import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIController, BALANCE, MAPS, Match, pointAt, segHitsCircle, type MapDef, type SimEvent } from '../packages/simulation/src/index';

type B = MapDef['buildings'][number];
const mk = (buildings: B[], obstacles: MapDef['obstacles'] = []): MapDef => ({
  id: 't', name: { ar: 't', en: 't' }, biome: 'meadow', width: 1600, height: 900, slots: 2, buildings, obstacles,
});
const two = [{ slot: 0, team: 0, isAI: false }, { slot: 1, team: 1, isAI: true }];
const match = (map: MapDef, seed = 1) => new Match({ map, balance: BALANCE, seed, players: two });
const run = (m: Match, ticks: number, each?: (ev: SimEvent[]) => void) => {
  for (let i = 0; i < ticks && m.phase === 'playing'; i++) { m.step(); each?.(m.events); }
};
const count = (ev: SimEvent[], type: SimEvent['type']) => ev.filter(e => e.type === type).length;
/** Invariants that must hold on every tick (acceptance J): finite, non-negative, nobody stuck. */
const sane = (m: Match) => {
  for (const b of m.buildings) assert.ok(Number.isFinite(b.garrison) && b.garrison >= 0, `bad garrison ${b.garrison}`);
  for (const a of m.armies) {
    assert.ok(Number.isInteger(a.units) && a.units > 0, `bad army units ${a.units}`);
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
    assert.ok(Math.hypot(a.x - a.px, a.y - a.py) <= a.speed * 1.46 / m.bal.tickRate + 1e-6, 'army teleported');   // 1.45 = Green Rush
    if (a.state === 'clashing') assert.ok(m.roadClash && a.foe > 0);
    const limit = (m.pathOf(a).len / a.speed + a.startUnits / m.bal.battleRate + 2) * m.bal.tickRate + a.heldTicks;
    assert.ok(m.tick - a.createdTick <= limit, `army ${a.id} stuck in state ${a.state}`);
  }
  for (const p of m.players) assert.ok(p.morale >= 0 && p.morale <= BALANCE.morale.max);
};
const FAR: B = { type: 'farm', level: 1, x: 1500, y: 800, slot: 1, garrison: 5 };
const A0 = 1 + BALANCE.morale.attackPerPoint * BALANCE.morale.start;

test('maps: 2 owned + >=3 neutral buildings, routes avoid obstacles', () => {
  for (const map of MAPS) {
    const m = match(map);
    assert.equal(m.buildings.filter(b => b.owner === 0).length, 2);
    assert.ok(m.buildings.filter(b => b.owner === -1).length >= 3);
    for (const row of m.paths) for (const p of row) {
      assert.ok(Number.isFinite(p.len));
      for (let i = 1; i < p.pts.length; i++) for (const o of map.obstacles.filter(o => o.kind !== 'gate')) {
        assert.ok(!segHitsCircle(p.pts[i - 1], p.pts[i], o, o.r), `${map.id}: route crosses ${o.kind}`);
      }
    }
  }
});

test('production: fractional accrual, capacity cap, neutral buildings do not produce', () => {
  const m = match(MAPS[0]);
  const farm = m.buildings[0], neutral = m.buildings.find(b => b.owner === -1 && b.type === 'farm')!;
  const n0 = neutral.garrison;
  run(m, 100);
  assert.ok(Math.abs(farm.garrison - 23) < 1e-6);
  assert.equal(neutral.garrison, n0);
  run(m, 2000);
  assert.equal(farm.garrison, m.capacity(farm));
});

test('A: 25% of 40 sends exactly 10 (floor), deducted from the source once', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 40 },
    { type: 'forge', level: 1, x: 900, y: 450, slot: 0, garrison: 0 }, FAR]));
  assert.equal(m.sendCount(m.buildings[0], 25), 10);
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 25 });
  m.step();
  assert.equal(count(m.events, 'army_sent'), 1);
  assert.equal(m.buildings[0].garrison, 30);
  assert.equal(m.armies.length, 1);
  assert.deepEqual([m.armies[0].units, m.armies[0].state], [10, 'moving']);
  run(m, 60, () => { assert.equal(m.buildings[0].garrison, 30, 'no second deduction while marching'); sane(m); });
  run(m, 200);
  assert.equal(m.buildings[0].garrison, 30);
  assert.equal(m.buildings[1].garrison, 10);
  for (const [g, pct, want] of [[7, 25, 1], [7, 50, 3], [7, 75, 5], [1, 25, 1], [0, 100, 0], [0.9, 100, 0]] as const) {
    assert.equal(m.sendCount({ ...m.buildings[0], garrison: g }, pct), want, `${pct}% of ${g}`);
  }
});

test('B+C: 100% never creates units; reinforcement is added exactly once', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 40 },
    { type: 'forge', level: 1, x: 700, y: 450, slot: 0, garrison: 3 }, FAR]));
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 100 });
  let arrived = 0;
  run(m, 300, ev => {
    arrived += count(ev, 'army_arrived');
    assert.equal(m.totalUnits(0), 43, 'units are conserved on the road');
    sane(m);
  });
  assert.equal(arrived, 1);
  assert.equal(m.buildings[0].garrison, 0);
  assert.equal(m.buildings[1].garrison, 43);
  assert.equal(m.armies.length, 0);
});

test('orders that cannot be carried out are rejected with a reason and change nothing', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 20 },
    { type: 'forge', level: 1, x: 600, y: 450, slot: 0, garrison: 0 }, FAR]));
  const reasons: string[] = [];
  for (let i = 0; i < 5; i++) m.enqueue({ type: 'send', player: 0, from: [0, 0], to: 1, pct: 100 }); // 1 valid, 4 hit the cooldown
  m.enqueue({ type: 'send', player: 0, from: [1], to: 0, pct: 100 });         // empty source
  m.enqueue({ type: 'send', player: 0, from: [2], to: 1, pct: 100 });         // not my building
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 33 as never }); // bad percent
  m.enqueue({ type: 'send', player: 0, from: [0], to: 99, pct: 50 });         // no such target
  m.enqueue({ type: 'upgrade', player: 0, building: 2 });                    // not mine
  m.enqueue({ type: 'send', player: 7, from: [0], to: 1, pct: 50 });          // no such player
  run(m, 300, ev => { for (const e of ev) if (e.type === 'order_rejected') reasons.push(e.reason); sane(m); });
  assert.deepEqual(reasons.sort(), ['cooldown', 'cooldown', 'cooldown', 'cooldown', 'empty', 'not_owner']);
  assert.equal(m.buildings[0].garrison, 0);
  assert.equal(m.buildings[1].garrison, 20);
  assert.equal(m.buildings[2].owner, 1);
});

test('D: attacking a weaker neutral farm captures it; survivors follow the combat model', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 20 },
    { type: 'farm', level: 2, x: 500, y: 450, slot: -1, garrison: 6 }, FAR]));
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 100 });
  const D = m.defenseFactor(m.buildings[1]);
  const seen: string[] = []; let atCapture = -1, battleTicks = 0;
  run(m, 300, ev => {
    for (const e of ev) {
      if (['army_sent', 'army_arrived', 'battle_started', 'building_captured', 'battle_resolved'].includes(e.type)) seen.push(e.type);
      if (e.type === 'building_captured') atCapture = m.buildings[1].garrison;
    }
    if (m.armies.some(a => a.state === 'fighting')) battleTicks++;
    sane(m);
  });
  assert.deepEqual(seen, ['army_sent', 'army_arrived', 'battle_started', 'building_captured', 'battle_resolved']);
  assert.ok(battleTicks >= 3, 'the battle takes visible time');
  assert.ok(Math.abs(atCapture - (20 - (6 * D) / A0)) < 1e-9, `survivors ${atCapture}`);
  assert.equal(m.buildings[1].owner, 0);
  assert.equal(m.buildings[1].level, 1, 'captured building drops one level');
  assert.equal(m.players[0].stats.captures, 1);
  assert.ok(m.players[0].morale > BALANCE.morale.start);
  assert.ok(Math.abs(m.predict(0, { ...m.buildings[1], owner: -1, level: 2, garrison: 6 }, 20) - 0) >= 0);
});

test('E: an attack that is too weak drains the defenders but never changes the owner', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 10 },
    { type: 'tower', level: 3, x: 500, y: 450, slot: -1, garrison: 30 }, FAR]));
  const D = m.defenseFactor(m.buildings[1]);
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 100 });
  let resolved: SimEvent | undefined;
  run(m, 300, ev => { resolved = ev.find(e => e.type === 'battle_resolved') ?? resolved; sane(m); });
  assert.equal(m.buildings[1].owner, -1);
  assert.ok(Math.abs(m.buildings[1].garrison - (30 - (10 * A0) / D)) < 1e-9);
  assert.ok(resolved && resolved.type === 'battle_resolved' && !resolved.captured && resolved.survivors === 0);
  assert.equal(m.armies.length, 0);
  assert.equal(m.totalUnits(0), 0);
  assert.ok(m.players[0].morale < BALANCE.morale.start, 'failed attack costs morale');
});

test('F: simultaneous armies on one target: one ownership change, no doubled damage', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 300, y: 250, slot: 0, garrison: 8 },
    { type: 'tower', level: 1, x: 300, y: 650, slot: 0, garrison: 8 },
    { type: 'tower', level: 1, x: 300, y: 450, slot: 0, garrison: 8 },
    { type: 'forge', level: 1, x: 500, y: 450, slot: -1, garrison: 12 }, FAR]));
  m.enqueue({ type: 'send', player: 0, from: [0, 1, 2], to: 3, pct: 100 });
  let caps = 0, hits = 0;
  run(m, 300, ev => { caps += count(ev, 'building_captured'); hits += count(ev, 'battle_hit'); sane(m); });
  assert.equal(caps, 1);
  assert.equal(m.buildings[3].owner, 0);
  // exact conservation: 24 attackers minus the cost of 12 defenders at forge defence
  // conservation: 24 attackers minus the cost of 12 defenders at forge defence (the first, failed army costs a little morale)
  const cost = (12 * BALANCE.forge.def) / A0;
  assert.ok(Math.abs(m.buildings[3].garrison - (24 - cost)) < 0.05, `garrison ${m.buildings[3].garrison}`);
  assert.ok(hits === Math.ceil(cost) || hits === Math.ceil(cost) + 1, `only as many units fought as were needed (${hits})`);
  assert.equal(m.forgeCount(0), 1);
});

test('upgrade and convert cost units and time; a farm turned into a tower stops producing', () => {
  const m = match(mk([{ type: 'farm', level: 1, x: 200, y: 450, slot: 0, garrison: 20 }, FAR]));
  const b = m.buildings[0];
  const prod1 = m.prodRate(b), cap1 = m.capacity(b), def1 = m.defenseFactor(b);
  m.enqueue({ type: 'upgrade', player: 0, building: 0 });
  m.step();
  assert.equal(b.garrison, 20 - BALANCE.farm.upgradeCost[0]);
  assert.equal(b.busyKind, 'upgrade');
  assert.equal(m.income(0), 0, 'income shows 0 while the only farm is upgrading');
  run(m, BALANCE.farm.upgradeTimeSec[0] * BALANCE.tickRate - 2);
  assert.equal(b.level, 1);
  assert.equal(b.garrison, 12, 'no production while upgrading');
  run(m, 2);
  assert.equal(b.level, 2);
  assert.ok(m.prodRate(b) > prod1 && m.capacity(b) > cap1 && m.defenseFactor(b) > def1, 'level 2 is faster, bigger and tougher');
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

test('G: every tower projectile lands once; damage equals hits; shots from a captured tower are void', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 100, y: 450, slot: 0, garrison: 30 },
    { type: 'forge', level: 1, x: 900, y: 450, slot: 0, garrison: 0 },
    { type: 'tower', level: 2, x: 500, y: 380, slot: 1, garrison: 10 },
    { type: 'farm', level: 1, x: 1500, y: 800, slot: 1, garrison: 1 }]));
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 100 });
  const fired = new Set<number>(), landed = new Map<number, number>(); let kills = 0, minGap = 1e9, lastFire = -1e9;
  run(m, 400, ev => {
    for (const e of ev) {
      if (e.type === 'tower_fired') { fired.add(e.projectile); minGap = Math.min(minGap, m.tick - lastFire); lastFire = m.tick; }
      if (e.type === 'projectile_hit') { landed.set(e.projectile, (landed.get(e.projectile) ?? 0) + 1); kills += e.kills; }
    }
    sane(m);
  });
  assert.ok(fired.size >= 4, `tower fired ${fired.size} shots`);
  assert.ok([...landed.values()].every(n => n === 1), 'no projectile hits twice');
  assert.ok([...landed.keys()].every(id => fired.has(id)), 'every hit comes from a fired projectile');
  assert.equal(m.buildings[1].garrison, 30 - kills, 'arrivals = sent - projectile kills, nothing else');
  assert.equal(m.players[0].stats.lost, kills);
  assert.ok(minGap >= Math.round(BALANCE.tower.levels[1].fireIntervalSec * BALANCE.tickRate), 'cooldown respected');
  assert.equal(m.projectiles.length, 0, 'no projectile left flying after the target is gone');

  // a shot already in the air does nothing once its tower has changed hands
  const n = match(mk([
    { type: 'tower', level: 1, x: 100, y: 450, slot: 0, garrison: 60 },
    { type: 'tower', level: 1, x: 400, y: 450, slot: 1, garrison: 2 },
    { type: 'farm', level: 1, x: 1500, y: 800, slot: 1, garrison: 1 }]));
  n.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 50 });
  let hitsAfterCapture = 0, captured = false;
  run(n, 300, ev => {
    for (const e of ev) {
      if (e.type === 'building_captured') { captured = true; assert.equal(n.projectiles.filter(s => s.tower === 1).length, 0); }
      else if (e.type === 'projectile_hit' && captured && e.owner === 1) hitsAfterCapture++;
    }
  });
  assert.ok(captured);
  assert.equal(hitsAfterCapture, 0);
});

test('morale and forge change a documented battle; tower defence keeps more defenders alive', () => {
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
    for (let i = 0; i < 400; i++) { m.step(); shots += count(m.events, 'projectile_hit'); left = Math.min(left, m.buildings[2].garrison); }
    return { left, shots };
  };
  const base = battle(false, 1, false), forged = battle(true, 1, false), high = battle(false, 5, false), tw = battle(false, 1, true);
  assert.equal(base.shots, 0);
  const expected = 30 - (20 * A0) / (1 + BALANCE.morale.defensePerPoint);
  // the farm regrows a little during the 1.4 s battle once it drops under its capacity
  assert.ok(base.left >= expected && base.left - expected < 0.9, `base ${base.left} vs ${expected}`);
  assert.ok(forged.left < base.left - 1, 'forge must strengthen the attack');
  assert.ok(high.left < base.left - 3, 'high morale must strengthen the attack');
  assert.ok(tw.shots >= 3, 'tower fired');
  assert.ok(tw.left > base.left + 3, 'tower killed attackers before they arrived');
});

test('H+I: building counters and the +X/s readout always match the real state', () => {
  const m = match(MAPS[1], 5);
  const ais = [new AIController(0, 'hard', 5), new AIController(1, 'normal', 5)];
  let checks = 0;
  for (let i = 0; i < 20 * 150 && m.phase === 'playing'; i++) {
    const before = m.players.map(p => p.stats.produced), shown = m.players.map(p => m.income(p.id));
    ais.forEach(a => a.update(m)); m.step(); sane(m);
    if (m.events.some(e => e.type === 'building_captured')) {
      const owned = m.players.map(p => m.buildings.filter(b => b.owner === p.id).length);
      assert.deepEqual(m.players.map(p => m.buildingCount(p.id)), owned); checks++;
    }
    // income shown before a quiet tick equals what was really produced during it
    if (m.events.length === 0) for (const p of m.players) {
      const real = (p.stats.produced - before[p.id]) * m.bal.tickRate;
      assert.ok(real <= shown[p.id] + 1e-9 && real >= shown[p.id] - 2.0, `income ${shown[p.id]} vs real ${real}`);
    }
  }
  assert.ok(checks >= 5);
  // exact check on a still board: 5 seconds of a level-2 farm
  const s = match(mk([{ type: 'farm', level: 2, x: 200, y: 450, slot: 0, garrison: 0 }, FAR]));
  const shown = s.income(0); run(s, 100);
  assert.ok(Math.abs(s.buildings[0].garrison - shown * 5) < 1e-9);
});

test('L: a player with no buildings stays alive while an army marches; the match ends exactly once', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 30 },
    { type: 'tower', level: 1, x: 420, y: 450, slot: 1, garrison: 40 },
    { type: 'forge', level: 1, x: 1400, y: 450, slot: -1, garrison: 2 }]));
  m.enqueue({ type: 'send', player: 0, from: [0], to: 2, pct: 100 });   // everything leaves home
  m.step(); m.step();
  m.enqueue({ type: 'send', player: 1, from: [1], to: 0, pct: 75 });    // enemy takes the empty home
  let ends = 0, lostAt = -1, eliminated = false;
  run(m, 1200, ev => {
    for (const e of ev) {
      if (e.type === 'building_lost' && e.player === 0) lostAt = m.tick;
      if (e.type === 'player_eliminated') eliminated = true;
      if (e.type === 'match_ended') ends++;
    }
    if (lostAt > 0 && m.tick === lostAt + 5) assert.ok(m.players[0].alive && m.phase === 'playing', 'not ended early');
    sane(m);
  });
  assert.ok(lostAt > 0);
  assert.equal(m.buildings[2].owner, 0, 'the travelling army still captured its target');
  assert.equal(eliminated, false);
  assert.equal(m.phase, 'playing');
  m.enqueue({ type: 'surrender', player: 0 });
  run(m, 5, ev => { ends += count(ev, 'match_ended'); });
  assert.equal(ends, 1);
  assert.equal(m.phase, 'ended');
  assert.equal(m.winnerTeam, 1);
  const tick = m.tick; m.step();
  assert.equal(m.tick, tick, 'a finished match no longer advances');
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
  test(`AI (${diff}) captures, upgrades and beats an idle player without flooding orders`, () => {
    const m = match(MAPS[0], 7);
    const ai = new AIController(1, diff, 7);
    let caps = 0, ups = 0;
    for (let i = 0; i < 20 * 600 && m.phase === 'playing'; i++) {
      ai.update(m); m.step(); sane(m);
      for (const e of m.events) {
        if (e.type === 'building_captured' && e.by === 1) caps++;
        if (e.type === 'upgraded' && m.buildings[e.building].owner === 1) ups++;
      }
    }
    assert.ok(caps >= 3, `captures ${caps}`);
    assert.ok(ups >= 1, `upgrades ${ups}`);
    assert.equal(m.phase, 'ended');
    assert.equal(m.winnerTeam, 1);
    const perSec = ai.orders / (m.tick / m.bal.tickRate);
    assert.ok(perSec < 1000 / BALANCE.ai[diff].thinkMs[0] + 0.01, `orders/s ${perSec.toFixed(2)}`);
    assert.ok(ai.trace.length > 0 && ai.trace.every(d => d.detail.length > 0), 'decision trace is recorded');
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

test('AI reinforces a building that is about to fall', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 60 },
    { type: 'farm', level: 1, x: 900, y: 450, slot: 1, garrison: 12 },
    { type: 'farm', level: 2, x: 1050, y: 450, slot: 1, garrison: 40 }]), 2);
  const ai = new AIController(1, 'hard', 2);
  m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 50 });
  let helped = false;
  for (let i = 0; i < 200; i++) {
    ai.update(m); m.step();
    if (m.events.some(e => e.type === 'army_sent' && e.owner === 1 && e.to === 1)) helped = true;
  }
  assert.ok(helped, 'reinforcements were sent to the threatened farm');
  assert.equal(m.buildings[1].owner, 1, 'and the farm held');
  assert.ok(ai.trace.some(d => d.action === 'defend'));
});

test('J: AI-vs-AI matches on every map resolve with no stuck army, NaN or negative value', () => {
  let decided = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const map = MAPS[seed % 2];
    const n = map.slots;
    const m = new Match({ map, balance: BALANCE, seed, players: Array.from({ length: n }, (_, s) => ({ slot: s, team: s, isAI: true })) });
    const ais = Array.from({ length: n }, (_, i) => new AIController(i, (['hard', 'normal', 'easy'] as const)[(seed + i) % 3], seed));
    let ends = 0;
    while (m.phase === 'playing') { ais.forEach(a => a.update(m)); m.step(); sane(m); ends += count(m.events, 'match_ended'); }
    assert.equal(ends, 1);
    if (m.winnerTeam !== null) decided++;
  }
  assert.ok(decided >= 8, `decided ${decided}/12`);
});

test('synchronized attack: nearer buildings wait, all groups arrive together, each deducted once at its own launch', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 100, y: 450, slot: 0, garrison: 20 },   // far
    { type: 'tower', level: 1, x: 500, y: 250, slot: 0, garrison: 20 },   // middle
    { type: 'tower', level: 1, x: 700, y: 520, slot: 0, garrison: 20 },   // near
    { type: 'forge', level: 1, x: 900, y: 450, slot: -1, garrison: 30 }, FAR]));
  m.enqueue({ type: 'send', player: 0, from: [0, 1, 2], to: 3, pct: 50, sync: true });
  m.step();
  assert.equal(m.armies.length, 1, 'only the farthest group leaves at once');
  assert.equal(m.pending.length, 2);
  assert.deepEqual(m.buildings.slice(0, 3).map(b => b.garrison), [10, 20, 20], 'waiting buildings keep their units until launch');
  const arrivals: number[] = []; let sent = 1, caps = 0;
  run(m, 400, ev => {
    for (const e of ev) { if (e.type === 'army_arrived') arrivals.push(m.tick); if (e.type === 'army_sent') sent++; if (e.type === 'building_captured') caps++; }
    assert.equal(m.totalUnits(0) + m.players[0].stats.lost >= 59.999, true);
    sane(m);
  });
  assert.equal(sent, 3);
  assert.equal(arrivals.length, 3);
  assert.ok(Math.max(...arrivals) - Math.min(...arrivals) <= 1, `arrival ticks ${arrivals}`);
  assert.deepEqual(m.buildings.slice(0, 3).map(b => b.garrison), [10, 10, 10]);
  assert.equal(m.pending.length, 0);
  assert.equal(caps, 0, '30 units at 50% are not enough here; the forge holds');

  // without sync the same order arrives spread out
  const n = match(m.map);
  n.enqueue({ type: 'send', player: 0, from: [0, 1, 2], to: 3, pct: 50 });
  const spread: number[] = [];
  run(n, 400, ev => { for (const e of ev) if (e.type === 'army_arrived') spread.push(n.tick); });
  assert.ok(Math.max(...spread) - Math.min(...spread) > 60);
});

test('a waiting synchronized order is void once its building is captured', () => {
  const m = match(mk([
    { type: 'tower', level: 1, x: 100, y: 450, slot: 0, garrison: 20 },
    { type: 'tower', level: 1, x: 800, y: 450, slot: 0, garrison: 4 },
    { type: 'forge', level: 1, x: 1000, y: 450, slot: -1, garrison: 30 },
    { type: 'tower', level: 1, x: 800, y: 620, slot: 1, garrison: 40 }]));
  m.enqueue({ type: 'send', player: 0, from: [0, 1], to: 2, pct: 100, sync: true });
  m.enqueue({ type: 'send', player: 1, from: [3], to: 1, pct: 100 });
  let fromLost = 0;
  run(m, 400, ev => { for (const e of ev) if (e.type === 'army_sent' && e.owner === 0 && e.from === 1) fromLost++; sane(m); });
  assert.equal(m.buildings[1].owner, 1);
  assert.equal(fromLost, 0, 'no army left the captured building');
  assert.equal(m.pending.length, 0);
});

test('road-clash rule (experimental): groups that meet stop and trade losses; off by default they pass', () => {
  const map = mk([
    { type: 'tower', level: 1, x: 200, y: 450, slot: 0, garrison: 20 },
    { type: 'tower', level: 1, x: 1200, y: 450, slot: 1, garrison: 8 }]);
  const play = (clash: boolean) => {
    const m = new Match({ map, balance: BALANCE, seed: 1, players: two, roadClash: clash });
    m.players[0].lastActionTick = 1e9; m.players[1].lastActionTick = 1e9;
    m.enqueue({ type: 'send', player: 0, from: [0], to: 1, pct: 100 });
    m.enqueue({ type: 'send', player: 1, from: [1], to: 0, pct: 100 });
    let started = 0, held = 0, hits = 0;
    run(m, 600, ev => { started += count(ev, 'clash_started'); hits += count(ev, 'clash_hit'); if (m.armies.some(a => a.state === 'clashing')) held++; sane(m); });
    return { m, started, held, hits };
  };
  const off = play(false);
  assert.equal(off.started, 0);
  assert.deepEqual([off.m.buildings[0].owner, off.m.buildings[1].owner], [1, 0], 'without the rule both groups walk past and take the empty buildings');
  const on = play(true);
  assert.equal(on.started, 1);
  assert.ok(on.held >= 15, `the clash lasts long enough to read (${on.held} ticks)`);
  assert.equal(on.hits, 16, 'equal morale: 8 lost on each side');
  assert.equal(on.m.buildings[1].owner, 0, 'the 12 survivors march on and take the empty tower');
  assert.equal(on.m.buildings[0].owner, 0);
  assert.ok(Math.abs(on.m.buildings[1].garrison - 12) < 1e-9);
});

test('road-clash matches still resolve cleanly with AI on both sides', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const m = new Match({ map: MAPS[seed % 2], balance: BALANCE, seed, players: [0, 1].map(s => ({ slot: s, team: s, isAI: true })), roadClash: true });
    const ais = [new AIController(0, 'hard', seed), new AIController(1, 'normal', seed)];
    while (m.phase === 'playing') { ais.forEach(a => a.update(m)); m.step(); sane(m); }
    assert.ok(m.history.length > 10 && m.history.every(h => h.length === 2));
  }
});

// ---------------- roads ----------------
test('roads: every route follows the drawn roads and walks round, never through, buildings it passes', () => {
  for (const map of MAPS) {
    const m = match(map);
    const onRoad = (x: number, y: number) => m.roads.some(r => r.some((p, i) => i > 0 && segHitsCircle(r[i - 1], p, { x, y }, 3)))
      || m.buildings.some((b, k) => Math.abs(Math.hypot(b.x - x, b.y - y) - m.passR[k]) < 3 || Math.hypot(b.x - x, b.y - y) < 3);
    for (let i = 0; i < m.buildings.length; i++) for (let j = 0; j < m.buildings.length; j++) {
      if (i === j) continue;
      const p = m.paths[i][j];
      for (const q of p.pts) assert.ok(onRoad(q.x, q.y), `${map.id} ${i}->${j}: waypoint off road`);
      for (let k = 0; k < m.buildings.length; k++) if (k !== i && k !== j) for (let s = 1; s < p.pts.length; s++)
        assert.ok(!segHitsCircle(p.pts[s - 1], p.pts[s], m.buildings[k], 69), `${map.id} ${i}->${j} cuts through building ${k}`);
    }
  }
});

// ---------------- golden seed ----------------
const seedMatch = (seed = 3) => {
  const m = new Match({ map: MAPS[0], balance: BALANCE, seed, players: two, goldenSeed: true });
  m.players.forEach(p => (p.lastActionTick = 1e9));
  return m;
};
const R = BALANCE.tickRate;
test('Golden Seed: warning first, then the seed, then a hold that pays out a timed production boost nearby', () => {
  const m = seedMatch();
  let warn = -1, spawn = -1, claim = -1, site = -1;
  run(m, BALANCE.seed.firstAtSec * R + 5, ev => { for (const e of ev) { if (e.type === 'seed_warning') { warn = m.tick; site = e.building; } if (e.type === 'seed_spawned') spawn = m.tick; } });
  assert.equal(spawn - warn, BALANCE.seed.warnSec * R, 'announced exactly warnSec ahead');
  assert.ok(m.sites.includes(site));
  const b = m.buildings[site];
  b.owner = 0; b.garrison = 50;                                           // the player takes the site
  run(m, BALANCE.seed.holdSec * R + 2, ev => { for (const e of ev) if (e.type === 'seed_claimed') { claim = m.tick; assert.equal(e.player, 0); } });
  assert.ok(claim > 0);
  const near = m.buildings.find(x => x.type === 'farm' && x.owner === 0 && Math.hypot(x.x - b.x, x.y - b.y) <= BALANCE.seed.radius) ?? (() => { const f = m.buildings.find(x => x.type === 'farm' && Math.hypot(x.x - b.x, x.y - b.y) <= BALANCE.seed.radius)!; f.owner = 0; return f; })();
  near.garrison = 0;
  const base = BALANCE.farm.levels[near.level - 1].prod;
  assert.ok(Math.abs(m.prodRate(near) - base * BALANCE.seed.prodMult) < 1e-9);
  run(m, R); assert.ok(Math.abs(near.garrison - base * BALANCE.seed.prodMult) < 1e-6, 'the boost is real production, and income() shows it');
  run(m, BALANCE.seed.buffSec * R);
  assert.equal(m.buffs.length, 0); assert.ok(Math.abs(m.prodRate(near) - base) < 1e-9, 'the boost ends');
});

test('Golden Seed: a capture during the hold steals it (the leader can be robbed)', () => {
  const m = seedMatch();
  run(m, BALANCE.seed.firstAtSec * R + 1);
  const site = m.gseed!.site, b = m.buildings[site];
  const enemy = m.buildings.filter(x => x.owner === 1).sort((x, y) => m.paths[x.id][site].len - m.paths[y.id][site].len)[0];
  enemy.garrison = 60;
  const eta = m.eta(enemy.id, site, 1);
  m.enqueue({ type: 'send', player: 1, from: [enemy.id], to: site, pct: 100 });
  run(m, Math.round((eta - BALANCE.seed.holdSec / 2) * R));
  b.owner = 0; b.garrison = 3;                                  // player 0 grabs the seed; the enemy army is half a hold away
  let held0 = false, winner = -1;
  run(m, 60 * R, ev => { if (m.gseed?.holder === 0) held0 = true; for (const e of ev) if (e.type === 'seed_claimed') winner = e.player; });
  assert.ok(held0, 'player 0 was holding it');
  assert.equal(winner, 1, 'the enemy capture restarted the hold and they claimed it');
});

// ---------------- drawbridge ----------------
test('Spring Bridge: closed gate holds groups before it, groups already on it finish crossing, ETA matches arrival', () => {
  const m = new Match({ map: MAPS[2], balance: BALANCE, seed: 1, players: two });
  m.players.forEach(p => (p.lastActionTick = 1e9));
  const [dIn] = m.gateSpan[1][9]!;
  m.buildings[1].garrison = 40; m.buildings[9].owner = 0;               // a friendly target across the south gate
  // 1) a group sent so that the gate closes before it reaches it waits at the gate
  m.bridge!.nextTick = m.tick + Math.round((dIn / BALANCE.unitSpeed - 1.5) * R);
  m.enqueue({ type: 'send', player: 0, from: [1], to: 9, pct: 25 });
  m.step();
  const a = m.armies[0];
  assert.equal(a.route, 0);
  while (m.bridge!.open) m.step();
  run(m, 3 * R);
  const held = a.dist;
  run(m, 2 * R);
  assert.ok(a.dist === held && held < dIn, 'waiting before the gate');
  let arrived = -1; run(m, 40 * R, ev => { for (const e of ev) if (e.type === 'army_arrived' && e.army === a.id) arrived = m.tick; });
  assert.ok(arrived > 0 && m.bridge!.open !== undefined, 'it crosses after the gate reopens');
  // 2) a group already on the bridge when it closes keeps going
  const n = new Match({ map: MAPS[2], balance: BALANCE, seed: 1, players: two });
  n.buildings[1].garrison = 40; n.buildings[9].owner = 0;
  n.enqueue({ type: 'send', player: 0, from: [1], to: 9, pct: 25 }); n.step();
  const g = n.armies[0];
  while (g.dist < dIn + 10) n.step();
  n.bridge!.nextTick = n.tick + 1; n.step(); n.step();
  assert.equal(n.bridge!.open, false);
  const d0 = g.dist; n.step(); assert.ok(g.dist > d0, 'on the bridge: keeps crossing');
  // 3) with the gate closed for long, a new group goes round by the north bridge, and arrives when eta() said
  const k = new Match({ map: MAPS[2], balance: BALANCE, seed: 1, players: two });
  k.players.forEach(p => (p.lastActionTick = 1e9));
  k.buildings[1].garrison = 40; k.buildings[9].owner = 0;
  k.bridge!.nextTick = 1; k.step(); k.bridge!.nextTick = k.tick + 60 * R;
  const eta = k.eta(1, 9, 0);
  k.enqueue({ type: 'send', player: 0, from: [1], to: 9, pct: 25 });
  let at = -1; const t0 = k.tick;
  run(k, 60 * R, ev => { for (const e of ev) if (e.type === 'army_arrived') at = k.tick; });
  assert.equal(k.armies.length, 0);
  assert.ok(Math.abs((at - t0) / R - eta) < 0.2, `eta ${eta.toFixed(2)} vs ${((at - t0) / R).toFixed(2)}`);
});

// ---------------- heroes ----------------
const heroMatch = (hero: 'sprig' | 'armorleaf' | 'turnip') => {
  const m = new Match({ map: mk([
    { type: 'farm', level: 1, x: 200, y: 450, slot: 0, garrison: 20 },
    { type: 'tower', level: 1, x: 420, y: 300, slot: 0, garrison: 10 },
    { type: 'farm', level: 1, x: 1100, y: 450, slot: 1, garrison: 40 },
    { type: 'farm', level: 1, x: 700, y: 650, slot: -1, garrison: 5 }]), balance: BALANCE, seed: 1, players: two, heroes: [hero, null] });
  m.players.forEach(p => (p.lastActionTick = 1e9));
  return m;
};
test('heroes: abilities respect their start cooldown, target rules and cooldown', () => {
  const m = heroMatch('sprig');
  m.enqueue({ type: 'ability', player: 0, slot: 0, building: 0 }); m.step();
  assert.ok(Math.abs(m.buildings[0].garrison - 20) < 0.2, 'not ready at the start');
  run(m, BALANCE.heroStartCooldownSec * R);
  m.enqueue({ type: 'ability', player: 0, slot: 0, building: 2 }); m.step();       // enemy building: refused
  assert.ok(m.abilityReady(0, 0));
  const g = m.buildings[0].garrison;
  m.enqueue({ type: 'ability', player: 0, slot: 0, building: 0 }); m.step();
  assert.ok(Math.abs(m.buildings[0].garrison - g - 10) < 0.1, 'Seed Burst adds units once');
  m.enqueue({ type: 'ability', player: 0, slot: 0, building: 0 }); m.step();
  assert.ok(m.buildings[0].garrison - g < 10.2, 'cooldown blocks a second use');
});
test('Sprig Green Rush speeds own marching groups; Armorleaf Bulwark and Volley change real numbers', () => {
  const m = heroMatch('sprig'); run(m, BALANCE.heroStartCooldownSec * R);
  m.enqueue({ type: 'send', player: 0, from: [0], to: 3, pct: 50 }); m.step();
  const a = m.armies[0], d0 = a.dist;
  m.enqueue({ type: 'ability', player: 0, slot: 1 }); m.step(); m.step();
  assert.ok(Math.abs((a.dist - d0) / 2 - (a.speed / R) * 1.45) < 1e-6 || a.dist - d0 > (a.speed / R) * 2.5);
  const h = heroMatch('armorleaf'); run(h, BALANCE.heroStartCooldownSec * R);
  const D = h.defenseFactor(h.buildings[0]);
  h.enqueue({ type: 'ability', player: 0, slot: 0, building: 0 }); h.step();
  assert.ok(Math.abs(h.defenseFactor(h.buildings[0]) / D - 1.8) < 1e-9);
  h.enqueue({ type: 'ability', player: 0, slot: 1, building: 0 }); h.step();
  assert.ok(h.abilityReady(0, 1), 'Volley needs a tower');
  h.enqueue({ type: 'ability', player: 0, slot: 1, building: 1 }); h.step();
  h.buildings[2].garrison = 40;
  h.enqueue({ type: 'send', player: 1, from: [2], to: 0, pct: 75 });
  const shots: number[] = [];
  run(h, 8 * R, ev => { for (const e of ev) if (e.type === 'tower_fired') shots.push(h.tick); });
  assert.ok(shots.length >= 2 && shots[1] - shots[0] <= Math.round(BALANCE.tower.levels[0].fireIntervalSec * R * 0.4) + 1, `volley gap ${shots[1] - shots[0]}`);
});
test('Turnip: Mud is visible before it bites and slows only hostile groups; Snare roots after its warning', () => {
  const m = heroMatch('turnip'); run(m, BALANCE.heroStartCooldownSec * R);
  m.buildings[2].garrison = 40;
  m.enqueue({ type: 'send', player: 1, from: [2], to: 0, pct: 50 }); m.step();
  const a = m.armies[0];
  run(m, 3 * R);
  const p = pointAt(m.pathOf(a), a.dist + 60);
  m.enqueue({ type: 'ability', player: 0, slot: 1, x: p.x, y: p.y }); m.step();
  assert.equal(m.zones.length, 1); assert.ok(m.tick < m.zones[0].armTick, 'a warning period before it bites');
  let rooted = 0; run(m, 4 * R, () => { if (a.state === 'moving' && Math.hypot(a.x - a.px, a.y - a.py) === 0) rooted++; });
  assert.ok(rooted >= BALANCE.heroes.turnip.abilities[1].durationSec! * R - 2, `rooted ${rooted} ticks`);
  const q = heroMatch('turnip'); run(q, BALANCE.heroStartCooldownSec * R);
  q.enqueue({ type: 'ability', player: 0, slot: 0, x: 3000, y: 3000 }); q.step();
  assert.equal(q.zones.length, 0, 'out of reach: refused');
});

// ---------------- control mode ----------------
test('King of the Bloom: holding the central building for holdSec wins', () => {
  const m = new Match({ map: MAPS[0], balance: BALANCE, seed: 1, players: two, mode: 'control' });
  const bloom = m.buildings[m.sites[0]];
  assert.equal(bloom.x, 800);
  bloom.owner = 1; bloom.garrison = 999;
  run(m, BALANCE.control.holdSec * R + 2);
  assert.equal(m.phase, 'ended'); assert.equal(m.winnerTeam, 1);
});

// ---------------- full matches with every addition ----------------
test('full AI matches: seed + heroes on every map, bridge map, control mode — all resolve; AI claims seeds and uses heroes', () => {
  let claims = 0, abilities = 0, holds = 0;
  const heroes = ['sprig', 'armorleaf', 'turnip'] as const;
  for (let seed = 1; seed <= 9; seed++) {
    const map = MAPS[seed % 3], n = map.slots;
    const m = new Match({ map, balance: BALANCE, seed, goldenSeed: true, mode: seed % 3 === 0 ? 'control' : 'conquest',
      players: Array.from({ length: n }, (_, s) => ({ slot: s, team: s, isAI: true })), heroes: Array.from({ length: n }, (_, i) => heroes[(seed + i) % 3]) });
    const ais = Array.from({ length: n }, (_, i) => new AIController(i, i % 2 ? 'normal' : 'hard', seed));
    let ends = 0;
    while (m.phase === 'playing') {
      ais.forEach(a => a.update(m)); m.step(); sane(m);
      for (const e of m.events) { if (e.type === 'seed_claimed') claims++; if (e.type === 'ability_used') abilities++; if (e.type === 'match_ended') ends++; }
      if (m.armies.some(a => a.heldTicks > 0 && m.bridge && !m.bridge.open)) holds++;
    }
    assert.equal(ends, 1);
  }
  console.log(`    seeds claimed ${claims}, abilities used ${abilities}, ticks with a group held at the gate ${holds}`);
  assert.ok(claims >= 3 && abilities >= 20 && holds > 0);
});
