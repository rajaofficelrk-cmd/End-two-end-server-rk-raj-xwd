// ==========================================
// RK RAJA XWD — Web Control Panel
// Render Ready / Safe Demo Server
// ==========================================

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);

// ---------- GLOBAL STATE ----------
let targets = [];
let currentIndex = 0;
let isRunning = false;
let isPaused = false;
let isStopped = false;
let timeInterval = 8000;
let headerName = "RK RAJA XWD";

const stats = {
  header: headerName,
  totalLines: 0,
  sent: 0,
  failed: 0,
  currentIndex: 0,
  currentUID: "",
  currentMsg: "",
  startedAt: null,
  elapsed: "00:00:00",
  status: "idle",
  logs: []
};

// ---------- LOGGING ----------
function pushLog(type, msg) {
  const entry = {
    time: new Date().toLocaleTimeString(),
    type,
    msg
  };

  stats.logs.push(entry);

  if (stats.logs.length > 300) {
    stats.logs.shift();
  }

  io.emit("log", entry);
}

// ---------- ELAPSED TIME ----------
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

// ---------- PARSE TARGETS ----------
function parseTargets(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];

  for (const raw of lines) {
    const line = raw.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const parts = line.split("|").map(s => s.trim());

    if (parts.length >= 2 && parts[0] && parts[1]) {
      out.push({
        uid: parts[0],
        message: parts.slice(1).join(" | ")
      });
    }
  }

  return out;
}

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "RK RAJA XWD",
    status: stats.status,
    uptime: process.uptime()
  });
});

// ---------- START DEMO ----------
app.post("/api/run", (req, res) => {
  const {
    targetsText,
    interval,
    header
  } = req.body || {};

  if (!targetsText) {
    return res.status(400).json({
      ok: false,
      error: "Targets zaroori hain."
    });
  }

  targets = parseTargets(targetsText);

  if (targets.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "Targets parse nahi hue. Format: UID | Message"
    });
  }

  currentIndex = 0;
  isRunning = false;
  isPaused = false;
  isStopped = false;

  stats.sent = 0;
  stats.failed = 0;
  stats.currentIndex = 0;
  stats.currentUID = "";
  stats.currentMsg = "";
  stats.startedAt = null;
  stats.elapsed = "00:00:00";
  stats.status = "idle";
  stats.logs = [];

  headerName = header || "RK RAJA XWD";
  stats.header = headerName;

  timeInterval = Math.max(
    1000,
    parseInt(interval, 10) || 8000
  );

  stats.totalLines = targets.length;

  pushLog(
    "info",
    `📄 ${targets.length} targets loaded.`
  );

  pushLog(
    "info",
    "🧪 Demo mode ready — no external messages are sent."
  );

  io.emit("stats", stats);

  res.json({
    ok: true,
    total: targets.length,
    mode: "demo"
  });

  setTimeout(startDemo, 500);
});

// ---------- DEMO LOOP ----------
function startDemo() {
  if (isRunning) return;

  if (currentIndex >= targets.length) {
    stats.status = "done";
    io.emit("stats", stats);
    return;
  }

  isRunning = true;
  isStopped = false;
  isPaused = false;

  stats.startedAt = Date.now();
  stats.status = "running";

  pushLog(
    "info",
    `🚀 Demo started → interval ${timeInterval}ms`
  );

  io.emit("stats", stats);

  processNextDemo();
}

function processNextDemo() {
  if (isStopped || !isRunning || isPaused) {
    return;
  }

  if (currentIndex >= targets.length) {
    isRunning = false;

    stats.status = "done";
    stats.currentUID = "";
    stats.currentMsg = "";

    pushLog(
      "success",
      "🎉 Demo completed."
    );

    io.emit("stats", stats);
    return;
  }

  const target = targets[currentIndex];

  stats.currentUID = target.uid;
  stats.currentMsg = target.message;
  stats.currentIndex = currentIndex + 1;

  io.emit("stats", stats);

  // Safe demo: nothing is sent externally.
  setTimeout(() => {
    if (isStopped || !isRunning || isPaused) {
      return;
    }

    stats.sent++;

    pushLog(
      "success",
      `✅ [${currentIndex + 1}/${targets.length}] ${target.uid} → Demo processed`
    );

    currentIndex++;

    io.emit("stats", stats);

    setTimeout(
      processNextDemo,
      timeInterval
    );
  }, 300);
}

// ---------- SOCKET.IO ----------
io.on("connection", socket => {
  socket.emit("stats", stats);

  stats.logs.forEach(log => {
    socket.emit("log", log);
  });

  socket.on("pause", () => {
    if (!isRunning) return;

    isPaused = true;
    stats.status = "paused";

    pushLog(
      "warn",
      "⏸️ Paused"
    );

    io.emit("stats", stats);
  });

  socket.on("resume", () => {
    if (!isRunning) return;

    isPaused = false;
    stats.status = "running";

    pushLog(
      "info",
      "▶️ Resumed"
    );

    io.emit("stats", stats);

    processNextDemo();
  });

  socket.on("stop", () => {
    if (!isRunning) return;

    isRunning = false;
    isStopped = true;
    isPaused = false;

    stats.status = "stopped";

    pushLog(
      "warn",
      `🛑 Stopped at ${currentIndex}/${targets.length}`
    );

    io.emit("stats", stats);
  });
});

// ---------- RENDER SERVER ----------
const PORT = Number(process.env.PORT) || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("================================");
  console.log("     RK RAJA XWD SERVER ONLINE");
  console.log("================================");
  console.log(`📡 Port: ${PORT}`);
  console.log("🌐 Listening on 0.0.0.0");
  console.log("================================");
});
