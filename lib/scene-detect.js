// Scene-change detector, ported from HoverNotes' offscreen pipeline.
// Splits each sampled frame into 4 quadrants on a tiny grayscale bitmap and
// flags a change when enough quadrants exceed the edge or histogram thresholds.
(function (global) {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    algorithm: "quadrant-edge-or-histogram",
    sampleEveryNFrames: 10,
    pixelGate: 2.5,             // cheap mean-diff gate before edge/histogram
    cooldownMs: 500,
    tinyWidth: 128,
    tinyHeight: 72,
    thresholds: {
      "quadrant-edge-diff": 4,
      "quadrant-histogram": 0.08
    },
    quadrantMinCount: 2,
    edgeQuadrantMinCount: 1,
    histogramQuadrantMinCount: 1
  };

  function toGray(rgba) {
    const n = rgba.length / 4;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      out[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    }
    return out;
  }

  // Mean absolute grayscale gradient difference (Sobel-like magnitude).
  function edgeScore(a, b, w, h) {
    let sum = 0;
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gax = a[i + 1] - a[i - 1];
        const gay = a[i + w] - a[i - w];
        const gbx = b[i + 1] - b[i - 1];
        const gby = b[i + w] - b[i - w];
        const ga = Math.sqrt(gax * gax + gay * gay);
        const gb = Math.sqrt(gbx * gbx + gby * gby);
        sum += Math.abs(ga - gb);
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  // Grayscale histogram chi-square distance, scaled to a comparable range.
  function histogramScore(a, b) {
    const ha = new Float32Array(256);
    const hb = new Float32Array(256);
    for (let i = 0; i < a.length; i++) {
      ha[Math.max(0, Math.min(255, Math.round(a[i])))]++;
      hb[Math.max(0, Math.min(255, Math.round(b[i])))]++;
    }
    const n = a.length || 1;
    let s = 0;
    for (let i = 0; i < 256; i++) {
      const pa = ha[i] / n;
      const pb = hb[i] / n;
      const t = pa + pb;
      if (t > 0) s += ((pa - pb) * (pa - pb)) / t;
    }
    return s;
  }

  function quadrantOf(gray, w, h, index) {
    const qw = Math.floor(w / 2);
    const qh = Math.floor(h / 2);
    const ox = (index % 2) * qw;
    const oy = Math.floor(index / 2) * qh;
    const data = new Float32Array(qw * qh);
    for (let y = 0; y < qh; y++) {
      for (let x = 0; x < qw; x++) {
        data[y * qw + x] = gray[(oy + y) * w + (ox + x)];
      }
    }
    return { data, width: qw, height: qh };
  }

  class SceneDetector {
    constructor(config) {
      this.config = Object.assign({}, DEFAULTS, config || {});
      this.config.thresholds = Object.assign({}, DEFAULTS.thresholds, (config && config.thresholds) || {});
      this.prev = null; // Float32Array of tiny grayscale
      this.frameIndex = 0;
      this.lastTriggerAt = 0;
    }

    reset() {
      this.prev = null;
      this.frameIndex = 0;
      this.lastTriggerAt = 0;
    }

    // ctx: a CanvasRenderingContext2D holding the current frame at tiny size.
    // Returns { triggered, score, quadrantScores, reason }.
    analyze(ctx) {
      const cfg = this.config;
      if (!cfg.enabled) return { triggered: false, score: 0, quadrantScores: [] };

      const { width: w, height: h } = ctx.canvas;
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const gray = toGray(rgba);

      if (!this.prev) {
        this.prev = gray;
        return { triggered: false, score: 0, quadrantScores: [], reason: "initial-frame" };
      }

      this.frameIndex++;
      if (this.frameIndex % (cfg.sampleEveryNFrames || 10) !== 0) {
        return { triggered: false, score: 0, quadrantScores: [] };
      }

      const edgeThr = cfg.thresholds["quadrant-edge-diff"];
      // Stage 1: cheap grayscale mean-diff gate. Skip expensive work on near-static frames.
      let meanDiff = 0;
      for (let i = 0; i < gray.length; i++) {
        meanDiff += Math.abs(gray[i] - this.prev[i]);
      }
      meanDiff /= gray.length || 1;
      if (meanDiff < (cfg.pixelGate || 2.5)) {
        this.prev = gray;
        return { triggered: false, score: meanDiff, quadrantScores: [] };
      }

      const histThr = cfg.thresholds["quadrant-histogram"];
      const quadrantScores = [];
      let edgesOver = 0;
      let histsOver = 0;
      let maxScore = 0;

      for (let q = 0; q < 4; q++) {
        const a = quadrantOf(this.prev, w, h, q);
        const b = quadrantOf(gray, w, h, q);
        const e = edgeScore(a.data, b.data, a.width, a.height);
        const s = histogramScore(a.data, b.data);
        quadrantScores.push({ edge: e, hist: s });
        if (e > edgeThr) edgesOver++;
        if (s > histThr) histsOver++;
        maxScore = Math.max(maxScore, e, s);
      }

      this.prev = gray;

      const minCount = cfg.quadrantMinCount || 2;
      const quadrantsOver = quadrantScores.filter(
        (q) => q.edge > edgeThr || q.hist > histThr
      ).length;
      const triggered = quadrantsOver >= minCount;

      const now = Date.now();
      const cooling = now - this.lastTriggerAt < (cfg.cooldownMs || 500);
      if (triggered && !cooling) {
        this.lastTriggerAt = now;
        return {
          triggered: true,
          score: maxScore,
          quadrantScores,
          reason: "scene-change"
        };
      }
      return { triggered: false, score: maxScore, quadrantScores };
    }
  }

  global.SceneDetect = { SceneDetector, DEFAULTS };
})(typeof self !== "undefined" ? self : window);
