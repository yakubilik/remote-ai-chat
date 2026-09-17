import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useSpeechRecognitionEvent } from '@jamsch/expo-speech-recognition';
import { useStore, useT } from '../src/store';
import { client } from '../src/ws';
import { colors, radius, type } from '../src/theme';
import { abortListening, ensureMic, label as voiceLabel, listVoices, pickVoice, pickup, ring, setVoicePrefs, speak, startListening, stopListening, stopSpeaking, voiceName } from '../src/voice';
import type * as Speech from 'expo-speech';

type Phase = 'idle' | 'dialling' | 'listening' | 'thinking' | 'speaking';
type Line = { id: number; who: 'you' | 'them'; text: string };

/** How long a gap in the talking means "your turn". iOS's own end-of-speech is
 *  about three seconds, which in a conversation reads as the line going dead;
 *  this is roughly the length of a breath. Too short and it cuts you off
 *  mid-thought, so it is measured from the last word actually recognised. */
const SILENCE_MS = 800;

/** Leaving the microphone open through the answer so you can talk over it.
 *
 *  Off, and it stays off until somebody can test it with real speakers. Echo
 *  cancellation removed most of the phone's own voice but not all of it, and
 *  continuous recognition hands back one growing transcript — so two passes of
 *  the same leaked sentence arrived as "that did not go through that did not go
 *  through", which matches no single thing that was said and therefore read as
 *  a person interrupting. It was sent, it failed, the failure was read out, the
 *  microphone heard that too, and the call talked to itself until it was
 *  closed.
 *
 *  Half duplex has none of that failure mode: nothing can be heard while
 *  anything is being said. Cutting in costs a tap, which is a price worth
 *  paying for a call that cannot get stuck in a loop. */
const BARGE_IN = false;

/** How long to let the speaker settle before believing the microphone again.
 *
 *  `onDone` fires when the synthesiser has finished producing the audio, not
 *  when the room has finished hearing it — and a Premium voice through a phone
 *  speaker carries. Three hundred milliseconds was not enough. */
const AFTER_SPEECH_MS = 600;

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** What is left of `heard` once everything traceable to `spoken` is taken out.
 *
 *  Not a single match: a leak can arrive twice over. The first attempt asked
 *  whether the whole heard string appeared inside the spoken one, which is true
 *  for one pass of echo and false for two — so "that did not go through that
 *  did not go through" read as a person talking, was sent, failed, was read out
 *  again, and the call fed on itself.
 *
 *  This walks the words instead, swallowing any run that still appears in what
 *  was said, however many runs there are. What survives is the part nothing
 *  accounts for, which is the only part a person can have contributed. */
function residue(heard: string, spoken: string): string {
  const sp = norm(spoken);
  const words = heard.split(/\s+/).filter(Boolean);
  if (!sp) return words.join(' ');
  const kept: string[] = [];
  let i = 0;
  while (i < words.length) {
    let run = '';
    let last = -1;
    for (let j = i; j < words.length; j++) {
      const next = run + norm(words[j]);
      if (!next || !sp.includes(next)) break;
      run = next;
      last = j;
    }
    if (last >= i) i = last + 1;            // that run came out of the speaker
    else kept.push(words[i++]);
  }
  return kept.join(' ');
}

/** Nothing survives that the phone did not say itself. */
function isEcho(heard: string, spoken: string): boolean {
  if (!norm(heard)) return true;
  if (!norm(spoken)) return false;          // nothing was said; it cannot be echo
  return norm(residue(heard, spoken)).length < 4;
}

/** Your words with the leaked ones taken off the front. */
function stripEcho(heard: string, spoken: string): string {
  return residue(heard, spoken) || heard;
}

/** The call.
 *
 *  One turn is: listen until you stop talking, ask the daemon, read the answer
 *  out, listen again. The loop is deliberate — a call that has to be poked for
 *  every sentence is a walkie-talkie, and the whole point of this screen is to
 *  be able to put the phone to your ear while walking.
 *
 *  It is half duplex. The microphone closes before anything is spoken, because
 *  with both ends open the phone hears its own voice and talks to itself.
 *  Cutting in is a tap on the big button, which is also how you end a silence
 *  iOS has not decided is over yet. */
export default function Call() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const T = useT();
  const lang = useStore((s) => s.prefs.lang);
  const conn = useStore((s) => s.conn);

  const [phase, setPhase] = useState<Phase>('idle');
  const [heard, setHeard] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const [voices, setVoices] = useState<Speech.Voice[] | null>(null);
  const prefs = useStore((st) => st.prefs);
  const setPrefs = useStore((st) => st.setPrefs);

  // The recogniser's last words, kept outside React: the `end` event fires
  // before a queued state update lands, and reading a stale transcript there
  // sent the daemon the *previous* question.
  const transcript = useRef('');
  const phaseRef = useRef<Phase>('idle');
  const live = useRef(false);            // the call is up (not the mic)
  const scroller = useRef<ScrollView | null>(null);
  const nextId = useRef(1);
  const silence = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speaking = useRef('');            // what is being read out right now
  const micOn = useRef(false);
  // Set while we are the ones closing the microphone to send a question, so the
  // `end` that follows is not mistaken for the recogniser giving up on its own.
  const sending = useRef(false);
  /** Every close we perform ourselves still comes back as `end`, and an abort
   *  as an `aborted` error on top of it. Both handlers exist to reopen a
   *  microphone that died unexpectedly — so without a way to tell our own close
   *  from a real one they reopened the one we had just closed on purpose, three
   *  `startListening` calls raced, and recognition returned nothing at all. */
  const closedAt = useRef(0);
  // `armSilence` is defined above `send` and closes over it; going through a
  // ref is what keeps that from being a use-before-declaration.
  const sendRef = useRef<() => void>(() => {});
  // Last thing read out, and last thing sent. Both are here to break loops: a
  // call that talks to itself does it by sending back what it just said, or by
  // sending the same thing twice.
  const lastSpoken = useRef('');
  const lastAsked = useRef('');
  const failures = useRef(0);
  const hangUpRef = useRef<() => void>(() => {});
  const pulse = useRef(new Animated.Value(0)).current;

  // The stored choice has to reach the voice module before anything is spoken.
  useEffect(() => { setVoicePrefs(prefs.voiceIds ?? {}); }, [prefs.voiceIds]);

  useEffect(() => { void pickVoice(lang).then(() => setVoice(voiceName(lang))); }, [lang]);

  const chooseVoice = useCallback(async (v: Speech.Voice) => {
    await setPrefs({ voiceIds: { ...(prefs.voiceIds ?? {}), [lang]: v.identifier } });
    setVoicePrefs({ ...(prefs.voiceIds ?? {}), [lang]: v.identifier });
    await pickVoice(lang);
    setVoice(voiceName(lang));
    setVoices(null);
    // Say something in it, so the choice is made by ear and not by name.
    speak(T('callVoiceTry'), lang, () => {});
  }, [lang, prefs.voiceIds, setPrefs, T]);

  const setPhaseBoth = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);

  const say = useCallback((who: 'you' | 'them', text: string) => {
    setLines((prev) => [...prev, { id: nextId.current++, who, text }]);
  }, []);

  /** The only way anything is spoken.
   *
   *  Two refs held the same idea — what is being said now, and what was said
   *  last — and they were written in different places. The greeting set one and
   *  not the other, so the echo guard at send time had nothing to compare the
   *  greeting's own echo against, decided it could not be echo, and sent it as a
   *  question. That is the first thing that happens on every call, which is why
   *  the loop started before a word was ever spoken to it.
   *
   *  Speaking and recording what was spoken are now one action, so they cannot
   *  come apart again. `record` is for the case where a second sentence follows
   *  a first and both are still in the air. */
  const sayAloud = useCallback((text: string, onDone: () => void, record?: string) => {
    const heardable = record ?? text;
    speaking.current = heardable;
    lastSpoken.current = heardable;
    speak(text, lang, onDone);
  }, [lang]);

  const hush = useCallback(() => {
    if (silence.current) { clearTimeout(silence.current); silence.current = null; }
  }, []);

  /** Close the microphone on purpose. Counts the events it is about to cause so
   *  the handlers know to let them pass. */
  const closeMic = useCallback((mode: 'stop' | 'abort') => {
    if (!micOn.current) return;
    micOn.current = false;
    // A window, not a count: a close raises `end` and sometimes an `aborted`
    // error too, and counting a fixed number would swallow the next real
    // failure whenever it raised fewer.
    closedAt.current = Date.now();
    if (mode === 'stop') stopListening();
    else abortListening();
  }, []);

  /** True when this event is one we caused. */
  const ours = useCallback(() => Date.now() - closedAt.current < 600, []);

  /** Start (or restart) the countdown to "you have stopped talking". Every
   *  recognised word pushes it back, so it only ever fires on a real gap. */
  const armSilence = useCallback(() => {
    hush();
    silence.current = setTimeout(() => {
      if (!live.current || phaseRef.current !== 'listening') return;
      if (!transcript.current.trim()) { armSilence(); return; }   // nobody said anything yet
      sendRef.current();
    }, SILENCE_MS);
  }, [hush]);

  /** Open the microphone for a fresh turn.
   *
   *  It may already be open: it stays on through the answer so you can cut in,
   *  and whatever it collected then is echo. Aborting first throws that away —
   *  `abort` rather than `stop`, because `stop` would hand us the echo as a
   *  final result. The native side needs a beat between the two. */
  const listen = useCallback(() => {
    if (!live.current) return;
    transcript.current = '';
    speaking.current = '';
    setHeard('');
    setPhaseBoth('listening');
    const go = () => {
      if (!live.current) return;
      startListening(lang);
      micOn.current = true;
      armSilence();
    };
    if (micOn.current) {
      closeMic('abort');
      setTimeout(go, 120);
    } else {
      setTimeout(go, AFTER_SPEECH_MS);
    }
  }, [lang, setPhaseBoth, armSilence, closeMic]);

  // ── the recogniser ───────────────────────────────────────────────────────
  useSpeechRecognitionEvent('result', (e) => {
    const said = e.results?.[0]?.transcript ?? '';
    if (!said) return;

    // Heard while the answer is still being read out: either the phone hearing
    // itself, or you cutting in.
    if (phaseRef.current === 'speaking') {
      if (!BARGE_IN || isEcho(said, speaking.current)) return;
      const mine = stripEcho(said, speaking.current);
      stopSpeaking();
      transcript.current = mine;
      setHeard(mine);
      setPhaseBoth('listening');
      armSilence();
      return;
    }

    if (phaseRef.current !== 'listening') return;
    transcript.current = said;
    setHeard(said);
    armSilence();
  });

  useSpeechRecognitionEvent('error', (e) => {
    if (ours()) return;
    if (!live.current) return;
    // The microphone is open through the answer as well, and hearing nothing
    // while the phone talks is the normal case, not a fault. Reopening here
    // would put the call into listening on top of its own voice.
    if (phaseRef.current === 'speaking') { micOn.current = false; return; }
    // A pause, or a session we aborted ourselves on the way to the next turn.
    if (e.error === 'no-speech' || e.error === 'aborted') { listen(); return; }
    setNote(T('callMicError'));
    setPhaseBoth('idle');
    live.current = false;
  });

  useSpeechRecognitionEvent('end', () => {
    micOn.current = false;
    if (ours()) return;
    if (sending.current) { sending.current = false; return; }
    if (!live.current) return;
    // iOS stopped of its own accord — a long silence, a route change, the app
    // coming back. On a call that is not the end of anything, so reopen it.
    if (phaseRef.current === 'listening') listen();
  });

  const ask = useCallback(async (question: string) => {
    say('you', question);
    setHeard('');
    setPhaseBoth('thinking');
    let answer: string;
    let failed = false;
    try {
      // The phone transcribed it, so the phone knows which language it was —
      // the daemon would otherwise take its cue from the snapshot, which is
      // mostly Turkish, and answer English questions in Turkish.
      const r = await client.call<{ text: string }>('call.ask', { text: question, lang });
      answer = (r?.text || '').trim();
    } catch (err: any) {
      failed = true;
      answer = err?.code === 'offline' ? T('callOffline') : T('callFailed');
    }
    if (!live.current) return;
    // Three failures in a row is a computer that is not going to answer, and
    // reading the same apology out on a loop helps nobody.
    if (failed) {
      failures.current += 1;
      if (failures.current >= 3) {
        setNote(answer);
        hangUpRef.current();
        return;
      }
    } else {
      failures.current = 0;
    }
    if (!answer) { listen(); return; }
    say('them', answer);
    setPhaseBoth('speaking');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // The microphone goes back on *before* the answer starts, and stays on
    // through it. That is the whole of cutting in: there is no button to find,
    // you just talk, and the `result` handler decides whether what it heard was
    // you or the phone hearing itself.
    if (BARGE_IN && !micOn.current) {
      startListening(lang);
      micOn.current = true;
    }
    sayAloud(answer, () => {
      if (!live.current || phaseRef.current !== 'speaking') return;
      listen();
    });
  }, [lang, listen, say, sayAloud, setPhaseBoth, T]);

  /** Your turn is over: close the microphone and put the question on the wire.
   *
   *  Two things are refused here rather than sent. Anything that is a piece of
   *  what was just read out is the phone hearing itself, however it got in —
   *  the microphone should have been shut, echo cancellation should have caught
   *  it, and this is the last place to notice before it becomes a question.
   *  Asking the same thing twice in a row is the same fault one step later.
   *  Either way the turn is dropped and the call goes back to listening, which
   *  is what a person would do having heard nothing. */
  const send = useCallback(() => {
    const said = transcript.current.trim();
    if (!said || !live.current) return;
    hush();
    if (isEcho(said, lastSpoken.current) || norm(said) === norm(lastAsked.current)) {
      transcript.current = '';
      setHeard('');
      armSilence();
      return;
    }
    lastAsked.current = said;
    sending.current = true;
    closeMic('stop');
    void ask(said);
  }, [hush, ask, closeMic, armSilence]);

  useEffect(() => { sendRef.current = send; }, [send]);

  // ── call control ─────────────────────────────────────────────────────────
  /** Placing the call.
   *
   *  Ringback, then the click of somebody picking up, then a voice. Those two
   *  sounds are doing real work: they are how anyone who has ever used a phone
   *  already knows the line is connecting, that it went through, and that it is
   *  now their turn — none of which a synthesised "hello" out of silence says.
   *
   *  They also cost nothing. The first question to the concierge would take
   *  about four seconds cold, because the CLI sets itself up on its first
   *  query; `call.hello` starts that on the way past and the ringing covers it,
   *  so the first question lands in about a second like every other one. The
   *  greeting itself is spoken by the phone and never waits on the network —
   *  the three numbers behind it are used if they have arrived and skipped if
   *  they have not. */
  const start = useCallback(async () => {
    if (!(await ensureMic())) { setNote(T('callNoMic')); return; }
    setNote(null);
    live.current = true;
    failures.current = 0;
    lastSpoken.current = '';
    lastAsked.current = '';
    setPhaseBoth('dialling');
    // Cheap, cached, and done while it rings — the greeting is the first thing
    // spoken and it should already be in the right voice.
    await pickVoice(lang);
    setVoice(voiceName(lang));

    // Fired, not awaited: this is also what warms the model session, and the
    // ringing is what it warms behind.
    let rest: string | null = null;
    void client.call<{ working: number; blocked: number; idle: number }>('call.hello', {})
      .then((h) => {
        const bits: string[] = [];
        // Whatever is blocked is said first — it is the only thing on the
        // computer that is actually waiting on the person holding the phone.
        if (h.blocked > 0) bits.push(T('callHeadBlocked', { n: h.blocked }));
        if (h.working > 0) bits.push(T('callHeadWorking', { n: h.working }));
        if (!bits.length) bits.push(T('callQuiet'));
        rest = bits.join(' ');
      })
      .catch(() => {});

    // Ringing, then the click of the other end picking up, then the voice. The
    // microphone opens on the click and not before: a ringtone is not a
    // question, and the recogniser should never have to decide that.
    await ring();
    if (!live.current) return;
    await pickup();
    if (!live.current) return;

    const alo = T('callAlo');
    setPhaseBoth('speaking');
    say('them', alo);
    if (BARGE_IN) { startListening(lang); micOn.current = true; }

    // Every one of these runs on `onStopped` too, which is what cutting in
    // triggers — and cutting in has already opened the microphone itself. The
    // phase guard is what stops the greeting from opening a second one on its
    // way out.
    sayAloud(alo, () => {
      if (!live.current || phaseRef.current !== 'speaking') return;
      // "Alo" takes about half a second to say and the round trip takes
      // milliseconds, so the headline is almost always here by now. When it is
      // not, the call simply opens without it rather than holding the line.
      if (rest) {
        say('them', rest);
        sayAloud(rest, () => {
          if (live.current && phaseRef.current === 'speaking') listen();
        }, `${alo} ${rest}`);
      } else {
        listen();
      }
    });
  }, [lang, listen, say, setPhaseBoth, T]);

  const hangUp = useCallback(() => {
    live.current = false;
    hush();
    closeMic('abort');
    stopSpeaking();
    setPhaseBoth('idle');
    setHeard('');
  }, [setPhaseBoth, hush, closeMic]);

  useEffect(() => { hangUpRef.current = hangUp; }, [hangUp]);

  /** The big button. What it does depends on what is happening — which is the
   *  point: there is only ever one thing you could want. */
  const tap = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (phase === 'idle') { void start(); return; }
    if (phase === 'dialling') return;                                // it is ringing; let it
    if (phase === 'speaking') { stopSpeaking(); listen(); return; }   // cut in
    if (phase === 'listening') { send(); return; }                    // send it now
  }, [phase, start, listen, send]);

  // Leaving the screen must not leave a microphone open behind it.
  useEffect(() => () => {
    live.current = false;
    if (silence.current) clearTimeout(silence.current);
    abortListening();
    stopSpeaking();
  }, []);

  useEffect(() => {
    if (phase === 'listening' || phase === 'thinking' || phase === 'dialling') {
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]));
      loop.start();
      return () => loop.stop();
    }
    pulse.setValue(0);
  }, [phase, pulse]);

  const label = phase === 'idle' ? T('callStart')
    : phase === 'dialling' ? T('callDialling')
    : phase === 'listening' ? T('callListening')
    : phase === 'thinking' ? T('callThinking')
    : T('callSpeaking');

  const hint = phase === 'dialling' ? T('callHintDialling')
    : phase === 'listening' ? T('callHintListening')
    : phase === 'speaking' ? T(BARGE_IN ? 'callHintSpeaking' : 'callHintTapCut')
    : phase === 'idle' ? T('callHintIdle') : '';

  const ringColor = phase === 'speaking' ? colors.info
    : phase === 'thinking' || phase === 'dialling' ? colors.warning : colors.accent;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
      <View style={styles.top}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={[type.body, { color: colors.accent }]}>{T('close')}</Text>
        </Pressable>
        <Text style={[type.headline, { color: colors.text }]}>{T('callTitle')}</Text>
        <View style={{ width: 54 }} />
      </View>

      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 20, paddingBottom: 12 }}
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}>
        {lines.length === 0 && phase === 'idle' && (
          <Text style={[type.sub, { color: colors.muted, textAlign: 'center', marginTop: 40 }]}>
            {T('callEmpty')}
          </Text>
        )}
        {lines.map((l) => (
          <View key={l.id} style={[styles.bubble, l.who === 'you' ? styles.you : styles.them]}>
            <Text style={[type.body, { color: l.who === 'you' ? colors.text : colors.text }]}>{l.text}</Text>
          </View>
        ))}
        {!!heard && (
          <View style={[styles.bubble, styles.you, { opacity: 0.5 }]}>
            <Text style={[type.body, { color: colors.text }]}>{heard}</Text>
          </View>
        )}
      </ScrollView>

      {voices !== null && (
        <View style={styles.voiceBox}>
          <View style={styles.voiceHead}>
            <Text style={[type.label, { color: colors.muted }]}>{T('callVoicePick')}</Text>
            <Pressable onPress={() => setVoices(null)} hitSlop={10}>
              <Text style={[type.sub, { color: colors.accent }]}>{T('close')}</Text>
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 220 }}>
            {voices.map((v) => {
              const on = (prefs.voiceIds ?? {})[lang] === v.identifier;
              return (
                <Pressable key={v.identifier} onPress={() => void chooseVoice(v)} style={styles.voiceRow}>
                  <Text style={[type.sub, { color: on ? colors.accent : colors.text }]}>{voiceLabel(v)}</Text>
                </Pressable>
              );
            })}
            {voices.length === 0 && (
              <Text style={[type.sub, { color: colors.muted, padding: 12 }]}>{T('callVoiceNone')}</Text>
            )}
          </ScrollView>
        </View>
      )}
      {!!note && <Text style={[type.caption, styles.note]}>{note}</Text>}
      {conn !== 'online' && <Text style={[type.caption, styles.note]}>{T('callOffline')}</Text>}

      <View style={{ alignItems: 'center', paddingBottom: insets.bottom + 24 }}>
        <Text style={[type.caption, { color: colors.muted, marginBottom: 2, height: 18 }]}>{hint}</Text>
        <Pressable onPress={() => { void listVoices(lang).then(setVoices); }} hitSlop={8}>
          <Text style={[type.caption, { color: colors.muted, marginBottom: 8, height: 16 }]}>
            {voice ? T('callVoice', { v: voice }) : ' '}
          </Text>
        </Pressable>
        <Pressable onPress={tap} disabled={phase === 'thinking'}>
          <Animated.View style={[styles.mic, {
            borderColor: ringColor,
            backgroundColor: phase === 'idle' ? colors.surface : colors.accentSoft,
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] }) }],
          }]}>
            <Text style={[type.headline, { color: phase === 'idle' ? colors.text : ringColor }]}>{label}</Text>
          </Animated.View>
        </Pressable>
        {phase !== 'idle' && (
          <Pressable onPress={hangUp} style={styles.hangUp} hitSlop={10}>
            <Text style={[type.sub, { color: colors.danger }]}>{T('callHangUp')}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 8 },
  bubble: { padding: 12, borderRadius: radius.lg, marginBottom: 10, maxWidth: '86%' },
  you: { alignSelf: 'flex-end', backgroundColor: colors.userBubble },
  them: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  note: { color: colors.warning, textAlign: 'center', paddingHorizontal: 20, paddingBottom: 6 },
  mic: { width: 190, height: 190, borderRadius: 95, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  hangUp: { marginTop: 18, paddingVertical: 8, paddingHorizontal: 20 },
  voiceBox: { marginHorizontal: 20, marginBottom: 10, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  voiceHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  voiceRow: { paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: 1, borderTopColor: colors.border },
});
