import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { agentAccountOf, useStore, useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { ChevronDown, Gear, Skeleton } from '../src/components/ui';
import { AccountPicker, accountOptions } from '../src/components/pickers';
import { AgentCard } from '../src/components/agentcard';
import type { Agent } from '../src/protocol';

/** Two columns of squares, the way an app grid reads. */
export default function Agents() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { agents, agentsLoaded, loadAgents, defaults, projects, createChat, conn, hostInfo, host, removeAgent,
          accounts, loadAccounts, setDefaults } = useStore();
  const [opening, setOpening] = useState<string | null>(null);
  const [pickOpen, setPickOpen] = useState(false);

  const account = agentAccountOf(defaults);

  useFocusEffect(useCallback(() => {
    if (conn !== 'online') return;
    void loadAgents(account, defaults.cwd ?? null).catch(() => {});
    void loadAccounts().catch(() => {});
  }, [conn, loadAgents, loadAccounts, account, defaults.cwd]));

  // Agents belong to an account, so an empty grid can just mean the wrong one
  // is selected. Saying which one, and letting it be changed here, is the
  // difference between "you have no agents" and "not in this account".
  const accountOpts = accountOptions(accounts, 'claude', T('useDefaultAccount'), T('notSignedIn'));
  const accountLabel = accountOpts.find((o) => o.id === (account ?? ''))?.label ?? T('useDefaultAccount');

  function remove(a: Agent) {
    Alert.alert(T('removeAgent'), T('removeAgentBody'), [
      { text: T('cancel'), style: 'cancel' },
      { text: T('remove'), style: 'destructive',
        onPress: () => removeAgent(a.name, account)
          .catch((e) => Alert.alert(T('error'), e?.message ?? '')) },
    ]);
  }

  async function open(a: Agent) {
    setOpening(a.id);
    try {
      // The same account the list was read from. An agent lives in one
      // account's folder, so a chat created against a different one cannot
      // find it — which is what made tapping an installed agent fail.
      const chat = await createChat({
        provider: 'claude', title: a.label, agent_id: a.id,
        account_id: account ?? undefined,
        cwd: defaults.cwd ?? projects[0]?.path ?? null,
      } as any);
      router.push(`/chat/${chat.id}`);
    } catch (e: any) {
      Alert.alert(T('error'), e?.message ?? '');
    } finally { setOpening(null); }
  }

  const waiting = !agentsLoaded && (conn === 'online' || conn === 'connecting');

  // Only what belongs here: the built-in creator, and agents installed or
  // written through the app. The computer's own set stays with the computer —
  // those are other tools' workers, not chat partners.
  const loose = agents.filter((a) => a.installed);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.top}>
        <Pressable onPress={() => router.push('/host-sheet')} style={styles.pill}>
          <View style={[styles.dot, { backgroundColor: conn === 'online' ? colors.success : colors.faint }]} />
          <Text style={[type.caption, { color: colors.text, fontWeight: '500', letterSpacing: 0 }]}>
            {hostInfo?.name?.replace('.local', '') || host?.name || T('computer')}
          </Text>
          <ChevronDown size={12} />
        </Pressable>
        <Pressable onPress={() => router.push('/settings')} style={styles.iconBtn}><Gear /></Pressable>
      </View>

      <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
        <View style={styles.segment}>
          <Pressable onPress={() => router.replace('/chats')} style={styles.segItem}>
            <Text style={[type.sub, { color: colors.muted }]}>{T('chatsTab')}</Text>
          </Pressable>
          <View style={[styles.segItem, styles.segOn]}>
            <Text style={[type.sub, { color: colors.text, fontWeight: '600' }]}>{T('agentsTab')}</Text>
          </View>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 32 }}>
        <Text style={[type.largeTitle, { color: colors.text, paddingBottom: 14 }]}>{T('agentsTab')}</Text>
        {accountOpts.length > 1 && (
          <View style={{ gap: 8, paddingBottom: 16 }}>
            <Pressable onPress={() => setPickOpen((v) => !v)} style={styles.acct}>
              <Text style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>{T('agentsAccount')}</Text>
              <Text style={[type.caption, { color: colors.text, fontWeight: '500', letterSpacing: 0, flex: 1 }]}
                numberOfLines={1}>{accountLabel}</Text>
              <ChevronDown />
            </Pressable>
            {pickOpen && (
              <AccountPicker accounts={accounts} provider="claude" value={account}
                onChange={(id) => { setPickOpen(false); void setDefaults({ agentAccountId: id }); }} />
            )}
          </View>
        )}
        {waiting ? (
          <View style={styles.grid}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={[styles.tile, { opacity: 1 - i * 0.18 }]}>
                <Skeleton width="70%" height={16} />
                <Skeleton width="90%" height={12} radius={5} style={{ marginTop: 8 }} />
              </View>
            ))}
          </View>
        ) : loose.length === 0 ? (
          <View style={{ gap: 8, paddingTop: 30 }}>
            <Text style={[type.headline, { color: colors.text }]}>{T('noAgents')}</Text>
            <Text style={[type.sub, { color: colors.muted }]}>{T('agentAddBody')}</Text>
            <Pressable onPress={() => router.push('/agent-store')} style={{ paddingTop: 10 }}>
              <Text style={[type.sub, { color: colors.accent }]}>{T('addAgent')}</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.grid}>
              {loose.map((a) => (
                <AgentCard key={a.id} agent={a} busy={opening === a.id}
                  disabled={!!opening} onPress={() => open(a)} onLongPress={() => remove(a)} />
              ))}
            </View>
            {/* Out of the grid: as a tile it was left stranded half-width on a
                row of its own whenever the agent count was odd, and read as a
                card that had been cut in half. */}
            <Pressable onPress={() => router.push('/agent-store')} style={styles.addCard}>
              <Text style={{ fontSize: 20, color: colors.accent }}>+</Text>
              <Text style={{ fontSize: 15, fontWeight: '600', letterSpacing: -0.2, color: colors.accent }}>
                {T('addAgent')}
              </Text>
            </Pressable>
            <Text style={{ fontSize: 14, lineHeight: 19, letterSpacing: -0.1, color: colors.muted, paddingTop: 20 }}>
              {T('agentsHint')}
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 20, paddingRight: 12 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: colors.surface },
  dot: { width: 7, height: 7, borderRadius: 4 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  segment: { flexDirection: 'row', padding: 3, borderRadius: 11, backgroundColor: colors.surface },
  segItem: { flex: 1, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.border2 },
  acct: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 36, paddingHorizontal: 12,
    borderRadius: 11, backgroundColor: colors.surface },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  addCard: { flexDirection: 'row', gap: 8, height: 62, marginTop: 16, borderRadius: 18, borderWidth: 1,
    borderStyle: 'dashed', borderColor: colors.border2, alignItems: 'center', justifyContent: 'center' },
  tile: { width: '47%', aspectRatio: 0.8, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1,
    borderColor: colors.border, padding: 14, justifyContent: 'flex-end' },
});
