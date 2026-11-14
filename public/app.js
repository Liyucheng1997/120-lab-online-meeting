import { createAi } from "./modules/ai.js";
import { createLevelMonitor, getAudioContext } from "./modules/audio-level.js";
import { hydrateIcons, icon } from "./modules/icons.js";
import { createRecorder } from "./modules/recorder.js";
import {
  $,
  $$,
  closePopover,
  confirmDialog,
  copyText,
  downloadText,
  escapeHtml,
  fileStamp,
  formatDuration,
  formatTime,
  openModal,
  openPopover,
  toast
} from "./modules/ui.js";
import { createWhiteboard } from "./modules/whiteboard.js";

// ============================================================
// 常量与偏好设置
// ============================================================

const REACTIONS = ["👍", "👏", "❤️", "😂", "😮", "🎉", "🤔", "🙏"];
const PREFS_KEY = "meeting-prefs-v2";
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

const FALLBACK_LANGUAGES = {
  "zh-CN": "Simplified Chinese (简体中文)",
  "en-US": "English"
};

function guessSpeechLang() {
  const lang = (navigator.language || "zh-CN").toLowerCase();
  if (lang.startsWith("zh")) return /tw|hk|hant/.test(lang) ? "zh-TW" : "zh-CN";
  const map = { en: "en-US", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES", it: "it-IT", pt: "pt-BR", ru: "ru-RU", ar: "ar-SA" };
  return map[lang.slice(0, 2)] || "zh-CN";
}

const DEFAULT_PREFS = {
  name: localStorage.getItem("meeting-display-name") || "",
  micId: "",
  camId: "",
  speakerId: "",
  speechLang: guessSpeechLang(),
  captionLang: "",
  aiLang: "zh-CN",
  noiseSuppression: true,
  mirror: true,
  showOriginal: true,
  autoCaptions: true,
  micOnJoin: true,
  camOnJoin: true
};

let prefs = { ...DEFAULT_PREFS, ...readJson(PREFS_KEY) };

function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 隐私模式下可能不可写
  }
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") || {};
  } catch {
    return {};
  }
}

// ============================================================
// 状态
// ============================================================

const state = {
  config: { ai: { configured: false }, iceServers: [{ urls: "stun:stun.l.google.com:19302" }], languages: FALLBACK_LANGUAGES },
  roomId: getRoomIdFromPath(),
  selfId: null,
  hostId: null,
  createdAt: Date.now(),
  joinedAt: 0,
  locked: false,
  inMeeting: false,
  leaving: false,
  socket: null,
  reconnectAttempts: 0,
  messageQueue: Promise.resolve(),

  audioTrack: null,
  monitorTrack: null,
  cameraTrack: null,
  screenTrack: null,
  sendStream: new MediaStream(),
  micOn: prefs.micOnJoin,
  camOn: prefs.camOnJoin,
  hand: false,

  peers: new Map(),
  participants: new Map(),

  layout: "grid",
  pinnedId: null,
  activeSpeakerId: null,
  speakerCandidate: { id: null, since: 0 },
  levels: new Map(),
  mutedTalkSince: 0,
  mutedTalkWarnedAt: 0,
  pushToTalk: false,

  panel: null,
  unreadChat: 0,
  chatSenderLast: null,
  recordingNames: [],
  endReason: ""
};

let ai = null;
let whiteboard = null;
let recorder = null;
let lobbyMonitor = null;
let levelMonitor = null;

// ============================================================
// 启动
// ============================================================

hydrateIcons();
applyTheme(false);
boot();

async function boot() {
  try {
    const response = await fetch("/api/config");
    if (response.ok) state.config = await response.json();
  } catch {
    // 使用默认配置
  }

  if (state.roomId) {
    showLobby();
  } else {
    showHome();
  }
}

function showView(id) {
  for (const view of ["homeView", "lobbyView", "meetingView", "endView"]) {
    $(`#${view}`).classList.toggle("hidden", view !== id);
  }
}

function applyTheme(dark) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark || prefersDark ? "dark" : "light";
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  applyTheme(state.inMeeting || !$("#endView").classList.contains("hidden"));
});

// ============================================================
// 首页
// ============================================================

function showHome() {
  showView("homeView");
  const tick = () => {
    $("#homeClock").textContent = new Date().toLocaleString("zh-CN", {
      month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
    });
  };
  tick();
  window.setInterval(tick, 15000);

  const last = readJson("meeting-last-room");
  if (last.roomId && Date.now() - last.at < 6 * 3600 * 1000) {
    const recent = $("#recentMeeting");
    recent.classList.remove("hidden");
    recent.innerHTML = `${icon("clock", 15)}<span>最近：</span><a href="/room/${encodeURIComponent(last.roomId)}">${escapeHtml(last.roomId)}</a>`;
  }
}

$("#newMeetingButton").addEventListener("click", () => {
  window.location.href = `/room/${createRoomId()}`;
});

$("#joinCodeForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("#joinCodeInput").value.trim();
  const fromLink = value.match(/\/room\/([a-zA-Z0-9-]{4,80})/);
  const code = fromLink ? fromLink[1] : value.replace(/\s+/g, "");
  if (!/^[a-zA-Z0-9-]{4,80}$/.test(code)) {
    toast("请输入有效的会议代码或链接", "error");
    $("#joinCodeInput").focus();
    return;
  }
  window.location.href = `/room/${code}`;
});

function createRoomId() {
  const letters = "abcdefghijkmnopqrstuvwxyz";
  const part = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => letters[b % letters.length]).join("");
  return `${part(3)}-${part(4)}-${part(3)}`;
}

function getRoomIdFromPath() {
  const match = window.location.pathname.match(/^\/room\/([a-zA-Z0-9-]{4,80})\/?$/);
  return match?.[1] || "";
}

// ============================================================
// 入会前预览
// ============================================================

async function showLobby() {
  showView("lobbyView");
  applyTheme(false);
  $("#lobbyTitle").textContent = "准备好了吗？";
  $("#lobbyCode").textContent = `会议代码 ${state.roomId}`;
  $("#nameInput").value = new URLSearchParams(window.location.search).get("name") || prefs.name;
  fillLanguageSelect($("#lobbyLangSelect"), prefs.speechLang);
  updatePreviewButtons();

  const resume = () => getAudioContext();
  window.addEventListener("pointerdown", resume, { once: true });

  lobbyMonitor = createLevelMonitor((levels) => {
    const level = levels.get("self")?.level || 0;
    $("#previewMeter").style.transform = `scaleX(${state.micOn ? level : 0})`;
  });

  setLobbyHint("正在请求摄像头和麦克风权限…");
  await acquireInitialMedia();
  if (!state.audioTrack) state.micOn = false;
  if (!state.cameraTrack) state.camOn = false;
  await refreshDeviceLists();
  updatePreview();
  setLobbyHint(lobbyMediaHint());
  if (!$("#nameInput").value) $("#nameInput").focus();
}

function setLobbyHint(text, kind = "") {
  const hint = $("#lobbyHint");
  hint.textContent = text;
  hint.dataset.kind = kind;
}

function lobbyMediaHint() {
  if (!state.audioTrack && !state.cameraTrack) {
    return "没有拿到摄像头和麦克风权限。你仍可以加入会议观看和聊天。";
  }
  if (!state.audioTrack) return "没有可用的麦克风，其他人将听不到你。";
  if (state.camOn && !state.cameraTrack) return "摄像头不可用，将以头像显示。";
  return window.isSecureContext ? "" : "提示：非 HTTPS 环境下部分浏览器会禁用摄像头。";
}

function audioConstraints(deviceId = prefs.micId) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: prefs.noiseSuppression,
    autoGainControl: true
  };
}

function videoConstraints(deviceId = prefs.camId) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 }
  };
}

async function acquireInitialMedia() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  const wantVideo = state.camOn;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: wantVideo ? videoConstraints() : false });
    setAudioTrack(stream.getAudioTracks()[0] || null);
    state.cameraTrack = stream.getVideoTracks()[0] || null;
    return;
  } catch (error) {
    console.warn("同时获取音视频失败，分别重试", error);
  }

  setAudioTrack(await openMic());
  if (wantVideo) state.cameraTrack = await openCamera();
}

async function openMic(deviceId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId) });
    return stream.getAudioTracks()[0] || null;
  } catch (error) {
    if (deviceId || prefs.micId) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints("") });
        return stream.getAudioTracks()[0] || null;
      } catch {
        // 继续返回 null
      }
    }
    console.warn("无法打开麦克风", error);
    return null;
  }
}

async function openCamera(deviceId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(deviceId) });
    const track = stream.getVideoTracks()[0] || null;
    if (track) track.contentHint = "motion";
    return track;
  } catch (error) {
    if (deviceId || prefs.camId) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints("") });
        return stream.getVideoTracks()[0] || null;
      } catch {
        // 继续返回 null
      }
    }
    console.warn("无法打开摄像头", error);
    return null;
  }
}

/** 设置麦克风轨道，同时维护一个始终开启的副本用于音量检测（静音时也能提示“你在说话”）。 */
function setAudioTrack(track) {
  state.monitorTrack?.stop();
  state.audioTrack = track;
  state.monitorTrack = track ? track.clone() : null;
  if (track) track.enabled = state.micOn;
  const monitorStream = state.monitorTrack ? new MediaStream([state.monitorTrack]) : null;
  lobbyMonitor?.track("self", monitorStream);
  if (levelMonitor) {
    if (monitorStream) levelMonitor.track("self", monitorStream);
    else levelMonitor.untrack("self");
  }
}

function updatePreview() {
  const video = $("#previewVideo");
  const showVideo = state.camOn && state.cameraTrack;
  video.srcObject = showVideo ? new MediaStream([state.cameraTrack]) : null;
  video.classList.toggle("mirror", prefs.mirror);
  video.classList.toggle("hidden", !showVideo);
  const avatar = $("#previewAvatar");
  avatar.classList.toggle("hidden", Boolean(showVideo));
  $("span", avatar).textContent = initial($("#nameInput").value || "我");
  updatePreviewButtons();
}

function updatePreviewButtons() {
  const mic = $("#previewMicButton");
  const cam = $("#previewCamButton");
  mic.innerHTML = icon(state.micOn ? "mic" : "micOff", 22);
  cam.innerHTML = icon(state.camOn ? "video" : "videoOff", 22);
  mic.classList.toggle("off", !state.micOn);
  cam.classList.toggle("off", !state.camOn);
  mic.title = state.micOn ? "关闭麦克风" : "打开麦克风";
  cam.title = state.camOn ? "关闭摄像头" : "打开摄像头";
}

$("#previewMicButton").addEventListener("click", async () => {
  state.micOn = !state.micOn;
  if (state.micOn && !state.audioTrack) setAudioTrack(await openMic());
  if (state.audioTrack) state.audioTrack.enabled = state.micOn;
  savePrefs({ micOnJoin: state.micOn });
  updatePreviewButtons();
});

$("#previewCamButton").addEventListener("click", async () => {
  state.camOn = !state.camOn;
  if (state.camOn) {
    if (!state.cameraTrack) state.cameraTrack = await openCamera();
    if (!state.cameraTrack) {
      state.camOn = false;
      toast("摄像头不可用", "error");
    }
  } else {
    state.cameraTrack?.stop();
    state.cameraTrack = null;
  }
  savePrefs({ camOnJoin: state.camOn });
  updatePreview();
});

$("#nameInput").addEventListener("input", () => {
  $("#previewAvatar span").textContent = initial($("#nameInput").value || "我");
});

$("#lobbyMicSelect").addEventListener("change", async (event) => {
  savePrefs({ micId: event.target.value });
  await switchMic(event.target.value);
});

$("#lobbyCamSelect").addEventListener("change", async (event) => {
  savePrefs({ camId: event.target.value });
  await switchCamera(event.target.value);
  updatePreview();
});

$("#lobbyLangSelect").addEventListener("change", (event) => savePrefs({ speechLang: event.target.value }));

$("#joinForm").addEventListener("submit", (event) => {
  event.preventDefault();
  joinMeeting();
});

async function refreshDeviceLists() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (select, kind, current, emptyText) => {
    if (!select) return;
    const items = devices.filter((d) => d.kind === kind);
    select.innerHTML = "";
    if (!items.length) {
      select.innerHTML = `<option value="">${emptyText}</option>`;
      select.disabled = true;
      return;
    }
    select.disabled = false;
    items.forEach((device, i) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `${emptyText.replace("没有", "")} ${i + 1}`;
      select.append(option);
    });
    select.value = items.some((d) => d.deviceId === current) ? current : items[0].deviceId;
  };

  const micId = state.audioTrack?.getSettings().deviceId || prefs.micId;
  const camId = state.cameraTrack?.getSettings().deviceId || prefs.camId;
  for (const select of $$("[data-devices='audioinput'], #lobbyMicSelect")) fill(select, "audioinput", micId, "没有麦克风");
  for (const select of $$("[data-devices='videoinput'], #lobbyCamSelect")) fill(select, "videoinput", camId, "没有摄像头");
  for (const select of $$("[data-devices='audiooutput']")) fill(select, "audiooutput", prefs.speakerId, "系统默认");
}

navigator.mediaDevices?.addEventListener?.("devicechange", () => refreshDeviceLists());

function fillLanguageSelect(select, value, extra) {
  select.innerHTML = "";
  const entries = Object.entries(state.config.languages || FALLBACK_LANGUAGES);
  if (extra) entries.unshift(extra);
  for (const [code, name] of entries) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = name;
    select.append(option);
  }
  select.value = value;
}

// ============================================================
// 加入会议
// ============================================================

function joinMeeting() {
  const name = $("#nameInput").value.trim() || `用户${Math.floor(Math.random() * 900 + 100)}`;
  savePrefs({ name });
  localStorage.setItem("meeting-display-name", name);
  state.displayName = name;
  $("#joinButton").disabled = true;
  setLobbyHint("正在连接会议…");
  getAudioContext();
  connectSocket();
}

function enterMeetingUi() {
  if (state.inMeeting) return;
  state.inMeeting = true;
  state.joinedAt = Date.now();
  if (!state.audioTrack) state.micOn = false;
  if (!state.cameraTrack) state.camOn = false;
  lobbyMonitor?.stop();
  lobbyMonitor = null;
  applyTheme(true);
  showView("meetingView");

  try {
    localStorage.setItem("meeting-last-room", JSON.stringify({ roomId: state.roomId, at: Date.now() }));
  } catch {
    // 忽略
  }

  $("#meetingTitle").textContent = state.roomId;
  document.title = `${state.roomId} · 云会议`;

  levelMonitor = createLevelMonitor(onLevels);
  if (state.monitorTrack) levelMonitor.track("self", new MediaStream([state.monitorTrack]));

  ai = createAi({
    config: state.config,
    languages: state.config.languages || FALLBACK_LANGUAGES,
    send,
    prefs: () => prefs,
    savePrefs,
    roomId: () => state.roomId,
    selfId: () => state.selfId,
    selfName: () => state.displayName,
    createdAt: () => state.createdAt,
    isMicOn: () => state.micOn && Boolean(state.audioTrack),
    onTranscription: (active, by) => {
      $("#transcribeBadge").classList.toggle("hidden", !active);
      $("#transcribeBadge").title = active ? `由 ${by} 开启，所有人的发言会被转写` : "";
    },
    onCaptionsChange: (visible) => setPressed($("#captionButton"), visible)
  });

  whiteboard = createWhiteboard({
    send,
    getSelfId: () => state.selfId,
    onToggle: () => {}
  });

  recorder = createRecorder({
    stage: $("#stage"),
    getTiles: recordingTiles,
    getAudioTracks: () => [
      state.audioTrack && state.micOn ? state.audioTrack : null,
      ...[...state.peers.values()].flatMap((peer) => peer.stream.getAudioTracks())
    ].filter(Boolean)
  });

  ensureTile(state.selfId || "self");
  updateControls();
  window.setInterval(tickClock, 1000);
  window.setInterval(collectStats, 3000);
  window.addEventListener("resize", scheduleLayout);
  new ResizeObserver(scheduleLayout).observe($("#stage"));
  tickClock();
}

// ============================================================
// 信令
// ============================================================

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    send({ type: "join", roomId: state.roomId, name: state.displayName, media: currentMedia() });
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    // 串行处理，保证 SDP / ICE 的顺序。
    state.messageQueue = state.messageQueue
      .then(() => handleMessage(message))
      .catch((error) => console.error("处理消息失败", message.type, error));
  });

  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    state.socket = null;
    if (state.leaving || state.endReason) return;

    if (!state.inMeeting) {
      $("#joinButton").disabled = false;
      setLobbyHint("无法连接到会议服务器，请稍后重试。", "error");
      return;
    }

    resetPeers();
    setConnection("正在重新连接…", "warn");
    const delay = Math.min(10000, 1000 * 2 ** state.reconnectAttempts);
    state.reconnectAttempts += 1;
    window.setTimeout(() => {
      if (!state.leaving && !state.endReason) connectSocket();
    }, delay);
  });
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
  }
}

function sendSignal(to, signal) {
  send({ type: "signal", to, signal });
}

async function handleMessage(message) {
  switch (message.type) {
    case "joined":
      return onJoined(message);
    case "join-error":
      state.socket?.close();
      state.socket = null;
      if (state.inMeeting) {
        showEnd(message.message);
      } else {
        $("#joinButton").disabled = false;
        setLobbyHint(message.message, "error");
      }
      return;
    case "user-joined":
      upsertParticipant(message.user);
      toast(`${message.user.name} 加入了会议`);
      return;
    case "user-left":
      removeParticipant(message.id);
      if (message.reason === "removed") toast(`${message.name} 已被移出会议`);
      else if (message.reason !== "ended") toast(`${message.name} 离开了会议`);
      return;
    case "signal":
      return handleSignal(message.from, message.signal);
    case "media": {
      const participant = state.participants.get(message.id);
      if (participant) {
        participant.media = message.media;
        updateTile(message.id);
        renderParticipants();
        scheduleLayout();
      }
      return;
    }
    case "hand":
      return onHand(message);
    case "reaction":
      return showReaction(message.id, message.name, message.emoji);
    case "chat":
      return addChatMessage(message);
    case "whiteboard":
      whiteboard?.applyRemote(message.operation);
      return;
    case "caption":
      ai?.handleCaption(message);
      return;
    case "transcription":
      if (message.active) toast(`${message.by} 开启了 AI 会议记录`, "info", 3500);
      else toast(`${message.by} 关闭了 AI 会议记录`);
      ai?.handleTranscription(message);
      return;
    case "ai-notes":
      ai?.handleNotes(message.notes);
      return;
    case "ai-notes-status":
      ai?.handleNotesStatus(message);
      return;
    case "ai-minutes":
      ai?.handleMinutes(message.minutes);
      return;
    case "recording":
      return onRecordingState(message.names || []);
    case "host-changed":
      state.hostId = message.hostId;
      if (message.hostId === state.selfId) toast("你现在是主持人", "success");
      else toast(`${message.name} 成为主持人`);
      renderParticipants();
      refreshAllTiles();
      return;
    case "locked":
      state.locked = message.locked;
      toast(message.locked ? `${message.by} 锁定了会议` : `${message.by} 解锁了会议`);
      updateLockUi();
      return;
    case "force-mute":
      if (state.micOn) {
        await setMic(false);
        toast(`主持人 ${message.by} 将你静音了`, "info", 3500);
      }
      return;
    case "force-video-off":
      if (state.camOn) {
        await setCam(false);
        toast(`主持人 ${message.by} 关闭了你的摄像头`, "info", 3500);
      }
      return;
    case "removed":
      state.endReason = `你已被主持人 ${message.by} 移出会议`;
      leaveMeeting(false);
      return;
    case "meeting-ended":
      state.endReason = `主持人 ${message.by} 已结束会议`;
      leaveMeeting(false);
      return;
    case "error":
      toast(message.message, "error");
      return;
    default:
      return;
  }
}

async function onJoined(message) {
  const firstJoin = !state.inMeeting;
  state.reconnectAttempts = 0;
  const oldSelfId = state.selfId;
  state.selfId = message.id;
  state.hostId = message.hostId;
  state.locked = message.locked;
  state.createdAt = message.createdAt || Date.now();

  if (firstJoin) enterMeetingUi();

  // 本地画面的 id 从临时值换成服务器分配的 id
  const selfTile = $(`[data-id="${CSS.escape(oldSelfId || "self")}"]`);
  if (selfTile) selfTile.dataset.id = state.selfId;
  if (oldSelfId && oldSelfId !== state.selfId) state.participants.delete(oldSelfId);
  state.participants.delete("self");

  state.participants.set(state.selfId, {
    id: state.selfId,
    name: state.displayName,
    media: currentMedia(),
    hand: false,
    joinedAt: Date.now(),
    self: true
  });
  state.hand = false;

  for (const user of message.users) {
    upsertParticipant(user, { silent: true });
    createPeer(user.id, true);
  }

  whiteboard.load(message.whiteboard);
  if (firstJoin) {
    for (const item of message.chat || []) addChatMessage(item, { history: true });
  }
  ai.handleJoined(message);
  onRecordingState(message.recording || []);
  updateLockUi();
  refreshAllTiles();
  renderParticipants();
  updateControls();
  setConnection("", "");
  scheduleLayout();

  if (firstJoin) {
    const others = message.users.length;
    toast(others ? `已加入会议，另有 ${others} 人在线` : "已加入会议。复制邀请链接发给其他人吧", "success", 3500);
  } else {
    toast("已重新连接", "success");
  }
}

// ============================================================
// WebRTC：perfect negotiation
// ============================================================

function createPeer(id, initiator) {
  if (state.peers.has(id)) return state.peers.get(id);

  const pc = new RTCPeerConnection({ iceServers: state.config.iceServers, bundlePolicy: "max-bundle" });
  const peer = {
    id,
    pc,
    polite: String(state.selfId) > String(id),
    makingOffer: false,
    ignoreOffer: false,
    pendingCandidates: [],
    stream: new MediaStream(),
    audioSender: null,
    videoSender: null,
    quality: 3,
    lastStats: null
  };
  state.peers.set(id, peer);

  if (initiator) {
    const audio = pc.addTransceiver(state.audioTrack || "audio", { direction: "sendrecv", streams: [state.sendStream] });
    const video = pc.addTransceiver(outgoingVideoTrack() || "video", { direction: "sendrecv", streams: [state.sendStream] });
    peer.audioSender = audio.sender;
    peer.videoSender = video.sender;
    preferCodecs(video);
  }

  pc.addEventListener("negotiationneeded", async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(id, { description: pc.localDescription });
    } catch (error) {
      console.error("创建 offer 失败", error);
    } finally {
      peer.makingOffer = false;
    }
  });

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) sendSignal(id, { candidate: event.candidate });
  });

  pc.addEventListener("track", (event) => {
    if (!peer.stream.getTracks().includes(event.track)) peer.stream.addTrack(event.track);
    const tile = ensureTile(id);
    const video = $("video", tile);
    if (video.srcObject !== peer.stream) video.srcObject = peer.stream;
    applySink(video);
    video.play().catch(() => {});
    if (event.track.kind === "audio") levelMonitor?.track(id, peer.stream);
    event.track.addEventListener("unmute", () => updateTile(id));
  });

  pc.addEventListener("connectionstatechange", () => {
    const tile = $(`[data-id="${CSS.escape(id)}"]`);
    tile?.classList.toggle("reconnecting", pc.connectionState === "disconnected" || pc.connectionState === "failed");
    if (pc.connectionState === "failed") pc.restartIce();
    if (pc.connectionState === "connected") applyBitrateLimits();
  });

  ensureTile(id);
  return peer;
}

/** 对方发来 offer 时，把本地音视频挂到对应的收发器上。 */
async function attachLocalTracks(peer) {
  for (const transceiver of peer.pc.getTransceivers()) {
    const kind = transceiver.receiver.track?.kind;
    if (kind === "audio" && !peer.audioSender) {
      transceiver.direction = "sendrecv";
      peer.audioSender = transceiver.sender;
      await transceiver.sender.replaceTrack(state.audioTrack);
      transceiver.sender.setStreams?.(state.sendStream);
    } else if (kind === "video" && !peer.videoSender) {
      transceiver.direction = "sendrecv";
      peer.videoSender = transceiver.sender;
      preferCodecs(transceiver);
      await transceiver.sender.replaceTrack(outgoingVideoTrack());
      transceiver.sender.setStreams?.(state.sendStream);
    }
  }
}

async function handleSignal(from, signal) {
  if (!state.participants.has(from)) return;
  const peer = createPeer(from, false);
  const { pc } = peer;

  try {
    if (signal.description) {
      const description = signal.description;
      const collision = description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;

      await pc.setRemoteDescription(description);
      if (description.type === "offer") {
        await attachLocalTracks(peer);
        await pc.setLocalDescription();
        sendSignal(from, { description: pc.localDescription });
      }

      for (const candidate of peer.pendingCandidates.splice(0)) {
        await pc.addIceCandidate(candidate).catch(() => {});
      }
    } else if (signal.candidate) {
      if (!pc.remoteDescription) {
        peer.pendingCandidates.push(signal.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch (error) {
        if (!peer.ignoreOffer) console.warn("ICE candidate 失败", error);
      }
    }
  } catch (error) {
    console.error("信令处理失败", error);
  }
}

function preferCodecs(transceiver) {
  // 优先 VP9 / H264 等更省带宽的编码（浏览器支持时）。
  try {
    const caps = RTCRtpReceiver.getCapabilities?.("video");
    if (!caps || !transceiver.setCodecPreferences) return;
    const rank = (codec) => {
      const type = codec.mimeType.toLowerCase();
      if (type === "video/vp9") return 0;
      if (type === "video/vp8") return 1;
      if (type === "video/h264") return 2;
      return 3;
    };
    transceiver.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
  } catch {
    // 不支持就用默认
  }
}

/** 网状拓扑：人越多，每路上行码率越低，避免上行带宽被占满。 */
async function applyBitrateLimits() {
  const count = state.peers.size;
  const sharing = Boolean(state.screenTrack);
  const maxBitrate = sharing
    ? count <= 2 ? 2_500_000 : 1_200_000
    : count <= 1 ? 1_800_000 : count <= 3 ? 900_000 : count <= 6 ? 500_000 : 300_000;

  for (const peer of state.peers.values()) {
    const sender = peer.videoSender;
    if (!sender) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      params.encodings[0].maxBitrate = maxBitrate;
      if (sharing) params.degradationPreference = "maintain-resolution";
      await sender.setParameters(params);
    } catch {
      // 协商未完成时会失败，连接建立后会再次调用
    }
  }
}

function resetPeers() {
  for (const id of [...state.peers.keys()]) closePeer(id);
  for (const id of [...state.participants.keys()]) {
    if (id !== state.selfId) {
      state.participants.delete(id);
      removeTile(id);
    }
  }
  renderParticipants();
  scheduleLayout();
}

function closePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc.close();
  state.peers.delete(id);
  levelMonitor?.untrack(id);
}

async function collectStats() {
  for (const peer of state.peers.values()) {
    if (peer.pc.connectionState !== "connected") continue;
    try {
      const report = await peer.pc.getStats();
      let rtt = 0;
      let lost = 0;
      let received = 0;
      report.forEach((stat) => {
        if (stat.type === "candidate-pair" && stat.nominated && stat.state === "succeeded") {
          rtt = stat.currentRoundTripTime || rtt;
        }
        if (stat.type === "inbound-rtp" && !stat.isRemote) {
          lost += stat.packetsLost || 0;
          received += stat.packetsReceived || 0;
        }
      });
      const prev = peer.lastStats;
      peer.lastStats = { lost, received };
      const dLost = prev ? Math.max(0, lost - prev.lost) : 0;
      const dReceived = prev ? Math.max(0, received - prev.received) : 0;
      const loss = dLost + dReceived ? dLost / (dLost + dReceived) : 0;
      const quality = rtt < 0.25 && loss < 0.02 ? 3 : rtt < 0.5 && loss < 0.08 ? 2 : 1;
      if (quality !== peer.quality) {
        peer.quality = quality;
        const tile = $(`[data-id="${CSS.escape(peer.id)}"]`);
        if (tile) {
          tile.dataset.quality = String(quality);
          $(".tile-net", tile).title = ["", "网络较差", "网络一般", "网络良好"][quality];
        }
      }
    } catch {
      // 忽略
    }
  }
}

// ============================================================
// 本地媒体控制
// ============================================================

function outgoingVideoTrack() {
  return state.screenTrack || (state.camOn ? state.cameraTrack : null) || null;
}

function currentMedia() {
  return {
    audio: state.micOn && Boolean(state.audioTrack),
    video: state.camOn && Boolean(state.cameraTrack),
    screen: Boolean(state.screenTrack)
  };
}

function broadcastMedia() {
  const self = state.participants.get(state.selfId);
  if (self) self.media = currentMedia();
  send({ type: "media", media: currentMedia() });
  updateTile(state.selfId);
  renderParticipants();
  updateControls();
  scheduleLayout();
}

async function replaceSenders(kind, track) {
  await Promise.all(
    [...state.peers.values()].map(async (peer) => {
      const sender = kind === "audio" ? peer.audioSender : peer.videoSender;
      if (!sender) return;
      try {
        await sender.replaceTrack(track);
      } catch (error) {
        console.warn("替换轨道失败", error);
      }
    })
  );
}

async function setMic(on) {
  if (on && !state.audioTrack) {
    const track = await openMic();
    if (!track) {
      toast("麦克风不可用，请检查浏览器权限", "error");
      return;
    }
    setAudioTrack(track);
    await replaceSenders("audio", track);
  }
  state.micOn = on;
  if (state.audioTrack) state.audioTrack.enabled = on;
  ai?.syncRecognition();
  broadcastMedia();
}

async function setCam(on) {
  if (on) {
    if (!state.cameraTrack) state.cameraTrack = await openCamera();
    if (!state.cameraTrack) {
      toast("摄像头不可用，请检查浏览器权限", "error");
      return;
    }
    state.camOn = true;
  } else {
    state.camOn = false;
    // 真正关闭摄像头（指示灯熄灭），而不是只发送黑屏。
    state.cameraTrack?.stop();
    state.cameraTrack = null;
  }
  if (!state.screenTrack) await replaceSenders("video", outgoingVideoTrack());
  updateLocalVideo();
  broadcastMedia();
}

async function switchMic(deviceId) {
  const track = await openMic(deviceId);
  if (!track) {
    toast("无法切换到这个麦克风", "error");
    return;
  }
  const old = state.audioTrack;
  setAudioTrack(track);
  await replaceSenders("audio", track);
  old?.stop();
  ai?.restartRecognition();
}

async function switchCamera(deviceId) {
  if (!state.camOn) return;
  const track = await openCamera(deviceId);
  if (!track) {
    toast("无法切换到这个摄像头", "error");
    return;
  }
  const old = state.cameraTrack;
  state.cameraTrack = track;
  if (!state.screenTrack) await replaceSenders("video", track);
  old?.stop();
  updateLocalVideo();
}

async function startScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("当前浏览器不支持共享屏幕", "error");
    return;
  }
  const sharer = [...state.participants.values()].find((p) => !p.self && p.media?.screen);
  if (sharer) {
    const ok = await confirmDialog({ title: "共享屏幕", message: `${sharer.name} 正在共享屏幕。你也要共享吗？`, confirmLabel: "继续共享" });
    if (!ok) return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false
    });
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    track.contentHint = "detail";
    track.addEventListener("ended", () => stopScreenShare(), { once: true });
    state.screenTrack = track;
    await replaceSenders("video", track);
    await applyBitrateLimits();
    updateLocalVideo();
    broadcastMedia();
    toast("正在共享屏幕", "success");
  } catch (error) {
    if (error?.name !== "NotAllowedError") toast("共享屏幕失败", "error");
  }
}

async function stopScreenShare() {
  const track = state.screenTrack;
  if (!track) return;
  state.screenTrack = null;
  await replaceSenders("video", outgoingVideoTrack());
  if (track.readyState !== "ended") track.stop();
  await applyBitrateLimits();
  updateLocalVideo();
  broadcastMedia();
}

function updateLocalVideo() {
  const tile = $(`[data-id="${CSS.escape(state.selfId || "self")}"]`);
  if (!tile) return;
  const video = $("video", tile);
  const track = state.screenTrack || (state.camOn ? state.cameraTrack : null);
  video.srcObject = track ? new MediaStream([track]) : null;
  if (track) video.play().catch(() => {});
  updateTile(state.selfId || "self");
}

// ============================================================
// 画面与布局
// ============================================================

function ensureTile(id) {
  let tile = $(`#videoGrid [data-id="${CSS.escape(id)}"]`);
  if (tile) return tile;

  tile = document.createElement("article");
  tile.className = "tile";
  tile.dataset.id = id;
  tile.dataset.quality = "3";
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-avatar"><span class="avatar"></span></div>
    <span class="tile-hand" aria-label="举手">✋</span>
    <span class="tile-reaction"></span>
    <div class="tile-foot"><span class="tile-mic"></span><span class="tile-name"></span></div>
    <span class="tile-net" title="网络良好"><i></i><i></i><i></i></span>
    <span class="tile-reconnect">重新连接中…</span>
    <div class="tile-actions">
      <button type="button" data-act="pin" title="固定画面">${icon("pin", 16)}</button>
      <button type="button" data-act="full" title="全屏">${icon("maximize", 16)}</button>
    </div>`;

  const isSelf = id === state.selfId || id === "self";
  const video = $("video", tile);
  video.muted = isSelf;
  if (isSelf) tile.classList.add("self");

  tile.addEventListener("dblclick", () => togglePin(tile.dataset.id));
  $("[data-act='pin']", tile).addEventListener("click", () => togglePin(tile.dataset.id));
  $("[data-act='full']", tile).addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else tile.requestFullscreen?.().catch(() => {});
  });

  $("#videoGrid").append(tile);
  if (isSelf) updateLocalVideo();
  updateTile(id);
  scheduleLayout();
  return tile;
}

function removeTile(id) {
  $(`#videoGrid [data-id="${CSS.escape(id)}"]`)?.remove();
  if (state.pinnedId === id) state.pinnedId = null;
  if (state.activeSpeakerId === id) state.activeSpeakerId = null;
  scheduleLayout();
}

function updateTile(id) {
  const tile = $(`#videoGrid [data-id="${CSS.escape(id)}"]`);
  if (!tile) return;
  const isSelf = id === state.selfId || id === "self";
  const participant = state.participants.get(id);
  const media = isSelf ? currentMedia() : participant?.media || { audio: true, video: true, screen: false };
  const name = isSelf ? `${state.displayName || "我"}（我）` : participant?.name || "参会者";
  const showVideo = media.video || media.screen;

  tile.classList.toggle("no-video", !showVideo);
  tile.classList.toggle("screen", Boolean(media.screen));
  tile.classList.toggle("mirror", isSelf && !media.screen && prefs.mirror);
  tile.classList.toggle("muted", !media.audio);
  tile.classList.toggle("hand-up", Boolean(isSelf ? state.hand : participant?.hand));
  tile.classList.toggle("pinned", state.pinnedId === id);
  tile.classList.toggle("is-host", state.hostId === id);
  $(".tile-name", tile).textContent = media.screen ? `${name} · 屏幕共享` : name;
  $(".tile-mic", tile).innerHTML = media.audio ? "" : icon("micOff", 14);
  $(".avatar", tile).textContent = initial(isSelf ? state.displayName : participant?.name);
  $("[data-act='pin']", tile).title = state.pinnedId === id ? "取消固定" : "固定画面";
}

function refreshAllTiles() {
  for (const tile of $$("#videoGrid .tile")) updateTile(tile.dataset.id);
}

function togglePin(id) {
  state.pinnedId = state.pinnedId === id ? null : id;
  refreshAllTiles();
  scheduleLayout();
}

let layoutFrame = 0;
function scheduleLayout() {
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    layoutTiles();
  });
}

function effectiveLayout(count) {
  if (count < 2) return "grid";
  const sharing = [...state.participants.values()].some((p) => (p.self ? state.screenTrack : p.media?.screen));
  if (state.pinnedId || sharing || state.layout === "speaker") return "speaker";
  return "grid";
}

function mainTileId(ids) {
  if (state.pinnedId && ids.includes(state.pinnedId)) return state.pinnedId;
  const remoteSharer = ids.find((id) => id !== state.selfId && state.participants.get(id)?.media?.screen);
  if (remoteSharer) return remoteSharer;
  if (state.screenTrack && ids.includes(state.selfId)) return state.selfId;
  if (state.activeSpeakerId && ids.includes(state.activeSpeakerId)) return state.activeSpeakerId;
  return ids.find((id) => id !== state.selfId) || ids[0];
}

function layoutTiles() {
  const grid = $("#videoGrid");
  const tiles = $$(".tile", grid);
  const W = grid.clientWidth;
  const H = grid.clientHeight;
  if (!W || !H || !tiles.length) return;

  const gap = W < 600 ? 6 : 10;
  const ids = tiles.map((t) => t.dataset.id);
  const mode = effectiveLayout(tiles.length);
  $("#layoutButton").innerHTML = icon(state.layout === "speaker" ? "speaker" : "grid", 18);
  grid.dataset.mode = mode;

  const place = (tile, x, y, w, h, hidden = false) => {
    tile.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    tile.style.width = `${Math.round(w)}px`;
    tile.style.height = `${Math.round(h)}px`;
    tile.classList.toggle("off-stage", hidden);
  };

  if (mode === "grid") {
    const n = tiles.length;
    let best = { cols: 1, w: 0, h: 0 };
    for (let cols = 1; cols <= n; cols += 1) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
      if (w > best.w) best = { cols, w, h: w * (9 / 16) };
    }
    const rows = Math.ceil(n / best.cols);
    const totalH = rows * best.h + (rows - 1) * gap;
    const top = (H - totalH) / 2;
    tiles.forEach((tile, i) => {
      const row = Math.floor(i / best.cols);
      const inRow = row === rows - 1 ? n - row * best.cols : best.cols;
      const col = i - row * best.cols;
      const rowW = inRow * best.w + (inRow - 1) * gap;
      const left = (W - rowW) / 2;
      tile.classList.remove("is-main");
      place(tile, left + col * (best.w + gap), top + row * (best.h + gap), best.w, best.h);
    });
    return;
  }

  // 主讲人视图：大画面 + 侧边/底部小画面条
  const mainId = mainTileId(ids);
  const others = tiles.filter((t) => t.dataset.id !== mainId);
  const vertical = W >= 720 && W / H > 1.15;

  if (vertical) {
    const stripW = Math.max(150, Math.min(240, W * 0.2));
    const stripH = stripW * (9 / 16);
    const maxCount = Math.max(1, Math.floor((H + gap) / (stripH + gap)));
    const shown = others.slice(0, maxCount);
    const totalH = shown.length * stripH + (shown.length - 1) * gap;
    const top = Math.max(0, (H - totalH) / 2);
    others.forEach((tile, i) => {
      tile.classList.remove("is-main");
      if (i < maxCount) place(tile, W - stripW, top + i * (stripH + gap), stripW, stripH);
      else place(tile, W - stripW, H, stripW, stripH, true);
    });
    const main = tiles.find((t) => t.dataset.id === mainId);
    main.classList.add("is-main");
    place(main, 0, 0, W - stripW - gap, H);
  } else {
    const stripH = Math.max(64, Math.min(120, H * 0.18));
    const stripW = stripH * (16 / 9);
    const maxCount = Math.max(1, Math.floor((W + gap) / (stripW + gap)));
    const shown = others.slice(0, maxCount);
    const totalW = shown.length * stripW + (shown.length - 1) * gap;
    const left = Math.max(0, (W - totalW) / 2);
    others.forEach((tile, i) => {
      tile.classList.remove("is-main");
      if (i < maxCount) place(tile, left + i * (stripW + gap), H - stripH, stripW, stripH);
      else place(tile, W, H - stripH, stripW, stripH, true);
    });
    const main = tiles.find((t) => t.dataset.id === mainId);
    main.classList.add("is-main");
    place(main, 0, 0, W, H - stripH - gap);
  }
}

function onLevels(levels) {
  const now = performance.now();
  let loudest = null;
  let loudestLevel = 0;

  for (const [rawId, info] of levels) {
    const id = rawId === "self" ? state.selfId : rawId;
    const isSelf = rawId === "self";
    const speaking = info.speaking && (!isSelf || state.micOn);
    const tile = $(`#videoGrid [data-id="${CSS.escape(id || "self")}"]`);
    tile?.classList.toggle("speaking", speaking);
    if (isSelf) {
      state.levels.set("self", info.level);
      updateMicMeter(state.micOn ? info.level : 0);
      checkMutedTalking(info, now);
      continue;
    }
    if (speaking && info.level > loudestLevel) {
      loudest = id;
      loudestLevel = info.level;
    }
  }

  // 主讲人切换加入 1.2 秒防抖，避免画面来回跳。
  if (loudest && loudest !== state.activeSpeakerId) {
    if (state.speakerCandidate.id !== loudest) state.speakerCandidate = { id: loudest, since: now };
    else if (now - state.speakerCandidate.since > 1200) {
      state.activeSpeakerId = loudest;
      if ($("#videoGrid").dataset.mode === "speaker") scheduleLayout();
    }
  }
}

function checkMutedTalking(info, now) {
  if (state.micOn || !state.audioTrack || info.level < 0.25) {
    if (info.level < 0.1) state.mutedTalkSince = 0;
    return;
  }
  if (!state.mutedTalkSince) state.mutedTalkSince = now;
  if (now - state.mutedTalkSince > 1500 && now - state.mutedTalkWarnedAt > 45000) {
    state.mutedTalkWarnedAt = now;
    toast("你好像在说话，但麦克风已静音。按住空格键可临时发言", "info", 4500);
  }
}

function updateMicMeter(level) {
  const button = $("#micButton");
  button.style.setProperty("--level", String(Math.min(1, level * 1.4)));
}

function recordingTiles() {
  return $$("#videoGrid .tile:not(.off-stage)").map((tile) => {
    const id = tile.dataset.id;
    const isSelf = id === state.selfId;
    const participant = state.participants.get(id);
    return {
      element: tile,
      video: $("video", tile),
      name: isSelf ? state.displayName : participant?.name || "",
      showVideo: !tile.classList.contains("no-video"),
      contain: tile.classList.contains("screen"),
      mirror: tile.classList.contains("mirror")
    };
  });
}

function applySink(video) {
  if (prefs.speakerId && typeof video.setSinkId === "function") {
    video.setSinkId(prefs.speakerId).catch(() => {});
  }
}

// ============================================================
// 参会者
// ============================================================

function upsertParticipant(user) {
  const existing = state.participants.get(user.id);
  state.participants.set(user.id, { ...existing, ...user, self: false });
  ensureTile(user.id);
  updateTile(user.id);
  renderParticipants();
  applyBitrateLimits();
}

function removeParticipant(id) {
  closePeer(id);
  state.participants.delete(id);
  removeTile(id);
  renderParticipants();
  applyBitrateLimits();
}

function isHost() {
  return state.hostId && state.hostId === state.selfId;
}

function renderParticipants() {
  const list = $("#participantList");
  const people = [...state.participants.values()].sort((a, b) => {
    if (Boolean(b.hand) !== Boolean(a.hand)) return b.hand ? 1 : -1;
    if (a.self !== b.self) return a.self ? -1 : 1;
    if ((a.id === state.hostId) !== (b.id === state.hostId)) return a.id === state.hostId ? -1 : 1;
    return (a.joinedAt || 0) - (b.joinedAt || 0);
  });

  $("#peopleCount").textContent = String(people.length);
  const badge = $("#peopleBadge");
  badge.textContent = String(people.length);
  badge.classList.toggle("hidden", people.length < 2);
  $("#hostTools").classList.toggle("hidden", !isHost());

  list.innerHTML = people
    .map((p) => {
      const media = p.self ? currentMedia() : p.media || {};
      const hand = p.self ? state.hand : p.hand;
      return `<li class="person" data-person="${escapeHtml(p.id)}">
        <span class="avatar sm">${escapeHtml(initial(p.name))}</span>
        <div class="person-name">
          <b>${escapeHtml(p.name)}${p.self ? "（我）" : ""}</b>
          <small>${p.id === state.hostId ? "主持人" : "参会者"}${media.screen ? " · 正在共享" : ""}</small>
        </div>
        <span class="person-icons">
          ${hand ? '<span class="hand-emoji" title="举手">✋</span>' : ""}
          <span class="${media.audio ? "" : "is-off"}">${icon(media.audio ? "mic" : "micOff", 16)}</span>
          <span class="${media.video || media.screen ? "" : "is-off"}">${icon(media.video || media.screen ? "video" : "videoOff", 16)}</span>
          ${isHost() && !p.self ? `<button type="button" class="icon-btn" data-person-menu="${escapeHtml(p.id)}" aria-label="更多操作">${icon("more", 16)}</button>` : ""}
        </span>
      </li>`;
    })
    .join("");

  $$("[data-person-menu]", list).forEach((button) => {
    button.addEventListener("click", () => openPersonMenu(button, button.dataset.personMenu));
  });
}

function menu(items) {
  const element = document.createElement("div");
  element.className = "menu";
  for (const item of items) {
    if (item === "-") {
      element.insertAdjacentHTML("beforeend", '<div class="menu-sep"></div>');
      continue;
    }
    const row = document.createElement("div");
    row.className = `menu-item${item.danger ? " danger" : ""}${item.disabled ? " disabled" : ""}`;
    row.innerHTML = `<span class="menu-icon">${icon(item.icon, 16)}</span><span class="menu-label">${escapeHtml(item.label)}</span>${item.shortcut ? `<span class="menu-shortcut">${escapeHtml(item.shortcut)}</span>` : ""}`;
    row.addEventListener("click", () => {
      if (item.disabled) return;
      closePopover();
      item.onClick();
    });
    element.append(row);
  }
  return element;
}

function openPersonMenu(anchor, id) {
  const person = state.participants.get(id);
  if (!person) return;
  const media = person.media || {};
  openPopover(anchor, menu([
    { icon: "micOff", label: "静音", disabled: !media.audio, onClick: () => send({ type: "host-action", action: "mute", target: id }) },
    { icon: "videoOff", label: "关闭摄像头", disabled: !media.video, onClick: () => send({ type: "host-action", action: "stop-video", target: id }) },
    { icon: "hand", label: "放下手", disabled: !person.hand, onClick: () => send({ type: "host-action", action: "lower-hand", target: id }) },
    { icon: "crown", label: "设为主持人", onClick: () => send({ type: "host-action", action: "make-host", target: id }) },
    "-",
    {
      icon: "userX",
      label: "移出会议",
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({ title: "移出会议", message: `确定将 ${person.name} 移出会议吗？`, confirmLabel: "移出", danger: true });
        if (ok) send({ type: "host-action", action: "remove", target: id });
      }
    }
  ]), { placement: "bottom" });
}

$("#muteAllButton").addEventListener("click", () => {
  send({ type: "host-action", action: "mute-all" });
  toast("已请求所有人静音");
});

$("#lockButton").addEventListener("click", () => {
  send({ type: "host-action", action: state.locked ? "unlock" : "lock" });
});

function updateLockUi() {
  $("#lockBadge").classList.toggle("hidden", !state.locked);
  const button = $("#lockButton");
  button.innerHTML = `${icon(state.locked ? "unlock" : "lock", 15)}${state.locked ? "解锁会议" : "锁定会议"}`;
}

// ============================================================
// 举手、表情
// ============================================================

function toggleHand() {
  state.hand = !state.hand;
  send({ type: "hand", raised: state.hand });
}

function onHand(message) {
  if (message.id === state.selfId) {
    state.hand = message.raised;
  } else {
    const participant = state.participants.get(message.id);
    if (participant) participant.hand = message.raised;
    if (message.raised) toast(`✋ ${message.name} 举手了`, "info", 3500);
  }
  updateTile(message.id);
  renderParticipants();
  updateControls();
}

function sendReaction(emoji) {
  send({ type: "reaction", emoji });
}

function showReaction(id, name, emoji) {
  const layer = $("#reactionLayer");
  const bubble = document.createElement("div");
  bubble.className = "reaction-bubble";
  bubble.style.left = `${8 + Math.random() * 18}%`;
  bubble.innerHTML = `<span class="emoji">${escapeHtml(emoji)}</span><span class="who">${escapeHtml(id === state.selfId ? "我" : name)}</span>`;
  layer.append(bubble);
  window.setTimeout(() => bubble.remove(), 4200);

  const tile = $(`#videoGrid [data-id="${CSS.escape(id)}"]`);
  const badge = tile && $(".tile-reaction", tile);
  if (badge) {
    badge.textContent = emoji;
    badge.classList.remove("show");
    void badge.offsetWidth;
    badge.classList.add("show");
  }
}

// ============================================================
// 聊天
// ============================================================

$("#chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  input.value = "";
});

function addChatMessage(message, { history = false } = {}) {
  const container = $("#chatMessages");
  $(".empty-hint", container)?.remove();
  const mine = message.senderId === state.selfId || (history && message.name === state.displayName);
  const grouped = state.chatSenderLast === message.senderId;
  state.chatSenderLast = message.senderId;

  const element = document.createElement("div");
  element.className = `chat-msg${mine ? " mine" : ""}${grouped ? " grouped" : ""}`;
  element.innerHTML = `
    ${grouped ? "" : `<div class="chat-meta"><b>${escapeHtml(mine ? "我" : message.name)}</b><span>${formatTime(message.sentAt)}</span></div>`}
    <div class="chat-bubble">${linkify(escapeHtml(message.text))}</div>
    ${mine || !state.config.ai?.configured ? "" : '<button type="button" class="chat-translate">翻译</button>'}`;

  $(".chat-translate", element)?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "翻译中…";
    try {
      const translated = await ai.translateText(message.text);
      button.insertAdjacentHTML("beforebegin", `<div class="chat-trans">${escapeHtml(translated)}</div>`);
      button.remove();
    } catch (error) {
      button.disabled = false;
      button.textContent = "翻译";
      toast(error.message, "error");
    }
  });

  const stick = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.append(element);
  if (stick || mine) container.scrollTop = container.scrollHeight;

  if (!history && !mine && state.panel !== "chat") {
    state.unreadChat += 1;
    updateChatBadge();
    toast(`${message.name}：${message.text.slice(0, 60)}`, "info", 3500);
  }
}

function linkify(html) {
  return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function updateChatBadge() {
  const badge = $("#chatBadge");
  badge.textContent = state.unreadChat > 9 ? "9+" : String(state.unreadChat);
  badge.classList.toggle("hidden", state.unreadChat === 0);
  // 手机上聊天按钮收进“更多”菜单，用小圆点提示未读。
  $("#moreButton").classList.toggle("has-dot", state.unreadChat > 0);
}

function isNarrow() {
  return window.matchMedia("(max-width: 760px)").matches;
}

// ============================================================
// 侧边栏
// ============================================================

function openPanel(name) {
  if (state.panel === name) {
    closePanel();
    return;
  }
  state.panel = name;
  $("#sidePanel").classList.remove("hidden");
  $$("#panelTabs [data-panel]").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  $$("#sidePanel [data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== name));
  if (name === "chat") {
    state.unreadChat = 0;
    updateChatBadge();
    const container = $("#chatMessages");
    container.scrollTop = container.scrollHeight;
    if (window.innerWidth > 760) $("#chatInput").focus();
  }
  updateControls();
  scheduleLayout();
}

function closePanel() {
  state.panel = null;
  $("#sidePanel").classList.add("hidden");
  updateControls();
  scheduleLayout();
}

$$("#panelTabs [data-panel]").forEach((button) => {
  button.addEventListener("click", () => {
    if (state.panel !== button.dataset.panel) openPanel(button.dataset.panel);
  });
});
$("#closePanelButton").innerHTML = icon("x", 16);
$("#closePanelButton").addEventListener("click", closePanel);

// ============================================================
// 控制栏
// ============================================================

function setPressed(button, pressed) {
  button.classList.toggle("active", Boolean(pressed));
  button.setAttribute("aria-pressed", String(Boolean(pressed)));
}

function updateControls() {
  const mic = $("#micButton");
  mic.innerHTML = icon(state.micOn ? "mic" : "micOff", 22) + '<span class="mic-level"></span>';
  mic.classList.toggle("off", !state.micOn);
  mic.title = `${state.micOn ? "关闭麦克风" : "打开麦克风"} (${MOD}+D)`;

  const cam = $("#camButton");
  cam.innerHTML = icon(state.camOn ? "video" : "videoOff", 22);
  cam.classList.toggle("off", !state.camOn);
  cam.title = `${state.camOn ? "关闭摄像头" : "打开摄像头"} (${MOD}+E)`;

  setPressed($("#screenButton"), Boolean(state.screenTrack));
  $("#screenButton").title = state.screenTrack ? "停止共享" : "共享屏幕";
  setPressed($("#handButton"), state.hand);
  $("#handButton").title = `${state.hand ? "放下手" : "举手"} (Alt+Y)`;
  setPressed($("#peopleButton"), state.panel === "people");
  setPressed($("#chatButton"), state.panel === "chat");
  setPressed($("#aiButton"), state.panel === "ai");
}

$("#micButton").addEventListener("click", () => setMic(!state.micOn));
$("#camButton").addEventListener("click", () => setCam(!state.camOn));
$("#screenButton").addEventListener("click", () => (state.screenTrack ? stopScreenShare() : startScreenShare()));
$("#captionButton").addEventListener("click", () => ai?.toggleCaptions());
$("#handButton").addEventListener("click", toggleHand);
$("#peopleButton").addEventListener("click", () => openPanel("people"));
$("#chatButton").addEventListener("click", () => openPanel("chat"));
$("#aiButton").addEventListener("click", () => openPanel("ai"));
$("#layoutButton").addEventListener("click", toggleLayout);

$("#copyLinkButton").addEventListener("click", async () => {
  const link = `${window.location.origin}/room/${state.roomId}`;
  if (await copyText(link)) toast("邀请链接已复制", "success");
});

$("#reactionButton").addEventListener("click", (event) => openReactionPicker(event.currentTarget));

function openReactionPicker(anchor) {
  const box = document.createElement("div");
  box.className = "reaction-picker";
  for (const emoji of REACTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.addEventListener("click", () => sendReaction(emoji));
    box.append(button);
  }
  openPopover(anchor, box);
}

$("#moreButton").addEventListener("click", (event) => {
  const mobileItems = isNarrow()
    ? [
      { icon: "users", label: `参会者（${state.participants.size}）`, onClick: () => openPanel("people") },
      { icon: "chat", label: state.unreadChat ? `聊天（${state.unreadChat} 条未读）` : "聊天", onClick: () => openPanel("chat") },
      { icon: "smile", label: "发送表情", onClick: () => openReactionPicker($("#moreButton")) },
      "-"
    ]
    : [];
  openPopover(event.currentTarget, menu([
    ...mobileItems,
    { icon: "pen", label: whiteboard?.isOpen ? "关闭白板" : "协作白板", shortcut: "Alt+W", onClick: () => whiteboard.toggle() },
    { icon: "record", label: recorder?.active ? "停止录制并保存" : "录制会议（保存到本地）", onClick: toggleRecording },
    { icon: state.layout === "speaker" ? "grid" : "speaker", label: state.layout === "speaker" ? "切换到宫格视图" : "切换到主讲人视图", onClick: toggleLayout },
    { icon: "maximize", label: document.fullscreenElement ? "退出全屏" : "全屏", shortcut: "F", onClick: toggleFullscreen },
    "-",
    { icon: "settings", label: "设置", onClick: openSettings },
    { icon: "keyboard", label: "快捷键", shortcut: "?", onClick: openShortcuts }
  ]));
});

$("#leaveButton").addEventListener("click", (event) => {
  const items = [{ icon: "phoneOff", label: "离开会议", danger: true, onClick: () => leaveMeeting(true) }];
  if (isHost() && state.participants.size > 1) {
    items.push({
      icon: "x",
      label: "为所有人结束会议",
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({ title: "结束会议", message: "所有参会者都会被断开。", confirmLabel: "结束会议", danger: true });
        if (ok) {
          send({ type: "host-action", action: "end" });
          state.endReason = "你已为所有人结束会议";
          leaveMeeting(false);
        }
      }
    });
  }
  openPopover(event.currentTarget, menu(items));
});

function toggleLayout() {
  state.layout = state.layout === "speaker" ? "grid" : "speaker";
  if (state.layout === "grid") state.pinnedId = null;
  refreshAllTiles();
  scheduleLayout();
  toast(state.layout === "speaker" ? "主讲人视图" : "宫格视图");
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function tickClock() {
  $("#meetingTimer").textContent = formatDuration(Date.now() - state.createdAt);
  $("#clockText").textContent = `${formatTime(Date.now())}  ·  ${state.roomId}`;
}

function setConnection(text, kind) {
  const el = $("#connectionStatus");
  el.textContent = text;
  el.dataset.kind = kind;
}

// ============================================================
// 录制
// ============================================================

async function toggleRecording() {
  if (recorder.active) {
    await recorder.stop();
    send({ type: "recording", active: false });
    toast("录制已保存到下载文件夹", "success");
    return;
  }
  const ok = await confirmDialog({
    title: "录制会议",
    message: "录制会保存在你的电脑上（webm 格式），所有参会者都会看到“录制中”提示。",
    confirmLabel: "开始录制"
  });
  if (!ok) return;
  try {
    recorder.start();
    send({ type: "recording", active: true });
    toast("开始录制", "success");
  } catch (error) {
    toast(error.message || "无法录制", "error");
  }
}

function onRecordingState(names) {
  state.recordingNames = names;
  const badge = $("#recordingBadge");
  badge.classList.toggle("hidden", !names.length);
  badge.title = names.length ? `${names.join("、")} 正在录制` : "";
}

// ============================================================
// 设置与快捷键
// ============================================================

function openSettings() {
  const body = document.createElement("div");
  body.className = "settings";
  const sinkSupported = typeof HTMLMediaElement.prototype.setSinkId === "function";
  body.innerHTML = `
    <div class="seg seg-full settings-tabs">
      <button type="button" data-set-tab="audio" class="active">音频</button>
      <button type="button" data-set-tab="video">视频</button>
      <button type="button" data-set-tab="ai">字幕与 AI</button>
    </div>
    <div class="form" data-set-pane="audio">
      <label class="field"><span>麦克风</span><select class="input" data-devices="audioinput" id="setMic"></select></label>
      <div class="meter-row"><span class="muted">输入音量</span><div class="settings-meter"><span id="settingsMeter"></span></div></div>
      ${sinkSupported ? '<label class="field"><span>扬声器</span><select class="input" data-devices="audiooutput" id="setSpeaker"></select></label>' : ""}
      <label class="form-check"><input type="checkbox" id="setNoise" ${prefs.noiseSuppression ? "checked" : ""}/> 降噪（抑制键盘声、风扇等背景噪音）</label>
    </div>
    <div class="form hidden" data-set-pane="video">
      <label class="field"><span>摄像头</span><select class="input" data-devices="videoinput" id="setCam"></select></label>
      <label class="form-check"><input type="checkbox" id="setMirror" ${prefs.mirror ? "checked" : ""}/> 镜像我的画面（只影响自己看到的）</label>
    </div>
    <div class="form hidden" data-set-pane="ai">
      <label class="field"><span>我说的语言 <em class="muted">语音识别用</em></span><select class="input" id="setSpeech"></select></label>
      <label class="field"><span>字幕翻译成</span><select class="input" id="setCaption"></select></label>
      <label class="field"><span>AI 笔记 / 纪要语言</span><select class="input" id="setAi"></select></label>
      <label class="form-check"><input type="checkbox" id="setOriginal" ${prefs.showOriginal ? "checked" : ""}/> 字幕同时显示原文</label>
      <label class="form-check"><input type="checkbox" id="setAutoCc" ${prefs.autoCaptions ? "checked" : ""}/> 有人开启转写时自动显示字幕</label>
    </div>`;

  $$("[data-set-tab]", body).forEach((button) => {
    button.addEventListener("click", () => {
      $$("[data-set-tab]", body).forEach((b) => b.classList.toggle("active", b === button));
      $$("[data-set-pane]", body).forEach((p) => p.classList.toggle("hidden", p.dataset.setPane !== button.dataset.setTab));
    });
  });

  fillLanguageSelect($("#setSpeech", body), prefs.speechLang);
  fillLanguageSelect($("#setCaption", body), prefs.captionLang, ["", "不翻译"]);
  fillLanguageSelect($("#setAi", body), prefs.aiLang);
  if (!state.config.ai?.configured) {
    $("#setCaption", body).disabled = true;
    $("#setAi", body).disabled = true;
  }

  const modal = openModal({ title: "设置", body, width: 460 });
  refreshDeviceLists();

  const meterTimer = window.setInterval(() => {
    const level = state.levels.get("self") || 0;
    $("#settingsMeter", body).style.transform = `scaleX(${level})`;
  }, 100);
  const observer = new MutationObserver(() => {
    if (!document.body.contains(modal.element)) {
      window.clearInterval(meterTimer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  $("#setMic", body).addEventListener("change", async (e) => {
    savePrefs({ micId: e.target.value });
    await switchMic(e.target.value);
  });
  $("#setSpeaker", body)?.addEventListener("change", (e) => {
    savePrefs({ speakerId: e.target.value });
    $$("#videoGrid video").forEach(applySink);
  });
  $("#setNoise", body).addEventListener("change", async (e) => {
    savePrefs({ noiseSuppression: e.target.checked });
    await state.audioTrack?.applyConstraints({ echoCancellation: true, autoGainControl: true, noiseSuppression: e.target.checked }).catch(() => {});
  });
  $("#setCam", body).addEventListener("change", async (e) => {
    savePrefs({ camId: e.target.value });
    await switchCamera(e.target.value);
  });
  $("#setMirror", body).addEventListener("change", (e) => {
    savePrefs({ mirror: e.target.checked });
    updateTile(state.selfId);
  });
  $("#setSpeech", body).addEventListener("change", (e) => {
    savePrefs({ speechLang: e.target.value });
    ai?.restartRecognition();
  });
  $("#setCaption", body).addEventListener("change", (e) => {
    savePrefs({ captionLang: e.target.value });
    const select = $("#translateSelect");
    select.value = e.target.value;
    select.dispatchEvent(new Event("change"));
  });
  $("#setAi", body).addEventListener("change", (e) => savePrefs({ aiLang: e.target.value }));
  $("#setOriginal", body).addEventListener("change", (e) => savePrefs({ showOriginal: e.target.checked }));
  $("#setAutoCc", body).addEventListener("change", (e) => savePrefs({ autoCaptions: e.target.checked }));
}

function openShortcuts() {
  const rows = [
    [`${MOD} + D`, "开关麦克风"],
    [`${MOD} + E`, "开关摄像头"],
    ["按住 空格", "静音时临时发言"],
    ["Alt + Y", "举手 / 放下"],
    ["Alt + C", "字幕"],
    ["Alt + H", "聊天"],
    ["Alt + A", "AI 助手"],
    ["Alt + P", "参会者"],
    ["Alt + W", "白板"],
    ["F", "全屏"],
    ["双击画面", "固定 / 取消固定"]
  ];
  openModal({
    title: "快捷键",
    width: 380,
    body: `<div class="shortcut-list">${rows.map(([k, v]) => `<div><kbd>${escapeHtml(k)}</kbd><span>${escapeHtml(v)}</span></div>`).join("")}</div>`
  });
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

document.addEventListener("keydown", (event) => {
  if (!state.inMeeting || state.leaving) return;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();

  if (mod && key === "d") {
    event.preventDefault();
    setMic(!state.micOn);
    return;
  }
  if (mod && key === "e") {
    event.preventDefault();
    setCam(!state.camOn);
    return;
  }
  if (event.altKey && !mod) {
    const actions = {
      y: toggleHand,
      c: () => ai?.toggleCaptions(),
      h: () => openPanel("chat"),
      a: () => openPanel("ai"),
      p: () => openPanel("people"),
      w: () => whiteboard?.toggle()
    };
    const action = actions[event.code.replace("Key", "").toLowerCase()];
    if (action) {
      event.preventDefault();
      action();
    }
    return;
  }
  if (isTyping(event.target) || mod || event.altKey) return;
  if (whiteboard?.isOpen) return;

  if (event.code === "Space" && !event.repeat && !state.micOn && state.audioTrack) {
    event.preventDefault();
    state.pushToTalk = true;
    setMic(true);
  } else if (key === "f" && !event.repeat) {
    toggleFullscreen();
  } else if (event.key === "?") {
    openShortcuts();
  }
});

document.addEventListener("keyup", (event) => {
  if (event.code === "Space" && state.pushToTalk) {
    state.pushToTalk = false;
    setMic(false);
  }
});

// ============================================================
// 离开会议
// ============================================================

async function leaveMeeting(byUser) {
  if (state.leaving) return;
  state.leaving = true;
  closePopover();

  if (recorder?.active) {
    await recorder.stop();
    toast("录制已保存", "success");
  }
  if (state.hand) send({ type: "hand", raised: false });

  ai?.stop();
  levelMonitor?.stop();
  for (const id of [...state.peers.keys()]) closePeer(id);
  for (const track of [state.audioTrack, state.monitorTrack, state.cameraTrack, state.screenTrack]) track?.stop();
  state.socket?.close();
  state.socket = null;

  showEnd(byUser ? "你已离开会议" : state.endReason || "会议已结束");
}

function showEnd(title) {
  state.inMeeting = false;
  applyTheme(true);
  showView("endView");
  document.title = "会议已结束 · 云会议";
  $("#endTitle").textContent = title;
  const duration = state.joinedAt ? formatDuration(Date.now() - state.joinedAt) : "";
  $("#endMeta").textContent = duration ? `会议代码 ${state.roomId} · 你参加了 ${duration}` : `会议代码 ${state.roomId}`;

  const notes = ai?.notes;
  const summary = $("#endSummary");
  if (notes) {
    summary.classList.remove("hidden");
    summary.innerHTML = `
      <p class="eyebrow">${icon("sparkles", 14)} AI 会议摘要</p>
      <h3>${escapeHtml(notes.title || "会议摘要")}</h3>
      <p>${escapeHtml(notes.summary || "")}</p>
      ${notes.actionItems?.length ? `<h4>待办事项</h4><ul class="todo">${notes.actionItems.map((a) => `<li><span class="md-check"></span><div>${escapeHtml(a.task)}${a.owner ? `<small>${escapeHtml(a.owner)}${a.due ? ` · ${escapeHtml(a.due)}` : ""}</small>` : ""}</div></li>`).join("")}</ul>` : ""}`;
  }

  $("#endMinutesButton").classList.toggle("hidden", !ai?.minutes);
  $("#endTranscriptButton").classList.toggle("hidden", !ai?.hasTranscript);
}

$("#endMinutesButton").addEventListener("click", () => ai?.downloadMinutes());
$("#endTranscriptButton").addEventListener("click", () => {
  if (ai) downloadText(`会议转写-${fileStamp()}.md`, ai.transcriptMarkdown());
});
$("#rejoinButton").addEventListener("click", () => window.location.reload());

window.addEventListener("beforeunload", () => {
  if (state.inMeeting) {
    state.leaving = true;
    state.socket?.close();
  }
});

// ============================================================
// 工具
// ============================================================

function initial(name) {
  const text = String(name || "?").trim();
  return (Array.from(text)[0] || "?").toUpperCase();
}
