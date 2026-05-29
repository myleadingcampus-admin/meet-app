const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const PORT = process.env.PORT || 3000;
const BREAKOUT_AUTO_CLOSE_MS = Number(process.env.BREAKOUT_AUTO_CLOSE_MS || 10 * 60 * 1000);

app.use(cors());
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    'camera=(self "https://p2p.mirotalk.com"), microphone=(self "https://p2p.mirotalk.com"), display-capture=(self "https://p2p.mirotalk.com")'
  );
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// In-memory storage for MVP. Replace with DB/Redis in production.
const classes = new Map();
const breakoutCloseTimers = new Map();

function ensureClass(classId) {
  if (!classes.has(classId)) {
    classes.set(classId, {
      id: classId,
      title: "Untitled Class",
      status: "scheduled",
      youtubeUrl: "",
      handRaiseQueue: [],
      chat: [],
      participants: new Map(),
      breakoutRoomsByUserId: {},
      activeBreakoutUserId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return classes.get(classId);
}

function publicClassPayload(classroom) {
  return {
    id: classroom.id,
    title: classroom.title,
    status: classroom.status,
    youtubeUrl: classroom.youtubeUrl,
    handRaiseQueue: classroom.handRaiseQueue,
    chat: classroom.chat.slice(-100),
    createdAt: classroom.createdAt,
    updatedAt: classroom.updatedAt,
    participantCount: classroom.participants.size,
  };
}

function canInteract(classroom) {
  return classroom && classroom.status !== "ended";
}

function findSocketIdByUserId(classroom, userId) {
  for (const [socketId, participant] of classroom.participants.entries()) {
    if (participant.userId === userId) return socketId;
  }
  return null;
}

function emitBreakoutToTeachers(classroomId, classroom) {
  const activeRoom = getActiveBreakoutRoom(classroom);
  for (const [socketId, participant] of classroom.participants.entries()) {
    if (participant.role === "teacher") {
      io.to(socketId).emit("breakout:updated", activeRoom);
    }
  }
}

function getActiveBreakoutRoom(classroom) {
  if (!classroom.activeBreakoutUserId) return null;
  return classroom.breakoutRoomsByUserId[classroom.activeBreakoutUserId] || null;
}

function ensureBreakoutRoom(classroom, userId, participantName) {
  const existing = classroom.breakoutRoomsByUserId[userId];
  if (existing) return existing;

  const safeRoom = `session-${classroom.id}-${userId}-doubt-room`;
  const room = {
    userId,
    participantName: participantName || "Participant",
    roomName: safeRoom,
    url: buildDoubtRoomUrl(safeRoom),
    openedAt: new Date().toISOString(),
  };
  classroom.breakoutRoomsByUserId[userId] = room;
  classroom.updatedAt = new Date().toISOString();
  return room;
}

function buildDoubtRoomUrl(roomName) {
  const encodedRoom = encodeURIComponent(roomName);
  return `https://p2p.mirotalk.com/join/${encodedRoom}?notify=false&video=0`;
}

function clearBreakoutCloseTimer(classId) {
  const timer = breakoutCloseTimers.get(classId);
  if (timer) {
    clearTimeout(timer);
    breakoutCloseTimers.delete(classId);
  }
}

function closeBreakoutRoom(classroom) {
  const activeRoom = getActiveBreakoutRoom(classroom);
  if (!activeRoom) return;

  delete classroom.breakoutRoomsByUserId[activeRoom.userId];
  classroom.activeBreakoutUserId = null;
  classroom.updatedAt = new Date().toISOString();
  clearBreakoutCloseTimer(classroom.id);

  emitBreakoutToTeachers(classroom.id, classroom);
  io.to(classroom.id).emit("breakout:invited", null);
  io.to(classroom.id).emit("class:updated", publicClassPayload(classroom));
}

function scheduleBreakoutAutoClose(classroom) {
  clearBreakoutCloseTimer(classroom.id);

  const timer = setTimeout(() => {
    const current = classes.get(classroom.id);
    if (!current || current.status !== "live") return;
    closeBreakoutRoom(current);
  }, BREAKOUT_AUTO_CLOSE_MS);

  breakoutCloseTimers.set(classroom.id, timer);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post("/api/classes", (req, res) => {
  const id = uuidv4();
  const title = req.body?.title?.trim() || "Untitled Class";
  const classroom = ensureClass(id);
  classroom.title = title;
  classroom.updatedAt = new Date().toISOString();
  res.status(201).json(publicClassPayload(classroom));
});

app.get("/api/classes/:id", (req, res) => {
  const classroom = classes.get(req.params.id);
  if (!classroom) {
    return res.status(404).json({ error: "Class not found" });
  }
  return res.json(publicClassPayload(classroom));
});

app.post("/api/classes/:id/start", (req, res) => {
  const classroom = ensureClass(req.params.id);
  const { title, youtubeUrl } = req.body || {};

  if (classroom.status === "ended") {
    return res.status(409).json({ error: "Session has ended and cannot be restarted" });
  }

  if (!youtubeUrl || !youtubeUrl.includes("youtube")) {
    return res.status(400).json({ error: "Valid YouTube URL is required" });
  }

  classroom.title = (title || classroom.title).trim();
  classroom.youtubeUrl = youtubeUrl.trim();
  classroom.status = "live";
  classroom.updatedAt = new Date().toISOString();

  emitBreakoutToTeachers(classroom.id, classroom);
  io.to(classroom.id).emit("class:updated", publicClassPayload(classroom));
  return res.json(publicClassPayload(classroom));
});

app.post("/api/classes/:id/end", (req, res) => {
  const classroom = classes.get(req.params.id);
  if (!classroom) {
    return res.status(404).json({ error: "Class not found" });
  }

  classroom.status = "ended";
  classroom.handRaiseQueue = [];
  classroom.chat = [];
  closeBreakoutRoom(classroom);
  classroom.updatedAt = new Date().toISOString();
  io.to(classroom.id).emit("class:updated", publicClassPayload(classroom));
  io.to(classroom.id).emit("session:ended");
  return res.json(publicClassPayload(classroom));
});

io.on("connection", (socket) => {
  socket.on("join:class", ({ classId, userId, role, name }) => {
    if (!classId) return;

    const classroom = ensureClass(classId);
    if (classroom.status === "ended") {
      socket.emit("class:updated", publicClassPayload(classroom));
      socket.emit("session:ended");
      return;
    }

    const participant = {
      userId: userId || uuidv4(),
      role: role || "student",
      name: name || "Anonymous",
      joinedAt: new Date().toISOString(),
    };

    classroom.participants.set(socket.id, participant);
    socket.join(classId);
    socket.data.classId = classId;
    socket.data.participant = participant;

    socket.emit("class:updated", publicClassPayload(classroom));
    if (participant.role === "teacher") {
      socket.emit("breakout:updated", getActiveBreakoutRoom(classroom));
    }
    io.to(classId).emit("participants:count", classroom.participants.size);
  });

  socket.on("hand-raise:add", () => {
    const classId = socket.data.classId;
    const participant = socket.data.participant;
    if (!classId || !participant) return;

    const classroom = ensureClass(classId);
    if (!canInteract(classroom)) return;
    const alreadyQueued = classroom.handRaiseQueue.some((x) => x.userId === participant.userId);
    if (alreadyQueued) return;

    classroom.handRaiseQueue.push({
      userId: participant.userId,
      name: participant.name,
      requestedAt: new Date().toISOString(),
      status: "pending",
    });
    classroom.updatedAt = new Date().toISOString();

    io.to(classId).emit("queue:updated", classroom.handRaiseQueue);
  });

  socket.on("hand-raise:resolve", ({ userId, action }) => {
    const classId = socket.data.classId;
    const participant = socket.data.participant;
    if (!classId || !participant || participant.role !== "teacher") return;

    const classroom = ensureClass(classId);
    if (!canInteract(classroom)) return;
    classroom.handRaiseQueue = classroom.handRaiseQueue.map((item) => {
      if (item.userId !== userId) return item;
      return { ...item, status: action === "accept" ? "accepted" : "rejected" };
    });

    if (action === "accept") {
      const approved = classroom.handRaiseQueue.find((item) => item.userId === userId);
      const room = ensureBreakoutRoom(classroom, userId, approved?.name);
      classroom.activeBreakoutUserId = userId;
      scheduleBreakoutAutoClose(classroom);
      emitBreakoutToTeachers(classId, classroom);

      const targetSocketId = findSocketIdByUserId(classroom, userId);
      if (targetSocketId) {
        io.to(targetSocketId).emit("breakout:invited", room);
      }
    }

    classroom.updatedAt = new Date().toISOString();
    io.to(classId).emit("queue:updated", classroom.handRaiseQueue);

    const targetSocketId = findSocketIdByUserId(classroom, userId);
    if (targetSocketId) {
      io.to(targetSocketId).emit("hand-raise:result", {
        status: action === "accept" ? "accepted" : "rejected",
      });
    }
  });

  socket.on("chat:send", ({ message }) => {
    const classId = socket.data.classId;
    const participant = socket.data.participant;
    if (!classId || !participant || !message?.trim()) return;

    const classroom = ensureClass(classId);
    if (!canInteract(classroom)) return;
    const payload = {
      id: uuidv4(),
      userId: participant.userId,
      name: participant.name,
      role: participant.role,
      message: message.trim().slice(0, 500),
      ts: new Date().toISOString(),
    };

    classroom.chat.push(payload);
    if (classroom.chat.length > 500) classroom.chat.shift();
    classroom.updatedAt = new Date().toISOString();
    io.to(classId).emit("chat:message", payload);
  });

  socket.on("breakout:open", ({ roomName }) => {
    const classId = socket.data.classId;
    const participant = socket.data.participant;
    if (!classId || !participant || participant.role !== "teacher") return;

    const classroom = ensureClass(classId);
    if (!canInteract(classroom)) return;
    const safeRoom = (roomName || `class-${classId}-doubt-room`).replace(/\s+/g, "-");
    const room = {
      userId: "manual",
      participantName: "Manual",
      roomName: safeRoom,
      url: buildDoubtRoomUrl(safeRoom),
      openedAt: new Date().toISOString(),
    };
    classroom.breakoutRoomsByUserId.manual = room;
    classroom.activeBreakoutUserId = "manual";
    scheduleBreakoutAutoClose(classroom);
    classroom.updatedAt = new Date().toISOString();

    // Notify teachers only for room control UI.
    emitBreakoutToTeachers(classId, classroom);

    io.to(classId).emit("breakout:invited", room);

    io.to(classId).emit("class:updated", publicClassPayload(classroom));
  });

  socket.on("breakout:close", () => {
    const classId = socket.data.classId;
    const participant = socket.data.participant;
    if (!classId || !participant || participant.role !== "teacher") return;

    const classroom = ensureClass(classId);
    if (!canInteract(classroom)) return;
    closeBreakoutRoom(classroom);
  });

  socket.on("disconnect", () => {
    const classId = socket.data.classId;
    if (!classId) return;

    const classroom = classes.get(classId);
    if (!classroom) return;

    classroom.participants.delete(socket.id);
    io.to(classId).emit("participants:count", classroom.participants.size);
  });
});

server.listen(PORT, () => {
  console.log(`Hybrid classroom module running on http://localhost:${PORT}`);
});
