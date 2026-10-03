# Skill-level curves: Patricia 5.1, Gaia 4.3.2, Stockfish 16

Each level plays the levels up to 3 above it: 40 games per pairing at 2+0.02, openings from `../book.epd`, fastchess 60d7a7a,
4 concurrent games. `fit.py` fits one Bradley-Terry Elo per level (lowest level = 0) with a bootstrap 95% interval.
Elo scales are relative within each engine; they do not compare engines to each other.

| Engine | Levels | Elo/level | R² | Shape |
|---|---|---|---|---|
| Gaia 4.3.2 | 1-20 | 177 | 0.989 | near-linear; 1-19 alone: 171, R² 0.997; level 20 (full strength) jumps ~700 |
| Patricia 5.1 | 1-21 | 116 | 0.925 | convex: 0-130 Elo/level up to 14, 230-340 from 18 up |
| Stockfish 16 | 0-20 | 75 | 0.876 | ~130 Elo/level to 6, flat 12-19, level 20 jumps ~500 |

Caveats: Patricia's last 16 pairings ran after a container restart (binary rebuilt, possibly a different CPU). Gaia ran with
`OwnBook=false`, `Ponder=false`. Stockfish is the Debian 16 package. Stockfish's plateau was not tested at a slower time control.

Run: `python3 tourn.py patricia --rounds 20 --window 3 --out ./res && python3 fit.py patricia` (engine paths are hardcoded at the top of `tourn.py`).
