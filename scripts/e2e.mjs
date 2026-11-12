// Browser end-to-end check: plays a real match with touch gestures on a phone-sized landscape viewport,
// then repeats the core gesture with a mouse on a desktop viewport. Requires `npm run build` first.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'test-artifacts'); mkdirSync(shots, { recursive: true });
const url = pathToFileURL(join(root, 'dist/broccoli.html')).href;
const results = []; let failed = 0;
const check = (name, ok, info = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); if (!ok) failed++; };

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(opts, tag) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  return { ctx, page, errors, tag };
}
const state = page => page.evaluate(() => {
  const s = window.__broccoli, m = s.match;
  return {
    tick: m.tick, phase: m.phase, winner: m.winnerTeam, waves: m.waves.map(w => ({ owner: w.owner, units: w.units })),
    b: m.buildings.map(b => ({ id: b.id, type: b.type, owner: b.owner, level: b.level, g: Math.floor(b.garrison), busy: b.busyKind })),
    sel: [...s.selection], pct: s.pct, frameMs: s.renderer.frameMs, scrollY: window.scrollY, morale: m.players[0].morale,
  };
});
const at = (page, id) => page.evaluate(i => window.__broccoli.screenOf(i), id);

// ---------- phone, touch ----------
{
  const { ctx, page, errors } = await open({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  }, 'phone');
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: 1 })) });
  const drag = async (a, b) => {
    await touch('touchStart', [a]);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 }]); await page.waitForTimeout(16); }
    await page.waitForTimeout(60);
    return () => touch('touchEnd', []);
  };

  await page.screenshot({ path: join(shots, '1-menu.png') });
  await page.tap('#btnSolo');
  await page.screenshot({ path: join(shots, '2-setup.png') });
  await page.tap('#segDiff .segb:nth-child(3)'); // hard
  await page.tap('#btnStart');
  await page.waitForTimeout(700);
  let s = await state(page);
  check('match starts with 2 owned and >=3 neutral buildings', s.b.filter(b => b.owner === 0).length === 2 && s.b.filter(b => b.owner === -1).length >= 3);
  const g0 = s.b[0].g;
  await page.waitForTimeout(2500);
  s = await state(page);
  check('production is visible on the board', s.b[0].g > g0, `${g0} -> ${s.b[0].g}`);

  // 100% from building 0 to the neutral farm 8
  await page.tap('.pct[data-pct="100"]');
  const release = await drag(await at(page, 0), await at(page, 8));
  await page.screenshot({ path: join(shots, '3-drag.png') });
  await release();
  await page.waitForTimeout(900);
  s = await state(page);
  check('touch drag sends a marching army', s.waves.some(w => w.owner === 0), `${s.waves.filter(w => w.owner === 0).length} waves`);
  check('percent button applied', s.pct === 100);
  await page.screenshot({ path: join(shots, '4-march.png') });
  await page.waitForTimeout(4500);
  s = await state(page);
  check('army arrived and captured the farm', s.b[8].owner === 0, `owner ${s.b[8].owner}, garrison ${s.b[8].g}`);
  check('morale rose after the capture', s.morale > 1, s.morale.toFixed(2));

  // cancelled drag: release on empty ground
  const a1 = await at(page, 1);
  await (await drag(a1, { x: a1.x + 60, y: a1.y - 110 }))();
  await page.waitForTimeout(400);
  const s2 = await state(page);
  check('releasing on empty ground cancels the order', s2.b[1].g >= s.b[1].g && s2.waves.filter(w => w.owner === 0).length === 0);

  // select + upgrade building 1 (level 1 farm, cost 8)
  await page.touchscreen.tap(a1.x, a1.y);
  await page.waitForTimeout(150);
  s = await state(page);
  check('tap selects a building', s.sel.length === 1 && s.sel[0] === 1);
  await page.screenshot({ path: join(shots, '5-selected.png') });
  await page.tap('#act-upgrade');
  await page.waitForTimeout(300);
  s = await state(page);
  check('upgrade starts and costs units', s.b[1].busy === 'upgrade');
  await page.waitForTimeout(4300);
  s = await state(page);
  check('upgrade finishes', s.b[1].level === 2);

  // convert the captured farm into a tower once it can afford it; tap-select then tap-target send
  await page.waitForTimeout(9000);
  s = await state(page);
  check('AI is active (captured or attacking)', s.b.some(b => b.owner === 1 && ![2, 3].includes(b.id)) || s.waves.some(w => w.owner === 1));
  const empty = await page.evaluate(() => { const r = window.__broccoli.renderer.toScreen(300, 860); return [r.x, r.y]; });
  await page.touchscreen.tap(...empty);
  check('tap on empty ground clears the selection', (await state(page)).sel.length === 0);
  await page.touchscreen.tap(...Object.values(await at(page, 0)));
  await page.touchscreen.tap(...Object.values(await at(page, 8)));
  await page.waitForTimeout(700);
  s = await state(page);
  check('tap-select then tap-target reinforces', s.waves.some(w => w.owner === 0) && s.sel.length === 0);
  await page.screenshot({ path: join(shots, '6-midgame.png') });
  check('page never scrolled', s.scrollY === 0);
  check('frame time is healthy', s.frameMs > 0 && s.frameMs < 34, s.frameMs.toFixed(1) + ' ms');

  // pause really stops the simulation
  await page.tap('#btnPause');
  const t1 = (await state(page)).tick; await page.waitForTimeout(600);
  check('pause stops the simulation', (await state(page)).tick === t1);
  await page.screenshot({ path: join(shots, '7-pause.png') });
  await page.tap('#btnSurrender');
  await page.waitForTimeout(1900);
  s = await state(page);
  check('surrender ends the match as a defeat', s.phase === 'ended' && s.winner === 1 && await page.isVisible('#result.on'));
  await page.screenshot({ path: join(shots, '8-result.png') });
  await page.tap('#btnAgain');
  await page.waitForTimeout(600);
  s = await state(page);
  check('play again starts a fresh match', s.phase === 'playing' && s.tick < 40);

  // 4-player map
  await page.tap('#btnPause'); await page.tap('#btnQuit');
  await page.tap('#btnSolo'); await page.tap('#maps .map:nth-child(2)'); await page.tap('#segOpp .segb:nth-child(3)'); await page.tap('#btnStart');
  await page.waitForTimeout(6000);
  s = await state(page);
  check('4-player map runs with 3 AI opponents', new Set(s.b.map(b => b.owner)).size >= 4 && s.tick > 80);
  await page.screenshot({ path: join(shots, '9-forest.png') });
  check('no console errors (phone)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---------- desktop, mouse ----------
{
  const { ctx, page, errors } = await open({ viewport: { width: 1366, height: 768 } }, 'desktop');
  await page.click('#btnSettings'); await page.click('#segLang .segb:nth-child(2)'); await page.click('#settings [data-back]');
  check('language switch works', (await page.textContent('#btnSolo')) === 'Solo Skirmish');
  await page.click('#btnSolo'); await page.click('#btnStart');
  await page.waitForTimeout(500);
  const a = await at(page, 0), b = await at(page, 4);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 }); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(800);
  const s = await state(page);
  check('mouse drag sends an army (default 50%)', s.waves.some(w => w.owner === 0) && s.pct === 50);
  await page.screenshot({ path: join(shots, '10-desktop.png') });
  check('no console errors (desktop)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(results.join('\n'));
console.log(failed ? `\n${failed} check(s) failed` : '\nall browser checks passed');
process.exit(failed ? 1 : 0);
