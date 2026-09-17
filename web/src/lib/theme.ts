/** Tokens lifted from design/desktop/TOKENS.md, which was itself extracted from
 *  the phone artboards. Nothing here is invented: if a colour is needed and is
 *  not on this list, the artboard is wrong, not this file. */
export const C = {
  bg: '#0F0E0C',
  bgDeep: '#060605',
  surface: '#1A1815',
  surface2: '#2A2722',
  surface3: '#201D1A',
  hair: '#141311',

  text: '#F1ECE3',
  text2: '#DDD6CB',
  mute: '#8C8578',
  faint: '#6E6860',

  accent: '#C2522D',
  accentHover: '#A3441F',
  accentSoft: '#E8A38A',
  accentTint: 'rgba(194,82,45,0.16)',
  accentRing: 'rgba(194,82,45,0.32)',

  ok: '#5C7E4F',
  warn: '#D8A657',
  danger: '#E0533F',
  info: '#7D9AD1',

  border: 'rgba(241,236,227,0.08)',
  borderStrong: 'rgba(241,236,227,0.12)',
} as const;

export const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

export const R = {
  badge: 6, btn: 8, input: 10, card: 12, media: 14, chip: 16, bubble: 18, composer: 26,
} as const;

/** Colour for a chat's status dot, and for the row that carries it. */
export function statusColor(status: string): string {
  if (status === 'running') return C.accent;
  if (status === 'awaiting_approval') return C.warn;
  return C.faint;
}
