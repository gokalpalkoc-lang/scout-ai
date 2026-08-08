# Scout

A mobile AI assistant that watches websites for events and keeps you ahead of
dates and deadlines.

You give Scout the address of a page that lists things — a venue's programme, a
university's seminars, a conference call-for-papers — and it reads that page on a
schedule using Gemini. New events land in your agenda, registration cutoffs
become reminders, and meaningful page changes become notifications. The assistant
tab can also check a link on demand, answer general questions, and run routines
for you.

It also grows. Ask it for a panel — "show me which venues post most often" — and
Claude writes one that runs inside the app and stays there. Ask it to automate
something and it writes a rule the app then applies by itself.

Built with Expo SDK 57 / React Native. No server, no account: everything lives on
your phone, and the only thing that leaves it is the page text sent to your chosen
model under your own key.

---

## Getting it running

```bash
npm install
npm start          # then press 'a', or scan the QR code with Expo Go
```

You need a Gemini API key. The app walks you through it on first launch:

1. Open <https://aistudio.google.com/apikey> and create a key (free, tied to your
   Google account's Gemini quota).
2. Paste it into Scout. It is verified immediately and stored in the phone's
   encrypted keystore (Android EncryptedSharedPreferences / iOS Keychain).

### Two providers

The **assistant** runs on Gemini or Claude — pick it in Settings. **Page
extraction always runs on Gemini**, whichever you choose, because it fires on
every site check and a cheap Flash model is exactly right for turning page text
into JSON. So a Gemini key is required either way; an Anthropic key is optional
and makes Claude available for chat, rules and panels.

Claude is the better choice for writing panels; Gemini Flash is the better choice
for reading fifty pages a day. The split is deliberate rather than a compromise.

Note that Scout talks to the Messages API over HTTP rather than through
`@anthropic-ai/sdk`. That is not a shortcut: the SDK pulls in `node:fs` through
its credential chain, which Metro cannot resolve, and its streaming needs
`response.body.getReader()`, which React Native's XHR-based `fetch` polyfill does
not have. Both were checked before the decision.

### A note on "use my Gemini tokens from my Google profile"

This is worth being straight about, because the app is shaped by it: **Google's
Gemini API does not accept a plain consumer Google sign-in from a mobile app.**
There are exactly two supported paths, and Scout implements both.

| | AI Studio key *(default)* | Vertex AI |
|---|---|---|
| What you provide | An API key from AI Studio | A GCP project + OAuth access token |
| Setup | ~30 seconds | Cloud project, billing, IAM |
| Quota | Your Google account's Gemini quota | Billed to the project |
| Token lifetime | Doesn't expire | ~1 hour, then re-paste |

The key path *is* your Google account's quota — same free tier, same limits, no
subscription and no middleman. Vertex is there under **Settings → Gemini access**
for anyone who wants project-level billing and audit logs; supply the project ID
and an access token from `gcloud auth print-access-token`. Because those tokens
are short-lived and Scout has no server to refresh them, the key path is the one
to use day to day.

A full Google Sign-In flow would need a registered OAuth client and a token
exchange service; the provider abstraction in `src/lib/gemini/auth.ts` is where
that would slot in.

---

## Testing on your computer

Three ways, in increasing fidelity.

### 1. In a browser — fastest, but cannot test watching

```bash
npm run web        # opens http://localhost:8081
```

This genuinely runs the app: SQLite works (compiled to WebAssembly), your key
persists, navigation and the whole UI work, and **Gemini chat works** — Google's
API sends CORS headers, so the browser is allowed to call it.

What does **not** work in a browser:

| | Why |
|---|---|
| Fetching watched pages | **CORS.** A browser refuses to let a page read `https://somevenue.com/events`. Verified: the request fails, so extraction and change detection cannot be tested here. Native has no such restriction. |
| Notifications, calendar, background wakes | No web implementation; these paths no-op by design. |

So the browser is right for UI, navigation and chat work — and useless for the
core watching feature. Use it as a fast design loop, not as a functional test.

### 2. Android emulator — tests everything

The SDK is already at `~/Android/Sdk` and `/dev/kvm` is accessible, so hardware
acceleration will work. What's missing is a virtual device: there are no AVDs and
no system image yet.

Create one in Android Studio (it downloads the image for you):

> **Tools → Device Manager → Add a new device**, pick any Pixel with API 34+, and
> let it download the system image (~1.5 GB).

Then:

```bash
npm run avd:list          # confirm the device exists
npm run android:emulator  # boots it and installs Expo Go
```

`android:emulator` sets `ANDROID_HOME` and puts `adb`/`emulator` on `PATH` for
you — neither is configured globally on this machine.

Everything works there except **background wakes**, which Expo Go cannot do. For
those, make a development build:

```bash
npx expo run:android      # needs the Android SDK + a JDK on PATH
```

Android Studio ships a usable JDK at `/opt/android-studio/jbr` if you need one:
`export JAVA_HOME=/opt/android-studio/jbr`.

### 3. Your own phone — the real thing

```bash
npm start                 # scan the QR code with Expo Go
```

Same phone, same network. This is the best day-to-day loop, and the only place
notification timing and battery behaviour are truthful.

---

## Making the app your own

Two of the three tabs are about watching websites. The **Studio** tab is about the
app changing shape on your instruction.

### Rules — automations, as data

Describe an automation and Scout writes it:

> "Star anything free at Salon IKSV"
> "Remind me a week before any abstract deadline"
> "Hide anything with 'cancelled' in the title"

The model only *proposes*; a validator decides. Every field, operator and action
is a closed set, so an unparseable rule is rejected rather than stored. Once
saved, **the rule runs with no model involved** — deterministic, instant, and free.
Before you save one you get a dry run against your current agenda, so you can see
what it would have caught.

A rule can star, hide, notify, set a category, add to your calendar, or book a
deadline reminder. Nothing else — deliberately.

### Panels — real code, written on demand

> "Build me a bar chart of events per watched site, tallest first"

Claude writes a small self-contained panel; the app runs it, versions it, and
keeps it. You can ask for changes ("sort by date instead, and show the venue"),
and every revision is kept so you can roll back.

**Why this is not the app rewriting its own React code:** Metro, the bundler, is a
Node toolchain and cannot run on a phone — no app can compile new React for itself
on-device. A WebView carries its own JS engine, so generated code runs with no
build step at all. From your side the app gained a feature; underneath, it loaded
a new panel rather than a new binary.

**How a panel is contained** — verified in a browser, not assumed:

| Attempt | Result |
|---|---|
| `fetch` to any host | blocked |
| `XMLHttpRequest` | blocked |
| `WebSocket` | blocked |
| Remote `<script>` | blocked |
| Remote `<img>` | blocked |

A `Content-Security-Policy` of `default-src 'none'` means a panel has **no network
access whatsoever** — it cannot send your agenda anywhere, and it cannot fetch new
code after you have reviewed it. It never sees your API keys. Data reaches it only
through a bridge whose every method maps to a permission you granted, listed on
the panel's own screen and revocable there.

What panels are *not*: a way to add native capability. No new permissions, no
background execution, no filesystem.

### The honest limit

This is "evolve on command", not self-rewriting. Panels and rules are real and
persistent; the app's own screens still change only when you install an update.
Going further would mean a build server in the loop — see the note at the end of
this README.

---

### Building an APK

```bash
npx eas build -p android --profile preview       # cloud build
npx eas build -p android --profile preview --local
```

Or generate the native project and build locally with Android Studio:

```bash
npx expo prebuild --clean
```

---

## What it does

### Watching pages

Each watched page has a **mode** — extract events, detect changes, or both — an
optional **hint** in your own words ("only the concerts section"), and a check
interval.

A check is deliberately cheap-first:

1. Fetch the page (browser user-agent; RSS and Atom feeds are handled natively).
2. Reduce the HTML to model-ready text, keeping the signals that matter:
   `<time datetime>` machine dates, link targets, list and table structure, and
   any schema.org JSON-LD the site publishes.
3. Hash the normalised text, ignoring churn like clocks and view counters.
4. **If the hash is unchanged, stop.** No Gemini call, no cost.
5. Otherwise extract events under a strict JSON schema, then re-validate
   everything in code: dates parsed, absurd horizons discarded, URLs sanitised,
   duplicates merged, low-confidence rows filtered.
6. Store only genuinely unseen items as "new" — that is what triggers a
   notification. Corrections to an existing event update it in place, and your
   stars and dismissals survive.

For change-watching, the line-level diff is judged by the model before it can
notify you, so rotating banners and comment counters stay silent.

### Agenda

Events grouped by day, filterable by new / this week / deadlines / starred /
past, searchable, and exportable to your phone's calendar (singly or all your
starred items at once). Deadlines carry a countdown and can book a reminder.

### Routines

Scheduled work, in three kinds: re-check every site, send a written briefing, or
run a custom instruction with your events and sites supplied as context.

Daily and weekly routines are delivered as an OS notification at the time you
choose — tapping it runs the routine. That is deliberate: Android will not let an
app run arbitrary code at an exact wall-clock time, so the app doesn't pretend
otherwise. Interval routines run opportunistically on a background wake or when
you open the app.

### Assistant

A chat that can actually operate the app. It has 17 tools — add and check watched
sites, scan an arbitrary URL, read a page, search your events, save events, add
to calendar, set reminders, create routines, report an overview — and every call
is listed under the reply so you can see what it did rather than take its word
for it. Replies stream, and Google Search grounding is available for general
questions.

### Token accounting

Google publishes no per-key consumption API, so Scout tallies the `usageMetadata`
on every response: today, last 7 days, all time, a 14-day trend and a per-model
breakdown, under **Settings → Token usage**.

---

## Keeping quota use down

- Unchanged pages cost nothing — only real content changes trigger extraction.
- Use a cheaper model for extraction than for chat (Settings → Page extraction
  model). It runs far more often.
- Lengthen intervals for sites that post weekly.
- Prefer a listing page over a home page: less boilerplate per check.

---

## If you want the app to rewrite its own code

Panels cover most of what "evolve on command" means, but they are not the app's
own source. Going further needs a build server, because the bundler cannot run on
a phone:

1. You ask for a change.
2. A host running the **Claude Agent SDK** edits this repository.
3. CI runs `npm run typecheck` and `expo export`.
4. `expo-updates` publishes the new JS bundle; the app picks it up on next launch.

That is genuinely the app updating itself over the air, with review in the middle.
`expo-updates` is available for this SDK and is a small addition if you want it.

**One caution specific to Scout.** This app feeds attacker-controlled text to a
model by design — it scrapes arbitrary websites. Today the worst case is bounded:
a malicious page yields junk events. If the same model can also author code that
ships to your phone, a page edit becomes a path to running code. If you build that
pipeline, keep code authoring strictly separate from the page-reading path, with a
different credential and a human diff review, and add a health check with
automatic rollback.

## Known limits

- **Scout reads HTML; it does not run a browser.** Pages that build themselves
  entirely in JavaScript come back empty. The "Test this page" button on the add
  screen tells you before you commit, and a source that yields nothing says so
  rather than failing silently.
- **Background timing is the OS's decision.** The wake interval is a floor, not a
  promise; Android may defer it for hours on a dozing device. A foreground sweep
  covers whatever was skipped when you next open the app.
- Background checking pauses itself if you haven't opened the app in two weeks,
  rather than draining battery and quota indefinitely.
- Some sites block automated requests outright (HTTP 403). Nothing to be done
  from the client side.
- Backups exclude your API keys by design — a file you might send through a
  messaging app is no place for a credential.
- **Rules apply to newly found events**, not retroactively to your existing
  agenda. This is deliberate: a rule that swept the whole table on every check
  would keep overriding stars and dismissals you made by hand.
- **Panels cannot add native capability.** No new permissions, no background
  execution, no filesystem — a panel is a sandboxed view over data you already
  have.

---

## Project layout

```
app/                    expo-router routes
  (tabs)/               Assistant · Agenda · Watchlist · Studio · Settings
  source/ event/ routine/  detail and editor screens
  rule/new  module/new  module/[id]
  onboarding · models · usage
src/theme/              design tokens, light + dark
src/components/ui/      Text, Button, Card, Field, Badge, Layout primitives
src/lib/
  db/                   SQLite schema, migrations, per-table repositories
  web/                  fetch, HTML→text, JSON-LD, hashing, diffing
  ai/                   provider router + the shared agent contract
  gemini/               auth, REST client (incl. SSE streaming), tools, agent
  anthropic/            auth, Messages API client, schema conversion, agent
  extract/              page → validated events, change classification
  rules/                rule DSL: types, validator, engine, generator
  modules/              sandbox (CSP), capability bridge, panel generator
  engine/               checkSource, sweep, routines
  notify/ calendar/ background/ backup
src/store/              Zustand: settings (persisted), app data, chat
```

Data model: `sources` → `events` (unique per source + fingerprint), plus
`snapshots` for change detection, `checks` for per-site history, `routines`,
`messages`, `rules`, and `modules` with `module_versions` (rollback) and
`module_storage` (per-panel key/value). Schema changes go through the `user_version` migration list in
`src/lib/db/index.ts` so an update never wipes a watchlist.

## Development

```bash
npm run typecheck    # tsc --noEmit
npx expo-doctor      # config and dependency checks
npm run dev:clear    # start with a cleared Metro cache
```

## Privacy

No analytics, no telemetry, no backend. Watched page contents and your prompts go
to the model API you configured and nowhere else. Notifications are local. Your
keys never leave the device except as an authorisation header to Google or
Anthropic. Generated panels have no network access at all, so they cannot send
anything anywhere.
