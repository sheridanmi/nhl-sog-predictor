import { useState, useMemo, useEffect, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart, Line, CartesianGrid, ReferenceLine, Cell } from 'recharts';
import AlertBanner from './components/AlertBanner.jsx';
import WeightTuner from './components/WeightTuner.jsx';
import ResultsTracker from './components/ResultsTracker.jsx';
import { suggestWeightAdjustments, getAllPicks } from './services/firestoreService.js';

const MONO = "'JetBrains Mono', 'Fira Code', monospace";
const DISPLAY = "'Outfit', 'DM Sans', sans-serif";

const DEFAULT_WEIGHTS = {
  seasonAvgSOG: 0.20, last5AvgSOG: 0.25, last10AvgSOG: 0.15,
  homeAwayAdj: 0.05, oppShotsAgainst: 0.10, toiTrend: 0.08,
  ppTimeFactor: 0.07, backToBack: 0.03, oppGoalieSVPct: 0.04, vegasTotal: 0.03,
};

function oddsToProb(odds) {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100);
  return 100 / (odds + 100);
}
function formatOdds(odds) { return odds == null ? '—' : odds > 0 ? `+${odds}` : `${odds}`; }

function EdgeBadge({ edge }) {
  let color, bg, label;
  if (edge >= 10) { color = "#4ade80"; bg = "rgba(74,222,128,0.12)"; label = "STRONG"; }
  else if (edge >= 5) { color = "#facc15"; bg = "rgba(250,204,21,0.10)"; label = "MODERATE"; }
  else if (edge >= 2) { color = "#94a3b8"; bg = "rgba(148,163,184,0.10)"; label = "SLIM"; }
  else { color = "#ef4444"; bg = "rgba(239,68,68,0.10)"; label = "NO EDGE"; }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 6, background: bg, color, fontSize: 11, fontWeight: 700, fontFamily: MONO, letterSpacing: 1, border: `1px solid ${color}22` }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }}/> {label} {edge > 0 ? "+" : ""}{edge.toFixed(1)}%
    </span>
  );
}

function LoadingScreen({ status }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, background: "linear-gradient(145deg, #0a0e1a 0%, #0f172a 40%, #0a0e1a 100%)" }}>
      <div style={{ fontSize: 48 }}>🏒</div>
      <h1 style={{ fontFamily: DISPLAY, fontSize: 28, fontWeight: 900, color: "#f1f5f9" }}>SOG EDGE FINDER</h1>
      <div style={{ width: 200, height: 4, background: "#1e293b", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: "60%", height: "100%", background: "#4ade80", borderRadius: 2, animation: "loading 1.5s ease-in-out infinite" }}/>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 12, color: "#64748b", textAlign: "center", maxWidth: 300 }}>{status}</div>
      <style>{`@keyframes loading { 0% { transform: translateX(-100%); } 50% { transform: translateX(100%); } 100% { transform: translateX(-100%); } }`}</style>
    </div>
  );
}

function PlayerRow({ analysis, rank, onClick }) {
  const { odds, edge, simulation } = analysis;
  const hasOdds = odds && odds.line != null;
  const edgeValue = edge?.edge || 0;
  const modelProb = hasOdds ? (simulation.probabilities[odds.line] || 0) * 100 : null;
  const impliedProb = hasOdds ? oddsToProb(odds.overOdds) * 100 : null;
  const isPositiveEdge = edgeValue > 2;
  return (
    <div onClick={onClick} style={{ display: "grid", gridTemplateColumns: "36px 2fr 70px 70px 1fr 90px 140px", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer", transition: "all 0.15s ease", background: isPositiveEdge ? "rgba(74,222,128,0.03)" : "transparent", borderLeft: isPositiveEdge ? "3px solid #4ade80" : "3px solid transparent" }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.04)"}
      onMouseLeave={e => e.currentTarget.style.background = isPositiveEdge ? "rgba(74,222,128,0.03)" : "transparent"}>
      <span style={{ color: "#475569", fontFamily: MONO, fontSize: 12, fontWeight: 700 }}>{rank}</span>
      <div>
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 14, color: "#f1f5f9", display: "flex", alignItems: "center", gap: 8 }}>
          {analysis.headshot && <img src={analysis.headshot} alt="" style={{ width: 28, height: 28, borderRadius: "50%", objectFit: "cover" }} onError={e => e.target.style.display='none'} />}
          {analysis.name}
          {analysis.isBackToBack && <span style={{ fontSize: 9, fontFamily: MONO, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '1px 5px', borderRadius: 3 }}>B2B</span>}
          {!analysis.oppGoalieConfirmed && analysis.odds && <span style={{ fontSize: 9, fontFamily: MONO, color: '#64748b' }}>⚠🥅</span>}
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 2, fontFamily: MONO }}>{analysis.team} • {analysis.position} • {analysis.homeAway === "home" ? "vs" : "@"} {analysis.opponent}</div>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 12, color: "#94a3b8", textAlign: "center" }}>{hasOdds ? `O ${odds.line}` : '—'}</div>
      <div style={{ fontFamily: MONO, fontSize: 12, color: "#94a3b8", textAlign: "center" }}>{hasOdds ? formatOdds(odds.overOdds) : '—'}</div>
      <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
        {hasOdds ? (<><div style={{ textAlign: "center" }}><div style={{ fontSize: 9, color: "#475569", fontFamily: MONO }}>MODEL</div><div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: modelProb > impliedProb ? "#4ade80" : "#ef4444" }}>{modelProb?.toFixed(1)}%</div></div>
          <div style={{ textAlign: "center" }}><div style={{ fontSize: 9, color: "#475569", fontFamily: MONO }}>BOOK</div><div style={{ fontFamily: MONO, fontSize: 13, color: "#94a3b8" }}>{impliedProb?.toFixed(1)}%</div></div></>) : <div style={{ fontFamily: MONO, fontSize: 11, color: "#475569" }}>No odds</div>}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: "#e2e8f0", textAlign: "center" }}>{simulation.projection}</div>
      {hasOdds ? <EdgeBadge edge={edgeValue} /> : <span style={{ fontFamily: MONO, fontSize: 10, color: "#475569" }}>—</span>}
    </div>
  );
}

function SimHistogram({ simulation, bookLine }) {
  const data = Object.entries(simulation.distribution).map(([sog, count]) => ({ sog: parseInt(sog), pct: +((count / simulation.iterations) * 100).toFixed(1), overLine: parseInt(sog) > bookLine })).filter(d => d.sog <= 10);
  return (
    <div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10, fontFamily: MONO }}>SIMULATION ({(simulation.iterations).toLocaleString()} RUNS)</div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} barCategoryGap="15%">
          <XAxis dataKey="sog" stroke="#475569" tick={{ fontSize: 11, fontFamily: MONO, fill: "#94a3b8" }} />
          <YAxis stroke="#475569" tick={{ fontSize: 10, fontFamily: MONO, fill: "#64748b" }} tickFormatter={v => `${v}%`} />
          <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontFamily: MONO, fontSize: 12 }} formatter={v => [`${v}%`, "Probability"]} labelFormatter={v => `${v} SOG`} />
          {bookLine && <ReferenceLine x={bookLine} stroke="#f59e0b" strokeDasharray="4 4" strokeWidth={2} />}
          <Bar dataKey="pct" radius={[4, 4, 0, 0]}>{data.map((e, i) => <Cell key={i} fill={e.overLine ? "#4ade80" : "#334155"} />)}</Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SOGTrendChart({ gameLog }) {
  const data = gameLog.slice(-20).map((g, i, arr) => ({ date: g.date?.slice(5) || `G${i+1}`, sog: g.shots, avg5: i >= 4 ? +(arr.slice(i-4, i+1).reduce((s, x) => s + x.shots, 0) / 5).toFixed(1) : null }));
  return (
    <div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10, fontFamily: MONO }}>SOG TREND</div>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={data}>
          <defs><linearGradient id="sogGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#4ade80" stopOpacity={0.3}/><stop offset="100%" stopColor="#4ade80" stopOpacity={0}/></linearGradient></defs>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
          <XAxis dataKey="date" stroke="#475569" tick={{ fontSize: 9, fontFamily: MONO, fill: "#64748b" }} />
          <YAxis stroke="#475569" tick={{ fontSize: 10, fontFamily: MONO, fill: "#64748b" }} />
          <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontFamily: MONO, fontSize: 12 }} />
          <Area type="monotone" dataKey="sog" stroke="#4ade80" fill="url(#sogGrad)" strokeWidth={2} dot={{ fill: "#4ade80", r: 3 }} name="SOG" />
          <Line type="monotone" dataKey="avg5" stroke="#f59e0b" strokeWidth={2} dot={false} name="5-Gm Avg" strokeDasharray="5 5" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function PlayerDetail({ analysis, onBack, onLogPick }) {
  const { odds, edge, simulation } = analysis;
  const hasOdds = odds && odds.line != null;
  const modelProb = hasOdds ? (simulation.probabilities[odds.line] || 0) * 100 : 0;
  const impliedProb = hasOdds ? oddsToProb(odds.overOdds) * 100 : 0;
  const edgeVal = edge?.edge || 0;
  const factors = simulation.factors || {};
  const dirColors = { positive: "#4ade80", negative: "#ef4444", neutral: "#94a3b8" };
  const dirIcons = { positive: "▲", negative: "▼", neutral: "—" };

  return (
    <div style={{ animation: "fadeIn 0.25s ease" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontFamily: MONO, fontSize: 13, padding: 0, marginBottom: 20 }}>← Back to Dashboard</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, padding: 24, background: "rgba(15,23,42,0.8)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          {analysis.headshot && <img src={analysis.headshot} alt="" style={{ width: 64, height: 64, borderRadius: "50%" }} onError={e => e.target.style.display='none'} />}
          <div>
            <div style={{ fontFamily: DISPLAY, fontSize: 26, fontWeight: 800, color: "#f1f5f9", display: 'flex', alignItems: 'center', gap: 10 }}>
              {analysis.name}
              {analysis.isBackToBack && (
                <span style={{ fontSize: 12, fontFamily: MONO, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '3px 8px', borderRadius: 5 }}>B2B ⚠</span>
              )}
            </div>
            <div style={{ fontFamily: MONO, fontSize: 12, color: "#64748b", marginTop: 4 }}>
              {analysis.team} • {analysis.position} • {analysis.homeAway === "home" ? "vs" : "@"} {analysis.opponent}
            </div>
            {!analysis.oppGoalieConfirmed && (
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#f59e0b', marginTop: 4 }}>
                ⚠ Opposing goalie not yet confirmed — projection may shift
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: MONO, fontSize: 36, fontWeight: 800, color: "#f1f5f9" }}>{simulation.projection}</div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: "#64748b" }}>PROJECTED SOG</div>
          {hasOdds && <div style={{ marginTop: 8 }}><EdgeBadge edge={edgeVal} /></div>}
          {hasOdds && (
            <button
              onClick={() => onLogPick(analysis)}
              style={{
                marginTop: 10, padding: '7px 14px', borderRadius: 7,
                background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.25)',
                color: '#4ade80', fontFamily: MONO, fontSize: 11,
                cursor: 'pointer', fontWeight: 700,
              }}
            >+ LOG PICK</button>
          )}
        </div>
      </div>

      {hasOdds && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
          {[{ label: "BOOK LINE", value: `Over ${odds.line}`, sub: odds.bookmaker },
            { label: "BOOK ODDS", value: formatOdds(odds.overOdds), sub: `Implied: ${impliedProb.toFixed(1)}%` },
            { label: "MODEL PROB", value: `${modelProb.toFixed(1)}%`, sub: `Over ${odds.line}`, hl: modelProb > impliedProb },
            { label: "EDGE", value: `${edgeVal > 0 ? "+" : ""}${edgeVal.toFixed(1)}%`, sub: edgeVal > 5 ? "✓ Play" : "Pass", hl: edgeVal > 5 },
          ].map((item, i) => (
            <div key={i} style={{ padding: 16, borderRadius: 10, background: item.hl ? "rgba(74,222,128,0.06)" : "rgba(15,23,42,0.6)", border: item.hl ? "1px solid rgba(74,222,128,0.15)" : "1px solid rgba(255,255,255,0.04)" }}>
              <div style={{ fontSize: 10, color: "#475569", fontFamily: MONO, letterSpacing: 1 }}>{item.label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, fontFamily: MONO, color: item.hl ? "#4ade80" : "#f1f5f9", marginTop: 4 }}>{item.value}</div>
              <div style={{ fontSize: 11, color: "#64748b", fontFamily: MONO, marginTop: 2 }}>{item.sub}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <div style={{ padding: 20, background: "rgba(15,23,42,0.6)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.04)" }}><SOGTrendChart gameLog={analysis.gameLog} /></div>
        <div style={{ padding: 20, background: "rgba(15,23,42,0.6)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.04)" }}><SimHistogram simulation={simulation} bookLine={odds?.line} /></div>
      </div>

      <div style={{ padding: 20, background: "rgba(15,23,42,0.6)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.04)", marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10, fontFamily: MONO }}>PROBABILITY TABLE</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
          {[0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5].map(t => {
            const prob = (simulation.probabilities[t] || 0) * 100;
            const isBook = hasOdds && t === odds.line;
            return (<div key={t} style={{ textAlign: "center", padding: "10px 6px", borderRadius: 8, background: isBook ? "rgba(245,158,11,0.12)" : "rgba(15,23,42,0.6)", border: isBook ? "1px solid rgba(245,158,11,0.3)" : "1px solid transparent" }}>
              <div style={{ fontSize: 10, color: "#64748b", fontFamily: MONO }}>O {t}</div>
              <div style={{ fontSize: 16, fontWeight: 800, fontFamily: MONO, marginTop: 4, color: prob > 60 ? "#4ade80" : prob > 45 ? "#facc15" : "#ef4444" }}>{prob.toFixed(0)}%</div>
              {isBook && <div style={{ fontSize: 9, color: "#f59e0b", fontFamily: MONO, marginTop: 2 }}>BOOK LINE</div>}
            </div>);
          })}
        </div>
      </div>

      <div style={{ padding: 20, background: "rgba(15,23,42,0.6)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.04)", marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10, fontFamily: MONO }}>FACTOR BREAKDOWN</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[{ label: "Season Avg SOG", value: factors.seasonAvg, dir: "neutral" },
            { label: "Last 5 Gm Avg", value: factors.last5Avg, dir: factors.last5Direction || "neutral" },
            { label: "Last 10 Gm Avg", value: factors.last10Avg, dir: "neutral" },
            { label: "Opp SA/Game", value: factors.oppSAPerGame, dir: factors.oppDirection || "neutral" },
            { label: "Avg TOI", value: `${factors.avgTOI} min`, dir: factors.toiDirection || "neutral" },
            { label: "PP TOI/Game", value: `${factors.avgPPTOI} min`, dir: "neutral" },
            { label: `Goalie: ${factors.oppGoalie || 'TBD'}${analysis.oppGoalieConfirmed ? ' ✅' : ' ❓'}`, value: factors.oppGoalieSV ? `${(factors.oppGoalieSV*100).toFixed(1)}%` : "—", dir: factors.goalieDirection || "neutral" },
            { label: "Back-to-Back", value: factors.isBackToBack ? "YES ⚠" : "No", dir: factors.isBackToBack ? "negative" : "neutral" },
          ].filter(f => f.value != null).map((f, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 80px 30px", alignItems: "center", padding: "7px 12px", background: "rgba(15,23,42,0.6)", borderRadius: 6 }}>
              <span style={{ fontFamily: MONO, fontSize: 11, color: "#cbd5e1" }}>{f.label}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: "#f1f5f9", textAlign: "right" }}>{f.value}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: dirColors[f.dir], textAlign: "center" }}>{dirIcons[f.dir]}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: 20, background: "rgba(15,23,42,0.6)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.04)" }}>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10, fontFamily: MONO }}>GAME LOG — LAST {Math.min(20, analysis.gameLog.length)} GAMES</div>
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "85px 50px 40px 50px 65px 55px 40px 40px", gap: 0, fontSize: 11, fontFamily: MONO }}>
            {["DATE","OPP","H/A","SOG","TOI","PP TOI","G","A"].map(h => <div key={h} style={{ padding: "6px 4px", color: "#475569", fontWeight: 700, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>{h}</div>)}
            {analysis.gameLog.slice(-20).reverse().map((g, i) => (
              [g.date?.slice(5)||"—", g.opponent, g.homeAway==="home"?"H":"A", g.shots, g.toi||`${g.toiMinutes?.toFixed(0)}`, g.ppToi||`${g.ppToiMinutes?.toFixed(1)}`, g.goals, g.assists].map((val, j) => (
                <div key={`${i}-${j}`} style={{ padding: "5px 4px", color: j===3 ? (g.shots>=4?"#4ade80":g.shots<=1?"#ef4444":"#e2e8f0") : "#94a3b8", fontWeight: j===3?700:400, borderBottom: "1px solid rgba(255,255,255,0.02)" }}>{val}</div>
              ))
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterBtn({ active, onClick, children }) {
  return <button onClick={onClick} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid", borderColor: active ? "rgba(74,222,128,0.3)" : "rgba(255,255,255,0.06)", background: active ? "rgba(74,222,128,0.08)" : "rgba(15,23,42,0.6)", color: active ? "#4ade80" : "#94a3b8", fontFamily: MONO, fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>{children}</button>;
}
function SmallBtn({ active, onClick, children }) {
  return <button onClick={onClick} style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: active ? "rgba(255,255,255,0.08)" : "transparent", color: active ? "#f1f5f9" : "#64748b", fontFamily: MONO, fontSize: 11, cursor: "pointer" }}>{children}</button>;
}
function NavTab({ active, onClick, children }) {
  return <button onClick={onClick} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: active ? "rgba(74,222,128,0.1)" : "transparent", color: active ? "#4ade80" : "#64748b", fontFamily: MONO, fontSize: 12, fontWeight: 700, cursor: "pointer", borderBottom: active ? "2px solid #4ade80" : "2px solid transparent" }}>{children}</button>;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [loadStatus, setLoadStatus] = useState("Loading analysis...");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [filterGame, setFilterGame] = useState("all");
  const [filterEdge, setFilterEdge] = useState("all");
  const [sortBy, setSortBy] = useState("edge");
  const [dataSource, setDataSource] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard'); // dashboard | tracker | weights
  const [customWeights, setCustomWeights] = useState(null);
  const [weightSuggestions, setWeightSuggestions] = useState(null);
  const [recalculating, setRecalculating] = useState(false);
  const [quickLogPlayer, setQuickLogPlayer] = useState(null);
  const [weightsUnlocked, setWeightsUnlocked] = useState(false);
  const [weightsPwInput, setWeightsPwInput] = useState('');
  const [weightsPwError, setWeightsPwError] = useState(false);
  const WEIGHTS_PASSWORD = 'sog2026';

  useEffect(() => {
    loadData();
    loadPickSuggestions();
  }, []);

  async function loadPickSuggestions() {
    try {
      const picks = await getAllPicks();
      const suggestions = suggestWeightAdjustments(picks, customWeights || DEFAULT_WEIGHTS);
      setWeightSuggestions(suggestions);
    } catch (e) {
      console.warn('Could not load pick suggestions:', e);
    }
  }

  async function loadData(weightsOverride = null) {
    setLoading(true);
    try {
      setLoadStatus("Loading pre-computed analysis...");
      const res = await fetch('/latest-analysis.json');
      if (res.ok) {
        const result = await res.json();
        if (result.analyses && result.analyses.length > 0) {
          setData(result);
          setDataSource('precomputed');
          setLoading(false);
          return;
        }
      }
    } catch (e) {
      console.log('No pre-computed data, trying live...');
    }

    try {
      setLoadStatus("Fetching live data with B2B & goalie detection...");
      const { buildTonightAnalysis } = await import('./services/dataAggregator.js');
      const ODDS_API_KEY = import.meta.env.VITE_ODDS_API_KEY || '';
      const result = await buildTonightAnalysis(ODDS_API_KEY, weightsOverride);
      setData(result);
      setDataSource('live');
      if (result.error) setError(result.error);
    } catch (err) {
      setError('No data available. Run: node scripts/daily-fetch.js');
    } finally {
      setLoading(false);
    }
  }

  async function handleApplyWeights(newWeights) {
    setCustomWeights(newWeights);
    setRecalculating(true);
    setActiveTab('dashboard');
    try {
      const { buildTonightAnalysis } = await import('./services/dataAggregator.js');
      const ODDS_API_KEY = import.meta.env.VITE_ODDS_API_KEY || '';
      const result = await buildTonightAnalysis(ODDS_API_KEY, newWeights);
      setData(result);
      setDataSource('live');
    } catch (e) {
      console.error('Recalc error:', e);
    } finally {
      setRecalculating(false);
    }
  }

  const filteredAnalyses = useMemo(() => {
    if (!data?.analyses) return [];
    let filtered = [...data.analyses];
    if (filterGame !== "all") {
      const [away, home] = filterGame.split("-");
      filtered = filtered.filter(a => a.team === away || a.team === home);
    }
    if (filterEdge === "strong") filtered = filtered.filter(a => (a.edge?.edge||0) >= 10);
    else if (filterEdge === "moderate") filtered = filtered.filter(a => (a.edge?.edge||0) >= 5);
    else if (filterEdge === "any") filtered = filtered.filter(a => (a.edge?.edge||0) >= 2);
    filtered.sort((a, b) => {
      if (sortBy === "edge") return (b.edge?.edge||-999) - (a.edge?.edge||-999);
      if (sortBy === "projection") return b.simulation.projection - a.simulation.projection;
      if (sortBy === "name") return a.name.localeCompare(b.name);
      return 0;
    });
    return filtered;
  }, [data, filterGame, filterEdge, sortBy]);

  if (loading || recalculating) return <LoadingScreen status={recalculating ? "Recalculating with new weights..." : loadStatus} />;

  if (error || !data?.analyses?.length) return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, background: "linear-gradient(145deg, #0a0e1a 0%, #0f172a 40%, #0a0e1a 100%)" }}>
      <div style={{ fontSize: 48 }}>🏒</div>
      <h1 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 800, color: "#f1f5f9" }}>No Data Available</h1>
      <p style={{ fontFamily: MONO, fontSize: 13, color: "#64748b", textAlign: "center", maxWidth: 500, lineHeight: 1.6 }}>
        {error || "Run the daily script to generate today's analysis:"}<br/><br/>
        <code style={{ background: "#1e293b", padding: "8px 14px", borderRadius: 6, display: "inline-block" }}>node scripts/daily-fetch.js</code>
      </p>
    </div>
  );

  const edgesFound = data.analyses.filter(a => a.hasEdge).length;
  const selected = selectedPlayer ? data.analyses.find(a => a.id === selectedPlayer) : null;
  const timestamp = data.timestamp ? new Date(data.timestamp) : null;
  const timeStr = timestamp ? timestamp.toLocaleString() : '';
  const b2bTeams = data.b2bTeams || [];

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(145deg, #0a0e1a 0%, #0f172a 40%, #0a0e1a 100%)", color: "#e2e8f0", fontFamily: DISPLAY }}>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes loading { 0% { transform: translateX(-100%); } 50% { transform: translateX(100%); } 100% { transform: translateX(-100%); } }
      `}</style>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 20px" }}>

        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
            <span style={{ fontSize: 28 }}>🏒</span>
            <h1 style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 900, color: "#f1f5f9", margin: 0 }}>SOG EDGE FINDER</h1>
            <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: dataSource === 'precomputed' ? "rgba(74,222,128,0.1)" : "rgba(250,204,21,0.1)", color: dataSource === 'precomputed' ? "#4ade80" : "#facc15", border: `1px solid ${dataSource === 'precomputed' ? "rgba(74,222,128,0.2)" : "rgba(250,204,21,0.2)"}`, letterSpacing: 1 }}>
              {dataSource === 'precomputed' ? 'DAILY' : 'LIVE'}
            </span>
            {customWeights && <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: "rgba(250,204,21,0.1)", color: "#facc15", border: "1px solid rgba(250,204,21,0.2)" }}>CUSTOM WEIGHTS</span>}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: "#475569", display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>{data.games.length} Games</span>
            <span>•</span>
            <span>{data.playersScanned} Players</span>
            <span>•</span>
            <span>{edgesFound} Edges</span>
            {b2bTeams.length > 0 && <><span>•</span><span style={{ color: '#f59e0b' }}>🔄 B2B: {b2bTeams.join(', ')}</span></>}
            {timeStr && <><span>•</span><span>Updated: {timeStr}</span></>}
          </div>
        </div>

        {/* Nav tabs */}
        {!selected && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 0 }}>
            <NavTab active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')}>📊 Dashboard</NavTab>
            <NavTab active={activeTab === 'tracker'} onClick={() => setActiveTab('tracker')}>📋 Results Tracker</NavTab>
            <NavTab active={activeTab === 'weights'} onClick={() => setActiveTab('weights')}>
              ⚙ Weights{weightSuggestions && Object.keys(weightSuggestions).length > 0 ? ' 💡' : ''}
            </NavTab>
          </div>
        )}

        {/* Player detail view */}
        {selected ? (
          <PlayerDetail
            analysis={selected}
            onBack={() => setSelectedPlayer(null)}
            onLogPick={(a) => { setSelectedPlayer(null); setActiveTab('tracker'); setQuickLogPlayer(a); }}
          />
        ) : (
          <>
            {/* Dashboard tab */}
            {activeTab === 'dashboard' && (
              <div style={{ animation: "fadeIn 0.25s ease" }}>
                <AlertBanner
                  analyses={data.analyses}
                  onPlayerClick={(id) => setSelectedPlayer(id)}
                />
                <div style={{ display: "flex", gap: 8, marginBottom: 20, overflowX: "auto", paddingBottom: 4 }}>
                  <FilterBtn active={filterGame==="all"} onClick={() => setFilterGame("all")}>ALL GAMES</FilterBtn>
                  {data.games.map((g, i) => { const key = `${g.awayTeam.abbrev}-${g.homeTeam.abbrev}`; return <FilterBtn key={i} active={filterGame===key} onClick={() => setFilterGame(key)}>{g.awayTeam.abbrev} @ {g.homeTeam.abbrev}</FilterBtn>; })}
                </div>
                <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: "#475569" }}>EDGE:</span>
                  {[{key:"all",label:"All"},{key:"any",label:"2%+"},{key:"moderate",label:"5%+"},{key:"strong",label:"10%+"}].map(f => <SmallBtn key={f.key} active={filterEdge===f.key} onClick={() => setFilterEdge(f.key)}>{f.label}</SmallBtn>)}
                  <div style={{ flex: 1 }} />
                  <span style={{ fontFamily: MONO, fontSize: 10, color: "#475569" }}>SORT:</span>
                  {[{key:"edge",label:"Edge"},{key:"projection",label:"Proj"},{key:"name",label:"Name"}].map(s => <SmallBtn key={s.key} active={sortBy===s.key} onClick={() => setSortBy(s.key)}>{s.label}</SmallBtn>)}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "36px 2fr 70px 70px 1fr 90px 140px", padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", fontFamily: MONO, fontSize: 10, color: "#475569", fontWeight: 700 }}>
                  <span>#</span><span>PLAYER</span><span style={{textAlign:"center"}}>LINE</span><span style={{textAlign:"center"}}>ODDS</span><span style={{textAlign:"center"}}>MODEL vs BOOK</span><span style={{textAlign:"center"}}>PROJ</span><span>EDGE</span>
                </div>
                {filteredAnalyses.map((a, i) => <PlayerRow key={a.id} analysis={a} rank={i+1} onClick={() => setSelectedPlayer(a.id)} />)}
                {filteredAnalyses.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#475569", fontFamily: MONO }}>No players match filters.</div>}
                <div style={{ marginTop: 24, padding: 14, background: "rgba(15,23,42,0.6)", borderRadius: 10, border: "1px solid rgba(255,255,255,0.04)" }}>
                  <div style={{ fontSize: 10, color: "#64748b", fontFamily: MONO, fontWeight: 700, marginBottom: 8, letterSpacing: 1 }}>⚙ MODEL WEIGHTS {customWeights ? '(CUSTOM)' : '(DEFAULT)'}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{Object.entries(data.weights||DEFAULT_WEIGHTS).map(([k,v]) => <span key={k} style={{ fontFamily: MONO, fontSize: 10, padding: "3px 8px", borderRadius: 4, background: "rgba(255,255,255,0.03)", color: "#94a3b8" }}>{k}: {(v*100).toFixed(0)}%</span>)}</div>
                </div>
              </div>
            )}

            {/* Results Tracker tab */}
            {activeTab === 'tracker' && (
              <ResultsTracker
                analyses={data.analyses}
                quickLogPlayer={quickLogPlayer}
                onQuickLogConsumed={() => setQuickLogPlayer(null)}
              />
            )}

            {/* Weights tab */}
            {activeTab === 'weights' && (
              <div style={{ animation: "fadeIn 0.25s ease" }}>
                {!weightsUnlocked ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300, gap: 16 }}>
                    <div style={{ fontSize: 36 }}>🔒</div>
                    <div style={{ fontFamily: DISPLAY, fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>Weight Tuner</div>
                    <div style={{ fontFamily: MONO, fontSize: 12, color: '#64748b' }}>Enter password to access model weights</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="password"
                        value={weightsPwInput}
                        onChange={e => { setWeightsPwInput(e.target.value); setWeightsPwError(false); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            if (weightsPwInput === WEIGHTS_PASSWORD) { setWeightsUnlocked(true); setWeightsPwInput(''); }
                            else { setWeightsPwError(true); setWeightsPwInput(''); }
                          }
                        }}
                        placeholder="Password"
                        style={{ padding: '9px 14px', borderRadius: 8, border: `1px solid ${weightsPwError ? '#ef4444' : 'rgba(255,255,255,0.1)'}`, background: 'rgba(15,23,42,0.8)', color: '#f1f5f9', fontFamily: MONO, fontSize: 13, outline: 'none', width: 200 }}
                      />
                      <button
                        onClick={() => {
                          if (weightsPwInput === WEIGHTS_PASSWORD) { setWeightsUnlocked(true); setWeightsPwInput(''); }
                          else { setWeightsPwError(true); setWeightsPwInput(''); }
                        }}
                        style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: 'rgba(74,222,128,0.15)', color: '#4ade80', fontFamily: MONO, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                      >UNLOCK</button>
                    </div>
                    {weightsPwError && <div style={{ fontFamily: MONO, fontSize: 11, color: '#ef4444' }}>Incorrect password</div>}
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                      <button onClick={() => setWeightsUnlocked(false)} style={{ background: 'none', border: 'none', color: '#475569', fontFamily: MONO, fontSize: 11, cursor: 'pointer' }}>🔒 Lock</button>
                    </div>
                    {weightSuggestions && Object.keys(weightSuggestions).length > 0 && (
                      <div style={{ padding: '12px 16px', marginBottom: 16, borderRadius: 8, background: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.15)', fontFamily: MONO, fontSize: 11, color: '#facc15' }}>
                        💡 Your results suggest some weight adjustments. See the suggestions in the tuner below.
                      </div>
                    )}
                    <WeightTuner
                      currentWeights={customWeights || DEFAULT_WEIGHTS}
                      suggestions={weightSuggestions}
                      onApply={handleApplyWeights}
                    />
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
