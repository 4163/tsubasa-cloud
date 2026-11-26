# Tsubasa~ Cloud website specification

Static two-page site on the orphan `site` branch. Satisfies Google Cloud OAuth external production branding requirements (homepage URL and privacy/data policy URL) and gives visitors an overview of the app, followed by a gated Phase 2 interactive demo.

> **Interactive demo gate:** Do **not** start implementing the interactive IndexedDB dummy app (Section 7, Phase 2) until the user explicitly confirms that both static pages (`/` and `/data-policy`) are complete. In Phase 1, render a centered, fixed-size styled dummy window placeholder on `/` as the minimum.

## 1. Stack and build

Matches the main application frontend stack with no server runtime:

- **Framework:** React 19 + TypeScript
- **Styling:** Compile-time StyleX (`@stylexjs/stylex` + `unplugin-stylex`), sharing the token definitions from `docs/styling-guide.md`
- **Virtualization:** TanStack Virtual (`@tanstack/react-virtual`) for the interactive app demo table and drawers
- **Bundler:** Vite 6 configured as a two-entry static multi-page build (MPA)
- **Hosting:** Provider-agnostic static hosting deployed from the `site` branch (publishing `dist/`)

### Routes

| Route | Static output | Purpose |
|---|---|---|
| `/` | `dist/index.html` | Homepage with project overview and interactive dummy app |
| `/data-policy` | `dist/data-policy/index.html` | Centered plain-English data policy for Google OAuth Branding and end users |

Each route is a real HTML file with its own `<head>` metadata, canonical link, and inline zero-flash theme boot script.

## 2. Writing and voice

- End-user facing, not developer facing. Avoid internal architecture jargon (SQLite WAL, Drizzle, Hono RPC, `appProperties`) on the site pages unless a concrete user-facing fact needs a plain name (for example, "stored locally on your computer").
- Concise and direct. No subtitles under headings, no marketing fluff, no narration prose.

## 3. Visual direction

Grounded in `docs/styling-guide.md`, the built app (`src/client/`), and the visual language of `docs/teardowns/hanekawa.md` (pixel-crisp dithering and gold accents, without copying Hanekawa's fixed-viewport integer-scaled layout).

### Tokens and typography
- Reuse the app's light and dark color tokens (`#eef2ec` / `#f7faf5` light, `#0b1412` / `#12211d` dark, `#135349` / `#35c4a8` brand accent, `#deb76c` / `#d4a13c` gold accent, flat 1px structural borders, no drop shadows).
- Maintain WCAG AAA contrast (7:1+) for primary, secondary, and status text. Never render gold as text on light surfaces.
- Fonts: `Pixelify Sans` for brand wordmark and display headings; `Montserrat` for body copy and UI controls.
- Scrollbars: 6px pill scrollbars matching the app.

### Grain overlay
Match `src/client/global.css` exactly:
- **Light mode:** 128x128 pre-attenuated PNG data URI at `opacity: 0.8`.
- **Dark mode:** 256x256 SVG `feTurbulence` (`baseFrequency="0.9"`, `numOctaves="4"`, rect `opacity="0.2"`) at `opacity: 0.35`.
- Fixed `pointer-events: none` layer (`z-index: 9999`) applied to `.grain-overlay` and `dialog:modal::after`.

### Dither canvas
- Uses a 4-tone Bayer 4x4 dither canvas quantized to Tsubasa's sage-mint light and dark palette.
- Phase 1 renders the dither canvas without separate `DitherDivider` strips.
- Hovering dithered background transition pixels on desktop intentionally switches the cursor to `text` as texture emulation, excluding the header, footer, interactive controls, and the preview window.

## 4. Shared layout chrome

Present on both `/` and `/data-policy`.

### Header
- Omits a header brand link because branding assets already appear on the page.
- Direct navigation links for both pages (`Home` and `Data Policy`).
- Single circular light/dark theme toggle button:
  - Auto-detects `prefers-color-scheme` on first visit and stores user overrides in `localStorage` (avoids a 3-button Auto/Light/Dark control).
  - Animates theme switches using the View Transitions API radial `clip-path: circle(...)` expansion from the button's click coordinates (or button center for keyboard activation).
  - Falls back to an instant switch when `document.startViewTransition` is unavailable or `prefers-reduced-motion: reduce` is active.

### Revealing footer
Sticky reveal-from-behind footer at the bottom of the page containing:
- Primary signature: `Tsubasa~ Cloud ◦ x4163`, with `Tsubasa~ Cloud` linking to GitHub.
- Omits `#8170` here because the full Discord handle already appears on `/data-policy`.

## 5. Brand and social assets

Source assets live in `docs/` on `main` and will be copied (and web-optimized where needed) into `site/public/` or `site/src/assets/`:

| Asset | Source file | Notes |
|---|---|---|
| App mark | `docs/svg-r44-app.svg` (884x884, transparent) | Adapts cleanly to both light and dark surfaces |
| Readme mark | `docs/svg-r44-readme.svg` (822x884, baked cream gradient `#f0eeca` to `#ffffdd`) | Keep both SVG options open; implementing agent decides which fits each slot |
| Hero banner | `docs/banner-mono.png` (4.5 MB raw) | Must be used on the site (web-optimized WebP/PNG export recommended for fast page load) |
| Social preview | `docs/social-preview-1280x640.jpg` (308 KB, 1280x640) | Preferred for Open Graph (`og:image`) and Twitter Card (`twitter:image`); implementing agent decides final wiring |

## 6. SEO and static metadata

Keep what search engines and link previews use while omitting deprecated or redundant tags (`pragma`, `expires`, `X-UA-Compatible`, `meta keywords`, and JS-injected JSON-LD):

- Per-page `<title>`, `<meta name="description">`, and `<link rel="canonical">`.
- Open Graph tags (`og:type`, `og:url`, `og:title`, `og:site_name`, `og:description`, `og:image`, `og:image:width`, `og:image:height`, `og:image:alt`).
- Twitter Card tags (`twitter:card="summary_large_image"`, `twitter:title`, `twitter:description`, `twitter:image`).
- Static inline `<script type="application/ld+json">` embedded directly in each HTML file (`WebSite` + `SoftwareApplication` on `/`; `WebPage` on `/data-policy`).
- `robots.txt` and `sitemap.xml` (listing `/` and `/data-policy`), with canonical and sitemap URLs driven by a configurable site origin.

## 7. Homepage (`/`)

1. **Hero section.** `Tsubasa~ Cloud` title, brand visual, concise end-user explanation of what Tsubasa does (combines personal Google Drive accounts into one virtual drive, keeps files whole, mirrors folders so they stay browsable on Google Drive, runs locally on Windows or in a browser), and the primary `Download` link. GitHub is linked from the footer and `/data-policy`.
2. **App preview window.** A simple, centered, fixed-size dummy window (not dynamically resizable or expandable) styled to match the Tsubasa workspace.
   - **Phase 1 minimum:** Static styled dummy window placeholder framed to the exact final dimensions and visual tokens so the page layout is complete without building interactive app logic yet.
   - **Phase 2 (gated):** Replaced by the interactive dummy app below only after the user confirms both `/` and `/data-policy` are complete.

### Interactive demo requirements (Phase 2, gated, never start without approval)

> **STOP:** Never start this section during the initial site build. Wait for explicit user confirmation that both static pages (`/` and `/data-policy`) are complete first.

When approved, replace the styled dummy window placeholder with a full client-side replica (including a `Reset demo` button to restore initial sample data). All state persists in the browser via **IndexedDB using dummy metadata and text records only**. Never store real file bytes or binary blobs in IndexedDB. No network calls.

- **Pools and sidebar.** Multiple pre-seeded standard pools plus the read-only `Share Pool`. Create, rename, delete, and reorder pools.
- **Accounts and quotas.** Pre-seeded dummy accounts with masked emails (`RedactedEmail`), 750 MB reserve headroom math, 14.25 GB single-file limit checks, 24-hour rolling transfer gauges, and buffer-breach indicators. Add dummy accounts, toggle enable/disable, move between pools, evacuate, or remove.
- **Virtualized file table.** TanStack Virtual rows with sorting, search, breadcrumbs, multi-select, and folder navigation.
- **Drag-and-drop and uploads.** Drop files or folders from the OS (or pick via upload button) to read only file metadata (`name`, `size`, `type`, relative path, timestamp) and store dummy metadata records in IndexedDB with simulated upload progress in `UploadDrawer`, folder-cohesion best-fit placement, and internal drag-and-drop onto folders and breadcrumbs.
- **File and folder actions.** New folder, rename, move across folders/accounts/pools (including conflict handling), copy, download (generates a small dummy placeholder file on the fly rather than storing real blobs), soft-delete to Trash, restore, and permanent purge / empty trash.
- **Public sharing.** Share selected files or folders into the Share Pool, generate copyable dummy share links, and manage or revoke active links in `ShareModal`.
- **External changes drawer.** Pre-seeded or triggerable dummy discrepancies (`unindexed`, `modified`, `missingRemote`, `conflicts`, `overCeiling`) with working Accept, Resolve, Move to root, and Rebalance actions.
- **Responsive layout.** Adapts cleanly on desktop (`> 768px`) and mobile (`<= 768px`, 64px rows, slide-in drawers) while keeping the demo container fixed rather than user-resizable.

## 8. Data policy page (`/data-policy`)

Simple centered single-column page with the title `Data Policy` and direct, plain-English sections. Text and links intentionally render directly over the open dither backdrop with no visible card or container wrapper. The brand mark circle stays `#deb76c` across both themes, and in dark mode the medallion adds a uniform silhouette outline in `colors.primaryText` matching the heading stroke weight.

1. **Self-hosted, zero developer access.** Tsubasa~ Cloud runs locally on your own computer. The developer operates no backend servers, collects no telemetry or analytics, and never sees your Google account, OAuth credentials, or files.
2. **How Google Drive access works.** You create and supply your own Google Cloud OAuth client. Tsubasa connects directly from your machine to Google Drive APIs to list, upload, download, organize, and share files inside your own `_Tsubasa~ Pool` folders.
3. **What stays on your device.** OAuth tokens stay in your local `.oauths/` directory; your file index stays in your local `data/tsubasa.db` file.
4. **Google API Limited Use and revocation.** Use of Google Drive data is strictly limited to operating the local file manager on your device. You can revoke access at any time from your Google Account permissions page or by deleting `.oauths/` and `data/`.
5. **This website.** Static site with no tracking cookies or analytics. The interactive demo stores only dummy text/metadata records locally in your browser's IndexedDB (never real file contents) and saves your light/dark theme choice in `localStorage`.
6. **Contact.** Lists email (`x4163x@gmail.com`), Discord (`x4163#8170`), and a link to GitHub Issues.

## 9. Work distribution and swarm execution

When implementation is approved, execute the build as a coordinated `/swarm` run with live multi-agent discussion at design, seam, and verification gates.

### Model pool
Restrict all spawned workers strictly to these two models (verify exact model identifiers via `swarm{action:"models", all:true}` before spawning):

- `Gemini 4 Neon Medium`
- `Gemini 4 Neon Low`

Concentrate `Neon Medium` on Stage 1 design and contract consensus, the interactive IndexedDB app demo, cross-track integration, and final verification. Assign `Neon Low` to bounded static tracks (copy, SEO metadata, asset preparation, and scoped checks) as ratified in Stage 1.

### Consensus protocol
Every discussion gate requires unanimous agreement among the assigned agents:

1. **No empty agreement.** Each agent casts `[Agree]`, `[Amend]`, or `[Block]` with concrete evidence (inspected files, contrast checks, build/typecheck output, or rendered browser checks).
2. **Hard block on facts and invariants.** A substantiated `[Block]` (such as real file bytes written to IndexedDB, grain intensity mismatch, WCAG AAA contrast failure, broken static route, missing demo action, or `unslop/SKILL.md` violation) stops promotion until fixed.
3. **Two-round escalation valve on pure design ties.** For "agent's call" choices where competing options both satisfy the spec, allow up to 2 debate rounds weighing concrete trade-offs. If still tied after round 2, escalate a short brief to the coordinator to pick one and proceed.

### Four-stage execution workflow (Phase 1: static site + styled dummy window)

Phase 1 delivers both static pages (`/` and `/data-policy`), shared chrome, assets, SEO, and the centered fixed-size styled dummy window placeholder on `/`. **Do not spawn a Phase 2 interactive-demo track during Phase 1.**

1. **Stage 1: Design-call, contract, and split consensus.**
   Spawn a planning group (`Neon Medium` + `Neon Low`) to inspect this spec, `docs/styling-guide.md`, `docs/teardowns/hanekawa.md`, `src/client/` (`global.css`, `tokens.stylex.ts`, components), and `docs/` assets. Reach unanimous consensus on:
   - All "agent's call" design choices (dither canvas placement, SVG mark selection, banner/social-preview wiring, secondary revealing footer items, and optional GitHub Issues contact link on `/data-policy`).
   - Shared contracts (tokens, header/footer chrome, theme boot script, fixed dummy window dimensions and placeholder layout).
   - Disjoint file ownership and model allocation across Stage 2 tracks.

2. **Stage 2: Parallel implementation with seam sync.**
   Run parallel build tracks with zero overlapping file ownership (exact file lists ratified in Stage 1):
   - **Track A (Scaffold, tokens, and shared chrome):** Vite 6 MPA config (`index.html`, `data-policy/index.html`), StyleX setup, fonts, exact light/dark grain overlay, shared header with circular View Transitions radial theme toggle, revealing footer, and Bayer 4x4 dither canvas.
   - **Track B (Static pages, copy, assets, SEO, and styled dummy window):** Homepage hero (`/`), centered fixed-size styled dummy window placeholder, centered `/data-policy` page, concise end-user copy compliant with `unslop/SKILL.md`, web-optimized brand/social assets, inline JSON-LD, Open Graph/Twitter metadata, `robots.txt`, and `sitemap.xml`.
   - **Cross-track seam check:** Before final wiring, tracks post their exported contracts (theme state, token imports, dummy window bounds, asset paths) on the board and unanimously confirm zero conflicts.

3. **Stage 3: Cross-track review and live verification.**
   Keep Stage 2 builders waiting on the board and bring in a fresh `Neon Medium` Final Reviewer. Verify against `tsc --noEmit`, `vite build`, and live rendered checks across light/dark themes and desktop/mobile viewports:
   - Grain opacity matches `src/client/global.css` (light `0.8`, dark `0.35`), contrast meets WCAG AAA, radial theme toggle respects `prefers-reduced-motion`, both static HTML outputs build cleanly, SEO metadata is valid, the dummy window is centered, fixed-size, and styled to match the app, and copy passes `unslop/SKILL.md`.
   - Any substantiated `[Block]` returns to the owning track for an in-place fix until all tracks and the Final Reviewer sign off unanimously.

4. **Stage 4: Handoff and Phase 2 gate.**
   Confirm `site/` and the main repo have no leftover temporary files, do not run `git commit` or `git push`, and report the settled Stage 1 design calls, build output, and Stage 3 sign-off status. Stop here and wait for the user to confirm both pages are complete before starting Phase 2.

### Phase 2 (Interactive demo, gated follow-up)
Start only after explicit user approval of Phase 1. Run a dedicated `Neon Medium` implementation + verification pass to replace the styled dummy window placeholder with the full metadata-only IndexedDB interactive demo (TanStack Virtual table, drag-and-drop metadata capture, `UploadDrawer`, `ShareModal`, `ExternalChangesDrawer`, Trash/restore/purge, pool/account actions, and `Reset demo`), verified with zero binary file blobs stored in IndexedDB.
