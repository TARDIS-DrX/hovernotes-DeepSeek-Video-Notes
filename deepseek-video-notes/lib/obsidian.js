// Obsidian writer using the File System Access API.
// Stores the picked vault handle in IndexedDB so it survives page reloads.

const DB_NAME = "DeepSeekVideoNotes";
const STORE = "handles";
const VAULT_KEY = "obsidian-vault";
export const IMAGES_FOLDER = "hover-notes-images";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Query-only: safe to call anywhere (no user gesture needed).
export async function hasWritePermission(handle) {
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  } catch (e) {
    return false;
  }
}

// The panel runs in a cross-origin iframe, where File System Access cannot prompt
// for permission at all. So we only CHECK here; the grant is done by the picker
// window (a top-level extension page) via showDirectoryPicker.
export async function ensureWritePermission(handle) {
  return hasWritePermission(handle);
}

export async function pickVault() {
  const handle = await window.showDirectoryPicker({ id: VAULT_KEY, mode: "readwrite" });
  await idbSet(VAULT_KEY, handle);
  return handle;
}

// Open the top-level picker window. Needed because showDirectoryPicker is not
// allowed inside a cross-origin subframe (the in-page panel iframe).
export function openVaultPicker() {
  return new Promise((resolve) => {
    chrome.windows.create(
      { url: chrome.runtime.getURL("picker.html"), type: "popup", width: 460, height: 340 },
      () => resolve()
    );
  });
}

// Returns the stored handle WITHOUT requesting permission (no gesture here).
export async function getStoredVault() {
  return (await idbGet(VAULT_KEY)) || null;
}

async function writeFile(dirHandle, name, contents) {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(contents);
  await writable.close();
}

function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((r) => r.blob());
}

// Key frames are captured as webp for speed; the vault expects .png files,
// so re-encode anything that is not already PNG.
async function imageAsPngBlob(dataUrl) {
  if (dataUrl.startsWith("data:image/png")) return dataUrlToBlob(dataUrl);
  const blob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export async function ensureImagesFolder(vaultHandle) {
  return vaultHandle.getDirectoryHandle(IMAGES_FOLDER, { create: true });
}

// screenshots: [{ name, dataUrl }]
export async function saveNote({ vaultHandle, folder, filename, content, screenshots }) {
  const targetDir = folder
    ? await vaultHandle.getDirectoryHandle(folder, { create: true })
    : vaultHandle;

  await writeFile(targetDir, filename, content);

  if (screenshots && screenshots.length) {
    const imagesDir = await ensureImagesFolder(vaultHandle);
    for (const shot of screenshots) {
      const blob = await imageAsPngBlob(shot.dataUrl);
      const fileHandle = await imagesDir.getFileHandle(shot.name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    }
  }

  return { path: folder ? `${folder}/${filename}` : filename };
}
