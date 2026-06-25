import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const rooms = new Map();
const clients = new Map();
const whiteboards = new Map();

app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get(["/", "/room/:roomId"], (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }

  return rooms.get(roomId);
}

function getWhiteboard(roomId) {
  if (!whiteboards.has(roomId)) {
    whiteboards.set(roomId, []);
  }

  return whiteboards.get(roomId);
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(roomId, message, exceptClientId) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const [clientId, client] of room) {
    if (clientId !== exceptClientId) {
      send(client.ws, message);
    }
  }
}

function leaveRoom(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  const room = rooms.get(client.roomId);
    if (room) {
    room.delete(clientId);
    broadcast(client.roomId, { type: "user-left", id: clientId }, clientId);

    if (room.size === 0) {
      rooms.delete(client.roomId);
      whiteboards.delete(client.roomId);
    }
  }

  clients.delete(clientId);
}

wss.on("connection", (ws) => {
  const clientId = randomUUID();

  ws.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid message format." });
      return;
    }

    if (message.type === "join") {
      const roomId = String(message.roomId || "").trim();
      const name = String(message.name || "Guest").trim().slice(0, 40) || "Guest";

      if (!roomId || !/^[a-zA-Z0-9-]{4,80}$/.test(roomId)) {
        send(ws, { type: "error", message: "Invalid meeting link." });
        return;
      }

      leaveRoom(clientId);

      const room = getRoom(roomId);
      const whiteboard = getWhiteboard(roomId);
      const users = [...room.entries()].map(([id, client]) => ({
        id,
        name: client.name
      }));

      clients.set(clientId, { id: clientId, name, roomId, ws });
      room.set(clientId, { id: clientId, name, roomId, ws });

      send(ws, { type: "joined", id: clientId, roomId, users, whiteboard });
      broadcast(roomId, { type: "user-joined", id: clientId, name }, clientId);
      return;
    }

    const sender = clients.get(clientId);
    if (!sender) {
      send(ws, { type: "error", message: "Join a meeting before sending signals." });
      return;
    }

    if (message.type === "signal") {
      const room = rooms.get(sender.roomId);
      const recipient = room?.get(message.to);

      if (recipient) {
        send(recipient.ws, {
          type: "signal",
          from: clientId,
          name: sender.name,
          signal: message.signal
        });
      }
      return;
    }

    if (message.type === "chat") {
      broadcast(sender.roomId, {
        type: "chat",
        id: clientId,
        name: sender.name,
        text: String(message.text || "").slice(0, 500),
        sentAt: Date.now()
      });
      return;
    }

    if (message.type === "whiteboard") {
      const operation = sanitizeWhiteboardOperation(message.operation);
      if (!operation) {
        send(ws, { type: "error", message: "Invalid whiteboard operation." });
        return;
      }

      const whiteboard = getWhiteboard(sender.roomId);

      if (operation.type === "clear") {
        whiteboard.length = 0;
      } else {
        whiteboard.push(operation);
        if (whiteboard.length > 1500) {
          whiteboard.splice(0, whiteboard.length - 1500);
        }
      }

      broadcast(sender.roomId, {
        type: "whiteboard",
        id: clientId,
        name: sender.name,
        operation,
        sentAt: Date.now()
      }, clientId);
    }
  });

  ws.on("close", () => {
    leaveRoom(clientId);
  });

  ws.on("error", () => {
    leaveRoom(clientId);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Video meeting app running at http://localhost:${port}`);
});

function sanitizeWhiteboardOperation(operation) {
  if (!operation || typeof operation !== "object") return null;

  if (operation.type === "clear") {
    return { type: "clear" };
  }

  if (operation.type === "stroke") {
    const tool = ["pen", "highlighter", "eraser"].includes(operation.tool)
      ? operation.tool
      : "pen";
    const points = Array.isArray(operation.points)
      ? operation.points
        .slice(0, 1000)
        .map((point) => ({
          x: clampUnit(Number(point.x)),
          y: clampUnit(Number(point.y))
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      : [];

    if (points.length < 2) return null;

    return {
      type: "stroke",
      tool,
      color: sanitizeColor(operation.color),
      size: clampNumber(Number(operation.size), 1, 48, tool === "highlighter" ? 18 : 4),
      points
    };
  }

  if (operation.type === "text") {
    const text = String(operation.text || "").trim().slice(0, 200);
    if (!text) return null;

    return {
      type: "text",
      x: clampUnit(Number(operation.x)),
      y: clampUnit(Number(operation.y)),
      text,
      color: sanitizeColor(operation.color),
      size: clampNumber(Number(operation.size), 12, 72, 24)
    };
  }

  return null;
}

function sanitizeColor(color) {
  const value = String(color || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#111827";
}

function clampUnit(value) {
  return clampNumber(value, 0, 1, 0);
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
