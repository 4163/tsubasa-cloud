# Guidelines

Coding standards, architecture rules, and agent workflow for Tsubasa~.

## Code guidelines
- **Self-documenting code.** Write code that reads clearly on its own. Use descriptive names and flat control flow (early returns over multi-layer nesting). Keep comments minimal and concise. Reserve them for *why*, non-obvious constraints, and maintained module invariants. A short local heading is fine when a file needs to explain an ownership, lifecycle, or persistence rule. Do not add commentary that merely narrates the code.
- **Performance first.** Avoid dynamic evaluations and allocations in hot paths. Cache aggressively.
  *Practical examples for agents (match the pattern to the local-first storage and virtualized UI architecture):*
  1. **Local-first read path.** The frontend never calls Google Drive to list files, expand directories, or run searches. 100% of read operations hit indexed local SQLite tables, returning in under 2 milliseconds.
  2. **Zero-copy streaming pipeline.** Uploads and downloads stream directly through Hono without buffering complete files in memory or writing temporary files to local disk. Memory overhead remains under 50 MB even during 14 GB transfers.
  3. **Instant virtual operations with lazy sync.** Folder renames, virtual file moves, and path updates apply instantly to SQLite. The UI reflects changes immediately, while background tasks update Google Drive `appProperties` asynchronously.
  4. **Incremental delta synchronization.** Tsubasa avoids repeated tree crawls. After initial account initialization, synchronization uses Google Drive's `changes.list` API with stored page tokens, fetching only modified records in a single payload.
  5. **Constant-time DOM rendering.** Large directories with tens of thousands of items are rendered using viewport virtualization (TanStack Virtual). The DOM node count remains constant regardless of folder size.
  6. **Storage placement and headroom checks.** Never write files without verifying account headroom against the strict 750 MB reserve ceiling (14.25 GB maximum on 15 GB accounts). Respect the 14.25 GB single-file limit and path-affinity rules before allocating.
  7. **Rolling transfer window tracking.** Track Google upload limits (750 GB per rolling 24-hour window per account) in the SQLite `transfer_logs` ledger to prevent account-level rate lockouts.
  8. **Pre-computed database lookups.** Keep SQLite queries inside indexed columns (`account_id`, `virtual_path`, `parent_id`). Run SQLite with WAL mode and avoid synchronous blocking queries in hot request loops.
- **Measure twice, cut once.** Prefer small, deliberate changes over broad refactors. Before writing new logic, search the codebase for an existing helper that already does the job. Prefer intuitive shared helpers over inlining repeated lines of code for identical operations. If a change duplicates logic across callsites, extract it into a shared helper instead.
- **Work in logical slices.** Prioritize small, precise code changes rather than big blocks to prevent tooling and scope failures, especially during large refactors. Be surgical!
- **YAGNI.** Do not add abstractions, features, or complexity without a clear need.

## Agent behavior
- Read every rule and referenced skill before starting work. Confirm adherence to the user.
- Keep responses concise and focused on the task.
- Follow existing code style and formatting for each directory and its associated files.
- For writing work, read `.agents/skills/unslop/SKILL.md` and follow it even if the harness does not auto-load always-active skills. This applies to docs, prompts, comments, and user-facing copy.

### Guardrails
- **No automated git commits.** Never execute git commit commands or automate commits unless explicitly instructed. The user handles all commits manually or through the commit pipeline (`make push`).
- **Downstream safety.** When modifying shared database schemas (`src/server/db/schema.ts`), storage placement engines (`src/server/storage/placement.ts`), quota logic (`src/server/storage/quota.ts`), or Hono API routes (`src/server/app.ts`), stop and verify that downstream callers and consumers remain unbroken. Do not rely on speculation. Execute type checks and verify runtime behavior.
- **Respect established structure.** Do not move, rename, or reorganize files, folders, or asset paths. Keep changes localized to the files being edited.
- **Preserve behavioral contracts.** Refactors must not alter existing functionality, return types, or output schemas unless there is an explicit functional win. Never alter SQLite schema columns or Google Drive `appProperties` keys without updating all callers, sync mechanisms, and owning documentation.
- **No test harness creation during implementation.** Do not create new test suites or test harnesses while implementation work is in progress. Manual runtime tests carry higher value because test harnesses written against incomplete code are fragile and waste implementation time. Edit existing tests only when a code change breaks them. Using manual curl checks, API scripts, or typecheck runs to debug implementation work is allowed.
- **No premature finalization.** Never declare work done, implemented, or complete until the user explicitly says so. Do not write completion summaries or treat a slice as finished on your own.

## Architecture rules

Keep the codebase from drifting into mixed patterns. Apply these on every change. Order for UI work is structure, then presentation, then behavior.

### Shared
- **One owner per concern.** Each responsibility has exactly one writer: account auth pooling, storage placement, SQLite schemas, streaming proxy, and UI table virtualization.
- **Folders are a byproduct of splitting.** A file moves into a feature folder only when a slice creates a sibling. No pure reorganization changes.
- **Pure modules first.** Storage placement, quota calculations, and database models have zero UI/DOM imports. Frontend components interact with them strictly through Hono RPC; never the reverse.
- **Communicate across boundaries via typed RPC, not reach-in.** The client consumes backend endpoints via the type-safe Hono RPC client (`src/client/api.ts`). Server modules do not import client components or view models.
- **Refactors do not change behavior** unless there is a practical function, durability, or performance win.

### Frontend and StyleX styling
- **Compile-time CSS with StyleX.** Define styles using StyleX (`@stylexjs/stylex`). Avoid inline style tags, runtime CSS-in-JS libraries, or utility class clutter.
- **Design tokens as source of truth.** Colors, spacing, typography, and elevation live in `tokens.stylex.ts`. Components consume tokens rather than hardcoding arbitrary magic numbers.
- **WCAG AAA accessibility and theme support.** Maintain minimum 7:1 contrast ratios across both dark and light themes.
- **Virtualized table rendering.** Virtual file and directory lists must use TanStack Virtual to keep DOM node counts constant. Never render unbounded file lists directly into the DOM.
- **Minimal DOM writes.** Update indicators, status readouts, and badges using plain text and StyleX class rules. Batch state transitions to avoid layout thrashing.

### Server and storage engine ownership
- **Local-first SQLite index.** `src/server/db/` owns SQLite connections, pragmas (WAL mode), migrations, and Drizzle schemas. Sub-millisecond indexed queries back all read operations.
- **Drive synchronization and auth pool.** `src/server/drive/` owns OAuth client pooling, token refreshment, Google Drive API wrappers (`about.get`, `changes.list`, `files.create`), and physical folder mirroring (`Tsubasa Storage/`).
- **Storage placement and quota calculation.** `src/server/storage/` owns the Folder-Cohesion Best-Fit algorithm, bottom-up branch sizing, 750 MB safety buffer headroom math, and 24-hour transfer logging.
- **Streaming transfer pipeline.** Hono routes (`src/server/app.ts`) handle resumable uploads and downloads using standard Web Streams (`ReadableStream`), bypassing disk buffering and keeping memory under 50 MB.
