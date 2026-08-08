import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';

import { Badge, Button, Card, Divider, Header, Row, Screen, SectionHeader, Text } from '../src/components/ui';
import {
  UsageSummary,
  formatTokens,
  loadUsage,
  resetUsage,
  subscribeUsage,
  summarize,
} from '../src/lib/usage';
import { relative } from '../src/lib/util/date';
import { useTheme } from '../src/theme';

/**
 * Token bars rendered from plain Views.
 *
 * A charting library would be a large dependency for one bar chart, and a
 * fourteen-bar sparkline is a handful of flexed Views.
 */
function TokenTrend({ data }: { data: { day: string; totalTokens: number }[] }) {
  const t = useTheme();
  const peak = Math.max(1, ...data.map((d) => d.totalTokens));

  return (
    <View style={{ gap: t.spacing.sm }}>
      <Row gap={3} align="flex-end" style={{ height: 84 }}>
        {data.map((d, i) => {
          const ratio = d.totalTokens / peak;
          const isToday = i === data.length - 1;
          return (
            <View key={d.day} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
              <View
                accessibilityLabel={`${d.day}: ${d.totalTokens} tokens`}
                style={{
                  width: '100%',
                  height: Math.max(3, ratio * 70),
                  borderRadius: 3,
                  backgroundColor:
                    d.totalTokens === 0
                      ? t.color.border
                      : isToday
                        ? t.color.primary
                        : t.color.primarySoft,
                  borderWidth: d.totalTokens > 0 && !isToday ? 1 : 0,
                  borderColor: t.color.primary,
                }}
              />
            </View>
          );
        })}
      </Row>
      <Row justify="space-between">
        <Text variant="caption" tone="muted">
          14 days ago
        </Text>
        <Text variant="caption" tone="muted">
          Today
        </Text>
      </Row>
    </View>
  );
}

function StatBlock({
  label,
  total,
  requests,
  prompt,
  output,
}: {
  label: string;
  total: number;
  requests: number;
  prompt: number;
  output: number;
}) {
  return (
    <Card>
      <Row justify="space-between" align="flex-start">
        <View style={{ gap: 2 }}>
          <Text variant="label" tone="muted">
            {label.toUpperCase()}
          </Text>
          <Text variant="title">{formatTokens(total)}</Text>
          <Text variant="caption" tone="muted">
            tokens across {requests} call{requests === 1 ? '' : 's'}
          </Text>
        </View>
        <View style={{ gap: 4, alignItems: 'flex-end' }}>
          <Badge label={`${formatTokens(prompt)} in`} tone="info" />
          <Badge label={`${formatTokens(output)} out`} tone="accent" />
        </View>
      </Row>
    </Card>
  );
}

export default function UsageScreen() {
  const t = useTheme();
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    void loadUsage().then((ledger) => setUsage(summarize(ledger)));
    return subscribeUsage((ledger) => setUsage(summarize(ledger)));
  }, []);

  const confirmReset = () => {
    Alert.alert('Reset the counters?', 'This only clears Scout\'s local tally, not anything at Google.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          await resetUsage();
          setUsage(summarize(await loadUsage()));
        },
      },
    ]);
  };

  return (
    <Screen scroll>
      <Header title="Token usage" onBack={() => router.back()} />

      <View style={{ paddingHorizontal: t.spacing.lg }}>
        <Card>
          <Text variant="caption" tone="muted" style={{ lineHeight: 18 }}>
            Google does not publish a per-key consumption API, so these numbers are Scout's own tally
            of what every Gemini response reported. They cover this device only.
          </Text>
        </Card>
      </View>

      <SectionHeader title="Last 14 days" />
      <View style={{ paddingHorizontal: t.spacing.lg }}>
        <Card>{usage ? <TokenTrend data={usage.trend} /> : <Text tone="muted">Loading…</Text>}</Card>
      </View>

      <SectionHeader title="Totals" />
      <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
        {usage ? (
          <>
            <StatBlock
              label="Today"
              total={usage.today.totalTokens}
              requests={usage.today.requests}
              prompt={usage.today.promptTokens}
              output={usage.today.outputTokens}
            />
            <StatBlock
              label="Last 7 days"
              total={usage.last7Days.totalTokens}
              requests={usage.last7Days.requests}
              prompt={usage.last7Days.promptTokens}
              output={usage.last7Days.outputTokens}
            />
            <StatBlock
              label="All time"
              total={usage.allTime.totalTokens}
              requests={usage.allTime.requests}
              prompt={usage.allTime.promptTokens}
              output={usage.allTime.outputTokens}
            />
          </>
        ) : null}
      </View>

      {usage?.topModels.length ? (
        <>
          <SectionHeader title="By model" />
          <View style={{ paddingHorizontal: t.spacing.lg }}>
            <Card padded={false}>
              {usage.topModels.map((m, i) => (
                <View key={m.model}>
                  <Row
                    justify="space-between"
                    style={{ paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text variant="body" numberOfLines={1}>
                        {m.model}
                      </Text>
                      <Text variant="caption" tone="muted">
                        {m.requests} call{m.requests === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <Text variant="bodyStrong" tone="secondary">
                      {formatTokens(m.totalTokens)}
                    </Text>
                  </Row>
                  {i < usage.topModels.length - 1 ? <Divider inset={t.spacing.lg} /> : null}
                </View>
              ))}
            </Card>
          </View>
        </>
      ) : null}

      <SectionHeader title="Keeping usage down" />
      <View style={{ paddingHorizontal: t.spacing.lg, gap: t.spacing.md }}>
        <Card>
          <View style={{ gap: t.spacing.md }}>
            {[
              ['Unchanged pages cost nothing', 'A check only calls Gemini when the page content actually changed.'],
              ['Use Flash-Lite for extraction', 'Settings → Page extraction model. It runs far more often than chat.'],
              ['Lengthen intervals', 'A venue that posts weekly does not need checking hourly.'],
              ['Watch listing pages, not home pages', 'Less boilerplate per check means fewer input tokens.'],
            ].map(([title, body]) => (
              <View key={title} style={{ gap: 2 }}>
                <Text variant="bodyStrong">{title}</Text>
                <Text variant="caption" tone="muted">
                  {body}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      </View>

      <View style={{ padding: t.spacing.lg, gap: t.spacing.sm }}>
        <Button title="Reset counters" icon="refresh-outline" variant="ghost" onPress={confirmReset} />
        {usage ? (
          <Text variant="caption" tone="muted" center>
            Counting since {relative(usage.since)}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}
