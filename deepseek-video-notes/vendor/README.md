# vendor/

本地 Whisper 转写需要 Transformers.js 的 UMD 构建放在这里：

- 下载 `transformers.min.js`（Transformers.js v3 的浏览器包，例如
  从 `@xenova/transformers` 的 `dist/transformers.min.js` 或 jsDelivr 的
  等价文件）放到本目录：`vendor/transformers.min.js`。
- 模型权重在首次转写时从 HuggingFace 下载并缓存到浏览器（`whisper-tiny` 约 40MB），
  需要 `manifest.json` 里已声明的 HuggingFace 主机权限与网络。
- 换成更准的模型：在 offscreen 的配置里改 `whisperModel`，例如
  `Xenova/whisper-base`、`Xenova/whisper-small`。

没有这个文件时，扩展不会报错：转写被跳过，笔记退回到平台字幕（YouTube 等）。
