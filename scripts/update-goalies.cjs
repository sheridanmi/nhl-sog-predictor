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
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const SPORT = 'icehockey_nhl';
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

// Firebase is optional here — if creds aren't set, CLV capture is skipped
// (with a warning) but goalie updates still run normally.
let db = null;
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  const app = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  db = getFirestore(app);
}

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
// ODDS FETCHING (for closing-line / CLV capture)
// ============================================================

async function getOddsEvents() {
  if (!ODDS_API_KEY) return [];
  try {
    return await fetchJSON(`${ODDS_BASE}/sports/${SPORT}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`);
  } catch (e) { console.error('  Error fetching odds events:', e.message); return []; }
}

async function getSOGProps(eventId) {
  if (!ODDS_API_KEY) return [];
  try {
    const data = await fetchJSON(`${ODDS_BASE}/sports/${SPORT}/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=player_shots_on_goal&oddsFormat=american&dateFormat=iso`);
    const props = [];
    if (data.bookmakers) {
      for (const bk of data.bookmakers) {
        const mkt = bk.markets?.find(m => m.key === 'player_shots_on_goal');
        if (!mkt) continue;
        const outcomes = {};
        for (const o of mkt.outcomes) {
          if (!outcomes[o.description]) outcomes[o.description] = { playerName: o.description, bookmaker: bk.key, bookmakerTitle: bk.title };
          if (o.name === 'Over') { outcomes[o.description].overOdds = o.price; outcomes[o.description].line = o.point; }
          if (o.name === 'Under') { outcomes[o.description].underOdds = o.price; }
        }
        props.push(...Object.values(outcomes));
      }
    }
    return props;
  } catch (e) { console.error(`  Error fetching SOG props for ${eventId}:`, e.message); return []; }
}

// Same consensus-line-then-best-price logic as daily-fetch.cjs, kept in sync manually
function shopLines(oddsByPlayer) {
  const oddsMap = {};
  for (const [name, offers] of Object.entries(oddsByPlayer)) {
    const withOver = offers.filter(o => o.overOdds != null && o.line != null);
    if (!withOver.length) continue;
    const byLine = {};
    for (const o of withOver) (byLine[o.line] = byLine[o.line] || []).push(o);
    let consensusLine = null, maxCount = 0;
    for (const [line, arr] of Object.entries(byLine)) {
      if (arr.length > maxCount) { maxCount = arr.length; consensusLine = parseFloat(line); }
    }
    const best = byLine[consensusLine].reduce((a, b) => (b.overOdds > a.overOdds ? b : a));
    oddsMap[name] = { ...best, booksOffering: withOver.length };
  }
  return oddsMap;
}

async function fetchClosingOdds(games) {
  const events = await getOddsEvents();
  const relevant = events.filter(e =>
    games.some(g =>
      e.home_team?.toLowerCase().includes(g.homeTeam.name?.toLowerCase() || '~~~') ||
      e.away_team?.toLowerCase().includes(g.awayTeam.name?.toLowerCase() || '~~~')
    )
  );
  const oddsByPlayer = {};
  for (const event of relevant) {
    const props = await getSOGProps(event.id);
    for (const p of props) {
      if (!oddsByPlayer[p.playerName]) oddsByPlayer[p.playerName] = [];
      oddsByPlayer[p.playerName].push(p);
    }
    await sleep(400);
  }
  return shopLines(oddsByPlayer);
}

function americanToImpliedProb(odds) {
  return odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);
}

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
// NEGATIVE BINOMIAL SAMPLING (Poisson-Gamma mixture)
// Same shape used in daily-fetch.cjs — kept consistent so a goalie-triggered
// recalc doesn't silently switch back to a Normal distribution.
// ============================================================

function sampleStdNormal() {
  const u1 = Math.random(), u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleGamma(shape, scale) {
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(shape + 1, scale) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do { x = sampleStdNormal(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

function samplePoisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * sampleStdNormal()));
}

function estimateNBDispersion(sampleMean, sampleVariance) {
  if (sampleMean <= 0 || sampleVariance <= sampleMean) return Infinity;
  const r = (sampleMean * sampleMean) / (sampleVariance - sampleMean);
  return Math.max(0.5, r);
}

function sampleNegativeBinomial(distMean, r) {
  if (!isFinite(r)) return samplePoisson(distMean);
  const lambda = sampleGamma(r, distMean / r);
  return samplePoisson(lambda);
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

  // Recalculate probabilities with adjusted projection, same NB shape as the original sim.
  // nbDispersion is explicitly stored as null when the original sim found no overdispersion
  // (Poisson shape) — only re-derive it here for legacy files that predate this field.
  const meanForDispersion = simulation.factors?.seasonAvg || newProjection;
  const sd = simulation.stdDev || 1.5;
  const nbDispersion = 'nbDispersion' in simulation
    ? (simulation.nbDispersion == null ? Infinity : simulation.nbDispersion)
    : estimateNBDispersion(meanForDispersion, sd * sd);
  const results = [];
  for (let i = 0; i < 10000; i++) {
    results.push(sampleNegativeBinomial(newProjection, nbDispersion));
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

  // ── CLV: capture closing lines and diff against opening lines ──────────
  // This runs close to game time, making it a reasonable proxy for the
  // closing line without needing a separate per-game-start job.
  console.log('\n💹 Capturing closing lines for CLV tracking...');
  let clvUpdated = 0;
  try {
    if (!ODDS_API_KEY) {
      console.log('  ⚠️  No ODDS_API_KEY set — skipping CLV capture.');
    } else if (!db) {
      console.log('  ⚠️  No Firebase credentials set for this job — skipping CLV capture.');
    } else {
      const closingOdds = await fetchClosingOdds(games);
      console.log(`  Found closing lines for ${Object.keys(closingOdds).length} players`);

      const gameDate = (analysis.timestamp ? new Date(analysis.timestamp) : new Date()).toISOString().split('T')[0];
      const snap = await db.collection('snapshots').where('gameDate', '==', gameDate).get();
      const docsByPlayerId = {};
      snap.docs.forEach(d => { docsByPlayerId[d.data().playerId] = d; });

      const batch = db.batch();
      let batchCount = 0;
      for (const player of updatedAnalyses) {
        if (!player.odds || player.odds.line == null) continue;
        const closing = closingOdds[player.name];
        if (!closing) continue;
        const doc = docsByPlayerId[player.id];
        if (!doc) continue;

        const openingImplied = americanToImpliedProb(player.odds.overOdds);
        const closingImplied = americanToImpliedProb(closing.overOdds);
        const clv = round((closingImplied - openingImplied) * 100, 2); // positive = market moved toward you after your bet

        batch.update(doc.ref, {
          closingLine: closing.line,
          closingOverOdds: closing.overOdds,
          closingBookmaker: closing.bookmakerTitle || closing.bookmaker,
          clv,
          clvCapturedAt: Timestamp.now(),
        });
        clvUpdated++;
        batchCount++;
        if (batchCount === 499) { await batch.commit(); batchCount = 0; }
      }
      if (batchCount > 0) await batch.commit();
      console.log(`  ✅ CLV captured for ${clvUpdated} snapshots`);
    }
  } catch (e) {
    console.error('  ⚠️  CLV capture failed (non-fatal, goalie update above still succeeded):', e.message);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  ✅ GOALIE UPDATE COMPLETE                ║`);
  console.log(`║  🥅 ${String(confirmed).padEnd(3)} goalies confirmed             ║`);
  console.log(`║  👤 ${String(updated).padEnd(3)} players updated               ║`);
  console.log(`║  📈 ${String(edgeChanges).padEnd(3)} edge changes > 1%            ║`);
  console.log(`║  🎯 ${String(newEdgesFound).padEnd(3)} total playable edges         ║`);
  console.log(`║  💹 ${String(clvUpdated).padEnd(3)} CLV snapshots captured       ║`);
  console.log(`║  ⏱️  ${elapsed}s elapsed                       ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
