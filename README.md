# Tsubasa~ Cloud site

Static site for Tsubasa~ Cloud on the standalone orphan `site` branch, hosting the `/` homepage with an embedded interactive demo and `/data-policy`.

## Development

```bash
npm run dev        # Dev server from src/ with hot reload on http://localhost:28302
npm run build      # Static build to dist/
npm run preview    # Serve built dist/ bundle on http://localhost:28303
npm run typecheck  # TypeScript check without emitting files
```

- **Site URL (`VITE_SITE_ORIGIN`).** Defaults to `https://4163.github.io/tsubasa-cloud`. Builds use this URL to set the asset base path (`/tsubasa-cloud/`, or `/` for a root domain) and fill in canonical links in HTML, `robots.txt`, and `sitemap.xml`. Override it for a custom domain with `VITE_SITE_ORIGIN=https://example.com npm run build`.

## Demo bundle and sync

The homepage embeds the main React client compiled in demo mode. Run this from the `main` branch repository root with this branch mounted as a worktree at `site/`:

```bash
npm run sync:demo  # Build static demo bundle and mirror it into site/public/demo/
```

- **Build isolation.** `npm run sync:demo` compiles the main React app in demo mode into `dist/demo/` and mirrors it into `site/public/demo/`. Demo builds use relative asset paths and a separate `tsubasa-demo-theme-choice` storage key. Standard desktop and localhost builds (`npm run build:web`) strip all demo code out.
- **Static deployment.** Keep `public/demo/` committed on this branch so static hosts deploy the site without checking out `main`. Re-run `npm run sync:demo` from `main` whenever demo-visible client code changes.

## Architecture and contracts

- **Pages.** Two static pages: `/` (`HomePage`) and `/data-policy` (`DataPolicyPage`), wrapped in a shared `SiteLayout` with `SiteHeader`, `DitherCanvas`, and `RevealingFooter`.
- **Demo frame and grain exclusion.** `DemoWindow` embeds `public/demo/index.html` in a `1280x720` frame (`540px` tall on mobile at `<= 768px`). It masks the host page's grain layer (`.grain-masked-none`) so the self-grained demo iframe does not double-grain while staying below `SiteHeader`.
- **Cross-frame theme sync.** The site saves its theme under `tsubasa-site-theme`, and the demo saves its own choice under `tsubasa-demo-theme-choice` so its theme toggle works independently. Toggling the site header theme sends a same-origin `tsubasa:site-theme-sync` `postMessage` to the iframe, which applies and saves it unless the demo already matches.
- **Client-only demo runtime.** Demo builds run without a backend server. `createDemoFetch()` intercepts Hono RPC calls in-browser with zero network requests and stores metadata-only state in IndexedDB (`tsubasa-demo-v1`), never saving real file bytes. `DemoWorkspaceBackdrop` fills the frame while the demo loads, initializes IndexedDB, or resets.

## Project structure

```text
tsubasa-site/
├─ index.html                # `/` entry HTML with pre-paint theme script and metadata
├─ data-policy/index.html    # `/data-policy` entry HTML
├─ vite.config.ts            # MPA config, VITE_SITE_ORIGIN substitution, clean route rewrite
├─ src/
│  ├─ entries/               # Page mount scripts (home.tsx, data-policy.tsx)
│  ├─ pages/                 # HomePage.tsx and DataPolicyPage.tsx
│  ├─ components/            # SiteLayout, SiteHeader, DemoWindow, DitherCanvas, BrandMark, RevealingFooter
│  ├─ theme.ts               # ThemeProvider, View Transitions toggle, toggle pub-sub
│  ├─ tokens.stylex.ts       # Light and dark StyleX tokens
│  ├─ url.ts                 # siteUrl() helper honoring import.meta.env.BASE_URL
│  └─ global.css             # Fonts, grain overlay, grain-masked rules, reduced-motion
└─ public/
   ├─ assets/                # Banner images and SVG brand mark
   ├─ fonts/                 # Self-hosted Montserrat and Pixelify Sans woff2
   ├─ demo/                  # Synced static demo bundle (committed on this branch)
   ├─ robots.txt             # Template rewritten with VITE_SITE_ORIGIN on build
   └─ sitemap.xml            # Template rewritten with VITE_SITE_ORIGIN on build
```
