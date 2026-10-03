#!/usr/bin/env python3
"""Generic skill-level tournament. Usage: tourn.py FAMILY [--rounds R] [--window W] [--tc TC] [--only i:j ...] [--out DIR]"""
import argparse, json, os, re, subprocess, sys, time
FC = '/home/user/disservin/fastchess/fastchess'
BOOK = '/home/user/chess-engine-oge/tools/tuning/book.epd'
FAM = {
 'patricia': dict(levels=range(1, 22), cmd='/home/user/adam-kulju/patricia/engine/patricia', opt='Skill_Level', extra=['option.Hash=16']),
 'gaiachess': dict(levels=range(1, 21), cmd='/home/user/jromang/gaiachess/target/release/gaiachess', opt='Skill Level',
                   extra=['option.Hash=16', 'option.OwnBook=false', 'option.Ponder=false']),
 'stockfish': dict(levels=range(0, 21), cmd='/usr/games/stockfish', opt='Skill Level', extra=['option.Hash=16']),
}
def eng(f, l):
    F = FAM[f]
    return ['-engine', f'cmd={F["cmd"]}', f'name=L{l:02d}', f'option.{F["opt"]}={l}'] + F['extra']
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('family'); ap.add_argument('--rounds', type=int, default=20)
    ap.add_argument('--window', type=int, default=4); ap.add_argument('--tc', default='2+0.02')
    ap.add_argument('--concurrency', type=int, default=4); ap.add_argument('--only', nargs='*'); ap.add_argument('--out', default='.')
    a = ap.parse_args(); f = a.family; L = list(FAM[f]['levels']); n = len(L)
    out = f'{a.out}/{f}'; os.makedirs(out + '/work', exist_ok=True); os.makedirs(out + '/pairings', exist_ok=True)
    pairs = [(L[i], L[i + d]) for d in range(1, a.window + 1) for i in range(n) if i + d < n]
    if a.only: pairs = [tuple(map(int, s.split(':'))) for s in a.only]
    todo = [p for p in pairs if not os.path.exists(f'{out}/pairings/L{p[0]:02d}_L{p[1]:02d}.json')]
    t0 = time.time(); print(f'{f}: {len(pairs)-len(todo)}/{len(pairs)} done, {len(todo)} to run', flush=True)
    for k, (i, j) in enumerate(todo, 1):
        tag = f'L{i:02d}_L{j:02d}'; t1 = time.time()
        cmd = [FC] + eng(f, i) + eng(f, j) + ['-each', f'tc={a.tc}', 'timemargin=100',
            '-openings', f'file={BOOK}', 'format=epd', 'order=random', '-srand', str(20261002 + 100 * i + j),
            '-rounds', str(a.rounds), '-repeat', '-concurrency', str(a.concurrency), '-maxmoves', '250',
            '-resign', 'movecount=3', 'score=800', 'twosided=true', '-draw', 'movenumber=40', 'movecount=8', 'score=10',
            '-pgnout', f'file={out}/work/{tag}.pgn']
        p = subprocess.run(cmd, capture_output=True, text=True)
        o = p.stdout.split('Results of')[-1]
        g = re.search(r'Games: (\d+), Wins: (\d+), Losses: (\d+), Draws: (\d+)', o)
        pe = re.search(r'Ptnml\(0-2\): \[(\d+), (\d+), (\d+), (\d+), (\d+)\]', o)
        if not g: print('FAIL', tag, p.stdout[-500:], p.stderr[-500:], flush=True); continue
        pgn = open(f'{out}/work/{tag}.pgn').read()
        r = dict(a=i, b=j, games=int(g[1]), wins=int(g[2]), losses=int(g[3]), draws=int(g[4]),
                 pentanomial=[int(x) for x in pe.groups()] if pe else None, time_losses=pgn.count('loses on time'), seconds=round(time.time() - t1))
        json.dump(r, open(f'{out}/pairings/{tag}.json', 'w'))
        el = time.time() - t0
        print(f'[{k}/{len(todo)}] {tag}: +{r["wins"]} -{r["losses"]} ={r["draws"]} tl={r["time_losses"]} ({r["seconds"]}s, elapsed {el/60:.1f}m, eta {el/k*(len(todo)-k)/60:.0f}m)', flush=True)
    print('done', flush=True)
main()
