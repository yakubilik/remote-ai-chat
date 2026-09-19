import React, { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useStore, useT } from '../store';
import { LOCALE, type Key } from '../i18n';
import { colors, radius, type } from '../theme';
import { Check } from './ui';
import type { CliAccount, LimitWindow } from '../protocol';

const NAME: Record<string, Key> = {
  five_hour: 'limFiveHour', seven_day: 'limWeekAll', seven_day_opus: 'limWeekOpus',
  seven_day_sonnet: 'limWeekSonnet', overage: 'limOverage',
};

function tone(u: number): string {
  if (u >= 0.9) return colors.danger;
  if (u >= 0.6) return colors.warning;
  return colors.info;
}

function resetLabel(ts: number | null, locale: string, T: ReturnType<typeof useT>): string {
  if (!ts) return '';
  const ms = ts * 1000 - Date.now();
  if (ms <= 0) return T('limResetsNow');
  const h = Math.floor(ms / 3600000);
  if (h < 24) return T('limResetsIn', { h: String(h), m: String(Math.floor((ms % 3600000) / 60000)) });
  return new Date(ts * 1000).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** How long ago the tool last measured. Shown because these numbers are only
 *  refreshed while a turn runs: after an idle hour the ring is a memory, not a
 *  reading, and saying so costs one line. */
function ageLabel(at: number | undefined, T: ReturnType<typeof useT>): string {
  if (!at) return '';
  const m = Math.floor((Date.now() / 1000 - at) / 60);
  if (m < 2) return T('limJustNow');
  if (m < 60) return T('limAgoM', { m: String(m) });
  return T('limAgoH', { h: String(Math.floor(m / 60)) });
}

/** The fullest window, drawn as a ring. The ring is always there: a number is
 *  only useful if it can be glanced at, and a control that comes and goes
 *  cannot be. Until the tool has reported anything the ring is drawn empty and
 *  says so when tapped, which is honest — it is the difference between "you
 *  have used nothing" and "nobody has measured yet". Providers that never
 *  report are the one exception; for those the ring would never fill.
 *
 *  Given a `label` it grows into the chip the chat header wears: the plan being
 *  spent, with a dot for the connection and the ring for what is left of it.
 *  The whole chip is the tap target then — a 30px ring beside a word is not
 *  one, and the word is the part the eye goes to. A provider that reports
 *  nothing keeps the chip and loses only the ring. */
export function LimitsRing({ chatId, accountId, provider, label, sub, dot }: {
  chatId?: string; accountId?: string | null; provider?: string; label?: string; sub?: string; dot?: string;
}) {
  const T = useT();
  const all = useStore((s) => s.limits);
  const accounts = useStore((s) => s.accounts);
  const busy = useStore((s) => (chatId ? !!s.busy[chatId] : false));
  const updateChat = useStore((s) => s.updateChat);
  const [open, setOpen] = useState(false);
  const key = accountId || `default-${provider ?? 'claude'}`;
  // The chip already names the account being spent, so this is where a reader
  // looks to change it. Only sign-ins that can actually run a turn are offered.
  const others = useMemo(
    () => (chatId ? accounts.filter((a) => a.provider === provider && (a.logged_in || a.is_default)) : []),
    [accounts, provider, chatId]);

  /** Moving a chat to another account starts a new thread there: a resume id
   *  belongs to one account's transcript store, and the daemon drops it on the
   *  way over. That is a whole conversation's memory, so it is asked first. */
  function switchTo(a: CliAccount) {
    const next = a.is_default ? null : a.id;
    const name = a.is_default ? T('useDefaultAccount') : a.label;
    if ((accountId ?? null) === next) { setOpen(false); return; }
    if (busy) { Alert.alert(T('acctSwitch'), T('acctSwitchBusy')); return; }
    Alert.alert(T('acctSwitch'), T('acctSwitchBody', { name }), [
      { text: T('cancel'), style: 'cancel' },
      { text: T('acctSwitchGo'), onPress: () => {
          setOpen(false);
          updateChat(chatId!, { account_id: next } as any)
            .catch((e: any) => Alert.alert(T('error'), e.message));
        } },
    ]);
  }
  const windows = useMemo(
    () => (all[key] ?? []).filter((w) => typeof w.utilization === 'number')
      .sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0)),
    [all, key]);
  const reports = !provider || provider === 'claude';
  if (!reports && label == null) return null;

  const top: LimitWindow | undefined = windows[0];
  const pct = Math.max(0, Math.min(1, top?.utilization ?? 0));
  const c = top ? tone(pct) : colors.muted;
  const r = 12, circ = 2 * Math.PI * r;
  const ring = (
    <View style={styles.ringBox}>
      <Svg width={30} height={30} viewBox="0 0 32 32">
        <Circle cx="16" cy="16" r={r} fill="none" stroke={colors.border2} strokeWidth={3.2} />
        <Circle cx="16" cy="16" r={r} fill="none" stroke={c} strokeWidth={3.2} strokeLinecap="round"
          strokeDasharray={`${circ * pct} ${circ}`} transform="rotate(-90 16 16)" />
      </Svg>
      <Text style={[styles.ringPct, { color: c }]}>{top ? Math.round(pct * 100) : '–'}</Text>
    </View>
  );

  return (
    <>
      {label != null ? (
        <Pressable onPress={() => setOpen(true)} hitSlop={6} style={[styles.planChip, !reports && { paddingRight: 12 }]}>
          {!!dot && <View style={[styles.dot, { backgroundColor: dot }]} />}
          <Text numberOfLines={1} style={[type.sub, { color: colors.text, fontWeight: '600' }]}>{label}</Text>
          {!!sub && <Text numberOfLines={1} style={[type.caption, { color: colors.muted, letterSpacing: 0, flexShrink: 1 }]}>{sub}</Text>}
          {reports && ring}
        </Pressable>
      ) : (
        <Pressable onPress={() => setOpen(true)} hitSlop={8} style={styles.ringBtn}>{ring}</Pressable>
      )}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.card} onPress={() => {}}>
            {windows.length === 0 && (
              <View style={styles.row}>
                <Text style={[type.sub, { color: colors.muted }]}>{T('limNone')}</Text>
              </View>
            )}
            {windows.map((w, i) => {
              const p = Math.max(0, Math.min(1, w.utilization ?? 0));
              return (
                <View key={w.window} style={[styles.row, i < windows.length - 1 && styles.rowBorder]}>
                  <View style={styles.rowTop}>
                    <Text style={[type.sub, { color: colors.text, fontWeight: '500', flexShrink: 1 }]}>
                      {NAME[w.window] ? T(NAME[w.window]) : w.window}
                    </Text>
                    <Text style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>
                      {resetLabel(w.resets_at, LOCALE, T)}
                    </Text>
                  </View>
                  <View style={styles.bar}>
                    <View style={[styles.fill, { width: `${p * 100}%`, backgroundColor: tone(p) }]} />
                  </View>
                  <Text style={[type.caption, { color: colors.faint, letterSpacing: 0 }]}>
                    {Math.round(p * 100)}%{i === 0 ? ` · ${ageLabel(w.at, T)}` : ''}
                  </Text>
                </View>
              );
            })}
            {others.length > 1 && (
              <View style={[styles.acctBlock, windows.length > 0 && styles.rowBorderTop]}>
                <Text style={[type.caption, { color: colors.faint, letterSpacing: 0.6 }]}>{T('acctSwitch').toUpperCase()}</Text>
                {others.map((a) => {
                  const on = (accountId ?? null) === (a.is_default ? null : a.id);
                  return (
                    <Pressable key={a.id} onPress={() => switchTo(a)} style={styles.acctRow} hitSlop={4}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={[type.sub, { color: colors.text, fontWeight: on ? '600' : '400' }]}>
                          {a.is_default ? T('useDefaultAccount') : a.label}
                        </Text>
                        <Text numberOfLines={1} style={[type.caption, { color: colors.faint, letterSpacing: 0 }]}>
                          {a.logged_in ? a.detail : T('notSignedIn')}
                        </Text>
                      </View>
                      {on && <Check size={18} />}
                    </Pressable>
                  );
                })}
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  ringBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  ringBox: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  ringPct: { position: 'absolute', fontSize: 10, fontWeight: '600' },
  planChip: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, paddingLeft: 12,
    paddingRight: 4, borderRadius: 17, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, maxWidth: 230 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', padding: 12 },
  card: { borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border2,
    overflow: 'hidden', marginBottom: 30 },
  row: { paddingHorizontal: 14, paddingVertical: 12, gap: 7 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border2 },
  rowBorderTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border2 },
  acctBlock: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4, gap: 2 },
  acctRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  bar: { height: 5, borderRadius: 3, backgroundColor: colors.border2, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3 },
});
