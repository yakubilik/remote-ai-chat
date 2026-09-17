import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { Back, Button, Card, Check, Chevron, Label, LiveBars } from '../src/components/ui';
import type { Key } from '../src/i18n';
import type { Provider } from '../src/protocol';

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** Every method the computer offers has a name and a sentence here. An id the
 *  app has never heard of still shows, under its own id, rather than vanishing. */
const TITLE: Record<string, Key> = {
  subscription: 'mSubscription', console: 'mConsole', sso: 'mSso',
  api_key: 'mApiKey', device: 'mDevice', browser_here: 'mBrowserHere',
};
const BODY: Record<string, Key> = {
  subscription: 'mSubscriptionBody', console: 'mConsoleBody', sso: 'mSsoBody',
  api_key: 'mApiKeyBody', device: 'mDeviceBody', browser_here: 'mBrowserHereBody',
};

export default function LoginMethod() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { id, provider } = useLocalSearchParams<{ id: string; provider: Provider }>();
  const prov = (provider ?? 'claude') as Provider;
  const tools = useStore((s) => s.tools);
  const methods = tools.find((t) => t.provider === prov)?.login_methods ?? [];
  const [picked, setPicked] = useState<string>(methods[0]?.id ?? '');
  // The list belongs to the computer, and this screen is reachable before the
  // computer has answered — a cold launch, or straight after adding an account.
  // Without asking for it here the card stays empty and Continue has nothing
  // to continue to.
  const conn = useStore((s) => s.conn);
  const loadTools = useStore((s) => s.loadTools);
  useEffect(() => {
    if (!methods.length && conn === 'online') void loadTools().catch(() => {});
  }, [methods.length, conn, loadTools]);
  // A list that arrives late still has to end up on its first entry: the choice
  // above was made when there was nothing yet to choose.
  useEffect(() => {
    if (methods.length && !methods.some((m) => m.id === picked)) setPicked(methods[0].id);
  }, [methods, picked]);

  function go() {
    if (!picked) return;
    router.replace({ pathname: '/account-login', params: { id: id!, provider: prov, method: picked } });
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}><Back /></Pressable>
        <Text numberOfLines={1} style={[type.title, { color: colors.text, flex: 1 }]}>
          {T('loginTitle', { p: NAMES[prov] })}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 20, paddingBottom: insets.bottom + 32 }}>
        <Text style={[type.caption, { color: colors.muted }]}>{T('pickMethod')}</Text>

        {methods.length ? (
          <Card>
            {methods.map((m, i) => (
              <Pressable key={m.id} onPress={() => setPicked(m.id)}
                style={[styles.row, i < methods.length - 1 && styles.rowBorder, picked === m.id && { backgroundColor: colors.pillBg }]}>
                <View style={{ width: 20 }}>{picked === m.id ? <Check size={20} /> : null}</View>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <Text style={[type.sub, { color: colors.text, fontWeight: '500' }]}>
                    {TITLE[m.id] ? T(TITLE[m.id]) : m.id}
                  </Text>
                  {BODY[m.id] ? (
                    <Text style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>{T(BODY[m.id])}</Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </Card>
        ) : (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 }}>
              <LiveBars height={15} />
              <Text style={[type.sub, { color: colors.muted }]}>{T('wStarting')}</Text>
            </View>
          </Card>
        )}

        <View style={{ gap: 8 }}>
          <Label>{T('otherWay')}</Label>
          <Card>
            <Pressable onPress={() => router.replace({ pathname: '/move-signin', params: { provider: prov, id: id! } })}
              style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={[type.sub, { color: colors.accent }]}>{T('moveFromAnother')}</Text>
              </View>
              <Chevron />
            </Pressable>
          </Card>
        </View>

        <Button title={T('continueBtn')} onPress={go} disabled={!picked} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 20, paddingBottom: 14 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, padding: 14, borderRadius: radius.md },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border2, borderRadius: 0 },
});
