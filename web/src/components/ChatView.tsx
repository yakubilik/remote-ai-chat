import { useEffect, useRef, useState } from 'react';
import { C, R } from '../lib/theme';
import { Chip, Dot, Icon, P, Pulse, Spinner, mono, Empty } from '../ui/kit';
import { Timeline } from './Timeline';
import { ChatMenu } from './ChatMenu';
import { duration, shortPath, toolSummary } from '../lib/format';
import type { Chat, Group } from '../lib/protocol';
import type { ChatLog } from '../lib/timeline';

function Header({ chat, groupName, count, onEdit, onMenu }: {
  chat: Chat; groupName: string | null; count: number;
  onEdit: (f: 'model' | 'effort' | 'perm_mode' | 'cwd') => void;
  onMenu: () => void;
}) {
  const sub = [groupName, chat.cwd.split(/[/\\]/).pop(), `${count} messages`].filter(Boolean).join(' · ');
  const running = chat.status === 'running';
  const awaiting = chat.status === 'awaiting_approval';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
      borderBottom: `1px solid ${C.border}`, flexShrink: 0, position: 'relative',
    }}>
      {/* Basis 0 so a long title claims only the room the chips leave over,
          and a floor of 120 so it never collapses away entirely. */}
      <div style={{ flex: '1 1 0', minWidth: 120 }}>
        <div style={{
          fontSize: 17, fontWeight: 600, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{chat.title || 'New chat'}</div>
        <div style={{
          fontSize: 12, color: C.mute, display: 'flex', alignItems: 'center', gap: 6, marginTop: 2,
        }}>
          <span style={{
            minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{sub}</span>
          {running && <><Pulse /><span style={{ color: C.accent }}>running</span></>}
          {awaiting && <>
            <Icon path={P.warn} size={11} color={C.warn} />
            <span style={{ color: C.warn }}>awaiting approval</span>
          </>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Chip onClick={() => onEdit('model')}>
          <Dot color={C.accent} live /> {chat.model}
        </Chip>
        {chat.effort && (
          <Chip onClick={() => onEdit('effort')}>
            <Icon path={P.bolt} size={12} color={C.mute} /> {chat.effort}
          </Chip>
        )}
        <Chip onClick={() => onEdit('perm_mode')} tone={chat.perm_mode === 'bypass' ? 'warn' : 'plain'}>
          <Icon path={P.shield} size={12} color={chat.perm_mode === 'bypass' ? C.warn : C.mute} />
          {chat.perm_mode}
        </Chip>
        <Chip onClick={() => onEdit('cwd')} title={chat.cwd} shrink>
          <Icon path={P.folder} size={12} color={C.mute} />
          <span style={{
            ...mono, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{shortPath(chat.cwd, 2)}</span>
        </Chip>
        <button
          type="button" onClick={onMenu} title="Chat menu"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, lineHeight: 0 }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill={C.mute}>
            <circle cx="5.5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="18.5" cy="12" r="1.8" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function WorkingStrip({ log, onInterrupt }: { log: ChatLog; onInterrupt: () => void }) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  let started: number | null = null;
  let toolCount = 0;
  let current: string | null = null;
  for (let i = log.items.length - 1; i >= 0; i--) {
    const it = log.items[i];
    if (it.kind === 'tool') {
      toolCount++;
      if (!current && it.running) current = `${it.tool} ${toolSummary(it.tool, it.input)}`.trim();
    }
    if (it.kind === 'turn' || it.kind === 'error') break;
    started = it.ts;
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, margin: '0 20px 8px',
      padding: '0 14px', height: 44, borderRadius: R.card,
      background: C.accentTint, border: `1px solid ${C.accentRing}`,
    }}>
      <Pulse />
      <span style={{ fontSize: 13, fontWeight: 600, color: C.accentSoft }}>Running</span>
      <span style={{ ...mono, fontSize: 12, color: C.mute }}>
        {started ? duration((now - started) * 1000) : '—'}
      </span>
      <span style={{
        ...mono, fontSize: 12, color: C.text2, flex: 1, minWidth: 0,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{current ?? 'thinking…'}</span>
      {toolCount > 0 && (
        <span style={{ ...mono, fontSize: 12, color: C.mute, flexShrink: 0 }}>tool {toolCount}</span>
      )}
      <button
        type="button" onClick={onInterrupt}
        style={{
          height: 28, padding: '0 12px', borderRadius: R.btn, fontSize: 12, fontWeight: 600,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
          border: '1px solid rgba(224,83,63,0.4)', background: 'rgba(224,83,63,0.14)', color: C.danger,
        }}
      >
        <Icon path={P.stop} size={12} color={C.danger} /> Stop
      </button>
    </div>
  );
}

function Composer({ chat, busy, sending, onSend, onInterrupt, onAttach }: {
  chat: Chat; busy: boolean; sending: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onAttach: (files: FileList) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  // Grow with the text, up to a point. Measured from 0 rather than 'auto' so a
  // second pass cannot read back the height the first pass just set.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(36, Math.min(200, el.scrollHeight))}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };

  const folder = chat.cwd.split(/[/\\]/).pop();
  return (
    <div style={{ padding: '8px 20px 16px', flexShrink: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 8, padding: 6,
        borderRadius: R.composer, background: C.surface, border: `1px solid ${C.border}`,
      }}>
        <input
          ref={file} type="file" multiple name="attachments" style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files?.length) onAttach(e.target.files); e.target.value = ''; }}
        />
        <button
          type="button" onClick={() => file.current?.click()} title="Attach a file"
          style={{
            width: 36, height: 36, borderRadius: 18, flexShrink: 0, cursor: 'pointer',
            background: C.surface2, border: `1px solid ${C.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Icon path={P.plus} size={18} color={C.text} />
        </button>
        <textarea
          ref={ref} name="composer" value={text} rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder={busy ? 'You can already type the next message…' : `Message ${folder}…`}
          style={{
            flex: 1, boxSizing: 'border-box', maxHeight: 200, resize: 'none',
            background: 'transparent', border: 'none', outline: 'none',
            fontSize: 15, lineHeight: '22px', padding: '7px 6px', color: C.text,
            overflowY: 'auto',
          }}
        />
        <button
          type="button" onClick={busy ? onInterrupt : submit}
          disabled={!busy && !text.trim()}
          title={busy ? 'Stop' : 'Send'}
          style={{
            width: 36, height: 36, borderRadius: 18, flexShrink: 0,
            cursor: busy || text.trim() ? 'pointer' : 'default',
            background: busy ? C.danger : text.trim() ? C.accent : C.surface2,
            border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: !busy && !text.trim() ? 0.5 : 1,
          }}
        >
          {sending ? <Spinner size={14} color="#FFFFFF" />
            : busy ? <Icon path={P.stop} size={14} color="#FFFFFF" fill />
            : <Icon path={P.send} size={16} color="#FFFFFF" width={2.4} />}
        </button>
      </div>
      <div style={{ ...mono, fontSize: 11, color: C.faint, marginTop: 6, display: 'flex', gap: 16 }}>
        <span>⏎ {busy ? 'queue' : 'send'}</span>
        <span>⇧⏎ newline</span>
        <span>⌘K command palette</span>
      </div>
    </div>
  );
}

export function ChatView({ chat, hostKey, log, groupName, groups, onSend, onInterrupt, onRespond, onEdit, onUpdate, onDelete, onAttach, sending }: {
  chat: Chat | null;
  hostKey: string | null;
  log: ChatLog;
  groupName: string | null;
  groups: Group[];
  sending: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onRespond: (requestId: string, d: 'allow' | 'allow_session' | 'deny') => void;
  onEdit: (f: 'model' | 'effort' | 'perm_mode' | 'cwd') => void;
  onUpdate: (patch: Record<string, any>) => void;
  onDelete: () => void;
  onAttach: (files: FileList) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log.items]);

  if (!chat) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: C.bg }}>
        <Empty
          title="Pick a chat, or open a new one"
          hint="Click a chat in the list, or press ⌘N to start one. The panel is connected to every paired computer at once."
        />
      </div>
    );
  }

  const busy = log.busy || chat.status !== 'idle';
  const msgCount = log.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length;

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <Header chat={chat} groupName={groupName} count={msgCount} onEdit={onEdit} onMenu={() => setMenu(true)} />
        {menu && (
          <ChatMenu
            chat={chat} groups={groups}
            onUpdate={onUpdate} onDelete={onDelete}
            onClose={() => setMenu(false)}
          />
        )}
      </div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}
      >
        {log.loading && !log.items.length && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner /></div>
        )}
        {log.error && (
          <div style={{ fontSize: 13, color: C.danger, padding: 12 }}>{log.error}</div>
        )}
        <Timeline items={log.items} hostKey={hostKey ?? ''} onRespond={onRespond} />
      </div>
      {busy && <WorkingStrip log={log} onInterrupt={onInterrupt} />}
      <Composer
        chat={chat} busy={busy} sending={sending}
        onSend={onSend} onInterrupt={onInterrupt} onAttach={onAttach}
      />
    </div>
  );
}
