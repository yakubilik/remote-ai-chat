import { useEffect, useState } from 'react';
import { R } from '../lib/theme';
import { Icon, P, mono } from '../ui/kit';

export interface Shot {
  /** what to show — the daemon's own viewable copy where there is one */
  src: string;
  /** the same file with a Content-Disposition, so the browser saves it */
  download: string;
  name: string;
}

function Tool({ icon, title, onClick, href }: {
  icon: string; title: string; onClick?: () => void; href?: string;
}) {
  const style: React.CSSProperties = {
    width: 34, height: 34, borderRadius: R.btn, flexShrink: 0, cursor: 'pointer',
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none',
  };
  const glyph = <Icon path={icon} size={16} color="#EDEAE3" />;
  return href
    ? <a href={href} title={title} download style={style}>{glyph}</a>
    : <button type="button" title={title} onClick={onClick} style={style}>{glyph}</button>;
}

/** A picture, looked at. It used to open in a tab, which threw away the chat
 *  behind it and handed the person a bare file on a localhost URL; here the
 *  chat is still there when they close it, and several pictures in one message
 *  can be stepped through without going back and forth. */
export function Lightbox({ shots, start, onClose }: {
  shots: Shot[]; start: number; onClose: () => void;
}) {
  const [i, setI] = useState(Math.min(Math.max(start, 0), Math.max(shots.length - 1, 0)));
  const many = shots.length > 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (!many) return;
      if (e.key === 'ArrowLeft') setI((n) => (n - 1 + shots.length) % shots.length);
      if (e.key === 'ArrowRight') setI((n) => (n + 1) % shots.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, many, shots.length]);

  const shot = shots[i];
  if (!shot) return null;

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(6,6,5,0.88)',
        display: 'flex', flexDirection: 'column', padding: 16, gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{
          ...mono, flex: 1, minWidth: 0, fontSize: 12.5, color: '#EDEAE3',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{shot.name}</span>
        {many && (
          <span style={{ ...mono, fontSize: 12, color: 'rgba(237,234,227,0.6)', flexShrink: 0 }}>
            {i + 1} / {shots.length}
          </span>
        )}
        <Tool icon={P.download} title="Download" href={shot.download} />
        <Tool icon={P.external} title="Open in a tab" onClick={() => window.open(shot.src, '_blank', 'noopener')} />
        <Tool icon={P.x} title="Close" onClick={onClose} />
      </div>

      {/* The backdrop closes on a click that lands on it, so the row around the
          picture counts as backdrop too — only the picture itself does not. */}
      <div
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', gap: 12 }}
      >
        {many && <Tool icon={P.chevronLeft} title="Previous" onClick={() => setI((n) => (n - 1 + shots.length) % shots.length)} />}
        <img
          src={shot.src} alt={shot.name}
          style={{
            flex: 1, minWidth: 0, maxWidth: '100%', maxHeight: '100%',
            objectFit: 'contain', borderRadius: R.media,
          }}
        />
        {many && <Tool icon={P.chevronRight} title="Next" onClick={() => setI((n) => (n + 1) % shots.length)} />}
      </div>
    </div>
  );
}
