import React, { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useStore, useT } from '../src/store';
import { colors, radius, type, mono } from '../src/theme';
import { Back, Button, Label, Lock, QrIcon } from '../src/components/ui';
import type { HostConfig } from '../src/protocol';

export default function Pair() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const addHost = useStore((s) => s.addHost);
  const hostCount = useStore((s) => s.hosts.length);
  const [perm, requestPerm] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8790');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const params = useLocalSearchParams<{ host?: string; port?: string; token?: string; name?: string; device_id?: string; add?: string }>();
  const adding = params.add === '1' || hostCount > 0;

  // Deep link: remoteaichat://pair?host=..&port=..&token=..  (QR alternatifi)
  useEffect(() => {
    if (params.host && params.token && !busy) {
      void finish({ host: String(params.host), port: Number(params.port) || 8790, token: String(params.token), name: String(params.name || params.host), device_id: params.device_id ? String(params.device_id) : undefined });
    }
  }, [params.host, params.token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function finish(cfg: HostConfig) {
    setBusy(true);
    try {
      await addHost(cfg);
      if (router.canGoBack()) router.dismissAll();
      router.replace('/chats');
    } finally { setBusy(false); }
  }

  /** Accepts what `remote-ai-chat pair` prints: the remoteaichat:// deep link,
   *  and the older JSON payload. */
  function parsePairCode(data: string): HostConfig | null {
    const text = (data || '').trim();
    if (text.startsWith('remoteaichat://')) {
      const q = text.slice(text.indexOf('?') + 1);
      const p: Record<string, string> = {};
      for (const pair of q.split('&')) {
        const i = pair.indexOf('=');
        if (i > 0) p[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
      }
      if (!p.host || !p.token) return null;
      return { host: p.host, port: Number(p.port) || 8790, token: p.token, name: p.name || p.host, device_id: p.device_id };
    }
    try {
      const j = JSON.parse(text);
      if (!j.host || !j.token) return null;
      return { host: j.host, port: Number(j.port) || 8790, token: j.token, name: j.name || j.host, device_id: j.device_id };
    } catch {
      return null;
    }
  }

  function onScan({ data }: { data: string }) {
    if (busy) return;
    const cfg = parsePairCode(data);
    if (!cfg) {
      Alert.alert(T('pairBadCode'), T('pairBadCodeBody'));
      setScanning(false);
      return;
    }
    setScanning(false);
    void finish(cfg);
  }

  async function startScan() {
    if (!perm?.granted) {
      const r = await requestPerm();
      if (!r.granted) { setManual(true); return; }
    }
    setScanning(true);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={[styles.wrap, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 10 }}>
          {adding ? (
            <Pressable onPress={() => router.back()} style={{ alignSelf: 'flex-start', marginLeft: -12, width: 44, height: 44, justifyContent: 'center', alignItems: 'center' }}><Back /></Pressable>
          ) : <Label>{T('pairStep')}</Label>}
          <Text style={[type.largeTitle, { fontSize: 30, lineHeight: 36, color: colors.text }]}>{adding ? T('pairAddTitle') : T('pairTitle')}</Text>
          <Text style={[type.body, { color: colors.muted }]}>{T('pairSubtitle')}</Text>
        </View>
        <View style={styles.cmd}><Text style={[type.mono, { fontSize: 15, lineHeight: 22, color: colors.text }]}>remote-ai-chat pair</Text></View>

        {scanning ? (
          <View style={styles.camWrap}>
            <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
          </View>
        ) : (
          <Pressable onPress={startScan} style={styles.qrBox}>
            <QrIcon />
            <Text style={[type.caption, { color: colors.muted, marginTop: 10 }]}>{T('pairTapScan')}</Text>
          </Pressable>
        )}

        {manual && (
          <View style={{ gap: 10 }}>
            <Label>{T('pairManual')}</Label>
            <TextInput value={host} onChangeText={setHost} placeholder="100.x.x.x" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" style={styles.input} />
            <TextInput value={port} onChangeText={setPort} placeholder="8790" placeholderTextColor={colors.faint} keyboardType="number-pad" style={styles.input} />
            <TextInput value={token} onChangeText={setToken} placeholder="token" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} secureTextEntry style={styles.input} />
            <Button title={T('pairConnect')} disabled={busy || !host || !token} onPress={() => finish({ host: host.trim(), port: Number(port) || 8790, token: token.trim(), name: host.trim() })} />
          </View>
        )}

        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
            <Lock size={16} color={colors.success} />
            <Text style={[type.caption, { color: colors.muted }]}>{T('pairTailscale')}</Text>
          </View>
          {!manual && <Button title={T('pairManualBtn')} kind="secondary" onPress={() => setManual(true)} />}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 28, gap: 22, flexGrow: 1, justifyContent: 'space-between' },
  cmd: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 16, paddingVertical: 14 },
  qrBox: { alignSelf: 'center', width: 220, height: 220, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  camWrap: { alignSelf: 'center', width: 260, height: 260, borderRadius: radius.md, overflow: 'hidden', borderWidth: 2, borderColor: colors.accent },
  input: { height: 48, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, color: colors.text, fontFamily: mono, fontSize: 15 },
});
