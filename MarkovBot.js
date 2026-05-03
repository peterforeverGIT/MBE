const fs = require("fs");
const WebSocket = require("ws");

const BOT_NAME = "MarkovBot";
const SAVE_DIR = "/storage/emulated/0/Download/eu";
const SAVE_FILE = `${SAVE_DIR}/MarkovBot_Save.json`;
const ROOMS = ["xkcd", "b", "xlcd", "test", "bots"];

// ---------------- STATE ----------------
let brain = { 2: {}, 3: {}, 4: {} };
let roomState = {};
let sockets = {};
let reconnectTimers = {};

// ---------------- INIT ----------------
if (!fs.existsSync(SAVE_DIR)) {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
}

// ---------------- LOG ----------------
const log = (...a) =>
  console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

// ---------------- CLEAN ----------------
function clean(text) {
  if (!text) return "";
  if (text.trim().startsWith("{")) return "";

  return text
    .replace(/[{}\[\]"]/g, "")
    .replace(/[^\w\s.!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ---------------- SAVE / LOAD ----------------
function save() {
  fs.writeFileSync(SAVE_FILE, JSON.stringify({ brain, roomState }, null, 2));
}

function migrate(oldBrain) {
  const out = { 2: {}, 3: {}, 4: {} };

  for (const n of [2, 3, 4]) {
    const section = oldBrain?.[n] || {};

    for (const key in section) {
      const val = section[key];

      if (Array.isArray(val)) {
        out[n][key] = {};
        for (const w of val) {
          out[n][key][w] = (out[n][key][w] || 0) + 1;
        }
      } else if (typeof val === "object") {
        out[n][key] = val;
      }
    }
  }

  return out;
}

function load() {
  // Only load from SAVE_DIR (Download folder), never from local .json
  if (!fs.existsSync(SAVE_FILE)) {
    log("No save file found, starting fresh");
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (data.brain) brain = migrate(data.brain);
    if (data.roomState) roomState = data.roomState;
    log("Loaded brain from:", SAVE_FILE);
  } catch (e) {
    console.error("LOAD ERROR:", e);
    log("WARNING: Falling back to empty brain");
  }
}

// ---------------- TRAIN ----------------
function add(n, key, next) {
  if (!brain[n][key]) brain[n][key] = {};
  brain[n][key][next] = (brain[n][key][next] || 0) + 1;
}

function train(text) {
  const w = clean(text).split(/\s+/).filter(Boolean);
  w.push(".");

  for (let i = 0; i < w.length - 2; i++)
    add(2, `${w[i]} ${w[i + 1]}`, w[i + 2]);

  for (let i = 0; i < w.length - 3; i++)
    add(3, `${w[i]} ${w[i + 1]} ${w[i + 2]}`, w[i + 3]);

  for (let i = 0; i < w.length - 4; i++)
    add(4, `${w[i]} ${w[i + 1]} ${w[i + 2]} ${w[i + 3]}`, w[i + 4]);
}

// ---------------- TRANSFORMER-LITE ----------------
function collect(ctx) {
  const c = {};

  function pull(n, weight) {
    if (ctx.length < n) return;

    const key = ctx.slice(-n).join(" ");
    const bucket = brain[n][key];
    if (!bucket) return;

    for (const w in bucket) {
      c[w] = (c[w] || 0) + bucket[w] * weight;
    }
  }

  pull(4, 3);
  pull(3, 2);
  pull(2, 1);

  return c;
}

function sample(cands) {
  const entries = Object.entries(cands);
  if (!entries.length) return null;

  let sum = 0;
  for (const [, v] of entries) sum += v;

  let r = Math.random() * sum;

  for (const [w, v] of entries) {
    r -= v;
    if (r <= 0) return w;
  }

  return entries[0][0];
}

// ---------------- GENERATE (FIXED CONTINUATION) ----------------
function generate(seed, sender) {
  const base = clean(seed).split(/\s+/).filter(Boolean);
  if (base.length < 2) return "need at least 2 words";

  const out = [...base];

  let sentenceCount = 0;

  for (let i = 0; i < 90; i++) {
    const cands = collect(out);
    let next = sample(cands);
    if (!next) break;

    if (next === ".") {
      sentenceCount++;

      // ✅ KEY FIX: 75% chance to continue after sentence
      if (Math.random() < 0.75) {
        continue; // do NOT stop generation
      } else {
        break;
      }
    }

    if (next === "someone") next = sender.toLowerCase();
    out.push(next);
  }

  return out.join(" ");
}

// ---------------- SEND ----------------
function send(ws, content, parent) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: "send",
    data: { content, parent }
  }));
}

// ---------------- COMMANDS ----------------
function handle(ws, text, sender, parent, room) {
  const lower = text.toLowerCase();

  // 1. HELP FIRST (highest priority) - bypass word count check
  if (lower.startsWith("!help") || lower.includes("@markovbot") && lower.includes("help")) {
    send(
      ws,
      "MarkovBot (transformer-lite)\n!markov [text]\n!ping\n/send [thread|null] [msg]\nMade by peterforever",
      parent
    );
    return true;
  }

  // 2. PING
  if (lower === "!ping") {
    send(ws, "pong", parent);
    return true;
  }

  // 3. MARKOV ONLY IF REAL SEED EXISTS
  if (lower.startsWith("!markov")) {
    const seed = text.replace(/!markov/i, "").trim();
    if (!seed) return true; // stop silently instead of error

    const reply = generate(seed, sender);
    send(ws, reply, parent);
    return true;
  }

  // 4. MENTION TRIGGER (SAFE) - bypass word count check for @markovbot
  if (lower.includes("@markovbot")) {
    const cleaned = text.replace(/@markovbot/i, "").trim();
    
    // If just @markovbot with no args, respond with help instead of error
    if (!cleaned || cleaned.split(/\s+/).length < 2) {
      send(
        ws,
        "MarkovBot (transformer-lite)\n!markov [text]\n!ping\n/send [thread|null] [msg]\nMade by peterforever",
        parent
      );
      return true;
    }

    const reply = generate(cleaned, sender);
    send(ws, reply, parent);
    return true;
  }

  return false;
}

// ---------------- CONNECT ----------------
function connect(room) {
  if (sockets[room]) return;

  log("Connecting:", room);

  const ws = new WebSocket(`wss://euphoria.leet.nu/room/${room}/ws`);
  sockets[room] = ws;

  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "nick",
      data: { name: BOT_NAME }
    }));
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "send-event") return;

      const d = msg.data || {};
      const text = d.content || "";
      const sender = d.sender?.name || "unknown";
      const parent = d.parent || d.id;

      log(room, "THREAD:", parent, "|", sender, ":", text);

      if (sender.toLowerCase() === BOT_NAME.toLowerCase()) return;

      const handled = handle(ws, text, sender, parent, room);

      if (!handled && !text.startsWith("peter's_terminal:")) {
        train(text);
      }

    } catch (e) {
      console.error("PARSE ERROR:", e);
    }
  });

  ws.on("close", () => {
    log("Disconnected:", room);
    delete sockets[room];

    if (!reconnectTimers[room]) {
      reconnectTimers[room] = setTimeout(() => {
        reconnectTimers[room] = null;
        connect(room);
      }, 4000);
    }
  });
}

// ---------------- TERMINAL ----------------
process.stdin.setEncoding("utf8");

process.stdin.on("data", (input) => {
  input = input.trim();

  if (input.startsWith("/send ")) {
    const parts = input.split(" ");
    const thread = parts[1] === "null" ? null : parts[1];
    const msg = parts.slice(2).join(" ");

    for (const r in sockets) {
      send(sockets[r], msg, thread);
      log("SENT ->", r, "| thread:", thread);
    }
  }

  if (input === "/save") save();

  if (input === "/rooms") console.log(Object.keys(sockets));

  if (input.startsWith("/join ")) connect(input.slice(6).trim());
});

// ---------------- START ----------------
process.on("SIGINT", () => {
  save();
  process.exit();
});

load();
ROOMS.forEach(connect);
