# Skill tuning

The calibration is complete; the method, the measured gaps and the Patricia comparison are in
`../../COLOPHON.md`. The scripts here reproduce it:

- `gen_book.js`: balanced opening book (`book.epd`).
- `ladder.py` / `pairs.py`: fastchess matches between budgets (`random`, `full`, `patN`, or an
  integer budget) using engine variants whose level 1 carries the given budget.
- `refine.py`: adaptive ladder refinement (insert above 220 Elo, drop below 80 Elo).
- `final_pass.py`: 200-game verification per adjacent pair with pentanomial Elo and 95% CI.
- `sprt.py`: SPRT, used for Patricia Skill_Level 1 vs engine level 1.
- `spot_checks.py`: 60+0.6 spot checks.

Environment variables: `OGE_ENGINE`, `FASTCHESS`, `PATRICIA`, `OGE_BOOK`.
