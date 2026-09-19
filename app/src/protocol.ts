// Mirrors docs/PROTOCOL.md

export type Provider = 'claude' | 'codex';
export type ChatStatus = 'idle' | 'running' | 'awaiting_approval';

export interface Chat {
  agent_id?: string | null;
  id: string;
  group_id: string | null;
  title: string;
  provider: Provider;
  model: string;
  effort: string | null;
  perm_mode: string;
  cwd: string;
  provider_session_id: string | null;
  account_id: string | null;
  status: ChatStatus;
  last_preview: string;
  max_turns: number | null;
  max_budget_usd: number | null;
  total_cost_usd: number;
  pinned: number;
  archived: number;
  created_at: number;
  updated_at: number;
  session_ids?: string;
  /** 1 to keep this chat on the sign-in named above even while the account
   *  pool is on. Off by default: the pool is a mode, and a chat is in it
   *  unless somebody says otherwise. */
  pool_pinned?: number;
}

export interface Group { id: string; name: string; sort: number; created_at: number }

export interface HostInfo {
  name: string; os: string; os_version: string; daemon_version: string;
  uptime_s: number; active_sessions: number; connected_devices: number;
  versions: { claude: string | null; codex: string | null };
  roots: string[];
  transcription?: boolean;
  /** The commit this computer is actually running. `daemon_version` is a
   *  constant and cannot tell two computers apart; this can. */
  revision?: Revision | null;
  update?: { behind: number; ahead: number; auto: boolean; repo: boolean;
             error?: string | null; checked_at?: number | null };
}

export interface Revision {
  repo: boolean;
  commit?: string; sha?: string; committed_at?: string; subject?: string;
  branch?: string; dirty?: boolean; dirty_files?: number;
  error?: string;
}

/** Where a computer stands against origin/main, and what is stopping it from
 *  moving onto it. */
export interface UpdateStatus {
  repo: boolean;
  auto: boolean;
  behind: number;
  ahead: number;
  busy: boolean;
  error?: string | null;
  checked_at?: number | null;
  local?: Revision | null;
  remote?: { commit?: string; committed_at?: string; subject?: string } | null;
  blockers?: string[];
}

export interface ProviderCatalog {
  models: { id: string; label: string; hint: string }[];
  efforts: string[];
  perm_modes: string[];
}
export type Catalog = Record<Provider, ProviderCatalog>;

export interface Project { path: string; name: string; is_git: boolean }

export interface RacEvent<T = any> {
  event: string;
  chat_id: string | null;
  seq: number | null;
  data: T;
  ts: number;
}

export interface HostConfig {
  host: string; port: number; token: string; name: string; device_id?: string;
}

export interface ProviderDefaults { model: string; effort: string | null; perm_mode: string; account_id?: string | null }
export interface Defaults {
  provider: Provider; model: string; effort: string; perm_mode: string; cwd: string | null;
  byProvider?: Partial<Record<Provider, ProviderDefaults>>;
  /** Which account the Agents tab reads from and installs into. Agents live in
   *  one account's folder, so this decides which ones exist at all. Left unset
   *  it follows the account new chats use; setting it here does not drag the
   *  chat default along, which is the point of it being its own value. */
  agentAccountId?: string | null;
}

export interface StoreItem {
  id: string;
  kind?: 'bundle';
  skills?: number;
  about?: string;
  label: string;
  glyph: string;
  color: string;
  repo: string;
}

export interface StoreSource {
  id: string;
  label: string;
  repo: string;
  note: string;
  items: StoreItem[];
  error?: string;
}

export interface Agent {
  id: string;
  name: string;
  label: string;
  description: string;
  color: string;
  glyph: string;
  model: string | null;
  scope: 'project' | 'user' | 'builtin';
  // several agents a tool shipped together; the app shows them as one
  family?: string | null;
  // put here by this app, rather than borrowed from the computer's own set
  installed?: boolean;
  path: string;
}

/** One window of the plan's usage, as the tool last reported it. */
export interface LimitWindow {
  window: string;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  utilization: number | null;
  resets_at: number | null;
  overage_status?: string | null;
  overage_resets_at?: number | null;
  overage_disabled_reason?: string | null;
  is_using_overage?: boolean;
  /** When the computer heard this. The tool only measures during a turn, so a
   *  reading can be an hour old and still be the newest one there is. */
  at?: number;
}

/** How the computer drives several sign-ins of one tool as one. */
export interface PoolSettings {
  enabled: boolean;
  /** The share of a window at which a chat is handed over, for any window
   *  `thresholds` does not name. Deliberately short of 1 so the move happens
   *  before the turn dies. */
  threshold: number;
  /** Per window, because the windows are not alike: the five-hour one refills
   *  several times a day, a weekly one is most of a working week. */
  thresholds: Record<string, number>;
  /** The default for a sign-in that has not been given an answer of its own.
   *  'account' leaves a sign-in with pay-as-you-go on in play past its plan;
   *  'never' treats the plan's limit as the limit whatever billing allows. */
  use_overage: 'account' | 'never';
  /** Per sign-in, overriding the default above. One account spending past its
   *  plan while another never touches it is the ordinary case. */
  overage_by_account: Record<string, 'account' | 'never'>;
  /** The reading-to-reading step to assume before a real one has been
   *  measured. The margin is always at least this wide on a sign-in that must
   *  not spend past its plan; once the computer has watched the account long
   *  enough, a wider measured step takes over. */
  reserve: number;
  /** provider -> account ids, in the order they are tried. */
  order: Record<string, string[]>;
  max_hops: number;
}

/** Where one sign-in stands under the pool. */
export interface PoolAccount {
  account_id: string;
  provider: Provider;
  label: string;
  blocked: boolean;
  /** The window that blocked it, and when it comes back. */
  window: string | null;
  until: number | null;
  utilization: number | null;
  /** The plan is spent and pay-as-you-go is carrying the account. */
  on_overage: boolean;
  /** The tool says paid extra usage is covering sends right now. */
  spending: boolean;
  /** The widest jump seen between two readings of one window here, and the
   *  margin actually held back below the threshold because of it. */
  step: number | null;
  margin: number;
  /** This sign-in is not allowed to spend past its plan. */
  strict: boolean;
  /** Nothing has ever been measured for this sign-in. */
  unknown: boolean;
}

/** A limits report: every window the tool measured this turn. The window named
 *  at the top level is the one it singled out, and is repeated inside the list;
 *  it is kept here only for apps written before the list existed. */
export interface LimitsEvent extends LimitWindow {
  windows?: LimitWindow[];
}

export interface CliAccount {
  has_key?: boolean;
  id: string;
  provider: Provider;
  label: string;
  logged_in: boolean;
  detail: string;
  /** The tier this sign-in is on — "max", "pro", "api", … Empty when the tool
   *  does not say; the app falls back to the provider's name. */
  plan?: string;
  is_default: boolean;
}

/** One way a tool can be signed in. The computer decides what is on offer;
 *  the app only knows how to describe each id. */
export interface LoginMethod {
  id: string;
  wants_email?: boolean;
  needs_code?: boolean;
  needs_key?: boolean;
  here?: boolean;
}

export interface ToolStatus {
  provider: Provider;
  version: string | null;
  path: string | null;
  login_methods?: LoginMethod[];
}

/** Sent only to the phone that started a login; never stored. */
export interface LoginPrompt {
  account_id: string;
  provider: Provider;
  url: string | null;
  url_host: string | null;
  code: string | null;
  needs_code: boolean;
  expires_at: number;
}

export interface LoginDone {
  account_id: string;
  ok: boolean;
  error_code?: string | null;
  detail: string;
  error: string | null;
  retryable: boolean;
}
