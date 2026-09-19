import React, { useEffect, useMemo, useState } from 'react';
import { Image, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as VideoThumbnails from 'expo-video-thumbnails';
import Svg, { Path } from 'react-native-svg';
import { colors, type, mono } from '../theme';
import { fileUrl, useStore, useT, type Attachment } from '../store';

const PlayIcon = ({ size = 14, color = colors.white }: { size?: number; color?: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}><Path d="M7 4v16l13-8z" /></Svg>
);
const PauseIcon = ({ size = 14, color = colors.white }: { size?: number; color?: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}><Path d="M6 4h4v16H6zM14 4h4v16h-4z" /></Svg>
);

function srcOf(a: Attachment): string | null {
  const remote = a.view || a.path;
  return a.localUri || (remote ? fileUrl(remote) : null);
}

function fmt(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// deterministic pseudo-waveform so a bubble looks the same every render
function bars(seed: string, n = 24): number[] {
  let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Array.from({ length: n }, (_, i) => { h = (h * 1103515245 + 12345) >>> 0; return 6 + ((h >>> 8) % 20) + (i % 3); });
}

/** Photo grid (1-4 images). Right aligned under the person's bubble, left
 *  under the agent's. Tap opens a full-screen viewer. */
export function ImageGroup({ items, align = 'right' }: { items: Attachment[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState<string | null>(null);
  // A picture that will not load says so. Left blank it reads as a rendering
  // bug; named, it reads as a file name where a picture should be.
  const [gone, setGone] = useState<Record<string, boolean>>({});
  const two = items.length > 1;
  return (
    <>
      <View style={{ width: two ? 236 : 220, flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}>
        {items.slice(0, 4).map((a) => {
          const uri = srcOf(a);
          const size = two ? { width: 116, height: 116 } : { width: 220, height: 220 };
          if (!uri || gone[a.path]) {
            return (
              <View key={a.path} style={[styles.thumb, size, { alignItems: 'center', justifyContent: 'center', gap: 6, padding: 8 }]}>
                <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={colors.faint} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M4 5h16v14H4z" /><Path d="M4 16l4-4 4 4 3-3 5 5" />
                </Svg>
                <Text numberOfLines={2} style={[type.caption, { color: colors.faint, letterSpacing: 0, textAlign: 'center' }]}>
                  {a.name}
                </Text>
              </View>
            );
          }
          return (
            <Pressable key={a.path} onPress={() => setOpen(uri)} style={[styles.thumb, size]}>
              <Image
                source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover"
                onError={() => setGone((g) => ({ ...g, [a.path]: true }))}
              />
            </Pressable>
          );
        })}
      </View>
      <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <Pressable onPress={() => setOpen(null)} style={styles.viewer}>
          {open && <Image source={{ uri: open }} style={{ width: '100%', height: '80%' }} resizeMode="contain" />}
        </Pressable>
      </Modal>
    </>
  );
}

/** Video thumbnail with play badge; tap plays full screen. */
export function VideoBubble({ item }: { item: Attachment }) {
  const uri = srcOf(item);
  const [thumb, setThumb] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    if (uri) VideoThumbnails.getThumbnailAsync(uri, { time: 500 }).then((r) => alive && setThumb(r.uri)).catch(() => {});
    return () => { alive = false; };
  }, [uri]);
  return (
    <>
      <Pressable onPress={() => uri && setOpen(true)} style={[styles.thumb, { width: 200, height: 130, alignItems: 'center', justifyContent: 'center' }]}>
        {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <View style={styles.playBadge}><PlayIcon size={18} /></View>
        {item.duration != null && <Text style={styles.durBadge}>{fmt(item.duration)}</Text>}
      </Pressable>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        {uri && <FullVideo uri={uri} onClose={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

function FullVideo({ uri, onClose }: { uri: string; onClose: () => void }) {
  const player = useVideoPlayer(uri, (p) => { p.loop = false; p.play(); });
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <VideoView player={player} style={{ flex: 1 }} fullscreenOptions={{ enable: true }} nativeControls />
      <Pressable onPress={onClose} style={styles.close}><Text style={[type.headline, { color: colors.white }]}>✕</Text></Pressable>
    </View>
  );
}

/** Voice note: play/pause, waveform, duration, transcript below. */
export function VoiceBubble({ item }: { item: Attachment }) {
  const T = useT();
  const transcriptionOn = useStore((s) => s.hostInfo?.transcription ?? true);
  const uri = srcOf(item);
  const player = useAudioPlayer(uri ? { uri } : null);
  const status = useAudioPlayerStatus(player);
  const wave = useMemo(() => bars(item.path), [item.path]);
  const total = status.duration || item.duration || 0;
  const progress = total ? Math.min(1, (status.currentTime || 0) / total) : 0;
  const playing = status.playing;
  const toggle = () => {
    if (!uri) return;
    if (playing) player.pause();
    else { if (progress >= 0.999) player.seekTo(0); player.play(); }
  };
  return (
    <View style={styles.voice}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Pressable onPress={toggle} style={styles.playBtn}>{playing ? <PauseIcon /> : <PlayIcon />}</Pressable>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 28 }}>
          {wave.map((h, i) => (
            <View key={i} style={{ width: 3, height: h, borderRadius: 2, backgroundColor: i / wave.length <= progress ? colors.text : colors.muted }} />
          ))}
        </View>
        <Text style={{ fontFamily: mono, fontSize: 12, color: colors.muted }}>{fmt(playing ? status.currentTime : total)}</Text>
      </View>
      <Text style={[type.caption, { color: colors.muted, letterSpacing: 0, lineHeight: 19, fontSize: 14 }]}>
        {item.transcript ? `“${item.transcript}”` : transcriptionOn ? T('noSpeech') : T('noTranscript')}
      </Text>
    </View>
  );
}

function fmtSize(n?: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A file by name. `openable` chips (the agent's) open in the system viewer
 *  on tap — Safari shows a PDF and offers the share sheet, which is download,
 *  AirDrop and Files in one place, with no native module of our own. */
export function FileChip({ item, openable }: { item: Attachment; openable?: boolean }) {
  const uri = openable ? srcOf(item) : null;
  const size = fmtSize(item.size);
  return (
    <Pressable disabled={!uri} onPress={() => uri && Linking.openURL(uri).catch(() => {})}
      style={[styles.fileChip, openable && { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }]}>
      <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={openable ? colors.accent : colors.muted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><Path d="M14 3v5h5" /></Svg>
      <Text numberOfLines={1} style={[type.caption, { color: colors.text, letterSpacing: 0, flexShrink: 1 }]}>{item.name}</Text>
      {!!size && openable && <Text style={[type.caption, { color: colors.muted, letterSpacing: 0 }]}>{size}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  thumb: { borderRadius: 14, overflow: 'hidden', backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
  playBadge: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(15,14,12,0.7)', alignItems: 'center', justifyContent: 'center' },
  durBadge: { position: 'absolute', right: 8, bottom: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(15,14,12,0.7)', color: colors.text, fontFamily: mono, fontSize: 11 },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.96)', alignItems: 'center', justifyContent: 'center' },
  close: { position: 'absolute', top: 54, right: 20, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  voice: { width: 260, backgroundColor: colors.userBubble, borderRadius: 18, borderBottomRightRadius: 4, padding: 12, gap: 8 },
  playBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 36, paddingHorizontal: 12, borderRadius: 18, backgroundColor: colors.userBubble, maxWidth: 260 },
});
