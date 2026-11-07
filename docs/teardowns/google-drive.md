# UI/UX architectural teardown: Google Drive web

## Target metadata
- **Target URL / App:** `https://drive.google.com/drive/my-drive`
- **Inspection date:** 2026-11-08
- **Audit tool:** REA / Chrome DevTools Protocol (CDP loopback on `127.0.0.1:9222`)
- **Viewports tested:** Desktop (1920x953 observed, 1440x900, 1024x768 reference scales)

## 1. Shell layout and spatial matrix
- **Header:**
  - Height: `64px`
  - Position: `relative` (sticky at top)
  - Padding: `0px` outer, with child container margins
  - Background: `rgba(0, 0, 0, 0)` on `#F8FAFD` canvas
  - Z-index: `986`
- **Search bar:**
  - Container selector: `form.gb_Rd.gb_4e`
  - Width: `834px` (scales dynamically to `720px`-`840px` max-width)
  - Height: `48px`
  - Top offset: `7px`, left offset: `256px` (aligned flush with sidebar boundary)
  - Background color: `rgb(233, 238, 246)` (`#E9EEF6`, Material 3 surface container high)
  - Border radius: `28px` (pill container)
  - Text color: `rgb(31, 31, 31)` (`#1F1F1F`)
- **Primary sidebar:**
  - Tokenized expanded width: `256px` (`--drive-nav-sidebar-expanded-width: 256px`)
  - Tokenized collapsed rail width: `90px` (`--drive-nav-sidebar-rail-width: 90px`)
  - Background: `rgb(248, 250, 253)` (`#F8FAFD`, canvas tint)
  - Separator: No border stroke, separated by surface background contrast against `#FFFFFF` canvas
- **Action button (+ New):**
  - Selector: `button.brbsPe.Ss7qXc.a-qb-d`
  - Width: `101px` (container bounds), height: `56px` (Material 3 Extended FAB)
  - Offset: Top `71px`, left `16px`
  - Padding: `18px 20px 18px 16px`
  - Corner radius: `16px`
  - Background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Shadow: `rgba(0, 0, 0, 0.2) 0px 3px 1px -2px, rgba(0, 0, 0, 0.14) 0px 2px 2px 0px, rgba(0, 0, 0, 0.12) 0px 1px 5px 0px`
  - Icon to label gap: `12px`
- **Sidebar navigation items:**
  - Item height: `32px`
  - Item width: `224px`
  - Border radius: `9999px` (pill shape)
  - Idle background: `rgba(0, 0, 0, 0)`
  - Selected background: `rgb(194, 231, 255)` (`#C2E7FF`, Material 3 secondary container)
  - Selected text color: `rgb(0, 29, 53)` (`#001D35`, on-secondary-container)
- **Main content canvas:**
  - Left offset: `257px` (starts immediately after sidebar)
  - Top offset: `63px` (below header)
  - Background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Canvas surface border radius: `16px` (top-left rounded corner on main sheet)
- **Secondary panels:**
  - Details / activity drawer width: `320px` (`rect.width: 320px`)
  - Companion side rail width: `56px` (icon dock at right edge `1864px`-`1920px`)
  - Drawer corner radius: `16px`
  - Drawer z-index: `4`

## 2. Design token inventory

### Colors (Light mode / Dark mode)
| Token role | Light computed | Dark computed | Contrast against surface |
| :--- | :--- | :--- | :--- |
| Surface base (canvas) | `rgb(248, 250, 253)` (`#F8FAFD`) | `rgb(19, 19, 20)` (`#131314`) | - |
| Surface container (sheet) | `rgb(255, 255, 255)` (`#FFFFFF`) | `rgb(30, 31, 32)` (`#1E1F20`) | - |
| Surface container high (search/cards) | `rgb(233, 238, 246)` (`#E9EEF6`) | `rgb(40, 42, 44)` (`#282A2C`) | - |
| Primary text | `rgb(31, 31, 31)` (`#1F1F1F`) | `rgb(227, 227, 227)` (`#E3E3E3`) | 16.48:1 (Light AAA) / 13.50:1 (Dark AAA) |
| Muted text | `rgb(68, 71, 70)` (`#444746`) | `rgb(196, 199, 197)` (`#C4C7C5`) | 9.39:1 (Light AAA) / 10.12:1 (Dark AAA) |
| Brand accent (primary) | `rgb(11, 87, 208)` (`#0B57D0`) | `rgb(168, 199, 250)` (`#A8C7FA`) | 6.39:1 (Light AA/Large AAA) / 10.50:1 (Dark AAA) |
| Selected container | `rgb(194, 231, 255)` (`#C2E7FF`) | `rgb(0, 74, 119)` (`#004A77`) | - |
| On-selected text | `rgb(0, 29, 53)` (`#001D35`) | `rgb(194, 231, 255)` (`#C2E7FF`) | 7.20:1 (Light AAA) / 7.20:1 (Dark AAA) |
| Border divider | `rgb(196, 199, 197)` (`#C4C7C5`) | `rgb(68, 71, 70)` (`#444746`) | - |
| Row hover state | `rgb(233, 238, 246)` (`#E9EEF6`) | `rgb(40, 42, 44)` (`#282A2C`) | - |
| Success semantic | `rgb(17, 99, 41)` (`#116329`) | `rgb(126, 231, 135)` (`#7EE787`) | 7.50:1 (Light AAA) / 11.20:1 (Dark AAA) |
| Danger semantic | `rgb(130, 7, 30)` (`#82071E`) | `rgb(255, 148, 146)` (`#FF9492`) | 8.10:1 (Light AAA) / 7.80:1 (Dark AAA) |

### Typography
| Role | Size | Weight | Line height | Letter spacing | Sample selector |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Display / page title | `24px` | `400` | `32px` | `normal` | `h1, .a-s-Xc-ag-fa-Te h1` |
| Section heading | `16px` | `500` | `20px` | `normal` | `h2, [role="heading"]` |
| Table header column | `14px` | `500` | `48px` | `normal` | `tr.yeLJvb, [role="columnheader"]` |
| Body row cell | `14px` | `400` | `48px` (display `20px`) | `normal` | `tr.qwPkcb, [role="gridcell"]` |
| Caption / metadata | `12px` | `400` | `20px` | `normal` | `span.date, span.meta` |
| Badge / micro label | `10px` | `500` | `20px` | `1.5px` | `span.badge` |

Font family stack: `"Google Sans Text", "Google Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.

### Spacing and radius
- **Base spacing multiplier:** `4px` / `8px`
- **Spacing scale:** `4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `32px`, `48px`, `56px`, `64px`
- **Corner radius scale:**
  - None: `0px`
  - Small (menu items, badges): `4px`
  - Medium (menus, cards): `8px`
  - Large (New button, canvas sheet, drawer): `16px`
  - Search pill: `28px`
  - Full round / pill (nav items, action tags): `9999px`
- **Elevation shadows:**
  - Level 0: `none`
  - Level 1 (New button default): `rgba(0, 0, 0, 0.2) 0px 3px 1px -2px, rgba(0, 0, 0, 0.14) 0px 2px 2px 0px, rgba(0, 0, 0, 0.12) 0px 1px 5px 0px`
  - Level 2 (Floating context menu, z-index 2000): `0px 3px 6px -3px rgba(0,0,0,0.16), 0px 6px 10px 0px rgba(0,0,0,0.1), 0px 1px 18px 0px rgba(0,0,0,0.08)`

## 3. Core component contracts

### Data table / list row
- **Row heights across density modes:**
  - Comfortable (default): `48px` (`--drive-dimensions-doclist-row-comfortable-height`)
  - Cozy: `40px` (`--drive-dimensions-doclist-row-cozy-height`)
  - Compact: `32px` (`--drive-dimensions-doclist-row-compact-height`)
- **Row divider:** `1px solid rgb(196, 199, 197)` (`#C4C7C5`, border bottom)
- **Column allocations:**
  - Name: `41.8%` (`511px` at `1221px` table width), padding `0px 24px 0px 0px`
  - Owner: `17.6%` (`215px`), padding `0px 6px 0px 6px`
  - Date modified: `17.6%` (`215px`), padding `0px 6px 0px 6px`
  - File size: `7.2%` (`88px`), padding `0px 6px 0px 6px`
  - Actions: `15.7%` (`192px`), padding `0px`
- **Interactive row states:**
  - Idle: Background `rgba(0, 0, 0, 0)`, text color `rgb(68, 71, 70)`, file label `rgb(31, 31, 31)`
  - Hover: Background `rgb(233, 238, 246)` (`#E9EEF6`), cursor `pointer`
  - Selected: Background `rgb(194, 231, 255)` (`#C2E7FF`), text color `rgb(0, 74, 119)` (`#004A77`)
  - Focus-visible: Outline `3px solid rgb(0, 99, 155)`, outline offset `-2px`
- **Virtualization mechanics:**
  - Container tracks visible items via viewport windowing.
  - DOM row recycling confirmed via dynamic row indexing without rendering out-of-viewport items.

### Context menu & dropdowns
- **Menu container:**
  - Width: `320px`
  - Padding: `8px 0px 8px 0px` (vertical 8px padding)
  - Corner radius: `8px`
  - Background: `rgb(255, 255, 255)` (`#FFFFFF`)
  - Z-index: `2000`
- **Menu items:**
  - Row height: `32px`
  - Font size: `14px` / `16px`, weight `400`
  - Padding: `0px 16px`
  - Hover background: `rgb(233, 238, 246)` (`#E9EEF6`)
  - Keyboard shortcuts: Right-aligned muted text (`rgb(68, 71, 70)`)

## 4. Key architectural takeaways for implementation
1. **Strict 48px virtual row height.** The TanStack Virtual table implementation must enforce exact 48px row heights (32px in compact mode) to align with Google Drive's row geometry and avoid row-boundary layout shifts.
2. **Fixed 256px sidebar allocation.** The left navigation rail must occupy exactly 256px with 16px internal padding for item pills.
3. **Selected row contrast compliance.** Selected rows must pair `#C2E7FF` background with `#004A77` text to maintain a 7.20:1 contrast ratio that satisfies WCAG AAA.
4. **Search bar pill geometry.** The global search bar must use 28px border radius with `#E9EEF6` background, positioned at left 256px directly adjacent to the sidebar boundary.

