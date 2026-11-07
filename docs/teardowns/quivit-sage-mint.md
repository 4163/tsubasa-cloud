# UI/UX architectural teardown: QuiviT (Sage Mint Theme)

## Target metadata
- **Target URL / App:** `D:\Projects\QuiviT` (`themes/sage-mint.css` applied over `src/css/global.css` and `src/css/main.css`)
- **Inspection date:** 2026-11-08
- **Audit tool:** REA local source inspection, computed token evaluation, and DOM layout audit
- **Viewports tested:** Desktop (1282x752 screenshot verified), Panel ranges (120px to 480px)

## 1. Shell layout and spatial matrix
- **Main application shell:**
  - Layout model: Vertical flex column (`#menubar` -> `#workspace` -> `#statusbar`)
  - Bounds: `100vw` by `100vh`, `overflow: hidden`, background `var(--bg)`
- **Menu bar (`#menubar`):**
  - Height: `26px` to `28px` (flex item, `padding: 0 10px`, line height `1.4`, body font `13px`)
  - Background: `var(--menu-bg)` (`#f6f9f2` light / `#142722` dark)
  - Border: `border-bottom: 1px solid var(--border)` (`#9fb08a` light / `#2e4a41` dark)
  - Menu trigger buttons: `height: 100%`, `padding: 0 10px`, hover `background: var(--hover-bg)`
  - Dropdown surfaces (`.menu-dropdown`):
    - Background: `var(--menu-bg)`
    - Border: `1px solid var(--border)`
    - Box shadow: `0 2px 8px rgba(31, 46, 26, 0.18)` (light) / `0 2px 12px rgba(0, 0, 0, 0.6)` (dark)
    - Padding: `3px 0`
    - Item row height: `22px` (`padding: 4px 20px 4px 24px`)
    - Hover highlight: `background: var(--hover-bg)` (`#dcead9` light / `#1c342c` dark)
- **Primary workspace (`#workspace`):**
  - Layout model: Horizontal flex container
  - Sidebar / file list panel (`#file-panel`):
    - Default width: `260px` (`--panel-w`)
    - Allowed range: Min `120px`, max `480px`
    - Dock modes: Left (default), Right, Top, Bottom, Detached window
    - Resize handle (`#panel-resize-handle`): Width `4px`, cursor `col-resize`, drag highlight `var(--accent-gold)` (`#d4a13c`)
  - Main viewport canvas (`#viewport`):
    - Layout: `flex: 1`, `position: relative`, `overflow: hidden`
    - Background: `var(--bg)` (`#e3e8e1` light / `#0d1a17` dark)
    - Transparency checkerboard: 14px grid with alternating `#ccd9bf` and `#b3c4a1` (light) / `#1c342c` and `#122720` (dark)
    - Diagonal canvas grill: 8px tile spacing with 1px lines at 45 degrees
- **Status bar (`#statusbar`):**
  - Height: `21px` to `22px` (`padding: 2.453px 8px`, `font-size: 11.5px`)
  - Background: `var(--surface-alt)` (`#edf1e6` light / `#1a322b` dark)
  - Border: `border-top: 1px solid var(--border)` (`#9fb08a` light / `#2e4a41` dark)
  - Text color: `var(--text-muted)` (`#5c7050` light / `#8fb3a3` dark)
  - Numeric alignment: `font-variant-numeric: tabular-nums` for dimensions, index, zoom, and scaling readouts

## 2. Design token inventory

### Colors (Light mode / Dark mode)
| Token role | Light computed | Dark computed | Contrast against surface |
| :--- | :--- | :--- | :--- |
| Canvas background (`--bg`) | `#e3e8e1` | `#0d1a17` | - |
| Surface container (`--surface`) | `#f6f9f2` | `#142722` | - |
| Secondary surface (`--surface-alt`) | `#edf1e6` | `#1a322b` | - |
| Field background (`--field-bg`) | `#e3e8e1` | `#0d1a17` | - |
| Primary text (`--text`) | `#1f2e1a` | `#d8ece2` | 13.49:1 (Light AAA) / 12.67:1 (Dark AAA) |
| Muted text (`--text-muted`) | `#5c7050` | `#8fb3a3` | 5.08:1 (Light AA) / 6.81:1 (Dark AA) |
| Dim text (`--text-dim`) | `#8fa17e` | `#567569` | 2.61:1 (Light Fail) / 3.09:1 (Dark Fail) |
| Status text (`--text-status`) | `#9c5c30` | `#d29868` | 4.95:1 (Light AA) / 6.28:1 (Dark AA) |
| Brand accent (`--accent`) | `#1f7a6c` | `#35c4a8` | 4.87:1 (Light AA) / 7.16:1 (Dark AAA) |
| Brand accent hover (`--accent-hover`) | `#175f54` | `#55dcc0` | 7.05:1 (Light AAA) / 9.22:1 (Dark AAA) |
| Selected row background (`--selected-bg`) | `#c9e4d8` | `#1f4a3c` | - |
| Selected row text (`--selected-text`) | `#0f3d34` | `#7fe8c8` | 8.96:1 (Light AAA) / 6.79:1 (Dark AA) |
| Row hover background (`--hover-bg`) | `#dcead9` | `#1c342c` | - |
| Accent gold highlight (`--accent-gold`) | `#d4a13c` | `#d4a13c` | 2.20:1 (Light UI) / 6.67:1 (Dark AA) |
| Border divider (`--border`) | `#9fb08a` | `#2e4a41` | - |
| Border divider subtle (`--border-light`) | `#c3d1ae` | `#253c34` | - |

Note on WCAG AAA adherence:
In light mode, `--text-muted` (`#5c7050`) achieves 5.08:1 contrast against `#f6f9f2`, which passes AA but falls short of the 7:1 AAA threshold. For Tsubasa strict AAA compliance, muted secondary text should map to `#3d4b35` (7.62:1) or `#1f2e1a`. In dark mode, `--accent` (`#35c4a8`) achieves 7.16:1 and passes AAA directly.

### Typography
| Role | Size | Weight | Line height | Sample token |
| :--- | :--- | :--- | :--- | :--- |
| Window title / Dialog display | `16px` (`1rem`) | `600` | `1.4` | `--fs-16` |
| Menu bar & action labels | `13px` (`0.8125rem`) | `400` | `1.4` | `--fs-13` (body default) |
| File list table row | `12px` (`0.75rem`) | `400` | `1.4` | `--fs-12` |
| File table header | `12px` (`0.75rem`) | `600` | `1.4` | `--fs-12` |
| Status bar readouts | `11.5px` (`0.71875rem`) | `400` | `1.2` | `--fs-11-5` |
| Metadata badges | `10px` (`0.625rem`) | `400` | `1.2` | `--fs-10` |

Primary font stack: `'Segoe UI', system-ui, -apple-system, sans-serif`.

### Spacing and radius
- **Base spacing scale:**
  - Row vertical padding: `1.6015px`
  - Cell horizontal padding: `8px`
  - Header cell padding: `4px 8px`
  - Status bar padding: `2.453px 8px`
  - Menu item horizontal padding: `10px`
  - Actions bar button gap: `4px`
- **Corner radius scale:**
  - Standard elements: `0px` (sharp desktop look for file lists, headers, menus, and buttons)
  - Focus visible outline: `2px` (`:focus-visible { outline: 2px solid var(--accent); border-radius: 2px; }`)
  - Scrollbar thumb: `3px`

## 3. Core component contracts

### File list table row (`#file-list li`)
- **Row height:** `20px` (measured via `#file-list-sentinel` probe, derived from 12px font plus `1.6015px` vertical padding)
- **Icon size:** `14px` by `14px` (`--fs-14`), gap `4px`
- **Grid column template:** `--file-grid-cols: var(--col-name-w) var(--col-ext-w) var(--col-date-w)` (default: `134px 46px 92px`)
- **Interactive states:**
  - Idle: Background transparent, text `#1f2e1a` (light) / `#d8ece2` (dark)
  - Hover: `background: #dcead9` (light) / `#1c342c` (dark)
  - Selected: `background: #c9e4d8`, text `#0f3d34` (light) / `background: #1f4a3c`, text `#7fe8c8` (dark)
  - In-view (multi-select indicator): `color-mix(in srgb, var(--selected-bg) 40%, transparent)`
  - Search match: `box-shadow: inset 3px 0 0 var(--accent-gold)`, `background: color-mix(in srgb, var(--accent-gold) 20%, transparent)`
- **Virtualization mechanism:**
  - Uses absolute positioning with `top: calc(index * rowHeight)`
  - Pool cloning against `#file-list-sentinel`
  - `.scroll-spacer` maintains the total container height for native scrollbar travel

### Search and quick actions bar (`.file-panel-actions`)
- **Search input:**
  - Height: `24px`
  - Background: `var(--field-bg)` (`#e3e8e1` light / `#0d1a17` dark)
  - Border: `1px solid var(--border)` (`#9fb08a` light / `#2e4a41` dark)
  - Focus: `outline: none`, `border-color: var(--accent)`
- **Action buttons:**
  - Dimensions: `24px` by `24px`
  - Icons: `14px` SVG strokes, stroke width `2px`
  - Hover: `background: var(--hover-bg)`

## 4. Key architectural takeaways for implementation
1. **Ultra-compact 20px table rows:** QuiviT uses a tight 20px row geometry (`--fs-12` with `1.6px` padding) suited for high-density file management.
2. **Sentinel-probed virtualization:** Rather than hardcoding fixed heights, QuiviT measures a hidden DOM probe (`#file-list-sentinel`) before recycling positioned row elements.
3. **Harmonic sage-mint palette:** Surfaces employ low-saturation earthy greens (`#e3e8e1`, `#f6f9f2`) paired with deep forest teals (`#1f7a6c`, `#175f54`) for active states.
4. **Gold-accented highlights:** A warm gold token (`#d4a13c`) handles secondary visual attention (panel resize indicators, search highlights, and active selection anchors).

