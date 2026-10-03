/**
 * ONE-TIME REPAIR SCRIPT
 *
 * Fixes two separate bugs found in already-saved data:
 *
 * 1. settle-picks.cjs used to read shots from a boxscore endpoint with a
 *    wrong field name, which silently returned 0 for almost every player
 *    instead of falling back or skipping. Nearly every settled record is
 *    potentially wrong.
 *
 * 2. save-snapshot.cjs computed gameDate with naive UTC date extraction
 *    instead of a real Eastern-time conversion. Any game whose start time
 *    crossed UTC midnight (most night games do) got recorded one day late.
 *    That wrong date then makes exact-date lookups fail entirely, which is
 *    why bug #1's "fix" alone couldn't correct those specific records.
 *
 * This script re-derives the correct game date AND shot count for every
 * settled record from /player/{id}/game-log/{season}/2 — the same source
 * daily-fetch.cjs already uses for live projections — trying the stored
 * date first and a +/-1 day window if that doesn't match anything.
 *
 * Run this ONCE after deploying the fixed save-snapshot.cjs and
 * settle-picks.cjs. Safe to run more than once — anything already correct
 * is left untouched and reported separately from what was actually fixed.
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

function shiftDateString(dateStr, deltaDays) {
  const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids any DST edge case in the date math itself
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().split('T')[0];
}

// Tries the stored date first, then +/-1 day. Returns both the shot count
// AND the date that actually matched, so callers can correct a wrong stored
// gameDate, not just a wrong actualSOG. Returns null if nothing matches
// within the window (meaning the game truly isn't in this player's log,
// not just mis-dated — gets reported and left alone rather than guessed).
async function getCorrectGameData(playerId, storedGameDate) {
  const log = await getPlayerGameLog(playerId);
  for (const candidateDate of [storedGameDate, shiftDateString(storedGameDate, -1), shiftDateString(storedGameDate, 1)]) {
    const game = log.find(g => g.gameDate === candidateDate);
    if (game) return { gameDate: candidateDate, actualSOG: game.shots, dateWasWrong: candidateDate !== storedGameDate };
  }
  return null;
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
    const result = await getCorrectGameData(snap.playerId, snap.gameDate);
    snapChecked++;

    if (result === null) {
      console.log(`  ❓ ${(snap.playerName || snap.id).padEnd(24)} ${snap.gameDate} — no game-log entry found within +/-1 day, leaving as-is`);
      snapSkippedNoData++;
      continue;
    }

    const { gameDate: correctDate, actualSOG: correctSOG, dateWasWrong } = result;
    if (correctSOG === snap.actualSOG && !dateWasWrong) {
      snapAlreadyCorrect++;
      continue;
    }

    let overResult = 'push';
    if (correctSOG > snap.line) overResult = 'won';
    else if (correctSOG < snap.line) overResult = 'lost';

    const dateNote = dateWasWrong ? `, date ${snap.gameDate} → ${correctDate}` : '';
    console.log(`  🔧 ${(snap.playerName || snap.id).padEnd(24)} O${snap.line}  was: ${snap.actualSOG} (${snap.overResult})  →  correct: ${correctSOG} (${overResult})${dateNote}`);

    const update = { actualSOG: correctSOG, overResult, correctedAt: Timestamp.now() };
    if (dateWasWrong) update.gameDate = correctDate;
    batch.update(snap.ref, update);
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
    const result = await getCorrectGameData(pick.playerId, pick.gameDate);
    pickChecked++;

    if (result === null) {
      pickSkippedNoData++;
      continue;
    }

    const { gameDate: correctDate, actualSOG: correctSOG, dateWasWrong } = result;
    if (correctSOG === pick.actualSOG && !dateWasWrong) {
      pickAlreadyCorrect++;
      continue;
    }

    let status = 'push';
    if (correctSOG > pick.line) status = pick.betSide === 'over' ? 'won' : 'lost';
    else if (correctSOG < pick.line) status = pick.betSide === 'over' ? 'lost' : 'won';

    const dateNote = dateWasWrong ? `, date ${pick.gameDate} → ${correctDate}` : '';
    console.log(`  🔧 ${(pick.playerName || pick.id).padEnd(24)} ${pick.betSide.toUpperCase()} ${pick.line}  was: ${pick.actualSOG} (${pick.status})  →  correct: ${correctSOG} (${status})${dateNote}`);

    const update = { actualSOG: correctSOG, status, correctedAt: Timestamp.now() };
    if (dateWasWrong) update.gameDate = correctDate;
    batch.update(pick.ref, update);
    batchCount++;
    pickFixed++;
    if (batchCount === 400) { await batch.commit(); batch = db.batch(); batchCount = 0; }

    await sleep(50);
  }
  if (batchCount > 0) await batch.commit();

  console.log(`\n  Picks: ${pickChecked} checked, ${pickFixed} corrected, ${pickAlreadyCorrect} already correct, ${pickSkippedNoData} skipped (no data)\n`);

  // ── PART 3: Stuck PENDING snapshots with a wrong gameDate ───────
  // settle-picks.cjs only ever looks for yesterday's unsettled snapshots by
  // date — if a snapshot's stored gameDate is wrong, it's invisible to that
  // nightly job forever, even after the real game finishes. This catches
  // snapshots still marked pending whose actual game already has a result.
  console.log('⏳ PART 3: Checking pending snapshots for a wrong gameDate...');
  const pendingSnap = await db.collection('snapshots').where('settled', '==', false).get();
  const pendingSnapshots = pendingSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
  console.log(`   Found ${pendingSnapshots.length} pending snapshots to check\n`);

  let pendingChecked = 0, pendingFixed = 0, pendingStillPending = 0, pendingSkippedNoData = 0;
  batch = db.batch();
  batchCount = 0;

  for (const snap of pendingSnapshots) {
    if (!snap.playerId || !snap.gameDate || snap.line == null) { pendingSkippedNoData++; continue; }
    const result = await getCorrectGameData(snap.playerId, snap.gameDate);
    pendingChecked++;

    if (result === null) {
      pendingStillPending++; // genuinely still pending — game hasn't happened/finished yet
      continue;
    }

    const { gameDate: correctDate, actualSOG: correctSOG, dateWasWrong } = result;
    let overResult = 'push';
    if (correctSOG > snap.line) overResult = 'won';
    else if (correctSOG < snap.line) overResult = 'lost';

    const dateNote = dateWasWrong ? ` (date ${snap.gameDate} → ${correctDate})` : '';
    console.log(`  🔧 ${(snap.playerName || snap.id).padEnd(24)} O${snap.line}  found actual: ${correctSOG} (${overResult})${dateNote} — settling`);

    const update = { actualSOG: correctSOG, overResult, settled: true, settledAt: Timestamp.now(), correctedAt: Timestamp.now() };
    if (dateWasWrong) update.gameDate = correctDate;
    batch.update(snap.ref, update);
    batchCount++;
    pendingFixed++;
    if (batchCount === 400) { await batch.commit(); batch = db.batch(); batchCount = 0; }

    await sleep(50);
  }
  if (batchCount > 0) await batch.commit();

  console.log(`\n  Pending snapshots: ${pendingChecked} checked, ${pendingFixed} corrected+settled, ${pendingStillPending} genuinely still pending, ${pendingSkippedNoData} skipped (no data)\n`);

  // ── Summary ────────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  ✅ REPAIR COMPLETE                       ║');
  console.log(`║  📸 ${String(snapFixed).padEnd(3)} settled snapshots corrected   ║`);
  console.log(`║  📋 ${String(pickFixed).padEnd(3)} picks corrected               ║`);
  console.log(`║  ⏳ ${String(pendingFixed).padEnd(3)} stuck pending snapshots fixed ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  if (snapFixed === 0 && pickFixed === 0 && pendingFixed === 0) {
    console.log('Nothing needed fixing — safe to consider the data clean. No need to run this script again unless settle-picks.cjs changes again.');
  }
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
