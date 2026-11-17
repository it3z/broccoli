// Online end-to-end: real server process + independent browser contexts (separate storage, separate sockets).
// 1v1: create/join by code, same state on both screens, a duplicated command is applied once, a dropped socket and
// a full page reload both come back to the same seat, the match ends for both. Then 2v2 with four browsers.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799, URL = `http://localhost:${PORT}/`;
const results = []; let failed = 0;
const check = (n, ok, info = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? '  — ' + info : ''}`); if (!ok) failed++; };
const srv = spawn('npx', ['tsx', 'apps/server/src/server.ts'], { cwd: root, env: { ...process.env, PORT: String(PORT), GRACE_MS: '60000' }, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', d => (srvLog += d)); srv.stderr.on('data', d => (srvLog += d));
for (let i = 0; i < 60 && !srvLog.includes('server on'); i++) await new Promise(r => setTimeout(r, 250));
const browser = await chromium.launch({ channel: 'chrome' });
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const player = async () => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, userAgent: UA });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL); return { ctx, page, errors };
};
// every snapshot is fingerprinted by tick, so two screens can be compared at the same simulation moment
const HOOK = () => { const s = window.__broccoli, f = s.applySnap.bind(s); window.__h = {};
  s.applySnap = (ev, st) => { f(ev, st); const m = s.match; window.__h[m.tick] = JSON.stringify([m.buildings.map(b => [b.owner, Math.floor(b.garrison * 100)]), m.armies.map(a => [a.id, a.owner, a.units, Math.round(a.dist)])]); }; };
const sameAt = async pages => {
  await new Promise(r => setTimeout(r, 400));
  const hs = await Promise.all(pages.map(p => p.evaluate(() => window.__h)));
  const ticks = Object.keys(hs[0]).filter(t => hs.every(h => h[t])).map(Number).sort((a, b) => b - a);
  return { tick: ticks[0], same: ticks.length > 0 && hs.every(h => h[ticks[0]] === hs[0][ticks[0]]) };
};
const waitStart = p => p.waitForFunction(() => window.__broccoli?.online && window.__broccoli.match.tick > 2, null, { timeout: 15000 });

// ---------------- 1v1 ----------------
const A = await player(), B = await player();
await A.page.tap('#btnOnline'); await A.page.tap('#btnCreate1');
await A.page.waitForSelector('#lobbyInfo b');
const code = (await A.page.textContent('#lobbyInfo b')).trim();
check('room created with a 5-letter invite code', /^[A-Z2-9]{5}$/.test(code), code);
await B.page.tap('#btnOnline'); await B.page.fill('#codeIn', code.toLowerCase()); await B.page.tap('#btnJoin');
await Promise.all([waitStart(A.page), waitStart(B.page)]);
await A.page.evaluate(HOOK); await B.page.evaluate(HOOK);
const seats = await Promise.all([A, B].map(x => x.page.evaluate(() => window.__broccoli.human)));
check('both browsers in the match, seats 0 and 1', seats[0] === 0 && seats[1] === 1, String(seats));
// player A drags an army; both screens must show it
const cdp = await A.ctx.newCDPSession(A.page);
const tt = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] });
const at = (pg, id) => pg.evaluate(i => window.__broccoli.screenOf(i), id);
const a0 = await at(A.page, 0), a8 = await at(A.page, 8);
await tt('touchStart', a0); for (let i = 1; i <= 8; i++) { await tt('touchMove', { x: a0.x + (a8.x - a0.x) * i / 8, y: a0.y + (a8.y - a0.y) * i / 8 }); await A.page.waitForTimeout(16); } await tt('touchEnd');
await A.page.waitForTimeout(700);
const seen = await Promise.all([A, B].map(x => x.page.evaluate(() => window.__broccoli.match.armies.filter(a => a.owner === 0).length)));
check('an order from A is run by the server and appears on both screens', seen[0] === 1 && seen[1] === 1, String(seen));
let s = await sameAt([A.page, B.page]);
check('both screens hold the identical state at the same tick', s.same, `tick ${s.tick}`);
// the same command id sent twice (a resend) is applied once
const before = await B.page.evaluate(() => window.__broccoli.match.armies.filter(a => a.owner === 1).length);
await B.page.evaluate(() => { const ws = window.__broccoli.online.net.ws, m = window.__broccoli.match; const src = m.buildings.find(b => b.owner === 1);
  const msg = JSON.stringify({ t: 'cmd', id: 900000, cmd: { type: 'send', player: 1, from: [src.id], to: src.id === 2 ? 3 : 2, pct: 25 } }); ws.send(msg); ws.send(msg); });
await B.page.waitForTimeout(600);
const after = await B.page.evaluate(() => window.__broccoli.match.armies.filter(a => a.owner === 1).length);
check('a duplicated command (same id) creates exactly one army', after - before === 1, `${before} -> ${after}`);
// forged player id: B claims to be player 0; the server uses B's seat
const fake = await B.page.evaluate(() => { const ws = window.__broccoli.online.net.ws; ws.send(JSON.stringify({ t: 'cmd', id: 900001, cmd: { type: 'send', player: 0, from: [0], to: 8, pct: 100 } })); return 1; });
await B.page.waitForTimeout(500);
const g0 = await A.page.evaluate(() => window.__broccoli.match.armies.filter(a => a.owner === 0).length);
check('a client cannot act for another seat', fake === 1 && g0 <= 1, `A armies ${g0}`);
// socket drop -> automatic rejoin to the same seat
const units = await B.page.evaluate(() => window.__broccoli.match.players.map((p, i) => window.__broccoli.match.totalUnits(i)));
await B.page.evaluate(() => window.__broccoli.online.net.ws.close());
await B.page.waitForTimeout(400);
const toast = await B.page.textContent('#toast');
await B.page.waitForFunction(() => window.__broccoli.online.net.ws.readyState === 1, null, { timeout: 10000 });
await B.page.waitForTimeout(600);
s = await sameAt([A.page, B.page]);
const seatB = await B.page.evaluate(() => [window.__broccoli.human, window.__broccoli.match.buildings.filter(b => b.owner === 1).length]);
check('dropped connection: reconnects by itself to the same seat, state identical', seatB[0] === 1 && s.same && toast.length > 0, `seat ${seatB[0]}, buildings ${seatB[1]}, msg "${toast}"`);
// full reload -> menu -> Rejoin -> same seat, no units created out of thin air
await B.page.reload();
await B.page.tap('#btnOnline');
check('after a reload the Rejoin button is offered', await B.page.isVisible('#btnRejoin'));
await B.page.tap('#btnRejoin');
await waitStart(B.page); await B.page.evaluate(HOOK);
await B.page.waitForTimeout(500);
s = await sameAt([A.page, B.page]);
const after2 = await B.page.evaluate(() => [window.__broccoli.human, window.__broccoli.match.players.map((p, i) => window.__broccoli.match.totalUnits(i))]);
check('page reload: rejoins the same seat and the same state', after2[0] === 1 && s.same, `seat ${after2[0]}`);
check('no duplicated units across the reconnects (totals only change by production/combat)', after2[1][1] <= units[1] + 40, `${units[1]} -> ${after2[1][1]}`);
await A.page.screenshot({ path: join(root, 'test-artifacts/online-A.png') });
await B.page.screenshot({ path: join(root, 'test-artifacts/online-B.png') });
// A surrenders: both see the end
await A.page.tap('#btnPause'); await A.page.tap('#btnSurrender');
await Promise.all([A, B].map(x => x.page.waitForSelector('#result.on', { timeout: 10000 })));
const titles = await Promise.all([A, B].map(x => x.page.textContent('#resTitle')));
check('match end reaches both players (defeat / victory)', titles[0] !== titles[1], titles.join(' | '));
check('no page errors (1v1)', A.errors.length + B.errors.length === 0, [...A.errors, ...B.errors].join(' | '));

// ---------------- 2v2 ----------------
const P = await Promise.all([player(), player(), player(), player()]);
await P[0].page.tap('#btnOnline'); await P[0].page.tap('#btnCreate2');
await P[0].page.waitForSelector('#lobbyInfo b');
const code2 = (await P[0].page.textContent('#lobbyInfo b')).trim();
for (const x of P.slice(1)) { await x.page.tap('#btnOnline'); await x.page.fill('#codeIn', code2); await x.page.tap('#btnJoin'); }
await Promise.all(P.map(x => waitStart(x.page)));
await Promise.all(P.map(x => x.page.evaluate(HOOK)));
const info = await Promise.all(P.map(x => x.page.evaluate(() => [window.__broccoli.human, window.__broccoli.match.players.map(p => p.team).join(''), window.__broccoli.match.map.id])));
check('2v2: four browsers seated 0-3 on Deep Forest, teams left vs right', info.map(i => i[0]).join('') === '0123' && info.every(i => i[1] === '0110' && i[2] === 'deep_forest'), JSON.stringify(info));
await P[0].page.waitForTimeout(1500);
s = await sameAt(P.map(x => x.page));
check('2v2: all four screens identical at the same tick', s.same, `tick ${s.tick}`);
check('no page errors (2v2)', P.every(x => x.errors.length === 0));
await browser.close(); srv.kill();
console.log(results.join('\n'));
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} online checks passed`);
process.exit(failed ? 1 : 0);
