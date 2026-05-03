const fs = require("fs");
const WebSocket = require("ws");

const BOT_NAME = "MarkovBot";
const SAVE_FILE = "./MarkovBot_Save.json";
const DEFAULT_ROOMS = ["xkcd", "b", "xlcd", "test", "bots"];

let brain = { 2: {}, 3: {}, 4: {} };
let roomState = {};
let sockets = {};
let reconnectTimers = {};

function log(...a) {
  console.log("[" + new Date().toLocaleTimeString() + "]", ...a);
}

function ensureBrain() {
  if (!brain[2]) brain[2] = {};
  if (!brain[3]) brain[3] = {};
  if (!brain[4]) brain[4] = {};
}

function convertLegacyBrain(old) {
  const out = { 2: {}, 3: {}, 4: {} };

  if (old && (old[2] || old[3] || old[4])) {
    out[2] = old[2] || {};
    out[3] = old[3] || {};
    out[4] = old[4] || {};
    return out;
  }

  if (!old || typeof old !== "object") return out;

  for (const k in old) {
    if (!Array.isArray(old[k])) continue;

    const len = k.trim().split(/\s+/).length;
    if (len >= 2 && len <= 4) out[len][k] = old[k];
  }

  return out;
}

function saveAll() {
  try {
    fs.writeFileSync(
      SAVE_FILE,
      JSON.stringify({ brain, roomState }, null, 2)
    );
    console.log("Saved brain size:", Object.keys(brain[2]).length);
  } catch (e) {
    console.error("SAVE FAILED:", e);
  }
}

function loadSave() {
  if (!fs.existsSync(SAVE_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));

    brain = data.brain || { 2: {}, 3: {}, 4: {} };
    roomState = data.roomState || {};

    ensureBrain();

    console.log("Loaded brain:", Object.keys(brain[2] || {}).length);
  } catch (e) {
    console.error("LOAD FAILED:", e);
  }
}

function cleanText(text) {
  if (!text) return "";
  if (text.trim().startsWith("{")) return "";

  return text
    .replace(/[{}\[\]"]/g, "")
    .replace(/[^\w\s.!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function addGram(n, key, next) {
  if (!brain[n][key]) brain[n][key] = [];
  brain[n][key].push(next);

  if (brain[n][key].length > 25) {
    brain[n][key].shift();
  }
}

function train(text) {
  text = cleanText(text);
  if (!text) return;

  const w = text.split(/\s+/).filter(Boolean);
  w.push(".");

  if (w.length < 3) return;

  for (let i = 0; i < w.length - 2; i++) {
    addGram(2, w[i] + " " + w[i + 1], w[i + 2]);
  }

  for (let i = 0; i < w.length - 3; i++) {
    addGram(3, w[i] + " " + w[i + 1] + " " + w[i + 2], w[i + 3]);
  }

  for (let i = 0; i < w.length - 4; i++) {
    addGram(4, w[i] + " " + w[i + 1] + " " + w[i + 2] + " " + w[i + 3], w[i + 4]);
  }
}

function pick(words) {
  const l = words.length;

  if (l >= 4) {
    const k4 = words.slice(l - 4).join(" ");
    if (brain[4][k4] && Math.random() >= 0.05) return brain[4][k4];
  }

  if (l >= 3) {
    const k3 = words.slice(l - 3).join(" ");
    if (brain[3][k3]) return brain[3][k3];
  }

  if (l >= 2) {
    const k2 = words.slice(l - 2).join(" ");
    if (brain[2][k2]) return brain[2][k2];
  }

  return null;
}

function generate(seed, sender = "someone") {
  seed = cleanText(seed);
  const s = seed.split(/\s+/).filter(Boolean);

  if (s.length < 2) return "need at least 2 words";

  const result = s.slice();

  for (let i = 0; i < 80; i++) {
    const opts = pick(result);
    if (!opts || !opts.length) break;

    let next = opts[Math.floor(Math.random() * opts.length)];

    if (next === "." && Math.random() < 0.1) break;
    if (next === ".") continue;

    if (next === "someone") next = sender.toLowerCase();
    result.push(next);
  }

  return result.join(" ");
}

function send(ws, msg, parent) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(
    JSON.stringify({
      type: "send",
      data: {
        content: msg,
        parent,
      },
    })
  );
}

function scheduleReconnect(room) {
  if (reconnectTimers[room]) return;

  reconnectTimers[room] = setTimeout(() => {
    reconnectTimers[room] = null;
    connectRoom(room);
  }, 5000);
}

function connectRoom(room) {
  if (!room || sockets[room]) return;

  log("Connecting to", room);

  const ws = new WebSocket("wss://euphoria.leet.nu/room/" + room + "/ws");
  sockets[room] = ws;

  ws.on("open", () => {
    log("Connected to", room);

    ws.send(
      JSON.stringify({
        type: "nick",
        data: { name: BOT_NAME },
      })
    );
  });

  ws.on("message", (raw) => {
    try {
      const p = JSON.parse(raw.toString());

      if (p.type === "ping-event") {
        ws.send(
          JSON.stringify({
            type: "ping-reply",
            data: { time: p.data.time },
          })
        );
        return;
      }

      if (p.type !== "send-event") return;

      const d = p.data || {};
      const text = d.content || "";
      const sender = d.sender?.name || "unknown";
      const id = d.id || "";
      const parent = d.parent || id;

      roomState[room] = roomState[room] || {};
      roomState[room].lastThread = parent;

      log(room, "|", sender + ":", text);

      if (sender.toLowerCase() === BOT_NAME.toLowerCase()) return;

      const lower = text.toLowerCase();
      const mention = lower.includes("@" + BOT_NAME.toLowerCase());

      if (!lower.startsWith("!markov") && !text.startsWith("peter's_terminal:")) {
        train(text);
      }

      if (lower === "!ping") {
        send(ws, "pong!", parent);
        return;
      }

      if (lower === "!help") {
        send(ws, "MarkovBot | !markov [seed text]", parent);
        return;
      }

      if (lower.startsWith("!markov") || mention) {
        const seed = lower
          .replace("!markov", "")
          .replace("@" + BOT_NAME.toLowerCase(), "")
          .trim();

        if (!seed) return;

        const reply = generate(seed, sender);
        send(ws, reply, parent);
        log("Reply:", reply);
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error in", room, err.message || err);
  });

  ws.on("close", () => {
    log("Disconnected from", room);
    delete sockets[room];
    scheduleReconnect(room);
  });
}

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});

process.on("SIGINT", () => {
  log("Saving before exit...");
  saveAll();
  process.exit(0);
});

process.stdin.resume();
process.stdin.setEncoding("utf8");

process.stdin.on("data", (input) => {
  input = input.trim();

  if (input.startsWith("/join ")) {
    const room = input.substring(6).trim();
    if (room && !sockets[room]) connectRoom(room);
    return;
  }

  if (input.startsWith("/train ")) {
    const txt = input.substring(7).trim();
    train(txt);
    console.log("trained");
    return;
  }

  if (input === "/save") {
    saveAll();
    console.log("saved");
    return;
  }

  if (input === "/rooms") {
    console.log(Object.keys(sockets));
    return;
  }
});

const roomsToJoin = loadSave();
for (const room of roomsToJoin) {
  connectRoom(room);
}

setInterval(saveAll, 30000);

console.log("");
console.log("MarkovBot running.");
console.log("");
console.log("Commands:");
console.log("/join ROOM");
console.log("/train TEXT");
console.log("/save");
console.log("/rooms");
console.log("");
