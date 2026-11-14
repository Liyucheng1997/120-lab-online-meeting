import { icon } from "./icons.js";
import {
  $,
  $$,
  copyText,
  downloadText,
  escapeHtml,
  fileStamp,
  formatDuration,
  postJson,
  postStream,
  renderMarkdown,
  timeAgo,
  toast
} from "./ui.js";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const CAPTION_LINGER_MS = 5000;

/**
 * AI 助手：语音转写 → 实时字幕 → 翻译 → AI 笔记 / 会议纪要 / 问答。
 *
 * 转写方式：每位参会者在自己的浏览器里识别自己的麦克风（Web Speech API），
 * 识别结果经服务器广播给所有人，因此每段文字天然带有发言人姓名。
 */
export function createAi(ctx) {
  const els = {
    notice: $("#aiNotice"),
    tabs: $$("[data-ai-tab]"),
    panes: $$("[data-ai-pane]"),
    transcribeButton: $("#transcribeButton"),
    translateSelect: $("#translateSelect"),
    exportButton: $("#exportTranscriptButton"),
    speechHint: $("#speechHint"),
    transcriptList: $("#transcriptList"),
    notesButton: $("#notesButton"),
    notesMeta: $("#notesMeta"),
    notesContent: $("#notesContent"),
    minutesButton: $("#minutesButton"),
    copyMinutesButton: $("#copyMinutesButton"),
    downloadMinutesButton: $("#downloadMinutesButton"),
    minutesContent: $("#minutesContent"),
    askThread: $("#askThread"),
    askForm: $("#askForm"),
    askInput: $("#askInput"),
    captionBar: $("#captionBar")
  };

  const state = {
    tab: "transcript",
    transcription: { active: false, by: "" },
    segments: [],
    segmentById: new Map(),
    captions: new Map(),
    captionsVisible: false,
    notes: null,
    notesBusy: false,
    minutes: null,
    minutesBusy: false,
    askHistory: [],
    askBusy: false,
    translateQueue: new Set(),
    translateTimer: null,
    translateWarned: false
  };

  const speech = {
    recognition: null,
    blocked: false,
    failures: 0,
    lastInterimAt: 0,
    restartTimer: null
  };

  const aiReady = () => Boolean(ctx.config?.ai?.configured);

  // ---------- 初始化界面 ----------

  for (const [code, name] of [["", "不翻译"], ...Object.entries(ctx.languages)]) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = code ? `翻译成 ${shortLanguage(name)}` : name;
    els.translateSelect.append(option);
  }
  els.translateSelect.value = ctx.prefs().captionLang || "";

  els.tabs.forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.aiTab)));
  els.transcribeButton.addEventListener("click", () => setTranscription(!state.transcription.active));
  els.translateSelect.addEventListener("change", () => {
    ctx.savePrefs({ captionLang: els.translateSelect.value });
    retranslateRecent();
    renderTranscript();
    renderCaptions();
  });
  els.exportButton.addEventListener("click", exportTranscript);
  els.notesButton.addEventListener("click", () => refreshNotes(true));
  els.minutesButton.addEventListener("click", generateMinutes);
  els.copyMinutesButton.addEventListener("click", async () => {
    if (state.minutes && (await copyText(state.minutes.markdown))) toast("会议纪要已复制", "success");
  });
  els.downloadMinutesButton.addEventListener("click", downloadMinutes);
  els.askForm.addEventListener("submit", (event) => {
    event.preventDefault();
    ask(els.askInput.value);
  });
  $$("[data-ask]").forEach((chip) => chip.addEventListener("click", () => ask(chip.dataset.ask)));

  if (!aiReady()) {
    els.notice.classList.remove("hidden");
    els.notice.innerHTML =
      `${icon("sparkles", 16)}<div><b>AI 功能未启用</b><span>服务器需要配置 <code>ANTHROPIC_API_KEY</code>。转写和字幕仍可正常使用。</span></div>`;
    for (const button of [els.notesButton, els.minutesButton]) button.disabled = true;
    els.translateSelect.disabled = true;
    els.askInput.disabled = true;
    els.askInput.placeholder = "AI 未启用";
  }

  if (!SpeechRecognition) {
    showSpeechHint("你的浏览器不支持语音识别，你的发言不会被转写。请使用 Chrome 或 Edge；其他人的字幕仍会显示。");
  }

  window.setInterval(() => {
    pruneCaptions();
    if (state.notes) renderNotesMeta();
  }, 1000);

  selectTab("transcript");

  // ---------- 标签页 ----------

  function selectTab(tab) {
    state.tab = tab;
    els.tabs.forEach((button) => button.classList.toggle("active", button.dataset.aiTab === tab));
    els.panes.forEach((pane) => pane.classList.toggle("hidden", pane.dataset.aiPane !== tab));
    if (tab === "ask") els.askInput.focus();
  }

  // ---------- 转写开关 ----------

  function setTranscription(active) {
    ctx.send({ type: "transcription", active });
  }

  function applyTranscription({ active, by }) {
    const changed = state.transcription.active !== active;
    state.transcription = { active, by };
    els.transcribeButton.textContent = active ? "停止转写" : "开始转写";
    els.transcribeButton.classList.toggle("btn-primary", !active);
    ctx.onTranscription(active, by);
    if (changed && active && !state.captionsVisible && ctx.prefs().autoCaptions !== false) {
      setCaptionsVisible(true);
    }
    syncRecognition();
  }

  // ---------- 语音识别（只识别自己的麦克风） ----------

  function shouldRecognize() {
    return Boolean(SpeechRecognition) && !speech.blocked && state.transcription.active && ctx.isMicOn();
  }

  function syncRecognition() {
    if (shouldRecognize()) {
      if (!speech.recognition) startRecognition();
    } else if (speech.recognition) {
      stopRecognition();
    }
  }

  function startRecognition() {
    window.clearTimeout(speech.restartTimer);
    const recognition = new SpeechRecognition();
    recognition.lang = ctx.prefs().speechLang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      speech.failures = 0;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript || "";
        if (result.isFinal) sendFinal(text);
        else interim += text;
      }
      if (interim.trim()) sendInterim(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        speech.blocked = true;
        showSpeechHint("语音识别被浏览器拒绝了。请允许麦克风权限，或换用 Chrome / Edge。");
        return;
      }
      if (event.error === "language-not-supported") {
        speech.blocked = true;
        showSpeechHint("浏览器不支持当前的识别语言，请在设置里换一种“我说的语言”。");
        return;
      }
      speech.failures += 1;
      if (event.error === "network") {
        showSpeechHint("语音识别服务连接失败（浏览器语音识别需要联网）。正在重试…");
      }
    };

    recognition.onend = () => {
      if (speech.recognition !== recognition) return;
      speech.recognition = null;
      if (speech.failures >= 6) {
        showSpeechHint("语音识别多次失败，已暂停。检查网络后点“开始转写”重试。");
        speech.failures = 0;
        return;
      }
      // Chrome 每隔一段时间会自动结束识别，这里无缝重启。
      const delay = Math.min(5000, 200 * 2 ** speech.failures);
      speech.restartTimer = window.setTimeout(syncRecognition, delay);
    };

    speech.recognition = recognition;
    try {
      recognition.start();
      if (!speech.blocked && els.speechHint.dataset.kind !== "static") hideSpeechHint();
    } catch (error) {
      console.warn("语音识别启动失败", error);
      speech.recognition = null;
    }
  }

  function stopRecognition() {
    const recognition = speech.recognition;
    speech.recognition = null;
    window.clearTimeout(speech.restartTimer);
    if (recognition) {
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // 已停止
      }
    }
    const self = state.captions.get(ctx.selfId());
    if (self && !self.final) {
      state.captions.delete(ctx.selfId());
      renderCaptions();
    }
  }

  function sendFinal(raw) {
    const text = raw.trim();
    if (!text) return;
    ctx.send({ type: "caption", text, final: true, lang: ctx.prefs().speechLang });
  }

  function sendInterim(raw) {
    const text = raw.trim();
    // 自己的临时字幕直接显示，不必等服务器回传。
    updateCaption({ speakerId: ctx.selfId(), speaker: ctx.selfName(), text, lang: ctx.prefs().speechLang, final: false });
    const now = performance.now();
    if (now - speech.lastInterimAt < 300) return;
    speech.lastInterimAt = now;
    ctx.send({ type: "caption", text, final: false, lang: ctx.prefs().speechLang });
  }

  function showSpeechHint(text, kind = "dynamic") {
    els.speechHint.textContent = text;
    els.speechHint.dataset.kind = kind;
    els.speechHint.classList.remove("hidden");
  }

  function hideSpeechHint() {
    if (!SpeechRecognition) return;
    els.speechHint.classList.add("hidden");
  }

  // ---------- 字幕 ----------

  function handleCaption(message) {
    if (message.final) {
      const segment = {
        id: message.id,
        speakerId: message.speakerId,
        speaker: message.speaker,
        text: message.text,
        lang: message.lang,
        at: message.at,
        tr: {}
      };
      addSegment(segment);
      queueTranslation(segment);
    }
    updateCaption(message);
  }

  let captionSeq = 0;

  function updateCaption(message) {
    const previous = state.captions.get(message.speakerId);
    state.captions.set(message.speakerId, {
      speaker: message.speaker,
      text: message.text,
      lang: message.lang,
      segmentId: message.final ? message.id : null,
      final: Boolean(message.final),
      at: Date.now(),
      // 行的先后按“开始说话”的时间排，说话过程中不再换位置，避免跳动。
      // 用递增序号而不是时间戳：两人同一毫秒开口时时间戳相同，会导致来回换位。
      startedAt: previous?.startedAt ?? ++captionSeq
    });
    renderCaptions();
  }

  function pruneCaptions() {
    let changed = false;
    const now = Date.now();
    for (const [id, caption] of state.captions) {
      if (now - caption.at > (caption.final ? CAPTION_LINGER_MS : CAPTION_LINGER_MS * 2)) {
        state.captions.delete(id);
        changed = true;
      }
    }
    if (changed) renderCaptions();
  }

  function captionText(caption) {
    const target = ctx.prefs().captionLang;
    if (caption.segmentId && target) {
      const segment = state.segmentById.get(caption.segmentId);
      const translated = segment?.tr[target];
      if (translated) return { main: translated, original: caption.text };
    }
    return { main: caption.text, original: "" };
  }

  function renderCaptions() {
    const visible = state.captionsVisible && state.captions.size > 0;
    els.captionBar.classList.toggle("hidden", !visible);
    if (!visible) return;

    // 只取最近说话的两个人，再按开始说话的先后排列。
    const lines = [...state.captions.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(-2)
      .sort((a, b) => a[1].startedAt - b[1].startedAt);
    const showOriginal = ctx.prefs().showOriginal;
    const wanted = new Set(lines.map(([id]) => id));

    // 原地更新文字，不重建 DOM：重建会让淡入动画每次都重播，看起来就是闪烁。
    for (const element of [...els.captionBar.children]) {
      if (!wanted.has(element.dataset.speaker)) element.remove();
    }

    lines.forEach(([speakerId, caption], index) => {
      let line = [...els.captionBar.children].find((el) => el.dataset.speaker === speakerId);
      if (!line) {
        line = document.createElement("div");
        line.className = "caption-line";
        line.dataset.speaker = speakerId;
        line.innerHTML = "<b></b><span></span><small></small>";
      }
      // 只在顺序确实不对时才移动节点（移动也会重播动画）。
      if (els.captionBar.children[index] !== line) {
        els.captionBar.insertBefore(line, els.captionBar.children[index] || null);
      }

      const { main, original } = captionText(caption);
      setText(line.children[0], caption.speaker);
      setText(line.children[1], tail(main, 140));
      setText(line.children[2], showOriginal && original ? tail(original, 140) : "");
      line.classList.toggle("interim", !caption.final);
    });
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function setCaptionsVisible(visible) {
    state.captionsVisible = visible;
    ctx.onCaptionsChange(visible);
    renderCaptions();
  }

  /** CC 按钮：转写没开时先开转写（字幕依赖每个人的转写）。 */
  function toggleCaptions() {
    if (!state.transcription.active) {
      setTranscription(true);
      setCaptionsVisible(true);
      return;
    }
    setCaptionsVisible(!state.captionsVisible);
  }

  // ---------- 转写列表 ----------

  function addSegment(segment) {
    if (state.segmentById.has(segment.id)) return;
    state.segments.push(segment);
    state.segmentById.set(segment.id, segment);
    if (state.segments.length > 5000) {
      const removed = state.segments.shift();
      state.segmentById.delete(removed.id);
    }
    appendSegmentRow(segment);
  }

  function segmentRowHtml(segment, previous) {
    const target = ctx.prefs().captionLang;
    const raw = target && segment.lang !== target ? segment.tr[target] : "";
    // 翻译失败时缓存的是原文，不再重复显示。
    const translated = raw && raw !== segment.text ? raw : "";
    const pending = target && segment.lang !== target && !raw && aiReady();
    const continued = previous && previous.speakerId === segment.speakerId && segment.at - previous.at < 60000;
    const isSelf = segment.speakerId === ctx.selfId();
    return `<div class="tr-row${continued ? " cont" : ""}${isSelf ? " self" : ""}" data-seg="${escapeHtml(segment.id)}">
      ${continued ? "" : `<div class="tr-head"><b>${escapeHtml(segment.speaker)}</b><span class="tabular">${formatDuration(segment.at - ctx.createdAt())}</span></div>`}
      <p class="tr-text">${escapeHtml(segment.text)}</p>
      ${translated ? `<p class="tr-trans">${escapeHtml(translated)}</p>` : pending ? '<p class="tr-trans pending">翻译中…</p>' : ""}
    </div>`;
  }

  function isNearBottom(element) {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }

  function appendSegmentRow(segment) {
    const list = els.transcriptList;
    $(".empty-state", list)?.remove();
    const stick = isNearBottom(list);
    const previous = state.segments[state.segments.length - 2];
    list.insertAdjacentHTML("beforeend", segmentRowHtml(segment, previous));
    if (list.children.length > 600) list.firstElementChild.remove();
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function updateSegmentRow(segment) {
    const row = els.transcriptList.querySelector(`[data-seg="${CSS.escape(segment.id)}"]`);
    if (!row) return;
    const index = state.segments.indexOf(segment);
    const stick = isNearBottom(els.transcriptList);
    row.outerHTML = segmentRowHtml(segment, state.segments[index - 1]);
    if (stick) els.transcriptList.scrollTop = els.transcriptList.scrollHeight;
  }

  function renderTranscript() {
    const list = els.transcriptList;
    if (!state.segments.length) return;
    const recent = state.segments.slice(-600);
    list.innerHTML = recent
      .map((segment, i) => segmentRowHtml(segment, i ? recent[i - 1] : null))
      .join("");
    list.scrollTop = list.scrollHeight;
  }

  // ---------- 翻译 ----------

  function needsTranslation(segment) {
    const target = ctx.prefs().captionLang;
    return Boolean(target && aiReady() && segment.lang !== target && !segment.tr[target]);
  }

  function queueTranslation(segment) {
    if (!needsTranslation(segment)) return;
    state.translateQueue.add(segment.id);
    window.clearTimeout(state.translateTimer);
    if (state.translateQueue.size >= 8) flushTranslations();
    else state.translateTimer = window.setTimeout(flushTranslations, 250);
  }

  function retranslateRecent() {
    for (const segment of state.segments.slice(-40)) queueTranslation(segment);
  }

  async function flushTranslations() {
    const target = ctx.prefs().captionLang;
    const ids = [...state.translateQueue];
    state.translateQueue.clear();
    if (!ids.length || !target) return;

    try {
      const { translations } = await postJson("/api/ai/translate", {
        roomId: ctx.roomId(),
        clientId: ctx.selfId(),
        target,
        segmentIds: ids
      });
      for (const [id, text] of Object.entries(translations || {})) {
        const segment = state.segmentById.get(id);
        if (!segment) continue;
        segment.tr[target] = text;
        updateSegmentRow(segment);
      }
      renderCaptions();
    } catch (error) {
      for (const id of ids) {
        const segment = state.segmentById.get(id);
        if (segment) segment.tr[target] = segment.text;
        if (segment) updateSegmentRow(segment);
      }
      if (!state.translateWarned) {
        state.translateWarned = true;
        toast(`翻译失败：${error.message}`, "error", 4000);
      }
    }
  }

  async function translateText(text) {
    const target = ctx.prefs().captionLang || ctx.prefs().aiLang || "zh-CN";
    const { text: translated } = await postJson("/api/ai/translate", {
      roomId: ctx.roomId(),
      clientId: ctx.selfId(),
      target,
      text
    });
    return translated;
  }

  // ---------- AI 笔记 ----------

  async function refreshNotes(manual) {
    if (!aiReady() || state.notesBusy) return;
    setNotesBusy(true);
    try {
      await postJson("/api/ai/notes", {
        roomId: ctx.roomId(),
        clientId: ctx.selfId(),
        language: ctx.prefs().aiLang
      });
    } catch (error) {
      if (manual) toast(error.message, "error", 4000);
      setNotesBusy(false);
    }
  }

  function setNotesBusy(busy) {
    state.notesBusy = busy;
    els.notesButton.disabled = busy || !aiReady();
    els.notesButton.lastChild.textContent = busy ? "整理中…" : "更新笔记";
    els.notesContent.classList.toggle("is-busy", busy);
  }

  function applyNotes(notes) {
    state.notes = notes;
    setNotesBusy(false);
    renderNotes();
    ctx.onNotes?.(notes);
  }

  function list(items, emptyText) {
    if (!items?.length) return `<p class="notes-empty">${emptyText}</p>`;
    return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  }

  function renderNotes() {
    const notes = state.notes;
    if (!notes) return;
    const actions = notes.actionItems?.length
      ? `<ul class="todo">${notes.actionItems
        .map((item) => {
          const meta = [item.owner && `负责人：${item.owner}`, item.due && `截止：${item.due}`].filter(Boolean).join(" · ");
          return `<li><span class="md-check"></span><div>${escapeHtml(item.task)}${meta ? `<small>${escapeHtml(meta)}</small>` : ""}</div></li>`;
        })
        .join("")}</ul>`
      : '<p class="notes-empty">暂无</p>';

    els.notesContent.innerHTML = `
      <h3 class="notes-title">${escapeHtml(notes.title || "会议笔记")}</h3>
      <p class="notes-summary">${escapeHtml(notes.summary || "")}</p>
      <h4>要点</h4>${list(notes.keyPoints, "暂无")}
      <h4>决议</h4>${list(notes.decisions, "还没有明确的决议")}
      <h4>待办事项</h4>${actions}
      ${notes.openQuestions?.length ? `<h4>待解决问题</h4>${list(notes.openQuestions)}` : ""}`;
    renderNotesMeta();
  }

  function renderNotesMeta() {
    if (!state.notes) return;
    els.notesMeta.textContent = `${timeAgo(state.notes.updatedAt)}更新 · ${state.notes.segmentCount} 段发言`;
  }

  // ---------- 会议纪要 ----------

  async function generateMinutes() {
    if (!aiReady() || state.minutesBusy) return;
    state.minutesBusy = true;
    els.minutesButton.disabled = true;
    els.minutesButton.lastChild.textContent = "生成中…";
    els.minutesContent.innerHTML = '<div class="ai-loading"><span class="spinner"></span>AI 正在通读整场会议…</div>';

    let markdown = "";
    let renderTimer = null;
    const render = () => {
      renderTimer = null;
      els.minutesContent.innerHTML = renderMarkdown(markdown) + '<span class="cursor"></span>';
    };

    try {
      await postStream(
        "/api/ai/minutes",
        { roomId: ctx.roomId(), clientId: ctx.selfId(), language: ctx.prefs().aiLang },
        (event, data) => {
          if (event === "delta") {
            markdown += data.text;
            if (!renderTimer) renderTimer = window.setTimeout(render, 80);
          } else if (event === "done") {
            window.clearTimeout(renderTimer);
            applyMinutes(data.minutes);
          } else if (event === "error") {
            throw new Error(data.error);
          }
        }
      );
      toast("会议纪要已生成", "success");
    } catch (error) {
      window.clearTimeout(renderTimer);
      toast(error.message || "生成失败", "error", 4500);
      if (state.minutes) renderMinutes();
      else els.minutesContent.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message || "生成失败")}</p></div>`;
    } finally {
      state.minutesBusy = false;
      els.minutesButton.disabled = false;
      els.minutesButton.lastChild.textContent = state.minutes ? "重新生成" : "生成会议纪要";
    }
  }

  function applyMinutes(minutes) {
    if (!minutes) return;
    state.minutes = minutes;
    els.copyMinutesButton.disabled = false;
    els.downloadMinutesButton.disabled = false;
    if (!state.minutesBusy) els.minutesButton.lastChild.textContent = "重新生成";
    renderMinutes();
    ctx.onMinutes?.(minutes);
  }

  function renderMinutes() {
    els.minutesContent.innerHTML = renderMarkdown(state.minutes.markdown);
  }

  function downloadMinutes() {
    if (!state.minutes) return;
    downloadText(`会议纪要-${fileStamp(new Date(state.minutes.createdAt))}.md`, state.minutes.markdown);
  }

  // ---------- 问 AI ----------

  async function ask(rawQuestion) {
    const question = String(rawQuestion || "").trim();
    if (!question || state.askBusy || !aiReady()) return;
    state.askBusy = true;
    els.askInput.value = "";
    els.askInput.disabled = true;
    $(".ask-chips", els.askThread)?.classList.add("compact");

    els.askThread.insertAdjacentHTML("beforeend", `<div class="bubble me">${escapeHtml(question)}</div>`);
    const answerEl = document.createElement("div");
    answerEl.className = "bubble ai markdown";
    answerEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    els.askThread.append(answerEl);
    els.askThread.scrollTop = els.askThread.scrollHeight;

    let answer = "";
    try {
      await postStream(
        "/api/ai/ask",
        {
          roomId: ctx.roomId(),
          clientId: ctx.selfId(),
          question,
          history: state.askHistory,
          language: ctx.prefs().aiLang
        },
        (event, data) => {
          if (event === "delta") {
            answer += data.text;
            answerEl.innerHTML = renderMarkdown(answer);
            els.askThread.scrollTop = els.askThread.scrollHeight;
          } else if (event === "error") {
            throw new Error(data.error);
          }
        }
      );
      state.askHistory.push({ question, answer });
    } catch (error) {
      answerEl.classList.add("error");
      answerEl.textContent = error.message || "回答失败";
    } finally {
      state.askBusy = false;
      els.askInput.disabled = false;
      els.askInput.focus();
    }
  }

  // ---------- 导出 ----------

  function transcriptMarkdown() {
    const target = ctx.prefs().captionLang;
    const lines = [
      `# 会议转写`,
      "",
      `- 会议：${ctx.roomId()}`,
      `- 开始时间：${new Date(ctx.createdAt()).toLocaleString("zh-CN", { hour12: false })}`,
      `- 导出时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      ""
    ];
    for (const segment of state.segments) {
      lines.push(`**[${formatDuration(segment.at - ctx.createdAt())}] ${segment.speaker}**：${segment.text}`);
      const translated = target && segment.tr[target];
      if (translated && translated !== segment.text) lines.push(`> ${translated}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  function exportTranscript() {
    if (!state.segments.length) {
      toast("还没有转写内容");
      return;
    }
    downloadText(`会议转写-${fileStamp()}.md`, transcriptMarkdown());
  }

  // ---------- 对外接口 ----------

  return {
    handleJoined(message) {
      state.segments = [];
      state.segmentById.clear();
      els.transcriptList.innerHTML = "";
      for (const segment of message.transcript || []) {
        const item = { ...segment, tr: {} };
        state.segments.push(item);
        state.segmentById.set(item.id, item);
      }
      if (state.segments.length) renderTranscript();
      else els.transcriptList.innerHTML = `<div class="empty-state">${icon("captions", 30)}<p>开启转写后，所有人的发言会实时变成文字，并可翻译成你的语言。</p></div>`;
      retranslateRecent();
      if (message.notes) applyNotes(message.notes);
      if (message.minutes) applyMinutes(message.minutes);
      applyTranscription(message.transcription || { active: false, by: "" });
    },
    handleCaption,
    handleTranscription: applyTranscription,
    handleNotes: applyNotes,
    handleNotesStatus(message) {
      setNotesBusy(Boolean(message.busy));
      if (message.error) toast(`AI 笔记：${message.error}`, "error", 4000);
    },
    handleMinutes: applyMinutes,
    syncRecognition,
    restartRecognition() {
      stopRecognition();
      speech.blocked = false;
      syncRecognition();
    },
    stop: stopRecognition,
    toggleCaptions,
    selectTab,
    translateText,
    exportTranscript,
    downloadMinutes,
    transcriptMarkdown,
    get captionsVisible() {
      return state.captionsVisible;
    },
    get transcriptionActive() {
      return state.transcription.active;
    },
    get hasTranscript() {
      return state.segments.length > 0;
    },
    get minutes() {
      return state.minutes;
    },
    get notes() {
      return state.notes;
    }
  };
}

function tail(text, max) {
  const chars = Array.from(text || "");
  return chars.length > max ? `…${chars.slice(-max).join("")}` : chars.join("");
}

function shortLanguage(name) {
  const match = String(name).match(/\(([^)]+)\)/);
  return match ? match[1] : name;
}
