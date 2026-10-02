# Skill tuning status

Final design (engine.js S8): the normal search runs with 70% of the move time; the next four root
moves are then searched two plies shallower in a bounded extra slice; other legal moves get a
depth-capped quiescence estimate (mate in one and stalemate recognised) floored at
max(worst searched loss, 20 cp). Any loss is capped at 2000 cp. Each move adds budget/40 to the
mover's accumulator (capped at the budget, one per colour); a move is picked uniformly among the
affordable ones. Mate in one is always played. With an unlimited budget this equals the random
mover of level 0 (measured: -5 +/- 40 Elo over 200 games).

Pipeline (all at 2+0.02 unless noted, 4 games concurrently, book.epd openings, resign/draw
adjudication, timemargin 100):
1. refine.py: adaptive ladder, 100 games per adjacent pair, insert geometric midpoints above
   220 Elo, drop rungs below 80 Elo, never re-insert a dropped budget.
2. final_pass.py: 200 fresh games per adjacent pair, pentanomial Elo with 95% CI.
3. sprt.py: Patricia 5.1 Skill_Level 1 vs engine level 1, SPRT elo0=100 elo1=200 (logistic).
4. spot_checks.py: 30 games at 60+0.6 for the bottom pair, the pair nearest Patricia level 1,
   the top pair, and Patricia 1 vs level 1.

Strong-region rungs (budgets below 2000, unaffected by the last estimator changes):
1414, 1000, 707, 531, 297, 193, 125, 30, full. Weak region is being re-refined from
32000 down to 2000. Results land in the scratch tuning directory and are summarised in COLOPHON.md.
