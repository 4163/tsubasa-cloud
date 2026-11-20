# Tsubasa extensions

Extensions live in subdirectories under `<home>/extensions/<name>/` and run as external subprocesses through `tsubasa ext`. Tsubasa resolves `<home>` from `--home` or `TSUBASA_HOME`, defaulting to the package root and never `process.cwd()`.

## Manifest contract

Each extension requires `extensions/<name>/manifest.json` with these fields:

```json
{
  "name": "my-tool",
  "description": "Short summary of what this extension does",
  "entry": "main.py",
  "runtime": "python",
  "minSchemaVersion": 1
}
```

- `name`: lowercase alphanumeric with hyphens matching `^[a-z0-9][a-z0-9-]*$`. Must match the directory name.
- `description`: non-empty string shown in `tsubasa ext list`.
- `entry`: relative path inside `extensions/<name>/`. The loader rejects any path that traverses outside the extension directory or resolves outside it through symlinks.
- `runtime`: one of `node`, `python`, or `exec`. The `exec` runtime spawns `entry` directly with `shell: false` and requires a native executable or a `+x` script with a shebang on POSIX.
- `minSchemaVersion`: optional positive integer declaring the minimum `tsubasa export` schema version required.

## Running extensions

List installed extensions:

```bash
tsubasa ext list
tsubasa ext list --json
```

Run an extension:

```bash
tsubasa ext <name> [args...]
```

Global Tsubasa flags placed before `ext` configure Tsubasa. Every token after `ext <name>` passes verbatim to the child process. Run `tsubasa --dry-run ext <name>` to validate the manifest and print the resolved command and child environment without spawning.

`tsubasa ext` only probes `/api/health` and never opens SQLite or holds `data/tsubasa.writer.lock`, so extensions can run `tsubasa` read and write commands without lock conflicts. The CLI spawns extensions with `shell: false`, inherits stdio, forwards `SIGINT` and `SIGTERM`, and exits with the child exit code. If a signal terminates the child, Tsubasa exits `130` for `SIGINT`, `143` for `SIGTERM`, or `1` for other signals. Pre-spawn failures use standard CLI exit codes: `6` for a missing `manifest.json`, `2` for an invalid manifest, missing `entry`, or conflicting `--server` and `--local`, `5` for an unreachable explicit `--server` or `TSUBASA_API_URL`, and `1` for a missing Python 3 interpreter or spawn failure.

## Child environment variables

Tsubasa sets these environment variables for the child process:

- `TSUBASA_CLI_BIN`: resolved CLI entrypoint script path such as `dist/cli/index.js`, not the `node` binary. Non-Node extensions should invoke `node "$TSUBASA_CLI_BIN"` when `tsubasa` is not on `PATH`.
- `TSUBASA_SCHEMA_VERSION`: current export schema version, `1`.
- `TSUBASA_TRANSPORT`: `http` when connected to a running server, or `local` in standalone mode.
- `TSUBASA_HOME`: resolved Tsubasa home directory.
- `TSUBASA_POOL`: set when `--pool` or `TSUBASA_POOL` is active.
- `TSUBASA_API_URL`: set only when `TSUBASA_TRANSPORT` is `http`. Unset in `local` mode.

## Python interpreter resolution

When `runtime` is `python`, Tsubasa checks candidate interpreters with `--version` and uses the first one that exits `0`:

1. `TSUBASA_PYTHON` environment variable, if set.
2. On Windows: `py -3`, then `python3`, then `python`.
3. On POSIX: `python3`, then `python`.

## Database boundary

Extensions must never open or write to `data/tsubasa.db` directly. Read catalog state through `tsubasa export` in JSON or streaming JSONL format and perform actions through `tsubasa` CLI commands.
