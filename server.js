// ==========================================
//   RK RAJA XWD - Facebook Auto Sender Backend
// ==========================================

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { login } = require("anuragxarohi"); // npm install anuragxarohi

// ---------- ⚙️ CONFIG ----------
const CONFIG = {
  headerName: "RK RAJA XWD",
  timeInterval: 8000,          // Har message ke beech gap (ms)
  appStateFile: "appstate.json",
  inputFile: "targets.txt",
  fileFormat: "pipe",          // "pipe" (|) or "csv" (,)
  autoStart: true,
  port: 3000,
};
// --------------------------------

// ---------- 🌐 SERVER SETUP ----------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server);

// ---------- 📊 LIVE STATS ----------
const stats = {
  header: CONFIG.headerName,
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
  logs: [],
  status: "idle",   // idle | running | paused | stopped | done
};

function pushLog(type, msg) {
  const time = new Date().toLocaleTimeString();
  const entry = { time, type, msg };
  stats.logs.push(entry);
  if (stats.logs.length > 200) stats.logs.shift();
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

setInterval(() => {
  updateElapsed();
  io.emit("stats", stats);
}, 1000);

// ---------- 📥 LOAD TARGETS ----------
function loadTargets() {
  const filePath = path.resolve(CONFIG.inputFile);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File nahi mili: ${filePath}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    let uid, message;
    if (CONFIG.fileFormat === "pipe") {
      [uid, message] = line.split("|").map((s) => s.trim());
    } else {
      if (i === 0 && line.toLowerCase().startsWith("uid")) continue;
      const p = line.split(",");
      uid = p[0]?.trim();
      message = p.slice(1).join(",").trim();
    }
    if (uid && message) out.push({ uid, message });
  }
  return out;
}

// ---------- 🔐 LOGIN + AUTO START ----------
let api = null;
let targets = [];
let currentIndex = 0;
let isRunning = false;
let isStopped = false;
let isPaused = false;

function boot() {
  targets = loadTargets();
  stats.totalLines = targets.length;
  console.log(`📄 Loaded ${targets.length} lines.`);

  const appState = JSON.parse(fs.readFileSync(CONFIG.appStateFile, "utf8"));
  console.log("🔐 Logging in with cookies...");

  login({ appState }, { online: true, selfListen: false }, (err, apiInstance) => {
    if (err) {
      console.error("❌ Login failed:", err);
      pushLog("error", "Login failed: " + (err.error || err));
      return;
    }
    api = apiInstance;
    stats.loggedIn = true;
    stats.userId = api.getCurrentUserID();
    pushLog("success", `Login OK → UID ${stats.userId}`);
    io.emit("stats", stats);

    if (CONFIG.autoStart) setTimeout(startSending, 1500);
  });
}

// ---------- 🚀 SEND LOOP ----------
function startSending() {
  if (isRunning) return;
  if (currentIndex >= targets.length) {
    stats.status = "done";
    pushLog("info", "✅ Saare messages already send ho chuke.");
    io.emit("stats", stats);
    return;
  }
  isRunning = true;
  isStopped = false;
  isPaused = false;
  stats.startedAt = Date.now();
  stats.status = "running";
  pushLog("info", "🚀 Auto-send shuru...");
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
      pushLog("error", `❌ [${currentIndex + 1}] ${uid} → Fail`);
    } else {
      stats.sent++;
      pushLog("success", `✅ [${currentIndex + 1}/${targets.length}] ${uid} → Sent`);
    }
    io.emit("stats", stats);
    currentIndex++;
    setTimeout(sendNext, CONFIG.timeInterval);
  });
}

// ---------- 🎮 SOCKET EVENTS ----------
io.on("connection", (socket) => {
  socket.emit("stats", stats);
  stats.logs.forEach((l) => socket.emit("log", l));

  socket.on("start", () => startSending());
  socket.on("pause", () => {
    isPaused = true;
    stats.status = "paused";
    pushLog("warn", "⏸️ Paused");
    io.emit("stats", stats);
  });
  socket.on("resume", () => {
    isPaused = false;
    stats.status = "running";
    pushLog("info", "▶️ Resumed");
    io.emit("stats", stats);
    sendNext();
  });
  socket.on("stop", () => {
    isRunning = false;
    isStopped = true;
    stats.status = "stopped";
    pushLog("warn", `🛑 Stopped at ${currentIndex}/${targets.length}`);
    io.emit("stats", stats);
  });
});

// ---------- ▶️ GO ----------
server.listen(CONFIG.port, () => {
  console.log(`\n🌐 Dashboard: http://localhost:${CONFIG.port}\n`);
  boot();
});
