# UI/UX architectural teardown: Dropbox mobile web

## Target metadata
- **Target URL / App:** `https://www.dropbox.com/home`
- **Inspection date:** 2026-11-08
- **Audit tool:** REA / Chrome DevTools Protocol (CDP loopback on `127.0.0.1:9222`)
- **Viewports tested:** Mobile (427x952 observed viewport, Pixel 9 Pro emulation, DPR 3)
- **Design system identifier:** Dropbox Dig 2 (`dig-Theme-vis2023 dig-Theme-vis2023--bright dig-Mode--bright In-Theme-Provider maestro--responsive`)

## 1. Shell layout and spatial matrix

### Mobile layout grid (`#maestro-portal`)
- **Display:** `grid`
- **Columns:** `grid-template-columns: 213.5px 213.5px` (symmetric two-column allocation spanning `427px`)
- **Rows:** `grid-template-rows: 0px 0px 0px 0px 76px 0px 64px 812px`
- **Grid areas mapping:**
  ```css
  "campaigns-toolkit campaigns-toolkit"
  "dev-notices dev-notices"
  "prompt prompt"
  "left-nav left-nav"
  "gh gh"
  "sidebar sidebar"
  "title title"
  "content content"
  ```
- **Outer bounds:** `427px` width by `952px` height, `position: fixed`, top `0px`, left `0px`

### Mobile header (`#global-header-portal`, `gridArea: gh`)
- **Height:** `76px`
- **Width:** `427px`
- **Position:** `relative`, `z-index: 202`
- **Background:** `rgba(0, 0, 0, 0)` over `#ffffff`
- **Action controls in mobile header:**
  - **Global Navigation (Hamburger menu):** at `x: 8px, y: 15px`, dimensions `32px` width by `32px` height, `aria-label: "Global Navigation"`
  - **Primary CTA ("New" button):** at `x: 48px, y: 8px`, width `88.8px`, height `32px`, border radius `12px`, background `#050505`, text `#F7F5F2`
  - **Secondary CTA ("Invite members" icon):** at `x: 188.2px, y: 17px`, width `24px`, height `32px`, collapsed to icon
  - **Upgrade CTA ("Click to upgrade" button):** at `x: 224.2px, y: 14px`, width `154.8px`, height `40px`, border radius `12px`, background `#B4DC19` (lime), text `#050505`
  - **User profile avatar:** at `x: 387px, y: 17px`, width `32px`, height `32px`, border radius `12px`

### Mobile title portal (`#maestro-title-portal`, `gridArea: title`)
- **Height:** `64px` (from y=76px to y=140px)
- **Width:** `427px`
- **Position:** `relative`, `z-index: 5`
- **Title text:** "All files", `22px / 28px "Sharp Grotesk"`, font-weight `500`
- **Action button cluster:**
  - "Folder settings" icon button: at `x: 105.9px, y: 102px`, width `32px`, height `32px`
  - "Upload" compact button: at `x: 315px, y: 102px`, width `48px`, height `32px`, border radius `8px`, background `rgba(179, 180, 196, 0.12)`
  - "New folder" icon button: at `x: 371px, y: 102px`, width `32px`, height `32px`, border radius `8px`, background `rgba(179, 180, 196, 0.12)`

### Mobile filter chips bar
- **Position:** `y: 156px` to `y: 193px`
- **Chips presented:**
  - "Recents": at `x: 20px, y: 161px`, width `105.2px`, height `32px`, border radius `999px` (pill), background `rgba(179, 180, 196, 0.12)`, font `14px / 20px "Atlas Grotesk"`
  - "Starred": at `x: 133.2px, y: 161px`, width `102.4px`, height `32px`, border radius `999px` (pill), background `rgba(179, 180, 196, 0.12)`
  - "Select view type" (List / Grid toggle): at `x: 379px, y: 156px`, width `32px`, height `32px`, border radius `8px`

### Content canvas (`#maestro-content-portal`, `gridArea: content`)
- **Height:** `812px` (from y=140px to y=952px)
- **Width:** `427px`
- **Scroll container:** `.maestro-browse-app-content.maestro-content-scroll`
- **Overflow-Y:** `auto`

---

## 2. Slide-out navigation drawer (`.maestro-nav__container`)

- **Off-canvas position:** `x: -300px, y: 0px`
- **Active / open position:** Slides into `x: 0px, y: 0px`
- **Dimensions:** Width `300px`, height `952px` (full viewport height)
- **Positioning:** `position: fixed`, `z-index: 3`
- **Background:** `rgb(243, 244, 245)` (`#F3F4F5`, `--dig-color__background__subtle`)
- **Animation timing:** `transform 0.25s cubic-bezier(0.215, 0.61, 0.355, 1)`
- **Header section:** Height `64px` (y=0 to 64px)
- **Navigation features list (`._navFeatures_3v8lz_17`):**
  - Container: width `252px`, height `206px`, padding `0px`
  - Items list: "All files", "Photos", "Shared", "File requests", "Deleted files"
  - Item metrics: height `36px`, padding `6px 0px`, font `16px / 26px "Atlas Grotesk"`
  - Idle color: `rgb(101, 105, 110)` (`#65696E`)
  - Active color: `rgb(5, 5, 5)` (`#050505`)
- **Footer section (`._navFooter_3v8lz_129`):**
  - Position: Bottom anchor, y=807px to y=952px, height `145px`
  - Storage meter text: "Using 1.58 MB of 2 GB" (`13px / normal "Atlas Grotesk"`)
  - Storage action: "Get more storage" button, height `32px`, border radius `8px`, font `13px / 500 "Sharp Grotesk"`

---

## 3. Core component contracts on mobile

### Mobile data table / list row (`tr._row_1adl5_88`)
- **Row height:** Strictly `48px` (`rect.height: 48px`, cell `rect.height: 47px`, border bottom `1px solid rgba(0, 0, 0, 0.14)`)
- **Row display mode:** `display: flex`
- **Column adaptation on mobile:**
  - **Visible columns:**
    1. Checkbox cell (`_checkboxCell_1adl5_217`): width `32px` (compacted from desktop 40px)
    2. Name cell (`_nameCell_1adl5_253`): width `375px` (flex-1 across remaining width)
  - **Hidden columns:**
    - "Last modified" (`_modifiedCell_1adl5_269`): `display: none`
    - "Size" (`_sizeCell_1adl5_270`): `display: none`
    - "Access" (`_accessCell_1adl5_271`): `display: none`
- **Trailing action button on mobile:**
  - Selector: `button[aria-label="More menu"]`
  - Dimensions: `32px` width by `32px` height
  - Position: Permanently visible at `x: 379px, y: 260.5px` (unlike desktop where it surfaces only on hover)
  - Icon: Three horizontal dots (`...`), `24px x 24px` SVG
- **Row background states:**
  - Idle: `rgba(0, 0, 0, 0)`
  - Selected: `rgb(215, 218, 222)` (`#D7DADE`)

### Mobile action menu / popover (`.dig-Menu-canvas`)
- **Trigger:** Tapping the `32px x 32px` "More menu" button
- **Surface dimensions:** Width `248px`, height dynamic (`~648px` for 12 items)
- **Positioning:** Anchored at `x: 163px, y: 297px`
- **Background:** `rgb(255, 255, 255)` (`#FFFFFF`)
- **Corner radius:** `24px` (Dropbox preserves its distinctive 24px corner radius on mobile rather than switching to a full-width bottom sheet)
- **Box shadow:** `rgba(0, 0, 0, 0.04) 0px 10px 40px 20px, rgba(0, 0, 0, 0.04) 0px 20px 30px -45px, rgba(0, 0, 0, 0.04) 0px 20px 30px -4px`
- **Menu action items:**
  - Item height: `40px`
  - Item width: `222px`
  - Padding: `0px 8px`
  - Font: `14px / normal "Atlas Grotesk"`, color `rgb(5, 5, 5)`
  - Items list: "Download", "Open in", "Copy link", "Share", "Manage permissions", "Rename", "Move", "Copy", "Save as…", "Delete"

---

## 4. Key architectural takeaways for Tsubasa implementation

1. **Uniform 48px row height across viewports.**
   Unlike MEGA (which jumps from 32px on desktop to 64px on mobile), Dropbox enforces a uniform 48px row height regardless of viewport width. This simplifies TanStack Virtual configuration since `estimateSize: () => 48` can remain constant across both desktop and mobile viewports.
2. **Column-hiding responsive contract.**
   At widths below `768px`, secondary columns (Last modified, Size, Access) are removed from the row layout, dedicating full width to Checkbox (32px) and Name (flex-1).
3. **Persistent touch targets on mobile rows.**
   On desktop, action buttons (Share, Copy link, More menu) hide until hover. On mobile touch viewports, the `32px x 32px` "More menu" button remains persistently visible on the trailing edge of each row.
4. **Off-canvas drawer animation.**
   The 300px navigation sidebar transitions off-canvas (`transform: translateX(-300px)`), sliding into `translateX(0)` in 250ms with `cubic-bezier(0.215, 0.61, 0.355, 1)` when triggered by the global navigation hamburger icon.
5. **Compact header and action controls.**
   Buttons in the title bar collapse to icon-only variants (32px x 32px) while preserving the 12px corner radius on primary CTAs and 8px on secondary tools.

