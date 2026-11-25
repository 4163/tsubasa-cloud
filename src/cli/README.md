# Tsubasa CLI

The `tsubasa` CLI operates on the local-first SQLite index and the Hono backend in `src/server/` without duplicating storage placement, quota, or sync logic.

## Build and run

Run directly from TypeScript during development:

```bash
npm run tsubasa -- <command>
```

Compile to `dist/cli/index.js` with `tsconfig.cli.json` and link the binary:

```bash
npm run build:cli
npm link
tsubasa <command>
```

## Transport and locking

By default, the CLI reads the bound `port` recorded in `data/tsubasa.writer.lock` if present and probes `GET /api/health` there alongside `http://127.0.0.1:${PORT:-28300}` with a 250 ms timeout. Reading the lockfile lets the CLI find an Electron-hosted server even when it falls back to an ephemeral port. The CLI routes over HTTP when `service === "tsubasa-backend"` and `dbFingerprint` matches the local database path hash.

- `--server <url>` or `TSUBASA_API_URL`: skip the `dbFingerprint` check and fail fast with exit code `5` if unreachable, with no local fallback.
- `--local`: skip HTTP probing and run standalone in-process against SQLite and Drive.
- `--home <dir>` or `TSUBASA_HOME`: override the home directory for `data/`, `.oauths/`, and `extensions/`. When unset, the CLI resolves the package root from `import.meta.url` and never uses `process.cwd()` for internal state.
- Write locking: standalone write commands acquire `data/tsubasa.writer.lock` atomically, and re-probe `/api/health` once when `--local` is not set to prevent concurrent writers.
- Outbox drain: standalone write commands drain queued `drive_outbox` items before exiting without `--no-wait-outbox`.
- Detached jobs: `--detach` requires an active HTTP server so background transfers survive after the CLI exits.

## Global flags and selectors

Global flags: `--json`, `--dry-run`, `--yes`/`-y`, `--quiet`/`-q`, `--show-emails`, `--no-wait-outbox`, `--pool <id|slug>`, `--server <url>`, `--local`, `--home <dir>`, `--help`/`-h`.

- Remote paths: use `--pool <id|slug>` or `<slug>:/path` shorthand. The `<slug>:/path` form only matches prefixes of length 2 or greater so Windows drive paths like `C:\data\file.bin` never collide.
- Pool resolution order: `--pool`, then `TSUBASA_POOL`, then the first standard pool ordered by `sort_order ASC, id ASC`.
- Account resolution order: `accountRef` in `acc_<8-hex>` format, then exact `id` or `email`, then a unique case-insensitive email prefix. Ambiguous prefixes exit with code `2` and list matching candidates.

## Commands

Top-level verbs:

- `status`, `ls`, `stat`, `find`, `mkdir`, `mv`, `cp`, `rm`, `upload`, `download`, `export`, `audit`, `dupes`

Resource groups:

- `pool`: `list`, `show`, `create`, `rename`, `delete`, `reorder`, `rebalance`
- `account`: `list`, `show`, `quota`, `enable`, `disable`, `evacuate`, `move-pool`, `remove`
- `job`: `list`, `status`, `resume`, `cancel`
- `trash`: `list`, `restore`, `purge`
- `share`: `list`, `clear`
- `outbox`: `list`, `retry`, `drop`
- `sync`: `delta`, `cold`
- `auth`: `check`, `add`
- `db`: `backup`
- `ext`: `list`, `<name>`
- `import`: `drive`, `tokens list`, `tokens clear`
- `plan`: `upload`, `import-drive`

Run `tsubasa --help --json` for the static JSON schema of all commands, flags, and exit codes.

## Automation contract

- Under `--json`, stdout emits only the valid JSON success payload. Progress events emit as NDJSON on stderr, and failures write one `{ ok: false, error: { code, message, exitCode, details, hint } }` object to stderr.
- Default output masks email addresses with deterministic asterisk masking such as `a***e@g***.com` and attaches a non-PII `accountRef` join key to every account-referencing record. Unmasked emails require the `--show-emails` CLI flag; no environment variable enables it.
- In non-TTY mode, destructive commands fail fast with exit code `2` without `--yes`: `rm --permanent`, `trash purge`, `pool delete`, `account remove`, `outbox drop`, and `share clear`.

| Exit code | Name | Meaning |
| :--- | :--- | :--- |
| `0` | `success` | Command completed without errors. |
| `1` | `runtime_error` | Unexpected internal or runtime failure. |
| `2` | `usage_or_validation_error` | Invalid arguments, ambiguous selector, or missing `--yes` in non-TTY mode. |
| `3` | `quota_or_ceiling_exceeded` | 750 MB reserve headroom, 14.25 GB file ceiling, or 750 GB 24-hour upload cap exceeded. |
| `4` | `conflict_or_lock_held` | Path conflict, writer lock held, pool not empty, or Share Pool read-only. |
| `5` | `auth_or_upstream_error` | OAuth failure, Drive upstream error, or unreachable explicit server. |
| `6` | `not_found` | Requested path, pool, account, job, or extension does not exist. |

## Transfers and external import

- Uploads at or below 5 MiB use the single-shot `POST /api/files/upload` fast path with MD5 verification. Larger files use server-owned chunked resumable uploads with an 8 MiB default chunk size, configurable with `--chunk-size` in 256 KiB multiples and capped at `chunkSize * concurrency <= 32 MiB`, with full-file MD5 verification before SQLite commit.
- Downloads resume client-side using `<dest>.part` and `<dest>.part.meta.json` inside the destination directory. Zero-byte files omit the `Range` header, HTTP `200` responses truncate `.part` before writing, and byte count plus hash verification run before atomic rename.
- `tsubasa import drive` imports external Google Drive trees using `--source-auth <cred.json>` and caches OAuth tokens under `data/source-tokens/` outside `.oauths/`. Default `--mode copy` uses folder-level temporary reader shares; `--mode stream` streams directly under 50 MB RAM with `drive.readonly` scope.
