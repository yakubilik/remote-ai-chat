import { useEffect, useMemo, useRef, useState } from 'react';
import { C, R } from '../lib/theme';
import { Btn, Dot, Empty, Icon, P, Segment, mono } from '../ui/kit';
import { ago, tilde } from '../lib/format';
import { useFleet } from '../lib/fleet';
import type { Chat } from '../lib/protocol';

export interface ProjectsProps {
  onNewChatIn: (cwd: string) => void;
  onOpenChat: (hostKey: string, chatId: string) => void;
}

/** What `host.git` reports per folder. Every field is optional on purpose: a
 *  daemon that predates the call answers with an error and the cards simply do
 *  without, rather than showing a placeholder that means nothing. */
interface GitInfo {
  is_git?: boolean;
  branch?: string | null;
  dirty?: number;
  staged?: number;
  untracked?: number;
  subject?: string | null;
  author?: string | null;
  committed_at?: number | null;
}

const SORTS = ['Last changed', 'Name', 'Open chats'] as const;
type Sort = typeof SORTS[number];

interface Row {
  path: string;
  name: string;
  isGit: boolean;
  git: GitInfo | null;
  chats: Chat[];
  running: number;
  awaiting: number;
  touched: number;
}

const ell: React.CSSProperties = {
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

function Badge({ tone, children }: { tone: 'accent' | 'warn'; children: React.ReactNode }) {
  const accent = tone === 'accent';
  return (
    <span style={{
      ...mono, display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
      fontSize: 10, fontWeight: 600, letterSpacing: 0.4, padding: '3px 7px',
      borderRadius: R.badge,
      color: accent ? C.accentSoft : C.warn,
      background: accent ? C.accentTint : 'rgba(216,166,87,0.16)',
      border: `1px solid ${accent ? C.accentRing : 'rgba(216,166,87,0.32)'}`,
    }}>{children}</span>
  );
}

/** The one line of git a card can carry. Counts come straight from
 *  `git status --porcelain`: `dirty` is every changed file, `staged` the ones
 *  already in the index, `untracked` the ones git has never seen. */
function GitLine({ git, isGit }: { git: GitInfo | null; isGit: boolean }) {
  if (!git?.is_git) {
    if (!isGit) return null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 20 }}>
        <Icon path={P.branch} size={12} color={C.faint} />
        <span style={{ ...mono, fontSize: 12, color: C.faint }}>git deposu</span>
      </div>
    );
  }
  const dirty = git.dirty ?? 0;
  const staged = git.staged ?? 0;
  const untracked = git.untracked ?? 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 20 }}>
      <Icon path={P.branch} size={12} color={C.mute} />
      <span style={{ ...mono, ...ell, fontSize: 12, color: C.text2, minWidth: 0 }}>
        {git.branch || 'HEAD'}
      </span>
      {staged > 0 && (
        <span style={{ ...mono, fontSize: 12, color: C.ok, flexShrink: 0 }}>+{staged}</span>
      )}
      {untracked > 0 && (
        <span style={{ ...mono, fontSize: 12, color: C.faint, flexShrink: 0 }}>?{untracked}</span>
      )}
      <span style={{ ...mono, fontSize: 12, color: dirty ? C.mute : C.faint, marginLeft: 'auto', flexShrink: 0 }}>
        {dirty ? `${dirty} dosya` : 'temiz'}
      </span>
    </div>
  );
}

function Card({ row, onNew, onOpen }: {
  row: Row;
  onNew: () => void;
  onOpen: (chatId: string) => void;
}) {
  const busy = row.running > 0 || row.awaiting > 0;
  const newest = row.chats[0] ?? null;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: 16,
      borderRadius: R.card, background: C.surface,
      border: `1px solid ${busy ? C.accentRing : C.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...ell, fontSize: 15, fontWeight: 600, color: C.text }} title={row.name}>
            {row.name}
          </div>
          <div style={{ ...mono, ...ell, fontSize: 12, color: C.mute, marginTop: 2 }} title={row.path}>
            {tilde(row.path)}
          </div>
        </div>
        {row.awaiting > 0 ? (
          <Badge tone="warn"><Icon path={P.warn} size={10} color={C.warn} />approval</Badge>
        ) : row.running > 0 ? (
          <Badge tone="accent"><Dot color={C.accentSoft} live size={5} />running</Badge>
        ) : null}
      </div>

      <GitLine git={row.git} isGit={row.isGit} />

      {row.git?.subject ? (
        <div style={{ minWidth: 0 }}>
          <div style={{ ...ell, fontSize: 13, color: C.text2 }} title={row.git.subject}>
            {row.git.subject}
          </div>
          <div style={{ ...ell, fontSize: 12, color: C.faint, marginTop: 2 }}>
            {[ago(row.git.committed_at), row.git.author].filter(Boolean).join(' · ')}
          </div>
        </div>
      ) : null}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto',
        paddingTop: 12, borderTop: `1px solid ${C.hair}`,
      }}>
        {row.chats.length > 0 && newest ? (
          <button
            type="button" onClick={() => onOpen(newest.id)}
            title={newest.title || 'New chat'}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, height: 28,
              padding: '0 8px', marginLeft: -8, borderRadius: R.btn, cursor: 'pointer',
              background: 'transparent', border: '1px solid transparent', textAlign: 'left',
            }}
          >
            <Dot
              color={row.awaiting ? C.warn : row.running ? C.accent : C.faint}
              live={busy} size={5}
            />
            <span style={{ ...ell, fontSize: 12, color: busy ? C.text2 : C.mute }}>
              {row.chats.length} chats open
            </span>
            <Icon path={P.chevronRight} size={12} color={C.faint} />
          </button>
        ) : (
          <span style={{
            display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0,
            fontSize: 12, color: C.faint,
          }}>
            <Dot color={C.faint} size={5} />no chats
          </span>
        )}
        <Btn onClick={onNew}>
          <Icon path={P.plus} size={13} color={C.text} />New chat
        </Btn>
      </div>
    </div>
  );
}

export function Projects({ onNewChatIn, onOpenChat }: ProjectsProps) {
  const focus = useFleet((s) => s.focus);
  const slot = useFleet((s) => (s.focus ? s.hosts[s.focus] : null));
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('Last changed');
  const [repos, setRepos] = useState<Record<string, GitInfo>>({});
  const [gitOff, setGitOff] = useState(false);

  const projects = slot?.projects ?? [];
  const chats = slot?.chats ?? [];

  // Asked once, when the screen first has a folder list to ask about. The call
  // is new; a daemon that has not been restarted answers `unknown_method` and
  // the grid just runs without a git column.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || !projects.length) return;
    const stamp = `${focus}:${projects.length}`;
    if (asked.current === stamp) return;
    asked.current = stamp;
    let alive = true;
    setRepos({});
    setGitOff(false);
    useFleet.getState()
      .call<{ repos?: Record<string, GitInfo> }>(focus, 'host.git', {
        paths: projects.map((p) => p.path),
      })
      .then((r) => { if (alive) setRepos(r?.repos ?? {}); })
      .catch(() => { if (alive) setGitOff(true); });
    return () => { alive = false; };
  }, [focus, projects.length]);

  const rows = useMemo<Row[]>(() => {
    const byCwd = new Map<string, Chat[]>();
    for (const c of chats) {
      if (c.archived || !c.cwd) continue;
      const arr = byCwd.get(c.cwd) ?? [];
      arr.push(c);
      byCwd.set(c.cwd, arr);
    }
    const out = projects.map((p) => {
      const open = (byCwd.get(p.path) ?? []).sort((a, b) => {
        const rank = (c: Chat) => (c.status === 'awaiting_approval' ? 0 : c.status === 'running' ? 1 : 2);
        return rank(a) - rank(b) || b.updated_at - a.updated_at;
      });
      const git = repos[p.path] ?? null;
      return {
        path: p.path,
        name: p.name,
        isGit: p.is_git,
        git,
        chats: open,
        running: open.filter((c) => c.status === 'running').length,
        awaiting: open.filter((c) => c.status === 'awaiting_approval').length,
        touched: Math.max(git?.committed_at ?? 0, open[0]?.updated_at ?? 0),
      };
    });
    const q = query.trim().toLocaleLowerCase('tr');
    const hit = q
      ? out.filter((r) => r.name.toLocaleLowerCase('tr').includes(q)
        || r.path.toLocaleLowerCase('tr').includes(q))
      : out;
    const byName = (a: Row, b: Row) => a.name.localeCompare(b.name, 'tr');
    if (sort === 'Name') return [...hit].sort(byName);
    if (sort === 'Open chats') {
      return [...hit].sort((a, b) =>
        b.chats.length - a.chats.length || b.touched - a.touched || byName(a, b));
    }
    return [...hit].sort((a, b) => b.touched - a.touched || byName(a, b));
  }, [projects, chats, repos, query, sort]);

  const roots = slot?.info?.roots ?? [];
  const gotGit = Object.keys(repos).length > 0;
  const gitMissing = (gitOff || (!gotGit && projects.some((p) => p.is_git)))
    && projects.length > 0;

  if (!slot) {
    return (
      <div style={{ flex: 1, display: 'flex', background: C.bg }}>
        <Empty title="Projects" hint="Pick a computer first." />
      </div>
    );
  }

  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
      background: C.bg, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: '16px 24px',
        borderBottom: `1px solid ${C.border}`, flexShrink: 0,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 600, color: C.text }}>Projects</div>
          <div style={{ ...mono, ...ell, fontSize: 12, color: C.mute, marginTop: 2 }}
            title={roots.join(' · ')}>
            {roots.map((r) => tilde(r)).join(' · ') || (slot.info?.name ?? '')}
          </div>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, width: 240, height: 32,
          padding: '0 10px', background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: R.input,
        }}>
          <Icon path={P.search} size={14} color={C.mute} />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            style={{
              flex: 1, minWidth: 0, background: 'transparent', border: 'none',
              outline: 'none', fontSize: 13, color: C.text,
            }}
          />
        </div>

        <div style={{ width: 320 }}>
          <Segment value={sort} options={SORTS} onChange={setSort} />
        </div>

        <span style={{ ...mono, fontSize: 12, color: C.faint, flexShrink: 0 }}>
          {rows.length === projects.length
            ? `${projects.length} folders`
            : `${rows.length}/${projects.length} folders`}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {rows.length ? (
          <div style={{
            display: 'grid', gap: 16,
            gridTemplateColumns: 'repeat(auto-fill, minmax(288px, 1fr))',
            alignItems: 'stretch',
          }}>
            {rows.map((r) => (
              <Card
                key={r.path} row={r}
                onNew={() => onNewChatIn(r.path)}
                onOpen={(chatId) => focus && onOpenChat(focus, chatId)}
              />
            ))}
          </div>
        ) : (
          <Empty
            title={projects.length ? 'No folder matches' : 'The folder list is empty'}
            hint={projects.length
              ? 'Clear the search box.'
              : 'Nothing shows up under this computer’s allowed roots.'}
          />
        )}

        {gitMissing && rows.length ? (
          <div style={{ ...ell, fontSize: 12, color: C.faint, padding: '20px 4px 4px' }}>
            No git information came from this computer — restart the daemon and the branch,
            dirty-file count and last commit appear on the cards.
          </div>
        ) : null}
      </div>
    </div>
  );
}
