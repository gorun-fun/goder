# Integrator AI Test Automation Guide

**English** · [中文(默认)](integration-testing.md)

> This document is for **third parties integrating goder as a base** (pages
> embedding `goder.js`, gateways deploying `goder-serve`) and the AI agents
> running their automated tests: how to test **every goder feature and
> extension point** with browser automation, without a real gh server or
> real models.
>
> Split of labor with `docs/testing.md`: testing.md is goder's own release
> self-test guide (test-serve form, real gh required); this one is
> **integrators testing their own integration** — data is injected by the
> test harness (scripted-api), zero network and zero models; runs in CI and
> by AI alike.

## 1. Harness Overview

Three layers, all exported from the embed library
(`import … from 'goder.js'`):

| Capability | Entry | What it does |
|---|---|---|
| Transport injection | `setApiFetch(fn?)` | Every API request out of core (the ORS client + `/v1/agent/*`) goes through it; inject a stand-in and the whole UI runs with zero networking |
| Programmable fake backend | `createScriptedApi()` | A gh server stand-in with the standard fetch signature: seeded sessions, SSE scripts, scenarios, error injection, request recording |
| Official harness page | `dist-embed/test-harness.html` | A full example page that tests on open with zero config; the official template for integrators building their own test pages |

Minimal usable combo (three lines):

```js
import { setKeyValueStorage, MemoryStorage, setApiFetch, createScriptedApi, configure } from 'goder.js';
setKeyValueStorage(new MemoryStorage());                    // local persistence isolation (clean on refresh)
setApiFetch(createScriptedApi().asFetch());                 // fake backend takes over every API
configure('test', { baseUrl: '/goder-api', model: 'fake/chat' });
```

Then mount panels as usual (`<goder-app-shell scope="test">`): cold start,
sessions, sending, streaming, approvals, ask, interrupt, and all six
settings sections run on the fake — the default echo scenario works with no
scripting at all.

## 2. Quick Start: test-harness.html

`dist-embed/test-harness.html` ships next to `goder.js`; open it from any
static server (same origin as the embed artifact).

**URL parameters**:

| Param | Meaning |
|---|---|
| `?api=fake` | Default. Fake backend + MemoryStorage, zero deps zero network |
| `?api=real` | Real connection (same-origin `/goder-api` gateway; `?server=` sets baseUrl) |
| `?scenario=<name>` | Initial scenario (fake mode), e.g. `?scenario=approval-pause` |

The page carries two toolbars:

- **Scenario row** (fake mode): echo / long markdown / slow stream /
  tool call / approval pause / ask pause / stream break / 5xx / fail frame /
  task block / skill block / notices — one-click switch + reset;
- **Extension row**: nav entry / side entry / settings section / tool
  display name / message renderer / send hook / approval auto-answer /
  message overrides / theming / trim events console — each toggle is an
  assertable extension-point behavior;
- **Event trail**: the toolbar's right side shows the last 8 `grf:*` events
  live (DOM-readable; AI can read event history from the page without
  attaching listeners).

**`window.goderKit`** (test surface, semantics not promised stable):

```js
goderKit.mode                                   // 'fake' | 'real'
goderKit.scenario('tool-call')                  // switch scenario (same as clicking)
goderKit.snapshot()                             // stable JSON: registry entries in all four
                                              // regions/connection state/session list/
                                              // current-session message digest/event trail
goderKit.requests()                             // RecordedRequest[] (assert outbound)
goderKit.scriptNext({ inputIncludes: 'keyword' }, frames)   // fine-grained scripting
goderKit.failNext({ inputIncludes: 'keyword' }, { status: 503, message: '…' })
goderKit.ext.toggle('nav', true)                // trigger extension toggles programmatically
goderKit.reset()                                // reload (back to a clean state)
```

`goderKit.snapshot()` returns something like:

```json
{
  "mode": "fake", "scenario": "echo",
  "registry": { "nav": ["sessions","settings"], "side": ["detail","browser","console"],
                 "bottom": ["terminal"], "settings": ["appearance","models","harness","plugins","mcp","skills"] },
  "conn": { "state": "ok", "error": null },
  "sessions": ["fc_seed_history", "fc_seed_empty"],
  "activeSession": "fc_seed_history",
  "messages": [ { "kind": "user", "text": "…" }, { "kind": "assistant", "text": "…" } ],
  "events": ["goder:round-completed {\"sessionId\":\"…\",\"ok\":true}"]
}
```

## 3. scripted-api Capability Reference

### Scenarios

Unscripted sends run the current scenario (`api.scenario(name)`; default
`echo`):

| Scenario | Behavior | Test surface covered |
|---|---|---|
| `echo` | streams the user text back in segments → completed | send/streaming/interrupt/multi-turn chains |
| `markdown` | long markdown (headings/lists/code blocks/tables) | render pipeline, code-block horizontal scrolling |
| `slow-stream` | 500ms/frame × 6 | in-process screenshots, immediate stop-button feedback |
| `tool-call` | bash tool args streaming → in_progress → completed → summary | the full tool-card lifecycle |
| `approval-pause` | tool approval pause (incomplete hang) | approval allow/deny, approval hooks; answering auto-resumes |
| `ask-pause` | ask_user_question pause | the in-composer ask form (single/multi select) |
| `stream-break` | silent cut after 3 frames (no terminal state) | stream self-healing, reconciliation (retrieveResponse) |
| `server-error` | next send 502, then back to echo | error cards, send-failure notice |
| `server-fail-frame` | in-stream response.failed terminal | the round-failure error card |
| `task-block` | reply contains a `<goder-task>` block | automation task card rendering & saving |
| `skill-block` | reply contains a `<goder-skill>` block | skill save card rendering (web form disables saving) |
| `notice-todos` | grf:notice todos/goal/phase stream | status popover, detail-panel todos |

### Fine-grained scripts (frame-level DSL)

```js
const api = createScriptedApi();
setApiFetch(api.asFetch());

api.scriptNext(
  { inputIncludes: 'error' },                    // match the next send
  [
    { delay: 50, event: { type: 'response.output_item.added',
                          item: { type: 'message', id: 'msg_1', role: 'assistant',
                                  status: 'in_progress', content: [] } } },
    { delay: 80, event: { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'part one' } },
    { delay: 80, event: { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'part two' } },
  ],                                             // non-terminal last frame auto-completes
);                                               // with response.completed
// Session-scoped queue (each send in that session consumes one group):
api.scriptConversation(convId, frames);
// One-shot error injection:
api.failNext({ inputIncludes: 'secret' }, { status: 429, message: 'rate limited' });
```

- Frames carry business fields only; common fields like
  `response.id/model/grf:session_id` are auto-filled (consistent with real
  event streams so the frontend's curRespId addressing works);
- If the last scripted frame is already a terminal event
  (`response.completed/failed/cancelled/incomplete` with `response.status`)
  it takes effect as-is, no duplicate appended;
- `requests()` returns `{method, path, body, at}[]` (rolling 500) — assert
  outbound traffic here (e.g. send-hook-rewritten text, grf:session
  pass-through);
- `state()` returns a session-archive digest (assertion/debug; field
  stability not promised);
- Protocol-face alignment is reverse-locked by
  `frontend/tests/scripted-api.test.ts`: the real `GoderClient` runs the
  full chain against the fake; client.ts path or shape drift goes red
  first.

### Seeded sessions

```js
createScriptedApi({ conversations: [
  { id: 'fc_demo', lastResponseId: 'resp_demo', history: [
      { role: 'user', content: 'a past question' },
      { role: 'assistant', content: 'a past answer' },
  ]},
]})
```

Session lists/history replay (`conversationItems` → `HistMessage[]` wire
shape) become directly testable; the frontend's `refreshConversations`
merges server sessions into the index under "ungrouped".

### Settings section data (`/v1/agent/*`)

The fake provides sensible defaults (a `fake` provider with two models,
plugin auto-discovery, two skills), `models/detect` returns rich results
(ctxLen); PUTs land in memory and read back — the settings page's
models/plugins/skills CRUD and the detect button are all testable.

## 4. Observation: Events & Assertions

### window-level events (bubbling CustomEvents, stable API)

| Event | detail | Use |
|---|---|---|
| `goder:session-selected` | `{ sessionId }` | session switch |
| `goder:session-archived` | `{ sessionId }` | session archive |
| `goder:round-completed` | `{ sessionId, ok }` | **the standard wait point for round settlement** (fired for success/failure/interruption alike; `ok` = normal completion) |
| `goder:conn-state` | `{ scope, state }` | connection state change (`checking/ok/error/unknown`) — cold start/disconnect/recovery assertions |

The recommended wait pattern for AI automation:

```js
await page.evaluate(() => new Promise((res) =>
  window.addEventListener('goder:round-completed', res, { once: true })));
```

### Assertion conventions

- **Dual-track**: behavioral assertions (DOM/events/`goderKit.snapshot()`)
  + visual assertions (screenshots, judged by the same five criteria as
  `docs/testing.md` §2.1) — DOM-only cases are incomplete;
- Lit + shadow DOM: pierce shadow roots (`el.shadowRoot.querySelector`);
  registry-driven panels live inside `goder-app-shell`;
- Prefer state assertions via `goderKit.snapshot()` (test-harness) or an
  equivalent reader on your own page; don't pierce internal fields;
- Outbound request assertions go through `api.requests()`.

## 5. Extension-Point Test Matrix

Each extension point: trigger → expectation → assertion. Directly
executable on test-harness (toolbar toggles or `goderKit.ext.toggle`); when
testing your own customizations on your own page, apply the same method to
your entries/hooks.

| Extension point | Trigger | Expectation | Assert |
|---|---|---|---|
| registry.nav entry | toggle "nav entry" | "Help center" appears in the left column; clicking switches to the host view | snapshot().registry.nav contains `host-help`; screenshot confirms highlight migration |
| registry.side entry | toggle "side entry" | a "Host metrics" tab appears showing the current session id/connection state | registry.side contains `host-metrics`; content follows session switches (kept alive) |
| registry.bottom entry | (visible once registered) | the host tab appears in the bottom dock | registry.bottom |
| registry.settings section | toggle "settings section" | a "Platform settings" group/section appears in settings | registry.settings contains `host-brand`; screenshot |
| registry.chat tool display name | toggle "tool display name" + scenario `tool-call` | the bash tool card shows the host-renamed label | tool card DOM copy |
| registry.chat renderer | toggle "message renderer" + scenario `notice-todos` | notice messages switch to the host-takeover style | message DOM contains the host marker |
| onBeforeSend hook | toggle "send hook", then send | outbound text carries the injected suffix; the echo contains it | last `requests()` body.input; echoed message text |
| onApproval hook | toggle "approval auto-answer" + scenario `approval-pause` | no approval card (or a flash); the round auto-resumes to completion | wait for `goder:round-completed {ok:true}`; no approval card DOM |
| i18n overrides | toggle "message overrides" | the "new session" button reads the override | accessible name/text |
| Theming (--goder-*) | toggle "theme" | the accent changes globally (buttons/highlights/indicators) | before/after screenshots |
| registry trimming | toggle "trim events console" | the side console tab disappears | registry.side still lists it but visible doesn't; screenshot |
| user chip / sideTop / markdown override / multi-scope | see the matching sections of `docs/embedding.md`; inject on a self-built page and assert the same way | — | — |

## 6. Testing on Your Own Page

test-harness is the template. Three steps for a self-built test page:

1. Copy the `<script>` assembly section of test-harness.html (fake,
   MemoryStorage, configure) and rename the scope to yours;
2. Add your own registry customizations/configure hooks after the assembly
   (ideally the same code as production — production pages supporting a
   `?test=1` param to switch in the harness avoids two drifting copies);
3. Expose your own `window.xxxKit` (snapshot/script/requests) for AI
   assertions.

**Web-degradation assertions for desktop-only capabilities** (no terminal/
native browser/file preview in embedded form): assert the entries are
hidden without errors (not that they exist) — consistent with the existing
convention in `docs/testing.md` §4.

## 7. Gateway Integrators (Go): FakeUpstream

Gateway deployers use `pkg/ghserver.FakeUpstream` instead of a real gh
process in Go tests: point `FixedUpstream` at it to exercise the full
gateway chain with zero binaries (routing/auth/token injection/multi-user
isolation/typed errors). See the header of `pkg/ghserver/fake.go` and the
`fake_test.go` cases.

The `Proc/Manager` full chain (real exec, port pool, idle reap) has no
HTTP-level stand-in — that's the process-management plane's job; test it
with a real gh binary (`go test ./pkg/ghserver/` covers it).

## 8. Known Boundaries

- scripted-api simulates the **protocol face**, not gh's business semantics
  (memory tools, built-in plugins, real approval policies); tests touching
  gh server behavior itself still need real gh (test-serve / manual E2E,
  see `docs/testing.md`);
- The fake's SSE has no backpressure and no real concurrency races; the
  minimal timing of slow-stream scenarios is guaranteed by frame delays —
  don't depend on precise wall-clock values, assert on event order;
- `window.goderKit` and `api.state()` are test surfaces with no stability
  promise; the official assertion surfaces are the events, the existing
  `snapshot()` fields, and `requests()`.
