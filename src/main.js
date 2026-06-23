/**
 * DQSync Agent (Electron)
 * Main process: Firebase, file watcher, IPC to renderer
 */

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const chokidar = require("chokidar");
const { initializeApp: initFirebase } = require("firebase/app");
const {
  getFirestore,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
  getDocs,
  collection,
  query,
  where,
  serverTimestamp,
} = require("firebase/firestore");
const { getAuth, signInAnonymously } = require("firebase/auth");
const { autoUpdater } = require("electron-updater");
const simulator = require("./simulator");
const wizard = require("./wizard");
const QRCode = require("qrcode");

// ── Firebase config ───────────────────────────────────────────────────────────

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBAVXE8PfeYSQ9dklvGt5u_SV2qdS7vFRM",
  authDomain:        "stroke-and-turn.firebaseapp.com",
  projectId:         "stroke-and-turn",
  storageBucket:     "stroke-and-turn.firebasestorage.app",
  messagingSenderId: "1077840297948",
  appId:             "1:1077840297948:web:eff7e45802f89352a31919",
};

const DEBOUNCE_MS = 800;
const HEARTBEAT_MS = 30_000;

// ── Persistent settings ───────────────────────────────────────────────────────
// Stored automatically at: C:\Users\<name>\AppData\Roaming\stroke-turn-agent\
// User never touches this file.

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch (err) {
    console.error("Could not save settings:", err.message);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

let mainWindow    = null;
let db            = null;
let auth          = null;
let meetId        = null;
let meetName      = null;
let lastEvent     = null;
let lastHeat      = null;
let debounceTimer = null;
let watcher       = null;
let watchFile     = null;
let heartbeatTimer = null;
let simulatorMode = false;
let priorWatchFile = null; // real timing file watched before simulator mode started

// New Meet Setup Wizard state — held between wizard steps until the meet is created.
let wizardParsed = null;        // parsed meet_details.json
let wizardTimingFile = null;    // path to the selected timing_system_configuration.json

// Auto-update flow state — drives the full-screen update overlay.
let updateFlowActive = false;   // true once an update is found (download/install underway)
let installTriggered = false;   // guards against double quitAndInstall

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg, type = "info") {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${msg}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("log", { msg, type, time });
  }
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status", status);
  }
  if (status.type === "update" || status.type === "update-ready") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-status", status);
    }
  }
}

// Drive the renderer's full-screen update overlay. Payload shape:
//   { phase: "checking"|"available"|"downloading"|"downloaded"|"installing"
//            |"restarting"|"restart-fallback"|"error"|"hide",
//     version?, percent?, message? }
function sendUpdateUI(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-ui", payload);
  }
}

// ── Firebase ──────────────────────────────────────────────────────────────────

function initDb() {
  try {
    const firebaseApp = initFirebase(FIREBASE_CONFIG);
    db = getFirestore(firebaseApp);
    auth = getAuth(firebaseApp);
    return true;
  } catch (err) {
    log(`❌ Firebase init failed: ${err.message}`, "error");
    return false;
  }
}

// Firestore rules require request.auth != null, so sign in anonymously before
// any read/write. Called once at startup.
async function initAuth() {
  try {
    await signInAnonymously(auth);
    log("🔐 Signed in anonymously", "success");
    return true;
  } catch (err) {
    log(`❌ Auth failed: ${err.message}`, "error");
    return false;
  }
}

async function getStroke(eventNumber) {
  try {
    const snap = await getDoc(doc(db, "meets", meetId, "events", String(eventNumber)));
    if (snap.exists()) return snap.data().stroke ?? null;
  } catch {}
  return null;
}

async function pushUpdate(currentEvent, currentHeat) {
  try {
    const stroke = await getStroke(currentEvent);
    await updateDoc(doc(db, "meets", meetId), {
      currentEvent,
      currentHeat,
      ...(stroke !== null ? { currentStroke: stroke } : {}),
    });
    const strokeLabel = stroke ? ` · ${stroke}` : "";
    log(`✅ Pushed → Event ${currentEvent} · Heat ${currentHeat}${strokeLabel}`, "success");
    sendStatus({ type: "heat", event: currentEvent, heat: currentHeat, stroke });
  } catch (err) {
    log(`❌ Failed to push: ${err.message}`, "error");
    writeAgentError(`Push failed: ${err.message}`);
  }
}

// ── Heartbeat ───────────────────────────────────────────────────────────────
// Stamp the meet doc every 30s so the web app (Observer view) can show whether
// the agent is alive and when it last pushed.

async function writeHeartbeat() {
  if (!meetId) return;
  // If a watch file is configured but missing on disk, surface that distinctly
  // so the monitor can show "file not found" rather than just "connected".
  const fileMissing = !!watchFile && !fs.existsSync(watchFile);
  try {
    await updateDoc(doc(db, "meets", meetId), {
      agentLastSeen: serverTimestamp(),
      agentStatus: fileMissing ? "file_not_found" : "connected",
      agentVersion: app.getVersion(),
      agentWatchFile: watchFile ?? null,
      agentMeetId: meetId,
      // Surface a missing-file error, otherwise clear any previous error.
      agentLastError: fileMissing ? `File not found: ${watchFile}` : null,
    });
  } catch (err) {
    log(`❌ Heartbeat failed: ${err.message}`, "error");
  }
}

// Write an agent-side error to the meet doc so it can be read remotely on the
// monitor. Only writes when connected to a meet (meetId set).
async function writeAgentError(errorMsg) {
  if (!meetId) return;
  try {
    await updateDoc(doc(db, "meets", meetId), {
      agentStatus: "error",
      agentLastError: errorMsg,
      agentLastErrorAt: serverTimestamp(),
      agentLastSeen: serverTimestamp(),
    });
  } catch (err) {
    log(`❌ Could not write agent error: ${err.message}`, "error");
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  writeHeartbeat(); // immediate first beat on connect
  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_MS);
}

// ── File watching ─────────────────────────────────────────────────────────────

function parseFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    const currentEvent = json.currentEvent !== undefined ? Number(json.currentEvent) : null;
    const currentHeat  = json.currentHeat  !== undefined ? Number(json.currentHeat)  : null;
    if (currentEvent === null || currentHeat === null || isNaN(currentEvent) || isNaN(currentHeat)) {
      return null;
    }
    return { currentEvent, currentHeat };
  } catch {
    return null;
  }
}

async function handleChange() {
  if (!meetId || !watchFile) return;
  const data = parseFile(watchFile);
  if (!data) return;
  const { currentEvent, currentHeat } = data;
  if (currentEvent === lastEvent && currentHeat === lastHeat) return;
  lastEvent = currentEvent;
  lastHeat  = currentHeat;
  log(`📄 File changed → Event ${currentEvent} · Heat ${currentHeat}`);
  await pushUpdate(currentEvent, currentHeat);
}

function debouncedChange() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(handleChange, DEBOUNCE_MS);
}

function startWatcher(filePath) {
  if (watcher) { watcher.close(); watcher = null; }
  watchFile = filePath;
  log(`👁️ Watching: ${path.basename(filePath)}`);
  handleChange(); // read current state immediately
  watcher = chokidar.watch(filePath, {
    persistent: true,
    usePolling: true,
    interval: 500,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignoreInitial: true,
  });
  watcher
    .on("change", debouncedChange)
    .on("add",    debouncedChange)
    .on("error",  (err) => {
      log(`❌ Watcher error: ${err.message}`, "error");
      writeAgentError(`File watcher error: ${err.message}`);
    });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

// Build the credential summary + QR codes the connected (Screen 2 / Admin)
// views render. QR generation is best-effort — a missing credential just omits
// that code. Officials + Admin join at /join, coaches at /coach (see wizard.js).
async function buildMeetInfo(data) {
  const pin       = data.pin ?? null;
  const adminPin  = data.adminPin ?? null;
  const coachWord = data.coachWord ?? null;
  const name      = data.name ?? data.meetName ?? "Unnamed Meet";
  const qrOpts = { margin: 1, width: 220, color: { dark: "#0a1628", light: "#ffffff" } };
  const qr = {};
  try {
    if (pin)       qr.official = await QRCode.toDataURL(wizard.buildJoinUrl(pin), qrOpts);
    if (adminPin)  qr.admin    = await QRCode.toDataURL(wizard.buildJoinUrl(adminPin), qrOpts);
    if (coachWord) qr.coach    = await QRCode.toDataURL(wizard.buildCoachUrl(coachWord), qrOpts);
  } catch (err) {
    log(`⚠️ Could not generate QR codes: ${err.message}`, "warn");
  }
  return {
    meetName: name, pin, adminPin, coachWord, qr,
    currentEvent:  data.currentEvent  ?? null,
    currentHeat:   data.currentHeat   ?? null,
    currentStroke: data.currentStroke ?? null,
  };
}

ipcMain.handle('connect-by-pin', async (_event, pin) => {
  try {
    // Should already be signed in from startup, but make sure before querying.
    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }
    const q = query(collection(db, 'meets'), where('pin', '==', pin));
    const snap = await getDocs(q);
    if (snap.empty) {
      return { success: false, error: 'PIN not found. Check with your meet host.' };
    }
    const meetDoc = snap.docs[0];
    meetId = meetDoc.id;
    const data = meetDoc.data();
    meetName = data.name ?? data.meetName ?? "Unnamed Meet";
    lastEvent = null;
    lastHeat = null;
    log(`✅ Connected to: ${meetName}`, 'success');
    sendStatus({ type: 'connected', meetName });
    startHeartbeat();
    const settings = loadSettings();
    settings.savedPin = pin;
    saveSettings(settings);
    if (watchFile && fs.existsSync(watchFile)) {
      startWatcher(watchFile);
    }
    const info = await buildMeetInfo(data);
    return { success: true, info };
  } catch (err) {
    // No meetId yet (connection failed), so skip the Firestore error write —
    // just log it locally.
    log(`❌ PIN lookup failed: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
});

// Current connected meet's credentials + QR (used on entering Screen 2 after the
// wizard, and to refresh the QR overlay).
ipcMain.handle('get-meet-info', async () => {
  if (!meetId) return { success: false };
  try {
    const snap = await getDoc(doc(db, 'meets', meetId));
    if (!snap.exists()) return { success: false };
    return { success: true, info: await buildMeetInfo(snap.data()) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Admin → "Update meet file": pick a new meet_details.json and re-import events
// + heats ONLY for the current meet. Meet doc (PINs/mode) and dqs are preserved.
ipcMain.handle('update-meet-file', async () => {
  if (!meetId) return { success: false, error: 'No meet connected.' };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select updated meet_details.json",
    filters: [{ name: "JSON Files", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  try {
    const json = wizard.readJsonFile(result.filePaths[0]);
    const parsed = wizard.parseMeetDetails(json);
    const r = await wizard.reimportEventsAndHeats(db, meetId, parsed);
    log(`♻️ Updated meet file — ${r.eventCount} events · ${r.heatCount} heats re-imported`, "success");
    return { success: true, eventCount: r.eventCount, heatCount: r.heatCount };
  } catch (err) {
    log(`❌ Update meet file failed: ${err.message}`, "error");
    return { success: false, error: err.message };
  }
});

// Admin → "Disconnect meet": stop the watcher + heartbeat and clear local state.
// The meet stays intact in Firestore; the agent returns to the launch screen.
ipcMain.handle('disconnect-meet', async () => {
  try {
    if (watcher) { watcher.close(); watcher = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (meetId) {
      try {
        await updateDoc(doc(db, "meets", meetId), {
          agentStatus: "disconnected",
          agentDisconnectedAt: serverTimestamp(),
          agentLastSeen: serverTimestamp(),
        });
      } catch { /* best effort — meet stays intact regardless */ }
    }
    log("🔌 Disconnected from meet", "warn");
    meetId = null;
    meetName = null;
    lastEvent = null;
    lastHeat = null;
    // Forget the saved PIN so a relaunch starts fresh on the launch screen.
    const settings = loadSettings();
    delete settings.savedPin;
    saveSettings(settings);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Trigger 2: user manually selects the file via the button
ipcMain.handle("select-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select timing_system_configuration.json",
    filters: [{ name: "JSON Files", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];

  // Save path for future launches
  const settings = loadSettings();
  settings.watchFile = filePath;
  saveSettings(settings);

  log(`📁 File selected: ${path.basename(filePath)}`, "success");
  startWatcher(filePath);

  // Auto-minimize after 800ms so user sees the green confirmation before it disappears
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(() => mainWindow.minimize(), 800);
  }

  return filePath;
});

// UI is ready — send it the current watch file path if we have one
ipcMain.handle("get-settings", () => {
  return loadSettings();
});

// ── Simulator Mode ──────────────────────────────────────────────────────────────
// Drives src/simulator.js, which writes a fake timing_system_configuration.json
// into userData. Starting the simulator points the watcher at that file so the
// normal change → push pipeline runs exactly as it would with Meet Maestro.

ipcMain.handle("simulator-start", () => {
  const filePath = simulator.startSimulator();
  simulatorMode = true;
  // Remember the real timing file (if any) so it can be restored on stop.
  priorWatchFile = loadSettings().watchFile ?? null;
  log(`🎮 Simulator started → ${path.basename(filePath)}`, "success");
  // Begin watching the simulated file immediately (no settings persistence —
  // the file is ephemeral and removed on stop).
  startWatcher(filePath);
  return filePath;
});

ipcMain.handle("simulator-stop", () => {
  simulator.stopSimulator();
  simulatorMode = false;
  if (watcher) { watcher.close(); watcher = null; }
  watchFile = null;
  log("🛑 Simulator stopped", "warn");
  // Restore the real timing file that was being watched before simulator mode,
  // if one existed and still exists on disk.
  if (priorWatchFile) {
    const restore = priorWatchFile;
    priorWatchFile = null;
    const settings = loadSettings();
    settings.watchFile = restore;
    saveSettings(settings);
    if (fs.existsSync(restore)) {
      log(`📁 Restored timing file: ${path.basename(restore)}`, "success");
      startWatcher(restore);
    } else {
      watchFile = restore;
      log(`⚠️ Saved timing file not found: ${path.basename(restore)}`, "warn");
    }
  }
  return true;
});

ipcMain.handle("simulator-next", () => simulator.nextHeat());
ipcMain.handle("simulator-prev", () => simulator.prevHeat());
ipcMain.handle("simulator-jump-event", (_event, n) => simulator.jumpEvent(n));
ipcMain.handle("simulator-jump-heat", (_event, n) => simulator.jumpHeat(n));
ipcMain.handle("simulator-get-state", () => simulator.getState());

// ── New Meet Setup Wizard ─────────────────────────────────────────────────────
// Step 1: pick + parse meet_details.json. Holds the parsed result in
// wizardParsed for the create step and returns a summary for the UI.
ipcMain.handle("wizard-select-meet-details", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select meet_details.json",
    filters: [{ name: "JSON Files", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };

  const filePath = result.filePaths[0];
  try {
    const json = wizard.readJsonFile(filePath);
    const parsed = wizard.parseMeetDetails(json);
    wizardParsed = parsed;
    log(`📋 Loaded meet details: ${parsed.meetName || path.basename(filePath)}`, "success");
    return {
      success: true,
      summary: {
        meetName: parsed.meetName,
        meetStartDate: parsed.meetStartDate,
        hostTeamName: parsed.hostTeamName,
        hostAbbr: parsed.hostAbbr,
        teams: parsed.teams,
        visitingTeams: parsed.visitingTeams,
        laneCount: parsed.laneCount,
        eventCount: parsed.events.length,
        heatCount: parsed.heats.length,
        teamCount: parsed.teams.length,
        meetType: parsed.meetType,
      },
    };
  } catch (err) {
    log(`❌ Could not read meet details: ${err.message}`, "error");
    return { success: false, error: err.message };
  }
});

// Step 2: pick + parse timing_system_configuration.json. Remembers the path so
// "Start Watching Files" can watch it after the meet is created.
ipcMain.handle("wizard-select-timing-config", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select timing_system_configuration.json",
    filters: [{ name: "JSON Files", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };

  const filePath = result.filePaths[0];
  try {
    const json = wizard.readJsonFile(filePath);
    const cfg = wizard.parseTimingConfig(json);
    wizardTimingFile = filePath;
    log(`⏱️ Loaded timing config: ${cfg.timingSystemType || "timing system"}`, "success");
    return {
      success: true,
      config: {
        numberOfLanes: cfg.numberOfLanes,
        timingSystemType: cfg.timingSystemType,
        filePath,
      },
    };
  } catch (err) {
    log(`❌ Could not read timing config: ${err.message}`, "error");
    return { success: false, error: err.message };
  }
});

// Step 4 → 5: create the meet from the parsed details + chosen meet type, then
// "connect" the agent to it (set meetId, start heartbeat) exactly as a PIN
// connect would. Returns the generated PINs + QR data URLs for the UI.
ipcMain.handle("wizard-create-meet", async (_event, meetType) => {
  if (!wizardParsed) {
    return { success: false, error: "No meet details loaded. Go back to Step 1." };
  }
  try {
    if (!auth.currentUser) await signInAnonymously(auth);

    const created = await wizard.createMeet(db, wizardParsed, {
      meetType,
      agentVersion: app.getVersion(),
    });

    // Connect the agent to the new meet (same as connect-by-pin success path).
    meetId = created.meetId;
    meetName = created.meetName;
    lastEvent = null;
    lastHeat = null;
    log(`✅ Meet created: ${created.meetName}`, "success");
    sendStatus({ type: "connected", meetName: created.meetName });
    startHeartbeat();

    // Persist the meet PIN so a relaunch reconnects, mirroring connect-by-pin.
    const settings = loadSettings();
    settings.savedPin = created.pin;
    if (wizardTimingFile) settings.watchFile = wizardTimingFile;
    saveSettings(settings);

    // Build QR codes pointing at the correct public route for each credential:
    // officials + admin/scorekeeper → /join, coaches → /coach (see wizard.js).
    const qrOpts = { margin: 1, width: 220, color: { dark: "#0a1628", light: "#ffffff" } };
    const [officialQr, adminQr, coachQr] = await Promise.all([
      QRCode.toDataURL(wizard.buildJoinUrl(created.pin), qrOpts),
      QRCode.toDataURL(wizard.buildJoinUrl(created.adminPin), qrOpts),
      QRCode.toDataURL(wizard.buildCoachUrl(created.coachWord), qrOpts),
    ]);

    return {
      success: true,
      meetId: created.meetId,
      meetName: created.meetName,
      pin: created.pin,
      adminPin: created.adminPin,
      coachWord: created.coachWord,
      meetType: created.meetType,
      eventCount: wizardParsed.events.length,
      heatCount: wizardParsed.heats.length,
      laneCount: wizardParsed.laneCount,
      hostTeamName: wizardParsed.hostTeamName,
      visitingTeams: wizardParsed.visitingTeams,
      qr: { official: officialQr, admin: adminQr, coach: coachQr },
    };
  } catch (err) {
    log(`❌ Meet creation failed: ${err.message}`, "error");
    return { success: false, error: err.message };
  }
});

// Copy text to the OS clipboard via Electron (reliable under file://, where the
// renderer's navigator.clipboard is not guaranteed to work).
ipcMain.handle("copy-to-clipboard", (_event, text) => {
  try {
    clipboard.writeText(String(text ?? ""));
    return true;
  } catch {
    return false;
  }
});

// Step 5: begin watching the timing file selected in Step 2 (the existing Time
// Drops file-watch pipeline). No-op if no timing file was provided.
ipcMain.handle("wizard-start-watching", () => {
  if (!wizardTimingFile) return { success: false, error: "No timing file selected." };
  if (!fs.existsSync(wizardTimingFile)) {
    return { success: false, error: "Timing file not found on disk." };
  }
  const settings = loadSettings();
  settings.watchFile = wizardTimingFile;
  saveSettings(settings);
  startWatcher(wizardTimingFile);
  return { success: true, filePath: wizardTimingFile };
});

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 600,
    resizable: false,
    title: "DQSync Agent",
    backgroundColor: "#0a1628",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.setMenuBarVisibility(false);
}

// ── System tray ───────────────────────────────────────────────────────────────

const { Tray, Menu, nativeImage } = require("electron");
let tray = null;

function createTray() {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  const trayIcon = require('fs').existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(trayIcon);
  tray.setToolTip("DQSync Agent v" + app.getVersion());
  const contextMenu = Menu.buildFromTemplate([
    { label: "DQSync Agent v" + app.getVersion(), enabled: false },
    { type: "separator" },
    { label: "Show", click: () => { if (mainWindow) mainWindow.show(); } },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("click", () => { if (mainWindow) mainWindow.show(); });
}

// ── Update cache cleanup ──────────────────────────────────────────────────────
// electron-updater stages downloads in <LOCALAPPDATA>/dqsync-agent-updater/pending
// (updaterCacheDirName from app-update.yml). Interrupted/failed updates can leave
// a stale or locked file there, which then fails the rename with EPERM on the
// next attempt. Clearing the staging folder before each download avoids that.
function clearUpdateCache() {
  try {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const pending = path.join(base, "dqsync-agent-updater", "pending");
    fs.rmSync(pending, { recursive: true, force: true });
  } catch (err) {
    log(`⚠️ Could not clear update cache: ${err.message}`, "warn");
  }
}

// Quit and install a downloaded update. Mirrors the prior manual-restart path:
// mark the disconnect as already handled and tear down the tray so the
// before-quit Firestore write doesn't block/delay the install, then hand off to
// electron-updater. Used by both the automatic install and the fallback button.
function doQuitAndInstall() {
  sendUpdateUI({ phase: "restarting" });
  writingDisconnect = true;
  if (tray) { try { tray.destroy(); } catch { /* noop */ } }
  try {
    autoUpdater.quitAndInstall();
  } catch (err) {
    log(`❌ Could not start installer: ${err.message}`, "error");
    sendUpdateUI({ phase: "restart-fallback" });
  }
}

// Manual restart fallback — fired by the overlay's "Restart now" button if the
// automatic quitAndInstall didn't take within 5s.
ipcMain.handle("restart-now", () => { doQuitAndInstall(); return true; });

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Ensure only one instance runs at a time
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return;
  }

  createWindow();
  createTray();

  // Show the real app version in the UI (kept in sync with package.json).
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(
      `document.getElementById('app-version').textContent = 'v${app.getVersion()}';`
    );
  });

  // ── Auto-update (GitHub Releases via electron-updater) ────────────────────
  // Download + install only on explicit user confirmation, never in the
  // background. quitAndInstall() fully closes the app before installing.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Full download to staging (no in-place blockmap patching) — more robust and
  // avoids a class of EPERM/file-lock errors during the pending-folder rename.
  autoUpdater.disableDifferentialDownload = true;

  // Remove any leftover staged download from a prior interrupted update.
  clearUpdateCache();

  // Check for updates 3 seconds after startup (give app time to load)
  setTimeout(() => {
    sendUpdateUI({ phase: "checking" });
    autoUpdater.checkForUpdates().catch((err) => {
      log(`⚠️ Update check failed: ${err.message}`, "warn");
      // Don't strand the overlay on a failed check when no update is in flight.
      if (!updateFlowActive) sendUpdateUI({ phase: "hide" });
    });
  }, 3000);

  // Update available — show the overlay and download automatically (no manual
  // confirmation). Progress streams to the overlay via download-progress.
  autoUpdater.on("update-available", (info) => {
    log(`🔄 Update available: v${info.version}`, "warn");
    updateFlowActive = true;
    sendUpdateUI({ phase: "available", version: info.version });
    clearUpdateCache();
    autoUpdater.downloadUpdate().catch((err) => {
      log(`❌ Update download failed: ${err.message}`, "error");
      sendUpdateUI({ phase: "error", message: err.message });
    });
  });

  // No update available — hide the overlay if it was only showing "Checking…".
  autoUpdater.on("update-not-available", () => {
    log(`✅ DQSync Agent is up to date (v${app.getVersion()})`, "success");
    if (!updateFlowActive) sendUpdateUI({ phase: "hide" });
  });

  // Download progress — fill the overlay's progress bar.
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.round(progress.percent);
    log(`⬇️ Downloading update: ${percent}%`);
    sendUpdateUI({ phase: "downloading", percent });
  });

  // Update downloaded — auto-install and restart, no waiting for a click.
  autoUpdater.on("update-downloaded", (info) => {
    log(`✅ Update v${info.version} downloaded — installing`, "success");
    sendStatus({ type: "update-ready", msg: `v${info.version} ready — restarting` });
    sendUpdateUI({ phase: "downloaded", version: info.version });
    if (installTriggered) return;
    installTriggered = true;
    // Briefly show "Installing…" so the restart isn't an abrupt black screen,
    // then quit into the installer. The new installer also force-kills us via
    // customCheckAppRunning as a backstop.
    setTimeout(() => {
      sendUpdateUI({ phase: "installing", version: info.version });
      doQuitAndInstall();
    }, 1000);
    // Fallback: if we're still alive ~5s after attempting the install, the
    // automatic restart didn't take — surface a manual "Restart now" button.
    setTimeout(() => {
      sendUpdateUI({ phase: "restart-fallback", version: info.version });
    }, 6000);
  });

  autoUpdater.on("error", (err) => {
    log(`❌ Update error: ${err.message}`, "error");
    // Clear staging so a retry starts clean (handles EPERM/locked-file leftovers).
    clearUpdateCache();
    // Only surface the error overlay if an update was actually in flight;
    // otherwise a routine failed check would needlessly cover the app.
    if (updateFlowActive) sendUpdateUI({ phase: "error", message: err.message });
    else sendUpdateUI({ phase: "hide" });
  });

  if (!initDb()) return;

  const authed = await initAuth();
  if (!authed) return;

  // Restore saved watch file path if it still exists on disk
  const settings = loadSettings();
  if (settings.watchFile && fs.existsSync(settings.watchFile)) {
    watchFile = settings.watchFile;
    log(`📁 Using saved file: ${path.basename(settings.watchFile)}`);
  }
});

app.on("window-all-closed", () => {
  if (watcher) watcher.close();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (tray) { try { tray.destroy(); } catch { /* noop */ } }
  app.quit();
});

// On quit, mark the agent disconnected on the meet doc so the monitor sees it
// go offline cleanly. Defer the actual quit until the async write finishes.
let writingDisconnect = false;
app.on("before-quit", (event) => {
  if (writingDisconnect || !meetId) return;
  writingDisconnect = true;
  event.preventDefault();
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  // Never hang on quit — force-quit after 3s if the disconnect write stalls.
  const forceQuit = setTimeout(() => { app.quit(); }, 3000);

  Promise.resolve(
    updateDoc(doc(db, "meets", meetId), {
      agentStatus: "disconnected",
      agentDisconnectedAt: serverTimestamp(),
      agentLastSeen: serverTimestamp(),
    }).catch((err) => {
      log(`❌ Could not write disconnect: ${err.message}`, "error");
    })
  ).finally(() => {
    clearTimeout(forceQuit);
    app.quit();
  });
});