/**
 * SNAPSHOT SAVER SCRIPT
 * 
 * Runs after daily-fetch.cjs completes.
 * Reads latest-analysis.json and saves every player prediction
 * with odds/edge data to Firestore for future backtesting.
 * 
 * Usage:
 *   node scripts/save-snapshot.cjs
 */

const fs = require('fs');
const path = require('path');

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   📸  SOG SNAPSHOT SAVER                 ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Load analysis JSON
  const jsonPath = path.join(__dirname, '..', 'public', 'latest-analysis.json');
  if (!fs.existsSync(jsonPath)) {
    console.error('❌ No latest-analysis.json found.');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const { analyses, games, timestamp } = data;

  if (!analyses || analyses.length === 0) {
    console.log('⚠️  No analyses to save. Exiting.');
    return;
  }

  const gameDate = new Date(timestamp).toISOString().split('T')[0];
  console.log(`📅 Saving snapshot for ${gameDate}`);
  console.log(`👤 ${analyses.length} players, ${games?.length || 0} games\n`);

  // Check if we already saved a snapshot for today
  const existing = await db.collection('snapshots')
    .where('gameDate', '==', gameDate)
    .limit(1)
    .get();

  if (!existing.empty) {
    console.log(`⚠️  Snapshot for ${gameDate} already exists — skipping to avoid duplicates.`);
    console.log('   (Run with FORCE=true env var to override)');
    if (!process.env.FORCE) return;
    console.log('   FORCE=true — overwriting...');
  }

  // Only save players who have odds (otherwise no backtest value)
  const playersWithOdds = analyses.filter(a => a.odds && a.odds.line != null && a.odds.overOdds != null);
  console.log(`💰 ${playersWithOdds.length} players have odds lines\n`);

  if (playersWithOdds.length === 0) {
    console.log('⚠️  No players with odds today. Nothing to snapshot.');
    return;
  }

  // Save each player as a snapshot document
  let saved = 0;
  let errors = 0;
  const batch = db.batch();
  let batchCount = 0;

  for (const player of playersWithOdds) {
    try {
      const docRef = db.collection('snapshots').doc();
      batch.set(docRef, {
        // Identity
        playerId: player.id,
        playerName: player.name,
        team: player.team,
        opponent: player.opponent,
        homeAway: player.homeAway,
        position: player.position,
        gameId: player.gameId,
        gameDate,
        gameTime: player.gameTime || null,

        // Model prediction
        projection: player.simulation?.projection || null,
        stdDev: player.simulation?.stdDev || null,
        confidence: player.simulation?.confidence || null,

        // Odds at time of fetch
        line: player.odds.line,
        overOdds: player.odds.overOdds,
        underOdds: player.odds.underOdds || null,
        bookmaker: player.odds.bookmaker || null,

        // Edge calculation
        edge: player.edge?.edge || null,
        modelProb: player.edge?.modelProb || null,
        impliedProb: player.edge?.impliedProb || null,
        edgeRating: player.edge?.rating || 'NO_EDGE',
        isPlayable: player.edge?.isPlayable || false,

        // Key simulation factors
        seasonAvg: player.simulation?.factors?.seasonAvg || null,
        last5Avg: player.simulation?.factors?.last5Avg || null,
        last10Avg: player.simulation?.factors?.last10Avg || null,
        avgTOI: player.simulation?.factors?.avgTOI || null,
        recentTOI: player.simulation?.factors?.recentTOI || null,
        isBackToBack: player.simulation?.factors?.isBackToBack || false,
        oppGoalie: player.simulation?.factors?.oppGoalie || null,
        oppGoalieSV: player.simulation?.factors?.oppGoalieSV || null,
        oppGoalieConfirmed: player.oppGoalieConfirmed || false,

        // To be filled in by settler at 1 AM
        actualSOG: null,
        settled: false,
        settledAt: null,

        // Metadata
        snapshotTime: Timestamp.now(),
        modelTimestamp: timestamp,
      });

      saved++;
      batchCount++;

      // Firestore batch limit is 500
      if (batchCount === 499) {
        await batch.commit();
        batchCount = 0;
        console.log(`  💾 Committed batch of 499...`);
      }
    } catch (e) {
      errors++;
      console.error(`  ❌ Error saving ${player.name}:`, e.message);
    }
  }

  // Commit remaining
  if (batchCount > 0) {
    await batch.commit();
  }

  console.log(`✅ Saved ${saved} player snapshots to Firestore`);
  if (errors > 0) console.log(`⚠️  ${errors} errors`);

  // Save a summary doc for quick querying
  await db.collection('snapshot_summaries').doc(gameDate).set({
    gameDate,
    gamesCount: games?.length || 0,
    playersWithOdds: playersWithOdds.length,
    playersTotal: analyses.length,
    playableEdges: playersWithOdds.filter(p => p.edge?.isPlayable).length,
    strongEdges: playersWithOdds.filter(p => (p.edge?.edge || 0) >= 10).length,
    snapshotTime: Timestamp.now(),
    modelTimestamp: timestamp,
    settled: false,
  });

  console.log(`📋 Summary doc saved for ${gameDate}`);
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  ✅ SNAPSHOT COMPLETE                     ║`);
  console.log(`║  📸 ${String(saved).padEnd(3)} players saved                  ║`);
  console.log(`║  📅 Date: ${gameDate}                ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
