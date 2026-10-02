# Skill tuning status

Policy (final design): main search at full depth (70% of the normal soft time), then the next four root moves are searched two plies shallower; a move is picked uniformly at random among those whose loss fits the accumulated budget (budget/40 per move, capped at the budget). Unsearched moves get a quiescence estimate floored at max(worst searched loss, 20 cp).

Coarse ladder at 2+0.02, 100 games per adjacent pair (Elo of A relative to B):

```
 random vs 32000  elo  -186.25 +/-   77.68  score 25.5%
  32000 vs 8000   elo  -603.86 +/-     nan  score 3.0%
   8000 vs 2000   elo     -inf +/-    -nan  score 0.0%
   2000 vs 500    elo  -401.92 +/-  151.37  score 9.0%
    500 vs 125    elo  -346.12 +/-  115.70  score 12.0%
    125 vs 30     elo  -151.35 +/-   58.34  score 29.5%
     30 vs 0      elo   -20.87 +/-   55.70  score 47.0%
      0 vs full   elo   -81.37 +/-   48.28  score 38.5%
```

Next: tools/tuning/refine.py inserts/drops budgets until every adjacent gap is within [100, 200] Elo, then final_pass.py re-measures every adjacent pair (200 games combined) and sprt.py checks Patricia Skill_Level 1 vs level 1 (elo0=100, elo1=200, logistic). Spot checks at 60+0.6 follow.
