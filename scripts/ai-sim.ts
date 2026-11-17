// AI-vs-AI balance run. Usage: tsx scripts/ai-sim.ts [gamesPerPairing]
// Prints win rates per difficulty pairing, seat bias and match length, as a Markdown table.
import { AIController, BALANCE, MAPS, Match, type Difficulty } from '../packages/simulation/src/index';

const N = Number(process.argv[2] || 60);
const CLASH = process.argv.includes('--clash');   // run with the experimental road-clash rule
const diffs: Difficulty[] = ['easy', 'normal', 'hard'];
function play(mapIndex: number, seats: Difficulty[], seed: number) {
  const m = new Match({ map: MAPS[mapIndex], balance: BALANCE, seed, players: seats.map((_, s) => ({ slot: s, team: s, isAI: true })), roadClash: CLASH });
  const ais = seats.map((d, i) => new AIController(i, d, seed));
  while (m.phase === 'playing') { ais.forEach(a => a.update(m)); m.step(); }
  const sec = m.tick / BALANCE.tickRate;
  return { winner: m.winnerTeam, sec, orders: ais.map(a => a.orders / sec), timeout: sec >= BALANCE.matchTimeLimitSec };
}
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) + '%' : '-');
console.log(`Rule set: ${CLASH ? 'road clash ON (experimental)' : 'standard'}, ${N} games per pairing\n`);
console.log(`| Map | Pairing (A vs B) | A wins | B wins | Draw/timeout | A wins as seat 1 / seat 2 | Avg length | Orders/s A / B |`);
console.log('|---|---|---|---|---|---|---|---|');
for (let mi = 0; mi < MAPS.length; mi++) {
  for (const [a, b] of [['easy', 'easy'], ['normal', 'normal'], ['hard', 'hard'], ['normal', 'easy'], ['hard', 'normal'], ['hard', 'easy']] as [Difficulty, Difficulty][]) {
    let aw = 0, bw = 0, dr = 0, t = 0, aSeat0 = 0, aSeat1 = 0, oa = 0, ob = 0;
    for (let g = 0; g < N; g++) {
      const swap = g % 2 === 1;
      const r = play(mi, swap ? [b, a] : [a, b], 1000 + g * 7 + mi);
      const aWon = r.winner === (swap ? 1 : 0), bWon = r.winner === (swap ? 0 : 1);
      if (r.timeout || r.winner === null) dr++; else if (aWon) { aw++; if (swap) aSeat1++; else aSeat0++; } else if (bWon) bw++;
      t += r.sec; oa += r.orders[swap ? 1 : 0]; ob += r.orders[swap ? 0 : 1];
    }
    const len = t / N;
    console.log(`| ${MAPS[mi].name.en} | ${a} vs ${b} | ${pct(aw, N)} | ${pct(bw, N)} | ${pct(dr, N)} | ${pct(aSeat0, N / 2)} / ${pct(aSeat1, N / 2)} | ${Math.floor(len / 60)}:${String(Math.round(len % 60)).padStart(2, '0')} | ${(oa / N).toFixed(2)} / ${(ob / N).toFixed(2)} |`);
  }
}
// four-way free-for-all on the 4-slot map: which seat wins with equal skill?
{
  const wins = [0, 0, 0, 0]; let dr = 0, t = 0;
  for (let g = 0; g < N; g++) { const r = play(1, ['normal', 'normal', 'normal', 'normal'], 5000 + g); if (r.winner === null || r.timeout) dr++; else wins[r.winner]++; t += r.sec; }
  console.log(`\n4-way normal on ${MAPS[1].name.en}: seat wins ${wins.map(w => pct(w, N)).join(' / ')}, draws ${pct(dr, N)}, avg ${Math.round(t / N)}s`);
}
void diffs;
