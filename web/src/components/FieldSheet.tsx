import { useMemo, useState } from 'react';
import { C, R } from '../lib/theme';
import { Icon, P, Radio, Label } from '../ui/kit';
import { Modal, ModalHead } from './Modal';
import { tilde } from '../lib/format';
import type { Catalog, Chat, CliAccount, LimitWindow, Project } from '../lib/protocol';

export type Field = 'model' | 'effort' | 'perm_mode' | 'cwd' | 'account_id';

const TITLE: Record<Field, string> = {
  model: 'Model', effort: 'Effort', perm_mode: 'Permission mode', cwd: 'Project folder',
  account_id: 'Account',
};

/** The daemon labels the machine's own sign-in in its own words; everything
 *  else is the label it was paired under. */
export function accountName(a: CliAccount): string {
  return a.is_default ? "This computer's account" : a.label;
}

/** The fullest window the account last reported — what "limit reached" means
 *  in a number, next to the account it belongs to. */
function usage(windows: LimitWindow[] | undefined): string | undefined {
  const top = (windows ?? [])
    .filter((w) => typeof w.utilization === 'number')
    .sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0];
  return top ? `${Math.round((top.utilization ?? 0) * 100)}% used` : undefined;
}

export function FieldSheet({ field, chat, catalog, projects, accounts, limits, busy, onPick, onClose }: {
  field: Field;
  chat: Chat;
  catalog: Catalog | null;
  projects: Project[];
  accounts: CliAccount[];
  limits: Record<string, LimitWindow[]>;
  /** A turn is running; moving the chat now would cut it off. */
  busy: boolean;
  onPick: (value: string | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const pc = catalog?.[chat.provider] ?? null;

  const rows = useMemo(() => {
    if (field === 'account_id') {
      return accounts
        .filter((a) => a.provider === chat.provider && (a.logged_in || a.is_default))
        .map((a) => ({
          // The default account is "no account id", not an id of its own.
          value: a.is_default ? '' : a.id,
          label: accountName(a),
          hint: a.logged_in ? a.detail : 'not signed in',
          right: usage(limits[a.is_default ? `default-${chat.provider}` : a.id]),
        }));
    }
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
  }, [field, pc, projects, accounts, limits, chat.provider, query]);

  const current = field === 'cwd' ? chat.cwd
    : field === 'model' ? chat.model
    : field === 'effort' ? (chat.effort ?? '')
    : field === 'account_id' ? (chat.account_id ?? '')
    : chat.perm_mode;

  // Moving a chat to another account starts a new thread there: a resume id
  // belongs to one account's transcript store, and the daemon drops it on the
  // way over. That is a whole conversation's memory, so it is said first.
  const pick = (value: string) => {
    if (field !== 'account_id') { onPick(value); onClose(); return; }
    if (value === current) { onClose(); return; }
    if (busy) {
      window.alert('A turn is running. Stop it first, then move the chat.');
      return;
    }
    const ok = window.confirm(
      'Carry on in this account?\n\nThe agent starts a fresh session there: '
      + 'this chat stays, but what was said is handed over as a recap rather than remembered.',
    );
    if (!ok) return;
    onPick(value || null);
    onClose();
  };

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
          <Radio
            key={r.value} label={r.label} hint={r.hint} right={r.right}
            on={r.value === current} onPick={() => pick(r.value)}
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
      {field === 'account_id' && (
        <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.border}` }}>
          <Label>another sign-in is added under Settings › Accounts</Label>
        </div>
      )}
    </Modal>
  );
}
