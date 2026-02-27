const NHL_BASE = '/nhl-api/v1';

function parseToiToMinutes(toiStr) {
  if (!toiStr) return 0;
  const parts = toiStr.split(':');
  if (parts.length !== 2) return 0;
  return parseInt(parts[0]) + parseInt(parts[1]) / 60;
}

export async function getTodaysGames(date = null) {
  const d = date || new Date().toISOString().split('T')[0];
  try {
    const res = await fetch(`${NHL_BASE}/schedule/${d}`);
    const data = await res.json();
    const todayData = data.gameWeek?.find(day => day.date === d);
    if (!todayData) return [];
    return todayData.games.map(game => ({
      id: game.id,
      startTime: game.startTimeUTC,
      gameState: game.gameState,
      awayTeam: {
        abbrev: game.awayTeam.abbrev,
        name: game.awayTeam.placeName?.default || game.awayTeam.abbrev,
        id: game.awayTeam.id,
        logo: game.awayTeam.logo,
      },
      homeTeam: {
        abbrev: game.homeTeam.abbrev,
        name: game.homeTeam.placeName?.default || game.homeTeam.abbrev,
        id: game.homeTeam.id,
        logo: game.homeTeam.logo,
      },
      venue: game.venue?.default,
    }));
  } catch (error) {
    console.error('Error fetching schedule:', error);
    return [];
  }
}

export async function getTeamRoster(teamAbbrev) {
  try {
    const res = await fetch(`${NHL_BASE}/roster/${teamAbbrev}/current`);
    const data = await res.json();
    const mapPlayer = (p) => ({
      id: p.id,
      firstName: p.firstName?.default,
      lastName: p.lastName?.default,
      fullName: `${p.firstName?.default} ${p.lastName?.default}`,
      number: p.sweaterNumber,
      position: p.positionCode,
      headshot: p.headshot,
    });
    return {
      forwards: (data.forwards || []).map(mapPlayer),
      defensemen: (data.defensemen || []).map(mapPlayer),
      goalies: (data.goalies || []).map(mapPlayer),
    };
  } catch (error) {
    console.error(`Error fetching roster for ${teamAbbrev}:`, error);
    return { forwards: [], defensemen: [], goalies: [] };
  }
}

export async function getPlayerGameLog(playerId, season = '20252026') {
  try {
    const res = await fetch(`${NHL_BASE}/player/${playerId}/game-log/${season}/2`);
    const data = await res.json();
    if (!data.gameLog) return [];
    return data.gameLog.map(game => ({
      gameId: game.gameId,
      date: game.gameDate,
      opponent: game.opponentAbbrev?.default,
      homeAway: game.homeRoadFlag === 'H' ? 'home' : 'away',
      goals: game.goals || 0,
      assists: game.assists || 0,
      points: game.points || 0,
      shots: game.shots || 0,
      pim: game.pim || 0,
      plusMinus: game.plusMinus || 0,
      toi: game.toi || '0:00',
      toiMinutes: parseToiToMinutes(game.toi),
      ppToi: game.powerPlayToi || '0:00',
      ppToiMinutes: parseToiToMinutes(game.powerPlayToi),
      powerPlayGoals: game.powerPlayGoals || 0,
      shifts: game.shifts || 0,
    }));
  } catch (error) {
    console.error(`Error fetching game log for player ${playerId}:`, error);
    return [];
  }
}

export async function getPlayerInfo(playerId) {
  try {
    const res = await fetch(`${NHL_BASE}/player/${playerId}/landing`);
    const data = await res.json();
    const currentSeason = data.featuredStats?.regularSeason?.subSeason;
    return {
      id: data.playerId,
      firstName: data.firstName?.default,
      lastName: data.lastName?.default,
      fullName: `${data.firstName?.default} ${data.lastName?.default}`,
      team: data.currentTeamAbbrev,
      position: data.position,
      headshot: data.headshot,
      isActive: data.isActive,
      seasonStats: currentSeason ? {
        gamesPlayed: currentSeason.gamesPlayed,
        goals: currentSeason.goals,
        assists: currentSeason.assists,
        shots: currentSeason.shots,
        avgToi: currentSeason.avgToi,
        powerPlayGoals: currentSeason.powerPlayGoals,
      } : null,
    };
  } catch (error) {
    console.error(`Error fetching player info for ${playerId}:`, error);
    return null;
  }
}

export async function getTeamStats(teamAbbrev) {
  try {
    const res = await fetch(`${NHL_BASE}/club-stats/${teamAbbrev}/now`);
    const data = await res.json();
    const goalies = data.goalies || [];
    return {
      teamAbbrev,
      goalies: goalies.map(g => ({
        id: g.playerId,
        name: `${g.firstName?.default} ${g.lastName?.default}`,
        gamesPlayed: g.gamesPlayed,
        gamesStarted: g.gamesStarted,
        wins: g.wins,
        losses: g.losses,
        savePct: g.savePctg,
        goalsAgainstAvg: g.goalsAgainstAvg,
        shotsAgainst: g.shotsAgainst,
        saves: g.saves,
      })),
    };
  } catch (error) {
    console.error(`Error fetching team stats for ${teamAbbrev}:`, error);
    return { teamAbbrev, goalies: [] };
  }
}

export async function getStandings() {
  try {
    const res = await fetch(`${NHL_BASE}/standings/now`);
    const data = await res.json();
    return (data.standings || []).map(team => ({
      teamAbbrev: team.teamAbbrev?.default,
      teamName: team.teamName?.default,
      gamesPlayed: team.gamesPlayed,
      wins: team.wins,
      losses: team.losses,
      points: team.points,
      goalsFor: team.goalFor,
      goalsAgainst: team.goalAgainst,
    }));
  } catch (error) {
    console.error('Error fetching standings:', error);
    return [];
  }
}

export async function fetchTeamPlayersForTonight(teamAbbrev, opponentAbbrev, homeAway, season = '20252026') {
  const roster = await getTeamRoster(teamAbbrev);
  const skaters = [...roster.forwards, ...roster.defensemen];
  const playerData = [];
  for (let i = 0; i < skaters.length; i += 5) {
    const batch = skaters.slice(i, i + 5);
    const batchResults = await Promise.all(
      batch.map(async (skater) => {
        try {
          const [gameLog, info] = await Promise.all([
            getPlayerGameLog(skater.id, season),
            getPlayerInfo(skater.id),
          ]);
          if (!gameLog || gameLog.length < 5) return null;
          return {
            id: skater.id,
            name: skater.fullName,
            firstName: skater.firstName,
            lastName: skater.lastName,
            team: teamAbbrev,
            opponent: opponentAbbrev,
            homeAway,
            position: skater.position,
            number: skater.number,
            headshot: skater.headshot,
            gameLog,
            seasonStats: info?.seasonStats || null,
            seasonAvgSOG: gameLog.reduce((s, g) => s + g.shots, 0) / gameLog.length,
            seasonAvgTOI: gameLog.reduce((s, g) => s + g.toiMinutes, 0) / gameLog.length,
            seasonAvgPPTOI: gameLog.reduce((s, g) => s + g.ppToiMinutes, 0) / gameLog.length,
          };
        } catch (err) {
          return null;
        }
      })
    );
    playerData.push(...batchResults.filter(Boolean));
    if (i + 5 < skaters.length) await new Promise(r => setTimeout(r, 300));
  }
  return playerData;
}

export async function fetchAllTonightData() {
  console.log('🏒 Fetching tonight\'s NHL data...');
  const games = await getTodaysGames();
  console.log(`📅 Found ${games.length} games tonight`);
  if (games.length === 0) return { games: [], players: [], standings: [] };
  const standings = await getStandings();
  const allPlayers = [];
  for (const game of games) {
    console.log(`📊 Fetching ${game.awayTeam.abbrev} @ ${game.homeTeam.abbrev}...`);
    const [awayPlayers, homePlayers] = await Promise.all([
      fetchTeamPlayersForTonight(game.awayTeam.abbrev, game.homeTeam.abbrev, 'away'),
      fetchTeamPlayersForTonight(game.homeTeam.abbrev, game.awayTeam.abbrev, 'home'),
    ]);
    allPlayers.push(
      ...awayPlayers.map(p => ({ ...p, gameId: game.id, gameTime: game.startTime })),
      ...homePlayers.map(p => ({ ...p, gameId: game.id, gameTime: game.startTime })),
    );
  }
  console.log(`✅ Loaded data for ${allPlayers.length} players across ${games.length} games`);
  return { games, players: allPlayers, standings };
}
