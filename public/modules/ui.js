import { icon } from "./icons.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- 提示 ----------

export function toast(message, kind = "info", duration = 2800) {
  const host = $("#toastHost");
  if (!host) return;
  const element = document.createElement("div");
  element.className = `toast toast-${kind}`;
  element.textContent = message;
  host.append(element);
  requestAnimationFrame(() => element.classList.add("show"));
  window.setTimeout(() => {
    element.classList.remove("show");
    window.setTimeout(() => element.remove(), 300);
  }, duration);
  while (host.children.length > 4) host.firstElementChild.remove();
}

// ---------- 对话框 ----------

/**
 * openModal({ title, body: Node|string, actions: [{label, kind, onClick}], width })
 * 返回 { close, element }。Esc / 点遮罩关闭。
 */
export function openModal({ title, body, actions = [], width = 440, onClose }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" style="width:${width}px">
      <div class="modal-header"><span>${escapeHtml(title)}</span>
        <button type="button" class="modal-x" aria-label="关闭">${icon("x", 16)}</button>
      </div>
      <div class="modal-body"></div>
      ${actions.length ? '<div class="modal-footer"></div>' : ""}
    </div>`;

  const modalBody = $(".modal-body", overlay);
  if (typeof body === "string") modalBody.innerHTML = body;
  else if (body) modalBody.append(body);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  const footer = $(".modal-footer", overlay);
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${action.kind ? `btn-${action.kind}` : ""}`;
    button.textContent = action.label;
    button.addEventListener("click", async () => {
      const keepOpen = await action.onClick?.();
      if (keepOpen !== true) close();
    });
    footer.append(button);
  }

  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  $(".modal-x", overlay).addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  return { close, element: overlay };
}

export function confirmDialog({ title, message, confirmLabel = "确定", danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title,
      body: `<p class="modal-msg">${escapeHtml(message)}</p>`,
      width: 380,
      actions: [
        { label: "取消" },
        { label: confirmLabel, kind: danger ? "danger-fill" : "primary", onClick: () => { result = true; } }
      ],
      onClose: () => resolve(result)
    });
  });
}

// ---------- 弹出菜单 ----------

let activePopover = null;

export function closePopover() {
  activePopover?.remove();
  activePopover = null;
}

/** 在 anchor 上方弹出菜单。content 是 Node。 */
export function openPopover(anchor, content, { placement = "top" } = {}) {
  closePopover();
  const popover = document.createElement("div");
  popover.className = "popover";
  popover.append(content);
  document.body.append(popover);

  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
  let top = placement === "top" ? rect.top - height - 10 : rect.bottom + 8;
  if (top < 8) top = rect.bottom + 8;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.transformOrigin = placement === "top" ? "bottom center" : "top center";

  activePopover = popover;
  window.setTimeout(() => {
    const onDown = (event) => {
      if (!popover.contains(event.target) && !anchor.contains(event.target)) {
        document.removeEventListener("pointerdown", onDown, true);
        if (activePopover === popover) closePopover();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
  });
  return popover;
}

// ---------- 时间 ----------

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function timeAgo(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return formatTime(timestamp);
}

// ---------- 文件 ----------

export function downloadText(filename, text, type = "text/markdown;charset=utf-8") {
  downloadBlob(filename, new Blob([text], { type }));
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function fileStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

// ---------- 网络 ----------

export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

/** 读取服务端的 SSE 流（POST）。onEvent(event, data)。 */
export async function postStream(url, body, onEvent, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败（${response.status}）`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

// ---------- Markdown（安全子集） ----------

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<span class="ts">$1</span>');
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r/g, "").split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (/^```/.test(line)) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
      index += 1;
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]) && lines[index + 1].includes("-")) {
      const head = splitRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) rows.push(splitRow(lines[index++]));
      html.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
      );
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (index < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[index])) {
        const raw = lines[index];
        const depth = Math.min(3, Math.floor((raw.match(/^\s*/)[0].length) / 2));
        let text = raw.replace(/^\s*([-*+]|\d+[.)])\s+/, "");
        let check = "";
        const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) {
          check = `<span class="md-check${task[1].trim() ? " done" : ""}"></span>`;
          text = task[2];
        }
        items.push(`<li class="d${depth}">${check}${inline(text)}</li>`);
        index += 1;
      }
      html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      html.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[index])
    ) {
      paragraph.push(lines[index++]);
    }
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    else index += 1;
  }

  return html.join("");
}
