/**
 * Preload script — safely exposes only what the UI needs.
 * "contextIsolation" means the renderer (HTML page) can't access
 * Node.js directly — it can only use what we expose here.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  // Get saved settings on startup
  getSettings: () => ipcRenderer.invoke("get-settings"),

  // Open native folder picker (Time Drops meet folder)
  selectFolder: () => ipcRenderer.invoke("select-folder"),

  // Connect to a meet by PIN
  connectByPin: (pin) => ipcRenderer.invoke("connect-by-pin", pin),

  // Connected-meet info (credentials + QR), file update, disconnect
  getMeetInfo: () => ipcRenderer.invoke("get-meet-info"),
  updateMeetFile: () => ipcRenderer.invoke("update-meet-file"),
  disconnectMeet: () => ipcRenderer.invoke("disconnect-meet"),

  // Admin: lock/unlock, codeset, export DQs
  setMeetStatus: (status) => ipcRenderer.invoke("set-meet-status", status),
  setTimingPin: (pin) => ipcRenderer.invoke("set-timing-pin", pin),
  getCodesets: () => ipcRenderer.invoke("get-codesets"),
  setCodeset: (codesetId) => ipcRenderer.invoke("set-codeset", codesetId),
  setZones: (zones) => ipcRenderer.invoke("set-zones", zones),
  setParentViewEnabled: (enabled) => ipcRenderer.invoke("set-parent-view-enabled", enabled),
  exportDqs: () => ipcRenderer.invoke("export-dqs"),

  // New Meet Setup Wizard
  wizardSelectFolder: () => ipcRenderer.invoke("wizard-select-folder"),
  wizardCreateMeet: (meetType, timingSystemPin) => ipcRenderer.invoke("wizard-create-meet", meetType, timingSystemPin),
  wizardStartWatching: () => ipcRenderer.invoke("wizard-start-watching"),
  copyToClipboard: (text) => ipcRenderer.invoke("copy-to-clipboard", text),

  // Simulator Mode controls
  startSimulator: () => ipcRenderer.invoke("simulator-start"),
  stopSimulator: () => ipcRenderer.invoke("simulator-stop"),
  simulatorNext: () => ipcRenderer.invoke("simulator-next"),
  simulatorPrev: () => ipcRenderer.invoke("simulator-prev"),
  simulatorJumpEvent: (n) => ipcRenderer.invoke("simulator-jump-event", n),
  simulatorJumpHeat: (n) => ipcRenderer.invoke("simulator-jump-heat", n),
  simulatorGetState: () => ipcRenderer.invoke("simulator-get-state"),

  // Listen for log messages from main process
  onLog: (callback) => ipcRenderer.on("log", (_event, data) => callback(data)),

  // Listen for status updates
  onStatus: (callback) => ipcRenderer.on("status", (_event, data) => callback(data)),

  // Listen for auto-update status
  onUpdate: (callback) => ipcRenderer.on("update-status", (_event, data) => callback(data)),

  // Full-screen update overlay: progress messages + manual restart fallback
  onUpdateUI: (callback) => ipcRenderer.on("update-ui", (_event, data) => callback(data)),
  restartNow: () => ipcRenderer.invoke("restart-now"),
});
