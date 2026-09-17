import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useShallow } from 'zustand/react/shallow';
import { useStore, useT } from '../src/store';
import { useNavGuard } from '../src/nav';
import { LOCALE } from '../src/i18n';
import { colors, radius, type, providerColor } from '../src/theme';
import { ArchiveIcon, Chevron, ChevronDown, Chips, Compose, FlatIcon, Gear, GroupedIcon, Phone, PinIcon, ProviderGlyph, Search, SkeletonRows, Spinner } from '../src/components/ui';
import type { Chat } from '../src/protocol';

/** The one section the flat view draws. It is never shown as a heading, so it
 *  needs an id no group or folder could ever collide with. */
const FLAT = '__flat__';

function timeLabel(ts: number, T: ReturnType<typeof useT>, locale: string) {
  const d = new Date(ts * 1000); const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return T('now');
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (diff < 86400 * 2) return T('yesterday');
  if (diff < 86400 * 7) return d.toLocaleDateString(locale, { weekday: 'short' });
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

export default function Chats() {
  const router = useRouter();
  const go = useNavGuard();
  const insets = useSafeAreaInsets();
  // A no-selector `useStore()` subscribes this screen to *every* store write,
  // and a running turn writes on every streamed token. That re-rendered the
  // whole list dozens of times a second, so taps queued up behind the render
  // work instead of opening a chat. Subscribe to what this screen actually
  // draws; the actions never change identity, so a shallow slice of them costs
  // nothing.
  const chats = useStore((s) => s.chats);
  const groups = useStore((s) => s.groups);
  const conn = useStore((s) => s.conn);
  const hostInfo = useStore((s) => s.hostInfo);
  const host = useStore((s) => s.host);
  const defaults = useStore((s) => s.defaults);
  const projects = useStore((s) => s.projects);
  const showArchived = useStore((s) => s.showArchived);
  const chatView = useStore((s) => s.prefs.chatView);
  const { refresh, loadProjects, createChat, updateChat, deleteChat, renameGroup, deleteGroup, createGroup, setShowArchived, setPrefs } =
    useStore(useShallow((s) => ({
      refresh: s.refresh, loadProjects: s.loadProjects, createChat: s.createChat, updateChat: s.updateChat,
      deleteChat: s.deleteChat, renameGroup: s.renameGroup, deleteGroup: s.deleteGroup, createGroup: s.createGroup,
      setShowArchived: s.setShowArchived, setPrefs: s.setPrefs,
    })));
  const T = useT();
  const locale = LOCALE[useStore((s) => s.prefs.lang)];
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => { if (conn === 'online') { void refresh().catch(() => {}); void loadProjects().catch(() => {}); } }, [conn, refresh, loadProjects]);

  // Tap: open a chat immediately with the defaults. Long-press: full picker sheet.
  const creating = useRef(false);
  const quickNew = useCallback(async () => {
    const cwd = defaults.cwd || projects[0]?.path;
    if (!cwd) { go(() => router.push('/new-chat')); return; }
    // Creating a chat is a round trip to the computer; without this a second
    // tap while it is in flight makes a second chat nobody asked for.
    if (creating.current) return;
    creating.current = true;
    try {
      const chat = await createChat({ provider: defaults.provider, model: defaults.model, effort: defaults.effort, perm_mode: defaults.perm_mode, cwd, account_id: defaults.byProvider?.[defaults.provider]?.account_id ?? undefined } as any);
      router.push(`/chat/${chat.id}`);
    } catch (e: any) {
      // Being offline is already on the screen, and the picker is where this tap
      // was heading anyway — an alert about it would only be in the way. Say
      // something only when the computer answered and said no.
      if (e?.code !== 'offline') Alert.alert(T('couldNotOpen'), e.message);
      router.push('/new-chat');
    } finally {
      creating.current = false;
    }
  }, [defaults, projects, createChat, router, go, T]);

  const sections = useMemo(() => {
    // `chats` is keyed by id, so its natural order is whenever each chat was first
    // seen — sort explicitly: pinned first, then most recently active.
    const all = Object.values(chats)
      .filter((c) => (showArchived || !c.archived) && (!q || c.title.toLowerCase().includes(q.toLowerCase()) || c.last_preview.toLowerCase().includes(q.toLowerCase())))
      .sort((a, b) => (b.pinned - a.pinned) || (b.updated_at - a.updated_at));
    // Grouping is a way of reading the list, not a property of it. Asked for the
    // flat view, hand back one unnamed section: same chats, newest first, no
    // walls. Nothing is regrouped or forgotten — the groups are still there the
    // moment the view is switched back.
    if (chatView === 'flat') return [{ id: FLAT, title: '', data: all, count: all.length }];

    const byGroup: Record<string, Chat[]> = {};
    for (const c of all) (byGroup[c.group_id || ''] ||= []).push(c);
    const out = groups.map((g) => ({ id: g.id, title: g.name, data: collapsed[g.id] ? [] : (byGroup[g.id] ?? []), count: byGroup[g.id]?.length ?? 0 }));

    // Chats nobody has filed fall into sections by the folder they work in.
    // One project is one section without anybody naming it, and a single
    // folder is not a grouping at all, so it stays as one plain list.
    const loose = byGroup[''] ?? [];
    const byCwd: Record<string, Chat[]> = {};
    for (const c of loose) (byCwd[c.cwd || ''] ||= []).push(c);
    const folders = Object.keys(byCwd);
    if (folders.length > 1) {
      folders
        .sort((a, b) => (byCwd[b][0]?.updated_at ?? 0) - (byCwd[a][0]?.updated_at ?? 0))
        .forEach((path) => {
          const id = `cwd:${path}`;
          out.push({ id, title: path.split('/').filter(Boolean).pop() || T('ungrouped'),
                     data: collapsed[id] ? [] : byCwd[path], count: byCwd[path].length });
        });
    } else if (loose.length || groups.length === 0) {
      out.push({ id: '', title: groups.length ? T('ungrouped') : T('chats'),
                 data: collapsed[''] ? [] : loose, count: loose.length });
    }
    return out;
  }, [chats, groups, q, collapsed, showArchived, chatView, T]);

  // In the flat view a row is the only place its group can still be named.
  const groupNames = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g.name])), [groups]);

  /** How the list is read, and the one place a group is made from nothing. A
   *  group that starts empty is worth having: it is where the next chats go. */
  function listOptions() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const err = (e: any) => Alert.alert(T('error'), e.message);
    Alert.alert(T('listOptions'), T('groupsHint'), [
      { text: chatView === 'grouped' ? `✓ ${T('viewGrouped')}` : T('viewGrouped'), onPress: () => void setPrefs({ chatView: 'grouped' }) },
      { text: chatView === 'flat' ? `✓ ${T('viewFlat')}` : T('viewFlat'), onPress: () => void setPrefs({ chatView: 'flat' }) },
      { text: T('newGroupAction'), onPress: () => Alert.prompt(T('newGroupTitle'), undefined, async (n) => {
        if (!n?.trim()) return;
        try {
          await createGroup(n.trim().slice(0, 60));
          // A new group is invisible in the flat view, which would read as the
          // tap having done nothing. Show the view that can hold it.
          if (chatView !== 'grouped') await setPrefs({ chatView: 'grouped' });
        } catch (e) { err(e); }
      }) },
      { text: T('cancel'), style: 'cancel' },
    ]);
  }

  function chatActions(chat: Chat) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const err = (e: any) => Alert.alert(T('error'), e.message);
    Alert.alert(chat.title, undefined, [
      { text: chat.pinned ? T('unpin') : T('pin'), onPress: () => updateChat(chat.id, { pinned: chat.pinned ? 0 : 1 } as any).catch(err) },
      { text: T('rename'), onPress: () => Alert.prompt(T('chatName'), undefined, (t) => t?.trim() && updateChat(chat.id, { title: t.trim().slice(0, 60) } as any).catch(err), 'plain-text', chat.title) },
      { text: T('moveToGroup'), onPress: () => moveToGroup(chat) },
      { text: chat.archived ? T('unarchive') : T('archiveAction'), onPress: () => updateChat(chat.id, { archived: chat.archived ? 0 : 1 } as any).catch(err) },
      { text: T('delete'), style: 'destructive', onPress: () => Alert.alert(T('deleteChat'), T('deleteChatBody'), [
        { text: T('cancel'), style: 'cancel' }, { text: T('delete'), style: 'destructive', onPress: () => deleteChat(chat.id).catch(err) }]) },
      { text: T('cancel'), style: 'cancel' },
    ]);
  }

  function moveToGroup(chat: Chat) {
    const err = (e: any) => Alert.alert(T('error'), e.message);
    Alert.alert(T('moveToGroup'), undefined, [
      ...groups.map((g) => ({ text: g.id === chat.group_id ? `✓ ${g.name}` : g.name, onPress: () => updateChat(chat.id, { group_id: g.id } as any).catch(err) })),
      { text: T('noGroup'), onPress: () => updateChat(chat.id, { group_id: null } as any).catch(err) },
      { text: T('newGroup'), onPress: () => Alert.prompt(T('newGroupTitle'), undefined, async (n) => { if (!n?.trim()) return; try { const g = await createGroup(n.trim()); await updateChat(chat.id, { group_id: g.id } as any); } catch (e) { err(e); } }) },
      { text: T('cancel'), style: 'cancel' },
    ]);
  }

  function groupActions(id: string, name: string) {
    if (!id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const err = (e: any) => Alert.alert(T('error'), e.message);
    Alert.alert(name, undefined, [
      { text: T('rename'), onPress: () => Alert.prompt(T('groupName'), undefined, (t) => t?.trim() && renameGroup(id, t.trim().slice(0, 60)).catch(err), 'plain-text', name) },
      { text: T('deleteGroup'), style: 'destructive', onPress: () => Alert.alert(T('deleteGroup'), T('deleteGroupBody'), [
        { text: T('cancel'), style: 'cancel' }, { text: T('delete'), style: 'destructive', onPress: () => deleteGroup(id).catch(err) }]) },
      { text: T('cancel'), style: 'cancel' },
    ]);
  }

  // Handed to every row, so they have to keep the same identity across renders
  // or memoising the row buys nothing. The action sheets close over this
  // render's state, so reach them through a ref rather than rebuilding.
  const actionsRef = useRef({ chatActions, groupActions });
  actionsRef.current = { chatActions, groupActions };
  const onRowPress = useCallback((chat: Chat) => go(() => router.push(`/chat/${chat.id}`)), [go, router]);
  const onRowLongPress = useCallback((chat: Chat) => actionsRef.current.chatActions(chat), []);

  const online = conn === 'online';
  const switching = useStore((st) => st.switching);
  const empty = Object.keys(chats).length === 0;
  // The outgoing computer's list stays up, dimmed and inert, until the new
  // one's list lands — a blank screen mid-switch is what read as a stutter.
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: switching ? 0.35 : 1, duration: switching ? 130 : 220, useNativeDriver: true }).start();
  }, [switching, fade]);
  // Until the computer has answered, an empty list is not an answer.
  const chatsLoaded = useStore((st) => st.chatsLoaded);
  const waitingForList = empty && !chatsLoaded && (conn === 'online' || conn === 'connecting');

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.top}>
        <Pressable onPress={() => go(() => router.push('/host-sheet'))} style={styles.pill}>
          <View style={[styles.dot, { backgroundColor: online ? colors.success : conn === 'connecting' ? colors.warning : colors.faint }]} />
          <Text style={[type.caption, { color: colors.text, fontWeight: '500', letterSpacing: 0 }]}>{hostInfo?.name?.replace('.local', '') || host?.name || T('computer')}</Text>
          <Text style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>
            {switching || conn === 'connecting' ? T('connecting') : online ? T('active', { n: hostInfo?.active_sessions ?? 0 }) : conn === 'unauthorized' ? T('unauthorized') : T('offline')}
          </Text>
          <ChevronDown size={12} />
        </Pressable>
        <View style={{ flexDirection: 'row' }}>
          <Pressable onPress={() => go(() => router.push('/call'))} style={styles.iconBtn}><Phone /></Pressable>
          <Pressable onPress={() => go(() => router.push('/settings'))} style={styles.iconBtn}><Gear /></Pressable>
          <Pressable onPress={quickNew} onLongPress={() => go(() => router.push('/new-chat'))} style={styles.iconBtn}><Compose /></Pressable>
        </View>
      </View>
      <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
        <View style={styles.segment}>
          <View style={[styles.segItem, styles.segOn]}>
            <Text style={[type.sub, { color: colors.text, fontWeight: '600' }]}>{T('chatsTab')}</Text>
          </View>
          <Pressable onPress={() => go(() => router.replace('/agents'))} style={styles.segItem}>
            <Text style={[type.sub, { color: colors.muted }]}>{T('agentsTab')}</Text>
          </Pressable>
        </View>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 6 }}>
        <Text style={[type.largeTitle, { color: colors.text }]}>{T('chats')}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, paddingBottom: 8 }}>
          <Pressable onPress={listOptions} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            {chatView === 'grouped' ? <GroupedIcon /> : <FlatIcon />}
            <Text style={[type.caption, { color: colors.muted }]}>{chatView === 'grouped' ? T('groupedShort') : T('flatShort')}</Text>
          </Pressable>
          <Pressable onPress={() => setShowArchived(!showArchived)} hitSlop={10}>
            <Text style={[type.caption, { color: showArchived ? colors.accent : colors.muted }]}>{showArchived ? T('archiveOn') : T('archive')}</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.search}>
        <Search />
        <TextInput value={q} onChangeText={setQ} placeholder={T('search')} placeholderTextColor={colors.muted} style={[type.body, { flex: 1, color: colors.text, lineHeight: undefined, paddingVertical: 0 }]} clearButtonMode="while-editing" />
      </View>

      <Animated.View style={{ flex: 1, opacity: fade }} pointerEvents={switching ? 'none' : 'auto'}>
      {waitingForList ? (
        <SkeletonRows rows={6} />
      ) : empty ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 40 }}>
          <Text style={[type.headline, { color: colors.text }]}>{online ? T('noChats') : conn === 'unauthorized' ? T('noAccess') : T('cantConnect')}</Text>
          <Text style={[type.sub, { color: colors.muted, textAlign: 'center' }]}>
            {online ? T('hintNew') : conn === 'unauthorized' ? T('noAccessHint') : T('hintOffline')}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(c) => c.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingTop: 12, paddingBottom: insets.bottom + 24 }}
          renderSectionHeader={({ section }) => section.id === FLAT ? null : (
            <Pressable onPress={() => setCollapsed((c) => ({ ...c, [section.id]: !c[section.id] }))} onLongPress={() => groupActions(section.id, section.title)} style={styles.secHead}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {collapsed[section.id] ? <Chevron size={14} /> : <ChevronDown />}
                <Text style={[type.label, { color: colors.muted }]}>{section.title}</Text>
              </View>
              <Text style={[type.caption, { color: colors.muted }]}>{section.count || T('groupEmpty')}</Text>
            </Pressable>
          )}
          renderItem={({ item }) => <ChatRow chat={item} T={T} locale={locale} group={chatView === 'flat' && item.group_id ? groupNames[item.group_id] : undefined} onPress={onRowPress} onLongPress={onRowLongPress} />}
        />
      )}
      </Animated.View>
    </View>
  );
}

const ChatRow = React.memo(function ChatRow({ chat, onPress, onLongPress, T, locale, group }: { chat: Chat; onPress: (chat: Chat) => void; onLongPress: (chat: Chat) => void; T: ReturnType<typeof useT>; locale: string; group?: string }) {
  const waiting = chat.status === 'awaiting_approval';
  const running = chat.status === 'running';
  const pc = providerColor(chat.provider);
  return (
    <Pressable onPress={() => onPress(chat)} onLongPress={() => onLongPress(chat)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface }]}>
      <ProviderGlyph provider={chat.provider} />
      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            {!!chat.pinned && <PinIcon color={pc} />}
            {!!chat.archived && <ArchiveIcon />}
            <Text numberOfLines={1} style={[type.headline, { color: colors.text, flexShrink: 1, fontWeight: waiting ? '600' : '500' }]}>{chat.title}</Text>
          </View>
          <Text style={[type.caption, { color: colors.muted }]}>{timeLabel(chat.updated_at, T, locale)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {waiting && <View style={[styles.dot, { width: 6, height: 6, backgroundColor: pc }]} />}
          {running && <Spinner />}
          <Text numberOfLines={1} style={[type.sub, { color: waiting ? pc : colors.muted, flex: 1 }]}>
            {running ? T('runningFor', { m: Math.max(0, Math.round((Date.now() / 1000 - chat.updated_at) / 60)) }) : waiting ? `${T('awaiting')} · ${chat.last_preview}` : chat.last_preview || T('emptyChat')}
          </Text>
        </View>
        <Chips items={[group, chat.model, chat.effort, chat.perm_mode]} accent={group ? pc : undefined} />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  segment: { flexDirection: 'row', padding: 3, borderRadius: 11, backgroundColor: colors.surface },
  segItem: { flex: 1, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.border2 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 20, paddingRight: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  dot: { width: 8, height: 8, borderRadius: 4 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  search: { marginHorizontal: 20, marginTop: 14, height: 40, borderRadius: radius.md, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  secHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 6, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 10, minHeight: 72 },
});
