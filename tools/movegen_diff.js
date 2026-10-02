// Compare the engine's legal moves with the python-chess output of movegen_diff.py.
const OGE = require('../engine.js');
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n');
let replay = null, checked = 0, bad = 0, games = 0, c960 = false;
const ours = p => p.legalMoves().map(m => p.moveToUci(m)).sort().join(' ');
for (const line of lines) {
  if (!line) continue;
  const parts = line.split('\t');
  if (parts[0] === 'G') { games++; c960 = parts[1] === '1'; replay = null; continue; }
  if (parts[0] === 'P') {
    const fen = parts[1], want = parts[2] || '';
    const pos = new OGE.Position(); pos.chess960 = c960; pos.setFen(fen);
    checked++;
    if (ours(pos) !== want) { bad++; if (bad <= 10) console.log(`MISMATCH (fresh) ${fen}\n want ${want}\n got  ${ours(pos)}`); }
    if (replay === null) { replay = new OGE.Position(); replay.chess960 = c960; replay.setFen(fen); }
    else {
      const f1 = replay.fen().split(' '), f2 = fen.split(' ');
      if (ours(replay) !== want || f1[0] !== f2[0] || f1[1] !== f2[1]) { bad++; if (bad <= 10) console.log(`MISMATCH (replay) ${fen}\n ours ${replay.fen()}`); }
      const lo = replay.hashLo, hi = replay.hashHi; replay.computeHash();
      if (lo !== replay.hashLo || hi !== replay.hashHi) { bad++; console.log(`HASH mismatch at ${fen}`); }
    }
    continue;
  }
  if (parts[0] === 'M') {
    const m = replay.parseMove(parts[1]);
    if (m === OGE.NO_MOVE || !replay.make(m)) { bad++; console.log(`cannot play ${parts[1]} in ${replay.fen()}`); replay.setFen(replay.fen()); }
  }
}
console.log(`${games} games, ${checked} positions: ${bad ? bad + ' MISMATCHES' : 'all match'}`);
process.exit(bad ? 1 : 0);
