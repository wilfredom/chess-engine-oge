#!/usr/bin/env python3
"""Fit one Bradley-Terry / maximum-likelihood Elo per Skill_Level from tournament/pairings/*.json
(draw = half a win), level 1 anchored at 0. 95% intervals: bootstrap over openings (each opening is one
two-game pair, resampled from the pentanomial counts of its pairing). Writes tournament_ratings.csv,
tournament_stats.json and tournament_curve.png. Usage: tournament_fit.py [--boot 2000]"""
import argparse, csv, glob, json, os
import numpy as np
from scipy.optimize import minimize
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
N = 24
PRIOR = 0.1      # pseudo-points per pairing side (0.2 games), keeps 60-0 pairings finite
PTS = np.array([0, .5, 1, 1.5, 2])

def load():
    rows = [json.load(open(p)) for p in sorted(glob.glob(f'{HERE}/tournament/pairings/*.json'))]
    I = np.array([r['a'] - 1 for r in rows]); J = np.array([r['b'] - 1 for r in rows])
    pent = np.array([r['pentanomial'] for r in rows])
    return rows, I, J, pent

def fit(I, J, pts, games, x0=None):
    """MLE of ratings r[0..N-1]; r[0] = 0. pts = points scored by the lower level of each pairing."""
    pts = pts + PRIOR; games = games + 2 * PRIOR
    def nll(r):
        d = (r[J] - r[I]) / 400.0                      # lower level's expected score = 1/(1+10^d)
        p = 1 / (1 + 10 ** d)
        g = np.zeros(N)
        dl = (pts - games * p) * np.log(10) / 400.0     # d loglik / d(r_J - r_I) is -(...); assembled below
        grad = np.zeros(N)
        np.add.at(grad, J, dl); np.add.at(grad, I, -dl)
        ll = np.sum(pts * np.log(p) + (games - pts) * np.log1p(-p))
        return -ll, grad
    x0 = np.zeros(N) if x0 is None else x0
    res = minimize(lambda z: nll(np.r_[0, z])[0], x0[1:], jac=lambda z: nll(np.r_[0, z])[1][1:], method='L-BFGS-B')
    return np.r_[0, res.x]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--boot', type=int, default=2000); a = ap.parse_args()
    rows, I, J, pent = load()
    n_pairs = pent.sum(1); games = 2.0 * n_pairs
    pts = pent @ PTS
    r = fit(I, J, pts, games)
    rng = np.random.default_rng(1)
    B = np.empty((a.boot, N))
    for b in range(a.boot):
        pb = np.array([rng.multinomial(n, c / n) @ PTS for n, c in zip(n_pairs, pent)])
        B[b] = fit(I, J, pb, games, r)
    lo, hi = np.percentile(B, [2.5, 97.5], axis=0)
    lv = np.arange(1, N + 1)
    gap = np.diff(r); gB = np.diff(B, axis=1); glo, ghi = np.percentile(gB, [2.5, 97.5], axis=0)

    # chain sum from the earlier neighbour-only calibration
    ch = list(csv.DictReader(open(f'{HERE}/skill_curve.csv')))
    chain = np.array([float(x['rating_elo']) for x in ch]); chain_se = np.array([float(x['rating_se']) for x in ch])
    se_t = (hi - lo) / (2 * 1.96)
    den = np.sqrt(se_t ** 2 + chain_se ** 2); z = np.divide(r - chain, den, out=np.zeros(N), where=den > 0)   # level 1 is the anchor
    cg = np.array([float(x['gap_to_previous_elo']) for x in ch])[1:]; cg_se = np.array([float(x['gap_se']) for x in ch])[1:]
    g_se = (ghi - glo) / (2 * 1.96); zg = (gap - cg) / np.sqrt(g_se ** 2 + cg_se ** 2)

    slope, icpt = np.polyfit(lv, r, 1); fitl = slope * lv + icpt
    r2 = 1 - np.sum((r - fitl) ** 2) / np.sum((r - r.mean()) ** 2)
    dev = r - fitl; k = int(np.argmax(np.abs(dev)))
    out_band = [int(l) for l, g in zip(lv[1:], gap) if not 100 <= g <= 200]
    cs, ci = np.polyfit(chain, r, 1)
    stats = {
      'pairings': len(rows), 'games': int(games.sum()), 'time_losses': int(sum(x.get('time_losses', 0) for x in rows)),
      'span_1_to_24': round(float(r[-1]), 1), 'chain_span': round(float(chain[-1]), 1),
      'fit_slope_per_level': round(float(slope), 1), 'fit_r2': round(float(r2), 4),
      'max_abs_dev': round(float(abs(dev[k])), 1), 'max_dev_level': int(lv[k]), 'max_dev_signed': round(float(dev[k]), 1),
      'gap_mean': round(float(gap.mean()), 1), 'gap_sd': round(float(gap.std(ddof=1)), 1),
      'gap_min': [round(float(gap.min()), 1), int(lv[1:][gap.argmin()])], 'gap_max': [round(float(gap.max()), 1), int(lv[1:][gap.argmax()])],
      'gaps_outside_100_200': out_band, 'n_gaps_outside': len(out_band),
      'gap_median_ci_halfwidth': round(float(np.median((ghi - glo) / 2)), 1),
      'tournament_vs_chain_slope': round(float(cs), 3),
      'levels_tournament_outside_chain_interval(|z|>1.96)': [int(l) for l, zz in zip(lv, z) if abs(zz) > 1.96],
      'gap_levels_disagreeing_with_chain(|z|>1.96)': [int(l) for l, zz in zip(lv[1:], zg) if abs(zz) > 1.96],
      'gap_tournament_minus_chain': [round(float(x), 1) for x in (gap - cg)], 'gap_z': [round(float(x), 2) for x in zg],
      'gap_tournament': [round(float(x), 1) for x in gap], 'gap_ci': [[round(float(a), 1), round(float(b), 1)] for a, b in zip(glo, ghi)],
      'z_vs_chain': [round(float(x), 2) for x in z],
      'diff_vs_chain': [round(float(x), 1) for x in (r - chain)],
    }
    json.dump(stats, open(f'{HERE}/tournament_stats.json', 'w'), indent=1)
    with open(f'{HERE}/tournament_ratings.csv', 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['level', 'rating_elo', 'ci95_lo', 'ci95_hi', 'chain_sum_elo', 'chain_sum_se', 'diff_vs_chain', 'z_vs_chain'])
        for i in range(N): w.writerow([i + 1, round(r[i], 1), round(lo[i], 1), round(hi[i], 1), chain[i], chain_se[i], round(r[i] - chain[i], 1), round(z[i], 2)])
    plot(lv, r, lo, hi, chain, fitl, gap, glo, ghi, slope, r2)
    print(json.dumps(stats, indent=1))

def plot(lv, r, lo, hi, chain, fitl, gap, glo, ghi, slope, r2):
    BG, BLUE, INK, GREY = '#fcfcfb', '#2a78d6', '#3a3a38', '#8a8a86'
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'text.color': INK, 'axes.edgecolor': GREY,
                         'axes.labelcolor': GREY, 'xtick.color': GREY, 'ytick.color': GREY})
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 8.2), sharex=True, facecolor=BG, gridspec_kw={'height_ratios': [3, 2], 'hspace': 0.08})
    for a in (a1, a2):
        a.set_facecolor(BG); a.grid(axis='y', color='#e8e8e5', lw=0.6); a.set_axisbelow(True)
        for s in ('top', 'right'): a.spines[s].set_visible(False)
    a1.fill_between(lv, lo, hi, color=BLUE, alpha=0.16, lw=0)
    a1.plot(lv, chain, color=GREY, lw=1, ls=(0, (4, 3)))
    a1.plot(lv, fitl, color=INK, lw=0.8, alpha=0.55)
    a1.plot(lv, r, color=BLUE, lw=1.8, marker='o', ms=4, mfc=BG, mew=1.4)
    a1.set_xlim(0.4, 28.2); a1.set_ylim(-300, 3500); a1.set_ylabel('Elo (level 1 = 0)')
    ytxt = lambda y: y
    a1.text(24.4, 2800, 'tournament fit\n(95% interval shaded)', color=BLUE, va='center', fontsize=9)
    a1.text(24.4, 3330, 'chain sum of\nneighbour gaps', color=GREY, va='center', fontsize=9)
    a1.text(24.4, 2250, f'straight line\n{slope:.0f} Elo/level\nR² = {r2:.4f}', color=INK, va='center', fontsize=9, alpha=0.8)
    a1.set_title('OGE rating per Skill_Level, from a tournament of levels 1-24', loc='left', fontsize=12, color=INK)
    x = lv[1:]
    a2.axhspan(100, 200, color=GREY, alpha=0.14, lw=0)
    a2.axhline(gap.mean(), color=INK, lw=0.9, ls=(0, (4, 3)))
    a2.errorbar(x, gap, yerr=[gap - glo, ghi - gap], fmt='none', ecolor=BLUE, elinewidth=0.9, alpha=0.5, capsize=0)
    a2.plot(x, gap, color=BLUE, lw=1.2, marker='o', ms=4, mfc=BG, mew=1.4)
    a2.text(24.4, 150, 'target band\n100-200 Elo', color=GREY, va='center', fontsize=9)
    a2.text(24.4, gap.mean() - (28 if gap.mean() < 150 else -28), f'mean {gap.mean():.0f}', color=INK, va='center', fontsize=9)
    a2.set_ylabel('Elo gained over previous level'); a2.set_xlabel('Skill_Level')
    a2.set_xticks(range(1, 25)); a2.tick_params(axis='x', length=0)
    fig.savefig(f'{HERE}/tournament_curve.png', dpi=150, facecolor=BG, bbox_inches='tight')

if __name__ == '__main__': main()
