// Tactical sanity test. Run: bun tools/tactics.js ./engine.js 1000
const { spawn } = require('child_process');
const TESTS = [
  ['r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'h5f7'],
  ['6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'd1d8'],
  ['2rr3k/pp3pp1/1nnqbN1p/3pN3/2pPp3/2P5/PPB4P/R2Q1RK1 w - - 0 1', 'd1g4'],
  ['8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1', 'b3b2'],
  ['5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - 0 1', 'e3g3'],
  ['r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1', 'h6h7'],
  ['5k2/6pp/p1qN4/1p1p4/3P4/2PKP2Q/PP3r2/3R4 b - - 0 1', 'c6c4'],
  ['7k/p7/1R5K/6r1/6p1/6P1/8/8 w - - 0 1', 'b6b7'],
  ['rnbqkb1r/pppp1ppp/8/4P3/6n1/7P/PPPNPPP1/R1BQKBNR b KQkq - 0 1', 'g4e3'],
  ['r4q1k/p2bR1rp/2p2Q1N/5p2/5p2/2P5/PP3PPP/R5K1 w - - 0 1', 'e7f7'],
  ['3q1rk1/p4pp1/2pb3p/3p4/6Pr/1PNQ4/P1PB1PP1/4RRK1 b - - 0 1', 'd6h2'],
  ['2br2k1/2q3rn/p2NppQ1/2p1P3/Pb5R/4P3/1B3P1P/6K1 w - - 0 1', 'h4h7'],
  ['r1b1kb1r/3q1ppp/pBp1pn2/8/Np3P2/5B2/PPP3PP/R2N1R1K w kq - 0 1', 'f3c6'],
  ['4k1r1/2p3r1/1pR1p3/3pP2p/3P2qP/P4N2/1PQ4P/5R1K b - - 0 1', 'g4f3'],
  ['r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6', null], // sanity: any legal
  ['kbK5/pp6/1P6/8/8/8/8/R7 w - - 0 1', 'a1a6'],  // mate in 2 (Ra6!)
  ['r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 0', 'e5f7'], // Nxf7 mate in 2? (Nf6+ also) accept either
];
const engine = process.argv[2], movetime = parseInt(process.argv[3] || '1000', 10);
(async () => {
  let solved = 0;
  for (const [fen, bm] of TESTS) {
    const p = spawn(engine, []);
    let out = '', depthLine = '';
    p.stdout.on('data', d => { out += d; });
    p.stdin.write(`uci\nisready\nposition fen ${fen}\ngo movetime ${movetime}\n`);
    await new Promise(r => { const iv = setInterval(() => { if (out.includes('bestmove')) { clearInterval(iv); r(); } }, 20); });
    p.stdin.write('quit\n');
    const best = out.match(/bestmove (\S+)/)[1];
    const lines = out.trim().split('\n').filter(l => l.startsWith('info depth'));
    depthLine = lines.length ? lines[lines.length - 1].replace(/ pv .*/, '') : '';
    const ok = bm === null || best === bm || (fen.startsWith('r2qkb1r') && (best === 'd5f6'));
    if (ok) solved++;
    console.log(`${ok ? 'ok  ' : 'MISS'} ${best.padEnd(6)} want ${(bm || 'any').padEnd(6)} | ${depthLine}`);
  }
  console.log(`solved ${solved}/${TESTS.length}`);
})();
