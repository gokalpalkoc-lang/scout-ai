import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ModuleHost } from '../../src/components/ModuleHost';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Field,
  Header,
  IconButton,
  Row,
  Text,
} from '../../src/components/ui';
import { reviseModule } from '../../src/lib/db/modules';
import { generateModule } from '../../src/lib/modules/generate';
import { CAPABILITIES, CAPABILITY_LABELS, Capability, ModuleVersion, WRITE_CAPABILITIES } from '../../src/lib/modules/types';
import { errorMessage } from '../../src/lib/util';
import { relative } from '../../src/lib/util/date';
import { useApp } from '../../src/store/app';
import { useSettings } from '../../src/store/settings';
import { useTheme } from '../../src/theme';

export default function ModuleDetailScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const settings = useSettings();

  const module = useApp((s) => s.modules.find((m) => m.id === id));
  const editModule = useApp((s) => s.editModule);
  const removeModule = useApp((s) => s.removeModule);
  const moduleVersions = useApp((s) => s.moduleVersions);
  const rollbackModuleTo = useApp((s) => s.rollbackModuleTo);
  const refreshModules = useApp((s) => s.refreshModules);

  const [versions, setVersions] = useState<ModuleVersion[]>([]);
  const [revising, setRevising] = useState(false);
  const [revisePrompt, setRevisePrompt] = useState('');
  const [showRevise, setShowRevise] = useState(false);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (!id) return;
    void moduleVersions(id).then(setVersions);
  }, [id, module?.version, moduleVersions]);

  useEffect(() => {
    if (module) void editModule(module.id, { lastOpenedAt: Date.now() });
    // Only on first open of this module.
  }, [module?.id]);

  const runRevision = useCallback(async () => {
    if (!module) return;
    const text = revisePrompt.trim();
    if (text.length < 4) {
      Alert.alert('What should change?', 'Describe the change in a sentence.');
      return;
    }

    setRevising(true);
    try {
      const generated = await generateModule({
        settings,
        request: text,
        existing: { name: module.name, fragment: module.html },
      });
      if (!generated.ok) {
        Alert.alert(
          'Could not apply that change',
          [generated.error, ...(generated.problems ?? [])].join('\n\n'),
        );
        return;
      }
      await reviseModule(module.id, generated.module.fragment, text, text);
      await refreshModules();
      setRevisePrompt('');
      setShowRevise(false);
    } catch (e) {
      Alert.alert('Could not apply that change', errorMessage(e));
    } finally {
      setRevising(false);
    }
  }, [module, revisePrompt, settings, refreshModules]);

  const toggleCapability = useCallback(
    (capability: Capability, granted: boolean) => {
      if (!module) return;
      const next = granted
        ? [...new Set([...module.capabilities, capability])]
        : module.capabilities.filter((c) => c !== capability);
      void editModule(module.id, { capabilities: next });
    },
    [module, editModule],
  );

  const confirmDelete = useCallback(() => {
    if (!module) return;
    Alert.alert('Delete this panel?', `"${module.name}" and its history will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await removeModule(module.id);
          router.back();
        },
      },
    ]);
  }, [module, removeModule]);

  if (!module) {
    return (
      <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
        <Header title="Not found" onBack={() => router.back()} />
        <EmptyState
          icon="help-circle-outline"
          title="This panel is gone"
          message="It may have been deleted."
          action={<Button title="Back to Studio" onPress={() => router.back()} />}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top }}>
      <Header
        title={module.name}
        subtitle={`v${module.version}${module.description ? ` · ${module.description}` : ''}`}
        onBack={() => router.back()}
        right={
          <Row gap={0}>
            <IconButton
              icon={module.pinned ? 'bookmark' : 'bookmark-outline'}
              tone={module.pinned ? t.color.warning : undefined}
              accessibilityLabel={module.pinned ? 'Unpin panel' : 'Pin panel to the top'}
              onPress={() => void editModule(module.id, { pinned: !module.pinned })}
            />
            <IconButton
              icon="create-outline"
              accessibilityLabel="Ask for a change"
              onPress={() => setShowRevise((v) => !v)}
            />
          </Row>
        }
      />

      <ScrollView
        contentContainerStyle={{
          padding: t.spacing.lg,
          paddingBottom: insets.bottom + t.spacing.xxxl,
          gap: t.spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* ----------------------------------------------------- the live panel */}
        {module.enabled ? (
          <ModuleHost
            module={module}
            onError={(message) => void editModule(module.id, { lastError: message })}
          />
        ) : (
          <Card>
            <Text variant="body" tone="muted" center>
              This panel is turned off.
            </Text>
            <Button
              title="Turn it on"
              size="sm"
              style={{ alignSelf: 'center', marginTop: t.spacing.md }}
              onPress={() => void editModule(module.id, { enabled: true })}
            />
          </Card>
        )}

        {module.lastError ? (
          <Card accent={t.color.danger}>
            <Row gap={t.spacing.sm} align="flex-start">
              <Ionicons name="bug-outline" size={16} color={t.color.danger} />
              <View style={{ flex: 1 }}>
                <Text variant="label" tone="danger">
                  Last error
                </Text>
                <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
                  {module.lastError}
                </Text>
                <Button
                  title="Ask Scout to fix it"
                  size="sm"
                  variant="secondary"
                  style={{ marginTop: t.spacing.md }}
                  onPress={() => {
                    setRevisePrompt(`Fix this error: ${module.lastError}`);
                    setShowRevise(true);
                  }}
                />
              </View>
            </Row>
          </Card>
        ) : null}

        {/* --------------------------------------------------------- revise box */}
        {showRevise ? (
          <Card>
            <Field
              label="What should change?"
              value={revisePrompt}
              onChangeText={setRevisePrompt}
              placeholder="Sort by date instead, and show the venue"
              icon="sparkles-outline"
              multiline
              hint="The current version is kept, so you can roll back if the change makes it worse."
            />
            <Row gap={t.spacing.sm} style={{ marginTop: t.spacing.md }}>
              <Button
                title={revising ? 'Rewriting…' : 'Apply change'}
                icon="checkmark"
                loading={revising}
                disabled={!revisePrompt.trim()}
                onPress={() => void runRevision()}
              />
              <Button title="Cancel" variant="ghost" onPress={() => setShowRevise(false)} />
            </Row>
          </Card>
        ) : null}

        {/* -------------------------------------------------------- permissions */}
        <Card padded={false}>
          <View style={{ padding: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="label" tone="secondary">
              PERMISSIONS
            </Text>
            <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
              This panel has no network access and cannot see your API keys. These grants are the only
              data it can reach.
            </Text>
          </View>
          {CAPABILITIES.map((capability, index) => {
            const granted = module.capabilities.includes(capability);
            const isWrite = WRITE_CAPABILITIES.includes(capability);
            return (
              <View key={capability}>
                {index > 0 ? <Divider inset={t.spacing.lg} /> : null}
                <Row
                  gap={t.spacing.md}
                  style={{ paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md }}
                >
                  <View style={{ flex: 1 }}>
                    <Row gap={6} wrap>
                      <Text variant="body">{CAPABILITY_LABELS[capability]}</Text>
                      {isWrite ? <Badge label="changes data" tone="warning" /> : null}
                    </Row>
                    <Text variant="caption" tone="muted">
                      {capability}
                    </Text>
                  </View>
                  <Switch
                    value={granted}
                    onValueChange={(v) => toggleCapability(capability, v)}
                    trackColor={{ false: t.color.surfacePressed, true: t.color.primarySoft }}
                    thumbColor={granted ? t.color.primary : t.color.textMuted}
                    accessibilityLabel={CAPABILITY_LABELS[capability]}
                  />
                </Row>
              </View>
            );
          })}
        </Card>

        {/* ------------------------------------------------------------ history */}
        <View style={{ gap: t.spacing.sm }}>
          <Text variant="label" tone="muted">
            VERSION HISTORY
          </Text>
          <Card padded={false}>
            {versions.map((version, index) => (
              <View key={version.id}>
                {index > 0 ? <Divider inset={t.spacing.lg} /> : null}
                <Row
                  gap={t.spacing.md}
                  align="flex-start"
                  style={{ paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md }}
                >
                  <View style={{ flex: 1 }}>
                    <Row gap={6}>
                      <Text variant="bodyStrong">v{version.version}</Text>
                      {version.version === module.version ? (
                        <Badge label="current" tone="success" />
                      ) : null}
                    </Row>
                    <Text variant="caption" tone="muted">
                      {relative(version.createdAt)}
                      {version.note ? ` · ${version.note}` : ''}
                    </Text>
                  </View>
                  {version.version !== module.version ? (
                    <Button
                      title="Restore"
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        Alert.alert('Restore this version?', `Roll back to v${version.version}.`, [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Restore',
                            onPress: () => void rollbackModuleTo(module.id, version.version),
                          },
                        ]);
                      }}
                    />
                  ) : null}
                </Row>
              </View>
            ))}
            {!versions.length ? (
              <Text variant="caption" tone="muted" style={{ padding: t.spacing.lg }}>
                No history recorded.
              </Text>
            ) : null}
          </Card>
        </View>

        {/* --------------------------------------------------------------- code */}
        <View style={{ gap: t.spacing.sm }}>
          <Button
            title={showCode ? 'Hide the code' : 'Show the code'}
            icon="code-slash-outline"
            variant="ghost"
            size="sm"
            onPress={() => setShowCode((v) => !v)}
          />
          {showCode ? (
            <Card>
              <Text variant="mono" tone="secondary" selectable>
                {module.html}
              </Text>
            </Card>
          ) : null}
          {module.prompt ? (
            <Card>
              <Text variant="label" tone="secondary">
                BUILT FROM
              </Text>
              <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
                “{module.prompt}”
              </Text>
            </Card>
          ) : null}
        </View>

        <Button
          title="Delete this panel"
          icon="trash-outline"
          variant="danger"
          fullWidth
          onPress={confirmDelete}
        />
      </ScrollView>
    </View>
  );
}
