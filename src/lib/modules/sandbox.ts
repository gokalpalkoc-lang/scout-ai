import { Palette } from '../../theme/tokens';

/**
 * Builds the document a module runs inside.
 *
 * A module supplies only a *body fragment* — markup plus its own `<style>` and
 * `<script>`. Everything security-relevant is supplied here, where the model
 * cannot influence it:
 *
 *  - **Content-Security-Policy with `default-src 'none'`.** This is the load-
 *    bearing control: it blocks fetch, XHR, WebSockets, remote scripts, remote
 *    images and fonts. A module physically cannot reach the network, so it can
 *    neither exfiltrate your agenda nor pull in new code after review.
 *  - **The bridge**, which is the only channel in or out, and which the app side
 *    gates per capability.
 *  - **Theme variables**, so a generated panel matches the app instead of
 *    looking like a web page bolted on.
 *
 * If a module needs data, it has to ask for it through `scout.call`, which means
 * every access is a decision the user already made when granting capabilities.
 */

/** U+2028/U+2029 are valid JSON but terminate a JS line — strip in injected code. */
export function escapeForInjection(json: string): string {
  return json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * The fragment is inserted into `<body>` verbatim, and it must be.
 *
 * An earlier version escaped the fragment's own `</script>` — reasoning about a
 * break-out that cannot happen here, since the bridge script is a separate block
 * that has already closed in `<head>`. The result was that every module with a
 * `<script>` block (which is nearly all of them) rendered its markup and then sat
 * completely inert, because the browser never saw the script close.
 *
 * Escaping is not what makes a module safe; the CSP is. And a fragment cannot
 * weaken that: additional `Content-Security-Policy` meta tags are intersected
 * with the existing policy, never loosened, so the worst a module can do to its
 * own sandbox is tighten it.
 */

export const BRIDGE_SCRIPT = `
(function () {
  var pending = {};
  var nextId = 1;

  function post(payload) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  window.__scoutResolve = function (envelope) {
    var entry = pending[envelope.id];
    if (!entry) return;
    delete pending[envelope.id];
    if (envelope.ok) entry.resolve(envelope.data);
    else entry.reject(new Error(envelope.error || 'Scout refused that call'));
  };

  window.scout = {
    call: function (method, params) {
      var id = String(nextId++);
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        post({ kind: 'call', id: id, method: method, params: params || {} });
        setTimeout(function () {
          if (pending[id]) {
            delete pending[id];
            reject(new Error('Scout did not answer in time'));
          }
        }, 20000);
      });
    },
    ready: function () { post({ kind: 'ready' }); },
    resize: function (height) { post({ kind: 'resize', height: height }); }
  };

  // Surface module errors in the app rather than losing them in the WebView.
  window.onerror = function (message, src, line) {
    post({ kind: 'error', message: String(message) + ' (line ' + line + ')' });
    return false;
  };
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    post({ kind: 'error', message: 'Unhandled promise rejection: ' + (reason && reason.message ? reason.message : String(reason)) });
  });

  // Report height so the host can size the WebView to its content.
  function reportHeight() {
    var h = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    if (h) post({ kind: 'resize', height: h });
  }
  window.addEventListener('load', function () { post({ kind: 'ready' }); reportHeight(); });
  if (window.ResizeObserver && document.body) {
    new ResizeObserver(reportHeight).observe(document.body);
  }
})();
`.trim();

function themeCss(color: Palette, scheme: 'light' | 'dark'): string {
  return `
:root {
  color-scheme: ${scheme};
  --bg: ${color.bg};
  --surface: ${color.surface};
  --surface-alt: ${color.surfaceAlt};
  --border: ${color.border};
  --text: ${color.text};
  --text-secondary: ${color.textSecondary};
  --text-muted: ${color.textMuted};
  --primary: ${color.primary};
  --primary-soft: ${color.primarySoft};
  --success: ${color.success};
  --warning: ${color.warning};
  --danger: ${color.danger};
  --accent: ${color.accent};
  --radius: 12px;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, Roboto, "Helvetica Neue", sans-serif;
  font-size: 15px;
  line-height: 1.45;
  -webkit-text-size-adjust: 100%;
}
body { padding: 14px; }
h1, h2, h3 { margin: 0 0 8px; line-height: 1.25; }
h1 { font-size: 20px; } h2 { font-size: 17px; } h3 { font-size: 15px; }
p { margin: 0 0 10px; }
a { color: var(--primary); }
button {
  font: inherit;
  color: var(--text);
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 14px;
  min-height: 40px;
}
button:active { background: var(--primary-soft); }
input, select, textarea {
  font: inherit; color: var(--text); background: var(--surface-alt);
  border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; width: 100%;
}
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px; margin-bottom: 10px;
}
.muted { color: var(--text-muted); font-size: 13px; }
.row { display: flex; gap: 10px; align-items: center; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); }
th { color: var(--text-muted); font-size: 12px; text-transform: uppercase; }
::-webkit-scrollbar { width: 0; height: 0; }
`.trim();
}

export interface WrapOptions {
  fragment: string;
  color: Palette;
  scheme: 'light' | 'dark';
}

export function wrapModuleHtml({ fragment, color, scheme }: WrapOptions): string {
  // `default-src 'none'` is what makes a module safe to run: no network, no
  // remote code, no remote images. Inline style/script are allowed because the
  // module *is* inline code that we already reviewed as data.
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Scout module</title>
<style>${themeCss(color, scheme)}</style>
<script>${BRIDGE_SCRIPT}</script>
</head>
<body>
${fragment}
</body>
</html>`;
}

/** The bridge documentation handed to the model when it writes a module. */
export const MODULE_API_REFERENCE = `
You are writing the BODY of a small web panel that runs inside the Scout mobile app.

Output rules:
- Return ONLY body content: HTML elements, plus at most one <style> and one <script>.
- Do NOT emit <!doctype>, <html>, <head>, <body>, or any <meta> tag. The app supplies those.
- No external resources of any kind. No fetch, no XHR, no CDN scripts, no remote images,
  no web fonts. A Content-Security-Policy blocks all of them and your panel will simply
  fail. Everything must be self-contained.
- No frameworks. Plain DOM APIs only. Modern JS (async/await, arrow functions) is fine.

Styling:
- Use the CSS variables the app provides so you match its theme:
  --bg --surface --surface-alt --border --text --text-secondary --text-muted
  --primary --primary-soft --success --warning --danger --accent --radius
- Helper classes already exist: .card, .muted, .row
- Never hardcode colours like #fff or black; always use the variables.
- Design for a narrow phone screen. One column. Tap targets at least 40px tall.

Data access — the ONLY way in or out:
  const result = await scout.call(method, params)

Available methods (you may use only the ones granted to this module):
  'events.read'    scout.call('events.query', { search?, from?, to?, onlyNew?, onlyStarred?,
                                               onlyDeadlines?, includePast?, limit? })
                     -> { events: [{ id, title, startsAt, endsAt, allDay, location, url, price,
                                     category, deadlineAt, deadlineLabel, confidence, isNew,
                                     starred, sourceId, sourceTitle }] }
  'stats.read'     scout.call('stats.get') -> { total, newCount, starred, deadlinesSoon, next7Days }
  'sources.read'   scout.call('sources.list')
                     -> { sources: [{ id, title, url, category, mode, enabled, lastCheckedAt,
                                      lastStatus, intervalMin, eventCount }] }
  'routines.read'  scout.call('routines.list') -> { routines: [{ id, name, kind, enabled, schedule }] }
  'events.write'   scout.call('events.update', { id, starred?, dismissed?, category? }) -> { ok: true }
  'sources.check'  scout.call('sources.check', { id }) -> { ok, newEvents, note }
  'storage'        scout.call('storage.get', { key }) -> { value: string | null }
                   scout.call('storage.set', { key, value }) -> { ok: true }
  'notify'         scout.call('notify.send', { title, body }) -> { ok: true }

Dates: startsAt and deadlineAt are ISO strings, either "YYYY-MM-DD" (no time known)
or "YYYY-MM-DDTHH:mm". Handle both. Undated events have null.

Behaviour:
- Render something useful immediately, then load data and update.
- Always handle the empty case with a short, friendly message — a new user may have no events.
- Wrap scout.call in try/catch and show the error text in the panel if it fails.
- Keep it focused: one job, done well, readable at a glance.
`.trim();
