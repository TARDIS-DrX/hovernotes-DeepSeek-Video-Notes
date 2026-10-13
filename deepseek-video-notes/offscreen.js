// Offscreen capture engine.
// Grabs the tab's video stream, samples frames, runs scene detection, and keeps
// key frames as PNG data URLs. Audio is recorded to a webm blob for optional
// local transcription (Whisper) — not yet wired up.

const CAPTURE_DEFAULTS = {
  fps: 4,                       // lighter sampling (~250ms per frame)
  maxDimension: 960,            // key frame longest edge
  keyframeType: "image/webp",   // webp is far cheaper than png to encode
  keyframeQuality: 0.6,
  fallbackFrameEveryMs: 30000,  // always keep a frame at least this often
  maxKeyFrames: 60,             // safety cap on key frames per session
  minKeyFrameGapMs: 8000,       // never keep two key frames closer than this
  transcribe: false,            // local Whisper is opt-in (heavy)
  whisperModel: "Xenova/whisper-tiny",
  sceneDetection: {
    enabled: true,
    algorithm: "quadrant-edge-or-histogram",
    sampleEveryNFrames: 2,      // on 4fps, check ~2x/sec
    cooldownMs: 500,
    pixelGate: 2.5,
    tinyWidth: 64,
    tinyHeight: 36,
    thresholds: { "quadrant-edge-diff": 4, "quadrant-histogram": 0.08 },
    quadrantMinCount: 2
  }
};

const state = {
  active: false,
  tabId: null,
  stream: null,
  video: null,
  captureCanvas: null,
  captureCtx: null,
  detectCanvas: null,
  detectCtx: null,
  detector: null,
  frames: [],
  loopTimer: null,
  recorder: null,
  audioChunks: [],
  startedAt: 0,
  playbackCtx: null,
  playbackSrc: null,
  lastKeyFrameAt: 0,
  lastFallbackAt: 0,
  config: null
};

function getTabUserMedia(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });
}

function computeSize(videoW, videoH, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(videoW, videoH));
  return {
    width: Math.max(2, Math.round(videoW * scale)),
    height: Math.max(2, Math.round(videoH * scale))
  };
}

async function startCapture({ streamId, tabId, options }) {
  if (state.active) await stopCapture();
  state.config = Object.assign({}, CAPTURE_DEFAULTS, options || {});
  state.config.sceneDetection = Object.assign(
    {},
    CAPTURE_DEFAULTS.sceneDetection,
    (options && options.sceneDetection) || {}
  );

  const stream = await getTabUserMedia(streamId);
  state.stream = stream;
  state.tabId = tabId;

  // tabCapture silences the tab's own playback; route the captured audio to speakers.
  try {
    const playbackCtx = new AudioContext();
    const src = playbackCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    src.connect(playbackCtx.destination);
    state.playbackCtx = playbackCtx;
    state.playbackSrc = src;
  } catch (e) {}

  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  await new Promise((resolve) => {
    if (video.videoWidth > 0) return resolve();
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
  });
  state.video = video;

  const size = computeSize(video.videoWidth, video.videoHeight, state.config.maxDimension);
  state.captureCanvas = document.createElement("canvas");
  state.captureCanvas.width = size.width;
  state.captureCanvas.height = size.height;
  state.captureCtx = state.captureCanvas.getContext("2d", { alpha: false });

  const sd = state.config.sceneDetection;
  state.detectCanvas = document.createElement("canvas");
  state.detectCanvas.width = sd.tinyWidth;
  state.detectCanvas.height = sd.tinyHeight;
  state.detectCtx = state.detectCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  state.detector = new SceneDetect.SceneDetector(sd);

  state.frames = [];
  state.audioChunks = [];
  state.startedAt = Date.now();
  state.lastKeyFrameAt = 0;
  state.lastFallbackAt = 0;
  state.active = true;

  // Optional: record the tab audio for offline transcription.
  try {
    const audioStream = new MediaStream(stream.getAudioTracks().map((t) => t.clone()));
    if (state.config.transcribe && audioStream.getAudioTracks().length) {
      const mime = ["audio/webm;codecs=opus", "audio/webm"].find((m) =>
        MediaRecorder.isTypeSupported(m)
      );
      const recorder = new MediaRecorder(audioStream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) state.audioChunks.push(e.data);
      };
      recorder.start(1000);
      state.recorder = recorder;
    }
  } catch (e) {
    // Audio is best-effort; frames still work without it.
  }

  const interval = Math.round(1000 / state.config.fps);
  const loop = () => {
    if (!state.active) return;
    sampleFrame();
    state.loopTimer = setTimeout(loop, interval);
  };
  loop();
}

function sampleFrame() {
  const { video, captureCtx, detectCtx, detector, config } = state;
  if (!video || video.readyState < 2) return;

  captureCtx.drawImage(video, 0, 0, state.captureCanvas.width, state.captureCanvas.height);
  detectCtx.drawImage(video, 0, 0, state.detectCanvas.width, state.detectCanvas.height);

  const result = detector.analyze(detectCtx);
  const now = Date.now();
  const elapsed = (now - state.startedAt) / 1000;
  const dueFallback = now - state.lastFallbackAt >= config.fallbackFrameEveryMs;
  const gapOk = !state.frames.length || now - state.lastKeyFrameAt >= (config.minKeyFrameGapMs || 0);

  if ((result.triggered && gapOk) || dueFallback) {
    state.lastFallbackAt = now;
    state.lastKeyFrameAt = now;
    if (state.frames.length < config.maxKeyFrames) {
      const dataUrl = state.captureCanvas.toDataURL(
        config.keyframeType || "image/webp",
        config.keyframeQuality || 0.6
      );
      state.frames.push({
        t: Math.round(elapsed * 1000) / 1000,
        dataUrl,
        score: Math.round((result.score || 0) * 1000) / 1000,
        reason: dueFallback && !result.triggered ? "interval" : result.reason
      });
    }
  }
}

function stopRecorder() {
// ---- Local Whisper transcription (optional) ----------------------------------
// Expects vendor/transformers.min.js (Transformers.js UMD build) to be present.
// Falls back gracefully: if the file or model is unavailable, returns null.
function loadTransformers() {
  if (self.transformers) return Promise.resolve(self.transformers);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("vendor/transformers.min.js");
    script.onload = () => (self.transformers ? resolve(self.transformers) : reject(new Error("transformers.js loaded but global missing")));
    script.onerror = () => reject(new Error("vendor/transformers.min.js not found"));
    document.head.appendChild(script);
  });
}

async function decodeAudioTo16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    return audioBuffer.getChannelData(0);
  } finally {
    ctx.close().catch(() => {});
  }
}

function fmtTs(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

async function transcribeAudio(blob, config) {
  if (!blob || !config.transcribe) return null;
  try {
    const transformers = await loadTransformers();
    const { pipeline, env } = transformers;
    if (env) {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
    }
    const audio = await decodeAudioTo16k(blob);
    const transcriber = await pipeline(
      "automatic-speech-recognition",
      config.whisperModel || "Xenova/whisper-tiny"
    );
    const out = await transcriber(audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5
    });
    if (out && out.chunks && out.chunks.length) {
      return out.chunks
        .map((c) => `[${fmtTs(c.timestamp && c.timestamp[0])}] ${String(c.text || "").trim()}`)
        .filter((l) => l.length > 12)
        .join("\n");
    }
    return out && out.text ? `[00:00:00] ${out.text}` : null;
  } catch (e) {
    chrome.runtime.sendMessage({ from: "offscreen", type: "log", data: "whisper unavailable: " + String(e && e.message || e) });
    return null;
  }
}

  return new Promise((resolve) => {
    const rec = state.recorder;
    if (!rec || rec.state === "inactive") return resolve(null);
    rec.onstop = () => resolve(new Blob(state.audioChunks, { type: rec.mimeType || "audio/webm" }));
    try {
      rec.stop();
    } catch (e) {
      resolve(null);
    }
  });
}

async function stopCapture() {
  if (!state.active) return;
  state.active = false;
  if (state.loopTimer) clearTimeout(state.loopTimer);

  const audioBlob = await stopRecorder().catch(() => null);
  try {
    state.stream.getTracks().forEach((t) => t.stop());
  } catch (e) {}

  try {
    if (state.playbackCtx) state.playbackCtx.close();
  } catch (e) {}
  state.playbackCtx = null;
  state.playbackSrc = null;

  let transcript = null;
  if (audioBlob && state.config && state.config.transcribe) {
    chrome.runtime.sendMessage({ from: "offscreen", type: "log", data: "transcribing audio with local whisper…" });
    transcript = await transcribeAudio(audioBlob, state.config).catch(() => null);
  }

  const payload = {
    tabId: state.tabId,
    durationSec: Math.round((Date.now() - state.startedAt) / 10) / 100,
    frames: state.frames.slice(),
    hasAudio: !!audioBlob,
    audioBytes: audioBlob ? audioBlob.size : 0,
    transcript
  };

  state.stream = null;
  state.video = null;
  state.recorder = null;
  state.frames = [];
  state.audioChunks = [];

  chrome.runtime.sendMessage({ from: "offscreen", type: "capture:result", payload });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return undefined;

  if (msg.type === "capture:start") {
    startCapture(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === "capture:stop") {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  return undefined;
});
