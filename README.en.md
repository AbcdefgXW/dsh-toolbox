# dsh-toolbox

[English](README.en.md) | [简体中文](README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-blue)
![dsh](https://img.shields.io/badge/dsh-plugin-ready-4caf50.svg)

> A toolbox plugin for dsh (DeepSeek Harness): session management / trash bin / subdirectory management / full-text search / preset editing / config editing / archive management.

## ✨ Features

- **💬 Session Management**: delete (to trash), duplicate (official fork with `-copyN` naming), move (between workspaces), reset workspace root, tag grouping (plugin-managed), view session content (read-only), conversation management (truncate/edit, disabled by default), empty sessions auto-labeled as `(empty session) workspace-name`
- **🗑️ Trash Bin**: deleted sessions/subdirectories go to trash (30-day retention by default, configurable); restore / purge / preview deleted session content
- **📁 Subdirectory Management**: create / rename / delete / duplicate directories under a workspace, batch-assign sessions
- **🔍 Full-text Search**: search across all sessions (highlight + jump + cancellable; frame-by-frame streaming decompression for low memory; 60s cache per keyword)
- **⚙️ Preset Editing**: edit Agent preset files online
- **📄 Config Editing**: edit dsh config file online (YAML validation + atomic write)
- **🗄 Archive Management**: view / restore / delete officially archived sessions
- **🧹 Release Memory**: clear plugin caches and attempt GC (full release still requires a container restart)

## 📸 Screenshots

<!-- TODO: add screenshots here -->

## Requirements

- **dsh** runtime (loaded as a dsh plugin; the frontend relies on `react`, `@deepseek-ai/dsh-client-ui-primitives`, etc., injected by the dsh web runtime)
- **Node.js ≥ 22.13** (session files are decompressed via the zstd support in `node:zlib`)
- **Linux** (session storage paths follow the `$DSH_HOME` convention, default `/home/dsh`)

## Installation

### Option 1: dsh CLI (recommended)

```bash
# From a GitHub repository (auto-clone + install deps)
dsh plugin --profile web add github:AbcdefgXW/dsh-toolbox

# Or from npm if published
dsh plugin --profile web add dsh-toolbox
```

If it is not auto-registered, add to `cordis.patch.yml` in the profile:

```yaml
- insert:
    - id: dsh-toolbox
      name: dsh-toolbox
```

### Option 2: Manual

```bash
git clone https://github.com/AbcdefgXW/dsh-toolbox.git
cd dsh-toolbox
npm install --omit=dev
```

Place the plugin directory on the dsh plugin load path (e.g. `$DSH_HOME/plugins/` or a compose mount), register it as above, then restart `dsh web`.

> `@deepseek-ai/*` packages are shipped with the dsh runtime; their versions track the dsh release. `js-yaml` is a plugin-level dependency (used for config-editing validation).

## Usage

After restarting `dsh web`, hard-refresh the browser (Ctrl+Shift+R) and click the **🧰 Toolbox** button at the bottom-left (shown as a 🧰 icon on narrow mobile screens). Additional toggles live under **Settings → Toolbox**.

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `DSH_HOME` | dsh data directory (sessions/config/caches) | `/home/dsh` |
| `DSH_CHANNELS_CWD` | current workspace root (session cwd base) | `/workspace` |

Defaults apply when unset; all other paths are derived from the plugin's own directory (`import.meta.url`) — no hardcoded paths.

## Data & Safety

- **Runtime data** lives in the plugin `state/` directory (settings, trash, backups, tags) — excluded from the repo via `.gitignore`
- The plugin reads/writes: `$DSH_HOME/sessions/` (session files, multi-frame zstd), `$DSH_HOME/storages/workspace.json` (workspace registry), and the dsh config file (only when using the config editor)
- **Delete = move to trash** (30-day retention by default, restorable) — never a physical delete
- **Conversation management (truncate/edit)**: modifies session files and requires a container restart to take full effect; disabled by default, enable it explicitly in settings

## Development

- `index.js` backend (cordis Service + typert remote, method name = endpoint name); `client.js` frontend (no build pipeline, loaded via `window.__ModuleLoader__`)
- Adding an endpoint requires three synchronized edits: backend method + backend `invocation` registration + frontend `DESCRIPTORS`
- Rewriting session files must use the official multi-frame format (`lib/zstd.js compressSessionText`: a header frame with exactly one line + event frames of 500 lines each); a single-frame compression breaks the dsh loader

## License

MIT — see [LICENSE](LICENSE)
