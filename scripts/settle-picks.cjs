/**
 * AUTO-SETTLER SCRIPT
 * 
 * Runs nightly at 1 AM ET after all games finish.
 * Looks up actual SOG for each pending pick from the NHL API
 * and auto-settles them as won/lost/push in Firestore.
 * 
 * Usage:
 *   node scripts/settle-picks.cjs
 */

const NHL_BASE = 'https://api-web.nhle.com/v1';

const https = require('https');
const http = require('http');

// Firebase Admin SDK for server-side Firestore access
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

// Initialize Firebase Admin using environment variables
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
// NHL API — Get actual SOG from completed game boxscore
// ============================================================

/**
 * Gets the boxscore for a completed game and returns a map of
 * playerId -> actual shots on goal
 */
async function getGameSOGMap(gameId) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/gamecenter/${gameId}/boxscore`);
    const sogMap = {};

    const processTeam = (teamData) => {
      const players = teamData?.players || teamData?.forwards || [];
      const allSkaters = [
        ...(teamData?.forwards || []),
        ...(teamData?.defense || []),
      ];
      for (const player of allSkaters) {
        const id = player.playerId || player.id;
        const shots = player.shots ?? player.toi ? (player.shots || 0) : null;
        if (id && shots !== null) {
          sogMap[id] = shots;
        }
      }
    };

    // Try different API response shapes
    if (data.playerByGameStats) {
      const { homeTeam, awayTeam } = data.playerByGameStats;
      processTeam(homeTeam);
      processTeam(awayTeam);
    } else if (data.boxscore?.playerByGameStats) {
      const { homeTeam, awayTeam } = data.boxscore.playerByGameStats;
      processTeam(homeTeam);
      processTeam(awayTeam);
    }

    return sogMap;
  } catch (e) {
    console.error(`  Error fetching boxscore for game ${gameId}:`, e.message);
    return {};
  }
}

/**
 * Alternative: look up a player's actual SOG by searching their recent game log
 * Used as fallback if boxscore lookup fails
 */
async function getPlayerActualSOG(playerId, gameDate) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/player/${playerId}/game-log/20252026/2`);
    if (!data.gameLog) return null;

    // Find the game matching today's date
    const game = data.gameLog.find(g => g.gameDate === gameDate);
    if (!game) return null;

    return game.shots ?? null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// FIRESTORE — Get pending picks and settle them
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
// MAIN
// ============================================================

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     🎯  SOG AUTO-SETTLER — NIGHTLY RUN   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // 1. Get all pending picks
  console.log('📋 Loading pending picks from Firestore...');
  const pending = await getPendingPicks();
  console.log(`   Found ${pending.length} pending picks\n`);

  if (pending.length === 0) {
    console.log('✅ Nothing to settle. Exiting.');
    return;
  }

  // 2. Group picks by gameId to minimize API calls
  const gameIds = [...new Set(pending.map(p => p.gameId).filter(Boolean))];
  console.log(`🏒 Fetching boxscores for ${gameIds.length} game(s)...`);

  const sogByGame = {};
  for (const gameId of gameIds) {
    console.log(`   Game ${gameId}...`);
    sogByGame[gameId] = await getGameSOGMap(gameId);
    console.log(`   → Found SOG data for ${Object.keys(sogByGame[gameId]).length} players`);
    await sleep(300);
  }

  // 3. Settle each pick
  console.log('\n🎯 Settling picks...');
  console.log('─'.repeat(60));

  let settled = 0, skipped = 0, won = 0, lost = 0, pushed = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const pick of pending) {
    const { id, playerName, playerId, gameId, line, betSide, gameDate } = pick;

    // Only settle picks from yesterday (games should be finished)
    // Skip picks from today — games may still be in progress
    const pickDate = gameDate || today;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (pickDate > yesterdayStr) {
      console.log(`  ⏭  ${playerName} — game today, skipping`);
      skipped++;
      continue;
    }

    // Try boxscore lookup first
    let actualSOG = null;
    if (gameId && sogByGame[gameId]) {
      actualSOG = sogByGame[gameId][playerId] ?? null;
    }

    // Fallback: game log lookup
    if (actualSOG === null && playerId) {
      console.log(`  🔍 Trying game log fallback for ${playerName}...`);
      actualSOG = await getPlayerActualSOG(playerId, pickDate);
      await sleep(200);
    }

    if (actualSOG === null) {
      console.log(`  ❓ ${playerName} — could not find actual SOG, skipping`);
      skipped++;
      continue;
    }

    const status = await settlePick(id, actualSOG, line, betSide);
    settled++;
    if (status === 'won') won++;
    else if (status === 'lost') lost++;
    else pushed++;

    const emoji = status === 'won' ? '✅' : status === 'lost' ? '❌' : '➡️';
    console.log(`  ${emoji} ${playerName.padEnd(24)} ${betSide.toUpperCase()} ${line}  →  actual: ${actualSOG} SOG  →  ${status.toUpperCase()}`);
  }

  // 4. Summary
  console.log('\n');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  ✅ SETTLING COMPLETE                     ║`);
  console.log(`║  📊 ${String(settled).padEnd(3)} picks settled                   ║`);
  console.log(`║  ✅ ${String(won).padEnd(3)} won                            ║`);
  console.log(`║  ❌ ${String(lost).padEnd(3)} lost                           ║`);
  console.log(`║  ➡️  ${String(pushed).padEnd(3)} push                           ║`);
  console.log(`║  ⏭  ${String(skipped).padEnd(3)} skipped                        ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
