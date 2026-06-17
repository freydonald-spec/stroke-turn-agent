/**
 * DQSync Agent (Electron)
 * Main process: Firebase, file watcher, IPC to renderer
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
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
let meetId        = null;
let meetName      = null;
let lastEvent     = null;
let lastHeat      = null;
let debounceTimer = null;
let watcher       = null;
let watchFile     = null;
let heartbeatTimer = null;

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
}

// ── Firebase ──────────────────────────────────────────────────────────────────

function initDb() {
  try {
    const firebaseApp = initFirebase(FIREBASE_CONFIG);
    db = getFirestore(firebaseApp);
    return true;
  } catch (err) {
    log(`❌ Firebase init failed: ${err.message}`, "error");
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

ipcMain.handle('connect-by-pin', async (_event, pin) => {
  try {
    const q = query(collection(db, 'meets'), where('pin', '==', pin));
    const snap = await getDocs(q);
    if (snap.empty) {
      return { success: false, error: 'PIN not found. Check with your meet host.' };
    }
    const meetDoc = snap.docs[0];
    meetId = meetDoc.id;
    meetName = meetDoc.data().meetName ?? 'Unnamed Meet';
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
    return { success: true };
  } catch (err) {
    // No meetId yet (connection failed), so skip the Firestore error write —
    // just log it locally.
    log(`❌ PIN lookup failed: ${err.message}`, 'error');
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

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  if (!initDb()) return;

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
  app.quit();
});

// On quit, mark the agent disconnected on the meet doc so the monitor sees it
// go offline cleanly. Defer the actual quit until the async write finishes.
let writingDisconnect = false;
app.on("before-quit", async (event) => {
  if (writingDisconnect || !meetId) return;
  writingDisconnect = true;
  event.preventDefault();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  try {
    await updateDoc(doc(db, "meets", meetId), {
      agentStatus: "disconnected",
      agentDisconnectedAt: serverTimestamp(),
      agentLastSeen: serverTimestamp(),
    });
  } catch (err) {
    log(`❌ Could not write disconnect: ${err.message}`, "error");
  }
  app.quit();
});