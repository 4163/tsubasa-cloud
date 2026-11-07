# UI/UX architectural teardown: Hanekawa ~ (x4163-apps)

## Target metadata
- **Target URL / App:** `D:\Projects\x4163-apps\index.html` (Hanekawa ~ landing page)
- **Inspection date:** 2026-11-08
- **Audit tool:** REA local source inspection and computed token evaluation
- **Viewports tested:** Desktop (1920x1080 screenshot verified), Breakpoints (Small <635px, Medium <954px, Large <1280px, Headroom <498px)

## 1. Shell layout and spatial matrix
- **Viewport bounds:**
  - `html, body`: `100%` width by `100dvh` height, `overflow: hidden`
  - Position model: Absolute-stacked canvas, interactive DOM portal, sprite layers, and grain overlay
- **Scale-adaptive geometry:**
  - Sprite height constant: `239px`
  - Minimum top gap constant: `20px`
  - Dynamic scale factor (`--sprite-scale`): `Math.max(1, Math.floor((window.innerHeight - 20) / 239))`
  - Responsive breakpoint caps:
    - `width < 635px`: clamped to scale `1`
    - `width < 954px`: clamped to scale `2`
    - `width < 1280px`: clamped to scale `3`
    - `width >= 1280px` and `height >= 976px`: scale `4`
  - Pixel ratio quantization: `PIXEL_SCALE = 2 + Math.max(0, spriteScale - 3)`
- **Portal container (`.portal`):**
  - Position: `position: relative`, centered vertically and horizontally in `main`
  - Scale: `scale: max(2, var(--sprite-scale))`
  - Translation: `translate: calc(-25% * var(--sprite-scale))` (at scale 1: `translate: unset`)
  - Layout: `display: flex`, `flex-direction: column`, `align-items: center`
  - Gap: `calc(0.5ch + 1px)`
  - Base font size: `10px`
- **Interactive floating sound bubble (`#bubble.bubble`):**
  - Position: `position: absolute`, `left: 50%`, `top: -65%`, `margin-bottom: 2ch`, `z-index: 10`
  - Counter-scale: `scale: calc(1 / max(2, var(--sprite-scale)))` so bubble retains 1:1 screen size
  - Dimensions:
    - Base: `width: clamp(48px, 10vmin, 88px)`, `aspect-ratio: 1`, `border-radius: 50%`
    - Scale 3 override: `clamp(38px, 8vmin, 72px)`
    - Scale 2 override: `clamp(36px, 7.5vmin, 64px)`
    - Scale 1 override: `clamp(34px, 7vmin, 58px)`
    - Headroom mode (`height < 498px` and scale 1): `left: -20%`, `top: 45%`
  - Motion:
    - Vertical float: `bubbleFloat 8s ease-in-out infinite` (`transform: translateY(-15px)` to `translateY(15px)`)
    - Surface wobble: `bubbleWobble 2s ease-out infinite` (`scaleY(0.95) scaleX(1.05)` to `scaleY(1.1) scaleX(0.9)`)
  - Glass surface:
    - Light: `radial-gradient(circle at 50% 40%, rgba(255, 255, 255, 0.28), rgba(255, 255, 255, 0.08))` with `backdrop-filter: blur(3px)`
    - Dark: `radial-gradient(circle at 50% 40%, rgba(210, 210, 210, 0.42), rgba(210, 210, 210, 0.14))`
    - Specular highlights: Multi-tier box-shadow with iridescent rims (magenta, yellow, blue, cyan) and blur highlights
  - Shard burst on pop: 14 polygon shards (triangles, diamonds, quads, dots) animated via Web Animations API (WAAPI)
- **Character sprite (`.hanekawa`):**
  - Natural dimensions: `239px` height
  - Position: `position: absolute`, `bottom: 0`, `transform-origin: bottom center`
  - Transform: `scale: var(--sprite-scale)`, `translate: calc(45% * var(--sprite-scale))`
  - Scale 1 translate: `18%` (at `height < 498px`: `80%`; at `width < 635px` and `height < 705px`: `62.5%`)
  - Hit testing: 2D canvas alpha mask (`data[i*4 + 3] > 0`). Non-transparent pixels update cursor to `pointer` via `html.hanekawa-hover`
- **Background dither canvas:**
  - Internal dimensions: `573px` by `235px` canvas rendering a `704px` by `439px` oversized dither texture
  - Algorithm: Bayer 4x4 threshold matrix, dither strength `38`, precomputed 4096-entry lookup table
  - Palette quantization: 4 distinct luminance steps
- **Grain overlay (`.grain-overlay`):**
  - Fixed full-screen overlay, `z-index: 999`, `pointer-events: none`
  - Texture: SVG fractal noise repeated at `256px` by `256px` with `opacity: 0.2`

## 2. Design token inventory

### Colors (Light mode / Dark mode)
| Token role | Light computed | Dark computed | Contrast against surface |
| :--- | :--- | :--- | :--- |
| Canvas / base background | `#ffffff` (`rgb(255, 255, 255)`) | `#d2d2d2` (`rgb(210, 210, 210)`) | - |
| Primary text | `#000000` (`rgb(0, 0, 0)`) | `#000000` (`rgb(0, 0, 0)`) | 21.00:1 (Light AAA) / 13.86:1 (Dark AAA) |
| Border stroke | `#313841` (`rgb(49, 56, 65)`) | `#313841` (`rgb(49, 56, 65)`) | 11.20:1 (Light AAA) / 7.37:1 (Dark AAA) |
| Brand gold accent | `#deb76c` (`rgb(222, 183, 108)`) | `#deb76c` (`rgb(222, 183, 108)`) | 1.88:1 (Light Fail as text) / 11.14:1 (AAA with black text) |
| Dark mode drop-shadow glow | `transparent` | `#ffffff` (`rgb(255, 255, 255)`) | 1.51:1 (Luminance separation against #d2d2d2) |
| Dither shade 0 | `#ffffff` | `#d2d2d2` | - |
| Dither shade 1 | `#d2d2d2` | `#aaaaaa` | - |
| Dither shade 2 | `#aaaaaa` | `#787878` | - |
| Dither shade 3 | `#787878` | `#484848` | - |

Note on WCAG AAA adherence:
In Hanekawa, `--color-gold` (`#deb76c`) is never used directly as body text on white. It is applied exclusively as a CSS filter outline on interactive elements, a text selection background with white text, or an indicator element with black text. On `#deb76c`, black text yields an 11.14:1 contrast ratio, which passes WCAG AAA.

### Typography
| Role | Size | Weight | Line height | Letter spacing | Font family |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Prompt header | `10px` | `400` | `1.2` | `normal` | `'Pixelify Sans', cursive` |
| Options & buttons | `10px` | `400` | `1.2` | `normal` | `'Pixelify Sans', cursive` |
| Text input | `10px` | `400` | `1.2` | `normal` | `'Pixelify Sans', cursive` |
| Secondary body stack | `12px` | `400 700` | `1.4` | `normal` | `'Montserrat', sans-serif` |

All pixel art typography and UI chrome render with `image-rendering: pixelated` and `image-rendering: crisp-edges`.

### Spacing and radius
- **Base spacing steps:**
  - Portal gap: `calc(0.5ch + 1px)` (~`6px`)
  - Options gap (Light): `calc(0.5ch + 7px)` (~`12px`)
  - Options gap (Dark): `calc(0.5ch + 8px)` (~`13px`)
  - Form row gap: `calc(1ch + 2px)` (~`12px`)
- **Border slice and radius scale:**
  - Header speech bubble: 9-slice image, slice `8px fill`, width `8px`
  - Input and dots bubbles: 9-slice image, slice `3px fill`, width `3px`
  - Preview radius property (`--preview-radius`): `4px`
  - Shard corner radius: `1px`
  - Bubble visual radius: `50%`

## 3. Core component contracts

### Speech bubble header (`.header`)
- **Display:** `display: flex`, `flex-direction: column`, `align-items: center`
- **Border:** 9-slice image `/assets/landpage/speech-bubble.png` (8px border-image-width, 8 fill slice)
- **Inner lines:** Pseudo-elements `::before` (inset `0 7px`, top/bottom `1px solid #313841`) and `::after` (inset `7px 0`, left/right `1px solid #313841`)
- **Focus state:** Gold color filter applied via CSS filter generator (`brightness(0) saturate(100%) invert(80%) sepia(29%) saturate(620%) hue-rotate(355deg) brightness(90%) contrast(93%)`)

### Interactive option input (`.input`, `.dots`)
- **Border:** 9-slice image `/assets/landpage/input-bubble.png` (3px border-image-width, 3 fill slice)
- **Padding:** `3px`
- **Caret blink:** `@keyframes cursorBlink` running 1s step-end on `input:placeholder-shown:not(:focus)` using a 1px vertical gradient of `#deb76c`
- **Selector indicator:** `assets/landpage/selector.png`, height `5px`. Active state runs `@keyframes selectorBounce` (1s step-end, `transform: translateX(-1px)`)
- **Focus state:** Keyboard focus applies `--gold-filter` to the wrapper unless actively typing (`.typing` class suppresses filter)

### Shard particle explosion (`.bubble-shard`)
- **Count:** 14 shards
- **Shapes:**
  - Triangle (`.shard-triangle`): `polygon(50% 0%, 0% 100%, 100% 100%)`, aspect `0.7`
  - Diamond (`.shard-diamond`): `polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)`
  - Irregular quad (`.shard-quad`): 4-point polygon using CSS variables
  - Dot (`.shard-dot`): rectangle with `border-radius: 1px`
- **Physics:** Driven by Web Animations API with randomized initial angles, velocities, drag deceleration, and opacity fade-out

## 4. Key architectural takeaways for implementation
1. **Dynamic integer scaling:** Hanekawa anchors layout scale to an integer multiplier calculated from available window height. This maintains crisp pixel art scaling without fractional blur.
2. **Double 9-slice chrome:** Bubble speech containers combine outer 9-slice pixel borders with 1px inner inset lines to achieve retro dialog box visuals.
3. **Counter-scaled overlays:** Floating elements inside scaled containers use inverse scaling (`calc(1 / scale)`) to keep particle effects and high-fidelity physics rendering at native display resolution.
4. **Sub-palette dithering:** Textures are quantised to four discrete tone steps using a Bayer 4x4 matrix, providing a retro aesthetic without heavy asset weights.

