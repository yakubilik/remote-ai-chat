import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { useShallow } from 'zustand/react/shallow';
import { buildTimeline, useStore, useT, type Attachment, type TimelineItem } from '../../src/store';
import type { CliAccount } from '../../src/protocol';
import { useNavGuard } from '../../src/nav';
import { getOpenChat, setChatOnScreen, setOpenChat } from '../../src/push';
import { LimitsRing } from '../../src/components/limits';
import { colors, type, mono, providerColor } from '../../src/theme';
import { Back, ChevronDown, SkeletonBubbles, Spinner } from '../../src/components/ui';
import { ApprovalCard, AssistantText, ConnectionBanner, ToolCard, ToolGroup, TurnFooter, UserBubble, WorkingRow } from '../../src/components/chat';

const Icon = ({ d, size = 20, color = colors.text, sw = 2.2 }: { d: string; size?: number; color?: string; sw?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"><Path d={d} /></Svg>
);
const I = {
  photos: 'M3 5h18v14H3z M9 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 16l-5-5-8 8',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  video: 'M3 6h13v12H3z M16 10l5-3v10l-5-3z',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h6',
  mic: 'M9 3h6v11H9z M5 11a7 7 0 0 0 14 0 M12 18v3',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5L20 7',
  up: 'M12 19V5M5 12l7-7 7 7',
};

/** What the tools call a tier, written the way the billing page writes it.
 *  Anything unrecognised is title-cased rather than dropped: a plan we have
 *  never heard of is still the plan the message is being charged to. */
const PLAN_NAMES: Record<string, string> = {
  max: 'Max', pro: 'Pro', plus: 'Plus', team: 'Team', enterprise: 'Enterprise',
  free: 'Free', api: 'API', business: 'Business',
};
function planName(account: CliAccount | undefined, provider: string | undefined): string {
  const p = (account?.plan ?? '').trim();
  if (p) return PLAN_NAMES[p] ?? p.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  // No tier from the tool — the account's own name still answers "which
  // sign-in is this", which is more than the vendor's name ever does.
  if (account && !account.is_default && account.label.trim()) return account.label.trim();
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function fmt(sec: number) { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function useTypewriter(target: string, segment: number | null): string {
  const [shown, setShown] = useState(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => { setShown(0); }, [segment]);
  useEffect(() => {
    if (segment == null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setShown((cur) => {
        const len = targetRef.current.length;
        if (cur >= len) return cur;
        // drain whatever is buffered in ~400ms, never slower than a readable crawl
        const step = Math.max(2, Math.ceil((len - cur) / 12));
        return Math.min(len, cur + step);
      });
      // Every frame re-renders the whole message, so the cost of a frame grows
      // with the answer. Past a few screenfuls nobody is reading the reveal
      // anyway — slow it down rather than spend the phone on it.
      timer = setTimeout(tick, targetRef.current.length > 3000 ? 100 : 33);
    };
    timer = setTimeout(tick, 33);
    return () => clearTimeout(timer);
  }, [segment]);
  return target.slice(0, Math.min(shown, target.length));
}

export default function ChatScreen() {
  const router = useRouter();
  const go = useNavGuard();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const chat = useStore((s) => s.chats[id!]);
  const events = useStore((s) => s.events[id!]);
  const live = useStore((s) => s.live[id!]);
  const thinking = useStore((s) => s.thinking[id!]);
  const progress = useStore((s) => s.progress[id!]);
  const busy = useStore((s) => s.busy[id!]);
  const conn = useStore((s) => s.conn);
  const catalog = useStore((s) => s.catalog);
  const groups = useStore((s) => s.groups);
  const accounts = useStore((s) => s.accounts);
  const accountsLoaded = useStore((s) => s.accountsLoaded);
  // Selector-less `useStore()` would subscribe this screen to every store write,
  // so a *different* chat streaming in the background re-rendered this one on
  // every token. Take just the actions; their identities never change.
  const { openChat, send, interrupt, respond, uploadAttachment, updateChat, deleteChat, createGroup, settleLive, loadAccounts } =
    useStore(useShallow((s) => ({
      openChat: s.openChat, send: s.send, interrupt: s.interrupt, respond: s.respond,
      uploadAttachment: s.uploadAttachment, updateChat: s.updateChat, deleteChat: s.deleteChat,
      createGroup: s.createGroup, settleLive: s.settleLive, loadAccounts: s.loadAccounts,
    })));
  const [text, setText] = useState('');
  const [turnStart, setTurnStart] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setTurnStart(busy ? (t) => t ?? Date.now() : null); }, [busy]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [kbVisible, setKbVisible] = useState(false);
  const listRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);

  /** iOS keeps its own copy of the field's text while autocorrect is mid-word,
   *  and a bare `setText('')` loses the race with it — the message goes out but
   *  the native view puts the old string straight back. Clearing the native
   *  field too is what actually empties the composer. */
  function clearComposer() { setText(''); inputRef.current?.clear(); }

  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const rec = useAudioRecorderState(recorder, 120);
  const [recording, setRecording] = useState(false);
  const levels = useRef<number[]>([]);
  useEffect(() => {
    if (!recording) { levels.current = []; return; }
    const m = rec.metering ?? -160;              // dBFS, roughly -60..0
    const v = Math.max(0, Math.min(1, (m + 50) / 50));
    levels.current = [...levels.current.slice(-27), v];
  }, [rec.durationMillis, recording]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (conn === 'online') void openChat(id!).catch((e) => console.warn('openChat failed', e?.message)); }, [id, conn, openChat]);
  // The header names the plan being spent, which only the account list knows.
  // Asking for it costs a shell-out per tool, so ask once per session.
  useEffect(() => {
    if (conn === 'online' && !accountsLoaded) void loadAccounts().catch(() => {});
  }, [conn, accountsLoaded, loadAccounts]);
  // Silences this chat's own "finished" notification while it is on screen.
  useFocusEffect(useCallback(() => {
    setChatOnScreen(id!);
    setOpenChat(id!);
    return () => setChatOnScreen(null);
  }, [id]));
  // Blur is not "left the chat" — a sheet blurs it too, and so does backgrounding
  // the app, which is exactly when a notification tap has to know where we are.
  useEffect(() => () => { if (getOpenChat() === id) setOpenChat(null); }, [id]);
  useEffect(() => {
    const a = Keyboard.addListener('keyboardWillShow', () => setKbVisible(true));
    const b = Keyboard.addListener('keyboardWillHide', () => setKbVisible(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  // A chat the user opened and left without saying anything should not linger in
  // the list; only drop it when we know it is genuinely empty.
  const loaded = useStore((s) => !!s.loadedChats[id!]);
  const disposable = useRef(false);
  disposable.current = loaded && !busy && (events?.length ?? 0) === 0
    && (chat?.total_cost_usd ?? 0) === 0
    && (chat?.title === 'New chat' || chat?.title === 'Yeni sohbet');
  useEffect(() => () => {
    if (disposable.current) void useStore.getState().deleteChat(id!).catch(() => {});
  }, [id]);

  const items = useMemo(() => buildTimeline(events || []), [events]);
  const typed = useTypewriter(live?.text ?? '', live ? live.segment : null);
  useEffect(() => {
    if (live?.final && typed.length >= live.text.length) settleLive(id!);
  }, [live, typed, id, settleLive]);
  // Inverted list: index 0 is the newest item, so the list is pinned to the bottom by construction.
  const data = useMemo<TimelineItem[]>(() => {
    // While the finished segment is still being typed out, its persisted twin
    // would render the whole thing at once — hide it until the typing catches up.
    const out = live?.final
      ? items.filter((i) => !(i.kind === 'assistant' && i.data.segment === live.segment))
      : [...items];
    if (live) out.push({ key: 'live', kind: 'assistant', data: { text: typed, live: !live.final || typed.length < live.text.length } });
    else if (busy) {
      // No text yet: say what the turn is doing instead of showing nothing.
      const lastTool = [...items].reverse().find((i) => i.kind === 'tool' && !i.result);
      const phase = lastTool || progress?.open_tools ? T('wWorking') : thinking ? T('wThinking') : T('wStarting');
      const hint = lastTool ? undefined : thinking ? thinking.trim().slice(-160) : undefined;
      out.push({ key: 'working', kind: 'working', data: { phase, hint } } as any);
    }
    return out.reverse();
  }, [items, live, typed, busy, thinking, progress, T]);

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 1200); }

  // ── sending ────────────────────────────────────────────────────────────
  async function sendNow(t: string, atts: Attachment[]) {
    const voice = atts.find((a) => a.kind === 'audio');
    const body = t || voice?.transcript || (voice ? T('voiceMessage') : T('lookAtFile'));
    try { await send(id!, body, atts); }
    catch (e: any) { Alert.alert(T('notSent'), e.message); setText(t); setPending(atts); }
  }
  async function onSend() {
    const t = text.trim();
    if (!t && pending.length === 0) return;
    const atts = pending;
    clearComposer(); setPending([]);
    await sendNow(t, atts);
  }

  // ── attachments ────────────────────────────────────────────────────────
  async function addAssets(assets: { uri: string; fileName?: string | null; duration?: number | null }[]) {
    setUploading(true);
    try {
      for (const a of assets) {
        const name = a.fileName || a.uri.split('/').pop() || `file-${Date.now()}`;
        const up = await uploadAttachment(id!, a.uri, name);
        setPending((p) => [...p, { ...up, name, duration: a.duration != null ? a.duration / 1000 : undefined }]);
      }
    } catch (e: any) { Alert.alert(T('uploadFailed'), e.message); }
    finally { setUploading(false); }
  }
  // PHPicker needs no library permission; only the camera does.
  const pickPhotos = async () => { const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85, allowsMultipleSelection: true, selectionLimit: 4 }); if (!r.canceled) await addAssets(r.assets); };
  const pickVideo = async () => { const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], videoMaxDuration: 120 }); if (!r.canceled) await addAssets(r.assets); };
  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert(T('noPermission'), T('photosDenied')); return; }
    const r = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (!r.canceled) await addAssets(r.assets);
  };
  const pickFile = async () => { const r = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true }); if (!r.canceled) await addAssets(r.assets.map((a) => ({ uri: a.uri, fileName: a.name }))); };
  const attachActions = [
    { key: 'photos', label: T('photos'), icon: I.photos, run: pickPhotos },
    { key: 'camera', label: T('camera'), icon: I.camera, run: takePhoto },
    { key: 'video', label: T('video'), icon: I.video, run: pickVideo },
    { key: 'file', label: T('file'), icon: I.file, run: pickFile },
  ];

  // ── voice ──────────────────────────────────────────────────────────────
  async function startRecording() {
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) { Alert.alert(T('noPermission'), T('micDenied')); return; }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch (e: any) { setRecording(false); Alert.alert(T('error'), e?.message ?? String(e)); }
  }
  async function stopRecording(sendIt: boolean) {
    const seconds = Math.max(rec.durationMillis, recorder.currentTime * 1000) / 1000;
    try { await recorder.stop(); } catch {}
    setRecording(false);
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    const uri = recorder.uri;
    if (!sendIt || !uri || seconds < 0.5) return;
    setUploading(true);
    try {
      const up = await uploadAttachment(id!, uri, `voice-${Date.now()}.m4a`);
      const att: Attachment = { ...up, kind: 'audio', duration: seconds };
      await sendNow(text.trim(), [...pending, att]);
      clearComposer(); setPending([]);
    } catch (e: any) { Alert.alert(T('uploadFailed'), e.message); }
    finally { setUploading(false); }
  }

  const openModelSheet = () => go(() => router.push({ pathname: '/model-sheet', params: { id } }));

  // ── chat menu ──────────────────────────────────────────────────────────
  function chatMenu() {
    if (!chat) return;
    const err = (e: any) => Alert.alert(T('error'), e.message);
    const options = [T('rename'), T('moveToGroup'), chat.pinned ? T('unpin') : T('pin'), chat.archived ? T('unarchive') : T('archiveAction'), T('chatSettingsItem'), T('deleteChat'), T('cancel')];
    const run = (i: number) => {
      switch (i) {
        case 0: Alert.prompt(T('chatName'), undefined, (t) => t?.trim() && updateChat(chat.id, { title: t.trim().slice(0, 60) } as any).catch(err), 'plain-text', chat.title); break;
        case 1: moveToGroup(); break;
        case 2: updateChat(chat.id, { pinned: chat.pinned ? 0 : 1 } as any).catch(err); break;
        case 3: updateChat(chat.id, { archived: chat.archived ? 0 : 1 } as any).then(() => { if (!chat.archived) { showToast(T('archived')); setTimeout(() => router.back(), 400); } }).catch(err); break;
        case 4: go(() => router.push({ pathname: '/chat-settings', params: { id } })); break;
        case 5: Alert.alert(T('deleteChat'), T('deleteChatBody'), [{ text: T('cancel'), style: 'cancel' }, { text: T('delete'), style: 'destructive', onPress: () => { router.back(); deleteChat(chat.id).catch(err); } }]); break;
      }
    };
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: 6, destructiveButtonIndex: 5, title: chat.title, userInterfaceStyle: 'dark' }, run);
    else Alert.alert(chat.title, undefined, options.map((text, i) => ({ text, onPress: () => run(i), style: i === 5 ? 'destructive' : i === 6 ? 'cancel' : 'default' })));
  }
  function moveToGroup() {
    if (!chat) return;
    const err = (e: any) => Alert.alert(T('error'), e.message);
    const names = [...groups.map((g) => (g.id === chat.group_id ? `✓ ${g.name}` : g.name)), T('noGroup'), T('newGroup'), T('cancel')];
    const run = async (i: number) => {
      if (i < groups.length) return updateChat(chat.id, { group_id: groups[i].id } as any).catch(err);
      if (i === groups.length) return updateChat(chat.id, { group_id: null } as any).catch(err);
      if (i === groups.length + 1) Alert.prompt(T('newGroupTitle'), undefined, async (n) => { if (!n?.trim()) return; try { const g = await createGroup(n.trim()); await updateChat(chat.id, { group_id: g.id } as any); } catch (e) { err(e); } });
    };
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: names, cancelButtonIndex: names.length - 1, title: T('moveToGroup'), userInterfaceStyle: 'dark' }, run);
    else Alert.alert(T('moveToGroup'), undefined, names.map((text, i) => ({ text, onPress: () => run(i) })));
  }

  const online = conn === 'online';
  const pc = chat ? providerColor(chat.provider) : colors.accent;
  const dot = online ? pc : conn === 'connecting' ? colors.warning : colors.faint;
  const canSend = (!!text.trim() || pending.length > 0) && online && !uploading;
  const modelLabel = chat ? (catalog?.[chat.provider]?.models.find((m) => m.id === chat.model)?.label ?? chat.model) : '';
  const account = useMemo(
    () => (chat ? accounts.find((a) => a.id === (chat.account_id || `default-${chat.provider}`)) : undefined),
    [accounts, chat?.account_id, chat?.provider]); // eslint-disable-line react-hooks/exhaustive-deps
  const planLabel = planName(account, chat?.provider);
  // Two sign-ins on one tool means the tier alone no longer says which one is
  // being spent; the account's name does.
  const planSub = useMemo(() => {
    const same = accounts.filter((a) => a.provider === chat?.provider && a.logged_in);
    return same.length > 1 && account?.plan && account.label !== planLabel ? account.label : undefined;
  }, [accounts, account, chat?.provider, planLabel]);
  const shortCwd = chat ? chat.cwd.replace(/^\/Users\/[^/]+/, '~') : '';

  const renderItem = useCallback(({ item }: { item: TimelineItem }) => {
    switch (item.kind) {
      case 'working' as any:
        return <WorkingRow phase={item.data.phase} hint={item.data.hint}
                 seconds={turnStart ? (now - turnStart) / 1000 : 0}
                 tokens={progress?.output_tokens} tools={progress?.open_tools} />;
      // No long-press wrapper on either bubble: long-press is the gesture that
      // starts a text selection, and a Pressable takes it first. Copying the
      // whole message is still one tap away — iOS offers Select All beside Copy
      // in the selection menu — and now part of a message can be taken too.
      case 'user': return <UserBubble text={item.data.text} attachments={item.data.attachments} />;
      case 'assistant':
        if (item.data.thinking) return (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingRight: 24 }}>
            <View style={{ paddingTop: 3 }}><Spinner /></View>
            <Text numberOfLines={3} style={[type.caption, { color: colors.muted, flex: 1 }]}>{item.data.thinking.trim().slice(-240)}</Text>
          </View>
        );
        return <AssistantText text={item.data.text} streaming={item.data.live} />;
      case 'tool': return <ToolCard id={item.data.id} tool={item.data.tool} input={item.data.input} result={item.result} />;
      case 'tools': return <ToolGroup items={item.data} />;
      case 'approval': return (
        <ApprovalCard tool={item.data.tool} input={item.data.input} preview={item.data.preview} danger={item.data.danger} decision={item.decision ?? null}
          onDecide={(d) => respond(id!, item.data.request_id, d).catch((e) => Alert.alert(T('error'), e.message))} />
      );
      case 'done': return <TurnFooter cost={item.data.cost_usd} duration={item.data.duration_ms} usage={item.data.usage} stopReason={item.data.stop_reason} />;
      case 'error': return <TurnFooter error={item.data.message} />;
      default: return null;
    }
  }, [id, respond, T]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header: back · plan chip (what this is being billed to) · more.
          The model moved down into the composer, where it is chosen. */}
      <View style={[styles.head, { paddingTop: insets.top }]}>
        <Pressable onPress={() => go(() => router.back())} style={styles.iconBtn}><Back color={colors.text} /></Pressable>
        <View style={{ flex: 1, alignItems: 'center', gap: 2, minWidth: 0 }}>
          <LimitsRing accountId={chat?.account_id} provider={chat?.provider} label={planLabel} sub={planSub} dot={dot} />
          {chat && (
            <Text numberOfLines={1} style={{ fontFamily: mono, fontSize: 11, color: !online ? colors.warning : chat.perm_mode === 'bypass' ? pc : colors.muted }}>
              {!online ? (conn === 'connecting' ? T('connecting') : T('offline')) : chat.perm_mode} · {shortCwd}
            </Text>
          )}
        </View>
        <Pressable onPress={chatMenu} style={styles.iconBtn}>
          <Svg width={22} height={22} viewBox="0 0 24 24" fill={colors.text}><Circle cx="5.5" cy="12" r="1.8" /><Circle cx="12" cy="12" r="1.8" /><Circle cx="18.5" cy="12" r="1.8" /></Svg>
        </Pressable>
      </View>

      {conn !== 'online' && <ConnectionBanner text={T('wReconnecting')} />}

      <FlatList
        ref={listRef}
        data={data}
        inverted
        keyExtractor={(it) => it.key}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 14, flexGrow: 1 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
        initialNumToRender={20}
        windowSize={9}
        ListEmptyComponent={
          // A transcript that has not arrived is not an empty transcript.
          !loaded ? (
            <View style={{ transform: [{ scaleY: -1 }], paddingTop: 12 }}>
              <SkeletonBubbles />
            </View>
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 10, transform: [{ scaleY: -1 }] }}>
              <Text style={[type.title, { color: colors.text }]}>{chat?.title}</Text>
              <Text style={[type.sub, { color: colors.muted, textAlign: 'center' }]}>{chat ? T('worksIn', { cwd: shortCwd }) : ''}</Text>
            </View>
          )
        }
        renderItem={renderItem}
      />

      {toast && <View style={styles.toast}><Text style={[type.caption, { color: colors.text, letterSpacing: 0 }]}>{toast}</Text></View>}

      {/* Composer */}
      <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: kbVisible ? 8 : Math.max(insets.bottom, 10), gap: 8 }}>
        {pending.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {pending.map((a) => (
              <Pressable key={a.path} onPress={() => setPending((p) => p.filter((x) => x.path !== a.path))} style={styles.pendingChip}>
                <Icon size={14} color={colors.muted} d={a.kind === 'video' ? I.video : a.kind === 'audio' ? I.mic : a.kind === 'image' ? I.photos : I.file} />
                <Text numberOfLines={1} style={[type.caption, { color: colors.text, letterSpacing: 0, maxWidth: 200 }]}>{a.name}</Text>
                <Icon size={12} color={colors.muted} d={I.x} />
              </Pressable>
            ))}
          </View>
        )}
        <View style={styles.pill}>
          {recording ? (
            <View style={styles.pillRow}>
              <Pressable onPress={() => stopRecording(false)} style={styles.roundBtn}><Icon d={I.x} size={18} /></Pressable>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 }}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent }} />
                <Text style={{ fontFamily: mono, fontSize: 15, color: colors.text }}>{fmt(rec.durationMillis / 1000)}</Text>
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 28 }}>
                  {Array.from({ length: 28 }, (_, i) => {
                    const v = levels.current[levels.current.length - 28 + i] ?? 0;
                    return <View key={i} style={{ width: 3, height: 6 + v * 20, borderRadius: 2, backgroundColor: i >= 28 - levels.current.length ? colors.text : colors.muted }} />;
                  })}
                </View>
              </View>
              <Pressable onPress={() => stopRecording(true)} style={[styles.roundBtn, { backgroundColor: colors.accent }]}><Icon d={I.check} size={18} color={colors.white} sw={2.6} /></Pressable>
            </View>
          ) : (
            <>
              <TextInput
                ref={inputRef}
                value={text} onChangeText={setText} placeholder={online ? T('message') : T('noConnection')} placeholderTextColor={colors.muted}
                multiline style={styles.input} editable={online}
              />
              <View style={styles.pillRow}>
                <Pressable style={styles.roundBtn} onPress={() => setAttachOpen(true)} disabled={uploading || !online}>{uploading ? <Spinner /> : <Icon d={I.plus} />}</Pressable>
                {/* The model sits where it is picked, one tap from the message
                    being written with it. */}
                <Pressable onPress={openModelSheet} style={styles.modelChip}>
                  <Text numberOfLines={1} style={[type.sub, { color: colors.text, fontWeight: '600' }]}>{modelLabel || '…'}</Text>
                  {!!chat?.effort && <Text style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>{chat.effort}</Text>}
                  <ChevronDown size={14} />
                </Pressable>
                <View style={{ flex: 1 }} />
                {busy ? (
                  // A running turn is not a locked door. Stop is always there, and
                  // anything typed next goes in the queue for the agent to pick up
                  // when it comes up for air — no need to cut it off first.
                  <>
                    <Pressable onPress={() => interrupt(id!)} style={[styles.roundBtn, { backgroundColor: colors.text }]}>
                      <Svg width={14} height={14} viewBox="0 0 24 24" fill={colors.bg}><Rect x="5" y="5" width="14" height="14" rx="3" /></Svg>
                    </Pressable>
                    {canSend ? (
                      <Pressable onPress={onSend} style={[styles.roundBtn, { backgroundColor: colors.accent }]}><Icon d={I.up} size={18} color={colors.white} sw={2.4} /></Pressable>
                    ) : null}
                  </>
                ) : canSend ? (
                  <Pressable onPress={onSend} style={[styles.roundBtn, { backgroundColor: colors.accent }]}><Icon d={I.up} size={18} color={colors.white} sw={2.4} /></Pressable>
                ) : (
                  <Pressable onPress={startRecording} disabled={!online || uploading} style={[styles.roundBtn, { backgroundColor: 'transparent' }]}><Icon d={I.mic} sw={2} /></Pressable>
                )}
              </View>
            </>
          )}
        </View>
      </View>

      {/* Attach sheet (design/AttachSheet.dc.html) */}
      <Modal visible={attachOpen} transparent animationType="slide" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.dim} onPress={() => setAttachOpen(false)} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 24 }]}>
          <View style={styles.handle} />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {attachActions.map((a) => (
              <Pressable key={a.key} onPress={() => { setAttachOpen(false); setTimeout(() => void a.run(), 350); }} style={{ flex: 1, alignItems: 'center', gap: 8 }}>
                <View style={styles.tile}><Icon d={a.icon} size={26} sw={1.8} /></View>
                <Text style={[type.caption, { color: colors.text, letterSpacing: 0, fontSize: 12 }]}>{a.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 14 }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <Text style={[type.sub, { color: colors.muted, flexShrink: 1 }]}>{T('uploadsNote')}</Text>
            <Text style={{ fontFamily: mono, fontSize: 12, color: colors.muted }}>~/.remote-ai-chat/uploads</Text>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingBottom: 8 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  modelChip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: 14, borderRadius: 19, backgroundColor: colors.surface2, maxWidth: 220 },
  pill: { gap: 2, padding: 6, borderRadius: 26, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  input: { alignSelf: 'stretch', minHeight: 36, maxHeight: 160, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6, color: colors.text, fontSize: 17, lineHeight: 22 },
  roundBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface2 },
  pendingChip: { flexDirection: 'row', gap: 6, alignItems: 'center', height: 32, paddingHorizontal: 10, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  toast: { position: 'absolute', alignSelf: 'center', bottom: 110, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border2 },
  dim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 10 },
  handle: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(241,236,227,0.2)', marginBottom: 16 },
  tile: { width: 60, height: 60, borderRadius: 18, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
});
