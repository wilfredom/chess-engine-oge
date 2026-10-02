#!/usr/bin/env python3
"""Adaptive skill ladder refinement.
Usage: refine.py <out_dir> <rounds> <tc> <concurrency> <seed_results_dir> rung1 rung2 ...
Rungs: 'random', 'full', or integer budgets (cp per 40 moves), strongest last.
Inserts the geometric midpoint where an adjacent gap > 220 Elo, drops a rung where
a gap < 80 Elo (hysteresis against 100-game noise), measures missing pairs, and never
re-inserts a budget it has dropped, until every gap is within range or cannot be refined."""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ladder import run_match
out_dir, rounds, tc, conc, seed_dir = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), sys.argv[5]
rungs = [r if r in ('random', 'full') else int(r) for r in sys.argv[6:]]
os.makedirs(out_dir, exist_ok=True)
measured = {}
def load(d):
    p = os.path.join(d, 'results.json')
    if os.path.exists(p):
        for r in json.load(open(p)): measured[(str(r['a']), str(r['b']))] = r
load(seed_dir); load(out_dir)
def save():
    json.dump(list(measured.values()), open(os.path.join(out_dir, 'results.json'), 'w'), indent=1)
    json.dump({'rungs': [str(r) for r in rungs], 'gaps': [gap(a, b) for a, b in zip(rungs, rungs[1:])]}, open(os.path.join(out_dir, 'ladder.json'), 'w'), indent=1)
def gap(a, b):
    r = measured.get((str(a), str(b)))
    if r is None: return None
    e = str(r['elo'])
    if 'inf' in e or 'nan' in e:
        return 800.0 if r['score_pct'] < 50 else -800.0
    return -float(e)                      # elo is A relative to B; gap is how much stronger B is
def measure(a, b):
    r = run_match(out_dir, str(a), str(b), rounds, tc, conc)
    measured[(str(a), str(b))] = r; save()
dropped = set()
RANDOM_EQUIVALENT_BUDGET = 32000      # an unlimited budget plays like the random mover (measured)
def mid(a, b):
    if b == 'full': return None
    ia, ib = (RANDOM_EQUIVALENT_BUDGET if a == 'random' else int(a)), int(b)
    if a == 'random' and ib >= ia: return None
    for frac in (0.5, 0.33, 0.67, 0.25, 0.75):      # geometric interpolation, skipping dropped budgets
        m = int(round(ia * (1 - frac))) if ib == 0 else int(round(math.exp(math.log(ia) * (1 - frac) + math.log(ib) * frac)))
        if m not in (ia, ib) and m >= 1 and m not in dropped: return m
    return None
for it in range(80):
    changed = False
    for i in range(len(rungs) - 1):
        a, b = rungs[i], rungs[i + 1]
        g = gap(a, b)
        if g is None: measure(a, b); changed = True; break
        if g > 220:
            m = mid(a, b)
            if m is None: continue        # cannot be refined by budget alone; reported at the end
            print(f'insert {m} between {a} and {b} (gap {g:.0f})', flush=True)
            rungs.insert(i + 1, m); changed = True; break
        if g < 80:
            drop = i + 1 if b != 'full' else i
            if rungs[drop] in ('random', 'full'): continue
            print(f'drop {rungs[drop]} (gap {a}->{b} is {g:.0f})', flush=True)
            dropped.add(rungs[drop]); del rungs[drop]; changed = True; break
    save()
    if not changed: break
print('LADDER', [str(r) for r in rungs])
print('GAPS  ', [None if g is None else round(g) for g in [gap(a, b) for a, b in zip(rungs, rungs[1:])]])
