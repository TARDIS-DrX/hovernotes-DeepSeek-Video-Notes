// Content script: locate the page video, read metadata, and best-effort captions.
(function () {
  "use strict";

  // Deep query that also descends into open shadow roots (Douyin renders the
  // player inside a shadow tree, so a plain querySelectorAll misses it).
  function deepQueryAll(selector, root, out) {
    root = root || document;
    out = out || [];
    try {
      root.querySelectorAll(selector).forEach((el) => out.push(el));
    } catch (e) {}
    let all;
    try {
      all = root.querySelectorAll("*");
    } catch (e) {
      return out;
    }
    for (const el of all) {
      if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
    }
    return out;
  }

  function largestVideo() {
    const videos = deepQueryAll("video");
    if (!videos.length) return null;
    return videos.sort((a, b) => {
      const sa = (a.videoWidth || 0) * (a.videoHeight || 0);
      const sb = (b.videoWidth || 0) * (b.videoHeight || 0);
      return sb - sa;
    })[0];
  }

  function metaContent(name) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute("content") : null;
  }

  function collectMeta() {
    const video = largestVideo();
    return {
      hasVideo: !!video,
      title: metaContent("og:title") || document.title || "",
      author:
        metaContent("author") ||
        metaContent("og:site_name") ||
        metaContent("og:article:author") ||
        "",
      source: location.href,
      platform: location.hostname.replace(/^www\./, ""),
      description: metaContent("description") || metaContent("og:description") || "",
      videoDuration: video && isFinite(video.duration) ? video.duration : null,
      currentTime: video ? video.currentTime : null,
      pageUrl: location.href
    };
  }

  // Best-effort caption grab. Returns joined cue text if a text track is loaded.
  function readTextTrackCues() {
    const video = largestVideo();
    if (!video || !video.textTracks) return null;
    const parts = [];
    for (const track of Array.from(video.textTracks)) {
      if (track.mode === "disabled") continue;
      const cues = track.cues;
      if (!cues) continue;
      for (const cue of Array.from(cues)) {
        parts.push(`[${fmt(cue.startTime)}] ${cue.text}`);
      }
    }
    return parts.length ? parts.join("\n") : null;
  }

  // YouTube: pull caption baseUrl from the page's player response and fetch it.
  async function readYouTubeTranscript() {
    if (!/youtube\.com|youtu\.be/.test(location.hostname)) return null;
    try {
      const raw =
        window.ytInitialPlayerResponse &&
        JSON.stringify(window.ytInitialPlayerResponse);
      if (!raw) return null;
      const tracks =
        window.ytInitialPlayerResponse &&
        window.ytInitialPlayerResponse.captions &&
        window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer &&
        window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (!tracks || !tracks.length) return null;
      const url = tracks[0].baseUrl + "&fmt=json3";
      const res = await fetch(url);
      const json = await res.json();
      const lines = [];
      for (const ev of json.events || []) {
        if (!ev.segs) continue;
        const text = ev.segs.map((s) => s.utf8).join("").trim();
        if (text) lines.push(`[${fmt(ev.tStartMs / 1000)}] ${text}`);
      }
      return lines.length ? lines.join("\n") : null;
    } catch (e) {
      return null;
    }
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  async function collectTranscript() {
    return readTextTrackCues() || (await readYouTubeTranscript()) || readPlatformDescription() || null;
  }

  // Many platforms (Douyin, Bilibili, generic) carry the main text in the page
  // description/文案 rather than a caption track. Use it as a coarse transcript.
  function readPlatformDescription() {
    const desc = collectMeta().description;
    if (desc && desc.trim().length >= 8) {
      return `[00:00:00] ${desc.trim()}`;
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Ignore stale content scripts left over after an extension reload.
    try {
      if (!chrome.runtime || !chrome.runtime.id) return undefined;
    } catch (e) {
      return undefined;
    }
    if (!msg || typeof msg !== "object") return undefined;
    if (msg.type === "cs:getMeta") {
      sendResponse(collectMeta());
      return undefined;
    }
    if (msg.type === "cs:getTranscript") {
      collectTranscript()
        .then((transcript) => sendResponse({ transcript }))
        .catch(() => sendResponse({ transcript: null }));
      return true;
    }
    return undefined;
  });
})();
