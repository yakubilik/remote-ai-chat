import React, { useCallback, useEffect, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { Back, Card, Check, Dots, Label, ProviderMark, SkeletonRows, Spinner } from '../src/components/ui';
import type { CliAccount, Provider } from '../src/protocol';

const PROVIDERS: Provider[] = ['claude', 'codex'];
const NAMES: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

export default function Accounts() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { accounts, tools, npmAvailable, defaults, conn, loadAccounts, loadTools,
          createAccount, deleteAccount, logoutAccount, renameAccount, installTool, setDefaults } = useStore();
  const [installing, setInstalling] = useState<Provider | null>(null);
  const [creating, setCreating] = useState<Provider | null>(null);
  const accountsLoaded = useStore((s) => s.accountsLoaded);
  const loginPrompt = useStore((s) => s.loginPrompt);
  const busyLogin = useStore((s) => s.loginBusy);

  const reload = useCallback(() => {
    if (conn !== 'online') return;
    void loadAccounts().catch(() => {});
    void loadTools().catch(() => {});
  }, [conn, loadAccounts, loadTools]);
  useFocusEffect(reload);
  useEffect(reload, [reload]);

  /** Two sign-ins at once produce two browser sessions racing for one pty, and
   *  the second one's code lands in the wrong place. */
  function signIn(a: CliAccount, provider: Provider) {
    if (loginPrompt || busyLogin) { Alert.alert(T('accountOptions'), T('loginBusy')); return; }
    router.push({ pathname: '/login-method', params: { id: a.id, provider } });
  }

  /** The name is the only thing anybody types here, so a name already taken
   *  asks again with it still in the box rather than dropping it behind an
   *  alert. Once the account exists the sign-in starts on its own: adding an
   *  account is only ever the first half of signing one in, and the method
   *  list was a tap that landed on its own first entry nearly every time.
   *  It stays one tap away on the next screen. */
  function add(provider: Provider, typed = '') {
    Alert.prompt(T('accountName'), T('accountNameHint'), async (name) => {
      const label = (name || '').trim();
      try {
        if (loginPrompt || busyLogin) { Alert.alert(T('accountOptions'), T('loginBusy')); return; }
        setCreating(provider);
        let a: CliAccount;
        try { a = await createAccount(provider, label); }
        finally { setCreating(null); }
        const method = tools.find((t) => t.provider === provider)?.login_methods?.[0]?.id;
        router.push(method
          ? { pathname: '/account-login', params: { id: a.id, provider, method } }
          : { pathname: '/login-method', params: { id: a.id, provider } });
      } catch (e: any) {
        if (e?.code === 'duplicate_label') {
          Alert.alert(T('nameTaken'), e.message, [
            { text: T('cancel'), style: 'cancel' },
            { text: T('tryAgain'), onPress: () => add(provider, label) },
          ]);
          return;
        }
        Alert.alert(T('error'), e.message);
      }
    }, 'plain-text', typed);
  }

  const err = (e: any) => Alert.alert(T('error'), e?.message ?? '');

  /** Everything you can do to one account. The computer's own account is not
   *  ours to rename or delete — it is the login the machine already had. */
  function options(a: CliAccount) {
    const label = a.is_default ? T('useDefaultAccount') : a.label;
    const acts: { text: string; run: () => void; danger?: boolean }[] = [
      { text: T('makeDefault'), run: () => void setDefaults({ byProvider: { [a.provider]: { account_id: a.id } } } as any).catch(err) },
    ];
    if (!a.is_default) {
      acts.push({ text: T('renameAccount'), run: () => rename(a) });
    }
    if (a.logged_in) {
      acts.push({ text: T('signOut'), run: () => confirmSignOut(a) });
    }
    if (!a.is_default) {
      acts.push({ text: T('deleteAccount'), danger: true, run: () => confirmDelete(a) });
    }
    const opts = [...acts.map((x) => x.text), T('cancel')];
    const run = (i: number) => { if (i < acts.length) acts[i].run(); };
    const danger = acts.findIndex((x) => x.danger);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: opts, cancelButtonIndex: opts.length - 1,
          destructiveButtonIndex: danger >= 0 ? danger : undefined,
          title: label, message: a.logged_in ? a.detail : T('notSignedIn'), userInterfaceStyle: 'dark' }, run);
    } else {
      Alert.alert(label, a.detail, [...acts.map((x, i) => ({ text: x.text, style: (x.danger ? 'destructive' : 'default') as any, onPress: () => run(i) })),
        { text: T('cancel'), style: 'cancel' as any }]);
    }
  }

  function rename(a: CliAccount) {
    Alert.prompt(T('renameAccountTitle'), undefined, (name) => {
      const v = (name || '').trim();
      if (!v || v === a.label) return;
      renameAccount(a.id, v).catch(err);
    }, 'plain-text', a.label);
  }

  function confirmSignOut(a: CliAccount) {
    Alert.alert(T('signOutAccount'), T('signOutBody'), [
      { text: T('cancel'), style: 'cancel' },
      { text: T('signOut'), style: 'destructive', onPress: () => logoutAccount(a.id).catch(err) },
    ]);
  }

  function confirmDelete(a: CliAccount) {
    if (a.is_default) return;
    Alert.alert(T('removeAccount'), T('removeAccountBody'), [
      { text: T('cancel'), style: 'cancel' },
      { text: T('remove'), style: 'destructive', onPress: () => deleteAccount(a.id).catch(err) },
    ]);
  }

  async function install(provider: Provider) {
    setInstalling(provider);
    try { await installTool(provider); }
    catch (e: any) { Alert.alert(T('error'), e.message); }
    finally { setInstalling(null); }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}><Back /></Pressable>
        <Text style={[type.largeTitle, { color: colors.text }]}>{T('accounts')}</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 22, paddingBottom: insets.bottom + 32 }}>
        {PROVIDERS.map((p) => {
          const tool = tools.find((t) => t.provider === p);
          const missing = tool ? !tool.version : false;
          const list = accounts.filter((a) => a.provider === p);
          return (
            <View key={p} style={{ gap: 8 }}>
              <Label>{NAMES[p]}</Label>

              {missing ? (
                <Card>
                  <View style={styles.row}>
                    <Text style={[type.sub, { color: colors.muted, flex: 1 }]}>{T('cliMissing', { p: NAMES[p] })}</Text>
                    {npmAvailable ? (
                      <Pressable onPress={() => install(p)} disabled={!!installing} style={styles.pillBtn}>
                        {installing === p ? <Spinner size={14} /> : null}
                        <Text style={[type.caption, { color: colors.pillText, letterSpacing: 0 }]}>
                          {installing === p ? T('installing') : T('install')}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {!npmAvailable && (
                    <Text style={[type.caption, { color: colors.faint, paddingHorizontal: 14, paddingBottom: 12 }]}>
                      {T('needNode')}
                    </Text>
                  )}
                </Card>
              ) : null}

              <Card>
                {!accountsLoaded && (conn === 'online' || conn === 'connecting') ? (
                  <SkeletonRows rows={2} minHeight={60} markSize={26} markRadius={6} paddingHorizontal={14} />
                ) : (
                  <>
                {list.map((a, i) => {
                  const chosen = defaults.byProvider?.[p]?.account_id ?? null;
                  const isDefault = chosen === a.id || (!chosen && a.is_default);
                  return (
                    <Pressable key={a.id}
                      onPress={() => setDefaults({ byProvider: { ...(defaults.byProvider ?? {}),
                        [p]: { ...(defaults.byProvider?.[p] ?? { model: '', effort: null, perm_mode: '' }),
                               account_id: a.is_default ? null : a.id } } })}
                      onLongPress={() => options(a)}
                      style={[styles.row, i < list.length - 1 && styles.rowBorder]}>
                      <ProviderMark provider={p} size={24} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={[type.sub, { color: a.logged_in ? colors.text : colors.muted, fontWeight: '500' }]}>{a.is_default ? T('useDefaultAccount') : a.label}</Text>
                        <Text numberOfLines={1} style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>
                          {a.logged_in ? a.detail : T('notSignedIn')}
                        </Text>
                      </View>
                      {a.logged_in
                        ? (isDefault ? <Check size={20} /> : null)
                        : (
                          <Pressable onPress={() => signIn(a, p)} style={styles.pillBtn}>
                            <Text style={[type.caption, { color: colors.pillText, letterSpacing: 0 }]}>{T('signIn')}</Text>
                          </Pressable>
                        )}
                      <Pressable onPress={() => options(a)} hitSlop={8} style={styles.dots}><Dots /></Pressable>
                    </Pressable>
                  );
                })}
                <Pressable onPress={() => add(p)} disabled={!!creating} style={[styles.row, styles.rowBorderTop]}>
                  {creating === p ? <Spinner size={14} /> : null}
                  <Text style={[type.sub, { color: colors.accent }]}>
                    {creating === p ? T('creatingAccount') : `+ ${T('addAccount', { p: NAMES[p] })}`}
                  </Text>
                </Pressable>
                <Pressable onPress={() => router.push({ pathname: '/move-signin', params: { provider: p } })} style={[styles.row, styles.rowBorderTop]}>
                  <Text style={[type.sub, { color: colors.accent }]}>{T('moveFromAnother')}</Text>
                </Pressable>
                  </>
                )}
              </Card>
            </View>
          );
        })}

        <Text style={[type.caption, { color: colors.muted }]}>{T('accountsHint')}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 20, paddingBottom: 18 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { minHeight: 60, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
  dots: { width: 30, height: 40, alignItems: 'flex-end', justifyContent: 'center' },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border2 },
  rowBorderTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border2, minHeight: 48 },
  pillBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 15,
             backgroundColor: colors.pillBg, borderWidth: 1, borderColor: colors.pillBorder },
});
