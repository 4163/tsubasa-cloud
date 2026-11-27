<p align="center">
  <img src="docs/banner-mono.png" alt="Tsubasa~ Cloud logo" />
</p>

# Tsubasa~ Cloud

<p>
  <img src="docs/svg-r44-readme.svg" alt="Tsubasa~ Cloud mark" align="left" width="67" />
  Tsubasa~ Cloud pools personal Google Drive accounts into one virtual drive backed by a local index. Files stay whole on single accounts without splitting or striping, and each pool mirrors its folder tree in Google Drive so accounts stay browsable on drive.google.com.
</p>

## Features

- **Pooled storage.** Combine personal Google Drive accounts into separate storage pools.
- **Synced folder structure.** Files in the same folder stay grouped on one account when space allows, and folder structure syncs between Tsubasa and Google Drive for parity.
- **File manager interface.** Standard workspace with expected file actions (file and folder uploads, downloads, rename, move, copy, trash) and fine-grained control over files, accounts, and pools.
- **Public sharing.** Share individual files or batches of files publicly by copying them into shareable folders on a dedicated read-only Share Pool.
- **External Drive changes and recovery.** Detect edits made directly on drive.google.com to accept them, move over-limit files to Drive root, or rebalance files across accounts. On a new machine, Tsubasa rebuilds your file list directly from your Google Drive accounts.
- **Desktop app, localhost web app, and CLI.** Run the Windows desktop app, open it in a browser on localhost, or use the `tsubasa` CLI for resumable transfers, Google Drive folder imports, and extensions.

> **14.25 GB direct upload limit.** Free Google Drive accounts have 15 GB of storage, and Tsubasa reserves 750 MB for Gmail and Google Photos.

> **750 GB daily upload tracking.** Google Drive caps uploads at 750 GB per account every 24 hours, and Tsubasa tracks usage against that limit.

## Setup

1. **Install or run Tsubasa.**
   - **Windows desktop app:** Run `Tsubasa~ Cloud Setup.exe` (NSIS installer) or extract the portable `.zip` and launch `Tsubasa~ Cloud.exe`.
   - **From source:** Requires [Node.js](https://nodejs.org/) with `npm`.
     ```bash
     npm install
     npm run dev        # API on http://localhost:28300, UI on http://localhost:28301
     ```
     Or build and serve the static bundle on `http://localhost:28300` with `npm run build && npm start`.
2. **Set up Google Drive OAuth.** In Google Cloud Console, enable the Google Drive API, create a **Desktop app** OAuth 2.0 Client ID (Web clients are rejected), and publish the consent screen to **In Production** so refresh tokens do not expire after 7 days. See [temp/](temp/) for the full walkthrough, screenshots, and details.
3. **Add Google accounts.** Use a Desktop OAuth JSON file, or a `.env` file with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Import it from the sidebar, place it in `.oauths/`, or run:
   ```bash
   npm run tsubasa -- auth add <credentials.json>
   ```
   Browser sign-in writes `<email>.tokens.json` to `.oauths/` and hydrates the account.

## CLI and extensions

The `tsubasa` CLI lets you manage pools, accounts, transfers, external Drive imports, and extensions from the terminal, whether the app is running or not.

```bash
npm run tsubasa -- status
npm run build:cli && npm link   # Install `tsubasa` globally on PATH
```

- CLI commands, flags, transfers, imports, and exit codes: [src/cli/README.md](src/cli/README.md)
- Subprocess extensions under `extensions/<name>/`: [extensions/README.md](extensions/README.md)

## Development

```bash
npm run dev          # API (:28300) + Vite UI (:28301) via dev:server and dev:web
npm run dev:electron # Build web, server, and Electron shell, then launch desktop app
npm run build        # Typecheck, build frontend, and compile server into dist/
npm start            # Serve compiled dist/ on :28300 in browser mode (no Vite/Electron)
npm run typecheck    # TypeScript check without emitting files
npm run package:win  # Build all targets (incl. CLI) and package NSIS + portable zip in release/
npm run sync:demo    # Build static demo bundle and mirror it into site/public/demo/
```

Architecture and styling docs: [docs/roadmap.md](docs/roadmap.md), [docs/styling-guide.md](docs/styling-guide.md), and [.agents/AGENTS.md](.agents/AGENTS.md). Static site and live demo: [tsubasa.moe.page](https://tsubasa.moe.page) ([site/README.md](https://github.com/4163/tsubasa-cloud/blob/site/README.md)).

## Data and OAuth locations

Each launch mode resolves one `<homeDir>` holding `.oauths/` and `data/tsubasa.db`:

| Launch mode | `<homeDir>` |
|---|---|
| **Windows NSIS installer** (release) | `%AppData%\Tsubasa~ Cloud\` |
| **Windows portable `.zip`** | Folder containing `Tsubasa~ Cloud.exe` |
| **CLI** (`tsubasa`, `npm run tsubasa`) | Package root from `import.meta.url` (never `process.cwd()`) |
| **Development** (`dev`, `dev:server`, `dev:electron`, `start`) | Repository root |
| **Override** (`TSUBASA_HOME` or CLI `--home <dir>`) | Resolved override path |

- Portable mode activates when `.portable`, `data/`, or `.oauths/` sits next to `Tsubasa~ Cloud.exe`, storing data there instead of `%AppData%\Tsubasa~ Cloud\`.

## Stack

| Layer | Technology | Role |
|---|---|---|
| **Frontend** | [React 19](https://react.dev) / [TypeScript](https://www.typescriptlang.org) | File explorer UI and client state |
| **Styling** | [StyleX](https://stylexjs.com) / [`unplugin-stylex`](https://github.com/eryue0220/unplugin-stylex) | Compile-time atomic CSS and light/dark tokens |
| **Virtualization** | [TanStack Virtual](https://tanstack.com/virtual) | Virtualized file table, drawers, and modal lists |
| **Build tool** | [Vite](https://vite.dev) | Dev server, HMR, `/api` proxy, frontend bundle |
| **Backend** | [Hono](https://hono.dev) / [`@hono/node-server`](https://github.com/honojs/node-server) | Local HTTP API, streaming proxy, typed RPC |
| **Database** | [SQLite](https://www.sqlite.org) / [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) / [Drizzle ORM](https://orm.drizzle.team) | WAL-mode catalog, transfer ledger, outbox, jobs |
| **Google Drive** | [`googleapis`](https://github.com/googleapis/google-api-nodejs-client) | OAuth 2.0 pool and Drive v3 API |
| **Desktop** | [Electron](https://www.electronjs.org) / [`electron-builder`](https://www.electron.build) | Windows shell, tray menu, NSIS installer, portable zip |
| **Runtime / CLI** | [Node.js](https://nodejs.org) / [`tsx`](https://tsx.is) / [`dotenv`](https://github.com/motdotla/dotenv) | Server/CLI runtime, TypeScript dev runner, `.env` loading |

## Project structure

```text
tsubasa-cloud/
├─ src/
│  ├─ client/             # React 19 + StyleX UI, virtualized table, Hono RPC client
│  ├─ electron/           # Electron main process, preload bridges, tray menu, server host
│  ├─ server/
│  │  ├─ db/              # SQLite WAL connection, Drizzle schema, runtime migrations
│  │  ├─ drive/           # OAuth pool, delta sync, outbox, transfers, sharing, discrepancies
│  │  ├─ routes/          # Hono API route modules
│  │  └─ storage/         # Headroom math, folder-cohesion placement, catalog export
│  └─ cli/                # tsubasa CLI commands, transport routing, extension runner
├─ site/ (orphan branch)  # Static homepage, data policy, and live demo (see site/README.md)
├─ scripts/               # Dev runner, static start wrapper, Windows packaging script
├─ build/                 # Desktop icons and NSIS installer include
├─ extensions/            # Extension contract docs and local subprocess extensions
├─ docs/                  # Roadmap, styling guide, UI teardowns, brand assets
├─ .oauths/               # OAuth client credentials and *.tokens.json (gitignored)
├─ data/                  # Local SQLite database and runtime state (gitignored)
└─ package.json
```

## Attributions

- Brand filter: [Vayce Comic Book Effect (Manga Ink)](https://vayce.app/tools/comic-book-effect/?profile=manga-ink&finish=0&str=0)
- Icons: [Lucide](https://lucide.dev) and [Material Icons](https://fonts.google.com/icons)
- Fonts: [Montserrat](https://fonts.google.com/specimen/Montserrat) and [Pixelify Sans](https://fonts.google.com/specimen/Pixelify+Sans)
- Subdomain: [moe.page](https://moe.page) ([moepage/subdomain](https://github.com/moepage/subdomain))

## License

Licensed under [GNU GPL-3.0](LICENSE).
