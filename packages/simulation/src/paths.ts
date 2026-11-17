import type { MapDef, Vec } from './types';

export interface Path { pts: Vec[]; cum: number[]; len: number }

const CLEAR = 10;   // min distance kept from an obstacle edge
const RING = 26;    // detour ring distance from an obstacle edge
const RING_PTS = 10;
const B_CLEAR = 62;  // routes keep this far from the centre of any building they are not going to or from
const B_RING = 80;   // detour ring radius around a building

export function segHitsCircle(a: Vec, b: Vec, c: Vec, r: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx - c.x, py = a.y + t * dy - c.y;
  return px * px + py * py < r * r;
}

function clear(a: Vec, b: Vec, map: MapDef, i: number, j: number): boolean {
  for (const o of map.obstacles) if (segHitsCircle(a, b, o, o.r + CLEAR)) return false;
  // a route never cuts through a third building: squads walk around it
  for (let k = 0; k < map.buildings.length; k++) {
    if (k === i || k === j) continue;
    if (segHitsCircle(a, b, map.buildings[k], B_CLEAR)) return false;
  }
  return true;
}

function makePath(pts: Vec[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, len: cum[cum.length - 1] };
}

/** All-pairs building routes on a visibility graph that detours around ponds and rocks. */
export function buildPaths(map: MapDef): Path[][] {
  const n = map.buildings.length;
  const nodes: Vec[] = map.buildings.map(b => ({ x: b.x, y: b.y }));
  for (const o of map.obstacles) {
    for (let i = 0; i < RING_PTS; i++) {
      const a = (i / RING_PTS) * Math.PI * 2;
      const p = { x: o.x + Math.cos(a) * (o.r + RING), y: o.y + Math.sin(a) * (o.r + RING) };
      if (p.x < 20 || p.y < 20 || p.x > map.width - 20 || p.y > map.height - 20) continue;
      if (map.obstacles.some(q => Math.hypot(q.x - p.x, q.y - p.y) < q.r + CLEAR)) continue;
      nodes.push(p);
    }
  }
  for (const q of map.buildings) {
    for (let i = 0; i < RING_PTS; i++) {
      const a = ((i + 0.5) / RING_PTS) * Math.PI * 2;
      const p = { x: q.x + Math.cos(a) * B_RING, y: q.y + Math.sin(a) * B_RING };
      if (p.x < 20 || p.y < 20 || p.x > map.width - 20 || p.y > map.height - 20) continue;
      if (map.obstacles.some(o => Math.hypot(o.x - p.x, o.y - p.y) < o.r + CLEAR)) continue;
      if (map.buildings.some(o => o !== q && Math.hypot(o.x - p.x, o.y - p.y) < B_CLEAR)) continue;
      nodes.push(p);
    }
  }
  const m = nodes.length;
  const adj: number[][] = [];
  for (let i = 0; i < m; i++) {
    adj.push(new Array(m).fill(Infinity));
  }
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
    if (clear(nodes[i], nodes[j], map, i, j)) {
      adj[i][j] = adj[j][i] = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
    }
  }
  const out: Path[][] = [];
  for (let s = 0; s < n; s++) {
    const dist = new Array(m).fill(Infinity), prev = new Array(m).fill(-1), done = new Array(m).fill(false);
    dist[s] = 0;
    for (let k = 0; k < m; k++) {
      let u = -1;
      for (let i = 0; i < m; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity) break;
      done[u] = true;
      for (let v = 0; v < m; v++) {
        const d = dist[u] + adj[u][v];
        if (d < dist[v]) { dist[v] = d; prev[v] = u; }
      }
    }
    const row: Path[] = [];
    for (let t = 0; t < n; t++) {
      if (t === s) { row.push(makePath([nodes[s]])); continue; }
      if (dist[t] === Infinity) { row.push(makePath([nodes[s], nodes[t]])); continue; }
      const pts: Vec[] = [];
      for (let c = t; c !== -1; c = prev[c]) pts.push(nodes[c]);
      row.push(makePath(pts.reverse()));
    }
    out.push(row);
  }
  return out;
}

export function pointAt(p: Path, d: number): Vec {
  if (d <= 0) return p.pts[0];
  if (d >= p.len) return p.pts[p.pts.length - 1];
  let i = 1;
  while (p.cum[i] < d) i++;
  const t = (d - p.cum[i - 1]) / (p.cum[i] - p.cum[i - 1]);
  const a = p.pts[i - 1], b = p.pts[i];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
