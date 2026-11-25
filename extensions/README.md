# Tsubasa extensions

Runner for local scripts and companion tools built on top of Tsubasa, such as custom catalog exporters, external image and video viewers, or custom file viewers. Extensions live in `<home>/extensions/<name>/` and run as external subprocesses through `tsubasa ext`.

> **Home directory:** `<home>` resolves from `--home` or `TSUBASA_HOME`, defaulting to the package root and never `process.cwd()`.

## Running extensions

```bash
tsubasa ext list                     # List valid and invalid extensions
tsubasa ext list --json
tsubasa ext <name> [args...]         # Run an extension
tsubasa --dry-run --json ext <name>  # Validate manifest and print resolved env without spawning
```

- Global flags placed before `ext` configure Tsubasa. Every token after `ext <name>` passes verbatim to the child process.
- `tsubasa ext` only probes `/api/health`. It never opens SQLite or holds `data/tsubasa.writer.lock`, so extensions can run `tsubasa` read and write commands without lock conflicts.

## Manifest contract

Each extension requires `extensions/<name>/manifest.json`:

```json
{
  "name": "my-tool",
  "description": "Short summary of what this extension does",
  "entry": "main.py",
  "runtime": "python",
  "minSchemaVersion": 1
}
```

- `name`: lowercase alphanumeric with hyphens (`^[a-z0-9][a-z0-9-]*$`), matching the directory name. `list` is reserved.
- `description`: non-empty string shown by `tsubasa ext list`.
- `entry`: relative path inside `extensions/<name>/`. Paths escaping the directory directly or via symlinks fail validation.
- `runtime`: `node`, `python`, or `exec`. `exec` spawns `entry` directly with `shell: false` (native binary or `+x` script with a shebang on POSIX).
- `minSchemaVersion`: optional positive integer declaring the minimum `tsubasa export` schema version (currently `1`).

> **Database boundary:** Extensions must never open or write to `data/tsubasa.db` directly. Read catalog data via `tsubasa export` (JSON, streaming JSONL, or CSV) and run mutations through `tsubasa` CLI commands.

## Child environment variables

| Variable | Value |
|---|---|
| `TSUBASA_CLI_BIN` | Resolved CLI entrypoint script, not `node`. Run `node "$TSUBASA_CLI_BIN"` for compiled builds (`dist/cli/index.js`) when `tsubasa` is not on `PATH`; under `npm run tsubasa` it resolves to `src/cli/index.ts`. |
| `TSUBASA_SCHEMA_VERSION` | Current export schema version (`1`). |
| `TSUBASA_TRANSPORT` | `http` when connected to a running server, or `local` in standalone mode. |
| `TSUBASA_HOME` | Resolved Tsubasa home directory. |
| `TSUBASA_POOL` | Set when `--pool` or `TSUBASA_POOL` is active. |
| `TSUBASA_API_URL` | Set only in `http` mode; unset in `local` mode. |

## Runtime and exit codes

- Children spawn with `shell: false`, inherit stdio, and receive forwarded `SIGINT` and `SIGTERM` signals.
- For `runtime: "python"`, Tsubasa checks `--version` in order and picks the first exit `0`: `TSUBASA_PYTHON` (if set), then `py -3`, `python3`, `python` on Windows, or `python3`, `python` on POSIX.

| Condition | Exit code |
|---|---|
| Child process exited normally | Child exit code |
| Child terminated by `SIGINT` / `SIGTERM` / other signal | `130` / `143` / `1` |
| Missing Python 3 interpreter or spawn error | `1` |
| Invalid name or manifest, missing `entry`, or `--server` / `TSUBASA_API_URL` with `--local` | `2` |
| Explicit `--server` or `TSUBASA_API_URL` unreachable | `5` |
| Missing `manifest.json` | `6` |
