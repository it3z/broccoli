// Browser end-to-end check: plays real matches with touch gestures on a phone-sized landscape viewport,
// lets an AI play the human seat through full matches at every difficulty, then repeats the core gesture
// with a mouse on a desktop viewport. Requires `npm run build` first.
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
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

async function open(opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  return { ctx, page, errors };
}
const state = page => page.evaluate(() => {
  const s = window.__broccoli, m = s.match;
  return {
    tick: m.tick, phase: m.phase, winner: m.winnerTeam,
    armies: m.armies.map(a => ({ owner: a.owner, units: a.units, state: a.state, to: a.to })),
    b: m.buildings.map(b => ({ id: b.id, type: b.type, owner: b.owner, level: b.level, g: Math.floor(b.garrison), busy: b.busyKind })),
    sel: [...s.selection], pct: s.pct, frameMs: s.renderer.frameMs, sprites: s.renderer.drawnSoldiers, scrollY: window.scrollY, morale: m.players[0].morale,
    hudUnits: document.getElementById('units').textContent, hudIncome: document.getElementById('income').textContent,
    chips: [...document.querySelectorAll('#foes .chip')].map(c => Number(c.textContent.replace(/\D/g, ''))),
    counts: m.players.map(p => m.buildings.filter(b => b.owner === p.id).length), units: m.totalUnits(0), income: m.income(0),
    toast: document.getElementById('toast').classList.contains('hidden') ? '' : document.getElementById('toast').textContent,
    hint: !document.getElementById('hint').classList.contains('hidden'),
  };
});
const at = (page, id) => page.evaluate(i => window.__broccoli.screenOf(i), id);

// ---------- phone, touch ----------
{
  const { ctx, page, errors } = await open({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, userAgent: UA });
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i + 1 })) });
  const drag = async (a, b) => {
    await touch('touchStart', [a]);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 }]); await page.waitForTimeout(16); }
    await page.waitForTimeout(60);
    return () => touch('touchEnd', []);
  };

  await page.screenshot({ path: join(shots, '1-menu.png') });
  await page.tap('#btnSolo');
  await page.tap('#segDiff .segb:nth-child(1)'); // easy, so the scripted steps below are not disturbed too early
  await page.tap('#btnStart');
  await page.waitForTimeout(700);
  let s = await state(page);
  check('match starts with 2 owned and >=3 neutral buildings', s.b.filter(b => b.owner === 0).length === 2 && s.b.filter(b => b.owner === -1).length >= 3);
  check('tutorial hint is showing before the first order', s.hint);
  const g0 = s.b[0].g;
  await page.waitForTimeout(2500);
  s = await state(page);
  check('production is visible on the board', s.b[0].g > g0, `${g0} -> ${s.b[0].g}`);
  check('I: HUD +X/s equals the real income', s.hudIncome === `+${s.income.toFixed(1)}/s`, s.hudIncome);

  // M: percent choice + drag. 100% from building 0 to the neutral farm 8
  await page.tap('.pct[data-pct="100"]');
  const before = (await state(page)).b[0].g;
  const release = await drag(await at(page, 0), await at(page, 8));
  await page.screenshot({ path: join(shots, '3-drag.png') });
  await release();
  await page.waitForTimeout(500);
  s = await state(page);
  const mine = s.armies.filter(a => a.owner === 0);
  check('touch drag sends ONE army with the previewed count', mine.length === 1 && Math.abs(mine[0].units - before) <= 1, `${mine.length} army, ${mine[0]?.units} units (source had ${before})`);
  check('source was emptied exactly once', s.b[0].g <= 1);
  check('hint leaves after the first valid order', !s.hint);
  check('soldier sprites are drawn for the army', s.sprites >= Math.min(10, mine[0]?.units ?? 99), `${s.sprites} sprites`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(shots, '4-march.png') });
  await page.waitForFunction(() => window.__broccoli.match.armies.some(a => a.owner === 0 && a.state === 'fighting'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '5-battle.png') });
  await page.waitForTimeout(3000);
  s = await state(page);
  check('D: army arrived, fought and captured the farm', s.b[8].owner === 0, `owner ${s.b[8].owner}, garrison ${s.b[8].g}`);
  check('H: building chips equal real ownership', JSON.stringify(s.chips) === JSON.stringify(s.counts), `${s.chips} vs ${s.counts}`);
  check('HUD unit total equals the real total', s.hudUnits.replace(/\D/g, '') === String(s.units), s.hudUnits);
  check('morale rose after the capture', s.morale > 1, s.morale.toFixed(2));

  // empty source: polite message, no order
  const a0 = await at(page, 0);
  await page.evaluate(() => { window.__broccoli.match.buildings[0].garrison = 0.4; });
  await (await drag(a0, await at(page, 8)))();
  await page.waitForTimeout(250);
  s = await state(page);
  check('sending from an empty building shows a small message and sends nothing', s.toast.length > 0 && s.armies.filter(a => a.owner === 0).length === 0, s.toast);

  // cancelled drag: release on empty ground
  const a1 = await at(page, 1);
  await (await drag(a1, { x: a1.x + 60, y: a1.y - 110 }))();
  await page.waitForTimeout(300);
  let s2 = await state(page);
  check('M: releasing on empty ground cancels the order', s2.armies.filter(a => a.owner === 0).length === 0);

  // second finger during a drag cancels it instead of issuing an order
  await touch('touchStart', [{ ...a1, id: 1 }]);
  const t8 = await at(page, 8);
  await touch('touchMove', [{ x: (a1.x + t8.x) / 2, y: (a1.y + t8.y) / 2, id: 1 }]);
  await touch('touchMove', [{ ...t8, id: 1 }]);
  await touch('touchStart', [{ ...t8, id: 1 }, { x: t8.x + 80, y: t8.y, id: 2 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  s2 = await state(page);
  check('M: a second finger cancels the gesture, no accidental order', s2.armies.filter(a => a.owner === 0).length === 0);

  // HUD taps do not reach the battlefield
  await page.tap('.pct[data-pct="25"]'); await page.tap('#btnAll'); await page.tap('#btnAll');
  s2 = await state(page);
  check('M: tapping HUD buttons sends nothing', s2.pct === 25 && s2.armies.filter(a => a.owner === 0).length === 0 && s2.sel.length === 0);

  // select + upgrade building 1
  await page.touchscreen.tap(a1.x, a1.y);
  await page.waitForTimeout(150);
  s = await state(page);
  check('tap selects a building', s.sel.length === 1 && s.sel[0] === 1);
  await page.screenshot({ path: join(shots, '6-selected.png') });
  await page.tap('#act-upgrade');
  await page.waitForTimeout(300);
  s = await state(page);
  check('upgrade starts and costs units', s.b[1].busy === 'upgrade');
  await page.waitForTimeout(4300);
  s = await state(page);
  check('upgrade finishes', s.b[1].level === 2);
  const empty = await page.evaluate(() => { const r = window.__broccoli.renderer.toScreen(300, 860); return [r.x, r.y]; });
  await page.touchscreen.tap(...empty);
  check('tap on empty ground clears the selection', (await state(page)).sel.length === 0);
  await page.tap('.pct[data-pct="50"]');
  await page.touchscreen.tap(...Object.values(await at(page, 1)));
  await page.touchscreen.tap(...Object.values(await at(page, 8)));
  await page.waitForTimeout(500);
  s = await state(page);
  check('C: tap-select then tap-target sends a reinforcement', s.armies.some(a => a.owner === 0 && a.to === 8) && s.sel.length === 0);
  check('page never scrolled', s.scrollY === 0);

  // K: pause, wait, resume: no jump in time or production
  await page.tap('#btnPause');
  const p1 = await state(page); await page.waitForTimeout(1500);
  const p2 = await state(page);
  check('K: pause stops the simulation', p2.tick === p1.tick);
  await page.screenshot({ path: join(shots, '7-pause.png') });
  await page.tap('#btnPauseHow'); await page.waitForTimeout(100);
  check('instructions open from the pause menu', await page.isVisible('#howto.on'));
  await page.tap('#howto [data-back]');
  check('…and return to the paused match', !(await page.isVisible('#howto.on')) && (await state(page)).tick === p1.tick);
  await page.tap('#btnResume'); await page.waitForTimeout(100);
  const p3 = await state(page);
  check('K: resume does not jump ahead', p3.tick - p1.tick <= 4, `+${p3.tick - p1.tick} ticks after 1.5 s paused`);
  // K: Safari sent to the background
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const h1 = await state(page); await page.waitForTimeout(1200);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const h2 = await state(page);
  check('K: hiding the page pauses the match (no hidden production)', h2.tick - h1.tick <= 2 && await page.isVisible('#pause.on'), `+${h2.tick - h1.tick} ticks`);
  await page.tap('#btnResume');

  // danger marker: force an enemy army at one of my buildings and look at the screen
  await page.evaluate(() => { const m = window.__broccoli.match; m.buildings[2].garrison = 30; m.enqueue({ type: 'send', player: 1, from: [2], to: 8, pct: 75 }); });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(shots, '8-under-attack.png') });
  s = await state(page);
  check('enemy army is marching on my building', s.armies.some(a => a.owner === 1 && a.to === 8));
  check('frame time is healthy', s.frameMs > 0 && s.frameMs < 34, s.frameMs.toFixed(1) + ' ms');

  // L + N: full matches to the result panel, the player seat driven by an AI through the real game loop
  for (const [diff, child] of [['easy', 1], ['normal', 2], ['hard', 3]]) {
    await page.tap('#btnPause'); await page.tap('#btnQuit');
    await page.tap('#btnSolo'); await page.tap(`#maps .map:nth-child(${child === 2 ? 2 : 1})`); await page.tap(`#segDiff .segb:nth-child(${child})`); await page.tap('#btnStart');
    await page.evaluate(() => window.__broccoli.autoplay('hard', 12));
    await page.waitForFunction(() => window.__broccoli.match.phase === 'ended', null, { timeout: 120000 });
    await page.waitForTimeout(1700);
    s = await state(page);
    const title = await page.textContent('#resTitle');
    check(`L: full match vs ${diff} AI ends with a result panel`, await page.isVisible('#result.on') && title.length > 0,
      `${s.winner === 0 ? 'player seat won' : 'AI won'} at ${Math.floor(s.tick / 20 / 60)}:${String(Math.floor(s.tick / 20) % 60).padStart(2, '0')}`);
    if (diff === 'easy') await page.screenshot({ path: join(shots, '9-result.png') });
    await page.tap('#btnAgain');
    await page.waitForTimeout(500);
    s = await state(page);
    check(`L: play again starts a fresh match (${diff})`, s.phase === 'playing' && s.tick < 40);
  }

  // 4-player map, busy mid-game picture and performance
  await page.tap('#btnPause'); await page.tap('#btnQuit');
  await page.tap('#btnSolo'); await page.tap('#maps .map:nth-child(2)'); await page.tap('#segOpp .segb:nth-child(3)'); await page.tap('#btnStart');
  await page.evaluate(() => window.__broccoli.autoplay('hard', 1));
  await page.waitForTimeout(26000);
  s = await state(page);
  check('4-player map runs with 3 AI opponents', new Set(s.b.map(b => b.owner)).size >= 4 && s.tick > 300);
  check('frame time stays healthy in a 4-player battle', s.frameMs < 34, `${s.frameMs.toFixed(1)} ms, ${s.sprites} sprites, ${s.armies.length} armies`);
  await page.screenshot({ path: join(shots, '10-forest.png') });
  check('O: no console errors (phone)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---------- small embedded viewport (like the in-app viewer in the recording) ----------
{
  const { ctx, page, errors } = await open({ viewport: { width: 620, height: 270 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, userAgent: UA });
  await page.tap('#btnSolo'); await page.tap('#maps .map:nth-child(2)'); await page.tap('#btnStart');
  await page.evaluate(() => window.__broccoli.autoplay('hard', 1));
  await page.waitForTimeout(14000);
  await page.screenshot({ path: join(shots, '11-small.png') });
  const s = await state(page);
  check('small viewport: match runs and armies are drawn', s.tick > 200 && s.frameMs < 34, `${s.frameMs.toFixed(1)} ms`);
  check('O: no console errors (small)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---------- desktop, mouse ----------
{
  const { ctx, page, errors } = await open({ viewport: { width: 1366, height: 768 } });
  await page.click('#btnSettings'); await page.click('#segLang .segb:nth-child(2)');
  await page.click('#segMusic .segb:nth-child(2)'); await page.click('#segFx .segb:nth-child(2)'); await page.click('#settings [data-back]');
  check('language switch works', (await page.textContent('#btnSolo')) === 'Solo Skirmish');
  await page.click('#btnSolo'); await page.click('#btnStart');
  await page.waitForTimeout(500);
  const a = await at(page, 0), b = await at(page, 4);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 }); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(800);
  const s = await state(page);
  check('mouse drag sends an army (default 50%)', s.armies.some(x => x.owner === 0) && s.pct === 50);
  check('reduced-effects setting is applied', await page.evaluate(() => window.__broccoli.lowFx === true));
  await page.screenshot({ path: join(shots, '12-desktop.png') });
  check('O: no console errors (desktop)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(results.join('\n'));
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
