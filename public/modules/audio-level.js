// 音量检测：用于说话人高亮、主讲人自动切换和麦克风电平条。
let sharedContext = null;

export function getAudioContext() {
  if (!sharedContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sharedContext = new Ctx();
  }
  if (sharedContext.state === "suspended") sharedContext.resume().catch(() => {});
  return sharedContext;
}

export function createLevelMonitor(onTick, interval = 150) {
  const entries = new Map();
  let timer = null;

  function track(id, stream) {
    const audioTrack = stream?.getAudioTracks?.()[0];
    const existing = entries.get(id);
    if (existing && existing.trackId === audioTrack?.id) return;
    untrack(id);
    if (!audioTrack) return;

    try {
      const context = getAudioContext();
      const source = context.createMediaStreamSource(new MediaStream([audioTrack]));
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      entries.set(id, {
        trackId: audioTrack.id,
        source,
        analyser,
        data: new Float32Array(analyser.fftSize),
        level: 0,
        lastLoud: 0
      });
      start();
    } catch (error) {
      console.warn("音量检测不可用", error);
    }
  }

  function untrack(id) {
    const entry = entries.get(id);
    if (!entry) return;
    try {
      entry.source.disconnect();
    } catch {
      // 已断开
    }
    entries.delete(id);
  }

  function start() {
    if (timer) return;
    timer = window.setInterval(tick, interval);
  }

  function tick() {
    const now = performance.now();
    const levels = new Map();
    for (const [id, entry] of entries) {
      entry.analyser.getFloatTimeDomainData(entry.data);
      let sum = 0;
      for (let i = 0; i < entry.data.length; i += 1) sum += entry.data[i] * entry.data[i];
      const rms = Math.sqrt(sum / entry.data.length);
      entry.level = entry.level * 0.5 + rms * 0.5;
      if (entry.level > 0.018) entry.lastLoud = now;
      levels.set(id, {
        level: Math.min(1, entry.level * 6),
        speaking: now - entry.lastLoud < 700
      });
    }
    onTick(levels);
  }

  function stop() {
    window.clearInterval(timer);
    timer = null;
    for (const id of [...entries.keys()]) untrack(id);
  }

  return { track, untrack, stop };
}
