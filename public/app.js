const homeView = document.querySelector("#homeView");
const meetingView = document.querySelector("#meetingView");
const createForm = document.querySelector("#createForm");
const joinForm = document.querySelector("#joinForm");
const homeNameInput = document.querySelector("#homeNameInput");
const meetingNameInput = document.querySelector("#meetingNameInput");
const joinCard = document.querySelector("#joinCard");
const callArea = document.querySelector("#callArea");
const controls = document.querySelector("#controls");
const roomTitle = document.querySelector("#roomTitle");
const videoGrid = document.querySelector("#videoGrid");
const participantList = document.querySelector("#participantList");
const statusText = document.querySelector("#statusText");
const copyLinkButton = document.querySelector("#copyLinkButton");
const leaveButton = document.querySelector("#leaveButton");
const muteButton = document.querySelector("#muteButton");
const cameraButton = document.querySelector("#cameraButton");
const screenButton = document.querySelector("#screenButton");
const whiteboardButton = document.querySelector("#whiteboardButton");
const whiteboardPanel = document.querySelector("#whiteboardPanel");
const closeWhiteboardButton = document.querySelector("#closeWhiteboardButton");
const clearWhiteboardButton = document.querySelector("#clearWhiteboardButton");
const whiteboardCanvas = document.querySelector("#whiteboardCanvas");
const whiteboardSurface = document.querySelector("#whiteboardSurface");
const whiteboardColor = document.querySelector("#whiteboardColor");
const whiteboardSize = document.querySelector("#whiteboardSize");
const whiteboardTextInput = document.querySelector("#whiteboardTextInput");
const whiteboardToolButtons = document.querySelectorAll("[data-tool]");
const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const chatMessages = document.querySelector("#chatMessages");
const whiteboardContext = whiteboardCanvas.getContext("2d");

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

const state = {
  roomId: getRoomIdFromPath(),
  selfId: null,
  displayName: "",
  localStream: null,
  cameraTrack: null,
  screenStream: null,
  isScreenSharing: false,
  socket: null,
  peers: new Map(),
  participants: new Map(),
  pendingCandidates: new Map(),
  whiteboard: {
    isOpen: false,
    tool: "pen",
    operations: [],
    currentStroke: null,
    isDrawing: false,
    width: 0,
    height: 0
  }
};

const savedName = localStorage.getItem("meeting-display-name") || "";
homeNameInput.value = savedName;
meetingNameInput.value = savedName;
setWhiteboardTool("pen");

if (state.roomId) {
  showMeeting();
} else {
  showHome();
}

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = getPreferredName(homeNameInput.value);
  localStorage.setItem("meeting-display-name", name);
  const roomId = createRoomId();
  window.location.href = `/room/${roomId}`;
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await joinMeeting();
});

copyLinkButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}`);
  copyLinkButton.textContent = "已复制";
  window.setTimeout(() => {
    copyLinkButton.textContent = "复制链接";
  }, 1200);
});

leaveButton.addEventListener("click", () => {
  leaveMeeting();
  window.location.href = "/";
});

muteButton.addEventListener("click", () => {
  const audioTrack = state.localStream?.getAudioTracks()[0];
  if (!audioTrack) return;

  audioTrack.enabled = !audioTrack.enabled;
  muteButton.setAttribute("aria-pressed", String(!audioTrack.enabled));
  muteButton.textContent = audioTrack.enabled ? "麦克风" : "已静音";
});

cameraButton.addEventListener("click", () => {
  const videoTrack = state.cameraTrack;
  if (!videoTrack) return;

  videoTrack.enabled = !videoTrack.enabled;
  cameraButton.setAttribute("aria-pressed", String(!videoTrack.enabled));
  cameraButton.textContent = videoTrack.enabled ? "摄像头" : "摄像头关";
});

screenButton.addEventListener("click", async () => {
  if (state.isScreenSharing) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
});

whiteboardButton.addEventListener("click", () => {
  toggleWhiteboard(!state.whiteboard.isOpen);
});

closeWhiteboardButton.addEventListener("click", () => {
  toggleWhiteboard(false);
});

clearWhiteboardButton.addEventListener("click", () => {
  const confirmed = window.confirm("确定要清空所有人的白板内容吗？");
  if (!confirmed) return;

  applyWhiteboardOperation({ type: "clear" }, true);
});

whiteboardToolButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setWhiteboardTool(button.dataset.tool);
  });
});

whiteboardCanvas.addEventListener("pointerdown", handleWhiteboardPointerDown);
whiteboardCanvas.addEventListener("pointermove", handleWhiteboardPointerMove);
whiteboardCanvas.addEventListener("pointerup", handleWhiteboardPointerUp);
whiteboardCanvas.addEventListener("pointercancel", handleWhiteboardPointerUp);
window.addEventListener("resize", resizeWhiteboardCanvas);

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !state.socket) return;

  send({ type: "chat", text });
  addChatMessage(state.displayName, text);
  chatInput.value = "";
});

window.addEventListener("beforeunload", () => {
  leaveMeeting();
});

function showHome() {
  homeView.classList.remove("hidden");
  meetingView.classList.add("hidden");
}

function showMeeting() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get("name") || savedName;

  homeView.classList.add("hidden");
  meetingView.classList.remove("hidden");
  roomTitle.textContent = `会议 ${state.roomId}`;
  meetingNameInput.value = name;
}

async function joinMeeting() {
  const name = getPreferredName(meetingNameInput.value);
  localStorage.setItem("meeting-display-name", name);
  state.displayName = name;
  setStatus("正在请求设备权限");
  joinForm.querySelector("button").disabled = true;

  try {
    state.localStream = await getLocalMedia();
    state.cameraTrack = state.localStream.getVideoTracks()[0] || null;

    joinCard.classList.add("hidden");
    callArea.classList.remove("hidden");
    controls.classList.remove("hidden");
    addVideoTile("local", state.localStream, `${name}（我）`, true);
    cameraButton.disabled = !state.cameraTrack;

    connectSocket();
  } catch (error) {
    setStatus("无法访问摄像头或麦克风");
    joinForm.querySelector("button").disabled = false;
    console.error(error);
  }
}

async function getLocalMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
  } catch (error) {
    console.warn("Video capture failed, retrying with audio only.", error);
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
}

async function startScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("当前浏览器不支持共享屏幕");
    return;
  }

  screenButton.disabled = true;
  setStatus("正在选择共享内容");

  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 30 }
      },
      audio: false
    });
    const screenTrack = screenStream.getVideoTracks()[0];

    if (!screenTrack) {
      throw new Error("No screen video track was selected.");
    }

    state.screenStream = screenStream;
    state.isScreenSharing = true;
    screenTrack.addEventListener("ended", () => {
      void stopScreenShare();
    }, { once: true });

    await replaceOutgoingVideoTrack(screenTrack);
    updateLocalPreview(screenTrack, true);
    updateScreenButton(true);
    setStatus("正在共享屏幕");
  } catch (error) {
    console.error(error);
    setStatus("共享屏幕已取消或失败");
    state.screenStream?.getTracks().forEach((track) => track.stop());
    state.screenStream = null;
    state.isScreenSharing = false;
    updateScreenButton(false);
  } finally {
    screenButton.disabled = false;
  }
}

async function stopScreenShare() {
  if (!state.isScreenSharing && !state.screenStream) return;

  const previousScreenStream = state.screenStream;
  const cameraTrack = state.cameraTrack?.readyState === "live" ? state.cameraTrack : null;

  state.isScreenSharing = false;
  state.screenStream = null;
  screenButton.disabled = true;

  try {
    await replaceOutgoingVideoTrack(cameraTrack);
    updateLocalPreview(cameraTrack, false);
    updateScreenButton(false);
    setStatus("已停止共享屏幕");
  } catch (error) {
    console.error(error);
    setStatus("停止共享屏幕失败");
  } finally {
    previousScreenStream?.getTracks().forEach((track) => {
      if (track.readyState !== "ended") {
        track.stop();
      }
    });
    screenButton.disabled = false;
  }
}

function connectSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  state.socket.addEventListener("open", () => {
    setStatus("正在连接会议");
    send({ type: "join", roomId: state.roomId, name: state.displayName });
  });

  state.socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);
    await handleSocketMessage(message);
  });

  state.socket.addEventListener("close", () => {
    setStatus("连接已断开");
  });

  state.socket.addEventListener("error", () => {
    setStatus("连接失败");
  });
}

async function handleSocketMessage(message) {
  if (message.type === "joined") {
    state.selfId = message.id;
    state.participants.set(state.selfId, `${state.displayName}（我）`);
    state.whiteboard.operations = Array.isArray(message.whiteboard) ? message.whiteboard : [];

    for (const user of message.users) {
      state.participants.set(user.id, user.name);
      await startOffer(user.id, user.name);
    }

    renderParticipants();
    redrawWhiteboard();
    setStatus("已连接");
    return;
  }

  if (message.type === "user-joined") {
    state.participants.set(message.id, message.name);
    renderParticipants();
    addChatMessage("系统", `${message.name} 加入了会议`);
    return;
  }

  if (message.type === "user-left") {
    removePeer(message.id);
    state.participants.delete(message.id);
    renderParticipants();
    addChatMessage("系统", "一位参会者已离开会议");
    return;
  }

  if (message.type === "signal") {
    await handleSignal(message.from, message.name, message.signal);
    return;
  }

  if (message.type === "chat") {
    if (message.id !== state.selfId) {
      addChatMessage(message.name, message.text);
    }
    return;
  }

  if (message.type === "whiteboard") {
    applyWhiteboardOperation(message.operation, false);
    return;
  }

  if (message.type === "error") {
    setStatus(message.message);
  }
}

async function startOffer(peerId, peerName) {
  const pc = ensurePeer(peerId, peerName);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal(peerId, { description: pc.localDescription });
}

async function handleSignal(peerId, peerName, signal) {
  const pc = ensurePeer(peerId, peerName);

  if (signal.description) {
    await pc.setRemoteDescription(signal.description);
    await flushPendingCandidates(peerId, pc);

    if (signal.description.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(peerId, { description: pc.localDescription });
    }
  }

  if (signal.candidate) {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(signal.candidate);
    } else {
      if (!state.pendingCandidates.has(peerId)) {
        state.pendingCandidates.set(peerId, []);
      }
      state.pendingCandidates.get(peerId).push(signal.candidate);
    }
  }
}

function ensurePeer(peerId, peerName) {
  if (state.peers.has(peerId)) {
    return state.peers.get(peerId);
  }

  const pc = new RTCPeerConnection({ iceServers });

  for (const track of state.localStream.getAudioTracks()) {
    pc.addTrack(track, state.localStream);
  }

  const videoTrack = getActiveVideoTrack();
  if (videoTrack) {
    pc.addTrack(videoTrack, createOutgoingStream(videoTrack));
  }

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendSignal(peerId, { candidate: event.candidate });
    }
  });

  pc.addEventListener("track", (event) => {
    const [stream] = event.streams;
    addVideoTile(peerId, stream, peerName, false);
  });

  pc.addEventListener("connectionstatechange", () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      removeVideoTile(peerId);
    }
  });

  state.peers.set(peerId, pc);
  state.participants.set(peerId, peerName);
  renderParticipants();

  return pc;
}

async function replaceOutgoingVideoTrack(videoTrack) {
  for (const [peerId, pc] of state.peers) {
    const sender = pc.getSenders().find((item) => item.track?.kind === "video");

    if (sender) {
      await sender.replaceTrack(videoTrack);
    } else if (videoTrack) {
      pc.addTrack(videoTrack, createOutgoingStream(videoTrack));
      await renegotiatePeer(peerId);
    }
  }
}

async function renegotiatePeer(peerId) {
  const pc = state.peers.get(peerId);
  if (!pc || pc.signalingState === "closed") return;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal(peerId, { description: pc.localDescription });
}

function getActiveVideoTrack() {
  if (state.isScreenSharing) {
    return state.screenStream?.getVideoTracks()[0] || null;
  }

  return state.cameraTrack?.readyState === "live" ? state.cameraTrack : null;
}

function createOutgoingStream(videoTrack) {
  return new MediaStream([
    ...state.localStream.getAudioTracks(),
    videoTrack
  ]);
}

async function flushPendingCandidates(peerId, pc) {
  const candidates = state.pendingCandidates.get(peerId) || [];

  for (const candidate of candidates) {
    await pc.addIceCandidate(candidate);
  }

  state.pendingCandidates.delete(peerId);
}

function sendSignal(to, signal) {
  send({ type: "signal", to, signal });
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
  }
}

function addVideoTile(id, stream, name, isLocal) {
  let tile = document.querySelector(`[data-video-id="${id}"]`);

  if (!tile) {
    tile = document.createElement("article");
    tile.className = `video-tile${isLocal ? " local" : ""}`;
    tile.dataset.videoId = id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;

    const badge = document.createElement("div");
    badge.className = "name-badge";

    tile.append(video, badge);
    videoGrid.append(tile);
  }

  const video = tile.querySelector("video");
  const badge = tile.querySelector(".name-badge");
  video.srcObject = stream;
  badge.textContent = name;
}

function updateLocalPreview(videoTrack, isScreenSharing) {
  const tracks = [...state.localStream.getAudioTracks()];

  if (videoTrack) {
    tracks.push(videoTrack);
  }

  addVideoTile(
    "local",
    new MediaStream(tracks),
    `${state.displayName}（我${isScreenSharing ? "，屏幕共享" : ""}）`,
    true
  );
  document.querySelector('[data-video-id="local"]')?.classList.toggle("sharing-screen", isScreenSharing);
}

function updateScreenButton(isScreenSharing) {
  screenButton.setAttribute("aria-pressed", String(isScreenSharing));
  screenButton.textContent = isScreenSharing ? "停止共享" : "共享屏幕";
}

function toggleWhiteboard(isOpen) {
  state.whiteboard.isOpen = isOpen;
  whiteboardPanel.classList.toggle("hidden", !isOpen);
  whiteboardButton.setAttribute("aria-pressed", String(isOpen));

  if (isOpen) {
    requestAnimationFrame(() => {
      resizeWhiteboardCanvas();
      whiteboardCanvas.focus();
    });
  }
}

function setWhiteboardTool(tool) {
  state.whiteboard.tool = tool;

  whiteboardToolButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });

  whiteboardTextInput.disabled = tool !== "text";
  whiteboardCanvas.style.cursor = tool === "text" ? "text" : "crosshair";

  if (tool === "text") {
    whiteboardTextInput.focus();
  }
}

function resizeWhiteboardCanvas() {
  const rect = whiteboardSurface.getBoundingClientRect();
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);

  if (!width || !height) return;
  if (state.whiteboard.width === width && state.whiteboard.height === height) return;

  const ratio = window.devicePixelRatio || 1;
  state.whiteboard.width = width;
  state.whiteboard.height = height;
  whiteboardCanvas.width = Math.floor(width * ratio);
  whiteboardCanvas.height = Math.floor(height * ratio);
  whiteboardContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  redrawWhiteboard();
}

function handleWhiteboardPointerDown(event) {
  if (!state.whiteboard.isOpen || event.button !== 0) return;

  event.preventDefault();
  resizeWhiteboardCanvas();

  const point = getWhiteboardPoint(event);

  if (state.whiteboard.tool === "text") {
    const text = whiteboardTextInput.value.trim();
    if (!text) {
      whiteboardTextInput.focus();
      return;
    }

    applyWhiteboardOperation({
      type: "text",
      x: point.x,
      y: point.y,
      text,
      color: whiteboardColor.value,
      size: Math.max(16, Number(whiteboardSize.value) + 12)
    }, true);
    whiteboardTextInput.select();
    return;
  }

  whiteboardCanvas.setPointerCapture(event.pointerId);
  state.whiteboard.isDrawing = true;
  state.whiteboard.currentStroke = {
    type: "stroke",
    tool: state.whiteboard.tool,
    color: whiteboardColor.value,
    size: Number(whiteboardSize.value),
    points: [point]
  };
}

function handleWhiteboardPointerMove(event) {
  if (!state.whiteboard.isDrawing || !state.whiteboard.currentStroke) return;

  event.preventDefault();
  state.whiteboard.currentStroke.points.push(getWhiteboardPoint(event));
  redrawWhiteboard(state.whiteboard.currentStroke);
}

function handleWhiteboardPointerUp(event) {
  if (!state.whiteboard.isDrawing || !state.whiteboard.currentStroke) return;

  event.preventDefault();

  const stroke = state.whiteboard.currentStroke;
  if (stroke.points.length === 1) {
    stroke.points.push(stroke.points[0]);
  }

  state.whiteboard.isDrawing = false;
  state.whiteboard.currentStroke = null;
  applyWhiteboardOperation(stroke, true);

  if (whiteboardCanvas.hasPointerCapture(event.pointerId)) {
    whiteboardCanvas.releasePointerCapture(event.pointerId);
  }
}

function getWhiteboardPoint(event) {
  const rect = whiteboardCanvas.getBoundingClientRect();

  return {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1)
  };
}

function applyWhiteboardOperation(operation, shouldBroadcast) {
  if (!operation) return;

  if (operation.type === "clear") {
    state.whiteboard.operations = [];
  } else {
    state.whiteboard.operations.push(operation);
  }

  redrawWhiteboard();

  if (shouldBroadcast) {
    send({ type: "whiteboard", operation });
  }
}

function redrawWhiteboard(previewOperation) {
  const { width, height } = state.whiteboard;
  if (!width || !height) return;

  whiteboardContext.clearRect(0, 0, width, height);

  for (const operation of state.whiteboard.operations) {
    drawWhiteboardOperation(operation);
  }

  if (previewOperation) {
    drawWhiteboardOperation(previewOperation);
  }
}

function drawWhiteboardOperation(operation) {
  if (operation.type === "stroke") {
    drawWhiteboardStroke(operation);
    return;
  }

  if (operation.type === "text") {
    drawWhiteboardText(operation);
  }
}

function drawWhiteboardStroke(stroke) {
  if (!Array.isArray(stroke.points) || stroke.points.length < 2) return;

  const { width, height } = state.whiteboard;
  const points = stroke.points.map((point) => ({
    x: point.x * width,
    y: point.y * height
  }));

  whiteboardContext.save();
  whiteboardContext.lineCap = "round";
  whiteboardContext.lineJoin = "round";

  if (stroke.tool === "eraser") {
    whiteboardContext.globalCompositeOperation = "destination-out";
    whiteboardContext.lineWidth = Math.max(12, stroke.size * 2);
    whiteboardContext.strokeStyle = "rgba(0, 0, 0, 1)";
  } else if (stroke.tool === "highlighter") {
    whiteboardContext.globalCompositeOperation = "source-over";
    whiteboardContext.lineWidth = Math.max(14, stroke.size * 2.4);
    whiteboardContext.strokeStyle = hexToRgba(stroke.color, 0.34);
  } else {
    whiteboardContext.globalCompositeOperation = "source-over";
    whiteboardContext.lineWidth = stroke.size;
    whiteboardContext.strokeStyle = stroke.color;
  }

  whiteboardContext.beginPath();
  whiteboardContext.moveTo(points[0].x, points[0].y);

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midpoint = {
      x: (previous.x + current.x) / 2,
      y: (previous.y + current.y) / 2
    };
    whiteboardContext.quadraticCurveTo(previous.x, previous.y, midpoint.x, midpoint.y);
  }

  whiteboardContext.lineTo(points.at(-1).x, points.at(-1).y);
  whiteboardContext.stroke();
  whiteboardContext.restore();
}

function drawWhiteboardText(operation) {
  const { width, height } = state.whiteboard;
  const x = operation.x * width;
  const y = operation.y * height;
  const fontSize = Math.max(12, operation.size);

  whiteboardContext.save();
  whiteboardContext.fillStyle = operation.color;
  whiteboardContext.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  whiteboardContext.textBaseline = "top";
  wrapWhiteboardText(operation.text, x, y, fontSize, width - x - 24);
  whiteboardContext.restore();
}

function wrapWhiteboardText(text, x, y, fontSize, maxWidth) {
  const safeMaxWidth = Math.max(120, maxWidth);
  const characters = Array.from(text);
  let line = "";
  let lineY = y;

  for (const character of characters) {
    const nextLine = `${line}${character}`;

    if (whiteboardContext.measureText(nextLine).width > safeMaxWidth && line) {
      whiteboardContext.fillText(line, x, lineY);
      line = character;
      lineY += fontSize * 1.35;
    } else {
      line = nextLine;
    }
  }

  if (line) {
    whiteboardContext.fillText(line, x, lineY);
  }
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function removeVideoTile(id) {
  document.querySelector(`[data-video-id="${id}"]`)?.remove();
}

function removePeer(peerId) {
  state.peers.get(peerId)?.close();
  state.peers.delete(peerId);
  state.pendingCandidates.delete(peerId);
  removeVideoTile(peerId);
}

function renderParticipants() {
  participantList.replaceChildren();

  for (const name of state.participants.values()) {
    const item = document.createElement("li");
    item.textContent = name;
    participantList.append(item);
  }
}

function addChatMessage(name, text) {
  const message = document.createElement("div");
  message.className = "chat-message";

  const sender = document.createElement("strong");
  sender.textContent = name;

  const body = document.createElement("span");
  body.textContent = text;

  message.append(sender, body);
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function leaveMeeting() {
  for (const peerId of state.peers.keys()) {
    removePeer(peerId);
  }

  state.screenStream?.getTracks().forEach((track) => track.stop());
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.socket?.close();
}

function setStatus(text) {
  statusText.textContent = text;
}

function getRoomIdFromPath() {
  const match = window.location.pathname.match(/^\/room\/([a-zA-Z0-9-]+)$/);
  return match?.[1] || "";
}

function getPreferredName(value) {
  return value.trim() || `用户${Math.floor(Math.random() * 900 + 100)}`;
}

function createRoomId() {
  return crypto.randomUUID().slice(0, 8);
}
