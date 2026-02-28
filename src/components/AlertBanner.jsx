import { useState, useEffect } from 'react';

const MONO = "'JetBrains Mono', 'Fira Code', monospace";
const DISPLAY = "'Outfit', 'DM Sans', sans-serif";

export default function AlertBanner({ analyses, onPlayerClick }) {
  const [dismissed, setDismissed] = useState(new Set());
  const [expanded, setExpanded] = useState(true);

  const strongEdges = analyses.filter(
    a => (a.edge?.edge || 0) >= 10 && !dismissed.has(a.id)
  );

  // Auto-collapse after 8 seconds
  useEffect(() => {
    if (strongEdges.length === 0) return;
    const timer = setTimeout(() => setExpanded(false), 8000);
    return () => clearTimeout(timer);
  }, [strongEdges.length]);

  if (strongEdges.length === 0) return null;

  return (
    <div style={{
      marginBottom: 20,
      borderRadius: 12,
      border: '1px solid rgba(74,222,128,0.3)',
      background: 'rgba(74,222,128,0.06)',
      overflow: 'hidden',
      animation: 'fadeIn 0.4s ease',
    }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', cursor: 'pointer',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8,
            borderRadius: '50%', background: '#4ade80',
            boxShadow: '0 0 8px #4ade80',
            animation: 'pulse 1.5s ease-in-out infinite',
          }} />
          <span style={{
            fontFamily: MONO, fontSize: 11, fontWeight: 700,
            color: '#4ade80', letterSpacing: 1,
          }}>
            🔥 {strongEdges.length} STRONG EDGE{strongEdges.length > 1 ? 'S' : ''} DETECTED
          </span>
        </div>
        <span style={{ fontFamily: MONO, fontSize: 11, color: '#4ade80' }}>
          {expanded ? '▲ collapse' : '▼ expand'}
        </span>
      </div>

      {/* Alerts */}
      {expanded && (
        <div style={{ borderTop: '1px solid rgba(74,222,128,0.15)', padding: '8px 0' }}>
          {strongEdges.map(a => (
            <div
              key={a.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 16px',
                borderBottom: '1px solid rgba(255,255,255,0.03)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {a.headshot && (
                  <img src={a.headshot} alt="" style={{ width: 32, height: 32, borderRadius: '50%' }}
                    onError={e => e.target.style.display = 'none'} />
                )}
                <div>
                  <div style={{ fontFamily: DISPLAY, fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
                    {a.name}
                    {a.isBackToBack && (
                      <span style={{
                        marginLeft: 8, fontSize: 10, fontFamily: MONO,
                        color: '#f59e0b', background: 'rgba(245,158,11,0.1)',
                        padding: '2px 6px', borderRadius: 4,
                      }}>B2B ⚠</span>
                    )}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    {a.team} • O{a.odds?.line} {a.odds?.overOdds > 0 ? '+' : ''}{a.odds?.overOdds}
                    {!a.oppGoalieConfirmed && (
                      <span style={{ color: '#f59e0b', marginLeft: 6 }}>⚠ Goalie TBD</span>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: MONO, fontSize: 16, fontWeight: 800, color: '#4ade80' }}>
                    +{a.edge?.edge?.toFixed(1)}%
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: '#475569' }}>EDGE</div>
                </div>
                <button
                  onClick={() => onPlayerClick(a.id)}
                  style={{
                    padding: '6px 12px', borderRadius: 6,
                    background: 'rgba(74,222,128,0.12)',
                    border: '1px solid rgba(74,222,128,0.25)',
                    color: '#4ade80', fontFamily: MONO, fontSize: 11,
                    cursor: 'pointer', fontWeight: 700,
                  }}
                >VIEW →</button>
                <button
                  onClick={() => setDismissed(d => new Set([...d, a.id]))}
                  style={{
                    padding: '6px 8px', borderRadius: 6,
                    background: 'transparent', border: '1px solid rgba(255,255,255,0.06)',
                    color: '#475569', fontFamily: MONO, fontSize: 11, cursor: 'pointer',
                  }}
                >✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
