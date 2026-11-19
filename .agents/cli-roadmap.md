# Tsubasa~ Cloud CLI roadmap

This roadmap specifies the `tsubasa` command-line interface for human operators and automation agents. It builds on the local-first SQLite index, the Hono backend, and the Google Drive sync and storage engines in `src/server/` without duplicating business logic or relaxing Tsubasa's 750 MB reserve, 14.25 GB file ceiling, or 50 MB transfer RAM invariants. Every design decision below reflects three-way architectural consensus and acts as the implementation contract for Phases 0 through 4.

## Agent and model allocation

Assign work by failure mode, not by convenience. Stateful storage engines and lock protocols fail silently when rushed, while pure formatters waste high-tier quota when a smaller or separate-pool model can finish them in one pass. Hydrogen Medium is dropped because Neon Medium and Hydrogen High cover its entire range at better speed and cost.

### Model benchmark and role table

| Model | Benchmark profile | Quota pool | Assigned responsibilities |
| :--- | :--- | :--- | :--- |
| **Neon High** | Intel 60, $3.74, 14.8m | Primary | Stateful engines, concurrency and durability invariants, schema v6 migrations, shared writer lockfile, `createApp` hardening, chunked resumable upload and download verification engines, external Drive importer with `transfer_jobs` and folder shares, `crossPoolMove.ts`, and final durability review. |
| **Neon Medium** | Intel 55, $1.90, 8.3m | Primary | Core CLI router and transport client, pool slug and `sort_order` route updates, `poolRegistry.ts` and `quota.ts` ordering updates, missing backend endpoints for evacuation, pool reorder, outbox list or drop, and live quota refresh, `src/server/storage/export.ts` plus `GET /api/export`, `auth add` loopback flow, and end-to-end integration. |
| **Hydrogen High** | Intel 51, $1.87, 8.6m | Separate | Parallel delivery alongside Neon Medium once the CLI transport and error-envelope contracts freeze. Owns integrated CLI command groups including `pool`, `account`, `sync`, `outbox`, `trash`, `share`, `audit`, `dupes`, `db backup`, `auth`, `ls`, `stat`, `find`, `mkdir`, `mv`, `cp`, `rm`, `status`, plus local SQLite maintenance queries. |
| **Argon Medium** | Intel 48, $4.31, 29.1m, 15.09s TTFT | Separate | Zero-exploration, single-shot pure leaf modules off the critical path. Runs only from pre-assembled Context Packets with every type and contract pasted inline. Never assigned to integrated CLI CRUD wrappers or Hono RPC typing loops. |
| **Neon Low** | Intel 44, $0.75, 3.7m | Primary | Fast repository scouting to assemble inline Context Packets for Argon Medium, `package.json` `bin` and script entries, `tsconfig.cli.json`, `.gitignore` updates, `extensions/README.md`, documentation and unslop passes, and `npm run typecheck` checks. |
| **Hydrogen Medium** | Dropped | N/A | Excluded from all phases. Redundant with Neon Medium and Hydrogen High. |

### Argon Medium single-shot rules

Argon Medium has a separate quota pool, which makes it useful for offloading parallel work, but its 15.09s time to first token and $4.31 average cost punish multi-turn exploration. Every Argon Medium dispatch follows four hard rules:

1. **Zero repository browsing.** Neon Low scouts the repo first and hands Argon Medium a self-contained Context Packet containing exact input types, output types, edge cases, and target file path.
2. **Off the critical path.** Argon Medium builds pure, side-effect-free leaf modules so Neon High, Neon Medium, and Hydrogen High never block waiting on its turn latency.
3. **One to three turns max.** If a task needs iterative Hono RPC type debugging or cross-file refactoring, assign it to Neon Medium or Hydrogen High instead.
4. **Strict scope list.** Argon Medium owns only these seven leaf modules:
   1. Deterministic 1:1 email redactor, `acc_<8-hex>` opaque handle mapper, and error-string email scrubber.
   2. Pool slugifier and validator plus the Windows-safe `<slug>:/path` selector parser.
   3. Table renderer, single-entity CSV formatter, JSONL framer, byte and duration formatters, and TTY stderr progress bar.
   4. Exit-code and structured JSON error-envelope mapper.
   5. 256 KiB chunk boundary slicer, `Content-Range` parser, and hash-length algorithm detector.
   6. `extensions/` `manifest.json` validator, path-containment guard, OS-aware Python probe, and safe `spawn` runner.
   7. Static `--help --json` schema serializer.

### Phase-by-phase model ownership matrix

| Phase | Neon High | Neon Medium | Hydrogen High | Argon Medium | Neon Low |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Phase 0** | `paths.ts`, schema v6 migration, `createApp`, `/api/health` `dbFingerprint`, shared writer lockfile | `poolRegistry.ts`, `routes/pools.ts`, `storage/quota.ts` ordering and slug support | Standby until Phase 0 transport types freeze | Leaf modules 1 through 5 and 7 from Context Packets | Context Packet scouting, `package.json` `bin` and scripts, `tsconfig.cli.json`, typecheck |
| **Phase 1** | Concurrency review of standalone write locking and outbox drain | CLI entrypoint, transport probe, standalone teardown, missing backend endpoints, `auth add` | `status`, `ls`, `stat`, `find`, `mkdir`, `mv`, `cp`, `rm`, `pool`, `account`, `trash`, `sync`, `outbox`, `share`, `auth check`, `audit`, `dupes`, `db backup` | None | Verification runs, `npm run typecheck`, docs |
| **Phase 2** | Review streaming memory bounds and subprocess isolation | `src/server/storage/export.ts`, `GET /api/export`, `tsubasa export` and `tsubasa ext` wiring | Export CLI filters, entity validation, and `ext list` output formatting | Leaf module 6 for `extensions/` manifest, path guard, Python probe, and `spawn` runner | Context Packet for leaf module 6, `extensions/README.md`, `.gitignore`, typecheck |
| **Phase 3** | Chunked resumable upload endpoints, full-file MD5 verification, `crossPoolMove.ts`, persisted `account evacuate` and unified `DELETE /api/accounts/:id` | Transfer routes wiring, download response headers, single-file `stat` endpoint, `plan upload` shared planner | Client `.part` resumable download, `upload`, `download`, `job`, `account evacuate`, `account remove --evacuate`, `pool rebalance`, cross-pool `mv` | None | Typecheck and runtime smoke checks |
| **Phase 4** | External Drive importer engine, `transfer_job_shares`, My Drive `root` split, 404 ACL backoff, `--mode stream` fallback, multi-day 750 GB pause and resume, final durability review | `--source-auth` loopback and `--no-browser` token flow, `plan import-drive` shared planner | `tsubasa import drive` CLI wrapper, stderr NDJSON and TTY progress formatting, source token clear command | None | Typecheck, final doc and unslop pass |

## Multi-agent consensus ledger

Future agents must respect the agreed decisions below and must not re-introduce dropped scope.

### Agreed decisions

- **D1.** Shared `src/server/paths.ts` home resolution, HTTP-first `/api/health` probe with `dbFingerprint`, lazy `createApp` import, shared `data/tsubasa.writer.lock` across server and CLI writes, and clean standalone outbox drain and shutdown.
- **D2.** Schema v6 adds `pools.slug` and `pools.sort_order` with SQLite-safe backfill, reserved `'share'` and `'all'` names, numeric-slug bans, and `ORDER BY is_share_pool ASC, sort_order ASC, id ASC`.
- **D3.** Windows-safe `bin` packaging, hybrid verb and resource grammar, `<slug>:/path` length-2 minimum, default 1:1 email redaction with deterministic `accountRef` join keys, exit codes 0 through 6, stderr JSON error envelope, non-TTY `--yes` gate, and `tsubasa --help --json`.
- **D4.** External Drive archive import backed by normalized `transfer_jobs`, `transfer_job_items`, and `transfer_job_shares`, folder-level temporary reader shares with `root` streaming split, `--mode stream` fallback, MD5 verification, and multi-day 750 GB cap resume.
- **D5.** 5 MiB upload fast path vs server-owned 8 MiB chunked resumable upload capped at 32 MiB RAM, client-side `.part` resumable download with hash verification, and unified `job` commands.
- **D6.** New `src/server/drive/crossPoolMove.ts`, persisted `account evacuate` unified with `DELETE /api/accounts/:id`, live quota refresh, pool reorder, and over-ceiling-only `pool rebalance`.
- **D7.** Pure canonical `src/server/storage/export.ts` at `GET /api/export` with Unix millisecond timestamps, `accountRef` join keys, streaming JSONL, single-entity CSV and `--fields`, and zero downstream-tool formatting.
- **D8.** Repo-root `extensions/<name>/manifest.json` subprocess runner with path-containment validation, `shell: false`, OS-aware Python probing, and strict read-only database boundaries.
- **D9.** Sub-2 ms local SQLite navigation via `status`, `stat`, `find`, and `ls`, newline `--stdin` batching, `sqlite.backup()` online backups, `outbox` inspection and drop, local and remote `audit`, indexed `dupes`, `auth check` and `auth add`, and `plan` aliases.
- **D10.** Five-phase delivery plan using Neon High, Neon Medium, Hydrogen High, Argon Medium on pure leaf modules only, and Neon Low.

### Key additions and changes

**Additions over the initial proposal.**

- `src/server/paths.ts` with `--home` and `TSUBASA_HOME` precedence.
- `dbFingerprint` on `GET /api/health` and the shared server plus CLI `data/tsubasa.writer.lock` file.
- Deterministic `accountRef` formatted as `acc_<8-hex>` on every account-referencing record.
- Dedicated exit codes `1` and `6`, structured stderr JSON error envelope, and `tsubasa --help --json`.
- Top-level `status`, `stat`, and `find` commands, `--local` flag, and newline `--stdin` batch input.
- Download metadata headers `X-Tsubasa-Hash`, `X-Tsubasa-File-Id`, and `X-Tsubasa-Size`.
- Normalized `transfer_job_items` and `transfer_job_shares` tables plus `files_pool_trashed_hash_idx`.
- My Drive `root` import split routing loose root files through `--mode stream`.
- Explicit `chunkSize * concurrency <= 32 MiB` memory bound and unified persisted evacuation for `DELETE /api/accounts/:id`.

**Changes from the initial proposal.**

- `share prune` renamed to `share clear` to match `clearSharePool` in `src/server/drive/share.ts`.
- `plan upload` and `plan import-drive` constrained to thin aliases for `upload --dry-run` and `import drive --dry-run`.
- Every `tsubasa export` timestamp unified to Unix epoch milliseconds.
- `pool rename` preserves `slug` unless `--slug <new>` is passed.
- `account remove` requires `--evacuate --yes` when an account still holds files.
- `db backup` mandates `await sqlite.backup(destPath)` instead of raw file copies.

### Dropped scope and rationale

| Dropped item | Reason for rejection |
| :--- | :--- |
| **Hydrogen Medium model** | Excluded by explicit directive. Neon Medium and Hydrogen High cover the same work faster and cheaper. |
| **SQLite `transfer_jobs` for downloads** | Downloads are read-only. Client-side `<dest>.part` plus sidecar works against remote `--server` targets and leaves zero stale database rows. |
| **`tsubasa export --format table` and multi-entity `csv` or `--fields`** | `export` is a canonical machine dump. Relational tables do not flatten cleanly into one CSV or terminal table, and humans already have `ls`, `pool list`, `account list`, and `status`. |
| **Utilization-equalizing `pool rebalance`** | Moving files purely to equalize account usage burns the 750 GB 24-hour Drive quota and breaks folder cohesion. `pool rebalance` runs `executeAutoRebalance` strictly for over-ceiling accounts. |
| **`share prune` expiry and `share create`** | `share_links` has no expiration column, and the backend only exposes `clearSharePool`. |
| **`ext info <name>` and `TSUBASA_SHOW_EMAILS` env var** | `ext list --json` already returns full manifest metadata. Allowing an environment variable to expose emails weakens the CLI-flag-only redaction policy. |
| **JSONL `--stdin` parser and interactive `discrepancy resolve` CLI mutations** | Newline-delimited `--stdin` covers batch scripting without parser complexity. Interactive discrepancy resolution stays deferred to a later slice. |
| **Argon Medium on integrated CLI CRUD wrappers** | Iterative Hono RPC type checking triggers multi-turn retries, which clashes with Argon Medium's 15.09s TTFT and $4.31 cost profile. |

## Technical contracts and invariants

### D1. Execution transport, home resolution, and concurrency safety

- **Single path resolver.** Add `src/server/paths.ts` and import it from `src/server/db/index.ts` and `src/server/drive/auth.ts`. Resolve Tsubasa's home directory in strict order: `--home <dir>`, then `TSUBASA_HOME`, then the repository or package root derived from `import.meta.url`. Never resolve `data/` or `.oauths/` from `process.cwd()`. Local file arguments passed to `upload`, `download`, `db backup`, and `--source-auth` still resolve relative to `process.cwd()`.
- **HTTP-first transport probe.** Before importing server modules, probe `GET /api/health` with a 250 ms timeout. Auto-probing succeeds only when `service === "tsubasa-backend"` and `dbFingerprint` matches the local SHA-256 hash of the canonical resolved `dbPath`. Returning a hash avoids exposing raw OS file paths on `/api/health`.
- **Explicit transport overrides.** Passing `--server <url>` or setting `TSUBASA_API_URL` skips the `dbFingerprint` check and fails fast with exit code `5` if the server is unreachable, with no silent fallback to local SQLite. Passing `--local` skips HTTP probing and forces standalone in-process execution.
- **Lazy import and stdout hygiene.** `src/server/db/index.ts` opens SQLite at module import time, so the CLI must finish `/api/health` probing before dynamically importing `src/server/app.ts`. Refactor `src/server/app.ts` to export `createApp({ enableHttpLogger, enableCompress })`. Pass `{ enableHttpLogger: false, enableCompress: false }` in standalone mode so Hono `logger()` never writes request lines to `--json` stdout.
- **Shared writer lockfile.** Both `src/server/index.ts` and standalone CLI write commands acquire `data/tsubasa.writer.lock` using atomic `O_EXCL` file creation containing `{ pid, startedAt, command, cwd }` plus a stale-PID liveness check. After acquiring the lock, standalone write commands re-probe `/api/health` once to close the TOCTOU race against a concurrently starting server. Standalone read-only commands skip the lock under SQLite WAL and skip `authPool.scan()`, because `authPool.scan()` renames credential files and updates SQLite on ID-token email changes.
- **Standalone startup and shutdown durability.** Standalone mode skips `hydratePool1Startup`, calls `initializeDatabase()` explicitly, and drains any `drive_outbox` items enqueued by the command before exiting. Passing `--no-wait-outbox` skips draining and sets `workerStopped = true`. On exit, standalone mode calls `authPool.stopWatching()`, `stopOutboxWorker()`, and `sqlite.close()`.

### D2. Pool slugs and ordering in schema v6

- **Schema version bump.** Bump `CURRENT_SCHEMA_VERSION` from `5` to `6` in `src/server/db/init.ts` and keep `src/server/db/schema.ts` synchronized.
- **SQLite-safe migration.** Execute `ALTER TABLE pools ADD COLUMN slug TEXT;` and `ALTER TABLE pools ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;`. Inside a single transaction, backfill `is_share_pool = 1` rows with `slug = 'share'` and `sort_order = 1_000_000`, and backfill standard pools with unique slugified `name` values deduplicated with `-2` or `-3` suffixes and `sort_order = id`. After backfill, create `UNIQUE INDEX pools_slug_idx ON pools(slug)` and `INDEX pools_sort_order_idx ON pools(is_share_pool, sort_order, id)`.
- **Slug validation rules.** Every pool slug must match `^[a-z0-9][a-z0-9-]{1,62}$`, contain at least one non-digit character, and have a minimum length of 2. Purely numeric slugs are forbidden, and `'share'` and `'all'` are reserved. Numeric pool names such as `"2"` auto-derive to `pool-2`.
- **Stability and cold recovery.** `pool rename` leaves `slug` untouched unless `--slug <new>` is explicitly supplied. Reordering pools updates only `sort_order`; `pools.id` and `_Tsubasa~ Pool <id>` never change. `slug` and `sort_order` live strictly as local SQLite metadata, and cold Drive recovery regenerates default values.
- **Insert and query alignment.** Update all four pool insert sites: `src/server/db/init.ts`, `ensurePoolExistsInDb` and `ensureSharePoolExistsInDb` in `src/server/drive/poolRegistry.ts`, and `src/server/routes/pools.ts`. Update `ORDER BY` clauses in `src/server/routes/pools.ts` and `src/server/storage/quota.ts` to `ORDER BY is_share_pool ASC, sort_order ASC, id ASC`.
- **CLI default pool precedence.** Resolve the active pool in strict order: `--pool`, then `TSUBASA_POOL`, then the first non-share pool ordered by `sort_order ASC, id ASC`.

### D3. Global agent-first CLI contract, redaction, selectors, and packaging

- **Binary and Windows packaging.** Add `"bin": { "tsubasa": "./dist/cli/index.js" }` to `package.json` with a `#!/usr/bin/env node` shebang so npm creates Windows `.cmd` and `.ps1` shims. Compile CLI sources via `tsconfig.cli.json` into `dist/cli/`, and add the dev script `"tsubasa": "tsx src/cli/index.ts"`.
- **Command grammar.** Use top-level verbs for file, transfer, and inspection commands: `ls`, `stat`, `find`, `mkdir`, `mv`, `cp`, `rm`, `upload`, `download`, `export`, and `status`. Use `<resource> <action>` for management groups: `pool`, `account`, `job`, `trash`, `share`, `outbox`, `sync`, `auth`, `db`, `ext`, `import`, and `plan`.
- **Windows-safe remote path syntax.** Use `--pool <id|slug>` as the primary pool selector and `--to-pool <id|slug>` for cross-pool `mv`. Support optional `<slug>:/path` shorthand only when `<slug>` is at least 2 characters long so Windows drive paths like `C:\data\file.bin` never collide with pool slugs.
- **Global flags.** Support `--json`, `--dry-run`, `--yes`, `--quiet`, `--show-emails`, `--pool`, `--server`, `--local`, and `--home`. Under `--json`, stdout carries only the valid JSON success payload while progress, logs, and errors go to stderr. `--show-emails` exists strictly as a CLI flag with no environment variable equivalent.
- **Email redaction and lossless `accountRef` join key.** In `src/server/db/schema.ts` and `src/server/drive/auth.ts`, `accounts.id` holds the lowercase email address. Default output masks `email`, `accountId`, `sourceFile`, and emails inside error strings via deterministic 1:1 dot masking that handles 1-character local parts cleanly. Every account-referencing record in `accounts`, `files`, `transferLogs`, `shareLinks`, `outbox`, and `transferJobs` emits a deterministic non-PII `accountRef` formatted as `acc_<8-hex>` from `sha256(accountId)` with no schema change.
- **Account selector resolution.** Resolve account selectors in strict order: `accountRef`, then exact `id` or `email`, then unique case-insensitive email prefix. An ambiguous prefix exits with code `2` and lists each candidate's `accountRef` and masked email.
- **Exit codes.** Align every exit code with `mapDomainErrorToResponse` in `src/server/routes/shared.ts`:

| Exit code | Meaning | Mapped error codes and conditions |
| :--- | :--- | :--- |
| `0` | Success | Command completed without error. |
| `1` | Runtime error | Unexpected failure or unhandled HTTP 500 error. |
| `2` | Usage or validation error | Invalid flags, bad arguments, ambiguous account selector, multi-entity `export --format csv` or `--fields`, or missing `--yes` in non-TTY mode. |
| `3` | Storage or transfer quota limit | 750 MB reserve headroom exhausted, 14.25 GB file ceiling exceeded via `EXCEEDS_CEILING` or `INSUFFICIENT_STORAGE`, or 750 GB 24-hour upload cap reached. |
| `4` | Conflict or lock held | Writer lock held, Share Pool read-only, or domain conflicts `ITEM_EXISTS`, `MOVE_CONFLICT`, `ACCOUNT_POOL_LOCKED`, `POOL_NOT_EMPTY`, and `SHARE_POOL_READ_ONLY`. |
| `5` | Auth or upstream failure | OAuth failure, Drive upstream error, or unreachable explicit `--server` or `TSUBASA_API_URL`. |
| `6` | Not found | Missing file, folder, pool, account, job, or extension mapped from `NOT_FOUND`. |

- **Structured JSON error envelope.** On any non-zero exit when `--json` is active, write one JSON object to stderr:

```json
{
  "ok": false,
  "error": {
    "code": "POOL_NOT_EMPTY",
    "message": "Cannot delete pool: pool contains accounts",
    "exitCode": 4,
    "details": null,
    "hint": "Move or remove accounts in this pool before deleting it."
  }
}
```

- **Non-interactive safety and discovery.** When `!process.stdin.isTTY`, never block waiting for interactive input. Destructive commands including `rm --permanent`, `trash purge`, `pool delete`, `account remove`, `outbox drop`, and `share clear` fail fast with exit `2` unless `--yes` is passed. Implement `tsubasa --help --json` to emit a static schema covering all commands, flags, and exit codes.

### D4. External Drive-to-pool archive import

- **Command and source authentication.** Expose `tsubasa import drive <folderIdOrUrl> --dest <path> --pool <pool> --source-auth <cred.json>`. Accept either a raw Drive folder ID or a pasted Drive URL. Keep source OAuth credentials outside `.oauths/`, cache source tokens under gitignored `data/source-tokens/`, run ephemeral loopback OAuth on `127.0.0.1:0` with a `--no-browser` fallback, and provide a flag or command to clear cached source tokens.
- **Normalized schema v6 job persistence.** Add three tables in schema v6:
  - `transfer_jobs` for top-level job state, kind, target pool, counters, and resumable upload or import metadata.
  - `transfer_job_items` indexed by `(job_id, status)` so 50,000-file imports update individual rows in constant time without WAL write amplification.
  - `transfer_job_shares` storing `(job_id, source_folder_id, target_account_id, permission_id)` so normal completion, `job cancel`, and crash recovery revoke every temporary reader permission.
- **Server-side copy and Drive edge cases.** Default mode uses folder-level temporary reader shares per target account, which requires the `drive` scope on the source token. Query source trees with `supportsAllDrives: true` and `includeItemsFromAllDrives: true`. Retry copy `404` errors with bounded backoff to absorb Drive inherited ACL propagation lag.
- **My Drive `root` handling.** Google Drive forbids `permissions.create` on `root`. When the import target is `root`, create folder-level temporary reader shares for top-level subfolders and route loose root-level files directly through `--mode stream`. Never issue per-file shares, which trigger `sharingRateLimitExceeded`.
- **Streaming fallback.** Support `--mode stream` using under 50 MB RAM and requiring only `drive.readonly` on the source account. Use this path for `writersCanShare=false` folders, non-owned Shared-with-me trees, or explicit user choice.
- **Special item handling.** Report Google Workspace native documents matching `application/vnd.google-apps.*`, Drive shortcuts, items with `capabilities.canCopy === false`, and files over the 14.25 GB `MAX_SINGLE_FILE_BYTES` ceiling upfront during `--dry-run` or `plan import-drive`, and skip them with explicit manifest statuses by default.
- **Placement, verification, and multi-day resume.** Route allocation through `src/server/storage/placement.ts` to enforce the 750 MB headroom reserve and 750 GB 24-hour rolling `transfer_logs` cap. Pause cleanly when hitting the 750 GB 24-hour cap so operators can continue via `job resume` across multiple days. Default `--conflict skip` skips files whose target path and `md5Checksum` already match. Verify `source.md5Checksum === dest.md5Checksum` and byte `size` before marking an item complete. Stream progress to stderr as a TTY bar or NDJSON under `--json`, print the final summary JSON to stdout, and support `--detach` to return `jobId` immediately.

### D5. Resumable byte-verified transfers and jobs

- **Upload fast path for small files.** Files at or below 5 MiB stay on the existing single-shot multipart endpoint `POST /api/files/upload` with streaming MD5 verification against Drive's `md5Checksum`, avoiding `transfer_jobs` overhead for small uploads.
- **Server-owned chunked resumable upload.** Files over 5 MiB use server-owned endpoints `POST /api/transfers/upload` and `PUT /api/transfers/:jobId/chunk` so `src/server/drive/` remains the sole owner of Drive OAuth tokens, headroom reservations, `transfer_logs`, and SQLite commits. Use 8 MiB chunks aligned to 256 KiB boundaries, enforce `chunkSize * concurrency <= 32 MiB` with default `--concurrency 2` to keep total RAM under 50 MB, and persist the Drive session URI plus `(localPath, sizeBytes, mtimeMs)` in `transfer_jobs`.
- **Upload resume and integrity rules.** Abort resume if the local file's `sizeBytes` or `mtimeMs` changed. On resume, query Drive with `Content-Range: bytes */<total>` to inspect the HTTP 308 `Range` offset, restart from byte 0 if the session expired with 404 or 410, and locally re-hash bytes from 0 to `offset` before sending `offset` to EOF so the full-file MD5 matches Drive's `md5Checksum`. If the final hash mismatches, delete the remote Drive file and never commit the SQLite row. Support `-r` and `--recursive`, `--conflict reject|replace|keep_both|skip`, and single-file `-` stdin upload requiring `--size` as non-resumable.
- **Client-side resumable downloads.** Resume downloads purely on the client using `<dest>.part` inside the destination directory to avoid Windows `EXDEV` cross-drive rename failures, paired with a `<dest>.part.meta.json` sidecar holding `fileId`, `driveFileId`, `sizeBytes`, `hash`, and `poolId`. Send `Range` requests to `GET /api/files/:id/download`.
- **Download backend prerequisites and edge cases.** Expose `X-Tsubasa-Hash`, `X-Tsubasa-File-Id`, and `X-Tsubasa-Size` response headers on `GET /api/files/:id/download`, and add a single-file metadata endpoint backing `stat`. Skip the `Range` header for 0-byte files so Drive never returns HTTP 416. If a resumed request returns HTTP 200 instead of 206, truncate `.part` to 0 bytes before writing. Verify exact byte count and hash before atomic rename, selecting MD5 vs SHA-256 by normalized hex string length and logging a warning alongside byte-count verification when `hash` is null. Support `-` stdout download as non-resumable.
- **Unified job commands.** Provide `job list`, `job status <id> [--follow]`, `job resume <id>`, and `job cancel <id>`. Cover persisted `transfer_jobs` of kinds `upload`, `import_drive`, `cross_pool_move`, and `account_evacuate`, plus read-only visibility into live in-memory `oauth_cold_sync` jobs.

### D6. Cross-pool and account operations

- **Cross-pool move engine.** Add `src/server/drive/crossPoolMove.ts` and its backend route. Reject any source or destination targeting Share Pool. Check target collisions using `reject|skip|keep_both|overwrite`, run placement via `src/server/storage/placement.ts` in the destination pool, execute cross-account copy with folder-level temporary share batching for folders and rewritten `appProperties`, verify `md5Checksum` and `size`, commit SQLite updates to `files`, `folders`, `accounts.quota_used_bytes`, and `transfer_logs` atomically, bump both pool revisions and invalidate both overview caches, then delete the source Drive file with `drive_outbox` `file_delete` fallback. Multi-file cross-pool folder moves run as persisted `transfer_jobs`.
- **New backend endpoints.**
  - `POST /api/accounts/:id/evacuate` backed by a persisted `transfer_job`, unified with `DELETE /api/accounts/:id` async evacuation so standalone CLI shutdown cannot orphan an in-memory job.
  - `POST /api/accounts/:id/quota/refresh` wrapping `refreshAccountLiveQuota` in `src/server/drive/client.ts`.
  - `POST /api/pools/reorder` updating `sort_order` atomically while excluding Share Pool.
- **Pool and account CLI coverage.** Implement `pool list`, `pool show`, `pool create`, `pool rename`, `pool delete`, `pool reorder <slugs...>`, and `pool rebalance`. Scope `pool rebalance` strictly to existing `executeAutoRebalance` in `src/server/drive/rebalance.ts` for over-ceiling accounts, with optional `--account` and `--dry-run`. Implement `account list`, `account show`, `account quota`, `account enable`, `account disable`, `account evacuate`, `account move-pool`, and `account remove`. `account move-pool` keeps the empty-account invariant and adds optional `--evacuate` to chain evacuation then pool transfer. `account remove` refuses non-empty accounts unless `--evacuate --yes` is supplied, and supports `--wait`.

### D7. Canonical export contract

- **Single pure backend owner.** Add `src/server/storage/export.ts` and expose it at `GET /api/export`. Reuse `getPooledStorageOverview` and `getTransferStatsByAccountMap` in `src/server/storage/quota.ts` so headroom and 24-hour transfer totals match the rest of the system. Keep the payload canonical to Tsubasa with zero downstream-tool formatting or third-party schema coupling.
- **Canonical schema and redaction.** Emit `schemaVersion: 1`, raw Tsubasa entities only across `pools`, `accounts`, `folders`, `files`, plus optional `transferLogs`, `shareLinks`, `outbox`, and `transferJobs`, deterministic sorting, raw integer byte counts, a `redacted` boolean in the root or meta envelope, default email redaction, and `accountRef` join keys on every account-referencing record.
- **Timestamp normalization.** Convert every exported timestamp to Unix epoch milliseconds, eliminating the SQLite mismatch between Unix seconds on `created_at` and `updated_at` and milliseconds on `transfer_logs.timestamp` and `next_retry_at`. Document `files.updatedAt` as local SQLite index time because Drive `modifiedTime` is not synced.
- **Presets, filters, and formats.** Support presets `minimal`, `standard`, and `full`, `--include`, and filters `--pool`, `--account`, `--path`, and `--trashed`. Support `--format json`, `--format jsonl` streamed via `better-sqlite3` `.iterate()` with `{"_type":"meta",...}` on line 1 followed by `{"_type":"<entity>",...}` records, and `--format csv` restricted to a single `--entity <name>`. Restrict `--fields` to a single `--entity <name>`. Multi-entity `csv` or `--fields` requests fail with exit code `2`.

### D8. Decoupled extensions boundary

- **Discovery and layout.** Load optional extensions from repo-root `extensions/<name>/manifest.json` declaring `name`, `description`, `entry`, `runtime` as `node`, `python`, or `exec`, and optional `minSchemaVersion`. Add `extensions/*` to `.gitignore` while keeping `!extensions/README.md` tracked. Keep `extensions/` generic so any external tool integrates solely through the CLI and `tsubasa export`.
- **Command dispatch.** Expose `tsubasa ext list` and `tsubasa ext <name> [args...]`. Global Tsubasa flags appearing before `ext` configure Tsubasa; all tokens after `ext <name>` pass verbatim to the child process.
- **Security and process lifecycle.** Enforce strict `name` validation against `^[a-z0-9][a-z0-9-]*$` and reject any `entry` path that escapes `extensions/<name>/`. Spawn child processes with `shell: false`, inherit stdio, forward `SIGINT` and `SIGTERM`, and propagate the child's exact exit code.
- **Child environment contract.** Pass `TSUBASA_CLI_BIN`, `TSUBASA_SCHEMA_VERSION`, `TSUBASA_TRANSPORT` set to `http` or `local`, `TSUBASA_HOME`, optional `TSUBASA_POOL`, and `TSUBASA_API_URL` only when an HTTP server is active and unset in local mode. Extensions must never open or write directly to `data/tsubasa.db`.
- **OS-aware Python probe.** Verify candidate interpreters with `--version` returning exit `0` in strict order: `TSUBASA_PYTHON` first; on Windows `py -3`, then `python3`, then `python`; on POSIX `python3`, then `python`.

### D9. Operations and maintenance commands

- **Local-first navigation and batching.** Implement `status`, `stat <path>`, `find <query>`, and `ls` backed by indexed local SQLite queries returning in under 2 ms. Support `--limit`, `afterPath` `--cursor`, `--recursive`, `--glob`, and `--format jsonl`. Implement `mkdir`, `mv` routing same-parent renames to `POST /api/items/rename` and cross-pool moves to `crossPoolMove`, `cp`, and `rm`. Support newline-delimited `--stdin` path lists on `rm`, `mv`, `cp`, and `download`.
- **Online WAL backup.** Implement `db backup <dest>` using `await sqlite.backup(destPath)`. Never use raw `fs.copyFileSync` against a WAL-mode database.
- **Outbox inspection and cleanup.** Add `GET /api/sync/outbox` and `DELETE /api/sync/outbox/:id` plus bulk dead-row deletion, exposed via `outbox list`, `outbox retry`, and `outbox drop`. `outbox drop` defaults to `dead` and `failed` items and requires `--yes`; `--force` permits dropping `pending` rows and warns the operator to run `sync cold`.
- **Audit and duplicate scan.** Implement `audit` with `--local` as default, running read-only `PRAGMA integrity_check`, orphan `folder_id` and `account_id` checks, account quota drift against `SUM(size_bytes)`, over-ceiling detection, and dead outbox counts. `--remote` wraps `scanAccountDiscrepancies` in `src/server/drive/detectorScan.ts`. Implement `dupes` with `--by hash|name-size` backed by the schema v6 index `files_pool_trashed_hash_idx(pool_id, is_trashed, hash)`.
- **Trash, sync, share, auth, and planners.** Implement `trash list|restore|purge`, `sync delta|cold`, `share list|clear`, `auth check` as a read-only credential probe, and `auth add` using ephemeral loopback OAuth plus `--no-browser`. Implement `plan upload` and `plan import-drive` strictly as thin aliases to `upload --dry-run` and `import drive --dry-run` calling one shared planner.

## Phased implementation roadmap

### Phase 0: Prerequisites, schema v6, build, and pure leaf modules

**Dependencies.** None. This phase establishes shared paths, database schema, process locking, packaging, and pure leaf utilities.

- [ ] `[Neon High]` Create `src/server/paths.ts` for `--home` -> `TSUBASA_HOME` -> `import.meta.url` resolution and wire it into `src/server/db/index.ts` and `src/server/drive/auth.ts`.
- [ ] `[Neon High]` Bump `CURRENT_SCHEMA_VERSION` to `6` in `src/server/db/init.ts` and update `src/server/db/schema.ts` with `pools.slug`, `pools.sort_order`, `pools_slug_idx`, `pools_sort_order_idx`, `files_pool_trashed_hash_idx`, `transfer_jobs`, `transfer_job_items`, and `transfer_job_shares`.
- [ ] `[Neon High]` Refactor `src/server/app.ts` to expose `createApp({ enableHttpLogger, enableCompress })` and add `dbFingerprint` to `GET /api/health` in `src/server/routes/instance.ts`.
- [ ] `[Neon High]` Implement shared `data/tsubasa.writer.lock` atomic `O_EXCL` acquisition and stale-PID verification in `src/server/lock.ts` and wire it into `src/server/index.ts`.
- [ ] `[Neon Medium]` Update pool insert sites and `ORDER BY` queries across `src/server/db/init.ts`, `src/server/drive/poolRegistry.ts`, `src/server/routes/pools.ts`, and `src/server/storage/quota.ts`.
- [ ] `[Neon Low]` Scout types and contracts to assemble Context Packets for Argon Medium, add `"bin"` and `"tsubasa"` script to `package.json`, add `tsconfig.cli.json`, and verify `.gitignore` coverage for `data/source-tokens/` and `data/tsubasa.writer.lock` under `data/`.
- [ ] `[Argon Medium]` Implement pure leaf modules 1 through 5 and 7 under `src/cli/lib/` from Context Packets: `redact.ts`, `selectors.ts`, `format.ts`, `errors.ts`, `chunks.ts`, and `helpSchema.ts`.

**Phase 0 verification.**
- Run `npm run typecheck` and `tsc -p tsconfig.cli.json` with zero errors.
- Migrate an existing v5 `data/tsubasa.db` copy to v6 and verify `pools.slug`, `pools.sort_order`, indexes, and new transfer tables via SQLite pragma checks.
- Confirm `GET /api/health` returns `service: "tsubasa-backend"` and `dbFingerprint` without raw OS paths, and confirm two server processes cannot hold `data/tsubasa.writer.lock` simultaneously.

### Phase 1: Core CLI shell, transport, discovery, and maintenance operations

**Dependencies.** Phase 0 complete.

- [ ] `[Neon Medium]` Build `src/cli/index.ts` and `src/cli/transport.ts` with 250 ms HTTP-first `/api/health` probe, `dbFingerprint` validation, `--server`, `--local`, lazy `createApp({ enableHttpLogger: false, enableCompress: false })` import, writer lock acquisition with post-lock health re-probe, outbox drain with `--no-wait-outbox`, and clean shutdown.
- [ ] `[Neon Medium]` Add missing backend endpoints: `POST /api/pools/reorder` in `src/server/routes/pools.ts`, `POST /api/accounts/:id/quota/refresh` in `src/server/routes/accounts.ts`, `GET /api/sync/outbox` and `DELETE /api/sync/outbox/:id` plus dead bulk drop in `src/server/routes/sync.ts`, and single-file metadata lookup in `src/server/routes/files.ts`.
- [ ] `[Neon Medium]` Implement `auth add` ephemeral loopback OAuth flow with `--no-browser` support in `src/cli/commands/auth.ts`.
- [ ] `[Hydrogen High]` Implement global flag parsing, non-TTY `--yes` enforcement, `--help --json`, and core file commands in `src/cli/commands/`: `status`, `ls`, `stat`, `find`, `mkdir`, `mv` for intra-pool moves and same-parent `POST /api/items/rename`, `cp`, `rm`, and newline `--stdin` support.
- [ ] `[Hydrogen High]` Implement management and maintenance commands in `src/cli/commands/`: `pool` CRUD and `reorder`, `account` `list|show|quota|enable|disable|move-pool`, `trash`, `sync`, `outbox`, `share list|clear`, `auth check`, `audit` local and remote modes, `dupes`, and WAL-safe `db backup` via `sqlite.backup()`.
- [ ] `[Neon High]` Review standalone write-lock TOCTOU handling, read-only `authPool.scan()` bypass, and outbox drain edge cases.
- [ ] `[Neon Low]` Run `npm run typecheck`, `npm run build:server`, and CLI build checks.

**Phase 1 verification.**
- Run `tsubasa status --json` and `tsubasa ls --json` in both HTTP mode against a running server and `--local` mode, verifying zero stdout pollution, redacted emails, and consistent `accountRef` values.
- Verify `tsubasa --help --json` parses cleanly and non-TTY destructive commands fail with exit code `2` without `--yes`.
- Verify `tsubasa db backup <dest>` produces a valid SQLite database passing `PRAGMA integrity_check` while the server is active.

### Phase 2: Canonical export and extensions runner

**Dependencies.** Phase 1 complete.

- [ ] `[Neon Medium]` Implement pure `src/server/storage/export.ts` reusing `getPooledStorageOverview` and `getTransferStatsByAccountMap`, normalizing all timestamps to Unix epoch milliseconds, and streaming JSONL via `better-sqlite3` `.iterate()`.
- [ ] `[Neon Medium]` Expose `GET /api/export` in `src/server/routes/storage.ts` and wire `src/cli/commands/export.ts` for presets `minimal|standard|full`, `--include`, filters, `json`, `jsonl`, and single-entity `csv` and `--fields`.
- [ ] `[Neon Low]` Assemble the Context Packet for Argon Medium leaf module 6, create `extensions/README.md`, and add `extensions/*` with `!extensions/README.md` to `.gitignore`.
- [ ] `[Argon Medium]` Implement `src/cli/lib/extensions.ts` covering `manifest.json` validation, `^[a-z0-9][a-z0-9-]*$` name checks, `entry` containment guard, OS-aware Python probe, and `spawn` execution with `shell: false` and signal forwarding.
- [ ] `[Hydrogen High]` Wire `src/cli/commands/ext.ts` for `tsubasa ext list` and `tsubasa ext <name> [args...]` with exact child env vars and verbatim passthrough arguments.
- [ ] `[Neon High]` Review JSONL streaming memory usage on large catalogs and verify extension path-traversal rejection and `TSUBASA_API_URL` omission in `--local` mode.

**Phase 2 verification.**
- Verify `tsubasa export --format jsonl` streams line 1 `{"_type":"meta",...}` with Unix millisecond timestamps and matching `accountRef` join keys across entities.
- Confirm multi-entity `tsubasa export --format csv` and multi-entity `--fields` fail with exit code `2`.
- Run a smoke extension via `tsubasa ext <name> --flag value` confirming verbatim arg forwarding, exit code propagation, and rejection of `../` manifest entries.

### Phase 3: Resumable byte-verified transfers, account evacuation, and cross-pool moves

**Dependencies.** Phase 1 complete. Can run in parallel with Phase 2 once Phase 1 stabilizes.

- [ ] `[Neon High]` Implement server-owned chunked resumable upload endpoints `POST /api/transfers/upload` and `PUT /api/transfers/:jobId/chunk` in `src/server/drive/resumableUpload.ts` and `src/server/routes/transfers.ts`, enforcing 8 MiB chunks, `chunkSize * concurrency <= 32 MiB`, `308 Range` offset resume, expired `404`/`410` restart, local re-hashing of bytes before `offset`, and full-file MD5 verification with remote delete on mismatch.
- [ ] `[Neon High]` Add streaming MD5 verification to the `<= 5 MiB` `POST /api/files/upload` fast path and expose `X-Tsubasa-Hash`, `X-Tsubasa-File-Id`, and `X-Tsubasa-Size` on `GET /api/files/:id/download` in `src/server/routes/files.ts`.
- [ ] `[Neon High]` Implement `src/server/drive/crossPoolMove.ts` and route for single-item and persisted-job multi-file cross-pool moves, rejecting Share Pool, verifying `md5Checksum` and `size`, updating both pool revisions and overview caches, and falling back to `drive_outbox` `file_delete` on source cleanup failure.
- [ ] `[Neon High]` Implement persisted `POST /api/accounts/:id/evacuate` and unify `DELETE /api/accounts/:id` async evacuation onto `transfer_jobs`.
- [ ] `[Neon Medium]` Wire shared upload dry-run planning for `upload --dry-run` and `plan upload`, plus `GET /api/jobs` combining persisted `transfer_jobs` and read-only live `oauth_cold_sync` entries.
- [ ] `[Hydrogen High]` Implement CLI commands in `src/cli/commands/`: `upload` with `-r`, `--conflict`, and `-` stdin upload, client-side `.part` plus sidecar resumable `download` handling 0-byte files, HTTP 200 truncation, hash-length detection, and `-` stdout output, `job list|status [--follow]|resume|cancel`, cross-pool `mv --to-pool`, `account evacuate`, `account remove --evacuate --yes [--wait]`, `account move-pool --evacuate`, `pool rebalance`, and `plan upload`.
- [ ] `[Neon Low]` Run `npm run typecheck` and build verification across server and CLI targets.

**Phase 3 verification.**
- Interrupt and resume an upload over 5 MiB, confirm `308 Range` recovery, verify MD5 match against Drive, and confirm local file mutation aborts resume.
- Interrupt and resume a multi-megabyte download via `.part` and sidecar, plus verify 0-byte download without `Range` and HTTP 200 truncation handling.
- Execute a cross-pool `mv` and an `account evacuate`, verifying source cleanup, SQLite quota reconciliation, and persisted job status transitions.

### Phase 4: External Drive-to-pool archive import

**Dependencies.** Phase 3 complete.

- [ ] `[Neon High]` Implement `src/server/drive/importDrive.ts` and import routes backed by `transfer_jobs`, `transfer_job_items`, and `transfer_job_shares`, supporting folder-level temporary reader shares, `supportsAllDrives: true` and `includeItemsFromAllDrives: true`, bounded backoff retries on copy 404 ACL propagation lag, My Drive `root` subfolder-share plus loose-file stream split, `--mode stream` fallback under 50 MB RAM, Workspace doc or shortcut or `> 14.25 GB` skipping, `md5Checksum` and `size` verification, and clean pause on the 750 GB 24-hour cap for multi-day `job resume`.
- [ ] `[Neon Medium]` Implement `--source-auth <cred.json>` OAuth flow with `127.0.0.1:0` loopback, `--no-browser` fallback, gitignored `data/source-tokens/` caching, token clear action, and shared dry-run planner for `import drive --dry-run` and `plan import-drive`.
- [ ] `[Hydrogen High]` Implement `src/cli/commands/import.ts` and `plan import-drive` alias with folder ID or URL parsing, stderr TTY progress bar or `--json` NDJSON events, stdout summary JSON, and `--detach`.
- [ ] `[Neon High]` Run final durability review across temporary share revocation on completion, `job cancel`, and crash recovery, memory bounds under 50 MB, and end-to-end exit code fidelity.
- [ ] `[Neon Low]` Run final `npm run typecheck`, `npm run build`, and documentation unslop pass.

**Phase 4 verification.**
- Run `tsubasa plan import-drive` on a mixed Drive tree containing standard files, subfolders, Workspace native docs, and shortcuts, verifying accurate upfront skip reporting and placement preview.
- Execute a real server-side copy import and a `--mode stream` import, verifying `md5Checksum` parity and confirming zero leftover temporary permissions on `job cancel` and normal completion.
- Simulate hitting the 750 GB 24-hour cap and verify clean job pause followed by `tsubasa job resume <id>` without re-copying verified files.
