const NHL_BASE = '/nhl-api/v1';

/**
 * Fetches yesterday's games and returns a Set of team abbrevs that played.
 */
export async function getTeamsPlayedYesterday() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];

  try {
    const res = await fetch(`${NHL_BASE}/schedule/${dateStr}`);
    const data = await res.json();
    const dayData = data.gameWeek?.find(d => d.date === dateStr);
    if (!dayData) return new Set();

    const teams = new Set();
    for (const game of dayData.games) {
      teams.add(game.homeTeam.abbrev);
      teams.add(game.awayTeam.abbrev);
    }
    return teams;
  } catch (err) {
    console.error('Error fetching yesterday schedule:', err);
    return new Set();
  }
}

/**
 * Given the list of tonight's games, returns a Map of teamAbbrev -> isBackToBack
 */
export async function buildBackToBackMap(tonightGames) {
  const playedYesterday = await getTeamsPlayedYesterday();
  const b2bMap = {};

  for (const game of tonightGames) {
    b2bMap[game.homeTeam.abbrev] = playedYesterday.has(game.homeTeam.abbrev);
    b2bMap[game.awayTeam.abbrev] = playedYesterday.has(game.awayTeam.abbrev);
  }

  const b2bTeams = Object.entries(b2bMap).filter(([, v]) => v).map(([k]) => k);
  if (b2bTeams.length > 0) {
    console.log(`🔄 Back-to-back teams tonight: ${b2bTeams.join(', ')}`);
  }

  return b2bMap;
}
