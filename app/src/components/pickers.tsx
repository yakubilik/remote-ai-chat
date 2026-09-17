import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, type } from '../theme';
import { Skeleton } from './ui';
import { useStore, useT } from '../store';
import { Check, Chevron, ChevronDown, OptionList, ProviderGlyph, Row } from './ui';
import type { CliAccount, Group, Project, Provider } from '../protocol';

/** The accounts a tool can actually run under: the ones signed in, plus the
 *  computer's own login, which is always on offer and is spelled with the
 *  app's own words rather than the computer's (`is_default`). The empty id is
 *  that one — it is "no account of ours", not an account named "". */
export function accountOptions(accounts: CliAccount[], provider: Provider, defaultLabel: string, notSignedIn: string) {
  return accounts
    .filter((a) => a.provider === provider && (a.logged_in || a.is_default))
    .map((a) => ({ id: a.is_default ? '' : a.id,
                   label: a.is_default ? defaultLabel : a.label,
                   hint: a.logged_in ? a.detail : notSignedIn }));
}

export function AccountPicker({ accounts, provider, value, onChange }: {
  accounts: CliAccount[]; provider: Provider; value: string | null; onChange: (id: string | null) => void;
}) {
  const T = useT();
  const options = accountOptions(accounts, provider, T('useDefaultAccount'), T('notSignedIn'));
  return <OptionList options={options} value={value ?? ''} onChange={(v) => onChange(v || null)} />;
}

export function ProviderPicker({ value, onChange, compact }: { value: Provider; onChange: (p: Provider) => void; compact?: boolean }) {
  const hostInfo = useStore((s) => s.hostInfo);
  const opts: { id: Provider; label: string; ver: string | null }[] = [
    { id: 'claude', label: 'Claude', ver: hostInfo?.versions.claude ? 'Claude Code ' + hostInfo.versions.claude.split(' ')[0] : 'Claude Code' },
    { id: 'codex', label: 'Codex', ver: hostInfo?.versions.codex ?? 'codex-cli' },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {opts.map((o) => {
        const on = o.id === value;
        const c = o.id === 'codex' ? colors.codex : colors.accent;
        return (
          <Pressable key={o.id} onPress={() => onChange(o.id)} style={[styles.prov, compact && { height: 48, justifyContent: 'center' }, on && { borderColor: c, backgroundColor: o.id === 'codex' ? colors.codexSoft : colors.accentSoft }]}>
            <ProviderGlyph provider={o.id} size={28} />
            <View>
              <Text style={[type.sub, { color: on ? colors.text : colors.muted, fontWeight: '600' }]}>{o.label}</Text>
              {!compact && <Text numberOfLines={1} style={[type.monoSmall, { color: colors.muted, fontFamily: undefined }]}>{o.ver}</Text>}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function FolderPicker({ value, projects, onChange, loading }:
  { value: string | null; projects: Project[]; onChange: (p: string) => void; loading?: boolean }) {
  const T = useT();
  const [open, setOpen] = useState(false);
  const short = value ? value.replace(/^\/Users\/[^/]+/, '~') : T('choose');
  return (
    <View>
      <Row label={T('folder')} value={short} mono onPress={() => setOpen((o) => !o)} />
      {open && (
        <View style={styles.dropdown}>
          {projects.map((p) => (
            <Pressable key={p.path} onPress={() => { onChange(p.path); setOpen(false); }} style={styles.dropRow}>
              <Text style={[type.sub, { color: colors.text, flex: 1 }]}>{p.name}</Text>
              {p.path === value && <Check size={16} />}
            </Pressable>
          ))}
          {projects.length === 0 && (loading
            // "no folders" is a claim; while the list is on its way it is not true yet
            ? <View style={{ padding: 12 }}><Skeleton width="58%" height={12} /></View>
            : <Text style={[type.caption, { color: colors.muted, padding: 12 }]}>{T('noFolders')}</Text>)}
        </View>
      )}
    </View>
  );
}

export function GroupPicker({ value, groups, onChange, last }: { value: string | null; groups: Group[]; onChange: (g: string | null) => void; last?: boolean }) {
  const T = useT();
  const [open, setOpen] = useState(false);
  const createGroup = useStore((s) => s.createGroup);
  const name = groups.find((g) => g.id === value)?.name ?? T('none');
  function newGroup() {
    Alert.prompt(T('newGroupTitle'), undefined, async (n) => {
      if (!n?.trim()) return;
      const g = await createGroup(n.trim());
      onChange(g.id); setOpen(false);
    });
  }
  return (
    <View>
      <Row label={T('group')} value={name} onPress={() => setOpen((o) => !o)} last={last && !open} />
      {open && (
        <View style={styles.dropdown}>
          <Pressable onPress={() => { onChange(null); setOpen(false); }} style={styles.dropRow}>
            <Text style={[type.sub, { color: colors.muted, flex: 1 }]}>{T('none')}</Text>{value === null && <Check size={16} />}
          </Pressable>
          {groups.map((g) => (
            <Pressable key={g.id} onPress={() => { onChange(g.id); setOpen(false); }} style={styles.dropRow}>
              <Text style={[type.sub, { color: colors.text, flex: 1 }]}>{g.name}</Text>{g.id === value && <Check size={16} />}
            </Pressable>
          ))}
          <Pressable onPress={newGroup} style={styles.dropRow}><Text style={[type.sub, { color: colors.accent }]}>{T('newGroup')}</Text></Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  prov: { flex: 1, height: 56, borderRadius: radius.lg, backgroundColor: colors.bg, borderWidth: 1.5, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  dropdown: { backgroundColor: colors.surface, marginHorizontal: 8, marginBottom: 8, borderRadius: radius.md, overflow: 'hidden' },
  dropRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: 12, gap: 8 },
});
