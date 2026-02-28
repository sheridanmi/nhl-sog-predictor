import { useState } from 'react';

const MONO = "'JetBrains Mono', 'Fira Code', monospace";
const DISPLAY = "'Outfit', 'DM Sans', sans-serif";

const DEFAULT_WEIGHTS = {
  seasonAvgSOG: 0.20, last5AvgSOG: 0.25, last10AvgSOG: 0.15,
  homeAwayAdj: 0.05, oppShotsAgainst: 0.10, toiTrend: 0.08,
  ppTimeFactor: 0.07, backToBack: 0.03, oppGoalieSVPct: 0.04, vegasTotal: 0.03,
};

const FACTOR_LABELS = {
  seasonAvgSOG: 'Season Avg SOG',
  last5AvgSOG: 'Last 5 Games',
  last10AvgSOG: 'Last 10 Games',
  homeAwayAdj: 'Home/Away Split',
  oppShotsAgainst: 'Opp Defense',
  toiTrend: 'TOI Trend',
  ppTimeFactor: 'PP Time',
  backToBack: 'B2B Penalty',
  oppGoalieSVPct: 'Goalie SV%',
  vegasTotal: 'Vegas Total',
};

const FACTOR_TIPS = {
  seasonAvgSOG: 'Full-season baseline shooting rate',
  last5AvgSOG: 'Recent form — hot/cold streaks',
  last10AvgSOG: 'Medium-term trend',
  homeAwayAdj: 'Home vs away shooting differential',
  oppShotsAgainst: 'How many shots opponent allows',
  toiTrend: 'Ice time trending up or down',
  ppTimeFactor: 'Power play deployment boost',
  backToBack: 'Fatigue penalty for back-to-back',
  oppGoalieSVPct: 'Opposing goalie quality',
  vegasTotal: 'Game pace proxy via O/U',
};

export default function WeightTuner({ onApply, suggestions, currentWeights }) {
  const [weights, setWeights] = useState(currentWeights || DEFAULT_WEIGHTS);
  const [showTips, setShowTips] = useState(false);

  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  const isValid = Math.abs(total - 1.0) < 0.001;

  function handleChange(key, rawVal) {
    const val = Math.round(rawVal * 100) / 100;
    setWeights(w => ({ ...w, [key]: val }));
  }

  function normalize() {
    const sum = Object.values(weights).reduce((s, v) => s + v, 0);
    const normalized = {};
    for (const k in weights) normalized[k] = Math.round((weights[k] / sum) * 1000) / 1000;
    setWeights(normalized);
  }

  function reset() { setWeights(DEFAULT_WEIGHTS); }

  function applySuggestion(key, direction) {
    const delta = 0.02;
    setWeights(w => ({
      ...w,
      [key]: Math.max(0.01, Math.min(0.5, w[key] + (direction === 'increase' ? delta : -delta))),
    }));
  }

  return (
    <div style={{
      padding: 20, background: 'rgba(15,23,42,0.8)',
      borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: DISPLAY, fontSize: 15, fontWeight: 700, color: '#f1f5f9' }}>
            ⚙ Model Weight Tuner
          </div>
          <div style={{ fontFamily: MONO, fontSize: 10, color: '#475569', marginTop: 2 }}>
            Adjust factor importance • Must sum to 100%
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{
            fontFamily: MONO, fontSize: 12, fontWeight: 700,
            color: isValid ? '#4ade80' : '#ef4444',
          }}>
            Σ {(total * 100).toFixed(1)}%
          </span>
          <Btn onClick={() => setShowTips(t => !t)} secondary>
            {showTips ? 'Hide Tips' : 'Tips'}
          </Btn>
          <Btn onClick={normalize} secondary>Auto-Balance</Btn>
          <Btn onClick={reset} secondary>Reset</Btn>
          <Btn onClick={() => onApply(weights)} disabled={!isValid}>
            Apply & Recalculate
          </Btn>
        </div>
      </div>

      {/* Suggestion banner from results tracker */}
      {suggestions && Object.keys(suggestions).length > 0 && (
        <div style={{
          padding: '10px 14px', marginBottom: 14,
          background: 'rgba(250,204,21,0.06)', borderRadius: 8,
          border: '1px solid rgba(250,204,21,0.15)',
        }}>
          <div style={{ fontFamily: MONO, fontSize: 10, color: '#facc15', fontWeight: 700, marginBottom: 6 }}>
            💡 SUGGESTIONS FROM YOUR RESULTS
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(suggestions).map(([key, dir]) => (
              <button
                key={key}
                onClick={() => applySuggestion(key, dir)}
                style={{
                  padding: '4px 10px', borderRadius: 6,
                  background: dir === 'increase' ? 'rgba(74,222,128,0.1)' : 'rgba(239,68,68,0.1)',
                  border: `1px solid ${dir === 'increase' ? 'rgba(74,222,128,0.2)' : 'rgba(239,68,68,0.2)'}`,
                  color: dir === 'increase' ? '#4ade80' : '#ef4444',
                  fontFamily: MONO, fontSize: 10, cursor: 'pointer',
                }}
              >
                {dir === 'increase' ? '▲' : '▼'} {FACTOR_LABELS[key]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sliders */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {Object.entries(weights).map(([key, val]) => {
          const pct = (val * 100).toFixed(0);
          const defaultPct = (DEFAULT_WEIGHTS[key] * 100).toFixed(0);
          const changed = Math.abs(val - DEFAULT_WEIGHTS[key]) > 0.005;
          const suggestion = suggestions?.[key];
          return (
            <div key={key}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: changed ? '#facc15' : '#cbd5e1' }}>
                    {FACTOR_LABELS[key]}
                  </span>
                  {suggestion && (
                    <span style={{
                      fontSize: 10, fontFamily: MONO,
                      color: suggestion === 'increase' ? '#4ade80' : '#ef4444',
                    }}>
                      {suggestion === 'increase' ? '▲ suggested' : '▼ suggested'}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {changed && (
                    <span style={{ fontFamily: MONO, fontSize: 9, color: '#475569' }}>
                      was {defaultPct}%
                    </span>
                  )}
                  <span style={{
                    fontFamily: MONO, fontSize: 13, fontWeight: 700,
                    color: changed ? '#facc15' : '#94a3b8', minWidth: 36, textAlign: 'right',
                  }}>
                    {pct}%
                  </span>
                </div>
              </div>
              <input
                type="range" min={1} max={50} step={1}
                value={Math.round(val * 100)}
                onChange={e => handleChange(key, parseInt(e.target.value) / 100)}
                style={{ width: '100%', accentColor: changed ? '#facc15' : '#4ade80', cursor: 'pointer' }}
              />
              {showTips && (
                <div style={{ fontFamily: MONO, fontSize: 10, color: '#475569', marginTop: 2 }}>
                  {FACTOR_TIPS[key]}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Btn({ children, onClick, secondary, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '6px 12px', borderRadius: 7,
        background: disabled ? 'rgba(255,255,255,0.03)' : secondary ? 'rgba(255,255,255,0.05)' : 'rgba(74,222,128,0.12)',
        border: `1px solid ${disabled ? 'rgba(255,255,255,0.04)' : secondary ? 'rgba(255,255,255,0.08)' : 'rgba(74,222,128,0.25)'}`,
        color: disabled ? '#334155' : secondary ? '#94a3b8' : '#4ade80',
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
        cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >{children}</button>
  );
}
