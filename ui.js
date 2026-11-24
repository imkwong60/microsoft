(() => {
  "use strict";

  const config = window.GDRIVE_CONFIG;
  const TOKEN_KEY = "gdrive.oauth.tokens";
  const AUTH_FLOW_KEY = "gdrive.oauth.flow";
  const QUEUE_DB = "gdrive-offline-queue";
  const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024; // Google simple upload recommended < 5MB
  const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;   // resumable chunk
  const UPLOAD_RETRY_LIMIT = 3;

  const state = {
    account: null,
    items: [],
    pending: [],
    folderId: null,
    folderName: "",
    filter: "all",
    view: "all",
    sortAscending: true,
    isLoading: false,
    isUploading: false,
    uploadingFromModal: false,
    previewItem: null,
    previewUrl: null,
    previewRequestId: 0
  };

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    fileGrid: $("#fileGrid"),
    emptyState: $("#emptyState"),
    loadingState: $("#loadingState"),
    fileSummary: $("#fileSummary"),
    fileCount: $("#fileCount"),
    overviewFiles: $("#overviewFiles"),
    overviewStorage: $("#overviewStorage"),
    overviewSync: $("#overviewSync"),
    overviewSyncCaption: $("#overviewSyncCaption"),
    syncStatus: $("#syncStatus"),
    allTabCount: $("#allTabCount"),
    searchInput: $("#searchInput"),
    pageTitle: $("#pageTitle"),
    pageDescription: $("#pageDescription"),
    breadcrumbCurrent: $("#breadcrumbCurrent"),
    uploadModal: $("#uploadModal"),
    filePicker: $("#filePicker"),
    selectedFiles: $("#selectedFiles"),
    confirmUploadButton: $("#confirmUploadButton"),
    dropzone: $("#dropzone"),
    uploadProgress: $("#uploadProgress"),
    uploadProgressName: $("#uploadProgressName"),
    uploadProgressPercent: $("#uploadProgressPercent"),
    uploadProgressBar: $("#uploadProgressBar"),
    uploadProgressDetail: $("#uploadProgressDetail"),
    imagePreviewModal: $("#imagePreviewModal"),
    previewImage: $("#previewImage"),
    previewSpinner: $("#previewSpinner"),
    previewCaption: $("#previewCaption"),
    toastRegion: $("#toastRegion")
  };

  let selectedFiles = [];
  let toastId = 0;
  let preparedAuthRequest = null;
  let authPreparationPending = false;
  let authPreparationError = null;

  // ─── Toast ───────────────────────────────────────────────
  function showToast(message, type = "success", duration = 2800) {
    const toast = document.createElement("div");
    const icon = document.createElement("span");
    const text = document.createElement("span");
    const close = document.createElement("button");
    const id = ++toastId;
    toast.className = "toast " + (type === "error" ? "error" : type === "info" ? "info" : "");
    toast.dataset.toastId = String(id);
    icon.className = "toast-icon";
    icon.innerHTML = type === "error"
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>'
      : type === "info"
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 11v5m0-8h.01"/><circle cx="12" cy="12" r="9"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
    text.className = "toast-message";
    text.textContent = message;
    close.className = "toast-close";
    close.type = "button";
    close.setAttribute("aria-label", "關閉提示");
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    close.addEventListener("click", () => dismissToast(toast));
    toast.append(icon, text, close);
    elements.toastRegion.append(toast);
    window.setTimeout(() => dismissToast(toast), duration);
  }

  function dismissToast(toast) {
    if (!toast.isConnected || toast.classList.contains("leaving")) return;
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 260);
  }

  // ─── IndexedDB offline queue ────────────────────────────
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(QUEUE_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("uploads")) {
          db.createObjectStore("uploads", { keyPath: "id", autoIncrement: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("無法開啟本機離線儲存空間"));
    });
  }

  async function queueTransaction(mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("uploads", mode);
      const store = transaction.objectStore("uploads");
      let request;
      try {
        request = operation(store);
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        resolve(request ? request.result : undefined);
        db.close();
      };
      transaction.onerror = () => {
        reject(transaction.error || new Error("本機離線佇列操作失敗"));
        db.close();
      };
      transaction.onabort = () => {
        reject(transaction.error || new Error("本機離線佇列操作已中止"));
        db.close();
      };
    });
  }

  function getQueuedUploads() {
    return queueTransaction("readonly", (store) => store.getAll());
  }

  function addQueuedUpload(file, folderId) {
    return queueTransaction("readwrite", (store) => store.add({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      folderId,
      blob: file,
      queuedAt: Date.now()
    }));
  }

  function removeQueuedUpload(id) {
    return queueTransaction("readwrite", (store) => store.delete(id));
  }

  // ─── Token storage ──────────────────────────────────────
  function getTokens() {
    try {
      const saved = localStorage.getItem(TOKEN_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch (error) {
      console.error("無法讀取登入狀態:", error);
      return {};
    }
  }

  function setTokens(tokens) {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  }

  function clearTokens() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function clearExpiredAuthFlow() {
    try {
      const authFlow = JSON.parse(localStorage.getItem(AUTH_FLOW_KEY) || "null");
      if (authFlow && Date.now() - Number(authFlow.createdAt) > 10 * 60 * 1000) {
        localStorage.removeItem(AUTH_FLOW_KEY);
      }
    } catch (error) {
      try { localStorage.removeItem(AUTH_FLOW_KEY); } catch (_) {}
    }
  }

  // ─── PKCE helpers ───────────────────────────────────────
  function randomString(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function base64UrlEncode(buffer) {
    let binary = "";
    new Uint8Array(buffer).forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function createCodeChallenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64UrlEncode(digest);
  }

  async function createAuthorizationRequest() {
    const verifier = randomString(48);
    const challenge = await createCodeChallenge(verifier);
    const oauthState = randomString(24);
    const authorizeUrl = new URL(config.authEndpoint);
    authorizeUrl.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: oauthState,
      access_type: "offline",   // 取得 refresh_token
      prompt: "consent",        // 第一次強制同意以拿到 refresh
      include_granted_scopes: "true"
    }).toString();
    return { verifier, state: oauthState, url: authorizeUrl.toString() };
  }

  function prepareAuthorizationRequest() {
    if (authPreparationPending || preparedAuthRequest) return;
    authPreparationPending = true;
    authPreparationError = null;
    createAuthorizationRequest()
      .then((request) => { preparedAuthRequest = request; })
      .catch((error) => {
        authPreparationError = error;
        console.error("Google 登入初始化失敗:", error);
      })
      .finally(() => { authPreparationPending = false; });
  }

  function signIn() {
    if (!navigator.onLine) {
      showToast("目前離線，連線後即可登入 Google 帳戶。", "info");
      return;
    }
    if (!preparedAuthRequest) {
      showToast(authPreparationError
        ? "登入準備失敗，請重新載入頁面後再試。"
        : "登入功能正在準備，請稍後再試。", authPreparationError ? "error" : "info");
      prepareAuthorizationRequest();
      return;
    }
    const request = preparedAuthRequest;
    try {
      localStorage.setItem(AUTH_FLOW_KEY, JSON.stringify({
        verifier: request.verifier,
        state: request.state,
        createdAt: Date.now()
      }));
      // 使用同一個視窗導向，避免 popup + postMessage 失敗導致主視窗不知道已登入
      preparedAuthRequest = null;
      window.location.href = request.url;
    } catch (error) {
      localStorage.removeItem(AUTH_FLOW_KEY);
      console.error("Google 登入初始化失敗:", error);
      showToast("無法開始 Google 登入，請稍後再試。", "error");
    }
  }

  async function exchangeAuthorizationCode() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const oauthError = params.get("error");
    if (!code && !oauthError) return false;

    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);

    let authFlow = null;
    try {
      authFlow = JSON.parse(localStorage.getItem(AUTH_FLOW_KEY) || "null");
    } catch (error) {
      console.error("無法讀取登入驗證狀態:", error);
    }
    const expectedState = authFlow && authFlow.state;
    const verifier = authFlow && authFlow.verifier;
    localStorage.removeItem(AUTH_FLOW_KEY);

    if (!expectedState || returnedState !== expectedState || !verifier) {
      throw new Error("登入驗證未通過，請重新登入。");
    }
    if (oauthError) {
      const description = params.get("error_description");
      throw new Error(description || "Google 登入已取消或失敗");
    }

    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: verifier
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error_description || payload.error || "無法完成 Google 登入");
    }
    setTokens({
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || "",
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000
    });
    return true;
  }

  async function refreshAccessToken() {
    const tokens = getTokens();
    if (!tokens.refreshToken) throw new Error("登入已逾期，請重新連結 Google 帳戶。");
    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      clearTokens();
      throw new Error(payload.error_description || payload.error || "登入已逾期，請重新連結 Google 帳戶。");
    }
    setTokens({
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000
    });
    return payload.access_token;
  }

  async function getAccessToken(forceRefresh = false) {
    const tokens = getTokens();
    if (!forceRefresh && tokens.accessToken && Number(tokens.expiresAt) > Date.now() + 60000) {
      return tokens.accessToken;
    }
    return refreshAccessToken();
  }

  // ─── Google Drive API helpers ───────────────────────────
  async function driveRequest(path, options = {}, retried = false) {
    const accessToken = await getAccessToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + accessToken);
    // Drive v3
    const url = path.startsWith("http") ? path : "https://www.googleapis.com/drive/v3/" + path;
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401 && !retried) {
      await getAccessToken(true);
      return driveRequest(path, options, true);
    }
    if (!response.ok) {
      let message = "Google Drive 請求失敗（" + response.status + "）";
      try {
        const errorPayload = await response.json();
        message = (errorPayload.error && errorPayload.error.message) || message;
      } catch (_) {}
      throw new Error(message);
    }
    return response;
  }

  function getCacheKey(folderId) {
    return "gdrive.snapshot." + (folderId || "root");
  }

  function cacheItems(items, folderId) {
    try {
      localStorage.setItem(getCacheKey(folderId), JSON.stringify({
        items,
        savedAt: Date.now()
      }));
    } catch (error) {
      console.warn("無法儲存檔案清單快取:", error);
    }
  }

  function readCachedItems(folderId) {
    try {
      const snapshot = JSON.parse(localStorage.getItem(getCacheKey(folderId)) || "null");
      return snapshot && Array.isArray(snapshot.items) ? snapshot.items : null;
    } catch (error) {
      return null;
    }
  }

  function showLoading(show) {
    state.isLoading = show;
    elements.loadingState.hidden = !show;
    elements.fileGrid.hidden = show;
    if (show) elements.emptyState.hidden = true;
    $("#refreshButton").classList.toggle("is-loading", show);
  }

  let loadSeq = 0;
  const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  async function loadFiles(options = {}) {
    if (!state.account) {
      renderFiles();
      return;
    }
    const seq = ++loadSeq;
    if (!navigator.onLine || options.cachedOnly) {
      const cached = readCachedItems(state.folderId);
      if (cached) {
        state.items = cached;
        renderFiles();
        if (!navigator.onLine) showToast("目前離線，顯示上次同步的檔案清單。", "info", 2500);
      } else {
        state.items = [];
        renderFiles();
        showToast("此資料夾尚無離線快取，請連線後重新整理。", "info");
      }
      return;
    }
    showLoading(true);
    try {
      // Build query: children of folder (or root) that are not trashed
      const parent = state.folderId || "root";
      const q = `'${parent}' in parents and trashed = false`;
      const fields = "files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink,thumbnailLink,parents)";
      const path = `files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=200&orderBy=folder,name`;
      let data;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await driveRequest(path);
          data = await response.json();
          break;
        } catch (err) {
          if (attempt >= 1) throw err;
          await delay(700); // 登入後第一次請求偶爾失敗，自動重試一次
        }
      }
      if (seq !== loadSeq) return; // 已有較新的載入請求，丟棄這次結果
      state.items = (Array.isArray(data.files) ? data.files : []).map((f) => ({
        id: f.id,
        name: f.name,
        size: Number(f.size) || 0,
        mimeType: f.mimeType,
        folder: f.mimeType === "application/vnd.google-apps.folder",
        file: f.mimeType !== "application/vnd.google-apps.folder",
        lastModifiedDateTime: f.modifiedTime,
        webUrl: f.webViewLink,
        thumbnailLink: f.thumbnailLink,
        iconLink: f.iconLink
      }));
      cacheItems(state.items, state.folderId);
      renderFiles();
    } catch (error) {
      if (seq !== loadSeq) return;
      console.error("讀取 Google Drive 檔案失敗:", error);
      const cached = readCachedItems(state.folderId);
      if (cached) {
        state.items = cached;
        renderFiles();
        showToast("同步失敗，已顯示上次同步的檔案。 " + error.message, "error", 4200);
      } else {
        state.items = [];
        renderFiles();
        showToast(error.message || "讀取 Google Drive 檔案失敗。", "error", 4000);
      }
    } finally {
      if (seq === loadSeq) {
        showLoading(false);
        renderFiles();
      }
    }
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return value + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return size.toFixed(size < 10 ? 1 : 0) + " " + units[unit];
  }

  function formatDate(dateString) {
    if (!dateString) return "Google Drive";
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "Google Drive";
    return new Intl.DateTimeFormat("zh-Hant", { month: "short", day: "numeric" }).format(date);
  }

  function iconFor(item) {
    if (item.folder) return { type: "folder", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h5l2 2h7A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/></svg>' };
    const ext = (item.name || "").split(".").pop().toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp", "svg", "heic"].includes(ext) || (item.mimeType || "").startsWith("image/")) {
      return { type: "image", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 17 5-5 3.5 3 2-2 5.5 5"/></svg>' };
    }
    if (ext === "pdf" || item.mimeType === "application/pdf") {
      return { type: "pdf", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 16h2a1.5 1.5 0 0 0 0-3H8v5m5-5v5h1.2a2.5 2.5 0 0 0 0-5z"/></svg>' };
    }
    if (["doc", "docx", "txt", "rtf", "odt"].includes(ext) || (item.mimeType || "").includes("document")) {
      return { type: "document", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 12h7m-7 3h7m-7 3h4"/></svg>' };
    }
    if (["xls", "xlsx", "csv", "ods"].includes(ext) || (item.mimeType || "").includes("spreadsheet")) {
      return { type: "spreadsheet", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 12h7m-7 3h7m-7 3h7M11 11.5v7"/></svg>' };
    }
    if (["ppt", "pptx", "odp"].includes(ext) || (item.mimeType || "").includes("presentation")) {
      return { type: "presentation", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 17v-5h2.5a1.5 1.5 0 0 1 0 3H8"/></svg>' };
    }
    if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) {
      return { type: "archive", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M11 9v2m0 2v2m0 2v2m-1-7h2m-2 4h2"/></svg>' };
    }
    return { type: "generic", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4"/></svg>' };
  }

  function isImageFile(item) {
    const mimeType = item.mimeType || "";
    const extension = (item.name || "").split(".").pop().toLowerCase();
    return mimeType.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "svg", "heic", "bmp", "tif", "tiff"].includes(extension);
  }

  function createFileCard(item, index, pending = false) {
    const card = document.createElement("article");
    const icon = iconFor(item);
    const iconWrap = document.createElement("span");
    const details = document.createElement("span");
    const name = document.createElement("span");
    const meta = document.createElement("span");
    card.className = "file-card" + (item.folder ? " folder-card" : "") + (pending ? " pending-card" : "") + (!pending && isImageFile(item) ? " image-card" : "");
    card.style.animationDelay = Math.min(index * 28, 240) + "ms";
    card.setAttribute("aria-label", item.name + (item.folder ? "，資料夾" : ""));
    if (!pending) {
      card.dataset.itemId = item.id;
      if (isImageFile(item)) card.title = "點擊預覽相片";
    }
    iconWrap.className = "file-icon " + icon.type;
    iconWrap.innerHTML = icon.svg;
    details.className = "file-details";
    name.className = "file-name";
    name.textContent = item.name;
    meta.className = "file-meta";
    meta.textContent = pending
      ? "等待上傳 · " + formatBytes(item.size)
      : (item.folder ? "資料夾" : (isImageFile(item) ? "點擊預覽 · " : "") + formatBytes(item.size)) + " · " + formatDate(item.lastModifiedDateTime);
    details.append(name, meta);
    card.append(iconWrap, details);

    if (pending) {
      const queueMark = document.createElement("span");
      queueMark.className = "file-action";
      queueMark.title = "等待網路連線";
      queueMark.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>';
      card.append(queueMark);
      return card;
    }
    if (!item.folder) {
      const download = document.createElement("button");
      download.className = "file-action";
      download.type = "button";
      download.setAttribute("aria-label", "下載 " + item.name);
      download.title = "下載";
      download.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 18v2h14v-2"/></svg>';
      download.addEventListener("click", (event) => {
        event.stopPropagation();
        downloadFile(item);
      });
      card.append(download);
    }
    card.addEventListener("click", () => {
      if (item.folder) {
        state.folderId = item.id;
        state.folderName = item.name;
        state.view = "all";
        state.filter = "all";
        document.querySelectorAll("[data-view]").forEach((button) => {
          button.classList.toggle("active", button.dataset.view === "all");
        });
        document.querySelectorAll(".pill-tab").forEach((button) => {
          const active = button.dataset.filter === "all";
          button.classList.toggle("active", active);
          button.setAttribute("aria-selected", String(active));
        });
        elements.breadcrumbCurrent.textContent = item.name;
        loadFiles();
      } else {
        if (isImageFile(item)) openImagePreview(item);
        else downloadFile(item);
      }
    });
    return card;
  }

  function updateViewHeading() {
    const isSubfolder = Boolean(state.folderId);
    const title = isSubfolder ? state.folderName : state.view === "folders" ? "資料夾" : state.view === "recent" ? "最近檔案" : "所有檔案";
    elements.pageTitle.textContent = title;
    const dot = document.createElement("span");
    dot.className = "title-period";
    dot.textContent = ".";
    elements.pageTitle.append(dot);
    elements.breadcrumbCurrent.textContent = title;
    elements.breadcrumbCurrent.title = isSubfolder ? "返回所有檔案" : "";
    elements.pageDescription.textContent = isSubfolder
      ? "瀏覽「" + state.folderName + "」中的檔案。"
      : state.view === "folders"
        ? "快速找到並整理你的雲端資料夾。"
        : state.view === "recent"
          ? "查看最近更新的 Google Drive 檔案。"
          : "整理、管理你的檔案，隨時隨地安心存取。";
  }

  function renderFiles() {
    updateViewHeading();
    const searchTerm = elements.searchInput.value.trim().toLocaleLowerCase();
    let files = state.items.slice();
    if (state.view === "folders" || state.filter === "folders") files = files.filter((item) => item.folder);
    if (state.filter === "files") files = files.filter((item) => item.file);
    if (state.view === "recent") {
      files.sort((a, b) => new Date(b.lastModifiedDateTime || 0) - new Date(a.lastModifiedDateTime || 0));
    } else {
      files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant") * (state.sortAscending ? 1 : -1));
    }
    if (searchTerm) files = files.filter((item) => item.name.toLocaleLowerCase().includes(searchTerm));

    elements.fileGrid.replaceChildren();
    const pendingHere = state.pending.filter((file) => (file.folderId || null) === (state.folderId || null));
    pendingHere.forEach((file, index) => elements.fileGrid.append(createFileCard(file, index, true)));
    files.forEach((item, index) => elements.fileGrid.append(createFileCard(item, pendingHere.length + index)));

    const totalCount = state.items.length + pendingHere.length;
    elements.fileCount.textContent = totalCount || "—";
    elements.allTabCount.textContent = totalCount || "—";
    elements.overviewFiles.textContent = totalCount || "—";
    const totalSize = state.items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    elements.overviewStorage.textContent = totalSize ? formatBytes(totalSize) : "—";

    if (state.account) {
      elements.overviewSync.textContent = navigator.onLine ? "已同步" : "離線";
      elements.overviewSyncCaption.textContent = navigator.onLine
        ? "檔案會安全儲存至 Google Drive"
        : "目前離線，顯示快取清單";
      elements.syncStatus.textContent = navigator.onLine ? "準備就緒" : "離線";
      elements.fileSummary.textContent = files.length
        ? `顯示 ${files.length} 個項目`
        : (searchTerm ? "找不到符合的檔案" : "此資料夾是空的");
    } else {
      elements.overviewSync.textContent = "未登入";
      elements.overviewSyncCaption.textContent = "連結 Google 帳戶後開始使用";
      elements.syncStatus.textContent = "尚未連線";
      elements.fileSummary.textContent = "連結帳戶以開始使用";
    }

    const showEmpty = !state.isLoading && files.length === 0 && pendingHere.length === 0;
    elements.emptyState.hidden = !showEmpty;
    elements.fileGrid.hidden = showEmpty || state.isLoading;
    if (showEmpty) {
      if (!state.account) {
        elements.emptyTitle.textContent = "雲端空間準備好了";
        elements.emptyDescription.textContent = "登入 Google 帳戶，開始瀏覽你的 Google Drive 檔案。";
        elements.emptyAction.textContent = "連結 Google 帳戶";
      } else {
        elements.emptyTitle.textContent = "此資料夾是空的";
        elements.emptyDescription.textContent = "上傳檔案或建立資料夾來開始整理。";
        elements.emptyAction.textContent = "上傳檔案";
      }
    }
  }

  async function downloadFile(item) {
    if (!navigator.onLine) {
      showToast("離線狀態無法下載，請先連線。", "info");
      return;
    }
    try {
      showToast("正在準備下載「" + item.name + "」…", "info", 2000);
      const response = await driveRequest(`files/${encodeURIComponent(item.id)}?alt=media`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast("「" + item.name + "」已開始下載。");
    } catch (error) {
      console.error("下載失敗:", error);
      showToast("下載失敗：" + error.message, "error");
    }
  }

  async function openImagePreview(item) {
    state.previewItem = item;
    state.previewRequestId += 1;
    const requestId = state.previewRequestId;
    elements.previewCaption.textContent = item.name;
    elements.previewImage.hidden = true;
    elements.previewSpinner.hidden = false;
    elements.imagePreviewModal.classList.add("open");
    elements.imagePreviewModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    try {
      // Prefer thumbnail if available (faster), otherwise full content
      let blob;
      if (item.thumbnailLink) {
        // thumbnailLink often needs auth header for private files
        const response = await driveRequest(item.thumbnailLink.replace(/=s\d+$/, "=s800"));
        blob = await response.blob();
      } else {
        const response = await driveRequest(`files/${encodeURIComponent(item.id)}?alt=media`);
        blob = await response.blob();
      }
      if (!blob.type.startsWith("image/")) {
        const response = await driveRequest(`files/${encodeURIComponent(item.id)}?alt=media`);
        blob = await response.blob();
      }
      if (!blob.type.startsWith("image/")) throw new Error("無法預覽此格式。");
      if (requestId !== state.previewRequestId) return;
      state.previewUrl = URL.createObjectURL(blob);
      elements.previewImage.alt = item.name;
      elements.previewImage.onload = () => { elements.previewSpinner.hidden = true; };
      elements.previewImage.onerror = () => {
        elements.previewSpinner.hidden = true;
        elements.previewCaption.textContent = "此圖片格式無法在目前的瀏覽器中預覽。";
      };
      elements.previewImage.src = state.previewUrl;
      elements.previewImage.hidden = false;
    } catch (error) {
      console.error("載入相片預覽失敗:", error);
      if (requestId === state.previewRequestId) {
        elements.previewSpinner.hidden = true;
        elements.previewCaption.textContent = error.message || "相片預覽載入失敗。";
        showToast("無法預覽「" + item.name + "」。", "error");
      }
    }
  }

  function closeImagePreview(clearItem = true) {
    state.previewRequestId += 1;
    elements.imagePreviewModal.classList.remove("open");
    elements.imagePreviewModal.setAttribute("aria-hidden", "true");
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
    }
    elements.previewImage.removeAttribute("src");
    elements.previewImage.hidden = true;
    elements.previewSpinner.hidden = false;
    if (clearItem) state.previewItem = null;
    if (!elements.uploadModal.classList.contains("open")) document.body.classList.remove("modal-open");
  }

  function updateUploadProgress(fileName, percent, detail) {
    if (!elements.uploadModal.classList.contains("open")) return;
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    elements.uploadProgress.hidden = false;
    elements.uploadProgressName.textContent = fileName;
    elements.uploadProgressPercent.textContent = value + "%";
    elements.uploadProgressBar.value = value;
    elements.uploadProgressDetail.textContent = detail;
  }

  function setUploadControlsDisabled(disabled) {
    elements.confirmUploadButton.disabled = disabled || selectedFiles.length === 0;
    $("#closeModalButton").disabled = disabled;
    $("#cancelUploadButton").disabled = disabled;
    elements.dropzone.disabled = disabled;
    elements.dropzone.setAttribute("aria-disabled", String(disabled));
  }

  // Resumable upload for larger files
  async function uploadLargeFile(file, folderId, onProgress) {
    // 1. Initiate resumable session
    const metadata = {
      name: file.name,
      parents: folderId ? [folderId] : undefined
    };
    const initResponse = await driveRequest("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.type || "application/octet-stream",
        "X-Upload-Content-Length": String(file.size)
      },
      body: JSON.stringify(metadata)
    });
    const uploadUrl = initResponse.headers.get("Location");
    if (!uploadUrl) throw new Error("Google Drive 沒有回傳分段上傳網址。");

    // 2. Upload chunks
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + UPLOAD_CHUNK_SIZE, file.size);
      let attempts = 0;
      while (true) {
        try {
          const chunk = file.slice(offset, end);
          const response = await fetch(uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Length": String(end - offset),
              "Content-Range": `bytes ${offset}-${end - 1}/${file.size}`
            },
            body: chunk
          });
          if (response.status === 308) {
            // Incomplete – continue
            const range = response.headers.get("Range");
            if (range) {
              const match = range.match(/bytes=0-(\d+)/);
              if (match) offset = Number(match[1]) + 1;
              else offset = end;
            } else {
              offset = end;
            }
            onProgress(offset);
            break;
          }
          if (response.ok) {
            onProgress(file.size);
            return response.json().catch(() => null);
          }
          let message = "Google Drive 分段上傳失敗（" + response.status + "）";
          try {
            const payload = await response.json();
            if (payload.error && payload.error.message) message = payload.error.message;
          } catch (_) {}
          throw new Error(message);
        } catch (error) {
          if (!navigator.onLine) throw new Error("網路中斷；目前檔案的分段上傳未完成，請連線後重新選取檔案再試。");
          attempts += 1;
          if (attempts > UPLOAD_RETRY_LIMIT) throw error;
          updateUploadProgress(file.name, (offset / file.size) * 100, "連線中斷，正在嘗試恢復第 " + attempts + " 次…");
          await new Promise((r) => setTimeout(r, attempts * 900));
        }
      }
    }
    return null;
  }

  async function uploadFile(file, folderId, onProgress) {
    if (file.size > SIMPLE_UPLOAD_LIMIT) {
      return uploadLargeFile(file, folderId, (uploadedBytes) => {
        onProgress((uploadedBytes / file.size) * 100, formatBytes(uploadedBytes) + " / " + formatBytes(file.size));
      });
    }
    // Simple multipart upload
    const metadata = {
      name: file.name,
      parents: folderId ? [folderId] : undefined
    };
    const boundary = "-------gdriveboundary" + Date.now();
    const delimiter = "\r\n--" + boundary + "\r\n";
    const closeDelimiter = "\r\n--" + boundary + "--";
    const metaPart = delimiter +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata);
    const mediaPart = delimiter +
      "Content-Type: " + (file.type || "application/octet-stream") + "\r\n\r\n";

    // Build body as Blob for efficiency
    const body = new Blob([
      metaPart,
      mediaPart,
      file,
      closeDelimiter
    ]);

    const response = await driveRequest(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      {
        method: "POST",
        headers: {
          "Content-Type": "multipart/related; boundary=" + boundary
        },
        body
      }
    );
    onProgress(100, formatBytes(file.size) + " / " + formatBytes(file.size));
    return response.json().catch(() => null);
  }

  async function uploadSelectedFiles(files) {
    if (state.isUploading) {
      showToast("另一個檔案仍在上傳，請完成後再開始。", "info");
      return;
    }
    state.isUploading = true;
    state.uploadingFromModal = true;
    setUploadControlsDisabled(true);
    let completed = 0;
    const failed = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        try {
          updateUploadProgress(file.name, 0, "正在建立安全的 Google Drive 上傳工作階段…");
          await uploadFile(file, state.folderId, (percent, detail) => {
            const totalPercent = ((index + percent / 100) / files.length) * 100;
            updateUploadProgress(file.name, totalPercent, detail);
          });
          completed += 1;
          selectedFiles = selectedFiles.filter((selected) => selected !== file);
          renderSelectedFiles();
          showToast("「" + file.name + "」已上傳至 Google Drive。");
        } catch (error) {
          console.error("上傳檔案失敗:", file.name, error);
          failed.push(file);
          showToast("「" + file.name + "」上傳失敗：" + error.message, "error", 5000);
        }
      }
      selectedFiles = failed;
      renderSelectedFiles();
      if (completed > 0) await loadFiles();
      if (failed.length === 0) {
        updateUploadProgress("上傳完成", 100, "所有檔案已安全儲存至 Google Drive。");
        window.setTimeout(() => {
          if (!state.uploadingFromModal) elements.uploadProgress.hidden = true;
        }, 1200);
        state.uploadingFromModal = false;
        closeUploadModal();
      } else {
        elements.uploadProgress.hidden = true;
      }
    } finally {
      state.isUploading = false;
      state.uploadingFromModal = false;
      setUploadControlsDisabled(false);
      renderSelectedFiles();
    }
  }

  async function uploadQueuedItems() {
    if (state.isUploading || !navigator.onLine || !state.account) return;
    state.isUploading = true;
    try {
      const queued = await getQueuedUploads();
      state.pending = queued;
      renderFiles();
      for (const upload of queued) {
        try {
          const queuedBlob = upload.blob;
          const queuedFile = queuedBlob.name
            ? queuedBlob
            : new File([queuedBlob], upload.name, {
              type: upload.type || "application/octet-stream",
              lastModified: upload.lastModified || upload.queuedAt
            });
          await uploadFile(queuedFile, upload.folderId, (percent, detail) => {
            elements.overviewSync.textContent = "上傳 " + Math.round(percent) + "%";
            elements.overviewSyncCaption.textContent = detail;
          });
          await removeQueuedUpload(upload.id);
          state.pending = state.pending.filter((file) => file.id !== upload.id);
          showToast("「" + upload.name + "」已上傳至 Google Drive。");
          renderFiles();
        } catch (error) {
          console.error("上傳檔案失敗:", upload.name, error);
          showToast("「" + upload.name + "」上傳失敗：" + error.message, "error", 4500);
          if (error.message.includes("逾期") || error.message.includes("重新連結")) break;
        }
      }
      if (state.pending.length < queued.length) await loadFiles();
    } catch (error) {
      console.error("讀取離線上傳佇列失敗:", error);
      showToast("無法讀取本機上傳佇列：" + error.message, "error", 4000);
    } finally {
      state.isUploading = false;
      renderFiles();
    }
  }

  async function addFilesToQueue(files) {
    if (!files.length) return;
    const hasLargeFile = files.some((file) => file.size > SIMPLE_UPLOAD_LIMIT);
    if (hasLargeFile && (!state.account || !navigator.onLine)) {
      showToast("大檔案需先登入 Google 帳戶並保持網路連線，才能分段上傳。", "error", 4500);
      return;
    }
    if (state.account && navigator.onLine) {
      await uploadSelectedFiles(files);
      return;
    }
    try {
      let addedCount = 0;
      for (const file of files) {
        await addQueuedUpload(file, state.folderId);
        addedCount += 1;
      }
      if (addedCount === 0) return;
      state.pending = await getQueuedUploads();
      renderFiles();
      closeUploadModal();
      if (navigator.onLine && state.account) {
        showToast("檔案已加入安全上傳佇列。", "info", 2200);
        await uploadQueuedItems();
      } else if (!state.account) {
        showToast("檔案已保存在此裝置；登入後即可同步至 Google Drive。", "info", 3500);
      } else {
        showToast("目前離線，檔案已安全排入佇列，連線後會自動上傳。", "info", 3500);
      }
    } catch (error) {
      console.error("加入本機上傳佇列失敗:", error);
      showToast("無法將檔案儲存在此裝置：" + error.message, "error", 4200);
    }
  }

  function openUploadModal() {
    selectedFiles = [];
    elements.filePicker.value = "";
    elements.uploadProgress.hidden = true;
    renderSelectedFiles();
    setUploadControlsDisabled(false);
    elements.uploadModal.classList.add("open");
    elements.uploadModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    window.setTimeout(() => $("#closeModalButton").focus(), 80);
  }

  function closeUploadModal() {
    if (state.uploadingFromModal) return;
    elements.uploadModal.classList.remove("open");
    elements.uploadModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function renderSelectedFiles() {
    elements.selectedFiles.replaceChildren();
    elements.selectedFiles.hidden = selectedFiles.length === 0;
    elements.confirmUploadButton.disabled = state.uploadingFromModal || selectedFiles.length === 0;
    selectedFiles.forEach((file) => {
      const row = document.createElement("div");
      const fileName = document.createElement("span");
      const fileSize = document.createElement("span");
      row.className = "selected-file";
      fileName.textContent = file.name;
      fileSize.textContent = formatBytes(file.size);
      row.append(fileName, fileSize);
      elements.selectedFiles.append(row);
    });
  }

  function updateConnection() {
    const online = navigator.onLine;
    $("#connectionDot").parentElement.classList.toggle("offline", !online);
    $("#connectionText").textContent = online ? "網路連線正常" : "離線模式";
    $("#onlineDot").parentElement.classList.toggle("offline", !online);
    $("#onlineLabel").textContent = online ? "線上" : "離線";
  }

  const PROFILE_KEY = "gdrive.profile";

  function readProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null"); } catch (_) { return null; }
  }

  function applyProfile(profile) {
    const displayName = profile.displayName || profile.email || "Google 帳戶";
    state.account = { displayName, email: profile.email || "", picture: profile.picture || "" };
    const initial = displayName.trim().charAt(0).toUpperCase() || "G";
    $("#accountName").textContent = displayName;
    $("#accountEmail").textContent = profile.email || "已登入 Google Drive";
    $("#accountAvatar").textContent = initial;
    $("#chipAvatar").textContent = initial;
    $("#chipStatus").textContent = "已登入";
    $("#chipEmail").textContent = profile.email || displayName;
    $("#accountChip").classList.add("signed-in");
    $("#accountChip").title = "已登入：" + (profile.email || displayName);
  }

  function clearProfileUI() {
    $("#accountName").textContent = "尚未登入";
    $("#accountEmail").textContent = "連結 Google 帳戶";
    $("#accountAvatar").textContent = "?";
    $("#chipAvatar").textContent = "?";
    $("#chipStatus").textContent = "尚未登入";
    $("#chipEmail").textContent = "—";
    $("#accountChip").classList.remove("signed-in");
    $("#accountChip").title = "尚未登入";
  }

  async function fetchProfile() {
    try {
      const response = await driveRequest("https://www.googleapis.com/oauth2/v3/userinfo");
      const profile = await response.json();
      const saved = { displayName: profile.name || profile.email, email: profile.email, picture: profile.picture };
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify(saved)); } catch (_) {}
      if (state.account) applyProfile(saved);
    } catch (error) {
      console.warn("無法載入 Google 帳戶資料:", error);
    }
  }

  async function showAccount(account) {
    // 先用快取的帳戶資料立即顯示登入狀態與 email
    applyProfile(readProfile() || account);
    renderFiles();
    // 帳戶資料與檔案清單同時載入，不再讓檔案等待帳戶資料
    const profileTask = fetchProfile();
    await loadFiles();
    await profileTask;
    await uploadQueuedItems();
  }

  async function completeExternalSignIn() {
    if (state.account) return;
    const tokens = getTokens();
    if (!tokens.accessToken && !tokens.refreshToken) return;
    showToast("Google 帳戶已成功連結。");
    await showAccount({ displayName: "Google 帳戶" });
  }

  function confirmSignOut() {
    if ($("#signOutModal")) return;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop open";
    backdrop.id = "signOutModal";
    backdrop.setAttribute("aria-hidden", "false");
    backdrop.innerHTML = '<section class="modal glass signout-modal" role="dialog" aria-modal="true" aria-labelledby="signOutTitle">' +
      '<h2 id="signOutTitle">要登出 Google 帳戶嗎？</h2>' +
      '<p class="modal-description" id="signOutDesc"></p>' +
      '<div class="modal-actions"><button class="button button-quiet" type="button" data-act="cancel">保持登入</button>' +
      '<button class="button button-danger" type="button" data-act="ok">登出</button></div></section>';
    backdrop.querySelector("#signOutDesc").textContent =
      "目前登入：" + ((state.account && (state.account.email || state.account.displayName)) || "Google 帳戶") +
      "。登出後需要重新登入才能存取檔案。";
    const close = () => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      if (!$(".modal-backdrop.open")) document.body.classList.remove("modal-open");
    };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) { close(); return; }
      const act = event.target.closest("[data-act]");
      if (!act) return;
      if (act.dataset.act === "ok") signOut();
      close();
    });
    document.addEventListener("keydown", onKey, true);
    document.body.classList.add("modal-open");
    document.body.append(backdrop);
    backdrop.querySelector('[data-act="cancel"]').focus();
  }

  async function signOut() {
    clearTokens();
    try { localStorage.removeItem(PROFILE_KEY); } catch (_) {}
    state.account = null;
    state.items = [];
    state.folderId = null;
    state.folderName = "";
    clearProfileUI();
    renderFiles();
    showToast("已從此裝置登出 Google 帳戶。", "info");
  }

  function setView(view) {
    state.view = view;
    state.filter = view === "folders" ? "folders" : "all";
    state.folderId = null;
    state.folderName = "";
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === view);
    });
    document.querySelectorAll(".pill-tab").forEach((button) => {
      const active = button.dataset.filter === state.filter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    loadFiles();
  }

  function bindEvents() {
    window.addEventListener("storage", (event) => {
      if (event.key === TOKEN_KEY && event.newValue) completeExternalSignIn();
    });
    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin || !event.data || event.data.source !== "gdrive-pwa-auth") return;
      if (event.data.error) {
        showToast(event.data.error, "error", 4500);
        return;
      }
      const receivedTokens = event.data.tokens;
      if (receivedTokens && receivedTokens.accessToken) {
        try {
          setTokens(receivedTokens);
        } catch (error) {
          showToast("登入已完成，但無法儲存帳戶狀態。", "error", 5000);
          return;
        }
      }
      completeExternalSignIn();
    });
    $("#accountButton").addEventListener("click", () => state.account ? confirmSignOut() : signIn());
    $("#mobileAccountButton").addEventListener("click", () => {
      document.body.classList.remove("sidebar-open");
      state.account ? confirmSignOut() : signIn();
    });
    $("#accountChip").addEventListener("click", () => state.account ? confirmSignOut() : signIn());
    $("#emptyAction").addEventListener("click", () => state.account ? openUploadModal() : signIn());
    $("#topUploadButton").addEventListener("click", openUploadModal);
    $("#mobileUploadButton").addEventListener("click", openUploadModal);
    $("#refreshButton").addEventListener("click", () => loadFiles());
    $("#menuButton").addEventListener("click", () => document.body.classList.add("sidebar-open"));
    $("#sidebarBackdrop").addEventListener("click", () => document.body.classList.remove("sidebar-open"));
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        setView(button.dataset.view);
        document.body.classList.remove("sidebar-open");
      });
    });
    document.querySelectorAll(".pill-tab").forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        if (state.filter !== "folders") state.view = "all";
        document.querySelectorAll(".pill-tab").forEach((tab) => {
          const active = tab === button;
          tab.classList.toggle("active", active);
          tab.setAttribute("aria-selected", String(active));
        });
        renderFiles();
      });
    });
    $("#sortButton").addEventListener("click", () => {
      state.sortAscending = !state.sortAscending;
      $("#sortButton span").textContent = state.sortAscending ? "名稱排序" : "名稱反向";
      renderFiles();
    });
    elements.searchInput.addEventListener("input", renderFiles);
    elements.breadcrumbCurrent.addEventListener("click", () => {
      if (!state.folderId) return;
      state.folderId = null;
      state.folderName = "";
      loadFiles();
    });
    elements.breadcrumbCurrent.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && state.folderId) {
        state.folderId = null;
        state.folderName = "";
        loadFiles();
      }
    });
    $("#dropzone").addEventListener("click", () => elements.filePicker.click());
    elements.filePicker.addEventListener("change", () => {
      selectedFiles = Array.from(elements.filePicker.files || []);
      renderSelectedFiles();
    });
    elements.confirmUploadButton.addEventListener("click", () => addFilesToQueue(selectedFiles.slice()));
    $("#closeModalButton").addEventListener("click", closeUploadModal);
    $("#cancelUploadButton").addEventListener("click", closeUploadModal);
    elements.uploadModal.addEventListener("click", (event) => {
      if (event.target === elements.uploadModal) closeUploadModal();
    });
    $("#closePreviewButton").addEventListener("click", () => closeImagePreview());
    $("#previewDownloadButton").addEventListener("click", () => {
      if (state.previewItem) downloadFile(state.previewItem);
    });
    elements.imagePreviewModal.addEventListener("click", (event) => {
      if (event.target === elements.imagePreviewModal) closeImagePreview();
    });
    elements.dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      elements.dropzone.classList.add("drag-over");
    });
    elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("drag-over"));
    elements.dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      elements.dropzone.classList.remove("drag-over");
      selectedFiles = Array.from(event.dataTransfer.files || []);
      renderSelectedFiles();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeUploadModal();
        closeImagePreview();
        document.body.classList.remove("sidebar-open");
      }
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
        event.preventDefault();
        elements.searchInput.focus();
      }
    });
    window.addEventListener("online", () => {
      updateConnection();
      showToast("網路已恢復，正在同步待上傳檔案。", "info");
      loadFiles();
      uploadQueuedItems();
    });
    window.addEventListener("offline", () => {
      updateConnection();
      showToast("已切換至離線模式，已快取的檔案清單仍可瀏覽。", "info");
      loadFiles({ cachedOnly: true });
    });
    // 視窗重新取得焦點時，檢查是否已有 token（防止登入後狀態沒更新）
    window.addEventListener("focus", () => {
      if (!state.account) {
        const tokens = getTokens();
        if (tokens.accessToken || tokens.refreshToken) {
          completeExternalSignIn();
        }
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !state.account) {
        const tokens = getTokens();
        if (tokens.accessToken || tokens.refreshToken) {
          completeExternalSignIn();
        }
      }
    });
  }

  async function initialize() {
    bindEvents();
    updateConnection();
    clearExpiredAuthFlow();
    const sharedFiles = new URLSearchParams(window.location.search).get("shared") === "1";
    if (sharedFiles) window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);

    const callbackParams = new URLSearchParams(window.location.search);
    const hasOAuthCallback = callbackParams.has("code") || callbackParams.has("error");
    let completedLogin = false;
    let callbackError = null;
    if (hasOAuthCallback) {
      try {
        completedLogin = await exchangeAuthorizationCode();
      } catch (error) {
        callbackError = error;
        console.error("Google OAuth 登入失敗:", error);
      }
      // 如果是從舊的 popup 流程回來，通知 opener 後關閉
      if (window.opener && window.opener !== window) {
        try {
          window.opener.postMessage({
            source: "gdrive-pwa-auth",
            error: callbackError ? callbackError.message : null,
            tokens: callbackError ? null : getTokens()
          }, window.location.origin);
        } catch (error) {
          console.warn("無法通知原本的 App 登入結果:", error);
        }
        window.close();
        return;
      }
      // 同一個視窗導向回來（新流程）
      if (callbackError) {
        showToast(callbackError.message || "Google 登入失敗。", "error", 4500);
      }
      // completedLogin 成功時，後面會自動呼叫 showAccount
    }

    try {
      state.pending = await getQueuedUploads();
    } catch (error) {
      console.error("無法載入待上傳檔案:", error);
    }

    const tokens = getTokens();
    if (sharedFiles) {
      showToast(tokens.accessToken || tokens.refreshToken
        ? "已收到分享檔案，正在準備上傳至 Google Drive。"
        : "已收到分享檔案；登入後會上傳至 Google Drive。", "info", 3500);
    }
    if (tokens.accessToken || tokens.refreshToken) {
      await showAccount({ displayName: "Google 帳戶" });
      if (completedLogin) showToast("Google 帳戶已成功連結。");
    } else {
      renderFiles();
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.error("Service Worker 註冊失敗:", error);
        showToast("離線快取無法啟用：" + error.message, "error", 4000);
      });
    }
  }

  prepareAuthorizationRequest();
  initialize();
})();
