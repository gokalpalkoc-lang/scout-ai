import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Chip, Field, Header, Row, Text } from '../../src/components/ui';
import { RoutineKind, ScheduleKind } from '../../src/lib/types';
import { errorMessage } from '../../src/lib/util';
import { WEEKDAY_LABELS, formatClock } from '../../src/lib/util/date';
import { useApp } from '../../src/store/app';
import { useTheme } from '../../src/theme';

const KINDS: {
  value: RoutineKind;
  label: string;
  blurb: string;
  icon: keyof typeof Ionicons.glyphMap;
  needsPrompt: boolean;
}[] = [
  {
    value: 'check_all',
    label: 'Check every site',
    blurb: 'Re-reads the whole watchlist and notifies you about anything new.',
    icon: 'refresh-circle-outline',
    needsPrompt: false,
  },
  {
    value: 'digest',
    label: 'Briefing',
    blurb: 'A written summary of what is coming up and which deadlines are closing.',
    icon: 'newspaper-outline',
    needsPrompt: false,
  },
  {
    value: 'prompt',
    label: 'Custom instruction',
    blurb: 'Runs an instruction you write, with your events and sites as context.',
    icon: 'sparkles-outline',
    needsPrompt: true,
  },
];

const PROMPT_EXAMPLES = [
  'List anything free happening this weekend, cheapest first.',
  'Which deadlines close in the next ten days? Be blunt about what I should do today.',
  'Summarise what changed on my watched sites since yesterday.',
  'Pick the three events I would most likely want, and say why.',
];

const INTERVALS = [
  { label: 'Every 30 min', value: 30 },
  { label: 'Hourly', value: 60 },
  { label: 'Every 6h', value: 360 },
  { label: 'Every 12h', value: 720 },
];

export default function RoutineEditorScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string; kind?: string }>();

  const routines = useApp((s) => s.routines);
  const addRoutine = useApp((s) => s.addRoutine);
  const editRoutine = useApp((s) => s.editRoutine);

  const existing = useMemo(
    () => (params.id ? routines.find((r) => r.id === params.id) : undefined),
    [params.id, routines],
  );

  const [name, setName] = useState('');
  const [kind, setKind] = useState<RoutineKind>(
    (params.kind as RoutineKind) && KINDS.some((k) => k.value === params.kind)
      ? (params.kind as RoutineKind)
      : 'digest',
  );
  const [prompt, setPrompt] = useState('');
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>('daily');
  const [hour, setHour] = useState(8);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(2);
  const [intervalMin, setIntervalMin] = useState(720);
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);

  // Load an existing routine into the form.
  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setNameTouched(true);
    setKind(existing.kind);
    setPrompt(existing.prompt ?? '');
    setScheduleKind(existing.scheduleKind);
    setHour(existing.hour);
    setMinute(existing.minute);
    setWeekday(existing.weekday);
    setIntervalMin(existing.intervalMin);
  }, [existing?.id]);

  // Suggest a name from the chosen kind until the user types one.
  useEffect(() => {
    if (nameTouched) return;
    const meta = KINDS.find((k) => k.value === kind);
    setName(kind === 'digest' ? 'Morning briefing' : (meta?.label ?? ''));
  }, [kind, nameTouched]);

  const needsPrompt = KINDS.find((k) => k.value === kind)?.needsPrompt ?? false;

  const save = useCallback(async () => {
    if (!name.trim()) {
      Alert.alert('Name it first', 'Give the routine a short name so you can recognise it.');
      return;
    }
    if (needsPrompt && !prompt.trim()) {
      Alert.alert('Add an instruction', 'A custom routine needs something to do.');
      return;
    }

    setSaving(true);
    try {
      const draft = {
        name: name.trim(),
        kind,
        prompt: needsPrompt ? prompt.trim() : null,
        scheduleKind,
        hour,
        minute,
        weekday,
        intervalMin,
        enabled: true,
      };

      if (existing) await editRoutine(existing.id, draft);
      else await addRoutine(draft);
      router.back();
    } catch (e) {
      Alert.alert('Could not save', errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [
    name,
    kind,
    prompt,
    needsPrompt,
    scheduleKind,
    hour,
    minute,
    weekday,
    intervalMin,
    existing,
    addRoutine,
    editRoutine,
  ]);

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header title={existing ? 'Edit routine' : 'New routine'} onBack={() => router.back()} />

      <ScrollView
        contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: insets.bottom + 110, gap: t.spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {/* --------------------------------------------------------------- kind */}
        <View style={{ gap: t.spacing.sm }}>
          <Text variant="label" tone="secondary">
            What should it do
          </Text>
          {KINDS.map((k) => (
            <Pressable
              key={k.value}
              onPress={() => setKind(k.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: kind === k.value }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                gap: t.spacing.md,
                padding: t.spacing.md,
                borderRadius: t.radius.md,
                borderWidth: 1,
                borderColor: kind === k.value ? t.color.primary : t.color.border,
                backgroundColor:
                  kind === k.value ? t.color.primarySoft : pressed ? t.color.surfaceAlt : t.color.surface,
              })}
            >
              <Ionicons
                name={kind === k.value ? 'radio-button-on' : 'radio-button-off'}
                size={19}
                color={kind === k.value ? t.color.primary : t.color.textMuted}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="bodyStrong">{k.label}</Text>
                <Text variant="caption" tone="muted">
                  {k.blurb}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>

        {/* --------------------------------------------------------------- name */}
        <Field
          label="Name"
          value={name}
          onChangeText={(v) => {
            setName(v);
            setNameTouched(true);
          }}
          placeholder="Morning briefing"
          icon="pricetag-outline"
        />

        {/* ------------------------------------------------------------- prompt */}
        {needsPrompt ? (
          <View style={{ gap: t.spacing.sm }}>
            <Field
              label="Instruction"
              value={prompt}
              onChangeText={setPrompt}
              placeholder="List anything free happening this weekend."
              icon="sparkles-outline"
              multiline
              hint="Your upcoming events, deadlines and watched sites are supplied as context automatically."
            />
            <Text variant="caption" tone="muted">
              Examples
            </Text>
            <View style={{ gap: t.spacing.sm }}>
              {PROMPT_EXAMPLES.map((example) => (
                <Pressable
                  key={example}
                  onPress={() => setPrompt(example)}
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    padding: t.spacing.md,
                    borderRadius: t.radius.sm,
                    borderWidth: 1,
                    borderColor: t.color.border,
                    backgroundColor: pressed ? t.color.surfaceAlt : t.color.surface,
                  })}
                >
                  <Text variant="caption" tone="secondary">
                    {example}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {/* ----------------------------------------------------------- schedule */}
        <View style={{ gap: t.spacing.md }}>
          <Text variant="label" tone="secondary">
            When
          </Text>
          <Row gap={t.spacing.sm} wrap>
            {(['daily', 'weekly', 'interval'] as ScheduleKind[]).map((s) => (
              <Chip
                key={s}
                label={s === 'daily' ? 'Every day' : s === 'weekly' ? 'Once a week' : 'On an interval'}
                selected={scheduleKind === s}
                onPress={() => setScheduleKind(s)}
              />
            ))}
          </Row>

          {scheduleKind === 'interval' ? (
            <>
              <Row gap={t.spacing.sm} wrap>
                {INTERVALS.map((i) => (
                  <Chip
                    key={i.value}
                    label={i.label}
                    selected={intervalMin === i.value}
                    onPress={() => setIntervalMin(i.value)}
                  />
                ))}
              </Row>
              <Card>
                <Row gap={t.spacing.sm} align="flex-start">
                  <Ionicons name="information-circle-outline" size={15} color={t.color.warning} />
                  <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                    Interval routines run when Scout next wakes up or when you open the app — not
                    exactly on the interval. For something time-critical, use a daily or weekly
                    schedule, which arrives as a notification.
                  </Text>
                </Row>
              </Card>
            </>
          ) : (
            <>
              {scheduleKind === 'weekly' ? (
                <Row gap={6} wrap>
                  {WEEKDAY_LABELS.map((label, index) => (
                    <Chip
                      key={label}
                      label={label}
                      selected={weekday === index + 1}
                      onPress={() => setWeekday(index + 1)}
                    />
                  ))}
                </Row>
              ) : null}

              <Pressable
                onPress={() => setShowPicker(true)}
                accessibilityRole="button"
                accessibilityLabel={`Change time, currently ${formatClock(hour, minute)}`}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: t.spacing.md,
                  padding: t.spacing.lg,
                  borderRadius: t.radius.md,
                  borderWidth: 1,
                  borderColor: t.color.border,
                  backgroundColor: pressed ? t.color.surfaceAlt : t.color.surface,
                })}
              >
                <Ionicons name="time-outline" size={20} color={t.color.primary} />
                <View style={{ flex: 1 }}>
                  <Text variant="caption" tone="muted">
                    Time
                  </Text>
                  <Text variant="heading">{formatClock(hour, minute)}</Text>
                </View>
                <Ionicons name="chevron-forward" size={17} color={t.color.textMuted} />
              </Pressable>

              {showPicker ? (
                <DateTimePicker
                  value={new Date(2026, 0, 1, hour, minute)}
                  mode="time"
                  is24Hour
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  onChange={(_event, date) => {
                    if (Platform.OS === 'android') setShowPicker(false);
                    if (date) {
                      setHour(date.getHours());
                      setMinute(date.getMinutes());
                    }
                  }}
                />
              ) : null}
              {showPicker && Platform.OS === 'ios' ? (
                <Button title="Done" variant="secondary" onPress={() => setShowPicker(false)} />
              ) : null}

              <Card>
                <Row gap={t.spacing.sm} align="flex-start">
                  <Ionicons name="notifications-outline" size={15} color={t.color.primary} />
                  <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                    At {formatClock(hour, minute)}
                    {scheduleKind === 'weekly' ? ` on ${WEEKDAY_LABELS[(weekday - 1) % 7]}` : ' every day'}, a
                    notification arrives. Tapping it runs the routine — that is how a phone app gets
                    reliable timing without draining the battery.
                  </Text>
                </Row>
              </Card>
            </>
          )}
        </View>
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
          title={existing ? 'Save changes' : 'Create routine'}
          icon="checkmark"
          size="lg"
          fullWidth
          loading={saving}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
