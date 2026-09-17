import { useMemo, useState } from 'react';
import { C, R } from '../lib/theme';
import { Icon, P, mono, Label } from '../ui/kit';
import { Modal, ModalHead } from './Modal';
import { tilde } from '../lib/format';
import type { Catalog, Chat, Project } from '../lib/protocol';

export type Field = 'model' | 'effort' | 'perm_mode' | 'cwd';

const TITLE: Record<Field, string> = {
  model: 'Model', effort: 'Effort', perm_mode: 'Permission mode', cwd: 'Project folder',
};

function Option({ label, hint, right, on, onPick }: {
  label: string; hint?: string; right?: string; on: boolean; onPick: () => void;
}) {
  return (
    <button
      type="button" onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 48,
        padding: '8px 12px', cursor: 'pointer', textAlign: 'left',
        background: on ? C.accentTint : 'transparent',
        border: 'none', borderBottom: `1px solid ${C.border}`,
      }}
    >
      <span style={{
        width: 15, height: 15, borderRadius: 8, flexShrink: 0,
        border: `1.5px solid ${on ? C.accent : C.faint}`,
        background: on ? C.accent : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {on && <span style={{ width: 5, height: 5, borderRadius: 3, background: '#FFF' }} />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{label}</span>
        {hint && <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 2 }}>{hint}</span>}
      </span>
      {right && (
        <span style={{
          ...mono, fontSize: 12, color: C.faint, flexShrink: 0, maxWidth: 220,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{right}</span>
      )}
    </button>
  );
}

export function FieldSheet({ field, chat, catalog, projects, onPick, onClose }: {
  field: Field;
  chat: Chat;
  catalog: Catalog | null;
  projects: Project[];
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const pc = catalog?.[chat.provider] ?? null;

  const rows = useMemo(() => {
    if (field === 'model') {
      return (pc?.models ?? []).map((m) => ({ value: m.id, label: m.label || m.id, hint: m.hint, right: m.id }));
    }
    if (field === 'effort') {
      return (pc?.efforts ?? []).map((e) => ({ value: e, label: e, hint: undefined, right: undefined }));
    }
    if (field === 'perm_mode') {
      return (pc?.perm_modes ?? []).map((m) => ({
        value: m, label: m,
        hint: m === 'bypass' ? 'Skips the permission questions. The dangerous-command list still asks.' : undefined,
        right: undefined,
      }));
    }
    const q = query.trim().toLocaleLowerCase('tr');
    return projects
      .filter((p) => !q || p.name.toLocaleLowerCase('tr').includes(q) || p.path.toLocaleLowerCase('tr').includes(q))
      .map((p) => ({ value: p.path, label: p.name, hint: undefined, right: tilde(p.path) }));
  }, [field, pc, projects, query]);

  const current = field === 'cwd' ? chat.cwd
    : field === 'model' ? chat.model
    : field === 'effort' ? (chat.effort ?? '')
    : chat.perm_mode;

  return (
    <Modal onClose={onClose} width={560}>
      <ModalHead
        title={TITLE[field]}
        subtitle={<span>{chat.title || 'New chat'} · applies immediately</span>}
        onClose={onClose}
      />
      {field === 'cwd' && (
        <div style={{ padding: 12, borderBottom: `1px solid ${C.border}` }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px',
            background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
          }}>
            <Icon path={P.search} size={14} color={C.mute} />
            <input
              autoFocus name="folder-search"
              value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="search folders…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13, color: C.text }}
            />
            <span style={{ fontSize: 11, color: C.faint }}>{rows.length} folders</span>
          </div>
        </div>
      )}
      <div style={{ overflowY: 'auto' }}>
        {rows.map((r) => (
          <Option
            key={r.value} label={r.label} hint={r.hint} right={r.right}
            on={r.value === current} onPick={() => { onPick(r.value); onClose(); }}
          />
        ))}
        {!rows.length && (
          <div style={{ padding: 24, fontSize: 13, color: C.mute, textAlign: 'center' }}>
            Nothing to choose — the computer may be offline
          </div>
        )}
      </div>
      {field === 'cwd' && (
        <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.border}` }}>
          <Label>only folders under the allowed roots can be opened</Label>
        </div>
      )}
    </Modal>
  );
}
