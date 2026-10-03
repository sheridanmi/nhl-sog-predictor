import { db } from '../firebase.js';
import { collection, query, where, getDocs, limit } from 'firebase/firestore';

const SNAPSHOTS = 'snapshots';
const SUMMARIES = 'snapshot_summaries';

// The 2026-27 season actually started here. Snapshots from before this date
// are leftover dev/test data from when this project was first being built —
// they predate the real model entirely and would otherwise silently wreck
// every stat on this tab (e.g. a 2.4% win rate pulling in 6 months of
// unrelated test data alongside ~4 real nights). Update alongside SEASON /
// SEASON_START_DATE in daily-fetch.cjs each year.
const SEASON_START_DATE = '2026-09-29';

// ============================================================
// FETCHING
// ============================================================

// Single read of the snapshots collection for the whole Backtest tab. This
// used to be two separate near-full-collection queries (one filtered to
// settled, one unfiltered for the strong-edge log) — on a free Spark-plan
// Firestore project (50k reads/day), that was burning through the daily
// quota in a handful of page loads. Everything below derives from this one
// fetch in memory instead of hitting Firestore again.
export async function getAllSnapshots(maxDocs = 5000) {
  const q = query(collection(db, SNAPSHOTS), limit(maxDocs));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => (s.gameDate || '') >= SEASON_START_DATE);
}

export function filterSettled(allSnapshots) {
  return allSnapshots.filter(s => s.settled === true);
}

// Every pick the model has ever flagged at or above a given edge threshold —
// settled AND still-pending — not just the ones the user placed a bet on.
// This is the model's own track record, independent of the user's Results Tracker.
export function filterStrongEdges(allSnapshots, minEdge = 10) {
  return allSnapshots
    .filter(s => (s.edge ?? -999) >= minEdge)
    .sort((a, b) => (b.gameDate || '').localeCompare(a.gameDate || ''));
}

export async function getSnapshotSummaries() {
  const snap = await getDocs(collection(db, SUMMARIES));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => (s.gameDate || s.id || '') >= SEASON_START_DATE)
    .sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || ''));
}

// ============================================================
// ANALYSIS
// ============================================================

function isDecided(s) {
  return s.overResult === 'won' || s.overResult === 'lost';
}

export function calcOverallStats(snapshots) {
  const decided = snapshots.filter(isDecided);
  const won = decided.filter(s => s.overResult === 'won').length;
  const lost = decided.filter(s => s.overResult === 'lost').length;
  const pushed = snapshots.filter(s => s.overResult === 'push').length;

  let totalReturn = 0;
  decided.forEach(s => {
    if (s.overResult === 'won') {
      const odds = s.overOdds || -110;
      totalReturn += odds > 0 ? odds / 100 : 100 / Math.abs(odds);
    } else {
      totalReturn -= 1;
    }
  });

  return {
    totalSnapshots: snapshots.length,
    decided: decided.length,
    won,
    lost,
    pushed,
    winRate: decided.length > 0 ? +((won / decided.length) * 100).toFixed(1) : null,
    roi: decided.length > 0 ? +((totalReturn / decided.length) * 100).toFixed(1) : null,
  };
}

// Does a bigger stated edge actually win more often?
export function calcEdgeBucketStats(snapshots) {
  const bucketDefs = [
    { key: 'negative', label: '< 0%', min: -Infinity, max: 0 },
    { key: 'slim', label: '0-2%', min: 0, max: 2 },
    { key: 'small', label: '2-5%', min: 2, max: 5 },
    { key: 'moderate', label: '5-10%', min: 5, max: 10 },
    { key: 'strong', label: '10%+', min: 10, max: Infinity },
  ];
  const results = bucketDefs.map(b => ({ ...b, total: 0, won: 0 }));

  snapshots.filter(isDecided).forEach(s => {
    const edge = s.edge ?? 0;
    const bucket = results.find(b => edge >= b.min && edge < b.max);
    if (bucket) {
      bucket.total++;
      if (s.overResult === 'won') bucket.won++;
    }
  });

  return results.map(b => ({
    key: b.key,
    label: b.label,
    total: b.total,
    won: b.won,
    winRate: b.total > 0 ? +((b.won / b.total) * 100).toFixed(1) : null,
  }));
}

// When the model says X%, does it actually hit ~X% of the time?
export function calcCalibrationCurve(snapshots, binSize = 10) {
  const decided = snapshots.filter(isDecided).filter(s => s.modelProb != null);
  const bins = {};
  for (let lo = 0; lo < 100; lo += binSize) {
    bins[lo] = { lo, hi: lo + binSize, total: 0, won: 0 };
  }

  decided.forEach(s => {
    const p = Math.min(99.99, Math.max(0, s.modelProb));
    const binLo = Math.floor(p / binSize) * binSize;
    if (bins[binLo]) {
      bins[binLo].total++;
      if (s.overResult === 'won') bins[binLo].won++;
    }
  });

  return Object.values(bins)
    .filter(b => b.total > 0)
    .map(b => ({
      bucket: `${b.lo}-${b.hi}%`,
      predicted: b.lo + binSize / 2,
      actual: +((b.won / b.total) * 100).toFixed(1),
      total: b.total,
    }));
}

// Generic split by any key — position, home/away, B2B, etc.
export function calcSplitStats(snapshots, keyFn, labelFn = k => k) {
  const decided = snapshots.filter(isDecided);
  const groups = {};
  decided.forEach(s => {
    const key = keyFn(s);
    if (key == null) return;
    if (!groups[key]) groups[key] = { total: 0, won: 0 };
    groups[key].total++;
    if (s.overResult === 'won') groups[key].won++;
  });
  return Object.entries(groups)
    .map(([key, g]) => ({
      key,
      label: labelFn(key),
      total: g.total,
      won: g.won,
      winRate: g.total > 0 ? +((g.won / g.total) * 100).toFixed(1) : null,
    }))
    .sort((a, b) => b.total - a.total);
}

// CLV (closing line value): did the market move toward your entry price after
// you got it, or away from it? Positive average CLV is the standard proxy for
// "you have a real edge" independent of whether any individual pick won — it
// doesn't wait for the game to finish the way win-rate does.
export function calcCLVStats(snapshots) {
  const withCLV = snapshots.filter(s => s.clv != null);
  if (!withCLV.length) return { count: 0, avgCLV: null, positiveRate: null };
  const avgCLV = withCLV.reduce((sum, s) => sum + s.clv, 0) / withCLV.length;
  const positive = withCLV.filter(s => s.clv > 0).length;
  return {
    count: withCLV.length,
    avgCLV: +avgCLV.toFixed(2),
    positiveRate: +((positive / withCLV.length) * 100).toFixed(1),
  };
}
