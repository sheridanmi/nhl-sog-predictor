const NHL_BASE = '/nhl-api/v1';

/**
 * Fetches the game preview/landing for a specific game to get confirmed starters.
 * Falls back to usage-based starter guess if not confirmed.
 */
export async function getConfirmedStarters(gameId) {
  try {
    const res = await fetch(`${NHL_BASE}/gamecenter/${gameId}/play-by-play`);
    const data = await res.json();

    const starters = { home: null, away: null };

    if (data.homeTeam?.goalies) {
      const starter = data.homeTeam.goalies.find(g => g.starter);
      if (starter) {
        starters.home = {
          id: starter.playerId,
          name: `${starter.name?.default || 'Unknown'}`,
          confirmed: true,
        };
      }
    }

    if (data.awayTeam?.goalies) {
      const starter = data.awayTeam.goalies.find(g => g.starter);
      if (starter) {
        starters.away = {
          id: starter.playerId,
          name: `${starter.name?.default || 'Unknown'}`,
          confirmed: true,
        };
      }
    }

    return starters;
  } catch {
    return { home: null, away: null };
  }
}

/**
 * Gets goalie stats for a specific player to enrich the matchup context.
 */
export async function getGoalieStats(playerId) {
  try {
    const res = await fetch(`${NHL_BASE}/player/${playerId}/landing`);
    const data = await res.json();
    const stats = data.featuredStats?.regularSeason?.subSeason;
    return {
      id: playerId,
      name: `${data.firstName?.default} ${data.lastName?.default}`,
      savePct: stats?.savePctg || null,
      goalsAgainstAvg: stats?.goalsAgainstAvg || null,
      gamesStarted: stats?.gamesStarted || 0,
      wins: stats?.wins || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Builds a map of gameId -> { homeGoalie, awayGoalie } with confirmed starters
 * and their full stats. Falls back gracefully to TBD.
 */
export async function buildGoalieMap(games) {
  const goalieMap = {};

  await Promise.all(games.map(async (game) => {
    const starters = await getConfirmedStarters(game.id);

    const [homeStats, awayStats] = await Promise.all([
      starters.home?.id ? getGoalieStats(starters.home.id) : Promise.resolve(null),
      starters.away?.id ? getGoalieStats(starters.away.id) : Promise.resolve(null),
    ]);

    goalieMap[game.id] = {
      home: homeStats || { name: 'TBD', savePct: null, confirmed: false },
      away: awayStats || { name: 'TBD', savePct: null, confirmed: false },
      homeConfirmed: !!starters.home,
      awayConfirmed: !!starters.away,
    };

    const homeLabel = goalieMap[game.id].homeConfirmed
      ? `✅ ${goalieMap[game.id].home.name}`
      : '❓ TBD';
    const awayLabel = goalieMap[game.id].awayConfirmed
      ? `✅ ${goalieMap[game.id].away.name}`
      : '❓ TBD';
    console.log(`🥅 ${game.awayTeam.abbrev} @ ${game.homeTeam.abbrev}: ${awayLabel} vs ${homeLabel}`);
  }));

  return goalieMap;
}
