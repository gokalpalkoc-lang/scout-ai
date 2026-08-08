import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, Button, Card, Chip, Field, Header, Row, Text } from '../../src/components/ui';
import { WatchMode } from '../../src/lib/types';
import { errorMessage, hostOf, normalizeUrl, titleFromUrl } from '../../src/lib/util';
import { fetchPage } from '../../src/lib/web/fetchPage';
import { useApp } from '../../src/store/app';
import { useSettings } from '../../src/store/settings';
import { useTheme } from '../../src/theme';

const MODES: { value: WatchMode; label: string; blurb: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  {
    value: 'both',
    label: 'Events and changes',
    blurb: 'Extract events, and also tell me when the page itself changes meaningfully.',
    icon: 'layers-outline',
  },
  {
    value: 'events',
    label: 'Events only',
    blurb: 'Just pull dated items into my agenda. Cheapest option.',
    icon: 'calendar-outline',
  },
  {
    value: 'changes',
    label: 'Changes only',
    blurb: 'No event extraction — just tell me when something on the page is different.',
    icon: 'git-compare-outline',
  },
];

const INTERVALS = [
  { label: '1 hour', value: 60 },
  { label: '6 hours', value: 360 },
  { label: '12 hours', value: 720 },
  { label: 'Daily', value: 1440 },
  { label: 'Weekly', value: 10_080 },
];

const HINT_EXAMPLES = [
  'Only the concerts section',
  'Ignore anything already past',
  'Only free events',
  'Focus on application deadlines',
  'Only the seminars table',
];

export default function NewSourceScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ url?: string }>();

  const addSource = useApp((s) => s.addSource);
  const sources = useApp((s) => s.sources);
  const defaultInterval = useSettings((s) => s.defaultCheckIntervalMin);

  const [url, setUrl] = useState(params.url ?? '');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [category, setCategory] = useState('');
  const [hint, setHint] = useState('');
  const [mode, setMode] = useState<WatchMode>('both');
  const [interval, setInterval] = useState(defaultInterval);
  const [notifyOn, setNotifyOn] = useState(true);
  const [checkNow, setCheckNow] = useState(true);

  const [preview, setPreview] = useState<{ title: string; chars: number; empty: boolean; hasSchema: boolean } | null>(
    null,
  );
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Suggest a title from the domain until the user types their own.
  useEffect(() => {
    if (titleTouched) return;
    const normalized = normalizeUrl(url);
    setTitle(normalized ? titleFromUrl(normalized) : '');
  }, [url, titleTouched]);

  const existingCategories = [...new Set(sources.map((s) => s.category).filter(Boolean))] as string[];

  const runPreview = useCallback(async () => {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      Alert.alert('Check the address', 'Paste a full web address, for example example.com/events.');
      return;
    }
    setPreviewing(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const page = await fetchPage(normalized);
      setPreview({
        title: page.page.title || hostOf(normalized),
        chars: page.page.text.length,
        empty: page.page.looksEmpty,
        hasSchema: !!page.jsonLdSummary,
      });
      if (!titleTouched && page.page.title) {
        setTitle(page.page.title.slice(0, 60));
      }
    } catch (e) {
      setPreviewError(errorMessage(e));
    } finally {
      setPreviewing(false);
    }
  }, [url, titleTouched]);

  const save = useCallback(async () => {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      Alert.alert('Check the address', 'Paste a full web address, for example example.com/events.');
      return;
    }
    if (sources.some((s) => s.url === normalized)) {
      Alert.alert('Already watching', 'That page is already on your watchlist.');
      return;
    }

    setSaving(true);
    try {
      await addSource(
        {
          url: normalized,
          title: title.trim() || titleFromUrl(normalized),
          category: category.trim() || null,
          mode,
          hint: hint.trim() || null,
          intervalMin: interval,
          enabled: true,
          notify: notifyOn,
        },
        checkNow,
      );
      router.back();
    } catch (e) {
      Alert.alert('Could not save', errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [url, title, category, mode, hint, interval, notifyOn, checkNow, addSource, sources]);

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header title="Watch a page" onBack={() => router.back()} />

      <ScrollView
        contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: insets.bottom + 110, gap: t.spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {/* ------------------------------------------------------------ address */}
        <View style={{ gap: t.spacing.md }}>
          <Field
            label="Web address"
            value={url}
            onChangeText={setUrl}
            placeholder="example.com/events"
            icon="link-outline"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            right={
              <Pressable
                onPress={async () => setUrl((await Clipboard.getStringAsync()).trim())}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Paste address"
              >
                <Ionicons name="clipboard-outline" size={17} color={t.color.textMuted} />
              </Pressable>
            }
          />

          <Row gap={t.spacing.sm}>
            <Button
              title={previewing ? 'Reading…' : 'Test this page'}
              icon="flask-outline"
              variant="secondary"
              size="sm"
              loading={previewing}
              disabled={!url.trim()}
              onPress={() => void runPreview()}
            />
          </Row>

          {previewError ? (
            <Card>
              <Row gap={t.spacing.sm} align="flex-start">
                <Ionicons name="alert-circle" size={17} color={t.color.danger} />
                <View style={{ flex: 1 }}>
                  <Text variant="label" tone="danger">
                    Could not read that page
                  </Text>
                  <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    {previewError}
                  </Text>
                </View>
              </Row>
            </Card>
          ) : null}

          {preview ? (
            <Card accent={preview.empty ? t.color.warning : t.color.success}>
              <Row gap={t.spacing.sm} align="flex-start">
                <Ionicons
                  name={preview.empty ? 'warning-outline' : 'checkmark-circle'}
                  size={17}
                  color={preview.empty ? t.color.warning : t.color.success}
                />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text variant="bodyStrong" numberOfLines={2}>
                    {preview.title}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {preview.empty
                      ? 'Almost no readable text. This page probably renders with JavaScript, so extraction may find nothing.'
                      : `${preview.chars.toLocaleString()} characters of readable text.`}
                  </Text>
                  {preview.hasSchema ? (
                    <Badge label="Publishes structured event data" tone="success" icon="ribbon-outline" />
                  ) : null}
                </View>
              </Row>
            </Card>
          ) : null}
        </View>

        {/* --------------------------------------------------------------- name */}
        <View style={{ gap: t.spacing.md }}>
          <Field
            label="Name"
            value={title}
            onChangeText={(v) => {
              setTitle(v);
              setTitleTouched(true);
            }}
            placeholder="Salon IKSV"
            icon="pricetag-outline"
          />

          <View style={{ gap: t.spacing.sm }}>
            <Field
              label="Group (optional)"
              value={category}
              onChangeText={setCategory}
              placeholder="music, work, university…"
              icon="folder-outline"
              autoCapitalize="none"
            />
            {existingCategories.length ? (
              <Row gap={t.spacing.sm} wrap>
                {existingCategories.map((c) => (
                  <Chip key={c} label={c} selected={category === c} onPress={() => setCategory(c)} />
                ))}
              </Row>
            ) : null}
          </View>
        </View>

        {/* --------------------------------------------------------------- mode */}
        <View style={{ gap: t.spacing.sm }}>
          <Text variant="label" tone="secondary">
            What to watch for
          </Text>
          {MODES.map((m) => (
            <Pressable
              key={m.value}
              onPress={() => setMode(m.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: mode === m.value }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                gap: t.spacing.md,
                padding: t.spacing.md,
                borderRadius: t.radius.md,
                borderWidth: 1,
                borderColor: mode === m.value ? t.color.primary : t.color.border,
                backgroundColor:
                  mode === m.value ? t.color.primarySoft : pressed ? t.color.surfaceAlt : t.color.surface,
              })}
            >
              <Ionicons
                name={mode === m.value ? 'radio-button-on' : 'radio-button-off'}
                size={19}
                color={mode === m.value ? t.color.primary : t.color.textMuted}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="bodyStrong">{m.label}</Text>
                <Text variant="caption" tone="muted">
                  {m.blurb}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>

        {/* --------------------------------------------------------------- hint */}
        <View style={{ gap: t.spacing.sm }}>
          <Field
            label="Extraction hint (optional)"
            value={hint}
            onChangeText={setHint}
            placeholder="Only the concerts section"
            icon="bulb-outline"
            multiline
            hint="Passed to Gemini with the page. The single most effective way to improve results on a messy site."
          />
          <Row gap={t.spacing.sm} wrap>
            {HINT_EXAMPLES.map((h) => (
              <Chip key={h} label={h} selected={hint === h} onPress={() => setHint(hint === h ? '' : h)} />
            ))}
          </Row>
        </View>

        {/* ----------------------------------------------------------- schedule */}
        <View style={{ gap: t.spacing.sm }}>
          <Text variant="label" tone="secondary">
            How often to check
          </Text>
          <Row gap={t.spacing.sm} wrap>
            {INTERVALS.map((i) => (
              <Chip
                key={i.value}
                label={i.label}
                selected={interval === i.value}
                onPress={() => setInterval(i.value)}
              />
            ))}
          </Row>
          <Text variant="caption" tone="muted">
            Each check costs one Gemini call, and only when the page has actually changed.
          </Text>
        </View>

        {/* -------------------------------------------------------------- flags */}
        <Card padded={false}>
          <View style={{ padding: t.spacing.lg, gap: t.spacing.lg }}>
            <Row justify="space-between">
              <View style={{ flex: 1, paddingRight: t.spacing.md }}>
                <Text variant="body">Notify me about this page</Text>
                <Text variant="caption" tone="muted">
                  Turn off for a busy page you would rather check yourself.
                </Text>
              </View>
              <Switch
                value={notifyOn}
                onValueChange={setNotifyOn}
                trackColor={{ false: t.color.surfacePressed, true: t.color.primarySoft }}
                thumbColor={notifyOn ? t.color.primary : t.color.textMuted}
                accessibilityLabel="Notify me about this page"
              />
            </Row>
            <Row justify="space-between">
              <View style={{ flex: 1, paddingRight: t.spacing.md }}>
                <Text variant="body">Check straight away</Text>
                <Text variant="caption" tone="muted">
                  Runs the first extraction as soon as you save.
                </Text>
              </View>
              <Switch
                value={checkNow}
                onValueChange={setCheckNow}
                trackColor={{ false: t.color.surfacePressed, true: t.color.primarySoft }}
                thumbColor={checkNow ? t.color.primary : t.color.textMuted}
                accessibilityLabel="Check straight away"
              />
            </Row>
          </View>
        </Card>
      </ScrollView>

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: t.spacing.lg,
          paddingBottom: insets.bottom + t.spacing.lg,
          backgroundColor: t.color.surface,
          borderTopWidth: 1,
          borderTopColor: t.color.border,
        }}
      >
        <Button
          title="Start watching"
          icon="eye"
          size="lg"
          fullWidth
          loading={saving}
          disabled={!url.trim()}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
