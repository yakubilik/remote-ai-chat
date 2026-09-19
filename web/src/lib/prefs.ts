import { create } from 'zustand';
import type { CliAccount, Provider, ProviderCatalog } from './protocol';

/** What a new chat opens with, per tool. Null means "whatever that computer
 *  offers first": a stored model, effort or permission word is only ever a
 *  preference, and a catalog that no longer lists it wins. */
export interface ProviderDefaults {
  model: string | null;
  effort: string | null;
  perm_mode: string | null;
  /** '' is a real answer — the computer's own sign-in, which `chat.create`
   *  takes as no account id at all. */
  account_id: string;
}

/** Defaults belong to a computer, not to this browser: models, accounts and
 *  folders are all things only that daemon can name. Keyed by `hostKey`. */
export interface Defaults {
  provider: Provider;
  cwd: string | null;
  byProvider: Partial<Record<Provider, ProviderDefaults>>;
}

const KEY = 'rac.defaults';

/** Shared constants, not fresh objects: components read these straight out of
 *  a zustand selector, where a new object every render is a re-render loop. */
export const NO_DEFAULTS: Defaults = { provider: 'claude', cwd: null, byProvider: {} };
export const NO_PROVIDER_DEFAULTS: ProviderDefaults = {
  model: null, effort: null, perm_mode: null, account_id: '',
};

function load(): Record<string, Defaults> {
  try {
    const raw = localStorage.getItem(KEY);
    const d = raw ? JSON.parse(raw) : null;
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

interface PrefsState {
  defaults: Record<string, Defaults>;
  setDefaults: (key: string, patch: Partial<Defaults>) => void;
  setProviderDefaults: (key: string, provider: Provider, patch: Partial<ProviderDefaults>) => void;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  defaults: load(),

  setDefaults: (key, patch) => {
    const defaults = {
      ...get().defaults,
      [key]: { ...NO_DEFAULTS, ...(get().defaults[key] ?? {}), ...patch },
    };
    set({ defaults });
    try { localStorage.setItem(KEY, JSON.stringify(defaults)); } catch { /* private mode */ }
  },

  setProviderDefaults: (key, provider, patch) => {
    const host = get().defaults[key] ?? NO_DEFAULTS;
    const current = host.byProvider[provider] ?? NO_PROVIDER_DEFAULTS;
    get().setDefaults(key, {
      byProvider: { ...host.byProvider, [provider]: { ...current, ...patch } },
    });
  },
}));

/** The defaults stored for one computer — `NO_DEFAULTS` until it has any. */
export function hostDefaults(defaults: Record<string, Defaults>, key: string): Defaults {
  return defaults[key] ?? NO_DEFAULTS;
}

export function providerDefaults(d: Defaults, provider: Provider): ProviderDefaults {
  return d.byProvider[provider] ?? NO_PROVIDER_DEFAULTS;
}

/** What a new chat would actually open with, for one tool on one computer: the
 *  stored default where the catalog still lists it, the tool's own first answer
 *  where it does not. New chat and Settings resolve it the same way, or
 *  Settings would be describing a chat nobody is about to open. */
export function resolveDefaults(
  pd: ProviderDefaults, pc: ProviderCatalog | null, accounts: CliAccount[] = [],
) {
  const models = pc?.models ?? [];
  const efforts = pc?.efforts ?? [];
  const perms = pc?.perm_modes ?? [];
  const pick = (stored: string | null, known: string[], fallback: string | null) =>
    (stored && known.includes(stored) ? stored : fallback);
  return {
    model: pick(pd.model, models.map((m) => m.id), models[0]?.id ?? null),
    // Not the first effort but the third: they run low to high, and a tool that
    // offers fewer takes the highest it has.
    effort: pick(pd.effort, efforts, efforts.length ? efforts[Math.min(2, efforts.length - 1)] : null),
    perm_mode: pick(pd.perm_mode, perms, perms[0] ?? null),
    // An account this computer no longer has falls back to its own sign-in,
    // never to whichever other account happens to be there.
    account_id: accounts.some((a) => !a.is_default && a.id === pd.account_id) ? pd.account_id : '',
  };
}
