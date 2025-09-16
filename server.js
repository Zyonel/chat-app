const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
require("dotenv").config(); // load .env

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

// 📂 Data folder for storing room histories
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// 🗂 In-memory cache of rooms
const rooms = {};

// --- Configurable settings ---
const PORT = process.env.PORT || 3000;
const KEEP_DAYS = parseInt(process.env.KEEP_DAYS || "30", 10);
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES || "2000", 10);

// --- Helpers ---
function makeRoomId(userA, userB) {
  return [userA, userB].sort().join("_"); // always consistent
}

function loadRoom(roomId) {
  const filePath = path.join(DATA_DIR, `room_${roomId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      rooms[roomId] = JSON.parse(data);
    } catch (err) {
      console.error(`❌ Error reading file for room ${roomId}:`, err);
      rooms[roomId] = [];
    }
  } else {
    rooms[roomId] = [];
  }
}

function saveRoom(roomId) {
  const filePath = path.join(DATA_DIR, `room_${roomId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(rooms[roomId], null, 2));
  } catch (err) {
    console.error(`❌ Error saving file for room ${roomId}:`, err);
  }
}

// 🧹 Cleanup old rooms
function cleanupOldRooms() {
  const EXPIRY = KEEP_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  fs.readdirSync(DATA_DIR).forEach((file) => {
    if (file.startsWith("room_") && file.endsWith(".json")) {
      const filePath = path.join(DATA_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (data.length > 0) {
          const lastMsgTime = new Date(data[data.length - 1].time).getTime();
          if (now - lastMsgTime > EXPIRY) {
            fs.unlinkSync(filePath);
            console.log(`🧹 Deleted old room file: ${file}`);
          }
        } else {
          fs.unlinkSync(filePath);
          console.log(`🧹 Deleted empty room file: ${file}`);
        }
      } catch (err) {
        console.error(`❌ Error checking room file ${file}:`, err);
      }
    }
  });
}

// Run cleanup at startup + every 24h
cleanupOldRooms();
setInterval(cleanupOldRooms, 24 * 60 * 60 * 1000);

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  // Save username
  socket.on("set username", (username) => {
    socket.username = username || "Anonymous";
    console.log(`👤 ${socket.username} set for socket ${socket.id}`);
  });

  // --- Join a DM room ---
  socket.on("join room", (roomId) => {
    if (!roomId || !socket.username) return;

    // Normalize roomId to always be sorted between 2 users
    const peerName = roomId.replace(socket.username, "").replace("_", "").trim();
    const normalizedRoomId = makeRoomId(socket.username, peerName);

    socket.join(normalizedRoomId);

    if (!rooms[normalizedRoomId]) loadRoom(normalizedRoomId);

    socket.emit("chat history", rooms[normalizedRoomId].slice(-100));
    console.log(`📥 ${socket.username} joined ${normalizedRoomId}`);
  });

  // --- Handle messages ---
  socket.on("chat message", (data) => {
    try {
      if (!socket.username) return;

      const peerName = data.roomId.replace(socket.username, "").replace("_", "").trim();
      const normalizedRoomId = makeRoomId(socket.username, peerName);
      const text = data.text;

      if (!text) return;

      const message = {
        username: socket.username,
        text: String(text),
        time: new Date().toISOString(),
        roomId: normalizedRoomId,
      };

      if (!rooms[normalizedRoomId]) rooms[normalizedRoomId] = [];
      rooms[normalizedRoomId].push(message);

      if (rooms[normalizedRoomId].length > MAX_MESSAGES) {
        rooms[normalizedRoomId].splice(0, rooms[normalizedRoomId].length - MAX_MESSAGES);
      }

      saveRoom(normalizedRoomId);
      io.to(normalizedRoomId).emit("chat message", message);
    } catch (err) {
      console.error("❌ Error handling chat message:", err);
    }
  });

  // --- Disconnect ---
  socket.on("disconnect", () => {
    console.log(`❌ ${socket.username || "Unknown"} disconnected (${socket.id})`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`🧹 Old rooms auto-deleted after ${KEEP_DAYS} days`);
});
