# Deployment Guide

**English** · [中文(默认)](deploy.md)

The pure web form of goder is served by `cmd/goder-serve`: static hosting of
the frontend plus the `/goder-api` multi-user gateway. Default
http://127.0.0.1:7700, **single-user managed mode** works with zero config —
the first API request lazily starts a gh server (data directory
`./goder-web-data/users/local/`).

```sh
./build.sh web        # build frontend + start (common for local dev)
# or run the built binary directly
go run ./cmd/goder-serve
```

Prerequisites: the `gh` executable on PATH (or an absolute path via
`GODER_BIN`); model configuration reuses `~/.grf/settings.json`
(`GRF_HOME` can relocate it).

## Identity Modes

Three modes cover everything from local tinkering to multi-user production:

```sh
# ① Single user + direct external gh server (no managed process; the browser
#    carries the token; legacy-compatible)
GODER_IDENTITY=single GODER_UPSTREAM=http://127.0.0.1:7400 ./goder-serve

# ② Trusted upstream gateway header (recommended when integrated into another
#    app; one gh process per user). Must sit behind an authenticated trusted
#    reverse proxy — see docs/security.en.md
GODER_IDENTITY=header GODER_UID_HEADER=X-GRF-UID ADDR=:7700 ./goder-serve

# ③ Built-in Casdoor SSO (complete standalone solution; /goder-api/auth/*)
GODER_IDENTITY=sso SSO_ENDPOINT=https://sso.example.com \
  SSO_CLIENT_ID=… SSO_CLIENT_SECRET=… \
  SSO_REDIRECT_URL=https://app.example.com/goder-api/auth/callback \
  ./goder-serve
```

header/sso modes default to a dedicated `GRF_HOME` per user
(settings/skills/plugins fully isolated; `GODER_USER_HOME=0` disables);
`GODER_SETTINGS_SEED` can point at a host settings.json as the one-time
initial snapshot for users (independent afterwards).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ADDR` | `127.0.0.1:7700` | Listen address |
| `GODER_DATA` | `./goder-web-data` | Data root (`users/<uid>/` layout) |
| `GODER_STATIC_DIR` | `frontend/dist` | Frontend static directory |
| `GODER_BIN` | `gh` | gh executable (name or absolute path) |
| `GODER_IDENTITY` | `single` | `single` / `header` / `sso` |
| `GODER_UPSTREAM` | empty | External gh server for single mode (direct proxy) |
| `GODER_UID_HEADER` / `GODER_NAME_HEADER` | `X-GRF-UID` / `X-GRF-Name` | User headers in header mode |
| `SSO_ENDPOINT` / `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` / `SSO_REDIRECT_URL` / `SSO_ORGANIZATION` | empty | Casdoor parameters (required for sso) |
| `AUTH_DEV_EMAIL` | empty | sso dev backdoor (issues a session without SSO login); **must stay empty in production** |
| `COOKIE_SECURE` | `0` | Force Secure on the sso session cookie (set 1 behind TLS offloading) |
| `GODER_SESSIONS_FILE` | empty (memory) | sso session file persistence (0600; single-instance; distributed needs a custom SessionStore) |
| `GODER_PORT_MIN` / `GODER_PORT_MAX` | `17400` / `18400` | User process port pool |
| `GODER_MAX_USERS` | `50` | Cap on concurrently managed user processes |
| `GODER_IDLE_TTL` | `30m` | Idle reap threshold for user processes |
| `GODER_READY_TIMEOUT` | `15s` | gh process readiness wait |
| `GODER_USER_HOME` | `1` | Per-user GRF_HOME |
| `GODER_SETTINGS_SEED` | empty | Host settings.json seeded on first user start (`1` = host default) |
| `GODER_CORS` | `1` | Wildcard CORS on the API (for local dev; use the allowlist in public) |
| `GODER_CORS_ORIGINS` | empty | Exact allowlist (comma-separated; takes precedence over GODER_CORS, allows credentials) |
| `GODER_ADMIN_TOKEN` | empty (off) | `/admin/*` admin API token; **equivalent to code execution** — internal use, long random value |
| `GODER_WEBHOOK_URL` / `GODER_WEBHOOK_SECRET` | empty (off) | Process lifecycle event callback / HMAC-SHA256 signing secret (required across trust domains) |
| `GODER_ACCESS_LOG` | `0` | Request log (stdout: method path status duration) |
| `GODER_GH_ENV_<KEY>` | — | Extra env passed to every gh child process (e.g. `GODER_GH_ENV_GRF_TURN_WEBHOOK_URL` for turn events) |

Admin API (`/admin/*`, AdminToken-authenticated): process ops `statuses` /
`start` / `stop` / `restart`, plus the host administration plane (provider
declarations / model resolution / plugin installation / session index / user
directory lifecycle) — declarative integration, see
[embedding.md](embedding.en.md) "Host administration plane".

## Production Checklist

- [ ] **Put it behind a trusted reverse proxy** with HTTPS (the loopback-only
      default is a deliberate conservative choice; exposure is an explicit
      ops decision)
- [ ] **Tighten CORS**: `GODER_CORS=0` + `GODER_CORS_ORIGINS=https://your.domain`
- [ ] In `header` mode, confirm the upstream proxy authenticates users and
      strips spoofed identity headers
- [ ] In `sso` mode: set `COOKIE_SECURE=1` behind TLS offloading; confirm
      `AUTH_DEV_EMAIL` is empty
- [ ] Set `GODER_ADMIN_TOKEN` when you need the admin plane (long random
      value, internal networks only)
- [ ] Set `GODER_WEBHOOK_SECRET` (if event callbacks are enabled)
- [ ] Back up `GODER_DATA` regularly (user session data & config) plus the
      host `~/.grf/settings.json`
- [ ] Multi-instance: the sso session store is single-instance by default;
      cross-instance needs a custom `SessionStore` (Redis etc., the
      `identity.SessionStore` interface)

The full security model: [security.en.md](security.en.md).
