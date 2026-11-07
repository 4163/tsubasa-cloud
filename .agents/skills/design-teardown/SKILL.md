---
name: design-teardown
description: Agnostic, REA-driven UI/UX architectural teardown and styling audit. Reverse-engineers layout metrics, spatial hierarchy, design tokens, interaction states, and accessibility contracts from any web target into factual reports and token definitions.
argument-hint: "<url|target-id|app-name> [pass 1-6|all]"
---

# Design Teardown

Agnostic, evidence-based UI/UX architectural teardown and styling audit. It inspects running web applications or static captures via REA (Reverse Engineer Anything) and the Chrome DevTools Protocol (CDP), extracting exact design tokens, spatial relationships, component states, and accessibility metrics.

The output is a factual report and structured tokens, not generic advice.

## House rules

These seven rules govern every audit pass:

1. **Every claim requires computed evidence.** Record computed CSS properties (`getComputedStyle`) and bounding box dimensions (`getBoundingClientRect`). Never guess padding, line-height, or color from visual inspection alone.
2. **Distinguish tokenized values from one-offs.** Flag whether a measured value belongs to a repeated harmonic scale (e.g. 4px/8px spacing grid, standard type scale) or is an arbitrary hardcoded override.
3. **Capture all interactive states.** An element teardown is incomplete without recording default, hover, active/pressed, focus-visible, selected, and disabled states.
4. **Enforce contrast verification.** Measure foreground-to-background contrast ratios for all text and interactive icons against WCAG 2.2 AAA (7:1 for normal text, 4.5:1 for large or bold text) across both light and dark themes.
5. **No editorializing or puffery.** Avoid words like "clean", "intuitive", or "modern". State exact dimensions, hex codes, transition durations, layout display modes, and DOM hierarchy.
6. **Identify virtualization boundaries.** On tables, lists, and trees, inspect whether the DOM renders all items or uses viewport virtualization (windowing). Record container heights and row heights.
7. **Mark unobserved values explicitly.** If an interaction state, responsive breakpoint, or dark mode variant cannot be triggered, record it as `UNOBSERVED` rather than inferring what it might be.

---

## Audit workflow

Run the audit across six sequential passes:

```
Pass 1: Macro Shell & Viewport Allocation
Pass 2: Foundational Design Tokens (Colors, Typography, Elevation, Spacing)
Pass 3: Data Containers, Lists & Grid Tables
Pass 4: Interactive States, Focus & Selection
Pass 5: Overlays, Menus & Action Drawers
Pass 6: Report Compilation & Token Export
```

### Pass 1: Macro shell and viewport allocation

Inspect the outer application shell and high-level layout containers.

- **Viewport and breakpoints:** Inspect behavior at Desktop (1440x900), Laptop (1024x768), Tablet (820x1180), and Mobile (390x844).
- **Application chrome:**
  - Header / top navigation bar: Height, padding, position (`fixed`, `sticky`, or static), border or shadow separation, search bar bounds and border radius.
  - Primary sidebar / rail: Expanded width, collapsed icon-only width, padding, border separator, scroll behavior.
  - Main content canvas: Outer margins, gutters, max-width constraints, overflow handling (`overflow-y: auto`, `contain: strict`).
  - Secondary panels (activity feed, details drawer): Default width, dock position, overlay vs inline reflow.

### Pass 2: Foundational design tokens

Extract the foundational design variables across both light and dark modes.

- **Color palette and surface layers:**
  - Base background color (`canvas`, `body`).
  - Surface elevations (surface-container-lowest, low, default, high, highest).
  - Text colors (primary text, secondary/muted text, disabled text, placeholder text).
  - Brand and accent colors (primary, hover tint, active tint, focus ring).
  - Semantic status colors (success, warning, danger, info).
  - Border and divider strokes (default border, subtle separator, active focus border).
- **Typography scale:**
  - Font families (primary sans-serif stack, monospace stack).
  - Scale levels: Display, Title/Heading (H1, H2, H3), Body (default, secondary), Caption/Label.
  - For each level, record: `font-size`, `font-weight`, `line-height`, `letter-spacing`.
- **Spacing and radius scales:**
  - Spacing grid: Base multiplier (e.g. 4px, 8px) and standard step scale (4, 8, 12, 16, 24, 32, 48, 64px).
  - Corner radius scale: None (0px), small (4px), medium (8px), large (12px), pill/round (9999px).
- **Elevation and depth:**
  - Box shadows per elevation tier (level 0 to level 4).
  - Z-index layering ladder (base, sticky header, drawer, modal, tooltip/popover).

### Pass 3: Data containers, lists, and grid tables

Examine the primary data-display surfaces (e.g. file tables, item lists, card grids).

- **Header row:** Height, text transformation, font weight, column separators, sort direction indicator placement and styling.
- **Row and cell geometry:**
  - Compact vs comfortable row heights (exact px).
  - Column alignment (left-aligned text, right-aligned numbers/dates, centered icons).
  - Icon and thumbnail dimensions, gap between icon and label.
  - Text truncation rules (`text-overflow: ellipsis`, `max-width`, wrapping constraints).
- **Virtualization mechanics:**
  - Check for dynamic translation transforms (`transform: translateY(...)`) or spacer elements.
  - Measure DOM node recycling count during active scrolling.

### Pass 4: Interactive states, focus, and selection

Inspect how the interface responds to user interaction.

- **Row and item states:**
  - Idle state: Background color, text color, icon opacity.
  - Hover state: Background color change, cursor style, action button visibility (e.g. actions appearing on hover).
  - Active/pressed state: Scale change, background darkening or brightening.
  - Focus state: Outline style, outline width, outline offset, `:focus-visible` behavior.
  - Selected state: Background tint, accent border, checkbox state indicator.
- **Selection model:**
  - Single click vs double click behavior.
  - Multi-select mechanics: Checkbox selection, Shift/Ctrl modifier selection, rubber-band marquee selection.
  - Floating action toolbar or bulk action rail dimensions, trigger animation, and actions presented.
- **Motion and timing:**
  - Standard transition durations (e.g. 150ms, 200ms).
  - Easing functions (`linear`, `ease-out`, `cubic-bezier(...)`).

### Pass 5: Overlays, menus, and action drawers

Audit floating and modal surfaces.

- **Context menus and dropdowns:**
  - Trigger mechanism (right click, three-dot button).
  - Menu surface: Background, border, shadow, border radius, minimum width.
  - Menu items: Row height, padding, icon sizing, keyboard shortcut text styling, hover highlight pill.
  - Separator lines: Margin, color, height.
- **Drawers and modals:**
  - Scrim / backdrop color, opacity, and backdrop-filter blur.
  - Dialog container: Width, max-height, border radius, padding, header/footer border separation.
  - Close button position, touch target size.
- **Toasts, banners, and snackbars:**
  - Dock position (bottom-left, bottom-center, top-right).
  - Height, radius, action button styling, entry and exit transitions.

### Pass 6: Report compilation and token export

Synthesize findings into two concrete artifacts:

1. **Factual teardown report:** Write to `docs/teardowns/<target-slug>.md` using the standard report structure below.
2. **Code tokens file:** Export measured values into the project's styling language (e.g. StyleX `defineVars` in `src/client/tokens.stylex.ts` or CSS Custom Properties).

---

## REA and browser inspection methods

### Connecting to a live target via CDP

1. Verify target browser is listening on CDP (default `http://127.0.0.1:9222`).
2. List available pages and inspect:
   - Use REA tool `list_browser_targets` to obtain target page IDs.
   - Use REA tool `inspect_web_page` to inspect DOM fragments and scripts.
   - Use REA tool `capture_web_screenshot` to document component visual states.

### Extraction console snippets

Run these evaluation snippets via CDP or browser console to extract exact computed values.

#### Extract surface and text colors
```javascript
(() => {
  const elements = Array.from(document.querySelectorAll('*'));
  const colors = new Set();
  const backgrounds = new Set();
  elements.slice(0, 500).forEach(el => {
    const style = window.getComputedStyle(el);
    if (style.color) colors.add(style.color);
    if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      backgrounds.add(style.backgroundColor);
    }
  });
  return { colors: Array.from(colors), backgrounds: Array.from(backgrounds) };
})();
```

#### Extract typography scale
```javascript
(() => {
  const selectorList = 'h1, h2, h3, h4, h5, h6, p, span, a, button, [role="row"], [role="gridcell"]';
  const nodes = document.querySelectorAll(selectorList);
  const typeMap = {};
  nodes.forEach(el => {
    const cs = window.getComputedStyle(el);
    const key = `${cs.fontSize} / ${cs.fontWeight} / ${cs.lineHeight}`;
    if (!typeMap[key]) {
      typeMap[key] = {
        sampleText: el.innerText ? el.innerText.trim().slice(0, 30) : el.tagName,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
      };
    }
  });
  return Object.values(typeMap);
})();
```

#### Extract row and table metrics
```javascript
((rowSelector) => {
  const row = document.querySelector(rowSelector);
  if (!row) return null;
  const cs = window.getComputedStyle(row);
  const rect = row.getBoundingClientRect();
  return {
    height: rect.height,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
    paddingRight: cs.paddingRight,
    borderBottom: cs.borderBottom,
    display: cs.display,
  };
})('[role="row"], tr, .row');
```

---

## Report template

When Pass 6 runs, format the teardown document (`docs/teardowns/<target>.md`) with this structure:

```markdown
# UI/UX Architectural Teardown: <Target Name>

## Target metadata
- **Target URL / App:** <URL or application name>
- **Inspection date:** <YYYY-MM-DD>
- **Audit tool:** REA / Chrome DevTools Protocol
- **Viewports tested:** Desktop (1440x900), Laptop (1024x768)

## 1. Shell layout and spatial matrix
- **Header:** height `<px>`, position `<type>`, padding `<px>`
- **Sidebar:** width `<px>` (collapsed `<px>`), separator `<border or shadow>`
- **Content canvas:** margins `<px>`, scroll container `<selector>`
- **Responsive behavior:** <Summary of reflow points>

## 2. Design token inventory
### Colors (Light mode / Dark mode)
| Token role | Light computed | Dark computed | Contrast against surface |
| :--- | :--- | :--- | :--- |
| Surface base | rgb(...) | rgb(...) | - |
| Surface container | rgb(...) | rgb(...) | - |
| Primary text | rgb(...) | rgb(...) | X.X:1 (Pass/Fail) |
| Muted text | rgb(...) | rgb(...) | X.X:1 (Pass/Fail) |
| Brand accent | rgb(...) | rgb(...) | X.X:1 (Pass/Fail) |
| Border divider | rgb(...) | rgb(...) | - |

### Typography
| Role | Size | Weight | Line height | Letter spacing | Sample selector |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Display | ... | ... | ... | ... | ... |
| Title | ... | ... | ... | ... | ... |
| Body | ... | ... | ... | ... | ... |
| Label / Meta | ... | ... | ... | ... | ... |

### Spacing and radius
- **Base spacing unit:** `<px>`
- **Radius scale:** Small `<px>`, Medium `<px>`, Large `<px>`, Pill `<px>`
- **Elevation shadows:**
  - Low: `box-shadow: ...`
  - Mid: `box-shadow: ...`
  - High: `box-shadow: ...`

## 3. Core component contracts
### Data table / list row
- **Row height:** `<px>` (compact `<px>`)
- **Icon size:** `<px>`
- **Hover background:** `rgb(...)`
- **Selected background:** `rgb(...)`
- **Virtualization:** <Yes/No, mechanism detected>

### Context menu & dropdowns
- **Padding:** `<px>`
- **Item height:** `<px>`
- **Corner radius:** `<px>`
- **Shadow:** `<box-shadow string>`

## 4. Key architectural takeaways for implementation
- 1. <Concrete takeaway, e.g. Row height must be strictly 48px to match virtualizer offset>
- 2. <Concrete takeaway, e.g. Surface container uses 8px radius with 1px outline-variant>
```

---

## Verification checklist

Before completing an audit report, verify every item:

- [ ] All reported color hex/rgb values are from computed styles.
- [ ] Contrast ratios meet WCAG AAA (7:1 for normal body text).
- [ ] Row and header heights are confirmed via `getBoundingClientRect`.
- [ ] Hover, active, focus-visible, and selected states are documented for interactive elements.
- [ ] Token names follow standard Design Tokens Community Group (DTCG) or StyleX conventions.
- [ ] No unverified claims or subjective aesthetic adjectives are present in the report.

