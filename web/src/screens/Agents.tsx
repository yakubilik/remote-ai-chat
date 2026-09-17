// TODO(daemon): the artboard also draws things the protocol does not carry, so
// they are not on this screen:
//  - per-agent on/off toggle (no agent.enable / agent.disable request)
//  - the tool list an agent may use (Agent has no `tools` field)
//  - a system-prompt preview and an "Edit" editor (no agent.read / agent.write)
//  - "Write an agent" and "Import from file" (no agent.create request)
//  - per-agent last-used time and project (agent.list returns no usage)
//  - Skills / Commands / Plugins tabs — skills exist only as a count
//    on a store bundle, and commands/plugins are not in the protocol at all.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { C, R } from '../lib/theme';
import { Btn, Dot, Empty, Icon, Label, P, Segment, Spinner, mono } from '../ui/kit';
import { Modal, ModalHead } from '../components/Modal';
import { useFleet } from '../lib/fleet';
import { agentStore, installAgent, listAgents, removeAgent } from '../lib/actions';
import { errText } from '../lib/i18n';
import { shortPath, tilde } from '../lib/format';
import type { Agent, CliAccount, StoreItem, StoreSource } from '../lib/protocol';

const STORE_W = 380;

/** The computer's own account has no id: agent.list falls back to it, but
 *  agent.install refuses it (needs_own_account), which is why it is offered
 *  for reading and left to fail loudly for writing. */
const OWN = '__own__';

const SCOPE_LABEL: Record<Agent['scope'], string> = {
  project: 'project', user: 'account', builtin: 'built-in',
};

const FILTERS = ['all', 'project', 'account', 'built-in'] as const;
type Filter = typeof FILTERS[number];

function err(e: any): string {
  return errText(e?.code, e?.message);
}

/** A destructive step never happens on the click that asked for it. */
function Confirm({ title, body, action, onConfirm, onClose }: {
  title: string; body: string; action: string; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} width={440}>
      <ModalHead title={title} onClose={onClose} />
      <div style={{ padding: '16px 20px', fontSize: 13, color: C.text2, lineHeight: '19px' }}>{body}</div>
      <div style={{
        display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px',
        borderTop: `1px solid ${C.border}`,
      }}>
        <Btn kind="quiet" onClick={onClose}>Cancel</Btn>
        <Btn kind="danger" onClick={() => { onConfirm(); onClose(); }}>{action}</Btn>
      </div>
    </Modal>
  );
}

/** The glyph tile is deliberately not painted in the agent's own colour: the
 *  panel's palette is the one in theme.ts and nothing else. */
function Glyph({ glyph, size = 30 }: { glyph: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: R.btn, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: C.surface2, border: `1px solid ${C.border}`,
      fontSize: size * 0.46, lineHeight: 1,
    }}>
      {glyph || '·'}
    </div>
  );
}

function Badge({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'accent' }) {
  return (
    <span style={{
      ...mono, fontSize: 10, fontWeight: 600, letterSpacing: 0.4, padding: '2px 6px',
      borderRadius: R.badge, whiteSpace: 'nowrap',
      color: tone === 'accent' ? C.accentSoft : C.mute,
      background: tone === 'accent' ? C.accentTint : C.surface2,
      border: `1px solid ${tone === 'accent' ? C.accentRing : C.border}`,
    }}>{children}</span>
  );
}

function AgentCard({ agent, busy, onRemove }: {
  agent: Agent; busy: boolean; onRemove: (() => void) | null;
}) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.card,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Glyph glyph={agent.glyph} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 14, fontWeight: 600, color: C.text,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{agent.label || agent.name}</div>
          <div style={{
            ...mono, fontSize: 11, color: C.faint, marginTop: 2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{agent.name}</div>
        </div>
        <Badge>{SCOPE_LABEL[agent.scope]}</Badge>
      </div>

      {agent.description && (
        <div style={{
          fontSize: 12.5, color: C.text2, lineHeight: '18px',
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>{agent.description}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {agent.model && <Badge>{agent.model}</Badge>}
        {agent.family && <Badge>{agent.family}</Badge>}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto',
        paddingTop: 8, borderTop: `1px solid ${C.hair}`,
      }}>
        <span title={tilde(agent.path)} style={{
          ...mono, flex: 1, minWidth: 0, fontSize: 11, color: C.faint,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{shortPath(agent.path, 3)}</span>
        {onRemove && (
          busy ? <Spinner size={13} /> : (
            <button
              type="button" onClick={onRemove} title="Remove this agent"
              style={{
                height: 26, padding: '0 10px', borderRadius: R.btn, cursor: 'pointer',
                fontSize: 12, fontWeight: 600, flexShrink: 0,
                background: 'transparent', border: `1px solid ${C.border}`, color: C.mute,
              }}
            >Remove</button>
          )
        )}
      </div>
    </div>
  );
}

function StoreRow({ source, open, onToggle, busyId, installed, onInstall }: {
  source: StoreSource;
  open: boolean;
  onToggle: () => void;
  busyId: string | null;
  installed: Set<string>;
  onInstall: (item: StoreItem) => void;
}) {
  const owner = source.repo.split('/')[0] || source.repo;
  const skills = source.items.reduce((n, i) => n + (i.skills ?? 0), 0);
  const meta = [owner, `${source.items.length} agents`, skills ? `${skills} skills` : null]
    .filter(Boolean).join(' · ');

  return (
    <div style={{
      background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.card,
      marginBottom: 8, overflow: 'hidden',
    }}>
      <button
        type="button" onClick={onToggle} disabled={!source.items.length}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', padding: '10px 12px',
          background: 'transparent', border: 'none', textAlign: 'left',
          cursor: source.items.length ? 'pointer' : 'default',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, color: C.text,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{source.label}</div>
          <div style={{ ...mono, fontSize: 11, color: C.faint, marginTop: 3 }}>{meta}</div>
          {source.note && (
            <div style={{ fontSize: 12, color: C.mute, marginTop: 4, lineHeight: '17px' }}>{source.note}</div>
          )}
        </div>
        {!!source.items.length && (
          <Icon path={open ? P.chevronDown : P.chevronRight} size={13} color={C.faint} />
        )}
      </button>

      {source.error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px',
          borderTop: `1px solid ${C.hair}`, fontSize: 12, color: C.mute,
        }}>
          <Dot color={C.faint} size={5} />
          <span>Could not read this collection — {source.error}</span>
        </div>
      )}

      {open && source.items.map((item) => {
        const on = installed.has(item.label.toLocaleLowerCase('tr').replace(/[^a-z0-9]/g, ''));
        return (
          <div
            key={item.id}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
              borderTop: `1px solid ${C.hair}`,
            }}
          >
            <Glyph glyph={item.glyph} size={24} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, color: C.text2,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{item.label}</div>
              {item.about && (
                <div style={{ fontSize: 12, color: C.mute, marginTop: 3, lineHeight: '17px' }}>{item.about}</div>
              )}
              {!!item.skills && (
                <div style={{ ...mono, fontSize: 11, color: C.faint, marginTop: 4 }}>{item.skills} beceri</div>
              )}
            </div>
            {busyId === item.id ? <Spinner size={13} />
              : on ? <Badge tone="accent">kurulu</Badge>
              : <Btn kind="primary" onClick={() => onInstall(item)}>Kur</Btn>}
          </div>
        );
      })}
    </div>
  );
}

export function Agents() {
  const { hosts, focus, refreshAccounts } = useFleet();
  const slot = focus ? hosts[focus] : null;
  const online = slot?.status === 'online';

  const [accountId, setAccountId] = useState<string>(OWN);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [sources, setSources] = useState<StoreSource[]>([]);
  const [loadingStore, setLoadingStore] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [openSource, setOpenSource] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<Agent | null>(null);

  // Agents live in one account's folder, so an account has to be chosen before
  // the list means anything. account.list is the slow call, hence its own read.
  useEffect(() => {
    if (focus && online) refreshAccounts(focus).catch(() => {});
  }, [focus, online]);

  // account.list returns the computer's own account as a row of its own, and
  // OWN already stands for it — listing both would offer the same folder twice.
  const claudeAccounts: CliAccount[] = useMemo(
    () => (slot?.accounts ?? []).filter((a) => a.provider === 'claude' && !a.is_default),
    [slot?.accounts],
  );

  const argAccount = accountId === OWN ? null : accountId;

  const loadAgents = useCallback(async () => {
    if (!focus || !online) { setAgents([]); return; }
    setLoadingAgents(true);
    setAgentsError(null);
    try {
      const r = await listAgents(focus, argAccount);
      setAgents(r?.agents ?? []);
    } catch (e) {
      setAgents([]);
      setAgentsError(err(e));
    } finally {
      setLoadingAgents(false);
    }
  }, [focus, online, argAccount]);

  const loadStore = useCallback(async () => {
    if (!focus || !online) { setSources([]); return; }
    setLoadingStore(true);
    setStoreError(null);
    try {
      const r = await agentStore(focus);
      setSources(r?.sources ?? []);
    } catch (e) {
      setSources([]);
      setStoreError(err(e));
    } finally {
      setLoadingStore(false);
    }
  }, [focus, online]);

  useEffect(() => { loadAgents(); }, [loadAgents]);
  useEffect(() => { loadStore(); }, [loadStore]);
  useEffect(() => { setAccountId(OWN); }, [focus]);

  // A store item's id ("hermes:*") is not an agent name, and agent.list does
  // not say where an agent came from, so "kurulu" is only claimed on an exact
  // name match. A miss just leaves the Kur button — never a false badge.
  const installedNames = useMemo(() => {
    const norm = (s: string) => s.toLocaleLowerCase('tr').replace(/[^a-z0-9]/g, '');
    return new Set(agents.flatMap((a) => [norm(a.name), norm(a.label || '')]).filter(Boolean));
  }, [agents]);

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    return agents.filter((a) => {
      if (filter !== 'all' && SCOPE_LABEL[a.scope] !== filter) return false;
      if (!q) return true;
      return (a.label || '').toLocaleLowerCase('tr').includes(q)
        || a.name.toLocaleLowerCase('tr').includes(q)
        || (a.description || '').toLocaleLowerCase('tr').includes(q);
    });
  }, [agents, filter, query]);

  const storeShown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    if (!q) return sources;
    return sources
      .map((s) => {
        const hit = s.label.toLocaleLowerCase('tr').includes(q)
          || s.repo.toLocaleLowerCase('tr').includes(q)
          || (s.note || '').toLocaleLowerCase('tr').includes(q);
        if (hit) return s;
        const items = s.items.filter((i) =>
          i.label.toLocaleLowerCase('tr').includes(q)
          || (i.about || '').toLocaleLowerCase('tr').includes(q));
        return items.length ? { ...s, items } : null;
      })
      .filter((s): s is StoreSource => s !== null);
  }, [sources, query]);

  const doInstall = async (item: StoreItem) => {
    if (!focus) return;
    setBusyId(item.id);
    setNotice(null);
    try {
      await installAgent(focus, item.id, argAccount);
      await loadAgents();
    } catch (e: any) {
      // A bundle carries skills, and the computer's own account is the one
      // folder they must never land in — so this one gets a way out, not just
      // an error line.
      setNotice(e?.code === 'needs_own_account'
        ? `${err(e)} Pick one of your own accounts above, then try again.`
        : err(e));
    } finally {
      setBusyId(null);
    }
  };

  const doRemove = async (agent: Agent) => {
    if (!focus) return;
    setBusyId(agent.name);
    setNotice(null);
    try {
      await removeAgent(focus, agent.name, argAccount);
      await loadAgents();
    } catch (e) {
      setNotice(err(e));
    } finally {
      setBusyId(null);
    }
  };

  if (!slot) {
    return (
      <div style={{ flex: 1, display: 'flex', background: C.bg }}>
        <Empty title="Agents" hint="Pair a computer first." />
      </div>
    );
  }

  const accountLabel = accountId === OWN
    ? 'This computer’s account'
    : (claudeAccounts.find((a) => a.id === accountId)?.label ?? accountId);

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg }}>
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px',
        borderBottom: `1px solid ${C.border}`, flexShrink: 0,
      }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Agents</div>
        <div style={{ ...mono, fontSize: 12, color: C.faint }}>
          {slot.info?.name || slot.cfg.name} · {accountLabel}
        </div>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => { loadAgents(); loadStore(); }} disabled={!online}>Refresh</Btn>
      </div>

      {/* toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px',
        borderBottom: `1px solid ${C.border}`, flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: C.mute }}>Account</span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            disabled={!online}
            style={{
              height: 30, padding: '0 8px', borderRadius: R.btn, fontSize: 13,
              background: C.surface2, border: `1px solid ${C.border}`, color: C.text,
              cursor: online ? 'pointer' : 'default', maxWidth: 240,
            }}
          >
            <option value={OWN}>This computer’s account</option>
            {claudeAccounts.map((a) => (
              <option key={a.id} value={a.id}>{a.label}{a.logged_in ? '' : ' · not signed in'}</option>
            ))}
          </select>
          {slot.loading.accounts && <Spinner size={13} />}
        </div>

        <div style={{ width: 260 }}>
          <Segment value={filter} options={FILTERS} onChange={setFilter} />
        </div>

        <div style={{ flex: 1 }} />

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 10px', width: 280,
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
        }}>
          <Icon path={P.search} size={14} color={C.mute} />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents and collections"
            style={{
              flex: 1, minWidth: 0, background: 'transparent', border: 'none',
              outline: 'none', fontSize: 13, color: C.text,
            }}
          />
        </div>
      </div>

      {notice && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
          borderBottom: `1px solid ${C.border}`, background: C.surface,
          fontSize: 12.5, color: C.warn, flexShrink: 0,
        }}>
          <Icon path={P.warn} size={13} color={C.warn} />
          <span style={{ flex: 1 }}>{notice}</span>
          <button
            type="button" onClick={() => setNotice(null)}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}
          >
            <Icon path={P.x} size={12} color={C.mute} />
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* installed */}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16 }}>
          {!online ? (
            <Empty title="Computer offline" hint="Agents are read from their definitions on that computer." />
          ) : loadingAgents ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: 24,
              fontSize: 13, color: C.mute,
            }}>
              <Spinner /> Reading agents…
            </div>
          ) : agentsError ? (
            <Empty title="Could not read agents" hint={agentsError} />
          ) : !shown.length ? (
            <Empty
              title={agents.length ? 'No agent matches this filter' : 'No agents on this account'}
              hint={agents.length ? undefined
                : 'Install one from the store on the right, or drop a markdown file with a name and description into the tool’s agents folder on that computer.'}
            />
          ) : (
            <div style={{
              display: 'grid', gap: 12,
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              alignItems: 'stretch',
            }}>
              {shown.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  busy={busyId === a.name}
                  // The built-in agent creator has no file behind it, and an
                  // agent this app did not write back is refused anyway
                  // (agent_not_removable) — so no button is offered for either.
                  onRemove={a.installed && a.scope !== 'builtin' && !!a.path
                    ? () => setDoomed(a) : null}
                />
              ))}
            </div>
          )}
        </div>

        {/* store */}
        <div style={{
          width: STORE_W, flexShrink: 0, borderLeft: `1px solid ${C.border}`,
          background: C.surface, display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 10px', flexShrink: 0,
          }}>
            <div style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>Store</div>
            {loadingStore
              ? <Spinner size={13} />
              : <span style={{ ...mono, fontSize: 11, color: C.faint }}>{sources.length} koleksiyon</span>}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 12px' }}>
            {storeError ? (
              <div style={{ padding: 16, fontSize: 12.5, color: C.mute, lineHeight: '18px' }}>
                Could not read the store — {storeError}
              </div>
            ) : !storeShown.length && !loadingStore ? (
              <div style={{ padding: 16, fontSize: 12.5, color: C.mute }}>
                {query ? 'No collection matches' : 'No collections'}
              </div>
            ) : storeShown.map((s) => (
              <StoreRow
                key={s.id}
                source={s}
                open={openSource === s.id
                  || (openSource === null && s.items.length > 0 && s.items.length <= 3)
                  || (!!query.trim() && s.items.length <= 12)}
                onToggle={() => setOpenSource((k) => (k === s.id ? null : s.id))}
                busyId={busyId}
                installed={installedNames}
                onInstall={doInstall}
              />
            ))}
          </div>

          <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
            <Label>installing downloads text only — nothing is executed</Label>
            <div style={{ fontSize: 11.5, color: C.faint, lineHeight: '16px' }}>
              An agent definition is an instruction that runs with that computer’s tools.
              You can only install into an account you added yourself.
            </div>
          </div>
        </div>
      </div>

      {doomed && (
        <Confirm
          title="Remove this agent?"
          body={`The ${doomed.label || doomed.name} definition is deleted from that computer. You can install it again from the store.`}
          action="Remove"
          onConfirm={() => doRemove(doomed)}
          onClose={() => setDoomed(null)}
        />
      )}
    </div>
  );
}
