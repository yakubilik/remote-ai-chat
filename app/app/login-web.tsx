import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import { useStore, useT } from '../src/store';
import { colors, mono, radius, type } from '../src/theme';
import { Lock, Spinner } from '../src/components/ui';

/** Where the authorization code comes back. The CLI asks for `code=true`, so
 *  the service redirects here with the code in the query instead of handing it
 *  to a local server — which is why the phone can read it at all. */
const CALLBACK_HOST = 'platform.claude.com';
const CALLBACK_PATH = '/oauth/code/callback';

/** The code as the CLI wants it pasted: the authorization code, then the state
 *  it was issued against.
 *
 *  Matched on host and path, never as text inside the whole address: the
 *  authorize URL carries this very callback as its `redirect_uri`, and iOS
 *  hands back the address decoded — so a substring match fires on the sign-in
 *  page itself and reads `code=true` out of it. */
export function codeFromCallback(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.host !== CALLBACK_HOST || !u.pathname.startsWith(CALLBACK_PATH)) return null;
  const p = new URLSearchParams(
    u.search.replace(/^\?/, '') + '&' + u.hash.replace(/^#/, '').replace(/#/g, '&'));
  const code = p.get('code');
  // `code=true` is the CLI's own request flag, not an authorization code.
  if (!code || code === 'true' || code.length < 10) return null;
  const state = p.get('state');
  return state ? `${code}#${state}` : code;
}

/** Paths a sign-in passes through. Signing out inside the page — which is what
 *  you do when the wrong account is already signed in — navigates off the
 *  authorize URL and lands on the product itself (claude.com/new). No code can
 *  ever come back from there, and the screen used to sit and wait until the CLI
 *  gave up fifteen minutes later. Judged on the path alone, generously: a wrong
 *  guess only offers a button nobody has to press. */
const AUTH_MARKERS = ['oauth', 'login', 'log-in', 'signin', 'sign-in', 'auth', 'device',
  'verify', 'magic', 'consent', 'authorize', 'activate', 'callback', 'account',
  'onboarding', 'join'];

export function isSignInPage(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return true; }     // nothing to judge
  // about:blank and friends are what a WebView reports between pages.
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return true;
  const p = u.pathname.toLowerCase();
  if (p === '/' || p === '') return true;              // mid-redirect, no path yet
  return AUTH_MARKERS.some((m) => p.includes(m));
}

export default function LoginWeb() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { id, url, code: oneTime, email } =
    useLocalSearchParams<{ id: string; url: string; code?: string; email?: string }>();
  const { submitLoginCode } = useStore();
  const authorizeUrl = String(url);
  const [host, setHost] = useState(() => {
    try { return new URL(authorizeUrl).host; } catch { return ''; }
  });
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [strayed, setStrayed] = useState(false);
  // Bumping this remounts the WebView: back to the authorize URL, and with
  // `incognito` a brand-new empty cookie store — the only way to be offered the
  // sign-in form again once a session has been established inside the page.
  const [attempt, setAttempt] = useState(0);
  const sent = useRef(false);
  const web = useRef<WebView>(null);

  const restart = useCallback(() => {
    setStrayed(false);
    setAttempt((a) => a + 1);
  }, []);

  const onNav = useCallback((nav: WebViewNavigation) => {
    try { setHost(new URL(nav.url).host); } catch {}
    if (sent.current) return;
    const code = codeFromCallback(nav.url);
    if (code) {
      sent.current = true;
      setSending(true);
      submitLoginCode(String(id), code)
        .catch(() => {})
        .finally(() => router.back());       // the result arrives as login.done
      return;
    }
    // Only once a page has settled: a redirect chain passes through addresses
    // that mean nothing on their own.
    if (!nav.loading) setStrayed(!isSignInPage(nav.url));
  }, [id, router, submitLoginCode]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <View style={styles.bar}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.iconBtn}>
          <Text style={[type.sub, { color: colors.accent }]}>{T('cancel')}</Text>
        </Pressable>
        <View style={styles.host}>
          <Lock size={13} color={colors.muted} />
          <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 12, color: colors.muted }}>{host}</Text>
        </View>
        <Pressable onPress={restart} hitSlop={10} style={styles.iconBtn}>
          <Text style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>{T('loginRestart')}</Text>
        </Pressable>
      </View>

      {/* `incognito`, never shared cookies: the phone is signed in to the
          service as somebody already, and the authorize page honours that
          session without ever showing a form — so a second account came back
          as the first one, with the address only ever a form pre-fill. A
          private store makes the sign-in ask who is signing in. */}
      <WebView key={attempt} ref={web} source={{ uri: authorizeUrl }} incognito
        onNavigationStateChange={onNav}
        style={{ flex: 1, backgroundColor: '#fff' }}
        startInLoadingState renderLoading={() => (
          <View style={styles.loading}><Spinner size={18} /></View>
        )} />

      {oneTime ? (
        // Codex signs in with a one-time code typed into the page. It stays in
        // front of the user the whole time, one tap from the clipboard.
        <View style={[styles.codeBar, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>{T('loginTypeThisCode')}</Text>
          <Pressable onPress={() => { void Clipboard.setStringAsync(String(oneTime)); setCopied(true); setTimeout(() => setCopied(false), 1600); }}
            style={styles.codeRow}>
            <Text style={{ fontFamily: mono, fontSize: 26, letterSpacing: 4, color: colors.text, flex: 1 }}>{oneTime}</Text>
            <View style={styles.copyPill}>
              <Text style={[type.caption, { color: colors.pillText, letterSpacing: 0 }]}>{copied ? T('copied') : T('copy')}</Text>
            </View>
          </Pressable>
        </View>
      ) : sending ? (
        <View style={styles.veil}>
          <Spinner size={26} />
          <Text style={[type.headline, { color: colors.text }]}>{T('loginCodeCaught')}</Text>
          <Text style={[type.caption, { color: colors.muted }]}>{T('loginFinishing')}</Text>
        </View>
      ) : strayed ? (
        <View style={[styles.foot, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={[type.caption, { color: colors.muted, letterSpacing: 0, flex: 1 }]}>{T('loginStrayed')}</Text>
          <Pressable onPress={restart} style={styles.returnPill}>
            <Text style={[type.caption, { color: colors.pillText, letterSpacing: 0 }]}>{T('loginReturn')}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={[styles.foot, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>
            {email ? T('loginPickAccount').replace('{e}', String(email)) : T('loginWebHint')}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 10 },
  iconBtn: { minWidth: 66, height: 44, alignItems: 'center', justifyContent: 'center' },
  host: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 0 },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface },
  returnPill: { height: 34, paddingHorizontal: 14, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.pillBg, borderWidth: 1, borderColor: colors.pillBorder },
  codeBar: { paddingHorizontal: 16, paddingTop: 14, gap: 10, backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.lg,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.pillBorder },
  copyPill: { height: 32, paddingHorizontal: 12, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.pillBg, borderWidth: 1, borderColor: colors.pillBorder },
  veil: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 12,
    paddingHorizontal: 40, backgroundColor: 'rgba(15,14,12,0.94)' },
});
