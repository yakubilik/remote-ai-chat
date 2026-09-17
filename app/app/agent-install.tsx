import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, Rect, RadialGradient, LinearGradient, Stop } from 'react-native-svg';
import { agentAccountOf, useStore, useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { Back, Button, Check, Label, Spinner } from '../src/components/ui';
import { AccountPicker } from '../src/components/pickers';
import type { StoreItem } from '../src/protocol';

/** Installing a skill pack is three things happening in order, so it says which
 *  one it is on rather than spinning silently. */
type Step = 0 | 1 | 2 | 3;

/** One agent from the store, and the install that puts it on this computer.
 *  Reached from the store list — which agent it is arrives as `id`. */
export default function AgentInstall() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { agents, storeSources, storeLoaded, loadStore, installAgent, defaults, conn,
          accounts, loadAccounts, setDefaults } = useStore();
  const [step, setStep] = useState<Step>(0);
  const account = agentAccountOf(defaults);

  useFocusEffect(useCallback(() => {
    if (conn !== 'online') return;
    if (!storeLoaded) void loadStore().catch(() => {});
    void loadAccounts().catch(() => {});
  }, [conn, storeLoaded, loadStore, loadAccounts]));

  const { id } = useLocalSearchParams<{ id: string }>();
  const item: StoreItem | undefined = useMemo(
    () => storeSources.flatMap((s) => s.items).find((i) => i.id === id), [storeSources, id]);
  const failed = storeSources.find((s) => s.error)?.error;
  // The store id is `<source>:<what>`; an installed agent carries the source's name.
  const have = agents.some((a) => a.name === (id ?? '').split(':')[0]);
  // A bundle brings skills, and skills are written under the account it is
  // installed into — the computer's own account has no folder of its own to
  // put them in, so the computer refuses. Without an account the install cannot
  // succeed, so it is not offered: the screen asks for one instead of failing
  // at the end of the attempt. A lone agent definition has no skills and does
  // land somewhere writable, so it is not gated.
  const needsAccount = !account && item?.kind === 'bundle';
  // Having signed in already is a different problem from having nowhere to
  // install: one is answered on the Accounts screen, the other by picking one
  // here. Sending someone who has nine accounts off to add a tenth would
  // answer neither, so the picker is shown as soon as there is a real account.
  const hasAdded = accounts.some((a) => a.provider === 'claude' && a.logged_in && !a.is_default);

  async function install() {
    if (!item || needsAccount) return;
    setStep(1);
    try {
      // One request, one answer — the computer reports no progress in between.
      // Nothing is ticked off until it comes back, or a failed install would
      // leave the screen claiming skills had been downloaded that never were.
      await installAgent(item.id, account);
      setStep(3);
    } catch (e: any) {
      setStep(0);
      Alert.alert(T('error'), e?.message ?? '');
    }
  }

  const steps: { key: Step; title: string; body: string }[] = [
    { key: 1, title: T('hStep1'), body: T('hStep1b', { n: String(item?.skills ?? 46) }) },
    { key: 2, title: T('hStep2'), body: T('hStep2b', { name: item?.label ?? '' }) },
    { key: 3, title: T('hStep3'), body: T('hStep3b') },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}><Back /></Pressable>
        <Text style={[type.title, { color: colors.text, flex: 1 }]}>{item?.label ?? T('addAgent')}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: insets.bottom + 32 }}>
        <View style={styles.hero}>
          <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" viewBox="0 0 100 55" preserveAspectRatio="none">
            <Defs>
              <LinearGradient id="hb" x1="0" y1="0" x2="0.4" y2="1">
                <Stop offset="0" stopColor="#4B3A8C" /><Stop offset="0.76" stopColor="#1E1733" /><Stop offset="1" stopColor="#14101F" />
              </LinearGradient>
              <RadialGradient id="hh" cx="0.14" cy="0.08" rx="1.1" ry="0.9">
                <Stop offset="0" stopColor="#A98CF0" stopOpacity="0.95" /><Stop offset="0.6" stopColor="#A98CF0" stopOpacity="0" />
              </RadialGradient>
              <LinearGradient id="hs" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#000" stopOpacity="0" /><Stop offset="0.55" stopColor="#000" stopOpacity="0.66" /><Stop offset="1" stopColor="#000" stopOpacity="0.9" />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="100" height="55" fill="url(#hb)" />
            <Rect x="0" y="0" width="100" height="55" fill="url(#hh)" />
            <Rect x="0" y="24" width="100" height="31" fill="url(#hs)" />
          </Svg>
          <Text style={styles.mark}>{item?.glyph ?? '🪽'}</Text>
          <View style={styles.heroTxt}>
            <Text style={styles.heroName}>{item?.label ?? ''}</Text>
            <Text style={styles.heroDesc}>
              {item?.skills ? T('hermesAbout', { n: String(item.skills) }) : (item?.about ?? '')}
            </Text>
          </View>
        </View>

        <View style={{ gap: 14 }}>
          {steps.map((s) => {
            const done = step >= s.key && step > 0 && (step > s.key || step === 3);
            const active = step === s.key && step < 3;
            return (
              <View key={s.key} style={styles.step}>
                <View style={[styles.num, done && styles.numOk]}>
                  {done ? <Check size={12} color={colors.success} />
                    : active ? <Spinner size={12} />
                    : <Text style={{ fontSize: 12, color: colors.muted }}>{s.key}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.stepTitle}>{s.title}</Text>
                  <Text style={styles.stepBody}>{s.body}</Text>
                </View>
              </View>
            );
          })}
        </View>

        {!have && step === 0 && hasAdded && (
          <View style={{ gap: 8 }}>
            <Label>{T('installInto')}</Label>
            <AccountPicker accounts={accounts} provider="claude" value={account}
              onChange={(id) => void setDefaults({ agentAccountId: id })} />
          </View>
        )}

        {have || step === 3 ? (
          <Button title={T('goToAgents')} onPress={() => router.back()} />
        ) : !hasAdded ? (
          <Button title={T('goToAccounts')} onPress={() => router.push('/accounts')} />
        ) : (
          <Button title={T('installNamed', { name: item?.label ?? '' })} onPress={install}
            disabled={!item || step > 0 || needsAccount} />
        )}

        <View style={styles.warn}>
          <Text style={[type.caption, { color: colors.pillText, letterSpacing: 0 }]}>
            {failed ? failed
              : needsAccount ? (hasAdded ? T('hermesPickAccount') : T('hermesNeedsAccount'))
              : T('hermesSource', { repo: item?.repo ?? 'AlexAI-MCP/hermes-CCC' })}
          </Text>
        </View>

        <Text style={{ fontSize: 14, lineHeight: 19, letterSpacing: -0.1, color: colors.muted }}>
          {T('orMakeYourOwn')}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 20, paddingBottom: 12 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hero: { height: 190, borderRadius: 22, overflow: 'hidden', justifyContent: 'flex-end' },
  mark: { position: 'absolute', right: -6, top: -22, fontSize: 118, opacity: 0.22 },
  heroTxt: { paddingHorizontal: 16, paddingBottom: 14 },
  heroName: { fontSize: 24, fontWeight: '700', lineHeight: 28, letterSpacing: -0.5, color: '#FFFFFF' },
  heroDesc: { fontSize: 13, lineHeight: 18, color: 'rgba(255,255,255,0.74)', marginTop: 4 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  num: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.border2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  numOk: { backgroundColor: 'rgba(111,169,111,0.20)' },
  stepTitle: { fontSize: 15, lineHeight: 20, letterSpacing: -0.2, color: colors.text },
  stepBody: { fontSize: 13, lineHeight: 17, color: colors.muted, marginTop: 2 },
  warn: { padding: 12, borderRadius: radius.lg, backgroundColor: colors.pillBg, borderWidth: 1, borderColor: colors.pillBorder },
});
