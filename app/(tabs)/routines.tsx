import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Header,
  IconButton,
  Row,
  SectionHeader,
  Text,
} from '../../src/components/ui';
import { moduleSummary } from '../../src/lib/modules/generate';
import { Module } from '../../src/lib/modules/types';
import { Rule, describeRule } from '../../src/lib/rules/types';
import { Routine, RoutineKind } from '../../src/lib/types';
import { truncate } from '../../src/lib/util';
import { WEEKDAY_LABELS, formatClock, relative } from '../../src/lib/util/date';
import { useApp } from '../../src/store/app';
import { useTheme } from '../../src/theme';

/**
 * Studio — everything the app does on its own, plus everything it has grown.
 *
 * Three sections, in order of how much they change the app: panels the assistant
 * has built (real code), rules it has authored (declarative), and schedules.
 */

const KIND_META: Record<RoutineKind, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  check_all: { label: 'Check every site', icon: 'refresh-circle-outline' },
  digest: { label: 'Briefing', icon: 'newspaper-outline' },
  prompt: { label: 'Custom instruction', icon: 'sparkles-outline' },
  reminder: { label: 'Reminder', icon: 'alarm-outline' },
};

export function scheduleLabel(routine: Routine): string {
  if (routine.scheduleKind === 'interval') {
    const m = routine.intervalMin;
    if (m < 60) return `Every ${m} minutes`;
    if (m < 1440) return `Every ${Math.round(m / 60)} hours`;
    return `Every ${Math.round(m / 1440)} days`;
  }
  const clock = formatClock(routine.hour, routine.minute);
  if (routine.scheduleKind === 'daily') return `Daily at ${clock}`;
  return `${WEEKDAY_LABELS[(routine.weekday - 1) % 7]} at ${clock}`;
}

function ModuleRow({
  module,
  onOpen,
  onToggle,
}: {
  module: Module;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const t = useTheme();
  const icon = module.icon as keyof typeof Ionicons.glyphMap;

  return (
    <Card onPress={onOpen} accent={module.enabled ? t.color.accent : undefined}>
      <Row gap={t.spacing.md} align="flex-start">
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: t.radius.md,
            backgroundColor: module.enabled ? t.color.accentSoft : t.color.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={icon}
            size={19}
            color={module.enabled ? t.color.accent : t.color.textMuted}
          />
        </View>

        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="subheading" numberOfLines={1}>
            {module.name}
          </Text>
          {module.description ? (
            <Text variant="caption" tone="muted" numberOfLines={2}>
              {module.description}
            </Text>
          ) : null}
          <Text variant="caption" tone="secondary">
            {moduleSummary(module)}
          </Text>
        </View>

        <Switch
          value={module.enabled}
          onValueChange={onToggle}
          trackColor={{ false: t.color.surfacePressed, true: t.color.accentSoft }}
          thumbColor={module.enabled ? t.color.accent : t.color.textMuted}
          accessibilityLabel={`${module.enabled ? 'Disable' : 'Enable'} ${module.name}`}
        />
      </Row>

      {module.lastError ? (
        <Text variant="caption" tone="danger" numberOfLines={2} style={{ marginTop: t.spacing.sm }}>
          {module.lastError}
        </Text>
      ) : null}
    </Card>
  );
}

function RuleRow({
  rule,
  onToggle,
  onDelete,
}: {
  rule: Rule;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const t = useTheme();
  return (
    <Card onLongPress={onDelete} accent={rule.enabled ? t.color.primary : undefined}>
      <Row gap={t.spacing.md} align="flex-start">
        <View style={{ flex: 1, gap: 4 }}>
          <Row gap={6} wrap>
            <Text variant="subheading" numberOfLines={1} style={{ flexShrink: 1 }}>
              {rule.name}
            </Text>
            {rule.author === 'assistant' ? <Badge label="Built by Scout" tone="accent" /> : null}
          </Row>
          <Text variant="caption" tone="secondary">
            {describeRule(rule)}
          </Text>
          <Text variant="caption" tone="muted">
            {rule.fireCount > 0
              ? `Fired ${rule.fireCount}× · last ${relative(rule.lastFiredAt)}`
              : 'Has not fired yet'}
          </Text>
        </View>
        <Switch
          value={rule.enabled}
          onValueChange={onToggle}
          trackColor={{ false: t.color.surfacePressed, true: t.color.primarySoft }}
          thumbColor={rule.enabled ? t.color.primary : t.color.textMuted}
          accessibilityLabel={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
        />
      </Row>
      <Row gap={t.spacing.sm} style={{ marginTop: t.spacing.md }}>
        <View style={{ flex: 1 }} />
        <IconButton icon="trash-outline" accessibilityLabel={`Delete ${rule.name}`} onPress={onDelete} />
      </Row>
    </Card>
  );
}

function RoutineRow({
  routine,
  running,
  onToggle,
  onRun,
  onEdit,
  onDelete,
}: {
  routine: Routine;
  running: boolean;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTheme();
  const meta = KIND_META[routine.kind];

  return (
    <Card onPress={onEdit} onLongPress={onDelete} accent={routine.enabled ? t.color.info : undefined}>
      <Row gap={t.spacing.md} align="flex-start">
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: t.radius.md,
            backgroundColor: routine.enabled ? t.color.infoSoft : t.color.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={meta.icon}
            size={18}
            color={routine.enabled ? t.color.info : t.color.textMuted}
          />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text variant="subheading" numberOfLines={1}>
            {routine.name}
          </Text>
          <Text variant="caption" tone="secondary">
            {meta.label} · {scheduleLabel(routine)}
          </Text>
        </View>
        <Switch
          value={routine.enabled}
          onValueChange={onToggle}
          trackColor={{ false: t.color.surfacePressed, true: t.color.infoSoft }}
          thumbColor={routine.enabled ? t.color.info : t.color.textMuted}
          accessibilityLabel={`${routine.enabled ? 'Disable' : 'Enable'} ${routine.name}`}
        />
      </Row>

      {routine.lastRunAt ? (
        <View style={{ marginTop: t.spacing.md, gap: 4 }}>
          <Text variant="caption" tone="muted">
            Last ran {relative(routine.lastRunAt)}
          </Text>
          {routine.lastResult ? (
            <Text variant="caption" tone="secondary" numberOfLines={3}>
              {truncate(routine.lastResult, 200)}
            </Text>
          ) : null}
        </View>
      ) : null}

      <Row gap={t.spacing.sm} style={{ marginTop: t.spacing.md }}>
        <Button
          title={running ? 'Running…' : 'Run now'}
          icon="play"
          size="sm"
          variant="secondary"
          loading={running}
          onPress={onRun}
        />
        <View style={{ flex: 1 }} />
        <IconButton icon="trash-outline" accessibilityLabel={`Delete ${routine.name}`} onPress={onDelete} />
      </Row>
    </Card>
  );
}

export default function StudioScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const modules = useApp((s) => s.modules);
  const rules = useApp((s) => s.rules);
  const routines = useApp((s) => s.routines);
  const editModule = useApp((s) => s.editModule);
  const editRule = useApp((s) => s.editRule);
  const removeRule = useApp((s) => s.removeRule);
  const editRoutine = useApp((s) => s.editRoutine);
  const removeRoutine = useApp((s) => s.removeRoutine);
  const fireRoutine = useApp((s) => s.fireRoutine);

  const [running, setRunning] = useState<string | null>(null);

  const run = useCallback(
    async (routine: Routine) => {
      setRunning(routine.id);
      try {
        const outcome = await fireRoutine(routine.id);
        Alert.alert(
          routine.name,
          outcome ? truncate(outcome.result, 700) : 'The routine could not be run.',
        );
      } finally {
        setRunning(null);
      }
    },
    [fireRoutine],
  );

  const confirmDeleteRule = useCallback(
    (rule: Rule) => {
      Alert.alert('Delete rule?', `"${rule.name}" will stop running.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void removeRule(rule.id) },
      ]);
    },
    [removeRule],
  );

  const confirmDeleteRoutine = useCallback(
    (routine: Routine) => {
      Alert.alert('Delete routine?', `"${routine.name}" will stop running.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void removeRoutine(routine.id) },
      ]);
    },
    [removeRoutine],
  );

  const nothingYet = !modules.length && !rules.length && !routines.length;

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header
        title="Studio"
        subtitle={`${modules.length} panel${modules.length === 1 ? '' : 's'} · ${rules.length} rule${
          rules.length === 1 ? '' : 's'
        } · ${routines.length} schedule${routines.length === 1 ? '' : 's'}`}
      />

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + t.spacing.xxxl }}
        showsVerticalScrollIndicator={false}
      >
        {nothingYet ? (
          <View>
            <EmptyState
              icon="construct-outline"
              title="Make the app your own"
              message="Scout can build panels for itself, write automations, and run things on a schedule. Ask it in the Assistant tab, or start one here."
            />
            <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.sm }}>
              {[
                {
                  icon: 'cube-outline' as const,
                  title: 'Build a panel',
                  body: 'Describe a view you want — a chart, a table, a checklist — and Scout writes it. It runs inside the app and stays.',
                  onPress: () => router.push('/module/new'),
                },
                {
                  icon: 'git-branch-outline' as const,
                  title: 'Create a rule',
                  body: '"Star anything free" or "remind me a week before any deadline". Runs by itself on every new event.',
                  onPress: () => router.push('/rule/new'),
                },
                {
                  icon: 'time-outline' as const,
                  title: 'Add a schedule',
                  body: 'A daily briefing, or a full re-check of every watched site.',
                  onPress: () => router.push('/routine/new'),
                },
              ].map((option) => (
                <Pressable
                  key={option.title}
                  onPress={option.onPress}
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    gap: t.spacing.md,
                    padding: t.spacing.md,
                    borderRadius: t.radius.md,
                    borderWidth: 1,
                    borderColor: t.color.border,
                    backgroundColor: pressed ? t.color.surfaceAlt : t.color.surface,
                  })}
                >
                  <Ionicons name={option.icon} size={20} color={t.color.primary} />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">{option.title}</Text>
                    <Text variant="caption" tone="muted">
                      {option.body}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={t.color.textMuted} />
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {/* ------------------------------------------------------------ panels */}
        {!nothingYet ? (
          <>
            <SectionHeader
              title="Panels"
              subtitle="Tools Scout built for this app"
              action="Build one"
              onAction={() => router.push('/module/new')}
            />
            <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
              {modules.length ? (
                modules.map((module) => (
                  <ModuleRow
                    key={module.id}
                    module={module}
                    onOpen={() => router.push({ pathname: '/module/[id]', params: { id: module.id } })}
                    onToggle={(enabled) => void editModule(module.id, { enabled })}
                  />
                ))
              ) : (
                <Card>
                  <Text variant="caption" tone="muted">
                    No panels yet. Ask the assistant for one — “build me a panel showing which venues
                    post most often” — or tap Build one.
                  </Text>
                </Card>
              )}
            </View>

            {/* ----------------------------------------------------------- rules */}
            <SectionHeader
              title="Rules"
              subtitle="Run automatically on every new event"
              action="Add"
              onAction={() => router.push('/rule/new')}
            />
            <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
              {rules.length ? (
                rules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    onToggle={(enabled) => void editRule(rule.id, { enabled })}
                    onDelete={() => confirmDeleteRule(rule)}
                  />
                ))
              ) : (
                <Card>
                  <Text variant="caption" tone="muted">
                    No rules yet. These are deterministic — Scout writes one from your description,
                    then the app applies it without calling a model again.
                  </Text>
                </Card>
              )}
            </View>

            {/* ------------------------------------------------------- schedules */}
            <SectionHeader
              title="Schedules"
              subtitle="Time-based routines"
              action="Add"
              onAction={() => router.push('/routine/new')}
            />
            <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
              {routines.length ? (
                routines.map((routine) => (
                  <RoutineRow
                    key={routine.id}
                    routine={routine}
                    running={running === routine.id}
                    onToggle={(enabled) => void editRoutine(routine.id, { enabled })}
                    onRun={() => void run(routine)}
                    onEdit={() => router.push({ pathname: '/routine/new', params: { id: routine.id } })}
                    onDelete={() => confirmDeleteRoutine(routine)}
                  />
                ))
              ) : (
                <Card>
                  <Text variant="caption" tone="muted">
                    No schedules yet. A daily briefing is the usual first one.
                  </Text>
                </Card>
              )}
            </View>

            <View style={{ padding: t.spacing.lg }}>
              <Row gap={t.spacing.sm} align="flex-start">
                <Ionicons name="shield-checkmark-outline" size={15} color={t.color.textMuted} />
                <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                  Panels run in a sandbox with no network access and no access to your API keys. They
                  can only read the data you grant them, and every permission is listed on the
                  panel’s own screen.
                </Text>
              </Row>
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
