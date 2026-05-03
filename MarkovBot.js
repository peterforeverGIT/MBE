const fs = require("fs");
const WebSocket = require("ws");

// ---------------- CONFIG ----------------
const BOT_NAME = "MarkovBot";
const SAVE_DIR = "/storage/emulated/0/Download/eu";
const SAVE_FILE = `${SAVE_DIR}/MarkovBot_Save.json`;
const ROOMS = ["xkcd", "b", "xlcd", "test", "bots"];

// ---------------- STATE ----------------
let brain = { 2: {}, 3: {}, 4: {} };
let roomState = {};
let sockets = {};
let reconnectTimers = {};

// ---------------- INIT STORAGE ----------------
if (!fs.existsSync(SAVE_DIR)) {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
}

// ---------------- LOG ----------------
const log = (...a) =>
  console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

// ---------------- CLEAN TEXT ----------------
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

// ---------------- SAVE ----------------
function save() {
  fs.writeFileSync(SAVE_FILE, JSON.stringify({ brain, roomState }, null, 2));
  log("Saved ->", SAVE_FILE);
}

// ---------------- MIGRATION ----------------
function migrate(oldBrain) {
  const out = { 2: {}, 3: {}, 4: {} };

  for (const n of [2, 3, 4]) {
    const section = oldBrain?.[n] || {};

    for (const key in section) {
      const val = section[key];

      // OLD FORMAT: array
      if (Array.isArray(val)) {
        out[n][key] = {};
        for (const w of val) {
          out[n][key][w] = (out[n][key][w] || 0) + 1;
        }
      }

      // NEW FORMAT: weighted map
      else if (typeof val === "object") {
        out[n][key] = val;
      }
    }
  }

  return out;
}

// ---------------- LOAD ----------------
function load() {
  if (!fs.existsSync(SAVE_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));

    if (data.brain) brain = migrate(data.brain);
    if (data.roomState) roomState = data.roomState;

    log("Loaded + migrated brain");
  } catch (e) {
    console.error("LOAD ERROR:", e);
  }
}

// ---------------- TRAINING ----------------
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

// ---------------- TRANSFORMER-LITE SAMPLING ----------------
function collectCandidates(ctx) {
  const cands = {};

  function pull(n, weight) {
    if (ctx.length < n) return;
    const key = ctx.slice(-n).join(" ");
    const bucket = brain[n][key];
    if (!bucket) return;

    for (const w in bucket) {
      cands[w] = (cands[w] || 0) + bucket[w] * weight;
    }
  }

  pull(4, 3);
  pull(3, 2);
  pull(2, 1);

  return cands;
}

function sample(cands) {
  const entries = Object.entries(cands);
  if (!entries.length) return null;

  let sum = 0;
  for (const [, v] of entries) sum += v;

  let r = Math.random() * sum;

  for (const [word, v] of entries) {
    r -= v;
    if (r <= 0) return word;
  }

  return entries[0][0];
}

// ---------------- GENERATE ----------------
function generate(seed, sender) {
  const base = clean(seed).split(/\s+/).filter(Boolean);
  if (base.length < 2) return "need at least 2 words";

  const out = [...base];

  for (let i = 0; i < 70; i++) {
    const cands = collectCandidates(out);
    let next = sample(cands);
    if (!next) break;

    if (next === "." && Math.random() < 0.15) break;
    if (next === ".") continue;

    if (next === "someone") next = sender.toLowerCase();
    out.push(next);
  }

  return out.join(" ");
}

// ---------------- SEND (HEIM STYLE) ----------------
function send(ws, content, parent) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: "send",
    data: { content, parent }
  }));
}

// ---------------- COMMAND HANDLER ----------------
function handle(ws, text, sender, parent, room) {
  const lower = text.toLowerCase();

  if (lower === "!ping") {
    send(ws, "pong", parent);
    return true;
  }

  if (lower.startsWith("!help")) {
    send(
      ws,
      "MarkovBot (transformer-lite hybrid)\n!markov [text]\n!ping\n/send [thread|null] [msg]\nMade by peterforever | unstable hosting",
      parent
    );
    return true;
  }

  if (lower.startsWith("!markov") || lower.includes("@markovbot")) {
    const seed = text
      .replace(/!markov/i, "")
      .replace(/@markovbot/i, "")
      .trim();

    if (!seed) return true;

    const reply = generate(seed, sender);
    send(ws, reply, parent);

    log(room, "THREAD:", parent, "| reply:", reply);
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

  // /send [thread|null] [message]
  if (input.startsWith("/send ")) {
    const parts = input.split(" ");
    const thread = parts[1] === "null" ? null : parts[1];
    const msg = parts.slice(2).join(" ");

    for (const r in sockets) {
      send(sockets[r], msg, thread);
      log("SENT ->", r, "| thread:", thread, "| msg:", msg);
    }
  }

  if (input === "/save") {
    save();
  }

  if (input === "/rooms") {
    console.log(Object.keys(sockets));
  }

  if (input.startsWith("/join ")) {
    connect(input.slice(6).trim());
  }
});

// ---------------- START ----------------
process.on("SIGINT", () => {
  save();
  process.exit();
});

load();
ROOMS.forEach(connect);
