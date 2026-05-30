const DB_NAME = "pocket-reading-vault";
const DB_VERSION = 1;
const STORE = "state";
const IMPORT_API_BASE = "https://pocket-reading-vault.onrender.com";
const SUPABASE_URL = "https://bhliywysdezcykoyyozw.supabase.co";
const SUPABASE_KEY = "sb_publishable_hh04jm0Nqp3_Jq-3FTcs5w_FbuaSO0v";

const $ = (selector) => document.querySelector(selector);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const defaultState = {
  theme: "light",
  readerFontSize: 18,
  readerLineHeight: 1.8,
  readerSideMargin: 20,
  readerTurnMode: "tap",
  readerBg: "white",
  selectedFolder: "all",
  selectedWorkId: null,
  folders: [
    { id: "all", name: "全部" },
    { id: "unfiled", name: "未分类" }
  ],
  works: []
};

let state = structuredClone(defaultState);
let db;
let noteTimer;
let progressTimer;
let snapTimer;
let persistTimer;
let pageCache = { key: "", step: 1, max: 0, total: 1, current: 1 };
let cloudTimer;
let pendingJump = null;
let controlsOpen = false;
let importDrawerOpen = false;
let cloudPanelOpen = false;
let cloudSession = null;
let syncingCloud = false;
let supabase;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbGet(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbSet(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function saveState() {
  state.updatedAt = new Date().toISOString();
  await dbSet("library", state);
  queueCloudSave();
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function textFromHtml(html = "") {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

function activeWork() {
  return state.works.find((work) => work.id === state.selectedWorkId) || null;
}

function folderName(id) {
  return state.folders.find((folder) => folder.id === id)?.name || "未分类";
}

function normalizeWork(work) {
  work.folderId ||= "unfiled";
  work.customTags ||= [];
  work.note ||= "";
  work.metadata ||= {};
  work.bookmarks ||= [];
  work.highlights ||= [];
  work.reading ||= { chapterIndex: 0, ratio: 0 };
  work.reading.chapterIndex ||= 0;
  work.reading.ratio ||= 0;
  return work;
}

function getChapters(work) {
  const host = document.createElement("div");
  host.innerHTML = work.contentHtml || "";
  const root = host.querySelector("#chapters") || host;
  let nodes = [...root.children].filter((node) => node.classList?.contains("chapter") || /^chapter-/.test(node.id || ""));
  if (!nodes.length) nodes = [...root.querySelectorAll(".chapter")];
  if (!nodes.length) return [{ title: "全文", html: root.innerHTML || work.contentHtml || "" }];

  return nodes.map((node, index) => {
    const heading = node.querySelector(".title, h2, h3, h4");
    const title = heading?.textContent?.replace(/\s+/g, " ").trim() || `第 ${index + 1} 章`;
    return { title, html: node.outerHTML };
  });
}

function currentChapterIndex(work, chapters = getChapters(work)) {
  const index = Number(work.reading?.chapterIndex || 0);
  return Math.max(0, Math.min(index, chapters.length - 1));
}

function filteredWorks() {
  const query = $("#searchInput").value.trim().toLowerCase();
  return state.works
    .filter((work) => state.selectedFolder === "all" || (work.folderId || "unfiled") === state.selectedFolder)
    .filter((work) => {
      if (!query) return true;
      const haystack = [
        work.title,
        work.author,
        work.note,
        ...(work.customTags || []),
        ...(work.metadata?.relationships || [])
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => new Date(b.importedAt) - new Date(a.importedAt));
}

function renderFolders() {
  const countFor = (folderId) => {
    if (folderId === "all") return state.works.length;
    return state.works.filter((work) => (work.folderId || "unfiled") === folderId).length;
  };
  $("#folderList").innerHTML = state.folders.map((folder) => `
    <button class="folder-card ${state.selectedFolder === folder.id ? "active" : ""}" data-folder="${folder.id}">
      <span>${escapeHtml(folder.name)}</span>
      <small>${countFor(folder.id)} 篇</small>
    </button>
  `).join("");
}

function renderWorks() {
  const works = filteredWorks();
  $("#workList").innerHTML = works.length ? works.map((work) => {
    const rel = work.metadata?.relationships?.[0] || work.customTags?.[0] || folderName(work.folderId || "unfiled");
    const chapters = getChapters(work).length;
    const chapterText = work.metadata?.chapters || "";
    const complete = /(\d+)\s*\/\s*\1/.test(chapterText) || /complete|完结/i.test(work.metadata?.status || "");
    const status = complete ? "完结" : (chapterText ? "连载" : "未知");
    const chapterIndex = Math.min(chapters - 1, Math.max(0, Number(work.reading?.chapterIndex || 0)));
    const ratio = Math.max(0, Math.min(1, Number(work.reading?.ratio || 0)));
    const progress = chapters ? Math.round(((chapterIndex + ratio) / chapters) * 100) : Math.round(ratio * 100);
    const progressText = progress > 0 ? `进度：${Math.min(100, progress)}%` : "未读";
    return `
      <button class="work-card ${state.selectedWorkId === work.id ? "active" : ""}" data-work="${work.id}">
        <h3 class="work-title-line"><span>${escapeHtml(work.title)}</span><small>${status}</small><b>›</b></h3>
        <p>${escapeHtml(work.author || "未知作者")} · ${escapeHtml(rel)}</p>
        <p>${progressText} · ${chapters} 章 · ${escapeHtml(work.metadata?.words || "字数未知")}</p>
      </button>
    `;
  }).join("") : `<div class="empty-state compact-empty"><p>这里还没有作品。</p></div>`;
}

function renderReader() {
  const work = activeWork();
  $("#emptyState").classList.toggle("hidden", Boolean(work));
  $("#reader").classList.toggle("hidden", !work);
  $("#readingBar").classList.toggle("hidden", !work || !controlsOpen);
  $("#readerConsole").classList.toggle("hidden", !work || !controlsOpen);
  $("#readerPageCount").classList.toggle("hidden", !work);
  document.body.classList.toggle("reading", Boolean(work));

  if (!work) return;
  normalizeWork(work);
  const chapters = getChapters(work);
  const index = currentChapterIndex(work, chapters);
  work.reading.chapterIndex = index;
  const chapter = chapters[index];

  $("#workFolder").textContent = folderName(work.folderId || "unfiled");
  $("#workTitle").textContent = work.title;
  $("#workAuthor").textContent = work.author || "未知作者";
  $("#noteInput").value = work.note || "";
  $("#summaryBlock").innerHTML = work.summaryHtml ? `<label>简介</label><div>${work.summaryHtml}</div>` : "";
  $("#chapterTitle").textContent = `${index + 1}/${chapters.length} ${chapter.title}`;
  $("#openChapterDialog").textContent = `${index + 1}/${chapters.length}`;
  $("#prevChapter").disabled = index === 0;
  $("#nextChapter").disabled = index === chapters.length - 1;
  $("#consolePrevChapter").hidden = index === 0;
  $("#consoleNextChapter").hidden = index === chapters.length - 1;

  $("#workContent").innerHTML = chapter.html;
  $("#workContent").style.setProperty("--reader-font-size", `${state.readerFontSize || 18}px`);
  $("#workContent").style.setProperty("--reader-line-height", `${state.readerLineHeight || 1.8}`);
  $("#workContent").style.setProperty("--reader-side-margin", `${state.readerSideMargin || 34}px`);
  resetPageCache();
  applyHighlights(work, index);

  const tags = [
    ...(work.metadata?.relationships || []),
    ...(work.customTags || []),
    work.metadata?.rating,
    work.metadata?.chapters
  ].filter(Boolean).slice(0, 14);
  $("#workTags").innerHTML = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  $("#metadataBlock").innerHTML = renderMetadata(work);
  updateProgressBar();
  updatePageCount();

  if (pendingJump !== null) {
    const ratio = pendingJump;
    pendingJump = null;
    requestAnimationFrame(() => scrollToChapterRatio(ratio));
  }
}

function renderMetadata(work) {
  const groups = [
    ["分级", work.metadata?.rating],
    ["警告", work.metadata?.warnings],
    ["分类", work.metadata?.categories],
    ["Fandom", work.metadata?.fandoms],
    ["CP / 关系", work.metadata?.relationships],
    ["角色", work.metadata?.characters],
    ["其他标签", work.metadata?.freeforms],
    ["章节", work.metadata?.chapters],
    ["字数", work.metadata?.words],
    ["状态", work.metadata?.status],
    ["语言", work.metadata?.language]
  ];
  return groups.map(([label, value]) => {
    const values = Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
    if (!values.length) return "";
    return `
      <div class="metadata-row">
        <b>${escapeHtml(label)}</b>
        <div>${values.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")}</div>
      </div>
    `;
  }).join("");
}

function renderMetaOptions() {
  $("#metaFolder").innerHTML = state.folders
    .filter((folder) => folder.id !== "all")
    .map((folder) => `<option value="${folder.id}">${escapeHtml(folder.name)}</option>`)
    .join("");
}

function renderChapterDialog() {
  const work = activeWork();
  if (!work) return;
  const chapters = getChapters(work);
  const index = currentChapterIndex(work, chapters);
  $("#chapterProgressText").textContent = `当前：${index + 1}/${chapters.length} · ${Math.round((work.reading?.ratio || 0) * 100)}%`;
  $("#chapterList").innerHTML = chapters.map((chapter, chapterIndex) => `
    <button class="chapter-item ${chapterIndex === index ? "active" : ""}" data-chapter="${chapterIndex}">
      <span>${escapeHtml(chapter.title)}</span>
      <small>第 ${chapterIndex + 1} 章</small>
    </button>
  `).join("");
  $("#bookmarkList").innerHTML = work.bookmarks.length ? work.bookmarks.map((bookmark) => `
    <button class="chapter-item" data-bookmark="${bookmark.id}">
      <span>${escapeHtml(bookmark.label)}</span>
      <small>${new Date(bookmark.createdAt).toLocaleString()}</small>
    </button>
  `).join("") : `<p class="status">还没有书签。</p>`;
}

function renderAll() {
  document.documentElement.classList.toggle("dark", state.theme === "dark");
  document.documentElement.classList.remove(
    "reader-bg-white",
    "reader-bg-light",
    "reader-bg-medium",
    "reader-bg-darkgray",
    "reader-bg-black",
    "reader-bg-paper",
    "reader-bg-green",
    "reader-bg-gray",
    "reader-bg-dark"
  );
  document.documentElement.classList.add(`reader-bg-${state.readerBg || "white"}`);
  document.documentElement.classList.remove("turn-tap", "turn-swipe", "turn-both", "turn-scroll");
  document.documentElement.classList.add(`turn-${state.readerTurnMode || "tap"}`);
  document.body.classList.toggle("import-open", importDrawerOpen);
  document.body.classList.toggle("cloud-open", cloudPanelOpen);
  document.documentElement.style.setProperty("--reader-font-size", `${state.readerFontSize || 18}px`);
  document.documentElement.style.setProperty("--reader-line-height", `${state.readerLineHeight || 1.8}`);
  document.documentElement.style.setProperty("--reader-side-margin", `${state.readerSideMargin || 34}px`);
  renderFolders();
  renderWorks();
  renderReader();
  renderMetaOptions();
  renderSettingsLabels();
  renderBackgroundChoices();
}

function renderSettingsLabels() {
  const font = $("#settingsFontSize");
  const line = $("#settingsLineHeight");
  const margin = $("#settingsSideMargin");
  if (font) font.textContent = `${state.readerFontSize || 18}px`;
  if (line) line.textContent = `${(state.readerLineHeight || 1.8).toFixed(1)}`;
  if (margin) margin.textContent = `${state.readerSideMargin || 20}px`;
}

function renderBackgroundChoices() {
  document.querySelectorAll("[data-bg]").forEach((button) => {
    button.classList.toggle("active", button.dataset.bg === (state.readerBg || "white"));
  });
}

function downloadTextFile(filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportLibrary() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "pocket-reading-vault",
    version: 1,
    state
  };
  const date = new Date().toISOString().slice(0, 10);
  downloadTextFile(`reading-vault-${date}.json`, JSON.stringify(payload, null, 2));
}

async function importLibraryFile(file) {
  const payload = JSON.parse(await file.text());
  const nextState = payload.state || payload;
  if (!nextState || !Array.isArray(nextState.works)) {
    throw new Error("这个文件不像书架备份。");
  }
  const existingFolders = new Map(state.folders.map((folder) => [folder.id, folder]));
  for (const folder of nextState.folders || []) {
    if (!existingFolders.has(folder.id)) state.folders.push(folder);
  }
  const existingWorks = new Map(state.works.map((work) => [work.id, work]));
  for (const work of nextState.works.map(normalizeWork)) {
    existingWorks.set(work.id, { ...existingWorks.get(work.id), ...work });
  }
  state.works = [...existingWorks.values()].map(normalizeWork);
  state.readerFontSize = nextState.readerFontSize || state.readerFontSize;
  state.readerLineHeight = nextState.readerLineHeight || state.readerLineHeight;
  state.readerSideMargin = nextState.readerSideMargin || state.readerSideMargin;
  state.readerTurnMode = nextState.readerTurnMode || state.readerTurnMode;
  state.readerBg = nextState.readerBg || state.readerBg;
  state.theme = nextState.theme || state.theme;
  await saveState();
  renderAll();
}

function setCloudStatus(message) {
  const node = $("#cloudStatus");
  if (node) node.textContent = message;
}

function renderCloudPanel() {
  const signedIn = Boolean(cloudSession?.user);
  if (!supabase) {
    $("#cloudEmail").disabled = true;
    $("#cloudLoginButton").classList.remove("hidden");
    $("#cloudLogoutButton").classList.add("hidden");
    $("#cloudUploadButton").disabled = true;
    $("#cloudDownloadButton").disabled = true;
    $("#cloudUser").textContent = "云端暂不可用";
    setCloudStatus("云端模块没加载成功，但本机导入和阅读可以继续用。");
    return;
  }
  $("#cloudEmail").disabled = signedIn;
  $("#cloudLoginButton").classList.toggle("hidden", signedIn);
  $("#cloudLogoutButton").classList.toggle("hidden", !signedIn);
  $("#cloudUploadButton").disabled = !signedIn;
  $("#cloudDownloadButton").disabled = !signedIn;
  $("#cloudUser").textContent = signedIn ? `已登录：${cloudSession.user.email}` : "未登录云端";
}

function cloneLibraryState(value) {
  return structuredClone({
    ...defaultState,
    ...value,
    folders: value?.folders || defaultState.folders,
    works: (value?.works || []).map(normalizeWork)
  });
}

function mergeLibraryState(localState, cloudState) {
  const merged = cloneLibraryState(localState);
  const folderMap = new Map((merged.folders || []).map((folder) => [folder.id, folder]));
  for (const folder of cloudState.folders || []) folderMap.set(folder.id, folder);
  merged.folders = [...folderMap.values()];
  if (!merged.folders.some((folder) => folder.id === "all")) merged.folders.unshift(defaultState.folders[0]);
  if (!merged.folders.some((folder) => folder.id === "unfiled")) merged.folders.push(defaultState.folders[1]);

  const workMap = new Map((merged.works || []).map((work) => [work.id, normalizeWork(work)]));
  for (const cloudWork of cloudState.works || []) {
    const existing = workMap.get(cloudWork.id);
    if (!existing) {
      workMap.set(cloudWork.id, normalizeWork(cloudWork));
      continue;
    }
    const localTime = new Date(existing.updatedAt || existing.importedAt || 0).getTime();
    const cloudTime = new Date(cloudWork.updatedAt || cloudWork.importedAt || 0).getTime();
    workMap.set(cloudWork.id, normalizeWork(cloudTime > localTime ? cloudWork : existing));
  }
  merged.works = [...workMap.values()];
  merged.readerFontSize = localState.readerFontSize || cloudState.readerFontSize || defaultState.readerFontSize;
  merged.readerLineHeight = localState.readerLineHeight || cloudState.readerLineHeight || defaultState.readerLineHeight;
  merged.readerSideMargin = localState.readerSideMargin || cloudState.readerSideMargin || defaultState.readerSideMargin;
  merged.readerTurnMode = localState.readerTurnMode || cloudState.readerTurnMode || defaultState.readerTurnMode;
  merged.readerBg = localState.readerBg || cloudState.readerBg || defaultState.readerBg;
  merged.theme = localState.theme || cloudState.theme || defaultState.theme;
  merged.updatedAt = new Date().toISOString();
  return merged;
}

async function getCloudState() {
  if (!cloudSession?.user) return null;
  const { data, error } = await supabase
    .from("library_states")
    .select("state, updated_at")
    .eq("user_id", cloudSession.user.id)
    .maybeSingle();
  if (error) throw error;
  return data?.state ? cloneLibraryState(data.state) : null;
}

async function saveCloudNow({ silent = false } = {}) {
  if (!cloudSession?.user || syncingCloud) return;
  syncingCloud = true;
  if (!silent) setCloudStatus("正在上传云端……");
  try {
    const payload = cloneLibraryState(state);
    const { error } = await supabase.from("library_states").upsert({
      user_id: cloudSession.user.id,
      state: payload,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
    setCloudStatus(`云端已保存：${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setCloudStatus(`云端保存失败：${error.message}`);
  } finally {
    syncingCloud = false;
  }
}

function queueCloudSave() {
  if (!cloudSession?.user || syncingCloud) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => saveCloudNow({ silent: true }), 1200);
}

async function loadCloudIntoLocal({ merge = true } = {}) {
  if (!cloudSession?.user) return;
  setCloudStatus("正在读取云端书架……");
  const cloudState = await getCloudState();
  if (!cloudState) {
    await saveCloudNow();
    return;
  }
  syncingCloud = true;
  state = merge ? mergeLibraryState(state, cloudState) : cloneLibraryState(cloudState);
  await dbSet("library", state);
  syncingCloud = false;
  renderAll();
  setCloudStatus(merge ? "已合并云端书架。" : "已下载云端书架。");
  if (merge) await saveCloudNow({ silent: true });
}

async function refreshCloudSession({ initial = false } = {}) {
  const { data } = await supabase.auth.getSession();
  cloudSession = data.session;
  renderCloudPanel();
  if (cloudSession?.user) {
    setCloudStatus("云端已连接。");
    if (initial) await loadCloudIntoLocal({ merge: true });
  } else {
    setCloudStatus("登录后可同步手机和电脑。");
  }
}

async function addWork(work) {
  const existing = state.works.find((item) => item.sourceUrl && item.sourceUrl === work.sourceUrl);
  if (existing && !confirm("这个链接已经在书架里了，要重新保存并覆盖正文吗？")) return;
  const next = normalizeWork({
    id: existing?.id || uid(),
    folderId: existing?.folderId || "unfiled",
    customTags: existing?.customTags || [],
    note: existing?.note || "",
    bookmarks: existing?.bookmarks || [],
    highlights: existing?.highlights || [],
    reading: existing?.reading || { chapterIndex: 0, ratio: 0 },
    ...work,
    importedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  state.works = existing ? state.works.map((item) => item.id === existing.id ? next : item) : [next, ...state.works];
  state.selectedWorkId = next.id;
  await saveState();
  renderAll();
}

async function importFromSource(url) {
  const status = $("#importStatus");
  status.textContent = "正在读取原站……";
  try {
    const response = await fetch(`${IMPORT_API_BASE}/api/import?url=${encodeURIComponent(url)}`, {
      headers: { accept: "application/json" }
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) throw new Error("STATIC_PAGE");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "导入失败。");
    await addWork(payload);
    status.textContent = "已经保存到本机书架。";
    $("#sourceUrl").value = "";
  } catch (error) {
    if (error.message === "STATIC_PAGE") {
      throw new Error("这个网页还没有连接到导入后端。请上传包含 Render 地址的新版 app.js。");
    }
    if (error instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(error.message)) {
      throw new Error("导入后端暂时没连上。Render 第一次启动可能要等 30 秒左右；如果一直这样，请确认 Render 服务已部署并在运行。");
    }
    throw error;
  }
}

function plainTextToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function parseWorkHtml(html, sourceUrl = "") {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = (selector) => doc.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || "";
  const tags = (selector) => [...doc.querySelectorAll(`${selector} a`)].map((item) => item.textContent.trim()).filter(Boolean);
  const chapters = doc.querySelector("#chapters");
  if (!chapters) throw new Error("这个 HTML 里没有找到 正文。请下载作品的 Entire Work / HTML 文件。");
  chapters.querySelectorAll("script, style").forEach((node) => node.remove());
  chapters.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src && sourceUrl) img.src = new URL(src, sourceUrl).toString();
  });
  return {
    title: text("h2.title.heading") || text("title").replace(/\s*\|\s*Archive Site.*$/i, "") || "未命名作品",
    author: text("h3.byline.heading") || "未知作者",
    sourceUrl,
    summaryHtml: doc.querySelector("blockquote.userstuff.summary")?.innerHTML || "",
    contentHtml: chapters.outerHTML,
    metadata: {
      rating: text("dd.rating.tags"),
      categories: tags("dd.category.tags"),
      fandoms: tags("dd.fandom.tags"),
      warnings: tags("dd.warning.tags"),
      relationships: tags("dd.relationship.tags"),
      characters: tags("dd.character.tags"),
      freeforms: tags("dd.freeform.tags"),
      words: text("dd.words"),
      chapters: text("dd.chapters"),
      status: text("dd.status"),
      language: text("dd.language")
    }
  };
}

function chapterScrollRatio() {
  const content = $("#workContent");
  if (!content || content.classList.contains("hidden")) return 0;
  if (isPagedMode()) {
    if (state.readerTurnMode === "scroll") {
      const maxY = Math.max(1, content.scrollHeight - content.clientHeight);
      return Math.max(0, Math.min(1, content.scrollTop / maxY));
    }
    const metrics = refreshPageCache();
    if (metrics.total <= 1) return 0;
    return Math.max(0, Math.min(1, (metrics.current - 1) / (metrics.total - 1)));
  }
  const rect = content.getBoundingClientRect();
  const start = window.scrollY + rect.top;
  const max = Math.max(1, content.scrollHeight - window.innerHeight + 120);
  return Math.max(0, Math.min(1, (window.scrollY - start + 20) / max));
}

function scrollToChapterRatio(ratio) {
  const content = $("#workContent");
  if (isPagedMode()) {
    if (state.readerTurnMode === "scroll") {
      const maxY = Math.max(1, content.scrollHeight - content.clientHeight);
      content.scrollTo({ top: maxY * ratio, behavior: "auto" });
      updateProgressBar();
      updatePageCount();
      return;
    }
    const metrics = refreshPageCache(true);
    const page = Math.round(Math.max(0, Math.min(1, ratio)) * (metrics.total - 1)) + 1;
    setReaderPage(page);
    updateProgressBar();
    return;
  }
  const rect = content.getBoundingClientRect();
  const start = window.scrollY + rect.top;
  const max = Math.max(1, content.scrollHeight - window.innerHeight + 120);
  window.scrollTo({ top: start + max * ratio, behavior: "auto" });
  updateProgressBar();
  updatePageCount();
}

function isPagedMode() {
  return window.matchMedia("(max-width: 879px)").matches;
}

function pageStepRatio() {
  const metrics = refreshPageCache();
  return metrics.total <= 1 ? 1 : 1 / metrics.total;
}

function turnPage(delta) {
  const work = activeWork();
  if (!work || !isPagedMode()) return;
  const content = $("#workContent");
  if (state.readerTurnMode === "scroll") {
    const maxY = Math.max(0, content.scrollHeight - content.clientHeight);
    if (delta > 0 && content.scrollTop >= maxY - 2) {
      changeChapter(1);
      return;
    }
    if (delta < 0 && content.scrollTop <= 2) {
      changeChapter(-1);
      return;
    }
    content.scrollBy({ top: content.clientHeight * 0.86 * delta, behavior: "auto" });
    updateProgressBar();
    queueProgressPersist();
    return;
  }
  const metrics = refreshPageCache();
  if (delta > 0 && metrics.current >= metrics.total) {
    changeChapter(1);
    return;
  }
  if (delta < 0 && metrics.current <= 1) {
    changeChapter(-1);
    return;
  }
  setReaderPage(metrics.current + delta);
  updateProgressBar();
  queueProgressPersist();
}

function readerPageKey() {
  const work = activeWork();
  const content = $("#workContent");
  if (!work || !content) return "";
  const chapters = getChapters(work);
  const index = currentChapterIndex(work, chapters);
  return [
    work.id || state.selectedWorkId || "",
    index,
    content.clientWidth,
    state.readerFontSize,
    state.readerLineHeight,
    state.readerSideMargin,
    state.readerTurnMode
  ].join("|");
}

function resetPageCache() {
  pageCache = { key: "", step: 1, max: 0, total: 1, current: 1 };
}

function refreshPageCache(force = false) {
  const content = $("#workContent");
  const key = readerPageKey();
  if (!content || !key || state.readerTurnMode === "scroll") return pageCache;
  const step = Math.max(1, content.clientWidth);
  if (!force && pageCache.key === key && pageCache.step === step) return pageCache;
  const max = Math.max(0, content.scrollWidth - step);
  const total = Math.max(1, Math.round(max / step) + 1);
  const current = Math.min(total, Math.max(1, Math.round(content.scrollLeft / step) + 1));
  pageCache = { key, step, max, total, current };
  return pageCache;
}

function setReaderPage(page) {
  const content = $("#workContent");
  const metrics = refreshPageCache();
  const current = Math.min(metrics.total, Math.max(1, page));
  pageCache.current = current;
  content.scrollLeft = Math.min(metrics.max, (current - 1) * metrics.step);
}

function syncPageFromScroll() {
  if (!isPagedMode() || state.readerTurnMode === "scroll") return;
  const content = $("#workContent");
  const metrics = refreshPageCache();
  pageCache.current = Math.min(metrics.total, Math.max(1, Math.round(content.scrollLeft / metrics.step) + 1));
}

function setControlsOpen(open) {
  controlsOpen = open;
  $("#readingBar").classList.toggle("hidden", !activeWork() || !controlsOpen);
  $("#readerConsole").classList.toggle("hidden", !activeWork() || !controlsOpen);
}

function snapToNearestPage() {
  const content = $("#workContent");
  if (!activeWork() || !isPagedMode() || state.readerTurnMode === "scroll") return;
  const metrics = refreshPageCache();
  const target = Math.max(0, Math.min(metrics.max, Math.round(content.scrollLeft / metrics.step) * metrics.step));
  if (Math.abs(target - content.scrollLeft) > 2) {
    content.scrollLeft = target;
  }
  pageCache.current = Math.min(metrics.total, Math.max(1, Math.round(target / metrics.step) + 1));
}

function queueProgressPersist(delay = 700) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistProgress, delay);
}

function updateProgressBar() {
  const work = activeWork();
  if (!work) return;
  const ratio = chapterScrollRatio();
  $("#progressRange").value = Math.round(ratio * 1000);
  $("#progressText").textContent = `${Math.round(ratio * 100)}%`;
  updatePageCount();
}

function updatePageCount() {
  const work = activeWork();
  const count = $("#readerPageCount");
  if (!work || !count) return;
  const content = $("#workContent");
  if (isPagedMode() && state.readerTurnMode === "scroll") {
    count.textContent = `${Math.round(chapterScrollRatio() * 100)}%`;
    return;
  }
  const metrics = isPagedMode() ? refreshPageCache() : { current: 1, total: 1 };
  count.textContent = `${metrics.current} / ${metrics.total}`;
}

function requestReadingFullscreen() {
  if (!isPagedMode() || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen().catch(() => {});
}

function exitReadingFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
}

async function persistProgress() {
  const work = activeWork();
  if (!work) return;
  normalizeWork(work);
  work.reading.ratio = chapterScrollRatio();
  work.updatedAt = new Date().toISOString();
  await saveState();
  updateProgressBar();
}

function changeChapter(delta) {
  const work = activeWork();
  if (!work) return;
  const chapters = getChapters(work);
  work.reading.chapterIndex = Math.max(0, Math.min(currentChapterIndex(work, chapters) + delta, chapters.length - 1));
  work.reading.ratio = 0;
  work.updatedAt = new Date().toISOString();
  pendingJump = 0;
  saveState().then(renderAll);
}

function goToChapter(index, ratio = 0) {
  const work = activeWork();
  if (!work) return;
  const chapters = getChapters(work);
  work.reading.chapterIndex = Math.max(0, Math.min(index, chapters.length - 1));
  work.reading.ratio = ratio;
  work.updatedAt = new Date().toISOString();
  pendingJump = ratio;
  saveState().then(renderAll);
}

async function addBookmark() {
  const work = activeWork();
  if (!work) return;
  normalizeWork(work);
  const chapters = getChapters(work);
  const index = currentChapterIndex(work, chapters);
  const ratio = chapterScrollRatio();
  work.bookmarks.unshift({
    id: uid(),
    chapterIndex: index,
    ratio,
    label: `${chapters[index].title} · ${Math.round(ratio * 100)}%`,
    createdAt: new Date().toISOString()
  });
  work.reading.ratio = ratio;
  work.updatedAt = new Date().toISOString();
  await saveState();
  updateProgressBar();
}

function applyHighlights(work, chapterIndex) {
  const root = $("#workContent");
  const highlights = (work.highlights || []).filter((item) => item.chapterIndex === chapterIndex);
  for (const highlight of highlights) markFirstText(root, highlight.text);
}

function markFirstText(root, text) {
  if (!text || text.length < 2) return false;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.includes(text)) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(".reader-highlight")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const node = walker.nextNode();
  if (!node) return false;
  const index = node.nodeValue.indexOf(text);
  const range = document.createRange();
  range.setStart(node, index);
  range.setEnd(node, index + text.length);
  const span = document.createElement("mark");
  span.className = "reader-highlight";
  range.surroundContents(span);
  return true;
}

async function addHighlightFromSelection() {
  const work = activeWork();
  const selection = window.getSelection();
  if (!work || !selection || selection.isCollapsed) return;
  const content = $("#workContent");
  if (!content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) return;
  const text = selection.toString().replace(/\s+/g, " ").trim();
  if (!text || text.length < 2) return;
  normalizeWork(work);
  const chapterIndex = currentChapterIndex(work);
  work.highlights.push({ id: uid(), chapterIndex, text, createdAt: new Date().toISOString() });
  work.updatedAt = new Date().toISOString();
  selection.removeAllRanges();
  await saveState();
  renderReader();
}

async function boot() {
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  } catch {
    supabase = null;
  }
  db = await openDb();
  state = { ...defaultState, ...(await dbGet("library") || {}) };
  state.works = (state.works || []).map(normalizeWork);
  state.readerLineHeight ||= defaultState.readerLineHeight;
  state.readerSideMargin ||= defaultState.readerSideMargin;
  state.readerTurnMode ||= defaultState.readerTurnMode;
  state.readerBg ||= defaultState.readerBg;
  if (["paper", "green", "gray"].includes(state.readerBg)) state.readerBg = "light";
  if (state.readerBg === "dark") state.readerBg = "black";
  state.readerFontSize = Math.max(12, Math.min(32, Number(state.readerFontSize || defaultState.readerFontSize)));
  state.readerLineHeight = Math.max(1.4, Math.min(2.4, Number(state.readerLineHeight || defaultState.readerLineHeight)));
  state.readerSideMargin = Math.max(12, Math.min(32, Number(state.readerSideMargin || defaultState.readerSideMargin)));
  if (!state.folders.some((folder) => folder.id === "all")) state.folders.unshift(defaultState.folders[0]);
  if (!state.folders.some((folder) => folder.id === "unfiled")) state.folders.push(defaultState.folders[1]);
  renderAll();
  if (supabase) {
    await refreshCloudSession({ initial: true });
    supabase.auth.onAuthStateChange(async (_event, session) => {
      cloudSession = session;
      renderCloudPanel();
      if (session?.user) await loadCloudIntoLocal({ merge: true });
      else setCloudStatus("已退出云端。");
    });
  } else {
    renderCloudPanel();
  }
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

$("#importForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = $("#sourceUrl").value.trim();
  if (!url) return;
  try {
    await importFromSource(url);
  } catch (error) {
    $("#importStatus").textContent = error.message;
  }
});

$("#importDrawerButton").addEventListener("click", () => {
  importDrawerOpen = !importDrawerOpen;
  renderAll();
});

$("#searchToggleButton").addEventListener("click", () => {
  $("#searchInput").focus();
  $("#searchInput").scrollIntoView({ block: "center", behavior: "smooth" });
});

$("#cloudPanelButton").addEventListener("click", () => {
  cloudPanelOpen = !cloudPanelOpen;
  renderAll();
});

$("#cloudLoginButton").addEventListener("click", async () => {
  if (!supabase) {
    setCloudStatus("云端模块暂时没加载成功，先用本机导入和阅读。");
    return;
  }
  const email = $("#cloudEmail").value.trim();
  if (!email) {
    setCloudStatus("先输入邮箱。");
    return;
  }
  setCloudStatus("正在发送登录邮件……");
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.href.split("#")[0] }
  });
  setCloudStatus(error ? `发送失败：${error.message}` : "登录邮件已发送，打开邮件里的链接即可同步。");
});

$("#cloudLogoutButton").addEventListener("click", async () => {
  if (!supabase) return;
  await supabase.auth.signOut();
  cloudSession = null;
  renderCloudPanel();
  setCloudStatus("已退出云端。");
});

$("#cloudUploadButton").addEventListener("click", () => saveCloudNow());

$("#cloudDownloadButton").addEventListener("click", async () => {
  if (!confirm("用云端书架合并到本机？本机已有作品不会被直接清空。")) return;
  try {
    await loadCloudIntoLocal({ merge: true });
  } catch (error) {
    setCloudStatus(`云端读取失败：${error.message}`);
  }
});

$("#folderList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-folder]");
  if (!button) return;
  state.selectedFolder = button.dataset.folder;
  state.selectedWorkId = null;
  await saveState();
  renderAll();
});

$("#workList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-work]");
  if (!button) return;
  state.selectedWorkId = button.dataset.work;
  const work = activeWork();
  pendingJump = work?.reading?.ratio || 0;
  requestReadingFullscreen();
  await saveState();
  renderAll();
});

$("#searchInput").addEventListener("input", renderWorks);
$("#newFolderButton").addEventListener("click", () => {
  $("#folderName").value = "";
  $("#folderDialog").showModal();
});

$("#folderForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const name = $("#folderName").value.trim();
  if (!name) return;
  state.folders.push({ id: uid(), name });
  await saveState();
  $("#folderDialog").close();
  renderAll();
});

$("#editMetaButton").addEventListener("click", () => {
  const work = activeWork();
  if (!work) return;
  $("#metaFolder").value = work.folderId || "unfiled";
  $("#metaCustomTags").value = (work.customTags || []).join(", ");
  $("#metaDialog").showModal();
});

$("#metaForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const work = activeWork();
  if (!work) return;
  work.folderId = $("#metaFolder").value;
  work.customTags = $("#metaCustomTags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
  work.updatedAt = new Date().toISOString();
  await saveState();
  $("#metaDialog").close();
  renderAll();
});

$("#noteInput").addEventListener("input", () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => {
    const work = activeWork();
    if (!work) return;
    work.note = $("#noteInput").value;
    work.updatedAt = new Date().toISOString();
    await saveState();
    renderWorks();
  }, 250);
});

$("#deleteWorkButton").addEventListener("click", async () => {
  const work = activeWork();
  if (!work || !confirm(`删除《${work.title}》？`)) return;
  state.works = state.works.filter((item) => item.id !== work.id);
  state.selectedWorkId = null;
  await saveState();
  renderAll();
});

$("#backToList").addEventListener("click", async () => {
  await persistProgress();
  state.selectedWorkId = null;
  exitReadingFullscreen();
  await saveState();
  renderAll();
});

$("#themeToggle").addEventListener("click", async () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  await saveState();
  renderAll();
});

$("#fontDecrease").addEventListener("click", async () => {
  state.readerFontSize = Math.max(15, (state.readerFontSize || 18) - 1);
  await saveState();
  renderAll();
});

$("#fontIncrease").addEventListener("click", async () => {
  state.readerFontSize = Math.min(28, (state.readerFontSize || 18) + 1);
  await saveState();
  renderAll();
});

$("#prevChapter").addEventListener("click", () => changeChapter(-1));
$("#nextChapter").addEventListener("click", () => changeChapter(1));
$("#highlightButton").addEventListener("click", addHighlightFromSelection);
$("#bookmarkButton").addEventListener("click", addBookmark);

$("#progressRange").addEventListener("input", (event) => {
  const ratio = Number(event.target.value) / 1000;
  scrollToChapterRatio(ratio);
});

$("#progressRange").addEventListener("change", persistProgress);

$("#consoleProgress")?.addEventListener("input", (event) => {
  const ratio = Number(event.target.value) / 1000;
  scrollToChapterRatio(ratio);
});

$("#consoleProgress")?.addEventListener("change", persistProgress);

$("#consoleBackButton").addEventListener("click", async () => {
  setControlsOpen(false);
  await persistProgress();
  state.selectedWorkId = null;
  exitReadingFullscreen();
  await saveState();
  renderAll();
});

function openSettingsDialog() {
  $("#settingsTurnMode").value = state.readerTurnMode || "tap";
  renderSettingsLabels();
  $("#readerSettingsDialog").showModal();
}

$("#consoleSettingsButton").addEventListener("click", () => {
  openSettingsDialog();
});

$("#chapterSettingsButton").addEventListener("click", () => {
  $("#chapterDialog").close();
  openSettingsDialog();
});

$("#consoleLibraryButton").addEventListener("click", openReaderDialog);
$("#consoleBackgroundButton").addEventListener("click", () => $("#backgroundDialog").showModal());

$("#consolePrevChapter").addEventListener("click", () => changeChapter(-1));
$("#consoleNextChapter").addEventListener("click", () => changeChapter(1));

$("#settingsTurnMode").addEventListener("change", async (event) => {
  state.readerTurnMode = event.target.value;
  await saveState();
  renderAll();
});

document.querySelectorAll("[data-stepper]").forEach((button) => {
  button.addEventListener("click", async () => {
    const delta = Number(button.dataset.delta || 0);
    if (button.dataset.stepper === "font") {
      state.readerFontSize = Math.max(12, Math.min(32, (state.readerFontSize || 18) + delta));
    }
    if (button.dataset.stepper === "line") {
      state.readerLineHeight = Math.max(1.4, Math.min(2.4, Number(((state.readerLineHeight || 1.8) + delta * 0.1).toFixed(1))));
    }
    if (button.dataset.stepper === "margin") {
      state.readerSideMargin = Math.max(12, Math.min(32, (state.readerSideMargin || 20) + delta * 2));
    }
    await saveState();
    renderAll();
  });
});

$("#settingsFontSize")?.addEventListener("input", async (event) => {
  state.readerFontSize = Number(event.target.value);
  await saveState();
  renderAll();
});

$("#settingsLineHeight")?.addEventListener("input", async (event) => {
  state.readerLineHeight = Number(event.target.value) / 100;
  await saveState();
  renderAll();
});

$("#settingsSideMargin")?.addEventListener("input", async (event) => {
  state.readerSideMargin = Number(event.target.value);
  await saveState();
  renderAll();
});

$("#settingsNightButton").addEventListener("click", async () => {
  state.readerBg = state.readerBg === "black" ? "white" : "black";
  state.theme = state.readerBg === "black" ? "dark" : "light";
  await saveState();
  renderAll();
});

document.querySelectorAll("[data-bg]").forEach((button) => {
  button.addEventListener("click", async () => {
    state.readerBg = button.dataset.bg;
    state.theme = state.readerBg === "black" ? "dark" : "light";
    await saveState();
    renderAll();
  });
});

$("#workContent").addEventListener("click", (event) => {
  if (!activeWork()) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  if (!isPagedMode()) {
    setControlsOpen(!controlsOpen);
    return;
  }
  const rect = $("#workContent").getBoundingClientRect();
  const x = (event.clientX - rect.left) / Math.max(1, rect.width);
  if (x >= 0.25 && x <= 0.75) {
    setControlsOpen(!controlsOpen);
    return;
  }
  if (state.readerTurnMode === "swipe") return;
  if (x < 0.25) turnPage(-1);
  else if (x > 0.75) turnPage(1);
});

$("#workContent").addEventListener("scroll", () => {
  syncPageFromScroll();
  updateProgressBar();
  clearTimeout(progressTimer);
  progressTimer = setTimeout(persistProgress, 900);
  clearTimeout(snapTimer);
  if (state.readerTurnMode === "swipe" || state.readerTurnMode === "both") {
    snapTimer = setTimeout(snapToNearestPage, 90);
  }
}, { passive: true });

window.addEventListener("resize", () => {
  resetPageCache();
  requestAnimationFrame(() => {
    scrollToChapterRatio(activeWork()?.reading?.ratio || 0);
    updateProgressBar();
  });
}, { passive: true });

window.addEventListener("scroll", () => {
  if (!activeWork()) return;
  updateProgressBar();
  clearTimeout(progressTimer);
  progressTimer = setTimeout(persistProgress, 900);
}, { passive: true });

function openReaderDialog() {
  renderChapterDialog();
  $("#chapterDialog").showModal();
}

$("#openChapterDialog").addEventListener("click", openReaderDialog);
$("#barTocButton").addEventListener("click", openReaderDialog);
$("#closeChapterDialog").addEventListener("click", () => $("#chapterDialog").close());

$("#chapterList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chapter]");
  if (!button) return;
  $("#chapterDialog").close();
  goToChapter(Number(button.dataset.chapter), 0);
});

$("#bookmarkList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-bookmark]");
  if (!button) return;
  const work = activeWork();
  const bookmark = work?.bookmarks?.find((item) => item.id === button.dataset.bookmark);
  if (!bookmark) return;
  $("#chapterDialog").close();
  goToChapter(bookmark.chapterIndex, bookmark.ratio);
});

$("#manualOpen").addEventListener("click", () => {
  $("#manualForm").reset();
  $("#manualDialog").showModal();
});

$("#htmlFileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    $("#importStatus").textContent = "正在读取 HTML 文件……";
    const html = await file.text();
    await addWork(parseWorkHtml(html));
    $("#importStatus").textContent = "已经从 HTML 文件保存到书架。";
  } catch (error) {
    $("#importStatus").textContent = error.message;
  } finally {
    event.target.value = "";
  }
});

$("#exportLibraryButton").addEventListener("click", exportLibrary);

$("#libraryFileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    $("#importStatus").textContent = "正在导入书架备份……";
    await importLibraryFile(file);
    $("#importStatus").textContent = "书架备份已导入。";
  } catch (error) {
    $("#importStatus").textContent = error.message;
  } finally {
    event.target.value = "";
  }
});

$("#manualForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  const title = $("#manualTitle").value.trim();
  const content = $("#manualContent").value.trim();
  if (!title || !content) return;
  await addWork({
    title,
    author: $("#manualAuthor").value.trim(),
    sourceUrl: $("#manualUrl").value.trim(),
    summaryHtml: "",
    contentHtml: `<div id="chapters"><div class="chapter">${plainTextToHtml(content)}</div></div>`,
    metadata: { relationships: [], freeforms: [], words: `${textFromHtml(content).length} 字` }
  });
  $("#manualDialog").close();
});

boot().catch((error) => {
  $("#importStatus").textContent = `启动失败：${error.message}`;
});
