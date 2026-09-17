import { useMemo, useState } from 'react';
import { C, R } from '../lib/theme';
import { Dot, Icon, P, Pulse, mono } from '../ui/kit';
import { ago, uptime } from '../lib/format';
import { useFleet, type HostSlot } from '../lib/fleet';
import type { Chat, Group } from '../lib/protocol';

const W = 260;

export type View = 'chats' | 'dashboard' | 'projects' | 'agents' | 'settings';

export function ProviderMark({ provider, dim }: { provider: string; dim?: boolean }) {
  const claude = provider === 'claude';
  return (
    <div style={{
      width: 30, height: 30, borderRadius: R.btn, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: claude ? C.accentTint : C.surface2,
      border: `1px solid ${claude ? C.accentRing : C.border}`,
      color: claude ? C.accentSoft : C.mute,
      fontSize: claude ? 13 : 11, fontWeight: 600,
      opacity: dim ? 0.6 : 1,
      ...(claude ? {} : mono),
    }}>
      {claude ? 'A' : '<>'}
    </div>
  );
}

function hostDetail(slot: HostSlot): string {
  if (slot.status === 'online') return `online · :${slot.cfg.port}`;
  if (slot.status === 'connecting') return 'connecting…';
  if (slot.status === 'unauthorized') return 'no access · token revoked';
  return slot.lastOnline ? `offline · ${ago(slot.lastOnline / 1000)}` : 'offline';
}

function HostCard({ hosts, order, focus, onFocus }: {
  hosts: Record<string, HostSlot>; order: string[]; focus: string | null;
  onFocus: (k: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const slot = focus ? hosts[focus] : null;
  const online = slot?.status === 'online';

  if (!slot) {
    return (
      <div style={{
        border: `1px solid ${C.border}`, borderRadius: R.card, background: C.bg,
        padding: '12px 14px', fontSize: 12, color: C.mute,
      }}>No computer paired yet</div>
    );
  }

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: R.card, background: C.bg, overflow: 'hidden' }}>
      <button
        type="button" onClick={() => order.length > 1 && setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px',
          background: 'transparent', border: 'none',
          cursor: order.length > 1 ? 'pointer' : 'default', textAlign: 'left',
        }}
      >
        <Icon path={P.cpu} size={16} color={C.mute} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{slot.info?.name || slot.cfg.name}</div>
          <div style={{
            fontSize: 11, color: C.mute, display: 'flex', alignItems: 'center', gap: 5, marginTop: 2,
          }}>
            <Dot color={online ? C.ok : slot.status === 'unauthorized' ? C.danger : C.faint} live={online} size={5} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {hostDetail(slot)}
            </span>
          </div>
        </div>
        {order.length > 1 && <Icon path={open ? P.chevronDown : P.chevronRight} size={13} color={C.faint} />}
      </button>
      {open && order.filter((k) => k !== focus).map((k) => {
        const s = hosts[k];
        return (
          <button
            key={k} type="button"
            onClick={() => { onFocus(k); setOpen(false); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 34,
              padding: '0 12px', background: 'transparent', border: 'none',
              borderTop: `1px solid ${C.border}`, cursor: 'pointer', textAlign: 'left',
            }}
          >
            <Dot color={s.status === 'online' ? C.ok : C.faint} live={s.status === 'online'} size={5} />
            <span style={{
              flex: 1, fontSize: 12, color: C.text2, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{s.info?.name || s.cfg.name}</span>
            <span style={{ fontSize: 11, color: C.faint }}>{hostDetail(s).split(' · ')[0]}</span>
          </button>
        );
      })}
    </div>
  );
}

const NAV: { view: View; label: string; icon: string }[] = [
  { view: 'chats', label: 'Chats', icon: 'M20 4H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3v4l5-4h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z' },
  { view: 'dashboard', label: 'Panel', icon: P.grid },
  { view: 'projects', label: 'Projects', icon: P.folder },
  { view: 'agents', label: 'Agents', icon: P.agent },
  { view: 'settings', label: 'Settings', icon: P.gear },
];

function NavRow({ item, active, count, alert, onClick }: {
  item: typeof NAV[number]; active: boolean; count?: number; alert?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button" onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 36,
        padding: '0 10px', borderRadius: R.btn, cursor: 'pointer', textAlign: 'left',
        background: active ? C.accentTint : 'transparent',
        border: `1px solid ${active ? C.accentRing : 'transparent'}`,
      }}
    >
      <Icon path={item.icon} size={16} color={active ? C.accentSoft : C.mute} />
      <span style={{ flex: 1, fontSize: 14, fontWeight: active ? 600 : 400, color: active ? C.text : C.text2 }}>
        {item.label}
      </span>
      {alert ? <Dot color={C.warn} live />
        : count != null ? <span style={{ fontSize: 12, color: C.faint }}>{count}</span> : null}
    </button>
  );
}

interface Section { key: string; title: string; chats: Chat[] }

function sections(chats: Chat[], groups: Group[]): Section[] {
  const byGroup = new Map<string, Chat[]>();
  const loose: Chat[] = [];
  for (const c of chats) {
    if (c.archived) continue;
    if (c.group_id) {
      const arr = byGroup.get(c.group_id) ?? [];
      arr.push(c);
      byGroup.set(c.group_id, arr);
    } else loose.push(c);
  }
  const rank = (c: Chat) => (c.pinned ? 0 : 1);
  const sort = (a: Chat[]) => a.sort((x, y) => rank(x) - rank(y) || y.updated_at - x.updated_at);
  const out: Section[] = [];
  for (const g of [...groups].sort((a, b) => a.sort - b.sort)) {
    const arr = byGroup.get(g.id);
    if (arr?.length) out.push({ key: g.id, title: g.name, chats: sort(arr) });
  }
  if (loose.length) out.push({ key: '__loose', title: 'Ungrouped', chats: sort(loose) });
  return out;
}

function ChatRow({ chat, selected, onPick }: { chat: Chat; selected: boolean; onPick: () => void }) {
  const awaiting = chat.status === 'awaiting_approval';
  const running = chat.status === 'running';
  return (
    <button
      type="button" onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 56,
        padding: '8px 10px', borderRadius: R.card, cursor: 'pointer', textAlign: 'left',
        background: selected ? C.accentTint : 'transparent',
        border: `1px solid ${selected ? C.accentRing : 'transparent'}`,
      }}
    >
      <ProviderMark provider={chat.provider} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 500, color: C.text, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{chat.title || 'New chat'}</div>
        <div style={{
          fontSize: 12, color: awaiting ? C.warn : C.mute, display: 'flex',
          alignItems: 'center', gap: 4, marginTop: 2, minWidth: 0,
        }}>
          {awaiting && <Icon path={P.warn} size={11} color={C.warn} />}
          <span style={{
            ...(awaiting ? mono : null),
            minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {chat.last_preview || (running ? 'Running…' : 'Empty chat')}
          </span>
        </div>
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        {awaiting ? (
          <span style={{
            ...mono, fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
            color: C.warn, background: 'rgba(216,166,87,0.16)',
            border: '1px solid rgba(216,166,87,0.32)', borderRadius: R.badge, padding: '2px 6px',
          }}>APPROVE</span>
        ) : running ? <Pulse /> : (
          <span style={{ fontSize: 11, color: C.faint }}>{ago(chat.updated_at)}</span>
        )}
      </div>
    </button>
  );
}

export function Sidebar({ view, onView, selected, onSelect, searchRef }: {
  view: View;
  onView: (v: View) => void;
  selected: string | null;
  onSelect: (hostKey: string, chatId: string) => void;
  searchRef?: React.RefObject<HTMLInputElement>;
}) {
  const { hosts, order, focus, setFocus } = useFleet();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const slot = focus ? hosts[focus] : null;
  const list = useMemo(() => {
    if (!slot) return [] as Section[];
    const q = query.trim().toLocaleLowerCase('tr');
    const chats = q
      ? slot.chats.filter((c) =>
          (c.title || '').toLocaleLowerCase('tr').includes(q) ||
          (c.last_preview || '').toLocaleLowerCase('tr').includes(q) ||
          (c.cwd || '').toLocaleLowerCase('tr').includes(q))
      : slot.chats;
    return sections(chats, slot.groups);
  }, [slot?.chats, slot?.groups, query]);

  const counts: Partial<Record<View, number>> = {
    chats: slot?.chats.filter((c) => !c.archived).length,
    projects: slot?.projects.length,
  };
  const anyAwaiting = order.some((k) => hosts[k]?.chats.some((c) => c.status === 'awaiting_approval'));

  return (
    <div style={{
      width: W, flexShrink: 0, background: C.surface, borderRight: `1px solid ${C.border}`,
      display: 'flex', flexDirection: 'column', height: '100%',
    }}>
      <div style={{ padding: '8px 8px 0' }}>
        <HostCard hosts={hosts} order={order} focus={focus} onFocus={setFocus} />
      </div>

      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map((item) => (
          <NavRow
            key={item.view} item={item} active={view === item.view}
            count={counts[item.view]}
            alert={item.view === 'dashboard' && anyAwaiting}
            onClick={() => onView(item.view)}
          />
        ))}
      </div>

      {view === 'chats' ? (
        <>
          <div style={{ padding: '0 8px 8px' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px',
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
            }}>
              <Icon path={P.search} size={14} color={C.mute} />
              <input
                ref={searchRef} name="chat-search"
                value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats"
                style={{
                  flex: 1, minWidth: 0, background: 'transparent', border: 'none',
                  outline: 'none', fontSize: 13, color: C.text,
                }}
              />
              <span style={{ ...mono, fontSize: 11, color: C.faint }}>⌘F</span>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
            {list.map((s) => {
              const shut = collapsed[s.key];
              return (
                <div key={s.key} style={{ marginBottom: 4 }}>
                  <button
                    type="button"
                    onClick={() => setCollapsed((c) => ({ ...c, [s.key]: !shut }))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, width: '100%', height: 30,
                      padding: '0 4px', background: 'transparent', border: 'none', cursor: 'pointer',
                    }}
                  >
                    <Icon path={shut ? P.chevronRight : P.chevronDown} size={12} color={C.mute} />
                    <span style={{
                      flex: 1, textAlign: 'left', fontSize: 11, fontWeight: 600,
                      letterSpacing: 0.6, textTransform: 'uppercase', color: C.mute,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{s.title}</span>
                    <span style={{ fontSize: 11, color: C.faint }}>{s.chats.length}</span>
                  </button>
                  {!shut && s.chats.map((c) => (
                    <ChatRow
                      key={c.id} chat={c} selected={selected === c.id}
                      onPick={() => focus && onSelect(focus, c.id)}
                    />
                  ))}
                </div>
              );
            })}
            {slot && !list.length && (
              <div style={{ padding: '24px 12px', fontSize: 13, color: C.mute, textAlign: 'center' }}>
                {query ? 'No chat matches' : 'No chats yet'}
              </div>
            )}
          </div>
        </>
      ) : <div style={{ flex: 1 }} />}

      <div style={{ borderTop: `1px solid ${C.border}`, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.mute }}>
          <Dot color={slot?.status === 'online' ? C.ok : C.faint} live={slot?.status === 'online'} size={5} />
          <span style={mono}>daemon {slot?.info?.daemon_version ?? '—'}</span>
          {slot?.info && <span style={mono}>· {uptime(slot.info.uptime_s)}</span>}
        </div>
      </div>
    </div>
  );
}

export { W as SIDEBAR_W };
