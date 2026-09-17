import { useEffect, useMemo, useRef, useState } from 'react';
import { C, R } from '../lib/theme';
import { Btn, Dot, Icon, Label, P, Spinner, mono } from '../ui/kit';
import { parsePairing } from '../lib/actions';
import { hostKey, useFleet } from '../lib/fleet';
import type { HostConfig } from '../lib/protocol';

type StepState = 'done' | 'active' | 'todo';

interface Probe {
  state: 'checking' | 'up' | 'down';
  /** Only ever set when the daemon actually told us — it answers /health
   *  without CORS headers, so a cross-origin dev panel can prove it is alive
   *  but cannot read the version out of it. */
  version: string | null;
}

const INSTALL = 'cd daemon && ./install.sh';
const PAIR = 'remote-ai-chat pair --name Panel';

/** Alive, and the version if the browser is allowed to read the answer.
 *  A `no-cors` request still resolves when the daemon replies and only
 *  rejects when nothing is listening — which is the question being asked. */
async function probeHealth(host: string, port: number): Promise<Probe> {
  const url = `http://${host}:${port}/health`;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json();
    return { state: 'up', version: typeof j?.version === 'string' ? j.version : null };
  } catch { /* cross-origin read blocked, or nothing there — ask again, blind */ }
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store' });
    return { state: 'up', version: null };
  } catch {
    return { state: 'down', version: null };
  }
}

/** A token is shown as its first and last few characters and nothing else —
 *  enough to tell two pairings apart, useless to anyone reading the screen. */
function mask(token: string): string {
  const t = token.trim();
  if (!t) return '';
  if (t.length <= 10) return '•'.repeat(t.length);
  return `${t.slice(0, 4)}${'•'.repeat(Math.min(16, t.length - 8))}${t.slice(-4)}`;
}

function Chip({ tone, children }: { tone: 'ok' | 'accent'; children: React.ReactNode }) {
  const ok = tone === 'ok';
  return (
    <span style={{
      ...mono, fontSize: 10, fontWeight: 600, letterSpacing: 0.4, padding: '3px 7px',
      borderRadius: R.badge, flexShrink: 0,
      color: ok ? C.ok : C.accentSoft,
      background: ok ? 'rgba(92,126,79,0.16)' : C.accentTint,
      border: `1px solid ${ok ? 'rgba(92,126,79,0.32)' : C.accentRing}`,
    }}>{children}</span>
  );
}

function Marker({ state, n }: { state: StepState; n: number }) {
  const bg = state === 'done' ? 'rgba(92,126,79,0.16)' : state === 'active' ? C.accentTint : C.surface;
  const bd = state === 'done' ? 'rgba(92,126,79,0.32)' : state === 'active' ? C.accentRing : C.border;
  return (
    <div style={{
      width: 26, height: 26, borderRadius: 13, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: bg, border: `1px solid ${bd}`,
    }}>
      {state === 'done'
        ? <Icon path={P.check} size={13} color={C.ok} width={2.6} />
        : <span style={{
          ...mono, fontSize: 12, fontWeight: 600,
          color: state === 'active' ? C.accentSoft : C.faint,
        }}>{n}</span>}
    </div>
  );
}

function Step({ n, state, title, chip, last, children }: {
  n: number;
  state: StepState;
  title: string;
  chip?: React.ReactNode;
  last?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'stretch' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 26 }}>
        <Marker state={state} n={n} />
        {!last && (
          <div style={{
            flex: 1, width: 1, minHeight: 16,
            background: state === 'done' ? 'rgba(92,126,79,0.32)' : C.border,
          }} />
        )}
      </div>
      <div style={{
        flex: 1, minWidth: 0, marginBottom: last ? 0 : 16, padding: 16,
        borderRadius: R.card, background: C.surface,
        border: `1px solid ${state === 'active' ? C.accentRing : C.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 22 }}>
          <span style={{
            fontSize: 15, fontWeight: 600,
            color: state === 'todo' ? C.mute : C.text,
          }}>{title}</span>
          {chip}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A command the user runs on the other machine: mono, selectable, copyable —
 *  never a sentence dressed up as code. */
function CodeBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const copy = () => {
    navigator.clipboard?.writeText(text)
      .then(() => {
        setCopied(true);
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 4px 0 12px',
      background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.input,
    }}>
      <code style={{
        ...mono, flex: 1, minWidth: 0, fontSize: 13, color: C.text2,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'text',
      }}>{text}</code>
      <Btn kind="quiet" onClick={copy}>
        <Icon path={copied ? P.check : P.copy} size={13} color={copied ? C.ok : C.mute} />
        {copied ? 'Copied' : 'Copy'}
      </Btn>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, secret, width }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secret?: boolean;
  width?: number;
}) {
  return (
    <div style={{ width, flex: width ? undefined : 1, minWidth: 0 }}>
      <div style={{ ...mono, fontSize: 11, color: C.faint, paddingBottom: 4 }}>{label}</div>
      <input
        value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={secret ? 'password' : 'text'}
        autoComplete="off" spellCheck={false}
        style={{
          ...mono, width: '100%', boxSizing: 'border-box', height: 34, padding: '0 10px',
          fontSize: 13, color: C.text, background: C.bg,
          border: `1px solid ${C.border}`, borderRadius: R.input, outline: 'none',
        }}
      />
    </div>
  );
}

export function Onboarding({ onPaired }: { onPaired: () => void }) {
  const addHost = useFleet((s) => s.addHost);
  const hosts = useFleet((s) => s.hosts);

  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('8790');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [paste, setPaste] = useState('');
  const [fromLink, setFromLink] = useState(false);
  /** Bumped on every resolved link so the box is rebuilt empty rather than
   *  re-rendered — a controlled value alone can leave the pasted token sitting
   *  in the DOM node. */
  const [pasteNonce, setPasteNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe>({ state: 'checking', version: null });
  const [pairedKey, setPairedKey] = useState<string | null>(null);

  const portNum = Number(port);
  const validAddr = !!host.trim() && Number.isFinite(portNum) && portNum > 0;

  // Poked on load and whenever the address settles, so typing a different host
  // re-answers "is anything listening there" without a button press.
  const seq = useRef(0);
  useEffect(() => {
    if (!validAddr) { setProbe({ state: 'down', version: null }); return; }
    const mine = ++seq.current;
    // A green tick belongs to the address it was earned at. Change the address
    // and it goes back to a question until this one has answered.
    setProbe({ state: 'checking', version: null });
    const id = window.setTimeout(() => {
      probeHealth(host.trim(), portNum).then((r) => { if (seq.current === mine) setProbe(r); });
    }, 350);
    return () => window.clearTimeout(id);
  }, [host, port]);

  const recheck = () => {
    const mine = ++seq.current;
    setProbe({ state: 'checking', version: null });
    probeHealth(host.trim(), portNum).then((r) => { if (seq.current === mine) setProbe(r); });
  };

  const onPaste = (text: string) => {
    setPaste(text);
    setError(null);
    if (!text.trim()) { setFromLink(false); return; }
    const cfg = parsePairing(text);
    if (!cfg) {
      setFromLink(false);
      setError('Could not read that pairing link — it should be remoteaichat://pair?… or the QR’s JSON.');
      return;
    }
    setHost(cfg.host);
    setPort(String(cfg.port));
    setToken(cfg.token);
    setName(cfg.name || cfg.host);
    setDeviceId(cfg.device_id);
    setFromLink(true);
    // The link carries the token in the clear, so it does not stay on screen:
    // what it resolved to is shown below, masked.
    setPaste('');
    setPasteNonce((n) => n + 1);
  };

  const connect = () => {
    if (!validAddr) { setError('Adres eksik.'); return; }
    if (!token.trim()) { setError('No token — paste the pairing link, or type it in.'); return; }
    const cfg: HostConfig = {
      host: host.trim(), port: portNum, token: token.trim(),
      name: name.trim() || host.trim(), device_id: deviceId,
    };
    setError(null);
    setPairedKey(hostKey(cfg));
    addHost(cfg);
  };

  const status = pairedKey ? hosts[pairedKey]?.status ?? 'connecting' : null;
  const info = pairedKey ? hosts[pairedKey]?.info ?? null : null;

  // The panel is usable the moment the socket is up; the "ready" step is drawn
  // for a beat first so the flow visibly finishes rather than snapping away.
  useEffect(() => {
    if (status !== 'online') return;
    const id = window.setTimeout(onPaired, 700);
    return () => window.clearTimeout(id);
  }, [status]);

  const s1: StepState = probe.state === 'up' ? 'done' : 'active';
  const s2: StepState = pairedKey ? 'done' : probe.state === 'up' ? 'active' : 'todo';
  const s3: StepState = status === 'online' ? 'done' : pairedKey ? 'active' : 'todo';
  const done = [s1, s2, s3].filter((s) => s === 'done').length;

  const preview = useMemo(() => (token.trim()
    ? `${host.trim()}:${port} · ${mask(token)}`
    : null), [host, port, token]);

  return (
    <div style={{
      height: '100%', width: '100%', overflowY: 'auto',
      background: C.bg, color: C.text,
    }}>
      <div style={{ maxWidth: 620, margin: '0 auto', padding: '56px 24px 64px' }}>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.2 }}>Let’s finish setting up</div>
        <div style={{ fontSize: 14, color: C.mute, marginTop: 6 }}>
          Three steps. Once the panel reaches the daemon, that computer’s chats open here.
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0 28px' }}>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: C.surface2, overflow: 'hidden' }}>
            <div style={{
              width: `${(done / 3) * 100}%`, height: '100%', borderRadius: 2,
              background: C.ok, transition: 'width 240ms ease',
            }} />
          </div>
          <span style={{ ...mono, fontSize: 12, color: C.mute }}>{done} / 3</span>
        </div>

        <Step
          n={1} state={s1} title="The daemon is running"
          chip={probe.state === 'up' ? <Chip tone="ok">tamam</Chip>
            : probe.state === 'checking' ? <Spinner size={12} /> : null}
        >
          {probe.state === 'up' ? (
            <div style={{ ...mono, fontSize: 12, color: C.mute, marginTop: 6 }}>
              {host.trim()}:{port}{probe.version ? ` · v${probe.version}` : ''}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: C.text2, lineHeight: '19px', margin: '8px 0 10px' }}>
                {probe.state === 'checking'
                  ? 'Probing the address…'
                  : 'Nothing answers at this address. Install it from the repo on that computer:'}
              </div>
              {probe.state === 'down' && (
                <>
                  <CodeBox text={INSTALL} />
                  <div style={{ display: 'flex', marginTop: 10 }}>
                    <Btn onClick={recheck}>Tekrar yokla</Btn>
                  </div>
                </>
              )}
            </>
          )}
        </Step>

        <Step
          n={2} state={s2} title="Pair the computer"
          chip={pairedKey ? <Chip tone="ok">tamam</Chip>
            : s2 === 'active' ? <Chip tone="accent">now</Chip> : null}
        >
          <div style={{ fontSize: 13, color: C.text2, lineHeight: '19px', margin: '8px 0 10px' }}>
            Run this on the computer, then paste the link it prints below.
          </div>
          <CodeBox text={PAIR} />

          <div style={{ marginTop: 14 }}>
            <Label>Pairing link</Label>
            <textarea
              key={pasteNonce}
              value={paste} onChange={(e) => onPaste(e.target.value)}
              placeholder="remoteaichat://pair?host=…&port=8790&token=…"
              spellCheck={false} rows={3}
              style={{
                ...mono, width: '100%', boxSizing: 'border-box', padding: '10px 12px',
                fontSize: 12, lineHeight: '18px', color: C.text, background: C.bg,
                border: `1px solid ${fromLink ? C.accentRing : C.border}`,
                borderRadius: R.input, outline: 'none', resize: 'vertical',
              }}
            />
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
              color: fromLink ? C.ok : C.faint, marginTop: 6, lineHeight: '17px',
            }}>
              {fromLink && <Icon path={P.check} size={12} color={C.ok} />}
              {fromLink
                ? 'Link read — the token stays masked below.'
                : "The QR’s JSON works too. A pasted token is never left on screen."}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
            <Field label="host" value={host} onChange={(v) => { setHost(v); setFromLink(false); }} />
            <Field label="port" value={port} width={88}
              onChange={(v) => { setPort(v.replace(/[^0-9]/g, '')); setFromLink(false); }} />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <Field label="token" value={token} secret placeholder="device token"
              onChange={(v) => { setToken(v); setFromLink(false); }} />
            <Field label="ad" value={name} onChange={setName} placeholder="This computer" width={160} />
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, marginTop: 16,
            paddingTop: 12, borderTop: `1px solid ${C.hair}`,
          }}>
            <span style={{
              ...mono, flex: 1, minWidth: 0, fontSize: 12,
              color: error ? C.danger : C.mute,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }} title={error ?? preview ?? ''}>
              {error ?? preview ?? 'token bekleniyor'}
            </span>
            <Btn kind="primary" onClick={connect} disabled={!token.trim() || !validAddr || !!pairedKey}>
              Connect
            </Btn>
          </div>
        </Step>

        <Step
          n={3} state={s3} last title="Ready"
          chip={status === 'online' ? <Chip tone="ok">connected</Chip>
            : s3 === 'active' ? <Spinner size={12} /> : null}
        >
          {!pairedKey ? (
            <div style={{ fontSize: 13, color: C.mute, marginTop: 6, lineHeight: '19px' }}>
              Once pairing is done this computer’s chats, projects and agents open in the panel.
            </div>
          ) : status === 'online' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <Dot color={C.ok} live size={6} />
              <span style={{ ...mono, fontSize: 12, color: C.mute }}>
                {info?.name ?? name ?? host}
                {info?.daemon_version ? ` · daemon ${info.daemon_version}` : ''}
              </span>
            </div>
          ) : (
            <div style={{
              fontSize: 13, marginTop: 8, lineHeight: '19px',
              color: status === 'unauthorized' ? C.danger : C.mute,
            }}>
              {status === 'unauthorized'
                ? 'The token was refused — run pair again on the computer.'
                : 'Connecting…'}
            </div>
          )}
        </Step>
      </div>
    </div>
  );
}
