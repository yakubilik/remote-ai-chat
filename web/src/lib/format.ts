const HOME = /^\/Users\/[^/]+|^\/home\/[^/]+|^C:\\Users\\[^\\]+/i;
const HOME_ANYWHERE = /\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+|C:\\Users\\[^\\\s'"]+/gi;

/** `/Users/you/projects/some-app` → `~/projects/some-app`. */
export function tilde(path: string | null | undefined): string {
  if (!path) return '';
  return path.replace(HOME, '~');
}

/** Same, but for a whole command line, where the path is somewhere in the
 *  middle: a one-line summary has no room for a home directory, and a shared
 *  screen has no reason to carry the account name. Display only. */
export function tildeAll(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(HOME_ANYWHERE, '~');
}

/** The last one or two segments, for when a full path will not fit. */
export function shortPath(path: string | null | undefined, keep = 2): string {
  const t = tilde(path);
  const parts = t.split(/[/\\]/).filter(Boolean);
  if (parts.length <= keep) return t;
  return '…/' + parts.slice(-keep).join('/');
}

export function cost(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function tokens(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function duration(ms: number | null | undefined): string {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '—';
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function uptime(seconds: number | null | undefined): string {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return '—';
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Wall-clock, for the event feed where the exact second matters. */
export function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** "3m", "yesterday", "12 Sep" — for lists, where only recency matters. */
export function ago(ts: number | null | undefined): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const diff = Date.now() / 1000 - n;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 172800) return 'yesterday';
  return new Date(n * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Seconds until a plan window resets, as "2h 14m". */
export function until(ts: number | null | undefined): string {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '';
  const diff = n - Date.now() / 1000;
  return diff <= 0 ? 'now' : uptime(diff);
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day',
  seven_day_opus: '7-day · Opus',
  seven_day_sonnet: '7-day · Sonnet',
  overage: 'overage',
};

export function windowName(w: string): string {
  return WINDOW_LABEL[w] ?? w.replace(/_/g, ' ');
}

/** The bit of a tool call worth showing on one line. */
export function toolSummary(tool: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick = (k: string) => (typeof input[k] === 'string' ? input[k] : null);
  const v = pick('command') ?? pick('file_path') ?? pick('path') ?? pick('pattern')
    ?? pick('url') ?? pick('query') ?? pick('prompt') ?? pick('description') ?? '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') return tilde(s);
  return tildeAll(s);
}
