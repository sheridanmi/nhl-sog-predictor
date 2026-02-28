import { fetchAllTonightData, getTeamStats } from './nhlApi.js';
import { fetchAllSOGProps, setOddsApiKey } from './oddsApi.js';
import { runSimulation, calculateEdge, DEFAULT_WEIGHTS } from '../utils/monteCarlo.js';
import { buildBackToBackMap } from './backToBack.js';
import { buildGoalieMap } from './goalieService.js';

export async function buildTonightAnalysis(oddsApiKey, customWeights = null) {
  const weights = customWeights || DEFAULT_WEIGHTS;
  const startTime = Date.now();

  if (oddsApiKey) setOddsApiKey(oddsApiKey);

  console.log('Building tonight\'s analysis...');

  const { games, players, standings } = await fetchAllTonightData();

  if (games.length === 0) {
    return { games: [], analyses: [], injuries: [], timestamp: new Date().toISOString(), loadTime: Date.now() - startTime, error: 'No games scheduled for today' };
  }

  // === FEATURE: Back-to-Back Detection ===
  const b2bMap = await buildBackToBackMap(games);

  // === FEATURE: Starting Goalie Confirmation ===
  const goalieMap = await buildGoalieMap(games);

  let oddsMap = {};
  if (oddsApiKey) {
    try { oddsMap = await fetchAllSOGProps(); }
    catch (err) { console.error('Error fetching odds:', err); }
  }

  const oppContextMap = {};
  for (const game of games) {
    const [homeStats, awayStats] = await Promise.all([
      getTeamStats(game.homeTeam.abbrev).catch(() => null),
      getTeamStats(game.awayTeam.abbrev).catch(() => null),
    ]);

    // Use confirmed starter if available, else fall back to usage-based
    const goalies = goalieMap[game.id];
    const homeGoalie = goalies?.home || homeStats?.goalies?.sort((a, b) => (b.gamesStarted || 0) - (a.gamesStarted || 0))[0];
    const awayGoalie = goalies?.away || awayStats?.goalies?.sort((a, b) => (b.gamesStarted || 0) - (a.gamesStarted || 0))[0];

    const homeGoalieSV = homeGoalie?.savePct ?? homeStats?.goalies?.[0]?.savePct ?? null;
    const awayGoalieSV = awayGoalie?.savePct ?? awayStats?.goalies?.[0]?.savePct ?? null;

    oppContextMap[`${game.awayTeam.abbrev}_opp`] = {
      oppShotsAgainstPerGame: homeStats?.goalies?.reduce((sum, g) => sum + (g.shotsAgainst || 0), 0) /
        Math.max(1, homeStats?.goalies?.reduce((sum, g) => sum + (g.gamesPlayed || 0), 0) || 1),
      oppGoalieName: homeGoalie?.name || 'TBD',
      oppGoalieSavePct: homeGoalieSV,
      oppGoalieConfirmed: goalies?.homeConfirmed || false,
      leagueAvgShotsAgainst: 30.0,
    };

    oppContextMap[`${game.homeTeam.abbrev}_opp`] = {
      oppShotsAgainstPerGame: awayStats?.goalies?.reduce((sum, g) => sum + (g.shotsAgainst || 0), 0) /
        Math.max(1, awayStats?.goalies?.reduce((sum, g) => sum + (g.gamesPlayed || 0), 0) || 1),
      oppGoalieName: awayGoalie?.name || 'TBD',
      oppGoalieSavePct: awayGoalieSV,
      oppGoalieConfirmed: goalies?.awayConfirmed || false,
      leagueAvgShotsAgainst: 30.0,
    };
  }

  const analyses = [];
  for (const player of players) {
    if (!player.gameLog || player.gameLog.length < 5) continue;
    if (player.seasonAvgSOG < 0.8) continue;

    const oppContext = oppContextMap[`${player.team}_opp`] || {};

    // Wire in real B2B status
    const isBackToBack = b2bMap[player.team] || false;

    const matchupContext = { ...oppContext, isBackToBack, vegasTotal: 6.0 };
    const sim = runSimulation(player, matchupContext, weights);
    if (sim.error) continue;

    const oddsKey = player.name;
    const odds = oddsMap[oddsKey] || null;

    let edge = null;
    if (odds && odds.overOdds && odds.line) {
      const modelProb = sim.probabilities[odds.line] || 0;
      edge = calculateEdge(modelProb, odds.overOdds);
    }

    analyses.push({
      id: player.id,
      name: player.name,
      team: player.team,
      opponent: player.opponent,
      homeAway: player.homeAway,
      position: player.position,
      headshot: player.headshot,
      gameId: player.gameId,
      gameTime: player.gameTime,
      gameLog: player.gameLog,
      seasonAvgSOG: player.seasonAvgSOG,
      simulation: sim,
      isBackToBack,
      oppGoalieConfirmed: oppContext.oppGoalieConfirmed || false,
      odds: odds ? {
        line: odds.line,
        overOdds: odds.overOdds,
        underOdds: odds.underOdds,
        bookmaker: odds.bookmakerTitle || odds.bookmaker,
        lastUpdate: odds.lastUpdate,
      } : null,
      edge: edge,
      edgeValue: edge?.edge || -999,
      hasEdge: edge?.isPlayable || false,
    });
  }

  analyses.sort((a, b) => b.edgeValue - a.edgeValue);

  const elapsed = Date.now() - startTime;
  console.log(`Analysis complete! ${analyses.length} players in ${(elapsed/1000).toFixed(1)}s`);
  console.log(`${analyses.filter(a => a.hasEdge).length} playable edges found`);

  return {
    games,
    analyses,
    standings,
    weights,
    b2bTeams: Object.entries(b2bMap).filter(([,v]) => v).map(([k]) => k),
    timestamp: new Date().toISOString(),
    loadTime: elapsed,
    playersScanned: players.length,
    edgesFound: analyses.filter(a => a.hasEdge).length,
  };
}
