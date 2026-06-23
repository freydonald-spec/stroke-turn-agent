/**
 * DQSync Agent — New Meet Setup Wizard logic.
 *
 * Parses the two Meet Maestro / Time Drops exports (meet_details.json and
 * timing_system_configuration.json) and writes a complete meet to Firestore —
 * meet doc, events, heats, and generated PINs — replicating exactly what the
 * web app's create + import flow produces so every existing role page keeps
 * working unchanged.
 *
 * The Firestore document shapes here mirror:
 *   - app/referee/create/page.tsx   (meet doc + PIN/coachWord/adminPin)
 *   - app/referee/import/page.tsx    (events + heats parse and write)
 * in the stroke-and-turn web app. Keep them in sync if those change.
 */

const fs = require("fs");
const {
  doc,
  collection,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  writeBatch,
  serverTimestamp,
} = require("firebase/firestore");

// ── Stroke map (mirror of app/referee/import/page.tsx STROKE_MAP) ────────────
const STROKE_MAP = {
  1: "Freestyle",
  2: "Backstroke",
  3: "Breaststroke",
  4: "Butterfly",
  5: "IM",
  6: "Relay",
  7: "Medley Relay",
};

// ── PIN / coach-word generation (mirror of lib/* in the web app) ─────────────

function generatePin() {
  return String(Math.floor(Math.random() * 9000) + 1000); // 1000–9999
}

// Admin PIN = 4-digit meet PIN + random 2-digit suffix (lib/adminPin.ts).
function generateAdminPin(meetPin) {
  const suffix = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  return `${meetPin}${suffix}`;
}

// Coach word = one animal + one swim word (lib/coachWord.ts).
const ANIMALS = ["SHARK", "OTTER", "TROUT", "CORAL", "HERON", "PERCH", "BREAM",
  "SNOOK", "GUPPY", "WHALE", "SQUID", "PRAWN", "COBIA", "EGRET", "CRANE",
  "TENCH", "SKATE", "SNIPE", "MARLIN", "DOLPHIN", "TARPON"];
const SWIM_WORDS = ["WAVE", "TIDE", "DIVE", "FLIP", "WAKE", "LANE", "KICK",
  "PULL", "GLIDE", "RELAY", "SURGE", "CREST", "REACH", "TAPER", "DRAFT",
  "FLOAT", "BLOCK", "TURNS"];

function generateCoachWord() {
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const swim = SWIM_WORDS[Math.floor(Math.random() * SWIM_WORDS.length)];
  return `${animal}${swim}`;
}

// ── Public join URLs for the Done/PINs QR codes ──────────────────────────────
// Centralised so the routes stay correct in one place.
//   - Officials (S&T/CJ/Referee/Starter) join at /join with the 4-digit pin.
//   - Scorekeeper/Admin also join at /join: the join page strips ?pin= to 4
//     digits, so handing it the 6-digit admin PIN prefills the officials pin,
//     and the scorekeeper then enters the full admin PIN at the admin gate.
//   - Coaches use the separate /coach route, which matches on coachWord.
const PUBLIC_BASE = "https://dqsync.app";

function buildJoinUrl(pin) {
  return `${PUBLIC_BASE}/join?pin=${encodeURIComponent(pin)}`;
}

function buildCoachUrl(word) {
  return `${PUBLIC_BASE}/coach?word=${encodeURIComponent(word)}`;
}

// ── meet_details.json parsing (mirror of parseTimeDrops in import/page.tsx) ───

// Relay swimmer names can appear under several field names / shapes.
function extractRelayNames(lane) {
  const candidates = [
    "laneRelayNames", "laneRelaySwimmers", "relaySwimmers",
    "relayNames", "laneRelayAthletes", "laneSwimmers",
  ];
  for (const key of candidates) {
    const arr = lane[key];
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.map((r) => {
        if (typeof r === "string") return r;
        const o = r ?? {};
        const first = String(o.firstName ?? o.swimmerFirstName ?? "");
        const last = String(o.lastName ?? o.swimmerLastName ?? "");
        const combined = `${first} ${last}`.trim();
        return String(o.swimmerName ?? o.name ?? o.fullName ?? o.athleteName ?? combined ?? "");
      });
    }
  }
  return [];
}

function extractTeamAbbreviation(lane) {
  const swimmer = lane.laneSwimmer ?? {};
  const team = lane.laneTeam ?? {};
  const candidates = [
    lane.laneTeamAbbreviation, lane.laneTeamAbbr, lane.teamAbbreviation,
    lane.laneRelayTeamAbbreviation, swimmer.swimmerTeamAbbreviation,
    swimmer.teamAbbreviation, swimmer.swimmerTeamAbbr,
    team.teamAbbreviation, team.abbreviation,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().toUpperCase();
  }
  return "";
}

// Derive which team abbreviation belongs to the host, given the host's full
// name from meetHostTeamName. The export only carries abbreviations on lanes, so
// match the abbreviation that is a subsequence of the host name's letters
// (e.g. "Springbrook Swim Club" → "SPR"); fall back to first-letter match.
function deriveHostAbbreviation(hostName, abbrs) {
  if (!hostName || abbrs.length === 0) return null;
  const letters = hostName.toUpperCase().replace(/[^A-Z]/g, "");
  const isSubsequence = (abbr) => {
    let i = 0;
    for (const ch of letters) {
      if (ch === abbr[i]) i++;
      if (i === abbr.length) return true;
    }
    return i === abbr.length;
  };
  // Prefer abbreviations that are a clean prefix of the host name, then any
  // subsequence match, then a shared first letter.
  const prefix = abbrs.find((a) => letters.startsWith(a));
  if (prefix) return prefix;
  const subseq = abbrs.find((a) => isSubsequence(a));
  if (subseq) return subseq;
  const firstLetter = abbrs.find((a) => a[0] === letters[0]);
  return firstLetter ?? null;
}

// Parse a meet_details.json object into the structures the importer needs.
// Throws with a clear message if the file isn't a valid meet_details export.
function parseMeetDetails(json) {
  const obj = json ?? {};

  if (!Array.isArray(obj.meetEvents))
    throw new Error("Not a valid meet_details.json — missing meetEvents array.");
  if (!Array.isArray(obj.meetSessions) || obj.meetSessions.length === 0)
    throw new Error("Not a valid meet_details.json — missing meetSessions array.");

  const session = obj.meetSessions[0] ?? {};
  // Lane count lives on the session pool; fall back to a root-level pool object.
  const sessionPool = session.pool ?? {};
  const rootPool = obj.pool ?? {};
  const laneCount = Number(sessionPool.numberOfLanes ?? rootPool.numberOfLanes ?? 0);

  const events = obj.meetEvents.map((e) => ({
    eventNumber: Number(e.eventNumber),
    eventLabel: String(e.eventLabel ?? ""),
    stroke: STROKE_MAP[Number(e.eventStrokeCode)] ?? "Unknown",
  }));

  // Heats: every race across every session (most exports have a single session,
  // but iterate all to be safe).
  const heats = [];
  for (const sess of obj.meetSessions) {
    const races = Array.isArray(sess.sessionRaces) ? sess.sessionRaces : [];
    for (const race of races) {
      const rawLanes = Array.isArray(race.raceLanes) ? race.raceLanes : [];
      const lanes = rawLanes
        .map((lane) => {
          const swimmer = lane.laneSwimmer ?? undefined;
          const swimmerName =
            (swimmer && swimmer.swimmerName) ??
            lane.laneRelayTeamName ??
            "";
          const teamAbbreviation = extractTeamAbbreviation(lane);
          const relayNames = extractRelayNames(lane);
          return {
            laneNumber: Number(lane.laneNumber),
            swimmerName,
            teamAbbreviation,
            relayNames,
          };
        })
        .filter((l) => l.laneNumber > 0);

      heats.push({
        eventNumber: Number(race.raceEventNumber),
        heatNumber: Number(race.raceHeatNumber),
        lanes,
      });
    }
  }

  // Unique team abbreviations across every lane in every race.
  const teamSet = new Set();
  for (const h of heats) {
    for (const l of h.lanes) {
      if (l.teamAbbreviation) teamSet.add(l.teamAbbreviation);
    }
  }
  const teams = Array.from(teamSet).sort();

  const hostTeamName = String(obj.meetHostTeamName ?? "");
  const hostAbbr = deriveHostAbbreviation(hostTeamName, teams);
  const visitingTeams = teams.filter((t) => t !== hostAbbr);

  // Auto-detect meet type from the number of unique teams: 2 → dual, 3+ → standard.
  const meetType = teams.length >= 3 ? "standard" : "dual";

  return {
    meetName: String(obj.meetName ?? ""),
    meetStartDate: String(obj.meetStartDate ?? ""),
    hostTeamName,
    hostAbbr,
    teams,
    visitingTeams,
    laneCount,
    events,
    heats,
    meetType,
  };
}

// ── timing_system_configuration.json parsing ─────────────────────────────────

function parseTimingConfig(json) {
  const obj = json ?? {};
  const numberOfLanes =
    obj.numberOfLanes !== undefined && obj.numberOfLanes !== null
      ? Number(obj.numberOfLanes)
      : null;
  const timingSystemType =
    obj.timingSystemType != null ? String(obj.timingSystemType) : null;
  const currentEvent =
    obj.currentEvent !== undefined && obj.currentEvent !== null
      ? Number(obj.currentEvent)
      : null;
  const currentHeat =
    obj.currentHeat !== undefined && obj.currentHeat !== null
      ? Number(obj.currentHeat)
      : null;
  return { numberOfLanes, timingSystemType, currentEvent, currentHeat };
}

// Read + parse a JSON file from disk. Throws a friendly error on bad files.
function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error("Could not read the selected file.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
}

// ── Firestore writes ─────────────────────────────────────────────────────────

// Commit Firestore writes in chunks (Firestore caps batches at 500 ops). Mirror
// of commitBatches() in the web app importer.
async function commitBatches(db, items, makeRef, makeData) {
  const CHUNK = 450;
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const item of items.slice(i, i + CHUNK)) {
      batch.set(makeRef(item), makeData(item));
    }
    await batch.commit();
  }
}

// Authorized-teams gate. Mirrors the web app's config/authorizedTeams allowlist
// (see app/monitor/page.tsx for the doc shape: teams is an array of either a
// legacy plain-string abbreviation, treated as active, or a TeamObject
// { abbreviation, teamName, status: "active"|"suspended", comp, addedAt }).
//
// A meet proceeds only if one of its teams is on the list AND that entry's
// status is "active" or "comp". A suspended (or any other non-allowed) status is
// treated like an unauthorized team. We FAIL OPEN in every ambiguous case —
// missing/empty/unreadable allowlist, or no teams in the file — so legitimate
// meets are never blocked by a config glitch. Comparison is case-insensitive.
// Throws an Error (caught by the IPC handler and shown in the wizard UI) when
// the meet has no authorized team.
async function assertAuthorizedTeams(db, teams) {
  const importedTeams = (teams || [])
    .map((t) => String(t).trim().toUpperCase())
    .filter(Boolean);
  if (importedTeams.length === 0) return; // nothing to check

  let entries; // [{ abbr, status }] — one per allowlist entry
  try {
    const snap = await getDoc(doc(db, "config", "authorizedTeams"));
    if (!snap.exists()) return; // no allowlist → fail open
    const raw = snap.data().teams;
    if (!Array.isArray(raw)) return; // unexpected shape → fail open
    entries = raw
      .map((t) => {
        // Legacy plain string → abbreviation only, implicitly active.
        if (typeof t === "string") {
          return { abbr: t.trim().toUpperCase(), status: "active" };
        }
        if (t && typeof t === "object") {
          const abbr = String(t.abbreviation ?? "").trim().toUpperCase();
          // Missing status defaults to active (objects predating the field).
          const status = String(t.status ?? "active").trim().toLowerCase();
          return { abbr, status };
        }
        return { abbr: "", status: "" };
      })
      .filter((e) => e.abbr);
  } catch {
    return; // could not read the allowlist → fail open
  }

  if (entries.length === 0) return; // empty allowlist → fail open

  const ALLOWED_STATUSES = new Set(["active", "comp"]);
  const allowedAbbrs = new Set(
    entries.filter((e) => ALLOWED_STATUSES.has(e.status)).map((e) => e.abbr),
  );
  const presentAbbrs = new Set(entries.map((e) => e.abbr));

  // A matching team with active/comp status authorizes the meet.
  if (importedTeams.some((t) => allowedAbbrs.has(t))) return;

  // The team is on the list but its only matching entries are suspended (or some
  // other non-allowed status) → specific suspended message.
  if (importedTeams.some((t) => presentAbbrs.has(t))) {
    throw new Error(
      "Your team's DQSync access is suspended. Contact DQSync to restore access.",
    );
  }

  // No imported team is on the list at all → original unauthorized message.
  throw new Error(
    `No authorized teams found in this meet file. ` +
    `Teams found: ${importedTeams.join(", ")}. ` +
    `Contact DQSync to authorize your team before creating a meet.`,
  );
}

// Find the default codeset id (LSA 2023) so DQ pages resolve infractions the
// same way as a web-app-created meet. Codesets are global and already seeded in
// production by the web app, so we just look them up rather than re-seeding.
async function findDefaultCodesetId(db) {
  try {
    const snap = await getDocs(collection(db, "codesets"));
    if (snap.empty) return null;
    const docs = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    const def = docs.find((c) => c.isDefault) ?? docs[0];
    return def ? def.id : null;
  } catch {
    return null;
  }
}

/**
 * Create the meet and import everything.
 *
 * @param db        Firestore instance
 * @param parsed    result of parseMeetDetails()
 * @param opts      { meetType, createdByName, agentVersion }
 * @returns         { meetId, meetName, pin, adminPin, coachWord, meetType }
 */
async function createMeet(db, parsed, opts = {}) {
  // Block creation up front if none of the meet's teams are authorized. Throws
  // before any Firestore read/write so nothing is created for an unauthorized meet.
  await assertAuthorizedTeams(db, parsed.teams);

  const meetType = opts.meetType === "standard" ? "standard" : "dual";
  const pin = generatePin();
  const adminPin = generateAdminPin(pin);
  const coachWord = generateCoachWord();
  const codesetId = await findDefaultCodesetId(db);

  // ── 1. Meet doc (mirror of app/referee/create/page.tsx meetData) ──
  const meetData = {
    name: parsed.meetName || "Untitled Meet",
    date: parsed.meetStartDate || "",
    pin,
    adminPin,
    coachWord,
    status: "active",
    laneCount: parsed.laneCount > 0 ? parsed.laneCount : 6,
    // meetMode is the field every role page reads. meetType is written too to
    // satisfy the wizard spec; both carry the same "dual" | "standard" value.
    meetMode: meetType,
    meetType,
    zones: [],
    ...(codesetId ? { codesetId } : {}),
    // Team metadata the coach view + monitor rely on.
    ...(parsed.teams.length > 0 ? { teams: parsed.teams } : {}),
    ...(parsed.hostTeamName ? { hostTeamName: parsed.hostTeamName } : {}),
    createdAt: serverTimestamp(),
    createdByName: opts.createdByName || "DQSync Agent",
    createdVia: "agent-wizard",
  };
  const ref = await addDoc(collection(db, "meets"), meetData);
  const meetId = ref.id;

  // ── 2. Events (same doc id + shape as the web importer) ──
  await commitBatches(
    db,
    parsed.events,
    (e) => doc(db, "meets", meetId, "events", String(e.eventNumber)),
    (e) => ({ eventNumber: e.eventNumber, eventLabel: e.eventLabel, stroke: e.stroke }),
  );

  // ── 3. Heats (same doc id + shape as the web importer) ──
  await commitBatches(
    db,
    parsed.heats,
    (h) => doc(db, "meets", meetId, "heats", `${String(h.eventNumber)}_${String(h.heatNumber)}`),
    (h) => ({ eventNumber: h.eventNumber, heatNumber: h.heatNumber, lanes: h.lanes }),
  );

  // ── 4. Set the meet's starting heat (fresh import → first heat) ──
  const sortedHeats = [...parsed.heats].sort(
    (a, b) => a.eventNumber - b.eventNumber || a.heatNumber - b.heatNumber,
  );
  const firstHeat = sortedHeats[0];
  const firstEvent = firstHeat
    ? parsed.events.find((e) => e.eventNumber === firstHeat.eventNumber)
    : null;
  if (firstHeat) {
    const meetUpdate = {
      currentEvent: firstHeat.eventNumber,
      currentHeat: firstHeat.heatNumber,
    };
    if (firstEvent && firstEvent.stroke) meetUpdate.currentStroke = firstEvent.stroke;
    await updateDoc(doc(db, "meets", meetId), meetUpdate);
  }

  return { meetId, meetName: meetData.name, pin, adminPin, coachWord, meetType };
}

/**
 * Re-import events + heats ONLY for an existing meet (Admin → "Update meet
 * file"). Replaces the events and heats subcollections wholesale — old docs are
 * deleted first so a shortened schedule doesn't leave stragglers — but the meet
 * doc (PINs, meetMode, hostTeamName, currentEvent…) and the dqs collection are
 * left completely untouched.
 *
 * @returns { eventCount, heatCount }
 */
async function reimportEventsAndHeats(db, meetId, parsed) {
  // Block re-import if none of the new file's teams are authorized — this also
  // writes to Firestore and could overwrite a meet with unauthorized data.
  await assertAuthorizedTeams(db, parsed.teams);

  // 1. Delete every existing doc in events + heats.
  for (const sub of ["events", "heats"]) {
    const snap = await getDocs(collection(db, "meets", meetId, sub));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      for (const d of docs.slice(i, i + 450)) batch.delete(d.ref);
      await batch.commit();
    }
  }

  // 2. Write the freshly parsed events + heats (same doc ids + shapes as createMeet).
  await commitBatches(
    db,
    parsed.events,
    (e) => doc(db, "meets", meetId, "events", String(e.eventNumber)),
    (e) => ({ eventNumber: e.eventNumber, eventLabel: e.eventLabel, stroke: e.stroke }),
  );
  await commitBatches(
    db,
    parsed.heats,
    (h) => doc(db, "meets", meetId, "heats", `${String(h.eventNumber)}_${String(h.heatNumber)}`),
    (h) => ({ eventNumber: h.eventNumber, heatNumber: h.heatNumber, lanes: h.lanes }),
  );

  return { eventCount: parsed.events.length, heatCount: parsed.heats.length };
}

module.exports = {
  parseMeetDetails,
  parseTimingConfig,
  readJsonFile,
  createMeet,
  reimportEventsAndHeats,
  buildJoinUrl,
  buildCoachUrl,
  // exported for potential reuse / testing
  deriveHostAbbreviation,
  generatePin,
  generateAdminPin,
  generateCoachWord,
};
