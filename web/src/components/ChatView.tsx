import { useEffect, useRef, useState } from 'react';
import { C, R } from '../lib/theme';
import { Chip, Dot, Icon, P, Pulse, Spinner, mono, Empty } from '../ui/kit';
import { Timeline } from './Timeline';
import { ChatMenu } from './ChatMenu';
import { duration, shortPath, toolSummary } from '../lib/format';
import { fileUrl } from '../lib/actions';
import type { Field } from './FieldSheet';
import type { Chat, Group } from '../lib/protocol';
import type { ChatLog } from '../lib/timeline';

function Header({ chat, groupName, count, accountLabel, onEdit, onMenu }: {
  chat: Chat; groupName: string | null; count: number; accountLabel: string | null;
  onEdit: (f: Field) => void;
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
        {/* Which sign-in is being spent, and the way to another one: this is
            where a person looks when a plan's limit has run out mid-chat. */}
        <Chip onClick={() => onEdit('account_id')} title="Account running this chat" shrink>
          <Icon path={P.agent} size={12} color={C.mute} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {accountLabel ?? 'account'}
          </span>
        </Chip>
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

/** What is attached but not sent yet. A picture is shown as the picture, at the
 *  size a thumbnail wants to be — a file name is not a preview, and the whole
 *  point of attaching a screenshot is to see that it is the right one. */
function Tray({ items, hostKey, busy, onRemove }: {
  items: any[]; hostKey: string; busy: boolean; onRemove: (path: string) => void;
}) {
  const src = (a: any) => {
    try { return fileUrl(hostKey, a.view || a.path); } catch { return ''; }
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
      {items.map((a) => (
        <div key={a.path} style={{ position: 'relative' }}>
          {a.kind === 'image' ? (
            <img
              src={src(a)} alt=""
              style={{
                width: 56, height: 56, objectFit: 'cover', display: 'block',
                borderRadius: R.btn, border: `1px solid ${C.border}`, background: C.bg,
              }}
            />
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 10px',
              borderRadius: R.btn, background: C.surface2, border: `1px solid ${C.border}`,
              maxWidth: 200,
            }}>
              <Icon path={a.kind === 'audio' ? P.mic : P.copy} size={13} color={C.mute} />
              <span style={{
                ...mono, fontSize: 12, color: C.text2, minWidth: 0,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{a.name}</span>
            </div>
          )}
          <button
            type="button" onClick={() => onRemove(a.path)} title="Remove"
            style={{
              position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              background: C.surface, border: `1px solid ${C.border}`, padding: 0,
            }}
          >
            <Icon path={P.x} size={10} color={C.text2} />
          </button>
        </div>
      ))}
      {busy && <Spinner size={14} />}
    </div>
  );
}

function Composer({ chat, hostKey, busy, sending, onSend, onInterrupt, onUpload }: {
  chat: Chat; hostKey: string; busy: boolean; sending: boolean;
  onSend: (text: string, attachments: any[]) => void;
  onInterrupt: () => void;
  onUpload: (file: File) => Promise<any>;
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  // Attaching is an upload now and a send later, so the pictures can be looked
  // at — and a caption typed — before the agent is handed them.
  const addFiles = async (files: FileList) => {
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        const a = await onUpload(f);
        setPending((p) => [...p, a]);
      }
    } catch (e: any) { setError(e?.message ?? 'Upload failed'); }
    finally { setUploading(false); }
  };

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
    if (!t && !pending.length) return;
    // A voice note carries its own words; anything else gets a line that says
    // why it is there, because a message with no text at all reads as a glitch.
    const caption = t
      || pending.map((a) => a.transcript).filter(Boolean).join('\n')
      || 'Have a look at this.';
    onSend(caption, pending);
    setText('');
    setPending([]);
  };

  const folder = chat.cwd.split(/[/\\]/).pop();
  const ready = !!text.trim() || pending.length > 0;
  return (
    <div style={{ padding: '8px 20px 16px', flexShrink: 0 }}>
      {(pending.length > 0 || uploading) && (
        <Tray
          items={pending} hostKey={hostKey} busy={uploading}
          onRemove={(p) => setPending((list) => list.filter((a) => a.path !== p))}
        />
      )}
      {error && (
        <div style={{ fontSize: 12, color: C.danger, marginBottom: 6 }}>{error}</div>
      )}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 8, padding: 6,
        borderRadius: R.composer, background: C.surface, border: `1px solid ${C.border}`,
      }}>
        <input
          ref={file} type="file" multiple name="attachments" style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }}
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
          type="button" onClick={busy && !ready ? onInterrupt : submit}
          disabled={!busy && !ready}
          title={busy && !ready ? 'Stop' : 'Send'}
          style={{
            width: 36, height: 36, borderRadius: 18, flexShrink: 0,
            cursor: busy || ready ? 'pointer' : 'default',
            background: busy && !ready ? C.danger : ready ? C.accent : C.surface2,
            border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: !busy && !ready ? 0.5 : 1,
          }}
        >
          {sending ? <Spinner size={14} color="#FFFFFF" />
            : busy && !ready ? <Icon path={P.stop} size={14} color="#FFFFFF" fill />
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

export function ChatView({ chat, hostKey, log, groupName, groups, accountLabel, onSend, onInterrupt, onRespond, onEdit, onUpdate, onDelete, onUpload, sending }: {
  chat: Chat | null;
  hostKey: string | null;
  log: ChatLog;
  groupName: string | null;
  groups: Group[];
  accountLabel: string | null;
  sending: boolean;
  onSend: (text: string, attachments: any[]) => void;
  onInterrupt: () => void;
  onRespond: (requestId: string, d: 'allow' | 'allow_session' | 'deny') => void;
  onEdit: (f: Field) => void;
  onUpdate: (patch: Record<string, any>) => void;
  onDelete: () => void;
  onUpload: (file: File) => Promise<any>;
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
        <Header
          chat={chat} groupName={groupName} count={msgCount} accountLabel={accountLabel}
          onEdit={onEdit} onMenu={() => setMenu(true)}
        />
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
        chat={chat} hostKey={hostKey ?? ''} busy={busy} sending={sending}
        onSend={onSend} onInterrupt={onInterrupt} onUpload={onUpload}
      />
    </div>
  );
}
