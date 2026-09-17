import type { RacEvent } from './protocol';
import { errText, t } from './i18n';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** The daemon speaks one language (English) and tags every error with a code;
 *  it is translated here so no screen has to think about it. The code rides
 *  along on the Error: a screen that can do something better than an alert —
 *  ask for the name again, say — has to know which error it caught. */
function rpcError(data: any): Error & { code?: string | null } {
  const e: Error & { code?: string | null } = new Error(errText(data?.code, data?.message));
  e.code = data?.code ?? null;
  return e;
}

/** "The computer is not reachable right now" — as opposed to a real refusal
 *  from the daemon. Screens that were only going to say so themselves can check
 *  the code and stay quiet instead of raising an alert about it. */
function connError(key: 'wsNotConnected' | 'wsDropped' | 'wsTimeout'): Error & { code?: string | null } {
  const e: Error & { code?: string | null } = new Error(t(key));
  e.code = 'offline';
  return e;
}

export type ConnStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'unauthorized';

export class RacClient {
  private ws: WebSocket | null = null;
  private rid = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(ev: RacEvent) => void>();
  private statusListeners = new Set<(s: ConnStatus) => void>();
  private url = '';
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  status: ConnStatus = 'idle';

  connect(host: string, port: number, token: string) {
    const url = `ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`;
    // Same target and a live socket → nothing to do (init() can run twice under Fast Refresh).
    if (this.wanted && this.url === url && this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.url = url;
    this.wanted = true;
    this.retry = 0;
    if (this.timer) clearTimeout(this.timer);
    this.closeSocket();
    this.open();
  }

  private closeSocket() {
    const old = this.ws;
    this.ws = null;
    if (old) { try { old.onclose = null; old.onmessage = null; old.close(); } catch {} }
  }

  disconnect() {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.closeSocket();
    this.setStatus('idle');
  }

  private open() {
    if (!this.wanted) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.setStatus('online'); };
    ws.onmessage = (m) => this.handle(String(m.data));
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) p.reject(connError('wsDropped'));
      this.pending.clear();
      if (e.code === 4401 || e.code === 1008) { this.setStatus('unauthorized'); this.wanted = false; return; }
      this.setStatus('offline');
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (!this.wanted) return;
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.retry++, 4));
    this.timer = setTimeout(() => this.open(), delay);
  }

  /** Force an immediate reconnect attempt (e.g. app came to foreground). */
  poke() {
    if (!this.wanted || this.status === 'online' || this.status === 'connecting') return;
    if (this.timer) clearTimeout(this.timer);
    this.retry = 0;
    this.open();
  }

  private handle(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if ((m.type === 'ok' || m.type === 'error') && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.type === 'ok') p.resolve(m.data);
      else p.reject(rpcError(m.data));
      return;
    }
    if (m.type === 'event') {
      const ev: RacEvent = { event: m.event, chat_id: m.chat_id, seq: m.seq, data: m.data, ts: m.ts };
      for (const l of this.listeners) l(ev);
    }
  }

  /** Resolve once the socket is usable. A call made in the seconds around a
   *  reconnect — the app just came back to the foreground, the phone changed
   *  network — is not a failure, it is early. Waiting out the reconnect is the
   *  difference between a working tap and a "not connected" alert about a
   *  computer that is right there. */
  private ready(ms = 6000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (!this.wanted) return Promise.reject(connError('wsNotConnected'));
    this.poke();
    return new Promise<void>((resolve, reject) => {
      const done = (fn: () => void) => { clearTimeout(timer); off(); fn(); };
      const timer = setTimeout(() => done(() => reject(connError('wsNotConnected'))), ms);
      const off = this.onStatus((s) => {
        if (s === 'online') done(resolve);
        else if (s === 'unauthorized' || s === 'idle') done(() => reject(connError('wsNotConnected')));
      });
    });
  }

  async call<T = any>(type: string, data: Record<string, any> = {}): Promise<T> {
    await this.ready();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw connError('wsNotConnected');
    }
    const id = ++this.rid;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, type, data }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(connError('wsTimeout')); }
      }, 30000);
    });
  }

  on(l: (ev: RacEvent) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  onStatus(l: (s: ConnStatus) => void) { this.statusListeners.add(l); return () => { this.statusListeners.delete(l); }; }

  private setStatus(s: ConnStatus) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }
}

export const client = new RacClient();

/** One request to a computer other than the connected one, on its own socket.
 *  Used to read a sign-in off a second machine without dropping the live
 *  connection. The socket is closed as soon as the reply lands. */
export function callOnce<T = any>(host: string, port: number, token: string,
                                  type: string, data: Record<string, any> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`);
    } catch {
      reject(connError('wsNotConnected'));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { ws.onclose = null; ws.onmessage = null; ws.close(); } catch {}
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(connError('wsTimeout'))), 30000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, type, data })); } catch {} };
    ws.onerror = () => {};
    ws.onclose = (e: any) => finish(() => reject(
      e?.code === 4401 ? new Error(t('copyUnauthorized')) : connError('wsNotConnected')));
    ws.onmessage = (m) => {
      let msg: any;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.id !== 1) return;                         // host.status arrives first
      if (msg.type === 'ok') finish(() => resolve(msg.data as T));
      else if (msg.type === 'error') finish(() => reject(rpcError(msg.data)));
    };
  });
}
