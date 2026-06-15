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

  // Listen for log messages from main process
  onLog: (callback) => ipcRenderer.on("log", (_event, data) => callback(data)),

  // Listen for status updates
  onStatus: (callback) => ipcRenderer.on("status", (_event, data) => callback(data)),
});
