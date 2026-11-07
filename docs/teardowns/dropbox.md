# UI/UX architectural teardown: Dropbox web

## Target metadata
- **Target URL / App:** `https://www.dropbox.com/home`
- **Inspection date:** 2026-11-08
- **Audit tool:** REA / Chrome DevTools Protocol (CDP loopback on `127.0.0.1:9222`, Chrome 156)
- **Viewports tested:** Desktop (1920x953 observed viewport, 1440x900 and 1024x768 reference scales)
- **Design system identifier:** Dropbox Dig 2 (`dig-Theme-vis2023 dig-Theme-vis2023--bright dig-Mode--bright In-Theme-Provider maestro--responsive`)

## 1. Shell layout and spatial matrix

### Main layout grid (`#maestro-portal`)
- **Display:** `grid`
- **Grid template columns:** `300px 0px 1620px 0px` (desktop 1920px width; at 1440px reference: 300px sidebar, 1140px main content)
- **Grid template rows:** `41px 0px 0px 76px 60px 776px`
- **Grid template areas:**
  ```css
  "campaigns-toolkit campaigns-toolkit campaigns-toolkit campaigns-toolkit"
  "dev-notices dev-notices dev-notices dev-notices"
  "prompt prompt prompt prompt"
  "left-nav gh gh sidebar"
  "left-nav title title sidebar"
  "left-nav content content sidebar"
  ```
- **Outer bounds:** `1920px` width by `953px` height, `position: fixed`, top `0px`, left `0px`

### Global header (`#global-header-portal`, `gridArea: gh`)
- **Height:** `76px` (`grid-row: 4 / 5`)
- **Width:** `1620px` (`grid-column: 2 / 4`)
- **Position:** `relative`
- **Background:** `rgba(0, 0, 0, 0)` (blends into `#ffffff` canvas)
- **Z-index:** `202`
- **Padding:** `16px 40px`
- **Border bottom:** `0px none`

### Global header action controls
- **Primary CTA ("New" button):**
  - Dimensions: width `88.8px`, height `32px`
  - Background: `rgb(5, 5, 5)` (`#050505`, `--dig-color__primary-cta__base`)
  - Text color: `rgb(247, 245, 242)` (`#F7F5F2`, `--dig-color__primary-cta__on-base`)
  - Border radius: `12px`
  - Font: `13px / normal "Sharp Grotesk"`, font-weight `400`
  - Hover background: `rgb(42, 43, 43)` (`#2A2B2B`, `--dig-color__primary-cta__base--state-1`)
  - Active background: `rgb(54, 55, 57)` (`#363739`, `--dig-color__primary-cta__base--state-2`)
  - Transition: `color 0.1s cubic-bezier(0.4, 0, 0.6, 1), border-color 0.1s cubic-bezier(0.4, 0, 0.6, 1), box-shadow 0.1s cubic-bezier(0.4, 0, 0.6, 1)`
- **Secondary CTA ("Invite members" button):**
  - Dimensions: width `171.7px`, height `40px`
  - Background: `rgba(179, 180, 196, 0.12)` (`--dig-color__opacity__surface--state-1`)
  - Text color: `rgb(5, 5, 5)` (`#050505`)
  - Border radius: `12px`
  - Font: `15px / normal "Sharp Grotesk"`, font-weight `500`
- **Upgrade CTA ("Click to upgrade" button):**
  - Dimensions: width `154.8px`, height `40px`
  - Background: `rgb(180, 220, 25)` (`#B4DC19`, brand lime accent)
  - Text color: `rgb(5, 5, 5)` (`#050505`)
  - Border radius: `12px`
  - Font: `15px / normal "Sharp Grotesk"`, font-weight `500`
- **User profile avatar:**
  - Dimensions: `40px` width by `40px` height
  - Border radius: `12px`

### Search bar in header
- **Input container:** `height: 40px`, embedded left of action cluster
- **Input font:** `14px / normal "Atlas Grotesk"`, font-weight `400`
- **Text color:** `rgb(5, 5, 5)`
- **Placeholder color:** `rgb(101, 105, 110)` (`#65696E`, `--dig-color__text__subtle`)
- **Focus ring:** `box-shadow: 0 0 0 3px #3080ff` (`--dig-utilities__boxshadow__focus-ring`)

### Primary sidebar (`#maestro-nav-portal`, `gridArea: left-nav`)
- **Width:** `300px`
- **Height:** `912px` (from y=41px to y=953px)
- **Position:** `static` inside grid, `z-index: 201`
- **Background:** `rgba(0, 0, 0, 0)` over `#ffffff`
- **Border right:** `0px none` (layout separation through white space and column tracks)
- **Navigation items:**
  - Items list: "All files", "Photos", "Shared", "File requests", "Deleted files"
  - Height: `36px`
  - Padding: `6px 0px`
  - Font: `16px / 26px "Atlas Grotesk"`, font-weight `400`
  - Idle text color: `rgb(101, 105, 110)` (`#65696E`)
  - Active text color: `rgb(5, 5, 5)` (`#050505`, font-weight `500`)
  - Hover background: `rgba(179, 180, 196, 0.12)`, border radius `8px`
- **Sidebar storage quota meter:**
  - Position: Bottom anchor of `#maestro-nav-portal`
  - Meter text: "Using 1.58 MB of 2 GB" (`13px / normal "Atlas Grotesk"`, color `rgb(101, 105, 110)`)
  - Storage action: "Get more storage" button, height `32px`, border radius `8px`, font `13px / 500 "Sharp Grotesk"`

### Title portal (`#maestro-title-portal`, `gridArea: title`)
- **Height:** `60px` (`grid-row: 5 / 6`)
- **Width:** `1620px`
- **Position:** `relative`, `z-index: 5`
- **Padding:** `0px 40px`
- **Heading ("All files"):**
  - Font: `22px / 28px "Sharp Grotesk"`, font-weight `500`
  - Color: `rgb(5, 5, 5)` (`#050505`)
- **Action button cluster:**
  - "Upload": width `109.7px`, height `32px`, border radius `8px`, background `rgba(179, 180, 196, 0.12)`, font `13px / 500 "Sharp Grotesk"`
  - "New folder": width `120.5px`, height `32px`, border radius `8px`, background `rgba(179, 180, 196, 0.12)`, font `13px / 500 "Sharp Grotesk"`
  - "Install app": width `118.4px`, height `32px`, border radius `8px`, background `rgba(179, 180, 196, 0.12)`, font `13px / 500 "Sharp Grotesk"`

### Filter chips bar
- **Selector:** `._container_1uy1p_1`
- **Height:** `56px`, padding `12px 16px`
- **Chips:** "Recents", "Starred"
- **Chip metrics:** height `32px`, padding `0px 16px 0px 12px`, border radius `999px` (pill), background `rgba(179, 180, 196, 0.12)`, color `rgb(5, 5, 5)`, font `14px / 20px "Atlas Grotesk"`, font-weight `400`

### Content canvas (`#maestro-content-portal`, `gridArea: content`)
- **Height:** `776px` (from y=177px to y=953px)
- **Width:** `1620px`
- **Overflow-Y:** `auto`
- **Scroll container:** `.maestro-browse-app-content.maestro-content-scroll`
- **Section container padding:** `0px 40px 0px 36px`

### Secondary details rail (`#sidebar-portal`, `gridArea: sidebar`)
- **Default state:** Collapsed, width `0px`, height `912px`
- **Expanded state:** Docked on right edge, width `320px`, inline grid track adjustment

---

## 2. Design token inventory

### Colors (Light mode / Dark mode)
| Token role | Light computed | Dark computed | Contrast against surface |
| :--- | :--- | :--- | :--- |
| Surface base (canvas) | `rgb(255, 255, 255)` (`#FFFFFF`) | `rgb(18, 18, 18)` (`#121212`) | - |
| Surface container (sidebar) | `rgb(255, 255, 255)` (`#FFFFFF`) | `rgb(22, 22, 24)` (`#161618`) | - |
| Surface subtle / row hover | `rgb(243, 244, 245)` (`#F3F4F5`) | `rgb(40, 40, 43)` (`#28282B`) | - |
| Surface selected | `rgb(215, 218, 222)` (`#D7DADE`) | `rgb(54, 56, 61)` (`#36383D`) | - |
| Primary text | `rgb(5, 5, 5)` (`#050505`) | `rgb(247, 245, 242)` (`#F7F5F2`) | 20.87:1 (Light AAA) / 17.50:1 (Dark AAA) |
| Subtle text (metadata) | `rgb(101, 105, 110)` (`#65696E`) | `rgb(196, 199, 197)` (`#C4C7C5`) | 5.63:1 (Light AA, fails AAA) / 10.12:1 (Dark AAA) |
| Brand accent (Dropbox Blue) | `rgb(0, 97, 254)` (`#0061FE`) | `rgb(92, 164, 255)` (`#5CA4FF`) | 5.15:1 (Light AA, fails AAA) / 7.10:1 (Dark AAA) |
| Brand lime (Upgrade CTA) | `rgb(180, 220, 25)` (`#B4DC19`) | `rgb(180, 220, 25)` (`#B4DC19`) | 13.01:1 on #050505 (AAA pass) |
| Border base | `rgb(176, 180, 186)` (`#B0B4BA`) | `rgb(68, 71, 70)` (`#444746`) | - |
| Row divider | `rgba(0, 0, 0, 0.14)` | `rgba(255, 255, 255, 0.12)` | - |
| Focus ring | `rgb(48, 128, 255)` (`#3080FF`) | `rgb(92, 164, 255)` (`#5CA4FF`) | - |
| Success semantic | `rgb(17, 99, 41)` (`#116329`) | `rgb(126, 231, 135)` (`#7EE787`) | 7.34:1 (Light AAA) / 12.18:1 (Dark AAA) |
| Danger semantic | `rgb(130, 7, 30)` (`#82071E`) | `rgb(255, 148, 146)` (`#FF9492`) | 8.10:1 (Light AAA) / 7.80:1 (Dark AAA) |

### Note on WCAG AAA adherence for Tsubasa implementation
Dropbox Dig uses `#65696E` (5.63:1) for table headers, metadata, and sidebar secondary links, and `#0061FE` (5.15:1) for hovered file names and brand accents. These values pass WCAG AA (4.5:1), but fail the strict 7:1 ratio required for Tsubasa. In Tsubasa's Dropbox token set:
- Muted text maps to `#444746` (9.39:1 in light mode) and `#C4C7C5` (10.12:1 in dark mode).
- Interactive blue text maps to `#0045B5` (7.25:1 in light mode) and `#5CA4FF` (7.10:1 in dark mode).
- Semantic statuses adhere to `#116329` (success) and `#82071E` (danger) per project guidelines.

### Typography scale
| Role | Size | Weight | Line height | Letter spacing | Font family | Sample selector |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Page title | `22px` | `500` | `28px` | `normal` | Sharp Grotesk | `#maestro-title-portal h1` |
| Primary button | `15px` | `500` | `normal` | `0.3px` | Sharp Grotesk | `button.dig-Button` |
| Action button | `13px` | `500` | `normal` | `0.26px` | Sharp Grotesk | `._actionButton_ahpdu_1` |
| Nav primary | `16px` | `500` | `26px` | `normal` | Atlas Grotesk | `#maestro-nav-portal a` (active) |
| Nav secondary | `16px` | `400` | `26px` | `normal` | Atlas Grotesk | `#maestro-nav-portal a` (idle) |
| Table header | `14px` | `500` | `22px` | `normal` | Atlas Grotesk | `tr._headerRow_1adl5_31 th` |
| Table cell | `14px` | `400` | `22px` | `normal` | Atlas Grotesk | `tr._row_1adl5_88 td` |
| Filter chip | `14px` | `400` | `20px` | `normal` | Atlas Grotesk | `._container_1uy1p_1 button` |
| Menu item | `14px` | `400` | `normal` | `normal` | Atlas Grotesk | `.dig-Menu-canvas div` |
| Small meta tag | `12px` | `400` | `normal` | `normal` | Atlas Grotesk | `span.meta` |
| Micro badge | `10px` | `500` | `normal` | `normal` | Atlas Grotesk | `span.counter` |

### Spacing and radius scales
- **Base spacing multiplier:** `4px` / `8px`
- **Standard step scale:** `4px` (`space1`), `8px` (`space2`), `12px` (`space3`), `16px` (`space4`), `20px` (`space5`), `24px` (`space6`), `32px` (`space8`), `40px` (`space10`), `48px` (`space12`), `64px` (`space16`)
- **Corner radius scale:**
  - Sharp: `0px`
  - Small: `4px`
  - Medium: `8px` (action buttons, list items)
  - Large / CTA: `12px` (header buttons, avatar, inputs)
  - Card / Popover / Menu: `24px` (context menu canvas, dialogs)
  - Pill: `999px` (filter chips)

### Elevation shadows
- **Level 0 (Flat):** `none`
- **Level 1 (Subtle float):** `rgba(0, 0, 0, 0.08) 0px 2px 4px 0px`
- **Level 2 (Popovers / Menus):** `rgba(0, 0, 0, 0.04) 0px 10px 40px 20px, rgba(0, 0, 0, 0.04) 0px 20px 30px -45px, rgba(0, 0, 0, 0.04) 0px 20px 30px -4px`
- **Level 3 (Modal dialogs):** `rgba(0, 0, 0, 0.15) 0px 16px 48px 0px`
- **Focus ring:** `0 0 0 3px #3080ff` (`--dig-utilities__boxshadow__focus-ring`)

---

## 3. Core component contracts

### Data table / list row (`tr._row_1adl5_88`)
- **Row height:** `48px` (`rect.height: 48px`, cell `rect.height: 47px`, border bottom `1px solid rgba(0, 0, 0, 0.14)`)
- **Row display mode:** `display: flex`
- **Column alignment and widths:**
  1. Checkbox cell: width `40px`, padding `0px 10px`
  2. Name cell: flex-grow `1`, width `1042px` (desktop), padding `0px 0px 0px 8px`
  3. Last modified cell: width `176px`, padding `0px 8px`, text-align `left`
  4. Size cell: width `146px`, padding `0px 8px`, text-align `left`
  5. Access cell: width `176px`, padding `0px 8px`, text-align `left`
- **Interactive row states:**
  - Idle state: background `rgba(0, 0, 0, 0)`, color `rgb(5, 5, 5)`
  - Hover state: background `rgb(243, 244, 245)` (`#F3F4F5`), transition `all 0.1s ease`
  - Selected state: background `rgb(215, 218, 222)` (`#D7DADE`), border bottom `1px solid rgba(0, 0, 0, 0.14)`
- **Hover action buttons cluster:**
  - Position: Right side of Name cell, floating over row background
  - Share pill: width `63.8px`, height `32px`, background `rgb(5, 5, 5)`, color `rgb(247, 245, 242)`, border radius `12px`
  - Icon buttons: Rename, Copy link, Star, More (`...`) buttons, dimensions `32px` width by `32px` height
- **Virtualization mechanics:**
  - Viewport virtualization detected inside `.maestro-content-scroll`. Transforms use dynamic `translateY` offsets with recycled DOM row nodes when scrolling large directories.

### Context menu & action dropdown (`.dig-Menu-canvas`)
- **Container surface:** width `231px` (flexible up to `280px`), background `rgb(255, 255, 255)`, border `1px solid rgba(0, 0, 0, 0.14)`, border radius `24px`
- **Box shadow:** `rgba(0, 0, 0, 0.04) 0px 10px 40px 20px, rgba(0, 0, 0, 0.04) 0px 20px 30px -45px, rgba(0, 0, 0, 0.04) 0px 20px 30px -4px`
- **Padding:** `12px 0px` segment padding
- **Menu item geometry:**
  - Item height: `40px`
  - Item width: `207px`
  - Item padding: `0px 8px`
  - Text: `14px / normal "Atlas Grotesk"`, color `rgb(5, 5, 5)`
  - Hover background: `rgba(179, 180, 196, 0.18)` (`--dig-color__opacity__surface--state-1`), border radius `8px`
- **Menu items observed:** Download, Open in, Copy link, Share selected, Manage permissions, Rename, Move, Copy, Save as, Delete, File info, More.

### Modals and scrims
- **Modal overlay / backdrop:** `background-color: rgba(255, 255, 255, 0.5)`, `backdrop-filter: blur(8px)`
- **Modal card radius:** `24px`

---

## 4. Key architectural takeaways for implementation

1. **Fixed 48px row height contract.**
   Data rows and header rows use an exact 48px height (`display: flex`, cell height 47px with 1px border). TanStack Virtual row estimates must be set to exactly `48` to prevent layout jumps or offset drift during fast scrolling.
2. **24px heavy corner radius for elevated containers.**
   Dropbox Dig 2 establishes a distinct 24px corner radius for floating menus, dropdown canvases, and dialogs. This contrasts with Google Drive's 8px/16px and MEGA's 8px/12px radius scales.
3. **Pill-shaped filter chips and 12px button radius.**
   Navigation filters ("Recents", "Starred") use pill geometry (`border-radius: 999px`) with 32px height. Action buttons ("New", "Invite members", "Upgrade") use 12px radius, while secondary utility buttons use 8px.
4. **WCAG AAA color normalization.**
   Dropbox's native secondary text (`#65696E`, 5.63:1) and hover link blue (`#0061FE`, 5.15:1) fail the strict 7:1 AAA standard. Tsubasa's Dropbox theme normalizes secondary text to `#444746` (9.39:1) and active blue to `#0045B5` (7.25:1) in light mode, ensuring accessibility across all themes.
5. **Macro shell grid structure.**
   The outer layout divides into 300px sidebar, 76px header, 60px title bar, and flexible scrollable content. Tsubasa's shell can map directly to this grid layout or toggle into compact modes.

