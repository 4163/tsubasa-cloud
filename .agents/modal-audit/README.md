# Marquee audit annotator

Local review server for inspecting modal and drawer screenshots, drawing numbered marquee regions, and exporting structured markdown feedback.

## Where screenshots live

By default, the server scans subdirectories inside `.agents/modal-audit/`. Keep each component or flow in its own subdirectory, and name image files with the breakpoint and optional dark suffix that the viewer toggles expect.

```text
.agents/modal-audit/
  server.mjs
  README.md
  <ComponentName>/
    <state>--desktop-16x9.png
    <state>--desktop-16x9--dark.png
    <state>--mobile.png
    <state>--mobile--dark.png
```

Only PNG files matching `*--desktop-16x9.png` or `*--mobile.png` appear by default when switching views, though `--dark` variants switch automatically when you toggle `Theme: Dark`. Any files placed directly in the audit root are ignored because only subdirectories are scanned.

## Starting the server

Run the script with Node 22 or newer from the repository root.

```powershell
node .agents/modal-audit/server.mjs
```

Open `http://localhost:4173` in a browser.

Pass `--dir` or `AUDIT_ROOT` to inspect screenshots stored in another folder, and pass `--port` or `PORT` to change the listening port.

```powershell
node .agents/modal-audit/server.mjs --dir "D:\path\to\captures" --port 4180
```

The server binds to `127.0.0.1` and uses Node built-in modules only.

## Reviewing and annotating

1. Pick a screenshot from the left sidebar, or switch between `Breakpoint: desktop-16x9`, `Breakpoint: mobile`, `Theme: Light`, and `Theme: Dark` in the top bar.
2. Drag across the screenshot canvas to draw a marquee box. Drags smaller than 1.5% in width or height are ignored so accidental clicks do not create empty boxes.
3. Type feedback for each numbered box in the right panel, along with per-screen general notes or global notes that apply across the whole pass.
4. Click `Copy Markdown Summary` to copy the formatted report, coordinates, and note counts to the clipboard.

## Persistence and cleanup

Notes save automatically on input and marquee changes to `audit-notes.json` inside the active audit directory. Remove the generated screenshot subdirectories and `audit-notes.json` once an audit pass finishes.
