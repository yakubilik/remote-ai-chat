import { C, R } from '../lib/theme';
import { Icon, P, mono, Label, Dot } from '../ui/kit';
import { cost, duration, shortPath, tokens } from '../lib/format';
import type { Chat } from '../lib/protocol';
import type { Item } from '../lib/timeline';

const W = 300;

function Row({ label, value, onClick, dot }: {
  label: string; value: string; onClick?: () => void; dot?: string;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={!onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 40,
        padding: '0 12px', background: 'transparent', border: 'none',
        borderBottom: `1px solid ${C.border}`, cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <span style={{ fontSize: 13, color: C.mute, flexShrink: 0 }}>{label}</span>
      <span style={{ flex: 1 }} />
      {dot && <Dot color={dot} live />}
      <span style={{
        fontSize: 13, fontWeight: 600, color: C.text, maxWidth: 170,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{value}</span>
      {onClick && <Icon path={P.chevronDown} size={13} color={C.mute} />}
    </button>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.card,
      overflow: 'hidden', marginBottom: 16,
    }}>{children}</div>
  );
}

/** The last few tools, newest first, with how long each one took — derived from
 *  the event timestamps, because the daemon does not time them for us. */
function recentTools(items: Item[]) {
  const out: { tool: string; arg: string; ms: number | null; bad: boolean; running: boolean }[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < 6; i--) {
    const it = items[i];
    if (it.kind !== 'tool') continue;
    const next = items[i + 1];
    out.push({
      tool: it.tool,
      arg: String(it.input?.file_path ?? it.input?.command ?? it.input?.pattern ?? '')
        .split(/[/\\]/).pop() ?? '',
      ms: next ? Math.max(0, (next.ts - it.ts) * 1000) : null,
      bad: it.isError,
      running: it.running,
    });
  }
  return out;
}

export function Inspector({ chat, items, busy, liveTokens, onEdit, onInterrupt, onPopOut }: {
  chat: Chat | null;
  items: Item[];
  busy: boolean;
  liveTokens: number | null;
  onEdit: (field: 'model' | 'effort' | 'perm_mode' | 'cwd') => void;
  onInterrupt: () => void;
  onPopOut: () => void;
}) {
  const tools = chat ? recentTools(items) : [];
  const spent = chat?.total_cost_usd ?? 0;
  const cap = chat?.max_budget_usd ?? null;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : null;
  const turnTokens = items.reduce((sum, it) => {
    if (it.kind !== 'turn' || !it.usage) return sum;
    return sum + (it.usage.input_tokens ?? 0) + (it.usage.output_tokens ?? 0);
  }, 0);

  return (
    <div style={{
      width: W, flexShrink: 0, background: C.surface, borderLeft: `1px solid ${C.border}`,
      display: 'flex', flexDirection: 'column', height: '100%',
    }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {!chat ? (
          <div style={{ fontSize: 13, color: C.mute }}>No chat selected</div>
        ) : (
          <>
            <Label>This session</Label>
            <Card>
              <Row label="Model" value={chat.model} onClick={() => onEdit('model')} />
              <Row label="Effort" value={chat.effort ?? '—'} onClick={() => onEdit('effort')} />
              <Row
                label="Permission" value={chat.perm_mode}
                dot={chat.perm_mode === 'bypass' ? C.warn : C.ok}
                onClick={() => onEdit('perm_mode')}
              />
              <Row label="Folder" value={shortPath(chat.cwd, 2)} onClick={() => onEdit('cwd')} />
            </Card>

            <Label>Cost &amp; tokens</Label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <div style={{
                flex: 1, background: C.bg, border: `1px solid ${C.border}`,
                borderRadius: R.card, padding: '10px 12px',
              }}>
                <div style={{ ...mono, fontSize: 18, fontWeight: 600 }}>{cost(spent)}</div>
                <div style={{ fontSize: 11, color: C.mute, marginTop: 2 }}>
                  {busy ? 'climbing…' : 'this session'}
                </div>
              </div>
              <div style={{
                flex: 1, background: C.bg, border: `1px solid ${C.border}`,
                borderRadius: R.card, padding: '10px 12px',
              }}>
                <div style={{ ...mono, fontSize: 18, fontWeight: 600 }}>
                  {tokens(busy && liveTokens ? turnTokens + liveTokens : turnTokens)}
                </div>
                <div style={{ fontSize: 11, color: C.mute, marginTop: 2 }}>token</div>
              </div>
            </div>
            {cap != null && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: C.mute }}>budget cap</span>
                  <span style={{ ...mono, fontSize: 11, color: C.mute }}>
                    {cost(spent)} / {cost(cap)}
                  </span>
                </div>
                <div style={{ height: 3, borderRadius: 2, background: C.surface2, overflow: 'hidden' }}>
                  <div style={{
                    width: `${pct}%`, height: '100%',
                    background: (pct ?? 0) > 85 ? C.warn : C.accent,
                  }} />
                </div>
              </div>
            )}

            {tools.length > 0 && (
              <>
                <Label>Recent tools</Label>
                <div style={{ marginBottom: 16 }}>
                  {tools.map((t, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 8, height: 30,
                      background: t.running ? C.surface3 : 'transparent',
                      borderRadius: 6, padding: '0 6px',
                    }}>
                      <Dot color={t.bad ? C.danger : t.running ? C.accent : C.ok} live={!t.running} />
                      <span style={{ ...mono, fontSize: 12, color: C.mute, width: 42, flexShrink: 0 }}>
                        {t.tool}
                      </span>
                      <span style={{
                        ...mono, fontSize: 12, color: C.text2, flex: 1,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{t.arg}</span>
                      <span style={{ ...mono, fontSize: 11, color: t.bad ? C.danger : C.faint }}>
                        {t.bad ? 'hata' : t.running ? '…' : duration(t.ms)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div style={{ padding: 16, borderTop: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          type="button" onClick={onInterrupt} disabled={!busy}
          style={{
            height: 36, borderRadius: R.btn, fontSize: 13, fontWeight: 600, cursor: busy ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            border: `1px solid ${busy ? 'rgba(224,83,63,0.4)' : C.border}`,
            background: busy ? 'rgba(224,83,63,0.14)' : 'transparent',
            color: busy ? C.danger : C.faint,
          }}
        >
          <Icon path={P.stop} size={13} color={busy ? C.danger : C.faint} />
          Stop
        </button>
        <button
          type="button" onClick={onPopOut} disabled={!chat}
          style={{
            height: 36, borderRadius: R.btn, fontSize: 13, fontWeight: 600,
            cursor: chat ? 'pointer' : 'default', opacity: chat ? 1 : 0.45,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            border: `1px solid ${C.border}`, background: C.surface2, color: C.text,
          }}
        >
          <Icon path={P.external} size={13} color={C.text} />
          Open in a new window
        </button>
      </div>
    </div>
  );
}

export { W as INSPECTOR_W };
