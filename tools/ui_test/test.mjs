// Verification script for /home/user/chess-engine-oge/index.html
//
// Run:   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test.mjs      (bun test.mjs also works)
// Needs: python3 -m http.server 8123 --directory /home/user/chess-engine-oge   (running in the background)
//        and `playwright` resolvable from this directory (here: node_modules -> /opt/node22/lib/node_modules).
// Env:   URL (default http://localhost:8123/index.html), REPO (default /home/user/chess-engine-oge),
//        SKIP_BVB=1 (skip the bot-vs-bot game), SKIP_FILE=1 (skip the file:// test), HEADED=1,
//        ONLY_FIXES=1 (run only section 7, the checks for the review findings)
// Output: PASS/FAIL lines, screenshots in ./shots, exit code 1 if anything failed.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PAGE_URL = process.env.URL || 'http://localhost:8123/index.html';
const REPO = process.env.REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function info(name, detail = '') { console.log(`INFO  ${name}${detail ? '  — ' + detail : ''}`); }
async function step(name, fn) {
  try { await fn(); } catch (e) { check(name, false, 'threw: ' + (e.stack || e.message)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const boardPart = fen => fen.split(' ').slice(0, 2).join(' ');   // engine FENs use Shredder castling letters in Chess960

function attachConsole(page, bucket) {
  page.on('console', m => { if (m.type() === 'error') bucket.push('console.error: ' + m.text()); });
  page.on('pageerror', e => bucket.push('pageerror: ' + e.message));
}
async function openPage(ctx, url, bucket) {
  const page = await ctx.newPage();
  attachConsole(page, bucket);
  await page.goto(url);
  await page.waitForFunction(() => window.app && app.state().engineReady, null, { timeout: 20000 });
  return page;
}
const state = page => page.evaluate(() => app.state());
async function waitFor(page, pred, timeout = 30000, label = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const st = await state(page);
    if (pred(st)) return st;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}; state=${JSON.stringify({ moves: st.moves.length, thinking: st.thinking, result: st.result, error: st.error })}`);
    await sleep(100);
  }
}
const humanTurn = s => s.result || (s.sideToMove === s.humanColor && !s.thinking);
async function squareCenter(page, sq) {
  return page.evaluate(sq => {
    const r = document.getElementById('board').getBoundingClientRect();
    const white = app.state().orientation === 'white';
    let f = sq.charCodeAt(0) - 97, rk = sq.charCodeAt(1) - 49;
    if (!white) { f = 7 - f; rk = 7 - rk; }
    return { x: r.left + (f + 0.5) * r.width / 8, y: r.top + (7 - rk + 0.5) * r.height / 8 };
  }, sq);
}
async function dragMove(page, from, to) {
  const a = await squareCenter(page, from), b = await squareCenter(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}
// chessground calls movable.events.after through setTimeout(…, 1), so give the page a moment after a drag/click.
async function settled(page, pred, timeout = 3000) {
  const t0 = Date.now();
  for (;;) {
    const st = await state(page);
    if (pred(st) || Date.now() - t0 > timeout) return st;
    await sleep(25);
  }
}
async function clickMove(page, from, to) {
  const a = await squareCenter(page, from), b = await squareCenter(page, to);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
}

const browser = await chromium.launch({ headless: !process.env.HEADED });
const ONLY_FIXES = !!process.env.ONLY_FIXES;

// ------------------------------------------------------------------ 1. load on desktop + phone (+ dark mode)
if (!ONLY_FIXES) for (const vp of [
  { width: 1280, height: 800, name: 'desktop' },
  { width: 390, height: 844, name: 'phone' },
  { width: 844, height: 390, name: 'phone-landscape' },
  { width: 390, height: 844, name: 'phone-dark', colorScheme: 'dark' },
]) {
  await step('load ' + vp.name, async () => {
    const errs = [];
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: vp.colorScheme || 'light' });
    const page = await openPage(ctx, PAGE_URL, errs);
    const st = await state(page);
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth,
      board: document.getElementById('board').getBoundingClientRect().width,
      boardH: document.getElementById('board').getBoundingClientRect().height,
      rows: ['bar-top', 'bar-bottom', 'status'].map(id => document.getElementById(id).getBoundingClientRect().width)
        .concat(document.querySelector('.actions').getBoundingClientRect().width),
      vh: innerHeight, vw: innerWidth, bg: getComputedStyle(document.body).backgroundColor,
    }));
    check(`${vp.name}: page loads, engine ready in a web worker`, st.engineReady && st.engineBackend === 'worker', JSON.stringify(m));
    check(`${vp.name}: no horizontal overflow`, m.sw <= m.cw && m.bw <= m.cw, `scrollWidth=${m.sw} clientWidth=${m.cw} bodyScrollWidth=${m.bw}`);
    const narrow = m.vw < 760;
    const expected = narrow ? Math.min(m.vw - 24, 0.7 * m.vh) : Math.min(m.vw - 32 - 340 - 24, 0.84 * m.vh, 760);
    check(`${vp.name}: board sized to the layout`, Math.abs(m.board - expected) < 2, `board=${m.board.toFixed(1)} expected=${expected.toFixed(1)}`);
    check(`${vp.name}: board square; player bars, action row and status line as wide as the board`, Math.abs(m.board - m.boardH) < 1 && m.rows.every(w => Math.abs(w - m.board) < 1), `board=${m.board}x${m.boardH} rows=${m.rows.join(',')}`);
    if (vp.colorScheme === 'dark') check('phone-dark: dark background applied', /rgb\(2[0-9], 2[0-9], 2[0-9]\)/.test(m.bg), m.bg);
    check(`${vp.name}: no console errors`, errs.length === 0, errs.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, `load-${vp.name}.png`), fullPage: true });
    await ctx.close();
  });
}

// ------------------------------------------------------------------ 2. unit checks: Chess960 numbering, SAN, engine castling notation
if (!ONLY_FIXES) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openPage(ctx, PAGE_URL, errs);
  await step('chess960 numbering', async () => {
    const r = await page.evaluate(() => {
      const f518 = app.chess960Fen(518), f0 = app.chess960Fen(0), f959 = app.chess960Fen(959);
      const seen = new Set();
      const bad = [];
      for (let n = 0; n < 960; n++) {
        const fen = app.chess960Fen(n);
        const row = fen.split('/')[7].split(' ')[0];
        seen.add(row);
        const k = row.indexOf('K'), r1 = row.indexOf('R'), r2 = row.lastIndexOf('R');
        const b1 = row.indexOf('B'), b2 = row.lastIndexOf('B');
        if (!(r1 < k && k < r2) || (b1 % 2) === (b2 % 2) || row.length !== 8 || fen.split('/')[0] !== row.toLowerCase()) bad.push(n + ':' + row);
      }
      return { f518, f0, f959, unique: seen.size, bad: bad.slice(0, 3) };
    });
    check('position 518 is the standard start', r.f518 === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', r.f518);
    check('position 0 = BBQNNRKR, 959 = RKRNNQBB', r.f0.startsWith('bbqnnrkr/') && r.f959.startsWith('rkrnnqbb/'), r.f0 + ' | ' + r.f959);
    check('all 960 positions distinct and valid (K between rooks, opposite-colour bishops, mirrored)', r.unique === 960 && r.bad.length === 0, `unique=${r.unique} bad=${r.bad}`);
  });
  await step('SAN generation', async () => {
    const cases = [   // [fen, uci, expected san, chess960?]
      ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2e4', 'e4'],
      ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'g1f3', 'Nf3'],
      ['r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', 'f3e5', 'Nxe5'],
      ['rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', 'e5f6', 'exf6'],              // en passant
      ['r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', 'e1g1', 'O-O'],
      ['r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', 'e1c1', 'O-O-O'],
      ['r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1', 'e8h8', 'O-O', true],                     // king-takes-rook notation
      ['4k3/1P6/8/8/8/8/8/4K3 w - - 0 1', 'b7b8q', 'b8=Q+'],
      ['4k3/1P6/8/8/8/8/8/4K3 w - - 0 1', 'b7b8n', 'b8=N'],
      ['6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8', 'Ra8#'],                                           // back-rank mate
      ['4k3/8/8/8/8/8/4K3/R6R w - - 0 1', 'a1d1', 'Rad1'],                                             // file disambiguation
      ['7k/8/8/8/R7/8/8/R3K3 w - - 0 1', 'a1a2', 'R1a2'],                                              // rank disambiguation
      ['6k1/8/8/8/8/8/8/Q2Q2KQ w - - 0 1', 'a1a4', 'Qaa4'],                                             // file suffices
      ['1k6/8/8/8/Q7/8/8/Q2Q3K w - - 0 1', 'a1d4', 'Qa1d4'],                                            // full square needed
      ['rnbqkbnr/pppp1ppp/8/4p3/5PP1/8/PPPPP2P/RNBQKBNR b KQkq - 0 2', 'd8h4', 'Qh4#'],
      ['r3k2r/8/8/8/8/8/8/3K4 b kq - 0 1', 'e8c8', 'O-O-O+'],                                          // castling with check
    ];
    const out = await page.evaluate(cases => cases.map(([fen, uci, exp, c960]) => [exp, app.san(fen, uci, !!c960)]), cases);
    for (const [exp, got] of out) check(`SAN ${exp}`, got === exp, `got ${got}`);
  });
  await step('engine king-takes-rook castling notation', async () => {
    // Deterministic: Kb1 Ra1 vs Kd8 Rc8 Re8 pawns c7 e7. O-O-O (rook to d1) is the unique mate in 1,
    // and the king on b1 blocks any other way for the rook to reach d1.
    const require = createRequire(import.meta.url);
    const OGE = require(path.join(REPO, 'engine.js'));
    const FEN = '2rkr3/2p1p3/8/8/8/8/8/RK6 w Q - 0 1';
    async function best(level) {
      const lines = [];
      const e = new OGE.Engine(l => lines.push(l));
      await e.command('setoption name UCI_Chess960 value true');
      await e.command('setoption name Skill_Level value ' + level);
      await e.command('position fen ' + FEN);
      await e.command('go depth 4');
      return lines.find(l => l.startsWith('bestmove')).split(' ')[1];
    }
    const b0 = await best(0), bMax = await best(OGE.MAX_SKILL);
    check('engine.js reports Chess960 castling as king-takes-rook (b1a1)', b0 === 'b1a1' && bMax === 'b1a1', `level0=${b0} max=${bMax}`);
    const parsed = await page.evaluate(([fen, uci]) => app.san(fen, uci, true), [FEN, bMax]);
    check('page parses the engine\'s king-takes-rook move as castling (O-O-O#)', parsed === 'O-O-O#', `san=${parsed}`);
  });
  await ctx.close();
}

// ------------------------------------------------------------------ 3. Human vs Bot (phone viewport): drag, click, API, lists, link, captures, clocks, view, undo
if (!ONLY_FIXES) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await openPage(ctx, PAGE_URL, errs);
  await step('human vs bot game', async () => {
    await page.evaluate(() => app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'standard', botLevel: 0 }));
    let st = await state(page);
    check('hvb: new game at the standard position, human white', boardPart(st.fen) === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w' && st.humanColor === 'white' && st.mode === 'hvb');
    check('hvb: chess960 selector hidden in standard mode', await page.evaluate(() => document.getElementById('pos960').closest('.c960-only').hidden));

    await dragMove(page, 'e2', 'e4');                                   // 1. drag through chessground
    st = await waitFor(page, s => s.moves.length >= 2 && !s.thinking, 30000, 'bot reply to e4');
    check('hvb: drag move e2-e4 accepted and bot replied', st.moves[0] === 'e4' && st.moves.length === 2, st.moves.join(' '));

    const legal = await page.evaluate(() => app.legalUcis());          // 2. click-click
    const clickMv = legal.includes('d2d4') ? ['d2', 'd4'] : [legal[0].slice(0, 2), legal[0].slice(2, 4)];
    await clickMove(page, clickMv[0], clickMv[1]);
    st = await waitFor(page, s => s.moves.length >= 4 && !s.thinking, 30000, 'bot reply to click move');
    check('hvb: click-click move accepted and bot replied', st.moves.length === 4, st.moves.join(' '));

    let captureSeen = false;                                            // 3. API moves, preferring captures
    for (let i = 0; i < 10; i++) {
      st = await state(page);
      if (st.result) break;
      const moves = await page.evaluate(() => app.legalMoves());
      const captures = moves.filter(m => m.san.includes('x') && !m.promo);
      const pick = captures[0] || moves.find(m => !m.promo && !m.castle && !m.san.startsWith('K')) || moves[0];
      const san = await page.evaluate(u => app.playUci(u), pick.uci);
      if (san === false) throw new Error('playUci rejected ' + pick.uci);
      if (san.includes('x')) captureSeen = true;
      st = await waitFor(page, humanTurn, 30000, 'bot reply');
    }
    st = await state(page);
    const dom = await page.evaluate(() => ({
      moveButtons: document.querySelectorAll('#moves .mv').length,
      lastSan: [...document.querySelectorAll('#moves .mv')].pop()?.textContent,
      lichess: document.getElementById('lichess').href,
      capTop: document.getElementById('cap-top').querySelectorAll('piece').length,
      capBottom: document.getElementById('cap-bottom').querySelectorAll('piece').length,
      clockBottom: document.getElementById('clock-bottom').textContent,
      total: document.getElementById('total-time').textContent,
      status: document.getElementById('status').textContent,
    }));
    check('hvb: move list shows all plies', dom.moveButtons === st.moves.length && dom.lastSan === st.moves[st.moves.length - 1], `${dom.moveButtons} buttons, last=${dom.lastSan}`);
    const expectedPgn = st.moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + m).join(' ');
    check('hvb: lichess link = analysis/pgn/<movetext>', dom.lichess === 'https://lichess.org/analysis/pgn/' + encodeURIComponent(expectedPgn), decodeURIComponent(dom.lichess));
    const capCount = st.captured.white.reduce((a, c) => a + c.count, 0) + st.captured.black.reduce((a, c) => a + c.count, 0);
    check('hvb: captured pieces shown', captureSeen && capCount > 0 && (dom.capTop + dom.capBottom) > 0, `state=${JSON.stringify(st.captured)} dom glyphs top=${dom.capTop} bottom=${dom.capBottom}`);
    check('hvb: clocks advance', st.elapsed.white > 0 && /\d\d:\d\d/.test(dom.clockBottom) && /game time \d\d:\d\d/.test(dom.total), `white=${Math.round(st.elapsed.white)}ms black=${Math.round(st.elapsed.black)}ms ${dom.total}`);
    check('hvb: status shows engine info', /depth \d+/.test(dom.status), dom.status);
    await page.screenshot({ path: path.join(SHOTS, 'hvb-phone.png'), fullPage: true });

    await page.click('#moves .mv[data-ply="1"]');                        // 4. view mode
    st = await state(page);
    const liveHidden = await page.evaluate(() => document.getElementById('btn-live').hidden);
    check('hvb: clicking a move enters view mode', st.view === 1 && !liveHidden && st.boardFen.split(' ')[0] !== st.fen.split(' ')[0] && st.boardFen.startsWith('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'), `view=${st.view} board=${st.boardFen}`);
    check('hvb: lichess link follows the viewed move', decodeURIComponent(st.lichessUrl).endsWith('1. ' + st.moves[0]), decodeURIComponent(st.lichessUrl));
    check('hvb: board is read-only while viewing', (await page.evaluate(() => app.playUci(app.legalUcis()[0]))) === false);
    await page.click('#btn-live');
    st = await state(page);
    check('hvb: back to live', st.view === null && st.boardFen.split(' ')[0] === st.fen.split(' ')[0]);

    const before = st.moves.length;                                     // 5. undo
    await page.click('#btn-undo');
    st = await waitFor(page, s => !s.thinking, 30000, 'undo settle');
    check('hvb: undo removes two plies and leaves the human to move', st.moves.length === before - 2 && st.sideToMove === 'white', `${before} -> ${st.moves.length}`);

    await page.click('#btn-flip');                                       // 6. flip
    st = await state(page);
    check('hvb: flip board', st.orientation === 'black' && (await page.evaluate(() => document.getElementById('name-bottom').textContent)).startsWith('Bot'));
    await page.click('#btn-flip');
    check('hvb: no console errors', errs.length === 0, errs.join(' | '));
  });

  await step('promotion dialog', async () => {
    // Race a pawn to the 8th rank against the random bot; drag it there and pick a knight in the dialog.
    let done = false, lastInfo = '';
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      await page.evaluate(() => app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'standard', botLevel: 0 }));
      for (let i = 0; i < 16; i++) {
        const st = await waitFor(page, humanTurn, 30000, 'human turn');
        if (st.result) { lastInfo = 'game ended: ' + st.result.reason; break; }
        const moves = await page.evaluate(() => app.legalMoves());
        const promo = moves.find(m => m.promo);
        if (promo) {
          const n0 = st.moves.length;
          await dragMove(page, promo.from, promo.to);
          await settled(page, s => s.promotionPending);
          const shown = await page.evaluate(() => !document.getElementById('promo-overlay').hidden && document.querySelectorAll('#promo-choices button').length);
          check('promotion: dialog opens with 4 choices', shown === 4, `shown=${shown}`);
          await page.screenshot({ path: path.join(SHOTS, 'promotion-dialog.png') });
          await page.click('#promo-choices button[aria-label="knight"]');
          const after = await settled(page, s => !s.promotionPending && s.moves.length > n0);
          const san = after.moves[n0];
          check('promotion: knight chosen -> SAN =N and UCI suffix n', /=N[+#]?$/.test(san) && after.ucis[n0].endsWith('n') && !after.promotionPending, `${san} ${after.ucis[n0]}`);
          done = true; break;
        }
        // most advanced pawn move (captures first on ties)
        const pawnMoves = moves.filter(m => /^[a-h][1-8]$/.test(m.from) && !m.castle && !m.san.startsWith('K') && !/^[NBRQ]/.test(m.san));
        pawnMoves.sort((a, b) => (+b.to[1] - +a.to[1]) || (b.san.includes('x') - a.san.includes('x')));
        const pick = pawnMoves[0] || moves[0];
        const san = await page.evaluate(u => app.playUci(u), pick.uci);
        if (san === false) { lastInfo = 'rejected ' + pick.uci; break; }
        lastInfo = `attempt ${attempt}: ${(await state(page)).moves.join(' ')}`;
      }
    }
    if (!done) check('promotion: dialog test (needs the random bot to leave a pawn alone)', false, lastInfo);
    check('promotion: no console errors', errs.length === 0, errs.join(' | '));
  });
  await ctx.close();
}

// ------------------------------------------------------------------ 3b. Touch input on a phone (tap-tap moves, no page scroll)
if (!ONLY_FIXES) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await openPage(ctx, PAGE_URL, errs);
  await step('touch input', async () => {
    await page.evaluate(() => app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'standard', botLevel: 0 }));
    const a = await squareCenter(page, 'e2'), b = await squareCenter(page, 'e4');
    await page.touchscreen.tap(a.x, a.y);
    await page.touchscreen.tap(b.x, b.y);
    const st = await settled(page, s => s.moves.length >= 1);
    check('touch: tap-tap e2-e4 makes the move', st.moves[0] === 'e4', st.moves.join(' '));
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, overlap: (() => { const n = document.getElementById('name-top').getBoundingClientRect(), c = document.getElementById('cap-top').getBoundingClientRect(); return c.width > 0 && n.right > c.left + 1; })() }));
    check('touch/mobile: no horizontal overflow, name does not overlap captured pieces', m.sw <= m.cw && !m.overlap, JSON.stringify(m));
    check('touch: no console errors', errs.length === 0, errs.join(' | '));
  });
  await ctx.close();
}

// ------------------------------------------------------------------ 3c. Game-end rules, driven through playUci for both sides (bot vs bot, paused)
if (!ONLY_FIXES) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openPage(ctx, PAGE_URL, errs);
  async function playLine(ucis) {
    await page.evaluate(() => app.newGame({ mode: 'bvb', whiteLevel: 0, blackLevel: 0, variant: 'standard' }));
    for (const u of ucis) {
      const san = await page.evaluate(u => app.playUci(u), u);
      if (san === false) throw new Error('rejected ' + u);
    }
    return state(page);
  }
  await step('game-end rules', async () => {
    let st = await playLine(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    check('rules: checkmate detected (fool\'s mate)', st.result && st.result.score === '0-1' && st.result.reason === 'Checkmate' && st.moves[3] === 'Qh4#', JSON.stringify(st.result) + ' ' + st.moves.join(' '));
    check('rules: result banner shown', (await page.evaluate(() => document.getElementById('status').textContent)).includes('Checkmate — Black wins · 0-1'));
    st = await playLine(['e2e3', 'a7a5', 'd1h5', 'a8a6', 'h5a5', 'h7h5', 'h2h4', 'a6h6', 'a5c7', 'f7f6', 'c7d7', 'e8f7', 'd7b7', 'd8d3', 'b7b8', 'd3h7', 'b8c8', 'f7g6', 'c8e6']);
    check('rules: stalemate detected', st.result && st.result.score === '1/2-1/2' && st.result.reason === 'Stalemate', JSON.stringify(st.result));
    st = await playLine(['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
    check('rules: threefold repetition detected', st.result && st.result.score === '1/2-1/2' && st.result.reason === 'Threefold repetition', JSON.stringify(st.result));
    st = await playLine(['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1']);
    check('rules: not yet a repetition one ply earlier', st.result === null);
    // undo in bot-vs-bot takes back one ply
    await page.click('#btn-undo');
    st = await state(page);
    check('rules: undo in bot vs bot takes back one ply', st.moves.length === 6 && st.sideToMove === 'white', st.moves.join(' '));
    check('rules: no console errors', errs.length === 0, errs.join(' | '));
  });
  await ctx.close();
}

// ------------------------------------------------------------------ 4. Chess960: selector, random start, castling by king-takes-rook, lichess tags, drag castling
if (!ONLY_FIXES) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openPage(ctx, PAGE_URL, errs);
  await step('chess960 game', async () => {
    await page.selectOption('#variant', 'chess960');
    check('960: selector shown when Chess960 selected', await page.evaluate(() => !document.getElementById('pos960').closest('.c960-only').hidden));
    await page.click('#btn-random960');
    let st = await state(page);
    const n = st.startNumber;
    const shownFen = await page.evaluate(() => document.getElementById('fen960').textContent);
    const inputVal = await page.evaluate(() => document.getElementById('pos960').value);
    check('960: Random button picks a position, shows its FEN, board follows', Number.isInteger(n) && n >= 0 && n <= 959 && shownFen === st.startFen && boardPart(st.fen) === boardPart(st.startFen) && inputVal === String(n) && st.boardFen.split(' ')[0] === st.startFen.split(' ')[0], `n=${n} ${st.startFen}`);
    check('960: empty-game lichess link', st.lichessUrl === 'https://lichess.org/analysis/chess960/' + st.startFen.replace(/ /g, '_'), st.lichessUrl);
    await page.fill('#pos960', '518');                                   // applied when committed (Enter), not per keystroke
    await page.press('#pos960', 'Enter');
    st = await state(page);
    check('960: typing 518 + Enter gives the standard start', st.startFen === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    await page.screenshot({ path: path.join(SHOTS, 'chess960-settings.png'), fullPage: true });

    let num;
    do { num = Math.floor(Math.random() * 960); } while (num === 518);
    await page.evaluate(num => app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'chess960', startNumber: num, botLevel: 0 }), num);
    st = await state(page);
    check('960: new game uses the chosen start', st.chess960 && st.startNumber === num && boardPart(st.fen) === boardPart(st.startFen) && st.startFen === (await page.evaluate(n => app.chess960Fen(n), num)), `n=${num} ${st.startFen}`);
    const kFile = st.startFen.split('/')[7].indexOf('K');
    let castled = null, plies = 0, botCastled = false;
    for (let i = 0; i < 60 && !castled; i++) {
      st = await waitFor(page, humanTurn, 30000, 'human turn');
      if (st.result) break;
      const moves = await page.evaluate(() => app.legalMoves());
      const castle = moves.find(m => m.castle);
      let pick = castle;
      if (!pick) {
        // develop: move non-king/rook pieces off the back rank, else push pawns, else anything quiet that stays off rank 1
        const off = moves.filter(m => !m.castle && !m.promo && m.from[1] === '1' && m.to[1] !== '1' && !/^[KR]/.test(m.san) && !/^O/.test(m.san));
        const pawns = moves.filter(m => !m.castle && !m.promo && m.from[1] === '2' && !/[+#]/.test(m.san));
        const quiet = moves.filter(m => !m.castle && !m.promo && m.to[1] !== '1' && !/^[KR]/.test(m.san) && !/^O/.test(m.san));
        const pool = off.length ? off : pawns.length ? pawns : quiet.length ? quiet : moves;
        pick = pool[Math.floor(Math.random() * pool.length)];
      }
      const san = await page.evaluate(u => app.playUci(u), pick.uci);
      if (san === false) throw new Error('playUci rejected ' + pick.uci);
      plies++;
      if (pick.castle) castled = { uci: pick.uci, san };
    }
    st = await state(page);
    check('960: human castled with king-takes-rook UCI', !!castled && /^O-O(-O)?/.test(castled.san) && /^[a-h]1[a-h]1$/.test(castled.uci) && castled.uci[0] === 'abcdefgh'[kFile], `${JSON.stringify(castled)} after ${plies} human moves; fen=${st.fen}; moves=${st.moves.join(' ')}`);
    if (castled) {
      const idx = st.ucis.lastIndexOf(castled.uci);
      const posCmd = st.lastPositionCmd;
      check('960: castling sent to the engine in king-takes-rook form', posCmd.includes(' ' + castled.uci) && posCmd.startsWith('position fen ' + st.startFen.split(' ')[0]), posCmd.slice(0, 140) + '…');
      st = await waitFor(page, s => s.result || (s.ucis.length > idx + 1 && !s.thinking), 30000, 'bot reply after castling');
      check('960: engine accepted the move list and replied', st.result !== null || st.ucis.length > idx + 1, `ucis=${st.ucis.length} idx=${idx} error=${st.error}`);
      check('960: no engine error', !st.error, st.error);
      const rank1 = await page.evaluate(() => {
        const r1 = app.state().fen.split(' ')[0].split('/')[7]; let f = 0; const out = {};
        for (const ch of r1) { if (/\d/.test(ch)) f += +ch; else { (out[ch] = out[ch] || []).push('abcdefgh'[f]); f++; } }
        return out;
      });
      const expectKing = castled.san.startsWith('O-O-O') ? 'c' : 'g', expectRook = castled.san.startsWith('O-O-O') ? 'd' : 'f';
      check('960: after castling the king and rook stand on the castled squares', (rank1.K || []).includes(expectKing) && (rank1.R || []).includes(expectRook), JSON.stringify(rank1));
      const url = decodeURIComponent(st.lichessUrl);
      check('960: lichess link has Variant and FEN tags', url.startsWith('https://lichess.org/analysis/pgn/[Variant "Chess960"]\n[FEN "' + st.startFen + '"]') && /\n\n1\. /.test(url), url.slice(0, 160).replace(/\n/g, '\\n'));
      check('960: SAN list uses O-O / O-O-O', st.moves.some(m => /^O-O/.test(m)), st.moves.join(' '));
      botCastled = st.moves.some((m, i) => i % 2 === 1 && /^O-O/.test(m));
    }
    await page.screenshot({ path: path.join(SHOTS, 'chess960-desktop.png'), fullPage: true });

    // Bot castling in the real game flow (best effort, random bot): report only.
    info('960: random bot castled in this game (king-takes-rook bestmove parsed by the page)', String(botCastled));

    // Drag castling through chessground in standard chess: king onto the rook (e1->h1) must castle.
    await page.evaluate(() => app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'standard', botLevel: 0 }));
    for (const u of ['e2e4', 'g1f3', 'f1c4']) {
      await waitFor(page, humanTurn, 30000, 'human turn');
      if (!(await page.evaluate(() => app.legalUcis())).includes(u)) break;
      await page.evaluate(u => app.playUci(u), u);
    }
    st = await waitFor(page, humanTurn, 30000, 'human turn');
    const canCastle = (await page.evaluate(() => app.legalMoves())).some(m => m.castle && m.san.startsWith('O-O'));
    if (canCastle && !st.result) {
      const n0 = st.moves.length;
      await dragMove(page, 'e1', 'h1');
      st = await settled(page, s => s.moves.length > n0);
      check('drag king onto rook castles (standard)', st.moves[n0] === 'O-O' && st.ucis[n0] === 'e1g1', st.moves.join(' '));
    } else check('drag king onto rook castles (standard)', false, `castling not available: fen=${st.fen} moves=${st.moves.join(' ')}`);
    check('960: no console errors', errs.length === 0, errs.join(' | '));
  });
  await ctx.close();
}

// ------------------------------------------------------------------ 5. Bot vs Bot, levels 0 vs 3, to completion
if (!process.env.SKIP_BVB && !ONLY_FIXES) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openPage(ctx, PAGE_URL, errs);
  await step('bot vs bot 0 vs top level', async () => {
    await page.selectOption('#mode', 'bvb');
    await page.selectOption('#level-white', '0');
    const topLevel = await page.evaluate(() => String(OGE.MAX_SKILL));
    await page.selectOption('#level-black', topLevel);   // full strength: the result below is then deterministic
    let st = await state(page);
    const btn = await page.evaluate(() => ({ hidden: document.getElementById('btn-start').hidden, text: document.getElementById('btn-start').textContent, hvbHidden: document.getElementById('level-bot').closest('label').hidden }));
    check('bvb: Start button shown, paused by default, two level selectors', st.mode === 'bvb' && !st.running && !btn.hidden && btn.text === 'Start' && btn.hvbHidden && st.levels.white === 0 && st.levels.black === 3, JSON.stringify({ running: st.running, btn, levels: st.levels }));
    const t0 = Date.now();
    await page.click('#btn-start');
    st = await waitFor(page, s => s.moves.length >= 4, 60000, 'first bvb moves');
    check('bvb: game runs after Start', st.running && st.moves.length >= 4, st.moves.join(' '));
    await page.click('#btn-start');                                      // pause
    await sleep(800);
    const paused = await state(page);
    await sleep(1500);
    const stillPaused = await state(page);
    check('bvb: pause stops play and clocks', !paused.running && paused.moves.length === stillPaused.moves.length && !stillPaused.thinking && Math.abs((paused.elapsed.white + paused.elapsed.black) - (stillPaused.elapsed.white + stillPaused.elapsed.black)) < 50, `${paused.moves.length} vs ${stillPaused.moves.length}`);
    await page.click('#btn-start');                                      // resume
    st = await waitFor(page, s => s.result !== null, 420000, 'bvb game end');
    const secs = Math.round((Date.now() - t0) / 1000);
    const dom = await page.evaluate(() => ({ status: document.getElementById('status').textContent, startDisabled: document.getElementById('btn-start').disabled, total: document.getElementById('total-time').textContent, lichess: document.getElementById('lichess').href }));
    check('bvb: game ran to completion', !!st.result, `${st.result && st.result.score} ${st.result && st.result.reason} after ${st.moves.length} plies in ${secs}s; ${dom.total}`);
    check('bvb: result shown in status, Start disabled', dom.status.includes(st.result.score) && dom.status.includes(st.result.reason) && dom.startDisabled, dom.status);
    check('bvb: full strength (black) beat the random mover or drew', st.result.score !== '1-0', st.result.score);
    check('bvb: virtual clocks decremented, never below 10s', st.virtual.black < 60000 && st.virtual.black >= 10000 && st.virtual.white >= 10000, JSON.stringify(st.virtual));
    check('bvb: elapsed time counted for both sides', st.elapsed.black > 1000 && st.elapsed.white >= 0 && /game time \d\d:\d\d/.test(dom.total), `${Math.round(st.elapsed.white)}ms / ${Math.round(st.elapsed.black)}ms`);
    check('bvb: lichess link covers the whole game', decodeURIComponent(dom.lichess).endsWith(st.moves[st.moves.length - 1]), decodeURIComponent(dom.lichess).slice(-60));
    check('bvb: no console errors', errs.length === 0, errs.join(' | '));
    await page.screenshot({ path: path.join(SHOTS, 'bvb-end.png'), fullPage: true });
  });
  await ctx.close();
}

// ------------------------------------------------------------------ 6. file:// (worker blocked -> main-thread fallback)
if (!process.env.SKIP_FILE && !ONLY_FIXES) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await step('file:// fallback', async () => {
    const page = await ctx.newPage();
    attachConsole(page, errs);
    await page.goto('file://' + path.join(REPO, 'index.html'));
    await page.waitForFunction(() => window.app && app.state().engineReady, null, { timeout: 30000 });
    let st = await state(page);
    check('file://: engine ready on the main thread', st.engineReady && st.engineBackend === 'main', `backend=${st.engineBackend} reason=${st.fallbackReason}`);
    await page.evaluate(() => app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'standard', botLevel: 2 }));
    await page.evaluate(() => app.playUci('e2e4'));
    st = await waitFor(page, s => s.moves.length >= 2 && !s.thinking, 60000, 'bot reply (main thread)');
    check('file://: bot replies through the main-thread engine', st.moves.length === 2 && st.moves[0] === 'e4', st.moves.join(' '));
    await dragMove(page, 'd2', 'd4');
    st = await waitFor(page, s => s.moves.length >= 4 && !s.thinking, 60000, 'bot reply 2 (main thread)');
    check('file://: drag move works too', st.moves.length === 4 && st.moves[2] === 'd4', st.moves.join(' '));
    const tag = await page.evaluate(() => document.getElementById('engine-tag').textContent);
    check('file://: header says main thread', /main thread/.test(tag), tag);
    // Watchdog on the main-thread engine: make the next "go" throw inside engine.js (-> "info string error", no bestmove).
    await page.evaluate(() => {
      const orig = OGE.Engine.prototype.go;
      let once = true;
      OGE.Engine.prototype.go = function (tokens) { if (once) { once = false; throw new Error('simulated failure'); } return orig.call(this, tokens); };
      app.playUci(app.legalUcis()[0]);
    });
    st = await waitFor(page, s => s.moves.length >= 6 && !s.thinking, 60000, 'bot reply after a failed main-thread search');
    check('file://: failed main-thread search -> engine restarted, bot moves', st.moves.length === 6 && /restarted/.test(st.error) && st.engineBackend === 'main', `error=${st.error} moves=${st.moves.join(' ')}`);
    const unexpected = errs.filter(e => !/Worker|worker|origin 'null'|SecurityError/.test(e));
    check('file://: no unexpected console errors', unexpected.length === 0, unexpected.join(' | '));
  });
  await ctx.close();
}

// ------------------------------------------------------------------ 7. Checks for the review findings (ui_findings.json)
if (!process.env.SKIP_FIXES) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openPage(ctx, PAGE_URL, errs);
  async function playAll(ucis) {
    for (const u of ucis) {
      const san = await page.evaluate(u => app.playUci(u), u);
      if (san === false) throw new Error('rejected ' + u);
    }
    return state(page);
  }

  await step('fix: mode is fixed per game', async () => {
    // Human vs Bot -> switch the form to Bot vs Bot while the bot is thinking: the running game must not change.
    await page.evaluate(() => app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'standard', botLevel: 1 }));
    await page.evaluate(() => app.playUci('e2e4'));
    await page.selectOption('#mode', 'bvb');
    let st = await waitFor(page, s => s.moves.length >= 2 && !s.thinking, 30000, 'bot reply after the mode switch');
    await sleep(1200);
    st = await state(page);
    const ui = await page.evaluate(() => ({ hint: !document.getElementById('settings-hint').hidden, startHidden: document.getElementById('btn-start').hidden,
      bvbSelectors: !document.getElementById('level-white').closest('label').hidden }));
    check('fix mode: switching to Bot vs Bot mid-game leaves the Human vs Bot game as it is', st.mode === 'hvb' && st.settingsMode === 'bvb' && st.moves.length === 2 && st.sideToMove === 'white' && !st.thinking && st.running,
      JSON.stringify({ mode: st.mode, settingsMode: st.settingsMode, moves: st.moves, running: st.running, thinking: st.thinking }));
    check('fix mode: form shows the pending mode, hint shown, no Start button for this game', ui.hint && ui.startHidden && ui.bvbSelectors, JSON.stringify(ui));
    const san = await page.evaluate(() => app.playUci(app.legalUcis().includes('d2d4') ? 'd2d4' : app.legalUcis()[0]));
    st = await waitFor(page, s => s.moves.length >= 4 && !s.thinking, 30000, 'bot reply after a human move');
    check('fix mode: human can still move and the bot (Bot strength level) replies', san !== false && st.moves.length === 4 && st.levels.black === 1, `${st.moves.join(' ')} levels=${JSON.stringify(st.levels)}`);
    await page.click('#btn-new');
    st = await state(page);
    check('fix mode: New game applies the new mode', st.mode === 'bvb' && !st.running && st.moves.length === 0, JSON.stringify({ mode: st.mode, running: st.running }));

    // Bot vs Bot (paused, two moves) -> switch the form to Human vs Bot: still a paused Bot vs Bot game that Start resumes.
    await page.evaluate(() => app.newGame({ mode: 'bvb', whiteLevel: 0, blackLevel: 0, variant: 'standard' }));
    await playAll(['e2e4', 'e7e5']);
    await page.selectOption('#mode', 'hvb');
    await sleep(500);
    st = await state(page);
    const startVisible = await page.evaluate(() => !document.getElementById('btn-start').hidden);
    check('fix mode: switching to Human vs Bot mid-game keeps the paused Bot vs Bot game', st.mode === 'bvb' && st.settingsMode === 'hvb' && !st.running && !st.thinking && st.moves.length === 2 && startVisible, JSON.stringify({ mode: st.mode, running: st.running, moves: st.moves.length, startVisible }));
    await page.click('#btn-start');
    // level-0 bots move instantly: pause from inside the page as soon as two more plies are on the board
    const plies = await page.evaluate(() => new Promise(res => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const s = app.state();
        if (s.moves.length >= 4 || s.result || Date.now() - t0 > 30000) { clearInterval(iv); app.pause(); res(s.moves.length); }
      }, 2);
    }));
    check('fix mode: Start still runs that Bot vs Bot game', plies >= 4, `plies=${plies}`);
    await waitFor(page, s => !s.thinking, 30000, 'pause settle');
    await page.selectOption('#mode', 'bvb');
  });

  await step('fix: Enter in the Chess960 number field', async () => {
    await page.evaluate(() => app.newGame({ mode: 'bvb', whiteLevel: 0, blackLevel: 0, variant: 'chess960', startNumber: 100 }));
    const url0 = page.url();
    await page.evaluate(() => { window.__marker = 42; });
    await page.fill('#pos960', '123');
    await page.press('#pos960', 'Enter');
    await sleep(400);
    let st = await state(page);
    const after = await page.evaluate(() => ({ marker: window.__marker, focused: document.activeElement === document.getElementById('pos960'), value: document.getElementById('pos960').value, fen: document.getElementById('fen960').textContent }));
    check('fix enter: Enter does not reload the page and applies the number', after.marker === 42 && page.url() === url0 && st.startNumber === 123 && st.startFen === after.fen && after.value === '123' && !after.focused,
      JSON.stringify({ ...after, url: page.url(), startNumber: st.startNumber }));
    await page.evaluate(() => document.getElementById('settings').requestSubmit());
    await sleep(300);
    check('fix enter: a form submit never navigates', (await page.evaluate(() => window.__marker)) === 42 && page.url() === url0, page.url());
  });

  await step('fix: Chess960 number applied on commit only', async () => {
    await page.evaluate(() => app.newGame({ mode: 'bvb', whiteLevel: 0, blackLevel: 0, variant: 'chess960', startNumber: 123 }));
    await page.fill('#pos960', '');
    const seen = [];
    for (const ch of '960') {
      await page.keyboard.type(ch);
      const st = await state(page);
      seen.push(st.startNumber);
      if (ch === '6') await page.evaluate(() => app.flip());                 // a re-render while typing
    }
    const mid = await page.evaluate(() => ({ value: document.getElementById('pos960').value, invalid: document.getElementById('pos960').getAttribute('aria-invalid'), fen: document.getElementById('fen960').textContent }));
    check('fix pos960: keystrokes do not start games (9, 96 not applied), re-render keeps the typed text', seen.every(n => n === 123) && mid.value === '960', `seen=${seen} value=${mid.value}`);
    check('fix pos960: out-of-range value flagged while typing, FEN still that of the position in use', mid.invalid === 'true' && mid.fen === (await page.evaluate(() => app.chess960Fen(123))), JSON.stringify(mid));
    await page.keyboard.press('Enter');
    let st = await state(page);
    const snapped = await page.evaluate(() => ({ value: document.getElementById('pos960').value, invalid: document.getElementById('pos960').getAttribute('aria-invalid') }));
    check('fix pos960: committing an invalid value snaps back to the position in use', st.startNumber === 123 && snapped.value === '123' && snapped.invalid === null, JSON.stringify({ n: st.startNumber, ...snapped }));
    await page.evaluate(() => app.flip());
    await page.fill('#pos960', '96');
    await page.evaluate(() => document.getElementById('pos960').blur());   // leaving the field commits (change event)
    st = await state(page);
    check('fix pos960: leaving the field commits a valid number', st.startNumber === 96 && st.startFen === (await page.evaluate(() => app.chess960Fen(96))) && st.moves.length === 0, `n=${st.startNumber}`);
  });

  await step('fix: Chess960 repetition from a non-classical start', async () => {
    await page.evaluate(() => app.newGame({ mode: 'bvb', whiteLevel: 0, blackLevel: 0, variant: 'chess960', startNumber: 0 }));
    const line = ['d1c3', 'd8c6', 'c3d1', 'c6d8', 'd1c3', 'd8c6', 'c3d1', 'c6d8'];
    let st = await playAll(line.slice(0, 7));
    check('fix rep960: no draw one ply before the third occurrence', st.result === null, JSON.stringify(st.result));
    st = await playAll(line.slice(7));
    check('fix rep960: start position of #0 (BBQNNRKR) repeated three times = draw at ply 8', st.result && st.result.reason === 'Threefold repetition' && st.moves.length === 8, `${JSON.stringify(st.result)} fen=${st.fen}`);
  });

  await step('fix: captured pieces after promotion', async () => {
    await page.evaluate(() => app.newGame({ mode: 'bvb', whiteLevel: 0, blackLevel: 0, variant: 'standard' }));
    let st = await playAll(['h2h4', 'g7g5', 'h4g5', 'h7h6', 'g5h6', 'b8c6', 'h6h7', 'e7e6', 'h7g8q']);
    const fmt = list => list.map(c => `${' PNBRQK'[c.type]}${c.count}`).join(' ');
    let dom = await page.evaluate(() => ({ top: [...document.querySelectorAll('#cap-top piece')].map(p => p.className), bottom: [...document.querySelectorAll('#cap-bottom piece')].map(p => p.className),
      bal: document.querySelector('#cap-bottom .balance')?.textContent }));
    check('fix captured: promotion is not a captured pawn (White took P2 N1, Black took nothing)', fmt(st.captured.white) === 'P2 N1' && st.captured.black.length === 0 && dom.top.length === 0 && dom.bottom.join(',') === 'black pawn,black knight' && st.captured.balance === 13 && dom.bal === '+13',
      `white=${fmt(st.captured.white)} black=${fmt(st.captured.black)} balance=${st.captured.balance} dom=${JSON.stringify(dom)}`);
    st = await playAll(['h8g8']);                                                 // Black takes the promoted queen
    dom = await page.evaluate(() => [...document.querySelectorAll('#cap-top piece')].map(p => p.className));
    check('fix captured: a captured promoted queen shows as a queen', fmt(st.captured.black) === 'Q1' && fmt(st.captured.white) === 'P2 N1' && dom.join(',') === 'white queen' && st.captured.balance === 4, `black=${fmt(st.captured.black)} dom=${dom}`);
    await page.evaluate(() => app.view(8));
    dom = await page.evaluate(() => ({ top: document.querySelectorAll('#cap-top piece').length, bottom: [...document.querySelectorAll('#cap-bottom piece')].map(p => p.className) }));
    check('fix captured: viewing an earlier move shows the captures up to that move', dom.top === 0 && dom.bottom.join(',') === 'black pawn', JSON.stringify(dom));
    await page.evaluate(() => app.view(null));
  });

  await step('fix: clocks credited on move', async () => {
    const r = await page.evaluate(async () => {
      app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'standard', botLevel: 1 });
      const t0 = performance.now();
      await new Promise(res => setTimeout(res, 430));
      app.playUci('e2e4');
      const waited = performance.now() - t0, s = app.state();
      return { waited, white: s.elapsed.white, black: s.elapsed.black };
    });
    check('fix clocks: the mover is credited up to the moment of the move, nothing leaks to the opponent', Math.abs(r.white - r.waited) < 25 && r.black < 5, JSON.stringify(r));
    const st = await waitFor(page, s => s.moves.length >= 2 && !s.thinking, 30000, 'bot reply');
    const used = 60000 - st.virtual.black;
    check('fix clocks: bot elapsed time matches the time its search used', Math.abs(st.elapsed.black - used) < 50, `elapsed=${st.elapsed.black.toFixed(1)} used=${used}`);
  });

  await step('fix: favicon, form-control font size', async () => {
    const r = await page.evaluate(() => ({ icon: !!document.querySelector('link[rel="icon"]'),
      fonts: ['mode', 'variant', 'level-bot', 'human-color', 'pos960'].map(id => parseFloat(getComputedStyle(document.getElementById(id)).fontSize)) }));
    check('fix misc: page declares a favicon (no /favicon.ico 404)', r.icon);
    check('fix misc: settings controls use >= 16px text (no iOS focus zoom)', r.fonts.every(f => f >= 16), r.fonts.join(','));
  });
  check('fix: no console errors (desktop context)', errs.length === 0, errs.join(' | '));
  await ctx.close();

  // Phones: names not truncated after many captures; swipes that start on the board scroll the page.
  for (const vp of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    const perrs = [];
    const pctx = await browser.newContext({ viewport: vp, hasTouch: true, isMobile: true });
    const ppage = await openPage(pctx, PAGE_URL, perrs);
    await step(`fix: phone ${vp.width}px bars`, async () => {
      // A capture-heavy game played through the API (bot vs bot, paused): captures first, else a pseudo-random move.
      const n = await ppage.evaluate(() => {
        app.newGame({ mode: 'bvb', whiteLevel: 3, blackLevel: 3, variant: 'standard' });
        let seed = 12345;
        const rnd = k => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
        for (let i = 0; i < 90 && !app.state().result; i++) {
          const ms = app.legalMoves();
          const caps = ms.filter(m => m.san.includes('x'));
          const pick = caps.length ? caps[rnd(caps.length)] : ms[rnd(ms.length)];
          app.playUci(pick.uci);
        }
        return app.state().moves.length;
      });
      const st = await state(ppage);
      const m = await ppage.evaluate(() => {
        const one = where => {
          const name = document.getElementById('name-' + where), cap = document.getElementById('cap-' + where), sub = document.getElementById('sub-' + where);
          const nr = name.getBoundingClientRect(), cr = cap.getBoundingClientRect(), sr = sub.getBoundingClientRect();
          return { text: name.textContent, truncated: name.scrollWidth > name.clientWidth + 1, overlap: cr.width > 0 && (nr.right > cr.left + 1 || sr.right > cr.left + 1), glyphs: cap.querySelectorAll('piece').length };
        };
        return { top: one('top'), bottom: one('bottom'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
      });
      const types = Math.max(st.captured.white.length, st.captured.black.length);
      check(`fix bars ${vp.width}px: bot name and level not truncated after ${n} plies (${types} captured types), no overlap, no overflow`,
        types >= 3 && !m.top.truncated && !m.bottom.truncated && !m.top.overlap && !m.bottom.overlap && m.sw <= m.cw, JSON.stringify(m));
      // (checked before any full-page screenshot: those re-apply device emulation and can drop the coarse pointer)
      const mv = await ppage.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches, h: document.querySelector('#moves .mv').getBoundingClientRect().height }));
      if (mv.coarse) check(`fix touch ${vp.width}px: move-list entries are at least 40px tall on touch screens`, mv.h >= 40, `height=${mv.h}`);
      else info(`fix touch ${vp.width}px: (pointer: coarse) not emulated, move-list height not checked`);
      await ppage.screenshot({ path: path.join(SHOTS, `fix-bars-${vp.width}.png`), fullPage: true });
    });
    if (vp.width === 390) await step('fix: touch swipe on the board scrolls the page', async () => {
      await ppage.evaluate(() => app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'standard', botLevel: 0 }));
      await ppage.evaluate(() => scrollTo(0, 0));
      const cdp = await pctx.newCDPSession(ppage);
      const b = await ppage.evaluate(() => { const r = document.getElementById('board').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
      const x = b.l + b.w / 2, y0 = b.t + b.h / 2 + 40, y1 = y0 - 160;      // starts on an empty square (rank 4/5)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (y1 - y0) * i / 12 }] }); await sleep(16); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(600);
      const sy = await ppage.evaluate(() => scrollY);
      check('fix touch: a swipe starting on empty board squares scrolls the page', sy > 50, `scrollY=${sy}`);
      await ppage.evaluate(() => scrollTo(0, 0));
      const a = await squareCenter(ppage, 'e2'), c = await squareCenter(ppage, 'e4');
      await ppage.touchscreen.tap(a.x, a.y);
      await ppage.touchscreen.tap(c.x, c.y);
      const st = await settled(ppage, s => s.moves.length >= 1);
      check('fix touch: tap-tap still moves pieces', st.moves[0] === 'e4', st.moves.join(' '));
      await waitFor(ppage, s => !s.thinking, 30000, 'bot reply');
    });
    check(`fix: no console errors (phone ${vp.width}px)`, perrs.length === 0, perrs.join(' | '));
    await pctx.close();
  }

  // Classic (non-overlay) scrollbars: 100vw is wider than the layout, the board must still be square.
  await step('fix: square board with classic scrollbars', async () => {
    const sbBrowser = await chromium.launch({ headless: !process.env.HEADED, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar'] });
    try {
      for (const [w, h] of [[800, 600], [1100, 900], [700, 900]]) {
        const sctx = await sbBrowser.newContext({ viewport: { width: w, height: h } });
        const serrs = [];
        const spage = await openPage(sctx, PAGE_URL, serrs);
        await sleep(300);                                                    // let chessground's ResizeObserver settle
        const m = await spage.evaluate(() => {
          const r = id => { const b = (typeof id === 'string' ? document.querySelector(id) : id).getBoundingClientRect(); return [Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10]; };
          return { board: r('#board'), cg: r('#board cg-board'), bar: r('#bar-top'), scrollbar: innerWidth - document.documentElement.clientWidth,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
        });
        check(`fix scrollbar ${w}x${h}: board and chessground board square, bars match, no overflow`, m.board[0] === m.board[1] && Math.abs(m.cg[0] - m.cg[1]) < 1 && m.bar[0] === m.board[0] && !m.overflow, JSON.stringify(m));
        await sctx.close();
      }
    } finally { await sbBrowser.close(); }
  });

  // Engine recovery: a search that never answers. The Worker is wrapped so the test can make a "go" fail.
  {
    const werrs = [];
    const wctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wctx.addInitScript(() => {
      const W = window.Worker;
      window.__workers = [];
      window.__failNextGo = null;      // 'error': answer the next go with "info string error" and no bestmove; 'hang': swallow it
      window.Worker = class extends W {
        constructor(...a) { super(...a); window.__workers.push(this); }
        postMessage(msg) {
          if (window.__failNextGo && typeof msg === 'string' && msg.startsWith('go ')) {
            const how = window.__failNextGo; window.__failNextGo = null;
            if (how === 'error') setTimeout(() => this.onmessage && this.onmessage({ data: 'info string error: simulated failure' }), 10);
            return;
          }
          super.postMessage(msg);
        }
      };
    });
    const wpage = await openPage(wctx, PAGE_URL, werrs);
    await step('fix: engine watchdog', async () => {
      await wpage.evaluate(() => app.newGame({ mode: 'hvb', humanColor: 'white', variant: 'standard', botLevel: 0 }));
      await wpage.evaluate(() => { window.__failNextGo = 'error'; app.playUci('e2e4'); });
      let st = await waitFor(wpage, s => s.moves.length >= 2 && !s.thinking, 20000, 'bot reply after a failed search');
      let nw = await wpage.evaluate(() => window.__workers.length);
      check('fix watchdog: "info string error" without bestmove -> engine restarted, bot moves', st.moves.length === 2 && nw === 2 && /restarted/.test(st.error) && st.engineBackend === 'worker', `workers=${nw} error=${st.error} moves=${st.moves.join(' ')}`);
      await wpage.evaluate(() => { window.__failNextGo = 'hang'; app.playUci(app.legalUcis()[0]); });
      await sleep(300);
      st = await state(wpage);
      const hung = st.thinking && st.engineBusy;
      await wpage.evaluate(() => { const w = window.__workers[window.__workers.length - 1]; w.terminate(); w.onerror(new ErrorEvent('error', { message: 'simulated crash' })); });
      st = await waitFor(wpage, s => s.moves.length >= 4 && !s.thinking, 20000, 'bot reply after a worker crash');
      nw = await wpage.evaluate(() => window.__workers.length);
      check('fix watchdog: worker dying mid-search -> engine restarted, bot moves', hung && st.moves.length === 4 && nw === 3, `hung=${hung} workers=${nw} moves=${st.moves.join(' ')}`);
      await wpage.click('#btn-new');
      await wpage.evaluate(() => app.playUci('d2d4'));
      st = await waitFor(wpage, s => s.moves.length >= 2 && !s.thinking, 20000, 'bot reply in a new game');
      check('fix watchdog: next game plays normally, error cleared', st.moves.length === 2 && !st.error, `error=${st.error}`);
    });
    check('fix: no console errors (watchdog context)', werrs.length === 0, werrs.join(' | '));
    await wctx.close();
  }
}

await browser.close();
console.log(`\n${results.length - failures}/${results.length} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
