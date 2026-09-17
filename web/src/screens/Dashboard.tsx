import { useEffect, useMemo, useState } from 'react';
import { C, R, statusColor } from '../lib/theme';
import { Btn, Dot, Empty, Icon, P, Pulse, Spinner, mono } from '../ui/kit';
import { ago, clock, cost, tilde, toolSummary, until, uptime, windowName } from '../lib/format';
import { onAnyEvent, selectRunning, useFleet, type HostSlot, type Running } from '../lib/fleet';
import { interrupt } from '../lib/actions';
import type { LimitWindow } from '../lib/protocol';

// TODO(daemon): the artboard asks for numbers the protocol does not carry yet.
// Each of these is a daemon change, not a screen change — until then the panel
// stays quiet rather than drawing a guess.
// - CPU / RAM load: host.info reports no measurements.
// - A "last 7 days" cost chart: there is no historical spend query, only a per-chat lifetime total.
// - A queue panel for the phone: queue depth is not in the protocol.
// - Daemon restart count and last error: the daemon keeps neither.
// - "N sessions closed in the last 24h": there is no closed-session history query.

/** Alpha variants of the theme colours, exactly as the artboards use them —
 *  kit.tsx does the same. No new hues, only opacity. */
const TINT = {
  warnBg: 'rgba(216,166,87,0.16)',
  warnBd: 'rgba(216,166,87,0.32)',
  infoBg: 'rgba(125,154,209,0.14)',
  infoBd: 'rgba(125,154,209,0.28)',
  dangerBg: 'rgba(224,83,63,0.10)',
  dangerBd: 'rgba(224,83,63,0.28)',
  plain: 'rgba(241,236,227,0.08)',
  track: 'rgba(241,236,227,0.10)',
};

const IC = {
  refresh: 'M20 11a8 8 0 1 0-2.3 5.6M20 5v6h-6',
  laptop: 'M5.5 6.5a1.5 1.5 0 0 1 1.5-1.5h10a1.5 1.5 0 0 1 1.5 1.5V15h-13zM2.5 15h19l-1.2 2.6a1.5 1.5 0 0 1-1.4.9H5.1a1.5 1.5 0 0 1-1.4-.9z',
  lock: 'M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4',
};

export interface DashboardProps {
  onOpenChat: (hostKey: string, chatId: string) => void;
  onNewChat: () => void;
}

/* ─────────────────────────── small helpers ─────────────────────────── */

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** The address a computer answers on is a private detail — enough of it is
 *  shown to tell two computers apart, never enough to dial it. */
function maskHost(host: string): string {
  if (!host) return '';
  if (isLocal(host)) return 'local';
  const ip = host.match(/^(\d{1,3})\.\d{1,3}\.\d{1,3}\.(\d{1,3})$/);
  if (ip) return `${ip[1]}.•••.•••.${ip[2]}`;
  const [first, ...rest] = host.split('.');
  const head = first.length > 3 ? `${first.slice(0, 3)}•••` : `${first}•••`;
  return rest.length ? `${head}.${rest.join('.')}` : head;
}

/** Clock-style elapsed time — the table reads as a stopwatch, not as prose. */
function elapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function connLabel(slot: HostSlot): { text: string; color: string; live: boolean } {
  if (slot.status === 'online') return { text: 'online', color: C.ok, live: true };
  if (slot.status === 'connecting') return { text: 'connecting…', color: C.warn, live: false };
  if (slot.status === 'unauthorized') return { text: 'no access', color: C.danger, live: false };
  return { text: 'offline', color: C.faint, live: false };
}

function limitTone(u: number): string {
  if (u >= 0.9) return C.danger;
  if (u >= 0.6) return C.warn;
  return C.info;
}

function permTone(mode: string): { fg: string; bg: string; bd: string } {
  const m = (mode || '').toLowerCase();
  if (m.includes('bypass') || m.includes('danger') || m.includes('full')) {
    return { fg: C.warn, bg: TINT.warnBg, bd: TINT.warnBd };
  }
  if (m.includes('edit')) return { fg: C.info, bg: TINT.infoBg, bd: TINT.infoBd };
  return { fg: C.mute, bg: TINT.plain, bd: C.borderStrong };
}

const EVENT_TONE: Record<string, string> = {
  'tool.use': C.info,
  'tool.result': C.info,
  'approval.request': C.warn,
  'approval.resolved': C.ok,
  'turn.started': C.mute,
  'turn.done': C.ok,
  'turn.error': C.danger,
  'message.user': C.accentSoft,
};

/* ─────────────────────────── shared bits ─────────────────────────── */

function Panel({ title, hint, right, children, pad = true }: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  pad?: boolean;
}) {
  return (
    <div style={{
      borderRadius: R.card, background: C.surface, border: `1px solid ${C.border}`,
      display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0,
    }}>
      <div style={{
        height: 44, flexShrink: 0, padding: '0 14px', display: 'flex',
        alignItems: 'center', gap: 10,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{title}</div>
        {hint && (
          <div style={{
            ...mono, fontSize: 11, color: C.mute, minWidth: 0,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{hint}</div>
        )}
        <div style={{ flex: 1 }} />
        {right}
      </div>
      <div style={pad ? { padding: '0 14px 14px' } : undefined}>{children}</div>
    </div>
  );
}

function Badge({ text, fg, bg, bd, small }: {
  text: string; fg: string; bg: string; bd: string; small?: boolean;
}) {
  return (
    <span style={{
      height: 20, borderRadius: R.badge, padding: small ? '0 6px' : '0 7px',
      display: 'inline-flex', alignItems: 'center', background: bg,
      border: `1px solid ${bd}`, color: fg, whiteSpace: 'nowrap',
      fontSize: small ? 10 : 11, fontWeight: 500,
      maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
      ...(small ? mono : {}),
    }}>{text}</span>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const claude = provider === 'claude';
  return (
    <Badge
      text={claude ? 'Claude' : 'Codex'}
      fg={claude ? C.accentSoft : C.info}
      bg={claude ? C.accentTint : TINT.infoBg}
      bd={claude ? C.accentRing : TINT.infoBd}
    />
  );
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{
      height: 5, borderRadius: 3, background: TINT.track, overflow: 'hidden', marginTop: 6,
    }}>
      <div style={{ width: `${Math.round(value * 100)}%`, height: 5, borderRadius: 3, background: color }} />
    </div>
  );
}

/* ─────────────────────────── computer cards ─────────────────────────── */

function HostCard({ slot, known }: { slot: HostSlot; known: number }) {
  const conn = connLabel(slot);
  const online = slot.status === 'online';
  const info = slot.info;
  const dim = !online;
  const masked = maskHost(slot.cfg.host);

  return (
    <div style={{
      minHeight: 156, boxSizing: 'border-box', borderRadius: R.card,
      background: online ? C.surface : C.hair,
      border: `1px solid ${online ? C.borderStrong : C.border}`,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon path={IC.laptop} size={18} color={dim ? C.faint : C.text2} />
        <div style={{
          fontSize: 15, fontWeight: 600, lineHeight: '20px', color: dim ? C.mute : C.text,
          minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{info?.name || slot.cfg.name}</div>
        {isLocal(slot.cfg.host) && (
          <Badge text="this computer" fg={C.accentSoft} bg={C.accentTint} bd={C.accentRing} />
        )}
        <div style={{ flex: 1 }} />
        <Dot color={conn.color} live={conn.live} size={8} />
        <div style={{ fontSize: 12, color: conn.color, whiteSpace: 'nowrap' }}>{conn.text}</div>
      </div>

      <div style={{
        ...mono, fontSize: 11, lineHeight: '15px', color: dim ? C.faint : C.mute,
        marginTop: 7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {info
          ? `${info.os}${info.os_version ? ` ${info.os_version}` : ''} · daemon ${info.daemon_version}`
          : 'no daemon information'}
      </div>

      {online && info ? (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <Stat label="Uptime" value={uptime(info.uptime_s)} />
          <Stat label="Sessions" value={String(info.active_sessions)} />
          <Stat label="Devices" value={String(info.connected_devices)} />
        </div>
      ) : (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 13, lineHeight: '17px', color: C.mute }}>
            {slot.lastOnline
              ? `Last seen ${ago(slot.lastOnline / 1000)} ago`
              : 'Never reached in this session'}
          </div>
          <div style={{ fontSize: 13, lineHeight: '17px', color: C.mute }}>
            {known ? `${known} chats, last known` : 'No chat information'}
          </div>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 10 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{
          ...mono, fontSize: 11, color: dim ? C.faint : C.mute, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {info
            ? `claude ${info.versions?.claude ?? '—'} · codex ${info.versions?.codex ?? '—'}`
            : '—'}
        </div>
        <div style={{ flex: 1 }} />
        <Icon path={IC.lock} size={12} color={online ? C.ok : C.faint} width={2.4} />
        <div style={{ ...mono, fontSize: 11, color: dim ? C.faint : C.mute, whiteSpace: 'nowrap' }}>
          {masked}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ fontSize: 12, color: C.mute, flex: 1, minWidth: 0 }}>{label}</div>
      <div style={{ ...mono, fontSize: 11, color: C.text2, whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

/* ─────────────────────────── running sessions ─────────────────────────── */

/** Fixed columns, declared once so the header and the rows cannot drift apart.
 *  Only the two text columns stretch; every number keeps its own lane. */
const COL = {
  chat: { flexGrow: 2, flexBasis: 0, minWidth: 150 },
  host: 80,
  model: 116,
  effort: 52,
  perm: 88,
  now: { flexGrow: 1, flexBasis: 0, minWidth: 110 },
  dur: 52,
  cost: 60,
  act: 62,
} as const;

function cell(w: number | { flexGrow: number; flexBasis: number; minWidth: number }, right = false): React.CSSProperties {
  const base: React.CSSProperties = {
    boxSizing: 'border-box', paddingRight: 10, minWidth: 0,
    textAlign: right ? 'right' : 'left',
  };
  return typeof w === 'number' ? { ...base, width: w, flexShrink: 0 } : { ...base, ...w };
}

const headText: React.CSSProperties = {
  fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase', color: C.mute,
  whiteSpace: 'nowrap', overflow: 'hidden',
};

/** What a chat is doing this very second. The chat row itself only knows its
 *  status, so the tool in flight and the moment the turn started are folded out
 *  of the live event stream instead. */
interface Live {
  tool: string | null; detail: string; approval: string | null;
  since: number | null;
  /** the tool has already returned: still the truest answer to "what is it
   *  doing", but drawn dimmer so a finished call cannot pass for a live one */
  done: boolean;
}

const EMPTY_LIVE: Live = { tool: null, detail: '', approval: null, since: null, done: false };

function SessionRow({ r, live, now, onOpen, onStop }: {
  r: Running; live: Live; now: number;
  onOpen: () => void; onStop: () => void;
}) {
  const chat = r.chat;
  const awaiting = chat.status === 'awaiting_approval';
  const perm = permTone(chat.perm_mode);
  const since = live.since ?? chat.updated_at;
  const dur = elapsed(now / 1000 - since);

  return (
    <div
      onClick={onOpen}
      style={{
        height: 68, flexShrink: 0, boxSizing: 'border-box', padding: '0 14px 0 12px',
        display: 'flex', alignItems: 'center', cursor: 'pointer',
        borderTop: `1px solid ${C.border}`,
        background: awaiting ? C.surface3 : 'transparent',
        borderLeft: `2px solid ${awaiting ? C.warn : 'transparent'}`,
      }}
    >
      <div style={{ ...cell(COL.chat), display: 'flex', alignItems: 'center', gap: 8 }}>
        {awaiting
          ? <Icon path={P.warn} size={12} color={C.warn} width={2.4} />
          : <Dot color={statusColor(chat.status)} live size={8} />}
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 500, lineHeight: '17px', color: C.text,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }} title={chat.title || 'New chat'}>{chat.title || 'New chat'}</div>
          <div style={{
            ...mono, fontSize: 11, lineHeight: '15px', color: C.mute, marginTop: 2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }} title={tilde(chat.cwd)}>{tilde(chat.cwd)}</div>
        </div>
      </div>

      <div style={{
        ...cell(COL.host), fontSize: 12, lineHeight: '15px', color: C.text2,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }} title={r.hostName}>{r.hostName}</div>

      <div style={cell(COL.model)}>
        <ProviderBadge provider={chat.provider} />
        <div style={{
          ...mono, fontSize: 11, lineHeight: '15px', color: C.text2, marginTop: 3,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }} title={chat.model}>{chat.model}</div>
      </div>

      <div style={{ ...cell(COL.effort), ...mono, fontSize: 11, color: chat.effort ? C.text2 : C.faint }}>
        {chat.effort || '—'}
      </div>

      <div style={cell(COL.perm)}>
        <Badge text={chat.perm_mode || '—'} fg={perm.fg} bg={perm.bg} bd={perm.bd} small />
      </div>

      <div style={cell(COL.now)}>
        {awaiting ? (
          <>
            <Badge text="awaiting approval" fg={C.warn} bg={TINT.warnBg} bd={TINT.warnBd} />
            {live.approval && (
              <div style={{
                ...mono, fontSize: 11, lineHeight: '15px', color: C.mute, marginTop: 3,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }} title={live.approval}>{live.approval}</div>
            )}
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <Pulse />
            <div style={{
              ...mono, fontSize: 11, minWidth: 0,
              color: live.tool ? (live.done ? C.mute : C.text2) : C.mute,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }} title={live.tool ? `${live.tool} ${live.detail}`.trim() : undefined}>
              {live.tool ? `${live.tool} ${live.detail}`.trim() : 'running…'}
            </div>
          </div>
        )}
      </div>

      <div style={{
        ...cell(COL.dur, true), ...mono, fontSize: 11,
        color: awaiting ? C.warn : C.text2,
      }}>{dur}</div>

      <div style={{ ...cell(COL.cost, true), ...mono, fontSize: 11, color: C.text2 }}>
        {cost(chat.total_cost_usd)}
      </div>

      <div style={{ ...cell(COL.act), paddingRight: 0, display: 'flex', justifyContent: 'flex-end' }}>
        {awaiting ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            style={{
              height: 26, borderRadius: R.btn, background: TINT.warnBg,
              border: `1px solid ${TINT.warnBd}`, padding: '0 9px', cursor: 'pointer',
              fontSize: 12, fontWeight: 600, color: C.warn,
            }}
          >Answer</button>
        ) : (
          <button
            type="button" title="Stop"
            onClick={(e) => { e.stopPropagation(); onStop(); }}
            style={{
              width: 26, height: 26, borderRadius: R.btn, background: 'transparent',
              border: `1px solid ${C.borderStrong}`, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon path={P.stop} size={12} color={C.mute} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── plan limits ─────────────────────────── */

function WindowRow({ w }: { w: LimitWindow }) {
  const u = Math.max(0, Math.min(1, w.utilization ?? 0));
  const tone = limitTone(u);
  const note = w.status === 'rejected' ? 'used up' : w.status === 'allowed_warning' ? 'warning' : null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Dot color={tone} live={u >= 0.6} size={6} />
        <div style={{
          fontSize: 12, color: C.text2, flex: 1, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{windowName(w.window)}</div>
        <div style={{ ...mono, fontSize: 11, color: tone }}>{Math.round(u * 100)}%</div>
      </div>
      <Bar value={u} color={tone} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <div style={{ ...mono, fontSize: 10, color: C.faint, flex: 1, minWidth: 0, whiteSpace: 'nowrap' }}>
          {w.resets_at ? `resets · ${until(w.resets_at)}` : 'reset time unknown'}
        </div>
        {note && <span style={{ ...mono, fontSize: 10, color: tone }}>{note}</span>}
        {w.overage_status && (
          <span style={{ ...mono, fontSize: 10, color: C.mute }}>overage · {w.overage_status}</span>
        )}
      </div>
    </div>
  );
}

function LimitsPanel({ hosts, order }: { hosts: Record<string, HostSlot>; order: string[] }) {
  const blocks = useMemo(() => {
    const out: { key: string; host: string; label: string; id: string; windows: LimitWindow[] }[] = [];
    for (const k of order) {
      const slot = hosts[k];
      if (!slot) continue;
      for (const [id, windows] of Object.entries(slot.limits ?? {})) {
        const live = (windows ?? [])
          .filter((w) => typeof w.utilization === 'number')
          .sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0));
        if (!live.length) continue;
        out.push({
          key: `${k}/${id}`,
          host: slot.info?.name || slot.cfg.name,
          label: slot.accounts.find((a) => a.id === id)?.label || id,
          id,
          windows: live,
        });
      }
    }
    return out;
  }, [hosts, order]);

  return (
    <Panel title="Plan limits" hint={blocks.length ? 'as the tools report them' : undefined}>
      {blocks.length ? blocks.map((b, i) => (
        <div key={b.key} style={{
          paddingTop: i ? 12 : 0,
          borderTop: i ? `1px solid ${C.border}` : undefined,
          marginTop: i ? 12 : 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <div style={{
              fontSize: 13, fontWeight: 600, minWidth: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{b.label}</div>
            <div style={{ flex: 1 }} />
            <div style={{ ...mono, fontSize: 10, color: C.faint, whiteSpace: 'nowrap' }}>{b.host}</div>
          </div>
          {b.label !== b.id && (
            <div style={{ ...mono, fontSize: 10, color: C.faint, marginTop: 2 }}>{b.id}</div>
          )}
          {b.windows.map((w) => <WindowRow key={w.window} w={w} />)}
        </div>
      )) : (
        <div style={{ fontSize: 12, lineHeight: '17px', color: C.mute }}>
          No tool has reported plan usage yet. It lands here after the first turn.
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────────────── daemon health ─────────────────────────── */

function HealthPanel({ hosts, order }: { hosts: Record<string, HostSlot>; order: string[] }) {
  const online = order.filter((k) => hosts[k]?.status === 'online').length;
  const tone = online === order.length ? C.ok : online ? C.warn : C.faint;
  const word = online === order.length ? 'healthy' : online ? 'partial' : 'offline';

  return (
    <Panel
      title="Daemon health"
      right={
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Dot color={tone} live={online > 0} size={7} />
          <span style={{ fontSize: 12, color: tone }}>{word}</span>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {order.map((k) => {
          const slot = hosts[k];
          if (!slot) return null;
          const conn = connLabel(slot);
          const info = slot.info;
          return (
            <div key={k}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Dot color={conn.color} live={conn.live} size={6} />
                <div style={{
                  fontSize: 12, color: C.text2, flex: 1, minWidth: 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{info?.name || slot.cfg.name}</div>
                <div style={{ ...mono, fontSize: 11, color: C.text2, whiteSpace: 'nowrap' }}>
                  {info && slot.status === 'online' ? uptime(info.uptime_s) : conn.text}
                </div>
              </div>
              <div style={{ ...mono, fontSize: 10, color: C.faint, marginTop: 3, whiteSpace: 'nowrap' }}>
                {info
                  ? `daemon ${info.daemon_version} · ${info.connected_devices} devices · ${info.active_sessions} sessions`
                  : slot.lastOnline ? `last seen ${ago(slot.lastOnline / 1000)}` : 'never reached'}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ─────────────────────────── screen ─────────────────────────── */

export function Dashboard({ onOpenChat, onNewChat }: DashboardProps) {
  const fleet = useFleet();
  const { hosts, order, activity } = fleet;
  const [live, setLive] = useState<Record<string, Live>>({});
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  const running = useMemo(() => selectRunning(fleet), [fleet.hosts, fleet.order]);
  const ticking = running.length > 0;

  // Only the running rows need a second hand; when nothing runs the clock in
  // the title strip is the only thing left to keep fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ticking ? 1000 : 30000);
    return () => clearInterval(id);
  }, [ticking]);

  useEffect(() => onAnyEvent((key, ev) => {
    if (!ev.chat_id) return;
    const k = `${key}/${ev.chat_id}`;
    const d: any = ev.data || {};
    const ts = ev.ts || Date.now() / 1000;
    setLive((m) => {
      const cur = m[k] ?? EMPTY_LIVE;
      switch (ev.event) {
        case 'turn.started':
          return { ...m, [k]: { ...EMPTY_LIVE, since: ts } };
        case 'tool.use':
          return { ...m, [k]: { ...cur, tool: d.tool ?? null, detail: toolSummary(d.tool ?? '', d.input), done: false } };
        case 'tool.result':
          return cur.tool ? { ...m, [k]: { ...cur, done: true } } : m;
        case 'approval.request':
          return { ...m, [k]: { ...cur, approval: `${d.tool ?? ''} ${toolSummary(d.tool ?? '', d.input)}`.trim() } };
        case 'approval.resolved':
          return { ...m, [k]: { ...cur, approval: null } };
        case 'turn.done':
        case 'turn.error': {
          if (!(k in m)) return m;
          const next = { ...m };
          delete next[k];
          return next;
        }
        default:
          return m;
      }
    });
  }), []);

  const doRefresh = async () => {
    setBusy(true);
    try { await Promise.all(order.map((k) => fleet.refresh(k))); }
    finally { setBusy(false); }
  };

  const awaiting = running.filter((r) => r.chat.status === 'awaiting_approval').length;
  const openCost = running.reduce((n, r) => n + (Number(r.chat.total_cost_usd) || 0), 0);
  const anyOnline = order.some((k) => hosts[k]?.status === 'online');
  const stamp = new Date(now);

  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
      background: C.bg, overflow: 'hidden',
    }}>
      <div style={{
        height: 60, flexShrink: 0, boxSizing: 'border-box', padding: '0 28px',
        borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.2 }}>Panel</div>
        <div style={{ ...mono, fontSize: 11, color: C.mute }}>
          {stamp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          {' · '}
          {stamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div style={{ flex: 1 }} />
        <Btn onClick={doRefresh} disabled={busy}>
          {busy ? <Spinner size={13} color={C.mute} /> : <Icon path={IC.refresh} size={14} color={C.mute} />}
          Refresh
        </Btn>
        <Btn kind="primary" onClick={onNewChat}>
          <Icon path={P.plus} size={14} color="#FFFFFF" width={2.4} />
          New chat
        </Btn>
      </div>

      <div style={{
        flex: 1, overflowY: 'auto', boxSizing: 'border-box', padding: '20px 28px',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          {/* left column */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{
              display: 'grid', gap: 16,
              // capped rather than stretched: one paired computer should not
              // produce a card as wide as the table under it
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 420px))',
            }}>
              {order.map((k) => hosts[k] && (
                <HostCard
                  key={k} slot={hosts[k]}
                  known={hosts[k].chats.filter((c) => !c.archived).length}
                />
              ))}
            </div>

            <Panel
              title="Active sessions"
              hint={running.length
                ? `${running.length} sessions · ${running.length - awaiting} running · ${awaiting} awaiting approval`
                : 'across every computer'}
              pad={false}
              right={running.length ? (
                <Btn onClick={() => { for (const r of running) interrupt(r.hostKey, r.chat.id).catch(() => {}); }}>
                  <Icon path={P.stop} size={12} color={C.mute} />
                  Stop all
                </Btn>
              ) : undefined}
            >
              {running.length ? (
                <>
                  <div style={{
                    height: 32, boxSizing: 'border-box', padding: '0 14px 0 12px',
                    display: 'flex', alignItems: 'center', background: C.hair,
                    borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
                  }}>
                    <div style={{ ...cell(COL.chat), ...headText }}>Chat</div>
                    <div style={{ ...cell(COL.host), ...headText }}>Device</div>
                    <div style={{ ...cell(COL.model), ...headText }}>Model</div>
                    <div style={{ ...cell(COL.effort), ...headText }}>Effort</div>
                    <div style={{ ...cell(COL.perm), ...headText }}>Perm</div>
                    <div style={{ ...cell(COL.now), ...headText }}>Now</div>
                    <div style={{ ...cell(COL.dur, true), ...headText }}>Time</div>
                    <div style={{ ...cell(COL.cost, true), ...headText }}>Cost</div>
                    <div style={{ ...cell(COL.act), paddingRight: 0 }} />
                  </div>
                  {running.map((r) => (
                    <SessionRow
                      key={`${r.hostKey}/${r.chat.id}`}
                      r={r}
                      live={live[`${r.hostKey}/${r.chat.id}`] ?? EMPTY_LIVE}
                      now={now}
                      onOpen={() => onOpenChat(r.hostKey, r.chat.id)}
                      onStop={() => interrupt(r.hostKey, r.chat.id).catch(() => {})}
                    />
                  ))}
                  <div style={{
                    height: 38, boxSizing: 'border-box', padding: '0 14px',
                    display: 'flex', alignItems: 'center', gap: 8,
                    borderTop: `1px solid ${C.border}`, background: C.hair,
                  }}>
                    <div style={{ fontSize: 12, color: C.mute }}>
                      Lifetime total across open chats
                    </div>
                    <div style={{ flex: 1 }} />
                    <div style={{ ...mono, fontSize: 12, color: C.text2 }}>{cost(openCost)}</div>
                  </div>
                </>
              ) : (
                <div style={{
                  minHeight: 220, display: 'flex', borderTop: `1px solid ${C.border}`,
                }}>
                  <Empty
                    icon={<Icon path={P.bolt} size={22} color={C.faint} />}
                    title={anyOnline ? 'Nothing is running anywhere right now' : 'No computer connected'}
                    hint={anyOnline
                      ? 'The moment a chat starts working or asks for approval, its row appears here.'
                      : 'When the computers come online, their running sessions gather here.'}
                  />
                </div>
              )}
            </Panel>
          </div>

          {/* right, narrow column */}
          <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <LimitsPanel hosts={hosts} order={order} />
            <HealthPanel hosts={hosts} order={order} />
          </div>
        </div>

        {/* live event stream */}
        <div style={{
          borderRadius: R.card, background: C.hair, border: `1px solid ${C.border}`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{
            height: 36, flexShrink: 0, boxSizing: 'border-box', padding: '0 14px',
            display: 'flex', alignItems: 'center', gap: 8,
            borderBottom: `1px solid ${C.border}`,
          }}>
            <Dot color={anyOnline ? C.ok : C.faint} live={anyOnline} size={7} />
            <div style={{ fontSize: 13, fontWeight: 600 }}>Live events</div>
            <div style={{ ...mono, fontSize: 11, color: C.mute }}>
              {anyOnline ? 'stream open' : 'stream closed'}
              {activity.length ? ` · ${activity.length} olay` : ''}
            </div>
          </div>

          <div style={{ padding: '6px 14px 10px', maxHeight: 300, overflowY: 'auto' }}>
            {activity.length ? activity.slice(0, 40).map((a) => (
              <div
                key={a.id}
                onClick={() => a.chatId && onOpenChat(a.hostKey, a.chatId)}
                style={{
                  minHeight: 20, display: 'flex', alignItems: 'center', gap: 10,
                  cursor: a.chatId ? 'pointer' : 'default',
                }}
              >
                <div style={{ ...mono, fontSize: 11, color: C.faint, width: 62, flexShrink: 0 }}>
                  {clock(a.ts)}
                </div>
                <div style={{
                  ...mono, fontSize: 11, width: 122, flexShrink: 0,
                  color: EVENT_TONE[a.event] ?? C.mute,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{a.event}</div>
                <div style={{
                  ...mono, fontSize: 11, color: C.text2, minWidth: 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }} title={a.text}>
                  {order.length > 1 ? `${a.hostName} · ${a.text}` : a.text}
                </div>
              </div>
            )) : (
              <div style={{ ...mono, fontSize: 11, color: C.faint, padding: '10px 0' }}>
                No events yet — rows stream in here once a turn begins.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
