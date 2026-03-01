/**
 * AUTO-SETTLER SCRIPT
 * 
 * Runs nightly at 1 AM ET after all games finish.
 * 1. Looks up actual SOG for each pending pick from the NHL API
 *    and auto-settles them as won/lost/push in Firestore.
 * 2. Also fills in actual SOG on snapshot records for backtesting.
 * 
 * Usage:
 *   node scripts/settle-picks.cjs
 */

const NHL_BASE = 'https://api-web.nhle.com/v1';

const https = require('https');
const http = require('http');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

const db = getFirestore(app);

// ============================================================
// HTTP FETCH HELPER
// ============================================================

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'SOG-Edge-Finder/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// NHL API
// ============================================================

async function getGameSOGMap(gameId) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/gamecenter/${gameId}/boxscore`);
    const sogMap = {};

    const processTeam = (teamData) => {
      const allSkaters = [
        ...(teamData?.forwards || []),
        ...(teamData?.defense || []),
      ];
      for (const player of allSkaters) {
        const id = player.playerId || player.id;
        const shots = player.shots ?? (player.toi ? (player.shots || 0) : null);
        if (id && shots !== null) sogMap[id] = shots;
      }
    };

    if (data.playerByGameStats) {
      processTeam(data.playerByGameStats.homeTeam);
      processTeam(data.playerByGameStats.awayTeam);
    } else if (data.boxscore?.playerByGameStats) {
      processTeam(data.boxscore.playerByGameStats.homeTeam);
      processTeam(data.boxscore.playerByGameStats.awayTeam);
    }

    return sogMap;
  } catch (e) {
    console.error(`  Error fetching boxscore for game ${gameId}:`, e.message);
    return {};
  }
}

async function getPlayerActualSOG(playerId, gameDate) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/player/${playerId}/game-log/20252026/2`);
    if (!data.gameLog) return null;
    const game = data.gameLog.find(g => g.gameDate === gameDate);
    return game?.shots ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// FIRESTORE — Picks
// ============================================================

async function getPendingPicks() {
  const snap = await db.collection('picks')
    .where('status', '==', 'pending')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function settlePick(pickId, actualSOG, line, betSide) {
  let status = 'push';
  if (actualSOG > line) status = betSide === 'over' ? 'won' : 'lost';
  else if (actualSOG < line) status = betSide === 'over' ? 'lost' : 'won';

  await db.collection('picks').doc(pickId).update({
    actualSOG,
    status,
    settledAt: Timestamp.now(),
    settledBy: 'auto-settler',
  });

  return status;
}

// ============================================================
// FIRESTORE — Snapshots (for backtesting)
// ============================================================

async function getUnsettledSnapshots(gameDate) {
  const snap = await db.collection('snapshots')
    .where('gameDate', '==', gameDate)
    .where('settled', '==', false)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function settleSnapshot(docId, actualSOG, line) {
  let overResult = 'push';
  if (actualSOG > line) overResult = 'won';
  else if (actualSOG < line) overResult = 'lost';

  await db.collection('snapshots').doc(docId).update({
    actualSOG,
    overResult,
    settled: true,
    settledAt: Timestamp.now(),
  });
}

async function markSnapshotSummarySettled(gameDate, settledCount) {
  try {
    await db.collection('snapshot_summaries').doc(gameDate).update({
      settled: true,
      settledCount,
      settledAt: Timestamp.now(),
    });
  } catch {
    // Summary doc may not exist for older dates
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     🎯  SOG AUTO-SETTLER — NIGHTLY RUN   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  // ── PART 1: Settle user picks ──────────────────────────────
  console.log('📋 PART 1: Settling user picks...');
  const pending = await getPendingPicks();
  console.log(`   Found ${pending.length} pending picks\n`);

  const gameIds = [...new Set(pending.map(p => p.gameId).filter(Boolean))];
  const sogByGame = {};

  if (gameIds.length > 0) {
    console.log(`🏒 Fetching boxscores for ${gameIds.length} game(s)...`);
    for (const gameId of gameIds) {
      sogByGame[gameId] = await getGameSOGMap(gameId);
      console.log(`   Game ${gameId} → ${Object.keys(sogByGame[gameId]).length} players`);
      await sleep(300);
    }
  }

  let settled = 0, skipped = 0, won = 0, lost = 0, pushed = 0;

  for (const pick of pending) {
    const { id, playerName, playerId, gameId, line, betSide, gameDate } = pick;
    const pickDate = gameDate || today;

    if (pickDate > yesterdayStr) {
      console.log(`  ⏭  ${playerName} — game today, skipping`);
      skipped++;
      continue;
    }

    let actualSOG = null;
    if (gameId && sogByGame[gameId]) actualSOG = sogByGame[gameId][playerId] ?? null;
    if (actualSOG === null && playerId) {
      actualSOG = await getPlayerActualSOG(playerId, pickDate);
      await sleep(200);
    }

    if (actualSOG === null) {
      console.log(`  ❓ ${playerName} — could not find SOG, skipping`);
      skipped++;
      continue;
    }

    const status = await settlePick(id, actualSOG, line, betSide);
    settled++;
    if (status === 'won') won++;
    else if (status === 'lost') lost++;
    else pushed++;

    const emoji = status === 'won' ? '✅' : status === 'lost' ? '❌' : '➡️';
    console.log(`  ${emoji} ${playerName.padEnd(24)} ${betSide.toUpperCase()} ${line}  →  actual: ${actualSOG}  →  ${status.toUpperCase()}`);
  }

  console.log(`\n  Picks: ${settled} settled (${won}W/${lost}L/${pushed}P), ${skipped} skipped\n`);

  // ── PART 2: Settle snapshots for backtesting ───────────────
  console.log('📸 PART 2: Settling snapshots for backtesting...');
  const snapshots = await getUnsettledSnapshots(yesterdayStr);
  console.log(`   Found ${snapshots.length} unsettled snapshots for ${yesterdayStr}\n`);

  if (snapshots.length === 0) {
    console.log('   No snapshots to settle.\n');
  } else {
    // Reuse boxscore lookups from part 1, fetch any missing
    const snapshotGameIds = [...new Set(snapshots.map(s => s.gameId).filter(Boolean))];
    for (const gameId of snapshotGameIds) {
      if (!sogByGame[gameId]) {
        sogByGame[gameId] = await getGameSOGMap(gameId);
        await sleep(300);
      }
    }

    let snapSettled = 0, snapSkipped = 0;

    for (const snap of snapshots) {
      const { id, playerName, playerId, gameId, line, gameDate } = snap;

      let actualSOG = null;
      if (gameId && sogByGame[gameId]) actualSOG = sogByGame[gameId][playerId] ?? null;
      if (actualSOG === null && playerId) {
        actualSOG = await getPlayerActualSOG(playerId, gameDate);
        await sleep(150);
      }

      if (actualSOG === null) {
        snapSkipped++;
        continue;
      }

      await settleSnapshot(id, actualSOG, line);
      snapSettled++;

      const hit = actualSOG > line ? '✅ OVER HIT' : actualSOG < line ? '❌ OVER MISS' : '➡️  PUSH';
      console.log(`  ${hit}  ${playerName.padEnd(24)} O${line}  →  actual: ${actualSOG}`);
    }

    await markSnapshotSummarySettled(yesterdayStr, snapSettled);
    console.log(`\n  Snapshots: ${snapSettled} settled, ${snapSkipped} skipped\n`);
  }

  // ── Summary ────────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  ✅ NIGHTLY RUN COMPLETE                  ║`);
  console.log(`║  🎯 ${String(settled).padEnd(3)} picks settled                   ║`);
  console.log(`║  ✅ ${String(won).padEnd(3)} won  ❌ ${String(lost).padEnd(3)} lost  ➡️  ${String(pushed).padEnd(3)} push   ║`);
  console.log(`║  📸 ${String(snapshots.length).padEnd(3)} snapshots processed           ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
