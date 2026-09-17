import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { Back, Button, Card, Check, Label, ProviderMark, Spinner } from '../src/components/ui';
import { callOnce } from '../src/ws';
import type { CliAccount, Provider } from '../src/protocol';

/** One signed-in account on some other paired computer. */
type Source = { hostId: string; hostName: string; account: CliAccount };

export default function MoveSignIn() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { provider, id } = useLocalSearchParams<{ provider: Provider; id?: string }>();
  const prov = (provider ?? 'claude') as Provider;
  const { hosts, activeHostId, host, createAccount, loadAccounts } = useStore();
  const [sources, setSources] = useState<Source[]>([]);
  const [scanning, setScanning] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [step, setStep] = useState<'idle' | 'moving' | 'checking'>('idle');

  const others = hosts.filter((h) => h.id !== activeHostId);

  // Every other computer is asked what it is signed in to. One that is off or
  // unreachable simply contributes nothing — it must not hold up the list.
  useEffect(() => {
    let alive = true;
    (async () => {
      const found: Source[] = [];
      await Promise.all(others.map(async (h) => {
        try {
          const r = await callOnce<{ accounts: CliAccount[] }>(h.host, h.port, h.token, 'account.list', {});
          for (const a of r.accounts) {
            if (a.provider === prov && a.logged_in) found.push({ hostId: h.id, hostName: h.name, account: a });
          }
        } catch {}
      }));
      if (alive) { setSources(found); setScanning(false); }
    })();
    return () => { alive = false; };
  }, [hosts.length, activeHostId, prov]);

  const move = useCallback(async (src: Source) => {
    const srcHost = hosts.find((h) => h.id === src.hostId);
    if (!srcHost) return;
    setStep('moving');
    try {
      const exported = await callOnce<{ credentials: Record<string, unknown>; label: string }>(
        srcHost.host, srcHost.port, srcHost.token, 'account.export', { account_id: src.account.id });

      // Into the account this screen was opened from, or a new one named after
      // the source. Never into the computer's own built-in account.
      let targetId = typeof id === 'string' ? id : '';
      if (!targetId) {
        const created = await createAccount(prov, src.account.is_default ? src.hostName : src.account.label);
        targetId = created.id;
      }

      setStep('checking');
      const r = await useStore.getState().importSignIn(targetId, exported.credentials);
      if (!r.verified) {
        Alert.alert(T('moveFailed'), `${r.verify_error ?? ''}\n\n${T('moveKeptSource', { host: src.hostName })}`.trim());
        setStep('idle');
        await loadAccounts();
        return;
      }
      // Only now: the source's copy is dead the moment this one refreshes.
      try {
        await callOnce(srcHost.host, srcHost.port, srcHost.token, 'account.forget', { account_id: src.account.id });
      } catch {}
      await loadAccounts();
      Alert.alert(T('moveDone'), T('moveDoneBody', { label: host?.name ?? '', host: src.hostName }));
      router.back();
    } catch (e: any) {
      Alert.alert(T('moveFailed'), e?.message ?? '');
      setStep('idle');
    }
  }, [hosts, id, prov, host?.name]);

  function confirm() {
    const src = sources.find((s) => `${s.hostId}:${s.account.id}` === picked);
    if (!src) return;
    Alert.alert(T('moveConfirm'), T('moveConfirmBody', { host: src.hostName, label: src.account.is_default ? T('useDefaultAccount') : src.account.label }), [
      { text: T('cancel'), style: 'cancel' },
      { text: T('moveButton'), onPress: () => void move(src) },
    ]);
  }

  const busy = step !== 'idle';

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 22 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -12 }}>
          <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}><Back /></Pressable>
          <Text style={[type.largeTitle, { color: colors.text }]}>{T('moveSignIn')}</Text>
        </View>
        <Text style={[type.caption, { color: colors.muted }]}>{T('moveIntro')}</Text>

        <View style={{ gap: 8 }}>
          <Label>{T('moveSource')}</Label>
          <Card>
            {scanning ? (
              <View style={[styles.row, { gap: 10 }]}>
                <Spinner />
                <Text style={[type.sub, { color: colors.muted }]}>{T('moveLoadingHost')}</Text>
              </View>
            ) : others.length === 0 ? (
              <View style={styles.row}><Text style={[type.sub, { color: colors.muted }]}>{T('moveNoHosts')}</Text></View>
            ) : sources.length === 0 ? (
              <View style={styles.row}><Text style={[type.sub, { color: colors.muted }]}>{T('moveNoAccounts')}</Text></View>
            ) : sources.map((s, i) => {
              const key = `${s.hostId}:${s.account.id}`;
              return (
                <Pressable key={key} disabled={busy} onPress={() => setPicked(key)}
                  style={[styles.row, i < sources.length - 1 && styles.rowBorder, picked === key && { backgroundColor: colors.pillBg }]}>
                  <ProviderMark provider={prov} size={24} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={[type.sub, { color: colors.text, fontWeight: '500' }]}>{s.hostName}</Text>
                    <Text numberOfLines={1} style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>
                      {(s.account.is_default ? T('useDefaultAccount') : s.account.label) + (s.account.detail ? ` · ${s.account.detail}` : '')}
                    </Text>
                  </View>
                  {picked === key ? <Check size={20} /> : null}
                </Pressable>
              );
            })}
          </Card>
        </View>

        <View style={styles.warn}>
          <Text style={[type.caption, { color: colors.pillText, letterSpacing: 0 }]}>{T('moveWarn')}</Text>
        </View>

        {busy ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <Spinner />
            <Text style={[type.sub, { color: colors.muted }]}>{step === 'checking' ? T('moveChecking') : T('moveWorking')}</Text>
          </View>
        ) : (
          <Button title={T('moveButton')} onPress={confirm} disabled={!picked} />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 62, paddingHorizontal: 14, paddingVertical: 8 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  warn: { padding: 12, borderRadius: radius.lg, backgroundColor: colors.pillBg, borderWidth: 1, borderColor: colors.pillBorder },
});
