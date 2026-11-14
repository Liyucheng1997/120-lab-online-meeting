import { $, $$, confirmDialog, downloadBlob, fileStamp } from "./ui.js";

/**
 * 协作白板：手写、荧光笔、文字、橡皮、撤销、清空、导出 PNG。
 * 操作用归一化坐标（0~1），通过服务器同步；中途加入的人会收到历史。
 */
export function createWhiteboard({ send, getSelfId, onToggle }) {
  const panel = $("#whiteboardPanel");
  const canvas = $("#whiteboardCanvas");
  const surface = $("#whiteboardSurface");
  const colorInput = $("#whiteboardColor");
  const sizeInput = $("#whiteboardSize");
  const textInput = $("#whiteboardTextInput");
  const toolButtons = $$("[data-tool]", panel);
  const context = canvas.getContext("2d");

  const board = {
    isOpen: false,
    tool: "pen",
    operations: [],
    mine: [],
    current: null,
    drawing: false,
    width: 0,
    height: 0
  };

  toolButtons.forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
  $$(".swatch", panel).forEach((swatch) => {
    swatch.addEventListener("click", () => {
      colorInput.value = swatch.dataset.color;
      $$(".swatch", panel).forEach((s) => s.classList.toggle("active", s === swatch));
    });
  });

  $("#closeWhiteboardButton").addEventListener("click", () => toggle(false));
  $("#undoWhiteboardButton").addEventListener("click", undo);
  $("#exportWhiteboardButton").addEventListener("click", exportPng);
  $("#clearWhiteboardButton").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "清空白板",
      message: "会清空所有人的白板内容，且无法撤销。",
      confirmLabel: "清空",
      danger: true
    });
    if (ok) apply({ type: "clear" }, true);
  });

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  // 面板显示、窗口缩放时都会触发，比单次 requestAnimationFrame 可靠（后台标签页里 rAF 会暂停）。
  new ResizeObserver(() => resize()).observe(surface);

  panel.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && event.target !== textInput) {
      event.preventDefault();
      undo();
    }
  });

  setTool("pen");

  function toggle(open = !board.isOpen) {
    board.isOpen = open;
    panel.classList.toggle("hidden", !open);
    onToggle?.(open);
    if (open) {
      resize();
      canvas.focus();
    }
  }

  function setTool(tool) {
    board.tool = tool;
    toolButtons.forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
    textInput.classList.toggle("hidden", tool !== "text");
    canvas.style.cursor = tool === "text" ? "text" : "crosshair";
    if (tool === "text") textInput.focus();
  }

  function resize() {
    const rect = surface.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (!width || !height) return;
    if (board.width === width && board.height === height) return;

    const ratio = window.devicePixelRatio || 1;
    board.width = width;
    board.height = height;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    redraw();
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height)
    };
  }

  function onPointerDown(event) {
    if (!board.isOpen || event.button !== 0) return;
    event.preventDefault();
    resize();
    const p = point(event);

    if (board.tool === "text") {
      const text = textInput.value.trim();
      if (!text) {
        textInput.focus();
        return;
      }
      apply({
        type: "text",
        id: newId(),
        x: p.x,
        y: p.y,
        text,
        color: colorInput.value,
        size: Math.max(16, Number(sizeInput.value) + 12)
      }, true);
      textInput.select();
      return;
    }

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // 某些触控笔 / 合成事件不支持捕获，不影响绘制
    }
    board.drawing = true;
    board.current = {
      type: "stroke",
      id: newId(),
      tool: board.tool,
      color: colorInput.value,
      size: Number(sizeInput.value),
      points: [p]
    };
  }

  function onPointerMove(event) {
    if (!board.drawing || !board.current) return;
    event.preventDefault();
    const coalesced = event.getCoalescedEvents?.() || [];
    const events = coalesced.length ? coalesced : [event];
    for (const item of events) board.current.points.push(point(item));
    redraw(board.current);
  }

  function onPointerUp(event) {
    if (!board.drawing || !board.current) return;
    event.preventDefault();
    const stroke = board.current;
    if (stroke.points.length === 1) stroke.points.push(stroke.points[0]);
    // 点太多时抽稀，减少同步数据量。
    if (stroke.points.length > 1400) {
      const step = Math.ceil(stroke.points.length / 1400);
      stroke.points = stroke.points.filter((_, i) => i % step === 0);
    }
    board.drawing = false;
    board.current = null;
    apply(stroke, true);
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  function undo() {
    const id = board.mine.pop();
    if (!id) return;
    apply({ type: "remove", id }, true);
  }

  function apply(operation, broadcast) {
    if (!operation) return;
    if (operation.type === "clear") {
      board.operations = [];
      board.mine = [];
    } else if (operation.type === "remove") {
      board.operations = board.operations.filter((op) => op.id !== operation.id);
      board.mine = board.mine.filter((id) => id !== operation.id);
    } else {
      board.operations.push(operation);
      if (broadcast) board.mine.push(operation.id);
    }
    redraw();
    if (broadcast) send({ type: "whiteboard", operation });
  }

  function load(operations) {
    board.operations = Array.isArray(operations) ? [...operations] : [];
    const self = getSelfId();
    board.mine = board.operations.filter((op) => op.author && op.author === self).map((op) => op.id);
    redraw();
  }

  function redraw(preview) {
    const { width, height } = board;
    if (!width || !height) return;
    context.clearRect(0, 0, width, height);
    for (const operation of board.operations) draw(operation);
    if (preview) draw(preview);
  }

  function draw(operation, ctx = context, width = board.width, height = board.height) {
    if (operation.type === "stroke") drawStroke(ctx, operation, width, height);
    if (operation.type === "text") drawText(ctx, operation, width, height);
  }

  function exportPng() {
    const ratio = 2;
    const makeCanvas = () => {
      const c = document.createElement("canvas");
      c.width = board.width * ratio;
      c.height = board.height * ratio;
      return c;
    };
    // 先在透明画布上画（橡皮擦会挖空），再整体合成到白底上。
    const ink = makeCanvas();
    const inkCtx = ink.getContext("2d");
    inkCtx.scale(ratio, ratio);
    for (const operation of board.operations) draw(operation, inkCtx, board.width, board.height);

    const out = makeCanvas();
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(ink, 0, 0);
    out.toBlob((blob) => blob && downloadBlob(`白板-${fileStamp()}.png`, blob), "image/png");
  }

  return {
    toggle,
    load,
    applyRemote: (operation) => apply(operation, false),
    get isOpen() {
      return board.isOpen;
    }
  };
}

function drawStroke(ctx, stroke, width, height) {
  if (!Array.isArray(stroke.points) || stroke.points.length < 2) return;
  const points = stroke.points.map((p) => ({ x: p.x * width, y: p.y * height }));

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineWidth = Math.max(12, stroke.size * 2);
    ctx.strokeStyle = "rgba(0,0,0,1)";
  } else if (stroke.tool === "highlighter") {
    ctx.lineWidth = Math.max(14, stroke.size * 2.4);
    ctx.strokeStyle = hexToRgba(stroke.color, 0.34);
  } else {
    ctx.lineWidth = stroke.size;
    ctx.strokeStyle = stroke.color;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + cur.x) / 2, (prev.y + cur.y) / 2);
  }
  ctx.lineTo(points.at(-1).x, points.at(-1).y);
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx, op, width, height) {
  const x = op.x * width;
  const y = op.y * height;
  const fontSize = Math.max(12, op.size);
  ctx.save();
  ctx.fillStyle = op.color;
  ctx.font = `600 ${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = "top";

  const maxWidth = Math.max(120, width - x - 24);
  let line = "";
  let lineY = y;
  for (const ch of Array.from(op.text)) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, lineY);
      line = ch;
      lineY += fontSize * 1.35;
    } else {
      line = next;
    }
  }
  if (line) ctx.fillText(line, x, lineY);
  ctx.restore();
}

function hexToRgba(hex, alpha) {
  const v = String(hex).replace("#", "");
  return `rgba(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}, ${alpha})`;
}

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

function newId() {
  return crypto.randomUUID().slice(0, 12);
}
