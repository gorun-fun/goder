# goder Release Testing Guide (for AI Testers)

**English** · [中文(默认)](testing.md)

> This document is for **AI agents running functional and interaction tests
> against release builds of goder on target platforms** (ZCode / other
> agents). Goal: complete a systematic regression per this guide and produce
> a structured test report. Human testers are equally welcome.
>
> This document is embedded in the goder binary: the "test guide" URL in
> test-serve's startup log (`GET .../test-serve/guide?t=<token>`, with
> `X-Goder-Version` / `X-Goder-Platform` response headers carrying the
> version and platform under test) is exactly this file — no separate
> distribution with artifacts; the repo source of truth is
> `docs/testing.md`.
>
> Repo background: root `AGENTS.md`; embedding API details:
> `docs/embedding.md`; feature mapping and known limitations: `README.md`.

## 1. Test Forms & Entry Matrix

goder is one frontend running in multiple forms. **Test priority:
test-serve (the automation main battlefield) → desktop app (platform-delta
specials) → web/embed forms (regression)**.

| Form | Entry | Automation | Coverage |
|---|---|---|---|
| **test-serve** (headless test form) | `goder test-serve` | Browser automation (playwright etc.), **the AI main battlefield** | Every desktop capability except "native window/webview-only": terminal panel, config persistence, gh management, file browsing, git review, all settings sections, full chat flows, automation operators |
| Desktop app | Release .app / .exe | Manual + computer-use style tools | Window chrome/drag-resize, the side **native** browser panel, native dialogs (directory picker), auto-update, tray quit |
| Web gateway | `goder-serve` (static + `/goder-api`) | Browser automation | Pure-web behavior: localStorage persistence, agent API proxy paths, multi-user gateway |
| Embed library | `frontend/dist-embed/goder.js` host page | Browser automation | Embedder API: registry assembly, theming, event bus, shared side panels |

### 1.1 The test-serve form (important)

`goder test-serve [--port 7460]` starts a headless instance from the same
release binary (no window; the wails event loop, service startup hooks and
gh cold start all run as usual), exposing the full desktop UI to a browser
through a local HTTP server:

```console
$ goder test-serve --port 7460
test-serve ready (127.0.0.1 only, quit: Ctrl+C):
  open:       http://goder.localhost:7460/?t=<random-token>
  direct:     http://127.0.0.1:7460/?t=<random-token>
  probe:      HEAD http://goder.localhost:7460/goder-host-probe → 204
  graceful:   POST http://goder.localhost:7460/test-serve/quit?t=<token>
```

- **Always access with the full URL including the `?t=` token** (first hit
  plants an HttpOnly cookie that subsequent same-origin requests carry;
  tokenless requests get 403). On Linux where `*.localhost` doesn't resolve,
  use the 127.0.0.1 direct form — behavior is identical.
- Wait for readiness via the probe: `HEAD /goder-host-probe` returning 204
  means good to go.
- Finish with the quit endpoint for graceful shutdown (don't kill -9; let
  the gh child go through normal reaping).
- **Fidelity deltas** (vs the desktop app; see §5 for the platform matrix):
  - assets load over the local HTTP server (the same path as Windows
    production; macOS/Linux production uses the wails asset server — the
    difference is transport only);
  - the page runs in the system browser engine rather than each platform's
    WebView (WKWebView/WebView2);
  - **not testable**: the native webview browser panel (no host window; it
    falls back to iframe mode automatically), window controls/dragging, the
    native directory picker dialog, the restart phase of auto-update.
- **Data & environment notes**:
  - test-serve **shares** config, project index, and the gh server with the
    desktop app (the managed instance is idempotently adopted); goder-console
    startup stamping overwrites port/token between the two — **don't run
    test-serve and the desktop app simultaneously**;
  - the test machine needs the `gh` executable (bundled in the macOS .app;
    bare binaries need it on PATH or an absolute path configured; if
    missing, macOS/Linux auto-download silently);
  - model config reuses `~/.grf/settings.json` (`GRF_HOME` relocatable).
    Chat cases need a usable model; pure-UI cases don't.

## 2. Method Conventions

- **Dual-track assertions (core)**: every functional case = **behavioral
  assertion + visual assertion**. DOM assertions prove "it happened" (the
  button was clicked, state changed); screenshots prove "it rendered as
  expected" (the disabled state is really gray, streaming really appears
  incrementally, the layout didn't break). **Cases with DOM assertions only
  are incomplete** — UI/function divergence (click with no feedback, state
  changed but the view didn't follow, squashed layouts) is precisely what
  E2E must catch, and it's a natural blind spot of DOM assertions.
  Multimodal models must look at screenshots; visual criteria in §2.1 and
  §3.9.
- **Assertion style**: prefer DOM assertions (AI/ARIA tree, accessible
  names, element state), falling back to `evaluate` for page state (xterm
  buffers, store fields); visual assertions use screenshots (conventions in
  §2.1). The goder frontend is Lit + shadow DOM: element lookups must pierce
  shadow roots (`el.shadowRoot.querySelector`); registry-driven panels live
  inside `goder-app-shell`.
- **Terminal output assertions**: the `goder-terminal` element holds the
  `term` instance; reading
  `term.buffer.active.getLine(i).translateToString(true)` beats reading the
  DOM.
- **Before each round**: restart test-serve (fresh token, clean process);
  for data isolation use a test user account or back up
  `~/Library/Application Support/goder/` (macOS) and `~/.grf/` first.
- **Severity**: P0 blocker (crash/white screen/data loss), P1 functional
  failure, P2 usable but interaction/display anomalies (**visual
  inconsistencies default to this level or above**), P3 polish.
- **Reporting**: follow the §8 template; every case gets verdict + evidence
  (DOM assertion values + screenshots — both). Test logs go to test-serve
  stdout.
- **Known noise** (not defects): with the settings page open, the review
  panel logs `fatal: not a git repository` for non-git directories (the
  side git review polling; expected); remote update check failures (no
  network).

### 2.1 Visual Verification Standard (for multimodal models)

**Screenshot discipline**:

- **One before, one after**: for key state changes (send, switch session,
  open panel, theme switch) capture "before + after" to prove the change
  happened and in the right direction; a single result shot can't detect
  "nothing reacted at all".
- **Full page + targeted**: layout cases use full-page shots; localized
  defects (button states, card interiors, overflow) add element shots to
  pin the DOM.
- **Fixed environmental variables**: one viewport (default 1280×720;
  responsive checks vary per §3.9), one theme and font size except in
  dedicated cases; avoid accidental states like cursor hover in shots
  (hover states get their own dedicated checks).
- **Streaming/transitions**: for dynamic processes (streaming replies,
  terminal output) take one shot mid-process (proving incremental
  appearance, not one dump) and one after (proving the terminal state).

**Verdict criteria** (every screenshot must answer):

1. Layout integrity: no overlap, no clipped overflow, no misalignment;
   sensible column width ratios.
2. State visibility: loading/disabled/active/empty/error states have clear
   visual distinction.
3. Immediate feedback: post-action view changes in step with functional
   assertions (buttons, list items, indicators).
4. Consistency: the same control looks consistent across sessions/settings/
   popovers; no unreadable contrast in either light or dark theme.
5. Copy rendering: long text wraps cleanly without truncating key
   information; time/version formats uniform.

**Baseline comparison (optional enhancement)**: stable surfaces like the
settings page can keep baseline shots for pixel comparison; dynamic areas
like the chat column skip pixel diffing and answer the criteria questions
instead. Rebuild baselines on version bumps to avoid cross-engine (§5.5)
false positives.

**Boundary note**: test-serve screenshots verify layout/state/consistency
logic on the system browser engine; engine-level rendering differences of
WKWebView/WebView2/WebKitGTK (font fallback, CSS corners) are still spot-
checked per §5.5 on each platform's desktop app.

## 3. Functional Checklist

> Cases below default to the test-serve form (desktop specials in §5,
> web/embed specials in §4). ★ marks smoke-mandatory items (§7).
> **Every case carries visual verification by default** beyond the textual
> expectation: the UI effects described (highlights, panels appearing,
> rendering) must be confirmed by screenshot (§2.1 criteria); cross-cutting
> visual states (empty/error/loading/disabled/overflow/theme/viewport) are
> covered centrally in §3.9.

### 3.1 Startup & cold start

- ★ **Page load**: with the token URL opened, the full UI appears within
  10s: left column (sessions/projects), central chat (composer), top bar;
  no white screen, no error overlay.
- ★ **gh cold start**: `/goder-api/token` returns
  `{"mode":"managed","running":true,...}`; the top-bar model selector shows
  configured models; the context usage indicator has a value.
- **No-model guard**: with no model configured (empty settings.json), load
  auto-redirects to Settings → Models for guidance.
- **init diagnostics**: no init diagnostic marker in the top bar on the
  normal path.

### 3.2 Left column: projects & sessions

- ★ **New project**: click "New project" → pick/enter a directory → the
  project appears in the list and sessions belong to it; survives page
  refresh (persisted).
- **Project operations**: view files (left column switches to the file
  tree), new session (creates a draft under the project), delete project
  (confirm popover → project and its sessions disappear into archive).
- **File tree** (desktop capability): entries sorted "directories first,
  name ascending, hidden filtered"; clicking a text file opens a preview
  tab in the side dock (title = file name); image files preview as images.
  **This entry hides in web form** (no capability, no error shown).
- ★ **Session list & switching**: multiple sessions coexist; switching
  updates chat, detail and events; the current session is highlighted.
- **Session draft**: unsent input survives switching away and back; sending
  settles the draft as the session's first message.
- **Ungrouped sessions**: sessions belonging to no project land in the
  "ungrouped" group.
- **Session delete/rename**: entries work; the list updates immediately.

### 3.3 Chat panel (core)

- ★ **Send & reply**: type a message and hit Enter → user message appears →
  the model streams incrementally → state returns to sendable on
  completion; replies render markdown (headings/lists/code blocks/inline
  code/bold-italic).
- ★ **Interrupt**: clicking stop mid-stream stops immediately; rendered
  content stays.
- **Resend/copy**: assistant messages offer "copy" and "edit & resend";
  edit-resend goes through the draft-edit path.
- **Tool cards**: tool invocations render cards (name, arguments, collapsible
  results); terminal tools show the command; browser tools show the page
  snapshot entry.
- **Approval & ask**: on tool-approval cards both allow and deny work; ask
  cards feed input back.
- **Attachments**: "add image attachment" → pick an image → sent with the
  message, rendered inline.
- **Model/reasoning switch**: switch models in the top-bar selector; the
  reasoning tier takes effect on the next message.
- **Context usage**: the indicator moves with session length; warns on
  overflow.
- **Full access toggle**: toggling changes the permission mode of the next
  message (tool surface follows).
- **`/` commands**: typing `/` in the composer pops the command list;
  picking one executes it.

### 3.4 Side panels

- **Browser panel** (shared/web): default iframe mode navigates URLs,
  forward/back/reload; console & network capture being unavailable in
  iframe mode is expected (native-only, see §5).
- **Review panel** (desktop capability): under a git project shows branch,
  ahead/behind, changed files, per-line +/− stats; click a file for the
  diff. Non-git directories show an error card (the git fatal text,
  recoverable and non-blocking), not a hang.
- ★ **Terminal panel** (desktop capability, test-serve testable): open the
  bottom/side terminal → PTY established (shell prompt appears) → type
  `echo OK` + Enter → `OK` echoes → "new terminal" opens a second session →
  closing tabs/sessions leaves no stray processes.
- **File preview tab** (desktop capability, passive entry): opened from the
  file tree/chat tool cards; multiple files each get a tab; title is the
  file name; closing is clean.
- **Side dock toggle**: the "side panels" button opens/closes; tab memory
  survives session switches.

### 3.5 Settings sections (registry-assembled, six built-ins)

- ★ **Appearance**: theme (light/dark/system), accent, font size apply
  instantly; persist across refresh (localStorage mirror).
- ★ **Models**: provider list CRUD; detect models (GET /models) fills the
  list; default model selection; `~/.grf/settings.json` written correctly
  (desktop; web goes through the agent API, no plaintext keys sent down).
- **Harness**: local (managed, the process is auto-started and kept alive
  by the desktop shell — no manual start/stop) / remote (URL/token, applied
  on save) mode toggle; common gh settings (max_steps / policy) written
  correctly to `~/.grf/settings.json` (desktop via the bridge, web via the
  agent API).
- **Plugins**: the list shows built-ins (browser/computer ops, and the
  non-deletable goder-console "interface control"); auto-discovery vs
  explicit-list semantics correct; online install/delete.
- **MCP**: remote MCP entry CRUD (url/token/timeout); after save the
  settings.json plugins key has the right shape.
- **Skills**: list (~/.grf/skills), enable/disable (SKILL.md ↔ .disabled),
  create/edit/delete, install from URL; the built-in goder-auto skill
  exists and is non-deletable/non-editable.
- **Settings nav**: section navigation and grouping (Basics/Agent) correct;
  return-to-sessions entry works.

### 3.6 Desktop management & update (the former testable in test-serve)

- **gh managed keep-alive**: managed mode has no manual start/stop
  (Settings → Harness is only a local/remote toggle); the gh server is
  auto-started and kept alive by the desktop shell, recovering after
  unexpected exits; after a test-serve restart the existing gh instance is
  adopted (pid unchanged).
- **Update check**: the settings/left-column update entry triggers a check
  → shows current/latest for both goder and gh. No-update shows a clear
  notice. **The download/restart phases are desktop-app-only** (test-serve
  has no window; restart semantics don't apply).

### 3.7 Automation operators (desktop capability, test-serve testable)

- **Operator category**: the left-column "Automation" category is
  desktop-only; "add operator" creates a same-named workspace directory
  under home.
- **Operator session**: new operator session → the first message
  auto-injects system_prompt (including the full goder-auto skill) → chat
  works.
- **Task capture**: a `<goder-task>` block in the reply renders a task card
  → saved into `index.automation` (survives refresh; migrateIndex must not
  clear it).
- **Execution entry**: the status popover (status-pop) shows the automation
  task entry → clicking creates a run-variant session under that operator.
- **Skill capture**: a successful run emitting a `<goder-skill>` block →
  renders a skill save card → saves to `~/.grf/skills/<name>/SKILL.md`
  (test-serve testable; web form disables saving).

### 3.8 goder-console agent control plane (desktop capability)

> Verify with one gh session (model side) or an MCP client hitting the
> loopback 7450 port. The settings page "Interface Control" shows the
> connection state.

- `goder_terminal_*`: create/type/incremental buffer reads — consistent
  with the manual terminal.
- `goder_browser_*`: navigation/snapshot ref mechanism/click & type/console
  & network capture/screenshots (snapshot synthetic events lack
  isTrusted; behavioral differences on pages requiring trusted events are
  expected).
- `goder_ui_*`: UI actions dispatched via the `goder:console-ui` event,
  mapped by the shell (e.g. switch session/open panel); `goder_ui_state`
  reads the UI state JSON.

### 3.9 Visual-consistency specials (UI behavior × function agreement)

> A cross-cutting group: defects where the function is right but the
> presentation is wrong get caught here. Every matrix cell = screenshot +
> the five §2.1 criteria answered one by one.

**A. State visibility (every state visually distinct)**

| State | How to trigger | Visual checkpoints |
|---|---|---|
| Loading | gh cold start, model detection, history fetch | A loading indicator (spinner/skeleton); never blank, never fake-complete |
| Streaming | during model replies | incremental appearance (mid-process shot), stop button clickable, composer disabled or noting busy |
| Disabled | send with no model, save button with unwritable settings | visually grayed + cursor change, no response to clicks |
| Empty | no sessions/projects/plugins/skills; terminal closed | guidance copy and an entry point, not bare blank; consistent empty styles across sections |
| Error | send with gh down, open an invalid path | error cards/toasts styled uniformly, dismissible or retryable, not blocking other areas |
| Active/selected | current session, settings section, side tab | highlight clear and unique; the old highlight disappears on switch |

**B. Theme × viewport matrix** (one full-page shot per cell)

| | Light | Dark |
|---|---|---|
| 1280×720 (default) | ☐ | ☐ |
| 1920×1080 (wide) | ☐ | ☐ |
| 880×620 (desktop min width) | ☐ | ☐ |

- At desktop min width: the left column collapses (the "collapse sidebar"
  button); side/bottom panels don't crush or overlap the chat.
- Dark-theme specials: no jarring pure-white blocks, no dark-on-dark
  unreadable text; the accent stays distinguishable in both themes.
- Font size tiers: one shot each; no overflow or truncation (long CJK
  words, code blocks scroll horizontally).

**C. Content overflow & long content**

- Very long session titles/project names: ellipsize or wrap without
  breaking the list or top bar.
- Very long code blocks: horizontal scroll inside the block; the message
  card holds; line numbers aligned.
- Very long unbroken strings (URLs/base64): wrap or scroll without
  horizontal overflow.
- Many sessions (≥30): the list scrolls smoothly; after creating one, the
  viewport scrolls to it.
- The chat auto-follows during streaming and stops following when the user
  scrolls up (a jump-to-bottom entry appears).

**D. Instant interaction feedback (presentation in step with function)**

- At send: input clears, user message appears, button enters loading —
  all within the same frame (before/after shots).
- Switching sessions: content and title replace immediately; no ghosts, no
  white flashes.
- Opening side/bottom panels: the slide-in/appearance animation completes;
  relayout doesn't jump.
- Copy success: there is feedback (toast/icon change), not silent.
- Delete confirmations: mask, focus, Esc/mask-click close — behavior and
  visuals agree.

**E. Embedded-form visuals** (with §4.2)

- No style leakage: host CSS doesn't affect panels, panel styles don't leak
  into the host (one case each direction).
- Theming: before/after shots of changing `--goder-*` variables; every
  panel follows.

## 4. Web & Embedded Specials

### 4.1 Web gateway (goder-serve)

- After `./build.sh web` starts: log in (per identity mode); the project
  index lives in **localStorage** (survives refresh; doesn't interfere with
  desktop file persistence).
- `/goder-api` proxy path: sessions/messages/model config (agent API paths;
  no plaintext keys sent down; `hasKey` semantics correct).
- **Multi-user isolation** (header/sso): two users get independent gh
  processes (GODER_DATA/users/<uid>/), data invisible to each other; lazy
  port-pool start and idle reap.
- All desktop-only entries hidden with no errors (terminal/review/file
  preview/automation category/update).

### 4.2 Embed library

- Host page loads `frontend/dist-embed/goder.js` (ESM, zero external
  deps): renders normally, shadow DOM style self-isolation (host CSS
  doesn't affect panels).
- **Theming**: only via `--goder-*` CSS variables.
- **registry API**: hide/show/add/remove across all four regions; custom
  nav/side/bottom/settings entries registerable; the shared side panel
  persists across sessions.
- **Event bus**: `uiEvents` (shell page changes interceptable/release),
  `newProject` (embedder takes over project creation), `setProjectPath`
  (reconciliation-corrects project paths).
- **Default prompts**: project defaults' `system_prompt` and
  `default_skill` pass through via `grf:session`.
- **Test harness**: `dist-embed/test-harness.html` (fake mode) tests on
  open: 12 scenario buttons, 10 extension toggles, `window.goderKit`
  snapshot/script/requests; `goder:round-completed`/`goder:conn-state`
  waitable. The full integrator guide: `docs/integration-testing.md`.
- Details and the responsibility table: `docs/embedding.md` §5.

## 5. Platform Delta Matrix (differentiated testing)

> Single-platform testing can't guarantee cross-platform consistency; the
> root of consistency is the repo invariants (AGENTS.md) — this matrix is
> the **set of differences each platform must verify on its own**. The
> three platforms are macOS / Windows / Linux.

| # | Difference | macOS | Windows | Linux | How to test |
|---|---|---|---|---|---|
| 1 | **Asset loading path** | wails asset server (`wails:` scheme, streaming-capable) | local HTTP server (`goder.localhost`, bypassing WebView2 response buffering) | same as macOS (WebKitGTK) | Desktop: send a message and watch **incremental streaming** (not one dump at round end); test-serve uses the local HTTP path on all three |
| 2 | **Side browser panel** | custom WKWebView subview; eval via callAsyncJavaScript callbacks | WebView2 window re-parented as a child; eval reports back via fetch to `/goder-eval-report` | unsupported → iframe fallback | Desktop: navigate, console capture, network capture, screenshot each once; eval envelope format compared on both sides (changing the format requires syncing both — see the header of `internal/browser/eval.go`) |
| 3 | **Window chrome** | hidden title bar with traffic lights | frameless + frontend-drawn `.winctl` | frameless + self-drawn | Desktop: minimize/maximize/close, drag, double-click zoom, edge resize |
| 4 | **Terminal PTY** | forkpty | ConPTY | forkpty | test-serve on all three: the §3.4 terminal cases (PTY/echo/exit/multi-session) |
| 5 | **WebView engine** | WKWebView (JavaScriptCore) | WebView2 (V8/Blink) | WebKitGTK | Engine-level regression: chat SSE streaming, markdown rendering, shadow DOM layout; engine-specific defects are P2+ |

**test-serve platform notes**: macOS runs with the Accessory policy (no
Dock icon); Windows resolves `*.localhost` natively; on Linux use the
127.0.0.1 direct form if resolution fails. Running the same browser
automation flow on all three platforms is the automated part of the delta
matrix.

## 6. Dual-Form Invariants (structural checks)

- **The embed artifact has zero external deps**:
  `frontend/dist-embed/goder.js` contains no `@wailsio/runtime` import and
  no external CDN references.
- **Desktop-only modules stay out of the embed artifact**:
  terminal/review/file-view never appear in dist-embed.
- **Registry assembly**: built-in panels all register through the registry;
  chat-panel/app-shell hardcode no panel types (code review).
- **DTO sync**: `internal/desktop` service DTOs match the interfaces in
  `frontend/src/host/bridge.ts` (code review).
- **Version comparison shares one semantic across three sites** (release
  related): `compareVersion` / `version.sh`'s `ver_max` / CI bundling logic;
  verify with the matrix cases (alpha/beta/rc/final/postN/cross-baseline).

## 7. Smoke List (10 minutes per platform)

1. ★ test-serve starts → probe 204 → open the token URL, UI intact.
2. ★ gh cold start running:true; the model selector has values.
3. ★ Create a session, send a message, streaming renders, interrupt works;
   **one shot mid-process and one after** (incremental appearance, correct
   terminal state).
4. ★ Switch/create sessions, state follows; **before/after shots**
   (highlight migrates, no ghosts).
5. ★ Terminal panel: PTY up, `echo OK` echoes, exit.
6. ★ Settings → Appearance: theme/font size instant; Settings → Models:
   list and detection fine; **one full-page shot per theme** (§3.9.B).
7. ★ Visual sweep: run the §2.1 five criteria over a full-page shot of the
   default UI (layout/state/consistency/contrast).
8. ★ Desktop app (one each of macOS/Windows/Linux): app starts, window ops
   (§5.3), native browser panel navigates (§5.2), update check error-free.

## 8. Test Report Template

```markdown
# goder release test report
- Date / version / platform (with OS version) / test form / model config / viewport & theme

## Summary
- Pass X / Fail Y / Blocked Z (P0 n · P1 n · P2 n · P3 n)

## Smoke list
| # | Case | Result | Evidence (DOM + screenshot) |

## Functional cases (§3.1–§3.8)
| Group | Case | Behavioral assertion | Visual assertion | Result | Evidence |

## Visual consistency specials (§3.9)
| Matrix cell (state/theme×viewport/overflow/feedback) | §2.1 verdicts | Screenshot |

## Platform delta matrix
| # | Difference | Result | Notes |

## Defect list
| ID | Severity | Module | Steps | Expected | Actual | Evidence (screenshot/DOM/log) |

## Environment notes
(gh version, model, abnormal network conditions, data state)
```
