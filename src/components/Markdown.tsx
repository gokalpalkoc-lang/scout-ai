import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { View } from 'react-native';

import { useTheme } from '../theme';
import { Text } from './ui/Text';

/**
 * Small markdown renderer for assistant replies.
 *
 * A full markdown library would pull in a parser and an HTML pipeline for what
 * the model actually emits: bullets, bold, inline code, links and short
 * headings. This covers exactly that, renders as native Text, and cannot break
 * the layout with unexpected block elements.
 */

type Block =
  | { kind: 'para'; text: string }
  | { kind: 'bullet'; text: string; ordered: boolean; marker: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

function parseBlocks(input: string): Block[] {
  const blocks: Block[] = [];
  const lines = input.replace(/\r/g, '').split('\n');
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'para', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^```/.test(line.trim())) {
      if (code) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else {
        flushParagraph();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    if (/^(---+|\*\*\*+|___+)$/.test(line.trim())) {
      flushParagraph();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', text: heading[2].trim(), level: heading[1].length });
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: 'bullet', text: bullet[1].trim(), ordered: false, marker: '•' });
      continue;
    }

    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      blocks.push({
        kind: 'bullet',
        text: ordered[2].trim(),
        ordered: true,
        marker: `${ordered[1]}.`,
      });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  if (code) blocks.push({ kind: 'code', text: code.join('\n') });
  return blocks;
}

type Span =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/** Splits inline markdown in one pass so nesting cannot be mis-ordered. */
function parseSpans(input: string): Span[] {
  const spans: Span[] = [];
  // Order matters: bold before italic, links before bare URLs. No lookbehind —
  // Hermes does not support it.
  const pattern =
    /(\*\*|__)(.+?)\1|(\*|_)([^\s*_][^*_]*)\3|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)/g;

  let cursor = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(input)) !== null) {
    if (m.index > cursor) spans.push({ kind: 'text', text: input.slice(cursor, m.index) });

    if (m[2] !== undefined) spans.push({ kind: 'bold', text: m[2] });
    else if (m[4] !== undefined) spans.push({ kind: 'italic', text: m[4] });
    else if (m[5] !== undefined) spans.push({ kind: 'code', text: m[5] });
    else if (m[6] !== undefined && m[7] !== undefined)
      spans.push({ kind: 'link', text: m[6], href: m[7] });
    else if (m[8] !== undefined) spans.push({ kind: 'link', text: m[8], href: m[8] });

    cursor = m.index + m[0].length;
  }
  if (cursor < input.length) spans.push({ kind: 'text', text: input.slice(cursor) });
  return spans;
}

function openLink(href: string) {
  WebBrowser.openBrowserAsync(href).catch(() => {});
}

function Inline({ text, tone }: { text: string; tone?: 'default' | 'inverse' }) {
  const t = useTheme();
  const spans = parseSpans(text);
  const base = tone === 'inverse' ? t.color.onPrimary : t.color.text;

  return (
    <Text variant="body" style={{ color: base }}>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'bold':
            return (
              <Text key={i} variant="body" style={{ fontWeight: '700', color: base }}>
                {span.text}
              </Text>
            );
          case 'italic':
            return (
              <Text key={i} variant="body" style={{ fontStyle: 'italic', color: base }}>
                {span.text}
              </Text>
            );
          case 'code':
            return (
              <Text
                key={i}
                style={{
                  fontFamily: 'monospace',
                  fontSize: t.fontSize.sm,
                  color: t.color.accent,
                  backgroundColor: t.color.accentSoft,
                }}
              >
                {` ${span.text} `}
              </Text>
            );
          case 'link':
            return (
              <Text
                key={i}
                variant="body"
                onPress={() => openLink(span.href)}
                style={{ color: t.color.primary, textDecorationLine: 'underline' }}
              >
                {span.text}
              </Text>
            );
          default:
            return (
              <Text key={i} variant="body" style={{ color: base }}>
                {span.text}
              </Text>
            );
        }
      })}
    </Text>
  );
}

export function Markdown({
  content,
  tone = 'default',
}: {
  content: string;
  tone?: 'default' | 'inverse';
}) {
  const t = useTheme();
  const blocks = parseBlocks(content);

  return (
    <View style={{ gap: t.spacing.sm }}>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading':
            return (
              <Text
                key={i}
                variant={block.level <= 2 ? 'subheading' : 'bodyStrong'}
                style={{ marginTop: i === 0 ? 0 : t.spacing.xs }}
              >
                {block.text}
              </Text>
            );
          case 'bullet':
            return (
              <View key={i} style={{ flexDirection: 'row', gap: t.spacing.sm }}>
                <Text
                  variant="body"
                  style={{
                    color: tone === 'inverse' ? t.color.onPrimary : t.color.textMuted,
                    minWidth: block.ordered ? 18 : 10,
                  }}
                >
                  {block.marker}
                </Text>
                <View style={{ flex: 1 }}>
                  <Inline text={block.text} tone={tone} />
                </View>
              </View>
            );
          case 'code':
            return (
              <View
                key={i}
                style={{
                  backgroundColor: t.color.surfaceAlt,
                  borderRadius: t.radius.sm,
                  borderWidth: 1,
                  borderColor: t.color.border,
                  padding: t.spacing.md,
                }}
              >
                <Text variant="mono" tone="secondary">
                  {block.text}
                </Text>
              </View>
            );
          case 'rule':
            return <View key={i} style={{ height: 1, backgroundColor: t.color.border }} />;
          default:
            return <Inline key={i} text={block.text} tone={tone} />;
        }
      })}
    </View>
  );
}
