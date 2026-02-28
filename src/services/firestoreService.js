import { db } from '../firebase.js';
import {
  collection, addDoc, updateDoc, deleteDoc,
  doc, getDocs, query, orderBy, serverTimestamp
} from 'firebase/firestore';

const PICKS_COLLECTION = 'picks';

export async function savePick(pick) {
  const docRef = await addDoc(collection(db, PICKS_COLLECTION), {
    ...pick,
    createdAt: serverTimestamp(),
    status: 'pending', // pending | won | lost | push
    actualSOG: null,
  });
  return docRef.id;
}

export async function updatePickResult(pickId, actualSOG) {
  const ref = doc(db, PICKS_COLLECTION, pickId);
  const pick = await getPickById(pickId);
  let status = 'push';
  if (actualSOG > pick.line) status = pick.betSide === 'over' ? 'won' : 'lost';
  else if (actualSOG < pick.line) status = pick.betSide === 'over' ? 'lost' : 'won';
  await updateDoc(ref, { actualSOG, status, settledAt: serverTimestamp() });
}

export async function deletePick(pickId) {
  await deleteDoc(doc(db, PICKS_COLLECTION, pickId));
}

export async function getAllPicks() {
  const q = query(collection(db, PICKS_COLLECTION), orderBy('createdAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getPickById(pickId) {
  const snap = await getDocs(collection(db, PICKS_COLLECTION));
  const d = snap.docs.find(x => x.id === pickId);
  return d ? { id: d.id, ...d.data() } : null;
}

export function calcStats(picks) {
  const settled = picks.filter(p => p.status !== 'pending');
  const won = settled.filter(p => p.status === 'won').length;
  const lost = settled.filter(p => p.status === 'lost').length;
  const pushed = settled.filter(p => p.status === 'push').length;
  const winRate = settled.length > 0 ? (won / (won + lost)) * 100 : 0;

  // ROI using American odds
  let totalReturn = 0;
  settled.forEach(p => {
    if (p.status === 'won') {
      const odds = p.odds || -110;
      const profit = odds > 0 ? (odds / 100) : (100 / Math.abs(odds));
      totalReturn += profit;
    } else if (p.status === 'lost') {
      totalReturn -= 1;
    }
  });
  const roi = settled.length > 0 ? (totalReturn / settled.length) * 100 : 0;

  // Edge accuracy: did high-edge picks win more?
  const strongPicks = settled.filter(p => (p.edge || 0) >= 10);
  const strongWinRate = strongPicks.length > 0
    ? (strongPicks.filter(p => p.status === 'won').length / strongPicks.filter(p => p.status !== 'push').length) * 100
    : null;

  // Wins by edge bucket for weight tuning insight
  const byEdgeBucket = {
    strong: { total: 0, won: 0 },
    moderate: { total: 0, won: 0 },
    slim: { total: 0, won: 0 },
  };
  settled.filter(p => p.status !== 'push').forEach(p => {
    const e = p.edge || 0;
    const bucket = e >= 10 ? 'strong' : e >= 5 ? 'moderate' : 'slim';
    byEdgeBucket[bucket].total++;
    if (p.status === 'won') byEdgeBucket[bucket].won++;
  });

  return { total: picks.length, settled: settled.length, won, lost, pushed, winRate, roi, strongWinRate, byEdgeBucket };
}

export function suggestWeightAdjustments(picks, currentWeights) {
  const settled = picks.filter(p => p.status !== 'pending' && p.status !== 'push');
  if (settled.length < 10) return null;

  // Analyze which factors the winning picks had in common
  const wonPicks = settled.filter(p => p.status === 'won');
  const lostPicks = settled.filter(p => p.status === 'lost');

  const avgFactor = (arr, key) => {
    const vals = arr.map(p => p.factors?.[key]).filter(v => v != null);
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };

  const suggestions = {};
  const factorMap = {
    last5Avg: 'last5AvgSOG',
    seasonAvg: 'seasonAvgSOG',
    last10Avg: 'last10AvgSOG',
  };

  for (const [factorKey, weightKey] of Object.entries(factorMap)) {
    const winAvg = avgFactor(wonPicks, factorKey);
    const lossAvg = avgFactor(lostPicks, factorKey);
    if (winAvg != null && lossAvg != null) {
      const diff = winAvg - lossAvg;
      if (Math.abs(diff) > 0.3) {
        suggestions[weightKey] = diff > 0 ? 'increase' : 'decrease';
      }
    }
  }

  return suggestions;
}
