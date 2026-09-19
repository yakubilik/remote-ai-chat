import { useState } from 'react';
import type { ReactNode } from 'react';
import { C, R } from '../lib/theme';
import { Icon, P, Spinner, mono } from '../ui/kit';
import { cost, duration, tokens, toolSummary, clock } from '../lib/format';
import type { Item } from '../lib/timeline';
import { Lightbox, type Shot } from './Lightbox';
import { fileUrl } from '../lib/actions';

const OK_BG = 'rgba(92,126,79,0.14)';
const BAD_BG = 'rgba(224,83,63,0.10)';

function Divider({ ts }: { ts: number }) {
  const d = new Date(ts * 1000);
  const today = new Date().toDateString() === d.toDateString();
  const label = `${today ? 'Today' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0' }}>
      <div style={{ flex: 1, height: 1, background: C.border }} />
      <span style={{ fontSize: 11, color: C.faint }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: C.border }} />
    </div>
  );
}

/** A picture that will not load. Shown as a picture-shaped thing, never as its
 *  file name: an `<img>` left to fail falls back to its `alt`, and a file name
 *  where a screenshot should be is the most confusing thing on the screen. */
function Missing({ name }: { name: string }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 6, padding: 8, textAlign: 'center',
    }}>
      <Icon path={P.image} size={20} color={C.faint} />
      <span style={{ fontSize: 11, color: C.faint, wordBreak: 'break-all' }}>{name}</span>
      <span style={{ fontSize: 10, color: C.faint }}>no longer on the computer</span>
    </div>
  );
}

/** What the phone sent up: photos, a voice note, a document. The daemon has
 *  already shrunk images and transcribed audio, so this only has to show them. */
/** Save this file, whichever computer it is on. */
function Download({ href }: { href: string }) {
  return (
    <a
      href={href} download title="Download"
      onClick={(e) => e.stopPropagation()}
      style={{
        width: 26, height: 26, borderRadius: R.btn, flexShrink: 0,
        background: C.surface2, border: `1px solid ${C.border}`, textDecoration: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <Icon path={P.download} size={13} color={C.mute} />
    </a>
  );
}

function Attachments({ list, hostKey }: { list: any[]; hostKey: string }) {
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const [shot, setShot] = useState<number | null>(null);
  if (!list?.length) return null;
  const media = list.filter((a) => a?.kind === 'image' || a?.kind === 'video');
  const rest = list.filter((a) => a?.kind !== 'image' && a?.kind !== 'video');
  // fileUrl needs the computer's token; if that computer is gone the bubble
  // still has to render, just without a working link. A picture is drawn from
  // the copy the daemon kept (`view`) so that it survives the original being
  // deleted; the link still opens the file the message named.
  const src = (a: any, viewing = false) => {
    try { return fileUrl(hostKey, (viewing && a.view) || a.path); } catch { return ''; }
  };
  // Saving hands over the file the message named, not the copy kept for
  // showing it — the same thing the link used to open.
  const dl = (a: any) => {
    try { return fileUrl(hostKey, a.path, true); } catch { return ''; }
  };
  const name = (a: any) => a.name ?? a.path?.split(/[/\\]/).pop() ?? 'file';

  // Every picture in this message, so one can be opened and the rest stepped
  // through without closing anything. Videos sit in the same grid but play in
  // place, so they are not part of it — hence the index of its own.
  const shots: Shot[] = [];
  const shotOf = new Map<number, number>();
  media.forEach((a, i) => {
    if (a.kind !== 'image') return;
    shotOf.set(i, shots.length);
    shots.push({ src: src(a, true), download: dl(a), name: name(a) });
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: media.length || rest.length ? 8 : 0 }}>
      {media.length > 0 && (
        <div style={{
          display: 'grid', gap: 4, width: media.length > 1 ? 232 : 200,
          gridTemplateColumns: media.length > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr',
        }}>
          {media.map((a, i) => (
            <div key={i} style={{
              position: 'relative', height: media.length > 1 ? 114 : 150,
              borderRadius: R.media, overflow: 'hidden', background: C.bg,
              border: `1px solid ${C.border}`,
            }}>
              {a.kind === 'image' ? (
                broken[a.path] ? <Missing name={a.name ?? ''} /> : (
                  <button
                    type="button" title={name(a)}
                    onClick={() => setShot(shotOf.get(i) ?? 0)}
                    style={{
                      display: 'block', width: '100%', height: '100%', padding: 0,
                      border: 'none', background: 'transparent', cursor: 'zoom-in',
                    }}
                  >
                    <img
                      src={src(a, true)} alt=""
                      onError={() => setBroken((b) => ({ ...b, [a.path]: true }))}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  </button>
                )
              ) : <video src={src(a, true)} controls style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </div>
          ))}
        </div>
      )}
      {rest.map((a, i) => (
        a.kind === 'audio' ? (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 240 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <audio src={src(a)} controls style={{ flex: 1, minWidth: 0, height: 32 }} />
              <Download href={dl(a)} />
            </div>
            {a.transcript && (
              <div style={{ fontSize: 13, lineHeight: '19px', color: C.mute }}>“{a.transcript}”</div>
            )}
          </div>
        ) : (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 4px 0 10px',
              borderRadius: R.btn, background: C.bg, border: `1px solid ${C.border}`,
              color: C.text2, maxWidth: 300,
            }}
          >
            <Icon path={P.copy} size={13} color={C.mute} />
            <a
              href={src(a)} target="_blank" rel="noreferrer" title={name(a)}
              style={{
                ...mono, fontSize: 12, flex: 1, minWidth: 0, color: 'inherit',
                textDecoration: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >{name(a)}</a>
            <Download href={dl(a)} />
          </div>
        )
      ))}
      {shot != null && <Lightbox shots={shots} start={shot} onClose={() => setShot(null)} />}
    </div>
  );
}

function UserBubble({ item, hostKey }: { item: Extract<Item, { kind: 'user' }>; hostKey: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{
        maxWidth: '72%', background: C.surface2, borderRadius: `${R.bubble}px ${R.bubble}px 4px ${R.bubble}px`,
        padding: '10px 14px', fontSize: 15, lineHeight: '22px', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {item.queued && (
          <div style={{ ...mono, fontSize: 11, color: C.mute, marginBottom: 4 }}>kuyrukta</div>
        )}
        <Attachments list={item.attachments} hostKey={hostKey} />
        {item.text}
      </div>
    </div>
  );
}

/** The little of Markdown that actually shows up in these answers: fenced code,
 *  inline code, and bold. Headings, tables and links are left as written — a
 *  renderer that half-understands them reads worse than the raw text does. */
function inline(text: string, keyBase: string) {
  const out: ReactNode[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) {
      out.push(
        <code key={`${keyBase}-${m.index}`} style={{
          ...mono, fontSize: 13, background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: R.badge, padding: '1px 5px', color: C.text2,
        }}>{m[1]}</code>,
      );
    } else {
      out.push(<strong key={`${keyBase}-${m.index}`} style={{ fontWeight: 600 }}>{m[2]}</strong>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The agent named a file by its path in the text and the daemon lifted it
 *  into `attachments`; once it is a picture or a link, the path is noise. */
function stripLocalRefs(text: string, atts: any[]): string {
  if (!atts?.length) return text;
  const paths = new Set(atts.map((a) => a.path));
  return text.replace(/!?\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:file:\/\/)?[^)\s]+))\s*\)/g, (m, label, angled, bare) => {
    const raw = (angled || bare || '').replace(/^file:\/\//, '');
    if (!paths.has(raw)) return m;
    return m.startsWith('!') ? '' : label;
  }).replace(/\n{3,}/g, '\n\n').trim();
}

function Assistant({ item, hostKey }: { item: Extract<Item, { kind: 'assistant' }>; hostKey: string }) {
  const atts = item.attachments ?? [];
  const parts = stripLocalRefs(item.text, atts).split(/```/);
  return (
    <div style={{ paddingRight: 32, fontSize: 15, lineHeight: '23px', textWrap: 'pretty' as any }}>
      {parts.map((part, i) => (
        i % 2 === 1 ? (
          <pre key={i} style={{
            ...mono, fontSize: 13, lineHeight: '19px', background: C.bg,
            border: `1px solid ${C.border}`, borderRadius: R.card, padding: '10px 12px',
            overflowX: 'auto', margin: '8px 0', color: C.text2,
          }}>{part.replace(/^[a-z]*\n/i, '')}</pre>
        ) : (
          <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{inline(part, `p${i}`)}</span>
        )
      ))}
      {atts.length > 0 && <div style={{ marginTop: 8 }}><Attachments list={atts} hostKey={hostKey} /></div>}
      {!item.done && (
        <span style={{
          display: 'inline-block', width: 7, height: 15, marginLeft: 2, background: C.accent,
          verticalAlign: 'text-bottom', animation: 'rac-caret 1s step-end infinite',
        }} />
      )}
    </div>
  );
}

function Thinking({ item }: { item: Extract<Item, { kind: 'thinking' }> }) {
  return (
    <div style={{
      display: 'flex', gap: 8, paddingRight: 32, fontSize: 13, lineHeight: '19px',
      color: C.mute, fontStyle: 'italic',
    }}>
      <Icon path={P.bolt} size={13} color={C.faint} />
      <span style={{ whiteSpace: 'pre-wrap' }}>{item.text}</span>
    </div>
  );
}

/** A cheap line diff: trim the shared head and tail, call the rest changed.
 *  Enough to show what an Edit touched without pretending to be a diff engine. */
function lineDiff(oldText: string, newText: string) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return {
    context: a.slice(0, head),
    removed: a.slice(head, a.length - tail),
    added: b.slice(head, b.length - tail),
    after: a.slice(a.length - tail),
  };
}

function DiffBody({ input }: { input: any }) {
  const oldText = typeof input?.old_string === 'string' ? input.old_string : null;
  const newText = typeof input?.new_string === 'string' ? input.new_string : null;
  if (oldText == null || newText == null) return null;
  const d = lineDiff(oldText, newText);
  const row = (text: string, sign: '-' | '+' | ' ') => (
    <div style={{
      display: 'flex', gap: 10, padding: '1px 12px',
      background: sign === '-' ? BAD_BG : sign === '+' ? OK_BG : 'transparent',
      color: sign === '-' ? '#E8A79A' : sign === '+' ? '#A9C79C' : C.mute,
    }}>
      <span style={{ width: 8, flexShrink: 0, opacity: sign === ' ' ? 0 : 1 }}>{sign}</span>
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{text || ' '}</span>
    </div>
  );
  return (
    <div style={{ ...mono, fontSize: 12, lineHeight: '18px', borderTop: `1px solid ${C.border}`, padding: '8px 0' }}>
      {d.context.slice(-2).map((l, i) => <div key={`c${i}`}>{row(l, ' ')}</div>)}
      {d.removed.map((l, i) => <div key={`r${i}`}>{row(l, '-')}</div>)}
      {d.added.map((l, i) => <div key={`a${i}`}>{row(l, '+')}</div>)}
      {d.after.slice(0, 2).map((l, i) => <div key={`f${i}`}>{row(l, ' ')}</div>)}
    </div>
  );
}

function Tool({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const bad = item.isError;
  const border = bad ? 'rgba(224,83,63,0.4)' : C.border;
  const summary = toolSummary(item.tool, item.input);
  const isEdit = item.tool === 'Edit' || item.tool === 'Write';
  const counts = isEdit && typeof item.input?.new_string === 'string'
    ? lineDiff(String(item.input.old_string ?? ''), item.input.new_string)
    : null;

  return (
    <div style={{
      borderRadius: R.card, background: C.surface, border: `1px solid ${border}`,
      marginRight: 32, overflow: 'hidden',
    }}>
      <button
        type="button" onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 40,
          padding: '0 12px', background: 'transparent', border: 'none', cursor: 'pointer',
        }}
      >
        {item.running ? <Spinner size={13} />
          : bad ? <Icon path={P.x} size={13} color={C.danger} width={2.6} />
          : <Icon path={P.check} size={13} color={C.ok} width={2.6} />}
        <span style={{ ...mono, fontSize: 13, color: C.mute, flexShrink: 0 }}>{item.tool}</span>
        <span style={{
          ...mono, fontSize: 13, color: C.text2, flex: 1, textAlign: 'left',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{summary}</span>
        {counts && (
          <span style={{ ...mono, fontSize: 11, flexShrink: 0 }}>
            <span style={{ color: C.ok }}>+{counts.added.length}</span>{' '}
            <span style={{ color: C.danger }}>−{counts.removed.length}</span>
          </span>
        )}
        {bad && (
          <span style={{
            ...mono, fontSize: 10, color: C.danger, background: BAD_BG,
            border: `1px solid ${border}`, borderRadius: R.badge, padding: '2px 6px', flexShrink: 0,
          }}>hata</span>
        )}
        <Icon path={open ? P.chevronDown : P.chevronRight} size={13} color={C.faint} />
      </button>
      {open && (isEdit ? <DiffBody input={item.input} /> : (
        <pre style={{
          ...mono, fontSize: 12, lineHeight: '18px', margin: 0, padding: '10px 12px',
          borderTop: `1px solid ${C.border}`, color: bad ? '#E8A79A' : C.mute,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto',
        }}>{item.output ?? (item.running ? 'running…' : '(no output)')}</pre>
      ))}
      {!open && bad && item.output && (
        <div style={{
          ...mono, fontSize: 12, lineHeight: '18px', padding: '8px 12px',
          borderTop: `1px solid ${border}`, color: '#E8A79A', background: BAD_BG,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 60, overflow: 'hidden',
        }}>{item.output.split('\n').slice(0, 2).join('\n')}</div>
      )}
    </div>
  );
}

function Approval({ item, onRespond }: {
  item: Extract<Item, { kind: 'approval' }>;
  onRespond: (d: 'allow' | 'allow_session' | 'deny') => void;
}) {
  const settled = item.decision != null;
  const word = item.decision === 'allow' ? 'izin verildi'
    : item.decision === 'allow_session' ? 'always allowed this session'
    : item.decision === 'deny' ? 'reddedildi'
    : item.decision === 'expired' ? 'timed out' : '';
  return (
    <div style={{
      marginRight: 32, borderRadius: R.card, background: C.surface,
      border: `1px solid ${settled ? C.border : 'rgba(216,166,87,0.32)'}`, padding: 12,
      opacity: settled ? 0.7 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Icon path={item.danger ? P.warn : P.shield} size={14} color={item.danger ? C.danger : C.warn} />
        <span style={{ fontSize: 13, fontWeight: 600, color: item.danger ? C.danger : C.warn }}>
          {item.danger ? 'Dangerous command' : 'Permission needed'}
        </span>
        <span style={{ ...mono, fontSize: 12, color: C.mute }}>{item.tool}</span>
        {settled && <span style={{ marginLeft: 'auto', fontSize: 12, color: C.mute }}>{word}</span>}
      </div>
      <div style={{
        ...mono, fontSize: 12, lineHeight: '18px', background: C.bg, borderRadius: R.btn,
        border: `1px solid ${C.border}`, padding: '8px 10px', color: C.text2,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto',
      }}>{item.preview || toolSummary(item.tool, item.input)}</div>
      {item.reason && (
        <div style={{ fontSize: 12, color: C.mute, marginTop: 6 }}>{item.reason}</div>
      )}
      {!settled && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" onClick={() => onRespond('deny')} style={btn('ghost')}>Reddet</button>
          <button type="button" onClick={() => onRespond('allow')} style={btn('primary')}>Allow</button>
          <button type="button" onClick={() => onRespond('allow_session')} style={btn('ghost')}>
            Always allow this session
          </button>
        </div>
      )}
    </div>
  );
}

function btn(kind: 'ghost' | 'primary') {
  return {
    height: 32, padding: '0 14px', borderRadius: R.btn, fontSize: 13, fontWeight: 600,
    cursor: 'pointer',
    border: `1px solid ${kind === 'primary' ? C.accent : C.border}`,
    background: kind === 'primary' ? C.accent : C.surface2,
    color: kind === 'primary' ? '#FFFFFF' : C.text,
  } as const;
}

function TurnSummary({ item }: { item: Extract<Item, { kind: 'turn' }> }) {
  const bits = [
    duration(item.durationMs),
    item.usage ? `${tokens((item.usage.input_tokens ?? 0) + (item.usage.output_tokens ?? 0))} token` : null,
    cost(item.costUsd),
    item.stopReason && item.stopReason !== 'end_turn' ? item.stopReason : null,
  ].filter(Boolean);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.faint }}>
      <div style={{ width: 24, height: 1, background: C.border }} />
      <Icon path={P.clock} size={12} color={C.faint} />
      <span style={{ ...mono, fontSize: 11 }}>{bits.join('  ·  ')}</span>
      <div style={{ flex: 1, height: 1, background: C.border }} />
    </div>
  );
}

function Failure({ item }: { item: Extract<Item, { kind: 'error' }> }) {
  return (
    <div style={{
      marginRight: 32, borderRadius: R.card, background: BAD_BG,
      border: '1px solid rgba(224,83,63,0.4)', padding: '10px 12px',
      display: 'flex', gap: 8, alignItems: 'flex-start',
    }}>
      <Icon path={P.warn} size={14} color={C.danger} />
      <div style={{ fontSize: 13, lineHeight: '19px', color: '#E8A79A', whiteSpace: 'pre-wrap' }}>
        {item.message}
      </div>
    </div>
  );
}

export function Timeline({ items, hostKey, onRespond }: {
  items: Item[];
  hostKey: string;
  onRespond: (requestId: string, d: 'allow' | 'allow_session' | 'deny') => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {items.map((item, i) => {
        const prev = items[i - 1];
        const gap = !prev || item.ts - prev.ts > 1800;
        return (
          <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {gap && <Divider ts={item.ts} />}
            {item.kind === 'user' && <UserBubble item={item} hostKey={hostKey} />}
            {item.kind === 'assistant' && <Assistant item={item} hostKey={hostKey} />}
            {item.kind === 'thinking' && <Thinking item={item} />}
            {item.kind === 'tool' && <Tool item={item} />}
            {item.kind === 'approval' && (
              <Approval item={item} onRespond={(d) => onRespond(item.requestId, d)} />
            )}
            {item.kind === 'turn' && <TurnSummary item={item} />}
            {item.kind === 'error' && <Failure item={item} />}
          </div>
        );
      })}
    </div>
  );
}

export { clock };
