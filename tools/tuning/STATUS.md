# Skill tuning status (auto-generated 2026-10-01T23:06Z)

Calibration ladder at 2+0.02, 160 games per adjacent pair (budget = cp per 40 moves; 'random' = Skill_Level 0, 'full' = max level). Elo is A relative to B:

```
 random vs 64000  elo   414.20 +/-   98.76  games 160  score 91.56%
  64000 vs 32000  elo  -636.43 +/-  251.07  games 160  score 2.5%
  32000 vs 16000  elo     -inf +/-    -nan  games 160  score 0.0%
  16000 vs 8000   elo  -759.05 +/-     nan  games 160  score 1.25%
   8000 vs 4000   elo  -687.51 +/-     nan  games 160  score 1.88%
   4000 vs 2000   elo  -687.51 +/-     nan  games 160  score 1.88%
   2000 vs 1000   elo  -511.50 +/-  142.94  games 160  score 5.0%
   1000 vs 500    elo  -579.43 +/-  171.70  games 160  score 3.44%
    500 vs 250    elo  -292.96 +/-   77.27  games 160  score 15.62%
    250 vs 125    elo  -134.45 +/-   61.10  games 160  score 31.56%
```

Plan: place the random mover on the curve (random vs 2000/1000/500), pick budgets at ~150 Elo spacing from the curve, verify adjacent pairs with 200-game matches, SPRT Patricia Skill_Level 1 vs engine level 1 (elo0=100 elo1=200 logistic), spot-check 2-3 pairs plus the Patricia pair at 60+0.6. Scripts: ladder.py, pairs.py, sprt.py (set OGE_ENGINE, FASTCHESS, PATRICIA, OGE_BOOK env vars).
