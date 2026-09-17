import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, useT } from '../src/store';
import { colors, type } from '../src/theme';
import { Label, OptionList, Segmented } from '../src/components/ui';
import { ProviderPicker } from '../src/components/pickers';
import type { Provider, ProviderDefaults } from '../src/protocol';

/** Bottom sheet (design/ModelSheet.dc.html). With `id` it edits that chat and applies
 *  immediately; without it (`defaults=1`) it edits the defaults used by the pen button. */
export default function ModelSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { id, defaults: defaultsMode } = useLocalSearchParams<{ id?: string; defaults?: string }>();
  const editingDefaults = defaultsMode === '1' || !id;
  const chat = useStore((s) => (id ? s.chats[id] : undefined));
  const catalog = useStore((s) => s.catalog);
  const defaults = useStore((s) => s.defaults);
  const updateChat = useStore((s) => s.updateChat);
  const setDefaults = useStore((s) => s.setDefaults);
  const prefs = useStore((s) => s.prefs);
  const authenticate = useStore((s) => s.authenticate);
  const accounts = useStore((s) => s.accounts);
  const loadAccounts = useStore((s) => s.loadAccounts);
  useEffect(() => { void loadAccounts().catch(() => {}); }, [loadAccounts]);

  const initial = editingDefaults
    ? { provider: defaults.provider, model: defaults.model, effort: defaults.effort as string | null, perm: defaults.perm_mode }
    : { provider: chat?.provider ?? 'claude', model: chat?.model ?? '', effort: chat?.effort ?? null, perm: chat?.perm_mode ?? 'ask' };
  const [provider, setProvider] = useState<Provider>(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState<string | null>(initial.effort);
  const [perm, setPerm] = useState(initial.perm);
  const cat = catalog?.[provider] ?? null;
  // Only signed-in accounts can run a chat; the computer's own login is always offered.
  const accountsFor = accounts.filter((a) => a.provider === provider && (a.logged_in || a.is_default));

  function onAccount(accountId: string | null) {
    if (editingDefaults) {
      const d = defaults.byProvider?.[provider] ?? { model, effort, perm_mode: perm };
      void setDefaults({ byProvider: { ...(defaults.byProvider ?? {}), [provider]: { ...d, account_id: accountId } } });
      return;
    }
    updateChat(id!, { account_id: accountId } as any).catch((e) => Alert.alert(T('couldNotSave'), e.message));
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function remember(p: Provider, d: ProviderDefaults) {
    void setDefaults({ provider: p, model: d.model, effort: d.effort ?? 'high', perm_mode: d.perm_mode, byProvider: { ...(defaults.byProvider ?? {}), [p]: d } });
  }
  function apply(next: Partial<{ provider: Provider; model: string; effort: string | null; perm_mode: string }>) {
    const p = { provider, model, effort, perm_mode: perm, ...next };
    remember(p.provider, { model: p.model, effort: p.effort, perm_mode: p.perm_mode });
    if (editingDefaults) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => updateChat(id!, p as any).catch((e) => Alert.alert(T('couldNotSave'), e.message)), 250);
  }

  /** Switching tool restores what was last used with that tool (or a sane catalog default). */
  function onProvider(pv: Provider) {
    const c = catalog?.[pv];
    if (!c) return;
    const last = defaults.byProvider?.[pv];
    const m = last && c.models.some((x) => x.id === last.model) ? last.model : (c.models.find((x: any) => x.hint?.startsWith('default')) ?? c.models[0]).id;
    const e = last && (last.effort == null || c.efforts.includes(last.effort)) ? last.effort : (c.efforts.includes('high') ? 'high' : c.efforts.includes('medium') ? 'medium' : c.efforts[0] ?? null);
    const pm = last && c.perm_modes.includes(last.perm_mode) ? last.perm_mode : c.perm_modes[0];
    setProvider(pv); setModel(m); setEffort(e); setPerm(pm);
    apply({ provider: pv, model: m, effort: e, perm_mode: pm });
  }
  const onModel = (m: string) => { setModel(m); apply({ model: m }); };
  const onEffort = (e: string) => { setEffort(e); apply({ effort: e }); };
  async function onPerm(p: string) {
    if (p === 'bypass' && prefs.faceIdBypass) { const ok = await authenticate(T('bypassAuth')); if (!ok) return; }
    setPerm(p); apply({ perm_mode: p });
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!editingDefaults && !chat) return null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: insets.bottom + 28, gap: 18 }}>
      <View style={styles.handle} />
      {editingDefaults && <Text style={[type.title, { color: colors.text }]}>{T('defaultsTitle')}</Text>}
      <ProviderPicker value={provider} onChange={onProvider} compact />
      {cat && (
        <>
          <OptionList options={cat.models} value={model} onChange={onModel} />
          {cat.efforts.length > 0 && <View style={{ gap: 8 }}><Label>{T('effort')}</Label><Segmented options={cat.efforts} value={effort} onChange={onEffort} labels={{ medium: 'med' }} /></View>}
          {accountsFor.length > 1 && (
            <View style={{ gap: 8 }}>
              <Label>{T('accountFor')}</Label>
              <OptionList
                options={accountsFor.map((a) => ({ id: a.is_default ? '' : a.id,
                  label: a.is_default ? T('useDefaultAccount') : a.label,
                  hint: a.logged_in ? a.detail : T('notSignedIn') }))}
                value={(editingDefaults ? defaults.byProvider?.[provider]?.account_id : chat?.account_id) ?? ''}
                onChange={(v) => onAccount(v || null)} />
            </View>
          )}
          <View style={{ gap: 8 }}><Label>{T('permMode')}</Label><Segmented options={cat.perm_modes} value={perm} onChange={onPerm} labels={{ 'accept-edits': 'edits', 'auto-edit': 'edit', 'full-auto': 'auto' }} /></View>
        </>
      )}
      {!editingDefaults && (
        <>
          <Text style={[type.caption, { color: colors.muted }]}>{T('appliesNow')}</Text>
          <Pressable onPress={() => { router.back(); setTimeout(() => router.push({ pathname: '/chat-settings', params: { id } }), 350); }} style={styles.more}>
            <Text style={[type.sub, { color: colors.text }]}>{T('moreSettings')}</Text>
            <Text style={[type.sub, { color: colors.muted }]}>›</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  handle: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(241,236,227,0.2)' },
  more: { height: 48, borderRadius: 14, backgroundColor: colors.bg, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
