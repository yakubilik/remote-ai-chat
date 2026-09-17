import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { C, R } from '../lib/theme';
import { Icon, P } from '../ui/kit';

export function Modal({ children, onClose, width = 680, align = 'center' }: {
  children: ReactNode; onClose: () => void; width?: number; align?: 'center' | 'top';
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(6,6,5,0.62)', zIndex: 50,
        display: 'flex', alignItems: align === 'top' ? 'flex-start' : 'center',
        justifyContent: 'center', paddingTop: align === 'top' ? 110 : 0,
      }}
    >
      <div style={{
        width, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 120px)',
        background: C.surface, border: `1px solid ${C.borderStrong}`, borderRadius: R.media,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {children}
      </div>
    </div>
  );
}

export function ModalHead({ title, subtitle, onClose }: {
  title: string; subtitle?: ReactNode; onClose: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 20px',
      borderBottom: `1px solid ${C.border}`, flexShrink: 0,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: C.mute, marginTop: 3 }}>{subtitle}</div>}
      </div>
      <button
        type="button" onClick={onClose}
        style={{
          width: 28, height: 28, borderRadius: R.btn, cursor: 'pointer', flexShrink: 0,
          background: C.surface2, border: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon path={P.x} size={13} color={C.mute} />
      </button>
    </div>
  );
}
