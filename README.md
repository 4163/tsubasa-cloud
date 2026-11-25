<p align="center">
  <img src="docs/banner-mono.png" alt="Tsubasa~ Cloud logo" />
</p>

# Tsubasa~ Cloud

<p>
  <img src="docs/svg-r44-readme.svg" alt="Tsubasa~ Cloud mark" align="left" width="67" />
  Tsubasa~ Cloud pools multiple personal Google Drive accounts into one virtual drive backed by a local SQLite index. Files stay intact on single accounts without splitting or striping, and each pool mirrors its folder hierarchy inside Google Drive so accounts remain browsable on drive.google.com.
</p>

## How it works

- **Local SQLite index.** Navigation, directory listings, and searches query a local SQLite database (`data/tsubasa.db`) in WAL mode instead of hitting the Google Drive API.
- **Folder-cohesion placement.** Files stay whole up to a 14.25 GB single-file ceiling, and Tsubasa reserves 750 MB per account so Gmail and Google Photos do not hit storage limits. Single-file uploads prefer the account holding sibling files in the parent folder and fall back to best-fit allocation. Folder uploads size branches bottom-up, check folder affinity, and fall back to best-fit per branch. Directories mirror inside each account's `_Tsubasa~ Pool <N>` folder, or `_Tsubasa~ Pool share` for the Share Pool.
- **Streaming transfers.** Downloads proxy through Hono as Web Streams with HTTP `Range` support. Uploads stream directly to Google Drive without buffering whole files to disk, using a verified single-shot path up to 5 MiB and resumable uploads above that. A rolling 24-hour `transfer_logs` table tracks Google's 750 GB daily per-account upload cap.
- **Outbox and delta sync.** Virtual renames, moves, and soft-trashes commit to SQLite first, then `drive_outbox` pushes remote Drive updates and `appProperties` (`tsubasa_managed`, `tsubasa_virtual_path`, `tsubasa_virtual_id`, `tsubasa_checksum`) in the background. Incremental refreshes use `drive.changes.list` page tokens, and cold recovery rebuilds `data/tsubasa.db` from Drive metadata.
- **Pools, sharing, and discrepancy handling.** Accounts group into isolated pools. Sharing copies selected files into public Drive batch folders on a read-only Share Pool. Discrepancy scans catch edits made directly on drive.google.com so you can accept them, eject them to Drive root, or rebalance across accounts.

## Setup

Requires [Node.js](https://nodejs.org/) with `npm`.

1. **Create a Desktop OAuth client.** In Google Cloud Console, enable the Google Drive API and create an OAuth 2.0 Client ID with Application Type set to **Desktop app**. Tsubasa uses loopback redirects and rejects Web application clients. One Desktop client ID authorizes multiple pooled Google accounts.
2. **Publish the consent screen.** Switch the OAuth consent screen publishing status from **Testing** to **In Production**. Testing mode expires refresh tokens after 7 days regardless of API activity. Unverified apps in Production allow up to 100 unique authorized accounts over the project lifetime, which covers personal pools without formal Google verification. Production refresh tokens stay valid as long as each account refreshes at least once every 6 months; routine syncs such as `tsubasa sync delta` or Drive quota refreshes reset that clock, so periodic dummy uploads are unnecessary. Re-authorize any account whose token was issued while the app was still in Testing.
3. **Install dependencies and start the app.**
   ```bash
   npm install
   npm run dev          # Hono API on http://localhost:28300 and Vite UI on http://localhost:28301
   ```
   Press `Ctrl+C` to stop both servers, or run `npm run dev:server` and `npm run dev:web` in separate terminals. To serve the compiled `dist/` bundle directly through Hono on `http://localhost:28300`, run `npm run build` followed by `npm start`.
4. **Add Google accounts.** Prepare a Desktop OAuth JSON file, or a `.env` file defining `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Import it from the web UI sidebar, copy it into `.oauths/`, or run:
   ```bash
   npm run tsubasa -- auth add <credentials.json>
   ```
   Completing browser sign-in writes `<email>.tokens.json` in `.oauths/` and hydrates the account into the pool.

## CLI and extensions

The `tsubasa` CLI shares the server's SQLite index, placement rules, and Drive engine. It checks `data/tsubasa.writer.lock` for the server's bound port alongside `127.0.0.1:${PORT:-28300}`, probes `GET /api/health`, and routes over HTTP when a running server matches the local `dbFingerprint`. Without a matching server, it runs standalone under `data/tsubasa.writer.lock`.

```bash
npm run tsubasa -- status
npm run build:cli && npm link   # Install `tsubasa` globally on PATH
```

- CLI commands, flags, exit codes, and external Drive imports: [src/cli/README.md](src/cli/README.md)
- Subprocess extensions under `extensions/<name>/`: [extensions/README.md](extensions/README.md)

## Data and OAuth locations

Tsubasa resolves a single home directory (`<homeDir>`) per launch mode and stores OAuth credentials under `.oauths/` and runtime state under `data/`.

| Launch mode | `<homeDir>` | `.oauths/` | SQLite database |
|---|---|---|---|
| **Development** (`npm run dev`, `dev:server`, `dev:electron`) | Repository root | `<repo>/.oauths/` | `<repo>/data/tsubasa.db` |
| **CLI** (`tsubasa`, `npm run tsubasa`) | Package root resolved from `import.meta.url`, never `process.cwd()` | `<packageRoot>/.oauths/` | `<packageRoot>/data/tsubasa.db` |
| **Windows NSIS installer** (`Tsubasa~ Cloud Setup.exe`) | `%AppData%\Tsubasa~ Cloud\` | `%AppData%\Tsubasa~ Cloud\.oauths\` | `%AppData%\Tsubasa~ Cloud\data\tsubasa.db` |
| **Windows portable `.zip`** | Directory containing `Tsubasa~ Cloud.exe` | `<exeDir>\.oauths\` | `<exeDir>\data\tsubasa.db` |
| **`TSUBASA_HOME` override** (any mode) | Resolved `TSUBASA_HOME` path | `<TSUBASA_HOME>/.oauths/` | `<TSUBASA_HOME>/data/tsubasa.db` |

Portable mode activates automatically when a `.portable` marker file sits next to `Tsubasa~ Cloud.exe`, which the portable zip bundles by default, or when an adjacent `data/` or `.oauths/` folder already exists. For the CLI, `--home <dir>` overrides the package root in the same way as `TSUBASA_HOME`. Alongside `tsubasa.db`, the `data/` directory holds `tsubasa.writer.lock`, which records the active server's bound port and writer lock state, and `desktop-prefs.json` for Electron theme preferences.

## Development

```bash
npm run dev          # Start Hono API (:28300) and Vite UI (:28301) together; Ctrl+C stops both
npm run dev:server   # Start Hono backend with watch reload (PORT defaults to 28300)
npm run dev:web      # Start Vite dev server on port 28301 (proxies /api to :28300)
npm run dev:electron # Build web, server, and Electron shell, then launch desktop app
npm start            # Serve compiled dist/ bundle through Hono on :28300 (TSUBASA_SERVE_STATIC=1)
npm run typecheck    # Run TypeScript check
npm run build        # Typecheck, build frontend, and compile server
npm run build:cli    # Compile the CLI to dist/cli/index.js
npm run package:win  # Package Windows NSIS installer and portable zip into release/
```

Architecture notes and styling rules live in [docs/roadmap.md](docs/roadmap.md), [docs/styling-guide.md](docs/styling-guide.md), and [.agents/AGENTS.md](.agents/AGENTS.md).

## Stack

| Component | Technology | Purpose |
|---|---|---|
| **Frontend** | [React 19](https://react.dev) / [TypeScript](https://www.typescriptlang.org) | File explorer UI and client state |
| **Styling** | [StyleX](https://stylexjs.com) / [`unplugin-stylex`](https://github.com/eryue0220/unplugin-stylex) | Compile-time atomic CSS and light/dark theme tokens |
| **Virtualization** | [TanStack Virtual](https://tanstack.com/virtual) | Fixed-row virtualized file table rendering |
| **Build tool** | [Vite](https://vite.dev) | Dev server, HMR, `/api` proxy, and frontend bundle |
| **Backend** | [Hono](https://hono.dev) / [`@hono/node-server`](https://github.com/honojs/node-server) | Local HTTP API, streaming proxy, and typed RPC |
| **Database** | [SQLite](https://www.sqlite.org) / [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) / [Drizzle ORM](https://orm.drizzle.team) | WAL-mode catalog, transfer ledger, outbox, and job state |
| **Google Drive** | [`googleapis`](https://github.com/googleapis/google-api-nodejs-client) | OAuth 2.0 client pool and Drive v3 API |
| **Desktop** | [Electron](https://www.electronjs.org) / [`electron-builder`](https://www.electron.build) | Windows desktop shell, tray lifecycle, NSIS installer, and portable zip |
| **CLI and runtime** | [Node.js](https://nodejs.org) / [`tsx`](https://tsx.is) / [`dotenv`](https://github.com/motdotla/dotenv) | Server execution, TypeScript CLI runner, and `.env` loading |

## Project structure

```text
tsubasa-cloud/
├─ src/
│  ├─ client/      # React 19 + StyleX UI, virtualized table, Hono RPC client
│  ├─ electron/    # Electron main process, preload bridge, tray, and server host
│  ├─ server/
│  │  ├─ db/       # SQLite WAL connection, Drizzle schema, runtime migrations
│  │  ├─ drive/    # OAuth pool, delta sync, outbox, streaming transfers, sharing
│  │  ├─ routes/   # Hono API routes
│  │  └─ storage/  # Headroom math, folder-cohesion placement, catalog export
│  └─ cli/         # `tsubasa` CLI commands, transport routing, extension runner
├─ build/          # Desktop icons and NSIS installer include
├─ extensions/     # Extension contract docs and local subprocess extensions
├─ docs/           # Roadmap, styling guide, UI teardowns, brand assets
├─ .oauths/        # OAuth client credentials and *.tokens.json (gitignored)
├─ data/           # Local SQLite database (tsubasa.db) and writer lock (gitignored)
└─ package.json
```

## Attributions

- Brand filter: [Vayce Comic Book Effect (Manga Ink)](https://vayce.app/tools/comic-book-effect/?profile=manga-ink&finish=0&str=0)
- Fonts: [Montserrat](https://fonts.google.com/specimen/Montserrat) and [Pixelify Sans](https://fonts.google.com/specimen/Pixelify+Sans)

## License

Licensed under [GNU GPL-3.0](LICENSE).
