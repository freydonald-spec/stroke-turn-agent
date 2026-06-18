/**
 * DQSync Agent — built-in Meet Simulator.
 *
 * Simulates the timing_system_configuration.json that Meet Maestro produces, so
 * the agent can be tested end-to-end without timing software. The file is
 * written under the app's userData dir (…/simulate/timing_system_configuration.json)
 * and the agent watches it like any real timing file.
 *
 * Ported from the standalone scripts/simulate-meet.js — same navigation logic
 * and MAX_HEATS cap, exposed as a module the main process drives via IPC.
 */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const MAX_HEATS = 10; // cap per event before advancing

// ── State ──────────────────────────────────────────────────────────────────
let currentEvent = 1;
let currentHeat = 1;

function getSimDir() {
  return path.join(app.getPath("userData"), "simulate");
}

function getFilePath() {
  return path.join(getSimDir(), "timing_system_configuration.json");
}

function writeFile() {
  const filePath = getFilePath();
  fs.mkdirSync(getSimDir(), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ currentEvent, currentHeat }, null, 2));
  return filePath;
}

function getState() {
  return { currentEvent, currentHeat };
}

// ── Lifecycle ──────────────────────────────────────────────────────────────
// Start from Event 1 · Heat 1, write the file so it exists before the agent
// begins watching, and return its path.
function startSimulator() {
  currentEvent = 1;
  currentHeat = 1;
  return writeFile();
}

// Remove the simulated file (best effort) and stop.
function stopSimulator() {
  try {
    const filePath = getFilePath();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

// ── Navigation (each returns the new state) ─────────────────────────────────
function nextHeat() {
  currentHeat++;
  if (currentHeat > MAX_HEATS) {
    currentEvent++;
    currentHeat = 1;
  }
  writeFile();
  return getState();
}

function prevHeat() {
  currentHeat--;
  if (currentHeat < 1) {
    if (currentEvent > 1) {
      currentEvent--;
      currentHeat = MAX_HEATS;
    } else {
      currentHeat = 1; // already at Event 1 · Heat 1 — clamp
    }
  }
  writeFile();
  return getState();
}

function jumpEvent(n) {
  const e = parseInt(n, 10);
  if (Number.isInteger(e) && e >= 1) {
    currentEvent = e;
    currentHeat = 1;
    writeFile();
  }
  return getState();
}

function jumpHeat(n) {
  const h = parseInt(n, 10);
  if (Number.isInteger(h)) {
    currentHeat = Math.max(1, Math.min(MAX_HEATS, h));
    writeFile();
  }
  return getState();
}

module.exports = {
  MAX_HEATS,
  startSimulator,
  stopSimulator,
  nextHeat,
  prevHeat,
  jumpEvent,
  jumpHeat,
  getState,
  getFilePath,
};
