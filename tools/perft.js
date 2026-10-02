// Perft suite: standard positions (classic reference values) and Chess960
// positions (values cross-checked with python-chess). Run: bun tools/perft.js
const OGE = require('../engine.js');
const CASES = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281, 4865609], false],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862, 4085603], false],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238, 674624], false],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333], false],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379, 2103487], false],
  ['r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890, 3894594], false],
  ['bqnb1rkr/pp3ppp/3ppn2/2R5/5P2/2P1Q3/PP3PPP/BQNBR1KR w HFhf - 2 9', [52, 1263, 64689], true],
  ['b1q1rrkb/pppppppp/3nn3/8/P7/1PPP4/4PPPP/BQNNRKRB w GE - 1 9', [20, 479, 10471], true],
  ['qbbnnrkr/2pp2pp/p7/1p2pp2/8/P3PP2/1PP3PP/QBBNNRKR w HFhf - 0 9', [19, 505, 10953], true],
  ['1nbbnrkr/p1p1ppp1/3p4/1p3P1p/3Pq2P/8/PPP1P1PP/QNBBNRKR w HFhf - 0 9', [26, 1040, 26730], true],
  ['qnbnr1kr/ppp1b1pp/4p3/3p1p2/3P4/P7/1PP1PPPP/QNB1RBKR w HEhe - 0 9', [22, 658, 15560], true],
  ['nrbbqkrn/pppppppp/8/8/8/8/PPPPPPPP/NRBBQKRN w KQkq - 0 1', [19, 361, 7737], true],
  ['r1k1r3/8/8/8/8/8/8/R3K1R1 w KQkq - 0 1', [4, 100, 2154], true],
  ['1r1k1r2/8/8/8/8/8/8/2R1K1R1 w KQkq - 0 1', [23, 448, 10273], true],
  ['2rk1r2/8/8/8/8/8/8/R2K1R2 w FAfc - 0 1', [22, 469, 10248], true],
  ['4k3/8/8/8/8/8/8/1R2K2R w KQ - 0 1', [26, 112, 3171], true],
  ['1rk3r1/8/8/8/8/8/8/1RK3R1 w KQkq - 0 1', [23, 442, 9940], true],
  ['qrkbbnnr/pppppppp/8/8/8/8/PPPPPPPP/QRKBBNNR w KQkq - 0 1', [20, 400, 8882], true],
];
let fail = 0, total = 0; const t0 = performance.now();
for (const [fen, expected, c960] of CASES) {
  const pos = new OGE.Position(); pos.chess960 = c960; pos.setFen(fen);
  for (let d = 1; d <= expected.length; d++) {
    const n = OGE.perft(pos, d); total += n;
    if (n !== expected[d - 1]) { fail++; console.log(`FAIL ${fen} depth ${d}: got ${n}, want ${expected[d - 1]}`); }
  }
  const lo = pos.hashLo, hi = pos.hashHi; pos.computeHash();
  if (lo !== pos.hashLo || hi !== pos.hashHi) { fail++; console.log(`FAIL hash drift ${fen}`); }
}
const s = (performance.now() - t0) / 1000;
console.log(`${CASES.length} positions, ${total} nodes, ${s.toFixed(2)}s, ${(total / s / 1e6).toFixed(2)} Mnps: ${fail ? fail + ' FAILURES' : 'all passed'}`);
process.exit(fail ? 1 : 0);
