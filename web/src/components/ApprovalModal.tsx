import { C, R } from '../lib/theme';
import { Btn, Dot, Icon, P, mono } from '../ui/kit';
import { Modal } from './Modal';
import { tilde, toolSummary } from '../lib/format';
import type { Chat } from '../lib/protocol';

export interface Pending {
  hostKey: string;
  hostName: string;
  chatId: string;
  requestId: string;
  tool: string;
  input: any;
  preview: string;
  danger: boolean;
  reason: string | null;
  ts: number;
}

function Line({ label, value, right }: { label: string; value: string; right?: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, height: 38, padding: '0 12px',
      borderBottom: `1px solid ${C.border}`,
    }}>
      <span style={{ fontSize: 13, color: C.mute, width: 88, flexShrink: 0 }}>{label}</span>
      <span style={{
        flex: 1, fontSize: 13, fontWeight: 600, minWidth: 0,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{value}</span>
      {right && <span style={{ fontSize: 12, color: C.mute, flexShrink: 0 }}>{right}</span>}
    </div>
  );
}

/** Raised for approvals the daemon flagged as dangerous, on any paired
 *  computer. Quiet approvals stay in the conversation where they happened;
 *  this one blocks, because a destructive command waiting on a chat nobody has
 *  open is exactly the thing the panel is supposed to catch. */
export function ApprovalModal({ pending, chat, queued, onRespond, onOpenChat, onClose }: {
  pending: Pending;
  chat: Chat | null;
  queued: number;
  onRespond: (d: 'allow' | 'allow_session' | 'deny') => void;
  onOpenChat: () => void;
  onClose: () => void;
}) {
  const command = pending.preview || toolSummary(pending.tool, pending.input);
  return (
    <Modal onClose={onClose} width={560}>
      <div style={{ padding: 20 }}>
        <div style={{ display: 'flex', gap: 14, marginBottom: 16 }}>
          <div style={{
            width: 38, height: 38, borderRadius: R.card, flexShrink: 0,
            background: 'rgba(224,83,63,0.14)', border: '1px solid rgba(224,83,63,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon path={P.warn} size={18} color={C.danger} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>
              {pending.danger ? 'Dangerous command' : 'Permission needed'}
            </div>
            <div style={{ fontSize: 13, color: C.mute, lineHeight: '19px', marginTop: 4 }}>
              {pending.reason ?? 'This may not be undoable. Approve it before it runs.'}
            </div>
          </div>
          {queued > 1 && (
            <span style={{
              ...mono, fontSize: 11, color: C.warn, background: 'rgba(216,166,87,0.16)',
              border: '1px solid rgba(216,166,87,0.32)', borderRadius: R.badge,
              padding: '3px 7px', height: 'fit-content', flexShrink: 0,
            }}>+{queued - 1} bekliyor</span>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, background: C.bg,
          border: `1px solid ${C.border}`, borderRadius: R.btn, padding: '10px 12px',
          marginBottom: 14,
        }}>
          <span style={{ ...mono, fontSize: 13, color: C.faint, flexShrink: 0 }}>$</span>
          <span style={{
            ...mono, fontSize: 13, lineHeight: '19px', color: C.text2, flex: 1,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 140, overflowY: 'auto',
          }}>{command}</span>
          <button
            type="button" title="Kopyala"
            onClick={() => navigator.clipboard?.writeText(command).catch(() => {})}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, lineHeight: 0 }}
          >
            <Icon path={P.copy} size={14} color={C.mute} />
          </button>
        </div>

        <div style={{
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: R.card,
          overflow: 'hidden', marginBottom: 16,
        }}>
          <Line label="Chat" value={chat?.title || 'Chat'} right={pending.tool} />
          <Line label="Folder" value={tilde(chat?.cwd ?? '')} />
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, height: 38, padding: '0 12px',
          }}>
            <span style={{ fontSize: 13, color: C.mute, width: 88, flexShrink: 0 }}>Computer</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
              <Dot color={C.ok} live />
              <span style={{
                fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{pending.hostName}</span>
            </span>
            {chat && (
              <span style={{ fontSize: 12, color: C.mute, flexShrink: 0 }}>
                izin modu: {chat.perm_mode}
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Btn kind="danger" onClick={() => onRespond('deny')}>Reddet</Btn>
          <Btn kind="primary" onClick={() => onRespond('allow')}>Allow</Btn>
          <Btn onClick={() => onRespond('allow_session')}>Always allow this session</Btn>
          <span style={{ flex: 1 }} />
          <Btn kind="quiet" onClick={onOpenChat}>Go to the chat</Btn>
        </div>
      </div>
    </Modal>
  );
}
