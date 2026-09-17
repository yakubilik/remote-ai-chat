import { useEffect, useRef, useState } from 'react';
import { C, R } from '../lib/theme';
import { Icon, P } from '../ui/kit';
import { Modal } from './Modal';
import { Btn } from '../ui/kit';
import type { Chat, Group } from '../lib/protocol';

interface Entry {
  label: string;
  icon: string;
  danger?: boolean;
  /** Entries that swap the menu for a modal of their own must survive the
   *  click — closing here would unmount the modal before it ever painted. */
  keepOpen?: boolean;
  onPick: () => void;
}

function Sheet({ entries, groups, chat, onMove, onClose }: {
  entries: Entry[];
  groups: Group[];
  chat: Chat;
  onMove: (groupId: string | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const row = (label: string, icon: string, onPick: () => void, danger?: boolean, on?: boolean) => (
    <button
      key={label} type="button" onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 34,
        padding: '0 12px', background: 'transparent', border: 'none', cursor: 'pointer',
        textAlign: 'left', color: danger ? C.danger : C.text,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = C.surface3; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <Icon path={icon} size={14} color={danger ? C.danger : C.mute} />
      <span style={{ flex: 1, fontSize: 13 }}>{label}</span>
      {on && <Icon path={P.check} size={13} color={C.ok} />}
    </button>
  );

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', top: 42, right: 12, width: 232, zIndex: 40,
        background: C.surface, border: `1px solid ${C.borderStrong}`, borderRadius: R.card,
        padding: '6px 0', boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
      }}
    >
      {moving ? (
        <>
          <div style={{ fontSize: 11, color: C.mute, padding: '4px 12px 6px' }}>Move to group</div>
          {row('Ungrouped', P.folder, () => { onMove(null); onClose(); }, false, !chat.group_id)}
          {groups.map((g) => row(g.name, P.folder, () => { onMove(g.id); onClose(); }, false, chat.group_id === g.id))}
          <div style={{ height: 1, background: C.border, margin: '6px 0' }} />
          {row('Geri', P.chevronLeft, () => setMoving(false))}
        </>
      ) : (
        <>
          {entries.map((e) => row(e.label, e.icon, () => { e.onPick(); if (!e.keepOpen) onClose(); }, e.danger))}
          <div style={{ height: 1, background: C.border, margin: '6px 0' }} />
          {row('Move to group…', P.folder, () => setMoving(true))}
        </>
      )}
    </div>
  );
}

export function ChatMenu({ chat, groups, onUpdate, onDelete, onClose }: {
  chat: Chat;
  groups: Group[];
  onUpdate: (patch: Record<string, any>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [confirming, setConfirming] = useState(false);

  const entries: Entry[] = [
    { label: 'Rename', icon: P.gear, keepOpen: true, onPick: () => setRenaming(true) },
    {
      label: chat.pinned ? 'Unpin' : 'Pin',
      icon: P.bolt,
      onPick: () => onUpdate({ pinned: chat.pinned ? 0 : 1 }),
    },
    {
      label: chat.archived ? 'Unarchive' : 'Archive',
      icon: P.layout,
      onPick: () => onUpdate({ archived: chat.archived ? 0 : 1 }),
    },
    { label: 'Delete chat', icon: P.x, danger: true, keepOpen: true, onPick: () => setConfirming(true) },
  ];

  if (renaming) {
    return (
      <Modal onClose={onClose} width={440}>
        <form
          onSubmit={(e) => { e.preventDefault(); onUpdate({ title: title.trim() || chat.title }); onClose(); }}
          style={{ padding: 20 }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Rename chat</div>
          <input
            autoFocus name="chat-title"
            value={title} onChange={(e) => setTitle(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', height: 38, padding: '0 12px',
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
              outline: 'none', fontSize: 14, color: C.text, marginBottom: 16,
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn kind="primary" type="submit">Kaydet</Btn>
          </div>
        </form>
      </Modal>
    );
  }

  if (confirming) {
    return (
      <Modal onClose={onClose} width={440}>
        <div style={{ padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Delete chat</div>
          <div style={{ fontSize: 13, color: C.mute, lineHeight: '19px', marginBottom: 16 }}>
            “{chat.title || 'New chat'}” and its whole history are deleted from the computer. This cannot be undone.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn kind="danger" onClick={() => { onDelete(); onClose(); }}>Delete</Btn>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Sheet
      entries={entries} groups={groups} chat={chat}
      onMove={(groupId) => onUpdate({ group_id: groupId })}
      onClose={onClose}
    />
  );
}
