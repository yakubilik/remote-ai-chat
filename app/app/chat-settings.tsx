import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { Button, Card, Label, OptionList, Segmented } from '../src/components/ui';
import { FolderPicker, GroupPicker, ProviderPicker } from '../src/components/pickers';
import type { Provider } from '../src/protocol';

export default function ChatSettings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const projectsLoaded = useStore((st) => st.projectsLoaded);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { chats, catalog, projects, groups, loadProjects, updateChat, deleteChat, prefs, authenticate, setDefaults } = useStore();
  const chat = chats[id!];
  const [provider, setProvider] = useState<Provider>(chat?.provider ?? 'claude');
  const cat = catalog?.[provider] ?? null;
  const [title, setTitle] = useState(chat?.title ?? '');
  const [model, setModel] = useState(chat?.model ?? '');
  const [effort, setEffort] = useState<string | null>(chat?.effort ?? null);
  const [perm, setPerm] = useState(chat?.perm_mode ?? 'ask');
  const [cwd, setCwd] = useState<string | null>(chat?.cwd ?? null);
  const [groupId, setGroupId] = useState<string | null>(chat?.group_id ?? null);
  const [maxTurns, setMaxTurns] = useState(chat?.max_turns ? String(chat.max_turns) : '');
  const [budget, setBudget] = useState(chat?.max_budget_usd ? String(chat.max_budget_usd) : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { void loadProjects().catch(() => {}); }, [loadProjects]);
  useEffect(() => {
    if (!cat || provider === chat?.provider) return;
    setModel(cat.models[0].id); setEffort(cat.efforts[0] ?? null); setPerm(cat.perm_modes[0]);
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!chat) return null;

  async function choosePerm(p: string) {
    if (p === 'bypass' && prefs.faceIdBypass) {
      const ok = await authenticate(T('bypassAuth'));
      if (!ok) return;
    }
    setPerm(p);
  }

  async function save() {
    setSaving(true);
    try {
      await updateChat(chat!.id, {
        provider, model, effort, perm_mode: perm, cwd: cwd ?? undefined, group_id: groupId,
        title: title.trim().slice(0, 60) || chat!.title,
        max_turns: maxTurns.trim() ? Number(maxTurns) : null,
        max_budget_usd: budget.trim() ? Number(budget) : null,
      } as any);
      void setDefaults({ provider, model, effort: effort ?? 'high', perm_mode: perm, cwd: cwd ?? undefined });
      router.back();
    } catch (e: any) { Alert.alert(T('couldNotSave'), e.message); }
    finally { setSaving(false); }
  }
  function remove() {
    Alert.alert(T('deleteChat'), T('deleteChatBody'), [
      { text: T('cancel'), style: 'cancel' },
      { text: T('delete'), style: 'destructive', onPress: async () => { await deleteChat(chat!.id); router.dismissAll(); router.replace('/chats'); } },
    ]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={styles.handle} />
      <View style={styles.head}>
        <Text style={[type.title, { color: colors.text, flex: 1 }]}>{T('chatSettings')}</Text>
        <Pressable onPress={() => router.back()}><Text style={[type.body, { color: colors.muted }]}>{T('cancel')}</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 22, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 8 }}>
          <Label>{T('titleLabel')}</Label>
          <TextInput value={title} onChangeText={setTitle} placeholder={T('chatName')} placeholderTextColor={colors.faint} style={styles.input} />
        </View>
        <View style={{ gap: 8 }}><Label>{T('tool')}</Label><ProviderPicker value={provider} onChange={setProvider} /></View>
        {cat && (
          <>
            <View style={{ gap: 8 }}><Label>{T('model')}</Label><OptionList options={cat.models} value={model} onChange={setModel} /></View>
            {cat.efforts.length > 0 && <View style={{ gap: 8 }}><Label>{T('effort')}</Label><Segmented options={cat.efforts} value={effort} onChange={setEffort} labels={{ medium: 'med' }} /></View>}
            <View style={{ gap: 8 }}><Label>{T('permMode')}</Label><Segmented options={cat.perm_modes} value={perm} onChange={choosePerm} labels={{ 'accept-edits': 'edits', 'auto-edit': 'edit', 'full-auto': 'auto' }} /></View>
          </>
        )}
        <Card style={{ backgroundColor: colors.bg }}>
          <FolderPicker value={cwd} projects={projects} loading={!projectsLoaded} onChange={setCwd} />
          <GroupPicker value={groupId} groups={groups} onChange={setGroupId} last />
        </Card>
        <View style={{ gap: 8 }}>
          <Label>{T('limits')}</Label>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <TextInput value={maxTurns} onChangeText={setMaxTurns} placeholder={T('unlimited')} placeholderTextColor={colors.faint} keyboardType="number-pad" style={styles.input} />
              <Text style={[type.caption, { color: colors.muted }]}>{T('maxTurns')}</Text>
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <TextInput value={budget} onChangeText={setBudget} placeholder={T('unlimited')} placeholderTextColor={colors.faint} keyboardType="decimal-pad" style={styles.input} editable={provider === 'claude'} />
              <Text style={[type.caption, { color: colors.muted }]}>{provider === 'claude' ? T('maxBudget') : T('budgetClaudeOnly')}</Text>
            </View>
          </View>
        </View>
        <Text style={[type.caption, { color: colors.muted }]}>
          {T('sessionInfo', { id: chat.provider_session_id ? chat.provider_session_id.slice(0, 8) : T('notYet'), cost: chat.total_cost_usd.toFixed(2) })}
        </Text>
        <Button title={T('save')} onPress={save} disabled={saving} />
        <Button title={T('deleteChat')} kind="danger" onPress={remove} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  handle: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(241,236,227,0.2)', marginTop: 10, marginBottom: 12 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 20, paddingBottom: 18 },
  input: { height: 48, borderRadius: radius.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, color: colors.text, fontSize: 16 },
});
