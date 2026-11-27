# Tsubasa~ Cloud live demo specification

Replace the static `DummyWindow` placeholder on `/` with a self-contained interactive demo built directly from the main app's frontend on `main`. Building from the main app avoids UI duplication and backs the demo with a client-only, metadata-only IndexedDB mock layer.

Promote the built demo bundle into `site/` through a local sync command so the orphan `site` branch stays self-contained and deployable on static hosts. Mount the synced demo bundle on `/` inside the existing centered fixed-size window frame using an `<iframe>`.

Keep all existing static pages and assets intact: the `/` hero, `/data-policy`, shared header and footer, dither canvas, grain overlay, fonts, SEO metadata, and brand assets.

## 1. Boundaries, host behavior, and visual parity

- **Fixed container.** Keep the centered, fixed-size window frame at `1120px` by `640px` on desktop and `100%` by `540px` on mobile. Never make the demo frame user-resizable or expandable.
- **Grain overlay.** Keep the demo app's own grain overlay intact and exclude the demo frame on `site/` using the site's existing grain-masking mechanism so grain does not double-stack.
- **Hybrid theme sync.** The demo keeps its own independent 3-way theme toggle and separate `localStorage` persistence so reloads avoid visual jank. Switching theme on the `site/` frontend pushes the resolved theme to the demo regardless of the demo's current theme, doing nothing if the theme already matches, while still allowing independent theme switches inside the demo afterward.
- **`Reset demo` button.** Append a `Reset demo` button after the GitHub button in the demo header. Clicking it wipes the demo IndexedDB state and restores the initial seeded dataset.
- **No multi-tab lock.** Skip multi-tab and instance lock blocking in demo mode.
- **Visual and interaction parity.** Match `docs/styling-guide.md` and `src/client/`: flat 1px structural borders, no drop shadows, 3px gold selection bars, WCAG AAA 7:1+ contrast, no gold text on light surfaces, native Top-Layer `<dialog>` modals and drawers, no right-click or overflow context menus, no toast notifications, no `Ctrl+Z` undo stack, and responsive layouts for desktop `> 768px` and mobile `<= 768px`.
- **Metadata-only persistence and zero network calls.** Store only dummy metadata and text records in IndexedDB. Never read or write real file bytes or binary blobs, and make zero outbound network calls.
- **Copy.** Follow `.agents/skills/unslop/SKILL.md` for all visible labels, empty states, and helper text.

## 2. Live demo scope

Match `src/client/` 1:1 while dropping CLI-only and non-UI actions.

- **Pools.** Create, rename, and delete standard pools. Share Pool is protected. Drop CLI-only pool reordering.
- **Modified OAuth import and dummy account pool.** Sidebar OAuth import accepts any `.json` file and creates an unauthorized account card with a dummy OAuth link, replacing the copy-link control with an `Authorize` button. Clicking `Authorize` picks an unused account at random from the locked 14-account roster below, excluding picked accounts until every account in the roster has been used, then refilling the pool.
- **Accounts and quotas.** Support `RedactedEmail` masking, 750 MB reserve headroom math with `14.25 GB` usable on `15 GB` accounts, `14.25 GB` single-file ceiling checks, 24-hour rolling transfer gauges with a `750 GB` daily cap, buffer-breach indicators, enable and disable toggles, moving accounts between pools, and removing accounts. Drop CLI-only account evacuation.
- **Virtualized file table and CRUD.** Use TanStack Virtual rows with sorting, search, interactive breadcrumbs, multi-select, folder navigation, new folder, rename, internal drag-and-drop and cut/paste move with conflict handling, copy, on-the-fly dummy placeholder file downloads, soft-delete to Trash, restore, and permanent purge or empty trash. Reclaim quota only on permanent purge.
- **OS drag-and-drop and simulated uploads.** Read only file metadata (`name`, `size`, `type`, relative path, timestamp), show Folder-Cohesion Best-Fit placement previews and conflict checks, and run simulated upload progress with abort and cancel controls in `UploadDrawer`.
- **Rebalancing.** Support single-file account switching, batch moving files between accounts, and Auto-rebalance for buffer-breached accounts.
- **Sync and external changes.** Provide working Sync All and `ExternalChangesDrawer` backed by the pre-seeded `Main Pool` discrepancies below.
- **Public sharing and Share Pool.** Support the first-time `ShareModal` flow: inspect selection, validate empty-drive expansion, copy into the newly created Share Pool, and produce copyable dummy share links. Include the read-only Share Pool view and `Clear Share Pool`. Drop per-link revoke inside `ShareModal`.

### Initial pool seeding

Do not pre-generate the Share Pool so visitors experience the first-time sharing flow. Do not pre-seed an unauthorized account.

- **`Main Pool`, default pool on first load.** Start with 5 pre-seeded accounts from the locked 14-account roster. Prefill a light, generic personal-cloud tree with a few folders and files so `/` stays clean and approachable. Include 2 pre-seeded Trash items for testing Restore and permanent-purge quota reclaim, plus light non-zero 24-hour transfer activity on 1 to 2 accounts. Pre-seed uncluttered external changes across 2 accounts: one buffer-breached account with Auto-rebalance and 1 `overCeiling` file for `Move to root`, and a second account with 1 `unindexed`, 1 `modified`, and 1 `missingRemote` item. Skip seeding path conflicts and keep all other accounts clean.
- **`Hocchan Union`, secondary pool.** Do not present this pool on initial load. Seed it from a static trimmed snapshot of `https://hocchan.netlify.app/archive/drive/g` via `directories_g.json`, never fetched at runtime, preserving accurate real file sizes from the archive. Include at least one `0 B` empty eligible account in `Hocchan Union` so visitors can test first-time Share Pool expansion immediately while leaving enough personas from the 14-account roster for the random `Authorize` pool.
- **`directories_g.json` folder rules.**
  - **Keep and reduce.** `Albums`, `PVs`, `Singles`.
  - **Keep with targeted reduction.** `Anime OP-ED-INs` keeping `Uta Monogatari` and reducing `(AMQ, AnisongDB) Compilation`; `DVDs／BDs` dropping `Others/` and reducing heavily to roughly 1 to 3 entries because of large file sizes; `Lives` reducing heavily to roughly 1 to 3 entries because of large file sizes; and `Pictures` dropping everything except `[Photobook]` subfolders and reducing further if still too large.
  - **Drop.** `Anime`, `Contributions`, `Gamerips`, `SNS`, `TV-Variety`, `Tracks`.
- **Reduction heuristic.** Implementation agents choose which entries to keep during consensus based on popular or well-known albums, singles, and titles so accurate real file sizes fit cleanly within the pool's assigned accounts, accounting for the 14-persona cap across `Main Pool`, `Hocchan Union`, and the random `Authorize` pool.

### Locked 14-account roster

The user supplies profile pictures during or after implementation. Use these exact display names and email addresses:

| # | Display name | Email |
| --- | --- | --- |
| 1 | Hitagi Senjougahara | `hitagi.senjougahara@gmail.com` |
| 2 | Mayoi Hachikuji | `mayoi.hachikuji@gmail.com` |
| 3 | Suruga Kanbaru | `suruga.kanbaru@gmail.com` |
| 4 | Nadeko Sengoku | `nadeko.sengoku@gmail.com` |
| 5 | Tsubasa Hanekawa | `tsubasa.hanekawa@gmail.com` |
| 6 | Kiss-Shot | `shinobu.oshino@gmail.com` |
| 7 | Karen Araragi | `karen.araragi@gmail.com` |
| 8 | Tsukihi Araragi | `araragi.tsukihi@gmail.com` |
| 9 | Yotsugi Ononoki | `ononoki.rulebook@gmail.com` |
| 10 | Ougi Oshino | `ougi.oshino0@gmail.com` |
| 11 | Sodachi Oikura | `sodachi.oikura@gmail.com` |
| 12 | Izuko Gaen | `izuko.gaen@gmail.com` |
| 13 | Yozuru Kagenui | `yozuru.kagenui@gmail.com` |
| 14 | Suicide-Master | `deathtopia.vsm@gmail.com` |

## 3. Swarm execution and consensus workflow

Run the build as a coordinated `/swarm` session with live multi-agent consensus. Do not pre-decide file splits, internal code structure, or fixed model-to-role assignments. Implementation agents decide architecture details, module and file boundaries, seed allocation across the 14 accounts, disjoint ownership splits, and worker tiers live through unanimous consensus.

### Branching and worktree guardrail

Before starting any implementation edits, create paired feature branches inside the two existing worktrees instead of editing `main` or `site` directly:

- Cut one feature branch off `main` in the root worktree for the demo build, transport seams, and sync command.
- Cut one feature branch off `site` in `site/`, preserving the orphan `site` lineage, for the `<iframe>` mount, grain masking, theme sync, and synced bundle.
- Keep all swarm workers on `workspace: "inherit"` with disjoint file ownership so both worktrees stay in their existing paths for local syncing and live verification.

### Model pool and tier baseline

Verify exact model identifiers via `swarm{action:"models", all:true}` before spawning workers. Restrict all spawned workers strictly to the Neon family (`High`, `Medium`, `Low`). Never spawn Hydrogen agents. Guide allocation with this tier baseline:

- **`Medium` as default workhorse.** Use `Medium` for planning, standard implementation tracks, contract checks, and standard verification.
- **`High` for targeted precision.** Reserve `High` for high-risk or ambiguous invariants such as IndexedDB state and quota math, cross-frame theme sync, or complex cross-layer seams, with explicit justification naming the touched invariants.
- **`Low` for bounded mechanical work.** Use `Low` only for deterministic, low-ambiguity tasks with a clear agreed spec.
- **Minimum `Medium` floor.** Keep at least a `Medium` or `High` reviewer on every critical review and blocking fix sign-off.

### Unanimous consensus protocol

Every discussion gate requires unanimous agreement among the assigned agents:

1. **No empty agreement.** Each participant casts `[Agree]`, `[Amend]`, or `[Block]` with concrete proof such as inspected files, contrast checks, command output, or rendered browser checks. Bare agreement is invalid.
2. **Symmetric hard block on facts, safety, and invariants.** A substantiated `[Block]` stops an item from becoming `[Agreed]` when it proves a factual error, broken invariant, or safety violation. The group must fix, re-classify, or drop the item.
3. **Two-round escalation valve on judgment ties.** When agents agree on facts and rules and only judgment differs, run at most 2 debate rounds. If still tied after round 2, send a concise Escalation Brief with both positions to the coordinator to select and ratify.
4. **Outcome tags.** Every candidate resolves to `[Agreed]`, `[Dropped]`, or `[Escalated]`.

### Consensus-driven stages

1. **Design, architecture, and split consensus.** Planning workers inspect this spec, `docs/styling-guide.md`, `src/client/`, and `site/` to reach unanimous consensus on architecture details, module and file boundaries, seed allocation across the 14 accounts, disjoint ownership splits, and worker tiers.
2. **Parallel disjoint implementation with seam consensus.** Implementation workers build in parallel across non-overlapping files. Before final integration, adjacent workers post their shared contracts on the board and reach unanimous seam consensus with zero conflicts.
3. **Independent author and auditor verification consensus.** Keep implementation workers separate from auditors. Auditors verify typecheck, build, live light/dark and desktop/mobile rendering, zero-blob IndexedDB and zero-network invariants, `.agents/AGENTS.md` compliance, and `.agents/skills/unslop/SKILL.md` compliance. Any substantiated `[Block]` returns to the owning worker for an in-place fix and another verification pass until unanimous sign-off.
4. **Handoff.** Leave all completed workers `waiting` rather than killing them, confirm no leftover temporary files remain, and do not run `git commit` or `git push`.
