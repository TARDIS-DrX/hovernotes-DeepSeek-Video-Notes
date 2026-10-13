// Runtime capability report. Runs in an extension page (panel / picker) and is
// merged with the service worker's own report, so the user can see at a glance
// which APIs this browser actually exposes.

export function pageCapabilities() {
  const ua = navigator.userAgent || "";
  const m = ua.match(/(?:Chrome|Chromium)\/(\d+)/);
  const chromium = m ? Number(m[1]) : null;
  const browser = /QQBrowser|Tencent|QQ\/|QQBrowser/i.test(ua)
    ? "QQ浏览器"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : "Chromium";

  const c = typeof chrome !== "undefined" ? chrome : {};
  let createWritable = false;
  try {
    createWritable =
      typeof FileSystemFileHandle !== "undefined" &&
      !!FileSystemFileHandle.prototype.createWritable;
  } catch (e) {}

  return {
    ua,
    chromium,
    browser,
    apis: {
      sidePanel: !!c.sidePanel,
      offscreen: !!c.offscreen,
      tabCapture: !!c.tabCapture,
      storage: !!(c.storage && c.storage.local),
      tabs: !!c.tabs,
      windows: !!c.windows,
      scripting: !!c.scripting,
      webNavigation: !!c.webNavigation
    },
    web: {
      showDirectoryPicker: typeof window.showDirectoryPicker === "function",
      createWritable,
      mediaRecorder: typeof MediaRecorder !== "undefined",
      audioContext: typeof AudioContext !== "undefined",
      createImageBitmap: typeof createImageBitmap === "function",
      indexedDB: typeof indexedDB !== "undefined"
    }
  };
}

// Flatten into a list of { key, label, ok, required }.
export function capabilityChecks(page, bg) {
  const p = page || {};
  const b = bg || {};
  const apis = Object.assign({}, p.apis, b);
  const web = p.web || {};
  return [
    { required: true, label: "抓标签页音频/视频 (tabCapture)", ok: !!b.getMediaStreamId },
    { required: true, label: "采集引擎 (offscreen)", ok: !!b.offscreen },
    { required: true, label: "写 Obsidian (File System Access)", ok: !!(web.showDirectoryPicker && web.createWritable) },
    { required: true, label: "录制 (MediaRecorder)", ok: !!web.mediaRecorder },
    { required: true, label: "音频解码 (AudioContext)", ok: !!web.audioContext },
    { required: true, label: "抽帧 (createImageBitmap)", ok: !!web.createImageBitmap },
    { required: true, label: "本地存储 (IndexedDB / storage)", ok: !!(web.indexedDB && apis.storage) },
    { required: true, label: "注入脚本 (scripting)", ok: !!apis.scripting },
    { required: true, label: "iframe 定位 (webNavigation)", ok: !!apis.webNavigation },
    { required: false, label: "侧边栏 (sidePanel，缺失则用独立窗口)", ok: !!(b.sidePanel && b.sidePanelOpen) }
  ];
}
