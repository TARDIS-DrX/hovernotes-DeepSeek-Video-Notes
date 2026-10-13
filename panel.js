import { ulid } from "./lib/ulid.js";
import { generateNotes } from "./lib/deepseek.js";
import { pickVault, getStoredVault, openVaultPicker, ensureWritePermission, saveNote, IMAGES_FOLDER } from "./lib/obsidian.js";
import { pageCapabilities, capabilityChecks } from "./lib/capabilities.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");

let vaultHandle = null;
let currentTabId = null;
let recording = false;
let pendingSave = null;

const EMBED = new URLSearchParams(location.search).get("embed") === "1" || window.self !== window.top;
let splitOn = false;
if (EMBED) document.body.classList.add("embed");

// Keep unexpected async failures inside the panel log instead of the error page.
window.addEventListener("unhandledrejection", (e) => {
  log("错误：" + String((e.reason && e.reason.message) || e.reason));
  e.preventDefault();
});

if (EMBED) {
  $("close").addEventListener("click", () => window.parent.postMessage({ type: "dvn:close" }, "*"));
  $("split").addEventListener("click", () => {
    splitOn = !splitOn;
    $("split").textContent = splitOn ? "⇥" : "⇤";
    window.parent.postMessage({ type: "dvn:split", on: splitOn }, "*");
  });
}

$("openStandalone").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("panel.html") });
});

function log(line) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = settings || {};
  $("apiKey").value = s.apiKey || "";
  $("language").value = s.language || "中文";
  $("folder").value = s.folder || "";
  $("whisper").checked = !!s.whisper;
  $("stylePrompt").value = s.stylePrompt || "";
}

async function saveSettings() {
  const settings = {
    apiKey: $("apiKey").value.trim(),
    language: $("language").value.trim(),
    folder: $("folder").value.trim(),
    whisper: $("whisper").checked,
    stylePrompt: $("stylePrompt").value.trim()
  };
  await chrome.storage.local.set({ settings });
  log("设置已保存");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function listFrameIds(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return (frames || []).map((f) => f.frameId);
  } catch (e) {
    return [0];
  }
}

async function sendToFrame(tabId, frameId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId });
  } catch (e) {
    return null;
  }
}

async function scanFrames(tabId) {
  const frameIds = await listFrameIds(tabId);
  let fallback = null;
  for (const frameId of frameIds) {
    const meta = await sendToFrame(tabId, frameId, { type: "cs:getMeta" });
    if (meta && meta.hasVideo) {
      meta.frameId = frameId;
      return meta;
    }
    if (meta && !fallback) fallback = meta;
  }
  return fallback;
}

// Find the frame with a <video>. If the content script is missing (the page was
// loaded before the extension), inject it into all frames and retry once.
async function getMeta(tabId) {
  let found = await scanFrames(tabId);
  if (found && found.hasVideo) return found;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content-script.js"]
    });
    await new Promise((r) => setTimeout(r, 150));
    found = await scanFrames(tabId);
  } catch (e) {}
  return found || { hasVideo: false };
}

async function getTranscript(tabId, frameId) {
  if (frameId === undefined) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "cs:getTranscript" });
      return res && res.transcript ? res.transcript : null;
    } catch (e) {
      return null;
    }
  }
  const res = await sendToFrame(tabId, frameId, { type: "cs:getTranscript" });
  return res && res.transcript ? res.transcript : null;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// Build the final Markdown. Keeps the fields the user's .base views depend on:
// title/author/source/description frontmatter, tag "hover-notes",
// screenshot files named screenshot-<id>.png inside hover-notes-images/.
function imageBlock(shot, meta) {
  const cap = shot.caption || shot.timestamp;
  let s = `\n\n![${cap}](${IMAGES_FOLDER}/${shot.name})\n[${shot.timestamp}](${meta.source || "#"})`;
  if (shot.caption) s += ` — ${shot.caption}`;
  return s + "\n\n";
}

// Insert images where the model put [[SHOT:k]] placeholders.
function buildMarkdown({ notes, meta, shotByIndex }) {
  const title = notes.title || meta.title || "Untitled video note";
  const tags = ["hover-notes"];
  if (meta.platform) tags.push(meta.platform.replace(/[^\w.-]/g, ""));
  for (const t of notes.tags || []) {
    const clean = String(t).replace(/[^\w./-]/g, "");
    if (clean && !tags.includes(clean)) tags.push(clean);
  }
  const created = new Date().toISOString().slice(0, 10);
  const fm =
    "---\n" +
    `title: ${title}\n` +
    `description: ${title}\n` +
    `author: ${meta.author || ""}\n` +
    `source: ${meta.source || ""}\n` +
    `created: "${created}"\n` +
    "tags:\n" +
    tags.map((t) => `  - ${t}`).join("\n") +
    "\n---\n\n";

  let body = "";
  if (notes.summary) body += `> [!abstract] 摘要\n> ${notes.summary}\n\n`;
  let md = (notes.markdown || "").trim() || "（模型未返回正文）";
  const used = new Set();
  md = md.replace(/\[\[SHOT:(\d+)\]\]/g, (m, n) => {
    const shot = shotByIndex[Number(n)];
    if (!shot) return "";
    used.add(Number(n));
    return imageBlock(shot, meta);
  });
  body += md + "\n\n";

  const leftovers = Object.keys(shotByIndex)
    .map(Number)
    .filter((i) => !used.has(i));
  if (leftovers.length) {
    body += "## 关键画面\n\n";
    for (const i of leftovers) body += imageBlock(shotByIndex[i], meta);
  }
  return fm + body;
}

function pickScreenshots(notes, frames) {
  const referenced = new Set();
  for (const m of String(notes.markdown || "").matchAll(/\[\[SHOT:(\d+)\]\]/g)) {
    referenced.add(Number(m[1]));
  }
  const capByIndex = {};
  for (const s of notes.screenshots || []) {
    if (s && Number.isInteger(s.index)) capByIndex[s.index] = String(s.caption || "");
  }
  for (const k of Object.keys(capByIndex)) referenced.add(Number(k));

  const shotByIndex = {};
  const screenshots = [];
  const list = Array.from(referenced).filter((i) => frames[i]).slice(0, 3);
  for (const idx of list) {
    const name = `screenshot-${ulid()}.png`;
    shotByIndex[idx] = { name, caption: capByIndex[idx] || "", timestamp: fmtTime(frames[idx].t) };
    screenshots.push({ name, dataUrl: frames[idx].dataUrl });
  }
  return { shotByIndex, screenshots };
}

// --- tiny Markdown renderer for the live preview -------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" }[c]));
}

function renderInline(text, shotSrc) {
  let t = escapeHtml(text);
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => `<img alt="${alt}" src="${shotSrc[src] || src}" />`);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => `<a href="${url}" target="_blank" rel="noreferrer">${txt}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  return t;
}

function renderMarkdown(md, shotSrc) {
  shotSrc = shotSrc || {};
  const lines = String(md || "").split(/\r?\n/);
  const out = [];
  let inList = false;
  let listTag = "ul";
  const closeList = () => { if (inList) { out.push(`</${listTag}>`); inList = false; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }
    if (/^---+\s*$/.test(line)) { closeList(); out.push("<hr/>"); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${renderInline(h[2], shotSrc)}</h${lvl}>`); i++; continue; }
    if (/^>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      const first = buf[0] || "";
      const cm = first.match(/^\[!(\w+)\]\s*(.*)$/i);
      const title = cm ? (cm[2] || cm[1]) : "";
      const bodyLines = cm ? buf.slice(1) : buf;
      out.push(`<blockquote class="${cm ? "callout" : "quote"}">${title ? `<div class="callout-title">${renderInline(title, shotSrc)}</div>` : ""}${bodyLines.map((b) => `<p>${renderInline(b, shotSrc)}</p>`).join("")}</blockquote>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const tag = ordered ? "ol" : "ul";
      if (!inList || listTag !== tag) { closeList(); listTag = tag; out.push(`<${tag}>`); inList = true; }
      out.push(`<li>${renderInline(li[3], shotSrc)}</li>`);
      i++; continue;
    }
    closeList();
    const para = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+\.\s|---)/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push(`<p>${para.map((l) => renderInline(l, shotSrc)).join("<br/>")}</p>`);
  }
  closeList();
  return out.join("\n");
}

function renderPreview() {
  const md = $("preview").value;
  const shotSrc = {};
  if (pendingSave) {
    for (const s of pendingSave.screenshots || []) shotSrc[`${IMAGES_FOLDER}/${s.name}`] = s.dataUrl;
  }
  const el = $("rendered");
  if (el) el.innerHTML = renderMarkdown(md, shotSrc);
}

async function finishRecording(payload) {
function tsToSec(ts) {
  const p = String(ts).split(":").map(Number);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}

function sliceTranscript(transcript, from, to) {
  if (!transcript) return null;
  const kept = transcript.split("\n").filter((line) => {
    const m = line.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
    if (!m) return true;
    const t = tsToSec(`${m[1]}:${m[2]}:${m[3]}`);
    return t >= from && t < to;
  });
  return kept.length ? kept.join("\n") : null;
}

// Split long videos into time-bounded chunks so each DeepSeek call stays small.
async function generateNotesChunked({ apiKey, meta, transcript, frames, language, stylePrompt }) {
  const MAX_FRAMES = 12;
  const WINDOW_SEC = 120;
  const chunks = [];
  let start = 0;
  for (let i = 0; i < frames.length; i++) {
    if (i > start && (i - start + 1 > MAX_FRAMES || frames[i].t - frames[start].t > WINDOW_SEC)) {
      chunks.push([start, i - 1]);
      start = i;
    }
  }
  if (frames.length) chunks.push([start, frames.length - 1]);

  const merged = { title: null, tags: [], summary: "", markdown: "", screenshots: [] };
  for (const [a, b] of chunks) {
    const sub = frames.slice(a, b + 1);
    const from = frames[a].t;
    const to = (frames[b + 1] ? frames[b + 1].t : frames[b].t + WINDOW_SEC);
    const subTranscript = sliceTranscript(transcript, from, to);
    log(`分块 ${a}-${b}（${sub.length} 帧）生成中…`);
    try {
      const notes = await generateNotes({ apiKey, meta, transcript: subTranscript, frames: sub, language, stylePrompt });
      if (!merged.title) merged.title = notes.title;
      for (const t of notes.tags || []) if (!merged.tags.includes(t)) merged.tags.push(t);
      if (!merged.summary && notes.summary) merged.summary = notes.summary;
      if (notes.markdown) {
        // Chunk-local frame indices -> global indices for the placeholders.
        const remapped = String(notes.markdown).replace(/\[\[SHOT:(\d+)\]\]/g, (m, n) => `[[SHOT:${Number(n) + a}]]`);
        merged.markdown += (merged.markdown ? "\n\n" : "") + remapped.trim() + "\n";
      }
      for (const s of notes.screenshots || []) {
        const idx = s && Number.isInteger(s.index) ? s.index + a : -1;
        if (idx >= 0 && merged.screenshots.length < 4) {
          merged.screenshots.push({ index: idx, caption: String(s.caption || "") });
        }
      }
    } catch (e) {
      log(`分块 ${a}-${b} 失败：${String(e.message || e)}`);
    }
  }
  return merged;
}

  const frames = payload.frames || [];
  log(`采集完成：${frames.length} 个关键帧，时长 ${payload.durationSec}s`);
  if (!frames.length) {
    log("没有关键帧，跳过生成。");
    return;
  }
  if (!vaultHandle) {
    log("请先选择 Obsidian 仓库。");
    return;
  }
  const { settings } = await chrome.storage.local.get("settings");
  const apiKey = (settings && settings.apiKey) || "";
  if (!apiKey) {
    log("缺少 DeepSeek API Key。");
    return;
  }

  const meta = await getMeta(payload.tabId);
  // Prefer platform captions; fall back to the local Whisper transcript.
  const transcript = (await getTranscript(payload.tabId, meta.frameId)) || payload.transcript || null;
  log(`元数据：${meta.title || "(无标题)"}；转录：${transcript ? transcript.length + " 字符" : "无"}`);

  log("调用 DeepSeek 生成笔记…");
  let notes;
  try {
    notes = await generateNotesChunked({
      apiKey,
      meta,
      transcript,
      frames,
      language: (settings && settings.language) || "中文",
      stylePrompt: (settings && settings.stylePrompt) || ""
    });
  } catch (e) {
    log("DeepSeek 失败：" + String(e.message || e));
    return;
  }

  const { shotByIndex, screenshots } = pickScreenshots(notes, frames);
  const content = buildMarkdown({ notes, meta, shotByIndex });
  const filename = (notes.title || meta.title || "video-note").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) + ".md";

  pendingSave = { filename, folder: (settings && settings.folder) || "", screenshots };
  $("preview").value = content;
  renderPreview();
  $("previewWrap").hidden = false;
  log(`已生成草稿（${screenshots.length} 张图）。可在下方预览/修改，确认后点“保存到 Obsidian”。`);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "vault:changed") {
    refreshVault();
    return;
  }
  if (msg && msg.type === "panel:log") {
    log(msg.line);
    return;
  }
  if (msg && msg.type === "panel:result") {
    recording = false;
    $("start").disabled = false;
    $("stop").disabled = true;
    finishRecording(msg.payload || {});
  }
});

async function refreshVault() {
  const h = await getStoredVault();
  if (h) {
    vaultHandle = h;
    $("vaultName").textContent = h.name;
    log("已选择仓库：" + h.name);
  }
}

$("pick").addEventListener("click", async () => {
  // Always pick from a top-level extension window: the side panel itself is not
  // allowed to show a file picker, which is why the vault seemed unchangeable.
  await openVaultPicker();
  log("已打开选择窗口；在里面选好文件夹并确认，面板会自动更新。");
});

$("saveKey").addEventListener("click", saveSettings);

$("start").addEventListener("click", async () => {
  // Permission must be (re)requested inside a user gesture.
  if (vaultHandle && !(await ensureWritePermission(vaultHandle))) {
    log("未获得仓库写入权限：请点“选择仓库”，在弹出窗口里再确认一次。");
    return;
  }
  const tab = await activeTab();
  if (!tab || !tab.id) return log("找不到活动标签页。");
  currentTabId = tab.id;
  const meta = await getMeta(tab.id);
  if (!meta || !meta.hasVideo) {
    log("这个标签页里没找到 <video> 元素（若刚重载扩展，请刷新页面后重试）。");
    return;
  }
  const hasCaptions = !!(await getTranscript(tab.id, meta.frameId));
  const useWhisper = $("whisper").checked && !hasCaptions;
  log(
    hasCaptions
      ? "检测到平台字幕，跳过本地 Whisper。"
      : useWhisper
        ? "无平台字幕，改用本地 Whisper 转写。"
        : "无平台字幕，且未启用本地 Whisper，仅靠画面理解。"
  );
  const res = await chrome.runtime.sendMessage({
    type: "panel:start",
    tabId: tab.id,
    options: { transcribe: useWhisper }
  });
  if (res && res.ok) {
    recording = true;
    $("start").disabled = true;
    $("stop").disabled = false;
    log("开始记录…");
  } else {
    const err = (res && res.error) || "unknown";
    log("启动失败：" + err);
    if (/activeTab|not been invoked|invoked for the current page/i.test(err)) {
      log("提示：先点一次浏览器工具栏里的扩展图标（授权当前页），再点“开始记录”。");
    }
  }
});

$("stop").addEventListener("click", async () => {
  if (vaultHandle && !(await ensureWritePermission(vaultHandle))) {
    log("未获得仓库写入权限：请点“选择仓库”，在弹出窗口里再确认一次。");
    return;
  }
  const tab = await activeTab();
  const tabId = currentTabId || (tab && tab.id);
  log("停止记录，等待采集结果…");
  await chrome.runtime.sendMessage({ type: "panel:stop", tabId });
});

async function runSelfCheck() {
  const page = pageCapabilities();
  let bg = {};
  try {
    bg = (await chrome.runtime.sendMessage({ type: "caps:bg" })) || {};
  } catch (e) {}
  const checks = capabilityChecks(page, bg);
  const lines = checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.label}${c.required ? "" : "（可选）"}`);
  const missing = checks.filter((c) => c.required && !c.ok).length;
  const el = $("caps");
  if (el) {
    el.textContent =
      `${page.browser} · Chromium ${page.chromium || "?"}\n` +
      lines.join("\n") +
      (missing
        ? `\n\n⚠️ 有 ${missing} 项必需能力缺失，本浏览器可能跑不通。`
        : "\n\n✅ 必需能力齐全。");
  }
  if (missing) log(`⚠️ 环境自检：${missing} 项必需能力缺失，见“环境自检”。`);
  else log(`环境自检通过（${page.browser} · Chromium ${page.chromium || "?"}）。`);
  return { page, bg, checks, missing };
}

$("save").addEventListener("click", async () => {
  if (!pendingSave) return;
  if (!vaultHandle) return log("请先选择 Obsidian 仓库。");
  if (!(await ensureWritePermission(vaultHandle))) {
    return log("未获得写入权限：请点“选择仓库”重新授权。");
  }
  const content = $("preview").value;
  log("写入 Obsidian…");
  try {
    const res = await saveNote({
      vaultHandle,
      folder: pendingSave.folder,
      filename: pendingSave.filename,
      content,
      screenshots: pendingSave.screenshots
    });
    log(`已保存：${res.path}（截图 ${pendingSave.screenshots.length} 张）`);
    pendingSave = null;
    $("previewWrap").hidden = true;
  } catch (e) {
    const m = String((e && e.message) || e);
    log("写入失败：" + m);
    if (/permission|NotAllowed|not allowed/i.test(m)) log("提示：请点“选择仓库”重新授权后重试。");
  }
});

$("discard").addEventListener("click", () => {
  pendingSave = null;
  $("previewWrap").hidden = true;
  log("已丢弃本次草稿。");
});

$("preview").addEventListener("input", renderPreview);

(async function init() {
  await runSelfCheck();
  await loadSettings();
  vaultHandle = await getStoredVault();
  if (vaultHandle) {
    $("vaultName").textContent = vaultHandle.name;
    log("已恢复上次的仓库：" + vaultHandle.name);
  } else {
    log("请选择 Obsidian 仓库并填入 DeepSeek Key。");
  }
  const tab = await activeTab();
  if (tab) {
    const meta = await getMeta(tab.id);
    log(meta && meta.hasVideo ? "当前标签页检测到视频。" : "当前标签页未检测到视频。");
  }
})();
