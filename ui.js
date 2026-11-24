(() => {
  "use strict";

  const config = window.ONEDRIVE_CONFIG;
  const TOKEN_KEY = "onedrive.oauth.tokens";
  const QUEUE_DB = "onedrive-offline-queue";
  const MAX_SIMPLE_UPLOAD = 250 * 1024 * 1024;
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
    isUploading: false
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
    toastRegion: $("#toastRegion")
  };
  let selectedFiles = [];
  let toastId = 0;

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

  function getTokens() {
    try {
      return JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "{}");
    } catch (error) {
      console.error("無法讀取登入狀態:", error);
      return {};
    }
  }

  function setTokens(tokens) {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  }

  function clearTokens() {
    sessionStorage.removeItem(TOKEN_KEY);
  }

  function randomString(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

  async function signIn() {
    if (!navigator.onLine) {
      showToast("目前離線，連線後即可登入 Microsoft 帳戶。", "info");
      return;
    }
    try {
      const verifier = randomString(48);
      const challenge = await createCodeChallenge(verifier);
      const oauthState = randomString(24);
      sessionStorage.setItem("onedrive.oauth.verifier", verifier);
      sessionStorage.setItem("onedrive.oauth.state", oauthState);
      const authorizeUrl = new URL(config.authority + "/oauth2/v2.0/authorize");
      authorizeUrl.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: config.redirectUri,
        response_mode: "query",
        scope: config.scopes.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: oauthState
      }).toString();
      window.location.assign(authorizeUrl.toString());
    } catch (error) {
      console.error("Microsoft 登入初始化失敗:", error);
      showToast("無法開始 Microsoft 登入，請稍後再試。", "error");
    }
  }

  async function exchangeAuthorizationCode() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const oauthError = params.get("error");
    if (!code && !oauthError) return false;
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    if (oauthError) {
      const description = params.get("error_description");
      throw new Error(description || "Microsoft 登入已取消或失敗");
    }
    const expectedState = sessionStorage.getItem("onedrive.oauth.state");
    const verifier = sessionStorage.getItem("onedrive.oauth.verifier");
    sessionStorage.removeItem("onedrive.oauth.state");
    sessionStorage.removeItem("onedrive.oauth.verifier");
    if (!expectedState || returnedState !== expectedState || !verifier) {
      throw new Error("登入驗證未通過，請重新登入。");
    }
    const response = await fetch(config.authority + "/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: verifier,
        scope: config.scopes.join(" ")
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error_description || "無法完成 Microsoft 登入");
    setTokens({
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || "",
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000
    });
    return true;
  }

  async function refreshAccessToken() {
    const tokens = getTokens();
    if (!tokens.refreshToken) throw new Error("登入已逾期，請重新連結 Microsoft 帳戶。");
    const response = await fetch(config.authority + "/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        redirect_uri: config.redirectUri,
        scope: config.scopes.join(" ")
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      clearTokens();
      throw new Error(payload.error_description || "登入已逾期，請重新連結 Microsoft 帳戶。");
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

  async function graphRequest(path, options = {}, retried = false) {
    const accessToken = await getAccessToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + accessToken);
    const response = await fetch("https://graph.microsoft.com/v1.0/" + path, { ...options, headers });
    if (response.status === 401 && !retried) {
      await getAccessToken(true);
      return graphRequest(path, options, true);
    }
    if (!response.ok) {
      let message = "OneDrive 請求失敗（" + response.status + "）";
      try {
        const errorPayload = await response.json();
        message = errorPayload.error && errorPayload.error.message ? errorPayload.error.message : message;
      } catch (error) {
        console.warn("無法解析 OneDrive 錯誤回應:", error);
      }
      throw new Error(message);
    }
    return response;
  }

  function getCacheKey(folderId) {
    return "onedrive.snapshot." + (folderId || "root");
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
      console.error("無法讀取檔案清單快取:", error);
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

  async function loadFiles(options = {}) {
    if (!state.account) {
      renderFiles();
      return;
    }
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
      const path = state.folderId
        ? "me/drive/items/" + encodeURIComponent(state.folderId) + "/children?$select=id,name,size,file,folder,lastModifiedDateTime,webUrl"
        : "me/drive/root/children?$select=id,name,size,file,folder,lastModifiedDateTime,webUrl";
      const response = await graphRequest(path);
      const data = await response.json();
      state.items = Array.isArray(data.value) ? data.value : [];
      cacheItems(state.items, state.folderId);
      renderFiles();
    } catch (error) {
      console.error("讀取 OneDrive 檔案失敗:", error);
      const cached = readCachedItems(state.folderId);
      if (cached) {
        state.items = cached;
        renderFiles();
        showToast("同步失敗，已顯示上次同步的檔案。 " + error.message, "error", 4200);
      } else {
        state.items = [];
        renderFiles();
        showToast(error.message || "讀取 OneDrive 檔案失敗。", "error", 4000);
      }
    } finally {
      showLoading(false);
      renderFiles();
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
    if (!dateString) return "OneDrive";
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "OneDrive";
    return new Intl.DateTimeFormat("zh-Hant", { month: "short", day: "numeric" }).format(date);
  }

  function iconFor(item) {
    if (item.folder) return { type: "folder", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h5l2 2h7A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z"/></svg>' };
    const ext = (item.name || "").split(".").pop().toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp", "svg", "heic"].includes(ext)) return { type: "image", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 17 5-5 3.5 3 2-2 5.5 5"/></svg>' };
    if (ext === "pdf") return { type: "pdf", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 16h2a1.5 1.5 0 0 0 0-3H8v5m5-5v5h1.2a2.5 2.5 0 0 0 0-5z"/></svg>' };
    if (["doc", "docx", "txt", "rtf", "odt"].includes(ext)) return { type: "document", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 12h7m-7 3h7m-7 3h4"/></svg>' };
    if (["xls", "xlsx", "csv", "ods"].includes(ext)) return { type: "spreadsheet", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 12h7m-7 3h7m-7 3h7M11 11.5v7"/></svg>' };
    if (["ppt", "pptx", "odp"].includes(ext)) return { type: "presentation", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M8 17v-5h2.5a1.5 1.5 0 0 1 0 3H8"/></svg>' };
    if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return { type: "archive", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4M11 9v2m0 2v2m0 2v2m-1-7h2m-2 4h2"/></svg>' };
    return { type: "generic", svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 4v4h4"/></svg>' };
  }

  function createFileCard(item, index, pending = false) {
    const card = document.createElement("article");
    const icon = iconFor(item);
    const iconWrap = document.createElement("span");
    const details = document.createElement("span");
    const name = document.createElement("span");
    const meta = document.createElement("span");
    card.className = "file-card" + (item.folder ? " folder-card" : "") + (pending ? " pending-card" : "");
    card.style.animationDelay = Math.min(index * 28, 240) + "ms";
    card.setAttribute("aria-label", item.name + (item.folder ? "，資料夾" : ""));
    if (!pending) card.dataset.itemId = item.id;
    iconWrap.className = "file-icon " + icon.type;
    iconWrap.innerHTML = icon.svg;
    details.className = "file-details";
    name.className = "file-name";
    name.textContent = item.name;
    meta.className = "file-meta";
    meta.textContent = pending
      ? "等待上傳 · " + formatBytes(item.size)
      : (item.folder ? "資料夾" : formatBytes(item.size)) + " · " + formatDate(item.lastModifiedDateTime);
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
        downloadFile(item);
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
          ? "查看最近更新的 OneDrive 檔案。"
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
    const pendingHere = state.pending.filter((file) => file.folderId === state.folderId);
    pendingHere.forEach((file, index) => elements.fileGrid.append(createFileCard(file, index, true)));
    files.forEach((item, index) => elements.fileGrid.append(createFileCard(item, index + pendingHere.length)));
    elements.emptyState.hidden = files.length > 0 || pendingHere.length > 0 || state.isLoading;
    elements.fileGrid.hidden = state.isLoading;
    elements.fileSummary.textContent = state.account
      ? (files.length + pendingHere.length) + " 個項目" + (pendingHere.length ? " · " + pendingHere.length + " 項待上傳" : "")
      : "連結帳戶以開始使用";
    elements.fileCount.textContent = String(state.items.length);
    elements.allTabCount.textContent = String(state.items.length);
    elements.overviewFiles.textContent = String(state.items.length + pendingHere.length);
    const total = state.items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    elements.overviewStorage.textContent = formatBytes(total);
    elements.overviewSync.textContent = pendingHere.length ? "待同步 " + pendingHere.length : "已同步";
    elements.overviewSyncCaption.textContent = pendingHere.length
      ? "檔案會在連線後自動上傳"
      : "檔案會安全儲存至 OneDrive";
    elements.syncStatus.textContent = pendingHere.length ? "等待同步" : "準備就緒";
    if (!state.account) {
      $("#emptyTitle").textContent = "雲端空間準備好了";
      $("#emptyDescription").textContent = "登入 Microsoft 帳戶，開始瀏覽你的 OneDrive 檔案。";
      $("#emptyAction").textContent = "連結 Microsoft 帳戶";
    } else if (pendingHere.length === 0 && files.length === 0 && searchTerm) {
      $("#emptyTitle").textContent = "找不到符合的檔案";
      $("#emptyDescription").textContent = "試試其他關鍵字，或清除搜尋內容。";
      $("#emptyAction").hidden = true;
    } else if (pendingHere.length === 0 && files.length === 0) {
      $("#emptyTitle").textContent = "這裡還沒有檔案";
      $("#emptyDescription").textContent = "上傳第一個檔案，或切換到其他資料夾。";
      $("#emptyAction").textContent = "上傳檔案";
      $("#emptyAction").hidden = false;
    } else {
      $("#emptyAction").hidden = false;
    }
  }

  async function downloadFile(item) {
    if (!navigator.onLine) {
      showToast("下載檔案需要網路連線。", "info");
      return;
    }
    try {
      const response = await graphRequest("me/drive/items/" + encodeURIComponent(item.id) + "/content");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = item.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      showToast("已開始下載「" + item.name + "」。");
    } catch (error) {
      console.error("下載 OneDrive 檔案失敗:", error);
      showToast(error.message || "下載檔案失敗。", "error", 4000);
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
        if (upload.size > MAX_SIMPLE_UPLOAD) {
          showToast("「" + upload.name + "」超過單次上傳上限 250 MB，請縮小檔案後重試。", "error", 4500);
          continue;
        }
        try {
          const encodedName = encodeURIComponent(upload.name);
          const path = upload.folderId
            ? "me/drive/items/" + encodeURIComponent(upload.folderId) + ":/" + encodedName + ":/content"
            : "me/drive/root:/" + encodedName + ":/content";
          await graphRequest(path, {
            method: "PUT",
            headers: { "Content-Type": upload.type || "application/octet-stream" },
            body: upload.blob
          });
          await removeQueuedUpload(upload.id);
          state.pending = state.pending.filter((file) => file.id !== upload.id);
          showToast("「" + upload.name + "」已上傳至 OneDrive。");
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
    try {
      let addedCount = 0;
      for (const file of files) {
        if (file.size > MAX_SIMPLE_UPLOAD) {
          showToast("「" + file.name + "」超過目前支援的 250 MB 上傳上限。", "error", 4000);
          continue;
        }
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
        showToast("檔案已保存在此裝置；登入後即可同步至 OneDrive。", "info", 3500);
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
    renderSelectedFiles();
    elements.uploadModal.classList.add("open");
    elements.uploadModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    window.setTimeout(() => $("#closeModalButton").focus(), 80);
  }

  function closeUploadModal() {
    elements.uploadModal.classList.remove("open");
    elements.uploadModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function renderSelectedFiles() {
    elements.selectedFiles.replaceChildren();
    elements.selectedFiles.hidden = selectedFiles.length === 0;
    elements.confirmUploadButton.disabled = selectedFiles.length === 0;
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

  async function showAccount(account) {
    state.account = account;
    const displayName = account.displayName || account.userPrincipalName || "Microsoft 帳戶";
    $("#accountName").textContent = displayName;
    $("#accountEmail").textContent = account.userPrincipalName || "Microsoft OneDrive";
    $("#accountAvatar").textContent = displayName.trim().charAt(0).toUpperCase();
    renderFiles();
    try {
      const response = await graphRequest("me?$select=id,displayName,mail,userPrincipalName");
      const profile = await response.json();
      state.account = profile;
      $("#accountName").textContent = profile.displayName || displayName;
      $("#accountEmail").textContent = profile.mail || profile.userPrincipalName || "Microsoft OneDrive";
      $("#accountAvatar").textContent = (profile.displayName || displayName).trim().charAt(0).toUpperCase();
    } catch (error) {
      console.warn("無法載入 Microsoft 帳戶資料:", error);
      if (!readCachedItems(null) && !navigator.onLine) showToast("離線狀態，請連線以重新驗證 Microsoft 帳戶。", "info");
    }
    await loadFiles();
    await uploadQueuedItems();
  }

  async function signOut() {
    clearTokens();
    state.account = null;
    state.items = [];
    state.folderId = null;
    state.folderName = "";
    $("#accountName").textContent = "尚未登入";
    $("#accountEmail").textContent = "連結 Microsoft 帳戶";
    $("#accountAvatar").textContent = "?";
    renderFiles();
    showToast("已從此裝置登出 Microsoft 帳戶。", "info");
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
    $("#accountButton").addEventListener("click", () => state.account ? signOut() : signIn());
    $("#mobileAccountButton").addEventListener("click", () => {
      document.body.classList.remove("sidebar-open");
      state.account ? signOut() : signIn();
    });
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
  }

  async function initialize() {
    bindEvents();
    updateConnection();
    try {
      const completedLogin = await exchangeAuthorizationCode();
      if (completedLogin) showToast("Microsoft 帳戶已成功連結。");
    } catch (error) {
      console.error("Microsoft OAuth 登入失敗:", error);
      showToast(error.message || "Microsoft 登入失敗。", "error", 4500);
    }
    try {
      state.pending = await getQueuedUploads();
    } catch (error) {
      console.error("無法載入待上傳檔案:", error);
      showToast("無法讀取本機離線佇列：" + error.message, "error", 4000);
    }
    const tokens = getTokens();
    if (tokens.accessToken || tokens.refreshToken) {
      await showAccount({ displayName: "Microsoft 帳戶" });
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

  initialize();
})();
