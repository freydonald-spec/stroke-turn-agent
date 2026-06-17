// DQSync Meet Simulator
// Simulates timing_system_configuration.json output from Meet Maestro
// Usage: node simulate-meet.js
// Then point DQSync Agent at the file path shown on startup.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const FILE_PATH = path.join(__dirname, 'timing_system_configuration.json');

// ── State ───────────────────────────────────────────────────────────────────
let currentEvent = 1;
let currentHeat = 1;
const MAX_HEATS = 10; // cap per event before advancing

// ── File output ──────────────────────────────────────────────────────────────
function writeFile() {
  fs.writeFileSync(FILE_PATH, JSON.stringify({ currentEvent, currentHeat }, null, 2));
  console.log(`✓ Event ${currentEvent} · Heat ${currentHeat} → written to ${FILE_PATH}`);
}

function removeFile() {
  try {
    if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
  } catch {
    // best effort
  }
}

// ── Console UI ───────────────────────────────────────────────────────────────
function printState() {
  console.log('╔══════════════════════════════════╗');
  console.log('║   DQSync Meet Simulator v1.0     ║');
  console.log('║   Simulates Meet Maestro output  ║');
  console.log('╚══════════════════════════════════╝');
  console.log('');
  console.log(`File: ${FILE_PATH}`);
  console.log('Point DQSync Agent at this file.');
  console.log('');
  console.log('Controls:');
  console.log('  N or ENTER  → Next heat');
  console.log('  P           → Previous heat');
  console.log('  E [number]  → Jump to event  (e.g. E 7)');
  console.log('  H [number]  → Jump to heat   (e.g. H 3)');
  console.log('  Q           → Quit');
  console.log('─────────────────────────────────────');
}

function printChange() {
  console.log(`→ Event ${currentEvent} · Heat ${currentHeat}`);
}

// ── Navigation ───────────────────────────────────────────────────────────────
function advance() {
  currentHeat++;
  if (currentHeat > MAX_HEATS) {
    currentEvent++;
    currentHeat = 1;
  }
  writeFile();
}

function previous() {
  currentHeat--;
  if (currentHeat < 1) {
    if (currentEvent > 1) {
      currentEvent--;
      currentHeat = MAX_HEATS;
    } else {
      // Already at Event 1 · Heat 1 — clamp.
      currentHeat = 1;
    }
  }
  writeFile();
}

function jumpEvent(n) {
  currentEvent = n;
  currentHeat = 1;
  writeFile();
}

function jumpHeat(n) {
  currentHeat = Math.max(1, Math.min(MAX_HEATS, n));
  writeFile();
}

// ── Input handling ───────────────────────────────────────────────────────────
function handleInput(raw) {
  const input = raw.trim().toUpperCase();

  if (input === 'N' || input === '') {
    advance();
    printChange();
  } else if (input === 'P') {
    previous();
    printChange();
  } else if (input === 'Q') {
    removeFile();
    console.log('Simulator stopped. File removed.');
    process.exit(0);
  } else if (input.startsWith('E ')) {
    const n = parseInt(input.slice(2).trim(), 10);
    if (Number.isInteger(n) && n >= 1) {
      jumpEvent(n);
      printChange();
    } else {
      console.log('Unknown command');
    }
  } else if (input.startsWith('H ')) {
    const n = parseInt(input.slice(2).trim(), 10);
    if (Number.isInteger(n)) {
      jumpHeat(n);
      printChange();
    } else {
      console.log('Unknown command');
    }
  } else {
    console.log('Unknown command');
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  removeFile();
  console.log('\nSimulator stopped. File removed.');
  process.exit(0);
});

// Best-effort cleanup on any exit.
process.on('exit', () => {
  removeFile();
});

console.clear();
printState();
writeFile(); // immediately write so the file exists before the agent watches it

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', handleInput);
rl.on('close', () => process.exit(0));
