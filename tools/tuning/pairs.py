#!/usr/bin/env python3
"""Run specific matches: pairs.py <out_dir> <rounds> <tc> <concurrency> A:B [A:B ...]"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ladder import run_match
out_dir, rounds, tc, conc = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
os.makedirs(out_dir, exist_ok=True)
results = []
for pair in sys.argv[5:]:
    a, b = pair.split(':')
    results.append(run_match(out_dir, a, b, rounds, tc, conc))
    json.dump(results, open(f'{out_dir}/results.json', 'w'), indent=1)
print('done')
