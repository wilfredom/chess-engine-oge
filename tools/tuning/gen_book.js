// Build an opening book of balanced positions: 8 plies of moves drawn from the
// engine's top-5 (within 50 cp of the best) at depth 7. Writes EPD lines.
const OGE = require(process.env.OGE_ENGINE || "../../engine.js");
const fs = require('fs');
const N = parseInt(process.argv[2] || '600', 10), PLIES = 8;
const pos = new OGE.Position();
const tt = new OGE.TranspositionTable(16);
const search = new OGE.Search(pos, tt, () => {});
search.silent = true;
const seen = new Set(), out = [];
(async () => {
  let attempts = 0;
  while (out.length < N && attempts < N * 3) {
    attempts++;
    pos.setFen(OGE.START_FEN); tt.clear(); search.clearHistory();
    let ok = true;
    for (let p = 0; p < PLIES; p++) {
      const r = await search.iterativeDeepening({ depth: 7, multiPV: 5 });
      if (!r.moves.length) { ok = false; break; }
      const good = r.moves.filter((m, i) => r.scores[0] - r.scores[i] <= 50);
      const m = good[Math.floor(Math.random() * good.length)];
      pos.make(m);
    }
    if (!ok) continue;
    const r = await search.iterativeDeepening({ depth: 8, multiPV: 1 });
    if (Math.abs(r.scores[0]) > 80) continue;           // keep it balanced
    const fen = pos.fen().split(' ').slice(0, 4).join(' ');
    if (seen.has(fen)) continue;
    seen.add(fen); out.push(fen + ' 0 1');
  }
  fs.writeFileSync(process.argv[3] || 'book.epd', out.join('\n') + '\n');
  console.log(`wrote ${out.length} openings (${attempts} attempts)`);
})();
