import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, Rect, RadialGradient, LinearGradient, Stop } from 'react-native-svg';
import { colors, type } from '../theme';
import { useT } from '../store';
import type { Agent } from '../protocol';

/** #rgb / #rrggbb -> [r,g,b]; anything else falls back to the accent. */
function rgb(hex: string): [number, number, number] {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return [194, 82, 45];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
/** t > 0 lightens toward white, t < 0 darkens toward black. */
function shade([r, g, b]: [number, number, number], t: number): string {
  const m = (c: number) => (t >= 0 ? c + (255 - c) * t : c * (1 + t));
  return `rgb(${clamp(m(r))},${clamp(m(g))},${clamp(m(b))})`;
}

/** One agent as a single card: the artwork is the card, the words sit on it.
 *  Each agent's own colour drives the art, so a wall of them stays distinct
 *  without anybody drawing an image for each. */
export function AgentCard({ agent, onPress, onLongPress, disabled, busy }:
  { agent: Agent; onPress: () => void; onLongPress?: () => void; disabled?: boolean; busy?: boolean }) {
  const T = useT();
  // The one agent that ships with the app speaks the app's language.
  const isCreator = agent.id === 'builtin:agent-creator';
  const label = isCreator ? T('creatorLabel') : agent.label;
  const desc = isCreator ? T('creatorDesc') : agent.description;
  const c = useMemo(() => rgb(agent.color), [agent.color]);
  const bright = shade(c, 0.34);
  const mid = shade(c, -0.34);
  const deep = shade(c, -0.8);
  const ink = shade(c, -0.9);

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} disabled={disabled}
      style={({ pressed }) => [styles.card, pressed && { transform: [{ scale: 0.98 }], opacity: 0.92 }]}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 100 125" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="base" x1="0" y1="0" x2="0.4" y2="1">
            <Stop offset="0" stopColor={mid} />
            <Stop offset="0.74" stopColor={deep} />
            <Stop offset="1" stopColor={ink} />
          </LinearGradient>
          <RadialGradient id="hi" cx="0.14" cy="0.08" rx="1.1" ry="0.9">
            <Stop offset="0" stopColor={bright} stopOpacity="0.95" />
            <Stop offset="0.62" stopColor={bright} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="lo" cx="0.95" cy="0.24" rx="1" ry="0.8">
            <Stop offset="0" stopColor={deep} stopOpacity="0.9" />
            <Stop offset="0.58" stopColor={deep} stopOpacity="0" />
          </RadialGradient>
          <LinearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000" stopOpacity="0" />
            <Stop offset="0.52" stopColor="#000" stopOpacity="0.62" />
            <Stop offset="1" stopColor="#000" stopOpacity="0.88" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100" height="125" fill="url(#base)" />
        <Rect x="0" y="0" width="100" height="125" fill="url(#hi)" />
        <Rect x="0" y="0" width="100" height="125" fill="url(#lo)" />
        <Rect x="0" y="55" width="100" height="70" fill="url(#scrim)" />
      </Svg>

      <Text style={styles.mark} numberOfLines={1}>{agent.glyph}</Text>

      <View style={styles.txt}>
        <Text numberOfLines={2} style={styles.name}>{busy ? '…' : label}</Text>
        {!!desc && (
          <Text numberOfLines={2} style={styles.desc}>{desc}</Text>
        )}
      </View>
      <View style={styles.hairline} pointerEvents="none" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { width: '47%', aspectRatio: 0.8, borderRadius: 22, overflow: 'hidden', justifyContent: 'flex-end',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
  hairline: { ...StyleSheet.absoluteFillObject, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.10)' },
  mark: { position: 'absolute', right: -10, top: -14, fontSize: 96, opacity: 0.22 },
  txt: { paddingHorizontal: 14, paddingBottom: 13 },
  name: { ...type.agentName, color: '#FFFFFF' },
  desc: { fontSize: 13, lineHeight: 17, letterSpacing: -0.1, color: 'rgba(255,255,255,0.72)', marginTop: 3 },
});
