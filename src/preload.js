/**
 * Preload script — safely exposes only what the UI needs.
 * "contextIsolation" means the renderer (HTML page) can't access
 * Node.js directly — it can only use what we expose here.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  // Get saved settings on startup
  getSettings: () => ipcRenderer.invoke("get-settings"),

  // Open native file picker
  selectFile: () => ipcRenderer.invoke("select-file"),

  // Connect to a meet by PIN
  connectByPin: (pin) => ipcRenderer.invoke("connect-by-pin", pin),

  // New Meet Setup Wizard
  wizardSelectMeetDetails: () => ipcRenderer.invoke("wizard-select-meet-details"),
  wizardSelectTimingConfig: () => ipcRenderer.invoke("wizard-select-timing-config"),
  wizardCreateMeet: (meetType) => ipcRenderer.invoke("wizard-create-meet", meetType),
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
});
