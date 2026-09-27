// ==========================================
//   RK RAJA XWD — BACKEND SERVER
//   Facebook Cookie Loader + Mass Sender
// ==========================================

const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { login } = require("anuragxarohi"); // npm install anuragxarohi

const app = express();

// ---------- MIDDLEWARE ----------
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ---------- STATE ----------
const tasks = {};       // taskId -> task object
let taskCounter = 0;
const startTime = Date.now();

// ---------- HELPERS ----------
function now() {
  return new Date().toLocaleTimeString();
}

function parseCookies(input) {
  const t = (input || "").trim();
  if (!t) throw new Error("Empty cookies");

  // JSON appstate format
  if (t.startsWith("[")) {
    const arr = JSON.parse(t);
    if (!Array.isArray(arr)) throw new Error("Invalid appstate JSON");
    return arr;
  }

  // Raw cookie string → appstate
  return t
    .split(";")
    .map((c) => {
      const [key, ...rest] = c.trim().split("=");
      return {
        key: key?.trim(),
        value: rest.join("=")?.trim(),
        domain: ".facebook.com",
        path: "/",
        secure: true,
      };
    })
    .filter((c) => c.key && c.value);
}

function parseTargets(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const parts = l.split("|").map((s) => s.trim());
      if (parts.length < 2) return null;
      const uid = parts[0];
      const message = parts.slice(1).join(" | ");
      if (!uid || !message) return null;
      return { uid, message };
    })
    .filter(Boolean);
}

function broadcastLog(taskId, type, msg) {
  const entry = { taskId, time: now(), type, msg };
  console.log(`[${entry.time}] [${taskId || "SYS"}] ${msg}`);
  io.emit("log", entry);
}

function broadcastStats(task) {
  if (!task) return;
  io.emit("stats", {
    taskId: task.id,
    sent: task.sent,
    failed: task.failed,
    idx: task.idx,
    total: task.targets.length,
  });
}

// ---------- ROUTES ----------

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "RK RAJA XWD", uptime: process.uptime() });
});

// LIVE MONITOR
app.get("/api/monitor", (req, res) => {
  const activeTasks = Object.values(tasks).filter((t) => t.running).length;
  const totalSent = Object.values(tasks).reduce((s, t) => s + t.sent, 0);
  res.json({
    uptime: (Date.now() - startTime) / 1000,
    activeTasks,
    totalSent,
    totalTasks: Object.keys(tasks).length,
  });
});

// START TASK
app.post("/api/start", async (req, res) => {
  try {
    const {
      cookies,
      targetsText,
      threadId,
      delay,
      hatersName,
      lastName,
    } = req.body;

    // Validate
    if (!cookies) {
      return res.status(400).json({ ok: false, error: "Cookies required" });
    }
    if (!targetsText && !threadId) {
      return res.status(400).json({ ok: false, error: "Message file ya Thread ID required" });
    }

    // Parse cookies
    let appState;
    try {
      appState = parseCookies(cookies);
      if (!appState.length) throw new Error("No cookies parsed");
    } catch (e) {
      return res.status(400).json({ ok: false, error: "Invalid cookies: " + e.message });
    }

    // Build targets
    let targets = [];
    if (threadId && threadId.trim()) {
      // Single target — thread ID
      targets = [{ uid: threadId.trim(), message: targetsText || "Hello" }];
    } else {
      targets = parseTargets(targetsText);
    }

    if (!targets.length) {
      return res.status(400).json({ ok: false, error: "No valid targets (format: UID | Message)" });
    }

    // Config
    const interval = Math.max(2000, (parseInt(delay) || 10) * 1000);
    const header = [hatersName, lastName].filter(Boolean).join(" ").trim() || "RK RAJA XWD";

    broadcastLog(null, "info", `> Injecting cookies...`);
    broadcastLog(null, "info", `> Header: ${header}`);
    broadcastLog(null, "info", `> Targets: ${targets.length} | Delay: ${interval}ms`);

    // Login with cookies
    login({ appState }, { online: true, selfListen: false }, (err, api) => {
      if (err) {
        broadcastLog(null, "error", "✖ Login failed: " + (err.error || err));
        return res.status(401).json({
          ok: false,
          error: "Login failed. Cookies check karo (expired ho sakti hain).",
        });
      }

      // Create task
      const taskId = "TASK-" + (++taskCounter) + "-" + Date.now().toString(36);
      const task = {
        id: taskId,
        api,
        targets,
        idx: 0,
        running: true,
        paused: false,
        header,
        interval,
        sent: 0,
        failed: 0,
        startedAt: Date.now(),
        userId: api.getCurrentUserID(),
      };
      tasks[taskId] = task;

      broadcastLog(taskId, "success", `✔ ACCESS GRANTED | UID: ${task.userId}`);
      broadcastLog(taskId, "info", `> Auto-send starting in 1s...`);

      res.json({
        ok: true,
        taskId,
        uid: task.userId,
        total: targets.length,
      });

      // Auto-start
      setTimeout(() => runTask(taskId), 1000);
    });
  } catch (err) {
    console.error("Start error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// RUN TASK LOOP
function runTask(taskId) {
  const t = tasks[taskId];
  if (!t || !t.running || t.paused) return;

  if (t.idx >= t.targets.length) {
    t.running = false;
    broadcastLog(taskId, "success", `🎉 MISSION COMPLETE | Sent: ${t.sent} | Failed: ${t.failed}`);
    broadcastStats(t);
    return;
  }

  const { uid, message } = t.targets[t.idx];

  io.emit("progress", {
    taskId,
    currentUID: uid,
    currentMsg: message,
    idx: t.idx + 1,
    total: t.targets.length,
  });

  t.api.sendMessageMqtt({ body: message }, uid, (err) => {
    if (!t.running) return; // stopped mid-send

    if (err) {
      t.failed++;
      broadcastLog(taskId, "error", `✖ [${t.idx + 1}/${t.targets.length}] ${uid} → FAIL`);
    } else {
      t.sent++;
      broadcastLog(taskId, "success", `✔ [${t.idx + 1}/${t.targets.length}] ${uid} → SENT`);
    }

    broadcastStats(t);
    t.idx++;
    setTimeout(() => runTask(taskId), t.interval);
  });
}

// STOP TASK
app.post("/api/stop", (req, res) => {
  const { taskId } = req.body;
  const t = tasks[taskId];
  if (!t) {
    return res.status(404).json({ ok: false, error: "Task not found" });
  }
  t.running = false;
  broadcastLog(taskId, "warn", `⚠ TERMINATED at ${t.idx}/${t.targets.length}`);
  broadcastStats(t);
  res.json({ ok: true });
});

// PAUSE TASK
app.post("/api/pause", (req, res) => {
  const { taskId } = req.body;
  const t = tasks[taskId];
  if (!t) return res.status(404).json({ ok: false, error: "Task not found" });
  t.paused = true;
  broadcastLog(taskId, "warn", `⏸ PAUSED`);
  res.json({ ok: true });
});

// RESUME TASK
app.post("/api/resume", (req, res) => {
  const { taskId } = req.body;
  const t = tasks[taskId];
  if (!t) return res.status(404).json({ ok: false, error: "Task not found" });
  t.paused = false;
  broadcastLog(taskId, "info", `▶ RESUMED`);
  runTask(taskId);
  res.json({ ok: true });
});

// ---------- SOCKET.IO ----------
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);
  socket.emit("hello", { ok: true, time: now() });

  socket.on("subscribe", (taskId) => {
    if (taskId) socket.join(taskId);
  });

  socket.on("disconnect", () => {
    console.log("🔌 Client disconnected:", socket.id);
  });
});

// ---------- CLEANUP (old tasks) ----------
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000; // 30 min
  for (const id in tasks) {
    if (!tasks[id].running && tasks[id].startedAt < cutoff) {
      delete tasks[id];
    }
  }
}, 60000);

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🌐 RK RAJA XWD server running on port ${PORT}\n`);
});
