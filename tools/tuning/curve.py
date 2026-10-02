#!/usr/bin/env python3
"""Skill level vs rating from the saved fastchess results (no new games).
Rating = cumulative sum of adjacent-level gaps (pentanomial Elo, 200-400 games each), level 1 = 0."""
import json, math, os, sys
import numpy as np
T = '/tmp/claude-0/-home-user-chess-engine-oge/e75db1b4-9bf2-513d-905b-cb08c4a5b420/scratchpad/tuning'
sys.path.insert(0, T)
from final_pass import pentanomial_elo

ladder = json.load(open(f'{T}/ladder_final.json'))['rungs']          # random, 26 budgets..., full
dirs = ['final2', 'final3', 'repair2', 'repair3', 'repair4', 'repair5', 'repair6', 'repair7', 'repair8']
rows = []
for d in dirs:
    p = f'{T}/{d}/results.json'
    if os.path.exists(p): rows += json.load(open(p))

levels, gaps, se = [], [], []
for i in range(2, len(ladder) - 1):                                   # levels 2..24 (0, 1->0 gap and 25 excluded)
    a, b = ladder[i - 1], ladder[i]
    pent = [0] * 5; games = 0
    for r in rows:
        if str(r['a']) == a and str(r['b']) == b and r.get('pentanomial'):
            pent = [x + y for x, y in zip(pent, r['pentanomial'])]; games += r['games']
    e = pentanomial_elo(pent)
    levels.append(i); gaps.append(-e['elo']); se.append((e['hi'] - e['lo']) / (2 * 1.96))
levels = np.array([1] + levels); gaps = np.array([0.0] + gaps); se = np.array([0.0] + se)
rating = np.cumsum(gaps); rating_se = np.sqrt(np.cumsum(se ** 2))

# linearity statistics (levels 1..24)
slope, intercept = np.polyfit(levels, rating, 1)
fit = slope * levels + intercept
ss_res = np.sum((rating - fit) ** 2); ss_tot = np.sum((rating - rating.mean()) ** 2)
r2 = 1 - ss_res / ss_tot
dev = rating - fit
g = gaps[1:]; lv = levels[1:]
gslope, gint = np.polyfit(lv, g, 1)
half = len(g) // 2
stats = {
  'levels': levels.tolist(), 'gap_to_previous': np.round(gaps, 1).tolist(), 'gap_se': np.round(se, 1).tolist(),
  'rating': np.round(rating, 1).tolist(), 'rating_se': np.round(rating_se, 1).tolist(),
  'fit_slope_per_level': round(float(slope), 1), 'fit_r2': round(float(r2), 4),
  'max_abs_dev_from_line': round(float(np.max(np.abs(dev))), 1),
  'max_dev_level': int(levels[np.argmax(np.abs(dev))]),
  'gap_mean': round(float(g.mean()), 1), 'gap_std': round(float(g.std(ddof=1)), 1),
  'gap_min': [round(float(g.min()), 1), int(lv[g.argmin()])], 'gap_max': [round(float(g.max()), 1), int(lv[g.argmax()])],
  'gap_trend_per_level': round(float(gslope), 2),
  'gap_first_half_mean': round(float(g[:half].mean()), 1), 'gap_second_half_mean': round(float(g[half:].mean()), 1),
  'expected_gap_std_from_noise': round(float(np.sqrt(np.mean(se[1:] ** 2))), 1),
}
json.dump(stats, open('curve_stats.json', 'w'), indent=1)
with open('skill_curve.csv', 'w') as f:
    f.write('level,budget_cp_per_40,gap_to_previous_elo,gap_se,rating_elo,rating_se\n')
    for l, gp, s, r, rs in zip(levels, gaps, se, rating, rating_se):
        f.write(f'{l},{ladder[l]},{gp:.1f},{s:.1f},{r:.1f},{rs:.1f}\n')

# ---------------- chart ----------------
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
SURF, INK, INK2, GRID, BLUE, GRAY = '#fcfcfb', '#0b0b0b', '#52514e', '#e6e5e1', '#2a78d6', '#8a8984'
plt.rcParams.update({'font.family': 'DejaVu Sans', 'text.color': INK, 'axes.labelcolor': INK2,
                     'xtick.color': INK2, 'ytick.color': INK2, 'axes.edgecolor': GRID})
fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(9, 9.2), dpi=170, sharex=True,
                               gridspec_kw={'height_ratios': [3, 2], 'hspace': 0.14}, facecolor=SURF)
for ax in (ax1, ax2):
    ax.set_facecolor(SURF)
    ax.grid(axis='y', color=GRID, linewidth=0.8); ax.set_axisbelow(True)
    for s in ('top', 'right'): ax.spines[s].set_visible(False)
    ax.spines['left'].set_color(GRID); ax.spines['bottom'].set_color(GRID)
    ax.tick_params(length=0)

# panel 1: rating vs level
ax1.fill_between(levels, rating - 1.96 * rating_se, rating + 1.96 * rating_se, color=BLUE, alpha=0.14, linewidth=0)
ax1.plot(levels, fit, color=GRAY, linewidth=1.6, linestyle=(0, (5, 4)), zorder=2)
ax1.plot(levels, rating, color=BLUE, linewidth=2.2, zorder=3)
ax1.scatter(levels, rating, s=34, color=BLUE, edgecolor=SURF, linewidth=1.5, zorder=4)
ax1.set_ylabel('Rating relative to level 1 (Elo)', fontsize=10.5)
ax1.set_title('OGE skill levels: rating vs level', loc='left', fontsize=14, fontweight='bold', color=INK, pad=26)
ax1.text(0, 1.035, f'Cumulative sum of head-to-head gaps between neighbouring levels, 200-400 games per pair. Shaded: 95% interval of the sum.',
         transform=ax1.transAxes, fontsize=9, color=INK2, va='bottom')
ax1.text(0.97, 0.10, f'dashed: straight line fit, {slope:.0f} Elo per level, R² = {r2:.3f}', transform=ax1.transAxes, ha='right', va='bottom', fontsize=9.5, color=INK2)
# Patricia marker at level 19
l19 = 19; r19 = rating[list(levels).index(l19)]
ax1.errorbar([l19], [r19], xerr=None, yerr=[[45], [45]], fmt='none', ecolor=INK, elinewidth=1.4, capsize=4, zorder=5)
ax1.scatter([l19], [r19], s=70, marker='D', color=SURF, edgecolor=INK, linewidth=1.8, zorder=6)
ax1.annotate('Patricia 5.1 Skill_Level 1\n(−12 ± 45 Elo vs level 19)', xy=(l19, r19), xytext=(8.3, 2900),
             fontsize=9.5, color=INK, ha='left', arrowprops=dict(arrowstyle='-', color=INK2, linewidth=1.0, shrinkA=2, shrinkB=8))
ax1.set_ylim(-150, rating.max() + 450)

# panel 2: gap per step
bar_x = levels[1:]; bar_y = gaps[1:]
ax2.axhspan(100, 200, color=BLUE, alpha=0.08, linewidth=0)
ax2.text(levels[-1] + 0.45, 197, 'target band\n100-200', fontsize=9, color=INK2, ha='left', va='top', linespacing=1.3)
ax2.bar(bar_x, bar_y, width=0.55, color=BLUE, zorder=3)
ax2.errorbar(bar_x, bar_y, yerr=1.96 * se[1:], fmt='none', ecolor=INK2, elinewidth=1.0, capsize=2.2, zorder=4)
ax2.axhline(g.mean(), color=GRAY, linewidth=1.6, linestyle=(0, (5, 4)), zorder=2)
ax2.text(levels[-1] + 0.45, g.mean() + 4, f'mean {g.mean():.0f}', fontsize=9, color=INK2, ha='left', va='bottom')
ax2.set_ylabel('Elo gained over previous level', fontsize=10.5)
ax2.set_xlabel('Skill_Level', fontsize=10.5)
ax2.set_xticks(range(1, 25, 1)); ax2.set_xlim(0.2, 26.4); ax2.set_ylim(0, 270)
ax2.tick_params(axis='x', labelsize=8.5)
fig.text(0.125, 0.025, f'Levels 0 and 25 excluded from testing. Bars: gap to the level below, whiskers 95% interval. Source: fastchess 2+0.02, saved results.', fontsize=8.5, color=INK2)
fig.savefig('skill_curve.png', facecolor=SURF, bbox_inches='tight', pad_inches=0.3)
print(json.dumps(stats, indent=1))
