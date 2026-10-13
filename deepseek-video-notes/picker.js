import { pickVault } from "./lib/obsidian.js";

const status = document.getElementById("status");

document.getElementById("pick").addEventListener("click", async () => {
  try {
    const handle = await pickVault();
    status.textContent = "已选择：" + handle.name + "，正在关闭…";
    chrome.runtime.sendMessage({ type: "vault:changed", name: handle.name });
    setTimeout(() => window.close(), 700);
  } catch (e) {
    status.textContent = "取消或失败：" + String((e && e.message) || e);
  }
});
