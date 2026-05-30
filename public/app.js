const DB_NAME = "pocket-reading-vault";
const DB_VERSION = 1;
const STORE = "state";
const IMPORT_API_BASE = "https://pocket-reading-vault.onrender.com";
const SUPABASE_URL = "https://bhliywysdezcykoyyozw.supabase.co";
const SUPABASE_KEY = "sb_publishable_hh04jm0Nqp3_Jq-3FTcs5w_FbuaSO0v";

const $ = (selector) => document.querySelector(selector);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const CLIENT_ID = (() => {
  try {
    const existing = localStorage.getItem("pocket-reading-vault-client-id");
    if (existing) return existing;
    const next = uid();
    localStorage.setItem("pocket-reading-vault-client-id", next);
    return next;
  } catch {
    return uid();
  }
})();

const defaultState = {
  theme: "light",
  readerFontSize: 18,
  readerFontFamily: "original",
  readerLineHeight: 1.8,
  readerSideMargin: 20,
  readerTurnMode: "tap",
  readerBg: "white",
  selectedFolder: "all",
  selectedWorkId: null,
  syncCode: "",
  pendingImports: [],
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
let selectionTimer;
let pendingImportTimer;
let snapTimer;
let persistTimer;
let pageCache = { key: "", step: 1, max: 0, total: 1, current: 1 };
let scrollRaf = 0;
let touchStart = null;
let suppressNextClick = false;
let lastReaderActionAt = 0;
let cloudTimer;
let pendingJump = null;
let controlsOpen = false;
let importDrawerOpen = false;
let cloudPanelOpen = false;
let managedWorkId = null;
let managedFolderId = null;
let longPressTimer = null;
let longPressPoint = null;
let suppressShelfClick = false;
let workDrag = null;
let cloudSession = null;
let syncingCloud = false;
let cloudRealtimeChannel = null;
let cloudRealtimeTimer = null;
let supabase;
let activeHighlightId = null;
let activeSelectionText = "";

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

function cssEscape(value = "") {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}

function textFromHtml(html = "") {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

function proxiedImageUrl(value, baseUrl = "") {
  if (!value || /^(data:|blob:)/i.test(value)) return value;
  try {
    const absolute = value.startsWith("//")
      ? `https:${value}`
      : (baseUrl ? new URL(value, baseUrl).toString() : new URL(value, location.href).toString());
    if (!/^https?:\/\//i.test(absolute)) return absolute;
    if (absolute.startsWith(`${IMPORT_API_BASE}/api/image?`)) return absolute;
    return `${IMPORT_API_BASE}/api/image?url=${encodeURIComponent(absolute)}`;
  } catch {
    return value;
  }
}

function rewriteSrcset(value = "", baseUrl = "") {
  return value.split(",").map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return "";
    const [rawUrl, ...rest] = trimmed.split(/\s+/);
    return [proxiedImageUrl(rawUrl, baseUrl), ...rest].join(" ");
  }).filter(Boolean).join(", ");
}

function normalizeImages(root, baseUrl = "") {
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src")
      || img.getAttribute("data-src")
      || img.getAttribute("data-original")
      || img.getAttribute("data-lazy-src")
      || "";
    const srcset = img.getAttribute("srcset") || "";
    if (src) img.setAttribute("src", proxiedImageUrl(src, baseUrl));
    if (!src && srcset) img.setAttribute("src", proxiedImageUrl(srcset.split(",")[0].trim().split(/\s+/)[0], baseUrl));
    if (srcset) img.setAttribute("srcset", rewriteSrcset(srcset, baseUrl));
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.removeAttribute("data-src");
    img.removeAttribute("data-original");
    img.removeAttribute("data-lazy-src");
  });
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
  if ((!work.author || work.author === "未知作者") && /\s+-\s+/.test(work.title || "")) {
    const parts = work.title.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      work.author = parts.pop();
      work.title = parts.join(" - ");
    }
  }
  if (!work.author || work.author === "未知作者") {
    work.author = "作者待补";
  }
  if (!work.metadata.words || work.metadata.words === "字数未知") {
    const count = textFromHtml(work.contentHtml || "").replace(/\s/g, "").length;
    if (count) work.metadata.words = `${count} 字`;
  }
  if (work.contentHtml && /<img\b/i.test(work.contentHtml) && !work.contentHtml.includes(`${IMPORT_API_BASE}/api/image?`)) {
    const contentRoot = document.createElement("div");
    contentRoot.innerHTML = work.contentHtml;
    normalizeImages(contentRoot, work.sourceUrl || "");
    work.contentHtml = contentRoot.innerHTML;
  }
  work.bookmarks ||= [];
  work.highlights ||= [];
  work.highlights = work.highlights.map((item) => ({
    id: item.id || uid(),
    chapterIndex: Number(item.chapterIndex || 0),
    text: item.text || "",
    color: item.color || "yellow",
    note: item.note || "",
    createdAt: item.createdAt || new Date().toISOString()
  })).filter((item) => item.text);
  work.reading ||= { chapterIndex: 0, ratio: 0 };
  work.reading.chapterIndex ||= 0;
  work.reading.ratio ||= 0;
  work.sortOrder ??= Date.parse(work.importedAt || work.updatedAt || "") || Date.now();
  return work;
}

function normalizePendingImports() {
  state.pendingImports = (state.pendingImports || [])
    .filter((item) => item?.url)
    .map((item) => ({
      url: item.url,
      tries: Number(item.tries || 0),
      lastError: item.lastError || "",
      nextTryAt: item.nextTryAt || new Date().toISOString(),
      createdAt: item.createdAt || new Date().toISOString()
    }));
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
    .sort((a, b) => (Number(b.sortOrder || 0) - Number(a.sortOrder || 0)) || (new Date(b.importedAt) - new Date(a.importedAt)));
}

function visibleFolders() {
  return state.folders.filter((folder) => folder.id !== "unfiled");
}

function renderFolders() {
  const countFor = (folderId) => {
    if (folderId === "all") return state.works.length;
    return state.works.filter((work) => (work.folderId || "unfiled") === folderId).length;
  };
  $("#folderList").innerHTML = visibleFolders().map((folder) => `
    <button class="folder-card ${state.selectedFolder === folder.id ? "active" : ""}" data-folder="${folder.id}">
      <span>${escapeHtml(folder.name)}</span>
      <small>${countFor(folder.id)} 篇</small>
    </button>
  `).join("");
}

function renderWorks() {
  const works = filteredWorks();
  $("#workList").innerHTML = works.length ? works.map((work) => {
    normalizeWork(work);
    const rel = work.metadata?.relationships?.[0] || work.customTags?.[0] || folderName(work.folderId || "unfiled");
    const chapters = getChapters(work).length;
    const chapterText = work.metadata?.chapters || "";
    const complete = /(\d+)\s*\/\s*\1/.test(chapterText) || /complete|完结/i.test(work.metadata?.status || "");
    const status = complete ? "完结" : (chapterText ? "连载" : "未知");
    const chapterIndex = Math.min(chapters - 1, Math.max(0, Number(work.reading?.chapterIndex || 0)));
    const ratio = Math.max(0, Math.min(1, Number(work.reading?.ratio || 0)));
    const progress = chapters ? Math.round(((chapterIndex + ratio) / chapters) * 100) : Math.round(ratio * 100);
    const progressText = progress > 0 ? `进度：${Math.min(100, progress)}%` : "未读";
    const customTags = (work.customTags || []).slice(0, 3);
    return `
      <button class="work-card ${state.selectedWorkId === work.id ? "active" : ""}" data-work="${work.id}">
        <h3 class="work-title-line"><span>${escapeHtml(work.title)}</span><small>${status}</small><b>›</b></h3>
        <p>${escapeHtml(work.author || "作者待补")} · ${escapeHtml(rel)}</p>
        <p>${progressText} · ${chapters} 章 · ${escapeHtml(work.metadata?.words || `${textFromHtml(work.contentHtml || "").replace(/\s/g, "").length} 字`)}</p>
        ${customTags.length ? `<div class="mini-tag-row">${customTags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
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
  $("#workAuthor").textContent = work.author || "作者待补";
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
  $("#workContent").style.setProperty("--reader-font-family", readerFontFamilyValue());
  $("#workContent").style.setProperty("--reader-line-height", `${state.readerLineHeight || 1.8}`);
  $("#workContent").style.setProperty("--reader-side-margin", `${state.readerSideMargin || 34}px`);
  resetPageCache();
  applyHighlights(work, index);

  const tags = [
    work.metadata?.rating,
    ...(work.metadata?.warnings || []),
    ...(work.metadata?.categories || []),
    ...(work.metadata?.fandoms || []),
    ...(work.metadata?.relationships || []),
    ...(work.metadata?.characters || []),
    ...(work.metadata?.freeforms || []),
    ...(work.customTags || []),
    work.metadata?.chapters
  ].filter(Boolean).slice(0, 28);
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
  const estimatedWords = work.metadata?.words || `${textFromHtml(work.contentHtml || "").replace(/\s/g, "").length} 字`;
  const groups = [
    ["分级", work.metadata?.rating],
    ["警告", work.metadata?.warnings],
    ["分类", work.metadata?.categories],
    ["Fandom", work.metadata?.fandoms],
    ["CP / 关系", work.metadata?.relationships],
    ["角色", work.metadata?.characters],
    ["其他标签", work.metadata?.freeforms],
    ["章节", work.metadata?.chapters],
    ["字数", estimatedWords],
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
  const options = [
    `<option value="unfiled">不放入文件夹</option>`,
    ...state.folders
    .filter((folder) => folder.id !== "all" && folder.id !== "unfiled")
    .map((folder) => `<option value="${folder.id}">${escapeHtml(folder.name)}</option>`)
  ].join("");
  $("#metaFolder").innerHTML = options;
  $("#manageFolderSelect").innerHTML = options;
}

function renderChapterDialog() {
  const work = activeWork();
  if (!work) return;
  const chapters = getChapters(work);
  const index = currentChapterIndex(work, chapters);
  $("#chapterProgressText").textContent = `当前：${index + 1}/${chapters.length} · ${Math.round((work.reading?.ratio || 0) * 100)}%`;
  const infoTags = [
    work.metadata?.rating,
    ...(work.metadata?.warnings || []),
    ...(work.metadata?.categories || []),
    ...(work.metadata?.fandoms || []),
    ...(work.metadata?.relationships || []),
    ...(work.metadata?.characters || []),
    ...(work.metadata?.freeforms || [])
  ].filter(Boolean);
  $("#chapterWorkInfo").innerHTML = `
    <h3>${escapeHtml(work.title || "作品信息")}</h3>
    <p>${escapeHtml(work.author || "作者待补")}</p>
    ${infoTags.length ? `<div class="tag-row">${infoTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    ${work.summaryHtml ? `<section class="summary-in-dialog"><b>简介</b><div>${work.summaryHtml}</div></section>` : ""}
  `;
  $("#chapterList").innerHTML = chapters.map((chapter, chapterIndex) => `
    <button class="chapter-item ${chapterIndex === index ? "active" : ""}" data-chapter="${chapterIndex}">
      <span>${escapeHtml(chapter.title)}</span>
      <small>第 ${chapterIndex + 1} 章</small>
    </button>
  `).join("");
  $("#bookmarkList").innerHTML = work.bookmarks.length ? work.bookmarks.map((bookmark) => `
    <div class="chapter-item note-row" data-bookmark="${bookmark.id}">
      <button type="button" class="note-jump" data-bookmark-jump="${bookmark.id}">
        <span>${escapeHtml(bookmark.label)}</span>
        <small>${new Date(bookmark.createdAt).toLocaleString()}</small>
      </button>
      <button type="button" class="mini-delete" data-delete-bookmark="${bookmark.id}">删除</button>
    </div>
  `).join("") : `<p class="status">还没有书签。</p>`;
  $("#highlightList").innerHTML = work.highlights.length ? work.highlights.map((highlight) => `
    <div class="chapter-item note-row" data-highlight-row="${highlight.id}">
      <button type="button" class="note-jump" data-highlight-jump="${highlight.id}">
        <span><mark class="reader-highlight ${escapeHtml(highlight.color || "yellow")}">${escapeHtml(highlight.text)}</mark></span>
        <small>${highlight.note ? escapeHtml(highlight.note) : "无备注"} · 第 ${Number(highlight.chapterIndex || 0) + 1} 章</small>
      </button>
      <button type="button" class="mini-delete" data-edit-highlight="${highlight.id}">备注</button>
      <button type="button" class="mini-delete" data-delete-highlight="${highlight.id}">删除</button>
    </div>
  `).join("") : `<p class="status">还没有高亮。</p>`;
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
  document.documentElement.style.setProperty("--reader-font-family", readerFontFamilyValue());
  document.documentElement.style.setProperty("--reader-line-height", `${state.readerLineHeight || 1.8}`);
  document.documentElement.style.setProperty("--reader-side-margin", `${state.readerSideMargin || 34}px`);
  renderFolders();
  renderWorks();
  renderReader();
  renderMetaOptions();
  renderSettingsLabels();
  renderFontChoices();
  renderBackgroundChoices();
}

function readerFontFamilyValue() {
  const map = {
    original: `inherit`,
    serif: `"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", Georgia, serif`,
    system: `-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`,
    kaiti: `"Kaiti SC", "STKaiti", "KaiTi", "楷体", serif`,
    wenkai: `"LXGW WenKai", "霞鹜文楷", "PingFang SC", "Microsoft YaHei", sans-serif`
  };
  return map[state.readerFontFamily || "original"] || map.original;
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

function renderFontChoices() {
  document.querySelectorAll("[data-font-family]").forEach((button) => {
    button.classList.toggle("active", button.dataset.fontFamily === (state.readerFontFamily || "original"));
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

function safeFilename(name = "work") {
  return String(name).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "work";
}

function workById(id) {
  return state.works.find((work) => work.id === id);
}

function downloadWork(work) {
  const chapters = getChapters(work);
  const chapterHtml = chapters.map((chapter, index) => `
    <section>
      <h2>${escapeHtml(chapter.title || `第 ${index + 1} 章`)}</h2>
      ${chapter.html || ""}
    </section>
  `).join("\n");
  const doc = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(work.title || "作品")}</title>
  <style>
    body{max-width:760px;margin:0 auto;padding:32px 20px;font-family:Georgia,"Songti SC",serif;line-height:1.8;color:#111}
    h1,h2{line-height:1.35}
    .meta{color:#666;border-bottom:1px solid #eee;padding-bottom:18px;margin-bottom:28px}
    img{max-width:100%;height:auto}
  </style>
</head>
<body>
  <h1>${escapeHtml(work.title || "未命名作品")}</h1>
  <p class="meta">${escapeHtml(work.author || "作者待补")} · ${escapeHtml(work.metadata?.words || `${textFromHtml(work.contentHtml || "").replace(/\s/g, "").length} 字`)}</p>
  ${work.summaryHtml ? `<section><h2>简介</h2>${work.summaryHtml}</section>` : ""}
  ${chapterHtml}
</body>
</html>`;
  downloadTextFile(`${safeFilename(work.title)}.html`, doc, "text/html;charset=utf-8");
}

async function deleteWorkById(id) {
  const work = workById(id);
  if (!work || !confirm(`删除《${work.title}》？`)) return;
  state.works = state.works.filter((item) => item.id !== id);
  if (state.selectedWorkId === id) state.selectedWorkId = null;
  await saveState();
  renderAll();
}

function orderedVisibleWorks() {
  const works = filteredWorks();
  if (works.some((work) => work.sortOrder == null)) {
    works.forEach((work, index) => {
      work.sortOrder = Date.now() - index;
    });
  }
  return works;
}

async function moveWorkInList(id, delta, { reopen = true } = {}) {
  const works = orderedVisibleWorks();
  const index = works.findIndex((work) => work.id === id);
  const targetIndex = index + delta;
  if (index < 0 || targetIndex < 0 || targetIndex >= works.length) return;
  const current = works[index];
  const target = works[targetIndex];
  const currentOrder = Number(current.sortOrder || 0);
  current.sortOrder = Number(target.sortOrder || 0);
  target.sortOrder = currentOrder;
  current.updatedAt = new Date().toISOString();
  target.updatedAt = current.updatedAt;
  await saveState();
  renderAll();
  if (reopen) openWorkManageDialog(id);
}

async function moveFolderInList(id, delta) {
  if (!id || id === "all" || id === "unfiled") return;
  const order = visibleFolders().map((folder) => folder.id).filter((folderId) => folderId !== "all");
  const index = order.indexOf(id);
  const targetIndex = index + delta;
  if (index < 0 || targetIndex < 0 || targetIndex >= order.length) return;
  [order[index], order[targetIndex]] = [order[targetIndex], order[index]];
  const fixed = state.folders.filter((folder) => folder.id === "all" || folder.id === "unfiled");
  const custom = order.map((folderId) => state.folders.find((folder) => folder.id === folderId)).filter(Boolean);
  state.folders = [fixed.find((folder) => folder.id === "all") || defaultState.folders[0], ...custom, fixed.find((folder) => folder.id === "unfiled") || defaultState.folders[1]];
  await saveState();
  renderAll();
  openFolderManageDialog(id);
}

function renderManageTags(work) {
  $("#manageTagList").innerHTML = (work.customTags || []).length
    ? work.customTags.map((tag) => `<button type="button" data-remove-tag="${escapeHtml(tag)}">${escapeHtml(tag)} ×</button>`).join("")
    : `<span class="empty-tag-note">还没有自定义 tag</span>`;
}

function refreshFolderManageButtons() {
  const order = visibleFolders().map((folder) => folder.id).filter((id) => id !== "all");
  const index = order.indexOf(managedFolderId);
  $("#manageFolderLeftButton").disabled = managedFolderId === "all" || index <= 0;
  $("#manageFolderRightButton").disabled = managedFolderId === "all" || index < 0 || index >= order.length - 1;
}

function openWorkManageDialog(id) {
  const work = workById(id);
  if (!work) return;
  managedWorkId = id;
  $("#manageWorkTitle").textContent = "整理";
  $("#manageFolderSelect").value = work.folderId || "unfiled";
  $("#manageTagInput").value = "";
  renderManageTags(work);
  if (!$("#workManageDialog").open) $("#workManageDialog").showModal();
}

function openFolderManageDialog(id) {
  const folder = state.folders.find((item) => item.id === id);
  if (!folder) return;
  managedFolderId = id;
  const locked = id === "all";
  $("#manageFolderTitle").textContent = "文件夹";
  $("#manageDeleteFolderButton").disabled = locked;
  refreshFolderManageButtons();
  if (!$("#folderManageDialog").open) $("#folderManageDialog").showModal();
}

function startLongPress(event, callback) {
  clearTimeout(longPressTimer);
  longPressPoint = { x: event.clientX, y: event.clientY };
  longPressTimer = setTimeout(() => {
    suppressShelfClick = true;
    callback();
  }, 560);
}

function cancelLongPress() {
  clearTimeout(longPressTimer);
  longPressPoint = null;
}

function cancelLongPressOnMove(event) {
  if (!longPressPoint) return;
  if (Math.abs(event.clientX - longPressPoint.x) > 8 || Math.abs(event.clientY - longPressPoint.y) > 8) {
    cancelLongPress();
  }
}

function startWorkPress(event, id) {
  clearTimeout(longPressTimer);
  longPressPoint = { x: event.clientX, y: event.clientY };
  workDrag = { id, active: false, moved: false, lastY: event.clientY };
  longPressTimer = setTimeout(() => {
    suppressShelfClick = true;
    if (!workDrag || workDrag.id !== id) return;
    workDrag.active = true;
    document.body.classList.add("shelf-dragging");
    document.querySelector(`[data-work="${cssEscape(id)}"]`)?.classList.add("dragging");
  }, 360);
}

async function moveDraggedWork(event) {
  if (!workDrag) return;
  if (!workDrag.active) {
    const movedEarly = Math.abs(event.clientX - longPressPoint.x) > 8 || Math.abs(event.clientY - longPressPoint.y) > 8;
    if (movedEarly) cancelWorkPress();
    return;
  }
  event.preventDefault();
  const dy = event.clientY - workDrag.lastY;
  if (Math.abs(dy) < 42) return;
  workDrag.moved = true;
  workDrag.lastY = event.clientY;
  await moveWorkInList(workDrag.id, dy > 0 ? 1 : -1, { reopen: false });
  document.body.classList.add("shelf-dragging");
  document.querySelector(`[data-work="${cssEscape(workDrag.id)}"]`)?.classList.add("dragging");
}

function finishWorkPress() {
  clearTimeout(longPressTimer);
  const drag = workDrag;
  workDrag = null;
  longPressPoint = null;
  document.body.classList.remove("shelf-dragging");
  document.querySelectorAll(".work-card.dragging").forEach((card) => card.classList.remove("dragging"));
  if (!drag) return;
  if (drag.active && !drag.moved) openWorkManageDialog(drag.id);
  if (drag.active) suppressShelfClick = true;
}

function cancelWorkPress() {
  clearTimeout(longPressTimer);
  workDrag = null;
  longPressPoint = null;
  document.body.classList.remove("shelf-dragging");
  document.querySelectorAll(".work-card.dragging").forEach((card) => card.classList.remove("dragging"));
}

function enableBackdropClose(selector) {
  const dialog = $(selector);
  if (!dialog) return;
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
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
  state.readerFontFamily = nextState.readerFontFamily || state.readerFontFamily;
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
  const connected = Boolean(state.syncCode);
  if (!supabase) {
    $("#cloudCode").readOnly = true;
    $("#cloudLoginButton").classList.add("hidden");
    $("#cloudStartButton").classList.add("hidden");
    $("#cloudGenerateButton").classList.add("hidden");
    $("#cloudPasswordLoginButton").classList.add("hidden");
    $("#cloudSignupButton").classList.add("hidden");
    $("#cloudSetPasswordButton").classList.add("hidden");
    $("#cloudLogoutButton").classList.add("hidden");
    $("#cloudQuickSyncButton").disabled = true;
    $("#cloudUploadButton").disabled = true;
    $("#cloudDownloadButton").disabled = true;
    $("#cloudUser").textContent = "云端暂不可用";
    setCloudStatus("云端模块没加载成功，但本机导入和阅读可以继续用。");
    return;
  }
  $("#cloudCode").readOnly = connected;
  $("#cloudCode").value = state.syncCode || $("#cloudCode").value || "";
  $("#cloudStartButton").classList.toggle("hidden", connected);
  $("#cloudGenerateButton").classList.toggle("hidden", connected);
  $("#cloudLoginButton").classList.add("hidden");
  $("#cloudPasswordLoginButton").classList.add("hidden");
  $("#cloudSignupButton").classList.add("hidden");
  $("#cloudSetPasswordButton").classList.add("hidden");
  $("#cloudLogoutButton").classList.toggle("hidden", !connected);
  $("#cloudQuickSyncButton").disabled = !connected;
  $("#cloudUploadButton").disabled = !connected;
  $("#cloudDownloadButton").disabled = !connected;
  $("#cloudUser").textContent = connected ? `同步码：${state.syncCode}` : "未连接同步码";
  $("#cloudAccountDetails").open = !connected;
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
  merged.readerFontFamily = localState.readerFontFamily || cloudState.readerFontFamily || defaultState.readerFontFamily;
  merged.readerLineHeight = localState.readerLineHeight || cloudState.readerLineHeight || defaultState.readerLineHeight;
  merged.readerSideMargin = localState.readerSideMargin || cloudState.readerSideMargin || defaultState.readerSideMargin;
  merged.readerTurnMode = localState.readerTurnMode || cloudState.readerTurnMode || defaultState.readerTurnMode;
  merged.readerBg = localState.readerBg || cloudState.readerBg || defaultState.readerBg;
  merged.theme = localState.theme || cloudState.theme || defaultState.theme;
  merged.updatedAt = new Date().toISOString();
  return merged;
}

async function getCloudState() {
  if (!state.syncCode) return null;
  const { data, error } = await supabase
    .from("shared_library_states")
    .select("state, updated_at")
    .eq("sync_code", state.syncCode)
    .maybeSingle();
  if (error) throw error;
  return data?.state ? cloneLibraryState(data.state) : null;
}

async function saveCloudNow({ silent = false } = {}) {
  if (!state.syncCode || syncingCloud) return;
  syncingCloud = true;
  if (!silent) setCloudStatus("正在上传云端……");
  try {
    const payload = cloneLibraryState(state);
    payload._lastWriter = CLIENT_ID;
    payload._lastWriterAt = new Date().toISOString();
    const { error } = await supabase.from("shared_library_states").upsert({
      sync_code: state.syncCode,
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
  if (!state.syncCode || syncingCloud) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => saveCloudNow({ silent: true }), 1200);
}

function stopCloudRealtime() {
  clearTimeout(cloudRealtimeTimer);
  cloudRealtimeTimer = null;
  if (cloudRealtimeChannel && supabase) {
    supabase.removeChannel(cloudRealtimeChannel);
  }
  cloudRealtimeChannel = null;
}

function startCloudRealtime() {
  stopCloudRealtime();
  if (!supabase || !state.syncCode) return;
  cloudRealtimeChannel = supabase
    .channel(`shared-library-state-${state.syncCode}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "shared_library_states",
        filter: `sync_code=eq.${state.syncCode}`
      },
      (payload) => {
        const remoteState = payload.new?.state;
        if (!remoteState || remoteState._lastWriter === CLIENT_ID || syncingCloud) return;
        clearTimeout(cloudRealtimeTimer);
        cloudRealtimeTimer = setTimeout(async () => {
          try {
            syncingCloud = true;
            state = mergeLibraryState(state, cloneLibraryState(remoteState));
            await dbSet("library", state);
            syncingCloud = false;
            renderAll();
            setCloudStatus(`已自动同步：${new Date().toLocaleTimeString()}`);
          } catch (error) {
            syncingCloud = false;
            setCloudStatus(`自动同步失败：${error.message}`);
          }
        }, 350);
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setCloudStatus("实时同步已开启。");
      if (status === "CHANNEL_ERROR") setCloudStatus("实时同步暂不可用，请确认 Supabase Realtime 已开启。");
    });
}

async function loadCloudIntoLocal({ merge = true } = {}) {
  if (!state.syncCode) return;
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
  renderCloudPanel();
  if (state.syncCode) {
    setCloudStatus("同步码已连接。");
    startCloudRealtime();
    if (initial) await loadCloudIntoLocal({ merge: true });
  } else {
    stopCloudRealtime();
    setCloudStatus("输入同一个同步码，手机和电脑会自动同步。");
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
    sortOrder: existing?.sortOrder || Date.now(),
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
    removePendingImport(url);
  } catch (error) {
    if (error.message === "STATIC_PAGE") {
      throw new Error("这个网页还没有连接到导入后端。请上传包含 Render 地址的新版 app.js。");
    }
    if (error instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(error.message)) {
      throw new Error("导入后端暂时没连上。Render 第一次启动可能要等 30 秒左右；如果一直这样，请确认 Render 服务已部署并在运行。");
    }
    if (/403|429|限流|拒绝访问/i.test(error.message)) {
      await addPendingImport(url, error.message);
      throw new Error("原站现在挡住了这次读取。我已把链接放进后台导入，会自动重试；你不用反复点。");
    }
    throw error;
  }
}

async function addPendingImport(url, message = "") {
  normalizePendingImports();
  const existing = state.pendingImports.find((item) => item.url === url);
  const tries = existing ? existing.tries + 1 : 1;
  const delayMinutes = Math.min(60, Math.max(5, tries * 5));
  const nextTryAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  const item = {
    url,
    tries,
    lastError: message,
    nextTryAt,
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  state.pendingImports = existing
    ? state.pendingImports.map((pending) => pending.url === url ? item : pending)
    : [item, ...state.pendingImports];
  await saveState();
  schedulePendingImports();
}

function removePendingImport(url) {
  if (!state.pendingImports?.length) return;
  state.pendingImports = state.pendingImports.filter((item) => item.url !== url);
  saveState();
}

function schedulePendingImports() {
  clearTimeout(pendingImportTimer);
  normalizePendingImports();
  if (!state.pendingImports.length) return;
  const now = Date.now();
  const next = Math.min(...state.pendingImports.map((item) => new Date(item.nextTryAt).getTime() || now));
  pendingImportTimer = setTimeout(runPendingImports, Math.max(3000, next - now));
}

async function runPendingImports() {
  normalizePendingImports();
  const due = state.pendingImports.filter((item) => new Date(item.nextTryAt).getTime() <= Date.now());
  if (!due.length) return schedulePendingImports();
  for (const item of due.slice(0, 1)) {
    try {
      $("#importStatus").textContent = "正在后台重试导入……";
      const response = await fetch(`${IMPORT_API_BASE}/api/import?url=${encodeURIComponent(item.url)}`, {
        headers: { accept: "application/json" }
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "导入失败。");
      await addWork(payload);
      state.pendingImports = state.pendingImports.filter((pending) => pending.url !== item.url);
      await saveState();
      $("#importStatus").textContent = "后台导入成功，已经保存到书架。";
    } catch (error) {
      await addPendingImport(item.url, error.message);
      $("#importStatus").textContent = "后台导入暂时没成功，会继续自动重试。";
    }
  }
  schedulePendingImports();
}

function plainTextToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function parseWorkHtml(html, sourceUrl = "") {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const cleanText = (value = "") => value.replace(/\s+/g, " ").trim();
  const titleParts = (value = "") => {
    const clean = cleanText(value)
      .replace(/\s*\|\s*Archive[\s\S]*$/i, "")
      .replace(/\s*-\s*Archive of Our Own[\s\S]*$/i, "")
      .replace(/\s*-\s*AO3[\s\S]*$/i, "");
    const parts = clean.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const author = parts.at(-1);
      const title = parts.slice(0, -1).filter((part) => !/^chapter\s+\d+/i.test(part)).join(" - ");
      return { title: title || parts[0], author };
    }
    return { title: clean, author: "" };
  };
  const text = (...selectors) => {
    for (const selector of selectors) {
      const value = cleanText(doc.querySelector(selector)?.textContent || "");
      if (value) return value;
    }
    return "";
  };
  const uniq = (items) => [...new Set(items.map(cleanText).filter(Boolean))];
  const ddByLabel = (patterns) => {
    const labels = Array.isArray(patterns) ? patterns : [patterns];
    for (const dt of doc.querySelectorAll("dt")) {
      const label = cleanText(dt.textContent).replace(/:$/, "");
      if (!labels.some((pattern) => pattern.test(label))) continue;
      let node = dt.nextElementSibling;
      while (node && node.tagName?.toLowerCase() !== "dd") node = node.nextElementSibling;
      if (node) return node;
    }
    return null;
  };
  const tags = (selectors, labels = []) => {
    const nodes = [];
    for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
      nodes.push(...doc.querySelectorAll(selector));
    }
    const labelNode = labels.length ? ddByLabel(labels) : null;
    if (labelNode) nodes.push(labelNode);
    const values = [];
    for (const node of nodes) {
      const linked = [...node.querySelectorAll("a, li")].map((item) => cleanText(item.textContent)).filter(Boolean);
      values.push(...(linked.length ? linked : cleanText(node.textContent).split(/,\s*/)));
    }
    return uniq(values);
  };
  const metaText = (selectors, labels = []) => {
    const direct = text(...(Array.isArray(selectors) ? selectors : [selectors]));
    if (direct) return direct;
    const labelNode = labels.length ? ddByLabel(labels) : null;
    return cleanText(labelNode?.textContent || "");
  };
  let chapters = doc.querySelector("#chapters, .chapters, #workskin, main");
  if (!chapters) {
    chapters = [...doc.querySelectorAll(".userstuff")]
      .sort((a, b) => cleanText(b.textContent).length - cleanText(a.textContent).length)[0];
  }
  if (!chapters) throw new Error("这个 HTML 里没有找到 正文。请下载作品的 Entire Work / HTML 文件。");
  chapters.querySelectorAll("script").forEach((node) => node.remove());
  normalizeImages(chapters, sourceUrl);
  const fromTitleTag = titleParts(text("title"));
  let title = text("h2.title.heading", "h1.title", "h1") || fromTitleTag.title;
  title = title
    .replace(/\s+-\s+Chapter\s+\d+[\s\S]*$/i, "")
    .replace(/\s*\|\s*Archive[\s\S]*$/i, "")
    .replace(/\s*-\s*Archive of Our Own[\s\S]*$/i, "");
  let author = text("h3.byline.heading", ".byline a", ".byline", "a[rel='author']", "a[rel='author'] span", "[class*='author'] a", "[class*='author']")
    || doc.querySelector("meta[name='author']")?.getAttribute("content")
    || fromTitleTag.author;
  author = cleanText(author)
    .replace(/^by\s+/i, "");
  if (!author && /\s+-\s+/.test(title)) {
    const parts = title.split(/\s+-\s+/);
    author = parts.pop() || "";
    title = parts.join(" - ");
  }
  const summaryHtml = doc.querySelector("blockquote.userstuff.summary, .summary blockquote, section.summary, #summary")?.innerHTML || "";
  const plainWords = cleanText(chapters.textContent || "").replace(/\s/g, "").length;
  const chaptersCount = chapters.querySelectorAll(".chapter, [id^='chapter-']").length || 1;
  return {
    title: title || "未命名作品",
    author: author || "作者待补",
    sourceUrl,
    summaryHtml,
    contentHtml: chapters.outerHTML,
    metadata: {
      rating: metaText(["dd.rating.tags", "dd[class*='rating']"], [/^rating$/i, /^分级$/]),
      categories: tags(["dd.category.tags", "dd[class*='category']"], [/^category$/i, /^分类$/]),
      fandoms: tags(["dd.fandom.tags", "dd[class*='fandom']"], [/^fandoms?$/i, /^原作$/]),
      warnings: tags(["dd.warning.tags", "dd[class*='warning']"], [/^archive warnings?$/i, /^warnings?$/i, /^警告$/]),
      relationships: tags(["dd.relationship.tags", "dd[class*='relationship']"], [/^relationships?$/i, /^关系$/i, /^CP$/i]),
      characters: tags(["dd.character.tags", "dd[class*='character']"], [/^characters?$/i, /^角色$/]),
      freeforms: tags(["dd.freeform.tags", "dd[class*='freeform']", "dd[class*='additional']"], [/^additional tags?$/i, /^freeforms?$/i, /^其他标签$/]),
      words: metaText(["dd.words", "dd[class*='words']"], [/^words$/i, /^字数$/]) || `${plainWords} 字`,
      chapters: metaText(["dd.chapters", "dd[class*='chapters']"], [/^chapters$/i, /^章节$/]) || `${chaptersCount}/${chaptersCount}`,
      status: metaText(["dd.status", "dd[class*='status']"], [/^status$/i, /^状态$/]),
      language: metaText(["dd.language", "dd[class*='language']"], [/^language$/i, /^语言$/])
    }
  };
}

function normalizeImportedWorkPayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("这个采集文件格式不对。");
  if (!payload.contentHtml) throw new Error("这个采集文件里没有正文。");
  const contentRoot = document.createElement("div");
  contentRoot.innerHTML = payload.contentHtml;
  normalizeImages(contentRoot, payload.sourceUrl || "");
  return {
    title: payload.title || "未命名作品",
    author: payload.author || "作者待补",
    sourceUrl: payload.sourceUrl || "",
    summaryHtml: payload.summaryHtml || "",
    contentHtml: contentRoot.innerHTML,
    metadata: {
      rating: payload.metadata?.rating || "",
      categories: payload.metadata?.categories || [],
      fandoms: payload.metadata?.fandoms || [],
      warnings: payload.metadata?.warnings || [],
      relationships: payload.metadata?.relationships || [],
      characters: payload.metadata?.characters || [],
      freeforms: payload.metadata?.freeforms || [],
      words: payload.metadata?.words || `${textFromHtml(contentRoot.innerHTML).replace(/\s/g, "").length} 字`,
      chapters: payload.metadata?.chapters || "",
      status: payload.metadata?.status || "",
      language: payload.metadata?.language || ""
    }
  };
}

async function parseImportedWorkFile(file) {
  const text = await file.text();
  const isJson = /\.json$/i.test(file.name) || /^\s*\{/.test(text);
  if (isJson) return normalizeImportedWorkPayload(JSON.parse(text));
  return parseWorkHtml(text);
}

function createCollectorBookmarklet() {
  const script = `(() => {
    const clean = (value = "") => value.replace(/\\s+/g, " ").trim();
    const q = (selector, root = document) => root.querySelector(selector);
    const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
    const text = (...selectors) => {
      for (const selector of selectors) {
        const value = clean(q(selector)?.textContent || "");
        if (value) return value;
      }
      return "";
    };
    const ddByLabel = (patterns) => {
      for (const dt of qa("dt")) {
        const label = clean(dt.textContent).replace(/:$/, "");
        if (!patterns.some((pattern) => pattern.test(label))) continue;
        let node = dt.nextElementSibling;
        while (node && node.tagName?.toLowerCase() !== "dd") node = node.nextElementSibling;
        if (node) return node;
      }
      return null;
    };
    const uniq = (items) => [...new Set(items.map(clean).filter(Boolean))];
    const tags = (selectors, labels = []) => {
      const nodes = [];
      for (const selector of selectors) nodes.push(...qa(selector));
      const labeled = labels.length ? ddByLabel(labels) : null;
      if (labeled) nodes.push(labeled);
      const values = [];
      for (const node of nodes) {
        const linked = qa("a, li", node).map((item) => clean(item.textContent)).filter(Boolean);
        values.push(...(linked.length ? linked : clean(node.textContent).split(/,\\s*/)));
      }
      return uniq(values);
    };
    const metaText = (selectors, labels = []) => {
      const direct = text(...selectors);
      if (direct) return direct;
      return clean(ddByLabel(labels)?.textContent || "");
    };
    let chapters = q("#chapters, .chapters, #workskin, main") || qa(".userstuff").sort((a, b) => clean(b.textContent).length - clean(a.textContent).length)[0];
    if (!chapters) return alert("没有找到正文，请确认在作品全文页。");
    chapters = chapters.cloneNode(true);
    qa("script, form", chapters).forEach((node) => node.remove());
    qa("img", chapters).forEach((img) => {
      const src = img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src");
      if (src) img.setAttribute("src", new URL(src, location.href).href);
      const srcset = img.getAttribute("srcset");
      if (!src && srcset) img.setAttribute("src", new URL(srcset.split(",")[0].trim().split(/\\s+/)[0], location.href).href);
      img.removeAttribute("data-src");
      img.removeAttribute("data-original");
      img.removeAttribute("data-lazy-src");
    });
    let title = text("h2.title.heading", "h1.title", "h1", "title")
      .replace(/\\s+-\\s+Chapter\\s+\\d+[\\s\\S]*$/i, "")
      .replace(/\\s*\\|\\s*Archive[\\s\\S]*$/i, "")
      .replace(/\\s*-\\s*Archive of Our Own[\\s\\S]*$/i, "");
    let author = text("h3.byline.heading", ".byline", "a[rel='author']");
    if (!author && /\\s+-\\s+/.test(title)) {
      const parts = title.split(/\\s+-\\s+/);
      author = parts.pop() || "";
      title = parts.join(" - ");
    }
    const payload = {
      collectorVersion: 1,
      title: title || "未命名作品",
      author: author.replace(/^by\\s+/i, "") || "作者待补",
      sourceUrl: location.href,
      summaryHtml: q("blockquote.userstuff.summary, .summary blockquote, section.summary, #summary")?.innerHTML || "",
      contentHtml: chapters.outerHTML,
      metadata: {
        rating: metaText(["dd.rating.tags", "dd[class*='rating']"], [/^rating$/i, /^分级$/]),
        categories: tags(["dd.category.tags", "dd[class*='category']"], [/^category$/i, /^分类$/]),
        fandoms: tags(["dd.fandom.tags", "dd[class*='fandom']"], [/^fandoms?$/i, /^原作$/]),
        warnings: tags(["dd.warning.tags", "dd[class*='warning']"], [/^archive warnings?$/i, /^warnings?$/i, /^警告$/]),
        relationships: tags(["dd.relationship.tags", "dd[class*='relationship']"], [/^relationships?$/i, /^关系$/i, /^CP$/i]),
        characters: tags(["dd.character.tags", "dd[class*='character']"], [/^characters?$/i, /^角色$/]),
        freeforms: tags(["dd.freeform.tags", "dd[class*='freeform']", "dd[class*='additional']"], [/^additional tags?$/i, /^freeforms?$/i, /^其他标签$/]),
        words: metaText(["dd.words", "dd[class*='words']"], [/^words$/i, /^字数$/]) || clean(chapters.textContent).replace(/\\s/g, "").length + " 字",
        chapters: metaText(["dd.chapters", "dd[class*='chapters']"], [/^chapters$/i, /^章节$/]),
        status: metaText(["dd.status", "dd[class*='status']"], [/^status$/i, /^状态$/]),
        language: metaText(["dd.language", "dd[class*='language']"], [/^language$/i, /^语言$/])
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (payload.title || "work").replace(/[\\\\/:*?"<>|]/g, "_").slice(0, 80) + ".reading-vault.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  })();`;
  return `javascript:${encodeURIComponent(script)}`;
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
  lastReaderActionAt = Date.now();
  hideSelectionToolbar();
  if (controlsOpen) setControlsOpen(false);
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
    state.readerFontFamily,
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

function scheduleReaderScrollUpdate() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    syncPageFromScroll();
    updateProgressBar();
  });
}

function canUseSwipeTurn() {
  return isPagedMode() && (state.readerTurnMode === "swipe" || state.readerTurnMode === "both");
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
  $("#consoleMenuProgress").textContent = `目录 · ${Math.round(ratio * 100)}%`;
  const bookmarkCount = (work.bookmarks || []).length + (work.highlights || []).length;
  $("#consoleBookmarkCount").textContent = String(bookmarkCount);
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
  document.documentElement.requestFullscreen()
    .then(() => screen.orientation?.lock?.("portrait").catch(() => {}))
    .catch(() => {});
}

function exitReadingFullscreen() {
  screen.orientation?.unlock?.();
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
  for (const highlight of highlights) markFirstText(root, highlight);
}

function markFirstText(root, highlight) {
  const text = typeof highlight === "string" ? highlight : highlight.text;
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
  span.className = `reader-highlight ${highlight.color || "yellow"}`;
  if (highlight.id) span.dataset.highlightId = highlight.id;
  if (highlight.note) span.title = highlight.note;
  range.surroundContents(span);
  return true;
}

function selectedReaderText() {
  const work = activeWork();
  const selection = window.getSelection();
  if (!work || !selection || selection.isCollapsed) return "";
  const content = $("#workContent");
  if (!content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) return "";
  return selection.toString().replace(/\s+/g, " ").trim();
}

async function addHighlightFromSelection(color = "yellow", note = "") {
  const work = activeWork();
  const selection = window.getSelection();
  const text = selectedReaderText();
  if (!text || text.length < 2) return;
  normalizeWork(work);
  const chapterIndex = currentChapterIndex(work);
  work.highlights.push({ id: uid(), chapterIndex, text, color, note, createdAt: new Date().toISOString() });
  work.updatedAt = new Date().toISOString();
  selection?.removeAllRanges();
  hideSelectionToolbar();
  await saveState();
  renderReader();
}

async function removeHighlight(id) {
  const work = activeWork();
  if (!work) return;
  work.highlights = (work.highlights || []).filter((item) => item.id !== id);
  work.updatedAt = new Date().toISOString();
  activeHighlightId = null;
  hideSelectionToolbar();
  await saveState();
  renderAll();
}

async function removeBookmark(id) {
  const work = activeWork();
  if (!work) return;
  work.bookmarks = (work.bookmarks || []).filter((item) => item.id !== id);
  work.updatedAt = new Date().toISOString();
  await saveState();
  renderAll();
}

async function editHighlightNote(id) {
  const work = activeWork();
  const highlight = work?.highlights?.find((item) => item.id === id);
  if (!highlight) return;
  const note = prompt("给这条高亮写备注", highlight.note || "");
  if (note === null) return;
  highlight.note = note.trim();
  work.updatedAt = new Date().toISOString();
  await saveState();
  renderAll();
}

function hideSelectionToolbar() {
  const toolbar = $("#selectionToolbar");
  toolbar?.classList.add("hidden");
  activeSelectionText = "";
}

function showSelectionToolbarFromRect(rect) {
  const toolbar = $("#selectionToolbar");
  if (!toolbar || !rect) return;
  const width = toolbar.offsetWidth || 280;
  const left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.left + rect.width / 2 - width / 2));
  const top = Math.max(12, rect.top - 56);
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
  toolbar.classList.remove("hidden");
}

function updateSelectionToolbar() {
  if (Date.now() - lastReaderActionAt < 650) return hideSelectionToolbar();
  if (!document.body.classList.contains("reading")) return hideSelectionToolbar();
  const selection = window.getSelection();
  const text = selectedReaderText();
  if (!selection || !text || text.length < 2) return hideSelectionToolbar();
  activeHighlightId = null;
  activeSelectionText = text;
  const range = selection.getRangeAt(0);
  showSelectionToolbarFromRect(range.getBoundingClientRect());
}

function showHighlightToolbar(mark) {
  activeHighlightId = mark.dataset.highlightId || null;
  activeSelectionText = mark.textContent?.replace(/\s+/g, " ").trim() || "";
  const selection = window.getSelection();
  selection?.removeAllRanges();
  showSelectionToolbarFromRect(mark.getBoundingClientRect());
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
  normalizePendingImports();
  if (!state.folders.some((folder) => folder.id === "all")) state.folders.unshift(defaultState.folders[0]);
  if (!state.folders.some((folder) => folder.id === "unfiled")) state.folders.push(defaultState.folders[1]);
  if (state.selectedFolder === "unfiled") state.selectedFolder = "all";
  renderAll();
  schedulePendingImports();
  if (supabase) {
    await refreshCloudSession({ initial: true });
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
  if (importDrawerOpen) cloudPanelOpen = false;
  renderAll();
});

$("#searchToggleButton").addEventListener("click", () => {
  $("#searchInput").focus();
  $("#searchInput").scrollIntoView({ block: "center", behavior: "smooth" });
});

$("#cloudPanelButton").addEventListener("click", () => {
  cloudPanelOpen = !cloudPanelOpen;
  if (cloudPanelOpen) importDrawerOpen = false;
  renderAll();
});

document.addEventListener("pointerdown", (event) => {
  if (!importDrawerOpen && !cloudPanelOpen) return;
  const target = event.target;
  if (
    target.closest(".import-drawer") ||
    target.closest(".cloud-section") ||
    target.closest("#importDrawerButton") ||
    target.closest("#cloudPanelButton")
  ) return;
  importDrawerOpen = false;
  cloudPanelOpen = false;
  renderAll();
}, { passive: true });

async function finishCloudSignIn(session, message = "已登录云端。") {
  cloudSession = session;
  renderCloudPanel();
  startCloudRealtime();
  await loadCloudIntoLocal({ merge: true });
  setCloudStatus(message);
}

function cloudCredentials() {
  const email = $("#cloudEmail").value.trim();
  const password = $("#cloudPassword").value;
  if (!email) {
    setCloudStatus("先输入邮箱。");
    return null;
  }
  if (!password || password.length < 6) {
    setCloudStatus("密码至少 6 位。");
    return null;
  }
  return { email, password };
}

function cloudErrorText(error) {
  const message = error?.message || "未知错误";
  if (/invalid login credentials/i.test(message)) {
    return "邮箱或密码不对，或者这个邮箱还没注册/没确认。第一次用请点「新建账号」，注册邮件确认后再密码登录。";
  }
  if (/email not confirmed/i.test(message)) {
    return "邮箱还没确认。请先打开注册邮件确认，再回这里密码登录。";
  }
  if (/user already registered|already registered/i.test(message)) {
    return "这个邮箱已经注册过了，直接点「密码登录」。如果忘了密码，需要在 Supabase 后台重置。";
  }
  return message;
}

function makeSyncCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const part = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${part()}-${part()}-${part()}`;
}

function cleanSyncCode(value = "") {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-").slice(0, 14);
}

$("#cloudStartButton").addEventListener("click", async () => {
  if (!supabase) {
    setCloudStatus("云端模块暂时没加载成功，先用本机导入和阅读。");
    return;
  }
  const code = cleanSyncCode($("#cloudCode").value.trim()) || makeSyncCode();
  state.syncCode = code;
  $("#cloudCode").value = code;
  try {
    await saveState();
    renderCloudPanel();
    startCloudRealtime();
    await loadCloudIntoLocal({ merge: true });
    await saveCloudNow({ silent: true });
    setCloudStatus("同步码已连接。手机电脑填同一个码就会同步。");
  } catch (error) {
    state.syncCode = "";
    renderCloudPanel();
    setCloudStatus(/shared_library_states|schema cache|relation/i.test(error.message)
      ? "云端表还没建好。请先在 Supabase 运行新版 SQL。"
      : `同步开启失败：${error.message}`);
  }
});

$("#cloudGenerateButton").addEventListener("click", () => {
  $("#cloudCode").value = makeSyncCode();
  setCloudStatus("已生成同步码。点「连接同步码」即可开启。");
});

$("#cloudPasswordLoginButton").addEventListener("click", async () => {
  if (!supabase) {
    setCloudStatus("云端模块暂时没加载成功，先用本机导入和阅读。");
    return;
  }
  const credentials = cloudCredentials();
  if (!credentials) return;
  setCloudStatus("正在密码登录……");
  const { data, error } = await supabase.auth.signInWithPassword(credentials);
  if (error) {
    setCloudStatus(`密码登录失败：${cloudErrorText(error)}`);
    return;
  }
  await finishCloudSignIn(data.session, "已密码登录，实时同步已开启。");
});

$("#cloudSignupButton").addEventListener("click", async () => {
  if (!supabase) {
    setCloudStatus("云端模块暂时没加载成功，先用本机导入和阅读。");
    return;
  }
  const credentials = cloudCredentials();
  if (!credentials) return;
  setCloudStatus("正在注册密码账号……");
  const { data, error } = await supabase.auth.signUp(credentials);
  if (error) {
    setCloudStatus(`注册失败：${cloudErrorText(error)}`);
    return;
  }
  if (data.session) {
    await finishCloudSignIn(data.session, "已注册并登录，实时同步已开启。");
  } else {
      setCloudStatus("注册邮件已发送。确认后回到这里点「密码登录」。如果邮件页面打不开，先回这个网页再试登录。");
  }
});

$("#cloudSetPasswordButton").addEventListener("click", async () => {
  if (!supabase || !cloudSession?.user) return;
  const password = $("#cloudPassword").value;
  if (!password || password.length < 6) {
    setCloudStatus("输入至少 6 位的新密码。");
    return;
  }
  setCloudStatus("正在设置密码……");
  const { error } = await supabase.auth.updateUser({ password });
  setCloudStatus(error ? `设置失败：${error.message}` : "密码已设置，以后可以直接密码登录。");
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
  setCloudStatus(error ? `发送失败：${error.message}` : "登录邮件已发送。这个方式会打开邮箱里的浏览器；更推荐直接用密码登录。");
});

$("#cloudLogoutButton").addEventListener("click", async () => {
  stopCloudRealtime();
  state.syncCode = "";
  $("#cloudCode").value = "";
  await saveState();
  renderCloudPanel();
  setCloudStatus("已断开同步码。本机内容还在。");
});

$("#cloudUploadButton").addEventListener("click", () => saveCloudNow());

$("#cloudQuickSyncButton").addEventListener("click", async () => {
  if (!state.syncCode) {
    setCloudStatus("先连接同步码。");
    $("#cloudAccountDetails").open = true;
    return;
  }
  try {
    setCloudStatus("正在同步……");
    await loadCloudIntoLocal({ merge: true });
    await saveCloudNow({ silent: true });
    setCloudStatus(`同步完成：${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setCloudStatus(`同步失败：${error.message}`);
  }
});

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
  if (suppressShelfClick) {
    suppressShelfClick = false;
    return;
  }
  state.selectedFolder = button.dataset.folder;
  state.selectedWorkId = null;
  await saveState();
  renderAll();
});

$("#folderList").addEventListener("pointerdown", (event) => {
  const button = event.target.closest("[data-folder]");
  if (!button) return;
  startLongPress(event, () => openFolderManageDialog(button.dataset.folder));
});
$("#folderList").addEventListener("pointermove", cancelLongPressOnMove);
$("#folderList").addEventListener("pointerup", cancelLongPress);
$("#folderList").addEventListener("pointerleave", cancelLongPress);
$("#folderList").addEventListener("pointercancel", cancelLongPress);
$("#folderList").addEventListener("contextmenu", (event) => {
  const button = event.target.closest("[data-folder]");
  if (!button) return;
  event.preventDefault();
  openFolderManageDialog(button.dataset.folder);
});

$("#workList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-work]");
  if (!button) return;
  if (suppressShelfClick) {
    suppressShelfClick = false;
    return;
  }
  state.selectedWorkId = button.dataset.work;
  const work = activeWork();
  pendingJump = work?.reading?.ratio || 0;
  requestReadingFullscreen();
  await saveState();
  renderAll();
});

$("#workList").addEventListener("pointerdown", (event) => {
  const button = event.target.closest("[data-work]");
  if (!button) return;
  startWorkPress(event, button.dataset.work);
});
$("#workList").addEventListener("pointermove", (event) => moveDraggedWork(event));
$("#workList").addEventListener("pointerup", finishWorkPress);
$("#workList").addEventListener("pointerleave", cancelWorkPress);
$("#workList").addEventListener("pointercancel", cancelWorkPress);
$("#workList").addEventListener("contextmenu", (event) => {
  const button = event.target.closest("[data-work]");
  if (!button) return;
  event.preventDefault();
  openWorkManageDialog(button.dataset.work);
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
  if (!work) return;
  await deleteWorkById(work.id);
});

$("#manageAddTagButton").addEventListener("click", async () => {
  const work = workById(managedWorkId);
  const tag = $("#manageTagInput").value.trim();
  if (!work || !tag) return;
  normalizeWork(work);
  if (!work.customTags.includes(tag)) work.customTags.push(tag);
  work.updatedAt = new Date().toISOString();
  await saveState();
  $("#manageTagInput").value = "";
  renderAll();
  openWorkManageDialog(work.id);
});

$("#manageTagList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-tag]");
  const work = workById(managedWorkId);
  if (!button || !work) return;
  work.customTags = (work.customTags || []).filter((tag) => tag !== button.dataset.removeTag);
  work.updatedAt = new Date().toISOString();
  await saveState();
  renderAll();
  openWorkManageDialog(work.id);
});

$("#manageFolderSelect").addEventListener("change", async (event) => {
  const work = workById(managedWorkId);
  if (!work) return;
  work.folderId = event.target.value;
  work.updatedAt = new Date().toISOString();
  await saveState();
  renderAll();
  openWorkManageDialog(work.id);
});

$("#manageDownloadButton").addEventListener("click", () => {
  const work = workById(managedWorkId);
  if (work) downloadWork(work);
});

$("#manageDeleteWorkButton").addEventListener("click", async () => {
  const id = managedWorkId;
  $("#workManageDialog").close();
  await deleteWorkById(id);
});

$("#manageDeleteFolderButton").addEventListener("click", async () => {
  const folder = state.folders.find((item) => item.id === managedFolderId);
  if (!folder || folder.id === "all") return;
  if (!confirm(`删除文件夹「${folder.name}」？里面的作品不会删除，只是不再放在这个文件夹里。`)) return;
  state.works.forEach((work) => {
    if ((work.folderId || "unfiled") === folder.id) work.folderId = "unfiled";
  });
  state.folders = state.folders.filter((item) => item.id !== folder.id);
  if (state.selectedFolder === folder.id) state.selectedFolder = "all";
  $("#folderManageDialog").close();
  await saveState();
  renderAll();
});

$("#manageFolderLeftButton").addEventListener("click", () => moveFolderInList(managedFolderId, -1));
$("#manageFolderRightButton").addEventListener("click", () => moveFolderInList(managedFolderId, 1));

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
$("#highlightButton").addEventListener("click", () => addHighlightFromSelection("yellow"));
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
$("#consoleAddBookmarkButton").addEventListener("click", async () => {
  await addBookmark();
  setControlsOpen(false);
});
$("#consoleBookmarkPanelButton").addEventListener("click", openReaderDialog);
$("#consoleSearchButton").addEventListener("click", () => {
  const query = prompt("搜索全文");
  if (!query) return;
  setControlsOpen(false);
  window.find?.(query);
});
$("#consoleBackgroundButton").addEventListener("click", () => $("#backgroundDialog").showModal());

$("#consolePrevChapter").addEventListener("click", () => changeChapter(-1));
$("#consoleNextChapter").addEventListener("click", () => changeChapter(1));

document.addEventListener("keydown", (event) => {
  if (!activeWork()) return;
  if (event.target?.matches?.("input, textarea, select")) return;
  const nextKeys = ["ArrowRight", "PageDown", " ", "Spacebar", "AudioVolumeDown", "VolumeDown"];
  const prevKeys = ["ArrowLeft", "PageUp", "AudioVolumeUp", "VolumeUp"];
  if (nextKeys.includes(event.key)) {
    event.preventDefault();
    turnPage(1);
  }
  if (prevKeys.includes(event.key)) {
    event.preventDefault();
    turnPage(-1);
  }
});

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

document.querySelectorAll("[data-font-family]").forEach((button) => {
  button.addEventListener("click", async () => {
    state.readerFontFamily = button.dataset.fontFamily || "serif";
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
  const rect = $("#workContent").getBoundingClientRect();
  const x = (event.clientX - rect.left) / Math.max(1, rect.width);
  const isMenuZone = x >= 0.35 && x <= 0.65;
  const mark = event.target.closest(".reader-highlight");
  if (mark) {
    event.preventDefault();
    event.stopPropagation();
    if (isMenuZone) showHighlightToolbar(mark);
    else if (isPagedMode() && state.readerTurnMode !== "swipe") turnPage(x < 0.5 ? -1 : 1);
    return;
  }
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  if (!isPagedMode()) {
    setControlsOpen(!controlsOpen);
    return;
  }
  if (isMenuZone) {
    setControlsOpen(!controlsOpen);
    return;
  }
  if (state.readerTurnMode === "swipe") return;
  if (x < 0.35) turnPage(-1);
  else if (x > 0.65) turnPage(1);
});

$("#workContent").addEventListener("mouseup", () => setTimeout(updateSelectionToolbar, 80));
$("#workContent").addEventListener("touchend", () => setTimeout(updateSelectionToolbar, 120));

document.addEventListener("selectionchange", () => {
  if (!document.body.classList.contains("reading")) return;
  if (Date.now() - lastReaderActionAt < 650) return;
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(updateSelectionToolbar, 120);
});

$("#selectionToolbar").addEventListener("click", async (event) => {
  event.stopPropagation();
  const colorButton = event.target.closest("[data-highlight-color]");
  const actionButton = event.target.closest("[data-highlight-action]");
  if (colorButton) {
    await addHighlightFromSelection(colorButton.dataset.highlightColor || "yellow");
    return;
  }
  if (!actionButton) return;
  const action = actionButton.dataset.highlightAction;
  if (action === "copy") {
    const text = activeSelectionText || selectedReaderText();
    if (text && navigator.clipboard?.writeText) await navigator.clipboard.writeText(text).catch(() => {});
    hideSelectionToolbar();
  }
  if (action === "note") {
    const note = prompt("写备注", "");
    if (note === null) return;
    if (activeHighlightId) {
      const work = activeWork();
      const highlight = work?.highlights?.find((item) => item.id === activeHighlightId);
      if (highlight) {
        highlight.note = note.trim();
        work.updatedAt = new Date().toISOString();
        await saveState();
        renderAll();
      }
      hideSelectionToolbar();
      return;
    }
    await addHighlightFromSelection("yellow", note.trim());
  }
  if (action === "delete") {
    if (activeHighlightId) {
      await removeHighlight(activeHighlightId);
      return;
    }
    const text = activeSelectionText || selectedReaderText();
    const work = activeWork();
    const chapterIndex = work ? currentChapterIndex(work) : 0;
    const match = work?.highlights?.find((item) => item.chapterIndex === chapterIndex && item.text === text);
    if (match) await removeHighlight(match.id);
    else hideSelectionToolbar();
  }
});

$("#workContent").addEventListener("touchstart", (event) => {
  if (!activeWork() || !canUseSwipeTurn() || event.touches.length !== 1) return;
  const touch = event.touches[0];
  touchStart = { x: touch.clientX, y: touch.clientY, at: Date.now(), moved: false };
}, { passive: true });

$("#workContent").addEventListener("touchmove", (event) => {
  if (!touchStart || !canUseSwipeTurn() || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const dx = touch.clientX - touchStart.x;
  const dy = touch.clientY - touchStart.y;
  if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
    touchStart.moved = true;
    event.preventDefault();
  }
}, { passive: false });

$("#workContent").addEventListener("touchend", (event) => {
  if (!touchStart || !canUseSwipeTurn()) {
    touchStart = null;
    return;
  }
  const touch = event.changedTouches[0];
  const dx = touch.clientX - touchStart.x;
  const dy = touch.clientY - touchStart.y;
  const elapsed = Date.now() - touchStart.at;
  const isSwipe = Math.abs(dx) >= 42 && Math.abs(dx) > Math.abs(dy) * 1.2 && elapsed < 700;
  touchStart = null;
  if (!isSwipe) return;
  suppressNextClick = true;
  turnPage(dx < 0 ? 1 : -1);
}, { passive: true });

$("#workContent").addEventListener("scroll", () => {
  scheduleReaderScrollUpdate();
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
  const deleteButton = event.target.closest("[data-delete-bookmark]");
  if (deleteButton) {
    removeBookmark(deleteButton.dataset.deleteBookmark);
    return;
  }
  const button = event.target.closest("[data-bookmark-jump]");
  if (!button) return;
  const work = activeWork();
  const bookmark = work?.bookmarks?.find((item) => item.id === button.dataset.bookmarkJump);
  if (!bookmark) return;
  $("#chapterDialog").close();
  goToChapter(bookmark.chapterIndex, bookmark.ratio);
});

$("#highlightList").addEventListener("click", (event) => {
  const deleteButton = event.target.closest("[data-delete-highlight]");
  if (deleteButton) {
    removeHighlight(deleteButton.dataset.deleteHighlight);
    return;
  }
  const editButton = event.target.closest("[data-edit-highlight]");
  if (editButton) {
    editHighlightNote(editButton.dataset.editHighlight);
    return;
  }
  const button = event.target.closest("[data-highlight-jump]");
  if (!button) return;
  const work = activeWork();
  const highlight = work?.highlights?.find((item) => item.id === button.dataset.highlightJump);
  if (!highlight) return;
  $("#chapterDialog").close();
  goToChapter(highlight.chapterIndex, 0);
});

[
  "#readerSettingsDialog",
  "#backgroundDialog",
  "#chapterDialog",
  "#workManageDialog",
  "#folderManageDialog",
  "#folderDialog",
  "#metaDialog",
  "#manualDialog"
].forEach(enableBackdropClose);

$("#manualOpen").addEventListener("click", () => {
  $("#manualForm").reset();
  $("#manualDialog").showModal();
});

$("#copyCollectorButton").addEventListener("click", async () => {
  const code = createCollectorBookmarklet();
  try {
    await navigator.clipboard.writeText(code);
    $("#importStatus").textContent = "采集助手已复制。把它存成浏览器书签，在原站作品页点这个书签，会下载可导入文件。";
  } catch {
    $("#importStatus").textContent = "复制失败。请换电脑浏览器操作，或继续用 Download → HTML 导入。";
  }
});

$("#htmlFileInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    $("#importStatus").textContent = "正在读取导入文件……";
    await addWork(await parseImportedWorkFile(file));
    $("#importStatus").textContent = "已经保存到书架。";
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
    metadata: { relationships: [], freeforms: [], words: `${textFromHtml(content).replace(/\s/g, "").length} 字` }
  });
  $("#manualDialog").close();
});

boot().catch((error) => {
  $("#importStatus").textContent = `启动失败：${error.message}`;
});
