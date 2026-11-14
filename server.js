import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  AiError,
  aiStatus,
  generateNotes,
  streamAnswer,
  streamMinutes,
  translateBatch
} from "./server/ai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

// 会议室最后一人离开后保留多久（便于刷新/重连后找回转写、笔记和白板）。
const ROOM_GRACE_MS = 15 * 60 * 1000;
const MAX_TRANSCRIPT = 20000;
const MAX_CHAT = 2000;
const MAX_WHITEBOARD = 1500;
const AUTO_NOTES_INTERVAL_MS = 90 * 1000;
const AUTO_NOTES_MIN_SEGMENTS = 4;
const REACTIONS = new Set(["👍", "👏", "❤️", "😂", "😮", "🎉", "🤔", "🙏"]);
const LANGUAGE_NAMES = {
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  "en-US": "English",
  "ja-JP": "Japanese (日本語)",
  "ko-KR": "Korean (한국어)",
  "fr-FR": "French (Français)",
  "de-DE": "German (Deutsch)",
  "es-ES": "Spanish (Español)",
  "it-IT": "Italian (Italiano)",
  "pt-BR": "Portuguese (Português)",
  "ru-RU": "Russian (Русский)",
  "ar-SA": "Arabic (العربية)"
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });

const rooms = new Map();
const clients = new Map();

app.use(express.json({ limit: "64kb" }));
app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, clients: clients.size });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ai: aiStatus(),
    iceServers: getIceServers(),
    languages: LANGUAGE_NAMES
  });
});

app.get(["/", "/room/:roomId"], (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---------- 房间状态 ----------

function createRoom(roomId) {
  return {
    id: roomId,
    clients: new Map(),
    hostId: null,
    locked: false,
    createdAt: Date.now(),
    whiteboard: [],
    transcript: [],
    chat: [],
    pastNames: new Set(),
    transcription: { active: false, by: "", at: 0 },
    recording: new Set(),
    translations: new Map(),
    notes: null,
    notesTask: null,
    notesAt: 0,
    notesSegmentCount: 0,
    minutes: null,
    aiLanguage: "zh-CN",
    cleanupTimer: null
  };
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = createRoom(roomId);
    rooms.set(roomId, room);
  }
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  return room;
}

function publicUser(client) {
  return {
    id: client.id,
    name: client.name,
    media: client.media,
    hand: client.hand,
    joinedAt: client.joinedAt
  };
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message, exceptClientId) {
  if (!room) return;
  for (const [clientId, client] of room.clients) {
    if (clientId !== exceptClientId) {
      send(client.ws, message);
    }
  }
}

function leaveRoom(clientId, reason = "left") {
  const client = clients.get(clientId);
  if (!client) return;

  const room = rooms.get(client.roomId);
  clients.delete(clientId);
  if (!room) return;

  room.clients.delete(clientId);
  room.recording.delete(clientId);
  broadcast(room, { type: "user-left", id: clientId, name: client.name, reason });

  if (room.hostId === clientId) {
    // 主持人离开：交给最早加入的人。
    const next = [...room.clients.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    room.hostId = next?.id || null;
    if (next) broadcast(room, { type: "host-changed", hostId: next.id, name: next.name });
  }

  broadcastRecording(room);

  if (room.clients.size === 0) {
    room.locked = false;
    room.transcription.active = false;
    room.cleanupTimer = setTimeout(() => {
      if (room.clients.size === 0) rooms.delete(room.id);
    }, ROOM_GRACE_MS);
  }
}

function broadcastRecording(room) {
  const names = [...room.recording].map((id) => room.clients.get(id)?.name).filter(Boolean);
  broadcast(room, { type: "recording", active: names.length > 0, names });
}

// ---------- WebSocket ----------

wss.on("connection", (ws) => {
  const clientId = randomUUID();

  ws.on("message", (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      send(ws, { type: "error", message: "消息格式错误。" });
      return;
    }

    if (message.type === "join") {
      handleJoin(ws, clientId, message);
      return;
    }

    const sender = clients.get(clientId);
    if (!sender) {
      send(ws, { type: "error", message: "请先加入会议。" });
      return;
    }

    const room = rooms.get(sender.roomId);
    if (!room) return;

    switch (message.type) {
      case "signal": {
        const recipient = room.clients.get(message.to);
        if (recipient) {
          send(recipient.ws, { type: "signal", from: clientId, name: sender.name, signal: message.signal });
        }
        return;
      }

      case "chat": {
        const text = String(message.text || "").trim().slice(0, 1000);
        if (!text) return;
        const entry = { id: randomUUID(), senderId: clientId, name: sender.name, text, sentAt: Date.now() };
        room.chat.push(entry);
        if (room.chat.length > MAX_CHAT) room.chat.shift();
        broadcast(room, { type: "chat", ...entry });
        return;
      }

      case "media": {
        sender.media = sanitizeMedia(message.media);
        broadcast(room, { type: "media", id: clientId, media: sender.media }, clientId);
        return;
      }

      case "hand": {
        sender.hand = Boolean(message.raised);
        broadcast(room, { type: "hand", id: clientId, name: sender.name, raised: sender.hand });
        return;
      }

      case "reaction": {
        const emoji = String(message.emoji || "");
        if (!REACTIONS.has(emoji)) return;
        broadcast(room, { type: "reaction", id: clientId, name: sender.name, emoji });
        return;
      }

      case "recording": {
        if (message.active) room.recording.add(clientId);
        else room.recording.delete(clientId);
        broadcastRecording(room);
        return;
      }

      case "transcription": {
        const active = Boolean(message.active);
        if (!active && room.hostId !== clientId && room.transcription.by !== sender.name) {
          send(ws, { type: "error", message: "只有主持人或开启转写的人可以关闭转写。" });
          return;
        }
        room.transcription = { active, by: sender.name, at: Date.now() };
        broadcast(room, { type: "transcription", ...room.transcription });
        return;
      }

      case "caption": {
        handleCaption(room, sender, message);
        return;
      }

      case "host-action": {
        handleHostAction(room, sender, message);
        return;
      }

      case "whiteboard": {
        handleWhiteboard(room, sender, message);
        return;
      }

      default:
        return;
    }
  });

  ws.on("close", () => leaveRoom(clientId));
  ws.on("error", () => leaveRoom(clientId));
});

function handleJoin(ws, clientId, message) {
  const roomId = String(message.roomId || "").trim();
  const name = String(message.name || "").trim().slice(0, 40) || "访客";

  if (!/^[a-zA-Z0-9-]{4,80}$/.test(roomId)) {
    send(ws, { type: "join-error", message: "会议链接无效。" });
    return;
  }

  const existing = rooms.get(roomId);
  if (existing?.locked && existing.clients.size > 0) {
    send(ws, { type: "join-error", message: "会议已被主持人锁定，暂时无法加入。" });
    return;
  }

  leaveRoom(clientId);

  const room = getRoom(roomId);
  const client = {
    id: clientId,
    name,
    roomId,
    ws,
    joinedAt: Date.now(),
    media: sanitizeMedia(message.media),
    hand: false
  };

  const users = [...room.clients.values()].map(publicUser);
  room.clients.set(clientId, client);
  room.pastNames.add(name);
  clients.set(clientId, client);
  if (!room.hostId || !room.clients.has(room.hostId)) room.hostId = clientId;

  send(ws, {
    type: "joined",
    id: clientId,
    roomId,
    users,
    hostId: room.hostId,
    locked: room.locked,
    createdAt: room.createdAt,
    whiteboard: room.whiteboard,
    transcription: room.transcription,
    transcript: room.transcript.slice(-300),
    chat: room.chat.slice(-100),
    notes: room.notes,
    minutes: room.minutes,
    recording: [...room.recording].map((id) => room.clients.get(id)?.name).filter(Boolean)
  });
  broadcast(room, { type: "user-joined", user: publicUser(client) }, clientId);
}

function handleCaption(room, sender, message) {
  const text = String(message.text || "").replace(/\s+/g, " ").trim().slice(0, 600);
  const lang = LANGUAGE_NAMES[message.lang] ? message.lang : "zh-CN";
  if (!text) return;

  if (!message.final) {
    broadcast(room, { type: "caption", speakerId: sender.id, speaker: sender.name, text, lang, final: false }, sender.id);
    return;
  }

  const segment = {
    id: randomUUID().slice(0, 12),
    speakerId: sender.id,
    speaker: sender.name,
    text,
    lang,
    at: Date.now()
  };
  room.transcript.push(segment);
  if (room.transcript.length > MAX_TRANSCRIPT) room.transcript.shift();
  broadcast(room, { type: "caption", ...segment, final: true });
  maybeAutoNotes(room);
}

function handleHostAction(room, sender, message) {
  if (room.hostId !== sender.id) {
    send(sender.ws, { type: "error", message: "只有主持人可以执行这个操作。" });
    return;
  }

  const target = room.clients.get(message.target);

  switch (message.action) {
    case "mute-all":
      broadcast(room, { type: "force-mute", by: sender.name }, sender.id);
      return;
    case "mute":
      if (target) send(target.ws, { type: "force-mute", by: sender.name });
      return;
    case "stop-video":
      if (target) send(target.ws, { type: "force-video-off", by: sender.name });
      return;
    case "lower-hand":
      if (target) {
        target.hand = false;
        broadcast(room, { type: "hand", id: target.id, name: target.name, raised: false });
      }
      return;
    case "remove":
      if (target && target.id !== sender.id) {
        send(target.ws, { type: "removed", by: sender.name });
        leaveRoom(target.id, "removed");
        target.ws.close();
      }
      return;
    case "make-host":
      if (target) {
        room.hostId = target.id;
        broadcast(room, { type: "host-changed", hostId: target.id, name: target.name });
      }
      return;
    case "end":
      for (const member of [...room.clients.values()]) {
        if (member.id === sender.id) continue;
        send(member.ws, { type: "meeting-ended", by: sender.name });
        leaveRoom(member.id, "ended");
        member.ws.close();
      }
      return;
    case "lock":
    case "unlock":
      room.locked = message.action === "lock";
      broadcast(room, { type: "locked", locked: room.locked, by: sender.name });
      return;
    default:
      return;
  }
}

function handleWhiteboard(room, sender, message) {
  const operation = sanitizeWhiteboardOperation(message.operation);
  if (!operation) {
    send(sender.ws, { type: "error", message: "白板操作无效。" });
    return;
  }

  const board = room.whiteboard;
  if (operation.type === "clear") {
    board.length = 0;
  } else if (operation.type === "remove") {
    const index = board.findIndex((op) => op.id === operation.id);
    if (index >= 0) board.splice(index, 1);
  } else {
    operation.author = sender.id;
    board.push(operation);
    if (board.length > MAX_WHITEBOARD) board.splice(0, board.length - MAX_WHITEBOARD);
  }

  broadcast(room, { type: "whiteboard", id: sender.id, name: sender.name, operation }, sender.id);
}

// ---------- AI ----------

function languageName(code) {
  return LANGUAGE_NAMES[code] || LANGUAGE_NAMES["zh-CN"];
}

function requireMember(req) {
  const { roomId, clientId } = req.body || {};
  const room = rooms.get(String(roomId || ""));
  if (!room || !room.clients.has(String(clientId || ""))) {
    throw new AiError("你不在这个会议中。", 403);
  }
  return { room, client: room.clients.get(clientId) };
}

function sendAiError(res, error) {
  const status = error instanceof AiError ? error.status : 500;
  if (!(error instanceof AiError)) console.error(error);
  res.status(status).json({ error: error.message || "AI 处理失败。" });
}

async function runNotes(room) {
  if (room.notesTask) return room.notesTask;

  room.notesTask = (async () => {
    const segmentCount = room.transcript.length;
    broadcast(room, { type: "ai-notes-status", busy: true });
    try {
      const notes = await generateNotes(room, languageName(room.aiLanguage));
      room.notes = { ...notes, updatedAt: Date.now(), segmentCount };
      room.notesAt = Date.now();
      room.notesSegmentCount = segmentCount;
      broadcast(room, { type: "ai-notes", notes: room.notes });
      return room.notes;
    } catch (error) {
      broadcast(room, { type: "ai-notes-status", busy: false, error: error.message });
      throw error;
    } finally {
      room.notesTask = null;
    }
  })();

  return room.notesTask;
}

function maybeAutoNotes(room) {
  if (!aiStatus().configured || !room.transcription.active) return;
  if (room.notesTask) return;
  const fresh = room.transcript.length - room.notesSegmentCount;
  if (fresh < AUTO_NOTES_MIN_SEGMENTS) return;
  if (Date.now() - room.notesAt < AUTO_NOTES_INTERVAL_MS) return;
  runNotes(room).catch(() => {});
}

app.post("/api/ai/translate", async (req, res) => {
  try {
    const { room } = requireMember(req);
    const target = LANGUAGE_NAMES[req.body.target] ? req.body.target : "zh-CN";
    const targetName = languageName(target);

    // 自由文本（聊天消息）
    if (typeof req.body.text === "string") {
      const text = req.body.text.trim().slice(0, 1000);
      if (!text) return res.json({ text: "" });
      const result = await translateBatch([{ id: "t", text }], targetName);
      return res.json({ text: result.get("t") || text });
    }

    // 字幕片段：按 (片段, 目标语言) 缓存，避免每个参会者重复翻译。
    const ids = Array.isArray(req.body.segmentIds) ? req.body.segmentIds.slice(0, 40).map(String) : [];
    const segments = ids
      .map((id) => room.transcript.find((s) => s.id === id))
      .filter(Boolean);

    const translations = {};
    const toTranslate = [];
    const waits = [];
    for (const segment of segments) {
      const cached = room.translations.get(segment.id)?.get(target);
      if (typeof cached === "string") {
        translations[segment.id] = cached;
      } else if (cached) {
        // 别人刚刚请求了同一句，等那次结果即可。
        waits.push(cached.then((text) => { if (text) translations[segment.id] = text; }));
      } else if (segment.lang === target) {
        translations[segment.id] = segment.text;
      } else {
        toTranslate.push(segment);
      }
    }

    if (toTranslate.length) {
      const first = room.transcript.indexOf(toTranslate[0]);
      const context = room.transcript
        .slice(Math.max(0, first - 6), first)
        .map((s) => `${s.speaker}: ${s.text}`)
        .join("\n");

      const task = translateBatch(
        toTranslate.map((s) => ({ id: s.id, text: s.text, speaker: s.speaker })),
        targetName,
        context
      );

      for (const segment of toTranslate) {
        if (!room.translations.has(segment.id)) room.translations.set(segment.id, new Map());
        room.translations.get(segment.id).set(
          target,
          // 永不 reject，避免未处理的 Promise 拒绝；失败时给 null。
          task.then((map) => map.get(segment.id) || segment.text, () => null)
        );
      }

      try {
        const map = await task;
        for (const segment of toTranslate) {
          const text = map.get(segment.id) || segment.text;
          translations[segment.id] = text;
          room.translations.get(segment.id)?.set(target, text);
        }
      } catch (error) {
        for (const segment of toTranslate) room.translations.get(segment.id)?.delete(target);
        throw error;
      }
    }

    await Promise.all(waits);
    trimTranslationCache(room);
    res.json({ translations });
  } catch (error) {
    sendAiError(res, error);
  }
});

function trimTranslationCache(room) {
  if (room.translations.size <= 3000) return;
  const keep = new Set(room.transcript.slice(-2000).map((s) => s.id));
  for (const id of room.translations.keys()) {
    if (!keep.has(id)) room.translations.delete(id);
  }
}

app.post("/api/ai/notes", async (req, res) => {
  try {
    const { room } = requireMember(req);
    if (LANGUAGE_NAMES[req.body.language]) room.aiLanguage = req.body.language;
    const notes = await runNotes(room);
    res.json({ notes });
  } catch (error) {
    sendAiError(res, error);
  }
});

function openEventStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

app.post("/api/ai/minutes", async (req, res) => {
  let room;
  try {
    ({ room } = requireMember(req));
  } catch (error) {
    return sendAiError(res, error);
  }

  if (room.minutesBusy) {
    return res.status(409).json({ error: "其他参会者正在生成会议纪要，完成后会自动同步给你。" });
  }

  const language = LANGUAGE_NAMES[req.body.language] ? req.body.language : room.aiLanguage;
  const emit = openEventStream(res);
  room.minutesBusy = true;

  try {
    const markdown = await streamMinutes(room, languageName(language), (delta) => emit("delta", { text: delta }));
    room.minutes = { markdown, createdAt: Date.now(), language };
    emit("done", { minutes: room.minutes });
    broadcast(room, { type: "ai-minutes", minutes: room.minutes });
  } catch (error) {
    emit("error", { error: error.message || "生成会议纪要失败。" });
  } finally {
    room.minutesBusy = false;
    res.end();
  }
});

app.post("/api/ai/ask", async (req, res) => {
  let room;
  try {
    ({ room } = requireMember(req));
  } catch (error) {
    return sendAiError(res, error);
  }

  const question = String(req.body.question || "").trim().slice(0, 1000);
  const history = Array.isArray(req.body.history)
    ? req.body.history
      .filter((t) => t && typeof t.question === "string" && typeof t.answer === "string" && t.answer)
      .map((t) => ({ question: t.question.slice(0, 1000), answer: t.answer.slice(0, 6000) }))
    : [];
  const language = LANGUAGE_NAMES[req.body.language] ? req.body.language : room.aiLanguage;

  if (!question) return res.status(400).json({ error: "请输入问题。" });

  const emit = openEventStream(res);
  try {
    const answer = await streamAnswer(room, question, history, languageName(language), (delta) => emit("delta", { text: delta }));
    emit("done", { answer });
  } catch (error) {
    emit("error", { error: error.message || "AI 回答失败。" });
  } finally {
    res.end();
  }
});

// ---------- 启动 ----------

server.listen(port, "0.0.0.0", () => {
  const ai = aiStatus();
  console.log(`Video meeting app running at http://localhost:${port}`);
  console.log(ai.configured
    ? `AI 助手已启用：${ai.model}${ai.fastModel !== ai.model ? `（翻译：${ai.fastModel}）` : ""}`
    : "AI 助手未配置：在 .env 中设置 ANTHROPIC_API_KEY 后重启即可启用笔记、翻译和纪要。");
});

// ---------- 校验 ----------

function getIceServers() {
  const list = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(",").map((url) => url.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || ""
    });
  }
  return list;
}

function sanitizeMedia(media) {
  return {
    audio: Boolean(media?.audio),
    video: Boolean(media?.video),
    screen: Boolean(media?.screen)
  };
}

function sanitizeWhiteboardOperation(operation) {
  if (!operation || typeof operation !== "object") return null;

  if (operation.type === "clear") {
    return { type: "clear" };
  }

  const id = String(operation.id || "").slice(0, 40) || randomUUID();

  if (operation.type === "remove") {
    return { type: "remove", id };
  }

  if (operation.type === "stroke") {
    const tool = ["pen", "highlighter", "eraser"].includes(operation.tool) ? operation.tool : "pen";
    const points = Array.isArray(operation.points)
      ? operation.points
        .slice(0, 1500)
        .map((point) => ({ x: clampUnit(Number(point?.x)), y: clampUnit(Number(point?.y)) }))
      : [];

    if (points.length < 2) return null;

    return {
      type: "stroke",
      id,
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
      id,
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
