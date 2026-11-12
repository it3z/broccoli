import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIController, BALANCE, MAPS, Match, segHitsCircle, type MapDef, type SimEvent } from '../packages/simulation/src/index';

type B = MapDef['buildings'][number];
const mk = (buildings: B[], obstacles: MapDef['obstacles'] = []): MapDef => ({
  id: 't', name: { ar: 't', en: 't' }, biome: 'meadow', width: 1600, height: 900, slots: 2, buildings, obstacles,
});
const two = [{ slot: 0, team: 0, isAI: false }, { slot: 1, team: 1, isAI: true }];
const match = (map: MapDef, seed = 1) => new Match({ map, balance: BALANCE, seed, players: two });
const run = (m: Match, ticks: number, each?: (ev: SimEvent[]) => void) => {
  for (let i = 0; i < ticks && m.phase === 'playing'; i++) { m.step(); each?.(m.events); }
};
const sane = (m: Match) => {
  for (const b of m.buildings) assert.ok(Number.isFinite(b.garrison) && b.garrison >= 0, `bad garrison ${b.garrison}`);
  for (const w of m.waves) assert.ok(Number.isInteger(w.units) && w.units > 0);
  for (const p of m.players) assert.ok(p.morale >= 0 && p.morale <= BALANCE.morale.max);
};
const FAR: B = { type: 'farm', level: 1, x: 1500, y: 800, slot: 1, garrison: 5 };

test('every map: 2 owned + >=3 neutral buildings, routes avoid obstacles', () => {
  for (const map of MAPS) {
    const m = match(map);
    assert.equal(m.buildings.filter(b => b.owner === 0).length, 2);
    assert.ok(m.buildings.filter(b => b.owner === -1).length >= 3);
    for (const row of m.paths) for (const p of row) {
      assert.ok(Number.isFinite(p.len));
      for (let i = 1; i < p.pts.length; i++) for (const o of map.obstacles) {
        assert.ok(!segHitsCircle(p.pts[i - 1], p.pts[i], o, o.r), `${map.id}: route crosses ${o.kind}`);
      }
    }
  }
});

test('production: fractional accrual, capacity cap, neutral buildings do not produce', () => {
  const m = match(MAPS[0]);
  const farm = m.buildings[0], neutral = m.buildings.find(b => b.owner === -1 && b.type === 'farm')!;
  const n0 = neutral.garrison;
  run(m, 100); // 5s at 1.0/s
  assert.ok(Math.abs(farm.garrison - 23) < 1e-6);
  assert.equal(neutral.garrison, n0);
  run(m, 2000);
  assert.equal(farm.garrison, m.capacity(farm));
});

for (const [pct, expected] of [[25, 5], [50, 10], [75, 15], [100, 20]] as const) {
  test(`send ${pct}% moves exactly ${expected} of 20 units, as waves over time`, () => {
    const m = match(mk([
      { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 20 },
      { type: 'forge', level: 1, x: 600, y: 450, slot: 0, garrison: 0 }, FAR]));
    assert.equal(m.sendCount(m.buildings[0], pct), expected);
    m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct });
    m.step();
    if (expected > BALANCE.waveSize) assert.ok(m.buildings[0].garrison > 20 - expected, 'units must not teleport at once');
    let launches = 0;
    run(m, 300, ev => { launches += ev.filter(e => e.type === 'launch').length; sane(m); });
    assert.equal(m.buildings[0].garrison, 20 - expected);
    assert.equal(m.buildings[1].garrison, expected);
    assert.equal(m.waves.length, 0);
    assert.equal(launches + 1, Math.ceil(expected / BALANCE.waveSize));
  });
}

test('repeated or invalid orders never duplicate or go negative', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 20 },
    { type: 'forge', level: 1, x: 600, y: 450, slot: 0, garrison: 0 }, FAR]));
  for (let i = 0; i < 5; i++) m.enqueue({ type: 'send', player: 0, from: [0, 0], to: 1, pct: 100 });
  m.enqueue({ type: 'send', player: 0, from: [2], to: 1, pct: 100 });         // not my building
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 33 as never }); // bad percent
  m.enqueue({ type: 'send', player: 0, from: [0], to: 99, pct: 50 });         // no such target
  m.enqueue({ type: 'upgrade', player: 0, building: 2 });                    // not mine
  m.enqueue({ type: 'send', player: 7, from: [0], to: 1, pct: 50 });          // no such player
  run(m, 300, () => sane(m));
  assert.equal(m.buildings[0].garrison, 0);
  assert.equal(m.buildings[1].garrison, 20);
  assert.equal(m.buildings[2].owner, 1);
});

test('capture: survivors follow the documented formula and level drops', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 8 },
    { type: 'farm', level: 2, x: 500, y: 450, slot: -1, garrison: 4 }, FAR]));
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 100 });
  const A = m.attackFactor(0), D = m.defenseFactor(m.buildings[1]);
  let caps = 0;
  run(m, 200, ev => { caps += ev.filter(e => e.type === 'capture').length; });
  // production resumes after capture, so compare right at the capture: recompute from stats
  assert.equal(caps, 1);
  assert.equal(m.buildings[1].owner, 0);
  assert.equal(m.buildings[1].level, 1);
  const survivors = ((8 * A) / D - 4) * D / A;
  assert.ok(Math.abs(m.players[0].stats.lost - (8 - survivors)) < 1e-9);
  assert.ok(m.players[0].morale > BALANCE.morale.start);
});

test('three buildings attack one target together: ownership changes exactly once', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 300, y: 250, slot: 0, garrison: 8 },
    { type: 'tower', level: 1, x: 300, y: 650, slot: 0, garrison: 8 },
    { type: 'tower', level: 1, x: 100, y: 450, slot: 0, garrison: 8 },
    { type: 'forge', level: 1, x: 500, y: 450, slot: -1, garrison: 12 }, FAR]));
  m.enqueue({ type: 'send', player: 0, from: [0, 1, 2], to: 3, pct: 100 });
  let caps = 0;
  run(m, 300, ev => { caps += ev.filter(e => e.type === 'capture').length; sane(m); });
  assert.equal(caps, 1);
  assert.equal(m.buildings[3].owner, 0);
  const A0 = 1 + BALANCE.morale.attackPerPoint * BALANCE.morale.start;
  assert.ok(m.buildings[3].garrison > 0 && m.buildings[3].garrison < 24 - 12 * BALANCE.forge.def / A0 + 1e-6);
  assert.equal(m.forgeCount(0), 1);
});

test('upgrade and convert cost units and time; a farm turned into a tower stops producing', () => {
  const m = match(mk([{ type: 'farm', level: 1, x: 200, y: 450, slot: 0, garrison: 20 }, FAR]));
  const b = m.buildings[0];
  m.enqueue({ type: 'upgrade', player: 0, building: 0 });
  m.step();
  assert.equal(b.garrison, 20 - BALANCE.farm.upgradeCost[0]);
  assert.equal(b.busyKind, 'upgrade');
  run(m, BALANCE.farm.upgradeTimeSec[0] * BALANCE.tickRate - 2);
  assert.equal(b.level, 1);
  assert.equal(b.garrison, 12, 'no production while upgrading');
  run(m, 2);
  assert.equal(b.level, 2);
  run(m, 400);
  assert.ok(b.garrison > 25);
  const before = b.garrison;
  m.enqueue({ type: 'convert', player: 0, building: 0, to: 'tower' });
  m.enqueue({ type: 'convert', player: 0, building: 0, to: 'forge' }); // ignored: already busy
  m.step();
  assert.ok(Math.abs(b.garrison - (before - BALANCE.convert.cost)) < 0.06);
  const during = b.garrison;
  run(m, BALANCE.convert.timeSec * BALANCE.tickRate);
  assert.equal(b.type, 'tower');
  assert.equal(b.level, 1);
  run(m, 400);
  assert.equal(b.garrison, during, 'towers never produce');
  assert.equal(m.income(0), 0);
});

test('tower really shoots marching enemies; morale and forge change a documented battle', () => {
  const battle = (forge: boolean, morale: number, tower: boolean) => {
    const m = match(mk([
      { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 40 },
      { type: 'forge', level: 1, x: 100, y: 100, slot: forge ? 0 : -1, garrison: 5 },
      { type: tower ? 'tower' : 'farm', level: 1, x: 700, y: 450, slot: 1, garrison: 30 },
      { type: 'farm', level: 1, x: 1500, y: 800, slot: 1, garrison: 1 }]));
    m.players[0].morale = morale;
    m.players[0].lastActionTick = 1e9; m.players[1].lastActionTick = 1e9;
    m.enqueue({ type: 'send', player: 0, from: [0], to: 2, pct: 50 });
    let shots = 0, left = 30;
    for (let i = 0; i < 400; i++) { m.step(); shots += m.events.filter(e => e.type === 'shot').length; left = Math.min(left, m.buildings[2].garrison); }
    return { left, shots, owner: m.buildings[2].owner };
  };
  const base = battle(false, 1, false), forged = battle(true, 1, false), high = battle(false, 5, false), tw = battle(false, 1, true);
  assert.equal(base.shots, 0);
  // 20 attackers at morale 1 vs a level-1 farm at morale 1 (morale drifts slightly between the 3 waves)
  const D = 1.0 * (1 + BALANCE.morale.defensePerPoint * 1);
  const expected = 30 - (20 * (1 + BALANCE.morale.attackPerPoint)) / D;
  assert.ok(Math.abs(base.left - expected) < 0.6, `base ${base.left} vs ${expected}`);
  assert.ok(forged.left < base.left - 1, 'forge must strengthen the attack');
  assert.ok(high.left < base.left - 3, 'high morale must strengthen the attack');
  assert.ok(tw.shots >= 3, 'tower fired');
  assert.ok(tw.left > base.left + 3, 'tower killed attackers before they arrived');
});

test('losing a building cancels its outgoing orders', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 60 },
    { type: 'tower', level: 1, x: 400, y: 450, slot: 1, garrison: 40 },
    { type: 'forge', level: 1, x: 1400, y: 450, slot: 1, garrison: 0 }]));
  m.enqueue({ type: 'send', player: 1, from: [1], to: 2, pct: 100 });
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 100 });
  run(m, 600, () => sane(m));
  assert.equal(m.buildings[1].owner, 0);
  assert.equal(m.dispatches.filter(d => d.owner === 1).length, 0);
});

test('surrender ends the match for the other side', () => {
  const m = match(MAPS[0]);
  m.enqueue({ type: 'surrender', player: 0 });
  m.step();
  assert.equal(m.phase, 'ended');
  assert.equal(m.winnerTeam, 1);
});

test('same seed and commands replay to the identical state', () => {
  const play = () => {
    const m = new Match({ map: MAPS[1], balance: BALANCE, seed: 42, players: [0, 1, 2, 3].map(s => ({ slot: s, team: s, isAI: true })) });
    const ais = [0, 1, 2, 3].map(i => new AIController(i, 'hard', 42));
    const hashes: string[] = [];
    for (let i = 0; i < 3000 && m.phase === 'playing'; i++) { ais.forEach(a => a.update(m)); m.step(); if (i % 500 === 0) hashes.push(m.hash()); }
    hashes.push(m.hash());
    return hashes;
  };
  assert.deepEqual(play(), play());
});

for (const diff of ['easy', 'normal', 'hard'] as const) {
  test(`AI (${diff}) captures, upgrades and beats an idle player`, () => {
    const m = match(MAPS[0], 7);
    const ai = new AIController(1, diff, 7);
    let caps = 0, ups = 0;
    for (let i = 0; i < 20 * 600 && m.phase === 'playing'; i++) {
      ai.update(m); m.step(); sane(m);
      for (const e of m.events) {
        if (e.type === 'capture' && e.by === 1) caps++;
        if (e.type === 'upgraded' && m.buildings[e.building].owner === 1) ups++;
      }
    }
    assert.ok(caps >= 3, `captures ${caps}`);
    assert.ok(ups >= 1, `upgrades ${ups}`);
    assert.equal(m.phase, 'ended');
    assert.equal(m.winnerTeam, 1);
  });
}

test('hard AI builds its own forge and tower when none can be captured', () => {
  const farms: B[] = [0, 1, 2, 3, 4, 5].map(i => ({ type: 'farm', level: 1, x: 900 + (i % 3) * 200, y: 250 + Math.floor(i / 3) * 300, slot: 1, garrison: 10 }));
  const m = match(mk([{ type: 'tower', level: 4, x: 150, y: 450, slot: 0, garrison: 400 }, ...farms]), 3);
  const ai = new AIController(1, 'hard', 3);
  const built = new Set<string>();
  for (let i = 0; i < 20 * 240; i++) {
    ai.update(m); m.step();
    for (const e of m.events) if (e.type === 'converted') built.add(m.buildings[e.building].type);
  }
  assert.ok(built.has('forge'), 'forge built');
  assert.ok(built.has('tower'), 'tower built');
  assert.ok(m.buildings.some(b => b.owner === 1 && b.type === 'farm' && b.level >= 3), 'farms upgraded');
});

test('AI-vs-AI matches on every map resolve, with reinforcements and no broken state', () => {
  let decided = 0, rescues = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const map = MAPS[seed % 2];
    const n = map.slots;
    const m = new Match({ map, balance: BALANCE, seed, players: Array.from({ length: n }, (_, s) => ({ slot: s, team: s, isAI: true })) });
    const ais = Array.from({ length: n }, (_, i) => new AIController(i, (['hard', 'normal', 'easy'] as const)[(seed + i) % 3], seed));
    while (m.phase === 'playing') {
      ais.forEach(a => a.update(m)); m.step();
      for (const e of m.events) if (e.type === 'reinforce') rescues++;
      if (m.tick % 200 === 0) sane(m);
    }
    sane(m);
    if (m.winnerTeam !== null) decided++;
  }
  console.log(`    decided ${decided}/12, reinforcements ${rescues}`);
  assert.ok(rescues >= 1, 'AI reinforced its own buildings');
  assert.ok(decided >= 8, `decided ${decided}/12`);
});
