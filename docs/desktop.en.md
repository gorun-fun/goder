# Desktop App Guide

**English** · [中文(默认)](desktop.md)

The wails v3 desktop form: an installable native app that manages its own
`gh server` child process.

## Build & Install

```sh
./build.sh          # frontend + desktop binary ./goder
./build.sh app      # assemble dist/goder.app (macOS, adhoc-signed)
```

- Prerequisite: the `gh` executable on PATH (an absolute path can be set in
  preferences). **Missing gh is auto-downloaded**: Windows shows a native
  confirmation dialog with a progress bar, macOS/Linux download silently; the
  binary lands under `bin/` in the user config directory (from
  download.gorun.fun/grf-harness, verified against the same-directory
  `.sha256`/`SHA256SUMS` before install). The macOS .app normally bundles gh
  and only falls back to downloading when missing; Windows/Linux release zips
  contain goder itself only.
- Model configuration reuses `~/.grf/settings.json` (the one `gh model`
  writes; `GRF_HOME` can relocate it).

## Runtime Modes

- **Managed mode (default)**: on start it launches
  `gh server -addr 127.0.0.1:7400 -data ~/Library/Application Support/goder/server-data`;
  the frontend connects through the app-internal same-origin proxy
  `/goder-api` (**the token is injected by the proxy**, never held by the
  browser); on exit the child is reaped (a watchdog covers crashes and kills,
  no orphans).
- **Remote mode** (Settings → General): connect to any already-running gh
  server (URL + token).
- **Auto-update**: checked on open and hourly; on confirmation it downloads →
  verifies → self-replaces → restarts (gh and plugins are synced along with
  the version).

## UI Tour

- **Left column**: project-scoped session list. **New project = a local
  directory** (system directory picker, named after the folder); the
  "Automation" category holds operator projects (task capture and one-click
  execution). A blue dot on a session = an unseen finished round; a running
  session shows a spinner.
- **Center**: the chat stream. Tool cards (argument digest, expandable full
  input/output), `ask_user_question` expanding right inside the composer,
  tool-approval cards (approve/reject + feedback).
- **Side tabs**: detail (overview/usage/tool timeline), **review** (current
  project git status grouping + inline diffs), **terminal** (independent PTY
  session), **browser** (address bar + iframe, remembered per scope), files,
  events; tabs can be added/removed and resized by dragging.
- **Bottom terminal**: a login shell in the **current project directory**
  (xterm.js + Go PTY), resizable, kept alive when collapsed; supports multiple
  tabs, and third parties can register their own bottom tabs.
- **Settings**: the gear at the bottom of the left column; nav + work panel
  layout (general/appearance/models/agent/update), changes apply instantly and
  save automatically.
- **Agent control (goder-console)**: agents inside gh can "visibly" drive the
  side browser and terminal panels (the user can watch and take over at any
  time) — bound to 127.0.0.1 only, protected by a random token.

## Data Locations

| Content | Location |
|---|---|
| Project index & session grouping | `~/Library/Application Support/goder/index-<scope>.json` |
| Managed gh data | `~/Library/Application Support/goder/server-data` |
| goder-console port/token | `~/Library/Application Support/goder/console-mcp.json` (0600) |
| Model/plugin/skill config | `~/.grf/` (`GRF_HOME` can relocate) |
| Session history & workspace | managed by gh server (inside its data dir) |

## Linux Install

Double-clicking a bare executable in the GNOME file manager does not run it
(it looks for an "open with" handler by content type); the proper entry points
are the app menu / desktop icon. The Linux zip ships `install.sh` (with a
.desktop template and icons): after unpacking, run `./install.sh` once and it
installs into `~/.local/bin` and the app overview (search "Goder" to launch);
running from a terminal works as usual.

## Known Limitations

- The embedded terminal and git review depend on PTY/local processes and are
  desktop-only (the corresponding entries hide themselves in embedded form;
  the events and browser tabs remain available).
- Approval cards (tool_approval) depend on gh's session-level approval mode;
  they never appear under the default policy (auto_approve); ask form cards
  are unaffected.
- Reasoning traces of historical (non-this-process) rounds are not in the
  online format, so they don't replay when restoring history; tool cards and
  text replay normally.
- In web form the project index lives in localStorage (per-origin); on desktop
  it's a file.
