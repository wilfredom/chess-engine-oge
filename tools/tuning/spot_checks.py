#!/usr/bin/env python3
"""60+0.6 spot checks: bottom pair, the pair nearest Patricia level 1, the top pair, and Patricia-1 vs level 1.
Usage: spot_checks.py <out_dir> <rounds> <concurrency> <ladder.json>"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ladder import run_match
out_dir, rounds, conc, ladder = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), json.load(open(sys.argv[4]))['rungs']
budgets = [int(r) for r in ladder if r not in ('random', 'full')]
near = min(budgets, key=lambda b: abs(b - 700))          # Patricia level 1 measured between budgets 1000 and 500
i = ladder.index(str(near))
pairs = [(ladder[0], ladder[1]), (ladder[i], ladder[i + 1]), (ladder[-2], ladder[-1]), ('pat1', ladder[1])]
os.makedirs(out_dir, exist_ok=True)
results = []
for a, b in pairs:
    results.append(run_match(out_dir, a, b, rounds, '60+0.6', conc))
    json.dump(results, open(f'{out_dir}/results.json', 'w'), indent=1)
print('done')
