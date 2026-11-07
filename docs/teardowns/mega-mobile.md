# UI/UX architectural teardown: MEGA mobile web

## Target metadata
- **Target URL / App:** `https://mega.nz/fm/VUo0lJxa`
- **Inspection date:** 2026-11-08
- **Audit tool:** REA / Chrome DevTools Protocol (CDP loopback on `127.0.0.1:9222`)
- **Viewports tested:** Mobile (427x952 observed viewport, 390x844 reference scale, DPR 3)

## 1. Shell layout and spatial matrix
- **Main layout grid (`#mainlayout.main-layout`):**
  - Display: `grid`
  - Body classes: `theme-light logged en mobile free`
  - Dimensions: `427px` width by `952px` height
- **Mobile header (`.mega-component.mega-header`):**
  - Position: `relative`, z-index `95`
  - Background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Total height: `159px`, structured as two stacked blocks:
    - **Top bar (`.block.top-block`):** Height `56px`, padding `16px 24px`, contains hamburger navigation button (`.nav-actions .menu`) and user profile avatar (`.nav-actions .avatar`)
    - **Bottom bar (`.bottom-block`):** Height `103px`, padding `16px 24px`, contains current directory path title (`Minami (美波)`) at `16px` font size
- **Main content canvas (`.fmholder` / `.mobile.fm-block.file-manager-block`):**
  - Position: `relative`, below header at `y: 159px`
  - Width: `427px`, height: `793px`
  - Background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Padding: `0px`
- **Off-canvas navigation drawer (`.mega-component.mega-top-menu`):**
  - Position: `fixed`, z-index `102`
  - Position coordinates: `x: 427px, y: 0px` (off-screen, slides into `x: 0px` on hamburger toggle)
  - Dimensions: `427px` width by `952px` height
  - Background: `rgb(247, 247, 247)` (`#F7F7F7`, `var(--mobile-surface-1)`)

## 2. Design token inventory

### Colors (Light mode / Dark mode)
| Token role | Light computed | Dark computed | Contrast against surface |
| :--- | :--- | :--- | :--- |
| Mobile surface 1 (drawer & sheet) | `rgb(247, 247, 247)` (`#F7F7F7`) | `rgb(31, 36, 42)` (`#1F242A`) | - |
| Mobile surface 2 (hover & cards) | `rgb(239, 239, 240)` (`#EFEFF0`) | `rgb(35, 40, 47)` (`#23282F`) | - |
| Sheet base canvas | `rgb(255, 255, 255)` (`#FFFFFF`) | `rgb(26, 31, 38)` (`#1A1F26`) | - |
| Item title text | `rgb(48, 50, 51)` (`#303233`) | `rgb(229, 229, 229)` (`#E5E5E5`) | 13.50:1 (Light AAA) / 13.15:1 (Dark AAA) |
| Item metadata subtitle | `rgb(97, 99, 102)` (`#616366`) | `rgb(181, 183, 188)` (`#B5B7BC`) | 6.03:1 (Light AA, fails AAA) / 8.52:1 (Dark AAA) |
| Active nav item background | `rgb(255, 255, 255)` (`#FFFFFF`) | `rgb(48, 53, 59)` (`#30353B`) | - |
| Bottom sheet scrim overlay | `rgba(0, 0, 0, 0.2)` | `rgba(0, 0, 0, 0.6)` | - |

Note on WCAG AAA adherence:
MEGA's mobile item metadata text (`#616366`, 6.03:1) passes AA but falls short of AAA. In Tsubasa, mobile subtitle metadata maps to `#444746` (9.39:1 in light) and `#C4C7C5` (10.12:1 in dark).

### Typography
| Role | Size | Weight | Line height | Sample selector |
| :--- | :--- | :--- | :--- | :--- |
| Mobile path heading | `16px` | `400` | `normal` | `.bottom-block .block` |
| Mobile item title | `14px` | `600` | `21px` | `.mobile.fm-item-name` |
| Mobile item subtitle / count | `12px` | `400` | `18px` | `.mobile.props` |
| Mobile sheet menu item | `14px` | `400` | `20px` | `.mega-sheet .button` |
| Drawer navigation item | `14px` | `400` | `20px` | `.mega-top-menu .menu-item` |

### Touch target dimensions and spacing
- **Mobile row height:** `64px` (container touch bound)
- **Action button touch target:** `56px` height on all sheet and drawer actions
- **Three-dot context button:** `40px` width by `24px` height (contained within the `64px` row)
- **Top header action icons:** `24px x 24px` icons with `16px 24px` container padding
- **Close button on sheet:** `36px x 36px`

## 3. Core component contracts

### Mobile list row (`.mobile.fm-item.megaListItem`)
- **Container dimensions:**
  - Width: `379px` (with `24px` outer screen margins)
  - Height: `64px`
  - Display: `grid`
  - Columns: `grid-template-columns: 40px 299px 40px`
  - Padding: `12px 0px`
  - Background: `rgba(0, 0, 0, 0)` idle
- **Column 1 (Leading visual, 40px):**
  - Selector: `.mobile.fm-item-img`
  - Dimensions: `40px` width by `24px` height
  - Contains file type thumbnail or folder glyph
- **Column 2 (Text content, 299px):**
  - Title: `.mobile.fm-item-name`, `14px / 21px Inter`, `fontWeight: 600`, color `#303233`, single line ellipsis
  - Subtitle: `.mobile.props`, `12px Inter`, `fontWeight: 400`, color `#616366`, displays item count (e.g. `4 files`, `1 folder, 5 files`) or file size
- **Column 3 (Trailing action, 40px):**
  - Selector: `button.context-btn.open-context-menu`
  - Dimensions: `40px` width by `24px` height
  - Contains three vertical dots glyph (`icon-menu-thin-outline`)

### Mobile context bottom sheet (`.mega-sheet.mobile-context-menu`)
- **Backdrop / Scrim:**
  - Background: `rgba(0, 0, 0, 0.2)`
  - Position: `fixed`, covers entire `427px x 952px` viewport
  - Z-index: `101`
- **Sheet surface container (`.sheet.custom-alpha`):**
  - Dimensions: Width `427px`, height `799px` (dynamic height, docked to bottom)
  - Background: `rgb(247, 247, 247)` (`#F7F7F7`, `var(--mobile-surface-1)`)
  - Border radius: `16px 16px 0px 0px` (top-left and top-right rounded corners)
  - Padding: `40px 0px 16px`
  - Close button: Top right, `36px x 36px`
- **Menu action items:**
  - Height: `56px` per item
  - Width: `100%` (`427px`)
  - Padding: `0px 24px`
  - Layout: Left icon (`24px x 24px`) + label text (`14px Inter`)
  - Items presented: "Download as a ZIP file", "Share link", "Create file request", "Open in app", "Move to", "Delete"

### Slide-out navigation drawer (`.mega-top-menu`)
- **Position and animation:**
  - Position: `fixed`, `x: 427px, y: 0px` (slides horizontally into viewport)
  - Width: `427px` (full screen width), height `952px`
  - Background: `rgb(247, 247, 247)` (`#F7F7F7`)
  - Z-index: `102`
- **Drawer navigation items:**
  - Item height: `56px`
  - Width: `427px`
  - Idle padding: `16px 24px`
  - Active padding: `16px 24px 16px 20px` with left indicator
  - Active background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Items list: "Cloud drive", "Shared items", "Rubbish bin", "Language", "Settings"

## 4. Key architectural takeaways for Tsubasa implementation
1. **Adaptive row height:** While desktop uses `32px` (compact) or `48px` (comfortable) single-line rows, mobile switches to `64px` height with a two-line stacked grid (`40px 1fr 40px`) to provide touch ergonomic clearance.
2. **Context menu transformation:** On mobile viewports, the desktop floating context menu (`280px`) transforms into a slide-up bottom sheet with `16px 16px 0px 0px` top radius and `56px` touch targets.
3. **Structured mobile header:** The 159px mobile header separates global app actions (56px top bar with hamburger and user profile avatar) from navigation path context (103px bottom bar with directory title).
4. **Accessible metadata contrast:** Subtitle text must use `#444746` rather than MEGA's `#616366` to satisfy WCAG AAA standards across mobile viewports.

