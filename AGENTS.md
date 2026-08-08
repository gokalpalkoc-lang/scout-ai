# Working on Scout

Scout is an Expo (SDK 57) React Native app: an AI assistant that watches websites
for events and manages routine tasks. Android is the primary target.

## Before writing code

Expo changes fast. Read the versioned docs for the exact SDK in `package.json`
(currently <https://docs.expo.dev/versions/v57.0.0/>) rather than relying on
memory — several APIs used here were renamed in recent releases:

- `expo-sqlite` uses the async API (`openDatabaseAsync`, `getAllAsync`, `runAsync`).
- Background work is `expo-background-task`, not the removed `expo-background-fetch`.
- `expo-file-system` uses the `File` / `Directory` / `Paths` classes.
- `expo-notifications` triggers use `SchedulableTriggerInputTypes`.

## Layout

```
app/                 expo-router routes (file = screen)
  (tabs)/            Assistant, Agenda, Watchlist, Studio, Settings
src/theme/           design tokens; nothing hardcodes a colour
src/components/ui/   primitives (Text, Button, Card, Field, …)
src/lib/
  db/                SQLite schema + one repository per table
  web/               fetch, HTML→text, JSON-LD, hashing, diffing
  ai/                provider router, shared contract/prompt/schema, rotation pool
  gemini/            auth, REST client, tool declarations (canonical), agent loop
  anthropic/         auth, Messages API client, schema conversion, agent loop
  openai/            one Chat-Completions adapter for every free-tier backend
  extract/           page → structured events (prompts + validation)
  rules/             the rule DSL: types, validator, engine, generator
  modules/           generated panels: sandbox, capability bridge, generator
  engine/            checkSource / sweep / routines — the orchestration
  notify/ calendar/ background/
src/store/           Zustand: settings (persisted) + app + chat
```

## Three model providers

The assistant runs on Gemini, Claude, or a rotating pool of free tiers; page
extraction always runs on Gemini (it fires on every check, and a cheap Flash
model is the right tool for text → JSON).

- **Everything shared lives in `src/lib/ai`**, and it is shared because it had
  already started to drift between two providers: the system prompt
  (`prompt.ts`), the Gemini-schema → JSON-Schema translation (`jsonSchema.ts`),
  and the one-shot authoring call the rule and module generators make (`ask.ts`).
  A fourth provider should add a wire layer, not another copy of these.
- **Tool declarations live once**, in Gemini's OpenAPI-subset shape in
  `src/lib/gemini/tools.ts`. Never maintain two copies — they drift.
- **The tool dispatcher is provider-neutral** (name + args → JSON), so all three
  agent loops drive the same 24 tools against the same database.
- **No SDKs, only raw HTTP,** and that was measured rather than assumed:
  `@anthropic-ai/sdk` imports `node:fs` through its credential chain (Metro
  cannot resolve it) and its streaming reads `response.body.getReader()`, which
  React Native's XHR-based `fetch` polyfill does not provide. XHR `onprogress` is
  the only incremental transport here, and the same applies to `openai`.

## The free model pool

`src/lib/openai` is one Chat Completions client serving Groq, Cerebras,
OpenRouter, Mistral, GitHub Models and any self-hosted server — adding a backend
is a row in `catalog.ts`, not a module. `src/lib/ai/pool.ts` decides who answers.

- **Quotas are learned, not configured.** Free tiers change their limits without
  notice, so the only trustworthy signal is a 429 and its `Retry-After`. Do not
  hardcode a rate limit; let a backend bench itself.
- **Failover stops the moment a turn is committed.** Once a backend has streamed
  a word or started a tool, switching would duplicate the draft in `store/chat`
  and re-run SQLite mutations. `runPoolTurn` watches `onToolStart`, not
  `onToolEnd` — a tool that failed halfway has still had its chance to write.
- **Health is persisted** (AsyncStorage), because a background sweep would
  otherwise walk straight back into a backend that is out of quota for the day.
  Keys stay in SecureStore; `pool.ts` holds only timings and counters.
- Streaming tool calls arrive as `function.arguments` **fragments keyed by
  index**. A half-streamed argument string is not valid JSON, so they can only be
  assembled once the stream ends.

## The two self-modification layers

- **Rules** (`src/lib/rules`) are *data*. The model proposes JSON; `parse.ts`
  decides. Every field, operator and action is a closed set. The engine runs with
  no model involved, so a bad rule produces a wrong star, not arbitrary
  behaviour.
- **Modules** (`src/lib/modules`) are *code* — generated panels running in a
  WebView. Safety rests on the CSP in `sandbox.ts` (`default-src 'none'` blocks
  all network access) plus per-module capability grants checked in `bridge.ts`.
  `validateFragment` is a second line of defence, not the first.
  - The fragment goes into `<body>` **verbatim**. Do not "escape" its closing
    tags: that once left every module inert, and it buys nothing the CSP does not
    already guarantee.
  - Adding a bridge method means adding it to `METHOD_CAPABILITY` *and*
    `MODULE_API_REFERENCE`, or the model cannot discover it.

## Conventions

- **SQLite is the source of truth.** Stores hold the last read; mutations call
  `refresh*` rather than patching state by hand.
- **Never trust the model.** Everything Gemini returns is re-validated in
  `src/lib/extract` before it reaches the database.
- **Single quotes in SQL.** SQLite reads `""` as an identifier, not an empty
  string, and the app must not depend on the lenient-parsing build flag.
- **No lookbehind in regex.** Hermes does not support it.
- **Secrets live in `expo-secure-store`**, never in AsyncStorage, the Zustand
  persisted state, or a backup file.
- **Cheap-first checking.** A page check only spends a Gemini call when the
  content hash actually changed. Preserve that property.
- Comments explain *why*, not *what*. Match the surrounding density.

## Verifying a change

```bash
npm run typecheck                       # must be clean
npx expo-doctor                         # must be 20/20
npx expo export --platform android      # must bundle
```

There is no device-free way to exercise SQLite or notifications, but a lot is
testable off-device and worth checking when touched:

- Pure logic (`htmlToText`, `sanitizeEvents`, `diffText`, date helpers, the rule
  validator and engine, fragment validation, schema conversion, the pool's
  rotation and backoff, `mergePoolMembers`) runs in plain Node via esbuild,
  stubbing `react-native` and the `expo-*` modules. Stub `expo-*` with a CJS
  `Proxy` so named imports resolve without listing every export.
- **The SSE clients are testable with a fake `XMLHttpRequest`** that grows
  `responseText` and fires `onprogress`, which is exactly what React Native does.
  Worth doing after any change to frame parsing: the cases that actually break
  are a chunk boundary landing mid-`data:` line, a final frame with no trailing
  newline, and tool arguments split across frames.
- The SQL — including the migration chain — runs against Node 24's built-in
  `node:sqlite`. Extract the DDL from `MIGRATIONS` and apply it in order.
- **The module sandbox is verifiable in a real browser**: render
  `wrapModuleHtml` with a fragment that tries `fetch`, `XMLHttpRequest`,
  `WebSocket`, a remote `<img>` and a remote `<script>`, load it in headless
  Chrome, and confirm every one is blocked and the CSP violations are logged.
  Do this after any change to `sandbox.ts`.
