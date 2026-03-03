/**
 * DAILY FETCH SCRIPT
 * 
 * Run this once a day (~3-4 PM before games start).
 * It fetches all NHL data + betting odds, runs simulations,
 * and uploads results to Firebase Storage.
 * 
 * Usage:
 *   node scripts/daily-fetch.js
 * 
 * Or on Windows, double-click run_model.bat
 */

const NHL_BASE = 'https://api-web.nhle.com/v1';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const SPORT = 'icehockey_nhl';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '9dadc0dad7194fc979285f4023e50ffc';
const SEASON = '20252026';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ============================================================
// HTTP FETCH HELPER (no external dependencies needed)
// ============================================================

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'SOG-Edge-Finder/1.0' } }, (res) => {
      // Follow redirects
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
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseToiToMinutes(toiStr) {
  if (!toiStr) return 0;
  const parts = toiStr.split(':');
  if (parts.length !== 2) return 0;
  return parseInt(parts[0]) + parseInt(parts[1]) / 60;
}

function round(num, dec) { return +num.toFixed(dec); }
function mean(arr) { return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length; }
function stdDev(arr) {
  if (arr.length < 2) return 1;
  const avg = mean(arr);
  return Math.sqrt(mean(arr.map(v => Math.pow(v - avg, 2))));
}

// ============================================================
// NHL API FUNCTIONS
// ============================================================

async function getTodaysGames() {
  // Use ET date so late-night UTC doesn't roll to next day
  const etOffset = -5; // EST (use -4 for EDT)
  const nowET = new Date(Date.now() + etOffset * 60 * 60 * 1000);
  const today = nowET.toISOString().split('T')[0];
  console.log(`📅 Checking schedule for ${today}...`);
  const data = await fetchJSON(`${NHL_BASE}/schedule/${today}`);
  const todayData = data.gameWeek?.find(day => day.date === today);
  if (!todayData) return [];
  return todayData.games.map(game => ({
    id: game.id,
    startTime: game.startTimeUTC,
    gameState: game.gameState,
    awayTeam: { abbrev: game.awayTeam.abbrev, name: game.awayTeam.placeName?.default || game.awayTeam.abbrev, logo: game.awayTeam.logo },
    homeTeam: { abbrev: game.homeTeam.abbrev, name: game.homeTeam.placeName?.default || game.homeTeam.abbrev, logo: game.homeTeam.logo },
    venue: game.venue?.default,
  }));
}

async function getTeamRoster(teamAbbrev) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/roster/${teamAbbrev}/current`);
    const map = p => ({
      id: p.id, firstName: p.firstName?.default, lastName: p.lastName?.default,
      fullName: `${p.firstName?.default} ${p.lastName?.default}`,
      number: p.sweaterNumber, position: p.positionCode, headshot: p.headshot,
    });
    return { forwards: (data.forwards || []).map(map), defensemen: (data.defensemen || []).map(map), goalies: (data.goalies || []).map(map) };
  } catch (e) { console.error(`  Error fetching roster for ${teamAbbrev}:`, e.message); return { forwards: [], defensemen: [], goalies: [] }; }
}

async function getPlayerGameLog(playerId, landingRecentGames = []) {
  const mapGame = g => ({
    date: g.gameDate, opponent: g.opponentAbbrev?.default || g.opponentAbbrev,
    homeAway: g.homeRoadFlag === 'H' ? 'home' : 'away',
    goals: g.goals || 0, assists: g.assists || 0, shots: g.shots || 0,
    toi: g.toi || '0:00', toiMinutes: parseToiToMinutes(g.toi),
    ppToi: g.powerPlayToi || '0:00', ppToiMinutes: parseToiToMinutes(g.powerPlayToi),
  });

  try {
    // Fetch season endpoint + game-log/now in parallel
    // Season endpoint = first ~20 games (Oct-Nov)
    // game-log/now = most recent ~20 games (Jan-Mar)
    // Combined = full season coverage
    const [seasonRes, nowRes] = await Promise.allSettled([
      fetchJSON(`${NHL_BASE}/player/${playerId}/game-log/${SEASON}/2`),
      fetchJSON(`${NHL_BASE}/player/${playerId}/game-log/now`),
    ]);

    const seasonGames = seasonRes.status === 'fulfilled' ? (seasonRes.value?.gameLog || []) : [];
    const nowGames = nowRes.status === 'fulfilled'
      ? (nowRes.value?.gameLog || []).filter(g => !g.seasonId || g.seasonId === 20252026 || String(g.seasonId) === '20252026')
      : [];

    const allGames = [...seasonGames, ...nowGames];

    // Deduplicate by gameId or gameDate
    const seen = new Set();
    const unique = allGames.filter(g => {
      const key = g.gameId ? String(g.gameId) : g.gameDate;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    // Merge in landing page recent games (fills in latest games not in season endpoint)
    const allWithLanding = [...unique];
    for (const lg of landingRecentGames) {
      if (!allWithLanding.find(g => g.date === lg.date)) allWithLanding.push(lg);
    }
    allWithLanding.sort((a, b) => b.date.localeCompare(a.date));
    if (allWithLanding.length > 0) return allWithLanding;
  } catch (e) { /* fall through */ }

  try {
    const data = await fetchJSON(`${NHL_BASE}/player/${playerId}/game-log/${SEASON}/2`);
    if (!data.gameLog) return landingRecentGames;
    const mapped = data.gameLog.sort((a,b) => b.gameDate.localeCompare(a.gameDate)).map(mapGame);
    // Merge with landing recent games
    const merged = [...mapped];
    for (const lg of landingRecentGames) {
      if (!merged.find(g => g.date === lg.date)) merged.push(lg);
    }
    merged.sort((a, b) => b.date.localeCompare(a.date));
    return merged;
  } catch (e) { return landingRecentGames; }
}

async function getPlayerInfo(playerId) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/player/${playerId}/landing`);
    // Extract recent games from landing page (always has current season recent games)
    const recentGames = (data.last5Games || []).map(g => ({
      date: g.gameDate,
      opponent: g.opponentAbbrev?.default || g.opponentAbbrev,
      homeAway: g.homeRoadFlag === 'H' ? 'home' : 'away',
      goals: g.goals || 0, assists: g.assists || 0, shots: g.shots || 0,
      toi: g.toi || '0:00', toiMinutes: parseToiToMinutes(g.toi),
      ppToi: g.powerPlayToi || '0:00', ppToiMinutes: parseToiToMinutes(g.powerPlayToi),
    }));
    return {
      id: data.playerId, fullName: `${data.firstName?.default} ${data.lastName?.default}`,
      team: data.currentTeamAbbrev, position: data.position, headshot: data.headshot,
      recentGames,
    };
  } catch (e) { return null; }
}

async function getTeamStats(teamAbbrev) {
  try {
    const data = await fetchJSON(`${NHL_BASE}/club-stats/${teamAbbrev}/now`);
    return {
      teamAbbrev,
      goalies: (data.goalies || []).map(g => ({
        name: `${g.firstName?.default} ${g.lastName?.default}`,
        gamesPlayed: g.gamesPlayed, gamesStarted: g.gamesStarted,
        savePct: g.savePctg, goalsAgainstAvg: g.goalsAgainstAvg,
        shotsAgainst: g.shotsAgainst,
      })),
    };
  } catch (e) { return { teamAbbrev, goalies: [] }; }
}

// ============================================================
// ODDS API FUNCTIONS
// ============================================================

async function getOddsEvents() {
  try {
    return await fetchJSON(`${ODDS_BASE}/sports/${SPORT}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`);
  } catch (e) { console.error('  Error fetching odds events:', e.message); return []; }
}

async function getSOGProps(eventId) {
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

// ============================================================
// MONTE CARLO SIMULATION
// ============================================================

const WEIGHTS = {
  seasonAvgSOG: 0.20, last5AvgSOG: 0.25, last10AvgSOG: 0.15,
  homeAwayAdj: 0.05, oppShotsAgainst: 0.10, toiTrend: 0.08,
  ppTimeFactor: 0.07, backToBack: 0.03, oppGoalieSVPct: 0.04, vegasTotal: 0.03,
};

function runSimulation(gameLog, homeAway, matchup) {
  const allSOG = gameLog.map(g => g.shots);
  const seasonAvg = mean(allSOG);
  const last5 = gameLog.slice(0, 5);   // newest first, so first 5 = most recent
  const last10 = gameLog.slice(0, 10); // newest first, so first 10 = most recent
  const last5Avg = mean(last5.map(g => g.shots));
  const last10Avg = mean(last10.map(g => g.shots));
  const avgTOI = mean(gameLog.map(g => g.toiMinutes));
  const recentTOI = mean(last5.map(g => g.toiMinutes));
  const avgPPTOI = mean(gameLog.map(g => g.ppToiMinutes));

  const homeGames = gameLog.filter(g => g.homeAway === 'home');
  const awayGames = gameLog.filter(g => g.homeAway === 'away');
  const homeAvg = homeGames.length > 2 ? mean(homeGames.map(g => g.shots)) : seasonAvg;
  const awayAvg = awayGames.length > 2 ? mean(awayGames.map(g => g.shots)) : seasonAvg;
  const haAdj = homeAway === 'home' ? (homeAvg - seasonAvg) : (awayAvg - seasonAvg);

  const baseWeight = WEIGHTS.seasonAvgSOG + WEIGHTS.last5AvgSOG + WEIGHTS.last10AvgSOG;
  let proj = (seasonAvg * WEIGHTS.seasonAvgSOG + last5Avg * WEIGHTS.last5AvgSOG + last10Avg * WEIGHTS.last10AvgSOG) / baseWeight;
  proj += haAdj * WEIGHTS.homeAwayAdj * 5;

  const leagueAvgSA = 30.0;
  const oppSA = matchup.oppSA || leagueAvgSA;
  proj += proj * ((oppSA - leagueAvgSA) / leagueAvgSA) * (WEIGHTS.oppShotsAgainst * 5);

  if (avgTOI > 0) proj += proj * ((recentTOI - avgTOI) / avgTOI) * (WEIGHTS.toiTrend * 5);
  if (avgPPTOI > 0) proj += ((avgPPTOI - 3.5) / 3.5) * 0.5 * WEIGHTS.ppTimeFactor * 10;
  if (matchup.isB2B) proj *= (1 - WEIGHTS.backToBack * 3);

  const oppSV = matchup.oppGoalieSV || 0.908;
  proj += (0.908 - oppSV) * 10 * WEIGHTS.oppGoalieSVPct * 10;
  proj = Math.max(0.5, proj);

  const sd = stdDev(allSOG);
  const results = [];
  for (let i = 0; i < 10000; i++) {
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    results.push(Math.max(0, Math.round(proj + z * sd)));
  }

  const distribution = {};
  for (let i = 0; i <= 12; i++) distribution[i] = 0;
  results.forEach(r => { distribution[Math.min(r, 12)] = (distribution[Math.min(r, 12)] || 0) + 1; });

  const probabilities = {};
  for (let t = 0.5; t <= 8.5; t += 1) {
    probabilities[t] = results.filter(r => r > t).length / 10000;
  }

  return {
    projection: round(proj, 2), stdDev: round(sd, 2), distribution, probabilities,
    factors: {
      seasonAvg: round(seasonAvg, 2), last5Avg: round(last5Avg, 2), last10Avg: round(last10Avg, 2),
      homeAvg: round(homeAvg, 2), awayAvg: round(awayAvg, 2), homeAwayAdj: round(haAdj, 2),
      oppSAPerGame: round(oppSA, 1), avgTOI: round(avgTOI, 1), recentTOI: round(recentTOI, 1),
      avgPPTOI: round(avgPPTOI, 1), isBackToBack: !!matchup.isB2B,
      oppGoalie: matchup.oppGoalieName || 'Unknown', oppGoalieSV: matchup.oppGoalieSV || null,
      last5Direction: last5Avg > seasonAvg ? 'positive' : last5Avg < seasonAvg - 0.3 ? 'negative' : 'neutral',
      oppDirection: oppSA > 30 ? 'positive' : oppSA < 28 ? 'negative' : 'neutral',
      toiDirection: recentTOI > avgTOI + 0.5 ? 'positive' : recentTOI < avgTOI - 0.5 ? 'negative' : 'neutral',
      goalieDirection: oppSV < 0.905 ? 'positive' : oppSV > 0.915 ? 'negative' : 'neutral',
    },
    iterations: 10000,
    confidence: round((Math.min(1, gameLog.length / 30) * 0.6 + Math.max(0, 1 - sd / 4) * 0.4) * 100, 0),
  };
}

function calcEdge(modelProb, bookOdds) {
  const implied = bookOdds < 0 ? Math.abs(bookOdds) / (Math.abs(bookOdds) + 100) : 100 / (bookOdds + 100);
  const edge = (modelProb - implied) * 100;
  return {
    edge: round(edge, 2), modelProb: round(modelProb * 100, 1), impliedProb: round(implied * 100, 1),
    rating: edge >= 10 ? 'STRONG' : edge >= 5 ? 'MODERATE' : edge >= 2 ? 'SLIM' : 'NO_EDGE',
    isPlayable: edge >= 3,
  };
}

// ============================================================
// MAIN PIPELINE
// ============================================================

async function main() {
  const startTime = Date.now();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     🏒  SOG EDGE FINDER — DAILY RUN  🏒    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // 1. Get schedule
  const games = await getTodaysGames();
  console.log(`📅 ${games.length} games tonight\n`);

  if (games.length === 0) {
    const result = { games: [], analyses: [], weights: WEIGHTS, timestamp: new Date().toISOString(), loadTime: 0, playersScanned: 0, edgesFound: 0, error: 'No games scheduled for today' };
    saveResults(result);
    console.log('\n⚠️  No games today. Empty results saved.');
    return;
  }

  // 2. Get opponent context for each game
  console.log('📊 Fetching team stats...');
  const oppContext = {};
  for (const game of games) {
    const [homeStats, awayStats] = await Promise.all([
      getTeamStats(game.homeTeam.abbrev), getTeamStats(game.awayTeam.abbrev),
    ]);
    const homeG = homeStats.goalies?.sort((a, b) => (b.gamesStarted || 0) - (a.gamesStarted || 0))[0];
    const awayG = awayStats.goalies?.sort((a, b) => (b.gamesStarted || 0) - (a.gamesStarted || 0))[0];

    oppContext[`${game.awayTeam.abbrev}_opp`] = {
      oppSA: homeStats.goalies?.reduce((s, g) => s + (g.shotsAgainst || 0), 0) / Math.max(1, homeStats.goalies?.reduce((s, g) => s + (g.gamesPlayed || 0), 0) || 1),
      oppGoalieName: homeG?.name || 'TBD', oppGoalieSV: homeG?.savePct || null,
    };
    oppContext[`${game.homeTeam.abbrev}_opp`] = {
      oppSA: awayStats.goalies?.reduce((s, g) => s + (g.shotsAgainst || 0), 0) / Math.max(1, awayStats.goalies?.reduce((s, g) => s + (g.gamesPlayed || 0), 0) || 1),
      oppGoalieName: awayG?.name || 'TBD', oppGoalieSV: awayG?.savePct || null,
    };
  }

  // 3. Get betting odds
  console.log('\n💰 Fetching betting lines...');
  const events = await getOddsEvents();
  // Use ET date (UTC-5 standard / UTC-4 daylight) to match game times
  const etOffset = -5; // EST; use -4 for EDT (adjust if needed)
  const nowET = new Date(Date.now() + etOffset * 60 * 60 * 1000);
  const todayET = nowET.toISOString().split('T')[0];
  // Also accept games whose commence_time falls within today ET (7PM ET = midnight UTC next day)
  const todayEvents = events.filter(e => {
    if (!e.commence_time) return false;
    const gameET = new Date(new Date(e.commence_time).getTime() + etOffset * 60 * 60 * 1000);
    return gameET.toISOString().split('T')[0] === todayET;
  });
  const eventsToFetch = todayEvents.length > 0 ? todayEvents : events.slice(0, 8);

  const oddsMap = {};
  for (const event of eventsToFetch) {
    console.log(`  ${event.away_team} @ ${event.home_team}`);
    const props = await getSOGProps(event.id);
    for (const p of props) {
      if (!oddsMap[p.playerName] || p.bookmaker === 'draftkings') {
        oddsMap[p.playerName] = p;
      }
    }
    await sleep(500);
  }
  console.log(`  Found lines for ${Object.keys(oddsMap).length} players`);

  // 4. Fetch players and run simulations
  const analyses = [];
  let totalPlayers = 0;

  for (const game of games) {
    for (const side of ['away', 'home']) {
      const team = side === 'away' ? game.awayTeam.abbrev : game.homeTeam.abbrev;
      const opp = side === 'away' ? game.homeTeam.abbrev : game.awayTeam.abbrev;
      console.log(`\n🏒 ${team} (${side}) vs ${opp}`);

      const roster = await getTeamRoster(team);
      const skaters = [...roster.forwards, ...roster.defensemen];
      console.log(`  ${skaters.length} skaters on roster`);

      for (let i = 0; i < skaters.length; i += 5) {
        const batch = skaters.slice(i, i + 5);
        const results = await Promise.all(batch.map(async (sk) => {
          try {
            const info = await getPlayerInfo(sk.id);
            const gl = await getPlayerGameLog(sk.id, info?.recentGames || []);
            if (!gl || gl.length < 5) return null;
            totalPlayers++;

            const avgSOG = mean(gl.map(g => g.shots));
            if (avgSOG < 0.8) return null;

            const ctx = oppContext[`${team}_opp`] || {};
            const sim = runSimulation(gl, side, ctx);

            const odds = oddsMap[sk.fullName] || null;
            let edge = null;
            if (odds && odds.overOdds && odds.line != null) {
              edge = calcEdge(sim.probabilities[odds.line] || 0, odds.overOdds);
            }

            process.stdout.write('.');
            return {
              id: sk.id, name: sk.fullName, team, opponent: opp, homeAway: side,
              position: sk.position, headshot: sk.headshot,
              gameId: game.id, gameTime: game.startTime,
              gameLog: gl.slice(0, 20), seasonAvgSOG: round(avgSOG, 2),
              simulation: sim,
              odds: odds ? { line: odds.line, overOdds: odds.overOdds, underOdds: odds.underOdds, bookmaker: odds.bookmakerTitle || odds.bookmaker } : null,
              edge, edgeValue: edge?.edge || -999, hasEdge: edge?.isPlayable || false,
            };
          } catch (e) { return null; }
        }));
        analyses.push(...results.filter(Boolean));
        await sleep(300);
      }
    }
  }

  analyses.sort((a, b) => b.edgeValue - a.edgeValue);

  const elapsed = Date.now() - startTime;
  const edgesFound = analyses.filter(a => a.hasEdge).length;

  const result = {
    games, analyses, weights: WEIGHTS,
    timestamp: new Date().toISOString(),
    loadTime: elapsed,
    playersScanned: totalPlayers,
    edgesFound,
  };

  saveResults(result);

  console.log('\n');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  ✅ COMPLETE                              ║`);
  console.log(`║  📊 ${String(analyses.length).padEnd(4)} players analyzed               ║`);
  console.log(`║  🎯 ${String(edgesFound).padEnd(4)} edges found                   ║`);
  console.log(`║  ⏱️  ${(elapsed / 1000).toFixed(1)}s elapsed                      ║`);
  console.log('╚══════════════════════════════════════════╝');

  if (edgesFound > 0) {
    console.log('\n🔝 TOP 10 EDGES:');
    console.log('─'.repeat(70));
    analyses.slice(0, 10).forEach((a, i) => {
      const line = a.odds ? `O ${a.odds.line} (${a.odds.overOdds > 0 ? '+' : ''}${a.odds.overOdds})` : 'No line';
      const edgeStr = a.edge ? `+${a.edge.edge.toFixed(1)}% ${a.edge.rating}` : '';
      console.log(`  ${i + 1}. ${a.name.padEnd(22)} ${a.team} ${a.homeAway === 'home' ? 'vs' : '@ '} ${a.opponent}  ${line.padEnd(18)} Proj: ${a.simulation.projection}  ${edgeStr}`);
    });
  }
}

function saveResults(data) {
  // Save to local file
  const dir = path.join(__dirname, '..', 'public');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'latest-analysis.json');
  fs.writeFileSync(filePath, JSON.stringify(data));
  console.log(`\n💾 Saved to ${filePath} (${(fs.statSync(filePath).size / 1024).toFixed(0)} KB)`);

  // Also save to dist for Firebase deployment
  const distDir = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(distDir)) {
    fs.writeFileSync(path.join(distDir, 'latest-analysis.json'), JSON.stringify(data));
    console.log('💾 Also saved to dist/ for Firebase');
  }
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
