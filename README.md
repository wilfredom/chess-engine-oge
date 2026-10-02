# OGE

A single-file UCI chess engine in JavaScript (`engine.js`) with Chess960, MultiPV,
calibrated skill levels, and an offline web app (`index.html`) built on chessground.

## Run the app

Serve the folder over HTTP and open it in a browser (phone or desktop):

```sh
python3 -m http.server 8000        # or: bun x serve .
```

then open <http://localhost:8000/>. Opening `index.html` directly from disk also works:
Firefox and Safari run the engine in a Web Worker, Chromium falls back to running it on
the main thread. Nothing is fetched from the network; only the "View on lichess" link
needs internet.

The app offers Human vs Bot and Bot vs Bot, a strength selector per bot, Standard or
Chess960 (with a start-position number or a random one), the move list with a lichess
analysis link at any point, elapsed time per side, and the pieces each side has captured.

## Run the engine (UCI)

```sh
bun engine.js            # UCI loop on stdin/stdout (Node 18+ also works: node engine.js)
bun engine.js bench      # OpenBench style benchmark, prints "<nodes> nodes <nps> nps"
```

UCI options: `Hash` (MB), `Threads` (accepted, always 1), `MultiPV` (1-5),
`Skill_Level` (0 = random moves that still mate in one, the maximum = full strength, see
`uci` for the range), `UCI_Chess960`. Debug commands: `perft N`, `d`, `eval`.

## Tests and tools

```sh
bun tools/perft.js                                   # move generator: standard + Chess960
pip install chess && python3 tools/movegen_diff.py 1 400 > /tmp/p.txt && bun tools/movegen_diff.js /tmp/p.txt
bun tools/tactics.js ./engine.js 1000                # tactical sanity check
fastchess --compliance ./engine.js                   # UCI compliance (https://github.com/Disservin/fastchess)
```

`tools/ui_test/` holds the Playwright test of the web app, `tools/tuning/` the fastchess
scripts that calibrated the skill levels. `COLOPHON.md` describes how the levels were
calibrated and what they measured.
