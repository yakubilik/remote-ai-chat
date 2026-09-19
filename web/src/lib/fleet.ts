import { create } from 'zustand';
import { RacClient, type ConnStatus } from './ws';
import type {
  Catalog, Chat, CliAccount, Group, HostConfig, HostInfo, LimitWindow, Project, RacEvent,
} from './protocol';

/** A computer is identified by where it answers, not by the name it was paired
 *  under: two entries pointing at the same daemon are the same computer. */
export function hostKey(cfg: Pick<HostConfig, 'host' | 'port'>): string {
  return `${cfg.host}:${cfg.port}`;
}

export interface HostSlot {
  cfg: HostConfig;
  status: ConnStatus;
  info: HostInfo | null;
  catalog: Catalog | null;
  chats: Chat[];
  groups: Group[];
  projects: Project[];
  accounts: CliAccount[];
  /** account id → the windows that account last reported */
  limits: Record<string, LimitWindow[]>;
  /** set while a slow refresh (account.list shells out to the CLIs) is in flight */
  loading: Record<string, boolean>;
  lastOnline: number | null;
}

export interface Activity {
  id: number;
  hostKey: string;
  hostName: string;
  chatId: string | null;
  event: string;
  ts: number;
  text: string;
}

const ACTIVITY_MAX = 300;

/** The panel is the only client that talks to every paired computer at once —
 *  that is the whole point of it, and the reason it cannot reuse the phone's
 *  single-socket store. One RacClient per computer, all live, merged here.
 *  Clients are kept outside the store because they are not state: they are the
 *  thing that produces it. */
const clients = new Map<string, RacClient>();
const unsubs = new Map<string, (() => void)[]>();

let activitySeq = 0;

/** Anything that wants every event from every computer without owning a socket.
 *  timeline.ts registers here; keeping it a plain registry is what stops the
 *  two stores from importing each other in a circle. */
type Tap = (hostKey: string, ev: RacEvent) => void;
const taps = new Set<Tap>();
export function onAnyEvent(tap: Tap): () => void {
  taps.add(tap);
  return () => { taps.delete(tap); };
}

interface FleetState {
  hosts: Record<string, HostSlot>;
  order: string[];
  activity: Activity[];
  /** which computer the chat/projects/agents screens are looking at */
  focus: string | null;
  /** chats from every paired computer in one list, rather than just `focus`.
   *  `focus` keeps running underneath it — it is still the computer a new chat
   *  would start on, and the one the other screens look at. */
  allHosts: boolean;
  ready: boolean;

  boot: () => void;
  addHost: (cfg: HostConfig) => void;
  removeHost: (key: string) => void;
  setFocus: (key: string | null) => void;
  setAllHosts: (on: boolean) => void;
  refresh: (key: string) => Promise<void>;
  refreshAccounts: (key: string) => Promise<void>;
  call: <T = any>(key: string, type: string, data?: Record<string, any>) => Promise<T>;
}

function emptySlot(cfg: HostConfig): HostSlot {
  return {
    cfg, status: 'idle', info: null, catalog: null,
    chats: [], groups: [], projects: [], accounts: [], limits: {},
    loading: {}, lastOnline: null,
  };
}

function loadHosts(): HostConfig[] {
  try {
    const raw = localStorage.getItem('rac.hosts');
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((h) => h && h.host && h.port && h.token) : [];
  } catch { return []; }
}

function saveHosts(hosts: HostConfig[]) {
  localStorage.setItem('rac.hosts', JSON.stringify(hosts));
}

/** Which way the chat list was left last time. Remembered because it is a way
 *  of working, not a filter you re-pick every morning. */
function loadAllHosts(): boolean {
  try { return localStorage.getItem('rac.allHosts') === '1'; } catch { return false; }
}

/** A pairing handed over in the address bar: the `web` command opens the panel
 *  at …/#t=<token>&h=<host>&p=<port>&n=<name>. Consumed once, then wiped from
 *  the URL so the token does not sit in the address bar or in history. */
function hostFromHash(): HostConfig | null {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  const q = new URLSearchParams(hash);
  const token = q.get('t');
  if (!token) return null;
  const cfg: HostConfig = {
    token,
    host: q.get('h') || location.hostname || '127.0.0.1',
    port: Number(q.get('p') || location.port || 8790),
    name: q.get('n') || 'This computer',
    device_id: q.get('d') || undefined,
  };
  history.replaceState(null, '', location.pathname + location.search);
  return Number.isFinite(cfg.port) && cfg.port > 0 ? cfg : null;
}

export const useFleet = create<FleetState>((set, get) => ({
  hosts: {},
  order: [],
  activity: [],
  focus: null,
  allHosts: loadAllHosts(),
  ready: false,

  boot: () => {
    if (get().ready) return;
    const stored = loadHosts();
    const fromUrl = hostFromHash();
    const all = [...stored];
    if (fromUrl) {
      const i = all.findIndex((h) => hostKey(h) === hostKey(fromUrl));
      if (i >= 0) all[i] = fromUrl; else all.push(fromUrl);
      saveHosts(all);
    }
    const hosts: Record<string, HostSlot> = {};
    for (const cfg of all) hosts[hostKey(cfg)] = emptySlot(cfg);
    const order = all.map(hostKey);
    set({ hosts, order, ready: true, focus: order[0] ?? null });
    for (const cfg of all) attach(cfg, set, get);

    // Dev server only: `npm run dev` runs on its own origin with no pairing in
    // the URL, so a gitignored public/dev-host.json stands in for one. Vite
    // strips this whole block from a production build.
    if (import.meta.env.DEV && !all.length) {
      fetch('/dev-host.json')
        .then((r) => (r.ok ? r.json() : null))
        .then((cfg) => { if (cfg?.token && cfg?.host) get().addHost(cfg); })
        .catch(() => {});
    }
  },

  addHost: (cfg) => {
    const key = hostKey(cfg);
    const all = loadHosts().filter((h) => hostKey(h) !== key);
    all.push(cfg);
    saveHosts(all);
    set((s) => ({
      hosts: { ...s.hosts, [key]: emptySlot(cfg) },
      order: s.order.includes(key) ? s.order : [...s.order, key],
      focus: s.focus ?? key,
    }));
    detach(key);
    attach(cfg, set, get);
  },

  removeHost: (key) => {
    detach(key);
    saveHosts(loadHosts().filter((h) => hostKey(h) !== key));
    set((s) => {
      const hosts = { ...s.hosts };
      delete hosts[key];
      const order = s.order.filter((k) => k !== key);
      return { hosts, order, focus: s.focus === key ? (order[0] ?? null) : s.focus };
    });
  },

  setFocus: (key) => set({ focus: key }),

  setAllHosts: (on) => {
    localStorage.setItem('rac.allHosts', on ? '1' : '0');
    set({ allHosts: on });
  },

  call: async (key, type, data = {}) => {
    const c = clients.get(key);
    if (!c) throw new Error('That computer is not connected');
    return c.call(type, data);
  },

  refresh: async (key) => {
    const c = clients.get(key);
    if (!c) return;
    const [list, projects, info] = await Promise.allSettled([
      c.call('chat.list', {}),
      c.call('host.projects', {}),
      c.call('host.info', {}),
    ]);
    patch(set, key, (slot) => ({
      ...slot,
      chats: list.status === 'fulfilled' ? list.value.chats : slot.chats,
      groups: list.status === 'fulfilled' ? list.value.groups : slot.groups,
      projects: projects.status === 'fulfilled' ? projects.value.projects : slot.projects,
      info: info.status === 'fulfilled' ? info.value : slot.info,
    }));
    // Plan usage only reaches the phone as an event during a turn, so a panel
    // that just opened would show nothing. limits.get is the cold-start read.
    try {
      const lim = await c.call('limits.get', {});
      patch(set, key, (slot) => ({ ...slot, limits: lim?.accounts ?? {} }));
    } catch { /* older daemon: no limits.get, events will fill it in */ }
  },

  /** account.list shells out to both CLIs and can take seconds, so it is never
   *  part of the connect path — screens that need it ask for it. */
  refreshAccounts: async (key) => {
    const c = clients.get(key);
    if (!c) return;
    patch(set, key, (s) => ({ ...s, loading: { ...s.loading, accounts: true } }));
    try {
      const r = await c.call('account.list', {});
      patch(set, key, (s) => ({ ...s, accounts: r.accounts ?? [] }));
    } finally {
      patch(set, key, (s) => ({ ...s, loading: { ...s.loading, accounts: false } }));
    }
  },
}));

type Setter = (fn: (s: FleetState) => Partial<FleetState>) => void;

function patch(set: Setter, key: string, fn: (slot: HostSlot) => HostSlot) {
  set((s) => {
    const slot = s.hosts[key];
    if (!slot) return {};
    return { hosts: { ...s.hosts, [key]: fn(slot) } };
  });
}

function pushActivity(set: Setter, key: string, name: string, ev: RacEvent, text: string) {
  const item: Activity = {
    id: ++activitySeq, hostKey: key, hostName: name,
    chatId: ev.chat_id, event: ev.event, ts: ev.ts || Date.now() / 1000, text,
  };
  set((s) => ({ activity: [item, ...s.activity].slice(0, ACTIVITY_MAX) }));
}

/** One line for the live feed, or null for the events that are only noise at
 *  fleet level (every token of a streaming answer, for one). */
function activityText(ev: RacEvent): string | null {
  const d = ev.data || {};
  switch (ev.event) {
    case 'tool.use': return `${d.tool} ${firstArg(d.input)}`.trim();
    case 'tool.result': return d.is_error ? 'the tool errored' : null;
    case 'approval.request': return `awaiting approval · ${d.tool}`;
    case 'approval.resolved': return `approval ${d.decision}`;
    case 'turn.started': return 'turn started';
    case 'turn.done': return `turn done · ${fmtCost(d.cost_usd)}`;
    case 'turn.error': return `error · ${String(d.message ?? '').slice(0, 120)}`;
    case 'message.user': return d.queued ? 'message queued' : 'message sent';
    default: return null;
  }
}

function firstArg(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.prompt ?? '';
  return String(v).replace(/\s+/g, ' ').slice(0, 90);
}

function fmtCost(v: any): string {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(3)}` : '—';
}

function attach(cfg: HostConfig, set: Setter, get: () => FleetState) {
  const key = hostKey(cfg);
  const c = new RacClient();
  clients.set(key, c);

  const offStatus = c.onStatus((status: ConnStatus) => {
    patch(set, key, (slot) => ({
      ...slot, status,
      lastOnline: status === 'online' ? Date.now() : slot.lastOnline,
    }));
    if (status === 'online') {
      c.call('hello', { device_name: cfg.name || 'Panel' })
        .then((r: any) => patch(set, key, (slot) => ({
          ...slot, info: r.host ?? slot.info, catalog: r.catalog ?? slot.catalog,
        })))
        .then(() => get().refresh(key))
        .catch(() => {});
    }
  });

  const offEvent = c.on((ev: RacEvent) => {
    const name = get().hosts[key]?.info?.name || cfg.name;
    patch(set, key, (slot) => reduce(slot, ev));
    for (const tap of taps) tap(key, ev);
    const line = activityText(ev);
    if (line) pushActivity(set, key, name, ev, line);
    // A finished turn is when spend and plan usage actually moved.
    if (ev.event === 'turn.done') {
      c.call('limits.get', {})
        .then((lim: any) => patch(set, key, (slot) => ({ ...slot, limits: lim?.accounts ?? slot.limits })))
        .catch(() => {});
    }
  });

  unsubs.set(key, [offStatus, offEvent]);
  c.connect(cfg.host, cfg.port, cfg.token);
}

function detach(key: string) {
  for (const off of unsubs.get(key) ?? []) off();
  unsubs.delete(key);
  clients.get(key)?.disconnect();
  clients.delete(key);
}

/** Fold one event into a computer's slot. Chat timelines are built elsewhere
 *  (timeline.ts); this only keeps the fleet-level lists true. */
function reduce(slot: HostSlot, ev: RacEvent): HostSlot {
  const d: any = ev.data || {};
  switch (ev.event) {
    case 'host.status':
      return { ...slot, info: d };
    case 'chats.changed':
      return { ...slot, chats: d.chats ?? slot.chats };
    case 'groups.changed':
      return { ...slot, groups: d.groups ?? slot.groups };
    case 'chat.created':
      return { ...slot, chats: [d, ...slot.chats.filter((c) => c.id !== d.id)] };
    case 'chat.updated':
      return { ...slot, chats: slot.chats.map((c) => (c.id === d.id ? d : c)) };
    case 'chat.deleted':
      return { ...slot, chats: slot.chats.filter((c) => c.id !== d.id) };
    default:
      return slot;
  }
}

export function clientFor(key: string): RacClient | undefined {
  return clients.get(key);
}

/** Everything that is running, anywhere, newest first — the one question the
 *  panel exists to answer. */
export interface Running { hostKey: string; hostName: string; chat: Chat }

export function selectRunning(s: FleetState): Running[] {
  const out: Running[] = [];
  for (const key of s.order) {
    const slot = s.hosts[key];
    if (!slot) continue;
    const name = slot.info?.name || slot.cfg.name;
    for (const chat of slot.chats) {
      if (chat.status !== 'idle') out.push({ hostKey: key, hostName: name, chat });
    }
  }
  return out.sort((a, b) => {
    const rank = (c: Chat) => (c.status === 'awaiting_approval' ? 0 : 1);
    return rank(a.chat) - rank(b.chat) || b.chat.updated_at - a.chat.updated_at;
  });
}
