/**
 * SHOP-LINES: compare every sportsbook's price on a player prop against the
 * rest of the market.
 *
 * Why this exists: the Monte Carlo projection turned out to add nothing beyond
 * what the market already knows (see the calibration report). What CAN still be
 * found is a single book posting a price that is stale or off relative to the
 * others. For each player this module:
 *   1. takes the books that post the CONSENSUS line (most books agree on it),
 *   2. removes each book's vig to get its "fair" over probability,
 *   3. for every book, builds a leave-one-out benchmark = the MEDIAN fair
 *      probability of the OTHER books (so an outlier can't drag its own yardstick),
 *   4. edge = benchmark fair prob - the probability implied by that book's price,
 *      for the Over price and for the Under price,
 *   5. keeps the best Over and best Under price and flags the better one.
 *
 * Pure functions, no network, no Firebase: safe to unit-test offline.
 */

// ---- tunables --------------------------------------------------------------
const MIN_OTHERS = 3;      // benchmark needs >= 3 OTHER two-sided books (so >= 4 books total)
const FLAG_MIN = 2.0;      // edge (percentage points) to flag as SHOP
const FLAG_STRONG = 4.0;   // ... as SHOP+
const SUSPECT_EDGE = 10.0; // an "edge" this big is usually a stale line, wrong player, or voided line
const SUSPECT_SPREAD = 8;  // the OTHER books disagree by more than this many points -> benchmark unreliable (normal is 1-3)

function impliedProb(american) {
  return american < 0 ? Math.abs(american) / (Math.abs(american) + 100) : 100 / (american + 100);
}

// Remove the vig by proportional normalisation: fair over prob given both sides.
function devigOver(overOdds, underOdds) {
  const po = impliedProb(overOdds), pu = impliedProb(underOdds);
  return po / (po + pu);
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function r(x, d) { return +x.toFixed(d); }

/**
 * offers: [{ bookmaker, bookmakerTitle, line, overOdds, underOdds }]  (one per book per line)
 * opts.line: force the line to evaluate (callers pass the line already chosen for
 *            the snapshot so shop data always refers to the same bet).
 */
function computeShop(offers, opts = {}) {
  const clean = [];
  const seen = new Set();
  for (const o of offers || []) {
    if (o == null || o.line == null) continue;
    const key = `${o.bookmaker}|${o.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(o);
  }

  // Compact record of every price we saw, for storage / later analysis.
  const books = clean.map(o => ({ b: o.bookmaker, l: o.line, o: o.overOdds ?? null, u: o.underOdds ?? null }));

  // Consensus line: the one most books post (same rule daily-fetch uses).
  let line = opts.line;
  if (line == null) {
    const byLine = {};
    for (const o of clean.filter(x => x.overOdds != null)) (byLine[o.line] = byLine[o.line] || []).push(o);
    let maxCount = 0;
    for (const [l, arr] of Object.entries(byLine)) if (arr.length > maxCount) { maxCount = arr.length; line = parseFloat(l); }
  }

  const base = { line: line ?? null, books, nBooks: 0, nTwoSided: 0, consensusOver: null, spread: null,
    side: null, edge: null, fairProb: null, bestBook: null, bestTitle: null, bestOdds: null,
    bestOver: null, bestUnder: null, flag: 'NONE', reason: null };
  if (line == null) return { ...base, reason: 'no-line' };

  const atLine = clean.filter(o => o.line === line);
  const withOver = atLine.filter(o => o.overOdds != null);
  const twoSided = atLine
    .filter(o => o.overOdds != null && o.underOdds != null)
    .map(o => ({ ...o, fairOver: devigOver(o.overOdds, o.underOdds) }));
  base.nBooks = atLine.length;
  base.nTwoSided = twoSided.length;
  if (twoSided.length) {
    const fairs = twoSided.map(o => o.fairOver);
    base.consensusOver = r(median(fairs), 4);
    base.spread = r((Math.max(...fairs) - Math.min(...fairs)) * 100, 1);
  }
  if (twoSided.length < MIN_OTHERS + 1) return { ...base, reason: 'few-books' };

  const benchmarkFor = (book) => {
    const others = twoSided.filter(o => o.bookmaker !== book).map(o => o.fairOver);
    return others.length >= MIN_OTHERS ? median(others) : null;
  };

  let bestOver = null, bestUnder = null;
  for (const o of withOver) {
    const bench = benchmarkFor(o.bookmaker);
    if (bench == null) continue;
    const edge = (bench - impliedProb(o.overOdds)) * 100;
    if (!bestOver || edge > bestOver.edge) {
      bestOver = { book: o.bookmaker, title: o.bookmakerTitle || o.bookmaker, odds: o.overOdds, edge: r(edge, 2), fairProb: r(bench, 4) };
    }
  }
  for (const o of atLine.filter(x => x.underOdds != null)) {
    const bench = benchmarkFor(o.bookmaker);
    if (bench == null) continue;
    const edge = ((1 - bench) - impliedProb(o.underOdds)) * 100;
    if (!bestUnder || edge > bestUnder.edge) {
      bestUnder = { book: o.bookmaker, title: o.bookmakerTitle || o.bookmaker, odds: o.underOdds, edge: r(edge, 2), fairProb: r(1 - bench, 4) };
    }
  }
  base.bestOver = bestOver;
  base.bestUnder = bestUnder;

  const pick = (bestOver && bestUnder) ? (bestOver.edge >= bestUnder.edge ? 'over' : 'under') : (bestOver ? 'over' : bestUnder ? 'under' : null);
  if (!pick) return { ...base, reason: 'no-prices' };
  const chosen = pick === 'over' ? bestOver : bestUnder;
  // Judge market disagreement on the books we're comparing AGAINST, not on the
  // outlier itself, otherwise any big mispricing would look like "the books disagree".
  const others = twoSided.filter(o => o.bookmaker !== chosen.book).map(o => o.fairOver);
  if (others.length) base.spread = r((Math.max(...others) - Math.min(...others)) * 100, 1);
  base.side = pick;
  base.edge = chosen.edge;
  base.fairProb = chosen.fairProb;
  base.bestBook = chosen.book;
  base.bestTitle = chosen.title;
  base.bestOdds = chosen.odds;

  if (chosen.edge >= SUSPECT_EDGE || (base.spread != null && base.spread > SUSPECT_SPREAD && chosen.edge >= FLAG_MIN)) base.flag = 'CHECK';
  else if (chosen.edge >= FLAG_STRONG) base.flag = 'SHOP+';
  else if (chosen.edge >= FLAG_MIN) base.flag = 'SHOP';
  return base;
}

module.exports = { computeShop, impliedProb, devigOver, median, MIN_OTHERS, FLAG_MIN, FLAG_STRONG, SUSPECT_EDGE, SUSPECT_SPREAD };
