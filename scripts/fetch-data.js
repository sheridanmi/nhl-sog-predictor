#!/usr/bin/env node
// ============================================================
// NHL SOG PREDICTOR — DATA PIPELINE
// Run daily before games: npm run fetch
// Pulls NHL API + Odds API, runs model, outputs data/today.json
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEBUG = process.argv.includes('--debug');
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const NHL_API = 'https://api-web.nhle.com/v1';
const ODDS_API = 'https://api.the-odds-api.com/v4';
const SEASON = '20252026';

const MODEL_WEIGHTS = {
  seasonAvgSOG: 0.20, last5AvgSOG: 0.25, last10AvgSOG: 0.15,
  homeAwayAdj: 0.05, oppShotsAgainst: 0.10, toiTrend: 0.08,
  ppTimeFactor: 0.07, backToBack: 0.03, oppGoalieSVPct: 0.04, vegasTotal: 0.03,
};

function log(m) { console.log(`[SOG] ${m}`); }
function debug(m) { if (DEBUG) console.log(`[DBG] ${m}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function today() { return new Date().toISOString().split('T')[0]; }
function yesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; }

async function fetchJSON(url, label = '') {
  debug(`Fetch: ${label || url}`);
  try {
    const r = await fetch(url);
    if (!r.ok) { console.error(`[ERR] ${label}: HTTP ${r.status}`); return null; }
    return await r.json();
  } catch (e) { console.error(`[ERR] ${label}: ${e.message}`); return null; }
}

function parseTOI(toi) {
  if (!toi) return 0;
  if (typeof toi === 'number') return toi;
  if (typeof toi === 'string' && toi.includes(':')) {
    const [m, s] = toi.split(':').map(Number);
    return +(m + s / 60).toFixed(1);
  }
  return 0;
}

// ---- STEP 1: SCHEDULE ----
async function fetchSchedule(date) {
  log(`Fetching schedule for ${date}...`);
  const d = await fetchJSON(`${NHL_API}/schedule/${date}`, 'schedule');
  if (!d?.gameWeek) return [];
  const games = [];
  for (const day of d.gameWeek) {
    if (day.date === date) {
      for (const g of day.games) {
        if (g.gameType === 2) {
          games.push({
            gameId: g.id, awayTeam: g.awayTeam.abbrev, homeTeam: g.homeTeam.abbrev,
            awayName: g.awayTeam.placeName?.default || g.awayTeam.abbrev,
            homeName: g.homeTeam.placeName?.default || g.homeTeam.abbrev,
            startTime: g.startTimeUTC, venue: g.venue?.default || '',
          });
        }
      }
    }
  }
  log(`Found ${games.length} games`);
  return games;
}

// ---- STEP 2: ROSTERS ----
async function fetchRoster(team) {
  const d = await fetchJSON(`${NHL_API}/roster/${team}/current`, `roster:${team}`);
  if (!d) return [];
  const players = [];
  for (const group of ['forwards', 'defensemen']) {
    if (d[group]) {
      for (const p of d[group]) {
        players.push({
          playerId: p.id,
          name: `${p.firstName?.default || ''} ${p.lastName?.default || ''}`.trim(),
          position: p.positionCode, team,
        });
      }
    }
  }
  debug(`${team}: ${players.length} skaters`);
  return players;
}

// ---- STEP 3: PLAYER GAME LOGS ----
async function fetchGameLog(playerId) {
  const d = await fetchJSON(`${NHL_API}/player/${playerId}/game-log/${SEASON}/2`, `log:${playerId}`);
  if (!d?.gameLog) return [];
  return d.gameLog.map(g => ({
    date: g.gameDate, opponent: g.opponentAbbrev?.default || g.opponentAbbrev || '',
    homeAway: g.homeRoadFlag === 'H' ? 'home' : 'away',
    sog: g.shots || 0, goals: g.goals || 0, assists: g.assists || 0,
    toi: parseTOI(g.toi), ppToi: parseTOI(g.powerPlayToi || 0),
  }));
}

// ---- STEP 4: TEAM STATS ----
async function fetchTeamStats() {
  log('Fetching team stats...');
  const d = await fetchJSON(
    'https://api.nhle.com/stats/rest/en/team/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22:%22points%22,%22direction%22:%22DESC%22%7D%5D&cayenneExp=seasonId=20252026%20and%20gameTypeId=2',
    'team-stats'
  );
  const stats = {};
  if (d?.data) {
    for (const t of d.data) {
      const a = t.teamTriCode || t.teamAbbrev;
      if (a) {
        const gp = Math.max(t.gamesPlayed || 1, 1);
        stats[a] = {
          saPerGame: t.shotsAgainstPerGame || (t.shotsAgainst || 0) / gp,
          shotsForPerGame: t.shotsForPerGame || (t.shotsFor || 0) / gp,
          ppPct: t.powerPlayPct ? t.powerPlayPct * 100 : 20,
          pkPct: t.penaltyKillPct ? t.penaltyKillPct * 100 : 80,
        };
      }
    }
  }
  log(`Got stats for ${Object.keys(stats).length} teams`);
  return stats;
}

// ---- STEP 5: BACK-TO-BACK CHECK ----
async function checkB2B(team) {
  const d = await fetchJSON(`${NHL_API}/schedule/${yesterday()}`, 'sched-yesterday');
  if (!d?.gameWeek) return false;
  for (const day of d.gameWeek) {
    if (day.date === yesterday()) {
      for (const g of day.games) {
        if (g.awayTeam?.abbrev === team || g.homeTeam?.abbrev === team) return true;
      }
    }
  }
  return false;
}

// ---- STEP 6: ODDS ----
async function fetchOddsEvents() {
  if (!ODDS_API_KEY) { log('⚠ No ODDS_API_KEY — skipping odds'); return []; }
  log('Fetching odds events...');
  const d = await fetchJSON(`${ODDS_API}/sports/icehockey_nhl/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`, 'events');
  return Array.isArray(d) ? d : [];
}

async function fetchSOGProps(eventId) {
  if (!ODDS_API_KEY) return [];
  const d = await fetchJSON(
    `${ODDS_API}/sports/icehockey_nhl/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=player_shots_on_goal&oddsFormat=american`,
    `sog:${eventId}`
  );
  if (!d?.bookmakers) return [];
  const props = [];
  for (const bk of d.bookmakers) {
    for (const mkt of bk.markets) {
      if (mkt.key === 'player_shots_on_goal') {
        for (const o of mkt.outcomes) {
          props.push({ bookmaker: bk.title, playerName: o.description, side: o.name, line: o.point, odds: o.price });
        }
      }
    }
  }
  return props;
}

async function fetchGameTotals() {
  if (!ODDS_API_KEY) return {};
  const d = await fetchJSON(
    `${ODDS_API}/sports/icehockey_nhl/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=totals&oddsFormat=american`,
    'totals'
  );
  const totals = {};
  if (Array.isArray(d)) {
    for (const ev of d) {
      const t = ev.bookmakers?.[0]?.markets?.[0]?.outcomes?.[0]?.point;
      if (t) totals[`${ev.away_team}|${ev.home_team}`] = t;
    }
  }
  return totals;
}

async function fetchAllSOGProps(events, games) {
  log('Fetching SOG props...');
  const allProps = {};
  let calls = 0;
  for (const ev of events) {
    const isToday = games.some(g =>
      (ev.home_team || '').toLowerCase().includes((g.homeName || '').toLowerCase()) ||
      (ev.away_team || '').toLowerCase().includes((g.awayName || '').toLowerCase())
    );
    if (!isToday) continue;
    const props = await fetchSOGProps(ev.id);
    calls++;
    for (const p of props) {
      if (!allProps[p.playerName]) allProps[p.playerName] = { lines: [] };
      allProps[p.playerName].lines.push(p);
    }
    await sleep(200);
  }
  log(`SOG props: ${Object.keys(allProps).length} players (${calls} API calls)`);
  return allProps;
}

// ---- STEP 7: PREDICTION MODEL ----
function runSim(gameLog, oppStats, ctx, iters = 10000) {
  if (!gameLog || gameLog.length < 3) return null;
  const last5 = gameLog.slice(0, Math.min(5, gameLog.length));
  const last10 = gameLog.slice(0, Math.min(10, gameLog.length));
  const avg = arr => arr.reduce((s, g) => s + g.sog, 0) / arr.length;
  const seasonAvg = avg(gameLog), l5 = avg(last5), l10 = avg(last10);
  const avgTOI = gameLog.reduce((s, g) => s + g.toi, 0) / gameLog.length;
  const avgPP = gameLog.reduce((s, g) => s + g.ppToi, 0) / gameLog.length;
  const oppSA = oppStats?.saPerGame || 30;

  let proj = seasonAvg * MODEL_WEIGHTS.seasonAvgSOG + l5 * MODEL_WEIGHTS.last5AvgSOG + l10 * MODEL_WEIGHTS.last10AvgSOG;
  // Home/away
  const ha = gameLog.filter(g => g.homeAway === ctx.homeAway);
  const haAvg = ha.length > 0 ? avg(ha) : seasonAvg;
  proj += (haAvg - seasonAvg) * MODEL_WEIGHTS.homeAwayAdj;
  // Opponent
  proj += proj * ((oppSA - 30) / 30) * MODEL_WEIGHTS.oppShotsAgainst;
  // TOI trend
  const recentTOI = last5.reduce((s, g) => s + g.toi, 0) / last5.length;
  if (avgTOI > 0) proj += proj * ((recentTOI - avgTOI) / avgTOI) * MODEL_WEIGHTS.toiTrend;
  // PP
  proj += (avgPP / 4) * 0.5 * MODEL_WEIGHTS.ppTimeFactor;
  // B2B
  if (ctx.backToBack) proj *= 0.92;
  // Pace
  if (ctx.vegasTotal) proj += proj * ((ctx.vegasTotal - 6) / 6) * MODEL_WEIGHTS.vegasTotal;

  proj = Math.max(0.5, proj);
  const sd = Math.sqrt(gameLog.reduce((s, g) => s + Math.pow(g.sog - seasonAvg, 2), 0) / gameLog.length);

  const results = [];
  for (let i = 0; i < iters; i++) {
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    results.push(Math.max(0, Math.round(proj + z * sd)));
  }

  const dist = {};
  for (let i = 0; i <= 12; i++) dist[i] = 0;
  results.forEach(r => { dist[Math.min(r, 12)]++; });

  const probs = {};
  for (let t = 0.5; t <= 7.5; t += 1) probs[t] = +(results.filter(r => r > t).length / iters).toFixed(4);

  return {
    projection: +proj.toFixed(2), stdDev: +sd.toFixed(2), distribution: dist, probabilities: probs,
    factors: { seasonAvg: +seasonAvg.toFixed(2), last5Avg: +l5.toFixed(2), last10Avg: +l10.toFixed(2),
      homeAwayAdj: +(haAvg - seasonAvg).toFixed(2), oppSAPerGame: +oppSA.toFixed(1),
      avgTOI: +avgTOI.toFixed(1), avgPPTOI: +avgPP.toFixed(1), recentTOI: +recentTOI.toFixed(1),
      backToBack: ctx.backToBack, vegasTotal: ctx.vegasTotal || null },
  };
}

function matchOdds(name, sogProps) {
  if (sogProps[name]) return sogProps[name];
  const last = name.split(' ').pop()?.toLowerCase();
  for (const [n, d] of Object.entries(sogProps)) {
    if (n.toLowerCase().includes(last) && n.toLowerCase()[0] === name.toLowerCase()[0]) return d;
  }
  return null;
}

function calcEdge(sim, oddsData) {
  if (!oddsData?.lines?.length) return null;
  const overs = oddsData.lines.filter(l => l.side === 'Over');
  if (!overs.length) return null;
  // Most common line
  const groups = {};
  overs.forEach(l => { groups[l.line] = (groups[l.line] || []).concat(l); });
  let bestLine = null, maxN = 0;
  for (const [line, arr] of Object.entries(groups)) { if (arr.length > maxN) { maxN = arr.length; bestLine = parseFloat(line); } }
  if (!bestLine) return null;
  const best = overs.filter(l => l.line === bestLine).reduce((a, b) => b.odds > a.odds ? b : a);
  const imp = best.odds < 0 ? Math.abs(best.odds) / (Math.abs(best.odds) + 100) : 100 / (best.odds + 100);
  const modelP = sim.probabilities[bestLine - 0.5] || sim.probabilities[bestLine] || 0;
  return {
    bookLine: bestLine, bookOverOdds: best.odds, bookmaker: best.bookmaker,
    impliedProb: +(imp * 100).toFixed(1), modelProb: +(modelP * 100).toFixed(1),
    edge: +((modelP - imp) * 100).toFixed(1),
  };
}

// ---- MAIN ----
async function main() {
  const dt = today();
  log(`\n🏒 NHL SOG PREDICTOR — ${dt}\n${'━'.repeat(45)}\n`);

  const games = await fetchSchedule(dt);
  if (!games.length) { log('No games today!'); return; }

  const teamStats = await fetchTeamStats();

  log('Checking back-to-backs...');
  const b2b = new Set();
  for (const g of games) {
    if (await checkB2B(g.awayTeam)) b2b.add(g.awayTeam);
    if (await checkB2B(g.homeTeam)) b2b.add(g.homeTeam);
  }
  if (b2b.size) log(`B2B teams: ${[...b2b].join(', ')}`);

  const oddsEvents = await fetchOddsEvents();
  const sogProps = await fetchAllSOGProps(oddsEvents, games);
  const gameTotals = await fetchGameTotals();

  // Fetch injuries (best effort)
  const injuries = (await fetchJSON(`${NHL_API}/injuries`, 'injuries')) || [];

  log('\nProcessing players...');
  const allPlayers = [];
  let count = 0;

  for (const game of games) {
    log(`\n📋 ${game.awayTeam} @ ${game.homeTeam}`);
    const away = await fetchRoster(game.awayTeam);
    const home = await fetchRoster(game.homeTeam);
    const roster = [
      ...away.map(p => ({ ...p, homeAway: 'away', opponent: game.homeTeam })),
      ...home.map(p => ({ ...p, homeAway: 'home', opponent: game.awayTeam })),
    ];

    for (const p of roster) {
      await sleep(50);
      const gl = await fetchGameLog(p.playerId);
      if (!gl || gl.length < 3) continue;

      const opp = teamStats[p.opponent] || { saPerGame: 30, pkPct: 80 };
      let vt = null;
      for (const [k, v] of Object.entries(gameTotals)) {
        if (k.toLowerCase().includes(game.awayName?.toLowerCase()) || k.toLowerCase().includes(game.homeName?.toLowerCase())) { vt = v; break; }
      }

      const sim = runSim(gl, opp, { homeAway: p.homeAway, backToBack: b2b.has(p.team), vegasTotal: vt });
      if (!sim) continue;

      const odds = matchOdds(p.name, sogProps);
      const edge = calcEdge(sim, odds);

      allPlayers.push({
        playerId: p.playerId, name: p.name, team: p.team, position: p.position,
        opponent: p.opponent, homeAway: p.homeAway, backToBack: b2b.has(p.team),
        gameLog: gl.slice(0, 20), simulation: sim, odds: edge,
        matchup: { oppSAPerGame: opp.saPerGame, oppPKPct: opp.pkPct, vegasTotal: vt },
      });
      count++;
      if (count % 20 === 0) log(`... ${count} players processed`);
    }
  }

  allPlayers.sort((a, b) => (b.odds?.edge || -999) - (a.odds?.edge || -999));

  const output = {
    meta: {
      date: dt, generatedAt: new Date().toISOString(),
      gamesCount: games.length, playersScanned: allPlayers.length,
      edgesFound: allPlayers.filter(p => p.odds?.edge > 2).length,
      modelWeights: MODEL_WEIGHTS,
    },
    games, injuries: Array.isArray(injuries) ? injuries : [], teamStats, players: allPlayers,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'today.json'), JSON.stringify(output, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, `${dt}.json`), JSON.stringify(output, null, 2));

  log(`\n${'━'.repeat(45)}`);
  log(`✅ Done! ${games.length} games, ${count} players, ${allPlayers.filter(p => p.odds?.edge > 2).length} edges`);

  const picks = allPlayers.filter(p => p.odds?.edge > 2).slice(0, 10);
  if (picks.length) {
    log(`\n🎯 TOP PICKS:`);
    picks.forEach((p, i) => {
      log(`  ${i + 1}. ${p.name} (${p.team}) — O ${p.odds.bookLine} SOG | Model: ${p.odds.modelProb}% | Book: ${p.odds.impliedProb}% | Edge: +${p.odds.edge}%`);
    });
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
