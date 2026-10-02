#!/usr/bin/env bun
/*
================================================================
                            O G E
================================================================
   A single-file UCI chess engine in JavaScript.

   Runs under Bun (or Node) as a UCI engine on stdin/stdout, and in
   the browser as a Web Worker or as a plain script that exposes the
   engine on globalThis.OGE for the bundled web app (index.html).

   This file is written to be read from top to bottom. Each section
   starts with a comment explaining what the code below it does and
   why. Nothing is clever for the sake of being clever.

   Run:      bun engine.js            (UCI loop on stdin)
             bun engine.js bench      (OpenBench style benchmark)
   Protocol: Universal Chess Interface (UCI), with UCI_Chess960
================================================================

   TABLE OF CONTENTS
   -----------------
   S1  Constants & Tables     Pieces, squares, moves, attack tables
   S2  Zobrist Hashing        64-bit position keys as two int32s
   S3  Position               Board state, FEN, make/unmake, attacks
   S4  Move Generation        Pseudo-legal moves, Chess960 castling
   S5  Evaluation             Tapered piece-square tables and pawns
   S6  Transposition Table    Typed-array hash table
   S7  Search                 Iterative deepening PVS, quiescence
   S8  Skill Levels           Centipawn-loss budget move selection
   S9  UCI & Benchmarks       Command loop, options, perft, bench
================================================================
*/
'use strict';

/* ================================================================
   S1  CONSTANTS & TABLES
   ================================================================

   Squares are numbered 0..63 from a1 (0) to h8 (63), rank-major:

     8 | 56 57 58 59 60 61 62 63
     7 | 48 49 50 51 52 53 54 55
     6 | 40 41 42 43 44 45 46 47
     5 | 32 33 34 35 36 37 38 39
     4 | 24 25 26 27 28 29 30 31
     3 | 16 17 18 19 20 21 22 23
     2 |  8  9 10 11 12 13 14 15
     1 |  0  1  2  3  4  5  6  7
       +------------------------
          a  b  c  d  e  f  g  h

   file(sq) = sq & 7, rank(sq) = sq >> 3.

   A piece is a small integer: the low three bits are the piece type
   (1 pawn .. 6 king) and bit 3 is the colour (0 white, 8 black).
   So a black rook is 8 | 4 = 12 and the empty square is 0.
*/

const WHITE = 0, BLACK = 8;
const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
const PIECE_CHARS = '.PNBRQK..pnbrqk.';

const typeOf  = p => p & 7;
const colorOf = p => p & 8;
const fileOf  = sq => sq & 7;
const rankOf  = sq => sq >> 3;
const squareName = sq => 'abcdefgh'[sq & 7] + '12345678'[sq >> 3];
const parseSquare = s => (s.charCodeAt(0) - 97) + ((s.charCodeAt(1) - 49) << 3);

/*
   Move encoding (a plain integer):

     bits  0.. 5   from-square
     bits  6..11   to-square (for castling: the king's destination)
     bits 12..14   promotion piece type (0 = none, 2..5 = N B R Q)
     bits 15..16   flag: 0 normal, 1 castling, 2 en passant

   Castling is encoded as king-from -> king-to. In Chess960 the king
   may not move at all (king on g1, rook on h1): the flag keeps that
   move distinct from a null move.
*/

const FLAG_CASTLE = 1 << 15, FLAG_EP = 2 << 15, FLAG_MASK = 3 << 15;
const NO_MOVE = 0;

const makeMove  = (from, to, promo = 0, flag = 0) => from | (to << 6) | (promo << 12) | flag;
const moveFrom  = m => m & 63;
const moveTo    = m => (m >> 6) & 63;
const movePromo = m => (m >> 12) & 7;
const moveFlag  = m => m & FLAG_MASK;

/*
   Attack tables. Knights and kings jump by fixed offsets; sliders
   follow rays until they hit a piece or the board edge. For every
   square we precompute:

     KNIGHT_MOVES[sq]        squares a knight on sq attacks
     KING_MOVES[sq]          squares a king on sq attacks
     RAYS[sq][dir]           squares along direction dir, nearest first
     PAWN_ATTACKERS[c][sq]   squares from which a pawn of colour c attacks sq

   Directions 0..3 are orthogonal (N S E W), 4..7 diagonal.
*/

const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]];
const KNIGHT_MOVES = [], KING_MOVES = [], RAYS = [], PAWN_ATTACKERS = [[], []];

for (let sq = 0; sq < 64; sq++) {
  const f = fileOf(sq), r = rankOf(sq);
  const onBoard = (ff, rr) => ff >= 0 && ff < 8 && rr >= 0 && rr < 8;
  const knight = [], king = [];
  for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]])
    if (onBoard(f + df, r + dr)) knight.push((r + dr) * 8 + f + df);
  for (const [df, dr] of DIRS)
    if (onBoard(f + df, r + dr)) king.push((r + dr) * 8 + f + df);
  KNIGHT_MOVES.push(Int8Array.from(knight));
  KING_MOVES.push(Int8Array.from(king));
  RAYS.push(DIRS.map(([df, dr]) => {
    const ray = [];
    for (let ff = f + df, rr = r + dr; onBoard(ff, rr); ff += df, rr += dr) ray.push(rr * 8 + ff);
    return Int8Array.from(ray);
  }));
  // A white pawn attacks upward, so white pawns attacking sq sit one rank below it.
  const wp = [], bp = [];
  if (r > 0 && f > 0) wp.push(sq - 9);
  if (r > 0 && f < 7) wp.push(sq - 7);
  if (r < 7 && f > 0) bp.push(sq + 7);
  if (r < 7 && f < 7) bp.push(sq + 9);
  PAWN_ATTACKERS[0].push(Int8Array.from(wp));
  PAWN_ATTACKERS[1].push(Int8Array.from(bp));
}

/* Deterministic pseudo random numbers (xorshift32). Used for Zobrist
   keys at start-up, and for the skill levels' random choices. */

class Random {
  constructor(seed) { this.s = seed | 0 || 0x9e3779b9; }
  next() {               // uniform 32-bit integer
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x | 0;
    return x | 0;
  }
  below(n) { return ((this.next() >>> 0) % n); }   // 0 .. n-1
}

/* ================================================================
   S2  ZOBRIST HASHING
   ================================================================

   Every position gets a 64-bit fingerprint made by XOR-ing random
   keys for each (piece, square), the castling rights, the en passant
   file and the side to move. JavaScript has no fast 64-bit integer,
   so a key is two 32-bit halves (lo, hi). XOR on two halves is still
   XOR on the whole key, so incremental updates work the same way.
*/

const ZOBRIST = new Random(0x2545F491);
const PIECE_KEY_LO = new Int32Array(16 * 64), PIECE_KEY_HI = new Int32Array(16 * 64);
const CASTLE_KEY_LO = new Int32Array(16), CASTLE_KEY_HI = new Int32Array(16);
const EP_KEY_LO = new Int32Array(8), EP_KEY_HI = new Int32Array(8);
for (let i = 0; i < 16 * 64; i++) { PIECE_KEY_LO[i] = ZOBRIST.next(); PIECE_KEY_HI[i] = ZOBRIST.next(); }
for (let i = 0; i < 16; i++) { CASTLE_KEY_LO[i] = ZOBRIST.next(); CASTLE_KEY_HI[i] = ZOBRIST.next(); }
for (let i = 0; i < 8; i++) { EP_KEY_LO[i] = ZOBRIST.next(); EP_KEY_HI[i] = ZOBRIST.next(); }
const SIDE_KEY_LO = ZOBRIST.next(), SIDE_KEY_HI = ZOBRIST.next();

/* ================================================================
   S3  POSITION
   ================================================================

   The board is a 64-entry Int8Array of piece codes (a "mailbox").
   Beside it the position keeps the side to move, castling rights,
   the en passant square, the fifty-move counter and the hash.

   Castling rights are four bits:
     1 white short (rook on the h-side of the king)
     2 white long  (rook on the a-side)
     4 black short
     8 black long
   castleRook[i] remembers which rook square belongs to bit i. In
   standard chess these are h1 a1 h8 a8; in Chess960 they are wherever
   the start position put them. castleMask[sq] is the set of rights
   that die when a piece moves from or to sq (king squares kill two).

   Undo information for make/unmake lives in flat typed arrays indexed
   by the "history ply" (game moves so far + search depth), so the
   search never allocates.
*/

const MAX_PLY = 128;          // deepest search line we ever follow
const MAX_HISTORY = 2048;     // game moves + search plies

class Position {
  constructor() {
    this.board = new Int8Array(64);
    this.side = WHITE;
    this.castling = 0;
    this.castleRook = new Int8Array([7, 0, 63, 56]);
    this.castleMask = new Int8Array(64);
    this.ep = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.kingSq = new Int8Array(2);
    this.hashLo = 0; this.hashHi = 0;
    this.histPly = 0;             // index into the undo stacks
    this.gamePly = 0;             // plies played in the game (not search)
    this.chess960 = false;        // only affects move notation
    // undo stacks
    this.uMove = new Int32Array(MAX_HISTORY);
    this.uCaptured = new Int8Array(MAX_HISTORY);
    this.uCastling = new Int8Array(MAX_HISTORY);
    this.uEp = new Int8Array(MAX_HISTORY);
    this.uHalfmove = new Int16Array(MAX_HISTORY);
    this.uHashLo = new Int32Array(MAX_HISTORY);
    this.uHashHi = new Int32Array(MAX_HISTORY);
    this.setFen(START_FEN);
  }

  /* ---- FEN -------------------------------------------------------
     Accepts standard FEN, X-FEN (KQkq with rooks anywhere) and
     Shredder-FEN (castling rights given as rook files, e.g. "HAha"). */
  setFen(fen) {
    const parts = fen.trim().split(/\s+/);
    const board = new Int8Array(64), kings = [-1, -1];
    let sq = 56, rankStart = 56;
    for (const ch of (parts[0] || '')) {
      if (ch === '/') { rankStart -= 8; sq = rankStart; if (rankStart < 0) break; continue; }
      if (ch >= '1' && ch <= '8') { sq += ch.charCodeAt(0) - 48; continue; }
      const idx = PIECE_CHARS.indexOf(ch);
      if (idx > 0 && sq >= rankStart && sq < rankStart + 8) {
        board[sq] = idx;
        if (typeOf(idx) === KING) kings[colorOf(idx) >> 3] = sq;
      }
      sq++;
    }
    if (kings[0] < 0 || kings[1] < 0) { if (fen !== START_FEN) this.setFen(START_FEN); throw new Error('invalid FEN (missing king): ' + fen); }
    this.board.set(board);
    this.kingSq[0] = kings[0]; this.kingSq[1] = kings[1];
    this.side = parts[1] === 'b' ? BLACK : WHITE;
    this.castling = 0;
    this.castleRook.fill(-1);
    const rights = parts[2] && parts[2] !== '-' ? parts[2] : '';
    for (const ch of rights) {
      const color = ch === ch.toUpperCase() ? WHITE : BLACK;
      const rank = color === WHITE ? 0 : 7;
      const king = this.kingSq[color >> 3];
      let rookFile = -1;
      const lower = ch.toLowerCase();
      if (lower === 'k') {            // outermost rook on the h-side of the king
        for (let f = 7; f > fileOf(king); f--) if (this.board[rank * 8 + f] === (color | ROOK)) { rookFile = f; break; }
      } else if (lower === 'q') {     // outermost rook on the a-side
        for (let f = 0; f < fileOf(king); f++) if (this.board[rank * 8 + f] === (color | ROOK)) { rookFile = f; break; }
      } else if (lower >= 'a' && lower <= 'h') {
        rookFile = lower.charCodeAt(0) - 97;
      }
      if (rookFile < 0 || rankOf(king) !== rank) continue;
      const bit = rookFile > fileOf(king) ? 0 : 1;
      const idx = bit + (color === WHITE ? 0 : 2);
      this.castling |= 1 << idx;
      this.castleRook[idx] = rank * 8 + rookFile;
    }
    this.castleMask.fill(15);
    for (let i = 0; i < 4; i++) if (this.castleRook[i] >= 0) this.castleMask[this.castleRook[i]] &= ~(1 << i);
    this.castleMask[this.kingSq[0]] &= ~3;
    this.castleMask[this.kingSq[1]] &= ~12;
    this.ep = parts[3] && parts[3] !== '-' ? parseSquare(parts[3]) : -1;
    if (this.ep >= 0 && !this.epCapturePossible()) this.ep = -1;
    this.halfmove = parts[4] ? parseInt(parts[4], 10) || 0 : 0;
    this.fullmove = parts[5] ? parseInt(parts[5], 10) || 1 : 1;
    this.histPly = 0;
    this.gamePly = 0;
    this.computeHash();
  }

  fen() {
    let s = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 8 + f];
        if (p === EMPTY) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        s += PIECE_CHARS[p];
      }
      if (empty) s += empty;
      if (r) s += '/';
    }
    s += this.side === WHITE ? ' w ' : ' b ';
    let c = '';
    for (let i = 0; i < 4; i++) {
      if (!(this.castling & (1 << i))) continue;
      const file = 'abcdefgh'[fileOf(this.castleRook[i])];
      // Shredder-FEN letters for Chess960, KQkq when the rooks are on their classical files.
      const classical = fileOf(this.castleRook[i]) === (i & 1 ? 0 : 7) && fileOf(this.kingSq[i >> 1]) === 4;
      const letter = this.chess960 && !classical ? file : (i & 1 ? 'q' : 'k');
      c += i < 2 ? letter.toUpperCase() : letter;
    }
    s += (c || '-') + ' ' + (this.ep >= 0 ? squareName(this.ep) : '-');
    s += ' ' + this.halfmove + ' ' + this.fullmove;
    return s;
  }

  /* A double pawn push only creates a real en passant square when an
     enemy pawn stands next to the pushed pawn. Dropping phantom ep
     squares keeps the hash honest for repetition detection. */
  epCapturePossible() {
    const attackers = PAWN_ATTACKERS[this.side >> 3][this.ep];   // our pawns that could capture on ep
    for (let i = 0; i < attackers.length; i++) if (this.board[attackers[i]] === (this.side | PAWN)) return true;
    return false;
  }

  computeHash() {
    let lo = 0, hi = 0;
    for (let sq = 0; sq < 64; sq++) {
      const p = this.board[sq];
      if (p) { lo ^= PIECE_KEY_LO[p * 64 + sq]; hi ^= PIECE_KEY_HI[p * 64 + sq]; }
    }
    lo ^= CASTLE_KEY_LO[this.castling]; hi ^= CASTLE_KEY_HI[this.castling];
    if (this.ep >= 0) { lo ^= EP_KEY_LO[fileOf(this.ep)]; hi ^= EP_KEY_HI[fileOf(this.ep)]; }
    if (this.side === BLACK) { lo ^= SIDE_KEY_LO; hi ^= SIDE_KEY_HI; }
    this.hashLo = lo; this.hashHi = hi;
  }

  /* ---- Attacks ---------------------------------------------------- */
  isAttacked(sq, by) {
    const b = this.board;
    const pawns = PAWN_ATTACKERS[by >> 3][sq];
    for (let i = 0; i < pawns.length; i++) if (b[pawns[i]] === (by | PAWN)) return true;
    const knights = KNIGHT_MOVES[sq];
    for (let i = 0; i < knights.length; i++) if (b[knights[i]] === (by | KNIGHT)) return true;
    const kings = KING_MOVES[sq];
    for (let i = 0; i < kings.length; i++) if (b[kings[i]] === (by | KING)) return true;
    const rays = RAYS[sq];
    for (let d = 0; d < 8; d++) {
      const ray = rays[d];
      for (let i = 0; i < ray.length; i++) {
        const p = b[ray[i]];
        if (p === EMPTY) continue;
        if (colorOf(p) === by) {
          const t = typeOf(p);
          if (t === QUEEN || t === (d < 4 ? ROOK : BISHOP)) return true;
        }
        break;
      }
    }
    return false;
  }

  inCheck() { return this.isAttacked(this.kingSq[this.side >> 3], this.side ^ 8); }

  /* ---- Make / unmake ---------------------------------------------
     make() applies a pseudo-legal move and returns false (after
     undoing it) if it leaves our own king in check. That single test
     also covers every Chess960 castling subtlety, because the king and
     rook have really been moved when the king's safety is checked. */
  make(move) {
    const b = this.board;
    const us = this.side, them = us ^ 8;
    const from = moveFrom(move), to = moveTo(move), flag = moveFlag(move);
    const piece = b[from];
    const h = this.histPly;
    this.uMove[h] = move;
    this.uCastling[h] = this.castling;
    this.uEp[h] = this.ep;
    this.uHalfmove[h] = this.halfmove;
    this.uHashLo[h] = this.hashLo;
    this.uHashHi[h] = this.hashHi;
    let lo = this.hashLo, hi = this.hashHi;
    let captured = EMPTY;

    if (this.ep >= 0) { lo ^= EP_KEY_LO[fileOf(this.ep)]; hi ^= EP_KEY_HI[fileOf(this.ep)]; }
    this.ep = -1;
    this.halfmove++;

    if (flag === FLAG_CASTLE) {
      const idx = (fileOf(to) === 6 ? 0 : 1) + (us === WHITE ? 0 : 2);
      const rookFrom = this.castleRook[idx];
      const rookTo = (fileOf(to) === 6 ? 5 : 3) + (rankOf(from) << 3);
      const rook = us | ROOK;
      b[from] = EMPTY; b[rookFrom] = EMPTY;
      b[to] = piece; b[rookTo] = rook;
      lo ^= PIECE_KEY_LO[piece * 64 + from] ^ PIECE_KEY_LO[piece * 64 + to] ^ PIECE_KEY_LO[rook * 64 + rookFrom] ^ PIECE_KEY_LO[rook * 64 + rookTo];
      hi ^= PIECE_KEY_HI[piece * 64 + from] ^ PIECE_KEY_HI[piece * 64 + to] ^ PIECE_KEY_HI[rook * 64 + rookFrom] ^ PIECE_KEY_HI[rook * 64 + rookTo];
      this.kingSq[us >> 3] = to;
    } else {
      if (flag === FLAG_EP) {
        const capSq = to + (us === WHITE ? -8 : 8);
        captured = b[capSq];
        b[capSq] = EMPTY;
        lo ^= PIECE_KEY_LO[captured * 64 + capSq]; hi ^= PIECE_KEY_HI[captured * 64 + capSq];
      } else if (b[to] !== EMPTY) {
        captured = b[to];
        lo ^= PIECE_KEY_LO[captured * 64 + to]; hi ^= PIECE_KEY_HI[captured * 64 + to];
      }
      const promo = movePromo(move);
      const placed = promo ? (us | promo) : piece;
      b[from] = EMPTY; b[to] = placed;
      lo ^= PIECE_KEY_LO[piece * 64 + from] ^ PIECE_KEY_LO[placed * 64 + to];
      hi ^= PIECE_KEY_HI[piece * 64 + from] ^ PIECE_KEY_HI[placed * 64 + to];
      if (typeOf(piece) === PAWN) {
        this.halfmove = 0;
        if ((to - from) === 16 || (from - to) === 16) {
          this.ep = (from + to) >> 1;
          // only keep it if an enemy pawn can actually capture
          const att = PAWN_ATTACKERS[them >> 3][this.ep];
          let possible = false;
          for (let i = 0; i < att.length; i++) if (b[att[i]] === (them | PAWN)) { possible = true; break; }
          if (possible) { lo ^= EP_KEY_LO[fileOf(this.ep)]; hi ^= EP_KEY_HI[fileOf(this.ep)]; } else this.ep = -1;
        }
      } else if (typeOf(piece) === KING) {
        this.kingSq[us >> 3] = to;
      }
      if (captured) this.halfmove = 0;
    }
    this.uCaptured[h] = captured;

    const newCastling = this.castling & this.castleMask[from] & this.castleMask[to];
    if (newCastling !== this.castling) {
      lo ^= CASTLE_KEY_LO[this.castling] ^ CASTLE_KEY_LO[newCastling];
      hi ^= CASTLE_KEY_HI[this.castling] ^ CASTLE_KEY_HI[newCastling];
      this.castling = newCastling;
    }
    lo ^= SIDE_KEY_LO; hi ^= SIDE_KEY_HI;
    this.hashLo = lo; this.hashHi = hi;
    this.side = them;
    this.histPly++;
    if (us === BLACK) this.fullmove++;

    if (this.isAttacked(this.kingSq[us >> 3], them)) { this.unmake(); return false; }
    return true;
  }

  unmake() {
    const h = --this.histPly;
    const move = this.uMove[h];
    const b = this.board;
    const them = this.side, us = them ^ 8;
    const from = moveFrom(move), to = moveTo(move), flag = moveFlag(move);
    this.side = us;
    if (us === BLACK) this.fullmove--;
    this.castling = this.uCastling[h];
    this.ep = this.uEp[h];
    this.halfmove = this.uHalfmove[h];
    this.hashLo = this.uHashLo[h];
    this.hashHi = this.uHashHi[h];
    if (flag === FLAG_CASTLE) {
      const idx = (fileOf(to) === 6 ? 0 : 1) + (us === WHITE ? 0 : 2);
      const rookFrom = this.castleRook[idx];
      const rookTo = (fileOf(to) === 6 ? 5 : 3) + (rankOf(from) << 3);
      b[to] = EMPTY; b[rookTo] = EMPTY;
      b[from] = us | KING; b[rookFrom] = us | ROOK;
      this.kingSq[us >> 3] = from;
      return;
    }
    const placed = b[to];
    const piece = movePromo(move) ? (us | PAWN) : placed;
    b[from] = piece;
    b[to] = EMPTY;
    if (flag === FLAG_EP) b[to + (us === WHITE ? -8 : 8)] = this.uCaptured[h];
    else if (this.uCaptured[h]) b[to] = this.uCaptured[h];
    if (typeOf(piece) === KING) this.kingSq[us >> 3] = from;
  }

  /* A null move (pass) for null-move pruning in the search. */
  makeNull() {
    const h = this.histPly;
    this.uMove[h] = NO_MOVE;
    this.uCastling[h] = this.castling;
    this.uEp[h] = this.ep;
    this.uHalfmove[h] = this.halfmove;
    this.uHashLo[h] = this.hashLo;
    this.uHashHi[h] = this.hashHi;
    this.uCaptured[h] = EMPTY;
    if (this.ep >= 0) { this.hashLo ^= EP_KEY_LO[fileOf(this.ep)]; this.hashHi ^= EP_KEY_HI[fileOf(this.ep)]; }
    this.ep = -1;
    this.hashLo ^= SIDE_KEY_LO; this.hashHi ^= SIDE_KEY_HI;
    this.side ^= 8;
    this.halfmove++;
    this.histPly++;
  }

  unmakeNull() {
    const h = --this.histPly;
    this.side ^= 8;
    this.castling = this.uCastling[h];
    this.ep = this.uEp[h];
    this.halfmove = this.uHalfmove[h];
    this.hashLo = this.uHashLo[h];
    this.hashHi = this.uHashHi[h];
  }

  /* Has this position occurred before? Used for draw detection. We
     only need to look back as far as the last irreversible move. */
  isRepetition() {
    const end = this.histPly - this.halfmove;
    for (let i = this.histPly - 2; i >= end && i >= 0; i -= 2)
      if (this.uHashLo[i] === this.hashLo && this.uHashHi[i] === this.hashHi) return true;
    return false;
  }

  /* King + minor piece (or less) on both sides cannot force mate. */
  insufficientMaterial() {
    let minors = 0;
    for (let sq = 0; sq < 64; sq++) {
      const t = typeOf(this.board[sq]);
      if (t === EMPTY || t === KING) continue;
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      minors++;
    }
    return minors <= 1;
  }

  /* ---- Move notation ----------------------------------------------
     UCI moves are from-square + to-square (+ promotion letter).
     Castling is written king-from king-to in standard chess (e1g1)
     and king-from rook-square in Chess960 mode (e1h1). */
  moveToUci(move) {
    const from = moveFrom(move), to = moveTo(move);
    if (moveFlag(move) === FLAG_CASTLE) {
      if (this.chess960) {
        const idx = (fileOf(to) === 6 ? 0 : 1) + (colorOf(this.board[from]) === WHITE ? 0 : 2);
        return squareName(from) + squareName(this.castleRook[idx]);
      }
      return squareName(from) + squareName(to);
    }
    const promo = movePromo(move);
    return squareName(from) + squareName(to) + (promo ? PIECE_CHARS[promo | 8] : '');
  }

  /* Find the legal move matching a UCI string; accepts both castling
     notations whatever the UCI_Chess960 setting. Returns NO_MOVE if
     there is none. */
  parseMove(str) {
    str = String(str).toLowerCase();
    const moves = this.legalMoves();
    const saved = this.chess960;
    for (const m of moves) {
      this.chess960 = false; const a = this.moveToUci(m);
      this.chess960 = true;  const b = this.moveToUci(m);
      this.chess960 = saved;
      if (str === a || str === b) return m;
    }
    this.chess960 = saved;
    return NO_MOVE;
  }

  /* Convenience for callers outside the search (UCI, web app). */
  legalMoves() {
    const list = new Int32Array(256);
    const n = generateMoves(this, list, 0, false);
    const legal = [];
    for (let i = 0; i < n; i++) if (this.make(list[i])) { this.unmake(); legal.push(list[i]); }
    return legal;
  }

  toString() {
    let s = '';
    for (let r = 7; r >= 0; r--) {
      s += (r + 1) + ' ';
      for (let f = 0; f < 8; f++) s += ' ' + PIECE_CHARS[this.board[r * 8 + f]];
      s += '\n';
    }
    return s + '\n   a b c d e f g h\n\nfen: ' + this.fen() + '\nkey: ' + ((this.hashHi >>> 0).toString(16).padStart(8, '0') + (this.hashLo >>> 0).toString(16).padStart(8, '0'));
  }
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/* ================================================================
   S4  MOVE GENERATION
   ================================================================

   generateMoves() writes pseudo-legal moves into `list` starting at
   index `start` and returns the index after the last move. Moves are
   pseudo-legal: they may leave our king in check, which make() will
   detect. With capturesOnly set, only captures and promotions are
   produced (for quiescence search).

   Castling follows the Chess960 rules, which reduce to the classical
   ones for the standard start position:
     - the king and the castling rook have not moved (rights bit set)
     - every square between the king's and rook's start and end squares
       is empty, except for the king and rook themselves
     - the king is not in check, and does not pass through or land on
       an attacked square (the landing square is re-checked by make()
       with the pieces actually moved, which catches the odd Chess960
       case where the moving rook was shielding the king)
*/

function generateMoves(pos, list, start, capturesOnly) {
  const b = pos.board;
  const us = pos.side, them = us ^ 8;
  let n = start;
  const up = us === WHITE ? 8 : -8;
  const startRank = us === WHITE ? 1 : 6, promoRank = us === WHITE ? 6 : 1;

  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (p === EMPTY || colorOf(p) !== us) continue;
    const t = typeOf(p);

    if (t === PAWN) {
      const r = rankOf(from), f = fileOf(from);
      const to = from + up;
      const promoting = r === promoRank;
      if (b[to] === EMPTY && (promoting || !capturesOnly)) {
        if (promoting) { list[n++] = makeMove(from, to, QUEEN); list[n++] = makeMove(from, to, ROOK); list[n++] = makeMove(from, to, BISHOP); list[n++] = makeMove(from, to, KNIGHT); }
        else {
          list[n++] = makeMove(from, to);
          if (r === startRank && b[to + up] === EMPTY) list[n++] = makeMove(from, to + up);
        }
      }
      for (let side = -1; side <= 1; side += 2) {
        if (f + side < 0 || f + side > 7) continue;
        const cap = to + side;
        if (cap === pos.ep) list[n++] = makeMove(from, cap, 0, FLAG_EP);
        else if (b[cap] !== EMPTY && colorOf(b[cap]) === them) {
          if (promoting) { list[n++] = makeMove(from, cap, QUEEN); list[n++] = makeMove(from, cap, ROOK); list[n++] = makeMove(from, cap, BISHOP); list[n++] = makeMove(from, cap, KNIGHT); }
          else list[n++] = makeMove(from, cap);
        }
      }
      continue;
    }

    if (t === KNIGHT || t === KING) {
      const targets = t === KNIGHT ? KNIGHT_MOVES[from] : KING_MOVES[from];
      for (let i = 0; i < targets.length; i++) {
        const to = targets[i], q = b[to];
        if (q === EMPTY) { if (!capturesOnly) list[n++] = makeMove(from, to); }
        else if (colorOf(q) === them) list[n++] = makeMove(from, to);
      }
      continue;
    }

    // sliders: rook uses directions 0..3, bishop 4..7, queen all
    const d0 = t === BISHOP ? 4 : 0, d1 = t === ROOK ? 4 : 8;
    const rays = RAYS[from];
    for (let d = d0; d < d1; d++) {
      const ray = rays[d];
      for (let i = 0; i < ray.length; i++) {
        const to = ray[i], q = b[to];
        if (q === EMPTY) { if (!capturesOnly) list[n++] = makeMove(from, to); continue; }
        if (colorOf(q) === them) list[n++] = makeMove(from, to);
        break;
      }
    }
  }

  if (!capturesOnly) {
    const rights = (pos.castling >> (us === WHITE ? 0 : 2)) & 3;
    if (rights) {
      const king = pos.kingSq[us >> 3];
      if (!pos.isAttacked(king, them)) {
        const rank = rankOf(king) << 3;
        for (let s = 0; s < 2; s++) {
          if (!(rights & (1 << s))) continue;
          const rookFrom = pos.castleRook[s + (us === WHITE ? 0 : 2)];
          const kingTo = rank + (s === 0 ? 6 : 2);
          const rookTo = rank + (s === 0 ? 5 : 3);
          if (b[rookFrom] !== (us | ROOK)) continue;
          const lo = Math.min(king, kingTo, rookFrom, rookTo), hi = Math.max(king, kingTo, rookFrom, rookTo);
          let ok = true;
          for (let sq = lo; sq <= hi && ok; sq++) if (sq !== king && sq !== rookFrom && b[sq] !== EMPTY) ok = false;
          if (!ok) continue;
          const step = kingTo > king ? 1 : -1;
          for (let sq = king + step; ok && sq !== kingTo + step; sq += step) if (pos.isAttacked(sq, them)) ok = false;
          if (ok) list[n++] = makeMove(king, kingTo, 0, FLAG_CASTLE);
        }
      }
    }
  }
  return n;
}

/* Perft counts leaf nodes of the full legal move tree. It is the
   standard way to prove a move generator correct. */
function perft(pos, depth) {
  if (depth === 0) return 1;
  const list = new Int32Array(256);
  const n = generateMoves(pos, list, 0, false);
  let nodes = 0;
  for (let i = 0; i < n; i++) {
    if (!pos.make(list[i])) continue;
    nodes += depth === 1 ? 1 : perft(pos, depth - 1);
    pos.unmake();
  }
  return nodes;
}

/* ================================================================
   S5  EVALUATION
   ================================================================

   The evaluation is a tapered sum of piece-square tables: every piece
   has a middlegame value and an endgame value for each square, and
   the two are blended by the "phase" (how much non-pawn material is
   left). The tables are PeSTO's (Ronald Friederich), which were tuned
   on millions of positions and give a solid 2000+ Elo backbone.

   On top of that come a few cheap hand-written terms that tables
   cannot express: pawn structure (passed, isolated, doubled), the
   bishop pair, rooks on open files, a pawn shield for the king and a
   tempo bonus.

   Scores are in centipawns from the side to move's point of view.
   Tables are written as seen from White with rank 8 at the top, so a
   white piece on square sq looks up index sq ^ 56 and a black piece
   looks up sq directly (a vertical mirror).
*/

const MG_VALUE = [0, 82, 337, 365, 477, 1025, 0];
const EG_VALUE = [0, 94, 281, 297, 512, 936, 0];
const PHASE_INC = [0, 0, 1, 1, 2, 4, 0];    // material "phase" weight per piece type
const PIECE_VALUE = [0, 100, 320, 330, 500, 900, 20000];   // for move ordering and skill estimates

const MG_PST = [
  [], // empty
  [ // pawn
      0,   0,   0,   0,   0,   0,  0,   0,
     98, 134,  61,  95,  68, 126, 34, -11,
     -6,   7,  26,  31,  65,  56, 25, -20,
    -14,  13,   6,  21,  23,  12, 17, -23,
    -27,  -2,  -5,  12,  17,   6, 10, -25,
    -26,  -4,  -4, -10,   3,   3, 33, -12,
    -35,  -1, -20, -23, -15,  24, 38, -22,
      0,   0,   0,   0,   0,   0,  0,   0],
  [ // knight
    -167, -89, -34, -49,  61, -97, -15, -107,
     -73, -41,  72,  36,  23,  62,   7,  -17,
     -47,  60,  37,  65,  84, 129,  73,   44,
      -9,  17,  19,  53,  37,  69,  18,   22,
     -13,   4,  16,  13,  28,  19,  21,   -8,
     -23,  -9,  12,  10,  19,  17,  25,  -16,
     -29, -53, -12,  -3,  -1,  18, -14,  -19,
    -105, -21, -58, -33, -17, -28, -19,  -23],
  [ // bishop
    -29,   4, -82, -37, -25, -42,   7,  -8,
    -26,  16, -18, -13,  30,  59,  18, -47,
    -16,  37,  43,  40,  35,  50,  37,  -2,
     -4,   5,  19,  50,  37,  37,   7,  -2,
     -6,  13,  13,  26,  34,  12,  10,   4,
      0,  15,  15,  15,  14,  27,  18,  10,
      4,  15,  16,   0,   7,  21,  33,   1,
    -33,  -3, -14, -21, -13, -12, -39, -21],
  [ // rook
     32,  42,  32,  51, 63,  9,  31,  43,
     27,  32,  58,  62, 80, 67,  26,  44,
     -5,  19,  26,  36, 17, 45,  61,  16,
    -24, -11,   7,  26, 24, 35,  -8, -20,
    -36, -26, -12,  -1,  9, -7,   6, -23,
    -45, -25, -16, -17,  3,  0,  -5, -33,
    -44, -16, -20,  -9, -1, 11,  -6, -71,
    -19, -13,   1,  17, 16,  7, -37, -26],
  [ // queen
    -28,   0,  29,  12,  59,  44,  43,  45,
    -24, -39,  -5,   1, -16,  57,  28,  54,
    -13, -17,   7,   8,  29,  56,  47,  57,
    -27, -27, -16, -16,  -1,  17,  -2,   1,
     -9, -26,  -9, -10,  -2,  -4,   3,  -3,
    -14,   2, -11,  -2,  -5,   2,  14,   5,
    -35,  -8,  11,   2,   8,  15,  -3,   1,
     -1, -18,  -9,  10, -15, -25, -31, -50],
  [ // king
    -65,  23,  16, -15, -56, -34,   2,  13,
     29,  -1, -20,  -7,  -8,  -4, -38, -29,
     -9,  24,   2, -16, -20,   6,  22, -22,
    -17, -20, -12, -27, -30, -25, -14, -36,
    -49,  -1, -27, -39, -46, -44, -33, -51,
    -14, -14, -22, -46, -44, -30, -15, -27,
      1,   7,  -8, -64, -43, -16,   9,   8,
    -15,  36,  12, -54,   8, -28,  24,  14],
];

const EG_PST = [
  [],
  [ // pawn
      0,   0,   0,   0,   0,   0,   0,   0,
    178, 173, 158, 134, 147, 132, 165, 187,
     94, 100,  85,  67,  56,  53,  82,  84,
     32,  24,  13,   5,  -2,   4,  17,  17,
     13,   9,  -3,  -7,  -7,  -8,   3,  -1,
      4,   7,  -6,   1,   0,  -5,  -1,  -8,
     13,   8,   8,  10,  13,   0,   2,  -7,
      0,   0,   0,   0,   0,   0,   0,   0],
  [ // knight
    -58, -38, -13, -28, -31, -27, -63, -99,
    -25,  -8, -25,  -2,  -9, -25, -24, -52,
    -24, -20,  10,   9,  -1,  -9, -19, -41,
    -17,   3,  22,  22,  22,  11,   8, -18,
    -18,  -6,  16,  25,  16,  17,   4, -18,
    -23,  -3,  -1,  15,  10,  -3, -20, -22,
    -42, -20, -10,  -5,  -2, -20, -23, -44,
    -29, -51, -23, -15, -22, -18, -50, -64],
  [ // bishop
    -14, -21, -11,  -8, -7,  -9, -17, -24,
     -8,  -4,   7, -12, -3, -13,  -4, -14,
      2,  -8,   0,  -1, -2,   6,   0,   4,
     -3,   9,  12,   9, 14,  10,   3,   2,
     -6,   3,  13,  19,  7,  10,  -3,  -9,
    -12,  -3,   8,  10, 13,   3,  -7, -15,
    -14, -18,  -7,  -1,  4,  -9, -15, -27,
    -23,  -9, -23,  -5, -9, -16,  -5, -17],
  [ // rook
    13, 10, 18, 15, 12,  12,   8,   5,
    11, 13, 13, 11, -3,   3,   8,   3,
     7,  7,  7,  5,  4,  -3,  -5,  -3,
     4,  3, 13,  1,  2,   1,  -1,   2,
     3,  5,  8,  4, -5,  -6,  -8, -11,
    -4,  0, -5, -1, -7, -12,  -8, -16,
    -6, -6,  0,  2, -9,  -9, -11,  -3,
    -9,  2,  3, -1, -5, -13,   4, -20],
  [ // queen
     -9,  22,  22,  27,  27,  19,  10,  20,
    -17,  20,  32,  41,  58,  25,  30,   0,
    -20,   6,   9,  49,  47,  35,  19,   9,
      3,  22,  24,  45,  57,  40,  57,  36,
    -18,  28,  19,  47,  31,  34,  39,  23,
    -16, -27,  15,   6,   9,  17,  10,   5,
    -22, -23, -30, -16, -16, -23, -36, -32,
    -33, -28, -22, -43,  -5, -32, -20, -41],
  [ // king
    -74, -35, -18, -18, -11,  15,   4, -17,
    -12,  17,  14,  17,  17,  38,  23,  11,
     10,  17,  23,  15,  20,  45,  44,  13,
     -8,  22,  24,  27,  26,  33,  26,   3,
    -18,  -4,  21,  24,  27,  23,   9, -11,
    -19,  -3,  11,  21,  23,  16,   7,  -9,
    -27, -11,   4,  13,  14,   4,  -5, -17,
    -53, -34, -21, -11, -28, -14, -24, -43],
];

/* Fold the material values into the tables once, so evaluation is a
   single lookup per piece: MG[piece][sq], EG[piece][sq]. */
const MG = [], EG = [];
for (let p = 0; p < 16; p++) {
  MG.push(new Int16Array(64)); EG.push(new Int16Array(64));
  const t = typeOf(p);
  if (t === EMPTY || t === 7) continue;
  for (let sq = 0; sq < 64; sq++) {
    const idx = colorOf(p) === WHITE ? sq ^ 56 : sq;
    MG[p][sq] = MG_VALUE[t] + MG_PST[t][idx];
    EG[p][sq] = EG_VALUE[t] + EG_PST[t][idx];
  }
}

// Hand-written terms, each as [middlegame, endgame].
const BISHOP_PAIR   = [20, 45];
const DOUBLED_PAWN  = [-8, -18];
const ISOLATED_PAWN = [-10, -14];
const PASSED_PAWN_MG = [0, 4, 8, 16, 30, 55, 90, 0];    // indexed by relative rank
const PASSED_PAWN_EG = [0, 10, 18, 32, 60, 100, 150, 0];
const ROOK_OPEN_FILE = [22, 10], ROOK_SEMI_OPEN = [10, 6];
const KING_SHIELD = 9;         // per own pawn directly in front of the king (middlegame)
const TEMPO = 12;

const pawnsOnFile = new Int8Array(16);   // [colour index * 8 + file]

function evaluate(pos) {
  const b = pos.board;
  let mg = 0, eg = 0, phase = 0;
  let wBishops = 0, bBishops = 0;
  pawnsOnFile.fill(0);

  // First pass: material + tables, phase, pawn files.
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq];
    if (p === EMPTY) continue;
    const t = typeOf(p);
    phase += PHASE_INC[t];
    if (colorOf(p) === WHITE) { mg += MG[p][sq]; eg += EG[p][sq]; }
    else { mg -= MG[p][sq]; eg -= EG[p][sq]; }
    if (t === PAWN) pawnsOnFile[(colorOf(p) >> 3) * 8 + fileOf(sq)]++;
    else if (t === BISHOP) { if (colorOf(p) === WHITE) wBishops++; else bBishops++; }
  }
  if (wBishops >= 2) { mg += BISHOP_PAIR[0]; eg += BISHOP_PAIR[1]; }
  if (bBishops >= 2) { mg -= BISHOP_PAIR[0]; eg -= BISHOP_PAIR[1]; }

  // Second pass: pawn structure and rook files, which need the file counts.
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq];
    if (p === EMPTY) continue;
    const t = typeOf(p), c = colorOf(p), ci = c >> 3, sign = c === WHITE ? 1 : -1;
    const f = fileOf(sq), r = rankOf(sq);
    if (t === PAWN) {
      const own = pawnsOnFile[ci * 8 + f];
      if (own > 1) { mg += sign * DOUBLED_PAWN[0]; eg += sign * DOUBLED_PAWN[1]; }
      const leftOwn = f > 0 ? pawnsOnFile[ci * 8 + f - 1] : 0, rightOwn = f < 7 ? pawnsOnFile[ci * 8 + f + 1] : 0;
      if (!leftOwn && !rightOwn) { mg += sign * ISOLATED_PAWN[0]; eg += sign * ISOLATED_PAWN[1]; }
      // passed: no enemy pawn ahead on this or the neighbouring files
      let passed = true;
      const enemy = c ^ 8;
      const step = c === WHITE ? 8 : -8;
      for (let s = sq + step; s >= 0 && s < 64 && passed; s += step) {
        if (b[s] === (enemy | PAWN)) passed = false;
        if (f > 0 && b[s - 1] === (enemy | PAWN)) passed = false;
        if (f < 7 && b[s + 1] === (enemy | PAWN)) passed = false;
      }
      if (passed) {
        const rel = c === WHITE ? r : 7 - r;
        mg += sign * PASSED_PAWN_MG[rel]; eg += sign * PASSED_PAWN_EG[rel];
      }
    } else if (t === ROOK) {
      const own = pawnsOnFile[ci * 8 + f], theirs = pawnsOnFile[(ci ^ 1) * 8 + f];
      if (!own && !theirs) { mg += sign * ROOK_OPEN_FILE[0]; eg += sign * ROOK_OPEN_FILE[1]; }
      else if (!own) { mg += sign * ROOK_SEMI_OPEN[0]; eg += sign * ROOK_SEMI_OPEN[1]; }
    } else if (t === KING) {
      // pawn shield: own pawns on the three squares in front of the king
      const ahead = c === WHITE ? 8 : -8;
      let shield = 0;
      for (let df = -1; df <= 1; df++) {
        if (f + df < 0 || f + df > 7) continue;
        const s1 = sq + ahead + df, s2 = sq + 2 * ahead + df;
        if (s1 >= 0 && s1 < 64 && b[s1] === (c | PAWN)) shield++;
        else if (s2 >= 0 && s2 < 64 && b[s2] === (c | PAWN)) shield++;
      }
      mg += sign * shield * KING_SHIELD;
    }
  }

  if (phase > 24) phase = 24;
  let score = ((mg * phase + eg * (24 - phase)) / 24) | 0;
  score += pos.side === WHITE ? TEMPO : -TEMPO;
  return pos.side === WHITE ? score : -score;
}

/* Material only, from White's point of view. The skill levels use it
   to recognise sacrifices and the search to detect bare kings. */
function materialBalance(pos) {
  let m = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = pos.board[sq];
    if (p && typeOf(p) !== KING) m += colorOf(p) === WHITE ? PIECE_VALUE[typeOf(p)] : -PIECE_VALUE[typeOf(p)];
  }
  return m;
}

function hasNonPawnMaterial(pos, color) {
  for (let sq = 0; sq < 64; sq++) {
    const p = pos.board[sq];
    if (p && colorOf(p) === color) { const t = typeOf(p); if (t !== PAWN && t !== KING) return true; }
  }
  return false;
}

/* ================================================================
   S6  TRANSPOSITION TABLE
   ================================================================

   The search sees the same position through different move orders.
   The transposition table remembers, per position hash, the best move
   found, the score, how deep the search was and whether that score
   was exact or only a bound. Entries live in parallel typed arrays
   (16 bytes each) so the table has a predictable size: the Hash
   option is in megabytes.

   Scores for forced mates are stored relative to the current node
   (mate in N from here) so they stay valid wherever the position is
   met again.
*/

const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;

class TranspositionTable {
  constructor(mb) { this.resize(mb); }

  resize(mb) {
    let n = 1024;
    while (n * 2 * 16 <= mb * 1024 * 1024) n *= 2;
    this.size = n; this.mask = n - 1;
    this.keys = new Int32Array(n);     // hashHi; hashLo picks the slot
    this.moves = new Int32Array(n);
    this.scores = new Int16Array(n);
    this.evals = new Int16Array(n);
    this.depths = new Uint8Array(n);
    this.flags = new Uint8Array(n);    // 0 empty, else TT_* | (age << 2)
    this.age = 0;
    this.used = 0;
  }

  clear() { this.keys.fill(0); this.moves.fill(0); this.flags.fill(0); this.age = 0; this.used = 0; }
  newSearch() { this.age = (this.age + 1) & 63; }

  /* Returns the slot index when the position is in the table, else -1. */
  probe(pos) {
    const i = pos.hashLo & this.mask;
    return this.flags[i] !== 0 && this.keys[i] === pos.hashHi ? i : -1;
  }

  store(pos, move, score, staticEval, depth, flag, ply) {
    const i = pos.hashLo & this.mask;
    const same = this.flags[i] !== 0 && this.keys[i] === pos.hashHi;
    // keep a deeper entry for the same position unless the new one is exact or old
    if (same && flag !== TT_EXACT && this.depths[i] > depth + 2 && (this.flags[i] >> 2) === this.age) {
      if (move && !this.moves[i]) this.moves[i] = move;
      return;
    }
    if (this.flags[i] === 0) this.used++;
    if (score > MATE_IN_MAX) score += ply; else if (score < -MATE_IN_MAX) score -= ply;
    this.keys[i] = pos.hashHi;
    this.moves[i] = move || (same ? this.moves[i] : 0);
    this.scores[i] = score;
    this.evals[i] = staticEval;
    this.depths[i] = depth < 0 ? 0 : depth;
    this.flags[i] = flag | (this.age << 2);
  }

  /* Score from the table, adjusted for the distance from the root. */
  scoreAt(i, ply) {
    const s = this.scores[i];
    if (s > MATE_IN_MAX) return s - ply;
    if (s < -MATE_IN_MAX) return s + ply;
    return s;
  }

  hashfull() { return Math.min(1000, Math.round(this.used * 1000 / this.size)); }
}

/* ================================================================
   S7  SEARCH
   ================================================================

   The search is a textbook alpha-beta in the "principal variation
   search" form, driven by iterative deepening: search to depth 1,
   then 2, then 3 ... until time runs out. Each iteration seeds the
   next with the transposition table and the move ordering tables, so
   the deeper searches are far cheaper than they would be cold.

   Ingredients, in the order they appear in search():
     - draw detection (repetition, fifty moves, bare material)
     - mate distance pruning
     - transposition table cut-offs
     - reverse futility pruning   "we are so far ahead a quiet move
                                   cannot lose this node"
     - null move pruning          "even passing keeps us above beta"
     - internal iterative reduction when the table has no move for us
     - move ordering: table move, captures by value (MVV-LVA),
       promotions, killer moves, counter move, history
     - late move pruning and futility pruning of hopeless quiet moves
     - check extension
     - late move reductions, re-searching when a reduced move surprises
     - killer / history / counter-move updates on a cut-off

   Scores: centipawns, with mate in N encoded as MATE - N. INFINITE is
   outside every legal score.
*/

const INFINITE = 32000, MATE = 31000, MATE_IN_MAX = MATE - MAX_PLY;
const MAX_DEPTH = 100;

const LMR_TABLE = [];
for (let d = 0; d < 64; d++) {
  LMR_TABLE.push(new Int8Array(64));
  for (let m = 0; m < 64; m++) LMR_TABLE[d][m] = d === 0 || m === 0 ? 0 : Math.floor(0.75 + Math.log(d) * Math.log(m) / 2.25);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* Yield to the event loop between iterations so that "stop", "quit"
   and "isready" typed during a search are seen. Inside an iteration
   the search is synchronous, so a stop takes effect at the end of the
   current depth (or when the hard time limit trips). */
const yieldToEventLoop = () => new Promise(resolve =>
  (typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)));
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

class Search {
  constructor(pos, tt, send) {
    this.pos = pos; this.tt = tt; this.send = send;
    this.moveStack = new Int32Array(MAX_PLY * 256);
    this.scoreStack = new Int32Array(MAX_PLY * 256);
    this.quietStack = new Int32Array(MAX_PLY * 64);
    this.killers = new Int32Array(MAX_PLY * 2);
    this.history = new Int32Array(2 * 64 * 64);
    this.counterMoves = new Int32Array(16 * 64);
    this.moveAtPly = new Int32Array(MAX_PLY);
    this.staticEvals = new Int32Array(MAX_PLY);
    this.pvTable = new Int32Array(MAX_PLY * MAX_PLY);
    this.pvLength = new Int32Array(MAX_PLY);
    this.excludedRootMoves = [];
    this.nodes = 0; this.seldepth = 0;
    this.stopped = false; this.stopRequested = false; this.running = false;
    this.hardTime = Infinity; this.nodeLimit = Infinity; this.allowStop = true;
    this.qsMaxPly = MAX_PLY;        // the skill estimator caps quiescence depth
    this.silent = false;
  }

  clearHistory() {
    this.killers.fill(0); this.history.fill(0); this.counterMoves.fill(0);
  }

  checkLimits() {
    if ((this.nodes & 1023) === 0 && this.allowStop) {
      if (this.nodes >= this.nodeLimit || now() >= this.hardTime) this.stopped = true;
    }
  }

  /* ---- Quiescence: resolve captures so that we never evaluate a
     position in the middle of an exchange. In check, all moves are
     tried (there is no standing pat when the king is attacked). */
  qsearch(alpha, beta, ply) {
    this.nodes++;
    this.checkLimits();
    if (ply > this.seldepth) this.seldepth = ply;
    const pos = this.pos;
    if (ply >= MAX_PLY - 1 || ply >= this.qsMaxPly) return evaluate(pos);
    const inCheck = pos.inCheck();
    let best = -INFINITE;
    if (!inCheck) {
      best = evaluate(pos);
      if (best >= beta) return best;
      if (best > alpha) alpha = best;
    }
    const base = ply * 256;
    const moves = this.moveStack, scores = this.scoreStack;
    const n = generateMoves(pos, moves, base, !inCheck);
    for (let i = base; i < n; i++) scores[i] = this.captureScore(moves[i]);
    for (let i = base; i < n; i++) {
      this.pickNext(i, n);
      const m = moves[i];
      if (!inCheck) {
        // delta pruning: even winning this piece cannot lift us to alpha
        const victim = moveFlag(m) === FLAG_EP ? PAWN : typeOf(pos.board[moveTo(m)]);
        if (!movePromo(m) && best + PIECE_VALUE[victim] + 200 <= alpha) continue;
      }
      if (!pos.make(m)) continue;
      const score = -this.qsearch(-beta, -alpha, ply + 1);
      pos.unmake();
      if (this.stopped) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) { alpha = score; if (alpha >= beta) break; }
      }
    }
    if (inCheck && best === -INFINITE) return -MATE + ply;
    return best;
  }

  /* ---- Move ordering helpers ------------------------------------- */
  captureScore(m) {
    const pos = this.pos;
    const promo = movePromo(m);
    const victim = moveFlag(m) === FLAG_EP ? PAWN : typeOf(pos.board[moveTo(m)]);
    const attacker = typeOf(pos.board[moveFrom(m)]);
    let s = 1000000 + PIECE_VALUE[victim] * 16 - attacker;
    if (promo) s += promo === QUEEN ? 20000 : -5000;
    return s;
  }

  scoreMoves(base, n, ply, ttMove) {
    const pos = this.pos, moves = this.moveStack, scores = this.scoreStack;
    const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
    const prev = ply > 0 ? this.moveAtPly[ply - 1] : NO_MOVE;
    const counter = prev ? this.counterMoves[pos.board[moveTo(prev)] * 64 + moveTo(prev)] : NO_MOVE;
    const histBase = (pos.side >> 3) * 4096;
    for (let i = base; i < n; i++) {
      const m = moves[i];
      if (m === ttMove) scores[i] = 1 << 30;
      else if (pos.board[moveTo(m)] !== EMPTY || moveFlag(m) === FLAG_EP || movePromo(m)) scores[i] = this.captureScore(m);
      else if (m === k1) scores[i] = 900000;
      else if (m === k2) scores[i] = 800000;
      else if (m === counter) scores[i] = 700000;
      else scores[i] = this.history[histBase + (m & 4095)];
    }
  }

  /* Swap the best-scored remaining move into slot i (selection sort,
     one step at a time: most nodes cut off after a move or two). */
  pickNext(i, n) {
    const moves = this.moveStack, scores = this.scoreStack;
    let best = i;
    for (let j = i + 1; j < n; j++) if (scores[j] > scores[best]) best = j;
    if (best !== i) {
      const m = moves[i], s = scores[i];
      moves[i] = moves[best]; scores[i] = scores[best];
      moves[best] = m; scores[best] = s;
    }
  }

  updateHistory(idx, bonus) {
    const h = this.history;
    const clamped = Math.max(-400, Math.min(400, bonus));
    h[idx] += clamped * 32 - ((h[idx] * Math.abs(clamped)) >> 9);   // saturates around +-16384
  }

  hasLegalMove(ply) {
    const base = ply * 256, n = generateMoves(this.pos, this.moveStack, base, false);
    for (let i = base; i < n; i++) if (this.pos.make(this.moveStack[i])) { this.pos.unmake(); return true; }
    return false;
  }

  /* ---- The main alpha-beta search ------------------------------- */
  search(depth, alpha, beta, ply, pvNode) {
    const pos = this.pos;
    this.pvLength[ply] = ply;
    if (this.stopped) return 0;
    const root = ply === 0;

    const inCheck = pos.inCheck();
    if (!root) {
      if (pos.isRepetition() || pos.insufficientMaterial()) return 0;
      // fifty-move rule: a draw unless this very position is checkmate
      if (pos.halfmove >= 100 && (!inCheck || this.hasLegalMove(ply))) return 0;
      // mate distance pruning
      if (alpha < -MATE + ply) alpha = -MATE + ply;
      if (beta > MATE - ply - 1) beta = MATE - ply - 1;
      if (alpha >= beta) return alpha;
    }
    if (ply >= MAX_PLY - 1) return evaluate(pos);
    if (depth <= 0) return this.qsearch(alpha, beta, ply);

    this.nodes++;
    this.checkLimits();
    if (ply > this.seldepth) this.seldepth = ply;

    // transposition table
    const tt = this.tt;
    const ttIdx = tt.probe(pos);
    let ttMove = NO_MOVE, ttFlag = 0, ttScore = 0;
    if (ttIdx >= 0) {
      ttMove = tt.moves[ttIdx];
      ttFlag = tt.flags[ttIdx] & 3;
      ttScore = tt.scoreAt(ttIdx, ply);
      if (!pvNode && tt.depths[ttIdx] >= depth) {
        if (ttFlag === TT_EXACT || (ttFlag === TT_LOWER && ttScore >= beta) || (ttFlag === TT_UPPER && ttScore <= alpha)) return ttScore;
      }
    }

    const staticEval = inCheck ? -INFINITE : (ttIdx >= 0 ? tt.evals[ttIdx] : evaluate(pos));
    this.staticEvals[ply] = staticEval;
    const improving = !inCheck && ply >= 2 && staticEval > this.staticEvals[ply - 2];

    if (!pvNode && !inCheck && Math.abs(beta) < MATE_IN_MAX) {
      // reverse futility pruning
      if (depth <= 8 && staticEval - 80 * depth + (improving ? 40 : 0) >= beta) return staticEval;

      // null move pruning
      if (depth >= 3 && staticEval >= beta && this.moveAtPly[ply - 1] !== NO_MOVE && hasNonPawnMaterial(pos, pos.side) &&
          !(ttIdx >= 0 && ttFlag === TT_UPPER && ttScore < beta)) {
        const R = 3 + (depth >> 2) + Math.min(3, ((staticEval - beta) / 200) | 0);
        pos.makeNull();
        this.moveAtPly[ply] = NO_MOVE;
        const score = -this.search(depth - 1 - R, -beta, -beta + 1, ply + 1, false);
        pos.unmakeNull();
        if (this.stopped) return 0;
        if (score >= beta) return score >= MATE_IN_MAX ? beta : score;
      }
    }

    // internal iterative reduction: no table move means a poorly ordered node
    if (depth >= 4 && ttMove === NO_MOVE) depth--;

    const base = ply * 256;
    const moves = this.moveStack;
    const n = generateMoves(pos, moves, base, false);
    this.scoreMoves(base, n, ply, ttMove);

    let bestScore = -INFINITE, bestMove = NO_MOVE, legal = 0, quiets = 0;
    const quietBase = ply * 64;
    const lmpLimit = (3 + depth * depth) >> (improving ? 0 : 1);
    const histBase = (pos.side >> 3) * 4096;

    for (let i = base; i < n; i++) {
      this.pickNext(i, n);
      const m = moves[i];
      if (root && this.excludedRootMoves.includes(m)) continue;
      const isCapture = pos.board[moveTo(m)] !== EMPTY || moveFlag(m) === FLAG_EP;
      const isQuiet = !isCapture && movePromo(m) === 0;

      if (!root && !pvNode && !inCheck && isQuiet && bestScore > -MATE_IN_MAX) {
        if (depth <= 8 && quiets >= lmpLimit) continue;                                  // late move pruning
        if (depth <= 8 && staticEval + 100 + 90 * depth <= alpha) continue;              // futility pruning
      }

      if (!pos.make(m)) continue;
      legal++;
      this.moveAtPly[ply] = m;
      const givesCheck = pos.inCheck();
      const newDepth = depth - 1 + (givesCheck ? 1 : 0);
      let score;

      if (legal === 1) {
        score = -this.search(newDepth, -beta, -alpha, ply + 1, pvNode);
      } else {
        let R = 0;
        if (depth >= 3 && isQuiet && legal >= (pvNode ? 4 : 2)) {
          R = LMR_TABLE[Math.min(depth, 63)][Math.min(legal, 63)];
          if (pvNode) R--;
          if (!improving) R++;
          if (givesCheck) R--;
          if (this.scoreStack[i] >= 700000) R--;             // killer or counter move
          R -= Math.max(-2, Math.min(2, (this.history[histBase + (m & 4095)] / 6000) | 0));
          if (R < 0) R = 0;
          if (R > newDepth - 1) R = Math.max(0, newDepth - 1);
        }
        score = -this.search(newDepth - R, -alpha - 1, -alpha, ply + 1, false);
        if (R > 0 && score > alpha && !this.stopped) score = -this.search(newDepth, -alpha - 1, -alpha, ply + 1, false);
        if (pvNode && score > alpha && score < beta && !this.stopped) score = -this.search(newDepth, -beta, -alpha, ply + 1, true);
      }
      pos.unmake();
      if (this.stopped) return 0;

      if (score > bestScore) {
        bestScore = score;
        if (score > alpha) {
          bestMove = m;
          alpha = score;
          // extend the principal variation
          const pv = this.pvTable, len = this.pvLength[ply + 1];
          pv[ply * MAX_PLY + ply] = m;
          for (let k = ply + 1; k < len; k++) pv[ply * MAX_PLY + k] = pv[(ply + 1) * MAX_PLY + k];
          this.pvLength[ply] = len > ply + 1 ? len : ply + 1;
          if (alpha >= beta) {
            if (isQuiet) {
              if (this.killers[ply * 2] !== m) { this.killers[ply * 2 + 1] = this.killers[ply * 2]; this.killers[ply * 2] = m; }
              const bonus = depth * depth;
              this.updateHistory(histBase + (m & 4095), bonus);
              for (let q = 0; q < quiets; q++) this.updateHistory(histBase + (this.quietStack[quietBase + q] & 4095), -bonus);
              const prev = ply > 0 ? this.moveAtPly[ply - 1] : NO_MOVE;
              if (prev) this.counterMoves[pos.board[moveTo(prev)] * 64 + moveTo(prev)] = m;
            }
            break;
          }
        }
      }
      if (isQuiet && quiets < 64) this.quietStack[quietBase + quiets++] = m;
    }

    if (legal === 0) {
      if (root && this.excludedRootMoves.length) return -INFINITE;    // only excluded moves were legal
      return inCheck ? -MATE + ply : 0;
    }
    const flag = bestScore >= beta ? TT_LOWER : bestMove ? TT_EXACT : TT_UPPER;
    tt.store(pos, bestMove, bestScore, staticEval, depth, flag, ply);
    return bestScore;
  }

  /* ---- Iterative deepening -----------------------------------------
     limits: { depth, nodes, movetime, wtime, btime, winc, binc,
               movestogo, infinite, multiPV }
     Resolves to { moves: [...], scores: [...], pvs: [[...]] } sorted
     best first, one entry per principal variation. */
  async iterativeDeepening(limits) {
    const pos = this.pos;
    this.running = true; this.stopped = false; this.stopRequested = false;
    this.nodes = 0; this.seldepth = 0;
    this.startTime = now();
    this.excludedRootMoves = [];
    this.moveAtPly.fill(NO_MOVE);
    this.tt.newSearch();
    this.killers.fill(0);
    for (let i = 0; i < this.history.length; i++) this.history[i] >>= 1;    // soften, keep what we learned

    // time management
    let soft = Infinity, hard = Infinity;
    const overhead = 20;
    if (limits.movetime !== undefined) { soft = hard = Math.max(1, limits.movetime - overhead); }
    else if (limits.wtime !== undefined || limits.btime !== undefined) {
      const time = (pos.side === WHITE ? limits.wtime : limits.btime) || 0;
      const inc = (pos.side === WHITE ? limits.winc : limits.binc) || 0;
      const mtg = limits.movestogo ? Math.min(limits.movestogo, 40) : 30;
      const usable = Math.max(1, time - overhead);
      soft = Math.min(usable * 0.8, usable / mtg + inc * 0.75);
      hard = Math.min(usable * 0.8, soft * 4);
    }
    if (limits.timeScale) soft *= limits.timeScale;      // leave room for the extra lines below
    this.hardTime = this.startTime + hard;
    this.nodeLimit = limits.nodes || Infinity;
    const maxDepth = Math.min(limits.depth || MAX_DEPTH, MAX_DEPTH);

    const rootMoves = pos.legalMoves();
    const multiPV = Math.max(1, Math.min(limits.multiPV || 1, rootMoves.length));
    const result = { moves: [], scores: [], pvs: [], depths: [], depth: 0 };
    if (rootMoves.length === 0) { this.running = false; return result; }

    let lastScores = [];
    for (let depth = 1; depth <= maxDepth; depth++) {
      const iterMoves = [], iterScores = [], iterPvs = [];
      this.excludedRootMoves = [];
      let aborted = false;
      for (let pvIdx = 0; pvIdx < multiPV; pvIdx++) {
        this.allowStop = depth > 1 || pvIdx > 0;     // we must own at least one move before stopping
        let alpha = -INFINITE, beta = INFINITE, delta = 25;
        if (depth >= 5 && pvIdx < lastScores.length) {
          alpha = Math.max(-INFINITE, lastScores[pvIdx] - delta);
          beta = Math.min(INFINITE, lastScores[pvIdx] + delta);
        }
        let score;
        for (;;) {
          this.seldepth = 0;
          score = this.search(depth, alpha, beta, 0, true);
          if (this.stopped) break;
          if (score <= alpha) { beta = ((alpha + beta) / 2) | 0; alpha = Math.max(-INFINITE, score - delta); }
          else if (score >= beta) { beta = Math.min(INFINITE, score + delta); }
          else break;
          delta += delta >> 1;
        }
        if (this.stopped) { aborted = true; break; }
        const len = this.pvLength[0];
        const pv = [];
        for (let k = 0; k < len; k++) pv.push(this.pvTable[k]);
        if (pv.length === 0) break;   // nothing left to search (fewer legal moves than requested lines)
        iterMoves.push(pv[0]); iterScores.push(score); iterPvs.push(pv);
        this.excludedRootMoves.push(pv[0]);
      }
      if (iterMoves.length) {
        // sort lines best first, then report
        const order = iterMoves.map((_, i) => i).sort((a, b) => iterScores[b] - iterScores[a]);
        result.moves = order.map(i => iterMoves[i]);
        result.scores = order.map(i => iterScores[i]);
        result.pvs = order.map(i => iterPvs[i]);
        result.depths = order.map(() => depth);
        result.depth = depth;
        lastScores = result.scores;
        if (!this.silent) this.report(depth, result, limits.reportLines || multiPV);
      }
      if (aborted || this.stopRequested) break;
      if (depth >= maxDepth) break;
      const elapsed = now() - this.startTime;
      if (elapsed >= soft) break;
      if (!limits.infinite && Math.abs(result.scores[0]) >= MATE_IN_MAX && depth >= 8 && multiPV === 1) break;
      await yieldToEventLoop();
      if (this.stopRequested) break;
    }
    if (limits.extraLines && result.moves.length > 0 && !this.stopRequested) this.searchExtraLines(result, limits.extraLines, soft);
    // "go infinite" must wait for "stop" even when the search ran out of depth
    while (limits.infinite && !this.stopRequested) await sleepMs(5);
    this.running = false;
    return result;
  }

  /* Skill mode: the main search ran as a normal single line search. Now
     give the next few root moves scores of their own, two plies shallower
     and within a small extra time slice, so the skill logic can compare
     them with the best move. This keeps the skill levels' main search as
     deep as full strength, so the top of the ladder is set by the budget
     and not by the cost of a five-line search. */
  searchExtraLines(result, count, soft) {
    const depth = Math.max(1, result.depth - 2);
    this.excludedRootMoves = [result.moves[0]];
    this.allowStop = true;
    this.hardTime = Math.min(this.hardTime, now() + Math.max(2, soft * 0.6));
    for (let i = 0; i < count && result.moves.length < this.pos.legalMoves().length; i++) {
      const score = this.search(depth, -INFINITE, INFINITE, 0, true);
      if (this.stopped) break;
      const len = this.pvLength[0];
      if (len === 0) break;
      const pv = [];
      for (let k = 0; k < len; k++) pv.push(this.pvTable[k]);
      result.moves.push(pv[0]); result.scores.push(score); result.pvs.push(pv); result.depths.push(depth);
      this.excludedRootMoves.push(pv[0]);
    }
    this.excludedRootMoves = [];
    this.stopped = false;
  }

  report(depth, result, lines) {
    const elapsed = Math.max(1, Math.round(now() - this.startTime));
    const nps = Math.round(this.nodes * 1000 / elapsed);
    for (let i = 0; i < Math.min(lines, result.moves.length); i++) {
      const s = result.scores[i];
      const score = s >= MATE_IN_MAX ? 'mate ' + Math.ceil((MATE - s) / 2) : s <= -MATE_IN_MAX ? 'mate -' + Math.ceil((MATE + s) / 2) : 'cp ' + s;
      const pv = result.pvs[i].map(m => this.pos.moveToUci(m)).join(' ');
      if (result.depths && result.depths[i]) depth = result.depths[i];
      this.send(`info depth ${depth} seldepth ${this.seldepth} multipv ${i + 1} score ${score} nodes ${this.nodes} nps ${nps} hashfull ${this.tt.hashfull()} time ${elapsed} pv ${pv}`);
    }
  }
}

/* ================================================================
   S8  SKILL LEVELS
   ================================================================

   Skill_Level 0 plays a random legal move, except that it always
   delivers checkmate in one when it can. Skill_Level N (the maximum)
   is the engine at full strength. Every level in between searches at
   full strength and then deliberately picks a weaker move, using a
   budget of centipawns it is allowed to throw away per 40 moves.
   Nothing else changes with the level: not the depth, not the node
   count, not the time, so a level plays the same at any time control.

   How a move is chosen:
     1. Search with MultiPV 5: the top five moves get exact scores.
        Every other legal move gets a cheap estimate (a quiescence
        search after the move), floored at the loss of the fifth move,
        so a move outside the top five is never rated better than one
        inside it.
     2. The "loss" of a move is best score minus that move's score.
     3. Each move the allowance BUDGET/40 is added to an accumulator
        (capped at the whole 40-move budget). We pick, uniformly at
        random, one of the moves whose loss fits in the accumulator and
        pay its loss from it. So a weak level sprays inaccuracies and
        the odd big blunder, then plays carefully while it recovers.
     4. When the best move wins by force (a mate score) we just play it.

   With an unlimited budget this is exactly the random mover of level 0,
   with a zero budget it is the best move, and in between strength grows
   smoothly as the budget shrinks. The table below is the only strength
   knob and was tuned with fastchess matches (see the COLOPHON).
*/

const SKILL_BUDGET_PER_40_MOVES = [
  Infinity,  // level 0: random moves (handled separately)
  40000, 20000, 10000, 5000, 2400, 1200, 600, 320, 160, 80, 40, 16,
  0,         // top level: full strength
];
const MAX_SKILL = SKILL_BUDGET_PER_40_MOVES.length - 1;
const MIN_UNSEARCHED_LOSS = 20;   // centipawns; a move outside the searched lines is never rated closer than this

class SkillState {
  constructor() { this.reset(); }
  reset() { this.accumulated = -1; this.lastLoss = 0; }   // -1: not yet started
}

function isMateInOne(pos, move) {
  if (!pos.make(move)) return false;
  let mate = false;
  if (pos.inCheck()) {
    const list = new Int32Array(256);
    const n = generateMoves(pos, list, 0, false);
    mate = true;
    for (let i = 0; i < n && mate; i++) if (pos.make(list[i])) { pos.unmake(); mate = false; }
  }
  pos.unmake();
  return mate;
}

/* Level 0: a random legal move, or mate in one if available. */
function randomMove(pos, rng) {
  const moves = pos.legalMoves();
  if (moves.length === 0) return NO_MOVE;
  for (const m of moves) if (isMateInOne(pos, m)) return m;
  return moves[rng.below(moves.length)];
}

/* Levels 1..N-1: pick from the search result using the budget. */
function chooseSkillMove(search, result, level, state, rng) {
  const pos = search.pos;
  const budget = SKILL_BUDGET_PER_40_MOVES[level];
  const perMove = budget / 40;
  if (state.accumulated < 0) state.accumulated = perMove;
  else state.accumulated = Math.min(budget, state.accumulated + perMove);

  const best = result.scores[0];
  if (best >= MATE_IN_MAX) return result.moves[0];        // never spoil a forced mate

  // Candidate list: searched lines first. The extra lines were searched a
  // little shallower than the best move, so a line is never rated better
  // than the best move (its loss is at least 1).
  const candidates = [];
  let worstSearched = 0;
  for (let i = 0; i < result.moves.length; i++) {
    const loss = i === 0 ? 0 : Math.max(1, best - result.scores[i]);
    candidates.push({ move: result.moves[i], loss });
    if (loss > worstSearched) worstSearched = loss;
  }
  // An unsearched move is at best as good as the worst searched line, and
  // never better than a small fixed loss: a cheap estimate is no proof.
  worstSearched = Math.max(worstSearched, MIN_UNSEARCHED_LOSS);
  // Estimates for the unsearched moves: a quiescence search a few plies deep
  // (enough to see a hanging piece) with a window covering only the range
  // between "as bad as the worst searched move" and "just unaffordable".
  // A node cap protects the clock in wild positions; moves it cuts off get a
  // one-ply static estimate instead of being left out, so the candidate set
  // never depends on move generation order.
  const searched = new Set(result.moves);
  const alpha = Math.max(-INFINITE + 1, best - Math.floor(state.accumulated) - 1);
  const beta = Math.min(INFINITE - 1, best - worstSearched + 1);
  if (alpha < beta) {
    search.stopped = false;
    search.allowStop = true;
    search.hardTime = Math.max(search.hardTime, now() + 30);
    search.nodeLimit = search.nodes + Math.max(4000, Math.min(40000, search.nodes * 0.25));
    search.qsMaxPly = 1 + 4;
    for (const m of pos.legalMoves()) {
      if (searched.has(m)) continue;
      if (!pos.make(m)) continue;
      let est;
      if (search.stopped) est = -evaluate(pos);
      else {
        est = -search.qsearch(-beta, -alpha, 1);
        if (search.stopped) est = -evaluate(pos);
      }
      pos.unmake();
      if (est <= alpha) continue;                          // costs more than we may spend
      candidates.push({ move: m, loss: Math.max(worstSearched, best - est) });
    }
    search.qsMaxPly = MAX_PLY;
    search.stopped = false;
  }

  // Every affordable move is equally likely. A weak player does not hunt
  // for the worst move; they fail to tell the good moves from the bad ones
  // within their tolerance. With an unlimited budget this is the random
  // mover of level 0; with a zero budget it is the best move.
  const affordable = candidates.filter(c => c.loss <= state.accumulated);
  const pick = affordable.length ? affordable[rng.below(affordable.length)] : candidates[0];
  state.accumulated -= Math.max(0, pick.loss);
  state.lastLoss = Math.max(0, pick.loss);
  return pick.move;
}

/* ================================================================
   S9  UCI & BENCHMARKS
   ================================================================

   The Engine class owns a position, a transposition table and a
   search, and turns UCI text commands into actions. It is independent
   of where the text comes from: stdin in Bun/Node, postMessage in a
   Web Worker, or direct calls from a web page.
*/

const ENGINE_NAME = 'OGE 1.0';
const ENGINE_AUTHOR = 'Wilfredo';

class Engine {
  constructor(send) {
    this.send = send || (s => console.log(s));
    this.pos = new Position();
    this.tt = new TranspositionTable(16);
    this.search = new Search(this.pos, this.tt, this.send);
    this.options = { hash: 16, threads: 1, multiPV: 1, skill: MAX_SKILL, chess960: false };
    this.skill = new SkillState();
    this.rng = new Random((Date.now() ^ (Math.random() * 0x7fffffff)) | 0);
    this.lastMoveCount = -1;
    this.quitRequested = false;
    this.onQuit = null;
    this.pending = [];              // commands received while a search is running
    this.positionInvalid = false;
  }

  /* Commands that arrive during a search are queued until the search has
     answered, except the few that must be handled at once. An error in a
     command becomes an "info string" instead of killing the process. */
  async command(line) {
    const cmd = line.trim().split(/\s+/)[0];
    const immediate = cmd === 'stop' || cmd === 'isready' || cmd === 'quit' || cmd === 'uci' || cmd === '';
    if (this.search.running && !immediate) { this.pending.push(line); return; }
    await this.execute(line);
    while (!this.search.running && this.pending.length) await this.execute(this.pending.shift());
  }

  async execute(line) {
    try { await this.dispatch(line); }
    catch (e) { this.send(`info string error: ${e && e.message ? e.message : e}`); }
  }

  async dispatch(line) {
    const tokens = line.trim().split(/\s+/);
    const cmd = tokens[0];
    switch (cmd) {
      case 'uci':
        this.send(`id name ${ENGINE_NAME}`);
        this.send(`id author ${ENGINE_AUTHOR}`);
        this.send('option name Hash type spin default 16 min 1 max 1024');
        this.send('option name Threads type spin default 1 min 1 max 1');
        this.send('option name MultiPV type spin default 1 min 1 max 5');
        this.send(`option name Skill_Level type spin default ${MAX_SKILL} min 0 max ${MAX_SKILL}`);
        this.send('option name UCI_Chess960 type check default false');
        this.send('uciok');
        break;
      case 'isready': this.send('readyok'); break;
      case 'ucinewgame': this.newGame(); break;
      case 'setoption': this.setOption(tokens); break;
      case 'position': this.setPosition(tokens); break;
      case 'go': await this.go(tokens); break;
      case 'stop': this.search.stopRequested = true; if (this.search.running) this.search.stopped = true; break;
      case 'quit': this.search.stopRequested = true; this.quitRequested = true; if (!this.search.running && this.onQuit) this.onQuit(); break;
      case 'bench': await this.bench(parseInt(tokens[1], 10) || 10); break;
      case 'perft': this.perft(parseInt(tokens[1], 10) || 5); break;
      case 'd': case 'display': this.send(this.pos.toString()); break;
      case 'eval': this.send(`static eval: ${evaluate(this.pos)} cp (side to move)`); break;
      case '': break;
      default: this.send(`info string unknown command: ${line.trim()}`);
    }
  }

  newGame() {
    this.tt.clear();
    this.search.clearHistory();
    this.skill.reset();
    this.lastMoveCount = -1;
  }

  setOption(tokens) {
    const nameIdx = tokens.indexOf('name'), valueIdx = tokens.indexOf('value');
    if (nameIdx < 0) return;
    const name = tokens.slice(nameIdx + 1, valueIdx > 0 ? valueIdx : undefined).join(' ').toLowerCase();
    const value = valueIdx > 0 ? tokens.slice(valueIdx + 1).join(' ') : '';
    const int = parseInt(value, 10);
    switch (name) {
      case 'hash': this.options.hash = Math.max(1, Math.min(1024, int || 16)); this.tt.resize(this.options.hash); break;
      case 'threads': this.options.threads = 1; break;                    // always single-threaded
      case 'multipv': this.options.multiPV = Math.max(1, Math.min(5, int || 1)); break;
      case 'skill_level': this.options.skill = Math.max(0, Math.min(MAX_SKILL, isNaN(int) ? MAX_SKILL : int)); break;
      case 'uci_chess960': this.options.chess960 = this.pos.chess960 = value.toLowerCase() === 'true'; break;
    }
  }

  setPosition(tokens) {
    let i = 1, fen = START_FEN;
    if (tokens[i] === 'startpos') i++;
    else if (tokens[i] === 'fen') { i++; const parts = []; while (i < tokens.length && tokens[i] !== 'moves') parts.push(tokens[i++]); fen = parts.join(' '); }
    this.positionInvalid = false;
    this.pos.setFen(fen);
    this.pos.chess960 = this.options.chess960;
    let count = 0;
    if (tokens[i] === 'moves') {
      for (i++; i < tokens.length; i++) {
        const m = this.pos.parseMove(tokens[i]);
        if (m === NO_MOVE) { this.send(`info string illegal move: ${tokens[i]}`); this.positionInvalid = true; break; }
        this.pos.make(m); this.pos.gamePly++; count++;
      }
    }
    // A shorter move list than last time means a new game started without ucinewgame.
    if (count < this.lastMoveCount) this.skill.reset();
    this.lastMoveCount = count;
  }

  parseGo(tokens) {
    const limits = {};
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i], v = parseInt(tokens[i + 1], 10);
      if (t === 'infinite') limits.infinite = true;
      else if (['depth', 'nodes', 'movetime', 'wtime', 'btime', 'winc', 'binc', 'movestogo'].includes(t) && !isNaN(v)) { limits[t] = v; i++; }
    }
    return limits;
  }

  async go(tokens) {
    if (this.search.running) return;
    const limits = this.parseGo(tokens);
    const pos = this.pos, level = this.options.skill;
    this.search.startTime = now();

    if (this.positionInvalid || pos.legalMoves().length === 0) { this.send('info depth 0 score cp 0'); this.send('bestmove 0000'); return; }

    let bestMove, ponder = NO_MOVE;
    if (level === 0) {
      bestMove = randomMove(pos, this.rng);
      const mate = isMateInOne(pos, bestMove);
      this.send(`info depth 1 seldepth 1 multipv 1 score ${mate ? 'mate 1' : 'cp 0'} nodes 1 nps 1 time 0 pv ${pos.moveToUci(bestMove)}`);
    } else if (level < MAX_SKILL) {
      limits.multiPV = 1;
      limits.extraLines = 4;          // the top five moves get searched scores
      limits.timeScale = 0.7;
      const result = await this.search.iterativeDeepening(limits);
      if (this.options.multiPV > 1) this.search.report(result.depth, result, this.options.multiPV);
      bestMove = chooseSkillMove(this.search, result, level, this.skill, this.rng);
      this.reportChosen(result, bestMove);
    } else {
      limits.multiPV = this.options.multiPV;
      const result = await this.search.iterativeDeepening(limits);
      bestMove = result.moves[0];
      if (result.pvs[0] && result.pvs[0].length > 1) ponder = result.pvs[0][1];
    }
    this.send('bestmove ' + pos.moveToUci(bestMove) + (ponder ? ' ponder ' + this.ponderString(bestMove, ponder) : ''));
    if (this.quitRequested && this.onQuit) this.onQuit();
  }

  /* After a skill-limited choice, print one more info line whose PV starts
     with the move we are about to play, with the score of that move. */
  reportChosen(result, move) {
    const idx = result.moves.indexOf(move);
    const s = idx >= 0 ? result.scores[idx] : (result.scores[0] - (this.skill.lastLoss || 0));
    const score = s >= MATE_IN_MAX ? 'mate ' + Math.ceil((MATE - s) / 2) : s <= -MATE_IN_MAX ? 'mate -' + Math.ceil((MATE + s) / 2) : 'cp ' + s;
    const pv = idx >= 0 ? result.pvs[idx].map(m => this.pos.moveToUci(m)).join(' ') : this.pos.moveToUci(move);
    const elapsed = Math.max(1, Math.round(now() - this.search.startTime));
    this.send(`info depth ${result.depth} seldepth ${this.search.seldepth} multipv 1 score ${score} nodes ${this.search.nodes} nps ${Math.round(this.search.nodes * 1000 / elapsed)} hashfull ${this.tt.hashfull()} time ${elapsed} pv ${pv}`);
  }

  ponderString(best, ponder) {
    if (!this.pos.make(best)) return '';
    const s = this.pos.moveToUci(ponder);
    this.pos.unmake();
    return s;
  }

  perft(depth) {
    const t0 = now();
    const nodes = perft(this.pos, depth);
    const ms = Math.max(1, now() - t0);
    this.send(`perft ${depth}: ${nodes} nodes in ${Math.round(ms)} ms (${Math.round(nodes / ms)} knps)`);
  }

  /* OpenBench benchmark: fixed-depth search of a set of positions.
     The last line, "<nodes> nodes <nps> nps", is what OpenBench reads. */
  async bench(depth) {
    const saved = { fen: this.pos.fen(), chess960: this.pos.chess960, skill: this.options.skill };
    this.options.skill = MAX_SKILL;
    this.tt.clear(); this.search.clearHistory();
    let nodes = 0;
    const t0 = now();
    this.search.silent = true;
    for (const fen of BENCH_POSITIONS) {
      this.pos.chess960 = false;
      this.pos.setFen(fen);
      this.skill.reset();
      const result = await this.search.iterativeDeepening({ depth, multiPV: 1 });
      nodes += this.search.nodes;
      this.send(`${fen.padEnd(72)} depth ${depth} bestmove ${this.pos.moveToUci(result.moves[0]).padEnd(6)} nodes ${this.search.nodes}`);
    }
    this.search.silent = false;
    const ms = Math.max(1, now() - t0);
    this.send(`${nodes} nodes ${Math.round(nodes * 1000 / ms)} nps`);
    this.pos.chess960 = saved.chess960; this.pos.setFen(saved.fen); this.options.skill = saved.skill;
  }
}

const BENCH_POSITIONS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
  'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
  'r2q1rk1/ppp2ppp/2n1bn2/2b1p3/3pP3/3P1NP1/PPP1NPBP/R1BQR1K1 b - - 1 10',
  '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pPp3/2P5/PPB4P/R2Q1RK1 w - - 0 1',
  'r1bq1r1k/1pp1Np1p/p2p2pB/8/4P3/2N5/PPP2PPP/R2QK1R1 b - - 0 1',
  '6k1/5p2/6p1/8/7p/8/6PP/6K1 b - - 0 1',
  '8/8/1p1r1k2/p1pPN1p1/P3P1P1/1P2Pp2/1P2P3/5K2 b - - 0 1',
  '4rrk1/pp1n3p/3q2pQ/2p1pb2/P1P2b2/6P1/1P2P1P1/4RRK1 w - - 0 1',
  '1r3k2/4q3/2Pp3b/3Bp3/2Q2p2/1p1P2P1/1P2KP2/3N4 w - - 0 1',
  '3r1k2/4npp1/1ppr3p/p6P/P2PPPP1/1NR5/5K2/2R5 w - - 0 1',
  'r1bqk2r/pp2bppp/2p5/3pP3/P2Q1P2/2N1B3/1PP3PP/R4RK1 b kq - 0 1',
  '2kr1bnr/pbpq4/2n1pp2/3p3p/3P1P1B/2N2N1Q/1PP3PP/R3KR2 b - - 0 1',
  '8/8/8/8/5kp1/P7/8/1K1N4 w - - 0 1',
  '3q2k1/pb3p1p/4pbp1/2r5/PpN2N2/1P2P2P/5PP1/Q2R2K1 b - - 0 1',
  'r2qnrnk/p2b2b1/1p1p2pp/2pPpp2/1PP1P3/PRNBB3/3QNPPP/5RK1 w - - 0 1',
];

/* ---- Entry points ----------------------------------------------- */

const isWorker = typeof importScripts === 'function' && typeof document === 'undefined';
const isBrowserPage = typeof document !== 'undefined';
const isMain = typeof require === 'undefined' || typeof module === 'undefined' || require.main === module;
const isCli = !isWorker && !isBrowserPage && isMain && typeof process !== 'undefined' && process.stdin && process.stdout;

// Always expose the building blocks, so a web page can drive the engine directly.
globalThis.OGE = { Engine, Position, Search, TranspositionTable, generateMoves, evaluate, perft, randomMove, isMateInOne,
  START_FEN, NO_MOVE, MAX_SKILL, SKILL_BUDGET_PER_40_MOVES, ENGINE_NAME, moveFrom, moveTo, movePromo, moveFlag, FLAG_CASTLE, FLAG_EP,
  squareName, parseSquare, typeOf, colorOf, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, PIECE_CHARS };

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.OGE;

if (isWorker) {
  const engine = new Engine(s => self.postMessage(s));
  self.onmessage = e => engine.command(String(e.data));
} else if (isCli) {
  const engine = new Engine(s => process.stdout.write(s + '\n'));
  engine.onQuit = () => { process.stdin.pause(); process.exitCode = 0; };
  const args = process.argv.slice(2);
  if (args[0] === 'bench') {
    engine.bench(parseInt(args[1], 10) || 10).then(() => process.exit(0));
  } else {
    if (args.length) for (const a of args) engine.command(a);
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        engine.command(line);
      }
    });
    process.stdin.on('end', () => { if (buffer.trim()) engine.command(buffer); engine.command('quit'); });
  }
}
