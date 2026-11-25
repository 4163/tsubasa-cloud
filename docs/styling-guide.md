# Tsubasa~ Cloud styling and design guide

## 1. Visual direction

Tsubasa pairs dense desktop file management with flat 1px structural borders and light texture. It draws its cool slate neutrals and gold highlights (`#deb76c` / `#d4a13c`) from Hanekawa, its sage-mint surfaces and 6px scrollbars from QuiviT, its partitioned workspace chrome from Dropbox, and its 64px mobile rows from MEGA.

Google Drive styling (bulky row padding, rounded pastel chips, low-density search bars) is excluded. Primary, secondary, and status text pairings on `surface` and `canvas` target WCAG AAA contrast (7:1 minimum).

## 2. Layout and breakpoints

- **Viewport width queries (`max-width: 768px`)** control layout reflow, drawer collapse, and column visibility. Pointer type never decides layout.
- **Pointer queries (`@media (pointer: coarse)`)** control touch tap physics, touch target heights, and action-column width.

### Desktop (`> 768px`)

Fixed `100vw` by `100vh` flex shell (`display: flex`, `overflow: hidden`) in `src/client/App.tsx` with isolated internal scroll containers:

- **Tracks:** `280px` sidebar beside a `1fr` flex-column workspace (`56px` header, `48px` action portal, `1fr` content canvas).
- **Sidebar (`Sidebar.tsx`):** Brand wordmark and version badge, pools section (`SidebarPoolSection`, including Share Pool), `<nav>` with All files and Trash, scrollable account cards with status pills, and bottom-anchored pool quota and 24-hour transfer gauges.
- **Header (`Header.tsx`):** Search input (`max-width: 520px`, `height: 36px`) on the left; 3-way theme selector (Auto, Light, Dark) and GitHub link on the right.
- **Action portal (`ActionPortal.tsx`):** Interactive breadcrumbs with drop targets on the left; workspace actions and selection-scoped commands on the right. When space tightens, toolbar buttons collapse to icon-only (`32px`, `44px` coarse) and account/share badges truncate down to `3.5ch` before horizontal scrolling kicks in.
- **Content canvas:** Flex column hosting the virtualized TanStack `FileTable`.

### Mobile (`<= 768px`)

- **Top header:** `56px` height with mobile menu button and search input on the left, theme selector and GitHub link on the right (GitHub text hides at `<= 600px`).
- **List rows:** `64px` height (`36px minmax(0, 1fr) auto`: checkbox, icon + name with account/size/date columns hidden, inline row actions).
- **Drawers:** Slide-in navigation drawer (`300px`, `max-width: 85vw`) from the left; upload and external-changes drawers slide from the top (`inset: 0 0 auto 0`, `max-height: 92dvh`) with `44px` coarse-pointer controls (`layout.mobileTouchTarget` `56px` is used only in `ShareModal`).

## 3. Color tokens

Canonical definitions live in `src/client/tokens.stylex.ts`. Primary, secondary, and status text pairings on `surface` and `canvas` meet 7:1+ WCAG AAA. Hover states, `surfaceElevated`, `surfaceAlt` badge pairings, and `brandAccentHover` / `dangerHover` sit at >= 5.5:1. `disabledText` is reserved for disabled controls.

| Role | Light | Dark | Notes |
|---|---|---|---|
| **Canvas** | `#eef2ec` | `#0b1412` | Base viewport canvas |
| **Surface container** | `#f7faf5` | `#12211d` | Primary card and table surface |
| **Surface elevated** | `#ffffff` | `#28443b` | Active segmented controls, elevated surfaces |
| **Surface alt / Hover** | `#e4ede7` | `#162d26` | Table headers and hover rows |
| **Primary text** | `#111d18` | `#e5f2eb` | Body text, headings, primary labels |
| **Secondary text** | `#2d453b` | `#a6c2b5` | Metadata, table headers, secondary labels |
| **Border / Subtle** | `#8ea194` / `#c2d1c7` | `#456659` / `#294138` | 1px structural and row dividers |
| **Brand accent** | `#135349` | `#35c4a8` | Primary CTA fill (`#ffffff` / `#111d18` text), active filters, account pills |
| **Gold accent** | `#deb76c` | `#d4a13c` | Focus rings, 3px selection bar, folder icons, dark-text pills |
| **Selection bg** | `#dcebe2` | `#1b3b32` | Selected table rows and active nav items |
| **Success** | `#116329` | `#2dd4bf` | Operational badges |
| **Warning** | `#6b3e00` | `#f7d154` | Pending sync, near-limit quota |
| **Danger** | `#82071e` | `#ff9492` | Buffer breach, errors, purge actions |

Paired tinted surfaces (`brandAccentSurface`, `successSurface`, `warningSurface`, `dangerSurface`) back status pills, inline error banners, and drag-over highlights with their matching semantic foregrounds.

### Gold usage rule

Never render gold (`#deb76c` / `#d4a13c`) as text on light surfaces (under 2:1 contrast). Use gold for:

1. Focus outlines (`2px solid`).
2. Selected table row and active nav left bars (`3px solid`).
3. Solid badge pills carrying dark text (`#111d18`, `accentGoldText`).
4. Folder icons and drag/marquee accents.

## 4. Typography

- **Brand and display:** `Pixelify Sans` (`src/client/assets/fonts/Pixelify_Sans/PixelifySans-VariableFont_wght.woff2`), used for the sidebar wordmark, version badge, and empty-state or drop-zone headings.
- **UI body and controls:** `Montserrat` (`src/client/assets/fonts/Montserrat/Montserrat-VariableFont_wght.woff2`).
- **Numeric columns:** `font-variant-numeric: tabular-nums` on sizes, dates, and transfer readouts.

| Level | Family | Size | Weight | Line height | Tracking |
|---|---|---|---|---|---|
| **Brand wordmark** | Pixelify Sans | `20px` | `600` | `1.2` | `0.02em` |
| **Page title** | Montserrat | `18px` | `600` | `1.3` | `-0.01em` |
| **Section heading** | Montserrat | `13px` | `600` | `1.4` | `0.04em` |
| **Body / Table row** | Montserrat | `13px` | `400` | `1.4` | `0` |
| **Table header** | Montserrat | `11px` | `600` | `1.3` | `0.05em` |
| **Metadata** | Montserrat | `11px` | `400` | `1.3` | `0` |
| **Status badge** | Montserrat | `10px` | `600` | `1.2` | `0.02em` |

## 5. Atmosphere, motion, borders, and scrollbars

- **Grain overlay (`src/client/global.css`).** Fixed `pointer-events: none` layer (`z-index: 9999`) applied via `.grain-overlay` and `dialog:modal::after`. Light mode uses a 128x128 pre-attenuated PNG tile (`opacity: 0.8`); dark mode uses a 256px SVG `feTurbulence` tile (`opacity: 0.35`).
- **Flat elevation.** No drop shadows or blurry card shadows. Define structure with 1px borders, distinct surface values, and 3px gold selection bars.
- **Dither dividers (`src/client/components/DitherDivider.tsx`).** A `<div aria-hidden="true">` tiled with inline `crispEdges` SVG data URIs (`6px 4px` vertical, `4px 6px` horizontal, `6px` strip width/height) separates the sidebar from the workspace on desktop and hides at `<= 768px`.
- **Radius scale.** `0px` (table rows, nav rows, dividers, drawers), `4px` (`radius.compact`: inputs, selects, badges, checkboxes, modal/drawer buttons), `8px` (`radius.button` / `radius.card`: Action Portal buttons, cards, `ModalDialog` surfaces), `9999px` (avatars, pills). `radius.modal` (`12px`) and `radius.sheet` (`16px`) are defined in `tokens.stylex.ts` but currently unused.
- **Scrollbars.** `6px` width/height, transparent track, pill thumb (`#8ea194` hover `#2d453b` light; `#2d453b` hover `#a6c2b5` dark).
- **Motion and loading feedback.** Tokenized transitions run at `150ms` fast, `200ms` normal, and `100ms` tap. Window resizing applies `.resize-animation-stopper` for `150ms`, and `@media (prefers-reduced-motion: reduce)` collapses transitions and animations. Table loading uses `<progress data-loading-spinner="true">` with a `150ms` fade-in delay so fast local SQLite reads never flash a spinner.

## 6. Core component contracts

### Virtualized file table (`src/client/components/FileTable.tsx`)

- **Row heights:** `36px` desktop, `44px` on coarse pointers, `64px` on mobile (`<= 768px`). (`tableRowHeightCompact` `32px` is used only in `ExternalChangesDrawer`; `tableRowHeightComfort` is unused.)
- **Desktop grid columns:** `16px 40px minmax(240px, 3fr) 160px 110px 156px 96px` (gutter, checkbox, name, account, size, modified, actions; actions widen to `120px` on coarse pointers).
- **Row states:** transparent idle, `rowHover` on hover, `selectionBg` + `3px` left `accentGold` border when selected (`selectionBorder` token is unused), and `2px` `focusRing` (`outline-offset: -2px`) on keyboard-focused row controls (checkbox, account select, row buttons, sort headers).

### Overlays (`ModalDialog.tsx`, `DrawerPrimitives.tsx`, `ModalChrome.tsx`)

All modals and drawers render as native Top-Layer `<dialog>` elements (`data-tsubasa-dialog="modal" | "drawer-left" | "drawer-sheet"`) instead of custom `z-index` backdrop divs. `global.css` drives `@starting-style` and `allow-discrete` entrance/exit transitions (`160ms` modal opacity/scale, `250ms` drawer slide) with `overscroll-behavior: contain`. Modals share `ModalHeader` (`48px` height) and `modalChromeStyles` (`radius.card` `8px` shell, `1px` `border`).

### Buttons and account meters

- **Primary button:** `32px` height (`26px` in `DrawerPrimitives`), `brandAccent` background (`#135349` light, `#35c4a8` dark), `brandAccentText` (`#ffffff` light, `#111d18` dark), and `brandAccentHover` on hover. Uses `8px` (`radius.button`) in Action Portal and `4px` (`radius.compact`) in modals and drawers.
- **Secondary button:** `32px` height, transparent background, `1px` `border`, `rowHover` background on hover. Action Portal secondary buttons also shift border and text to `brandAccent` on hover.
- **Quota gauges:** Pool meter isolates Tsubasa usage from external Drive items. Account cards show headroom, total Drive usage, and 24-hour upload totals, displaying a `Full` pill, `danger` bar fill, and inline `danger` breach notice when `quotaUsedBytes > usableLimitBytes` and `tsubasaUsedBytes > 0`.
- **Email masking:** Workspace surfaces mask emails 1:1 with monospace dots (`arg•••••••••••ra@gmail.com`) via `RedactedEmail` to prevent layout shift on hover while keeping text selectable. Modals and drawers show full emails.

### Interaction boundaries

- **No right-click or overflow context menus.** Action Portal and inline row buttons expose every single-item and batch command.
- **No toast notifications.** Show feedback in place (button state swaps like `Copied` or `Fetching...`, optimistic rows, drawer progress bars, inline modal and workspace error banners).
- **No app-level undo stack (`Ctrl+Z`).** Use Trash Restore for deletes and direct rename/move controls to reverse edits.

### Native `title` tooltip rules

Native `title` tooltips appear only on desktop pointer hover (never touch or keyboard focus). Use `title` only when hover needs hidden context:

- **Use `title` for:** icon-only controls, Action Portal buttons whose labels drop in compact overflow mode (set `title` only while the label is hidden), truncated single-line text (`scrollWidth > clientWidth`), non-obvious state/action chips (selection summary badges, drawer email context, `Full`/`Disabled` pills), and disabled buttons whose blocker is not shown beside the button.
- **Never use `title` for:** visible untruncated labels, keyboard shortcuts, narration or destructive warnings, self-evident disabled states (`Empty trash` when empty, busy controls, `0 B` cells), unmasking redacted workspace emails, or `<option>` elements (put short blockers in the option label text instead).

| Case | Rule | Example |
|---|---|---|
| **Hidden label** | Exact hidden label, sentence case, no period | `Upload file`, `Paste (2)`, `Download` |
| **Overflowing text** | Exact raw string, no prefix | `/Projects/2026/archive.tar.gz` |
| **Non-obvious state / blocker** | Short fragment, no `"Click to..."`, no period | `Move selected files to another account`, `750 MB buffer breached`, `No account with enough headroom` |

## 7. Touch physics (`@media (pointer: coarse)`)

- Disable default browser tap highlights (`-webkit-tap-highlight-color: transparent`) and overscroll bounce (`overscroll-behavior: none`).
- Omit unlayered `:hover` resets in `global.css` so `@layer` StyleX button backgrounds stay intact.
- Apply `100ms` `:active` tap transitions (`background-color`, `transform`, `filter: brightness(85%)` on images, `underline` on links).
- Enforce `min-height: 44px` on primary/secondary buttons, inputs, and drawer/modal controls (`36px` on compact header, sidebar mini, and table row controls).

## 8. StyleX and theme hydration

1. **Compile-time StyleX only.** No Tailwind or runtime CSS-in-JS.
2. **Tokens in `src/client/tokens.stylex.ts`.** Reference `stylex.defineVars` tokens rather than hardcoded hex values or pixel margins.
3. **Flat `stylex.create` objects** and `stylex.createTheme` bound to `data-theme="light"` / `data-theme="dark"`.
4. **Zero-flash boot script (`index.html`).** An inline `<head>` script resolves theme choice before first paint from Electron (`window.tsubasaDesktop.getThemeChoice()`, backed by `data/desktop-prefs.json`) or `localStorage` (`tsubasa-theme-choice`), falling back to `prefers-color-scheme`.
5. **Segmented control stability.** Active segmented options pin background and text colors on hover to prevent dark-mode contrast inversions.
