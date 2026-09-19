import React, { useCallback, useEffect, useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, useT } from '../src/store';
import { colors, radius, type } from '../src/theme';
import { Back, Card, Label, OptionList, ProviderMark, Toggle } from '../src/components/ui';
import type { PoolAccount, Provider } from '../src/protocol';

const PROVIDERS: Provider[] = ['claude', 'codex'];
const NAMES: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };
const LINES = [0.9, 0.95, 0.99, 1.0];
// The window the five-hour line is stored under; every other window falls
// back to `threshold`, which is what the weekly control edits.
const FIVE_HOUR = 'five_hour';
const RESERVES = [0.05, 0.1, 0.2];

/** Where one sign-in stands, in as few words as the row has room for. */
function standing(a: PoolAccount, T: (k: any, p?: any) => string): { text: string; color: string } {
  if (a.blocked) {
    const back = a.until ? new Date(a.until * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
    return { text: back ? T('poolBlocked', { time: back }) : T('poolBlockedNoTime'), color: colors.warning };
  }
  if (a.spending) return { text: T('poolSpending'), color: colors.error };
  if (a.on_overage) return { text: T('poolOnOverage'), color: colors.warning };
  if (a.unknown) return { text: T('poolUnknown'), color: colors.faint };
  return { text: T('poolFree', { percent: Math.round((a.utilization ?? 0) * 100) }), color: colors.muted };
}

export default function PoolScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const { pool, poolAccounts, conn, loadPool, setPool } = useStore();

  const reload = useCallback(() => {
    if (conn === 'online') void loadPool();
  }, [conn, loadPool]);
  useFocusEffect(reload);
  useEffect(reload, [reload]);

  // Only a tool with a second sign-in has anywhere to move a chat to. One
  // account is not a pool, and saying so beats an order list of one.
  const usable = useMemo(
    () => PROVIDERS.filter((p) => poolAccounts.filter((a) => a.provider === p).length > 1),
    [poolAccounts]);

  const save = (patch: any) => setPool(patch).catch((e: any) => Alert.alert(T('error'), e.message));

  /** Moving a sign-in up the list. The order is the whole policy — "the next
   *  account" means the next one here — so it is edited where it is read,
   *  one step at a time, rather than behind a drag handle that fights the
   *  scroll view on a phone. */
  const move = (provider: Provider, id: string, by: number) => {
    const ids = poolAccounts.filter((a) => a.provider === provider).map((a) => a.account_id);
    const from = ids.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    save({ order: { ...(pool?.order ?? {}), [provider]: ids } });
  };

  /** One sign-in's own answer on extra usage. Set explicitly rather than
   *  cleared back to the default: "I decided this one" is worth keeping even
   *  when it happens to match what the default says today. */
  const toggleStrict = (a: PoolAccount) =>
    save({ overage_by_account: { ...(pool?.overage_by_account ?? {}),
                                 [a.account_id]: a.strict ? 'account' : 'never' } });

  const on = !!pool?.enabled;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={[styles.head, { paddingTop: insets.top }]}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}><Back /></Pressable>
        <Text style={[type.title, { color: colors.text }]}>{T('pool')}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 22 }}>
        <View style={{ gap: 8 }}>
          <Card>
            <View style={styles.row}>
              <Text style={[type.sub, { color: colors.text, flex: 1 }]}>{T('poolOn')}</Text>
              <Toggle value={on} onChange={(v) => save({ enabled: v })} disabled={!pool} />
            </View>
          </Card>
          <Text style={[type.caption, { color: colors.muted }]}>{T('poolHint')}</Text>
          {usable.length === 0 && (
            <Text style={[type.caption, { color: colors.warning }]}>{T('poolNeedsTwo')}</Text>
          )}
        </View>

        {on && (
          <>
            <View style={{ gap: 8 }}>
              <Label>{T('poolThreshold5h')}</Label>
              <OptionList
                options={LINES.map((v) => ({ id: String(v), label: `${Math.round(v * 100)}%` }))}
                value={String(pool?.thresholds?.[FIVE_HOUR] ?? pool?.threshold ?? 0.95)}
                onChange={(v) => save({ thresholds: { ...(pool?.thresholds ?? {}), [FIVE_HOUR]: Number(v) } })} />
            </View>

            <View style={{ gap: 8 }}>
              <Label>{T('poolThresholdWeek')}</Label>
              <OptionList
                options={LINES.map((v) => ({ id: String(v), label: `${Math.round(v * 100)}%` }))}
                value={String(pool?.threshold ?? 0.99)}
                onChange={(v) => save({ threshold: Number(v) })} />
              <Text style={[type.caption, { color: colors.muted }]}>{T('poolThresholdHint')}</Text>
            </View>

            <View style={{ gap: 8 }}>
              <Label>{T('poolOverage')}</Label>
              <OptionList
                options={[{ id: 'account', label: T('poolOverageAccount') },
                          { id: 'never', label: T('poolOverageNever') }]}
                value={pool?.use_overage ?? 'account'}
                onChange={(v) => save({ use_overage: v })} />
              <Text style={[type.caption, { color: colors.muted }]}>{T('poolOverageHint')}</Text>
            </View>

            {/* Only meaningful when we are the thing preventing the spend. With
                overage allowed there is nothing to hold plan back against. */}
            {pool?.use_overage === 'never' && (
              <View style={{ gap: 8 }}>
                <Label>{T('poolReserve')}</Label>
                <OptionList
                  options={RESERVES.map((v) => ({ id: String(v), label: `${Math.round(v * 100)}%` }))}
                  value={String(pool?.reserve ?? 0.1)}
                  onChange={(v) => save({ reserve: Number(v) })} />
                <Text style={[type.caption, { color: colors.muted }]}>{T('poolReserveHint')}</Text>
              </View>
            )}

            {usable.map((provider) => (
              <View key={provider} style={{ gap: 8 }}>
                <Label>{`${NAMES[provider]} · ${T('poolOrder')}`}</Label>
                <Card>
                  {poolAccounts.filter((a) => a.provider === provider).map((a, i, all) => {
                    const st = standing(a, T);
                    return (
                      <View key={a.account_id} style={[styles.row, i < all.length - 1 && styles.rowBorder]}>
                        <Text style={[type.monoSmall, { color: colors.faint, width: 18 }]}>{i + 1}</Text>
                        <ProviderMark provider={provider} size={20} />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text numberOfLines={1} style={[type.sub, { color: colors.text }]}>{a.label}</Text>
                          <Text style={[type.caption, { color: st.color }]}>
                            {st.text}
                            {a.strict ? ` · ${T('poolStrict')}` : ''}
                            {a.strict && a.margin > 0 ? ` · ${T('poolMargin', { percent: Math.round(a.margin * 100) })}` : ''}
                          </Text>
                        </View>
                        <Pressable onPress={() => toggleStrict(a)} hitSlop={8} style={styles.nudge}>
                          <Text style={[type.caption, { color: a.strict ? colors.accent : colors.faint }]}>
                            {a.strict ? '$̸' : '$'}
                          </Text>
                        </Pressable>
                        <Pressable onPress={() => move(provider, a.account_id, -1)} disabled={i === 0}
                                   hitSlop={8} style={styles.nudge}>
                          <Text style={[type.sub, { color: i === 0 ? colors.faint : colors.accent }]}>↑</Text>
                        </Pressable>
                        <Pressable onPress={() => move(provider, a.account_id, 1)} disabled={i === all.length - 1}
                                   hitSlop={8} style={styles.nudge}>
                          <Text style={[type.sub, { color: i === all.length - 1 ? colors.faint : colors.accent }]}>↓</Text>
                        </Pressable>
                      </View>
                    );
                  })}
                </Card>
                <Text style={[type.caption, { color: colors.muted }]}>{T('poolOrderHint')}</Text>
                <Text style={[type.caption, { color: colors.muted }]}>{T('poolPerAccountHint')}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 8, paddingRight: 20, paddingBottom: 18 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  row: { minHeight: 52, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border2 },
  nudge: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
});
