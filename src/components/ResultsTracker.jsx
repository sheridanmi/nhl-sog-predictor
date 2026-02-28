import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line, CartesianGrid } from 'recharts';
import { getAllPicks, savePick, updatePickResult, deletePick, calcStats } from '../services/firestoreService.js';

const MONO = "'JetBrains Mono', 'Fira Code', monospace";
const DISPLAY = "'Outfit', 'DM Sans', sans-serif";

function formatOdds(odds) { return odds == null ? '—' : odds > 0 ? `+${odds}` : `${odds}`; }

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      padding: '16px 20px', borderRadius: 10,
      background: 'rgba(15,23,42,0.7)',
      border: `1px solid ${color ? `${color}22` : 'rgba(255,255,255,0.04)'}`,
    }}>
      <div style={{ fontFamily: MONO, fontSize: 10, color: '#475569', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 800, color: color || '#f1f5f9', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontFamily: MONO, fontSize: 10, color: '#64748b', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    pending: { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', label: 'PENDING' },
    won: { color: '#4ade80', bg: 'rgba(74,222,128,0.1)', label: 'WON ✓' },
    lost: { color: '#ef4444', bg: 'rgba(239,68,68,0.1)', label: 'LOST ✗' },
    push: { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', label: 'PUSH' },
  };
  const s = map[status] || map.pending;
  return (
    <span style={{
      padding: '3px 8px', borderRadius: 5,
      background: s.bg, color: s.color,
      fontFamily: MONO, fontSize: 10, fontWeight: 700,
    }}>{s.label}</span>
  );
}

export default function ResultsTracker({ analyses }) {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('picks'); // picks | log | stats
  const [settling, setSettling] = useState(null); // pickId being settled
  const [actualSOG, setActualSOG] = useState('');
  const [addingPick, setAddingPick] = useState(null); // analysis object
  const [betSide, setBetSide] = useState('over');
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => {
    loadPicks();
  }, []);

  async function loadPicks() {
    setLoading(true);
    try {
      const data = await getAllPicks();
      setPicks(data);
    } catch (e) {
      console.error('Error loading picks:', e);
    } finally {
      setLoading(false);
    }
  }

  async function handleSavePick(analysis) {
    if (!analysis.odds) return;
    const pick = {
      playerId: analysis.id,
      playerName: analysis.name,
      team: analysis.team,
      opponent: analysis.opponent,
      homeAway: analysis.homeAway,
      line: analysis.odds.line,
      odds: betSide === 'over' ? analysis.odds.overOdds : analysis.odds.underOdds,
      betSide,
      bookmaker: analysis.odds.bookmaker,
      projection: analysis.simulation.projection,
      edge: analysis.edge?.edge || 0,
      modelProb: analysis.edge?.modelProb || 0,
      impliedProb: analysis.edge?.impliedProb || 0,
      factors: analysis.simulation.factors,
      isBackToBack: analysis.isBackToBack || false,
      oppGoalieConfirmed: analysis.oppGoalieConfirmed || false,
      gameDate: new Date().toISOString().split('T')[0],
    };
    await savePick(pick);
    setAddingPick(null);
    setSaveMsg(`✓ Pick saved: ${analysis.name} ${betSide === 'over' ? 'O' : 'U'}${analysis.odds.line}`);
    setTimeout(() => setSaveMsg(''), 3000);
    await loadPicks();
  }

  async function handleSettle(pickId) {
    const sog = parseInt(actualSOG);
    if (isNaN(sog) || sog < 0) return;
    await updatePickResult(pickId, sog);
    setSettling(null);
    setActualSOG('');
    await loadPicks();
  }

  async function handleDelete(pickId) {
    if (!confirm('Delete this pick?')) return;
    await deletePick(pickId);
    await loadPicks();
  }

  const stats = calcStats(picks);

  // Win rate over time chart data
  const winRateHistory = (() => {
    const settled = picks.filter(p => p.status !== 'pending').reverse();
    let wins = 0, total = 0;
    return settled.map((p, i) => {
      total++;
      if (p.status === 'won') wins++;
      return { game: i + 1, winRate: Math.round((wins / total) * 100), date: p.gameDate };
    });
  })();

  // Edge bucket accuracy chart
  const bucketData = [
    { name: '2-5% (Slim)', ...stats.byEdgeBucket.slim },
    { name: '5-10% (Mod)', ...stats.byEdgeBucket.moderate },
    { name: '10%+ (Strong)', ...stats.byEdgeBucket.strong },
  ].map(d => ({ ...d, winRate: d.total > 0 ? Math.round((d.won / d.total) * 100) : 0 }));

  const TabBtn = ({ id, label }) => (
    <button onClick={() => setTab(id)} style={{
      padding: '7px 16px', borderRadius: 8,
      background: tab === id ? 'rgba(74,222,128,0.1)' : 'transparent',
      border: tab === id ? '1px solid rgba(74,222,128,0.25)' : '1px solid transparent',
      color: tab === id ? '#4ade80' : '#64748b',
      fontFamily: MONO, fontSize: 11, cursor: 'pointer', fontWeight: 600,
    }}>{label}</button>
  );

  return (
    <div style={{ animation: 'fadeIn 0.25s ease' }}>
      {/* Header + tabs */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontFamily: DISPLAY, fontSize: 20, fontWeight: 800, color: '#f1f5f9', margin: 0 }}>
            📋 Results Tracker
          </h2>
          <div style={{ fontFamily: MONO, fontSize: 11, color: '#475569', marginTop: 2 }}>
            {stats.settled} settled • {picks.filter(p => p.status === 'pending').length} pending
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <TabBtn id="picks" label="Log Pick" />
          <TabBtn id="log" label="My Picks" />
          <TabBtn id="stats" label="Analytics" />
        </div>
      </div>

      {/* Save confirmation */}
      {saveMsg && (
        <div style={{
          padding: '10px 14px', marginBottom: 14, borderRadius: 8,
          background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)',
          fontFamily: MONO, fontSize: 12, color: '#4ade80',
        }}>{saveMsg}</div>
      )}

      {/* === TAB: LOG PICK === */}
      {tab === 'picks' && (
        <div>
          {analyses.filter(a => a.odds && a.hasEdge).length === 0 && (
            <div style={{
              padding: 30, textAlign: 'center',
              fontFamily: MONO, fontSize: 12, color: '#475569',
              background: 'rgba(15,23,42,0.5)', borderRadius: 10,
            }}>
              No playable edges found today. Check All Players tab to log any pick.
            </div>
          )}

          {/* Quick-log from today's edges */}
          <div style={{ fontFamily: MONO, fontSize: 10, color: '#475569', marginBottom: 10, letterSpacing: 1 }}>
            TODAY'S PLAYABLE EDGES — CLICK TO LOG
          </div>
          {analyses.filter(a => a.odds).sort((a,b) => (b.edge?.edge||0) - (a.edge?.edge||0)).slice(0, 20).map(a => {
            const isAdding = addingPick?.id === a.id;
            const edgeVal = a.edge?.edge || 0;
            return (
              <div key={a.id} style={{
                marginBottom: 8, borderRadius: 10, overflow: 'hidden',
                border: `1px solid ${isAdding ? 'rgba(74,222,128,0.25)' : 'rgba(255,255,255,0.05)'}`,
                background: isAdding ? 'rgba(74,222,128,0.04)' : 'rgba(15,23,42,0.5)',
              }}>
                <div
                  onClick={() => setAddingPick(isAdding ? null : a)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px', cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {a.headshot && <img src={a.headshot} alt="" style={{ width: 32, height: 32, borderRadius: '50%' }} onError={e => e.target.style.display='none'} />}
                    <div>
                      <div style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>
                        {a.name}
                        {a.isBackToBack && <span style={{ marginLeft: 6, fontSize: 9, fontFamily: MONO, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '1px 5px', borderRadius: 3 }}>B2B</span>}
                        {!a.oppGoalieConfirmed && <span style={{ marginLeft: 6, fontSize: 9, fontFamily: MONO, color: '#f59e0b' }}>⚠ Goalie TBD</span>}
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 10, color: '#64748b', marginTop: 1 }}>
                        {a.team} • O{a.odds.line} {formatOdds(a.odds.overOdds)} • Proj: {a.simulation.projection}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                      fontFamily: MONO, fontSize: 14, fontWeight: 800,
                      color: edgeVal >= 10 ? '#4ade80' : edgeVal >= 5 ? '#facc15' : '#94a3b8',
                    }}>
                      {edgeVal > 0 ? '+' : ''}{edgeVal.toFixed(1)}%
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: isAdding ? '#4ade80' : '#475569' }}>
                      {isAdding ? '▲' : '▼'}
                    </span>
                  </div>
                </div>

                {isAdding && (
                  <div style={{
                    padding: '12px 16px',
                    borderTop: '1px solid rgba(74,222,128,0.1)',
                    background: 'rgba(74,222,128,0.02)',
                    display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                  }}>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: '#64748b' }}>BET SIDE:</span>
                    {['over', 'under'].map(side => (
                      <button key={side} onClick={() => setBetSide(side)} style={{
                        padding: '5px 12px', borderRadius: 6,
                        background: betSide === side ? 'rgba(74,222,128,0.12)' : 'transparent',
                        border: `1px solid ${betSide === side ? 'rgba(74,222,128,0.3)' : 'rgba(255,255,255,0.06)'}`,
                        color: betSide === side ? '#4ade80' : '#64748b',
                        fontFamily: MONO, fontSize: 11, cursor: 'pointer', fontWeight: 700,
                      }}>
                        {side.toUpperCase()} {side === 'over' ? a.odds.overOdds : a.odds.underOdds ? formatOdds(a.odds.underOdds) : ''}
                      </button>
                    ))}
                    <button
                      onClick={() => handleSavePick(a)}
                      style={{
                        padding: '6px 16px', borderRadius: 6, marginLeft: 'auto',
                        background: 'rgba(74,222,128,0.15)', border: '1px solid rgba(74,222,128,0.3)',
                        color: '#4ade80', fontFamily: MONO, fontSize: 11,
                        cursor: 'pointer', fontWeight: 700,
                      }}
                    >SAVE PICK +</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* === TAB: MY PICKS LOG === */}
      {tab === 'log' && (
        <div>
          {loading && <div style={{ padding: 30, textAlign: 'center', fontFamily: MONO, fontSize: 12, color: '#475569' }}>Loading picks...</div>}
          {!loading && picks.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', fontFamily: MONO, fontSize: 12, color: '#475569' }}>
              No picks logged yet. Go to "Log Pick" tab to add your first bet.
            </div>
          )}
          {picks.map(pick => (
            <div key={pick.id} style={{
              marginBottom: 8, borderRadius: 10, overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.05)',
              background: 'rgba(15,23,42,0.5)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px',
              }}>
                <div>
                  <div style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 700, color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {pick.playerName}
                    <StatusBadge status={pick.status} />
                    {pick.isBackToBack && <span style={{ fontSize: 9, fontFamily: MONO, color: '#f59e0b' }}>B2B</span>}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: '#64748b', marginTop: 3 }}>
                    {pick.gameDate} • {pick.betSide?.toUpperCase()} {pick.line} {formatOdds(pick.odds)} • Edge: {pick.edge > 0 ? '+' : ''}{pick.edge?.toFixed(1)}%
                    {pick.actualSOG != null && ` • Actual: ${pick.actualSOG} SOG`}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {pick.status === 'pending' && (
                    settling === pick.id ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="number" min={0} max={15} placeholder="SOG"
                          value={actualSOG}
                          onChange={e => setActualSOG(e.target.value)}
                          style={{
                            width: 56, padding: '5px 8px', borderRadius: 6,
                            background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)',
                            color: '#f1f5f9', fontFamily: MONO, fontSize: 12,
                          }}
                        />
                        <ActionBtn color="#4ade80" onClick={() => handleSettle(pick.id)}>✓</ActionBtn>
                        <ActionBtn onClick={() => { setSettling(null); setActualSOG(''); }}>✕</ActionBtn>
                      </div>
                    ) : (
                      <ActionBtn color="#facc15" onClick={() => setSettling(pick.id)}>Settle</ActionBtn>
                    )
                  )}
                  <ActionBtn color="#ef4444" onClick={() => handleDelete(pick.id)}>✕</ActionBtn>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* === TAB: ANALYTICS === */}
      {tab === 'stats' && (
        <div>
          {stats.settled < 5 && (
            <div style={{
              padding: '12px 16px', marginBottom: 16, borderRadius: 8,
              background: 'rgba(250,204,21,0.06)', border: '1px solid rgba(250,204,21,0.15)',
              fontFamily: MONO, fontSize: 11, color: '#facc15',
            }}>
              ⚠ Settle at least 5 picks to see meaningful analytics. You have {stats.settled} settled.
            </div>
          )}

          {/* Stat cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            <StatCard label="WIN RATE" value={`${stats.winRate.toFixed(1)}%`} sub={`${stats.won}W – ${stats.lost}L`} color={stats.winRate >= 55 ? '#4ade80' : stats.winRate >= 50 ? '#facc15' : '#ef4444'} />
            <StatCard label="ROI" value={`${stats.roi > 0 ? '+' : ''}${stats.roi.toFixed(1)}%`} sub="per unit wagered" color={stats.roi > 0 ? '#4ade80' : '#ef4444'} />
            <StatCard label="STRONG EDGE W%" value={stats.strongWinRate != null ? `${stats.strongWinRate.toFixed(1)}%` : '—'} sub="10%+ edge picks" color="#4ade80" />
            <StatCard label="PICKS LOGGED" value={stats.total} sub={`${stats.settled} settled • ${stats.pushed} push`} />
          </div>

          {/* Win rate over time */}
          {winRateHistory.length >= 3 && (
            <div style={{ padding: 20, background: 'rgba(15,23,42,0.6)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.04)', marginBottom: 16 }}>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>WIN RATE OVER TIME</div>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={winRateHistory}>
                  <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                  <XAxis dataKey="game" stroke="#475569" tick={{ fontSize: 9, fontFamily: MONO, fill: '#64748b' }} label={{ value: 'Pick #', position: 'insideBottom', fill: '#475569', fontSize: 9 }} />
                  <YAxis stroke="#475569" tick={{ fontSize: 9, fontFamily: MONO, fill: '#64748b' }} domain={[0, 100]} tickFormatter={v => `${v}%`} />
                  <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', fontFamily: MONO, fontSize: 11 }} formatter={v => [`${v}%`, 'Win Rate']} />
                  <Line type="monotone" dataKey="winRate" stroke="#4ade80" strokeWidth={2} dot={{ fill: '#4ade80', r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Edge bucket accuracy */}
          <div style={{ padding: 20, background: 'rgba(15,23,42,0.6)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.04)', marginBottom: 16 }}>
            <div style={{ fontFamily: MONO, fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>
              WIN RATE BY EDGE BUCKET
              <span style={{ color: '#475569', marginLeft: 8 }}>— Does your model's edge rating predict outcomes?</span>
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={bucketData} barCategoryGap="30%">
                <XAxis dataKey="name" stroke="#475569" tick={{ fontSize: 10, fontFamily: MONO, fill: '#94a3b8' }} />
                <YAxis stroke="#475569" tick={{ fontSize: 9, fontFamily: MONO, fill: '#64748b' }} domain={[0, 100]} tickFormatter={v => `${v}%`} />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', fontFamily: MONO, fontSize: 11 }} formatter={(v, n, p) => [`${v}% (${p.payload.won}/${p.payload.total})`, 'Win Rate']} />
                <Bar dataKey="winRate" radius={[6, 6, 0, 0]}>
                  {bucketData.map((d, i) => <Cell key={i} fill={d.winRate >= 55 ? '#4ade80' : d.winRate >= 48 ? '#facc15' : '#ef4444'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div style={{ fontFamily: MONO, fontSize: 10, color: '#475569', marginTop: 8 }}>
              Breakeven at -110 odds ≈ 52.4% win rate
            </div>
          </div>

          {/* Tip for weight tuner */}
          {stats.settled >= 10 && (
            <div style={{
              padding: '12px 16px', borderRadius: 8,
              background: 'rgba(74,222,128,0.05)', border: '1px solid rgba(74,222,128,0.12)',
              fontFamily: MONO, fontSize: 11, color: '#64748b',
            }}>
              💡 You have enough data for weight tuning. Head to the <strong style={{ color: '#4ade80' }}>⚙ Weights</strong> tab to see AI-suggested adjustments based on your results.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ children, onClick, color }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 10px', borderRadius: 6,
      background: color ? `${color}15` : 'rgba(255,255,255,0.04)',
      border: `1px solid ${color ? `${color}30` : 'rgba(255,255,255,0.06)'}`,
      color: color || '#64748b', fontFamily: MONO, fontSize: 11,
      cursor: 'pointer', fontWeight: 600,
    }}>{children}</button>
  );
}
