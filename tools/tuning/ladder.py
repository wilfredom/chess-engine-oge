#!/usr/bin/env python3
"""Calibration ladder: play adjacent budgets against each other with fastchess.
Usage: ladder.py <out_dir> <rounds> <tc> <concurrency> budget1 budget2 ...
Budgets: 'random' (Skill_Level 0), 'full' (max level), or an integer cp/40 moves.
Writes <out_dir>/results.json with one entry per adjacent pair."""
import json, os, re, subprocess, sys, time
ENGINE = os.environ.get('OGE_ENGINE', os.path.join(os.path.dirname(__file__), '..', '..', 'engine.js'))
FC = os.environ.get('FASTCHESS', 'fastchess')
BOOK = os.environ.get('OGE_BOOK', os.path.join(os.path.dirname(__file__), 'book.epd'))
PAT = os.environ.get('PATRICIA', 'patricia')

def variant(out_dir, budget):
    """Engine copy whose level 1 has the given budget (level 2 = full strength)."""
    src = open(ENGINE).read()
    new = re.sub(r"const SKILL_BUDGET_PER_40_MOVES = \[.*?\];",
                 f"const SKILL_BUDGET_PER_40_MOVES = [Infinity, {budget}, 0];", src, flags=re.S)
    assert new != src
    path = os.path.join(out_dir, f'oge_b{budget}.js')
    open(path, 'w').write(new); os.chmod(path, 0o755)
    return path

def engine_args(out_dir, spec, name):
    if spec == 'random':  return ['-engine', f'cmd={ENGINE}', f'name={name}', 'option.Skill_Level=0']
    if spec == 'full':    return ['-engine', f'cmd={ENGINE}', f'name={name}']
    if str(spec).startswith('pat'):   # Patricia at a skill level, e.g. pat1
        return ['-engine', f'cmd={PAT}', f'name={name}', f'option.Skill_Level={spec[3:]}']
    return ['-engine', f'cmd={variant(out_dir, int(spec))}', f'name={name}', 'option.Skill_Level=1']

def run_match(out_dir, a, b, rounds, tc, conc, extra=()):
    tag = f'{a}_vs_{b}'
    cmd = [FC] + engine_args(out_dir, a, f'A_{a}') + engine_args(out_dir, b, f'B_{b}') + [
        '-each', f'tc={tc}', 'timemargin=100', 'option.Hash=16', '-openings', f'file={BOOK}', 'format=epd', 'order=random',
        '-rounds', str(rounds), '-repeat', '-concurrency', str(conc), '-maxmoves', '250',
        '-draw', 'movenumber=40', 'movecount=8', 'score=10',
        '-resign', 'movecount=3', 'score=800', 'twosided=true',
        '-pgnout', f'file={out_dir}/{tag}.pgn', '-log', f'file={out_dir}/{tag}.log', 'level=warn'] + list(extra)
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    out = p.stdout
    open(f'{out_dir}/{tag}.txt', 'w').write(out + '\n--- stderr ---\n' + p.stderr)
    out = out.split('Results of')[-1]      # the final report, not an interim one
    m = re.search(r'Elo: (\S+) \+/- (\S+), nElo: (\S+) \+/- (\S+)', out)
    g = re.search(r'Games: (\d+), Wins: (\d+), Losses: (\d+), Draws: (\d+), Points: ([\d.]+) \(([\d.]+) %\)', out)
    pent = re.search(r'Ptnml\(0-2\): \[(\d+), (\d+), (\d+), (\d+), (\d+)\]', out)
    timeouts = out.count('loses on time') + open(f'{out_dir}/{tag}.pgn').read().count('on time') if os.path.exists(f'{out_dir}/{tag}.pgn') else 0
    res = {'a': a, 'b': b, 'elo': m.group(1) if m else None, 'err': m.group(2) if m else None,
           'games': int(g.group(1)) if g else 0, 'wins': int(g.group(2)) if g else 0, 'losses': int(g.group(3)) if g else 0,
           'draws': int(g.group(4)) if g else 0, 'score_pct': float(g.group(6)) if g else None,
           'pentanomial': [int(x) for x in pent.groups()] if pent else None, 'time_losses': timeouts, 'seconds': round(time.time() - t0)}
    print(json.dumps(res), flush=True)
    return res

if __name__ == '__main__':
    out_dir, rounds, tc, conc = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
    rungs = sys.argv[5:]
    os.makedirs(out_dir, exist_ok=True)
    results = []
    for a, b in zip(rungs, rungs[1:]):
        results.append(run_match(out_dir, a, b, rounds, tc, conc))
        json.dump(results, open(f'{out_dir}/results.json', 'w'), indent=1)
    print('done')
