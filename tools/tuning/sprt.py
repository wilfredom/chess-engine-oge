#!/usr/bin/env python3
"""SPRT between two rungs (same rung syntax as ladder.py) with fastchess.
Usage: sprt.py <out_dir> <tc> <concurrency> <elo0> <elo1> <rungA> <rungB> [max_rounds]
Elo bounds are classical (logistic) Elo of A relative to B."""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from ladder import FC, BOOK, engine_args

def run_sprt(out_dir, tc, conc, elo0, elo1, a, b, max_rounds=2000):
    os.makedirs(out_dir, exist_ok=True)
    tag = f'sprt_{a}_vs_{b}'
    cmd = [FC] + engine_args(out_dir, a, f'A_{a}') + engine_args(out_dir, b, f'B_{b}') + [
        '-each', f'tc={tc}', 'timemargin=100', 'option.Hash=16', '-openings', f'file={BOOK}', 'format=epd', 'order=random',
        '-sprt', f'elo0={elo0}', f'elo1={elo1}', 'alpha=0.05', 'beta=0.05', 'model=logistic',
        '-rounds', str(max_rounds), '-repeat', '-concurrency', str(conc), '-maxmoves', '250',
        '-draw', 'movenumber=40', 'movecount=8', 'score=10',
        '-resign', 'movecount=3', 'score=800', 'twosided=true',
        '-pgnout', f'file={out_dir}/{tag}.pgn', '-log', f'file={out_dir}/{tag}.log', 'level=warn']
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    out = p.stdout
    open(f'{out_dir}/{tag}.txt', 'w').write(out + '\n--- stderr ---\n' + p.stderr)
    blocks = out.split('Results of')
    last = blocks[-1] if len(blocks) > 1 else out
    m = re.search(r'Elo: (\S+) \+/- (\S+)', last)
    g = re.search(r'Games: (\d+), Wins: (\d+), Losses: (\d+), Draws: (\d+), Points: ([\d.]+) \(([\d.]+) %\)', last)
    l = re.search(r'LLR: (\S+) \((\S+), (\S+)\) \[(\S+), (\S+)\]', last)
    res = {'a': a, 'b': b, 'tc': tc, 'elo0': elo0, 'elo1': elo1, 'elo': m.group(1) if m else None, 'err': m.group(2) if m else None,
           'games': int(g.group(1)) if g else 0, 'wins': int(g.group(2)) if g else 0, 'losses': int(g.group(3)) if g else 0,
           'draws': int(g.group(4)) if g else 0, 'llr': l.group(1) if l else None, 'llr_bounds': [l.group(2), l.group(3)] if l else None,
           'passed_h1': ('H1 was accepted' in out) or (l is not None and float(l.group(1)) >= float(l.group(3))),
           'passed_h0': ('H0 was accepted' in out) or (l is not None and float(l.group(1)) <= float(l.group(2))),
           'seconds': round(time.time() - t0)}
    print(json.dumps(res), flush=True)
    return res

if __name__ == '__main__':
    out_dir, tc, conc, elo0, elo1, a, b = sys.argv[1:8]
    max_rounds = int(sys.argv[8]) if len(sys.argv) > 8 else 2000
    run_sprt(out_dir, tc, int(conc), float(elo0), float(elo1), a, b, max_rounds)
