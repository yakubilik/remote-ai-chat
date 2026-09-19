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
}

const EMPTY: ChatLog = { items: [], seq: 0, busy: false, pending: [], loading: false, error: null };

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
    const c = clientFor(hostKey);
    if (!c) return;
    const have = get().logs[k];
    set((s) => ({ logs: { ...s.logs, [k]: { ...(have ?? EMPTY), loading: true, error: null } } }));
    try {
      const r: any = await c.call('chat.get', { chat_id: chatId, since_seq: have?.seq ?? 0 });
      const evs: RacEvent[] = r.events ?? [];
      let items = have && have.seq > 0 ? have.items : [];
      let seq = have?.seq ?? 0;
      for (const ev of evs) {
        items = apply(items, ev);
        if (ev.seq != null && ev.seq > seq) seq = ev.seq;
      }
      set((s) => ({
        logs: {
          ...s.logs,
          [k]: { items, seq, busy: !!r.busy, pending: r.pending_approvals ?? [], loading: false, error: null },
        },
      }));
    } catch (e: any) {
      set((s) => ({
        logs: { ...s.logs, [k]: { ...(s.logs[k] ?? EMPTY), loading: false, error: e?.message ?? 'Could not load the chat' } },
      }));
    }
  },

  feed: (hostKey, ev) => {
    if (!ev.chat_id) return;
    const k = logKey(hostKey, ev.chat_id);
    const cur = get().logs[k];
    if (!cur) return;                     // not open anywhere; chat.get will catch it up
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
