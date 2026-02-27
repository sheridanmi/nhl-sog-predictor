const ODDS_BASE = '/odds-api/v4';
const SPORT = 'icehockey_nhl';
let apiKey = '';

export function setOddsApiKey(key) { apiKey = key; }
export function getOddsApiKey() { return apiKey; }

export async function getNHLEvents() {
  if (!apiKey) { console.warn('No Odds API key set.'); return []; }
  try {
    const res = await fetch(`${ODDS_BASE}/sports/${SPORT}/events?apiKey=${apiKey}&dateFormat=iso`);
    if (!res.ok) { console.error('Odds API events error:', res.status); return []; }
    const events = await res.json();
    const remaining = res.headers.get('x-requests-remaining');
    if (remaining) console.log(`Odds API quota remaining: ${remaining}`);
    return events.map(event => ({
      id: event.id,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      commenceTime: event.commence_time,
    }));
  } catch (error) {
    console.error('Error fetching NHL events:', error);
    return [];
  }
}

export async function getPlayerSOGProps(eventId) {
  if (!apiKey) return [];
  try {
    const url = `${ODDS_BASE}/sports/${SPORT}/events/${eventId}/odds?apiKey=${apiKey}&regions=us&markets=player_shots_on_goal&oddsFormat=american&dateFormat=iso`;
    const res = await fetch(url);
    if (!res.ok) { console.error(`Odds API SOG error for ${eventId}:`, res.status); return []; }
    const data = await res.json();
    const remaining = res.headers.get('x-requests-remaining');
    if (remaining) console.log(`Odds API quota remaining: ${remaining}`);
    const playerProps = [];
    if (data.bookmakers) {
      for (const bookmaker of data.bookmakers) {
        const sogMarket = bookmaker.markets?.find(m => m.key === 'player_shots_on_goal');
        if (!sogMarket) continue;
        const playerOutcomes = {};
        for (const outcome of sogMarket.outcomes) {
          const name = outcome.description;
          if (!playerOutcomes[name]) {
            playerOutcomes[name] = {
              playerName: name,
              bookmaker: bookmaker.key,
              bookmakerTitle: bookmaker.title,
              lastUpdate: sogMarket.last_update,
            };
          }
          if (outcome.name === 'Over') {
            playerOutcomes[name].overOdds = outcome.price;
            playerOutcomes[name].line = outcome.point;
          } else if (outcome.name === 'Under') {
            playerOutcomes[name].underOdds = outcome.price;
            playerOutcomes[name].line = outcome.point;
          }
        }
        playerProps.push(...Object.values(playerOutcomes));
      }
    }
    return playerProps;
  } catch (error) {
    console.error(`Error fetching SOG props for ${eventId}:`, error);
    return [];
  }
}

export async function fetchAllSOGProps() {
  console.log('Fetching betting lines...');
  const events = await getNHLEvents();
  const today = new Date().toISOString().split('T')[0];
  const todaysEvents = events.filter(e => e.commenceTime?.split('T')[0] === today);
  const eventsToFetch = todaysEvents.length > 0 ? todaysEvents : events.slice(0, 8);
  console.log(`Fetching SOG props for ${eventsToFetch.length} events`);
  const allProps = {};
  for (const event of eventsToFetch) {
    console.log(`  ${event.awayTeam} @ ${event.homeTeam}`);
    const props = await getPlayerSOGProps(event.id);
    for (const prop of props) {
      const key = prop.playerName;
      if (!allProps[key] || prop.bookmaker === 'draftkings') {
        allProps[key] = { ...prop, eventId: event.id, homeTeam: event.homeTeam, awayTeam: event.awayTeam };
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`Loaded SOG props for ${Object.keys(allProps).length} players`);
  return allProps;
}

export function matchPlayerName(oddsName, nhlPlayers) {
  const normalized = oddsName.toLowerCase().trim();
  const exact = nhlPlayers.find(p =>
    p.name?.toLowerCase() === normalized ||
    `${p.firstName} ${p.lastName}`.toLowerCase() === normalized
  );
  if (exact) return exact;
  const parts = normalized.split(' ');
  const lastName = parts[parts.length - 1];
  return nhlPlayers.find(p =>
    p.lastName?.toLowerCase() === lastName || p.name?.toLowerCase().endsWith(lastName)
  ) || null;
}

export function americanToImpliedProb(odds) {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100);
  return 100 / (odds + 100);
}

export function formatAmericanOdds(odds) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}
