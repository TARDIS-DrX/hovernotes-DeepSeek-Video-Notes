// DeepSeek Video Notes - service worker.
// Orchestrates capture: asks the browser for a tab stream id, hands it to the
// offscreen document, and relays the collected key frames to the panel page.
//
// Everything that runs at load time is wrapped, so a browser that lacks one API
// (e.g. a Chromium shell without chrome.sidePanel) cannot break registration.

const OFFSCREEN_PATH = "offscreen.html";
let creatingOffscreen = null;

function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {}
}

// --- Opening the panel: native side panel, else a small window -------------
function openFallbackPanel() {
  try {
    chrome.windows.create({
      url: chrome.runtime.getURL("panel.html"),
      type: "popup",
      width: 460,
      height: 760
    });
  } catch (e) {}
}

function enableSidePanelOnAction() {
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      // A popup owns the toolbar click now; keep the side panel as a page.
      const p = chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  } catch (e) {}
}
enableSidePanelOnAction();

// Single toolbar handler. On Chrome the side panel opens before this fires.
try {
  chrome.action.onClicked.addListener((tab) => {
    const tabId = tab && tab.id;
    if (chrome.sidePanel && chrome.sidePanel.open && tabId != null) {
      const p = chrome.sidePanel.open({ tabId });
      if (p && typeof p.catch === "function") p.catch(() => openFallbackPanel());
    } else {
      openFallbackPanel();
    }
  });
} catch (e) {}

// --- Offscreen document ----------------------------------------------------
async function hasOffscreenDocument() {
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      return await chrome.offscreen.hasDocument();
    }
    if (chrome.runtime && chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
      });
      return contexts.length > 0;
    }
  } catch (e) {}
  return false;
}

// Drop any leftover capture stream by recreating the offscreen document.
async function resetOffscreen() {
  try {
    if (chrome.offscreen && chrome.offscreen.closeDocument) {
      if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    }
  } catch (e) {}
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    throw new Error("offscreen API unavailable in this browser");
  }
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Capture the active tab's video to extract key frames."
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// --- Capture ---------------------------------------------------------------
function getMediaStreamId(tabId, retries = 8) {
  return new Promise((resolve, reject) => {
    if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) {
      return reject(new Error("tabCapture.getMediaStreamId unavailable in this browser"));
    }
    const attempt = (left) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        const err = chrome.runtime.lastError;
        if (!err && streamId) return resolve(streamId);
        const msg = err ? err.message : "no stream id";
        if (left <= 1) return reject(new Error(msg));
        // "active stream" means a previous capture has not been released yet.
        const delay = /active stream/i.test(msg) ? 600 : 300;
        setTimeout(() => attempt(left - 1), delay);
      });
    };
    attempt(retries);
  });
}

async function startCapture(tabId, options) {
  // Start from a clean offscreen document so no stale stream blocks the tab.
  await resetOffscreen();
  await ensureOffscreen();
  await new Promise((r) => setTimeout(r, 250));
  // getMediaStreamId expects the target tab to be the active tab; bring it forward.
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {}
  const streamId = await getMediaStreamId(tabId);
  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "capture:start",
    streamId,
    tabId,
    options: options || {}
  });
}

async function stopCapture(tabId) {
  await chrome.runtime.sendMessage({ target: "offscreen", type: "capture:stop", tabId });
}

// --- Capability report for the panel self-check ----------------------------
function bgCaps() {
  return {
    sidePanel: !!chrome.sidePanel,
    sidePanelOpen: !!(chrome.sidePanel && chrome.sidePanel.open),
    offscreen: !!(chrome.offscreen && chrome.offscreen.createDocument),
    tabCapture: !!chrome.tabCapture,
    getMediaStreamId: !!(chrome.tabCapture && chrome.tabCapture.getMediaStreamId),
    scripting: !!chrome.scripting,
    webNavigation: !!chrome.webNavigation,
    runtimeGetContexts: !!(chrome.runtime && chrome.runtime.getContexts)
  };
}

// --- Message routing -------------------------------------------------------
try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return undefined;

    if (msg.type === "caps:bg") {
      sendResponse(bgCaps());
      return false;
    }

    if (msg.type === "dvn:open-sidepanel") {
      const tabId = sender && sender.tab && sender.tab.id;
      if (chrome.sidePanel && chrome.sidePanel.open && tabId != null) {
        chrome.sidePanel
          .open({ tabId })
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true;
      }
      sendResponse({ ok: false, error: "sidePanel unavailable" });
      return false;
    }

    if (msg.type === "panel:start") {
      startCapture(msg.tabId, msg.options)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }

    if (msg.type === "panel:stop") {
      stopCapture(msg.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }

    if (msg.from === "offscreen" && msg.type === "log") {
      broadcast({ type: "panel:log", line: msg.data });
    }
    if (msg.from === "offscreen" && msg.type === "capture:result") {
      broadcast({ type: "panel:result", payload: msg.payload });
    }

    return undefined;
  });
} catch (e) {}

try {
  chrome.runtime.onInstalled.addListener(() => {
    enableSidePanelOnAction();
    try {
      chrome.action.setTitle({ title: "DeepSeek Video Notes" });
    } catch (e) {}
  });
} catch (e) {}
