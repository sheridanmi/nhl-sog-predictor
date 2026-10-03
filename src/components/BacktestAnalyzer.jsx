import { useState, useEffect } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Cell,
} from 'recharts';
import {
  getSettledSnapshots, getSnapshotSummaries, getStrongEdgeSnapshots,
  calcOverallStats, calcEdgeBucketStats, calcCalibrationCurve, calcSplitStats, calcCLVStats,
} from '../services/backtestService.js';

const MONO = "'JetBrains Mono', 'Fira Code', monospace";
const DISPLAY = "'Outfit', 'DM Sans', sans-serif";

function Card({ label, value, sub, color }) {
  return (
    <div style={{ padding: 16, borderRadius: 10, background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ fontSize: 10, color: '#475569', fontFamily: MONO, letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: MONO, color: color || '#f1f5f9', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b', fontFamily: MONO, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div style={{ padding: 20, background: 'rgba(15,23,42,0.6)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.04)', marginBottom: 20 }}>
      <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 4, fontFamily: MONO, fontWeight: 700 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11, color: '#475569', marginBottom: 14, fontFamily: MONO, lineHeight: 1.5 }}>{subtitle}</div>}
      {children}
    </div>
  );
}

function SplitList({ items }) {
  if (!items.length) return <div style={{ fontFamily: MONO, fontSize: 11, color: '#475569' }}>No data yet</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map(item => (
        <div key={item.key} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 50px', alignItems: 'center', padding: '8px 10px', background: 'rgba(15,23,42,0.8)', borderRadius: 6 }}>
          <span style={{ fontFamily: MONO, fontSize: 12, color: '#cbd5e1' }}>{item.label}</span>
          <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, textAlign: 'right', color: item.winRate >= 55 ? '#4ade80' : item.winRate >= 50 ? '#facc15' : '#ef4444' }}>{item.winRate}%</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: '#475569', textAlign: 'right' }}>n={item.total}</span>
        </div>
      ))}
    </div>
  );
}

function ResultPill({ result }) {
  const styles = {
    won: { bg: 'rgba(74,222,128,0.12)', border: 'rgba(74,222,128,0.25)', color: '#4ade80', text: 'WON' },
    lost: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.25)', color: '#ef4444', text: 'LOST' },
    push: { bg: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.25)', color: '#94a3b8', text: 'PUSH' },
    pending: { bg: 'rgba(250,204,21,0.1)', border: 'rgba(250,204,21,0.2)', color: '#facc15', text: 'PENDING' },
  };
  const s = styles[result] || styles.pending;
  return (
    <span style={{ padding: '3px 9px', borderRadius: 6, background: s.bg, border: `1px solid ${s.border}`, color: s.color, fontFamily: MONO, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {s.text}
    </span>
  );
}

function StrongEdgeLog({ snapshots, minEdge }) {
  const MAX_ROWS = 150;
  const shown = snapshots.slice(0, MAX_ROWS);
  const record = snapshots.reduce((acc, s) => {
    if (s.overResult === 'won') acc.won++;
    else if (s.overResult === 'lost') acc.lost++;
    else if (s.overResult === 'push') acc.push++;
    else acc.pending++;
    return acc;
  }, { won: 0, lost: 0, push: 0, pending: 0 });

  return (
    <Section
      title={`🔥 STRONG EDGE PICK LOG (${minEdge}%+)`}
      subtitle={`Every pick the model has flagged at ${minEdge}% edge or higher, win or lose — not just the ones you bet on. Record: ${record.won}-${record.lost}${record.push ? `-${record.push}` : ''}${record.pending ? `, ${record.pending} pending` : ''}.`}
    >
      {snapshots.length === 0 ? (
        <div style={{ fontFamily: MONO, fontSize: 12, color: '#475569', padding: '20px 0', textAlign: 'center' }}>
          No picks at {minEdge}%+ edge yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                {['DATE', 'PLAYER', 'TEAM', 'LINE', 'ODDS', 'EDGE', 'ACTUAL', 'RESULT'].map(h => (
                  <th key={h} style={{ textAlign: h === 'PLAYER' ? 'left' : 'right', padding: '8px 10px', color: '#475569', fontWeight: 700, fontSize: 10, letterSpacing: 0.5 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '8px 10px', color: '#64748b', whiteSpace: 'nowrap' }}>{s.gameDate}</td>
                  <td style={{ padding: '8px 10px', color: '#f1f5f9', fontWeight: 600, textAlign: 'left' }}>{s.playerName}</td>
                  <td style={{ padding: '8px 10px', color: '#94a3b8', textAlign: 'right' }}>{s.team}{s.homeAway === 'home' ? '' : ` @ ${s.opponent || ''}`}</td>
                  <td style={{ padding: '8px 10px', color: '#cbd5e1', textAlign: 'right' }}>O {s.line}</td>
                  <td style={{ padding: '8px 10px', color: '#cbd5e1', textAlign: 'right' }}>{s.overOdds > 0 ? `+${s.overOdds}` : s.overOdds}</td>
                  <td style={{ padding: '8px 10px', color: '#4ade80', fontWeight: 700, textAlign: 'right' }}>+{s.edge}%</td>
                  <td style={{ padding: '8px 10px', color: '#cbd5e1', textAlign: 'right' }}>{s.actualSOG != null ? s.actualSOG : '—'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}><ResultPill result={s.overResult || 'pending'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {snapshots.length > MAX_ROWS && (
            <div style={{ fontFamily: MONO, fontSize: 10, color: '#475569', textAlign: 'center', padding: '10px 0 0' }}>
              Showing {MAX_ROWS} most recent of {snapshots.length} total.
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

export default function BacktestAnalyzer() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [strongEdges, setStrongEdges] = useState([]);
  const STRONG_EDGE_MIN = 10;

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [snaps, sums, strong] = await Promise.all([
        getSettledSnapshots(5000), getSnapshotSummaries(), getStrongEdgeSnapshots(STRONG_EDGE_MIN, 5000),
      ]);
      setSnapshots(snaps);
      setSummaries(sums);
      setStrongEdges(strong);
    } catch (e) {
      console.error('Backtest load error:', e);
      setError('Failed to load backtest data from Firestore. Check console for details.');
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return <div style={{ padding: 60, textAlign: 'center', color: '#64748b', fontFamily: MONO, fontSize: 13 }}>Loading backtest data from Firestore...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{ fontFamily: MONO, fontSize: 13, color: '#ef4444', marginBottom: 12 }}>{error}</div>
        <button onClick={load} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(74,222,128,0.25)', background: 'rgba(74,222,128,0.1)', color: '#4ade80', fontFamily: MONO, fontSize: 12, cursor: 'pointer' }}>Retry</button>
      </div>
    );
  }

  const overall = calcOverallStats(snapshots);

  // The strong-edge log is useful from the very first pick — gating it behind
  // the same 20-decided threshold as the statistical charts below would hide
  // exactly the thing someone wants to see earliest in a new season.
  if (overall.decided < 20) {
    return (
      <div style={{ animation: 'fadeIn 0.25s ease' }}>
        <StrongEdgeLog snapshots={strongEdges} minEdge={STRONG_EDGE_MIN} />
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📸</div>
          <div style={{ fontFamily: DISPLAY, fontSize: 16, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>Not enough settled data yet for the stats below</div>
          <div style={{ fontFamily: MONO, fontSize: 12, color: '#64748b', maxWidth: 440, margin: '0 auto', lineHeight: 1.6 }}>
            Found {overall.decided} settled snapshot{overall.decided === 1 ? '' : 's'} out of {overall.totalSnapshots} total in Firestore.
            Calibration and edge-bucket charts need at least 20 decided picks (won or lost) to mean anything. Snapshots
            settle automatically every night at 1 AM ET after games finish — check back once the season's been running a bit.
          </div>
        </div>
      </div>
    );
  }

  const edgeBuckets = calcEdgeBucketStats(snapshots).filter(b => b.total > 0);
  const calibration = calcCalibrationCurve(snapshots, 10);
  const byPosition = calcSplitStats(snapshots, s => s.position || 'Unknown');
  const byHomeAway = calcSplitStats(snapshots, s => (s.homeAway === 'home' ? 'Home' : s.homeAway === 'away' ? 'Away' : null));
  const byB2B = calcSplitStats(snapshots, s => (s.isBackToBack ? 'B2B' : 'Normal Rest'));
  const clvStats = calcCLVStats(snapshots);

  return (
    <div style={{ animation: 'fadeIn 0.25s ease' }}>
      {/* Overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 20 }}>
        <Card label="SETTLED PICKS" value={overall.decided} sub={`${overall.totalSnapshots} total snapshots`} />
        <Card label="WIN RATE" value={`${overall.winRate}%`} color={overall.winRate >= 55 ? '#4ade80' : overall.winRate >= 50 ? '#facc15' : '#ef4444'} />
        <Card label="ROI / UNIT" value={`${overall.roi > 0 ? '+' : ''}${overall.roi}%`} color={overall.roi > 0 ? '#4ade80' : '#ef4444'} sub="flat -110 stake basis" />
        <Card
          label="AVG CLV"
          value={clvStats.avgCLV != null ? `${clvStats.avgCLV > 0 ? '+' : ''}${clvStats.avgCLV}pts` : '—'}
          color={clvStats.avgCLV > 0 ? '#4ade80' : clvStats.avgCLV < 0 ? '#ef4444' : undefined}
          sub={clvStats.count > 0 ? `${clvStats.positiveRate}% beat closing (n=${clvStats.count})` : 'no closing lines captured yet'}
        />
        <Card label="NIGHTS OF DATA" value={summaries.length} sub={summaries[0]?.gameDate ? `since ${summaries[0].gameDate}` : ''} />
      </div>

      <StrongEdgeLog snapshots={strongEdges} minEdge={STRONG_EDGE_MIN} />

      {/* Calibration curve */}
      <Section
        title="CALIBRATION CURVE"
        subtitle="If the model is well-calibrated, the green line should sit on the dashed diagonal. Points below the line mean the model is overconfident at that probability range — dangerous for betting even if edge % looks big."
      >
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={calibration} margin={{ top: 5, right: 20, left: 0, bottom: 20 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
            <XAxis
              dataKey="predicted" type="number" domain={[0, 100]}
              stroke="#475569" tick={{ fontSize: 10, fontFamily: MONO, fill: '#94a3b8' }}
              tickFormatter={v => `${v}%`}
              label={{ value: 'Model Predicted Probability', position: 'insideBottom', offset: -10, fill: '#475569', fontSize: 10 }}
            />
            <YAxis
              stroke="#475569" tick={{ fontSize: 10, fontFamily: MONO, fill: '#94a3b8' }}
              domain={[0, 100]} tickFormatter={v => `${v}%`}
            />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontFamily: MONO, fontSize: 11 }}
              formatter={(v, n, p) => [`${v}% actual (n=${p.payload.total})`, p.payload.bucket]}
            />
            <Line data={[{ predicted: 0, actual: 0 }, { predicted: 100, actual: 100 }]} type="linear" dataKey="actual" stroke="#475569" strokeDasharray="4 4" dot={false} isAnimationActive={false} legendType="none" />
            <Line data={calibration} type="monotone" dataKey="actual" stroke="#4ade80" strokeWidth={2} dot={{ fill: '#4ade80', r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </Section>

      {/* Edge bucket */}
      <Section
        title="WIN RATE BY EDGE BUCKET"
        subtitle="Does a bigger stated edge actually win more often? If the bars don't climb left-to-right, the edge calculation isn't tracking real predictive power."
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={edgeBuckets} barCategoryGap="25%">
            <XAxis dataKey="label" stroke="#475569" tick={{ fontSize: 11, fontFamily: MONO, fill: '#94a3b8' }} />
            <YAxis stroke="#475569" tick={{ fontSize: 10, fontFamily: MONO, fill: '#64748b' }} domain={[0, 100]} tickFormatter={v => `${v}%`} />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontFamily: MONO, fontSize: 11 }}
              formatter={(v, n, p) => [`${v}% (${p.payload.won}/${p.payload.total})`, 'Win Rate']}
            />
            <ReferenceLine y={50} stroke="#475569" strokeDasharray="4 4" />
            <Bar dataKey="winRate" radius={[6, 6, 0, 0]}>
              {edgeBuckets.map((b, i) => <Cell key={i} fill={b.winRate >= 55 ? '#4ade80' : b.winRate >= 50 ? '#facc15' : '#ef4444'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Section>

      {/* Splits */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <Section title="BY POSITION"><SplitList items={byPosition} /></Section>
        <Section title="HOME / AWAY"><SplitList items={byHomeAway} /></Section>
        <Section title="BACK-TO-BACK"><SplitList items={byB2B} /></Section>
      </div>
    </div>
  );
}
