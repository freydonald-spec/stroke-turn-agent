# DQSync Agent — CLAUDE.md

Electron desktop app (Windows) that watches a swim-meet timing file and pushes the
current event/heat to Firestore so all DQSync judge/role pages update live. It also
creates meets, manages credentials, and exports DQ reports — replacing the web-app
setup flow for meet hosts.

## Architecture

Plain JavaScript Electron app — **no TypeScript, no bundler, no test runner.** Three
source files do the work:

- `src/main.js` — main process. Firebase (JS SDK, anonymous auth), the chokidar file
  watcher, the heartbeat, the auto-updater, and **every `ipcMain.handle(...)`**. All
  Firestore reads/writes live here or in `wizard.js`.
- `src/preload.js` — the `contextBridge` allowlist. Every renderer→main call must be
  exposed here as `window.agent.<method>`. contextIsolation is on, nodeIntegration off,
  so the renderer cannot `require()` anything.
- `src/index.html` — the entire renderer: CSS + markup + one inline `<script>`. UI is
  a single window with show/hide **view state** (no extra windows).
- `src/wizard.js` — pure-ish module for the New Meet wizard: parsing the two Meet
  Maestro exports, generating PINs/coach words, and all the Firestore writes for
  creating a meet / re-importing events+heats. Required by `main.js`.
- `src/simulator.js` — writes a fake `timing_system_configuration.json` so the
  watch→push pipeline can be exercised without timing hardware.

Data flow: timing file changes → chokidar (`startWatcher`) → `pushUpdate` writes
`currentEvent`/`currentHeat`/`currentStroke` to `meets/{meetId}`. A 30s heartbeat
stamps `agentLastSeen`/`agentStatus` so the web monitor can tell the agent is alive.

### The three UI screens (renderer)

`showScreen('launch'|'main'|'admin')` toggles `.screen.active`. Overlays (`#wizard`
z-50, `#qr-overlay` z-80, `#update-overlay` z-100) are `position:fixed` on top.

- **Launch** — 4 PIN digit boxes → `connectByPin`; "Set up new meet" → wizard.
- **Main** — connected card (meet name, tappable PIN/Admin/Coach pills → per-role QR
  overlay, LOCKED badge, sim banner), "Now swimming" heat card, Admin button,
  collapsible Activity log (last 20 in memory, newest first, color-coded dots).
- **Admin** — meet info + codeset toggles; Actions: Lock meet, Export DQs, Update meet
  file, Change timing file, Disconnect; Developer tools: Simulator (with warning).

## Firestore — same project as the web app (`stroke-and-turn`)

This agent writes to the **same** Firestore as the `~/stroke-and-turn` Next.js app.
Document shapes MUST stay byte-compatible so existing role pages keep working. When
touching meet/event/heat/DQ shapes, read the web app first — the source of truth:

- Meet doc + PIN/adminPin/coachWord → `app/referee/create/page.tsx`, `lib/coachWord.ts`,
  `lib/adminPin.ts`
- Events/heats import + parse → `app/referee/import/page.tsx`
- `config/activeMeet` → `lib/setActiveMeet.ts`
- DQ report export format → `app/scorekeeper/page.tsx` (`exportPlainText`); helpers
  (`shortEventLabel`, `relayMaestroCode`, `dqCodeDisplay`, `formatDateLong`) are ported
  verbatim into `main.js` — keep them in sync.
- Lock = `status: "locked" | "active"` on the meet doc (web app reads `status`).
- Codeset = `codesetId` on the meet doc; codeset docs are global in `codesets`
  (names "LSA 2023", "NFHS / HY-Tek", "USA Swimming 2024").

Key collections: `meets/{id}`, `meets/{id}/events/{eventNumber}`,
`meets/{id}/heats/{eventNumber}_{heatNumber}`, `meets/{id}/dqs`, `codesets`.

## Conventions

- **Adding a renderer→main feature** takes three edits: `ipcMain.handle` in `main.js`,
  one line in `preload.js`, and a `window.agent.<x>()` call in `index.html`. Missing the
  preload line is the most common bug.
- Match the existing dark theme: bg `#0a1628`, cards `#0f1e35`/`#0f2040`, teal `#00c2e0`,
  amber `#f59e0b`/`#fbbf24`, red `#ef4444`, green `#34d399`, muted text `#64748b`.
- The renderer can't use Node. Generate QR codes / read files / touch Firestore in
  `main.js` and pass results over IPC. Clipboard goes through the `copy-to-clipboard`
  handler (Electron `clipboard`), not `navigator.clipboard`.
- `escapeHtml()` any user/meet-derived string before putting it in `innerHTML`.

## Verify / build / release

No `tsc` and no tests. Verify with:

```sh
node --check src/main.js && node --check src/preload.js && node --check src/wizard.js
# inline renderer script:
node -e "const fs=require('fs');const m=fs.readFileSync('src/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/);fs.writeFileSync('/tmp/inl.js',m[1]);" && node --check /tmp/inl.js
```

Also worth cross-checking after HTML edits: every `getElementById` has a matching
`id=`, every `window.agent.X` is in `preload.js`, and every `preload` invoke has an
`ipcMain.handle`. A 9s smoke launch (`perl -e 'alarm 9; exec @ARGV' npx electron .`)
should print "Signed in anonymously" with no errors (the update check is skipped when
unpacked — that's expected).

**Build:** `npm run build` (electron-builder → NSIS `dist/DQSync-Agent-Setup.exe`;
builds on macOS without wine). Output: `DQSync-Agent-Setup.exe`, `.exe.blockmap`,
`latest.yml`.

### Release on every agent change (standing rule)

After ANY change to the agent code, do the full release so existing installs
auto-update (electron-updater reads GitHub Releases):

1. Bump `version` in `package.json` (and the static `#app-version` text in
   `index.html`; the real value is set at runtime from `app.getVersion()`).
2. `npm run build`
3. Commit + `git push origin main` (commits end with the Co-Authored-By trailer).
4. `gh release create vX.Y.Z dist/DQSync-Agent-Setup.exe dist/DQSync-Agent-Setup.exe.blockmap dist/latest.yml --title "..." --notes "..."`

**All three assets must be attached** or auto-update breaks. The repo is
`freydonald-spec/stroke-turn-agent`; releases publish from this repo (see the
`build.publish` block in `package.json`).

## Gotchas

- The auto-updater is **automatic**: on launch it downloads + installs + restarts via
  the full-screen `#update-overlay`. Don't reintroduce the old confirm dialogs.
- `connect-by-pin` only matches the 4-digit officials `pin` field (not adminPin).
- The QR for the Admin PIN points at `/join?pin={adminPin}`; the web `/join` page
  slices to 4 digits, so it prefills the officials PIN and the scorekeeper then enters
  the full admin PIN at the admin gate.
- Heartbeat writes `agentStatus` (not `status`), so locking the meet (`status`) and the
  agent heartbeat don't fight.
- "Update meet file" replaces ONLY the events + heats subcollections
  (`wizard.reimportEventsAndHeats`) — never the meet doc or `dqs`.
