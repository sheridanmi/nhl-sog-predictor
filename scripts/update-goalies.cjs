/**
 * GOALIE UPDATE SCRIPT
 * 
 * Lightweight script that runs at 6:30 PM ET — after starters are posted.
 * Loads the existing latest-analysis.json, fetches confirmed starting goalies
 * for tonight's games, patches the goalie data and recalculates affected edges,
 * then saves the updated JSON for redeployment.
 * 
 * Does NOT re-fetch all player data — runs in ~30 seconds.
 * 
 * Usage:
 *   node scripts/update-goalies.cjs
 */

const NHL_BASE = 'https://api-web.nhle.com/v1';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

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
function round(num, dec) { return +num.toFixed(dec); }

// ============================================================
// GOALIE FETCHING
// ============================================================

/**
 * Try to get confirmed starter from game preview endpoint
 */
async function getConfirmedStartersForGame(gameId) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/gamecenter/${gameId}/play-by-play`);
    const starters = { home: null, away: null };

    const extract = (teamData) => {
      if (!teamData?.goalies) return null;
      const starter = teamData.goalies.find(g => g.starter);
      if (!starter) return null;
      return {
        id: starter.playerId,
        name: starter.name?.default || `${starter.firstName?.default} ${starter.lastName?.default}` || 'Unknown',
        confirmed: true,
      };
    };

    starters.home = extract(data.homeTeam);
    starters.away = extract(data.awayTeam);
    return starters;
  } catch {
    return { home: null, away: null };
  }
}

/**
 * Get goalie stats from their player landing page
 */
async function getGoalieStats(playerId) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/player/${playerId}/landing`);
    const stats = data.featuredStats?.regularSeason?.subSeason;
    return {
      id: playerId,
      name: `${data.firstName?.default} ${data.lastName?.default}`,
      savePct: stats?.savePctg || null,
      goalsAgainstAvg: stats?.goalsAgainstAvg || null,
      gamesStarted: stats?.gamesStarted || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback: get probable starter from club-stats (most games started)
 */
async function getProbableStarter(teamAbbrev) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/club-stats/${teamAbbrev}/now`);
    const goalies = data.goalies || [];
    const starter = goalies.sort((a, b) => (b.gamesStarted || 0) - (a.gamesStarted || 0))[0];
    if (!starter) return null;
    return {
      id: starter.playerId,
      name: `${starter.firstName?.default} ${starter.lastName?.default}`,
      savePct: starter.savePctg || null,
      confirmed: false,
    };
  } catch {
    return null;
  }
}

// ============================================================
// RECALCULATE EDGE with updated goalie data
// ============================================================

function recalcEdge(analysis, newOppGoalieSV) {
  const { simulation, odds } = analysis;
  if (!odds || odds.line == null || !odds.overOdds) return analysis;

  // Adjust projection for goalie change
  const oldSV = simulation.factors?.oppGoalieSV || 0.908;
  const leagueAvgSV = 0.908;
  const oldGoalieFactor = (leagueAvgSV - oldSV) * 10 * 0.04 * 10;
  const newGoalieFactor = (leagueAvgSV - newOppGoalieSV) * 10 * 0.04 * 10;
  const projAdjustment = newGoalieFactor - oldGoalieFactor;
  const newProjection = Math.max(0.5, round(simulation.projection + projAdjustment, 2));

  // Recalculate probabilities with adjusted projection
  const sd = simulation.stdDev || 1.5;
  const results = [];
  for (let i = 0; i < 10000; i++) {
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    results.push(Math.max(0, Math.round(newProjection + z * sd)));
  }

  const probabilities = {};
  for (let t = 0.5; t <= 8.5; t += 1) {
    probabilities[t] = results.filter(r => r > t).length / 10000;
  }

  // Recalculate edge
  const modelProb = probabilities[odds.line] || 0;
  const implied = odds.overOdds < 0
    ? Math.abs(odds.overOdds) / (Math.abs(odds.overOdds) + 100)
    : 100 / (odds.overOdds + 100);
  const edgeVal = (modelProb - implied) * 100;

  return {
    ...analysis,
    simulation: {
      ...simulation,
      projection: newProjection,
      probabilities,
      factors: {
        ...simulation.factors,
        oppGoalieSV: newOppGoalieSV,
        oppGoalie: analysis._confirmedGoalieName || simulation.factors?.oppGoalie,
        goalieDirection: newOppGoalieSV < 0.905 ? 'positive' : newOppGoalieSV > 0.915 ? 'negative' : 'neutral',
      },
    },
    edge: {
      edge: round(edgeVal, 2),
      modelProb: round(modelProb * 100, 1),
      impliedProb: round(implied * 100, 1),
      rating: edgeVal >= 10 ? 'STRONG' : edgeVal >= 5 ? 'MODERATE' : edgeVal >= 2 ? 'SLIM' : 'NO_EDGE',
      isPlayable: edgeVal >= 3,
    },
    edgeValue: round(edgeVal, 2),
    hasEdge: edgeVal >= 3,
    oppGoalieConfirmed: true,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const startTime = Date.now();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🥅  SOG GOALIE UPDATER — 6:30 PM RUN   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Load existing analysis JSON
  const jsonPath = path.join(__dirname, '..', 'public', 'latest-analysis.json');
  if (!fs.existsSync(jsonPath)) {
    console.error('❌ No latest-analysis.json found. Run daily-fetch.cjs first.');
    process.exit(1);
  }

  const analysis = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const { games, analyses } = analysis;

  if (!games || games.length === 0) {
    console.log('⚠️  No games in analysis. Exiting.');
    return;
  }

  console.log(`📋 Loaded analysis: ${analyses.length} players, ${games.length} games`);
  console.log(`🕐 Original timestamp: ${analysis.timestamp}\n`);

  // Build goalie map for all games
  console.log('🥅 Fetching confirmed starters...');
  const goalieMap = {}; // teamAbbrev -> { name, savePct, confirmed }

  for (const game of games) {
    const starters = await getConfirmedStartersForGame(game.id);

    // Home goalie (faces away team players)
    if (starters.home?.id) {
      const stats = await getGoalieStats(starters.home.id);
      goalieMap[game.awayTeam.abbrev] = {
        name: stats?.name || starters.home.name,
        savePct: stats?.savePct || null,
        confirmed: true,
      };
      console.log(`  ✅ ${game.awayTeam.abbrev} faces: ${goalieMap[game.awayTeam.abbrev].name} (SV%: ${stats?.savePct?.toFixed(3) || 'N/A'})`);
    } else {
      // Fallback to most-used goalie
      const probable = await getProbableStarter(game.homeTeam.abbrev);
      if (probable) {
        goalieMap[game.awayTeam.abbrev] = probable;
        console.log(`  ❓ ${game.awayTeam.abbrev} faces: ${probable.name} (probable, not confirmed)`);
      }
    }

    await sleep(200);

    // Away goalie (faces home team players)
    if (starters.away?.id) {
      const stats = await getGoalieStats(starters.away.id);
      goalieMap[game.homeTeam.abbrev] = {
        name: stats?.name || starters.away.name,
        savePct: stats?.savePct || null,
        confirmed: true,
      };
      console.log(`  ✅ ${game.homeTeam.abbrev} faces: ${goalieMap[game.homeTeam.abbrev].name} (SV%: ${stats?.savePct?.toFixed(3) || 'N/A'})`);
    } else {
      const probable = await getProbableStarter(game.awayTeam.abbrev);
      if (probable) {
        goalieMap[game.homeTeam.abbrev] = probable;
        console.log(`  ❓ ${game.homeTeam.abbrev} faces: ${probable.name} (probable, not confirmed)`);
      }
    }

    await sleep(200);
  }

  // Count confirmed vs TBD
  const confirmed = Object.values(goalieMap).filter(g => g.confirmed).length;
  const total = Object.keys(goalieMap).length;
  console.log(`\n📊 ${confirmed}/${total} goalies confirmed\n`);

  // Patch analyses with updated goalie data
  console.log('🔄 Updating player projections...');
  let updated = 0;
  let edgeChanges = 0;

  const updatedAnalyses = analyses.map(player => {
    const goalie = goalieMap[player.team];
    if (!goalie) return player;

    const oldGoalieName = player.simulation?.factors?.oppGoalie || 'TBD';
    const newGoalieName = goalie.name;
    const newSavePct = goalie.savePct;
    const wasConfirmed = player.oppGoalieConfirmed;

    // Skip if already confirmed and same goalie
    if (wasConfirmed && oldGoalieName === newGoalieName) return player;

    updated++;
    const oldEdge = player.edgeValue;

    // Recalculate with new goalie data if we have their SV%
    let updatedPlayer;
    if (newSavePct) {
      updatedPlayer = recalcEdge(
        { ...player, _confirmedGoalieName: newGoalieName },
        newSavePct
      );
    } else {
      // No SV% available — just update the name and confirmed status
      updatedPlayer = {
        ...player,
        oppGoalieConfirmed: goalie.confirmed,
        simulation: {
          ...player.simulation,
          factors: {
            ...player.simulation?.factors,
            oppGoalie: newGoalieName,
          },
        },
      };
    }

    // Track edge changes
    if (Math.abs((updatedPlayer.edgeValue || 0) - oldEdge) > 1) {
      edgeChanges++;
      console.log(`  📈 ${player.name}: edge ${oldEdge > 0 ? '+' : ''}${oldEdge?.toFixed(1)}% → ${updatedPlayer.edgeValue > 0 ? '+' : ''}${updatedPlayer.edgeValue?.toFixed(1)}% (${newGoalieName})`);
    }

    return updatedPlayer;
  });

  // Re-sort by edge value
  updatedAnalyses.sort((a, b) => (b.edgeValue || -999) - (a.edgeValue || -999));

  const newEdgesFound = updatedAnalyses.filter(a => a.hasEdge).length;

  // Save updated analysis
  const updatedData = {
    ...analysis,
    analyses: updatedAnalyses,
    edgesFound: newEdgesFound,
    timestamp: new Date().toISOString(),
    goalieUpdateTimestamp: new Date().toISOString(),
    goaliesConfirmed: confirmed,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(updatedData));
  console.log(`\n💾 Saved updated analysis to ${jsonPath}`);

  // Also update dist/ if it exists
  const distPath = path.join(__dirname, '..', 'dist', 'latest-analysis.json');
  if (fs.existsSync(path.dirname(distPath))) {
    fs.writeFileSync(distPath, JSON.stringify(updatedData));
    console.log('💾 Also updated dist/latest-analysis.json');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  ✅ GOALIE UPDATE COMPLETE                ║`);
  console.log(`║  🥅 ${String(confirmed).padEnd(3)} goalies confirmed             ║`);
  console.log(`║  👤 ${String(updated).padEnd(3)} players updated               ║`);
  console.log(`║  📈 ${String(edgeChanges).padEnd(3)} edge changes > 1%            ║`);
  console.log(`║  🎯 ${String(newEdgesFound).padEnd(3)} total playable edges         ║`);
  console.log(`║  ⏱️  ${elapsed}s elapsed                       ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
