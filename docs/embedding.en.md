# Web Embedding Guide

**English** · [中文(默认)](embedding.md)

Embed grf-harness's session list / chat / detail panel / event console into
your own web app. Aligned with "bare grf-harness choosing which tools to
enable": the four UI assembly regions (left nav, side tabs, bottom tabs,
settings sections) are all assembled through the **registry** — built-in
entries and your custom entries share one API and can be added, removed, or
trimmed freely.

## 1. Loading

```html
<script type="module" src="/path/to/goder.js"></script>
```

`goder.js` is a self-contained ESM (shadow DOM style isolation: it pollutes
neither the host's styles nor the reverse — apart from the `--goder-*`
variables). Importing registers all generic panels and built-in entries.

## 2. Connection Configuration

```js
import { configure } from '/path/to/goder.js';
configure('myscope', {
  baseUrl: '/goder-api',   // gh server root (without /v1); same-origin gateway recommended
  token: '…',            // optional: Bearer token for direct gh server connections;
                         // injected server-side in multi-user gateway mode, leave empty
  model: 'deepseek/deepseek-chat', // optional: default model; must be the full
                         // provider/model name (bare names get expanded from the
                         // provider table; if unresolvable it's treated as unset and
                         // the server default applies — gh only accepts full names
                         // and silently ignores bare ones)
  auth: {                // optional: handling for logged-out (401) on the gateway
    loginUrl: '/goder-api/auth/login', // redirect to the login entry
    // or onUnauthorized: (scope) => { … }  // host-custom (no auto-redirect once set)
  },
  policySelector: false, // optional: false hides the composer policy selector
                         // (when the embedder manages session policy entirely
                         // via project defaults)
  settings: {            // optional: settings-page trimming
    agentGroup: false,   // false = hide the "Agent" group (Harness/plugins/MCP/
                         // skills — read-only guidance in browser form, when the
                         // platform doesn't open management)
  },
  user: {                // optional: identity chip at the bottom of the left
    name: 'Alice',       // column (for embedders with their own user system;
    detail: 'alice',     // shows the system username/"local user" when absent)
                         // optional: hover tooltip extra (e.g. uid)
    panel: (ctx) => {    // optional: when given, the chip becomes clickable and
      const el = document.createElement('div'); // pops a host-drawn user panel
      el.textContent = 'host-drawn user panel (profile / logout etc.)';
      return el;
    },
    chevron: false,      // optional: false removes the chip's trailing chevron
    hit: 'content',      // optional: 'content' shrinks the clickable/hover area
  },                     // to icon+name (default 'full' = whole row)
  sideTop: {             // optional: inject into the left column top row (the
    leading: () => {     // row holding the collapse button)
      const el = document.createElement('button'); // host elements (leading =
      el.textContent = '⌂'; // row start, trailing = row end; elements render
      return el;         // inside the shell's shadow DOM, styles must be inline,
    },                   // kept alive across re-renders)
  },
  sessionDefaults: {     // optional: grf:session fallback for projects without
                         // defaults / ungrouped sessions (system_prompt/
                         // host_context/default_skill/policy etc.; expanded
                         // before project defaults when a draft settles and
                         // overridden by them field by field — projects with
                         // defaults are unaffected; not persisted, the host
                         // re-delivers on every load)
    system_prompt: '…',  // the custom section (identity + working style; gh's
                         // built-in tool docs are always appended)
    host_context: 'You run on platform X, current user …, tools xx_* available…',
                         // host environment brief (gh ≥ host_context versions):
                         // a separate section appended after system_prompt and
                         // before built-in tool docs — the host communicates
                         // "which host am I in / who is the user / which
                         // host-specific tools exist" without taking over the
                         // whole identity prompt. Older gh ignores the field,
                         // harmless. Applies on session creation only.
    default_skill: 'grf-start', // default skill injected in full (if present)
  },
  ungroupedSessions: false, // optional: false forbids ungrouped sessions —
                         // sending with no active session rebinds to the most
                         // recently used project, and the "ungrouped sessions"
                         // group is no longer rendered
  disableDefaultPrompt: true, // optional: fully disables goder's default
                         // identity prompt (left empty when neither
                         // sessionDefaults nor project defaults provide
                         // system_prompt — gh's server default takes over;
                         // for embedders that fully manage identity)
  onBeforeSend: (p) => {  // optional: send hook — called before the user's
    if (banned(p.text)) return null; // message leaves the composer. Return null
    return { ...p, text: p.text + RAG }; // to cancel (input stays), or a
  },                      // rewritten payload to send. Outbound audit / RAG
                          // injection / sensitive-word filtering / rerouting
  onApproval: (req) => {  // optional: approval hook — called when a tool
    if (req.toolName === 'bash' && trusted(req.input)) {
      return { approved: true }; // returning a decision auto-answers (background
    }                     // sessions are taken over too)
    return null;          // returning null falls back to the default approval
  },                      // card for the user to handle manually
  markdown: (text) => renderRich(text), // optional: override the message
                         // stream's markdown renderer (swap in marked or
                         // another rich engine; outputs an HTML string — the
                         // override owns escaping and safety)
  locale: 'en',          // optional: i18n target language (marker)
  messages: {            // optional: message overrides (keys are the Chinese
    '新会话': 'New chat', // defaults, {x} interpolation supported)
    '连接中断({err}),自动重试 {a}/{m}': 'reconnecting ({err}) {a}/{m}',
  },
  statusPop: false,      // optional: false hides the status popover at the top
                         // right of the chat column (goder's automation task/
                         // git/goal cards)
  persistToken: true,    // optional: only when true is the connection token
                         // persisted to local storage (default: never written,
                         // the host delivers it every time — see auth model)
});
```

Precedence: JS `configure` > element attributes > remembered localStorage.
Declarative attributes:

```html
<goder-chat scope="myscope" server="/goder-api"></goder-chat>
```

Users can also configure manually in the connection area at the bottom of
`<goder-session-list>` (stored in localStorage).

**Auth model (important)**: in same-origin gateway mode the browser only
needs the gateway's login session (cookies ride along automatically); each
user's gh token is injected by the gateway when forwarding and **never sent
to the browser**. `token` is only used when connecting directly to an
external gh server.

## 3. Panel Catalog

| Element | Description | Common attributes |
|------|------|----------|
| `<goder-session-list>` | Project-scoped session list: grouping/new/rename/archive; blue dot = unseen finished round | `no-connection` hides the bottom connection area |
| `<goder-chat>` | Chat: message stream + tool cards + ask forms + approval cards + composer; the side column is tabbed (entries per registry.side) | `no-header` `no-composer` |
| `<goder-session-detail>` | The side "detail" panel itself: overview/usage/tool timeline/Todo/meta | — |
| `<goder-review>` | git review: branch/ahead-behind/file grouping + inline diffs (needs desktop capabilities; placeholder in pure web) | `.cwd` |
| `<goder-browser>` | Embedded browser: address bar + iframe, last URL remembered per scope | — |
| `<goder-console>` | Event stream log (all SSE events + system messages) | `filter="all\|events\|problems"` |
| `<goder-app-shell>` | The full layout above (left nav + dark rounded workcard, collapsible/resizable regions) | `panels="sessions,chat,sidebar,console"` `layout="sidebar=false"` `nav="sessions"` |

Common attributes on all panels: `scope` (data domain, default `default`),
`server`, `token`. The side/bottom docks are standalone elements
(`<goder-side-dock>`/`<goder-bottom-dock>`, assembled by
`<goder-app-shell>`; usable separately when the host builds its own layout):
when `panels` excludes `chat`, the docks still work (the "center isn't chat,
sidebar has tool panels" shape).

```js
import { GODER_UI_VERSION } from '/path/to/goder.js';
GODER_UI_VERSION; // '0.1.0' — same-source version constant of the artifact,
                  // for feature negotiation before upgrading
```

`dist-embed/types/` contains the full TypeScript artifacts (`goder.js` +
`entries/embed.d.ts` and its dependency closure); TS projects get every
`configure` option and hook signature by importing via relative path.

## 4. registry: UI Customization (the core extension point)

Four regions, each an entry collection (`add/remove/hide/show/items/visible`):

- `registry.nav` — left column nav views (built-in: `sessions`, `settings`)
- `registry.side` — side tabs (built-in: `detail` `browser` `console` `review`
  `terminal` `file`; the latter three desktop-only)
- `registry.bottom` — bottom tabs (built-in: `terminal`, desktop-only)
- `registry.settings` — settings sections (built-in: `appearance`, `models`,
  and the agent group `harness` `plugins` `mcp` `skills`)

### Trimming built-in entries

```js
registry.side.hide('console');   // hide the events console
registry.nav.hide('settings');   // hide settings (host manages config)
registry.side.show('console');   // restore
```

### Adding custom entries

```js
// html/nothing are exported from the embed library (the same lit html tag
// internals render with, zero extra deps); entries returning HTMLElement
// don't need them.
import { registry, html } from '/goder.js';

// Left nav: a view + optional center workarea override (default = chat)
registry.nav.add({
  id: 'help',
  label: 'Help',
  order: 50,                        // sort weight; built-in sessions=10/settings=90
  view: (ctx) => html`<my-help-panel user=${ctx.store}></my-help-panel>`,
  // center: (ctx, state) => html`…`,  // optional: what the center shows when
  //                                    // this nav is active
  // fullView: true,                   // optional: full-width view — collapses
  //                                    // side/bottom docks while active (state
  //                                    // remembered and restored); the left
  //                                    // column stays collapsible (built-in
  //                                    // settings uses this form)
});

// Side tab: render returns a template or HTMLElement (HTMLElement survives
// tab switches)
registry.side.add({
  id: 'metrics',
  label: 'Metrics',
  icon: '<svg …>…</svg>',           // inline svg string
  width: 360,                       // default width (user-resizable)
  render: (ctx) => html`
    <div>current session: ${ctx.sessionId ?? '(none)'}</div>
    <div>connection: ${ctx.store.connState}</div>`,
});
// Multi-instance tabs (one independent tab per key, like the built-in
// files tab):
registry.side.add({
  id: 'doc', multi: true,
  titleFor: (key) => key,
  render: (ctx, key) => html`<my-doc doc=${key}></my-doc>`,
});

// Bottom tab: a fresh instance element per opened tab (stateful content)
registry.bottom.add({
  id: 'logs',
  label: 'Logs',
  icon: '<svg …>…</svg>',
  create: (ctx) => document.createElement('my-log-view'),
});
```

### Custom settings sections (registry.settings)

The settings page (left section nav + central section page) is isomorphic to
the other three regions: built-in sections are registry entries too — third
parties can add their own sections and draw their own pages, or trim or
override built-ins.

```js
registry.settings.add({
  id: 'brand',
  label: 'Platform Settings',
  group: 'Platform',   // left-column group heading; defaults into "Extensions".
                       // The built-in group names "Basics"/"Agent" can be
                       // reused (merged into them)
  order: 15,           // sort weight (built-in: appearance 10 / models 20 /
                       // Harness 30 / plugins 40 / MCP 50 / skills 60);
                       // default appends after built-ins
  wide: true,          // optional: wide canvas for the section page (880px,
                      // default 620px)
  icon: '<svg …>…</svg>', // optional; generic settings icon when absent
  render: (ctx) => html`<div>…your section page…</div>`,
});
```

- `render` templates are rebuilt per render; returning an **HTMLElement keeps
  it alive across section switches** (good for stateful controls); pages live
  inside shadow DOM where host styles can't reach — use inline styles, and
  reuse the inherited `--goder-*` variables for colors
- `ctx` is a `PanelContext` (no session context in settings views:
  `sessionId` is empty, `shell` undefined; `desktop` for form-factor
  degradation)
- **Overriding built-ins**: re-`add` with the same id replaces it wholesale
  (e.g. `id: 'appearance'` with a custom `render` swaps the built-in
  appearance page)
- **Trimming**: `registry.settings.hide('models')` hides built-in or custom
  sections (automatically falls back to the first visible section when the
  current one is hidden), `show` restores
- `visible(ctx)` for context-dependent visibility

**PanelContext** (the render argument): `scope` (data domain name), `store`
(the scope's shared data domain: sessions/event stream/connection state, see
the `GoderScope` type), `sessionId` (current session), `desktop` (wails
desktop or not), `shell` (layout state when assembled inside app-shell: side
column expanded / desktop traffic lights / toggle callbacks; undefined when
embedded standalone).

**Switching nav**: `<goder-app-shell>` exposes a `navTo(id)` method and an
`activeNav` attribute, and accepts the bubbling `goder-nav-activate` event
(detail = nav id). Nav views can push state up via `goder-nav-state`
(detail = `{ nav?, state }`) — the built-in settings section uses this.

### Entry scope ownership (the scopes field)

The registry is a global singleton; multiple scope instances on one page
share entries by default. Entries may declare `scopes: ['app']` to be visible
only under those scopes (orthogonal to the `visible(ctx)` guard), enabling
"two embed instances on one page each assembling their own panel set":

```js
registry.side.add({ id: 'game', label: 'Game', icon: svg, scopes: ['play'], render: … });
```

### Chat content customization (registry.chat)

Render extensions at the message layer (the four shell regions solve "where
and what to place"; this solves "what the message itself looks like"):

```js
import { registry, html } from '/path/to/goder.js';

// ① A dedicated card for your own tools: takes over tool item rendering by
//    tool name (string or regex)
registry.chat.addRenderer({
  id: 'mine',
  toolName: /^mcp__mine__/,
  render: (it, ctx) => {
    if (it.kind !== 'tool') return undefined; // conditional takeover:
                                              // undefined falls through to built-in
    const el = document.createElement('div');
    el.textContent = 'my tool card: ' + it.name;
    return el; // HTMLElement or lit template; nothing/empty template = skip
  },
});

// ② Tool display knowledge: name → localized label + primary-argument /
//    detail extraction (shared by tool cards and the stream)
registry.chat.addToolMeta({ name: 'mcp__mine__query', label: 'Knowledge search' });

// ③ Unknown-kind fallback: built-ins now render a generic notice card (no
//    longer silently dropped); renderers can fully customize by kind
registry.chat.removeRenderer('mine'); // same id overrides/removes
```

Markdown renderer overrides go through `configure({ markdown })` (per-scope);
the built-in `renderMarkdown` remains exported for host reuse.

### Registry scope of effect

The registry is a global singleton: all scope instances on a page share entry
definitions; data is isolated per scope. An entry's `visible(ctx)` can
dynamically show/hide (built-in entries use it for desktop-capability
degradation).

### Identity area injection (bottom-left user chip)

The identity area at the bottom of `<goder-session-list>` /
`<goder-settings-nav>` is rendered by `<goder-user-chip>`. Embedders with
their own user system (SSO etc.) inject a display name via
`configure(scope, { user })`; with `panel` given, the chip becomes clickable
and pops a host-drawn user panel above it (profile / logout etc.), closing on
outside click or Esc. The panel element renders inside the chip's shadow DOM
where host styles can't reach — inline styles; reuse the inherited
`--goder-*` variables; returned HTMLElements survive toggles. `user.panel`
receives the same `PanelContext` as side tabs (no session context, empty
`sessionId`). `user.chevron:false` removes the trailing chevron (default
true); `user.hit:'content'` shrinks the clickable/hover area to the
icon+name block (default `'full'` row). Popup width is content-driven: never
narrower than the chip row; the host panel can widen itself with `min-width`
(cap 420px / 90vw).

### Left-column top row injection (sideTop)

`configure(scope, { sideTop: { leading, trailing } })` injects host elements
into the left column's top row (`.side-top`, where the collapse button
lives): `leading` renders before the collapse button (row start), `trailing`
at the row end. Elements render inside the shell's shadow DOM (host styles
can't reach, inline styles required), survive re-renders, and are discarded
and rebuilt on config changes; the row stays as-is when unconfigured.
Typical use: the embedding platform puts a "back to my site" button in the
top-left corner.

### Settings page trimming & customization

The settings page's "Agent" group (Harness/plugins/MCP/skills) and the
"Models" provider management read/write via gh server's `/v1/agent/*`
configuration API in web form (newer gh required; API keys/MCP tokens are
masked — plaintext never sent down, empty = keep). The multi-user gateway
injects `GRF_HOME` per user by default
(`<data>/users/<uid>/grf-home`), so config is fully isolated per logged-in
user; `GODER_USER_HOME=0` disables, `GODER_SETTINGS_SEED` points at the
initial settings.json seeded on first user start (one-time snapshot,
independent afterwards). On too-old gh or without isolation these sections
fall back to guidance text; when the platform doesn't open management you
can still hide the whole group via
`configure(scope, { settings: { agentGroup: false } })`. Adding custom
sections and overriding/hiding built-ins: see "Custom settings sections"
above.

## 5. Server Side: the goder-serve Gateway

Browsers cannot talk to gh server directly (no CORS headers). Two options:

1. **Same-origin gateway (recommended)**: deploy `cmd/goder-serve` (or put
   the same logic in your backend/gateway): static hosting of the frontend
   plus the `/goder-api` reverse proxy.
2. Add CORS to gh server (not recommended — SSE needs headers too, and the
   token is exposed to the browser).

`goder-serve`'s core capability is **multi-user isolation: one gh server
process per user** (dedicated port pool 17400-18400, dedicated data dir
`<GODER_DATA>/users/<uid>/server-data`), with user tokens injected by the
gateway. Identity mode via `GODER_IDENTITY`:

### single (default, local tinkering)

Everyone shares one process (uid=`local`); with `GODER_UPSTREAM` set it
becomes a direct proxy to an external gh server (no managed process, browser
carries the token — the minimal legacy deployment).

```sh
GODER_DATA=./goder-web-data ADDR=127.0.0.1:7700 go run ./cmd/goder-serve
```

### header — integrated into another app (e.g. game-web)

Your app does its own login (SSO); **your backend** proxies `/goder-api` to
this gateway and injects a trusted user header. The gateway resolves the
user from the header and routes to that user's dedicated gh process.

```
browser ──cookie──▶ your app backend (game-web)
                      │ proxy /goder-api + inject X-GRF-UID: <user id>
                      ▼
                 goder-serve (GODER_IDENTITY=header)
                      │ uid → dedicated gh server (port pool + own data dir)
                      ▼
                 gh server ×N
```

```sh
GODER_IDENTITY=header GODER_UID_HEADER=X-GRF-UID ADDR=127.0.0.1:7702 \
  GODER_DATA=/srv/goder-web GODER_IDLE_TTL=30m go run ./cmd/goder-serve
```

Self-check endpoints: `GET /goder-api/whoami` returns the resolved user and
backend process address; `GET /goder-api/healthz` gateway liveness;
`GET /goder-api/healthz/ready` readiness probe (gh binary resolvable;
processes start lazily per user).

**Ops plane (optional, enabled by `GODER_ADMIN_TOKEN`)**:
`GET /goder-api/admin/statuses` returns all user process states (headless
monitoring / a programmatic entry for third-party backends);
`POST /goder-api/admin/start?uid=<user>` idempotently starts the user's
process (returns as-is if running; 503 during crash cooldown);
`POST /goder-api/admin/stop?uid=<user>` reaps it;
`POST /goder-api/admin/restart?uid=<user>` stops then starts (for config
changes or wedged processes; the port changes, the data dir doesn't).
Auth: `Authorization: Bearer <GODER_ADMIN_TOKEN>`.

**Webhook (optional, `GODER_WEBHOOK_URL`)**: user process lifecycle events
(`proc.started`/`proc.stopped`/`proc.crashed`) POSTed to your backend (body
carries `type/uid/addr?/reason?/ts`; best-effort delivery). With
`GODER_WEBHOOK_SECRET` set each callback carries an HMAC-SHA256 signature
header `X-Goder-Signature: sha256 <hex(body)>` (mandatory for public/
cross-trust-domain callbacks; verify with a constant-time comparison).

**Turn-level events (optional)**: gh child processes support
`GRF_TURN_WEBHOOK_URL` / `GRF_TURN_WEBHOOK_SECRET` — when a background turn
settles it POSTs `turn.settled` (carrying
session_id/response_id/status/model/usage, HMAC signature header
`X-GRF-Signature`), turning host headless tasks (background orchestration)
from polling into event-driven. Pass through via the `GODER_GH_ENV_<KEY>`
environment variables, e.g. `GODER_GH_ENV_GRF_TURN_WEBHOOK_URL=…`.
In-browser sync/SSE sessions keep consuming SSE, unaffected.

**Other gateway environment variables**: `GODER_CORS_ORIGINS`
(comma-separated Origin allowlist, exact match + credentials allowed,
takes precedence over `GODER_CORS` wildcard mode), `GODER_ACCESS_LOG=1`
(structured request log), `GODER_SESSIONS_FILE` (sso session file
persistence, survives restarts), `GODER_WEBHOOK_URL`,
`GODER_WEBHOOK_SECRET`, `GODER_ADMIN_TOKEN`, `GODER_GH_ENV_<KEY>` (extra
env for every gh child). Gateway responses uniformly carry
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
Gateway errors are typed: capacity (user cap / port exhaustion) 429,
process not-ready / start failure / cooldown 503, others 502.

**Security constraint**: header mode trusts request headers — the gateway
port must only accept traffic from your backend (intranet/localhost/
firewall); never expose it to the public internet directly.

### sso — the complete standalone solution

The gateway does its own Casdoor OAuth2 authorization-code login (modeled
on game-web's flow, independently implemented, no database):
`/goder-api/auth/login | callback | logout | me`, issuing opaque random
local sessions (HttpOnly cookie, in-memory table by default;
`GODER_SESSIONS_FILE` enables file persistence — restart-safe, single
instance). The `AUTH_DEV_EMAIL` dev backdoor is for local development only.

```sh
GODER_IDENTITY=sso \
  SSO_ENDPOINT=https://sso.example.com \
  SSO_CLIENT_ID=… SSO_CLIENT_SECRET=… \
  SSO_REDIRECT_URL=https://app.example.com/goder-api/auth/callback \
  COOKIE_SECURE=1 ADDR=:7700 go run ./cmd/goder-serve
```

Frontend redirect when logged out:
`configure('scope', { baseUrl: '/goder-api', auth: { loginUrl: '/goder-api/auth/login' } })`.

### Responsibility split (this project vs. yours)

| Responsibility | Owner |
|------|------|
| User system, SSO login page, roles/permissions | **Yours** (game-web: Casdoor + own sessions) |
| Mapping logged-in users to a stable uid + injecting a trusted header | **Your backend** |
| uid → isolated gh process, token injection, lifecycle (lazy start/idle reap/caps) | **This project's gateway** |
| Frontend panel embedding, registry customization, scope data isolation | **This project's embed library** |
| The complete login flow for standalone deployments (Casdoor sso mode) | Provided by this project, optional |

### Host administration plane (declarative integration, PerUserHome layout)

Beyond process ops (statuses/start/stop/restart), `GODER_ADMIN_TOKEN` opens
a set of **declarative endpoints** under `/admin/*` — capabilities that
embedders (openos-style desktop hosts) previously had to implement by
writing goder's private files directly (serve-data layout, the settings.json
multi-writer protocol, wrapper reverse-parsing) are now expressed through
APIs, with directory knowledge converged back into this project.

> **Security boundary**: the AdminToken is equivalent to code execution on
> the server (plugin wrappers installed through it are executed by gh as
> that user). Keep it on internal/trusted networks, use a long random value,
> never in URLs or frontend code.

- **Managed provider declarations** `PUT /admin/users/{uid}/providers`
  `{entries:[{name,base_url,api_key,models}], managed:[all names],
  default:"P/m"|"", force_default:bool}`. Entries inside the managed set
  are upserted faithfully, previously-declared-but-now-absent ones are
  removed, names outside the declaration are untouched; the default model is
  written per the decision chain (force / currently empty / currently
  pointing at a managed entry) without fighting the user's own choice;
  nothing is written when content is unchanged. For users who never opened
  goder, the directory is created and seeded directly (ahead of seeding and
  gh's first start). Companion `GET /admin/users/{uid}/providers` returns
  the settings.json fingerprint and managed names (for idempotent caching
  on the request path).
- **managed:true injection (automatic)**: for users with declared managed
  names, the gateway injects `managed:true` into their
  `GET /v1/agent/models` proxied response (the embedding convention for
  "platform-managed read-only" semantics — embedder reverse proxies no
  longer need to rewrite responses).
- **Bare model-name resolution** `GET /admin/users/{uid}/resolve-model?name=`
  → `{status: ok|no_default|not_found|ambiguous|unreadable, resolved?,
  candidates?}`. Resolution order matches gh's `config.ResolveModel`
  (default provider first → exactly one hit; ambiguity is reported honestly,
  never silently picked); error copy is synthesized by the host.
- **Host stdio plugins** `POST /admin/plugins/install`
  `{uid, name, command:[full argv]}` (auto-discovery mode writes a wrapper /
  explicit-list mode upserts the command entry, preserving the "no plugins
  key = auto-discovery" semantics), `GET /admin/plugins` (listing,
  **returns the original uid** — directory-name sanitization is
  irreversible; legacy self-healing no longer parses wrappers),
  `DELETE /admin/plugins?uid=&name=`.
- **Session grouping index**: `GET|PUT /admin/users/{uid}/index`
  (whole read/write) + `POST /admin/users/{uid}/index/sessions`
  (faithfully appends a session to a grouped project; read-modify-write
  under one server-side lock); the browser embed uses the **user-level
  endpoints** `GET|PUT <prefix>/index` (identity as auth). Field shape
  matches the frontend ProjectsIndex; unknown keys (automation etc.) are
  preserved — hosts no longer need their own server-side mirror.
- **User directory lifecycle**: `GET /admin/users` (overview of all user
  directories including offline ones), `DELETE /admin/users/{uid}` (stop
  process + remove directory, for account-deletion cascades).

All endpoints require the PerUserHome layout (the shared `~/.grf` form is
rejected with 409).

## 6. Scopes: multiple instances per page

Panels with the same scope share: the current session, run state, event
stream, console log. Different scopes are independent (own connection
config, project index, sessions).

```html
<goder-session-list scope="ops"></goder-session-list>
<goder-chat scope="ops"></goder-chat>
```

Scope lifecycles are managed automatically by panels: mounting holds a
reference; when the last panel disconnects the scope is reaped after a 30s
delay (polling timers cleared, instance released; remounting during the
delay cancels it). Hosts creating/destroying many scope instances
dynamically can also hold references manually:
`acquireScope(name)` / `releaseScope(name)` (stacks with the panels' own
counting). Reaping keeps no run state: in-flight rounds finish in the old
instance; after a rebuild the client re-aligns from the server's session
list; connection config injected via `configure` (including unpersisted
tokens) survives rebuilds.

## 7. Events (host listening)

Panels dispatch bubbling CustomEvents to the page:

| Event | detail |
|------|--------|
| `goder:session-selected` | `{ sessionId }` |
| `goder:session-archived` | `{ sessionId }` |
| `goder:round-completed` | `{ sessionId, ok }` — terminal round state (fired for success/failure/interruption alike; `ok` = normal completion); the standard wait point for stream settlement |
| `goder:conn-state` | `{ scope, state }` — connection state change (`checking/ok/error/unknown`) |

```js
window.addEventListener('goder:session-selected', (e) => {
  console.log('session selected', e.detail.sessionId);
});
```

## 8. Theming

Settings → Appearance → Theme offers **dark / light / follow system**
(stored in localStorage, mirrored on the first `configure()` call). "Follow
system" resolves light/dark by these priorities, following changes live:

1. An explicit theme class on the host page root (`dark` / `light` on
   `<html>` or `<body>`; the Tailwind class convention);
2. The openos host (detects `window.OpenOS`): dark if `html.dark` was
   already matched above, otherwise light — i.e. it follows the openos
   desktop's light/dark setting;
3. The browser/system `prefers-color-scheme` (the follow channel for the
   wails desktop and pure web forms; tracks system switches).

Hosts can also take over theming entirely by overriding variables:

```css
:root {
  --goder-bg: #101014;         /* background */
  --goder-accent: #e05d27;     /* accent */
  --goder-font-size: 14px;     /* font size */
  /* full list in the theme block of frontend/src/ui/theme.ts */
}
```

## 9. Behavior Details

- **Sending**: Enter sends, Shift+Enter newline; image paste/pick supported
  (data-URL multimodal); while a round runs, the input area switches to
  "stop"
- **Pause & answer**: `ask_user_question` or tool approval pauses the round;
  the question expands **inside the bottom composer** — single-select
  submits on click, multi-select on submit; tool approval is a chat card.
  Answering resumes automatically (chained `grf:input_result`); reopening a
  paused session restores the pending UI
- **Edit & resend**: hovering a user message shows copy/edit; "resend" after
  editing **truncates history at that message** before sending (requires
  gh server's `grf:history` prefix-rewrite extension)
- **Stream self-healing**: on SSE interruption the client reconciles against
  the server's terminal state (watchdog as backstop); hosts don't handle it
- **Persistence**: project index & session grouping live in localStorage
  (key `goder:<scope>:index`); connection config in `goder:<scope>:conn`.
  Hosts can clear these keys to "reset"
- The repo's demo page `frontend/embed-demo.html` has complete registry
  trim/add examples; the test harness page `dist-embed/test-harness.html` +
  `setApiFetch`/`createScriptedApi` drives every UI flow for AI test
  automation with zero networking — see `docs/integration-testing.md`
