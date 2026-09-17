import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { Button, Card, Label, OptionList, Row, Segmented } from '../src/components/ui';
import { ProviderPicker, FolderPicker, GroupPicker } from '../src/components/pickers';
import type { Provider } from '../src/protocol';

export default function NewChat() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const projectsLoaded = useStore((st) => st.projectsLoaded);
  const { catalog, defaults, projects, groups, loadProjects, createChat, setDefaults, prefs, authenticate } = useStore();
  const [provider, setProvider] = useState<Provider>(defaults.provider);
  const [model, setModel] = useState(defaults.model);
  const [effort, setEffort] = useState<string | null>(defaults.effort);
  const [perm, setPerm] = useState(defaults.perm_mode);
  const [cwd, setCwd] = useState<string | null>(defaults.cwd);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void loadProjects().catch(() => {}); }, [loadProjects]);
  const cat = catalog?.[provider];
  useEffect(() => {
    if (!cat) return;
    if (!cat.models.some((m) => m.id === model)) setModel(cat.models[0].id);
    if (effort && !cat.efforts.includes(effort)) setEffort(cat.efforts[0] ?? null);
    if (!cat.perm_modes.includes(perm)) setPerm(cat.perm_modes[0]);
  }, [cat]); // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveCwd = cwd || projects[0]?.path || null;

  async function choosePerm(p: string) {
    if (p === 'bypass' && prefs.faceIdBypass) {
      const ok = await authenticate(T('bypassAuth'));
      if (!ok) return;
    }
    setPerm(p);
  }

  async function start() {
    setBusy(true);
    try {
      const chat = await createChat({ provider, model, effort: effort ?? undefined, perm_mode: perm, cwd: effectiveCwd ?? undefined, group_id: groupId ?? undefined, account_id: defaults.byProvider?.[provider]?.account_id ?? undefined } as any);
      void setDefaults({ provider, model, effort: effort ?? 'high', perm_mode: perm, cwd: effectiveCwd });
      router.replace(`/chat/${chat.id}`);
    } catch (e: any) {
      Alert.alert(T('couldNotStart'), e.message);
    } finally { setBusy(false); }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={styles.handle} />
      <View style={styles.head}>
        <Text style={[type.title, { color: colors.text }]}>{T('newChat')}</Text>
        <Pressable onPress={() => router.back()}><Text style={[type.body, { color: colors.muted }]}>{T('cancel')}</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 22, paddingBottom: insets.bottom + 24 }}>
        <View style={{ gap: 8 }}><Label>{T('tool')}</Label><ProviderPicker value={provider} onChange={setProvider} /></View>
        {cat && (
          <>
            <View style={{ gap: 8 }}><Label>{T('model')}</Label><OptionList options={cat.models} value={model} onChange={setModel} /></View>
            {cat.efforts.length > 0 && (
              <View style={{ gap: 8 }}><Label>{T('effort')}</Label><Segmented options={cat.efforts} value={effort} onChange={setEffort} labels={{ medium: 'med' }} /></View>
            )}
            <View style={{ gap: 8 }}><Label>{T('permMode')}</Label><Segmented options={cat.perm_modes} value={perm} onChange={choosePerm} labels={{ 'accept-edits': 'edits', 'auto-edit': 'edit', 'full-auto': 'auto' }} /></View>
          </>
        )}
        <Card style={{ backgroundColor: colors.bg }}>
          <FolderPicker value={effectiveCwd} projects={projects} loading={!projectsLoaded} onChange={setCwd} />
          <GroupPicker value={groupId} groups={groups} onChange={setGroupId} last />
        </Card>
        <Button title={T('startChat')} onPress={start} disabled={busy || !cat || !effectiveCwd} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  handle: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(241,236,227,0.2)', marginTop: 10, marginBottom: 12 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 18 },
});
