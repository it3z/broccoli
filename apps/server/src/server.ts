// BROCCOLI online server: serves the game page and runs every room's match authoritatively.
// No dependencies: a minimal RFC 6455 WebSocket implementation on node:http. Run: npm run server  (PORT, default 8787)
import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { Match, type Command, type HeroId } from '../../../packages/simulation/src/index';
import { roomMatchConfig, snapshot, type RoomConfig } from '../../../packages/simulation/src/online';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = Number(process.env.PORT || 8787);
const GRACE_MS = Number(process.env.GRACE_MS || 60000);      // a dropped player keeps their seat this long
const MAX_CMDS_PER_SEC = 20;

// ---------- WebSocket plumbing ----------
class Socket {
  private buf = Buffer.alloc(0);
  onMessage: (s: string) => void = () => {};
  onClose: () => void = () => {};
  closed = false;
  constructor(private sock: Duplex) {
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => this.finish()); sock.on('error', () => this.finish());
  }
  private finish(): void { if (!this.closed) { this.closed = true; this.onClose(); } }
  private parse(): void {
    for (;;) {
      if (this.buf.length < 2) return;
      const op = this.buf[0] & 0x0f, masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { this.sock.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      const mask = masked ? this.buf.subarray(off, off + 4) : null, data = Buffer.from(this.buf.subarray(need - len, need));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(need);
      if (op === 0x8) { this.sock.end(); this.finish(); return; }
      if (op === 0x9) this.frame(0xa, data);
      else if (op === 0x1) this.onMessage(data.toString('utf8'));
    }
  }
  private frame(op: number, data: Buffer): void {
    if (this.closed) return;
    const n = data.length, head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    this.sock.write(Buffer.concat([head, data]));
  }
  send(o: unknown): void { this.frame(0x1, Buffer.from(JSON.stringify(o))); }
  close(): void { try { this.frame(0x8, Buffer.alloc(0)); this.sock.end(); } catch { /* gone */ } this.finish(); }
}

// ---------- rooms ----------
interface Seat { token: string; ws: Socket | null; lastId: number; leftAt: number; window: number[] }
interface Room { code: string; rc: RoomConfig; seats: (Seat | null)[]; match: Match | null; timer: NodeJS.Timeout | null; emptySince: number }
const rooms = new Map<string, Room>();
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c = ''; do { c = Array.from({ length: 5 }, () => CODE[randomBytes(1)[0] % CODE.length]).join(''); } while (rooms.has(c)); return c; };

function lobby(r: Room): void {
  const msg = { t: 'lobby', code: r.code, size: r.rc.size, seats: r.seats.map(s => (s ? (s.ws ? 'on' : 'away') : 'free')) };
  for (const s of r.seats) s?.ws?.send(msg);
}
function startMsg(r: Room, seat: number) { return { t: 'start', code: r.code, seat, rc: r.rc }; }
function start(r: Room): void {
  r.match = new Match(roomMatchConfig(r.rc));
  r.seats.forEach((s, i) => s?.ws?.send(startMsg(r, i)));
  r.timer = setInterval(() => tick(r), 1000 / r.match.bal.tickRate);
  console.log(`[${r.code}] started ${r.rc.size === 2 ? '1v1' : '2v2'} map ${r.rc.mapIndex}`);
}
function tick(r: Room): void {
  const m = r.match!, now = Date.now();
  // a seat that has been away longer than the grace period forfeits (its buildings turn neutral)
  r.seats.forEach((s, i) => { if (s && !s.ws && now - s.leftAt > GRACE_MS && m.players[i].alive) m.enqueue({ type: 'surrender', player: i }); });
  m.step();
  const msg = JSON.stringify({ t: 'snap', ev: m.events, s: snapshot(m) });
  for (const s of r.seats) if (s?.ws && !s.ws.closed) s.ws.send(JSON.parse(msg));
  if (m.phase === 'ended') {
    clearInterval(r.timer!); r.timer = null;
    for (const s of r.seats) s?.ws?.send({ t: 'end', history: m.history });
    console.log(`[${r.code}] ended, winner team ${m.winnerTeam}`);
    setTimeout(() => rooms.delete(r.code), 30000);
  }
}
function seatUp(r: Room, i: number, ws: Socket, token?: string): void {
  const s = r.seats[i] ?? { token: token ?? randomBytes(12).toString('hex'), ws: null, lastId: 0, leftAt: 0, window: [] };
  if (s.ws && s.ws !== ws) s.ws.close();                    // an older connection for the same seat is replaced
  s.ws = ws; r.seats[i] = s;
  ws.send({ t: 'joined', code: r.code, seat: i, token: s.token, size: r.rc.size });
  ws.onClose = () => { if (s.ws === ws) { s.ws = null; s.leftAt = Date.now(); lobby(r); } };
  ws.onMessage = raw => onSeatMessage(r, i, raw);
  if (r.match) ws.send(startMsg(r, i));
  lobby(r);
  if (!r.match && r.seats.every(x => x)) start(r);
}
function onSeatMessage(r: Room, i: number, raw: string): void {
  let msg: { t?: string; id?: number; cmd?: Command } | null = null;
  try { msg = JSON.parse(raw); } catch { return; }
  const s = r.seats[i]!;
  if (msg?.t !== 'cmd' || !r.match || !msg.cmd || typeof msg.id !== 'number') return;
  if (msg.id <= s.lastId) return;                           // replayed or duplicate (e.g. resent after a reconnect)
  s.lastId = msg.id;
  const now = Date.now(); s.window = s.window.filter(t => now - t < 1000);
  if (s.window.length >= MAX_CMDS_PER_SEC) return;          // flood guard
  s.window.push(now);
  r.match.enqueue({ ...msg.cmd, player: i } as Command);   // the seat decides who is acting, never the client
}

function onConnect(ws: Socket): void {
  ws.onMessage = raw => {
    let msg: { t?: string; size?: number; map?: number; code?: string; token?: string; hero?: HeroId | null } | null = null;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg) return;
    if (msg.t === 'create') {
      const size = msg.size === 4 ? 4 : 2, code = newCode();
      const mapIndex = size === 4 ? 1 : Math.max(0, Math.min(2, msg.map ?? 0));
      const heroes = Array.from({ length: size }, (_, k) => (['sprig', 'armorleaf', 'turnip'] as HeroId[])[k % 3]);
      const r: Room = { code, rc: { size, mapIndex, seed: randomBytes(4).readUInt32BE() | 1, heroes, goldenSeed: true }, seats: Array(size).fill(null), match: null, timer: null, emptySince: 0 };
      rooms.set(code, r);
      seatUp(r, 0, ws);
    } else if (msg.t === 'join' || msg.t === 'rejoin') {
      const r = rooms.get(String(msg.code ?? '').toUpperCase());
      if (!r) return ws.send({ t: 'error', reason: 'no_room' });
      if (msg.t === 'rejoin') {
        const i = r.seats.findIndex(s => s && s.token === msg!.token);
        if (i < 0) return ws.send({ t: 'error', reason: 'bad_token' });
        return seatUp(r, i, ws, msg.token);
      }
      const free = r.seats.findIndex(s => !s);
      if (free < 0) return ws.send({ t: 'error', reason: 'full' });
      seatUp(r, free, ws);
    }
  };
}

// ---------- HTTP: the game page, health, and the WebSocket upgrade ----------
const page = () => { const f = join(root, 'dist/broccoli.html'); return existsSync(f) ? readFileSync(f) : Buffer.from('run npm run build first'); };
const server = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size })); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page());
});
server.on('upgrade', (req: IncomingMessage, sock: Duplex) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || !req.url?.startsWith('/ws')) { sock.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  onConnect(new Socket(sock));
});
// rooms nobody is connected to are dropped after the grace period
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    const anyone = r.seats.some(s => s?.ws);
    if (anyone) r.emptySince = 0; else if (!r.emptySince) r.emptySince = now;
    else if (now - r.emptySince > GRACE_MS) { if (r.timer) clearInterval(r.timer); rooms.delete(r.code); }
  }
}, 5000);
server.listen(PORT, '0.0.0.0', () => console.log(`BROCCOLI server on http://localhost:${PORT}  (WebSocket /ws)`));
