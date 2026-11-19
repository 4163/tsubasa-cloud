# Tsubasa extensions

Extensions live in subdirectories under `extensions/<name>/` and run as external subprocesses through `tsubasa ext`. Git ignores everything inside `extensions/` except this file.

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

- `name`: lowercase alphanumeric with hyphens (`^[a-z0-9][a-z0-9-]*$`). Must match the directory name.
- `description`: non-empty string shown in `tsubasa ext list`.
- `entry`: relative path inside `extensions/<name>/`. Paths that traverse outside the extension directory or resolve outside it through symlinks are rejected.
- `runtime`: one of `node`, `python`, or `exec`.
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

Global Tsubasa flags placed before `ext` configure Tsubasa. Every token after `ext <name>` passes verbatim to the child process. The CLI spawns extensions with `shell: false`, inherits stdio, forwards `SIGINT` and `SIGTERM`, and exits with the child process exit code.

## Child environment variables

Tsubasa sets these environment variables for the child process:

- `TSUBASA_CLI_BIN`: path to the active `tsubasa` CLI entrypoint.
- `TSUBASA_SCHEMA_VERSION`: current export schema version (`1`).
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

Extensions must never open or write to `data/tsubasa.db` directly. Read catalog state through `tsubasa export` (JSON or streaming JSONL) and perform actions through `tsubasa` CLI commands.
