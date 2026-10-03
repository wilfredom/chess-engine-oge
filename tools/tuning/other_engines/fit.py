#!/usr/bin/env python3
"""Bradley-Terry fit + chart for one family. Usage: fit.py FAMILY [--boot 1000]. Lowest level anchored at 0 Elo."""
import argparse, glob, json, csv
import numpy as np
from scipy.optimize import minimize
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
PRIOR = 0.1; PTS = np.array([0, .5, 1, 1.5, 2])
TITLE = {'patricia': 'Patricia 5.1 Skill_Level', 'gaiachess': 'Gaia 4.3.2 Skill Level', 'stockfish': 'Stockfish 16 Skill Level'}
def fit(I, J, pts, games, N, x0=None):
    pts = pts + PRIOR; games = games + 2 * PRIOR
    def f(z):
        r = np.r_[0, z]; p = 1 / (1 + 10 ** ((r[J] - r[I]) / 400.0))   # lower level's expected score
        return -np.sum(pts * np.log(p) + (games - pts) * np.log1p(-p))
    x0 = np.zeros(N) if x0 is None else x0
    res = minimize(f, x0[1:], method='L-BFGS-B')   # numeric gradient: N<=21, cheap and sign-safe
    return np.r_[0, res.x]
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('family'); ap.add_argument('--boot', type=int, default=1000); ap.add_argument('--dir', default='res'); a = ap.parse_args()
    rows = [json.load(open(p)) for p in sorted(glob.glob(f'{a.dir}/{a.family}/pairings/*.json'))]
    lv = np.array(sorted({r['a'] for r in rows} | {r['b'] for r in rows})); N = len(lv); ix = {l: k for k, l in enumerate(lv)}
    I = np.array([ix[r['a']] for r in rows]); J = np.array([ix[r['b']] for r in rows]); pent = np.array([r['pentanomial'] for r in rows])
    npairs = pent.sum(1); games = 2.0 * npairs; pts = pent @ PTS
    r = fit(I, J, pts, games, N); rng = np.random.default_rng(1); B = np.empty((a.boot, N))
    for b in range(a.boot):
        pb = np.array([rng.multinomial(n, c / n) @ PTS for n, c in zip(npairs, pent)]); B[b] = fit(I, J, pb, games, N, r)
    lo, hi = np.percentile(B, [2.5, 97.5], axis=0); gap = np.diff(r); gB = np.diff(B, axis=1); glo, ghi = np.percentile(gB, [2.5, 97.5], axis=0)
    slope, icpt = np.polyfit(lv, r, 1); fitl = slope * lv + icpt; r2 = 1 - np.sum((r - fitl) ** 2) / np.sum((r - r.mean()) ** 2)
    dev = r - fitl; k = int(np.argmax(np.abs(dev)))
    st = dict(family=a.family, pairings=len(rows), games=int(games.sum()), time_losses=sum(x['time_losses'] for x in rows),
              span=round(float(r[-1]), 1), slope_per_level=round(float(slope), 1), r2=round(float(r2), 4),
              max_dev=round(float(dev[k]), 1), max_dev_level=int(lv[k]), gap_mean=round(float(gap.mean()), 1), gap_sd=round(float(gap.std(ddof=1)), 1),
              gap_min=[round(float(gap.min()), 1), int(lv[1:][gap.argmin()])], gap_max=[round(float(gap.max()), 1), int(lv[1:][gap.argmax()])],
              gap_ci_halfwidth_median=round(float(np.median((ghi - glo) / 2)), 1), rmse_vs_line=round(float(np.sqrt(np.mean(dev ** 2))), 1),
              gaps=[round(float(x), 1) for x in gap])
    s2, i2 = np.polyfit(lv[:-1], r[:-1], 1); d2 = r[:-1] - (s2 * lv[:-1] + i2)
    st['excl_top_level'] = dict(slope=round(float(s2), 1), r2=round(float(1 - np.sum(d2 ** 2) / np.sum((r[:-1] - r[:-1].mean()) ** 2)), 4),
        max_dev=round(float(d2[np.argmax(np.abs(d2))]), 1), max_dev_level=int(lv[:-1][np.argmax(np.abs(d2))]), rmse=round(float(np.sqrt(np.mean(d2 ** 2))), 1),
        gap_mean=round(float(gap[:-1].mean()), 1), gap_sd=round(float(gap[:-1].std(ddof=1)), 1))
    json.dump(st, open(f'{a.dir}/{a.family}/stats.json', 'w'), indent=1)
    with open(f'{a.dir}/{a.family}/ratings.csv', 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['level', 'elo', 'ci_lo', 'ci_hi'])
        for i in range(N): w.writerow([lv[i], round(r[i], 1), round(lo[i], 1), round(hi[i], 1)])
    plot(a.family, lv, r, lo, hi, fitl, gap, glo, ghi, slope, r2, f'{a.dir}/{a.family}.png'); print(json.dumps(st))
def plot(fam, lv, r, lo, hi, fitl, gap, glo, ghi, slope, r2, path):
    BG, BLUE, INK, GREY = '#fcfcfb', '#2a78d6', '#3a3a38', '#8a8a86'
    plt.rcParams.update({'font.size': 10, 'text.color': INK, 'axes.edgecolor': GREY, 'axes.labelcolor': GREY, 'xtick.color': GREY, 'ytick.color': GREY})
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 8), sharex=True, facecolor=BG, gridspec_kw={'height_ratios': [3, 2], 'hspace': 0.08})
    for a in (a1, a2):
        a.set_facecolor(BG); a.grid(axis='y', color='#e8e8e5', lw=0.6); a.set_axisbelow(True)
        for s in ('top', 'right'): a.spines[s].set_visible(False)
    a1.fill_between(lv, lo, hi, color=BLUE, alpha=0.16, lw=0); a1.plot(lv, fitl, color=INK, lw=0.9, alpha=0.6, ls=(0, (4, 3)))
    a1.plot(lv, r, color=BLUE, lw=1.8, marker='o', ms=4, mfc=BG, mew=1.4)
    a1.set_ylabel(f'Elo (level {lv[0]} = 0)'); a1.set_xlim(lv[0] - 0.6, lv[-1] + 4.2)
    x1 = lv[-1] + 0.5
    a1.text(1.01, 0.88, 'measured\n(95% interval)', color=BLUE, va='center', fontsize=9, transform=a1.transAxes)
    a1.text(1.01, 0.62, f'straight line\n{slope:.0f} Elo/level\nR² = {r2:.4f}', color=INK, va='center', fontsize=9, alpha=0.8, transform=a1.transAxes)
    a1.set_title(f'{TITLE[fam]}: rating by level (own tournament, levels vs neighbours within 3)', loc='left', fontsize=11.5)
    x = lv[1:]; a2.axhline(gap.mean(), color=INK, lw=0.9, ls=(0, (4, 3)))
    a2.errorbar(x, gap, yerr=[gap - glo, ghi - gap], fmt='none', ecolor=BLUE, elinewidth=0.9, alpha=0.5)
    a2.plot(x, gap, color=BLUE, lw=1.2, marker='o', ms=4, mfc=BG, mew=1.4)
    a2.text(x1, gap.mean(), f'mean {gap.mean():.0f}', color=INK, va='center', fontsize=9)
    a2.set_ylabel('Elo gained over previous level'); a2.set_xlabel('Skill level'); a2.set_xticks(list(lv)); a2.tick_params(axis='x', length=0)
    fig.savefig(path, dpi=140, facecolor=BG, bbox_inches='tight')
main()
