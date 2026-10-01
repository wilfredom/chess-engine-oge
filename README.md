# OGE

A single-file UCI chess engine in JavaScript (`engine.js`) with Chess960, MultiPV,
skill levels, and an offline web app (`index.html`) built on chessground.

## Run the app

Open `index.html` in a browser. For the engine to run in a background Web Worker
(recommended, keeps the board responsive) serve the folder over HTTP:

```sh
bun x serve .            # or: python3 -m http.server 8000
```

then open <http://localhost:8000/>. Opening the file directly (`file://`) also works
in Firefox and Safari; Chromium falls back to running the engine on the main thread.
Everything is local, no network is needed except for the "View on lichess" link.

## Run the engine (UCI)

```sh
bun engine.js            # UCI loop on stdin/stdout (Node 18+ also works)
bun engine.js bench      # OpenBench style benchmark, prints "<nodes> nodes <nps> nps"
```

UCI options: `Hash` (MB), `Threads` (accepted, always 1), `MultiPV` (1-5),
`Skill_Level` (0 = random moves that still mate in one, max = full strength),
`UCI_Chess960`. Extra debugging commands: `perft N`, `d`, `eval`.

## Tests

```sh
bun tools/perft.js                                   # move generator, standard + Chess960
pip install chess && python3 tools/movegen_diff.py 1 400 > /tmp/p.txt && bun tools/movegen_diff.js /tmp/p.txt
bun tools/tactics.js ./engine.js 1000                # tactical sanity check
fastchess --compliance ./engine.js                   # UCI compliance (https://github.com/Disservin/fastchess)
```

Skill-level tuning scripts live in `tools/tuning/` (see `COLOPHON.md` for how the
levels were calibrated).
