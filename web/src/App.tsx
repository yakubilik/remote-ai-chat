import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C } from './lib/theme';
import { KEYFRAMES } from './ui/kit';
import { Sidebar, type View } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { Inspector } from './components/Inspector';
import { NewChat } from './components/NewChat';
import { Palette, type Command } from './components/Palette';
import { FieldSheet, accountName, type Field } from './components/FieldSheet';
import { ApprovalModal, type Pending } from './components/ApprovalModal';
import { Dashboard } from './screens/Dashboard';
import { Projects } from './screens/Projects';
import { Agents } from './screens/Agents';
import { Settings } from './screens/Settings';
import { Onboarding } from './screens/Onboarding';
import { useFleet, onAnyEvent, pokeAll } from './lib/fleet';
import { useLogs, logKey, emptyLog } from './lib/timeline';
import { deleteChat, interrupt, respond, send, updateChat, upload } from './lib/actions';
import type { Chat } from './lib/protocol';

interface Selection { hostKey: string; chatId: string }

export function App() {
  const fleet = useFleet();
  const logs = useLogs();
  const [view, setView] = useState<View>('chats');
  const [sel, setSel] = useState<Selection | null>(null);
  const [newChat, setNewChat] = useState<{ cwd?: string } | null>(null);
  const [palette, setPalette] = useState(false);
  const [field, setField] = useState<Field | null>(null);
  const [sending, setSending] = useState(false);
  const [liveTokens, setLiveTokens] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { fleet.boot(); }, []);

  // "Open in a new window" opens ?host=&chat=. Honoured once the computer that
  // owns the chat is connected, so a popped-out window lands on the right one.
  useEffect(() => {
    if (sel || !fleet.ready) return;
    const q = new URLSearchParams(location.search);
    const chatId = q.get('chat');
    if (!chatId) return;
    const wanted = q.get('host');
    const key = wanted && fleet.hosts[wanted] ? wanted
      : fleet.order.find((k) => fleet.hosts[k]?.chats.some((c) => c.id === chatId));
    if (key) open(key, chatId);
  }, [fleet.ready, fleet.hosts, sel]);

  const slot = sel ? fleet.hosts[sel.hostKey] : (fleet.focus ? fleet.hosts[fleet.focus] : null);
  const chat: Chat | null = useMemo(() => {
    if (!sel) return null;
    return fleet.hosts[sel.hostKey]?.chats.find((c) => c.id === sel.chatId) ?? null;
  }, [sel, fleet.hosts]);

  const log = sel ? (logs.logs[logKey(sel.hostKey, sel.chatId)] ?? emptyLog()) : emptyLog();

  const open = useCallback((hostKey: string, chatId: string) => {
    setSel({ hostKey, chatId });
    setView('chats');
    if (fleet.focus !== hostKey) fleet.setFocus(hostKey);
    logs.open(hostKey, chatId);
  }, [fleet.focus]);

  // The chat on screen catches itself up the moment its computer answers
  // again. Without this a panel that was asleep, or whose socket died quietly
  // under a long turn, goes on drawing the timeline it had when the connection
  // went — and every event it missed is a hole no later event fills, because
  // the live feed only ever appends.
  const selStatus = sel ? (fleet.hosts[sel.hostKey]?.status ?? null) : null;
  useEffect(() => {
    if (!sel || selStatus !== 'online') return;
    void useLogs.getState().open(sel.hostKey, sel.chatId);
  }, [sel?.hostKey, sel?.chatId, selStatus]);

  // A tab in the background is where sockets go to die unnoticed.
  useEffect(() => {
    const wake = () => { if (!document.hidden) pokeAll(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, []);

  // Live token count belongs to the turn that is running, not to the chat, so
  // it is dropped the moment that turn ends rather than lingering as a total.
  useEffect(() => {
    if (!sel) return;
    return onAnyEvent((k, ev) => {
      if (k !== sel.hostKey || ev.chat_id !== sel.chatId) return;
      if (ev.event === 'turn.progress') setLiveTokens(ev.data?.output_tokens ?? null);
      if (ev.event === 'turn.done' || ev.event === 'turn.error' || ev.event === 'turn.started') setLiveTokens(null);
    });
  }, [sel?.hostKey, sel?.chatId]);

  // Approvals from every paired computer, not just the chat on screen. A
  // destructive command sitting on a chat nobody has open is the exact thing
  // this panel is here to catch, so the queue is filled two ways: live events,
  // and a read of any chat the daemon already reports as waiting.
  useEffect(() => onAnyEvent((key, ev) => {
    if (!ev.chat_id) return;
    if (ev.event === 'approval.request') {
      const d: any = ev.data ?? {};
      const slot = useFleet.getState().hosts[key];
      setPending((q) => (
        q.some((p) => p.requestId === d.request_id) ? q : [...q, {
          hostKey: key, hostName: slot?.info?.name ?? slot?.cfg.name ?? key,
          chatId: ev.chat_id!, requestId: d.request_id, tool: d.tool ?? '?',
          input: d.input ?? {}, preview: d.preview ?? '', danger: !!d.danger,
          reason: d.reason ?? null, ts: ev.ts,
        }]
      ));
    }
    if (ev.event === 'approval.resolved') {
      const rid = (ev.data as any)?.request_id;
      setPending((q) => q.filter((p) => p.requestId !== rid));
    }
  }), []);

  // Cold start: a chat can already be waiting when the panel opens. Reading it
  // once fills in the request the live stream never carried.
  const waiting = useMemo(() => fleet.order.flatMap((k) =>
    (fleet.hosts[k]?.chats ?? [])
      .filter((c) => c.status === 'awaiting_approval')
      .map((c) => `${k}/${c.id}`)), [fleet.hosts, fleet.order]);

  useEffect(() => {
    for (const id of waiting) {
      const [hostKey, chatId] = [id.slice(0, id.lastIndexOf('/')), id.slice(id.lastIndexOf('/') + 1)];
      if (pending.some((p) => p.hostKey === hostKey && p.chatId === chatId)) continue;
      const existing = useLogs.getState().logs[logKey(hostKey, chatId)];
      if (!existing) { useLogs.getState().open(hostKey, chatId); continue; }
      const slot = useFleet.getState().hosts[hostKey];
      const open = existing.items.filter((it) => it.kind === 'approval' && it.decision == null);
      if (!open.length) continue;
      setPending((q) => {
        const add = open
          .filter((it: any) => !q.some((p) => p.requestId === it.requestId))
          .map((it: any) => ({
            hostKey, hostName: slot?.info?.name ?? slot?.cfg.name ?? hostKey, chatId,
            requestId: it.requestId, tool: it.tool, input: it.input, preview: it.preview,
            danger: it.danger, reason: it.reason, ts: it.ts,
          }));
        return add.length ? [...q, ...add] : q;
      });
    }
  }, [waiting, logs.logs, pending]);

  const blocking = pending.find((p) => p.danger) ?? null;

  const doSend = async (text: string, attachments: any[] = []) => {
    if (!sel) return;
    setSending(true);
    try { await send(sel.hostKey, sel.chatId, text, attachments); }
    catch (e) { console.error(e); }
    finally { setSending(false); }
  };

  // The upload happens as the file is chosen; the send waits for the composer,
  // so a picture can be looked at (and captioned) before the agent gets it.
  const doUpload = async (f: File) => {
    if (!sel) throw new Error('No chat open');
    return upload(sel.hostKey, sel.chatId, f);
  };

  // Which sign-in this chat spends, and how full it is. `account.list` shells
  // out to the CLIs, so it is asked for once the chat screen actually needs it.
  const accountKey = chat ? (chat.account_id || `default-${chat.provider}`) : null;
  const account = accountKey && slot
    ? slot.accounts.find((a) => a.id === accountKey) ?? null
    : null;
  const accountLabel = account ? accountName(account) : null;
  const accountUsage = useMemo(() => {
    const top = (accountKey && slot ? slot.limits[accountKey] ?? [] : [])
      .filter((w) => typeof w.utilization === 'number')
      .sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0];
    return top ? (top.utilization ?? 0) : null;
  }, [accountKey, slot?.limits]);

  useEffect(() => {
    if (view !== 'chats' || !fleet.focus) return;
    const s = fleet.hosts[fleet.focus];
    if (s?.status === 'online' && !s.accounts.length && !s.loading.accounts) {
      fleet.refreshAccounts(fleet.focus).catch(() => {});
    }
  }, [view, fleet.focus, slot?.status, slot?.accounts.length]);

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      { id: 'new', label: 'New chat', shortcut: '⌘N', hint: slot?.info?.name, run: () => setNewChat({}) },
      { id: 'dashboard', label: 'Panele git', shortcut: '⌘1', run: () => setView('dashboard') },
      { id: 'projects', label: 'Projects', shortcut: '⌘2', run: () => setView('projects') },
      { id: 'agents', label: 'Agents', shortcut: '⌘3', run: () => setView('agents') },
      { id: 'settings', label: 'Settings', shortcut: '⌘,', run: () => setView('settings') },
    ];
    // Only means anything with more than one computer paired.
    if (fleet.order.length > 1) {
      list.push({
        id: 'all-hosts',
        label: fleet.allHosts ? 'Show one computer' : 'Show every computer',
        hint: fleet.allHosts ? (slot?.info?.name ?? undefined) : `${fleet.order.length} paired`,
        run: () => { fleet.setAllHosts(!fleet.allHosts); setView('chats'); },
      });
    }
    const running = fleet.order.flatMap((k) =>
      (fleet.hosts[k]?.chats ?? []).filter((c) => c.status !== 'idle').map((c) => ({ k, c })));
    if (running.length) {
      list.push({
        id: 'stop-all',
        label: 'Stop every session',
        hint: `${running.length} running`,
        danger: true,
        run: () => { for (const r of running) interrupt(r.k, r.c.id).catch(() => {}); },
      });
    }
    return list;
  }, [fleet.hosts, fleet.order, fleet.allHosts, slot?.info?.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 'k') { e.preventDefault(); setPalette((p) => !p); }
      else if (e.key === 'n') { e.preventDefault(); setNewChat({}); }
      else if (e.key === 'f') { e.preventDefault(); setView('chats'); setTimeout(() => searchRef.current?.focus(), 0); }
      else if (e.key === ',') { e.preventDefault(); setView('settings'); }
      else if (e.key === '1') { e.preventDefault(); setView('dashboard'); }
      else if (e.key === '2') { e.preventDefault(); setView('projects'); }
      else if (e.key === '3') { e.preventDefault(); setView('agents'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (fleet.ready && !fleet.order.length) {
    return (
      <>
        <style>{KEYFRAMES}</style>
        <Onboarding onPaired={() => setView('chats')} />
      </>
    );
  }

  return (
    <>
      <style>{KEYFRAMES}</style>
      <div style={{ display: 'flex', height: '100vh', background: C.bg, overflow: 'hidden' }}>
        <Sidebar
          view={view} onView={setView}
          selected={sel?.chatId ?? null} selectedHost={sel?.hostKey ?? null} onSelect={open}
          onNewChat={() => setNewChat({})}
          searchRef={searchRef}
        />

        {view === 'chats' && (
          <>
            <ChatView
              chat={chat} hostKey={sel?.hostKey ?? null} log={log} sending={sending}
              groupName={chat?.group_id
                ? (slot?.groups.find((g) => g.id === chat.group_id)?.name ?? null)
                : null}
              accountLabel={accountLabel}
              onSend={doSend}
              onUpload={doUpload}
              onInterrupt={() => sel && interrupt(sel.hostKey, sel.chatId).catch(() => {})}
              onRespond={(rid, d) => sel && respond(sel.hostKey, sel.chatId, rid, d).catch(() => {})}
              onEdit={setField}
              groups={slot?.groups ?? []}
              onUpdate={(patch) => sel && updateChat(sel.hostKey, sel.chatId, patch).catch(() => {})}
              onDelete={() => {
                if (!sel) return;
                const { hostKey, chatId } = sel;
                setSel(null);
                deleteChat(hostKey, chatId).catch(() => {});
              }}
            />
            <Inspector
              chat={chat} items={log.items} busy={!!chat && (log.busy || chat.status !== 'idle')}
              liveTokens={liveTokens}
              accountLabel={accountLabel} accountUsage={accountUsage}
              onEdit={setField}
              onInterrupt={() => sel && interrupt(sel.hostKey, sel.chatId).catch(() => {})}
              onPopOut={() => sel && window.open(
                `${location.pathname}?host=${encodeURIComponent(sel.hostKey)}&chat=${encodeURIComponent(sel.chatId)}`,
                '_blank', 'width=1100,height=860')}
            />
          </>
        )}

        {view === 'dashboard' && (
          <Dashboard onOpenChat={open} onNewChat={() => setNewChat({})} />
        )}
        {view === 'projects' && (
          <Projects onNewChatIn={(cwd) => setNewChat({ cwd })} onOpenChat={open} />
        )}
        {view === 'agents' && <Agents />}
        {view === 'settings' && <Settings />}
      </div>

      {newChat && fleet.focus && (
        <NewChat
          hostKey={fleet.focus}
          initialCwd={newChat.cwd}
          onDone={(c) => { setNewChat(null); open(fleet.focus!, c.id); }}
          onClose={() => setNewChat(null)}
        />
      )}

      {palette && (
        <Palette
          commands={commands}
          onOpenChat={open}
          onNewChatIn={(cwd) => setNewChat({ cwd })}
          onClose={() => setPalette(false)}
        />
      )}

      {blocking && (
        <ApprovalModal
          pending={blocking}
          queued={pending.length}
          chat={fleet.hosts[blocking.hostKey]?.chats.find((c) => c.id === blocking.chatId) ?? null}
          onRespond={(d) => {
            respond(blocking.hostKey, blocking.chatId, blocking.requestId, d).catch(() => {});
            setPending((q) => q.filter((p) => p.requestId !== blocking.requestId));
          }}
          onOpenChat={() => open(blocking.hostKey, blocking.chatId)}
          onClose={() => setPending((q) => q.filter((p) => p.requestId !== blocking.requestId))}
        />
      )}

      {field && chat && sel && (
        <FieldSheet
          field={field} chat={chat}
          catalog={fleet.hosts[sel.hostKey]?.catalog ?? null}
          projects={fleet.hosts[sel.hostKey]?.projects ?? []}
          accounts={fleet.hosts[sel.hostKey]?.accounts ?? []}
          limits={fleet.hosts[sel.hostKey]?.limits ?? {}}
          busy={log.busy || chat.status !== 'idle'}
          onPick={(value) => updateChat(sel.hostKey, sel.chatId, { [field]: value })
            .catch((e) => window.alert(e?.message ?? 'That did not work'))}
          onClose={() => setField(null)}
        />
      )}
    </>
  );
}
