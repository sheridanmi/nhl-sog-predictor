#!/usr/bin/env python3
"""
Diagnose + recalibrate the SOG model from an export of settled snapshots.

Usage:  python3 analyze.py snapshots-export.json [report.md]

What it answers
  1. Do bigger stated edges actually win more? (bucket table with CIs and ROI)
  2. Is the model or the market better calibrated? (Brier / log loss)
  3. How much should the model be trusted vs the market? (logistic blend + grid)
  4. Which splits (sample size, line, position, hot-streak gap) are leaking money?
  5. Walk-forward: if we had used the recalibrated probability day by day,
     would the plays have made money? (each day uses only earlier days)
"""
import sys, json, math, collections
import numpy as np
from scipy.optimize import minimize

path = sys.argv[1]
out_path = sys.argv[2] if len(sys.argv) > 2 else None
lines_out = []
def P(s=""):
    print(s); lines_out.append(s)

# ---------- helpers ----------
def imp(o):
    return abs(o) / (abs(o) + 100) if o < 0 else 100 / (o + 100)
def dec(o):
    return 1 + (100 / abs(o) if o < 0 else o / 100)
def logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4); return np.log(p / (1 - p))
def sigmoid(x): return 1 / (1 + np.exp(-x))
def wilson(w, n, z=1.96):
    if n == 0: return (float('nan'),) * 2
    p = w / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h
def brier(p, y): return float(np.mean((p - y) ** 2))
def logloss(p, y):
    p = np.clip(p, 1e-4, 1 - 1e-4); return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
def roi(odds, y):
    # flat 1u stakes on the Over
    ret = np.where(y == 1, np.array([dec(o) - 1 for o in odds]), -1.0)
    return float(np.mean(ret)) if len(ret) else float('nan')

# ---------- load ----------
rows = json.load(open(path))
R = []
for s in rows:
    if s.get('overResult') not in ('won', 'lost'): continue
    if s.get('modelProb') is None or s.get('overOdds') is None: continue
    po = imp(s['overOdds'])
    pu = imp(s['underOdds']) if s.get('underOdds') is not None else None
    market = po / (po + pu) if pu is not None else po  # no-vig when we can
    R.append(dict(
        date=s.get('gameDate', ''), y=1 if s['overResult'] == 'won' else 0,
        model=s['modelProb'] / 100.0, market=market, implied=po, odds=s['overOdds'],
        edge=s.get('edge') if s.get('edge') is not None else (s['modelProb'] - 100 * po),
        line=s.get('line'), gp=s.get('gamesPlayed'), pos=s.get('position'),
        ha=s.get('homeAway'), b2b=bool(s.get('isBackToBack')),
        gap=(s['last5Avg'] - s['seasonAvg']) if s.get('last5Avg') is not None and s.get('seasonAvg') is not None else None,
        proj=s.get('projection'), actual=s.get('actualSOG'),
        seas=s.get('seasonAvg'), l5=s.get('last5Avg'), l10=s.get('last10Avg'),
        toi=s.get('avgTOI'), rtoi=s.get('recentTOI'),
        under_odds=s.get('underOdds'),
    ))
R.sort(key=lambda r: r['date'])
n = len(R)
if n < 30:
    P(f"Only {n} decided snapshots - too few to analyze. Need at least ~30, ideally 500+."); sys.exit(0)
y = np.array([r['y'] for r in R], float)
model = np.array([r['model'] for r in R]); market = np.array([r['market'] for r in R])
odds = [r['odds'] for r in R]
dates = sorted(set(r['date'] for r in R))

P(f"# SOG model diagnostic  ({n} decided Overs, {dates[0]} to {dates[-1]}, {len(dates)} slates)\n")
w = int(y.sum()); lo, hi = wilson(w, n)
P(f"Overall Over win rate: {w}/{n} = {100*w/n:.1f}%  (95% CI {100*lo:.1f}-{100*hi:.1f}) | avg model prob {100*model.mean():.1f}% | avg no-vig market {100*market.mean():.1f}% | flat ROI {100*roi(odds,y):+.1f}%\n")

# ---------- 1. edge buckets ----------
P("## 1. Do bigger edges win more?")
P("| Edge bucket | n | Win % | 95% CI | Avg model % | Avg market % | Flat ROI |")
P("|---|---|---|---|---|---|---|")
for lab, a, b in [("< 0", -1e9, 0), ("0-5", 0, 5), ("5-10", 5, 10), ("10-15", 10, 15), ("15-20", 15, 20), ("20+", 20, 1e9)]:
    idx = [i for i, r in enumerate(R) if a <= r['edge'] < b]
    if not idx: continue
    ww = int(y[idx].sum()); l, h = wilson(ww, len(idx))
    P(f"| {lab} | {len(idx)} | {100*ww/len(idx):.1f}% | {100*l:.0f}-{100*h:.0f} | {100*model[idx].mean():.1f} | {100*market[idx].mean():.1f} | {100*roi([odds[i] for i in idx], y[idx]):+.1f}% |")
P("\nIf Win % does not rise with the bucket, the stated edge is mostly model error, not opportunity.\n")

# ---------- 2. calibration ----------
P("## 2. Model vs market (lower is better)")
P(f"- Brier:    model {brier(model,y):.4f} | market {brier(market,y):.4f}")
P(f"- Log loss: model {logloss(model,y):.4f} | market {logloss(market,y):.4f}")
P("\nCalibration by model probability:")
P("| Model prob bin | n | Predicted | Actual |")
P("|---|---|---|---|")
for a in range(0, 100, 10):
    idx = [i for i in range(n) if a <= model[i] * 100 < a + 10]
    if len(idx) >= 5:
        P(f"| {a}-{a+10}% | {len(idx)} | {100*model[idx].mean():.1f}% | {100*y[idx].mean():.1f}% |")
P("")

# ---------- 3. blend with market ----------
def fit_logit(Xm, Xk, yy, l2=1.0):
    X = np.column_stack([np.ones(len(yy)), logit(Xm), logit(Xk)])
    def nll(b):
        p = np.clip(sigmoid(X @ b), 1e-6, 1 - 1e-6)
        return -np.sum(yy * np.log(p) + (1 - yy) * np.log(1 - p)) + l2 * (b[1] ** 2 + b[2] ** 2) * 0.5
    return minimize(nll, np.array([0, 0.2, 0.8]), method="BFGS").x
def predict(b, Xm, Xk):
    return sigmoid(b[0] + b[1] * logit(Xm) + b[2] * logit(Xk))

b = fit_logit(model, market, y)
P("## 3. How much to trust the model")
P(f"Logistic fit: logit(P) = {b[0]:+.3f} + {b[1]:.3f}*logit(model) + {b[2]:.3f}*logit(market)")
P("(model coefficient near 0 = model adds nothing beyond the market; near 1 with market near 0 = model is the better source)")
best_w, best_ll = 0, 9
for wt in np.linspace(0, 1, 21):
    ll = logloss(wt * model + (1 - wt) * market, y)
    if ll < best_ll: best_w, best_ll = wt, ll
P(f"Best linear blend p = w*model + (1-w)*market: w = {best_w:.2f} (log loss {best_ll:.4f} vs market-only {logloss(market,y):.4f})\n")

# ---------- 4. splits ----------
def split(title, keyfn):
    g = collections.defaultdict(list)
    for i, r in enumerate(R):
        k = keyfn(r)
        if k is not None: g[k].append(i)
    P(f"**{title}**")
    P("| Group | n | Win % | Avg model % | Avg market % | Model - actual (pts) | ROI |")
    P("|---|---|---|---|---|---|---|")
    for k, idx in sorted(g.items(), key=lambda kv: str(kv[0])):
        if len(idx) < 8: continue
        P(f"| {k} | {len(idx)} | {100*y[idx].mean():.1f}% | {100*model[idx].mean():.1f} | {100*market[idx].mean():.1f} | {100*(model[idx].mean()-y[idx].mean()):+.1f} | {100*roi([odds[i] for i in idx], y[idx]):+.1f}% |")
    P("")
P("## 4. Where is the model leaking?")
split("By games played (sample size behind the projection)", lambda r: None if r['gp'] is None else ("<8" if r['gp'] < 8 else "8-11" if r['gp'] < 12 else "12+"))
split("By line", lambda r: r['line'])
split("By position", lambda r: r['pos'])
split("By last-5 minus season avg (hot/cold streak)", lambda r: None if r['gap'] is None else ("cold < -0.5" if r['gap'] < -0.5 else "flat" if r['gap'] <= 0.5 else "hot 0.5-1.0" if r['gap'] <= 1.0 else "very hot > 1.0"))
split("Home/away", lambda r: r['ha'])
split("Back-to-back", lambda r: r['b2b'])

# ---------- 5. walk-forward ----------
P("## 5. Walk-forward test (each slate predicted using only earlier slates)")
MIN_TRAIN = max(60, n // 4)
by_date = collections.defaultdict(list)
for i, r in enumerate(R): by_date[r['date']].append(i)
wf_p = np.full(n, np.nan)
for d in dates:
    train = [i for i in range(n) if R[i]['date'] < d]
    if len(train) < MIN_TRAIN: continue
    bb = fit_logit(model[train], market[train], y[train])
    for i in by_date[d]: wf_p[i] = predict(bb, model[i:i+1], market[i:i+1])[0]
ok = ~np.isnan(wf_p)
if ok.sum() < 30:
    P(f"Not enough history yet ({ok.sum()} out-of-sample plays; need >= 30 after a {MIN_TRAIN}-play warm-up). Re-run in a week or two.\n")
else:
    P(f"Out-of-sample plays: {ok.sum()}. Log loss: raw model {logloss(model[ok],y[ok]):.4f} | market {logloss(market[ok],y[ok]):.4f} | recalibrated {logloss(wf_p[ok],y[ok]):.4f}")
    P("| Play rule | n | Win % | Avg odds-implied % | Flat ROI |")
    P("|---|---|---|---|---|")
    impl = np.array([r['implied'] for r in R])
    for name, mask in [
        ("Raw model edge >= 5", np.array([r['edge'] >= 5 for r in R]) & ok),
        ("Raw model edge >= 10", np.array([r['edge'] >= 10 for r in R]) & ok),
        ("Recalibrated edge >= 2", ((wf_p - impl) * 100 >= 2) & ok),
        ("Recalibrated edge >= 3", ((wf_p - impl) * 100 >= 3) & ok),
        ("Recalibrated edge >= 5", ((wf_p - impl) * 100 >= 5) & ok),
    ]:
        idx = np.where(mask)[0]
        if len(idx) == 0: P(f"| {name} | 0 | - | - | - |"); continue
        P(f"| {name} | {len(idx)} | {100*y[idx].mean():.1f}% | {100*impl[idx].mean():.1f} | {100*roi([odds[i] for i in idx], y[idx]):+.1f}% |")
    P("\nA real edge shows up as Win % clearly above the odds-implied % for the recalibrated rows, and not for the raw ones.\n")

# ---------- 6. learn a better projection from the data ----------
from scipy.stats import nbinom
from scipy.optimize import brentq

def nb_sf(k, mu, r):
    """P(X > k) for NB with mean mu, dispersion r (r=inf -> Poisson-like)."""
    mu = np.maximum(mu, 0.05)
    p = r / (r + mu)
    return nbinom.sf(k, r, p)

def implied_mu(line, p_over, r):
    k = math.floor(line)
    f = lambda mu: nb_sf(k, mu, r) - p_over
    try: return brentq(f, 0.05, 20)
    except ValueError: return float('nan')

P("## 6. Learn the projection itself (market mean + player features -> actual shots)")
need = ['seas', 'l5', 'l10', 'toi', 'rtoi', 'actual', 'line']
D = [i for i, r in enumerate(R) if all(r[k] is not None for k in need)]
if len(D) < 150:
    P(f"Only {len(D)} snapshots carry the fields needed (actualSOG, last5Avg, ...). Skipping.\n")
else:
    R_DISP = 8.0  # starting dispersion; re-estimated below
    for _ in range(2):
        mu_m = np.array([implied_mu(R[i]['line'], R[i]['market'], R_DISP) for i in D])
        good = ~np.isnan(mu_m)
        Dg = [D[j] for j in range(len(D)) if good[j]]; mu_m = mu_m[good]
        act = np.array([R[i]['actual'] for i in Dg], float)
        # method-of-moments dispersion from residuals vs the market mean
        v = np.var(act - mu_m); m = np.mean(mu_m)
        R_DISP = float(np.clip((m * m) / max(v - m, 1e-3), 1.5, 60))
    seas = np.array([R[i]['seas'] for i in Dg]); l5 = np.array([R[i]['l5'] for i in Dg]); l10 = np.array([R[i]['l10'] for i in Dg])
    toi = np.array([R[i]['toi'] for i in Dg]); rtoi = np.array([R[i]['rtoi'] for i in Dg])
    proj = np.array([R[i]['proj'] if R[i]['proj'] is not None else np.nan for i in Dg], float)
    # features expressed as DEVIATIONS from the market mean, so the fit answers
    # "which player signals move the true mean away from what the market already says?"
    X = np.column_stack([np.ones(len(Dg)), seas - mu_m, l5 - seas, l10 - seas, rtoi - toi])
    names = ["intercept", "season avg - market", "last5 - season", "last10 - season", "recent TOI - avg TOI (min)"]
    gdates = [R[i]['date'] for i in Dg]
    def ridge(Xa, ya, lam=5.0):
        I = np.eye(Xa.shape[1]); I[0, 0] = 0
        return np.linalg.solve(Xa.T @ Xa + lam * I, Xa.T @ ya)
    beta = ridge(X, act - mu_m)
    P(f"Estimated NB dispersion r = {R_DISP:.1f}. Fitted on {len(Dg)} plays:  actual SOG - market mean = ")
    for nm, bv in zip(names, beta): P(f"- {nm}: {bv:+.3f}")
    P("(The 'last5 - season' and 'last10 - season' coefficients are the ones to read: ~0 or negative means hot/cold streaks do NOT carry forward, so the current heavy last-5 weighting is wrong; positive means they do.)\n")

    # walk-forward
    ud = sorted(set(gdates)); idx_by = collections.defaultdict(list)
    for j, d in enumerate(gdates): idx_by[d].append(j)
    pred = np.full(len(Dg), np.nan)
    warm = max(150, len(Dg) // 4)
    for d in ud:
        tr = [j for j in range(len(Dg)) if gdates[j] < d]
        if len(tr) < warm: continue
        bb = ridge(X[tr], (act - mu_m)[tr])
        for j in idx_by[d]: pred[j] = mu_m[j] + X[j] @ bb
    ok2 = ~np.isnan(pred)
    def rmse(a): return float(np.sqrt(np.mean((a - act[ok2]) ** 2)))
    P(f"Out-of-sample RMSE of predicted shots (lower = better, n={ok2.sum()}):")
    P(f"- Market-implied mean:   {rmse(mu_m[ok2]):.3f}")
    P(f"- Season average only:   {rmse(seas[ok2]):.3f}")
    if not np.isnan(proj[ok2]).any(): P(f"- Current model (v3):    {rmse(proj[ok2]):.3f}")
    P(f"- Learned v4 projection: {rmse(pred[ok2]):.3f}\n")

    # betting test: Over AND Under, vs vigged odds, using the learned projection
    if ok2.sum() >= 50:
        P("Walk-forward betting test using the learned projection (flat 1u, both sides):")
        P("| Rule | n | Win % | Avg implied % | Flat ROI |")
        P("|---|---|---|---|---|")
        for thr in (2, 3, 4, 6):
            for side in ("Over", "Under"):
                wins = []; imps = []; ods = []
                for j in np.where(ok2)[0]:
                    r = R[Dg[j]]; k = math.floor(r['line'])
                    p_over = float(nb_sf(k, pred[j], R_DISP))
                    if side == "Over":
                        o, p, won = r['odds'], p_over, act[j] > r['line']
                    else:
                        o = r.get('under_odds'); p = 1 - p_over; won = act[j] < r['line']
                        if o is None: continue
                    if act[j] == r['line']: continue  # push
                    if (p - imp(o)) * 100 >= thr:
                        wins.append(1 if won else 0); imps.append(imp(o)); ods.append(o)
                if wins:
                    P(f"| {side}, edge >= {thr} | {len(wins)} | {100*np.mean(wins):.1f}% | {100*np.mean(imps):.1f} | {100*roi(ods, np.array(wins, float)):+.1f}% |")
                else:
                    P(f"| {side}, edge >= {thr} | 0 | - | - | - |")
        P("\nBreak-even needs Win % >= Avg implied %. Under a ~6% two-way hold, even a real edge of 2-3 points often shows as ROI near 0.\n")

# ---------- 7. line shopping (v4-shop snapshots) ----------
P("## 7. Line shopping (v4-shop): is one book's off-market price a real edge?")
V = [s for s in rows if str(s.get('modelVersion') or '').startswith('v4')]
if not V:
    P("No v4-shop snapshots yet. They start appearing after the next daily fetch; the first settled ones the morning after.\n")
else:
    vdays = sorted(set(s.get('gameDate', '') for s in V))
    priced = [s for s in V if (s.get('shopNTwoSided') or 0) >= 4]
    fl = collections.Counter(s.get('shopFlag') for s in priced)
    P(f"{len(V)} v4 snapshots over {len(vdays)} slates; {len(priced)} priced by 4+ two-sided books. Flags: SHOP+ {fl.get('SHOP+',0)}, SHOP {fl.get('SHOP',0)}, CHECK (suspicious, excluded below) {fl.get('CHECK',0)}, none {fl.get('NONE',0)}.\n")

    S = []
    for s in V:
        side = s.get('shopSide'); res = s.get('overResult')
        if side not in ('over', 'under') or s.get('shopOdds') is None or s.get('shopFair') is None: continue
        if res not in ('won', 'lost'): continue   # pending or push
        S.append(dict(side=side, won=1 if (res == 'won') == (side == 'over') else 0, odds=s['shopOdds'],
                      implied=imp(s['shopOdds']), fair=s['shopFair'], edge=s.get('shopEdge') or 0,
                      flag=s.get('shopFlag'), book=s.get('shopBook'), date=s.get('gameDate', ''),
                      cc=s.get('closingConsensusOver'), ccn=s.get('closingNTwoSided')))

    def stats(sub):
        w_ = sum(x['won'] for x in sub); n_ = len(sub)
        lo_, hi_ = wilson(w_, n_)
        ev = float(np.mean([x['fair'] * dec(x['odds']) - 1 for x in sub]))
        rl = float(np.mean([(dec(x['odds']) - 1) if x['won'] else -1.0 for x in sub]))
        return n_, w_ / n_, lo_, hi_, float(np.mean([x['fair'] for x in sub])), float(np.mean([x['implied'] for x in sub])), ev, rl

    HDR = "| n | Win % | 95% CI | Avg fair % | Avg price-implied % | Expected ROI | Realized ROI |\n|---|---|---|---|---|---|---|"
    def row(label, sub):
        if not sub: return f"| {label} | 0 | - | - | - | - | - | - |"
        n_, wr, lo_, hi_, fa, im, ev, rl = stats(sub)
        return f"| {label} | {n_} | {100*wr:.1f}% | {100*lo_:.0f}-{100*hi_:.0f} | {100*fa:.1f} | {100*im:.1f} | {100*ev:+.1f}% | {100*rl:+.1f}% |"
    HDR2 = "| Group " + HDR.split("\n")[0] + "\n|---|---|---|---|---|---|---|---|"

    flagged = [x for x in S if x['flag'] in ('SHOP', 'SHOP+')]
    P("**Flagged plays (SHOP and SHOP+), flat 1u at the flagged price, settled only:**")
    P(HDR2); P(row("All flagged", flagged))
    P("\n'Fair %' is what the other books say the true chance is. Expected ROI is what you'd earn IF the other books are right; Realized ROI is what happened.\n")

    if len(flagged) < 100:
        P(f"**Verdict: TOO EARLY.** {len(flagged)} settled flagged plays so far; nothing under ~100 means anything, and ~{int(1.96/0.02**2)} are needed to confirm a 2-point edge. Keep this paper-only.\n")
    else:
        n_, wr, lo_, hi_, fa, im, ev, rl = stats(flagged)
        d = fa - im
        need = int(1.96 / d ** 2) if d > 0.002 else None
        if lo_ > im: v = "EVIDENCE OF EDGE: win rate's 95% CI sits above the price-implied rate."
        elif hi_ < im: v = "NO EDGE: win rate's 95% CI sits below the price-implied rate (the off-price book was probably the informed one)."
        else: v = f"INCONCLUSIVE: CI straddles the break-even rate." + (f" Confirming a {100*d:.1f}-point edge needs roughly {need} plays." if need else " The edge claimed is under 0.2 points, too small to ever confirm.")
        P(f"**Verdict: {v}**\n")
        se = math.sqrt(sum(x['fair'] * (1 - x['fair']) for x in flagged)) / n_
        z = (wr - fa) / se
        P(f"Consensus check: flagged plays won {100*wr:.1f}% vs the {100*fa:.1f}% the other books predicted (z = {z:+.1f}). "
          + ("WARNING: they win significantly LESS than the other books predict, so the off-price book probably knows something the rest don't. Do not bet these." if z < -2
             else "Consistent with the other books being right."))
        P("")

    P("**By edge size:**"); P(HDR2)
    for lab, lo_e, hi_e in (("2-4 pts", 2, 4), ("4-6 pts", 4, 6), ("6-10 pts", 6, 10)):
        P(row(lab, [x for x in flagged if lo_e <= x['edge'] < hi_e]))
    P(row("CHECK (10+ pts or books disagree)", [x for x in S if x['flag'] == 'CHECK']))
    P("\nIf realized ROI is worst in the biggest bands, huge 'edges' are stale or voided lines, not opportunities (same pattern as the model edges).\n")

    P("**By side:**"); P(HDR2)
    for sd_ in ("over", "under"): P(row(sd_.title(), [x for x in flagged if x['side'] == sd_]))
    bk = collections.defaultdict(list)
    for x in flagged: bk[x['book']].append(x)
    P("\n**By book that posted the flagged price** (n >= 8):"); P(HDR2)
    for b_, sub in sorted(bk.items(), key=lambda kv: -len(kv[1])):
        if len(sub) >= 8: P(row(str(b_), sub))
    P("")

    # Is the market consensus itself calibrated, and does it beat the model?
    cal = [(s['consensusOver'], 1 if s['overResult'] == 'won' else 0, s.get('modelProb')) for s in priced
           if s.get('consensusOver') is not None and s.get('overResult') in ('won', 'lost')]
    if len(cal) >= 100:
        cp = np.array([c[0] for c in cal]); cy = np.array([c[1] for c in cal], float)
        P(f"**Sanity check: the multi-book consensus on {len(cal)} settled Overs.** Brier {brier(cp, cy):.4f}, log loss {logloss(cp, cy):.4f}.")
        mm = [(c[0], c[1], c[2] / 100) for c in cal if c[2] is not None]
        if mm:
            a_ = np.array([m[0] for m in mm]); y_ = np.array([m[1] for m in mm], float); m_ = np.array([m[2] for m in mm])
            P(f"On those same plays the Monte Carlo model scores Brier {brier(m_, y_):.4f} / log loss {logloss(m_, y_):.4f} (lower is better).")
        P("| Consensus Over % | n | Predicted | Actual |\n|---|---|---|---|")
        for a in range(20, 80, 10):
            ix = [i for i in range(len(cal)) if a <= cp[i] * 100 < a + 10]
            if len(ix) >= 15: P(f"| {a}-{a+10} | {len(ix)} | {100*cp[ix].mean():.1f}% | {100*cy[ix].mean():.1f}% |")
        P("")

    # CLV against the late multi-book consensus: did the market move toward the flagged price?
    cl = [x for x in flagged if x['cc'] is not None and (x['ccn'] or 0) >= 4]
    if len(cl) >= 20:
        late = np.array([(x['cc'] if x['side'] == 'over' else 1 - x['cc']) for x in cl])
        pr = np.array([x['implied'] for x in cl]); fr = np.array([x['fair'] for x in cl])
        P(f"**Closing-line value vs late consensus ({len(cl)} flagged plays with a 5:42 PM multi-book read):** late fair prob minus price-implied = {100*np.mean(late-pr):+.2f} pts ({100*np.mean(late>pr):.0f}% positive); the consensus moved {100*np.mean(late-fr):+.2f} pts since 3 PM (+ = toward the flagged side, - = away from it).")
        avg_clv = float(np.mean(late - pr)); pos = float(np.mean(late > pr))
        if avg_clv > 0 and pos > 0.6: msg = "The late market agrees the flagged prices were good (positive CLV on most plays)."
        elif avg_clv < 0: msg = "The late market moved AWAY from the flagged prices: they were probably the informed side, not mistakes."
        else: msg = "Mixed so far: no clear confirmation either way."
        P(msg + " CLV is the best early evidence because it doesn't wait on win/loss noise (which takes ~1,000+ plays to resolve).\n")

    # paper ledger
    byd = collections.defaultdict(float); cnt = collections.Counter()
    for x in flagged:
        byd[x['date']] += (dec(x['odds']) - 1) if x['won'] else -1.0; cnt[x['date']] += 1
    if byd:
        P("**Paper ledger (flagged plays, 1u each), last 10 slates:**\n| Date | Plays | Units | Cumulative |\n|---|---|---|---|")
        cum = 0.0
        for d_ in sorted(byd)[-10:]:
            cum += byd[d_]; P(f"| {d_} | {cnt[d_]} | {byd[d_]:+.2f} | {cum:+.2f} |")
        P("")

P("## Reference: recalibration constants (only relevant if you keep using the model probability)")
P(f"- Blend weight on model: ~{best_w:.2f}; market: ~{1-best_w:.2f}.")
P(f"- Logistic coefficients to hard-code once n is large: intercept {b[0]:+.3f}, model {b[1]:.3f}, market {b[2]:.3f}.")
P("- Use the recalibrated probability for edge, not the raw Monte Carlo output.")

if out_path:
    open(out_path, "w").write("\n".join(lines_out))
    print(f"\n[report written to {out_path}]")
