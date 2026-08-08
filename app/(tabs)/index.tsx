import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Markdown } from '../../src/components/Markdown';
import { Badge, EmptyState, Header, IconButton, Row, Text } from '../../src/components/ui';
import { ChatMessage, ToolTrailEntry } from '../../src/lib/types';
import { PROVIDER_LABELS } from '../../src/lib/ai/contract';
import { useApp } from '../../src/store/app';
import { useChat } from '../../src/store/chat';
import { useSettings } from '../../src/store/settings';
import { useTheme } from '../../src/theme';

/** Human labels for the tool names the model calls. */
const TOOL_LABELS: Record<string, string> = {
  list_watched_sites: 'Reading your watchlist',
  add_watched_site: 'Adding a site to watch',
  update_watched_site: 'Updating a watched site',
  remove_watched_site: 'Removing a watched site',
  check_site_now: 'Checking sites now',
  scan_url_for_events: 'Scanning the page for events',
  read_url: 'Reading the page',
  search_events: 'Searching your events',
  save_event: 'Saving an event',
  update_event: 'Updating an event',
  add_event_to_calendar: 'Adding to your calendar',
  remind_me: 'Setting a reminder',
  list_routines: 'Reading your routines',
  create_routine: 'Creating a routine',
  delete_routine: 'Deleting a routine',
  get_overview: 'Taking stock',
  get_site_history: 'Reading check history',
  list_rules: 'Reading your rules',
  create_rule: 'Writing an automation',
  update_rule: 'Updating a rule',
  delete_rule: 'Deleting a rule',
  list_modules: 'Reading your panels',
  create_module: 'Building a panel',
  revise_module: 'Rewriting a panel',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, ' ');
}

function ToolTrail({ entries }: { entries: ToolTrailEntry[] }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;

  const failed = entries.filter((e) => !e.ok).length;

  return (
    <View style={{ marginTop: t.spacing.sm }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide what Scout did' : 'Show what Scout did'}
      >
        <Row gap={6}>
          <Ionicons
            name={open ? 'chevron-down' : 'chevron-forward'}
            size={13}
            color={t.color.textMuted}
          />
          <Text variant="caption" tone={failed ? 'warning' : 'muted'}>
            {entries.length} action{entries.length === 1 ? '' : 's'}
            {failed ? ` · ${failed} failed` : ''}
          </Text>
        </Row>
      </Pressable>

      {open ? (
        <View
          style={{
            marginTop: t.spacing.sm,
            gap: 6,
            borderLeftWidth: 2,
            borderLeftColor: t.color.border,
            paddingLeft: t.spacing.md,
          }}
        >
          {entries.map((entry, i) => (
            <Row key={i} gap={6} align="flex-start">
              <Ionicons
                name={entry.ok ? 'checkmark-circle' : 'close-circle'}
                size={13}
                color={entry.ok ? t.color.success : t.color.danger}
                style={{ marginTop: 2 }}
              />
              <View style={{ flex: 1 }}>
                <Text variant="caption" tone="secondary">
                  {toolLabel(entry.name)}
                </Text>
                <Text variant="caption" tone="muted">
                  {entry.summary}
                </Text>
              </View>
            </Row>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Bubble({ message, onRetry }: { message: ChatMessage; onRetry?: () => void }) {
  const t = useTheme();
  const isUser = message.role === 'user';

  const copy = useCallback(() => {
    Clipboard.setStringAsync(message.text).then(() =>
      Alert.alert('Copied', 'The message is on your clipboard.'),
    );
  }, [message.text]);

  if (isUser) {
    return (
      <View style={{ alignItems: 'flex-end', paddingHorizontal: t.spacing.lg, marginBottom: t.spacing.md }}>
        <View
          style={{
            maxWidth: '88%',
            backgroundColor: t.color.primary,
            borderRadius: t.radius.lg,
            borderBottomRightRadius: 6,
            paddingHorizontal: t.spacing.lg,
            paddingVertical: t.spacing.md,
          }}
        >
          <Text variant="body" style={{ color: t.color.onPrimary }}>
            {message.text}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: t.spacing.lg, marginBottom: t.spacing.md }}>
      <Pressable onLongPress={copy} accessibilityRole="button" accessibilityLabel="Assistant message. Long press to copy.">
        <View
          style={{
            backgroundColor: message.error ? t.color.dangerSoft : t.color.surface,
            borderRadius: t.radius.lg,
            borderWidth: 1,
            borderColor: message.error ? t.color.danger : t.color.border,
            padding: t.spacing.lg,
          }}
        >
          {message.error ? (
            <Row gap={6} style={{ marginBottom: t.spacing.sm }}>
              <Ionicons name="alert-circle-outline" size={15} color={t.color.danger} />
              <Text variant="label" tone="danger">
                Something went wrong
              </Text>
            </Row>
          ) : null}

          <Markdown content={message.text} />
          {message.toolTrail ? <ToolTrail entries={message.toolTrail} /> : null}

          {message.grounding?.length ? (
            <View style={{ marginTop: t.spacing.md, gap: 4 }}>
              <Text variant="caption" tone="muted">
                Sources
              </Text>
              {message.grounding.map((g, i) => (
                <Text key={i} variant="caption" tone="primary" numberOfLines={1}>
                  {g.title || g.uri}
                </Text>
              ))}
            </View>
          ) : null}

          {message.error && onRetry ? (
            <Pressable onPress={onRetry} style={{ marginTop: t.spacing.md }} accessibilityRole="button">
              <Row gap={6}>
                <Ionicons name="refresh" size={14} color={t.color.primary} />
                <Text variant="label" tone="primary">
                  Try again
                </Text>
              </Row>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

function StreamingBubble({ draft, runningTool, tools }: { draft: string; runningTool: string | null; tools: ToolTrailEntry[] }) {
  const t = useTheme();

  return (
    <View style={{ paddingHorizontal: t.spacing.lg, marginBottom: t.spacing.md }}>
      <View
        style={{
          backgroundColor: t.color.surface,
          borderRadius: t.radius.lg,
          borderWidth: 1,
          borderColor: t.color.border,
          padding: t.spacing.lg,
          gap: t.spacing.sm,
        }}
      >
        {draft ? <Markdown content={draft} /> : null}

        {runningTool ? (
          <Row gap={t.spacing.sm}>
            <ActivityIndicator size="small" color={t.color.primary} />
            <Text variant="caption" tone="secondary">
              {toolLabel(runningTool)}…
            </Text>
          </Row>
        ) : !draft ? (
          <Row gap={t.spacing.sm}>
            <ActivityIndicator size="small" color={t.color.primary} />
            <Text variant="caption" tone="muted">
              Thinking…
            </Text>
          </Row>
        ) : null}

        {tools.length ? <ToolTrail entries={tools} /> : null}
      </View>
    </View>
  );
}

const SUGGESTIONS = [
  { icon: 'eye-outline' as const, text: 'Watch a website for events', prompt: '' },
  {
    icon: 'search-outline' as const,
    text: "What's coming up this week?",
    prompt: "What's coming up in the next seven days?",
  },
  {
    icon: 'refresh-outline' as const,
    text: 'Check all my sites now',
    prompt: 'Check all my watched sites now and tell me what changed.',
  },
  {
    icon: 'alarm-outline' as const,
    text: 'Deadlines I should know about',
    prompt: 'Which deadlines are closing soon? Sort by how urgent they are.',
  },
  {
    icon: 'construct-outline' as const,
    text: 'Build me a panel for the app',
    prompt:
      'Build me a panel that shows which of my watched sites produce the most events, as a bar chart, tallest first.',
  },
  {
    icon: 'git-branch-outline' as const,
    text: 'Automate something',
    prompt: 'Create a rule that stars anything free and reminds me a week before any deadline.',
  },
];

export default function AssistantScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const { messages, draft, activeTools, runningTool, sending, load, send, cancel, retryLast, clear } =
    useChat();
  const sources = useApp((s) => s.sources);
  const provider = useSettings((s) => s.assistantProvider);
  const chatModel = useSettings((s) => s.chatModel);
  const claudeModel = useSettings((s) => s.claudeModel);
  const activeModel = provider === 'claude' ? claudeModel : chatModel;
  const hasOnboarded = useSettings((s) => s.hasOnboarded);

  const [input, setInput] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the newest turn in view as text streams in.
  useEffect(() => {
    if (!messages.length && !draft) return;
    const id = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(id);
  }, [messages.length, draft, runningTool]);

  const submit = useCallback(
    (text?: string) => {
      const value = (text ?? input).trim();
      if (!value || sending) return;
      setInput('');
      void send(value);
    },
    [input, sending, send],
  );

  const confirmClear = useCallback(() => {
    if (!messages.length) return;
    Alert.alert('Clear conversation?', 'The messages are deleted from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => void clear() },
    ]);
  }, [messages.length, clear]);

  const lastIsError = messages[messages.length - 1]?.error;

  const empty = useMemo(
    () => (
      <View style={{ paddingTop: t.spacing.xl }}>
        <EmptyState
          icon="sparkles-outline"
          title="Ask Scout anything"
          message={
            sources.length
              ? 'Scout can check your watched sites, pull events out of a page, set reminders and answer general questions.'
              : 'Start by giving Scout a website to watch, then ask it what is coming up.'
          }
        />
        <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.sm }}>
          {SUGGESTIONS.map((s) => (
            <Pressable
              key={s.text}
              onPress={() => (s.prompt ? submit(s.prompt) : router.push('/source/new'))}
              accessibilityRole="button"
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: t.spacing.md,
                padding: t.spacing.md,
                borderRadius: t.radius.md,
                borderWidth: 1,
                borderColor: t.color.border,
                backgroundColor: pressed ? t.color.surfaceAlt : t.color.surface,
              })}
            >
              <Ionicons name={s.icon} size={18} color={t.color.primary} />
              <Text variant="body" style={{ flex: 1 }}>
                {s.text}
              </Text>
              <Ionicons name="arrow-forward" size={15} color={t.color.textMuted} />
            </Pressable>
          ))}
        </View>
      </View>
    ),
    [sources.length, submit, t],
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header
        title="Scout"
        subtitle={`${PROVIDER_LABELS[provider]} · ${activeModel}`}
        right={
          <Row gap={0}>
            {messages.length ? (
              <IconButton icon="trash-outline" accessibilityLabel="Clear conversation" onPress={confirmClear} />
            ) : null}
            <IconButton
              icon="add-circle-outline"
              accessibilityLabel="Add a site to watch"
              onPress={() => router.push('/source/new')}
            />
          </Row>
        }
      />

      {!hasOnboarded ? null : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        >
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item, index }) => (
              <Bubble
                message={item}
                onRetry={index === messages.length - 1 && item.error ? () => void retryLast() : undefined}
              />
            )}
            ListEmptyComponent={messages.length ? null : empty}
            ListFooterComponent={
              sending ? (
                <StreamingBubble draft={draft} runningTool={runningTool} tools={activeTools} />
              ) : null
            }
            contentContainerStyle={{ paddingTop: t.spacing.sm, paddingBottom: t.spacing.md }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => {
              if (sending) listRef.current?.scrollToEnd({ animated: true });
            }}
          />

          {/* Composer */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: t.spacing.sm,
              paddingHorizontal: t.spacing.lg,
              paddingTop: t.spacing.sm,
              paddingBottom: t.spacing.sm,
              borderTopWidth: 1,
              borderTopColor: t.color.border,
              backgroundColor: t.color.surface,
            }}
          >
            <View
              style={{
                flex: 1,
                backgroundColor: t.color.surfaceAlt,
                borderRadius: t.radius.xl,
                borderWidth: 1,
                borderColor: t.color.border,
                paddingHorizontal: t.spacing.lg,
                paddingVertical: Platform.OS === 'ios' ? 10 : 4,
                maxHeight: 130,
              }}
            >
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder="Ask, or paste a link to watch…"
                placeholderTextColor={t.color.textMuted}
                multiline
                editable={!sending}
                onSubmitEditing={() => submit()}
                blurOnSubmit={false}
                accessibilityLabel="Message Scout"
                style={{
                  color: t.color.text,
                  fontSize: t.fontSize.base,
                  maxHeight: 110,
                  paddingVertical: Platform.OS === 'android' ? 8 : 0,
                }}
              />
            </View>

            <Pressable
              onPress={() => (sending ? cancel() : submit())}
              disabled={!sending && !input.trim()}
              accessibilityRole="button"
              accessibilityLabel={sending ? 'Stop generating' : 'Send message'}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: sending
                  ? t.color.dangerSoft
                  : input.trim()
                    ? pressed
                      ? t.color.primaryPressed
                      : t.color.primary
                    : t.color.surfaceAlt,
              })}
            >
              <Ionicons
                name={sending ? 'stop' : 'arrow-up'}
                size={20}
                color={sending ? t.color.danger : input.trim() ? t.color.onPrimary : t.color.textMuted}
              />
            </Pressable>
          </View>

          {lastIsError ? (
            <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.sm }}>
              <Badge label="Check Settings → Gemini access if this keeps happening" tone="warning" />
            </View>
          ) : null}
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
