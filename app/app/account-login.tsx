import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { errText } from '../src/i18n';
import { useStore, useT } from '../src/store';
import { colors, radius, type, mono } from '../src/theme';
import { Back, Button, Check, LiveBars } from '../src/components/ui';
import type { Provider } from '../src/protocol';

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

export default function AccountLogin() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { id, provider, method } = useLocalSearchParams<{ id: string; provider: Provider; method?: string }>();
  const { loginPrompt, loginDone, startLogin, submitLoginCode, cancelLogin } = useStore();
  const submitting = useStore((st) => st.loginSubmitting);
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [apiKey, setApiKey] = useState('');
  // What this method needs from the phone before it can start: an address to
  // pre-fill, a key to send, or nothing at all.
  const tools = useStore((st) => st.tools);
  const spec = tools.find((t) => t.provider === (provider ?? 'claude'))
    ?.login_methods?.find((m) => m.id === (method || ''));
  const needsKey = !!spec?.needs_key;
  const needsEmail = !needsKey && (spec ? !!spec.wants_email : (provider ?? 'claude') === 'claude');

  // The computer runs the sign-in; the phone only supplies the address and
  // hands back the code. Each run produces a fresh link, so a link that has
  // gone stale is fixed by starting again rather than by reloading the page.
  async function begin() {
    setFailed(null); setCode(''); setStarted(true);
    try { await startLogin(id!, { email: email.trim() || undefined, method, api_key: apiKey.trim() || undefined }); }
    catch (e: any) { setFailed(e.message); setStarted(false); }
  }
  // Only the account may re-run this. Adding any changing value to the list
  // makes React run the previous cleanup, and that cleanup cancels the sign-in
  // that has just started.
  useEffect(() => {
    if (!needsEmail && !needsKey) void begin();
    return () => { void cancelLogin(id!); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loginDone && !loginDone.ok) setFailed(errText(loginDone.error_code, loginDone.error));
  }, [loginDone, T]);
  // A success needs a beat to be read, then gets out of the way on its own.
  useEffect(() => {
    if (loginDone?.account_id !== id || !loginDone?.ok) return;
    const t = setTimeout(() => router.back(), 1400);
    return () => clearTimeout(t);
  }, [loginDone?.account_id, loginDone?.ok, id]);

  const prompt = loginPrompt?.account_id === id ? loginPrompt : null;
  // The sign-in page opens inside the app: the service sends the authorization
  // code back to a callback URL, so the app can read it off the address bar and
  // the code never has to be carried by hand. Codex has no such page — it shows
  // a device code instead — so it is left alone.
  const opened = useRef<string | null>(null);
  const openPage = useCallback(() => {
    if (!prompt?.url) return;
    router.push({ pathname: '/login-web',
                  params: { id: id!, url: prompt.url,
                            ...(prompt.code ? { code: prompt.code } : {}),
                            // which account to pick, for a page that no longer
                            // knows: the sign-in opens with an empty cookie jar
                            ...(email.trim() ? { email: email.trim() } : {}) } });
  }, [prompt?.url, prompt?.code, id, email]);
  // Codex needs its one-time code on screen before the page is any use, so it
  // waits for the code; Claude has nothing to wait for.
  useEffect(() => {
    if (!prompt?.url || opened.current === prompt.url) return;
    if (!prompt.needs_code && !prompt.code) return;
    opened.current = prompt.url;
    openPage();
  }, [prompt?.url, prompt?.needs_code, prompt?.code, openPage]);
  const done = loginDone?.account_id === id ? loginDone : null;

  /** The e-mailed code is short and usually digits; the authorization code the
   *  page hands back is long. Catch the mix-up before it burns the session. */
  function looksLikeEmailCode(v: string): boolean {
    const t = v.trim();
    return t.length < 20 || /^[0-9\s-]+$/.test(t);
  }

  async function send() {
    if (!code.trim()) return;
    if (looksLikeEmailCode(code)) {
      Alert.alert(T('wrongCodeTitle'), T('wrongCodeBody'), [
        { text: T('cancel'), style: 'cancel' },
        { text: T('sendAnyway'), onPress: () => void submit() },
      ]);
      return;
    }
    await submit();
  }

  async function submit() {
    setBusy(true);
    try { await submitLoginCode(id!, code.trim()); }
    catch (e: any) { Alert.alert(T('error'), e.message); }
    finally { setBusy(false); }
  }

  /** Adding an account now lands straight on its default sign-in, so the list
   *  of methods has to stay reachable from here — console keys and SSO are the
   *  whole reason it exists. */
  function otherWay() {
    return (
      <Pressable onPress={() => router.replace({ pathname: '/login-method',
                                                 params: { id: id!, provider: provider ?? 'claude' } })}
        hitSlop={8} style={{ alignSelf: 'center', paddingVertical: 6 }}>
        <Text style={[type.caption, { color: colors.accent, letterSpacing: 0 }]}>{T('otherWay')}</Text>
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}><Back /></Pressable>
        <Text numberOfLines={1} style={[type.title, { color: colors.text, flex: 1 }]}>
          {T('loginTitle', { p: NAMES[provider ?? 'claude'] })}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 18, paddingBottom: insets.bottom + 32 }}>
        {done?.ok ? (
          <View style={[styles.card, { borderColor: colors.success }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Check size={22} color={colors.success} />
              <View style={{ flex: 1 }}>
                <Text style={[type.headline, { color: colors.text }]}>{T('loginOk')}</Text>
                <Text numberOfLines={1} style={[type.caption, { color: colors.muted }]}>{done.detail}</Text>
              </View>
            </View>
            <Button title={T('loginDone')} onPress={() => router.back()} />
          </View>
        ) : failed ? (
          <View style={styles.card}>
            <Text style={[type.headline, { color: colors.text }]}>{T('loginFailed')}</Text>
            <Text style={[type.sub, { color: colors.muted }]}>{failed}</Text>
            <Button title={T('tryAgain')} onPress={() => {
              setFailed(null);
              // Tools that sign in by address ask for it again; the others just go.
              if (needsEmail) setStarted(false); else void begin();
            }} />
          </View>
        ) : needsKey && !started ? (
          <View style={styles.card}>
            <Text style={[type.sub, { color: colors.muted }]}>{T('keyHint')}</Text>
            <TextInput value={apiKey} onChangeText={setApiKey} placeholder={T('keyPlaceholder')}
              placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false}
              secureTextEntry style={[styles.input, { fontFamily: mono }]} />
            <Button title={T('signIn')} onPress={begin} disabled={!apiKey.trim()} />
            <Text style={[type.caption, { color: colors.pillText, letterSpacing: 0 }]}>{T('keyWarn')}</Text>
            {otherWay()}
          </View>
        ) : needsEmail && !prompt && !started ? (
          <View style={styles.card}>
            <Text style={[type.sub, { color: colors.muted }]}>{T('loginEmailHint')}</Text>
            <TextInput value={email} onChangeText={setEmail} placeholder={T('loginEmail')}
              placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false}
              keyboardType="email-address" textContentType="emailAddress" style={styles.input} />
            <Button title={T('loginContinue')} onPress={begin} disabled={!email.trim()} />
            {otherWay()}
          </View>
        ) : !prompt ? (
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <LiveBars height={15} />
              <Text style={[type.sub, { color: colors.muted }]}>{T('wStarting')}</Text>
            </View>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={[type.sub, { color: colors.muted }]}>
              {prompt.needs_code ? T('loginPasteHint') : T('loginDeviceHint')}
            </Text>

            {!!prompt.url && !submitting && (
              <>
                <Button title={T('loginOpenHere')} onPress={openPage} />
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <Pressable onPress={() => { Clipboard.setStringAsync(prompt.url!); }} style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontFamily: mono, fontSize: 12, color: colors.faint }} numberOfLines={1}>
                      {prompt.url_host}
                    </Text>
                  </Pressable>
                  <Pressable onPress={begin}>
                    <Text style={[type.caption, { color: colors.accent, letterSpacing: 0 }]}>{T('loginNewLink')}</Text>
                  </Pressable>
                </View>
              </>
            )}

            {!!prompt.code && (
              <Pressable onPress={() => { void Clipboard.setStringAsync(prompt.code!); setCopied(true); setTimeout(() => setCopied(false), 1600); }}
                style={styles.codeBox}>
                <Text style={{ fontFamily: mono, fontSize: 26, letterSpacing: 4, color: colors.text }}>
                  {prompt.code}
                </Text>
                <Text style={[type.caption, { color: copied ? colors.success : colors.muted, letterSpacing: 0 }]}>
                  {copied ? T('copied') : T('tapToCopy')}
                </Text>
              </Pressable>
            )}

            {submitting ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <LiveBars height={15} />
                <Text style={[type.sub, { color: colors.muted }]}>{T('loginFinishing')}</Text>
              </View>
            ) : prompt.needs_code ? (
              <>
                <TextInput value={code} onChangeText={setCode} placeholder={T('loginCodeLabel')}
                  placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false}
                  style={styles.input} />
                <Button title={T('loginSubmit')} onPress={send} disabled={busy || !code.trim()} />
              </>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <LiveBars height={15} />
                <Text style={[type.sub, { color: colors.muted }]}>{T('loginWaiting')}</Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 20, paddingBottom: 14 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
          padding: 16, gap: 14 },
  codeBox: { minHeight: 72, paddingVertical: 10, gap: 4, borderRadius: radius.md, backgroundColor: colors.bg,
             borderWidth: 1, borderColor: colors.pillBorder, alignItems: 'center', justifyContent: 'center' },
  input: { height: 48, borderRadius: radius.md, backgroundColor: colors.bg, borderWidth: 1,
           borderColor: colors.border2, paddingHorizontal: 14, color: colors.text, fontFamily: mono, fontSize: 15 },
});
