import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import { useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { Back, Button, Label, Lock } from '../src/components/ui';

const REPO = 'https://github.com/yakubilik/remote-ai-chat';
const TAILSCALE = 'https://tailscale.com/download';

const INSTALL = 'git clone ' + REPO + '.git\ncd remote-ai-chat/daemon && ./install.sh';

/** A command you are meant to run somewhere else. Tapping it copies — the
 *  phone is not where it runs, so the only useful thing the box can do is
 *  hand it over. */
function Command({ text, copied, label }: { text: string; copied: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        void Clipboard.setStringAsync(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
      style={styles.cmd}
    >
      <Text style={[type.mono, { fontSize: 14, lineHeight: 21, color: colors.text }]}>{text}</Text>
      <Text style={[type.caption, { color: done ? colors.success : colors.muted, marginTop: 10 }]}>
        {done ? copied : label}
      </Text>
    </Pressable>
  );
}

function Link({ title, url }: { title: string; url: string }) {
  return (
    <Pressable onPress={() => void Linking.openURL(url)} hitSlop={8}>
      <Text style={[type.sub, { color: colors.accent }]}>{title} →</Text>
    </Pressable>
  );
}

/** What the pairing screen used to assume you already knew: that the agent
 *  runs on a computer, that a daemon has to be installed there, and that
 *  reaching it from the bus needs a private network between the two. */
export default function Welcome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const [step, setStep] = useState(0);

  const toPair = () => router.replace('/pair');

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={[styles.wrap, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}
    >
      <View style={{ gap: 10 }}>
        {step === 1 && (
          <Pressable onPress={() => setStep(0)} style={styles.back}><Back /></Pressable>
        )}
        <Label>{T(step === 0 ? 'welStep1' : 'welStep2')}</Label>
        <Text style={[type.largeTitle, { fontSize: 30, lineHeight: 36, color: colors.text }]}>
          {T(step === 0 ? 'welTitle1' : 'welTitle2')}
        </Text>
        <Text style={[type.body, { color: colors.muted }]}>{T(step === 0 ? 'welBody1' : 'welBody2')}</Text>
      </View>

      {step === 0 ? (
        <View style={{ gap: 14 }}>
          <Label>{T('welInstallLabel')}</Label>
          <Command text={INSTALL} label={T('welCopy')} copied={T('welCopied')} />
          <Text style={[type.caption, { color: colors.muted }]}>{T('welWindows')}</Text>
          <Link title={T('welDocs')} url={REPO} />
        </View>
      ) : (
        <View style={{ gap: 14 }}>
          <View style={styles.note}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Lock size={16} color={colors.success} />
              <Text style={[type.sub, { color: colors.text, flex: 1 }]}>{T('welPrivateTitle')}</Text>
            </View>
            <Text style={[type.caption, { color: colors.muted, marginTop: 8 }]}>{T('welPrivate')}</Text>
          </View>
          <Link title={T('welTailscale')} url={TAILSCALE} />
        </View>
      )}

      <View style={{ gap: 12 }}>
        <Button
          title={T(step === 0 ? 'welNext' : 'welStart')}
          onPress={() => (step === 0 ? setStep(1) : toPair())}
        />
        {step === 0 && (
          <Pressable onPress={toPair} hitSlop={8} style={{ alignItems: 'center', paddingVertical: 6 }}>
            <Text style={[type.caption, { color: colors.muted }]}>{T('welSkip')}</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 28, gap: 26, flexGrow: 1, justifyContent: 'space-between' },
  back: { alignSelf: 'flex-start', marginLeft: -12, width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  cmd: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, paddingHorizontal: 16, paddingVertical: 14,
  },
  note: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, paddingHorizontal: 16, paddingVertical: 14,
  },
});
