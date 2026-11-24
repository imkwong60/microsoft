const CACHE_NAME = "gdrive-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./authConfig.js",
  "./ui.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("gdrive-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.method === "POST" && url.searchParams.has("shared")) {
    event.respondWith(storeSharedFiles(request));
    return;
  }
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(async () => {
          const cachedPage = await caches.match(request);
          return cachedPage || caches.match("./index.html");
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

async function storeSharedFiles(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("files").filter((entry) => entry instanceof File && entry.size > 0);
    if (!files.length) {
      return new Response("No shared files were received.", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    const db = await openUploadDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("uploads", "readwrite");
        const store = transaction.objectStore("uploads");
        files.forEach((file) => store.add({
          name: file.name || formData.get("title") || "shared-file",
          size: file.size,
          type: file.type || "application/octet-stream",
          lastModified: file.lastModified || Date.now(),
          folderId: null,
          blob: file,
          queuedAt: Date.now(),
          sharedFrom: "share-target"
        }));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Unable to save shared files"));
        transaction.onabort = () => reject(transaction.error || new Error("Saving shared files was aborted"));
      });
    } finally {
      db.close();
    }
    const destination = new URL("./?shared=1", self.registration.scope);
    return Response.redirect(destination.toString(), 303);
  } catch (error) {
    console.error("Unable to receive shared files:", error);
    return new Response("Unable to save shared files. Open the app and choose the files directly.", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

function openUploadDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("gdrive-offline-queue", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("uploads")) {
        request.result.createObjectStore("uploads", { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open upload queue"));
  });
}
