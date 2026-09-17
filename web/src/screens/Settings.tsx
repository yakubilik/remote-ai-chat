// TODO(daemon): the Settings artboard draws several things the protocol does
// not carry. They are left off this screen rather than faked:
//  - "Restart the daemon" — there is no restart request.
//  - "Open the file" / a config.toml path in the header — no config.path request.
//  - Depolama (2.2 GB) — nothing reports disk usage.
//  - Bildirimler — push is per device and the panel has no push registration.
//  - Defaults for a new chat — these live in the phone's own
//    storage, not on the daemon; the panel would need its own local blob first.
//  - Security: the dangerous-command list and the denied-path list. host.info
//    carries `roots` and nothing else, so only roots are shown.
//  - Accounts: "Move a sign-in" (account.export/import exist, but moving a sign-in
//    between two computers is its own flow and is not built here).
//  - "make default" — is_default is derived from the account having no home
//    folder; there is no request that sets it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { C, R } from '../lib/theme';
import { Btn, Dot, Icon, Label, P, Segment, Spinner, mono } from '../ui/kit';
import { Modal, ModalHead } from '../components/Modal';
import { ProviderMark } from '../components/Sidebar';
import { onAnyEvent, useFleet, type HostSlot } from '../lib/fleet';
import { parsePairing, toolStatus } from '../lib/actions';
import { errText, t } from '../lib/i18n';
import { ago, tilde, until, uptime, windowName } from '../lib/format';

/** The daemon labels the machine's own account in English ("This computer's
 *  account") because it has no idea who is asking. i18n already carries the
 *  phrase, so the panel says it in its own language. */
function accountName(a: { is_default: boolean; label: string }): string {
  return a.is_default ? t('useDefaultAccount') : a.label;
}
import type {
  CliAccount, LimitWindow, LoginMethod, LoginPrompt, Provider, ToolStatus,
} from '../lib/protocol';

const RAIL_W = 232;

type SectionId = 'hosts' | 'accounts' | 'tools' | 'security' | 'about';

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'hosts', label: 'Computers', icon: P.cpu },
  { id: 'accounts', label: 'Accounts', icon: P.agent },
  { id: 'tools', label: 'Tools', icon: P.bolt },
  { id: 'security', label: 'Security', icon: P.shield },
  { id: 'about', label: 'About', icon: P.layout },
];

/** The daemon's own words for a sign-in route. Which of these are on offer is
 *  the computer's answer (tool.status), not a guess made here. */
const METHOD: Record<string, { label: string; body: string }> = {
  subscription: { label: 'Claude subscription', body: 'Sign in on a page that opens in the browser. Spends your subscription quota.' },
  console: { label: 'Anthropic Console', body: 'Pay as you go. Billed to the API account, not a subscription.' },
  sso: { label: 'Company sign-in (SSO)', body: 'Through your organisation’s identity provider.' },
  api_key: { label: 'API key', body: 'Paste the key. No browser opens.' },
  device: { label: 'ChatGPT with a one-time code', body: 'A page opens; you type the code it gives you.' },
  browser_here: { label: 'That computer’s browser', body: 'Completes on its own if you are sitting at that computer.' },
};

function methodName(id: string): string { return METHOD[id]?.label ?? id; }

function err(e: any): string { return errText(e?.code, e?.message); }

function hostDetail(slot: HostSlot): string {
  if (slot.status === 'online') return 'online';
  if (slot.status === 'connecting') return 'connecting…';
  if (slot.status === 'unauthorized') return 'no access · token revoked';
  return slot.lastOnline ? `offline · ${ago(slot.lastOnline / 1000)}` : 'offline';
}

/** A sign-in URL carries a one-time code in its query. The host is what the
 *  user needs to recognise; the rest never goes on screen. */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? '?••••••••••' : ''}`;
  } catch {
    return url.split('?')[0] + '?••••••••••';
  }
}

/* ── small pieces ─────────────────────────────────────────────────────── */

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

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.card,
      marginBottom: 10, overflow: 'hidden',
    }}>{children}</div>
  );
}

function KV({ k, v, code }: { k: string; v: React.ReactNode; code?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 12, padding: '7px 14px',
      borderTop: `1px solid ${C.hair}`,
    }}>
      <span style={{ width: 150, flexShrink: 0, fontSize: 12, color: C.mute }}>{k}</span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 12.5, color: C.text2,
        wordBreak: 'break-word', ...(code ? mono : {}),
      }}>{v}</span>
    </div>
  );
}

function Head({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{title}</div>
        {hint && <div style={{ fontSize: 12.5, color: C.mute, marginTop: 4, lineHeight: '18px' }}>{hint}</div>}
      </div>
      {right}
    </div>
  );
}

function Note({ children, tone = 'mute' }: { children: React.ReactNode; tone?: 'mute' | 'warn' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px',
      borderRadius: R.btn, background: tone === 'warn' ? 'rgba(216,166,87,0.10)' : C.surface,
      border: `1px solid ${tone === 'warn' ? 'rgba(216,166,87,0.28)' : C.border}`,
      fontSize: 12.5, lineHeight: '18px', color: tone === 'warn' ? C.warn : C.mute,
      marginBottom: 10,
    }}>
      {tone === 'warn' && <Icon path={P.warn} size={13} color={C.warn} />}
      <span style={{ flex: 1 }}>{children}</span>
    </div>
  );
}

function Field({ value, onChange, placeholder, type = 'text', autoFocus, onEnter }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  type?: string; autoFocus?: boolean; onEnter?: () => void;
}) {
  return (
    <input
      value={value} type={type} autoFocus={autoFocus} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } }}
      style={{
        width: '100%', height: 34, padding: '0 10px', boxSizing: 'border-box',
        background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
        outline: 'none', fontSize: 13, color: C.text,
      }}
    />
  );
}

function limitTone(u: number): string {
  if (u >= 0.9) return C.danger;
  if (u >= 0.6) return C.warn;
  return C.info;
}

/** Plan usage is only drawn for a window the tool actually reported. An empty
 *  bar would be a claim the daemon never made. */
function Limits({ windows }: { windows: LimitWindow[] }) {
  const shown = windows
    .filter((w) => typeof w.utilization === 'number')
    .sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0));
  if (!shown.length) return null;
  return (
    <div style={{ padding: '8px 14px 10px', borderTop: `1px solid ${C.hair}` }}>
      <Label>plan usage</Label>
      {shown.map((w) => {
        const p = Math.max(0, Math.min(1, w.utilization ?? 0));
        return (
          <div key={w.window} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ width: 110, flexShrink: 0, fontSize: 12, color: C.text2 }}>
              {windowName(w.window)}
            </span>
            <span style={{
              flex: 1, height: 5, borderRadius: 3, background: C.surface2, overflow: 'hidden', minWidth: 40,
            }}>
              <span style={{
                display: 'block', height: '100%', width: `${p * 100}%`,
                background: limitTone(p), borderRadius: 3,
              }} />
            </span>
            <span style={{ ...mono, width: 40, textAlign: 'right', fontSize: 11, color: C.faint }}>
              %{Math.round(p * 100)}
            </span>
            <span style={{ ...mono, width: 76, textAlign: 'right', fontSize: 11, color: C.faint }}>
              {w.resets_at ? until(w.resets_at) : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── login ────────────────────────────────────────────────────────────── */

type LoginStage = 'method' | 'waiting' | 'code' | 'done';

function LoginSheet({ hostKey, account, methods, onClose, onFinished }: {
  hostKey: string;
  account: CliAccount;
  methods: LoginMethod[];
  onClose: () => void;
  onFinished: () => void;
}) {
  const call = useFleet((s) => s.call);
  const options = methods.length ? methods : [{ id: 'subscription' }];
  const [method, setMethod] = useState<LoginMethod>(options[0]);
  const [stage, setStage] = useState<LoginStage>('method');
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [code, setCode] = useState('');
  const [prompt, setPrompt] = useState<LoginPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // The daemon sends login events only down the socket that asked for the
  // login, which is this computer's one client — so the fleet tap is enough.
  useEffect(() => {
    return onAnyEvent((k, ev) => {
      if (k !== hostKey) return;
      const d: any = ev.data || {};
      if (d.account_id !== account.id) return;
      if (ev.event === 'account.login.prompt') {
        setPrompt(d as LoginPrompt);
        setStage((s) => (s === 'done' ? s : (d.needs_code ? 'code' : 'waiting')));
      }
      if (ev.event === 'account.login.done') {
        setStage('done');
        setBusy(false);
        setOk(!!d.ok);
        setProblem(d.ok ? null : errText(d.error_code, d.error));
        if (d.ok) onFinished();
      }
    });
  }, [hostKey, account.id]);

  const cancel = useCallback(() => {
    call(hostKey, 'account.login.cancel', { account_id: account.id }).catch(() => {});
  }, [hostKey, account.id]);

  // Leaving the sheet with a pty still open would strand it for 15 minutes.
  useEffect(() => () => { cancel(); }, [cancel]);

  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const r: any = await call(hostKey, 'account.login', {
        account_id: account.id,
        method: method.id,
        ...(method.wants_email && email.trim() ? { email: email.trim() } : {}),
        ...(method.needs_key ? { api_key: apiKey } : {}),
      });
      // An API key is settled inside the request; everything else waits for a
      // prompt event. The done event arrives either way.
      setStage(r?.needs_code ? 'code' : 'waiting');
    } catch (e) {
      setBusy(false);
      setProblem(err(e));
      setStage('method');
    }
  };

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await call(hostKey, 'account.login.submit', { account_id: account.id, code: code.trim() });
      setStage('waiting');
    } catch (e) {
      setProblem(err(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} width={520}>
      <ModalHead
        title={`${accountName(account)} · sign-in`}
        subtitle={<span style={mono}>{account.provider}</span>}
        onClose={onClose}
      />
      <div style={{ padding: 20, overflowY: 'auto' }}>
        {stage === 'method' && (
          <>
            <Label>how should this account sign in</Label>
            {options.map((m) => {
              const on = m.id === method.id;
              return (
                <button
                  key={m.id} type="button" onClick={() => setMethod(m)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', marginBottom: 6,
                    padding: '10px 12px', borderRadius: R.btn, cursor: 'pointer',
                    background: on ? C.accentTint : C.bg,
                    border: `1px solid ${on ? C.accentRing : C.border}`,
                  }}
                >
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: C.text }}>
                    {methodName(m.id)}
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: C.mute, marginTop: 3 }}>
                    {METHOD[m.id]?.body ?? ''}
                  </span>
                </button>
              );
            })}

            {method.wants_email && (
              <div style={{ marginTop: 12 }}>
                <Label>the account’s email</Label>
                <Field value={email} onChange={setEmail} placeholder="you@example.com" onEnter={start} />
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 5 }}>
                  The computer starts the sign-in with this address; the page opens on that account.
                </div>
              </div>
            )}

            {method.needs_key && (
              <div style={{ marginTop: 12 }}>
                <Label>api key</Label>
                <Field value={apiKey} onChange={setApiKey} type="password" placeholder="Paste the key" />
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 5 }}>
                  The key is stored on that computer, not in the panel. It spends your API bill, not your subscription.
                </div>
              </div>
            )}
          </>
        )}

        {(stage === 'waiting' || stage === 'code') && (
          <>
            {prompt?.url ? (
              <>
                <Label>1 · open this link in a browser</Label>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 0 10px', height: 36,
                  background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
                }}>
                  <span style={{
                    ...mono, flex: 1, minWidth: 0, fontSize: 12, color: C.text2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{maskUrl(prompt.url)}</span>
                  <Btn onClick={() => navigator.clipboard?.writeText(prompt.url!).catch(() => {})}>
                    <Icon path={P.copy} size={13} color={C.text} /> Kopyala
                  </Btn>
                  <Btn onClick={() => window.open(prompt.url!, '_blank', 'noopener')}>
                    <Icon path={P.external} size={13} color={C.text} /> Open
                  </Btn>
                </div>
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 6 }}>
                  The one-time code in the URL is masked — copying takes the whole thing.
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.mute }}>
                <Spinner /> Preparing the sign-in page…
              </div>
            )}

            {prompt?.code && (
              <div style={{ marginTop: 14 }}>
                <Label>enter this code on the page</Label>
                <div style={{
                  ...mono, fontSize: 20, letterSpacing: 3, color: C.text, padding: '10px 12px',
                  background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
                }}>{prompt.code}</div>
              </div>
            )}

            {stage === 'code' && (
              <div style={{ marginTop: 14 }}>
                <Label>2 · paste the code the page gives you at the end</Label>
                <Field value={code} onChange={setCode} autoFocus onEnter={submit} placeholder="…" />
              </div>
            )}

            {stage === 'waiting' && prompt && !prompt.needs_code && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginTop: 14,
                fontSize: 13, color: C.mute,
              }}>
                <Spinner /> Waiting for approval…
              </div>
            )}

            {prompt?.expires_at && (
              <div style={{ ...mono, fontSize: 11, color: C.faint, marginTop: 10 }}>
                expires in {until(prompt.expires_at)}
              </div>
            )}
          </>
        )}

        {stage === 'done' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
            <Dot color={ok ? C.ok : C.danger} live size={8} />
            <span style={{ color: ok ? C.text : C.danger }}>
              {ok ? 'Signed in' : 'Sign-in failed'}
            </span>
          </div>
        )}

        {problem && (
          <div style={{
            marginTop: 12, padding: '10px 12px', borderRadius: R.btn, fontSize: 12.5,
            color: C.danger, background: 'rgba(224,83,63,0.10)',
            border: '1px solid rgba(224,83,63,0.28)', lineHeight: '18px',
          }}>{problem}</div>
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px',
        borderTop: `1px solid ${C.border}`,
      }}>
        <div style={{ flex: 1 }} />
        {stage === 'method' && (
          <>
            <Btn kind="quiet" onClick={onClose}>Cancel</Btn>
            <Btn
              kind="primary" onClick={start}
              disabled={busy || (!!method.needs_key && !apiKey.trim())}
            >{busy ? 'Starting…' : 'Start'}</Btn>
          </>
        )}
        {(stage === 'waiting' || stage === 'code') && (
          <>
            <Btn kind="quiet" onClick={onClose}>Cancel</Btn>
            {stage === 'code' && (
              <Btn kind="primary" onClick={submit} disabled={busy || code.trim().length < 10}>
                Verify
              </Btn>
            )}
          </>
        )}
        {stage === 'done' && (
          ok
            ? <Btn kind="primary" onClick={onClose}>Done</Btn>
            : <>
                <Btn kind="quiet" onClick={onClose}>Close</Btn>
                <Btn onClick={() => { setStage('method'); setPrompt(null); setCode(''); setProblem(null); }}>
                  Tekrar dene
                </Btn>
              </>
        )}
      </div>
    </Modal>
  );
}

/* ── sections ─────────────────────────────────────────────────────────── */

function HostsSection() {
  const { hosts, order, addHost, removeHost } = useFleet();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<string | null>(null);

  const add = () => {
    const cfg = parsePairing(text);
    if (!cfg) { setProblem('That does not look like a pairing link.'); return; }
    setProblem(null);
    setText('');
    addHost(cfg);
  };

  return (
    <>
      <Head
        title="Computers"
        hint="The panel connects to every paired computer at once. Removing one only cuts this panel’s access."
      />

      {order.map((k) => {
        const slot = hosts[k];
        if (!slot) return null;
        const online = slot.status === 'online';
        const info = slot.info;
        return (
          <Card key={k}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
              <Icon path={P.cpu} size={16} color={online ? C.accentSoft : C.mute} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{info?.name || slot.cfg.name}</div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                  color: slot.status === 'unauthorized' ? C.danger : C.mute, marginTop: 3,
                }}>
                  <Dot color={online ? C.ok : slot.status === 'unauthorized' ? C.danger : C.faint} live={online} size={5} />
                  {hostDetail(slot)}
                </div>
              </div>
              <Btn kind="danger" onClick={() => setDoomed(k)}>Remove</Btn>
            </div>
            <KV k="adres" v={`${slot.cfg.host}:${slot.cfg.port}`} code />
            <KV k="token" v="•••••••••• · kept in the panel, never shown" code />
            <KV k="daemon" v={info?.daemon_version ?? '—'} code />
            <KV k="sistem" v={info ? `${info.os} ${info.os_version}` : '—'} code />
            <KV k="uptime" v={info ? uptime(info.uptime_s) : '—'} code />
            <KV k="open sessions" v={info ? String(info.active_sessions) : '—'} code />
            <KV k="devices" v={info ? String(info.connected_devices) : '—'} code />
          </Card>
        );
      })}

      <div style={{ marginTop: 18 }}>
        <Head
          title="Add a computer"
          hint="Run `remote-ai-chat pair` on that computer, then paste the link it prints here."
        />
        <Card>
          <div style={{ padding: 14 }}>
            <textarea
              value={text}
              onChange={(e) => { setText(e.target.value); setProblem(null); }}
              placeholder="remoteaichat://pair?host=…&port=8790&token=…"
              rows={3}
              style={{
                width: '100%', boxSizing: 'border-box', padding: 10, resize: 'vertical',
                background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
                outline: 'none', color: C.text, ...mono, fontSize: 12, lineHeight: '18px',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <span style={{ flex: 1, fontSize: 12, color: problem ? C.danger : C.faint }}>
                {problem ?? 'The token in that link is kept in the panel and never shown on screen.'}
              </span>
              <Btn kind="primary" onClick={add} disabled={!text.trim()}>Add</Btn>
            </div>
          </div>
        </Card>
      </div>

      {doomed && (
        <Confirm
          title="Remove this computer?"
          body={`${hosts[doomed]?.info?.name || hosts[doomed]?.cfg.name || doomed} leaves this panel and is disconnected. Nothing on that computer is deleted — pair again to add it back.`}
          action="Remove"
          onConfirm={() => removeHost(doomed)}
          onClose={() => setDoomed(null)}
        />
      )}
    </>
  );
}

function AccountCard({ slot, account, onLogin, onLogout, onRename, onDelete }: {
  slot: HostSlot;
  account: CliAccount;
  onLogin: () => void;
  onLogout: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const windows = slot.limits[account.id] ?? [];
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
        <ProviderMark provider={account.provider} dim={!account.logged_in} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              fontSize: 14, fontWeight: 600,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{accountName(account)}</span>
            {account.is_default && (
              <span style={{
                ...mono, fontSize: 10, fontWeight: 600, color: C.mute, padding: '2px 6px',
                borderRadius: R.badge, background: C.surface2, border: `1px solid ${C.border}`,
                whiteSpace: 'nowrap',
              }}>the computer’s own account</span>
            )}
            {account.has_key && (
              <span style={{
                ...mono, fontSize: 10, fontWeight: 600, color: C.mute, padding: '2px 6px',
                borderRadius: R.badge, background: C.surface2, border: `1px solid ${C.border}`,
              }}>api key</span>
            )}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 4,
            fontSize: 12, color: account.logged_in ? C.mute : C.faint,
          }}>
            <Dot color={account.logged_in ? C.ok : C.faint} live={account.logged_in} size={5} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {account.logged_in ? (account.detail || 'signed in') : 'not signed in'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {!account.is_default && <Btn onClick={onRename}>Rename</Btn>}
          {account.logged_in
            ? <Btn onClick={onLogout}>Sign out</Btn>
            : <Btn kind="primary" onClick={onLogin}>Sign in</Btn>}
          {!account.is_default && <Btn kind="danger" onClick={onDelete}>Delete</Btn>}
        </div>
      </div>
      <KV k="id" v={account.id} code />
      <Limits windows={windows} />
    </Card>
  );
}

function AccountsSection({ hostKey, slot, tools }: {
  hostKey: string; slot: HostSlot; tools: ToolStatus[];
}) {
  const { call, refreshAccounts } = useFleet();
  const [problem, setProblem] = useState<string | null>(null);
  const [login, setLogin] = useState<CliAccount | null>(null);
  const [renaming, setRenaming] = useState<CliAccount | null>(null);
  const [renameText, setRenameText] = useState('');
  const [doomed, setDoomed] = useState<CliAccount | null>(null);
  const [signingOut, setSigningOut] = useState<CliAccount | null>(null);
  const [newProvider, setNewProvider] = useState<Provider>('claude');
  const [newLabel, setNewLabel] = useState('');
  const online = slot.status === 'online';

  const reload = useCallback(() => {
    refreshAccounts(hostKey).catch((e) => setProblem(err(e)));
  }, [hostKey]);

  useEffect(() => { if (online) reload(); }, [hostKey, online]);

  const run = async (fn: () => Promise<any>) => {
    setProblem(null);
    try { await fn(); reload(); }
    catch (e) { setProblem(err(e)); }
  };

  const byProvider = useMemo(() => {
    const out: Record<Provider, CliAccount[]> = { claude: [], codex: [] };
    for (const a of slot.accounts) out[a.provider]?.push(a);
    return out;
  }, [slot.accounts]);

  const methodsFor = (p: Provider): LoginMethod[] =>
    tools.find((t) => t.provider === p)?.login_methods ?? [];

  return (
    <>
      <Head
        title="Accounts"
        hint="Each account runs in its own folder on that computer; you pick which one a chat spends when you open it."
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {slot.loading.accounts && <Spinner size={13} />}
            <Btn onClick={reload} disabled={!online}>Refresh</Btn>
          </div>
        }
      />

      {problem && <Note tone="warn">{problem}</Note>}
      {!online && <Note>This computer is offline — accounts cannot be read.</Note>}

      {(['claude', 'codex'] as Provider[]).map((p) => (
        byProvider[p].length ? (
          <div key={p} style={{ marginBottom: 16 }}>
            <Label>{p}</Label>
            {byProvider[p].map((a) => (
              <AccountCard
                key={a.id} slot={slot} account={a}
                onLogin={() => setLogin(a)}
                onLogout={() => setSigningOut(a)}
                onRename={() => { setRenaming(a); setRenameText(a.label); }}
                onDelete={() => setDoomed(a)}
              />
            ))}
          </div>
        ) : null
      ))}

      {online && !slot.accounts.length && !slot.loading.accounts && (
        <Note>No accounts on this computer.</Note>
      )}

      <div style={{ marginTop: 18 }}>
        <Head title="Add an account" hint="A new account starts with an empty folder; you sign in separately." />
        <Card>
          <div style={{ padding: 14, display: 'flex', alignItems: 'flex-end', gap: 10 }}>
            <div style={{ width: 180 }}>
              <Label>tool</Label>
              <Segment
                value={newProvider}
                options={['claude', 'codex'] as const}
                onChange={setNewProvider}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Label>account name</Label>
              <Field
                value={newLabel} onChange={setNewLabel} placeholder="e.g. Work, Second subscription"
                onEnter={() => newLabel.trim() && run(async () => {
                  await call(hostKey, 'account.create', { provider: newProvider, label: newLabel.trim() });
                  setNewLabel('');
                })}
              />
            </div>
            <Btn
              kind="primary"
              disabled={!online || !newLabel.trim()}
              onClick={() => run(async () => {
                await call(hostKey, 'account.create', { provider: newProvider, label: newLabel.trim() });
                setNewLabel('');
              })}
            >Add</Btn>
          </div>
        </Card>
      </div>

      {login && (
        <LoginSheet
          hostKey={hostKey} account={login} methods={methodsFor(login.provider)}
          onClose={() => { setLogin(null); reload(); }}
          onFinished={reload}
        />
      )}

      {renaming && (
        <Modal onClose={() => setRenaming(null)} width={440}>
          <ModalHead title="Account name" subtitle={<span style={mono}>{renaming.id}</span>} onClose={() => setRenaming(null)} />
          <div style={{ padding: 20 }}>
            <Field value={renameText} onChange={setRenameText} autoFocus />
          </div>
          <div style={{
            display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 20px',
            borderTop: `1px solid ${C.border}`,
          }}>
            <Btn kind="quiet" onClick={() => setRenaming(null)}>Cancel</Btn>
            <Btn
              kind="primary" disabled={!renameText.trim()}
              onClick={() => {
                const a = renaming;
                setRenaming(null);
                run(() => call(hostKey, 'account.rename', { account_id: a.id, label: renameText.trim() }));
              }}
            >Kaydet</Btn>
          </div>
        </Modal>
      )}

      {signingOut && (
        <Confirm
          title="Sign out of this account?"
          body={`The ${signingOut.label} sign-in is revoked on that computer and any chat spending it is released. The account stays — you can sign in again later.`}
          action="Sign out"
          onConfirm={() => {
            const a = signingOut;
            run(() => call(hostKey, 'account.logout', { account_id: a.id }));
          }}
          onClose={() => setSigningOut(null)}
        />
      )}

      {doomed && (
        <Confirm
          title="Delete this account?"
          body={`The ${doomed.label} account and its folder on that computer are deleted for good. Any chat spending it is released. This cannot be undone.`}
          action="Delete"
          onConfirm={() => {
            const a = doomed;
            run(() => call(hostKey, 'account.delete', { account_id: a.id }));
          }}
          onClose={() => setDoomed(null)}
        />
      )}
    </>
  );
}

function ToolsSection({ tools, npm, loading, problem, onReload }: {
  tools: ToolStatus[]; npm: boolean | null; loading: boolean;
  problem: string | null; onReload: () => void;
}) {
  return (
    <>
      <Head
        title="Tools"
        hint="The command-line tools that run the chats — versions are re-read from that computer."
        right={<Btn onClick={onReload} disabled={loading}>{loading ? 'Reading…' : 'Refresh'}</Btn>}
      />

      {problem && <Note tone="warn">{problem}</Note>}

      {tools.map((tool) => (
        <Card key={tool.provider}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
            <ProviderMark provider={tool.provider} dim={!tool.version} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{tool.provider}</div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, marginTop: 3,
                fontSize: 12, color: C.mute,
              }}>
                <Dot color={tool.version ? C.ok : C.faint} live={!!tool.version} size={5} />
                {tool.version ? `version ${tool.version}` : 'not installed on this computer'}
              </div>
            </div>
          </div>
          {tool.path && <KV k="yol" v={tilde(tool.path)} code />}
          {!!tool.login_methods?.length && (
            <KV
              k="sign-in methods"
              v={
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {tool.login_methods.map((m) => (
                    <span key={m.id} style={{
                      ...mono, fontSize: 11, color: C.mute, padding: '2px 7px',
                      borderRadius: R.badge, background: C.surface2, border: `1px solid ${C.border}`,
                    }} title={METHOD[m.id]?.body ?? ''}>{methodName(m.id)}</span>
                  ))}
                </span>
              }
            />
          )}
        </Card>
      ))}

      {!tools.length && !loading && !problem && <Note>No tool information.</Note>}

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
          <Icon path={P.bolt} size={16} color={C.mute} />
          <div style={{ flex: 1, fontSize: 13.5 }}>npm</div>
          <span style={{ ...mono, fontSize: 12, color: npm ? C.text2 : C.faint }}>
            {npm == null ? '—' : npm ? 'present' : 'missing'}
          </span>
        </div>
      </Card>
      {npm === false && <Note>Without npm the tools cannot be installed from this panel.</Note>}
    </>
  );
}

function SecuritySection({ slot }: { slot: HostSlot }) {
  const roots = slot.info?.roots ?? [];
  return (
    <>
      <Head
        title="Security"
        hint="Chats can only open under the roots below. That limit is enforced on the computer, and holds even in bypass permission mode."
      />

      <Label>allowed roots</Label>
      <Card>
        {roots.length ? roots.map((root, i) => (
          <div
            key={root}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
              borderTop: i ? `1px solid ${C.hair}` : 'none',
            }}
          >
            <Icon path={P.folder} size={14} color={C.mute} />
            <span style={{ ...mono, flex: 1, minWidth: 0, fontSize: 12.5, color: C.text2, wordBreak: 'break-all' }}>
              {tilde(root)}
            </span>
          </div>
        )) : (
          <div style={{ padding: 14, fontSize: 12.5, color: C.mute }}>
            {slot.status === 'online' ? 'This computer reported no roots.' : 'The computer is offline.'}
          </div>
        )}
      </Card>

      <Note>
        The roots come from that computer’s own config and cannot be changed from the panel.
        Edit the config file on the computer instead.
      </Note>
    </>
  );
}

function AboutSection({ slot }: { slot: HostSlot }) {
  const info = slot.info;
  return (
    <>
      <Head title="About" hint="The daemon running on this computer." />
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
          <Icon path={P.cpu} size={16} color={C.mute} />
          <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{info?.name || slot.cfg.name}</div>
          <Dot color={slot.status === 'online' ? C.ok : C.faint} live={slot.status === 'online'} size={6} />
        </div>
        <KV k="daemon version" v={info?.daemon_version ?? '—'} code />
        <KV k="sistem" v={info ? `${info.os} ${info.os_version}` : '—'} code />
        <KV k="uptime" v={info ? uptime(info.uptime_s) : '—'} code />
        <KV k="devices" v={info ? String(info.connected_devices) : '—'} code />
        <KV k="open sessions" v={info ? String(info.active_sessions) : '—'} code />
        <KV k="adres" v={`${slot.cfg.host}:${slot.cfg.port}`} code />
        <KV k="claude" v={info?.versions?.claude ?? 'not installed'} code />
        <KV k="codex" v={info?.versions?.codex ?? 'not installed'} code />
        {info?.transcription != null && (
          <KV k="transcription" v={info.transcription ? 'on' : 'off'} code />
        )}
      </Card>
    </>
  );
}

/* ── screen ───────────────────────────────────────────────────────────── */

export function Settings() {
  const { hosts, order, focus } = useFleet();
  const [section, setSection] = useState<SectionId>('accounts');
  const slot = focus ? hosts[focus] : null;
  const online = slot?.status === 'online';

  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [npm, setNpm] = useState<boolean | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsProblem, setToolsProblem] = useState<string | null>(null);

  // tool.status re-probes both CLIs, so it is asked for once per computer and
  // then only when the user asks again.
  const loadTools = useCallback(async () => {
    if (!focus || !online) return;
    setToolsLoading(true);
    setToolsProblem(null);
    try {
      const r: any = await toolStatus(focus);
      setTools(r?.tools ?? []);
      setNpm(typeof r?.npm === 'boolean' ? r.npm : null);
    } catch (e) {
      setToolsProblem(err(e));
    } finally {
      setToolsLoading(false);
    }
  }, [focus, online]);

  useEffect(() => { setTools([]); setNpm(null); }, [focus]);
  useEffect(() => { if (online) loadTools(); }, [loadTools]);

  const counts: Partial<Record<SectionId, number>> = {
    hosts: order.length,
    accounts: slot?.accounts.length,
    security: slot?.info?.roots?.length,
  };

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px',
        borderBottom: `1px solid ${C.border}`, flexShrink: 0,
      }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Settings</div>
        {slot && (
          <div style={{ ...mono, fontSize: 12, color: C.faint }}>
            {slot.info?.name || slot.cfg.name}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{
          width: RAIL_W, flexShrink: 0, borderRight: `1px solid ${C.border}`,
          background: C.surface, padding: 10, display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {SECTIONS.map((s) => {
            const on = s.id === section;
            const n = counts[s.id];
            return (
              <button
                key={s.id} type="button" onClick={() => setSection(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 36,
                  padding: '0 10px', borderRadius: R.btn, cursor: 'pointer', textAlign: 'left',
                  background: on ? C.accentTint : 'transparent',
                  border: `1px solid ${on ? C.accentRing : 'transparent'}`,
                }}
              >
                <Icon path={s.icon} size={15} color={on ? C.accentSoft : C.mute} />
                <span style={{
                  flex: 1, fontSize: 13.5, fontWeight: on ? 600 : 400, color: on ? C.text : C.text2,
                }}>{s.label}</span>
                {n != null && <span style={{ fontSize: 11, color: C.faint }}>{n}</span>}
              </button>
            );
          })}

          <div style={{ flex: 1 }} />
          <div style={{
            padding: 10, borderRadius: R.btn, background: C.bg, border: `1px solid ${C.border}`,
            fontSize: 11.5, color: C.mute, lineHeight: '16px',
          }}>
            Every setting lives on that computer. The panel only reads and changes it.
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '18px 24px 40px' }}>
          <div style={{ maxWidth: 820 }}>
            {section === 'hosts' && <HostsSection />}

            {section !== 'hosts' && !slot && (
              <Note>No computer paired yet. Add one from “Computers” on the left.</Note>
            )}

            {section === 'accounts' && slot && focus && (
              <AccountsSection hostKey={focus} slot={slot} tools={tools} />
            )}
            {section === 'tools' && slot && (
              <ToolsSection
                tools={tools} npm={npm} loading={toolsLoading}
                problem={toolsProblem} onReload={loadTools}
              />
            )}
            {section === 'security' && slot && <SecuritySection slot={slot} />}
            {section === 'about' && slot && <AboutSection slot={slot} />}
          </div>
        </div>
      </div>
    </div>
  );
}
