import { useEffect, useMemo, useState } from 'react';
import { C, R } from '../lib/theme';
import { Btn, Dot, Icon, Label, P, Segment, mono } from '../ui/kit';
import { Modal, ModalHead } from './Modal';
import { ProviderMark } from './Sidebar';
import { tilde } from '../lib/format';
import { useFleet } from '../lib/fleet';
import { createChat } from '../lib/actions';
import type { Chat, Provider } from '../lib/protocol';

export function NewChat({ hostKey, initialCwd, onDone, onClose }: {
  hostKey: string;
  initialCwd?: string;
  onDone: (chat: Chat) => void;
  onClose: () => void;
}) {
  const slot = useFleet((s) => s.hosts[hostKey]);
  const catalog = slot?.catalog ?? null;

  const [provider, setProvider] = useState<Provider>('claude');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [perm, setPerm] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(initialCwd ?? null);
  const [query, setQuery] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [maxTurns, setMaxTurns] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pc = catalog?.[provider] ?? null;

  // Every provider brings its own models, efforts and permission words, so the
  // choices below reset when the provider does rather than carrying over
  // something the other side has never heard of. A choice the new catalog still
  // knows is kept: a reconnect hands us a fresh catalog object mid-dialog, and
  // that must not quietly put the model back to the default under the user.
  useEffect(() => {
    const fallbackEffort = pc?.efforts?.length ? pc.efforts[Math.min(2, pc.efforts.length - 1)] : null;
    setModel((m) => (m && pc?.models.some((x) => x.id === m) ? m : pc?.models[0]?.id ?? null));
    setEffort((e) => (e && pc?.efforts?.includes(e) ? e : fallbackEffort));
    setPerm((p) => (p && pc?.perm_modes.includes(p) ? p : pc?.perm_modes[0] ?? null));
  }, [provider, catalog]);

  const projects = slot?.projects ?? [];
  const recent = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of slot?.chats ?? []) {
      if (c.cwd) seen.set(c.cwd, Math.max(seen.get(c.cwd) ?? 0, c.updated_at));
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p]) => p);
  }, [slot?.chats]);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    if (!q) return projects.filter((p) => !recent.includes(p.path));
    return projects.filter((p) =>
      p.name.toLocaleLowerCase('tr').includes(q) || p.path.toLocaleLowerCase('tr').includes(q));
  }, [projects, query, recent]);

  const start = async () => {
    if (!model || busy) return;
    setBusy(true);
    setError(null);
    try {
      const chat = await createChat(hostKey, {
        provider, model, effort, perm_mode: perm ?? undefined,
        cwd: cwd ?? undefined,
        max_turns: maxTurns ? Number(maxTurns) : null,
        max_budget_usd: budget ? Number(budget) : null,
      });
      onDone(chat);
    } catch (e: any) {
      setError(e?.message ?? 'Could not open the chat');
      setBusy(false);
    }
  };

  const folderRow = (path: string, name: string, isGit: boolean) => (
    <button
      key={path} type="button" onClick={() => setCwd(path)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 40,
        padding: '0 12px', borderRadius: R.btn, cursor: 'pointer', textAlign: 'left',
        background: cwd === path ? C.accentTint : 'transparent',
        border: `1px solid ${cwd === path ? C.accentRing : 'transparent'}`,
      }}
    >
      <Icon path={P.folder} size={14} color={cwd === path ? C.accentSoft : C.mute} />
      <span style={{
        ...mono, flex: 1, fontSize: 13, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{tilde(path)}</span>
      {isGit && <Icon path={P.branch} size={12} color={C.faint} />}
      <span style={{ fontSize: 12, color: C.faint }}>{name}</span>
      {cwd === path && <Icon path={P.check} size={14} color={C.ok} />}
    </button>
  );

  return (
    <Modal onClose={onClose} width={680}>
      <ModalHead
        title="New chat"
        subtitle={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Dot color={slot?.status === 'online' ? C.ok : C.faint} live={slot?.status === 'online'} size={5} />
          {(slot?.info?.name ?? slot?.cfg.name ?? '—')} will open on it
        </span>}
        onClose={onClose}
      />

      <div style={{ overflowY: 'auto', padding: 20 }}>
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          {(['claude', 'codex'] as Provider[]).map((p) => {
            const on = provider === p;
            const version = slot?.info?.versions?.[p];
            return (
              <button
                key={p} type="button" onClick={() => setProvider(p)}
                disabled={!catalog?.[p]}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                  borderRadius: R.card, cursor: catalog?.[p] ? 'pointer' : 'default',
                  opacity: catalog?.[p] ? 1 : 0.5, textAlign: 'left',
                  background: on ? C.accentTint : C.bg,
                  border: `1px solid ${on ? C.accentRing : C.border}`,
                }}
              >
                <ProviderMark provider={p} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 600, textTransform: 'capitalize' }}>{p}</span>
                  <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 2 }}>
                    {version ? `${p === 'claude' ? 'Claude Code' : 'codex app-server'} ${version}` : 'not installed'}
                  </span>
                </span>
                {on && <Icon path={P.check} size={16} color={C.ok} />}
              </button>
            );
          })}
        </div>

        <Label>Model</Label>
        <div style={{
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.card,
          overflow: 'hidden', marginBottom: 20,
        }}>
          {(pc?.models ?? []).map((m, i, arr) => (
            <button
              key={m.id} type="button" onClick={() => setModel(m.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 48,
                padding: '8px 12px', cursor: 'pointer', textAlign: 'left',
                background: model === m.id ? C.accentTint : 'transparent',
                border: 'none', borderBottom: i === arr.length - 1 ? 'none' : `1px solid ${C.border}`,
              }}
            >
              <span style={{
                width: 15, height: 15, borderRadius: 8, flexShrink: 0,
                border: `1.5px solid ${model === m.id ? C.accent : C.faint}`,
                background: model === m.id ? C.accent : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {model === m.id && <span style={{ width: 5, height: 5, borderRadius: 3, background: '#FFF' }} />}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{m.label || m.id}</span>
                {m.hint && <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 2 }}>{m.hint}</span>}
              </span>
              <span style={{ ...mono, fontSize: 12, color: C.faint, flexShrink: 0 }}>{m.id}</span>
            </button>
          ))}
          {!pc?.models.length && (
            <div style={{ padding: 16, fontSize: 13, color: C.mute }}>
              Could not fetch the model list — the computer may be offline
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <Label>Effort</Label>
            {pc?.efforts?.length
              ? <Segment value={effort} options={pc.efforts} onChange={setEffort} />
              : <div style={{ fontSize: 13, color: C.mute }}>this tool has no effort setting</div>}
          </div>
          <div style={{ flex: 1 }}>
            <Label>Permission mode</Label>
            <Segment
              value={perm} options={pc?.perm_modes ?? []} onChange={setPerm}
              tone={(v) => (v === 'bypass' ? 'warn' : 'plain')}
            />
          </div>
        </div>

        {perm === 'bypass' && (
          <div style={{
            display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px',
            borderRadius: R.btn, background: 'rgba(216,166,87,0.10)',
            border: '1px solid rgba(216,166,87,0.32)', marginBottom: 20,
          }}>
            <Icon path={P.warn} size={14} color={C.warn} />
            <span style={{ fontSize: 12, lineHeight: '18px', color: C.warn }}>
              bypass skips the permission questions. The dangerous-command list still asks, even here.
            </span>
          </div>
        )}

        <Label>Project folder</Label>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px',
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input, marginBottom: 8,
        }}>
          <Icon path={P.search} size={14} color={C.mute} />
          <input
            name="new-chat-folder"
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search folders…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13, color: C.text }}
          />
          <span style={{ fontSize: 11, color: C.faint }}>
            {query ? filtered.length : projects.length} folders
          </span>
        </div>
        <div style={{ maxHeight: 176, overflowY: 'auto', marginBottom: 16 }}>
          {!query && recent.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: C.mute, padding: '4px 12px' }}>Recent</div>
              {recent.map((p) => folderRow(p, p.split(/[/\\]/).pop() ?? '', false))}
              <div style={{ height: 8 }} />
            </>
          )}
          {filtered.map((p) => folderRow(p.path, p.name, p.is_git))}
          {!projects.length && (
            <div style={{ padding: 12, fontSize: 13, color: C.mute }}>The folder list is empty</div>
          )}
        </div>

        <button
          type="button" onClick={() => setAdvanced((a) => !a)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, background: 'transparent',
            border: 'none', cursor: 'pointer', padding: '4px 0', marginBottom: advanced ? 8 : 0,
          }}
        >
          <Icon path={advanced ? P.chevronDown : P.chevronRight} size={13} color={C.mute} />
          <span style={{ fontSize: 13, color: C.text2 }}>Advanced</span>
          <span style={{ fontSize: 12, color: C.faint, marginLeft: 8 }}>caps are per chat</span>
        </button>
        {advanced && (
          <div style={{ display: 'flex', gap: 12 }}>
            {[
              { label: 'max_turns', value: maxTurns, set: setMaxTurns, ph: 'unlimited' },
              { label: 'max_budget_usd', value: budget, set: setBudget, ph: 'unlimited' },
            ].map((f) => (
              <div key={f.label} style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px',
                background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
              }}>
                <span style={{ ...mono, fontSize: 13, color: C.mute, flex: 1 }}>{f.label}</span>
                <input
                  name={f.label}
                  value={f.value} onChange={(e) => f.set(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder={f.ph} inputMode="decimal"
                  style={{
                    ...mono, width: 78, textAlign: 'right', background: 'transparent',
                    border: 'none', outline: 'none', fontSize: 13, color: C.text,
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px',
        borderTop: `1px solid ${C.border}`, flexShrink: 0,
      }}>
        <span style={{
          ...mono, fontSize: 12, color: error ? C.danger : C.mute, flex: 1, minWidth: 0,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {error ?? [provider, model, effort, perm, cwd ? tilde(cwd) : null].filter(Boolean).join(' · ')}
        </span>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" onClick={start} disabled={!model || busy}>
          {busy ? 'Opening…' : 'Start chat'}
        </Btn>
      </div>
    </Modal>
  );
}
