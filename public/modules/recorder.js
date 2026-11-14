import { getAudioContext } from "./audio-level.js";
import { downloadBlob, fileStamp } from "./ui.js";

/**
 * 本地录制：把当前画面布局合成到 1280×720 画布，混合所有人的声音，保存为 webm。
 * getTiles(): [{ element, video, name, showVideo, contain, mirror }]
 * getAudioTracks(): MediaStreamTrack[]
 */
export function createRecorder({ stage, getTiles, getAudioTracks }) {
  const WIDTH = 1280;
  const HEIGHT = 720;
  let recorder = null;
  let drawTimer = null;
  let audioTimer = null;
  let chunks = [];
  let connected = new Map();
  let destination = null;
  let startedAt = 0;

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");

  function pickMime() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4"
    ];
    return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || "";
  }

  function drawFrame() {
    const stageRect = stage.getBoundingClientRect();
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    if (!stageRect.width || !stageRect.height) return;

    const scale = Math.min(WIDTH / stageRect.width, HEIGHT / stageRect.height);
    const offsetX = (WIDTH - stageRect.width * scale) / 2;
    const offsetY = (HEIGHT - stageRect.height * scale) / 2;

    for (const tile of getTiles()) {
      const r = tile.element.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const x = offsetX + (r.left - stageRect.left) * scale;
      const y = offsetY + (r.top - stageRect.top) * scale;
      const w = r.width * scale;
      const h = r.height * scale;

      ctx.save();
      roundRect(ctx, x, y, w, h, 12 * scale);
      ctx.clip();
      ctx.fillStyle = "#1c1c1e";
      ctx.fillRect(x, y, w, h);

      const video = tile.video;
      if (tile.showVideo && video.videoWidth && video.videoHeight) {
        const vr = video.videoWidth / video.videoHeight;
        const tr = w / h;
        let dw;
        let dh;
        if (tile.contain ? vr > tr : vr < tr) {
          dw = w;
          dh = w / vr;
        } else {
          dh = h;
          dw = h * vr;
        }
        const dx = x + (w - dw) / 2;
        const dy = y + (h - dh) / 2;
        if (tile.mirror) {
          ctx.translate(dx + dw, dy);
          ctx.scale(-1, 1);
          ctx.drawImage(video, 0, 0, dw, dh);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        } else {
          ctx.drawImage(video, dx, dy, dw, dh);
        }
      } else {
        const radius = Math.min(w, h) * 0.16;
        ctx.fillStyle = "#3a3a3c";
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#f5f5f7";
        ctx.font = `600 ${radius}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(Array.from(tile.name || "?")[0], x + w / 2, y + h / 2);
      }
      ctx.restore();

      // 名字标签
      const fontSize = Math.max(11, 13 * scale);
      ctx.font = `500 ${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const label = tile.name || "";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      roundRect(ctx, x + 8 * scale, y + h - 30 * scale, tw + 16 * scale, 22 * scale, 11 * scale);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x + 16 * scale, y + h - 19 * scale);
    }

    // 录制时长水印
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    ctx.font = '500 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.textAlign = "right";
    ctx.fillText(`● REC ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`, WIDTH - 16, 24);
  }

  function syncAudio() {
    const context = getAudioContext();
    const current = new Set();
    for (const track of getAudioTracks()) {
      if (!track || track.readyState !== "live") continue;
      current.add(track.id);
      if (connected.has(track.id)) continue;
      try {
        const source = context.createMediaStreamSource(new MediaStream([track]));
        source.connect(destination);
        connected.set(track.id, source);
      } catch (error) {
        console.warn("录制混音失败", error);
      }
    }
    for (const [id, source] of connected) {
      if (!current.has(id)) {
        source.disconnect();
        connected.delete(id);
      }
    }
  }

  function start() {
    if (recorder) return false;
    if (!window.MediaRecorder) throw new Error("当前浏览器不支持录制。");

    const context = getAudioContext();
    destination = context.createMediaStreamDestination();
    connected = new Map();
    chunks = [];
    startedAt = Date.now();

    syncAudio();
    drawFrame();
    // 用定时器而不是 requestAnimationFrame：切到后台标签页时也能继续录。
    drawTimer = window.setInterval(drawFrame, 1000 / 24);
    audioTimer = window.setInterval(syncAudio, 1000);

    const stream = new MediaStream([
      ...canvas.captureStream(24).getVideoTracks(),
      ...destination.stream.getAudioTracks()
    ]);
    const mimeType = pickMime();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.start(1000);
    return true;
  }

  function stop() {
    if (!recorder) return Promise.resolve(false);
    const active = recorder;
    recorder = null;
    window.clearInterval(drawTimer);
    window.clearInterval(audioTimer);

    return new Promise((resolve) => {
      active.addEventListener("stop", () => {
        for (const source of connected.values()) source.disconnect();
        connected.clear();
        const type = active.mimeType || "video/webm";
        const blob = new Blob(chunks, { type });
        chunks = [];
        if (blob.size) {
          const ext = type.includes("mp4") ? "mp4" : "webm";
          downloadBlob(`会议录制-${fileStamp()}.${ext}`, blob);
        }
        resolve(true);
      }, { once: true });
      active.stop();
    });
  }

  return {
    start,
    stop,
    get active() {
      return Boolean(recorder);
    }
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
