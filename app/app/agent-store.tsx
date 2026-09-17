import React, { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { Back, Card, Check, Chevron, Label, Skeleton } from '../src/components/ui';
import type { StoreItem } from '../src/protocol';

/** What can be added, before anything is added.
 *
 *  There is one agent on offer today, and this screen still asks which one:
 *  a tap on "Add an agent" that goes straight to installing something the
 *  reader never chose is a tap they cannot take back. The list is also the
 *  only place that says what an agent brings with it before it lands. */
export default function AgentStore() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { agents, storeSources, storeLoaded, loadStore, conn } = useStore();

  useFocusEffect(useCallback(() => {
    if (conn === 'online' && !storeLoaded) void loadStore().catch(() => {});
  }, [conn, storeLoaded, loadStore]));

  // An installed agent carries the name of the source it came from.
  const installed = (item: StoreItem) => agents.some((a) => a.name === item.id.split(':')[0]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}><Back /></Pressable>
        <Text style={[type.title, { color: colors.text, flex: 1 }]}>{T('addAgent')}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: insets.bottom + 32 }}>
        {!storeLoaded ? (
          <View style={{ gap: 10 }}>
            {[0, 1].map((i) => (
              <View key={i} style={[styles.row, { opacity: 1 - i * 0.35 }]}>
                <Skeleton width={38} height={38} radius={12} />
                <View style={{ flex: 1, gap: 6 }}>
                  <Skeleton width="45%" height={14} />
                  <Skeleton width="80%" height={11} radius={5} />
                </View>
              </View>
            ))}
          </View>
        ) : storeSources.map((src) => (
          <View key={src.id} style={{ gap: 8 }}>
            <Label>{src.label}</Label>
            {src.error ? (
              <View style={styles.warn}>
                <Text style={[type.caption, { color: colors.pillText, letterSpacing: 0 }]}>{src.error}</Text>
              </View>
            ) : (
              <Card>
                {src.items.map((item, i) => {
                  const have = installed(item);
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => router.push({ pathname: '/agent-install', params: { id: item.id } })}
                      style={[styles.row, i < src.items.length - 1 && styles.rowBorder]}
                    >
                      <View style={[styles.glyph, { backgroundColor: item.color + '33' }]}>
                        <Text style={{ fontSize: 20 }}>{item.glyph}</Text>
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={[type.sub, { color: colors.text, fontWeight: '600' }]}>{item.label}</Text>
                        <Text numberOfLines={2} style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>
                          {item.skills ? T('nSkills', { n: String(item.skills) }) + ' · ' : ''}{item.repo}
                        </Text>
                      </View>
                      {have ? <Check size={18} /> : <Chevron />}
                    </Pressable>
                  );
                })}
              </Card>
            )}
            {!!src.note && <Text style={[type.caption, { color: colors.muted }]}>{src.note}</Text>}
          </View>
        ))}

        <Text style={{ fontSize: 14, lineHeight: 19, letterSpacing: -0.1, color: colors.muted }}>
          {T('orMakeYourOwn')}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 20, paddingBottom: 12 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 14 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border2 },
  glyph: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  warn: { padding: 12, borderRadius: radius.lg, backgroundColor: colors.pillBg, borderWidth: 1, borderColor: colors.pillBorder },
});
