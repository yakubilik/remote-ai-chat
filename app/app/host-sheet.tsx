import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useStore, useT } from '../src/store';
import { colors, type } from '../src/theme';
import { Card, Check, Chevron, Label, Row, Spinner } from '../src/components/ui';

/** The computer picker behind the name in the top-left of the home screens.
 *  Picking one closes the sheet straight away — the switch itself plays out on
 *  the screen underneath, which keeps its list up until the new one lands. */
export default function HostSheet() {
  const router = useRouter();
  const T = useT();
  const { hosts, activeHostId, hostInfo, conn, switching, switchHost, removeHost } = useStore();
  const [busy, setBusy] = useState<string | null>(null);

  function pick(id: string) {
    if (id === activeHostId) { router.back(); return; }
    void Haptics.selectionAsync().catch(() => {});
    // Close first: the crossfade belongs to the screen underneath, and holding
    // the sheet open through the reconnect would hide the thing being waited on.
    router.back();
    void switchHost(id);
  }

  function confirmRemove(id: string, name: string) {
    Alert.alert(T('removeHost'), T('removeHostBody', { name }), [
      { text: T('cancel'), style: 'cancel' },
      {
        text: T('remove'), style: 'destructive', onPress: async () => {
          setBusy(id);
          try { await removeHost(id); } finally { setBusy(null); }
          // Nothing left to pick from — the pairing screen is the only way out.
          if (useStore.getState().hosts.length === 0) { router.dismissAll(); router.replace('/pair'); }
        },
      },
    ]);
  }

  return (
    // No flex:1 and no scroller: the sheet sizes itself to this view, and a
    // stretching child would hand it a height that has nothing to do with the list.
    <View style={{ backgroundColor: colors.surface, paddingTop: 18 }}>
      <View style={{ paddingHorizontal: 20, gap: 8, paddingBottom: 24 }}>
        <Label>{T('computers')}</Label>
        <Card style={{ backgroundColor: colors.surface2 }}>
          {hosts.map((h) => {
            const active = h.id === activeHostId;
            // Only the live computer can claim a colour; the rest are just names.
            const dot = active
              ? (conn === 'online' ? colors.success : conn === 'connecting' ? colors.warning : colors.faint)
              : 'transparent';
            return (
              <Pressable
                key={h.id}
                onPress={() => pick(h.id)}
                onLongPress={() => confirmRemove(h.id, h.name)}
                style={[styles.hostRow, styles.rowBorder]}
              >
                <View style={[styles.dot, { backgroundColor: dot, borderWidth: active ? 0 : 1, borderColor: colors.faint }]} />
                <View style={{ flex: 1 }}>
                  {/* Every computer reads at full strength; the dot and the check say which one is live. */}
                  <Text style={[type.sub, { color: colors.text, fontWeight: active ? '600' : '500' }]}>
                    {(active && hostInfo?.name?.replace('.local', '')) || h.name}
                  </Text>
                  <Text style={[type.monoSmall, { color: colors.muted }]}>{h.host}:{h.port}</Text>
                </View>
                {busy === h.id ? <Spinner /> : active ? (switching ? <Spinner /> : <Check size={18} />) : <Chevron />}
              </Pressable>
            );
          })}
          <Row label={T('addComputer')} onPress={() => { router.back(); router.push({ pathname: '/pair', params: { add: '1' } }); }} last />
        </Card>
        <Text style={[type.caption, { color: colors.muted }]}>{T('hostHint')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border2 },
  hostRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
