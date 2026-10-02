#!/usr/bin/env python3
"""Round-robin tournament over Skill_Levels 1..24 (levels 0 and 25 excluded), pairs with |i-j| <= WINDOW.
One fastchess call per pairing; each result is written to tournament/pairings/Lii_Ljj.json at once,
so a rerun skips finished pairings and resumes where it stopped.
Usage: tournament.py [--rounds 30] [--tc 2+0.02] [--concurrency N] [--work DIR] [--only i:j ...]
Environment: FASTCHESS (default 'fastchess'), OGE_ENGINE, OGE_BOOK."""
import argparse, json, os, re, shutil, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.abspath(os.environ.get('OGE_ENGINE', os.path.join(HERE, '..', '..', 'engine.js')))
FC = os.environ.get('FASTCHESS', 'fastchess')
BOOK = os.environ.get('OGE_BOOK', os.path.join(HERE, 'book.epd'))
OUT = os.path.join(HERE, 'tournament', 'pairings')
LEVELS, WINDOW, SEED = range(1, 25), 6, 20261002

def pairings():
    """Closest pairs first, so a partial run already connects every level."""
    return [(i, i + d) for d in range(1, WINDOW + 1) for i in LEVELS if i + d in LEVELS]

def path(i, j): return os.path.join(OUT, f'L{i:02d}_L{j:02d}.json')

def stray():
    out = subprocess.run(['pgrep', '-x', 'fastchess'], capture_output=True, text=True).stdout.split()
    return [p for p in out if p != str(os.getpid())]

def engine(level):
    return ['-engine', 'cmd=bun', f'args={ENGINE}', f'name=L{level:02d}', f'option.Skill_Level={level}']

def play(i, j, a):
    tag = f'L{i:02d}_L{j:02d}'
    cmd = [FC] + engine(i) + engine(j) + [
        '-each', f'tc={a.tc}', 'timemargin=100', 'option.Hash=16',
        '-openings', f'file={BOOK}', 'format=epd', 'order=random', '-srand', str(SEED + 100 * i + j),
        '-rounds', str(a.rounds), '-repeat', '-concurrency', str(a.concurrency), '-maxmoves', '250',
        '-resign', 'movecount=3', 'score=800', 'twosided=true',
        '-draw', 'movenumber=40', 'movecount=8', 'score=10',
        '-pgnout', f'file={a.work}/{tag}.pgn', '-log', f'file={a.work}/{tag}.log', 'level=warn']
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    open(f'{a.work}/{tag}.txt', 'w').write(p.stdout + '\n--- stderr ---\n' + p.stderr)
    out = p.stdout.split('Results of')[-1]
    g = re.search(r'Games: (\d+), Wins: (\d+), Losses: (\d+), Draws: (\d+)', out)
    pent = re.search(r'Ptnml\(0-2\): \[(\d+), (\d+), (\d+), (\d+), (\d+)\]', out)
    if not g: raise RuntimeError(f'{tag}: no result parsed; see {a.work}/{tag}.txt')
    pgn = open(f'{a.work}/{tag}.pgn').read() if os.path.exists(f'{a.work}/{tag}.pgn') else ''
    res = {'a': i, 'b': j, 'games': int(g[1]), 'wins': int(g[2]), 'losses': int(g[3]), 'draws': int(g[4]),
           # wins/losses are from A's (the lower level's) point of view; pentanomial likewise (0 = both lost, 4 = both won)
           'pentanomial': [int(x) for x in pent.groups()] if pent else None,
           'time_losses': pgn.count('loses on time'), 'seconds': round(time.time() - t0)}
    json.dump(res, open(path(i, j), 'w'))
    return res

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--rounds', type=int, default=30)
    ap.add_argument('--tc', default='2+0.02')
    ap.add_argument('--concurrency', type=int, default=os.cpu_count())
    ap.add_argument('--work', default=os.path.join(HERE, 'tournament', 'work'))
    ap.add_argument('--only', nargs='*', help='run only these pairings, e.g. 1:2 3:5')
    a = ap.parse_args()
    if stray(): sys.exit(f'fastchess already running: pids {stray()}')
    os.makedirs(OUT, exist_ok=True); os.makedirs(a.work, exist_ok=True)
    todo = pairings()
    if a.only: todo = [tuple(map(int, s.split(':'))) for s in a.only]
    todo = [p for p in todo if not os.path.exists(path(*p))]
    t0 = time.time()
    print(f'{len(pairings()) - len(todo)} of {len(pairings())} done, {len(todo)} to run', flush=True)
    for n, (i, j) in enumerate(todo, 1):
        r = play(i, j, a)
        el = time.time() - t0
        print(f'[{n}/{len(todo)}] L{i:02d} v L{j:02d}: +{r["wins"]} -{r["losses"]} ={r["draws"]} '
              f'({r["seconds"]}s, elapsed {el/60:.1f}m, eta {el/n*(len(todo)-n)/60:.0f}m)', flush=True)
    print('done', flush=True)
