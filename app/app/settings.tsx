import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, useT } from '../src/store';
import { colors, type } from '../src/theme';
import type { Key } from '../src/i18n';
import type { UpdateStatus } from '../src/protocol';
import { Back, Card, Check, Chevron, Label, Row, Segmented, Toggle as Switch } from '../src/components/ui';

function Toggle({ label, value, onChange, hint, last }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string; last?: boolean }) {
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <View style={{ flex: 1 }}>
        <Text style={[type.sub, { color: colors.text }]}>{label}</Text>
        {!!hint && <Text style={[type.caption, { color: colors.muted }]}>{hint}</Text>}
      </View>
      <Switch value={value} onChange={onChange} />
    </View>
  );
}

/** One line that says whether this computer is current, and offers the update
 *  when there is one to take. A blocker is shown instead of a dead button: the
 *  reason it cannot update is the useful part, and "uncommitted changes here"
 *  is something only the person reading it can resolve. */
const BLOCKER: Record<string, Key> = {
  'not a git checkout': 'updNoRepo', 'already up to date': 'updClean',
  'uncommitted changes': 'updDirty', 'unpushed commits': 'updAhead',
  'a turn is running': 'updBusy',
};

function UpdateRow({ status, busy, onPress }: { status: UpdateStatus; busy: boolean; onPress: () => void }) {
  const T = useT();
  const behind = status.behind ?? 0;
  if (behind <= 0) {
    return (
      <View style={[styles.row]}>
        <Text style={[type.sub, { color: colors.text, flex: 1 }]}>{T('upToDate')}</Text>
        <Check size={18} />
      </View>
    );
  }
  // "already up to date" cannot be a blocker here — we are behind.
  const blocking = (status.blockers ?? []).filter((b) => b !== 'already up to date');
  const label = T('behindN', { n: String(behind) });
  if (blocking.length) {
    return (
      <View style={[styles.row]}>
        <View style={{ flex: 1 }}>
          <Text style={[type.sub, { color: colors.warning }]}>{label}</Text>
          <Text style={[type.caption, { color: colors.muted }]}>
            {blocking.map((b) => (BLOCKER[b] ? T(BLOCKER[b]) : b)).join(' · ')}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <Pressable onPress={busy ? undefined : onPress} style={[styles.row]}>
      <View style={{ flex: 1 }}>
        <Text style={[type.sub, { color: colors.warning }]}>{label}</Text>
        {!!status.remote?.subject && (
          <Text numberOfLines={1} style={[type.caption, { color: colors.muted }]}>{status.remote.subject}</Text>
        )}
      </View>
      <Text style={[type.sub, { color: busy ? colors.muted : colors.accent, fontWeight: '500' }]}>
        {busy ? T('updating') : T('updateNow')}
      </Text>
    </Pressable>
  );
}

export default function Settings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { accounts, hosts, activeHostId, hostInfo, conn, defaults, prefs, device, setPrefs, setDevicePrefs, switchHost, removeHost, authenticate, pushToken, refreshHost, catalog, updateStatus, checkUpdate, applyUpdate } = useStore();
  const [updBusy, setUpdBusy] = useState(false);
  const accountSummary = accounts.length
    ? `${accounts.filter((a) => a.logged_in).length}/${accounts.length}`
    : undefined;
  useEffect(() => { if (conn === 'online') { void refreshHost().catch(() => {}); const t = setInterval(() => void refreshHost().catch(() => {}), 30000); return () => clearInterval(t); } }, [conn, refreshHost]);
  // Ask the computer where it stands the moment this screen is open. `refresh`
  // makes it talk to GitHub, which is why it happens here and not on a timer.
  useEffect(() => { if (conn === 'online') void checkUpdate(true).catch(() => {}); }, [conn, checkUpdate]);
  const short = (v: string | null | undefined) => (v ? v.replace(/\s.*$/, '').split('.').slice(0, 2).join('.') : '–');
  const modelLabel = catalog?.[defaults.provider]?.models.find((m) => m.id === defaults.model)?.label ?? defaults.model;
  const online = conn === 'online';
  const [busyHost, setBusyHost] = useState<string | null>(null);

  async function toggleFaceId(key: 'faceIdLaunch' | 'faceIdBypass', v: boolean) {
    if (!v) { const ok = await authenticate(T('authToDisable')); if (!ok) return; }
    await setPrefs({ [key]: v });
  }

  function confirmRemove(id: string, name: string) {
    Alert.alert(T('removeHost'), T('removeHostBody', { name }), [
      { text: T('cancel'), style: 'cancel' },
      { text: T('remove'), style: 'destructive', onPress: async () => {
        setBusyHost(id);
        try { await removeHost(id); } finally { setBusyHost(null); }
        if (useStore.getState().hosts.length === 0) { router.dismissAll(); router.replace('/pair'); }
      } },
    ]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}><Back /></Pressable>
        <Text style={[type.largeTitle, { color: colors.text }]}>{T('settings')}</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 22, paddingBottom: insets.bottom + 24 }}>
        <View style={{ gap: 8 }}>
          <Label>{T('computers')}</Label>
          <Card>
            {hosts.map((h) => {
              const active = h.id === activeHostId;
              return (
                <Pressable key={h.id} onPress={() => !active && switchHost(h.id)} onLongPress={() => confirmRemove(h.id, h.name)} style={[styles.hostRow, styles.rowBorder]}>
                  <View style={[styles.dot, { backgroundColor: active ? (online ? colors.success : conn === 'connecting' ? colors.warning : colors.faint) : 'transparent', borderWidth: active ? 0 : 1, borderColor: colors.faint }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[type.sub, { color: active ? colors.text : colors.muted, fontWeight: '500' }]}>{(active && hostInfo?.name?.replace('.local', '')) || h.name}</Text>
                    <Text style={[type.monoSmall, { color: colors.muted }]}>
                      {h.host}:{h.port}{active && hostInfo ? ` · claude ${short(hostInfo.versions.claude)} · codex ${short(hostInfo.versions.codex?.split(' ').pop())}` : active ? ` · ${conn}` : ''}
                    </Text>
                  </View>
                  {active ? <Check size={18} /> : <Chevron />}
                  {busyHost === h.id && <Text style={[type.caption, { color: colors.muted }]}>…</Text>}
                </Pressable>
              );
            })}
            <Row label={T('addComputer')} onPress={() => router.push({ pathname: '/pair', params: { add: '1' } })} last />
          </Card>
          <Text style={[type.caption, { color: colors.muted }]}>{T('hostHint')}</Text>
        </View>

        {!!updateStatus?.repo && (
          <View style={{ gap: 8 }}>
            <Label>{T('software')}</Label>
            <Card>
              <Row label={T('versionRow')} mono
                value={`${updateStatus.local?.commit ?? '–'}${updateStatus.local?.branch ? ` · ${updateStatus.local.branch}` : ''}`} />
              <UpdateRow
                status={updateStatus} busy={updBusy}
                onPress={async () => {
                  setUpdBusy(true);
                  const r = await applyUpdate();
                  setUpdBusy(false);
                  if (!r.ok && r.error) Alert.alert(T('software'), T('updFailed', { e: r.error }));
                }}
              />
            </Card>
            <Text style={[type.caption, { color: colors.muted }]}>
              {updateStatus.auto ? T('autoUpdates') : T('autoUpdatesOff')}
              {updateStatus.local?.dirty ? ` · ${T('updDirtyFiles', { n: String(updateStatus.local.dirty_files ?? 0) })}` : ''}
            </Text>
          </View>
        )}

        <View style={{ gap: 8 }}>
          <Label>{T('accounts')}</Label>
          <Card>
            <Row label={T('accounts')} value={accountSummary} onPress={() => router.push('/accounts')} last />
          </Card>
        </View>

        <View style={{ gap: 8 }}>
          <Label>{T('defaults')}</Label>
          <Card>
            <Row label={T('toolRow')} value={defaults.provider === 'codex' ? 'Codex' : 'Claude'} onPress={() => router.push({ pathname: '/model-sheet', params: { defaults: '1' } })} />
            <Row label={T('modelRow')} value={modelLabel} onPress={() => router.push({ pathname: '/model-sheet', params: { defaults: '1' } })} />
            <Row label={T('effortRow')} value={defaults.effort} onPress={() => router.push({ pathname: '/model-sheet', params: { defaults: '1' } })} />
            <Row label={T('permRow')} value={defaults.perm_mode} onPress={() => router.push({ pathname: '/model-sheet', params: { defaults: '1' } })} />
            <Row label={T('folderRow')} value={defaults.cwd ? defaults.cwd.replace(/^\/Users\/[^/]+/, '~') : T('firstProject')} mono last />
          </Card>
          <Text style={[type.caption, { color: colors.muted }]}>{T('defaultsHint')}</Text>
        </View>

        <View style={{ gap: 8 }}>
          <Label>{T('security')}</Label>
          <Card>
            <Toggle label={T('faceIdLaunch')} hint={T('faceIdLaunchHint')} value={prefs.faceIdLaunch} onChange={(v) => toggleFaceId('faceIdLaunch', v)} />
            <Toggle label={T('faceIdBypass')} hint={T('faceIdBypassHint')} value={prefs.faceIdBypass} onChange={(v) => toggleFaceId('faceIdBypass', v)} />
            <Pressable onPress={() => activeHostId && confirmRemove(activeHostId, hosts.find((h) => h.id === activeHostId)?.name ?? '')} style={styles.hostRow}>
              <Text style={[type.sub, { color: colors.accent }]}>{T('revokeDevice')}</Text>
            </Pressable>
          </Card>
        </View>

        <View style={{ gap: 8 }}>
          <Label>{T('notifications')}</Label>
          <Card>
            <Toggle label={T('pushApproval')} value={device?.push_approval ?? true} onChange={(v) => setDevicePrefs({ push_approval: v }).catch((e) => Alert.alert(T('error'), e.message))} />
            <Toggle label={T('pushDone')} hint={T('pushDoneHint')} value={device?.push_done ?? true} onChange={(v) => setDevicePrefs({ push_done: v }).catch((e) => Alert.alert(T('error'), e.message))} last />
          </Card>
          <Text style={[type.caption, { color: colors.muted }]}>
            {pushToken ? T('pushOk') : T('pushNo')}
          </Text>
        </View>

        {hostInfo && (
          <View style={{ gap: 8 }}>
            <Label>{T('host')}</Label>
            <Card>
              <Row label={T('system')} value={`${hostInfo.os} ${hostInfo.os_version}`} />
              <Row label={T('daemon')} value={hostInfo.daemon_version} />
              <Row label={T('uptime')} value={`${Math.floor(hostInfo.uptime_s / 3600)}h ${Math.floor((hostInfo.uptime_s % 3600) / 60)}m`} />
              <Row label={T('activeSessions')} value={String(hostInfo.active_sessions)} />
              <Row label={T('roots')} value={hostInfo.roots.join(', ')} mono last />
            </Card>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 20, paddingBottom: 18 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border2 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
