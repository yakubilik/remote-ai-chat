import React, { useEffect, useMemo, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
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
  return a.localUri || (a.path ? fileUrl(a.path) : null);
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

/** Photo grid (1-4 images), right aligned. Tap opens a full-screen viewer. */
export function ImageGroup({ items }: { items: Attachment[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const two = items.length > 1;
  return (
    <>
      <View style={{ width: two ? 236 : 220, flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
        {items.slice(0, 4).map((a) => {
          const uri = srcOf(a);
          return (
            <Pressable key={a.path} onPress={() => uri && setOpen(uri)} style={[styles.thumb, two ? { width: 116, height: 116 } : { width: 220, height: 220 }]}>
              {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
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

export function FileChip({ item }: { item: Attachment }) {
  return (
    <View style={styles.fileChip}>
      <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><Path d="M14 3v5h5" /></Svg>
      <Text numberOfLines={1} style={[type.caption, { color: colors.text, letterSpacing: 0, flexShrink: 1 }]}>{item.name}</Text>
    </View>
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
