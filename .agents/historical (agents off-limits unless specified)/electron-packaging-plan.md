# Phase 7: Electron desktop packaging plan

Design and implementation plan for wrapping Tsubasa~ Cloud in an Electron desktop shell and producing Windows installers and portable builds.

## Goals and scope

- Wrap the existing Hono backend and compiled Vite frontend in a Windows Electron desktop app without duplicating storage, sync, or placement logic.
- Implement native window ergonomics: hidden-until-ready reveal, theme-matched native shell background, native Windows light/dark title bar, dynamic ` ◦ ` title bar naming, single-instance focus restoration, and system tray lifecycle.
- Enforce single-instance Electron priority over browser tabs using the existing `/api/instance/*` lease routes.
- Ship both an NSIS installer (`oneClick: false`) and an unpacked portable `.zip` archive via `electron-builder`, with safe user data path resolution across dev, installed, and portable runs.
- Explicitly skip upload progress in the title bar, taskbar, and tray tooltip as YAGNI.

## Locked decisions

### 1. Dynamic title bar naming

Titles use most-specific-first order with the ` ◦ ` (U+25E6) separator. Search queries and upload percentages are omitted (YAGNI, avoids live-typing churn and privacy leaks into OS window titles or Alt+Tab):

| Workspace state | Window title |
| :--- | :--- |
| Pool root (`/`) | `<Pool Name> ◦ Tsubasa~ Cloud` |
| Subfolder (`/Projects/2026`) | `2026 ◦ <Pool Name> ◦ Tsubasa~ Cloud` |
| Trash view | `Trash ◦ <Pool Name> ◦ Tsubasa~ Cloud` |
| Share Pool root | `Share Pool ◦ Tsubasa~ Cloud` |
| Share Pool subfolder | `<Batch Folder> ◦ Share Pool ◦ Tsubasa~ Cloud` |
| Pre-mount / checking / blocked gate | `Tsubasa~ Cloud` |

The same formatting helper updates `document.title` in regular browsers and sends deduplicated updates to Electron over IPC so browser tabs and the desktop window stay consistent.

### 2. Native title bar theme and shell background

- **Title bar light and dark mode.** Electron sets `nativeTheme.themeSource` to `'system' | 'light' | 'dark'`, mapped from Tsubasa's 3-way theme choice (`'auto' | 'light' | 'dark'`). This controls Windows DWM dark/light title bar rendering natively without custom frameless chrome.
- **Startup pre-paint persistence.** Electron persists the last chosen theme (`'auto' | 'light' | 'dark'`) in a small `desktop-prefs.json` file under the resolved Tsubasa data directory. On launch, the main process reads this file before calling `new BrowserWindow(...)`, sets `nativeTheme.themeSource`, and resolves the matching canvas background color:
  - Light canvas: `#eef2ec`
  - Dark canvas: `#0b1412`
- **Runtime sync.** When the user switches themes in the UI, `useThemeChoice` sends the choice over IPC so the main process updates `nativeTheme.themeSource`, persists `desktop-prefs.json`, and calls `mainWindow.setBackgroundColor(...)`. When `themeChoice === 'auto'`, a `nativeTheme.on('updated')` listener updates the native shell background automatically on OS theme switches.
- **Hidden-until-ready reveal.** `BrowserWindow` starts with `show: false`. It reveals on `ready-to-show` (with a 2500 ms fallback timer so startup never stalls hidden) and uses logical size defaults (`width: 1280`, `height: 800`, `minWidth: 640`, `minHeight: 480`).

### 3. System tray and window close behavior

- **Always-active tray icon.** Created on app startup using `build/icon.ico` (generated from `docs/svg-r44-app.svg`) with static tooltip `Tsubasa~ Cloud`.
- **Close hides to tray.** Clicking the window close button (`X`) prevents default termination and hides `mainWindow` to the system tray instead, keeping the background Hono server, outbox worker, and active transfers alive.
- **Tray interactions:**
  - Left-click (or `Show Tsubasa~ Cloud` menu item): shows, unminimizes, and focuses `mainWindow`.
  - Right-click: opens the custom frameless tray popup (`src/electron/trayMenu.ts` and `src/electron/trayPreload.ts`) with `Show Tsubasa~ Cloud`, `Start with Windows`, separator, and `Quit`.
- **Clean quit.** Selecting `Quit` from the tray menu (or triggering `app.quit()` / OS shutdown) sets `isQuitting = true`, destroys the tray popup, closes the window, stops the embedded Hono server, closes SQLite, and releases `data/tsubasa.writer.lock`.

### 4. Single-instance and Electron priority

- **Desktop single instance.** `app.requestSingleInstanceLock()` runs at startup before creating the server or window. A second Electron launch exits immediately; the primary instance receives `second-instance` and restores/focuses `mainWindow` (including from tray).
- **Browser tab blocking.**
  - `src/server/routes/instance.ts` already supports `ownerKind: 'electron'` overriding `'browser'` leases and returning HTTP `409` with `{ ownerKind: 'electron' }` to browser tabs.
  - `src/client/utils/useTabLock.ts` reads `window.tsubasaDesktop?.isElectron` to claim and heartbeat with `ownerKind: 'electron'`.
  - Any external browser tab opened against the same backend receives HTTP `409` before mounting `<App />` and renders `TabBlockedModal` with the existing Electron-owner copy.

### 5. Embedded Hono server, ports, and native `better-sqlite3`

- **Private localhost HTTP origin.** Instead of `file://` (which breaks relative `/api/...` Hono RPC paths, `history.replaceState`, and storage isolation), the Electron app loads its workspace over `http://127.0.0.1:<port>/`.
- **Static asset serving.** When running in packaged mode (or when `TSUBASA_SERVE_STATIC=1`), the Hono app serves the compiled Vite frontend from `dist/` and falls back to `dist/index.html` for non-`/api` GET routes.
- **Port selection and CLI interop:**
  - Default ports live in `src/server/ports.ts`: `28300` for the Hono backend, `28301` for the Vite dev server, and `28302` for the frontend audit annotator.
  - Electron probes the bound `port` recorded in `data/tsubasa.writer.lock` and `http://127.0.0.1:${PORT || 28300}/api/health` first.
  - If a live Tsubasa backend with matching `dbFingerprint` is already running (for example `npm run dev:server` during development), Electron attaches to it instead of colliding on `data/tsubasa.writer.lock`.
  - Otherwise, Electron starts its own Hono server bound to `127.0.0.1`: trying port `28300` (or `PORT`) first, and falling back to an OS-assigned ephemeral port (`0`) if `28300` is occupied by an unrelated process. Once bound, the server writes its active `port` and `hostname` into `data/tsubasa.writer.lock` so the `tsubasa` CLI and Electron auto-discover it even after an ephemeral fallback.
- **OAuth copy-link flow and external links.**
  - The UI does not open OAuth popups directly; `SidebarAccountCard` displays the generated authorize URL with a `Copy` button so the user can paste it into whichever browser profile owns that Google account.
  - `GET /api/accounts/auth-url/:id` defaults `redirect_uri` to `${requestOrigin}/api/auth/callback` when omitted, so the copied URL still lands on the active Hono server even if Electron binds an ephemeral port instead of `28300`.
  - `GET /api/auth/callback` redirects to the server's own origin when serving static `dist/` assets (avoiding a dead `localhost:28301` redirect in packaged mode), so the user's browser tab renders `TabBlockedModal` with the existing "Account linked" message, and notifies the Electron main process in-process so the desktop window refreshes accounts immediately (bridging the `BroadcastChannel` boundary between external browser and Electron).
  - `mainWindow.webContents.setWindowOpenHandler` denies secondary Electron windows: external-origin links (such as Share Pool Drive links) open via `shell.openExternal`, while same-origin `/api/files/.../download` requests return `{ action: 'deny' }` without opening an external browser so `handleDownload` falls through to its `<a download>` path and uses Electron's native download flow.
- **Native module ABI (`better-sqlite3`).**
  - In **packaged builds**, `electron-builder` rebuilds `better-sqlite3` against Electron's Node ABI (`npmRebuild: true`), and the Hono server runs in Electron's Node runtime (in-process or via `utilityProcess`) with zero system Node.js dependency.
  - In **local development**, `npm run dev:electron` can either attach to `npm run dev:server` (running on system Node) or spawn the backend child with system Node so `npm run dev:server`, `tsubasa` CLI, and Electron all coexist without repeatedly rebuilding `better-sqlite3` in `node_modules/`.

### 6. Data home resolution (dev, installed, portable)

Electron resolves `TSUBASA_HOME` before starting or probing the server using this precedence:

1. Explicit `TSUBASA_HOME` environment variable, if set.
2. Development mode (`!app.isPackaged`): repository root (`process.cwd()` / package root), matching `src/server/paths.ts` and the `tsubasa` CLI.
3. Packaged portable mode: if a `.portable` marker file (bundled at the root of the portable `.zip` by `scripts/package-win.mjs`, and omitted from `release/win-unpacked/` and NSIS) or an existing `data/` or `.oauths/` directory sits next to the executable (`path.dirname(process.execPath)`), use the executable directory.
4. Packaged installed default: Electron's `app.getPath('userData')` (`%AppData%\Tsubasa~ Cloud\`), which stays writable under `Program Files` and survives NSIS upgrades.

### 7. Windows packaging targets (`electron-builder`)

- **Targets:**
  - `nsis` (`oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`, Start Menu and optional Desktop shortcut, clean uninstaller with `build/installer.nsh` startup registry cleanup).
  - `zip` (unpacked Windows directory archive for portable/manual/Scoop users; `scripts/package-win.mjs` injects a root `.portable` marker into the `.zip` archive without modifying `release/win-unpacked/` or the NSIS installer).
- **Artifacts included in package:**
  - `dist/` (compiled Vite client, compiled Hono server, compiled Electron main/preload, and optionally compiled CLI).
  - `build/icon.ico` and `build/icon.png` (generated from `docs/svg-r44-app.svg`) for the installer, desktop window, and system tray.
  - Production `node_modules` (including Electron-rebuilt `better-sqlite3`).
- **Excluded from package:** `.oauths/`, `data/`, `docs/`, `.agents/`, `src/`, `extensions/` user data, dev dependencies.

## Planned file layout

Keep existing `src/client/`, `src/server/`, and `src/cli/` organization intact and add a dedicated `src/electron/` owner:

- `src/electron/main.ts`: Electron app bootstrap, single-instance lock, `TSUBASA_HOME` resolution, theme/prefs persistence, embedded Hono server lifecycle, `BrowserWindow` setup, tray icon, `--autostart` silent boot, external URL routing, and graceful shutdown.
- `src/electron/preload.ts`: Minimal `contextBridge` exposing `window.tsubasaDesktop`:
  - `isElectron: true`
  - `setTitle(title: string): void`
  - `setThemeChoice(choice: 'auto' | 'light' | 'dark'): void`
  - `onAuthCompleted(cb: (payload: AuthCompletedPayload) => void): () => void`
- `src/electron/trayMenu.ts`: Custom frameless tray popup `BrowserWindow`, native Windows layout and theme styling, `display.bounds` anchoring with Windows 11 overflow cursor fallback, keyboard navigation, and debounced dismissal.
- `src/electron/trayPreload.ts`: Sandboxed `contextBridge` preload exposing `window.tsubasaTrayMenu` (`onState`, `invokeAction`, `dismiss`).
- `src/electron/paths.ts`: Dev, portable, and installed `TSUBASA_HOME` resolution plus `desktop-prefs.json` read and write helpers.
- `src/electron/serverHost.ts`: Embedded Hono server startup, port selection (`28300` via `src/server/ports.ts`, then ephemeral `0`), lockfile and `/api/health` attachment probe, static `dist/` wiring, and clean shutdown.
- `src/server/ports.ts`: Shared default port constants (`28300`, `28301`, `28302`) and port parsing helpers used across server, Electron, CLI, and Vite.
- `tsconfig.electron.json`: TypeScript config compiling `src/electron/` to `dist/electron/`, paired with `tsconfig.electron.preload.json` for CommonJS preload bundles (`preload.cjs` and `trayPreload.cjs`).
- `electron-builder.yml`: Windows `nsis` and `zip` packaging config, icons, and `asarUnpack` for `better-sqlite3` native `.node` binaries.

### Targeted edits to existing files

- `src/server/app.ts`: Add optional static frontend serving (`staticDir` option) and an optional `onAuthCompleted` hook to notify Electron when OAuth completes in an external browser.
- `src/server/index.ts`: Export a reusable `startTsubasaServer(options)` helper so Electron can start and stop the server cleanly without duplicating writer-lock, DB init, or shutdown logic.
- `src/server/routes/accounts.ts`: Default `redirect_uri` in `/api/accounts/auth-url/:id` from the request origin and redirect `/api/auth/callback` to the server's own origin when serving static UI.
- `src/client/vite-env.d.ts`: Add type declarations for `window.tsubasaDesktop`.
- `src/client/utils/useTabLock.ts`: Use `ownerKind: 'electron'` when `window.tsubasaDesktop?.isElectron` is true, and subscribe to Electron IPC `onAuthCompleted` notifications alongside `BroadcastChannel`.
- `src/client/hooks/useResolvedTheme.ts`: Sync theme choice to `window.tsubasaDesktop?.setThemeChoice(...)`.
- `src/client/utils/windowTitle.ts`: Pure helper building the ` ◦ ` title string, wired from `src/client/App.tsx` with fallback titles in `main.tsx` and `TabBlockedModal.tsx`.
- `package.json`: Add Electron dev, build, and package scripts (`dev:electron`, `build:electron`, `package:win`) plus `electron` and `electron-builder` devDependencies.

## Execution slices

1. **Slice 1: Server embeddability and OAuth loopback polish.** Refactor server startup into a reusable start/stop handle, add optional static `dist/` serving in `createApp`, and ensure `/api/accounts/auth-url/:id` and `/api/auth/callback` honor dynamic loopback origins and emit auth completion hooks.
2. **Slice 2: Electron main, preload, theme, and title bar.** Install `electron` and `electron-builder`, create `src/electron/*` and `tsconfig.electron.json`, implement single-instance lock, hidden-until-ready reveal, persisted native theme + shell background color, always-on tray with close-to-tray, and `shell.openExternal` link handling.
3. **Slice 3: Renderer bridge integration.** Wire `useTabLock` (`ownerKind: 'electron'` + IPC auth completion), `useThemeChoice` native theme sync, and the ` ◦ ` dynamic window title helper.
4. **Slice 4: Windows packaging (`nsis` + `zip`).** Configure `electron-builder.yml` with icons, `asarUnpack` for `better-sqlite3`, and `package:win` scripts; build and manually verify both the unpacked portable directory and the NSIS installer.

## Manual verification checklist

- Launch Electron in dev mode (`npm run dev:electron`): confirm no white/black flash before reveal, native Windows title bar matches light/dark/auto theme, and `setBackgroundColor` updates on theme toggle.
- Navigate pools, subfolders, Trash, and Share Pool: verify ` ◦ ` title bar updates and stays clean when typing in search.
- Close window with `X`: verify app hides to tray, left-click restores it, and `Quit` in tray menu exits cleanly and removes `data/tsubasa.writer.lock`.
- Launch a second Electron instance while running (visible or in tray): verify second process exits and primary window restores and focuses.
- Open `http://localhost:<port>` in a browser while Electron is running: verify `TabBlockedModal` blocks the tab with Electron-owner messaging; open a browser tab first, then launch Electron, and verify Electron supersedes the browser tab on next heartbeat.
- Run `npm run package:win`: verify `electron-builder` produces both the NSIS `Setup.exe` and the `.zip` archive, verify packaged app launches standalone without dev servers, verify `%AppData%\Tsubasa~ Cloud\` default home and `.portable` adjacent-folder override, and confirm `npm run typecheck` and `npm run build` pass.

## Follow-up slices

- [x] **1. Custom tray menu and Start with Windows toggle.**
  - Replaced Electron's native Win32 tray context menu with a compact `188x77` frameless popup `BrowserWindow` (`src/electron/trayMenu.ts`, `src/electron/trayPreload.ts`) using `thickFrame: false`, `hasShadow: false`, hairline `1px` border, native `12px` `'Segoe UI'` ClearType text, uniform light/dark sage-mint surface with paper grain overlay, `28px` left gutter with a plain `✓` check character and indented separator, and instant hover with a `1.5px` left gold accent bar.
  - Anchors bottom-left at the tray icon center over `display.bounds`, falls back to `screen.getCursorScreenPoint()` for Windows 11 overflow tray icons, layers above the taskbar via `'screen-saver'` always-on-top, and dismisses cleanly on debounced `blur` and `Escape`.
  - Added the `Start with Windows` toggle (disabled in dev when `!app.isPackaged`, active in packaged NSIS and portable builds). Registers with `--autostart` for silent tray boot, reads live `app.getLoginItemSettings` state, and removes `com.tsubasa.cloud` from both `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` and `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run` via `!macro customUnInstall` in `build/installer.nsh`.
- [x] **2. Dedicated port block and lockfile port discovery.**
  - Centralized default ports `28300` (Hono API), `28301` (Vite dev UI), and `28302` (frontend audit annotator) in `src/server/ports.ts` and updated server, Electron, CLI, Vite, and audit callers.
  - Persisted the bound `port` and `hostname` in `data/tsubasa.writer.lock` so the `tsubasa` CLI and Electron auto-discover an active backend even after an ephemeral port fallback.
- [x] **3. One-command localhost runners.**
  - Added zero-dependency `scripts/dev.mjs` wired to `npm run dev` to run `dev:server` and `dev:web` together in one terminal and stop both on `Ctrl+C`.
  - Added `scripts/start.mjs` wired to `npm start` to serve the compiled `dist/` bundle through Hono with `TSUBASA_SERVE_STATIC=1` and graceful IPC shutdown on Windows.
- [x] **4. Sidebar version badge.**
  - Injected `package.json`'s `version` at build time via Vite `define` (`__APP_VERSION__`) in `vite.config.ts` and `src/client/vite-env.d.ts`, and rendered a compact `v<version>` badge in `Pixelify Sans` inside `Sidebar.tsx`'s `brandHeader`.
- [x] **5. Portable `.zip` marker out of the box.**
  - Updated `scripts/package-win.mjs` to inject a root `.portable` marker file into the packaged `.zip` archive without modifying `release/win-unpacked/` or the NSIS installer.
- [x] **6. Document data and OAuth locations in `README.md`.**
  - Added the launch-mode table in `README.md` covering `<homeDir>`, `.oauths/`, and `data/tsubasa.db` across dev, CLI, NSIS, portable `.zip`, and `TSUBASA_HOME` override, and updated CLI transport docs in `src/cli/README.md`.
