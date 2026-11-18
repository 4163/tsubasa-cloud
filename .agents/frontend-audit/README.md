# Frontend audit annotator

Local review server for inspecting frontend UI screenshots, drawing numbered marquee regions, and exporting structured markdown feedback.

## Where screenshots live

By default, the server scans subdirectories inside `.agents/frontend-audit/`. Keep each view, component, or flow in its own subdirectory, and name image files with the breakpoint and optional dark suffix that the viewer toggles expect.

```text
.agents/frontend-audit/
  server.mjs
  README.md
  <SurfaceName>/
    <state>--desktop-16x9.png
    <state>--desktop-16x9--dark.png
    <state>--mobile.png
    <state>--mobile--dark.png
```

Standard capture viewports:

- `desktop-16x9`: `1366x768` (standard 16:9 desktop viewport, satisfies the `>= 1024px` desktop layout breakpoint)
- `mobile`: `390x844` (standard mobile viewport, satisfies the `< 768px` mobile layout breakpoint)

Only PNG files matching `*--desktop-16x9.png` or `*--mobile.png` appear by default when switching views, and `--dark` variants switch automatically when you toggle `Theme: Dark`. Files placed directly in the audit root are ignored because only subdirectories are scanned.

## Starting the server

Run the script with Node 22 or newer from the repository root.

```powershell
node .agents/frontend-audit/server.mjs
```

Open `http://localhost:4173` in a browser.

Pass `--dir` or `AUDIT_ROOT` to inspect screenshots stored in another folder, and pass `--port` or `PORT` to change the listening port.

```powershell
node .agents/frontend-audit/server.mjs --dir "D:\path\to\captures" --port 4180
```

The server binds to `127.0.0.1` and uses Node built-in modules only.

## Reviewing and annotating

1. Pick a screenshot from the left sidebar, or switch between `Breakpoint: desktop-16x9 (1366x768)`, `Breakpoint: mobile (390x844)`, `Theme: Light`, and `Theme: Dark` in the top bar.
2. Drag across the screenshot canvas to draw a marquee box. Drags smaller than 1.5% in width or height are ignored so accidental clicks do not create empty boxes.
3. Type feedback for each numbered box in the right panel, along with per-screen general notes or global notes that apply across the whole pass.
4. Click `Copy Markdown Summary` to copy the formatted report, coordinates, and note counts to the clipboard.

## Persistence and cleanup

Notes save automatically per screenshot and breakpoint (`--desktop-16x9` and `--mobile`) on input and marquee changes to `audit-notes.json` inside the active audit directory. Remove the generated screenshot subdirectories and `audit-notes.json` once an audit pass finishes.
