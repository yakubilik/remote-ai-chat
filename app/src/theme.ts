import { Platform } from 'react-native';

export const colors = {
  bg: '#0F0E0C',
  surface: '#1A1815',
  surface2: '#2A2722',
  text: '#F1ECE3',
  muted: '#8C8578',
  faint: 'rgba(241,236,227,0.32)',
  border: 'rgba(241,236,227,0.08)',
  border2: 'rgba(241,236,227,0.12)',
  accent: '#C2522D',
  accentSoft: 'rgba(194,82,45,0.16)',
  codex: '#7D9AD1',
  codexMark: '#D8D2C7',
  mascot: '#C86D4E',
  skeleton: '#241F1B',
  pillBg: 'rgba(194,82,45,0.13)',
  pillBorder: 'rgba(194,82,45,0.32)',
  pillText: '#E8A38A',
  pillMeta: '#C08C7B',
  codexSoft: 'rgba(91,123,181,0.18)',
  success: '#5C7E4F',
  warning: '#E5B264',
  danger: '#E0533F',
  info: '#4C8DD9',
  error: '#C2522D',
  white: '#FFFFFF',
  userBubble: '#2A2722',
};

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' }) as string;

export const type = {
  agentName: { fontSize: 19, fontWeight: '600' as const, lineHeight: 23, letterSpacing: -0.4 },
  largeTitle: { fontSize: 34, fontWeight: '700' as const, lineHeight: 41, letterSpacing: -0.5 },
  title: { fontSize: 22, fontWeight: '600' as const, lineHeight: 28 },
  headline: { fontSize: 17, fontWeight: '600' as const, lineHeight: 22 },
  body: { fontSize: 17, fontWeight: '400' as const, lineHeight: 24 },
  sub: { fontSize: 15, fontWeight: '400' as const, lineHeight: 20 },
  caption: { fontSize: 13, fontWeight: '400' as const, lineHeight: 18, letterSpacing: 0.3 },
  label: { fontSize: 13, fontWeight: '500' as const, lineHeight: 18, letterSpacing: 1.2, textTransform: 'uppercase' as const },
  mono: { fontFamily: mono, fontSize: 13, lineHeight: 18 },
  monoSmall: { fontFamily: mono, fontSize: 11, lineHeight: 14 },
};

export const radius = { sm: 8, md: 12, lg: 14, xl: 18, sheet: 22 };

export function providerColor(provider: string) {
  return provider === 'codex' ? colors.codex : colors.accent;
}
export function providerSoft(provider: string) {
  return provider === 'codex' ? colors.codexSoft : colors.accentSoft;
}
