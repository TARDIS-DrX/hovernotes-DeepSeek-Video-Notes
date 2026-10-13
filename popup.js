// Toolbar popup: the entry point for capture. Opening this popup is what grants
// the activeTab permission that chrome.tabCapture needs, so "start" lives here.

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(text) {
  $("status").textContent = text;
}

function openSidePanel(tabId) {
  try {
    if (chrome.sidePanel && chrome.sidePanel.open && tabId != null) {
      const p = chrome.sidePanel.open({ tabId });
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch (e) {}
}

$("start").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.id) return setStatus("找不到活动标签页。");

  // Keep the side panel open so it can show logs and generate the note.
  openSidePanel(tab.id);

  const { settings } = await chrome.storage.local.get("settings");
  const transcribe = !!(settings && settings.whisper);

  const res = await chrome.runtime.sendMessage({
    type: "panel:start",
    tabId: tab.id,
    options: { transcribe }
  });

  if (res && res.ok) {
    $("start").disabled = true;
    $("stop").disabled = false;
    setStatus("记录中…播放视频，结束后点“停止并生成”。");
  } else {
    const err = (res && res.error) || "未知错误";
    setStatus(
      "启动失败：" + err +
        (/active stream/i.test(err)
          ? "（该标签页正被别的捕获占用：关掉“实时字幕”/录屏类扩展，或刷新页面后再试）"
          : "")
    );
  }
});

$("stop").addEventListener("click", async () => {
  const tab = await activeTab();
  const res = await chrome.runtime.sendMessage({ type: "panel:stop", tabId: tab && tab.id });
  $("start").disabled = false;
  $("stop").disabled = true;
  setStatus(res && res.ok ? "已停止，正在侧边栏生成笔记…" : "停止失败。");
});

$("panel").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab && tab.id) openSidePanel(tab.id);
  window.close();
});
