#!/usr/bin/env python3
"""Adaptive skill ladder refinement.
Usage: refine.py <out_dir> <rounds> <tc> <concurrency> <seed_results_dir> rung1 rung2 ...
Rungs: 'random', 'full', or integer budgets (cp per 40 moves), strongest last.
Inserts the geometric midpoint where an adjacent gap > 200 Elo, drops a rung where
a gap < 100 Elo, measures missing pairs, until all gaps are within [100, 200]."""
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
def mid(a, b):
    if a == 'random' or b == 'full': return None
    ia, ib = int(a), int(b)
    m = ia // 2 if ib == 0 else int(round(math.sqrt(ia * ib)))
    return None if m in (ia, ib) or m < 1 else m
for it in range(80):
    changed = False
    for i in range(len(rungs) - 1):
        a, b = rungs[i], rungs[i + 1]
        g = gap(a, b)
        if g is None: measure(a, b); changed = True; break
        if g > 200:
            m = mid(a, b)
            if m is None: continue        # cannot be refined by budget alone; reported at the end
            print(f'insert {m} between {a} and {b} (gap {g:.0f})', flush=True)
            rungs.insert(i + 1, m); changed = True; break
        if g < 100:
            drop = i + 1 if b != 'full' else i
            if rungs[drop] in ('random', 'full'): continue
            print(f'drop {rungs[drop]} (gap {a}->{b} is {g:.0f})', flush=True)
            del rungs[drop]; changed = True; break
    save()
    if not changed: break
print('LADDER', [str(r) for r in rungs])
print('GAPS  ', [None if g is None else round(g) for g in [gap(a, b) for a, b in zip(rungs, rungs[1:])]])
