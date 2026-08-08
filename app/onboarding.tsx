import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, Button, Card, Field, Row, Text } from '../src/components/ui';
import * as background from '../src/lib/background';
import { looksLikeApiKey, saveApiKey } from '../src/lib/gemini/auth';
import { listModels, verifyCredential } from '../src/lib/gemini/client';
import * as notify from '../src/lib/notify';
import { errorMessage, normalizeUrl, titleFromUrl } from '../src/lib/util';
import { useApp } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { useTheme } from '../src/theme';

const API_KEY_URL = 'https://aistudio.google.com/apikey';

type Step = 'welcome' | 'key' | 'permissions' | 'firstSite' | 'done';

const STEP_ORDER: Step[] = ['welcome', 'key', 'permissions', 'firstSite', 'done'];

/** Progress dots so the user can see how long setup is. */
function Progress({ step }: { step: Step }) {
  const t = useTheme();
  const index = STEP_ORDER.indexOf(step);
  return (
    <Row gap={6} justify="center">
      {STEP_ORDER.map((s, i) => (
        <View
          key={s}
          style={{
            width: i === index ? 22 : 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: i <= index ? t.color.primary : t.color.border,
          }}
        />
      ))}
    </Row>
  );
}

function Bullet({ icon, title, body }: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }) {
  const t = useTheme();
  return (
    <Row gap={t.spacing.md} align="flex-start">
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: t.radius.md,
          backgroundColor: t.color.primarySoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={18} color={t.color.primary} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong">{title}</Text>
        <Text variant="caption" tone="muted">
          {body}
        </Text>
      </View>
    </Row>
  );
}

export default function Onboarding() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const settings = useSettings();
  const addSource = useApp((s) => s.addSource);

  const [step, setStep] = useState<Step>('welcome');
  const [keyInput, setKeyInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [keyOk, setKeyOk] = useState(false);
  const [notifOk, setNotifOk] = useState<boolean | null>(null);
  const [siteUrl, setSiteUrl] = useState('');
  const [savingSite, setSavingSite] = useState(false);

  const finish = useCallback(() => {
    settings.set('hasOnboarded', true);
    router.replace('/');
  }, [settings]);

  const verifyKey = useCallback(async () => {
    const value = keyInput.trim();
    if (!looksLikeApiKey(value)) {
      Alert.alert(
        'That does not look right',
        'A Gemini API key is one long string with no spaces. Tap "Get a free key" and copy it from AI Studio.',
      );
      return;
    }

    setVerifying(true);
    try {
      await saveApiKey(value);
      const result = await verifyCredential({ provider: 'aistudio', apiKey: value }, settings.chatModel);
      if (!result.ok) {
        Alert.alert('Google rejected that key', result.error);
        return;
      }

      settings.set('credentialVerifiedAt', Date.now());
      setKeyOk(true);

      try {
        const models = await listModels({ provider: 'aistudio', apiKey: value });
        if (models.length) settings.patch({ knownModels: models, modelsFetchedAt: Date.now() });
      } catch {
        /* fallback list is fine */
      }
      setStep('permissions');
    } catch (e) {
      Alert.alert('Could not verify the key', errorMessage(e));
    } finally {
      setVerifying(false);
    }
  }, [keyInput, settings]);

  const grantPermissions = useCallback(async () => {
    const state = await notify.ensurePermission();
    setNotifOk(state.granted);
    if (state.granted) {
      await notify.configureChannels();
      await background.register(settings.backgroundIntervalMin);
    }
    setStep('firstSite');
  }, [settings.backgroundIntervalMin]);

  const saveFirstSite = useCallback(async () => {
    const url = normalizeUrl(siteUrl);
    if (!url) {
      Alert.alert('Check the address', 'Paste a full web address, for example example.com/events.');
      return;
    }
    setSavingSite(true);
    try {
      await addSource(
        {
          url,
          title: titleFromUrl(url),
          category: null,
          mode: 'both',
          hint: null,
          intervalMin: settings.defaultCheckIntervalMin,
          enabled: true,
          notify: true,
        },
        true,
      );
      setStep('done');
    } catch (e) {
      Alert.alert('Could not add that site', errorMessage(e));
    } finally {
      setSavingSite(false);
    }
  }, [siteUrl, addSource, settings.defaultCheckIntervalMin]);

  return (
    <View style={{ flex: 1, backgroundColor: t.color.bg, paddingTop: insets.top + t.spacing.lg }}>
      <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.lg }}>
        <Progress step={step} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: t.spacing.lg, paddingBottom: insets.bottom + 120, gap: t.spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {step === 'welcome' ? (
          <>
            <View style={{ gap: t.spacing.sm }}>
              <View
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: t.radius.xl,
                  backgroundColor: t.color.primarySoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: t.spacing.md,
                }}
              >
                <Ionicons name="sparkles" size={28} color={t.color.primary} />
              </View>
              <Text variant="display">Scout</Text>
              <Text variant="body" tone="secondary">
                An assistant that watches the websites you care about and tells you what is coming up.
              </Text>
            </View>

            <View style={{ gap: t.spacing.lg }}>
              <Bullet
                icon="eye-outline"
                title="Watch any page"
                body="Give Scout a venue, university or conference page. It reads it on a schedule."
              />
              <Bullet
                icon="calendar-outline"
                title="Events, not noise"
                body="Gemini pulls out titles, dates, places and deadlines, and only flags what is genuinely new."
              />
              <Bullet
                icon="alarm-outline"
                title="Never miss a cutoff"
                body="Registration deadlines become reminders before they close."
              />
              <Bullet
                icon="chatbubbles-outline"
                title="Ask it anything"
                body="It can also check a link on demand, answer questions and run routines for you."
              />
            </View>
          </>
        ) : null}

        {step === 'key' ? (
          <>
            <View style={{ gap: t.spacing.sm }}>
              <Text variant="title">Connect your Gemini access</Text>
              <Text variant="body" tone="secondary">
                Scout runs on Gemini using your own Google account quota. There is no Scout server and
                no subscription.
              </Text>
            </View>

            <Card>
              <Text variant="label" tone="secondary">
                Why a key and not a Google sign-in?
              </Text>
              <Text variant="caption" tone="muted" style={{ marginTop: 6, lineHeight: 18 }}>
                Google's Gemini API does not accept a plain consumer Google login from a mobile app —
                it takes either an AI Studio API key or a Cloud project with OAuth. The key is the same
                free quota tied to your Google account, and it takes about thirty seconds to create.
              </Text>
            </Card>

            <View style={{ gap: t.spacing.md }}>
              <Button
                title="Get a free key at AI Studio"
                icon="open-outline"
                fullWidth
                variant="secondary"
                onPress={() => void WebBrowser.openBrowserAsync(API_KEY_URL)}
              />
              <Field
                label="Paste your key here"
                value={keyInput}
                onChangeText={setKeyInput}
                placeholder="AIza…"
                icon="key-outline"
                secretToggle
                autoCapitalize="none"
                autoCorrect={false}
                hint="Stored in the phone's encrypted keystore. It never leaves the device except to call Google."
              />
              <Row gap={t.spacing.sm}>
                <Button
                  title="Paste from clipboard"
                  icon="clipboard-outline"
                  variant="ghost"
                  size="sm"
                  onPress={async () => setKeyInput((await Clipboard.getStringAsync()).trim())}
                />
              </Row>
            </View>
          </>
        ) : null}

        {step === 'permissions' ? (
          <>
            <View style={{ gap: t.spacing.sm }}>
              <Badge label="Key verified" tone="success" icon="checkmark-circle" />
              <Text variant="title" style={{ marginTop: t.spacing.sm }}>
                Let Scout work while closed
              </Text>
              <Text variant="body" tone="secondary">
                Two permissions make the watching useful. Both are optional and you can change them
                later in Settings.
              </Text>
            </View>

            <View style={{ gap: t.spacing.lg }}>
              <Bullet
                icon="notifications-outline"
                title="Notifications"
                body="How Scout tells you about a new event or a closing deadline. Without this it can only report when you open the app."
              />
              <Bullet
                icon="cloud-outline"
                title="Background checks"
                body="Android wakes Scout occasionally to re-read your pages. The system decides exactly when."
              />
            </View>

            {notifOk === false ? (
              <Card>
                <Text variant="caption" tone="warning">
                  Notifications were declined. Scout still works — it will show what it found the next
                  time you open it.
                </Text>
              </Card>
            ) : null}
          </>
        ) : null}

        {step === 'firstSite' ? (
          <>
            <View style={{ gap: t.spacing.sm }}>
              <Text variant="title">Add your first page</Text>
              <Text variant="body" tone="secondary">
                Pick a page that lists events — the busier the better. You can add more later, or ask
                the assistant to do it.
              </Text>
            </View>

            <Field
              label="Web address"
              value={siteUrl}
              onChangeText={setSiteUrl}
              placeholder="example.com/events"
              icon="link-outline"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              hint="A listing page works better than a home page."
            />

            <Card>
              <Text variant="label" tone="secondary">
                What makes a good page
              </Text>
              <View style={{ gap: 6, marginTop: t.spacing.sm }}>
                {[
                  'A programme, calendar or "upcoming events" page',
                  'A department\'s announcements or seminars page',
                  'A conference call-for-papers with deadlines',
                  'An RSS feed, if the site offers one — those read perfectly',
                ].map((line) => (
                  <Row key={line} gap={6} align="flex-start">
                    <Ionicons name="checkmark" size={13} color={t.color.success} style={{ marginTop: 3 }} />
                    <Text variant="caption" tone="muted" style={{ flex: 1 }}>
                      {line}
                    </Text>
                  </Row>
                ))}
              </View>
              <Text variant="caption" tone="muted" style={{ marginTop: t.spacing.md }}>
                Pages that build themselves entirely in JavaScript may come back empty — Scout reads
                HTML, it does not run a browser.
              </Text>
            </Card>
          </>
        ) : null}

        {step === 'done' ? (
          <>
            <View style={{ gap: t.spacing.md, alignItems: 'center', paddingTop: t.spacing.xl }}>
              <View
                style={{
                  width: 68,
                  height: 68,
                  borderRadius: 34,
                  backgroundColor: t.color.successSoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="checkmark" size={34} color={t.color.success} />
              </View>
              <Text variant="title" center>
                Scout is set up
              </Text>
              <Text variant="body" tone="secondary" center>
                The first check is running now. Try asking the assistant "what did you find?" or
                "what's on this month?".
              </Text>
            </View>

            <Card>
              <Text variant="label" tone="secondary">
                Worth doing next
              </Text>
              <View style={{ gap: t.spacing.md, marginTop: t.spacing.md }}>
                <Bullet
                  icon="repeat-outline"
                  title="Create a morning briefing"
                  body="Routines → Briefing. A summary of what is coming up, at the time you choose."
                />
                <Bullet
                  icon="options-outline"
                  title="Tune each page"
                  body="Open a site and add a hint like 'only the concerts section' to sharpen extraction."
                />
              </View>
            </Card>
          </>
        ) : null}
      </ScrollView>

      {/* Footer actions */}
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
          gap: t.spacing.sm,
        }}
      >
        {step === 'welcome' ? (
          <Button title="Get started" iconRight="arrow-forward" fullWidth size="lg" onPress={() => setStep('key')} />
        ) : null}

        {step === 'key' ? (
          <>
            <Button
              title="Verify and continue"
              iconRight="arrow-forward"
              fullWidth
              size="lg"
              loading={verifying}
              disabled={!keyInput.trim()}
              onPress={() => void verifyKey()}
            />
            <Button
              title="Skip — I'll add it later"
              variant="ghost"
              fullWidth
              onPress={() => setStep('permissions')}
            />
          </>
        ) : null}

        {step === 'permissions' ? (
          <>
            <Button
              title="Allow and continue"
              iconRight="arrow-forward"
              fullWidth
              size="lg"
              onPress={() => void grantPermissions()}
            />
            <Button title="Not now" variant="ghost" fullWidth onPress={() => setStep('firstSite')} />
          </>
        ) : null}

        {step === 'firstSite' ? (
          <>
            <Button
              title="Watch this page"
              iconRight="arrow-forward"
              fullWidth
              size="lg"
              loading={savingSite}
              disabled={!siteUrl.trim() || !keyOk}
              onPress={() => void saveFirstSite()}
            />
            {!keyOk ? (
              <Text variant="caption" tone="warning" center>
                Add a Gemini key first — Scout cannot read a page without one.
              </Text>
            ) : null}
            <Button title="Skip for now" variant="ghost" fullWidth onPress={finish} />
          </>
        ) : null}

        {step === 'done' ? (
          <Button title="Open Scout" icon="sparkles" fullWidth size="lg" onPress={finish} />
        ) : null}
      </View>
    </View>
  );
}
