import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import { colors, radius, type } from '../theme';

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={[type.label, { color: colors.muted }]}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Row({ label, value, onPress, mono, last }: {
  label: string; value?: string; onPress?: () => void; mono?: boolean; last?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.row, !last && styles.rowBorder, pressed && { opacity: 0.6 }]}>
      <Text style={[type.sub, { color: colors.text }]}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
        {value != null && (
          <Text numberOfLines={1} style={[mono ? { fontFamily: type.mono.fontFamily, fontSize: 14 } : type.sub, { color: colors.muted, flexShrink: 1 }]}>{value}</Text>
        )}
        {onPress && <Chevron />}
      </View>
    </Pressable>
  );
}

export function Segmented<T extends string>({ options, value, onChange, labels }: {
  options: T[]; value: T | null; onChange: (v: T) => void; labels?: Record<string, string>;
}) {
  return (
    <View style={styles.seg}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable key={o} onPress={() => onChange(o)} style={[styles.segItem, on && styles.segOn]}>
            <Text style={[type.caption, { color: on ? colors.text : colors.muted, fontWeight: on ? '600' : '400', letterSpacing: 0 }]}>
              {labels?.[o] ?? o}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function OptionList({ options, value, onChange }: {
  options: { id: string; label: string; hint?: string }[]; value: string | null; onChange: (id: string) => void;
}) {
  return (
    <Card>
      {options.map((o, i) => (
        <Pressable key={o.id} onPress={() => onChange(o.id)} style={[styles.row, i < options.length - 1 && styles.rowBorder]}>
          <View>
            <Text style={[type.sub, { color: colors.text, fontWeight: o.id === value ? '500' : '400' }]}>{o.label}</Text>
            {!!o.hint && <Text style={[type.monoSmall, { color: colors.muted, fontFamily: undefined }]}>{o.hint}</Text>}
          </View>
          {o.id === value && <Check />}
        </Pressable>
      ))}
    </Card>
  );
}

export function Button({ title, onPress, kind = 'primary', disabled }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean;
}) {
  const bg = kind === 'primary' ? colors.accent : 'transparent';
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [
      styles.btn, { backgroundColor: bg, borderWidth: kind === 'primary' ? 0 : 1, borderColor: colors.border2 },
      (pressed || disabled) && { opacity: 0.6 },
    ]}>
      <Text style={[type.headline, { color: kind === 'primary' ? colors.white : kind === 'danger' ? colors.accent : colors.text, fontWeight: kind === 'primary' ? '600' : '500' }]}>{title}</Text>
    </Pressable>
  );
}

/** Pressable toggle (iOS-switch look) — used instead of RN Switch so it behaves
 *  the same everywhere and matches the design's 51×31 control. */
export function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Pressable onPress={() => onChange(!value)} disabled={disabled} hitSlop={8}
      style={{ width: 51, height: 31, borderRadius: 16, padding: 2, backgroundColor: value ? colors.success : 'rgba(241,236,227,0.12)', alignItems: value ? 'flex-end' : 'flex-start', justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
      <View style={{ width: 27, height: 27, borderRadius: 14, backgroundColor: colors.white }} />
    </Pressable>
  );
}

export function Chips({ items, accent }: { items: (string | null | undefined)[]; accent?: string }) {
  const list = items.filter(Boolean) as string[];
  return (
    <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'nowrap' }}>
      {list.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text style={[type.monoSmall, { color: colors.muted }]}>·</Text>}
          <Text numberOfLines={1} style={[type.monoSmall, { color: i === 0 && accent ? accent : colors.muted }]}>{it}</Text>
        </React.Fragment>
      ))}
    </View>
  );
}

// ── icons (stroke-based, 24 grid) ──────────────────────────────────────────
const I = ({ children, size = 20, color = colors.text, sw = 2 }: { children: React.ReactNode; size?: number; color?: string; sw?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{children}</Svg>
);
export const Chevron = ({ size = 16, color = colors.muted }: { size?: number; color?: string }) => <I size={size} color={color} sw={2.2}><Path d="m9 6 6 6-6 6" /></I>;
export const ChevronDown = ({ size = 14, color = colors.muted }: { size?: number; color?: string }) => <I size={size} color={color} sw={2.2}><Path d="m6 9 6 6 6-6" /></I>;
export const Back = ({ color = colors.accent }: { color?: string }) => <I size={22} color={color} sw={2.2}><Path d="m15 5-7 7 7 7" /></I>;
export const Check = ({ size = 20, color = colors.accent }: { size?: number; color?: string }) => <I size={size} color={color} sw={2.6}><Path d="m5 12 5 5L20 7" /></I>;
export const Compose = () => <I size={24} color={colors.accent} sw={1.8}><Path d="M12 20h9" /><Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></I>;
export const Menu = () => <I size={22} color={colors.text} sw={1.8}><Path d="M3 7h18M3 12h18M3 17h12" /></I>;
export const Gear = () => <I size={22} color={colors.text} sw={1.8}><Path d="M4 7h10M4 12h16M4 17h10" /><Circle cx="18" cy="7" r="2" /><Circle cx="18" cy="17" r="2" /></I>;
export const Lock = ({ size = 16, color = colors.accent }: { size?: number; color?: string }) => <I size={size} color={color} sw={2.2}><Rect x="4" y="11" width="16" height="10" rx="2" /><Path d="M8 11V7a4 4 0 0 1 8 0v4" /></I>;
export const Dots = ({ size = 18, color = colors.muted }: { size?: number; color?: string }) => (
  <I size={size} color={color}><Circle cx="5" cy="12" r="1.9" fill={color} stroke="none" /><Circle cx="12" cy="12" r="1.9" fill={color} stroke="none" /><Circle cx="19" cy="12" r="1.9" fill={color} stroke="none" /></I>
);
export const Plus = ({ color = colors.muted }: { color?: string }) => <I size={24} color={color}><Path d="M12 5v14M5 12h14" /></I>;
export const Search = () => <I size={18} color={colors.muted}><Circle cx="11" cy="11" r="7" /><Path d="m20 20-3.5-3.5" /></I>;
/** A spinner that actually spins — a static arc reads as a frozen app. */
/** Placeholder shapes for a list that has not answered yet. A list rendered
 *  empty while its request is still in flight reads as "nothing here", which is
 *  a different and wrong answer. */
export function Skeleton({ width, height = 12, radius = 6, style }:
  { width: number | string; height?: number; radius?: number; style?: ViewStyle }) {
  const a = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 1, duration: 780, useNativeDriver: true }),
      Animated.timing(a, { toValue: 0.45, duration: 780, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.View style={[{ width: width as any, height, borderRadius: radius,
    backgroundColor: colors.skeleton, opacity: a }, style]} />;
}

/** One placeholder row: a mark and two lines, fading down the list. */
export function SkeletonRows({ rows = 5, minHeight = 72, markSize = 26, markRadius = 8,
                              paddingHorizontal = 20, widths }:
  { rows?: number; minHeight?: number; markSize?: number; markRadius?: number;
    paddingHorizontal?: number; widths?: [string, string][] }) {
  const w: [string, string][] = widths ?? [['62%', '86%'], ['44%', '72%'], ['55%', '63%'],
                                           ['50%', '78%'], ['40%', '58%'], ['47%', '68%']];
  return (
    <View accessibilityLabel="loading">
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight,
                               paddingHorizontal, paddingVertical: 10, opacity: 1 - i * 0.15 }}>
          <Skeleton width={markSize} height={markSize} radius={markRadius} />
          <View style={{ flex: 1, gap: 9 }}>
            <Skeleton width={w[i % w.length][0]} height={13} />
            <Skeleton width={w[i % w.length][1]} height={11} radius={5} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** A transcript still on its way: alternating bubble shapes, fading upward. */
export function SkeletonBubbles({ rows = 4 }: { rows?: number }) {
  const shape: [boolean, number][] = [[true, 46], [false, 96], [true, 62], [false, 128], [true, 40], [false, 84]];
  return (
    <View accessibilityLabel="loading" style={{ paddingHorizontal: 16, gap: 14 }}>
      {Array.from({ length: rows }).map((_, i) => {
        const [mine, h] = shape[i % shape.length];
        return (
          <View key={i} style={{ alignItems: mine ? 'flex-end' : 'flex-start', opacity: 1 - i * 0.18 }}>
            <Skeleton width={mine ? '62%' : '86%'} height={h} radius={16} />
          </View>
        );
      })}
    </View>
  );
}

export function Spinner({ color = colors.accent, size = 14 }: { color?: string; size?: number }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(Animated.timing(spin, {
      toValue: 1, duration: 850, easing: Easing.linear, useNativeDriver: true,
    }));
    anim.start();
    return () => anim.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Circle cx={12} cy={12} r={9} stroke={colors.border2} strokeWidth={2.8} />
        <Path d="M21 12a9 9 0 0 0-9-9" stroke={color} strokeWidth={2.8} strokeLinecap="round" />
      </Svg>
    </Animated.View>
  );
}


/** Four bars breathing in sequence — the moving part of the status pill. */
export function LiveBars({ color = colors.accent, height = 16 }: { color?: string; height?: number }) {
  const anims = useRef([0, 1, 2, 3].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    const loops = anims.map((v, i) =>
      Animated.loop(Animated.sequence([
        Animated.delay(i * 130),
        Animated.timing(v, { toValue: 1, duration: 380, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 380, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.delay((3 - i) * 130),
      ])));
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [anims]);
  const hs = [0.55, 1, 0.75, 0.45].map((f) => height * f);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2.5, height }}>
      {anims.map((v, i) => (
        <Animated.View key={i} style={{
          width: 3, height: hs[i], borderRadius: 2, backgroundColor: color,
          transform: [
            { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [hs[i] * 0.25, 0] }) },
            { scaleY: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) },
          ],
        }} />
      ))}
    </View>
  );
}

/** The mark on the live status line: turns steadily and breathes, so "waiting"
 *  never looks the same as "stuck". */
export function LiveMark({ size = 15 }: { size?: number }) {
  const spin = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(spin, {
      toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: true,
    }));
    const b = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 620, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 620, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    a.start(); b.start();
    return () => { a.stop(); b.stop(); };
  }, [spin, pulse]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1.12] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }, { scale }], opacity }}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill={colors.accent}>
        <Path d={CLAUDE_BURST} />
      </Svg>
    </Animated.View>
  );
}
export const QrIcon = () => <I size={34} color={colors.muted} sw={1.6}><Rect x="3" y="3" width="7" height="7" rx="1" /><Rect x="14" y="3" width="7" height="7" rx="1" /><Rect x="3" y="14" width="7" height="7" rx="1" /><Path d="M14 14h3v3M21 14v7h-7" /></I>;

export const Paperclip = ({ size = 14, color = colors.muted }: { size?: number; color?: string }) => <I size={size} color={color} sw={2}><Path d="m21 11.5-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" /></I>;
export const PinIcon = ({ size = 13, color = colors.muted }: { size?: number; color?: string }) => <I size={size} color={color} sw={2}><Path d="M12 17v5M9 3h6l-1 6 3 3H7l3-3z" /></I>;
export const ArchiveIcon = ({ size = 13, color = colors.muted }: { size?: number; color?: string }) => <I size={size} color={color} sw={2}><Rect x="3" y="4" width="18" height="4" rx="1" /><Path d="M5 8v12h14V8M10 12h4" /></I>;
export const GroupedIcon = ({ size = 14, color = colors.muted }: { size?: number; color?: string }) => <I size={size} color={color} sw={2}><Rect x="3" y="4" width="18" height="6" rx="1.5" /><Rect x="3" y="14" width="18" height="6" rx="1.5" /></I>;
export const FlatIcon = ({ size = 14, color = colors.muted }: { size?: number; color?: string }) => <I size={size} color={color} sw={2}><Path d="M4 7h16M4 12h16M4 17h16" /></I>;

/** Chat avatar: a mark drawn in each tool's own visual language.
 *  These are original marks, not the vendors' trademarked logos. */
const CLAUDE_BURST = "M14.20 13.45L22.60 12.00L14.20 10.55ZM12.53 14.58L19.50 19.50L14.58 12.53ZM10.55 14.20L12.00 22.60L13.45 14.20ZM9.42 12.53L4.50 19.50L11.47 14.58ZM9.80 10.55L1.40 12.00L9.80 13.45ZM11.47 9.42L4.50 4.50L9.42 11.47ZM13.45 9.80L12.00 1.40L10.55 9.80ZM14.58 11.47L19.50 4.50L12.53 9.42Z";

/** The vendors' own app icons, shipped with the app so a chat row reads at a glance.
 *  (Their trademarks; used to identify the tool each chat talks to.) */
const PROVIDER_ICONS: Record<string, any> = {
  claude: require('../../assets/provider-claude.png'),
  codex: require('../../assets/provider-codex.png'),
};

/** Claude mascot, redrawn from the reference image on a 16x11 pixel grid. */
const MASCOT: [number, number, number, number, string][] = [
  [2, 0, 3, 2, 'body'], [11, 0, 3, 2, 'body'],
  [1, 2, 14, 6, 'body'],
  [0, 4, 1, 2, 'body'], [15, 4, 1, 2, 'body'],
  [2, 8, 2, 3, 'body'], [7, 8, 2, 3, 'body'], [12, 8, 2, 3, 'body'],
  [4, 4, 2, 2, 'eye'], [10, 4, 2, 2, 'eye'],
].map((r) => r as [number, number, number, number, string]);

export function ClaudeMascot({ size = 24 }: { size?: number }) {
  const u = size / 16;              // the grid is 16 wide, 11 tall
  return (
    <Svg width={size} height={size * (11 / 16)} viewBox="0 0 16 11">
      {MASCOT.map(([x, y, w, h, kind], i) => (
        <Rect key={i} x={x} y={y} width={w} height={h}
              fill={kind === 'eye' ? '#141311' : colors.mascot} />
      ))}
    </Svg>
  );
}

export function ProviderMark({ provider, size = 24 }: { provider: string; size?: number }) {
  if (provider === 'codex') {
    return <Image source={PROVIDER_ICONS.codex} style={{ width: size, height: size, borderRadius: size * 0.22 }} resizeMode="cover" />;
  }
  return <ClaudeMascot size={size} />;
}

export function ProviderGlyph({ provider, size = 44 }: { provider: string; size?: number }) {
  if (provider === 'codex') {
    return <Image source={PROVIDER_ICONS.codex}
                  style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surface }}
                  resizeMode="cover" />;
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.accentSoft,
                   alignItems: 'center', justifyContent: 'center' }}>
      <ClaudeMascot size={size * 0.62} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  row: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border2 },
  seg: { flexDirection: 'row', gap: 4, backgroundColor: colors.bg, borderRadius: radius.md, padding: 4 },
  segItem: { flex: 1, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.surface2 },
  btn: { height: 52, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
});
