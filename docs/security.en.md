# Security Notes

**English** · [中文(默认)](security.md)

A quick tour of goder's security model (shared by the desktop app, the
embeddable library, and the multi-user gateway). Code-level invariants for
the areas involved live in [AGENTS.md](../AGENTS.md).

## Token Boundary (core principle)

- A user's gh server token is **never delivered to the browser**: in managed
  mode (desktop and gateway) the server-side proxy injects the
  `Authorization` header and overwrites whatever the browser might send;
  browsers always go through the same-origin `/goder-api` (gh server sends no
  CORS headers — direct connections both fail cross-origin and are unsafe).
- The only exception is the "direct external gh server" single-user mode
  (`GODER_UPSTREAM`), where the user holds their own token and the gateway
  does not inject.

## Identity & Trust Model

Three identity modes (`GODER_IDENTITY`) with distinct trust boundaries:

| Mode | Trust basis | Deployment constraint |
|---|---|---|
| `single` | No identity; everyone shares one process | Local/intranet tinkering |
| `header` | Fully trusts the user header injected by the upstream gateway | **Only behind an authenticated, trusted reverse proxy**; exposing it directly unlocks every user's data |
| `sso` | Casdoor OAuth2 authorization code + local session | The complete standalone solution |

sso details: one-time state validation (validated then cleared), 32-byte
cryptographically random session tokens, HttpOnly + SameSite=Lax cookies; set
`COOKIE_SECURE=1` behind TLS offloading; `AUTH_DEV_EMAIL` is a local-dev
backdoor (issues a session without SSO login) and **must stay empty in
production**; the session table can persist to a file via
`GODER_SESSIONS_FILE` (0600, atomic writes, single-instance).

## Process & Data Isolation (multi-user gateway)

- One dedicated `gh server` child process per logged-in user: own port
  (pool 17400-18400), own data directory, own `GRF_HOME` (settings/skills/
  plugins fully isolated).
- uids are sanitized through a whitelist into directory names (path-traversal
  safe; dot segments like `..` are folded away too) — user directories cannot
  reach each other.
- Process caps, idle reaping, and crash-restart cooldown protect against
  resource exhaustion.
- The proxy caps body buffering for lengthless requests (64MB default),
  closing the memory-DoS surface.

## Admin Plane (/admin/*)

- Authenticated by the Bearer `GODER_ADMIN_TOKEN` with constant-time
  comparison; disabled when unset.
- **Privileges equivalent to code execution on the server**: plugin wrappers
  installed through it are executed by gh as the service user. Keep it on
  internal/trusted networks, use a long random value, never in URLs or
  frontend code.
- Process lifecycle events can be POSTed to a webhook; with
  `GODER_WEBHOOK_SECRET` set, each callback carries an HMAC-SHA256 signature
  header (mandatory for cross-trust-domain callbacks).

## CORS

The wildcard default exists for **local development**; public deployments
must switch to the `GODER_CORS_ORIGINS` allowlist (exact match, echoes the
matched Origin and allows credentials, compatible with cookie sessions).

## Desktop Local Defenses

- The local HTTP server binds 127.0.0.1 only; sensitive paths (`/goder-api*`,
  `/wails/*`) sit behind a localhost Host allowlist (127.0.0.1 / localhost /
  *.localhost) — this blocks DNS rebinding, which would otherwise expose the
  loopback server to an attacker's page. The wails call channel performs no
  origin checking of its own, so this guard is required.
- `/goder-api/token` (connection info) and `/goder-api/local-file`
  (read-only local files) are further constrained: local-file is limited to
  allowlisted roots (user home / gh data dir / project index directories,
  compared after symlink resolution) + 64MB cap + nosniff.
- The goder-console MCP (agent-driven panel browser/terminal/UI) binds
  127.0.0.1 only with a random token (constant-time comparison); the wrapper
  is 0700 and the token travels via environment variable, never in argv
  (invisible to `ps`).

## Download Integrity (supply chain)

gh bootstrap downloads, goder self-updates, and online plugin/skill installs
all verify sha256 against the **same-directory checksum sidecar** before
writing to disk: `<file>.sha256` first, the `SHA256SUMS` manifest as fallback.
Verification is mandatory whenever a sidecar exists (mismatched bytes are
never installed or executed); when none exists (historically published
directories) the check is skipped with a log line. Release CI publishes a
`.sha256` per artifact. All downloads go over HTTPS.

## Frontend XSS Defenses

- The markdown renderer is homegrown: all input is HTML-escaped first, then
  converted by a restricted converter; links/images allow only `http(s)://`
  (rejecting `javascript:` and friends); no `eval`/`new Function` anywhere.
- The embeddable library is style-isolated via shadow DOM; theming goes only
  through `--goder-*` CSS variables.

## Errors & Logging

Error responses aimed at browsers carry only generic, categorized messages
(capacity / not-ready / upstream unavailable); internal details (addresses,
paths, startup log locations) stay in server-side logs.
