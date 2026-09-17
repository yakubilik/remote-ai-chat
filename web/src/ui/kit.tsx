import React from 'react';
import { C, MONO, R } from '../lib/theme';

export const mono: React.CSSProperties = { fontFamily: MONO };

/** Status is never colour alone: the dot carries a shape too (a ring when it
 *  is only "known", a filled disc when it is live). */
export function Dot({ color, live = false, size = 6 }: { color: string; live?: boolean; size?: number }) {
  return (
    <span
      style={{
        width: size, height: size, borderRadius: size / 2, flexShrink: 0,
        background: live ? color : 'transparent',
        border: live ? 'none' : `1.5px solid ${color}`,
        display: 'inline-block',
      }}
    />
  );
}

export function Chip({ children, onClick, tone = 'plain', title, shrink }: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: 'plain' | 'accent' | 'warn' | 'mono';
  title?: string;
  /** Lets the chip give up width when the row runs out of it, instead of
   *  pushing its neighbours — the label inside has to ellipsize itself. */
  shrink?: boolean;
}) {
  const bg = tone === 'accent' ? C.accentTint : C.surface;
  const bd = tone === 'accent' ? C.accentRing : tone === 'warn' ? 'rgba(216,166,87,0.32)' : C.border;
  return (
    <button
      type="button" onClick={onClick} title={title} disabled={!onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
        borderRadius: R.chip, background: bg, border: `1px solid ${bd}`,
        color: tone === 'warn' ? C.warn : C.text, fontSize: 13, fontWeight: 600,
        cursor: onClick ? 'pointer' : 'default', whiteSpace: 'nowrap',
        maxWidth: 240, overflow: 'hidden',
        flexShrink: shrink ? 1 : 0, minWidth: shrink ? 0 : undefined,
      }}
    >
      {children}
    </button>
  );
}

export function Btn({ children, onClick, kind = 'ghost', disabled, wide, title, type }: {
  children: React.ReactNode;
  onClick?: () => void;
  kind?: 'ghost' | 'primary' | 'danger' | 'quiet';
  disabled?: boolean;
  wide?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const style: React.CSSProperties = {
    height: 34, padding: '0 14px', borderRadius: R.btn, fontSize: 13, fontWeight: 600,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
    width: wide ? '100%' : undefined, whiteSpace: 'nowrap',
    border: `1px solid ${C.border}`, background: C.surface2, color: C.text,
  };
  if (kind === 'primary') { style.background = C.accent; style.borderColor = C.accent; style.color = '#FFFFFF'; }
  if (kind === 'danger') { style.background = 'rgba(224,83,63,0.14)'; style.borderColor = 'rgba(224,83,63,0.4)'; style.color = C.danger; }
  if (kind === 'quiet') { style.background = 'transparent'; style.color = C.mute; }
  return (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled} title={title} style={style}>
      {children}
    </button>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase',
      color: C.mute, padding: '0 0 8px',
    }}>{children}</div>
  );
}

/** A row of mutually exclusive choices — effort and permission mode both read
 *  as one control with a chosen slot, not as five buttons. */
export function Segment<T extends string>({ value, options, onChange, tone }: {
  value: T | null;
  options: readonly T[];
  onChange: (v: T) => void;
  tone?: (v: T) => 'plain' | 'warn';
}) {
  return (
    <div style={{
      display: 'flex', background: C.bg, border: `1px solid ${C.border}`,
      borderRadius: R.btn, padding: 3, gap: 2,
    }}>
      {options.map((o) => {
        const on = o === value;
        const warn = on && tone?.(o) === 'warn';
        return (
          <button
            key={o} type="button" onClick={() => onChange(o)}
            style={{
              // Basis 'auto' so a long option ("accept-edits") keeps its own
              // width and only the slack is shared — equal slots clipped it.
              flex: '1 1 auto', height: 28, padding: '0 8px',
              borderRadius: 6, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: on ? 600 : 400,
              background: on ? (warn ? 'rgba(216,166,87,0.18)' : C.surface2) : 'transparent',
              color: on ? (warn ? C.warn : C.text) : C.mute,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >{o}</button>
        );
      })}
    </div>
  );
}

export function Empty({ title, hint, icon }: { title: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 10, color: C.mute, padding: 40, textAlign: 'center',
    }}>
      {icon}
      <div style={{ fontSize: 17, color: C.text2 }}>{title}</div>
      {hint && <div style={{ fontSize: 13, maxWidth: 420, lineHeight: '19px' }}>{hint}</div>}
    </div>
  );
}

export function Spinner({ size = 14, color = C.accent }: { size?: number; color?: string }) {
  return (
    <span
      style={{
        width: size, height: size, borderRadius: size / 2, flexShrink: 0,
        border: `2px solid ${color}`, borderTopColor: 'transparent',
        display: 'inline-block', animation: 'rac-spin 0.8s linear infinite',
      }}
    />
  );
}

/** Three bars that rise and fall — the "working" mark from the phone artboards,
 *  kept because it reads at a glance in a list where a spinner would not. */
export function Pulse({ color = C.accent }: { color?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 12 }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{
          width: 3, borderRadius: 1.5, background: color, height: 12,
          animation: `rac-pulse 1s ease-in-out ${i * 0.15}s infinite`,
        }} />
      ))}
    </span>
  );
}

export const KEYFRAMES = `
@keyframes rac-spin { to { transform: rotate(360deg); } }
@keyframes rac-pulse { 0%,100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
@keyframes rac-caret { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }
`;

export function Icon({ path, size = 16, color = C.mute, fill = false, width = 2.2 }: {
  path: string; size?: number; color?: string; fill?: boolean; width?: number;
}) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill={fill ? color : 'none'} stroke={fill ? 'none' : color}
      strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d={path} />
    </svg>
  );
}

export const P = {
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  chevronLeft: 'm15 5-7 7 7 7',
  check: 'm5 12 5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  stop: 'M8 8h8v8H8z',
  send: 'M12 19V5M5 12l7-7 7 7',
  warn: 'M12 3l9 16H3zM12 9v5M12 17.2v.1',
  branch: 'M6 4v10M6 20v-2M18 4v4a4 4 0 0 1-4 4H6',
  gear: 'M4 7h10M18 7h2M4 17h4M12 17h8M15 5v4M8 15v4',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  shield: 'M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6z',
  external: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  cpu: 'M7 7h10v10H7zM4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3',
  layout: 'M4 5h16v14H4zM10 5v14',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  agent: 'M12 4a4 4 0 0 1 4 4v1h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h1V8a4 4 0 0 1 4-4zM9 14v.1M15 14v.1',
  clock: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM12 8v4l3 2',
} as const;
