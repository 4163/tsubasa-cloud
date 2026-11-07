# UI/UX architectural teardown: MEGA web

## Target metadata
- **Target URL / App:** `https://mega.nz/fm/kEgAnYIY`
- **Inspection date:** 2026-11-08
- **Audit tool:** REA / Chrome DevTools Protocol (CDP loopback on `127.0.0.1:9222`)
- **Viewports tested:** Desktop (1920x953 observed viewport, 1440x900 and 1024x768 reference scales)

## 1. Shell layout and spatial matrix
- **Main layout grid (`#pmlayout`):**
  - Display: `grid`
  - Columns: `grid-template-columns: 286px 1634px 0px`
  - Rows: `grid-template-rows: 0px 64px 889px 0px`
  - Outer bounds: `1920px` width by `953px` height
- **Header (`.mega-component.mega-header`):**
  - Height: `64px` (`grid-row: 2 / 3`)
  - Width: `1634px` (`grid-column: 2 / 4`)
  - Position: `relative`
  - Background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Padding: `0px`
  - Z-index: `auto`
- **Search bar in header:**
  - Container selector: `.searcher-wrapper.search`
  - Position: `x: 310px, y: 32px`
  - Input selector: `input.js-filesearcher.text-ellipsis`
  - Input width: `690px`, height: `20px`
  - Background: `rgba(0, 0, 0, 0)`
  - Padding: `0px 8px`
  - Search filter chip: `search-chip`, height `28px`, border radius `16px`, background `rgba(97, 99, 102, 0.1)`
- **Primary sidebar (`.mega-component.mega-top-menu.drive`):**
  - Width: `286px` (`grid-column: 1 / 2`, `grid-row: 1 / 4`)
  - Height: `953px` (full viewport height)
  - Background: `rgb(247, 247, 247)` (`#F7F7F7`, `var(--mobile-surface-1)`)
  - Border: `0px none`, resizable handle `ui-resizable`
  - Z-index: `102`
  - Padding: `0px 0px 24px`
- **Sidebar navigation items:**
  - Item height: `56px`
  - Item width: `286px` (full sidebar width)
  - Idle background: `rgba(0, 0, 0, 0)`
  - Active / selected background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Active padding: `16px 0px 16px 20px` with left indicator
  - Idle padding: `16px 0px 16px 24px`
  - Primary text color: `rgb(48, 50, 51)` (`#303233`)
  - Font: `14px / 20px Inter`
- **Storage quota meter block in sidebar:**
  - Selector: `.mega-component.storage-block`
  - Position: Bottom of sidebar, `y: 779px`, width `286px`, height `150px`
  - Upgrade button: width `262px`, height `40px`, border radius `8px`, border `2px solid rgb(4, 16, 30)`
- **Action buttons (Upload & New folder):**
  - Container: `.fm-header-buttons`, height `64px`, padding `12px 24px`
  - Upload button: selector `button.fm-new-menu.button.primary`, width `126px`, height `40px`, border radius `8px`, background `rgb(4, 16, 30)` (`#04101E`), text color `rgb(250, 250, 250)` (`#FAFAFA`), padding `0px 24px`
  - New folder button: selector `button.fm-new-folder.button.secondary`, width `152px`, height `40px`, border radius `8px`, background `rgba(97, 99, 102, 0.1)` (`#616366` at 10% alpha), text color `rgb(48, 50, 51)` (`#303233`), padding `0px 24px`
- **Breadcrumbs bar:**
  - Selector: `.fm-breadcrumbs-wrapper`
  - Position: `x: 286px, y: 132px, height: 24px`
  - Padding: `0px 0px 0px 20px`, margin `4px 0px 0px`
  - Breadcrumb text: `14px / 20px Inter`, color `rgb(48, 50, 51)`
- **Filter chips bar:**
  - Selector: `.fm-header-chips-and-view-buttons`
  - Position: `x: 286px, y: 168px, height: 40px`
  - Chips: "Type", "Last modified", "Date added"
  - Chip dimensions: height `24px`, padding `0px 12px`, border radius `16px` (pill), background `rgba(97, 99, 102, 0.1)`

## 2. Design token inventory

### Colors (Light mode / Dark mode)
| Token role | Light computed | Dark computed | Contrast against surface |
| :--- | :--- | :--- | :--- |
| Surface base (page) | `rgb(255, 255, 255)` (`#FFFFFF`) | `rgb(26, 31, 38)` (`#1A1F26`) | - |
| Surface container (sidebar) | `rgb(247, 247, 247)` (`#F7F7F7`) | `rgb(31, 36, 42)` (`#1F242A`) | - |
| Surface container high | `rgb(239, 239, 240)` (`#EFEFF0`) | `rgb(35, 40, 47)` (`#23282F`) | - |
| Heading text | `rgb(4, 16, 30)` (`#04101E`) | `rgb(255, 255, 255)` (`#FFFFFF`) | 19.13:1 (Light AAA) / 16.56:1 (Dark AAA) |
| Primary text | `rgb(51, 51, 51)` (`#333333`) | `rgb(229, 229, 229)` (`#E5E5E5`) | 12.63:1 (Light AAA) / 13.15:1 (Dark AAA) |
| Muted text (secondary) | `rgb(110, 110, 110)` (`#6E6E6E`) | `rgb(153, 153, 153)` (`#999999`) | 5.10:1 (Light AA, fails AAA) / 5.81:1 (Dark AA, fails AAA) |
| Table cell text | `rgb(97, 99, 102)` (`#616366`) | `rgb(181, 183, 188)` (`#B5B7BC`) | 6.03:1 (Light AA, fails AAA) / 8.52:1 (Dark AAA) |
| Brand accent (primary red) | `rgb(221, 20, 5)` (`#DD1405`) | `rgb(206, 63, 45)` (`#CE3F2D`) | 5.03:1 (Light AA, fails AAA) / 3.45:1 (Dark Fail) |
| Secondary blue | `rgb(43, 166, 222)` (`#2BA6DE`) | `rgb(87, 132, 209)` (`#5784D1`) | 2.76:1 (Light Fail) / 4.52:1 (Dark AA) |
| Border divider stroke | `rgb(238, 238, 238)` (`#EEEEEE`) | `rgb(48, 53, 59)` (`#30353B`) | - |
| Success semantic | `rgb(29, 176, 123)` (`#1DB07B`) | `rgb(49, 181, 0)` (`#31B500`) | 2.78:1 (Light Fail) / 7.12:1 (Dark AAA) |
| Error semantic | `rgb(228, 0, 70)` (`#E40046`) | `rgb(245, 130, 139)` (`#F5828B`) | 4.79:1 (Light AA, fails AAA) / 6.66:1 (Dark AA) |

Note on WCAG AAA adherence for Tsubasa implementation:
MEGA uses `#6E6E6E` (5.10:1) and `#616366` (6.03:1) for secondary labels and table metadata, which pass AA but fail the project's strict 7:1 AAA standard. In Tsubasa, muted text must map to `#444746` (9.39:1 in light) and `#C4C7C5` (10.12:1 in dark). Red accents must map to `#82071E` (8.10:1 in light) and `#FF9492` (7.80:1 in dark).

### Typography
| Role | Size | Weight | Line height | Letter spacing | Token variable |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Display H1 | `60px` | `700` | `72px` | `normal` | `--font-h1` (Poppins) |
| Heading H3 | `40px` | `600` | `48px` | `normal` | `--font-h3` (Poppins) |
| Heading H4 | `32px` | `600` | `40px` | `normal` | `--font-h4` (Poppins) |
| Heading H5 | `24px` | `600` | `28px` | `normal` | `--font-h5` (Poppins) |
| Heading H6 | `20px` | `700` | `24px` | `normal` | `--font-h6` (Inter) |
| Copy Medium Bold | `16px` | `700` | `24px` | `normal` | `--font-copy-md-bold` (Inter) |
| Copy Small (Body 1) | `14px` | `400` | `20px` | `normal` | `--font-copy-sm` (Inter) |
| Copy Small Bold | `14px` | `700` | `20px` | `normal` | `--font-copy-sm-bold` (Inter) |
| Table header column | `12px` | `400` | `20px` | `normal` | `thead th` (Inter) |
| Table cell row | `12px` | `400` | `31px` | `normal` | `tbody td` (Inter) |
| Button standard | `16px` | `600` | `24px` | `normal` | `--font-btn-lg` (Inter) |
| Caption | `10px` | `400` | `16px` | `normal` | `--text-caption` (Inter) |
| Monospace code | `12px` | `400` | `24px` | `normal` | `--text-code1` (Source Code Pro) |

Font families:
- Primary interface: `"Inter", arial, sans-serif`
- Display titles: `"Poppins", arial, sans-serif`
- Monospace: `"source_code_proregular", monospace`

### Spacing and radius scales
- **Harmonic spacing tokens (`--spacing-*`):**
  - `--spacing-1`: `2px`
  - `--spacing-2`: `4px`
  - `--spacing-3`: `8px`
  - `--spacing-4`: `12px`
  - `--spacing-5`: `16px`
  - `--spacing-6`: `20px`
  - `--spacing-7`: `24px`
  - `--spacing-8`: `32px`
  - `--spacing-9`: `40px`
  - `--spacing-10`: `48px`
  - `--spacing-11`: `64px`
  - `--spacing-12`: `80px`
  - `--spacing-13`: `96px`
  - `--spacing-14`: `120px`
  - `--spacing-15`: `160px`
- **Corner radius scale:**
  - Small: `4px` (buttons, inputs)
  - Medium: `8px` (action buttons, cards)
  - Large: `12px` (popup menus)
  - X-Large: `16px` (context menus, filter chip pills)
  - Full round: `9999px`
- **Elevation and depth:**
  - Level 0: `none`
  - Level 1 (context menu): `0px 4px 8px 0px rgba(0, 0, 0, 0.1)`
  - Level 2 (dropdown popup): `0px 4px 16px 0px rgba(0, 0, 0, 0.1)`
  - Level 3 (modal dialog): `0px 8px 32px 0px rgba(0, 0, 0, 0.2)`
- **Z-index layering ladder:**
  - Base layout: `auto`
  - Flyout overlay: `101`
  - Sidebar: `102`
  - Context menu: `250`
  - Toast notifications: `1002`

## 3. Core component contracts

### Data table / list row
- **Header row:**
  - Height: `57px`
  - Background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Border bottom: `1px solid rgba(82, 84, 87, 0.05)`
  - Text: `12px / 20px`, color `rgb(97, 99, 102)`
  - Columns: Start spacer (`66px`), Name (`flex 1`), Status (`50px`), Time added (`180px`), Type (`130px`), Size (`100px`), Link actions (`93px`)
- **Row geometry:**
  - Height: `32px` (compact density)
  - Font: `12px / 31px Inter`, color `rgb(97, 99, 102)`
  - Name cell padding: `0px 13px 0px 5px`
  - Checkbox icon: `20px x 20px` container, `16px x 16px` SVG (`margin: 0px 0px 1px 1px`)
- **Interactive states:**
  - Idle state: `rgba(0, 0, 0, 0)` background
  - Hover state: `var(--mobile-surface-1)` (`rgb(247, 247, 247)`) rendered on pseudo-element `td::before`
  - Selected state: `var(--surface-grey-4)` (`rgb(238, 238, 238)`) on `.ui-selected::before`
  - Cursor: `pointer` on name cell, `auto` on row container
- **Virtualization mechanics:**
  - Implements viewport DOM virtualization with container class `main.ps.centered` and `fm-scrolling`
  - Uses fixed row height `32px` for table mode and fixed cell dimensions for grid mode to allow constant-time row index calculation

### Context menu (`.fm-context-menu`)
- **Container dimensions:**
  - Width: `280px`
  - Corner radius: `16px`
  - Border: `1px solid rgba(82, 84, 87, 0.2)`
  - Background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Box shadow: `rgba(0, 0, 0, 0.1) 0px 4px 8px 0px`
  - Padding: `4px 0px`
  - Z-index: `250`
- **Menu item geometry:**
  - Height: `36px`
  - Width: `262px`
  - Margin: `0px 9px`
  - Padding: `0px 8px`
  - Icon size: `24px x 24px` left icon
  - Text: `13.33px Inter`, color `rgb(48, 50, 51)` (`#303233`)
  - Hover state: background `rgba(97, 99, 102, 0.1)` (`#616366` at 10% alpha), border radius `8px`

### Notification toast (`.toast.rack`)
- **Container position:**
  - Position: `fixed`
  - Placement: Bottom center (`bottom: 0px`, `left: 50%`)
  - Z-index: `1002`

## 4. Key architectural takeaways for Tsubasa implementation
1. **Compact row height standard:** MEGA enforces a strict `32px` row height in list view, which matches Google Drive's Compact density mode. Tsubasa's TanStack Virtual file table should support `32px` as the default compact row height and `48px` as comfortable mode.
2. **Dedicated storage quota meter:** MEGA dedicates a prominent `150px` height block at the bottom of the sidebar with an account status badge and upgrade actions. Tsubasa should adapt this layout pattern for the multi-account pooled quota gauges (individual account headroom meters and 24-hour rolling transfer dials).
3. **Primary and secondary action buttons:** The `40px` height, `8px` radius button design ("Upload" in primary dark `#04101E` and "New folder" in 10% tinted secondary `#616366`) presents clear visual hierarchy directly adjacent to path breadcrumbs and filter chips.
4. **Context menu pill highlight:** Context menu items use `36px` row height with `24px` icon alignment and `8px` corner radius hover pills, providing reliable click targets while keeping menus compact.
5. **Enforced WCAG AAA token adjustments:** MEGA's native secondary text (`#6E6E6E`, 5.10:1) and red accent (`#DD1405`, 5.03:1) fall below WCAG AAA. Tsubasa must override these with `#444746` (secondary text) and `#82071E` / `#FF9492` (crimson/bright red) to maintain strict 7:1 contrast across themes.

