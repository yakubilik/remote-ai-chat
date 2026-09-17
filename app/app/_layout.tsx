import React, { useEffect, useRef } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { useStore, useT } from '../src/store';
import { client } from '../src/ws';
import { colors, type } from '../src/theme';
import { Lock } from '../src/components/ui';
import { getOpenChat, registerForPush } from '../src/push';

export default function RootLayout() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const locked = useStore((s) => s.locked);
  const unlock = useStore((s) => s.unlock);
  const lock = useStore((s) => s.lock);
  const setPushToken = useStore((s) => s.setPushToken);
  const router = useRouter();
  const bg = useRef<number | null>(null);
  const T = useT();

  useEffect(() => {
    void init();
    void registerForPush().then((t) => t && setPushToken(t));
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        client.poke();
        // re-lock after 60s in background
        if (bg.current && Date.now() - bg.current > 60_000) lock();
        bg.current = null;
      } else if (st === 'background') {
        bg.current = Date.now();
      }
    });
    const tap = Notifications.addNotificationResponseReceivedListener((r) => {
      const cid = (r.notification.request.content.data as any)?.chat_id;
      if (!cid) return;
      // The tap only brought the app forward — we are already reading this chat.
      if (getOpenChat() === cid) return;
      // A notification is a jump somewhere else, not a step deeper into wherever
      // the user happened to be. Pushing left the previous chat underneath, so
      // Back walked into *that* chat instead of leaving. Land on the tapped chat
      // with the list behind it.
      try { if (router.canDismiss()) router.dismissTo('/chats'); } catch {}
      router.push(`/chat/${cid}`);
    });
    return () => { sub.remove(); tap.remove(); };
  }, [init, setPushToken, lock, router]);

  useEffect(() => { if (ready && locked) void unlock(); }, [ready, locked, unlock]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'default' }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="pair" />
        <Stack.Screen name="chats" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="new-chat" options={{ presentation: 'modal' }} />
        <Stack.Screen name="chat-settings" options={{ presentation: 'modal' }} />
        <Stack.Screen name="model-sheet" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.7, 1], sheetGrabberVisible: false, sheetCornerRadius: 22, contentStyle: { backgroundColor: colors.surface } }} />
        {/* The computer list is a handful of rows, so the sheet hugs it: a fixed
            detent both left dead space below and clipped the last row mid-height. */}
        <Stack.Screen name="host-sheet" options={{ presentation: 'formSheet', sheetAllowedDetents: 'fitToContents', sheetGrabberVisible: true, sheetCornerRadius: 22, contentStyle: { backgroundColor: colors.surface } }} />
        <Stack.Screen name="settings" />
        <Stack.Screen name="agents" />
        <Stack.Screen name="agent-store" />
        <Stack.Screen name="agent-install" />
        <Stack.Screen name="accounts" />
        <Stack.Screen name="account-login" options={{ presentation: 'modal' }} />
      </Stack>
      {ready && locked && (
        <View style={styles.lock}>
          <Lock size={28} />
          <Text style={[type.title, { color: colors.text, marginTop: 16 }]}>{T('locked')}</Text>
          <Pressable onPress={unlock} style={styles.lockBtn}><Text style={[type.headline, { color: colors.white }]}>{T('unlockBtn')}</Text></Pressable>
        </View>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  lock: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  lockBtn: { marginTop: 24, height: 52, paddingHorizontal: 28, borderRadius: 14, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
});
