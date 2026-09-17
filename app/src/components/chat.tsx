import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AstRenderer, MarkdownIt, renderRules, stringToTokens, tokensToAST } from 'react-native-markdown-display';
// @ts-ignore - exported at runtime, absent from the package's typings
import { removeTextStyleProps, styles as mdDefaults } from 'react-native-markdown-display';
// The three passes the library's own `parser()` runs between tokens and AST.
// Not re-exported, so they are reached by path; building the AST here is what
// lets the keys be ours (see below).
// @ts-ignore
import { cleanupTokens } from 'react-native-markdown-display/src/lib/util/cleanupTokens';
// @ts-ignore
import groupTextTokens from 'react-native-markdown-display/src/lib/util/groupTextTokens';
// @ts-ignore
import omitListItemParagraph from 'react-native-markdown-display/src/lib/util/omitListItemParagraph';
import * as Haptics from 'expo-haptics';
import { colors, radius, type, mono } from '../theme';
import { useStore, useT } from '../store';
import { Check, Chevron, ChevronDown, LiveMark, Lock, Spinner } from './ui';
import { FileChip, ImageGroup, VideoBubble, VoiceBubble } from './media';
import type { Attachment } from '../store';

export function UserBubble({ text, attachments }: { text: string; attachments?: Attachment[] }) {
  const atts = attachments ?? [];
  const images = atts.filter((a) => a.kind === 'image' || (!a.kind && /\.(png|jpe?g|gif|webp|heic)$/i.test(a.name || a.path || '')));
  const videos = atts.filter((a) => a.kind === 'video');
  const voices = atts.filter((a) => a.kind === 'audio');
  const files = atts.filter((a) => !images.includes(a) && !videos.includes(a) && !voices.includes(a));
  const textIsTranscript = voices.length > 0 && voices.some((v) => v.transcript && v.transcript === text);
  return (
    <View style={{ alignItems: 'flex-end', gap: 6 }}>
      {images.length > 0 && <ImageGroup items={images} />}
      {videos.map((v) => <VideoBubble key={v.path} item={v} />)}
      {voices.map((v) => <VoiceBubble key={v.path} item={v} />)}
      {files.map((f) => <FileChip key={f.path} item={f} />)}
      {!!text && !textIsTranscript && <View style={styles.userBubble}><Text selectable style={[type.body, { color: colors.text, lineHeight: 23 }]}>{text}</Text></View>}
    </View>
  );
}

const mdStyles = {
  body: { color: colors.text, fontSize: 17, lineHeight: 24 },
  paragraph: { marginTop: 0, marginBottom: 10 },
  heading1: { color: colors.text, fontSize: 22, fontWeight: '600', marginBottom: 8 },
  heading2: { color: colors.text, fontSize: 19, fontWeight: '600', marginBottom: 6 },
  heading3: { color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: 4 },
  strong: { fontWeight: '600' },
  link: { color: colors.accent },
  bullet_list: { marginBottom: 8 },
  ordered_list: { marginBottom: 8 },
  list_item: { marginBottom: 4 },
  code_inline: { fontFamily: mono, fontSize: 14, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: 4, borderRadius: 4 },
  code_block: { fontFamily: mono, fontSize: 12, backgroundColor: colors.surface, color: colors.text, borderRadius: radius.md, padding: 12, borderWidth: 0 },
  fence: { fontFamily: mono, fontSize: 12, backgroundColor: colors.surface, color: colors.text, borderRadius: radius.md, padding: 12, borderWidth: 0, borderColor: colors.border },
  blockquote: { backgroundColor: colors.surface, borderLeftWidth: 0, paddingHorizontal: 12, borderRadius: radius.sm },
  hr: { backgroundColor: colors.border2 },
  table: { borderColor: colors.border2 },
  tr: { borderColor: colors.border2 },
} as const;

/** The parser hands code blocks one trailing newline more than was written. */
function trimEnd(content: string): string {
  return typeof content === 'string' && content.endsWith('\n') ? content.slice(0, -1) : content;
}

/** Markdown builds every line out of plain <Text>, and a <Text> that is not
 *  `selectable` cannot be dragged through on iOS — so there was no way to take
 *  part of an answer, only the whole message. Copying one command out of a code
 *  block is the common case, and it was the one case that could not be done.
 *
 *  Only the rules that actually render text are replaced; everything else stays
 *  on the library's own defaults. */
const selectableRules = {
  textgroup: (node: any, children: any, _parent: any, styles: any) => (
    <Text key={node.key} selectable style={styles.textgroup}>{children}</Text>
  ),
  code_inline: (node: any, _children: any, _parent: any, styles: any, inherited: any = {}) => (
    <Text key={node.key} selectable style={[inherited, styles.code_inline]}>{node.content}</Text>
  ),
  code_block: (node: any, _children: any, _parent: any, styles: any, inherited: any = {}) => (
    <Text key={node.key} selectable style={[inherited, styles.code_block]}>{trimEnd(node.content)}</Text>
  ),
  fence: (node: any, _children: any, _parent: any, styles: any, inherited: any = {}) => (
    <Text key={node.key} selectable style={[inherited, styles.fence]}>{trimEnd(node.content)}</Text>
  ),
};

/** Markdown, rendered so that a message can grow a token at a time.
 *
 *  The library stamps every node it parses - the root view included - with a
 *  fresh `getUniqueID()`. React reads those as keys, so each render was an
 *  entirely new tree: every view in the message torn down and rebuilt. Free
 *  for a message that arrives finished, quadratic for one that streams. A long
 *  answer rebuilt hundreds of native views dozens of times a second and the
 *  chat stopped responding until it was left and re-entered, which is exactly
 *  what it took to make it flow again.
 *
 *  So the AST is built here and keyed by position in the tree: the paragraph
 *  that was there a token ago keeps its key, and React updates what changed
 *  instead of replacing all of it. The renderer and its stylesheet are built
 *  once, for the same reason - the component rebuilt both on every render. */
const MD = MarkdownIt({ typographer: true });

/** The library's own style merge: defaults under ours, plus the `_VIEW_SAFE_`
 *  twin of each entry that the render rules reach for on container nodes. */
function buildStyles(custom: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const k of Object.keys(mdDefaults as any)) out[k] = { ...(mdDefaults as any)[k], ...StyleSheet.flatten(custom[k]) };
  for (const k of Object.keys(custom)) if (!out[k]) out[k] = { ...StyleSheet.flatten(custom[k]) };
  for (const k of Object.keys(out)) out['_VIEW_SAFE_' + k] = (removeTextStyleProps as any)(out[k]);
  return StyleSheet.create(out);
}

const renderer: any = new (AstRenderer as any)(
  { ...renderRules, ...selectableRules },
  buildStyles(mdStyles as any),
  undefined,   // onLinkPress - the library's default opener
  null,        // maxTopLevelChildren
  null,        // topLevelMaxExceededItem
  ['data:image/png;base64', 'data:image/gif;base64', 'data:image/jpeg;base64', 'https://', 'http://'],
  'https://',
  false,
);

/** Where a node sits in the tree, not a counter. Two parses of almost the same
 *  text agree on almost every key, which is the whole point. */
function keyTree(nodes: any[], path: string): any[] {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    n.key = `${path}${i}${n.type}`;
    if (n.children?.length) keyTree(n.children, `${n.key}.`);
  }
  return nodes;
}

function renderMarkdown(src: string) {
  let tokens = stringToTokens(src, MD as any);
  tokens = (cleanupTokens as any)(tokens);
  tokens = (groupTextTokens as any)(tokens);
  tokens = (omitListItemParagraph as any)(tokens);
  const ast = keyTree(tokensToAST(tokens) as any[], '');
  // `render()` keys the root with a fresh id too; pin it, or the one key that
  // matters most changes on every token.
  return renderer.renderNode({ type: 'body', key: 'md', children: ast }, [], true);
}

export const AssistantText = React.memo(function AssistantText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <View style={styles.assistant}>{renderMarkdown(text + (streaming ? ' ▍' : ''))}</View>
  );
});

const HOME = /\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+|C:\\Users\\[^\\\s'"]+/gi;

/** A home directory eats the half of a one-line summary that carried meaning,
 *  and the account name is nobody's business on a screen held up to a room.
 *  Display only — the command that runs is untouched. */
function tildeAll(text: string): string {
  return text.replace(HOME, '~');
}

function toolSummary(tool: string, input: any): string {
  if (!input) return '';
  if (tool === 'Bash') return tildeAll(input.command || '');
  return tildeAll(input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt || '');
}

/** A finished run of tool calls, folded into one line until it is asked for.
 *  `Ran 5 commands` beats five cards between two sentences. */
export function ToolGroup({ items }: { items: { key: string; data: any; result?: any }[] }) {
  const T = useT();
  const [open, setOpen] = useState(false);
  const failed = items.filter((i) => i.result?.is_error).length;
  return (
    <View style={{ gap: 6 }}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.groupHead}>
        <Check size={14} color={failed ? colors.error : colors.success} />
        <Text style={[type.mono, { color: colors.muted, flex: 1 }]}>
          {T('ranTools', { n: items.length })}{failed ? ` · ${T('nFailed', { n: failed })}` : ''}
        </Text>
        {open ? <ChevronDown /> : <Chevron size={14} />}
      </Pressable>
      {open && items.map((i) => <ToolCard key={i.key} id={i.data.id} tool={i.data.tool} input={i.data.input} result={i.result} />)}
    </View>
  );
}

export function ToolCard({ id, tool, input, result }: { id?: string; tool: string; input: any; result?: { output: string; is_error: boolean } }) {
  const T = useT();
  const [open, setOpen] = useState(false);
  // What the agent this call started is doing. It used to say this in the
  // conversation itself, in its own voice, which read as the assistant
  // answering something nobody asked.
  const act = useStore((s) => (id ? s.agentActivity[id] : undefined));
  const summary = toolSummary(tool, input);
  const isEdit = tool === 'Edit' && input?.old_string != null;
  const pending = !result;
  const counts = isEdit ? `+${String(input.new_string ?? '').split('\n').length} −${String(input.old_string ?? '').split('\n').length}` : null;
  return (
    <View style={styles.tool}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.toolHead}>
        {pending ? <Spinner /> : <Check size={14} color={result.is_error ? colors.error : colors.success} />}
        <Text style={[type.mono, { color: colors.muted }]}>{tool}</Text>
        <Text numberOfLines={1} style={[type.mono, { color: colors.text, flex: 1 }]}>{summary}</Text>
        {!!counts && <Text style={[type.monoSmall, { color: colors.muted }]}>{counts}</Text>}
        {open ? <ChevronDown /> : <Chevron size={14} />}
      </Pressable>
      {pending && act && (
        <View style={styles.agentLine}>
          <Text numberOfLines={1} style={[type.monoSmall, { color: colors.muted, flex: 1 }]}>
            {act.tool ? `${act.tool} · ` : ''}{act.text || ''}
          </Text>
          {act.tools > 0 && (
            <Text style={[type.monoSmall, { color: colors.faint }]}>{T('ranTools', { n: act.tools })}</Text>
          )}
        </View>
      )}
      {open && (
        <View style={styles.toolBody}>
          {isEdit ? (
            <>
              {String(input.old_string).split('\n').slice(0, 12).map((l: string, i: number) => (
                <Text key={'o' + i} style={[type.monoSmall, { fontSize: 12, lineHeight: 18, color: colors.muted }]}><Text style={{ color: colors.error }}>− </Text>{l}</Text>
              ))}
              {String(input.new_string).split('\n').slice(0, 12).map((l: string, i: number) => (
                <Text key={'n' + i} style={[type.monoSmall, { fontSize: 12, lineHeight: 18, color: colors.text }]}><Text style={{ color: colors.success }}>+ </Text>{l}</Text>
              ))}
            </>
          ) : (
            <Text style={[type.monoSmall, { fontSize: 12, lineHeight: 18, color: colors.muted }]} numberOfLines={12}>
              {JSON.stringify(input, null, 1).slice(0, 1500)}
            </Text>
          )}
          {result && (
            <Text style={[type.monoSmall, { fontSize: 12, lineHeight: 18, color: result.is_error ? colors.error : colors.text, marginTop: 8 }]} numberOfLines={20}>
              {result.output || T('empty')}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function DiffLines({ input }: { input: any }) {
  const oldS = input?.old_string != null ? String(input.old_string) : null;
  const newS = input?.new_string != null ? String(input.new_string) : input?.content != null ? String(input.content) : null;
  if (oldS == null && newS == null) return null;
  const line = (t: string, sign: '−' | '+', i: number) => (
    <Text key={sign + i} numberOfLines={1} style={[type.monoSmall, { fontSize: 12, lineHeight: 18, color: sign === '−' ? colors.muted : colors.text }]}>
      <Text style={{ color: sign === '−' ? colors.error : colors.success }}>{sign} </Text>{t}
    </Text>
  );
  return (
    <View style={{ marginTop: 8 }}>
      {oldS != null && oldS.split('\n').slice(0, 8).map((t, i) => line(t, '−', i))}
      {newS != null && newS.split('\n').slice(0, 8).map((t, i) => line(t, '+', i))}
    </View>
  );
}

export function ApprovalCard({ tool, input, preview, danger, decision, onDecide }: {
  tool: string; input?: any; preview: string; danger: boolean; decision: string | null;
  onDecide: (d: 'allow' | 'allow_session' | 'deny') => void;
}) {
  const T = useT();
  const resolved = !!decision;
  const decide = (d: 'allow' | 'allow_session' | 'deny') => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onDecide(d);
  };
  const label = decision === 'deny' ? T('denied') : decision === 'expired' ? T('expired') : decision === 'allow_session' ? T('allowedSession') : decision ? T('allowed') : null;
  return (
    <View style={[styles.approval, resolved && { borderColor: colors.border2 }]}>
      <View style={styles.approvalHead}>
        <Lock color={resolved ? colors.muted : colors.accent} />
        <Text style={[type.label, { color: resolved ? colors.muted : colors.accent }]}>{resolved ? label : danger ? T('danger') : T('pending')}</Text>
        <View style={{ flex: 1 }} />
        <Text style={[type.monoSmall, { color: colors.muted }]}>{tool}</Text>
      </View>
      <View style={styles.approvalCmd}>
        <Text style={[type.mono, { color: colors.text }]}>{preview}</Text>
        {(tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') && <DiffLines input={input} />}
      </View>
      {!resolved && (
        <>
          <View style={{ flexDirection: 'row', gap: 8, padding: 12, paddingBottom: 8 }}>
            <Pressable onPress={() => decide('deny')} style={[styles.apBtn, { borderWidth: 1, borderColor: colors.border2 }]}>
              <Text style={[type.sub, { color: colors.text, fontWeight: '500' }]}>{T('deny')}</Text>
            </Pressable>
            <Pressable onPress={() => decide('allow')} style={[styles.apBtn, { backgroundColor: colors.accent }]}>
              <Text style={[type.sub, { color: colors.white, fontWeight: '600' }]}>{T('allow')}</Text>
            </Pressable>
          </View>
          {!danger && (
            <Pressable onPress={() => decide('allow_session')} style={{ paddingBottom: 12, alignItems: 'center' }}>
              <Text style={[type.caption, { color: colors.muted }]}>{T('allowSession', { tool })}</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

export function TurnFooter({ cost, duration, error, usage, stopReason }: { cost?: number | null; duration?: number | null; error?: string; usage?: any; stopReason?: string | null }) {
  const T = useT();
  if (error) return <Text style={[type.caption, { color: colors.error }]}>{T('errorPrefix')}{error}</Text>;
  const parts = [];
  if (stopReason === 'interrupted') parts.push(T('stopped'));
  if (cost != null) parts.push(`$${cost.toFixed(3)}`);
  const tok = usage?.output_tokens ?? usage?.total_tokens;
  if (cost == null && tok) parts.push(`${tok >= 1000 ? (tok / 1000).toFixed(1) + 'k' : tok} tok`);
  if (duration != null) parts.push(`${Math.round(duration / 1000)}s`);
  if (!parts.length) return null;
  return <Text style={[type.monoSmall, { color: colors.faint }]}>{parts.join(' · ')}</Text>;
}

const styles = StyleSheet.create({
  assistant: { paddingRight: 24 },
  userBubble: { maxWidth: 290, backgroundColor: colors.userBubble, borderRadius: 18, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingHorizontal: 12,
               backgroundColor: colors.surface, borderRadius: radius.md },
  tool: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', marginRight: 24 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingHorizontal: 12 },
  toolBody: { borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  agentLine: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border, paddingHorizontal: 12, paddingVertical: 6 },
  approval: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.accent, overflow: 'hidden', marginRight: 24 },
  approvalHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 },
  approvalCmd: { marginHorizontal: 14, padding: 10, borderRadius: radius.sm, backgroundColor: colors.bg },
  apBtn: { flex: 1, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
});

/** Live activity row — the status line while a turn runs:
 *  a pulsing mark, elapsed time, tokens generated so far, open tool calls, phase. */
/** One quiet line while a turn runs: a pulsing mark, then elapsed · tokens ·
 *  open tools · what it is doing. Same weight as the turn footer, no container. */
export function WorkingRow({ phase, seconds, tokens, tools, hint }: {
  phase: string; seconds: number; tokens?: number; tools?: number; hint?: string;
}) {
  const T = useT();
  const secs = Math.max(0, Math.floor(seconds));
  const time = secs < 60
    ? `${secs}${T('unitSec')}`
    : `${Math.floor(secs / 60)}${T('unitMin')} ${secs % 60}${T('unitSec')}`;
  const parts = [time];
  if (tokens) parts.push(`${tokens >= 1000 ? (tokens / 1000).toFixed(1) + T('unitK') : tokens} ${T('unitTok')}`);
  if (tools) parts.push(`${tools} ${T('unitTool')}`);
  parts.push(phase);

  return (
    <View style={{ gap: 4, paddingRight: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <LiveMark size={14} />
        <Text numberOfLines={1} style={[type.caption, { color: colors.muted, letterSpacing: 0, flexShrink: 1 }]}>
          {parts.join(' · ')}
        </Text>
      </View>
      {!!hint && (
        <Text numberOfLines={2} style={[type.caption, { color: colors.faint, fontStyle: 'italic', letterSpacing: 0 }]}>
          {hint}
        </Text>
      )}
    </View>
  );
}

/** Thin banner shown above the timeline while the socket is down. */
export function ConnectionBanner({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      height: 28, marginHorizontal: 16, marginTop: 8, borderRadius: 8, backgroundColor: 'rgba(229,178,100,0.12)' }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.warning }} />
      <Text style={[type.caption, { color: colors.warning, letterSpacing: 0 }]}>{text}</Text>
    </View>
  );
}
