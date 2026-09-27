// ==========================================
//   RK RAJA XWD — Web Control Panel (No Files)
//   Cookies + Targets page se paste karo
// ==========================================

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { login } = require("anuragxarohi"); // npm install anuragxarohi

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);

// ---------- 📊 GLOBAL STATE ----------
let api = null;
let targets = [];         // [{uid, message}]
let currentIndex = 0;
let isRunning = false;
let isPaused = false;
let isStopped = false;
let timeInterval = 8000;  // default
let headerName = "RK RAJA XWD";

const stats = {
  header: headerName,
  loggedIn: false,
  userId: null,
  totalLines: 0,
  sent: 0,
  failed: 0,
  currentIndex: 0,
  currentUID: "",
  currentMsg: "",
  startedAt: null,
  elapsed: "00:00:00",
  status: "idle",
  logs: [],
};

function pushLog(type, msg) {
  const entry = { time: new Date().toLocaleTimeString(), type, msg };
  stats.logs.push(entry);
  if (stats.logs.length > 300) stats.logs.shift();
  io.emit("log", entry);
}
function updateElapsed() {
  if (!stats.startedAt) return;
  const ms = Date.now() - stats.startedAt;
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  stats.elapsed = `${h}:${m}:${s}`;
}
setInterval(() => { updateElapsed(); io.emit("stats", stats); }, 1000);

// ---------- 📥 PARSE TARGETS (from textarea) ----------
function parseTargets(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length >= 2 && parts[0] && parts[1]) {
      out.push({ uid: parts[0], message: parts.slice(1).join(" | ") });
    }
  }
  return out;
}

// ---------- 🔐 COOKIES PARSER ----------
// Accepts either JSON array of cookies or raw cookie string
function parseCookies(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    // JSON appstate
    return JSON.parse(trimmed);
  }
  // Raw cookie string → convert to appstate format
  return trimmed
    .split(";")
    .map((c) => {
      const [key, ...v] = c.trim().split("=");
      return { key: key?.trim(), value: v.join("=")?.trim(), domain: ".facebook.com", path: "/" };
    })
    .filter((c) => c.key && c.value);
}

// ---------- 🚀 /api/run ----------
app.post("/api/run", (req, res) => {
  const { cookies, targetsText, interval, header } = req.body;

  if (!cookies || !targetsText) {
    return res.status(400).json({ ok: false, error: "Cookies aur targets dono zaroori hain." });
  }

  // Reset state
  stats.sent = 0;
  stats.failed = 0;
  stats.currentIndex = 0;
  stats.currentUID = "";
  stats.currentMsg = "";
  stats.startedAt = null;
  stats.elapsed = "00:00:00";
  stats.status = "idle";
  stats.logs = [];
  currentIndex = 0;
  isRunning = false;
  isPaused = false;
  isStopped = false;

  headerName = header || "RK RAJA XWD";
  stats.header = headerName;
  timeInterval = Math.max(2000, parseInt(interval) || 8000);

  targets = parseTargets(targetsText);
  stats.totalLines = targets.length;
  if (targets.length === 0) {
    return res.status(400).json({ ok: false, error: "Targets parse nahi hue. Format: UID | Message" });
  }

  let appState;
  try {
    appState = parseCookies(cookies);
    if (!appState.length) throw new Error("Empty cookies");
  } catch (err) {
    return res.status(400).json({ ok: false, error: "Cookies format galat: " + err.message });
  }

  pushLog("info", `📄 ${targets.length} targets mili. Cookies OK.`);
  pushLog("info", "🔐 Facebook se login ho raha hai...");
  io.emit("stats", stats);

  // Login
  login({ appState }, { online: true, selfListen: false }, (err, apiInstance) => {
    if (err) {
      pushLog("error", "❌ Login fail: " + (err.error || err));
      stats.status = "stopped";
      io.emit("stats", stats);
      return res.json({ ok: false, error: "Login failed. Cookies check karo." });
    }
    api = apiInstance;
    stats.loggedIn = true;
    stats.userId = api.getCurrentUserID();
    pushLog("success", `✅ Login OK → UID ${stats.userId}`);
    io.emit("stats", stats);

    res.json({ ok: true, userId: stats.userId, total: targets.length });

    // Auto-start after 1s
    setTimeout(startSending, 1000);
  });
});

// ---------- 🚀 SEND LOOP ----------
function startSending() {
  if (isRunning || !api) return;
  if (currentIndex >= targets.length) {
    stats.status = "done";
    pushLog("success", "🎉 Saare messages send ho gaye!");
    io.emit("stats", stats);
    return;
  }
  isRunning = true;
  isStopped = false;
  isPaused = false;
  stats.startedAt = Date.now();
  stats.status = "running";
  pushLog("info", `🚀 Auto-send shuru → interval ${timeInterval}ms`);
  io.emit("stats", stats);
  sendNext();
}

function sendNext() {
  if (isStopped || !isRunning || isPaused) return;
  if (currentIndex >= targets.length) {
    isRunning = false;
    stats.status = "done";
    stats.currentUID = "";
    stats.currentMsg = "";
    pushLog("success", "🎉 Saare messages send ho gaye!");
    io.emit("stats", stats);
    return;
  }

  const { uid, message } = targets[currentIndex];
  stats.currentUID = uid;
  stats.currentMsg = message;
  stats.currentIndex = currentIndex + 1;
  io.emit("stats", stats);

  api.sendMessageMqtt({ body: message }, uid, (err) => {
    if (err) {
      stats.failed++;
      pushLog("error", `❌ [${currentIndex + 1}/${targets.length}] ${uid} → Fail`);
    } else {
      stats.sent++;
      pushLog("success", `✅ [${currentIndex + 1}/${targets.length}] ${uid} → Sent`);
    }
    io.emit("stats", stats);
    currentIndex++;
    setTimeout(sendNext, timeInterval);
  });
}

// ---------- 🎮 SOCKET ----------
io.on("connection", (socket) => {
  socket.emit("stats", stats);
  stats.logs.forEach((l) => socket.emit("log", l));

  socket.on("pause", () => {
    if (!isRunning) return;
    isPaused = true;
    stats.status = "paused";
    pushLog("warn", "⏸️ Paused");
    io.emit("stats", stats);
  });
  socket.on("resume", () => {
    if (!isRunning) return;
    isPaused = false;
    stats.status = "running";
    pushLog("info", "▶️ Resumed");
    io.emit("stats", stats);
    sendNext();
  });
  socket.on("stop", () => {
    if (!isRunning) return;
    isRunning = false;
    isStopped = true;
    stats.status = "stopped";
    pushLog("warn", `🛑 Stopped at ${currentIndex}/${targets.length}`);
    io.emit("stats", stats);
  });
});

// ---------- ▶️ START SERVER ----------
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n🌐 Dashboard: http://localhost:${PORT}\n`);
});
