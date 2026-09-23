import { create } from 'zustand';
import type { RacEvent } from './protocol';
import { clientFor, onAnyEvent } from './fleet';

/** One thing drawn in a conversation. Built by folding the daemon's event log,
 *  which is the only description of a chat that exists: there is no message
 *  table, just `events` ordered by seq. */
export type Item =
  | { kind: 'user'; id: string; ts: number; text: string; attachments: any[]; queued: boolean }
  | { kind: 'assistant'; id: string; ts: number; segment: number; text: string; done: boolean; attachments?: any[] }
  | { kind: 'thinking'; id: string; ts: number; text: string }
  | {
      kind: 'tool'; id: string; ts: number; tool: string; input: any;
      output: string | null; isError: boolean; running: boolean;
    }
  | {
      kind: 'approval'; id: string; ts: number; requestId: string; tool: string; input: any;
      preview: string; danger: boolean; reason: string | null;
      decision: 'allow' | 'allow_session' | 'deny' | 'expired' | null;
    }
  | {
      kind: 'turn'; id: string; ts: number; costUsd: number | null; usage: any;
      durationMs: number | null; numTurns: number | null; stopReason: string | null;
    }
  | { kind: 'error'; id: string; ts: number; message: string };

export interface ChatLog {
  items: Item[];
  /** highest seq folded in, so a reconnect can ask for only what it missed */
  seq: number;
  busy: boolean;
  pending: string[];
  loading: boolean;
  error: string | null;
  /** there is older history above the first item — the chat was opened at its tail */
  truncated: boolean;
}

const EMPTY: ChatLog = { items: [], seq: 0, busy: false, pending: [], loading: false, error: null, truncated: false };

/** A chat.get in flight, per chat. Two callers asking at once both read the
 *  same since_seq, and the slower answer overwrites the fuller one; sharing
 *  the request means they cannot disagree about where the chat ends. */
const inFlight = new Map<string, Promise<void>>();

/** Events that arrived while a chat.get was in the air. They are folded in
 *  after the answer lands rather than before it, so the rebuild cannot throw
 *  away a turn that ended during the load. */
const held = new Map<string, RacEvent[]>();

/** How many pages of 500 a reconnect will walk before giving up and taking
 *  the tail instead. Ten is an afternoon of events; past that the missed part
 *  is history, not context. */
const MAX_PAGES = 10;

export function logKey(hostKey: string, chatId: string): string {
  return `${hostKey}/${chatId}`;
}

/** Fold one event in. Returns the same array when nothing changed, so React
 *  can skip the render — a streaming turn fires these several times a second. */
export function apply(items: Item[], ev: RacEvent): Item[] {
  const d: any = ev.data || {};
  const ts = ev.ts || Date.now() / 1000;
  const id = ev.seq != null ? `s${ev.seq}` : `l${ev.event}-${ts}-${items.length}`;

  switch (ev.event) {
    case 'message.user':
      return [...items, {
        kind: 'user', id, ts, text: d.text ?? '',
        attachments: d.attachments ?? [], queued: !!d.queued,
      }];

    case 'text.delta': {
      const seg = Number(d.segment ?? 0);
      const i = lastOpenSegment(items, seg);
      if (i < 0) {
        return [...items, { kind: 'assistant', id, ts, segment: seg, text: d.text ?? '', done: false }];
      }
      const next = items.slice();
      const cur = next[i] as Extract<Item, { kind: 'assistant' }>;
      next[i] = { ...cur, text: cur.text + (d.text ?? '') };
      return next;
    }

    /** The authoritative text for a segment: it replaces whatever streaming
     *  built, rather than adding to it, so a dropped delta cannot leave a hole. */
    case 'message.assistant': {
      const seg = Number(d.segment ?? 0);
      const i = lastOpenSegment(items, seg);
      if (i < 0) {
        return [...items, { kind: 'assistant', id, ts, segment: seg, text: d.text ?? '', done: true, attachments: d.attachments ?? [] }];
      }
      const next = items.slice();
      next[i] = { ...(next[i] as any), text: d.text ?? '', done: true, id, attachments: d.attachments ?? [] };
      return next;
    }

    case 'thinking.delta': {
      const last = items[items.length - 1];
      if (last?.kind === 'thinking') {
        const next = items.slice();
        next[next.length - 1] = { ...last, text: last.text + (d.text ?? '') };
        return next;
      }
      return [...items, { kind: 'thinking', id, ts, text: d.text ?? '' }];
    }

    case 'tool.use':
      // A tool call ends the answer that was being written before it.
      return [...closeSegments(items), {
        kind: 'tool', id: `t${d.id}`, ts, tool: d.tool ?? '?', input: d.input ?? {},
        output: null, isError: false, running: true,
      }];

    case 'tool.result': {
      const i = items.findIndex((it) => it.kind === 'tool' && it.id === `t${d.id}`);
      if (i < 0) return items;
      const next = items.slice();
      next[i] = {
        ...(next[i] as any),
        output: d.output ?? '', isError: !!d.is_error, running: false,
      };
      return next;
    }

    case 'approval.request':
      return [...closeSegments(items), {
        kind: 'approval', id: `a${d.request_id}`, ts, requestId: d.request_id,
        tool: d.tool ?? '?', input: d.input ?? {}, preview: d.preview ?? '',
        danger: !!d.danger, reason: d.reason ?? null, decision: null,
      }];

    case 'approval.resolved': {
      const i = items.findIndex((it) => it.kind === 'approval' && it.id === `a${d.request_id}`);
      if (i < 0) return items;
      const next = items.slice();
      next[i] = { ...(next[i] as any), decision: d.decision ?? null };
      return next;
    }

    case 'turn.done':
      return [...closeSegments(items), {
        kind: 'turn', id, ts, costUsd: num(d.cost_usd), usage: d.usage ?? null,
        durationMs: num(d.duration_ms), numTurns: num(d.num_turns),
        stopReason: d.stop_reason ?? null,
      }];

    case 'turn.error':
      return [...closeSegments(items), { kind: 'error', id, ts, message: String(d.message ?? 'Bilinmeyen hata') }];

    default:
      return items;
  }
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Index of the still-growing bubble for a segment, or -1. Only the tail is
 *  searched: a segment that something else was appended after is finished. */
function lastOpenSegment(items: Item[], segment: number): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'assistant') return -1;
    if (it.segment === segment && !it.done) return i;
  }
  return -1;
}

function closeSegments(items: Item[]): Item[] {
  const i = items.length - 1;
  const last = items[i];
  if (last?.kind !== 'assistant' || last.done) return items;
  const next = items.slice();
  next[i] = { ...last, done: true };
  return next;
}

interface LogState {
  logs: Record<string, ChatLog>;
  open: (hostKey: string, chatId: string) => Promise<void>;
  feed: (hostKey: string, ev: RacEvent) => void;
  forget: (hostKey: string, chatId: string) => void;
}

export const useLogs = create<LogState>((set, get) => ({
  logs: {},

  open: async (hostKey, chatId) => {
    const k = logKey(hostKey, chatId);
    const running = inFlight.get(k);
    if (running) return running;
    const c = clientFor(hostKey);
    if (!c) return;

    const run = (async () => {
      const have = get().logs[k];
      set((s) => ({ logs: { ...s.logs, [k]: { ...(have ?? EMPTY), loading: true, error: null } } }));
      held.set(k, []);
      try {
        // Where the chat is picked up. A cold open is answered from the tail
        // (the daemon's doing); a reconnect asks forward from the last seq
        // already folded in, and keeps asking while the daemon says there is
        // more — one page short of caught up leaves a hole that never closes.
        let since = have?.seq ?? 0;
        let items = since > 0 ? (have?.items ?? []) : [];
        let seq = since;
        let truncated = since > 0 ? !!have?.truncated : false;
        let last: any = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          const r: any = await c.call('chat.get', { chat_id: chatId, since_seq: since });
          last = r;
          for (const ev of (r.events ?? []) as RacEvent[]) {
            if (ev.seq != null && ev.seq <= seq) continue;
            items = apply(items, ev);
            if (ev.seq != null) seq = ev.seq;
          }
          if (r.truncated) truncated = true;
          if (!r.more) break;
          if (seq <= since) break;                    // no progress; stop rather than spin
          since = seq;
        }
        // Anything that streamed in while the pages were in the air. A turn
        // that ended in that window has to move `busy` too, or the answer's
        // snapshot of it — taken before the event — leaves the chat "running".
        let busy = !!last?.busy;
        for (const ev of held.get(k) ?? []) {
          if (ev.event === 'turn.started') busy = true;
          else if (ev.event === 'turn.done' || ev.event === 'turn.error') busy = false;
          if (ev.seq != null && ev.seq <= seq) continue;
          items = apply(items, ev);
          if (ev.seq != null) seq = ev.seq;
        }
        set((s) => ({
          logs: {
            ...s.logs,
            [k]: {
              items, seq, truncated, busy,
              pending: last?.pending_approvals ?? [],
              loading: false, error: null,
            },
          },
        }));
      } catch (e: any) {
        set((s) => ({
          logs: { ...s.logs, [k]: { ...(s.logs[k] ?? EMPTY), loading: false, error: e?.message ?? 'Could not load the chat' } },
        }));
      } finally {
        held.delete(k);
      }
    })();

    inFlight.set(k, run);
    try { await run; } finally { inFlight.delete(k); }
  },

  feed: (hostKey, ev) => {
    if (!ev.chat_id) return;
    const k = logKey(hostKey, ev.chat_id);
    const waiting = held.get(k);
    if (waiting) { waiting.push(ev); return; }   // a load is in the air; fold it in after
    const cur = get().logs[k];
    if (!cur) return;                     // not open anywhere; chat.get will catch it up
    if (ev.seq != null && ev.seq <= cur.seq) return;   // already folded in
    const items = apply(cur.items, ev);
    const seq = ev.seq != null && ev.seq > cur.seq ? ev.seq : cur.seq;
    const busy = ev.event === 'turn.started' ? true
      : ev.event === 'turn.done' || ev.event === 'turn.error' ? false
      : cur.busy;
    if (items === cur.items && seq === cur.seq && busy === cur.busy) return;
    set((s) => ({ logs: { ...s.logs, [k]: { ...cur, items, seq, busy } } }));
  },

  forget: (hostKey, chatId) => set((s) => {
    const logs = { ...s.logs };
    delete logs[logKey(hostKey, chatId)];
    return { logs };
  }),
}));

export function emptyLog(): ChatLog { return EMPTY; }

/** Every open conversation follows its computer's socket for as long as the
 *  panel is running — switching screens must not lose a turn that is mid-flight. */
onAnyEvent((hostKey, ev) => useLogs.getState().feed(hostKey, ev));
