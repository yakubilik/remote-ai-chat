import * as Speech from 'expo-speech';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { ExpoSpeechRecognitionModule } from '@jamsch/expo-speech-recognition';
import { LOCALE, type Lang } from './i18n';

/** Speech in and speech out, both on the phone.
 *
 *  Nothing audible ever crosses the network. The phone recognises what you said
 *  and sends the daemon a sentence; the daemon sends a sentence back and the
 *  phone reads it. That is why a call needs no WebRTC, no codec and no jitter
 *  buffer — by the time the bytes travel they are just text on the socket the
 *  app already had open.
 *
 *  Half duplex on purpose: the microphone is closed before anything is spoken.
 *  With both open the phone hears its own voice and answers itself. Cutting in
 *  is a tap, not a shout — see the call screen. */

export function locale(lang: Lang): string {
  return LOCALE[lang] || 'en-US';
}

export async function ensureMic(): Promise<boolean> {
  try {
    const r = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    return !!r.granted;
  } catch {
    return false;
  }
}

export function startListening(lang: Lang) {
  ExpoSpeechRecognitionModule.start({
    lang: locale(lang),
    // The screen shows the words as they land, so a long pause still looks
    // alive — and they are also how the call knows you have stopped talking.
    interimResults: true,
    // Continuous, because iOS's own end-of-speech takes about three seconds.
    // Three seconds of silence is not a pause in a conversation, it is the
    // other person having hung up. The call times the gap itself instead, at
    // roughly the length of a breath.
    continuous: true,
    addsPunctuation: true,
    // Recognition quality matters more here than keeping audio off Apple's
    // servers: the questions are full of project names the on-device model has
    // never seen. The audio is a question about a build, not the work itself.
    requiresOnDeviceRecognition: false,
    // Words the recogniser would otherwise spell as something else entirely.
    contextualStrings: ['Claude', 'Codex', 'daemon', 'commit', 'build', 'deploy',
                        'branch', 'merge', 'TestFlight', 'Xcode', 'Expo'],
    // The session a phone call wants: speaker by default, and `voiceChat`,
    // which is what turns on the echo cancellation. Without it the microphone
    // hears the answer being read out and the call starts interrupting itself.
    iosCategory: {
      category: 'playAndRecord',
      categoryOptions: ['defaultToSpeaker', 'allowBluetooth'],
      mode: 'voiceChat',
    },
  });
}

export function stopListening() {
  try { ExpoSpeechRecognitionModule.stop(); } catch {}
}

/** Drop the microphone now and throw away whatever was half-heard. `stop()`
 *  asks for a final result; ending a call does not want one. */
export function abortListening() {
  try { ExpoSpeechRecognitionModule.abort(); } catch {}
}

/** Which voice answers the phone.
 *
 *  Not hardcoded, because the good ones are optional downloads: iOS ships a
 *  compact voice and keeps the "Enhanced" one behind Settings → Accessibility →
 *  Spoken Content → Voices. Asking the phone what it actually has and ranking
 *  that is the difference between a considered choice and a broken identifier.
 *
 *  For English the target is Daniel — en-GB, male, unhurried. It is the closest
 *  thing Apple ships to the butler everyone has in mind, and unlike a cloned
 *  voice it costs nothing, runs on the phone and belongs to nobody.
 *
 *  Turkish has one voice, Yelda, and she is female. There is no Turkish butler
 *  to pick, so the ranking below quietly does the only thing it can. */
const WANTED: Record<string, string[]> = {
  en: ['daniel', 'oliver', 'arthur', 'serena'],
  tr: ['yelda'],
};

/** iOS ships three grades of voice and `expo-speech` can only report two: its
 *  native side maps anything that is not `.enhanced` to "Default", which files
 *  a freshly downloaded **Premium** voice — the best one there is — under the
 *  same label as the tinny built-in. Ranking on that field would have thrown
 *  away the voice somebody had just gone and installed.
 *
 *  The identifier does not lie. Apple builds it as
 *  `com.apple.voice.<grade>.<lang>.<Name>`, so the grade is read from there. */
export function grade(v: Speech.Voice): 'premium' | 'enhanced' | 'compact' {
  const id = (v.identifier || '').toLowerCase();
  if (id.includes('premium')) return 'premium';
  if (id.includes('enhanced') || v.quality === Speech.VoiceQuality.Enhanced) return 'enhanced';
  return 'compact';
}

const GRADE_SCORE = { premium: 90, enhanced: 60, compact: 0 };

const picked: Partial<Record<Lang, Speech.Voice | null>> = {};
let override: Partial<Record<Lang, string>> = {};

/** The chosen voice wins over anything this file thinks it knows. */
export function setVoicePrefs(ids: Partial<Record<Lang, string>>) {
  override = ids || {};
  for (const k of Object.keys(picked) as Lang[]) delete picked[k];
}

function score(v: Speech.Voice, lang: Lang): number {
  const base = locale(lang).slice(0, 2).toLowerCase();
  const vl = (v.language || '').toLowerCase().replace('_', '-');
  if (!vl.startsWith(base)) return -1;
  let n = GRADE_SCORE[grade(v)];
  if (base === 'en' && vl.startsWith('en-gb')) n += 20;
  const idx = (WANTED[base] || []).indexOf((v.name || '').toLowerCase());
  if (idx >= 0) n += 15 - idx * 4;
  return n;
}

/** Every voice on the phone, the ones for this language first.
 *
 *  Filtering to the app's language hid the Turkish voices from somebody running
 *  the app in English — who is exactly the person who asks a question in
 *  Turkish and wants it answered in a Turkish voice. The language a call is
 *  held in is not the language the menus are in. */
export async function listVoices(lang: Lang): Promise<Speech.Voice[]> {
  const base = locale(lang).slice(0, 2).toLowerCase();
  const mine = (v: Speech.Voice) =>
    (v.language || '').toLowerCase().replace('_', '-').startsWith(base);
  try {
    const all = await Speech.getAvailableVoicesAsync();
    return all.sort((a, b) => {
      if (mine(a) !== mine(b)) return mine(a) ? -1 : 1;
      if (a.language !== b.language) return a.language.localeCompare(b.language);
      return score(b, lang) - score(a, lang) || a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

export async function pickVoice(lang: Lang): Promise<Speech.Voice | null> {
  if (picked[lang] !== undefined) return picked[lang] ?? null;
  let best: Speech.Voice | null = null;
  try {
    const all = await Speech.getAvailableVoicesAsync();
    const chosen = override[lang];
    if (chosen) best = all.find((v) => v.identifier === chosen) ?? null;
    if (!best) {
      let top = 0;
      for (const v of all) {
        const n = score(v, lang);
        if (n > top) { top = n; best = v; }
      }
    }
  } catch {
    best = null;
  }
  picked[lang] = best;
  return best;
}

/** Apple already puts the grade in the name of the ones you download — "Ava
 *  (Premium)" — so appending ours produced "Ava (Premium) (premium)". Only say
 *  it when the name has not said it already. */
function withGrade(v: Speech.Voice): string {
  const g = grade(v);
  return v.name.toLowerCase().includes(g) ? v.name : `${v.name} (${g})`;
}

export function voiceName(lang: Lang): string | null {
  const v = picked[lang];
  return v ? withGrade(v) : null;
}

export function label(v: Speech.Voice): string {
  return `${withGrade(v)} · ${v.language.replace('_', '-')}`;
}

export function speak(text: string, lang: Lang, onDone: () => void) {
  Speech.speak(text, {
    voice: picked[lang]?.identifier,
    language: locale(lang),
    // Slightly under the default: the answers are dense, and a status read at
    // full speed has to be asked for twice. It also reads as composure rather
    // than as a machine getting through a queue.
    rate: 0.96,
    onDone,
    onStopped: onDone,
    onError: onDone,
  });
}

export function stopSpeaking() {
  try { Speech.stop(); } catch {}
}

// ── the sound of a call ───────────────────────────────────────────────────────
/** A call that begins with a synthesised voice saying hello begins nowhere: you
 *  have no idea whether it is connecting, whether it heard you, whether there is
 *  a line at all. Two sounds fix that, and they are the ones every phone has
 *  trained everyone to read — the ringback while it dials, the click when the
 *  other end picks up.
 *
 *  The ring is also honest about time rather than filling it: the daemon is
 *  warming the model session while it plays, so the first question afterwards
 *  answers in about a second instead of four. */
const RING_MS = 2000;      // ring.wav, synthesised at 425 Hz — European ringback
const PICKUP_MS = 90;      // pickup.wav

function playOnce(mod: number, ms: number, volume: number): Promise<void> {
  return new Promise((resolve) => {
    let player: AudioPlayer | null = null;
    const done = () => {
      try { player?.remove(); } catch {}
      player = null;
      resolve();
    };
    try {
      player = createAudioPlayer(mod);
      player.volume = volume;
      player.play();
    } catch {
      resolve();
      return;
    }
    // The clips are ours and their lengths are known, so the end is a timer
    // rather than a status subscription — one less thing to leak if the screen
    // is closed mid-ring.
    setTimeout(done, ms);
  });
}

export function ring(): Promise<void> {
  return playOnce(require('../assets/sound/ring.wav'), RING_MS, 0.5);
}

export function pickup(): Promise<void> {
  return playOnce(require('../assets/sound/pickup.wav'), PICKUP_MS, 0.6);
}
