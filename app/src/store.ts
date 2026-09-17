import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback } from 'react';
import { client, type ConnStatus } from './ws';
import { t as tt, type Key } from './i18n';
import type { Agent, Catalog, Chat, CliAccount, LimitWindow, LimitsEvent, UpdateStatus, StoreSource, Provider, Defaults, Group, HostConfig, HostInfo, LoginDone, LoginPrompt, Project, RacEvent, ToolStatus } from './protocol';

const HOSTS_KEY = 'rac.hosts';
const ACTIVE_KEY = 'rac.activeHost';
const DEFAULTS_KEY = 'rac.defaults';
const PREFS_KEY = 'rac.prefs';

export interface LiveText { segment: number; text: string; final?: boolean }
export interface TurnProgress { output_tokens: number; open_tools: number }
export interface StoredHost extends HostConfig { id: string }
/** How the chat list is laid out. `grouped` keeps the project/group sections;
 *  `flat` is one list, newest first. A preference, not a computed thing — the
 *  same list can be read either way and only the person reading it knows which. */
export type ChatView = 'grouped' | 'flat';
export interface Prefs {
  faceIdLaunch: boolean; faceIdBypass: boolean; chatView: ChatView;
}
export interface DeviceInfo { id: string; name: string; push_approval: boolean; push_done: boolean; has_push_token: boolean }
export interface Attachment { path: string; name: string; size?: number; kind?: 'image' | 'video' | 'audio' | 'file'; url?: string; transcript?: string; duration?: number; localUri?: string }

interface State {
  ready: boolean;
  hosts: StoredHost[];
  activeHostId: string | null;
  host: StoredHost | null;                // derived: the active host
  conn: ConnStatus;
  // A computer switch is in flight: the outgoing computer's chats are still on
  // screen (inert) so the swap reads as a crossfade instead of a blank list.
  switching: boolean;
  hostInfo: HostInfo | null;
  catalog: Catalog | null;
  device: DeviceInfo | null;
  projects: Project[];
  accounts: CliAccount[];
  tools: ToolStatus[];
  npmAvailable: boolean;
  loginPrompt: LoginPrompt | null;
  loginDone: LoginDone | null;
  // a sign-in is running somewhere: the CLI drives one browser session at a
  // time, so a second one started in parallel puts its code in the wrong pty
  // a list that has not answered yet must not be drawn as an empty list
  agents: Agent[];
  agentsLoaded: boolean;
  storeSources: StoreSource[];
  storeLoaded: boolean;
  loadStore: () => Promise<void>;
  installAgent: (id: string, accountId?: string | null) => Promise<void>;
  removeAgent: (name: string, accountId?: string | null) => Promise<void>;
  loadAgents: (accountId?: string | null, cwd?: string | null) => Promise<void>;
  // account id -> the windows that account's plan reports
  limits: Record<string, LimitWindow[]>;
  // tool call id -> what the background agent it started is doing right now.
  // Live only: a helper's step-by-step is progress, not conversation, and the
  // answer it produces arrives as that tool's result.
  agentActivity: Record<string, { tools: number; tool?: string | null; text?: string }>;
  chatsLoaded: boolean;
  accountsLoaded: boolean;
  projectsLoaded: boolean;
  loginBusy: boolean;
  // set the moment a code goes to the computer, so no screen offers the code
  // field again while the CLI is finishing
  loginSubmitting: boolean;
  installLog: string;
  defaults: Defaults;
  prefs: Prefs;
  locked: boolean;
  pushToken: string | null;
  chats: Record<string, Chat>;
  groups: Group[];
  showArchived: boolean;
  events: Record<string, RacEvent[]>;
  live: Record<string, LiveText | null>;
  progress: Record<string, TurnProgress | null>;
  thinking: Record<string, string>;
  busy: Record<string, boolean>;
  loadedChats: Record<string, boolean>;

  init: () => Promise<void>;
  addHost: (cfg: HostConfig) => Promise<void>;
  switchHost: (id: string) => Promise<void>;
  removeHost: (id: string) => Promise<void>;
  setDefaults: (d: Partial<Defaults>) => Promise<void>;
  setPrefs: (p: Partial<Prefs>) => Promise<void>;
  setDevicePrefs: (p: { push_approval?: boolean; push_done?: boolean }) => Promise<void>;
  setPushToken: (t: string | null) => void;
  authenticate: (reason: string) => Promise<boolean>;
  unlock: () => Promise<boolean>;
  lock: () => void;
  refresh: () => Promise<void>;
  refreshHost: () => Promise<void>;
  // Where the active computer stands against origin/main.
  updateStatus: UpdateStatus | null;
  checkUpdate: (refresh?: boolean) => Promise<void>;
  applyUpdate: () => Promise<{ ok: boolean; error?: string }>;
  setShowArchived: (v: boolean) => void;
  settleLive: (chatId: string) => void;
  loadProjects: () => Promise<void>;
  openChat: (id: string) => Promise<void>;
  createChat: (d: Partial<Chat> & { provider: string }) => Promise<Chat>;
  updateChat: (id: string, fields: Partial<Chat>) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  send: (id: string, text: string, attachments?: Attachment[]) => Promise<void>;
  interrupt: (id: string) => Promise<void>;
  respond: (id: string, requestId: string, decision: 'allow' | 'allow_session' | 'deny') => Promise<void>;
  uploadAttachment: (chatId: string, uri: string, name: string) => Promise<Attachment>;
  loadAccounts: () => Promise<void>;
  createAccount: (provider: Provider, label: string) => Promise<CliAccount>;
  importSignIn: (accountId: string, credentials: Record<string, unknown>) =>
    Promise<CliAccount & { verified: boolean; verify_error: string | null }>;
  startLogin: (accountId: string, opts?: { email?: string; method?: string; api_key?: string }) => Promise<{ needs_code: boolean }>;
  submitLoginCode: (accountId: string, code: string) => Promise<void>;
  cancelLogin: (accountId: string) => Promise<void>;
  renameAccount: (accountId: string, label: string) => Promise<void>;
  logoutAccount: (accountId: string) => Promise<void>;
  deleteAccount: (accountId: string) => Promise<void>;
  loadTools: () => Promise<void>;
  installTool: (provider: Provider) => Promise<void>;
  createGroup: (name: string) => Promise<Group>;
  renameGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
}

const DEFAULTS: Defaults = { provider: 'claude', model: 'opus', effort: 'high', perm_mode: 'ask', cwd: null };

/** The account the Agents tab works in. Unset means "whatever new chats use";
 *  null is a real answer meaning the computer's own account. Listing, opening
 *  and installing all have to agree, or the tab shows agents a chat cannot
 *  find. */
export function agentAccountOf(d: Defaults): string | null {
  return d.agentAccountId !== undefined ? d.agentAccountId : (d.byProvider?.claude?.account_id ?? null);
}
const PREFS: Prefs = { faceIdLaunch: false, faceIdBypass: true, chatView: 'grouped' };

async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T;
    return { ...(fallback as any), ...parsed } as T;
  } catch { return fallback; }
}

/** If the chat screen is not mounted to type it out, drop the finished segment
 *  anyway — the persisted message renders it in full. */
function scheduleSettle(chatId: string) {
  setTimeout(() => {
    const st = useStore.getState();
    if (st.live[chatId]?.final) st.settleLive(chatId);
  }, 4000);
}

/** chat id -> the chat.get already in the air for it. */
const inFlightOpen = new Map<string, Promise<void>>();

/** Tokens arrive from the tool one or two characters at a time - sixty-odd
 *  events a second on a fast model. Writing each one to the store re-rendered
 *  the open chat that many times a second, on top of the typewriter's own tick.
 *  Collect them and write on a frame the eye can actually see; the chat screen
 *  still types out whatever has landed. */
const pendingDeltas = new Map<string, { segment: number; text: string }>();
let deltaTimer: ReturnType<typeof setTimeout> | null = null;
const DELTA_FLUSH_MS = 80;

function flushDeltas() {
  if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
  if (pendingDeltas.size === 0) return;
  const live = { ...useStore.getState().live };
  for (const [cid, d] of pendingDeltas) {
    const cur = live[cid];
    live[cid] = cur && cur.segment === d.segment ? { ...cur, text: cur.text + d.text } : { segment: d.segment, text: d.text };
  }
  pendingDeltas.clear();
  useStore.setState({ live });
}

function bufferDelta(cid: string, segment: number, text: string) {
  const cur = pendingDeltas.get(cid);
  if (cur && cur.segment === segment) cur.text += text;
  else {
    // A new segment cannot wait behind the previous one's tail.
    if (cur) flushDeltas();
    pendingDeltas.set(cid, { segment, text });
  }
  if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, DELTA_FLUSH_MS);
}

export const useStore = create<State>((set, get) => {
  // Fast Refresh can re-evaluate this module; make sure only the newest store listens.
  const anyClient = client as any;
  if (anyClient.__unbind) anyClient.__unbind();
  const unsubs: (() => void)[] = [];
  anyClient.__unbind = () => { for (const u of unsubs) u(); };

  unsubs.push(client.onStatus((conn) => {
    set({ conn });
    if (conn === 'online') { void afterConnect(); return; }
    // The new computer answered with a refusal or is unreachable: keeping the
    // previous one's chats on screen would be a lie, so end the switch empty.
    if (get().switching && (conn === 'offline' || conn === 'unauthorized')) settleSwitch({ chats: {}, groups: [] });
  }));

  async function afterConnect(attempt = 0): Promise<void> {
    try {
      const hello = await client.call('hello', { device_name: 'iPhone', push_token: get().pushToken ?? undefined });
      set({ hostInfo: hello.host, catalog: hello.catalog, device: hello.device ?? null });
      // What the computer already knows about the plan, so the ring is filled
      // in before the first turn rather than after it.
      client.call<{ accounts: Record<string, LimitWindow[]> }>('limits.get', {})
        .then((r) => set({ limits: r.accounts ?? {} }))
        .catch(() => {});
      await get().refresh();
      // Nothing else is caught up here on purpose. Every chat ever opened used
      // to be re-fetched, one await after another, on every single reconnect —
      // and coming back from the background is a reconnect. Twenty chats meant
      // twenty round trips of up to five hundred events each, twenty store
      // writes and twenty full re-renders before the phone would answer a tap.
      // That is the freeze, and the backlog landing all at once is what it
      // looked like from the outside.
      //
      // The chat on screen already re-fetches itself the moment the connection
      // comes back (see the chat screen's effect on `conn`), and any other chat
      // re-fetches when it is opened. The loop was racing that effect too: both
      // read the same since_seq, so whichever answer landed last won and the
      // events only the other one had seen were dropped.
    } catch (e) {
      console.warn('hello failed', e);
      // The daemon answers slowly right after a restart; try once more before giving up.
      if (attempt < 2 && get().conn === 'online') { setTimeout(() => void afterConnect(attempt + 1), 3000); return; }
      // Out of retries. A switch still holding the previous computer's chats has
      // to let go of them, or the list stays dimmed and inert for good.
      if (get().switching) settleSwitch({ chats: {}, groups: [] });
    }
  }

  unsubs.push(client.on((ev) => {
    // Buffered tokens have to land before anything that reads or replaces the
    // live text, or a flush lands after `message.assistant` and appends a tail
    // the authoritative message already contains.
    if (ev.event !== 'text.delta' && pendingDeltas.size) flushDeltas();
    const s = get();
    const cid = ev.chat_id;
    switch (ev.event) {
      case 'host.status': set({ hostInfo: ev.data }); return;
      // What is left of the plan, straight from the tool. Kept per account so a
      // second subscription's numbers never show up under the first.
      case 'limits': {
        const chat = ev.chat_id ? get().chats[ev.chat_id] : null;
        const key = chat?.account_id || `default-${chat?.provider ?? 'claude'}`;
        const at = Date.now() / 1000;
        // `windows` is the whole plan; the fields beside it describe only the
        // window the tool singled out. Take the list when it is there, and fall
        // back to the single window for a computer that has not been updated.
        const { windows, ...headline } = (ev.data ?? {}) as LimitsEvent;
        const incoming: LimitWindow[] = (windows?.length ? windows : [headline as LimitWindow])
          .filter((w) => w && w.window)
          .map((w) => ({ ...w, at }));
        if (incoming.length === 0) return;
        const fresh = new Set(incoming.map((w) => w.window));
        const rest = (get().limits[key] ?? []).filter((w) => !fresh.has(w.window));
        set({ limits: { ...get().limits, [key]: [...rest, ...incoming] } });
        return;
      }
      case 'update.available': set({ updateStatus: { ...(get().updateStatus ?? {} as UpdateStatus), ...ev.data } }); return;
      case 'update.applied': return;   // the socket is about to drop; the reconnect tells the truth
      case 'agent.activity': {
        const id = ev.data?.id;
        if (!id) return;
        set({ agentActivity: { ...get().agentActivity, [id]: {
          tools: ev.data.tools ?? 0, tool: ev.data.tool, text: ev.data.text } } });
        return;
      }
      case 'account.login.prompt': set({ loginPrompt: ev.data }); return;
      case 'account.login.done': set({ loginDone: ev.data, loginPrompt: null, loginBusy: false, loginSubmitting: false }); return;
      case 'tool.install.output': set({ installLog: (s.installLog + ev.data.line).slice(-4000) }); return;
      case 'groups.changed': set({ groups: ev.data.groups }); return;
      case 'chats.changed': { const chats: Record<string, Chat> = {}; for (const c of ev.data.chats as Chat[]) chats[c.id] = c; set({ chats }); return; }
      case 'chat.created':
      case 'chat.updated': set({ chats: { ...s.chats, [ev.data.id]: ev.data } }); return;
      case 'chat.deleted': { const chats = { ...s.chats }; delete chats[ev.data.id]; set({ chats }); return; }
    }
    if (!cid) return;
    switch (ev.event) {
      case 'turn.started':
        set({ busy: { ...s.busy, [cid]: true }, live: { ...s.live, [cid]: null },
              progress: { ...s.progress, [cid]: null }, thinking: { ...s.thinking, [cid]: '' } });
        return;
      case 'text.delta':
        bufferDelta(cid, ev.data.segment as number, ev.data.text as string);
        return;
      case 'turn.progress':
        set({ progress: { ...s.progress, [cid]: ev.data } });
        return;
      case 'thinking.delta':
        set({ thinking: { ...s.thinking, [cid]: ((s.thinking[cid] || '') + ev.data.text).slice(-600) } });
        return;
    }
    if (ev.seq != null) {
      const list = s.events[cid] || [];
      const last = list.length ? list[list.length - 1].seq! : 0;
      if (ev.seq <= last) return;
      const patch: Partial<State> = { events: { ...s.events, [cid]: [...list, ev] } };
      if (ev.event === 'message.assistant') {
        const cur = s.live[cid];
        // Hand the authoritative text to the live item and mark it final; the chat
        // screen keeps typing it out and calls settleLive() when it catches up.
        if (cur && cur.segment === ev.data.segment) {
          patch.live = { ...s.live, [cid]: { segment: cur.segment, text: ev.data.text, final: true } };
          scheduleSettle(cid);
        }
        patch.thinking = { ...s.thinking, [cid]: '' };
      }
      if (ev.event === 'turn.done' || ev.event === 'turn.error') {
        patch.busy = { ...s.busy, [cid]: false };
        const cur = s.live[cid];
        if (!cur?.final) patch.live = { ...s.live, [cid]: null };
        patch.thinking = { ...s.thinking, [cid]: '' };
        // No agent is still working once the turn is over, and a stale "running
        // 12 tools" under a finished card would be a lie.
        patch.agentActivity = {};
      }
      set(patch);
    }
  }));

  /** Everything that belongs to one computer and must not outlive it. */
  const perHost = () => {
    pendingDeltas.clear();
    return {
      chats: {}, groups: [], events: {}, live: {}, busy: {}, loadedChats: {}, hostInfo: null, catalog: null, device: null, projects: [],
      chatsLoaded: false, accountsLoaded: false, projectsLoaded: false, accounts: [],
      agents: [], agentsLoaded: false, storeSources: [], storeLoaded: false, limits: {}, agentActivity: {}, updateStatus: null,
    };
  };

  /** Wipe what the outgoing computer left behind and clear the switching flag. */
  function settleSwitch(extra: Partial<State> = {}) {
    pendingDeltas.clear();
    set({ events: {}, live: {}, busy: {}, loadedChats: {}, switching: false, ...extra } as any);
  }

  function connectTo(h: StoredHost | null, keepList = false) {
    client.disconnect();
    if (keepList) {
      // Hold on to `chats`/`groups` — they are what is on screen — and drop
      // everything else now, since no screen draws it without a live computer.
      set({ hostInfo: null, catalog: null, device: null, projects: [], accounts: [],
            agents: [], agentsLoaded: false, storeSources: [], storeLoaded: false, limits: {}, agentActivity: {}, updateStatus: null,
            chatsLoaded: false, accountsLoaded: false, projectsLoaded: false, switching: true });
    } else {
      set({ ...perHost(), switching: false });
    }
    if (h) client.connect(h.host, h.port, h.token);
  }

  async function persistHosts(hosts: StoredHost[], active: string | null) {
    await SecureStore.setItemAsync(HOSTS_KEY, JSON.stringify(hosts));
    await SecureStore.setItemAsync(ACTIVE_KEY, active ?? '');
    set({ hosts, activeHostId: active, host: hosts.find((h) => h.id === active) ?? null });
  }

  return {
    ready: false, hosts: [], activeHostId: null, host: null, conn: 'idle', switching: false, hostInfo: null, catalog: null, device: null,
    projects: [], accounts: [], tools: [], npmAvailable: true, loginPrompt: null, loginDone: null,
    loginBusy: false, loginSubmitting: false, installLog: '',
    defaults: DEFAULTS, prefs: PREFS, locked: false, pushToken: null,
    chats: {}, groups: [], showArchived: false, events: {}, live: {}, progress: {}, thinking: {}, busy: {}, loadedChats: {},
    agents: [], agentsLoaded: false, storeSources: [], storeLoaded: false, limits: {}, agentActivity: {}, updateStatus: null,
    chatsLoaded: false, accountsLoaded: false, projectsLoaded: false,

    init: async () => {
      let hosts = await loadJSON<StoredHost[]>(HOSTS_KEY, []);
      if (!Array.isArray(hosts)) hosts = [];
      // migrate the single-host key from the first build
      try {
        const legacy = await SecureStore.getItemAsync('rac.host');
        if (legacy && hosts.length === 0) {
          const h = JSON.parse(legacy);
          hosts = [{ ...h, id: h.device_id || `${h.host}:${h.port}` }];
          await SecureStore.deleteItemAsync('rac.host');
          await SecureStore.setItemAsync(HOSTS_KEY, JSON.stringify(hosts));
        }
      } catch {}
      let active = (await SecureStore.getItemAsync(ACTIVE_KEY).catch(() => null)) || null;
      if (!active || !hosts.some((h) => h.id === active)) active = hosts[0]?.id ?? null;
      const defaults = await loadJSON(DEFAULTS_KEY, DEFAULTS);
      const prefs = await loadJSON(PREFS_KEY, PREFS);
      const host = hosts.find((h) => h.id === active) ?? null;
      set({ hosts, activeHostId: active, host, defaults, prefs, locked: prefs.faceIdLaunch, ready: true });
      if (host) client.connect(host.host, host.port, host.token);
    },

    addHost: async (cfg) => {
      const id = cfg.device_id || `${cfg.host}:${cfg.port}`;
      // one entry per host:port — re-pairing the same computer replaces its token
      const hosts = [...get().hosts.filter((h) => h.id !== id && !(h.host === cfg.host && h.port === cfg.port)), { ...cfg, id }];
      await persistHosts(hosts, id);
      connectTo(hosts.find((h) => h.id === id)!);
    },

    switchHost: async (id) => {
      const h = get().hosts.find((x) => x.id === id);
      if (!h || id === get().activeHostId) return;
      await persistHosts(get().hosts, id);
      connectTo(h, true);
    },

    removeHost: async (id) => {
      const wasActive = get().activeHostId === id;
      if (wasActive) {
        try { await client.call('device.revoke_self', {}); } catch {}
      }
      const hosts = get().hosts.filter((h) => h.id !== id);
      const active = wasActive ? (hosts[0]?.id ?? null) : get().activeHostId;
      await persistHosts(hosts, active);
      if (wasActive) connectTo(hosts.find((h) => h.id === active) ?? null);
    },

    setDefaults: async (d) => {
      const defaults = { ...get().defaults, ...d };
      set({ defaults });
      await SecureStore.setItemAsync(DEFAULTS_KEY, JSON.stringify(defaults));
    },

    setPrefs: async (p) => {
      const prefs = { ...get().prefs, ...p };
      set({ prefs });
      await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(prefs));
    },

    setDevicePrefs: async (p) => {
      const r = await client.call('device.prefs', p);
      set({ device: { ...(get().device as DeviceInfo), ...r } });
    },

    setPushToken: (t) => {
      set({ pushToken: t });
      if (t && get().conn === 'online') void client.call('device.prefs', { push_token: t }).catch(() => {});
    },

    authenticate: async (reason) => {
      try {
        const hw = await LocalAuthentication.hasHardwareAsync();
        const enrolled = hw && (await LocalAuthentication.isEnrolledAsync());
        if (!enrolled) return true; // no biometrics on this device → don't lock the user out
        const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: tt('cancel'), disableDeviceFallback: false });
        return r.success;
      } catch { return false; }
    },

    unlock: async () => {
      const ok = await get().authenticate(tt('unlockReason'));
      if (ok) set({ locked: false });
      return ok;
    },

    lock: () => { if (get().prefs.faceIdLaunch) set({ locked: true }); },

    refreshHost: async () => {
      const info = await client.call('host.info', {});
      set({ hostInfo: info });
    },

    checkUpdate: async (refresh = false) => {
      try {
        const st = await client.call<UpdateStatus>('update.status', { refresh });
        set({ updateStatus: st });
      } catch {
        // An older daemon has no update.status. Saying nothing is right: the
        // screen falls back to showing no version row at all.
      }
    },

    applyUpdate: async () => {
      try {
        const r = await client.call<{ ok: boolean; error?: string }>('update.apply', {});
        // A successful apply ends with the daemon exiting, so there is no
        // point re-reading status here — the socket is about to drop and the
        // reconnect brings back the new commit by itself.
        if (!r.ok) await get().checkUpdate(true);
        return r;
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },

    refresh: async () => {
      const r = await client.call('chat.list', { include_archived: true });
      const chats: Record<string, Chat> = {};
      for (const c of r.chats as Chat[]) chats[c.id] = c;
      // Swapping the list and dropping the old computer's per-chat state in one
      // set() is what makes the switch a single frame instead of a flicker.
      if (get().switching) settleSwitch({ chats, groups: r.groups, chatsLoaded: true });
      else set({ chats, groups: r.groups, chatsLoaded: true });
    },

    setShowArchived: (v) => { set({ showArchived: v }); },

    /** Drop a finished live segment once the chat screen has typed it out. */
    settleLive: (chatId) => {
      const cur = get().live[chatId];
      if (cur?.final) set({ live: { ...get().live, [chatId]: null } });
    },

    loadProjects: async () => {
      const r = await client.call('host.projects', {});
      set({ projects: r.projects, projectsLoaded: true });
    },

    openChat: async (id) => {
      // Two callers asking for the same chat at once both read the same
      // since_seq, and the slower answer overwrites the fuller one. Sharing the
      // in-flight request means they cannot disagree about where the chat ends.
      const running = inFlightOpen.get(id);
      if (running) return running;
      const run = (async () => {
        const list = get().events[id] || [];
        const since = list.length ? list[list.length - 1].seq! : 0;
        const r = await client.call('chat.get', { chat_id: id, since_seq: since });
        // Re-read rather than close over `list`: events that streamed in while
        // the request was in the air are already in the store, and dropping
        // back to the old array would throw them away.
        const now = get().events[id] || [];
        const known = since ? now : [];
        const lastSeq = known.length ? known[known.length - 1].seq! : 0;
        const fresh = (r.events as RacEvent[]).filter((e) => (e.seq ?? 0) > lastSeq);
        set({
          chats: { ...get().chats, [id]: r.chat },
          events: { ...get().events, [id]: [...known, ...fresh] },
          busy: { ...get().busy, [id]: !!r.busy },
          loadedChats: { ...get().loadedChats, [id]: true },
        });
      })();
      inFlightOpen.set(id, run);
      try { await run; } finally { inFlightOpen.delete(id); }
    },

    createChat: async (d) => {
      const chat = await client.call<Chat>('chat.create', d);
      set({ chats: { ...get().chats, [chat.id]: chat } });
      return chat;
    },

    updateChat: async (id, fields) => {
      const chat = await client.call<Chat>('chat.update', { chat_id: id, ...fields });
      set({ chats: { ...get().chats, [id]: chat } });
    },

    deleteChat: async (id) => {
      await client.call('chat.delete', { chat_id: id });
      const chats = { ...get().chats }; delete chats[id];
      set({ chats });
    },

    send: async (id, text, attachments) => {
      await client.call('chat.send', { chat_id: id, text, attachments: attachments ?? [] });
    },

    interrupt: async (id) => { await client.call('chat.interrupt', { chat_id: id }); },

    respond: async (id, requestId, decision) => {
      await client.call('approval.respond', { chat_id: id, request_id: requestId, decision });
    },

    uploadAttachment: async (chatId, uri, name) => {
      const h = get().host;
      if (!h) throw new Error(tt('wsNotConnected'));
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('file', { uri, name, type: guessMime(name) } as any);
      const res = await fetch(`http://${h.host}:${h.port}/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${h.token}` }, body: form,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.detail || `${tt('uploadFailed')} (${res.status})`);
      const att = (await res.json()) as Attachment;
      return { ...att, localUri: uri };
    },

    loadAgents: async (accountId, cwd) => {
      const r = await client.call<{ agents: Agent[] }>('agent.list',
        { account_id: accountId ?? null, cwd: cwd ?? null });
      set({ agents: r.agents, agentsLoaded: true });
    },

    loadStore: async () => {
      const r = await client.call<{ sources: StoreSource[] }>('agent.store', {});
      set({ storeSources: r.sources, storeLoaded: true });
    },

    installAgent: async (id, accountId) => {
      await client.call('agent.install', { id, account_id: accountId ?? null });
      await get().loadAgents(accountId ?? null, get().defaults.cwd ?? null);
    },

    removeAgent: async (name, accountId) => {
      await client.call('agent.remove', { name, account_id: accountId ?? null });
      await get().loadAgents(accountId ?? null, get().defaults.cwd ?? null);
    },

    loadAccounts: async () => {
      const r = await client.call('account.list', {});
      set({ accounts: r.accounts, accountsLoaded: true });
    },

    importSignIn: async (accountId, credentials) => {
      // The blob is a bearer credential: it is passed straight through and
      // never kept in the store or on disk.
      const r = await client.call<CliAccount & { verified: boolean; verify_error: string | null }>(
        'account.import', { account_id: accountId, credentials });
      await get().loadAccounts();
      return r;
    },

    createAccount: async (provider, label) => {
      const a = await client.call<CliAccount>('account.create', { provider, label });
      // Show it straight away; asking every account whether it is signed in
      // means shelling out to the tools, and that is not worth waiting for.
      set({ accounts: [...get().accounts, a] });
      void get().loadAccounts().catch(() => {});
      return a;
    },

    startLogin: async (accountId, opts) => {
      set({ loginPrompt: null, loginDone: null, loginBusy: true, loginSubmitting: false });
      try {
        return await client.call('account.login', {
          account_id: accountId, email: opts?.email ?? null,
          method: opts?.method ?? null, api_key: opts?.api_key ?? null });
      } catch (e) {
        set({ loginBusy: false });
        throw e;
      }
    },

    submitLoginCode: async (accountId, code) => {
      set({ loginSubmitting: true });
      try {
        await client.call('account.login.submit', { account_id: accountId, code });
      } catch (e) {
        set({ loginSubmitting: false });
        throw e;
      }
    },

    cancelLogin: async (accountId) => {
      await client.call('account.login.cancel', { account_id: accountId }).catch(() => {});
      set({ loginPrompt: null, loginDone: null, loginBusy: false, loginSubmitting: false });
    },

    renameAccount: async (accountId, label) => {
      await client.call('account.rename', { account_id: accountId, label });
      await get().loadAccounts();
    },

    logoutAccount: async (accountId) => {
      await client.call('account.logout', { account_id: accountId });
      await get().loadAccounts();
      await get().refresh().catch(() => {});
    },

    deleteAccount: async (accountId) => {
      await client.call('account.delete', { account_id: accountId });
      await get().loadAccounts();
      await get().refresh().catch(() => {});
    },

    loadTools: async () => {
      const r = await client.call('tool.status', {});
      set({ tools: r.tools, npmAvailable: r.npm });
    },

    installTool: async (provider) => {
      set({ installLog: '' });
      await client.call('tool.install', { provider });
      await get().loadTools();
      await get().loadAccounts().catch(() => {});
    },

    createGroup: async (name) => {
      const g = await client.call<Group>('group.create', { name });
      set({ groups: [...get().groups, g] });
      return g;
    },

    renameGroup: async (id, name) => {
      await client.call('group.rename', { group_id: id, name });
      set({ groups: get().groups.map((g) => (g.id === id ? { ...g, name } : g)) });
    },

    deleteGroup: async (id) => {
      await client.call('group.delete', { group_id: id });
      set({ groups: get().groups.filter((g) => g.id !== id) });
      await get().refresh();
    },
  };
});

function guessMime(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    mp4: 'video/mp4', mov: 'video/quicktime', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  } as Record<string, string>)[ext ?? ''] || 'application/octet-stream';
}

export interface TimelineItem {
  key: string;
  kind: 'user' | 'assistant' | 'tool' | 'tools' | 'approval' | 'done' | 'error';
  data: any;
  result?: any;
  decision?: string | null;
}

export function buildTimeline(events: RacEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolIdx = new Map<string, number>();
  const apprIdx = new Map<string, number>();
  for (const ev of events) {
    switch (ev.event) {
      case 'message.user': items.push({ key: `u${ev.seq}`, kind: 'user', data: ev.data }); break;
      case 'message.assistant': items.push({ key: `a${ev.seq}`, kind: 'assistant', data: ev.data }); break;
      case 'tool.use': toolIdx.set(ev.data.id, items.length); items.push({ key: `t${ev.seq}`, kind: 'tool', data: ev.data }); break;
      case 'tool.result': { const i = toolIdx.get(ev.data.id); if (i != null) items[i] = { ...items[i], result: ev.data }; break; }
      case 'approval.request': {
        // The tool card for this call arrives just before its approval; show the decision above it.
        const last = items[items.length - 1];
        const pos = last && last.kind === 'tool' && !last.result && last.data.tool === ev.data.tool ? items.length - 1 : items.length;
        items.splice(pos, 0, { key: `p${ev.seq}`, kind: 'approval', data: ev.data, decision: null });
        apprIdx.set(ev.data.request_id, pos);
        if (pos === items.length - 2) toolIdx.set(last.data.id, items.length - 1);
        break;
      }
      case 'approval.resolved': { const i = apprIdx.get(ev.data.request_id); if (i != null) items[i] = { ...items[i], decision: ev.data.decision }; break; }
      case 'turn.done': items.push({ key: `d${ev.seq}`, kind: 'done', data: ev.data }); break;
      case 'turn.error': items.push({ key: `e${ev.seq}`, kind: 'error', data: ev.data }); break;
    }
  }
  return groupTools(items);
}

/** Fold a run of tool calls into one card.
 *
 *  A turn that reads six files used to cost six cards, and the sentence that
 *  explained them scrolled off the top. A run is only folded once it is over:
 *  a call still waiting for its answer stays out in the open, because that is
 *  the one the reader is waiting on. Approvals break a run — a decision must
 *  never be hidden behind a chevron. */
function groupTools(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let run: TimelineItem[] = [];
  const flush = () => {
    if (run.length > 1) out.push({ key: `g${run[0].key}`, kind: 'tools', data: run });
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    if (it.kind === 'tool' && it.result) { run.push(it); continue; }
    flush();
    out.push(it);
  }
  flush();
  return out;
}

/** Every screen's handle on the string table. A hook rather than a bare import
 *  so that the day a second language exists, nothing but this file changes. */
export function useT() {
  return useCallback((key: Key, params?: Record<string, string | number>) => tt(key, params), []);
}

/** Absolute, authenticated URL for a file that lives on the active computer. */
export function fileUrl(path: string): string | null {
  const h = useStore.getState().host;
  if (!h) return null;
  return `http://${h.host}:${h.port}/files?path=${encodeURIComponent(path)}&token=${encodeURIComponent(h.token)}`;
}
