# Tsubasa CLI

Headless CLI for automation, batch operations, agent workflows, and maintenance or destructive actions not exposed in the frontend. `tsubasa` operates on the same SQLite index, placement rules, and Google Drive engine as the app.

## Build and run

```bash
npm run tsubasa -- <command>      # Run from TypeScript in development
npm run build:cli && npm link     # Compile dist/cli/index.js and install tsubasa on PATH
tsubasa <command>
```

## Commands

| Group | Subcommands / verbs |
|---|---|
| Top-level | `status`, `ls`, `stat`, `find`, `mkdir`, `mv`, `cp`, `rm`, `upload`, `download`, `export`, `audit`, `dupes` |
| `pool` | `list`, `show`, `create`, `rename`, `delete`, `reorder`, `rebalance` |
| `account` | `list`, `show`, `quota`, `enable`, `disable`, `evacuate`, `move-pool`, `remove` |
| `job` | `list`, `status`, `resume`, `cancel` |
| `trash` | `list`, `restore`, `purge` |
| `share` | `list`, `clear` |
| `outbox` | `list`, `retry`, `drop` |
| `sync` | `delta`, `cold` |
| `auth` | `check`, `add` |
| `db` | `backup` |
| `ext` | `list`, `<name>` |
| `import` | `drive`, `tokens list`, `tokens clear` |
| `plan` | `upload`, `import-drive` |

> **Full command schema:** Run `tsubasa --help --json` for the complete static JSON schema of commands, flags, and exit codes.

## Global flags and selectors

Flags: `--json`, `--dry-run`, `--yes`/`-y`, `--quiet`/`-q`, `--show-emails`, `--no-wait-outbox`, `--pool <id|slug>`, `--server <url>`, `--local`, `--home <dir>`, `--help`/`-h`.

- **Remote paths.** Pass `--pool <id|slug>` or `<slug>:/path`. The prefix form requires 2+ characters so Windows drive letters (`C:\data\file.bin`) never match.
- **Pool resolution.** `<slug>:/path` or `--pool`, then `TSUBASA_POOL`, then the first standard pool (`sort_order ASC, id ASC`).
- **Account resolution.** `accountRef` (`acc_<8-hex>`), then exact `id` or `email`, then a unique case-insensitive email prefix. Ambiguous prefixes exit `2` with matching candidates.

## Automation and agent contract

- **Structured JSON (`--json`).** Stdout emits only the valid JSON payload. Progress writes NDJSON to stderr. Failures write one `{ ok: false, error: { code, message, exitCode, details, hint } }` object to stderr.
- **Email redaction.** Emails mask deterministically by default (`a***e@g***.com`), and account records include a non-PII `accountRef` join key. Only `--show-emails` unmasks emails; no environment variable enables unmasking.
- **Non-TTY confirmations.** Destructive commands exit `2` without `--yes` in non-TTY mode: `rm --permanent`, `trash purge`, `pool delete`, `account remove`, `outbox drop`, `share clear`.

| Exit code | Name | Meaning |
|---|---|---|
| `0` | `success` | Completed without errors. |
| `1` | `runtime_error` | Internal or runtime failure. |
| `2` | `usage_or_validation_error` | Invalid arguments, ambiguous selector, or missing `--yes` in non-TTY mode. |
| `3` | `quota_or_ceiling_exceeded` | 750 MB reserve headroom, 14.25 GB file ceiling, or 750 GB 24-hour upload cap exceeded. |
| `4` | `conflict_or_lock_held` | Path conflict, writer lock held, pool not empty, or Share Pool read-only. |
| `5` | `auth_or_upstream_error` | OAuth failure, Drive upstream error, or unreachable explicit server. |
| `6` | `not_found` | Requested path, pool, account, job, or extension does not exist. |

## Transfers and external import

- **Uploads.** Files `<= 5 MiB` use single-shot `POST /api/files/upload` with MD5 verification. Larger files use resumable chunks (default `8 MiB`, `--chunk-size` in `256 KiB` multiples, `chunkSize * concurrency <= 32 MiB`) with full-file MD5 verification before SQLite commit. Single files can stream from stdin (`-`) with `--size <bytes>`.
- **Downloads.** Resume client-side using `<dest>.part` and `<dest>.part.meta.json`. Zero-byte files omit `Range`, HTTP `200` responses truncate `.part`, and byte length plus MD5/SHA-256 verification run before atomic rename. Single files can stream to stdout (`-`).
- **External Drive import (`tsubasa import drive`).** Imports external Google Drive trees with `--source-auth <cred.json>` and caches source OAuth tokens in `data/source-tokens/` outside `.oauths/`. Default `--mode copy` uses temporary folder-level reader shares; `--mode stream` streams under 50 MB RAM with `drive.readonly` scope.

## Transport and locking

- **Auto-discovery.** Probes `GET /api/health` (250 ms timeout) on the port recorded in `data/tsubasa.writer.lock` and on `http://127.0.0.1:${PORT:-28300}` (`PORT` checked first when set). Routes over HTTP when `service === "tsubasa-backend"` and `dbFingerprint` matches the local DB path hash, including Electron servers on ephemeral ports.
- **Explicit server (`--server <url>` or `TSUBASA_API_URL`).** Probes with a 2 s timeout, skips `dbFingerprint`, and exits `5` if unreachable without local fallback. Cannot be combined with `--local` (exits `2`).
- **Standalone (`--local`).** Skips HTTP probing and runs in-process against SQLite and Drive.
- **Home override (`--home <dir>` or `TSUBASA_HOME`).** Sets the root for `data/`, `.oauths/`, and `extensions/`. Defaults to the package root from `import.meta.url`, never `process.cwd()`.
- **Write locking and outbox drain.** Standalone writes acquire `data/tsubasa.writer.lock` atomically, re-probe `/api/health` once (unless `--local`), and drain newly queued `drive_outbox` rows (up to 30 s) before exiting unless `--no-wait-outbox` is passed.

> **Detached jobs (`--detach`):** Requires an active HTTP server so background transfers survive after the CLI exits (`mv --to-pool`, `account evacuate`, `account remove`, `job resume`, `import drive`).
