import { useEffect, useMemo, useRef, useState } from 'react';
import { C, R } from '../lib/theme';
import { Dot, Icon, P, Pulse, mono } from '../ui/kit';
import { tilde } from '../lib/format';
import { useFleet } from '../lib/fleet';
import { ProviderMark } from './Sidebar';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  danger?: boolean;
  run: () => void;
}

interface Row {
  key: string;
  group: string;
  label: string;
  hint?: string;
  shortcut?: string;
  danger?: boolean;
  mark?: 'chat-claude' | 'chat-codex' | 'folder' | 'command';
  running?: boolean;
  run: () => void;
}

export function Palette({ commands, onOpenChat, onNewChatIn, onClose }: {
  commands: Command[];
  onOpenChat: (hostKey: string, chatId: string) => void;
  onNewChatIn: (cwd: string) => void;
  onClose: () => void;
}) {
  const { hosts, order, focus } = useFleet();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    const hit = (s: string) => !q || s.toLocaleLowerCase('tr').includes(q);
    const out: Row[] = [];

    for (const key of order) {
      const slot = hosts[key];
      if (!slot) continue;
      const many = order.length > 1;
      for (const c of slot.chats) {
        if (c.archived) continue;
        if (!hit(c.title) && !hit(c.cwd)) continue;
        out.push({
          key: `chat:${key}:${c.id}`,
          group: 'Chats',
          label: c.title || 'New chat',
          hint: [many ? (slot.info?.name ?? slot.cfg.name) : null, c.cwd.split(/[/\\]/).pop()].filter(Boolean).join(' · '),
          mark: c.provider === 'claude' ? 'chat-claude' : 'chat-codex',
          running: c.status !== 'idle',
          run: () => { onOpenChat(key, c.id); onClose(); },
        });
        if (out.length > 40) break;
      }
    }

    const slot = focus ? hosts[focus] : null;
    for (const p of slot?.projects ?? []) {
      if (!hit(p.name) && !hit(p.path)) continue;
      out.push({
        key: `proj:${p.path}`,
        group: 'Projects',
        label: tilde(p.path),
        hint: 'new chat here',
        mark: 'folder',
        run: () => { onNewChatIn(p.path); onClose(); },
      });
    }

    for (const c of commands) {
      if (!hit(c.label)) continue;
      out.push({
        key: `cmd:${c.id}`, group: 'Komutlar', label: c.label, hint: c.hint,
        shortcut: c.shortcut, danger: c.danger, mark: 'command',
        run: () => { c.run(); onClose(); },
      });
    }
    return out;
  }, [query, hosts, order, focus, commands, onOpenChat, onNewChatIn, onClose]);

  useEffect(() => { setCursor(0); }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); rows[cursor]?.run(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';
  const focused = focus ? hosts[focus] : null;

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(6,6,5,0.62)', zIndex: 60,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 110,
      }}
    >
      <div style={{
        width: 640, maxWidth: 'calc(100vw - 48px)', background: C.surface,
        border: `1px solid ${C.borderStrong}`, borderRadius: R.media,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 52,
          borderBottom: `1px solid ${C.border}`,
        }}>
          <Icon path={P.search} size={16} color={C.mute} />
          <input
            autoFocus name="palette-query"
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
            placeholder="folder, chat, command…"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 16, color: C.text,
            }}
          />
          <span style={{
            ...mono, fontSize: 11, color: C.faint, border: `1px solid ${C.border}`,
            borderRadius: R.badge, padding: '2px 6px',
          }}>esc</span>
        </div>

        <div ref={listRef} style={{ maxHeight: 420, overflowY: 'auto', padding: '8px 0' }}>
          {rows.map((r, i) => {
            const head = r.group !== lastGroup ? (lastGroup = r.group) : null;
            const on = i === cursor;
            return (
              <div key={r.key}>
                {head && (
                  <div style={{
                    fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase',
                    color: C.mute, padding: '10px 16px 6px',
                  }}>{head}</div>
                )}
                <button
                  type="button" data-i={i}
                  onMouseEnter={() => setCursor(i)}
                  onClick={r.run}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 40,
                    padding: '0 16px', cursor: 'pointer', textAlign: 'left', border: 'none',
                    background: on ? C.accentTint : 'transparent',
                    borderLeft: `2px solid ${on ? C.accent : 'transparent'}`,
                  }}
                >
                  {r.mark === 'chat-claude' || r.mark === 'chat-codex'
                    ? <div style={{ transform: 'scale(0.8)', marginLeft: -3 }}>
                        <ProviderMark provider={r.mark === 'chat-claude' ? 'claude' : 'codex'} />
                      </div>
                    : <Icon
                        path={r.mark === 'folder' ? P.folder : r.danger ? P.stop : P.bolt}
                        size={15} color={r.danger ? C.danger : C.mute}
                      />}
                  <span style={{
                    flex: 1, fontSize: 14, minWidth: 0, whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    color: r.danger ? C.danger : C.text,
                    ...(r.mark === 'folder' ? mono : {}),
                  }}>{r.label}</span>
                  {r.running && <Pulse />}
                  {r.hint && (
                    <span style={{
                      fontSize: 12, color: C.faint, flexShrink: 0, maxWidth: 220,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{r.hint}</span>
                  )}
                  {r.shortcut && (
                    <span style={{
                      ...mono, fontSize: 11, color: C.faint, border: `1px solid ${C.border}`,
                      borderRadius: R.badge, padding: '2px 6px', flexShrink: 0,
                    }}>{r.shortcut}</span>
                  )}
                </button>
              </div>
            );
          })}
          {!rows.length && (
            <div style={{ padding: 32, textAlign: 'center', fontSize: 13, color: C.mute }}>
              Nothing matches
            </div>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px', height: 36,
          borderTop: `1px solid ${C.border}`, ...mono, fontSize: 11, color: C.faint,
        }}>
          <span>↑↓ gez</span>
          <span>⏎ open</span>
          <span>⌘K kapat</span>
          <span style={{ flex: 1 }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Dot color={focused?.status === 'online' ? C.ok : C.faint} live={focused?.status === 'online'} size={5} />
            {focused ? `${focused.info?.name ?? focused.cfg.name} ${focused.status === 'online' ? 'online' : 'offline'}` : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}
