# Goder

**English** · [中文(默认)](README.md)

A ZCode-style GUI for [grf-harness](https://git.gorun.fun/share/grf-harness) (gh):
one frontend, three form factors — a native desktop app, embeddable web components
for any page, and a multi-user web gateway. AI conversations, tool calls, a
project terminal, git review, and a built-in browser live in one workbench;
everything talks to gh through `gh server` (ORS, compatible with the Responses
API).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) ![Go](https://img.shields.io/badge/Go-1.26-00ADD8) ![Lit](https://img.shields.io/badge/Lit-3-324fff) ![wails](https://img.shields.io/badge/wails-v3%20beta-00b8c8)

```
┌─────────────┬──────────────────────────────┬────────────┐
│ Projects    │  Session     [idle] term side│ Detail Rev+│
│ ├ demo      │  ┌────────────────────────┐  │  overview  │
│ │  · chat A │  │ you: use bash …         │  │  usage     │
│ │  ● chat B │  │ ▸ bash ✓ ls -la         │  │  tool      │
│ ├ ungrouped │  │ assistant: output …     │  │  timeline  │
│ └─ + new    │  └────────────────────────┘  │            │
│ ●connected ⚙│  [ input                send ]│            │
├─────────────┴──────────────────────────────┴────────────┤
│ wenjun@mac goder-proj-test % …    (built-in terminal)   │
└──────────────────────────────────────────────────────────┘
● The blue dot before "chat B" = an unseen finished round
  (cleared on click); running sessions show a spinner.
```

## Contents

- [Three Form Factors](#three-form-factors)
- [Quick Start](#quick-start)
- [Highlights](#highlights)
- [Configuration](#configuration)
- [Security](#security)
- [Project Structure](#project-structure)
- [Contributing](#contributing)

Deep-dive guides live in [`docs/`](docs/README.en.md): [Desktop App](docs/desktop.en.md) · [Deployment](docs/deploy.en.md) · [Security](docs/security.en.md) · [Web Embedding](docs/embedding.en.md) · [Automated Testing](docs/testing.en.md) · [Integration Test Harness](docs/integration-testing.en.md)

## Three Form Factors

| Form | What it is | Entry |
|------|------|------|
| **Desktop app** (wails v3) | An installable native app: project-scoped session list + chat + side tabs (detail/review/terminal/browser/files/events) + a bottom project terminal; manages its own `gh server` child process | `./build.sh app` → `dist/goder.app` |
| **Web embedding** | Sessions / chat / detail and more as standalone web components for any page; nav, side/bottom tabs, and message rendering are all customizable through the registry; send & approval hooks can intercept outbound messages and decisions; i18n message overrides | `frontend/dist-embed/goder.js` (ESM, zero external deps) |
| **Multi-user web gateway** | `cmd/goder-serve`: static hosting + `/goder-api` per-user routing — **one dedicated gh server process per logged-in user** (own port and data dir; the token is injected by the gateway, never sent to the browser) | `./build.sh web` |

## Quick Start

```sh
./build.sh          # frontend + desktop binary ./goder
./build.sh app      # assemble dist/goder.app (macOS)
./build.sh embed    # build only the embeddable library
./build.sh web      # pure web form (http://127.0.0.1:7700)
```

**Desktop**: works on first launch — the default managed mode starts a gh
server automatically (downloading it if missing); create a project by picking
a local directory and start chatting. Full tour (side tabs, bottom terminal,
remote mode, auto-update, Linux install) in [docs/desktop.en.md](docs/desktop.en.md).

**Web**: the default single-user managed mode works with zero config;
multi-user and identity modes (single/header/sso) switch via environment
variables — see [docs/deploy.en.md](docs/deploy.en.md).

## Highlights

### Conversations & sessions

- SSE streaming (text/thinking deltas) with stop control; self-healing on
  stream breaks (watchdog + final-state reconciliation, rounds recovered from
  the server snapshot)
- Tool-call cards: status icon, argument digest, expandable full input/output,
  sub-agent labels
- `ask_user_question` expands right inside the composer (click to confirm,
  checkboxes for multi-select); tool-approval cards (approve/reject + feedback),
  chained continuation after answering
- Project-scoped session list (server truth + local project index grouping);
  restore across restarts, paused sessions resume with their pending cards;
  unread blue dots and running spinners

### Desktop workbench (desktop only)

- **Bottom terminal**: a login shell in the current project directory
  (xterm.js + Go PTY), kept alive when collapsed; the side dock has another
  independent terminal tab
- **Git review**: current project status grouped (branch/ahead-behind/staged/
  unstaged/untracked) with inline diffs, auto-refreshing
- **Built-in browser**: address bar + iframe, remembered per scope; via
  goder-console the agent can navigate/click/read console & network/take
  screenshots in the same panel — you watch everything live
- The local server binds loopback only with a localhost Host allowlist; the
  gh token is injected by the same-origin proxy and never held by the browser

### Web embedding

- Registry: four assembly regions (nav / side tabs / bottom tabs / settings
  sections) plus the message content layer (custom renderers, tool display
  metadata, markdown override) — built-in and third-party entries share one
  `add/remove/hide/show` API
- Runtime policies injected per scope: `onBeforeSend` / `onApproval` hooks,
  default prompts, skill injection, host context briefs
- Shadow DOM style isolation, theming via `--goder-*` CSS variables;
  `GODER_UI_VERSION` constant + full .d.ts type artifacts
- Quick taste: visit `/embed-demo.html` after `./build.sh web`

### Multi-user gateway

- One process per user: dedicated port pool, data directory, and GRF_HOME;
  lazy start, idle reaping, crash-restart cooldown, user caps
- Three identity modes: single user / trusted upstream gateway header
  (recommended for integrations) / built-in Casdoor SSO
- Host administration plane (`/admin/*`): provider declarations, model
  resolution, plugin installation, session index, user directory lifecycle —
  all declarative APIs, hosts never write private files directly

## Configuration

Key environment variables (all optional, sensible defaults; full list in
[docs/deploy.en.md](docs/deploy.en.md)):

| Variable | Default | Description |
|---|---|---|
| `ADDR` | `127.0.0.1:7700` | Gateway listen address |
| `GODER_IDENTITY` | `single` | `single` / `header` / `sso` |
| `GODER_DATA` | `./goder-web-data` | Data root (per-user layout) |
| `GODER_MAX_USERS` / `GODER_IDLE_TTL` | `50` / `30m` | User process cap / idle reap |
| `GODER_CORS_ORIGINS` | empty | CORS allowlist for public deployments (overrides the wildcard default) |
| `GODER_ADMIN_TOKEN` | empty (off) | Admin API token; **equivalent to code execution**, keep it internal |
| `GODER_GH_ENV_<KEY>` | — | Extra env passed to gh child processes (e.g. turn webhooks) |

## Security

One security model shared by all three forms (full write-up in
[docs/security.en.md](docs/security.en.md)); the essentials:

- **Token boundary**: gh tokens are injected by the gateway/desktop proxy and
  never delivered to the browser
- **header mode only behind a trusted reverse proxy**; in sso mode set
  `COOKIE_SECURE=1` behind TLS offloading; leave `AUTH_DEV_EMAIL` empty in
  production
- Tighten CORS for public deployments (`GODER_CORS_ORIGINS` allowlist);
  `GODER_ADMIN_TOKEN` is equivalent to code execution
- The desktop local server binds loopback only, with a localhost Host
  allowlist on sensitive paths (anti DNS rebinding)
- Download integrity: gh/self-update/plugins/skills are verified against the
  same-directory `.sha256`/`SHA256SUMS` before install; enforced whenever present
- Markdown is escaped first and rendered with a restricted converter; links
  allow only `http(s)`

## Project Structure

```
pkg/            Public Go layer (importable base for third-party Go modules)
  ghserver/       gh server process management + reverse-proxy core (token injection/SSE/body sizing)
  identity/       Identity resolution: single / header / sso (Casdoor)
  gateway/        Multi-user web gateway: per-user /goder-api routing + /admin/* + webhooks
internal/        Desktop-only Go layer (desktop wails service shell / appcfg / grfsettings
                 / browser native webview)
plugins/console/ goder-console: MCP service for agent-driven panels (loopback only)
cmd/goder-serve/ Multi-user gateway CLI
frontend/src/    core (UI-free core) / registry (UI registry) / panels /
                 shell (layout) / ui / host (wails bridge) / entries (desktop & embed entries)
docs/            Topical docs (desktop/deployment/security/embedding/testing)
```

Dependency direction: panels/shell → registry/core; core never depends on UI;
desktop-only capabilities go through `host/bridge.ts` only. Deep architecture
and code conventions: [AGENTS.md](AGENTS.md).

## Contributing

```sh
cd frontend && npx tsc --noEmit    # frontend type check
cd frontend && npm test            # vitest unit tests (registry/markdown/send pipeline…)
go build ./... && go vet ./...     # Go side
go test ./...                      # pkg base layer + FQN alignment guard
gofmt -l pkg cmd internal plugins  # must print nothing
```

- End-to-end: `goder test-serve` exposes the full desktop UI to a browser in
  headless form — guide in [docs/testing.en.md](docs/testing.en.md) (also
  shipped inside the binary)
- Code comments and docs in this repo are written in Chinese
- Releases: pushing a tag triggers CI; versions track the latest gh release
  tag — see [AGENTS.md](AGENTS.md)

## License

This project is open source under the [MIT License](LICENSE).
