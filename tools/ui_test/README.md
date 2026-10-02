# Web app test

Playwright drives `index.html` through a human-vs-bot game, promotion, touch and phone layout,
rules (mate, stalemate, repetition), Chess960 (numbering, castling notation, lichess link),
bot vs bot, the file:// fallback and the review fixes.

```sh
npm install playwright                       # once; Chromium must be available to Playwright
python3 -m http.server 8123 --directory ../.. &   # from this directory
node test.mjs                                # PASS/FAIL lines, screenshots in ./shots
```

Environment: `URL` (default http://localhost:8123/index.html), `REPO` (default the repository
root), `SKIP_BVB=1`, `SKIP_FILE=1`, `ONLY_FIXES=1`, `HEADED=1`.
