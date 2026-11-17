import type { MapDef, Vec } from './types';

export interface Path { pts: Vec[]; cum: number[]; len: number }
export interface Network { paths: Path[][]; roads: Vec[][]; passR: number[] }

const CLEAR = 10;        // min distance kept from an obstacle edge
const RING = 26;         // detour ring distance from an obstacle edge
const RING_PTS = 10;
const B_CLEAR = 70;      // a road keeps this far from the centre of any building it does not connect
export const B_PASS = 84;   // squads passing a building's junction walk around it at this radius (less where neighbours are close)
const ROAD_MAX = 430;    // longest road segment between two buildings

export function segHitsCircle(a: Vec, b: Vec, c: Vec, r: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx - c.x, py = a.y + t * dy - c.y;
  return px * px + py * py < r * r;
}

function segsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const o = (p: Vec, q: Vec, r: Vec) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function makePath(pts: Vec[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, len: cum[cum.length - 1] };
}

/** Obstacles that block movement. A 'gate' (drawbridge) only blocks while closed. */
function blockers(map: MapDef, gatesClosed: boolean) {
  return map.obstacles.filter(o => o.kind !== 'gate' || gatesClosed);
}

/** Shortest obstacle-free polylines between every pair of buildings, avoiding third buildings. */
function directPaths(map: MapDef, obs: MapDef['obstacles']): Vec[][][] {
  const n = map.buildings.length;
  const nodes: Vec[] = map.buildings.map(b => ({ x: b.x, y: b.y }));
  const addRing = (cx: number, cy: number, r: number, offset: number, skip: (p: Vec) => boolean) => {
    for (let i = 0; i < RING_PTS; i++) {
      const a = ((i + offset) / RING_PTS) * Math.PI * 2, p = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
      if (p.x < 20 || p.y < 20 || p.x > map.width - 20 || p.y > map.height - 20 || skip(p)) continue;
      nodes.push(p);
    }
  };
  const inObstacle = (p: Vec) => obs.some(q => Math.hypot(q.x - p.x, q.y - p.y) < q.r + CLEAR);
  for (const o of obs) addRing(o.x, o.y, o.r + RING, 0, inObstacle);
  for (const q of map.buildings) addRing(q.x, q.y, B_CLEAR + 16, 0.5, p => inObstacle(p) || map.buildings.some(o => o !== q && Math.hypot(o.x - p.x, o.y - p.y) < B_CLEAR));
  const m = nodes.length;
  const clear = (i: number, j: number) => {
    for (const o of obs) if (segHitsCircle(nodes[i], nodes[j], o, o.r + CLEAR)) return false;
    for (let k = 0; k < n; k++) if (k !== i && k !== j && segHitsCircle(nodes[i], nodes[j], map.buildings[k], B_CLEAR)) return false;
    return true;
  };
  const adj: number[][] = Array.from({ length: m }, () => new Array(m).fill(Infinity));
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
    if (clear(i, j)) adj[i][j] = adj[j][i] = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
  }
  const out: Vec[][][] = [];
  for (let s = 0; s < n; s++) {
    const dist = new Array(m).fill(Infinity), prev = new Array(m).fill(-1), done = new Array(m).fill(false);
    dist[s] = 0;
    for (let k = 0; k < m; k++) {
      let u = -1;
      for (let i = 0; i < m; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity) break;
      done[u] = true;
      for (let v = 0; v < m; v++) { const d = dist[u] + adj[u][v]; if (d < dist[v]) { dist[v] = d; prev[v] = u; } }
    }
    const row: Vec[][] = [];
    for (let t = 0; t < n; t++) {
      if (t === s) { row.push([nodes[s]]); continue; }
      if (dist[t] === Infinity) { row.push([nodes[s], nodes[t]]); continue; }
      const pts: Vec[] = [];
      for (let c = t; c !== -1; c = prev[c]) pts.push(nodes[c]);
      row.push(pts.reverse());
    }
    out.push(row);
  }
  return out;
}

const polyLen = (p: Vec[]) => { let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); return l; };

/** Cut a polyline where it first comes within r of c (keepStart) or where it last leaves r of c (!keepStart). */
function trim(p: Vec[], c: Vec, r: number, keepStart: boolean): Vec[] {
  const pts = keepStart ? p : [...p].reverse();
  const out: Vec[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (Math.hypot(b.x - c.x, b.y - c.y) > r) { out.push(b); continue; }
    // find the crossing on segment a-b (a is outside, b inside)
    let lo = 0, hi = 1;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2, x = a.x + (b.x - a.x) * mid, y = a.y + (b.y - a.y) * mid; if (Math.hypot(x - c.x, y - c.y) > r) lo = mid; else hi = mid; }
    out.push({ x: a.x + (b.x - a.x) * lo, y: a.y + (b.y - a.y) * lo });
    break;
  }
  return keepStart ? out : out.reverse();
}

/** Walk round a junction building; take the shorter way unless it brushes another building or obstacle. */
function arc(c: Vec, r: number, from: Vec, to: Vec, avoid: { x: number; y: number; r: number }[]): Vec[] {
  const a0 = Math.atan2(from.y - c.y, from.x - c.x), a1 = Math.atan2(to.y - c.y, to.x - c.x);
  let d = a1 - a0; while (d > Math.PI) d -= Math.PI * 2; while (d <= -Math.PI) d += Math.PI * 2;
  const build = (dd: number) => {
    const steps = Math.max(1, Math.ceil(Math.abs(dd) / 0.3)), out: Vec[] = [];
    for (let i = 1; i < steps; i++) { const a = a0 + (dd * i) / steps; out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }); }
    return out;
  };
  const short = build(d), long = build(d > 0 ? d - Math.PI * 2 : d + Math.PI * 2);
  const hits = (pts: Vec[]) => pts.some(p => avoid.some(o => Math.hypot(o.x - p.x, o.y - p.y) < o.r));
  return hits(short) && !hits(long) ? long : short;
}

/**
 * Road network: buildings are joined by non-crossing roads (shortest first, at most ROAD_MAX long, never through a third
 * building). Every army route follows these roads; where a route passes a building on the way, it walks around that
 * building's yard at radius B_PASS instead of through it. The roads drawn on the map are exactly these polylines.
 */
export function buildNetwork(map: MapDef, gatesClosed = false): Network {
  const n = map.buildings.length, obs = blockers(map, gatesClosed);
  const direct = directPaths(map, obs);
  const cand: [number, number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) cand.push([i, j, polyLen(direct[i][j])]);
  cand.sort((a, b) => a[2] - b[2]);
  const roads: { i: number; j: number; pts: Vec[]; len: number }[] = [];
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const crosses = (p: Vec[], i: number, j: number) => roads.some(r => {
    if (r.i === i || r.i === j || r.j === i || r.j === j) return false;
    for (let a = 1; a < p.length; a++) for (let b = 1; b < r.pts.length; b++) if (segsCross(p[a - 1], p[a], r.pts[b - 1], r.pts[b])) return true;
    return false;
  });
  const add = (i: number, j: number, len: number) => { roads.push({ i, j, pts: direct[i][j], len }); parent[find(i)] = find(j); };
  for (const [i, j, len] of cand) if (len <= ROAD_MAX && !crosses(direct[i][j], i, j)) add(i, j, len);
  for (const [i, j, len] of cand) if (find(i) !== find(j)) add(i, j, len);   // keep every building reachable
  const adj: { to: number; r: number }[][] = Array.from({ length: n }, () => []);
  roads.forEach((r, k) => { adj[r.i].push({ to: r.j, r: k }); adj[r.j].push({ to: r.i, r: k }); });
  const edge = (a: number, b: number) => { const r = roads[adj[a].find(e => e.to === b)!.r]; return r.i === a ? r.pts : [...r.pts].reverse(); };

  // ring radius per junction: as wide as B_PASS, but never closer than B_CLEAR to a neighbour or an obstacle's margin
  const passR = map.buildings.map(c => Math.max(60, Math.min(B_PASS,
    ...map.buildings.filter(o => o !== c).map(o => Math.hypot(o.x - c.x, o.y - c.y) - B_CLEAR),
    ...obs.map(o => Math.hypot(o.x - c.x, o.y - c.y) - o.r - CLEAR - 2))));
  const paths: Path[][] = [];
  for (let s = 0; s < n; s++) {
    const dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
    dist[s] = 0;
    for (let k = 0; k < n; k++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity) break;
      done[u] = true;
      for (const e of adj[u]) { const d = dist[u] + roads[e.r].len + (u === s ? 0 : B_PASS * 0.6); if (d < dist[e.to]) { dist[e.to] = d; prev[e.to] = u; } }
    }
    const row: Path[] = [];
    for (let t = 0; t < n; t++) {
      if (t === s) { row.push(makePath([{ x: map.buildings[s].x, y: map.buildings[s].y }])); continue; }
      const seq: number[] = [];
      for (let c = t; c !== -1; c = prev[c]) seq.push(c);
      seq.reverse();
      let pts: Vec[] = [];
      for (let k = 0; k + 1 < seq.length; k++) {
        let seg = edge(seq[k], seq[k + 1]);
        if (k > 0) seg = trim(seg, map.buildings[seq[k]], passR[seq[k]], false);                 // leave the junction's ring
        if (k + 2 < seq.length) seg = trim(seg, map.buildings[seq[k + 1]], passR[seq[k + 1]], true);  // reach the next junction's ring
        if (k > 0) {
          const c = map.buildings[seq[k]];
          const avoid = [...map.buildings.filter(o => o !== c).map(o => ({ x: o.x, y: o.y, r: B_CLEAR })), ...obs.map(o => ({ x: o.x, y: o.y, r: o.r + CLEAR }))];
          pts.push(...arc(c, passR[seq[k]], pts[pts.length - 1], seg[0], avoid));
        }
        pts = pts.concat(k > 0 ? seg : seg);
      }
      row.push(makePath(pts));
    }
    paths.push(row);
  }
  return { paths, roads: roads.map(r => r.pts), passR };
}

export function buildPaths(map: MapDef): Path[][] { return buildNetwork(map).paths; }

export function pointAt(p: Path, d: number): Vec {
  if (d <= 0) return p.pts[0];
  if (d >= p.len) return p.pts[p.pts.length - 1];
  let i = 1;
  while (p.cum[i] < d) i++;
  const t = (d - p.cum[i - 1]) / (p.cum[i] - p.cum[i - 1] || 1);
  const a = p.pts[i - 1], b = p.pts[i];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
