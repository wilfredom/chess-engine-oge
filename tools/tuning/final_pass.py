#!/usr/bin/env python3
"""Final verification pass: play every adjacent pair of the ladder again and combine
with earlier results (pentanomial Elo with 95% confidence interval).
Usage: final_pass.py <out_dir> <rounds> <tc> <concurrency> <ladder.json> <prev_results_dir> [...more dirs]
With rounds=0 only combines existing results."""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ladder import run_match

def pentanomial_elo(p):
    n = sum(p)
    if n == 0: return None
    scores = [0, 0.25, 0.5, 0.75, 1.0]
    mean = sum(c * s for c, s in zip(p, scores)) / n
    var = sum(c * (s - mean) ** 2 for c, s in zip(p, scores)) / n
    se = math.sqrt(var / n) if n > 1 else 0.5
    def elo(x):
        x = min(max(x, 1e-6), 1 - 1e-6)
        return -400 * math.log10(1 / x - 1)
    return {'score': mean, 'elo': elo(mean), 'lo': elo(mean - 1.96 * se), 'hi': elo(mean + 1.96 * se), 'pairs': n}

def load_all(dirs):
    rows = []
    for d in dirs:
        p = os.path.join(d, 'results.json')
        if os.path.exists(p): rows += json.load(open(p))
    return rows

if __name__ == '__main__':
    out_dir, rounds, tc, conc, ladder_path = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), sys.argv[5]
    prev_dirs = sys.argv[6:]
    rungs = json.load(open(ladder_path))['rungs']
    os.makedirs(out_dir, exist_ok=True)
    new = []
    if rounds > 0:
        for a, b in zip(rungs, rungs[1:]):
            new.append(run_match(out_dir, a, b, rounds, tc, conc))
            json.dump(new, open(os.path.join(out_dir, 'results.json'), 'w'), indent=1)
    rows = load_all(prev_dirs + [out_dir])
    report = []
    for a, b in zip(rungs, rungs[1:]):
        pent = [0] * 5; games = 0; forfeits = 0
        for r in rows:
            if str(r['a']) == str(a) and str(r['b']) == str(b) and r.get('pentanomial'):
                pent = [x + y for x, y in zip(pent, r['pentanomial'])]; games += r['games']; forfeits += r.get('time_losses', 0) or 0
        e = pentanomial_elo(pent)
        # e is A's score; the gap is how much stronger B is than A
        gap = None if e is None else {'gap': -e['elo'], 'lo': -e['hi'], 'hi': -e['lo'], 'games': games, 'pentanomial': pent, 'forfeits': forfeits}
        report.append({'weaker': str(a), 'stronger': str(b), **(gap or {})})
        if gap: print(f"{str(a):>7} -> {str(b):<6} gap {gap['gap']:7.1f}  95% CI [{gap['lo']:6.1f}, {gap['hi']:6.1f}]  games {games}  pent {pent}  forfeits {forfeits}")
    json.dump(report, open(os.path.join(out_dir, 'report.json'), 'w'), indent=1)
