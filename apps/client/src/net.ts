// Online client: talks to apps/server over WebSocket, keeps the seat token for reconnection.
import type { Command } from '../../../packages/simulation/src/index';
import type { RoomConfig } from '../../../packages/simulation/src/online';

export interface NetHandlers {
  lobby: (code: string, size: number, seats: string[]) => void;
  start: (rc: RoomConfig, seat: number, code: string) => void;
  snap: (ev: unknown[], s: Record<string, unknown>) => void;
  end: (history: number[][]) => void;
  error: (reason: string) => void;
  status: (connected: boolean) => void;
}
const KEY = 'broccoli.online';
export function defaultServer(): string {
  const saved = (() => { try { return localStorage.getItem(KEY + '.url'); } catch { return null; } })();
  if (saved) return saved;
  if (location.protocol.startsWith('http') && !location.hostname.endsWith('github.io')) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  return 'ws://localhost:8787/ws';
}

export class Net {
  private ws: WebSocket | null = null;
  private cmdId = 0;
  private closedByUs = false;
  private retry = 0;
  code = ''; token = ''; seat = -1;
  constructor(private url: string, private h: NetHandlers) {}

  private open(first: () => void): void {
    const ws = new WebSocket(this.url); this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.h.status(true); first(); };
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data));
      if (m.t === 'joined') { this.code = m.code; this.token = m.token; this.seat = m.seat; try { sessionStorage.setItem(KEY, JSON.stringify({ url: this.url, code: m.code, token: m.token })); } catch { /* private mode */ } }
      else if (m.t === 'lobby') this.h.lobby(m.code, m.size, m.seats);
      else if (m.t === 'start') this.h.start(m.rc, m.seat, m.code);
      else if (m.t === 'snap') this.h.snap(m.ev, m.s);
      else if (m.t === 'end') this.h.end(m.history);
      else if (m.t === 'error') this.h.error(m.reason);
    };
    // dropped (network, Safari in the background): keep trying to get the same seat back with the token
    ws.onclose = () => {
      this.h.status(false);
      if (this.closedByUs || !this.token) return;
      setTimeout(() => this.open(() => this.ws!.send(JSON.stringify({ t: 'rejoin', code: this.code, token: this.token }))), Math.min(4000, 600 * ++this.retry));
    };
  }
  create(size: 2 | 4, map: number): void { try { localStorage.setItem(KEY + '.url', this.url); } catch { /* */ } this.open(() => this.ws!.send(JSON.stringify({ t: 'create', size, map }))); }
  join(code: string): void { try { localStorage.setItem(KEY + '.url', this.url); } catch { /* */ } this.open(() => this.ws!.send(JSON.stringify({ t: 'join', code: code.trim().toUpperCase() }))); }
  rejoin(code: string, token: string): void { this.code = code; this.token = token; this.open(() => this.ws!.send(JSON.stringify({ t: 'rejoin', code, token }))); }
  /** Every command carries a rising id; the server ignores ids it has already seen. */
  send(cmd: Command): void { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'cmd', id: ++this.cmdId, cmd })); }
  close(): void { this.closedByUs = true; this.ws?.close(); }
  static saved(): { url: string; code: string; token: string } | null { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } }
  static forget(): void { try { sessionStorage.removeItem(KEY); } catch { /* */ } }
}
