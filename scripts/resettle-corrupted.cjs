/**
 * ONE-TIME REPAIR SCRIPT
 *
 * settle-picks.cjs previously used a boxscore endpoint with a wrong field
 * name that silently returned 0 shots for almost every player, instead of
 * correctly falling back or skipping. Every snapshot and pick settled by
 * the old code is potentially wrong — this script re-checks every one of
 * them against the proven-correct /player/{id}/game-log/{season}/2 endpoint
 * (the same source daily-fetch.cjs already uses for live projections) and
 * corrects any that don't match.
 *
 * Run this ONCE after deploying the fixed settle-picks.cjs. It is safe to
 * run more than once — anything already correct is left untouched (and
 * reported separately from what was actually fixed) — but there's no need
 * to run it again once it reports 0 corrections.
 *
 * Usage:
 *   node scripts/resettle-corrupted.cjs
 */

const NHL_BASE = 'https://api-web.nhle.com/v1';
const SEASON = '20262027';

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

// Cache each player's full season log so repeat appearances across many
// nights only cost one API call per player, not one per (player, date) pair.
const gameLogCache = new Map();

async function getPlayerGameLog(playerId) {
  if (gameLogCache.has(playerId)) return gameLogCache.get(playerId);
  try {
    const data = await fetchJSON(`${NHL_BASE}/player/${playerId}/game-log/${SEASON}/2`);
    const log = data.gameLog || [];
    gameLogCache.set(playerId, log);
    return log;
  } catch (e) {
    console.error(`  Error fetching game log for player ${playerId}:`, e.message);
    gameLogCache.set(playerId, []);
    return [];
  }
}

async function getCorrectActualSOG(playerId, gameDate) {
  const log = await getPlayerGameLog(playerId);
  const game = log.find(g => g.gameDate === gameDate);
  return game?.shots ?? null;
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🔧  RE-SETTLE CORRUPTED RECORDS         ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // ── PART 1: Snapshots ────────────────────────────────────────
  console.log('📸 PART 1: Checking settled snapshots...');
  const snapSnap = await db.collection('snapshots').where('settled', '==', true).get();
  const snapshots = snapSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
  console.log(`   Found ${snapshots.length} settled snapshots to verify\n`);

  let snapChecked = 0, snapFixed = 0, snapAlreadyCorrect = 0, snapSkippedNoData = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const snap of snapshots) {
    if (!snap.playerId || !snap.gameDate || snap.line == null) { snapSkippedNoData++; continue; }
    const correctSOG = await getCorrectActualSOG(snap.playerId, snap.gameDate);
    snapChecked++;

    if (correctSOG === null) {
      console.log(`  ❓ ${(snap.playerName || snap.id).padEnd(24)} ${snap.gameDate} — no game-log entry found, leaving as-is`);
      snapSkippedNoData++;
      continue;
    }

    if (correctSOG === snap.actualSOG) {
      snapAlreadyCorrect++;
      continue;
    }

    let overResult = 'push';
    if (correctSOG > snap.line) overResult = 'won';
    else if (correctSOG < snap.line) overResult = 'lost';

    console.log(`  🔧 ${(snap.playerName || snap.id).padEnd(24)} O${snap.line}  was: ${snap.actualSOG} (${snap.overResult})  →  correct: ${correctSOG} (${overResult})`);

    batch.update(snap.ref, { actualSOG: correctSOG, overResult, correctedAt: Timestamp.now() });
    batchCount++;
    snapFixed++;
    if (batchCount === 400) { await batch.commit(); batch = db.batch(); batchCount = 0; }

    await sleep(50); // cache means this is rare after the first appearance of a player
  }
  if (batchCount > 0) await batch.commit();

  console.log(`\n  Snapshots: ${snapChecked} checked, ${snapFixed} corrected, ${snapAlreadyCorrect} already correct, ${snapSkippedNoData} skipped (no data)\n`);

  // ── PART 2: Picks ────────────────────────────────────────────
  console.log('📋 PART 2: Checking settled picks...');
  const pickSnap = await db.collection('picks').where('status', 'in', ['won', 'lost', 'push']).get();
  const picks = pickSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
  console.log(`   Found ${picks.length} settled picks to verify\n`);

  let pickChecked = 0, pickFixed = 0, pickAlreadyCorrect = 0, pickSkippedNoData = 0;
  batch = db.batch();
  batchCount = 0;

  for (const pick of picks) {
    if (!pick.playerId || !pick.gameDate || pick.line == null || !pick.betSide) { pickSkippedNoData++; continue; }
    const correctSOG = await getCorrectActualSOG(pick.playerId, pick.gameDate);
    pickChecked++;

    if (correctSOG === null) {
      pickSkippedNoData++;
      continue;
    }

    if (correctSOG === pick.actualSOG) {
      pickAlreadyCorrect++;
      continue;
    }

    let status = 'push';
    if (correctSOG > pick.line) status = pick.betSide === 'over' ? 'won' : 'lost';
    else if (correctSOG < pick.line) status = pick.betSide === 'over' ? 'lost' : 'won';

    console.log(`  🔧 ${(pick.playerName || pick.id).padEnd(24)} ${pick.betSide.toUpperCase()} ${pick.line}  was: ${pick.actualSOG} (${pick.status})  →  correct: ${correctSOG} (${status})`);

    batch.update(pick.ref, { actualSOG: correctSOG, status, correctedAt: Timestamp.now() });
    batchCount++;
    pickFixed++;
    if (batchCount === 400) { await batch.commit(); batch = db.batch(); batchCount = 0; }

    await sleep(50);
  }
  if (batchCount > 0) await batch.commit();

  console.log(`\n  Picks: ${pickChecked} checked, ${pickFixed} corrected, ${pickAlreadyCorrect} already correct, ${pickSkippedNoData} skipped (no data)\n`);

  // ── Summary ────────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  ✅ REPAIR COMPLETE                       ║');
  console.log(`║  📸 ${String(snapFixed).padEnd(3)} snapshots corrected           ║`);
  console.log(`║  📋 ${String(pickFixed).padEnd(3)} picks corrected               ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  if (snapFixed === 0 && pickFixed === 0) {
    console.log('Nothing needed fixing — safe to consider the data clean. No need to run this script again unless settle-picks.cjs changes again.');
  }
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
