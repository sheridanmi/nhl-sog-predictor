export const DEFAULT_WEIGHTS = {
  seasonAvgSOG: 0.20,
  last5AvgSOG: 0.25,
  last10AvgSOG: 0.15,
  homeAwayAdj: 0.05,
  oppShotsAgainst: 0.10,
  toiTrend: 0.08,
  ppTimeFactor: 0.07,
  backToBack: 0.03,
  oppGoalieSVPct: 0.04,
  vegasTotal: 0.03,
};

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 1;
  const avg = mean(arr);
  const squareDiffs = arr.map(v => Math.pow(v - avg, 2));
  return Math.sqrt(mean(squareDiffs));
}

function round(num, decimals) {
  return +num.toFixed(decimals);
}

function americanToImpliedProb(americanOdds) {
  if (americanOdds < 0) return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
  return 100 / (americanOdds + 100);
}

function americanToDecimal(americanOdds) {
  if (americanOdds < 0) return 1 + (100 / Math.abs(americanOdds));
  return 1 + (americanOdds / 100);
}

function calculateConfidence(sd, sampleSize) {
  const sizeFactor = Math.min(1, sampleSize / 30);
  const varianceFactor = Math.max(0, 1 - (sd / 4));
  return round((sizeFactor * 0.6 + varianceFactor * 0.4) * 100, 0);
}

export function runSimulation(player, matchupContext = {}, weights = DEFAULT_WEIGHTS, iterations = 10000) {
  const { gameLog } = player;
  if (!gameLog || gameLog.length < 3) {
    return { projection: 0, stdDev: 0, distribution: {}, probabilities: {}, factors: {}, iterations: 0, confidence: 0, error: `Insufficient data for ${player.name || 'player'}` };
  }

  const allSOG = gameLog.map(g => g.shots);
  const seasonAvg = mean(allSOG);
  const last5 = gameLog.slice(-5);
  const last10 = gameLog.slice(-10);
  const last5Avg = mean(last5.map(g => g.shots));
  const last10Avg = mean(last10.map(g => g.shots));
  const allTOI = gameLog.map(g => g.toiMinutes);
  const avgTOI = mean(allTOI);
  const recentTOI = mean(last5.map(g => g.toiMinutes));
  const allPPTOI = gameLog.map(g => g.ppToiMinutes);
  const avgPPTOI = mean(allPPTOI);

  const homeGames = gameLog.filter(g => g.homeAway === 'home');
  const awayGames = gameLog.filter(g => g.homeAway === 'away');
  const homeAvg = homeGames.length > 2 ? mean(homeGames.map(g => g.shots)) : seasonAvg;
  const awayAvg = awayGames.length > 2 ? mean(awayGames.map(g => g.shots)) : seasonAvg;
  const homeAwayAdj = player.homeAway === 'home' ? (homeAvg - seasonAvg) : (awayAvg - seasonAvg);

  let projection = 0;
  projection += seasonAvg * weights.seasonAvgSOG;
  projection += last5Avg * weights.last5AvgSOG;
  projection += last10Avg * weights.last10AvgSOG;
  const baseWeight = weights.seasonAvgSOG + weights.last5AvgSOG + weights.last10AvgSOG;
  projection = projection / baseWeight;

  projection += homeAwayAdj * weights.homeAwayAdj * 5;

  const leagueAvgSA = matchupContext.leagueAvgShotsAgainst || 30.0;
  const oppSA = matchupContext.oppShotsAgainstPerGame || leagueAvgSA;
  const oppFactor = (oppSA - leagueAvgSA) / leagueAvgSA;
  projection += projection * oppFactor * (weights.oppShotsAgainst * 5);

  if (avgTOI > 0) {
    const toiFactor = (recentTOI - avgTOI) / avgTOI;
    projection += projection * toiFactor * (weights.toiTrend * 5);
  }

  const ppBaseline = 3.5;
  if (avgPPTOI > 0) {
    const ppBoost = ((avgPPTOI - ppBaseline) / ppBaseline) * 0.5;
    projection += ppBoost * weights.ppTimeFactor * 10;
  }

  if (matchupContext.isBackToBack) projection *= (1 - weights.backToBack * 3);

  const leagueAvgSV = 0.908;
  const oppGoalieSV = matchupContext.oppGoalieSavePct || leagueAvgSV;
  const goalieFactor = (leagueAvgSV - oppGoalieSV) * 10;
  projection += goalieFactor * weights.oppGoalieSVPct * 10;

  const avgGameTotal = 6.0;
  const vegasTotal = matchupContext.vegasTotal || avgGameTotal;
  const paceFactor = (vegasTotal - avgGameTotal) / avgGameTotal;
  projection += projection * paceFactor * (weights.vegasTotal * 5);

  projection = Math.max(0.5, projection);

  const sogStdDev = stdDev(allSOG);

  const results = [];
  for (let i = 0; i < iterations; i++) {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const simSOG = Math.max(0, Math.round(projection + z * sogStdDev));
    results.push(simSOG);
  }

  const distribution = {};
  for (let i = 0; i <= 12; i++) distribution[i] = 0;
  results.forEach(r => { const key = Math.min(r, 12); distribution[key] = (distribution[key] || 0) + 1; });

  const probabilities = {};
  for (let threshold = 0.5; threshold <= 8.5; threshold += 1) {
    probabilities[threshold] = results.filter(r => r > threshold).length / iterations;
  }

  const factors = {
    seasonAvg: round(seasonAvg, 2),
    last5Avg: round(last5Avg, 2),
    last10Avg: round(last10Avg, 2),
    homeAwayAdj: round(homeAwayAdj, 2),
    homeAvg: round(homeAvg, 2),
    awayAvg: round(awayAvg, 2),
    oppSAPerGame: round(oppSA, 1),
    avgTOI: round(avgTOI, 1),
    recentTOI: round(recentTOI, 1),
    avgPPTOI: round(avgPPTOI, 1),
    isBackToBack: !!matchupContext.isBackToBack,
    oppGoalie: matchupContext.oppGoalieName || 'Unknown',
    oppGoalieSV: matchupContext.oppGoalieSavePct || null,
    oppPKPct: matchupContext.oppPKPct || null,
    vegasTotal: vegasTotal,
    last5Direction: last5Avg > seasonAvg ? 'positive' : last5Avg < seasonAvg - 0.3 ? 'negative' : 'neutral',
    oppDirection: oppSA > 30 ? 'positive' : oppSA < 28 ? 'negative' : 'neutral',
    toiDirection: recentTOI > avgTOI + 0.5 ? 'positive' : recentTOI < avgTOI - 0.5 ? 'negative' : 'neutral',
    goalieDirection: oppGoalieSV < 0.905 ? 'positive' : oppGoalieSV > 0.915 ? 'negative' : 'neutral',
  };

  return {
    projection: round(projection, 2),
    stdDev: round(sogStdDev, 2),
    distribution,
    probabilities,
    factors,
    iterations,
    confidence: calculateConfidence(sogStdDev, gameLog.length),
  };
}

export function calculateEdge(modelProb, bookOdds) {
  const impliedProb = americanToImpliedProb(bookOdds);
  const edge = (modelProb - impliedProb) * 100;
  let rating;
  if (edge >= 10) rating = 'STRONG';
  else if (edge >= 5) rating = 'MODERATE';
  else if (edge >= 2) rating = 'SLIM';
  else rating = 'NO_EDGE';
  const decimalOdds = americanToDecimal(bookOdds);
  const b = decimalOdds - 1;
  const kellyFraction = Math.max(0, (b * modelProb - (1 - modelProb)) / b);
  return {
    edge: round(edge, 2),
    modelProb: round(modelProb * 100, 1),
    impliedProb: round(impliedProb * 100, 1),
    rating,
    isPlayable: edge >= 3,
    kellyFraction: round(kellyFraction, 4),
    suggestedKelly: round(kellyFraction * 0.25, 4),
  };
}
