const DB_NAME = "pocket-reading-vault";
const DB_VERSION = 1;
const STORE = "state";
const IMPORT_API_BASE = "https://pocket-reading-vault.onrender.com";
const CLOUD_PROXY_BASE = IMPORT_API_BASE;
const SUPABASE_URL = "https://bhliywysdezcykoyyozw.supabase.co";
const SUPABASE_KEY = "sb_publishable_hh04jm0Nqp3_Jq-3FTcs5w_FbuaSO0v";
const SAFE_MODE = new URLSearchParams(location.search).has("safe");

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
  readerVerticalMargin: 42,
  readerBrightness: 100,
  readerEyeCare: false,
  readerTurnMode: "tap",
  readerBg: "white",
  progressAccent: "#E0F4F1",
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

const PROGRESS_PALETTES = [
  {
    group: "治愈书香",
    colors: [
      ["淡竹绿", "#E2F0D9"],
      ["麦芽黄", "#FDF2D5"],
      ["薄荷青", "#E0F4F1"]
    ]
  },
  {
    group: "独处静谧",
    colors: [
      ["雾霾蓝", "#E6F0FA"],
      ["薰衣草紫", "#EBE8F5"],
      ["远山灰", "#ECEFF1"]
    ]
  },
  {
    group: "少女心动",
    colors: [
      ["晚霞粉", "#FCE8E6"],
      ["奶油橘", "#FDF0E6"],
      ["浅草莓紫", "#F9EBF2"]
    ]
  },
  {
    group: "蒸汽波暗色",
    colors: [
      ["暗夜蓝", "#1E293B"],
      ["枯叶红", "#3F2424"]
    ]
  }
];

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
let lastTouchSelectionAt = 0;
let pageTurnAnimation = 0;
let cloudTimer;
let pendingJump = null;
let pendingChapterJump = null;
let pendingHighlightJumpId = null;
let controlsOpen = false;
let importDrawerOpen = false;
let cloudPanelOpen = false;
let managedWorkId = null;
let managedFolderId = null;
let batchSelectedWorkIds = new Set();
let batchSelectedFolderIds = new Set();
let readerNavTab = "chapters";
let highlightLibraryWorkId = null;
let highlightLibraryPreviewId = null;
let highlightLibrarySwipe = null;
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
let activeSelectionRange = null;
let toolbarPointerHandledAt = 0;
let toolbarActionUntil = 0;
let previewImageUrl = "";

function lockPortraitMode() {
  screen.orientation?.lock?.("portrait").catch(() => {});
}

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
    if (absolute.startsWith(`${IMPORT_API_BASE}/api/image?`)) {
      const proxyUrl = new URL(absolute);
      if (baseUrl && !proxyUrl.searchParams.get("ref")) proxyUrl.searchParams.set("ref", baseUrl);
      return proxyUrl.toString();
    }
    const params = new URLSearchParams({ url: absolute });
    if (baseUrl) params.set("ref", baseUrl);
    return `${IMPORT_API_BASE}/api/image?${params.toString()}`;
  } catch {
    return value;
  }
}

function originalImageUrlFromProxy(value = "") {
  try {
    const parsed = new URL(value, location.href);
    if (parsed.origin === new URL(IMPORT_API_BASE).origin && parsed.pathname === "/api/image") {
      return parsed.searchParams.get("url") || "";
    }
  } catch {}
  return "";
}

function retryImageUrl(img, work) {
  const current = img.currentSrc || img.src || "";
  const original = img.getAttribute("data-original-src") || originalImageUrlFromProxy(current) || current;
  if (!original) return "";
  img.dataset.proxyRetry = String(Number(img.dataset.proxyRetry || "0") + 1);
  const retry = proxiedImageUrl(original, work?.sourceUrl || "");
  try {
    const retryUrl = new URL(retry);
    retryUrl.searchParams.set("retry", Date.now().toString());
    return retryUrl.toString();
  } catch {
    return retry;
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
      || img.getAttribute("data-cfsrc")
      || img.getAttribute("data-orig-src")
      || img.getAttribute("data-hi-res-src")
      || img.getAttribute("data-full-src")
      || img.getAttribute("data-image-src")
      || img.getAttribute("data-original-src")
      || img.getAttribute("data-actualsrc")
      || img.getAttribute("data-url")
      || img.getAttribute("data-img-url")
      || img.getAttribute("data-preview-src")
      || img.getAttribute("data-large-file")
      || img.getAttribute("data-medium-file")
      || img.getAttribute("data-orig-file")
      || "";
    const srcset = img.getAttribute("srcset")
      || img.getAttribute("data-srcset")
      || img.getAttribute("data-lazy-srcset")
      || img.getAttribute("data-cfsrcset")
      || img.getAttribute("data-original-srcset")
      || "";
    const original = originalImageUrlFromProxy(src)
      || img.getAttribute("data-original-src")
      || src
      || (srcset ? srcset.split(",")[0].trim().split(/\s+/)[0] : "");
    if (original && !img.getAttribute("data-original-src")) {
      img.setAttribute("data-original-src", originalImageUrlFromProxy(original) || original);
    }
    if (original) img.setAttribute("src", proxiedImageUrl(original, baseUrl));
    if (!original && srcset) img.setAttribute("src", proxiedImageUrl(srcset.split(",")[0].trim().split(/\s+/)[0], baseUrl));
    if (srcset) img.setAttribute("srcset", rewriteSrcset(srcset, baseUrl));
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    img.setAttribute("draggable", "false");
    img.removeAttribute("data-src");
    img.removeAttribute("data-original");
    img.removeAttribute("data-lazy-src");
    img.removeAttribute("data-cfsrc");
    img.removeAttribute("data-orig-src");
    img.removeAttribute("data-hi-res-src");
    img.removeAttribute("data-full-src");
    img.removeAttribute("data-image-src");
    img.removeAttribute("data-actualsrc");
    img.removeAttribute("data-url");
    img.removeAttribute("data-img-url");
    img.removeAttribute("data-preview-src");
    img.removeAttribute("data-large-file");
    img.removeAttribute("data-medium-file");
    img.removeAttribute("data-orig-file");
    img.removeAttribute("data-srcset");
    img.removeAttribute("data-lazy-srcset");
    img.removeAttribute("data-cfsrcset");
    img.removeAttribute("data-original-srcset");
  });
}

function prepareReaderImages() {
  const work = activeWork();
  normalizeImages($("#workContent"), work?.sourceUrl || "");
  const images = [...$("#workContent").querySelectorAll("img")];
  images.forEach((img, index) => {
    const original = img.getAttribute("data-original-src") || originalImageUrlFromProxy(img.getAttribute("src") || "") || img.getAttribute("src") || "";
    if (original) {
      img.setAttribute("data-original-src", original);
      const refreshed = proxiedImageUrl(original, work?.sourceUrl || "");
      if (refreshed && refreshed !== img.getAttribute("src")) img.setAttribute("src", refreshed);
    }
    img.classList.add("reader-image");
    img.setAttribute("role", "button");
    img.setAttribute("tabindex", "0");
    img.setAttribute("title", "点开查看图片");
    img.addEventListener("error", () => {
      const next = retryImageUrl(img, work);
      if (next && next !== img.src) {
        img.src = next;
        return;
      }
      img.classList.add("reader-image-broken");
      img.alt = img.alt || "图片暂时加载不了，点开可重试";
    });
    if (index < 3) {
      img.loading = "eager";
      img.setAttribute("fetchpriority", "high");
    }
  });
  images.slice(0, 6).forEach((img) => {
    const src = img.currentSrc || img.src;
    if (src) {
      const preload = new Image();
      preload.src = src;
    }
  });
}

function activeWork() {
  return state.works.find((work) => work.id === state.selectedWorkId) || null;
}

function folderName(id) {
  return state.folders.find((folder) => folder.id === id)?.name || "未分类";
}

function ensureFolderNames(names = []) {
  const ids = [];
  for (const name of names) {
    const existing = state.folders.find((folder) => folder.name === name);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const folder = { id: uid(), name };
    state.folders.push(folder);
    ids.push(folder.id);
  }
  return ids;
}

function workFolderIds(work) {
  normalizeWork(work);
  return [...new Set([...(work.folderIds || []), work.folderId].filter((id) => id && id !== "unfiled"))];
}

function workInFolder(work, folderId) {
  if (folderId === "all") return true;
  return workFolderIds(work).includes(folderId);
}

function folderNamesForWork(work) {
  const names = workFolderIds(work).map(folderName).filter((name) => name && name !== "未分类");
  return names.length ? names.join(" / ") : "未分组";
}

function normalizeWork(work, options = {}) {
  work.folderId ||= "unfiled";
  work.folderIds ||= [];
  if (work.folderId && work.folderId !== "unfiled" && !work.folderIds.includes(work.folderId)) {
    work.folderIds.push(work.folderId);
  }
  work.folderIds = [...new Set((work.folderIds || []).filter((id) => id && id !== "all" && id !== "unfiled"))];
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
  if (!options.light && work.contentHtml && /<img\b/i.test(work.contentHtml)) {
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
  let chapters = nodes.map((node, index) => {
    const heading = node.querySelector(".title, h2, h3, h4") || (/^H[2-4]$/i.test(node.tagName || "") ? node : null);
    const title = heading?.textContent?.replace(/\s+/g, " ").trim() || `第 ${index + 1} 章`;
    return { title, html: node.outerHTML };
  });
  if (chapters.length > 1) return chapters;

  const loose = splitLooseChapters(root);
  if (loose.length > chapters.length) return loose;
  if (nodes.length === 1) {
    const nestedLoose = splitLooseChapters(nodes[0]);
    if (nestedLoose.length > chapters.length) return nestedLoose;
  }
  return chapters.length ? chapters : [{ title: "全文", html: root.innerHTML || work.contentHtml || "" }];
}

function isLooseChapterStart(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = (node.tagName || "").toLowerCase();
  const className = node.className?.toString() || "";
  const id = node.id || "";
  const text = node.textContent?.replace(/\s+/g, " ").trim() || "";
  if (/^chapter-/i.test(id) || /\bchapter\b/i.test(className)) return true;
  const heading = node.querySelector?.(":scope > .title, :scope > h2, :scope > h3, :scope > h4");
  const headingText = heading?.textContent?.replace(/\s+/g, " ").trim() || "";
  if (headingText && (/(title|heading|chapter|module|group)/i.test(className) || /^(chapter|part|第\s*[\d一二三四五六七八九十百]+|[\d一二三四五六七八九十百]+[\s.、-]*(章|节|回)?)/i.test(headingText))) {
    return true;
  }
  if (!/^h[2-4]$/.test(tag)) return false;
  if (/(title|heading|chapter)/i.test(className)) return true;
  return /^(chapter|part|第\s*[\d一二三四五六七八九十百]+|[\d一二三四五六七八九十百]+[\s.、-]*(章|节|回)?)/i.test(text);
}

function looseChapterTitle(node, fallback) {
  const heading = node?.matches?.("h2, h3, h4, .title")
    ? node
    : node?.querySelector?.(":scope > .title, :scope > h2, :scope > h3, :scope > h4, .title, h2, h3, h4");
  return heading?.textContent?.replace(/\s+/g, " ").trim() || fallback;
}

function splitLooseChapters(root) {
  const children = [...root.children].filter((node) => !/^(script|style)$/i.test(node.tagName || ""));
  const starts = children.filter(isLooseChapterStart);
  if (starts.length < 2) return [];
  const groups = [];
  let current = [];
  for (const child of children) {
    if (isLooseChapterStart(child) && current.length) {
      groups.push(current);
      current = [child];
    } else {
      current.push(child);
    }
  }
  if (current.length) groups.push(current);
  return groups
    .filter((group) => group.some((node) => (node.textContent || "").replace(/\s/g, "").length > 20))
    .map((group, index) => {
      const heading = looseChapterTitle(group.find((node) => isLooseChapterStart(node)), `第 ${index + 1} 章`);
      const html = group.map((node) => node.outerHTML).join("");
      return {
        title: heading,
        html: `<div class="chapter" id="chapter-loose-${index + 1}">${html}</div>`
      };
    });
}

function currentChapterIndex(work, chapters = getChapters(work)) {
  const index = Number(work.reading?.chapterIndex || 0);
  return Math.max(0, Math.min(index, chapters.length - 1));
}

function lightweightChapterCount(work) {
  const chapterText = work?.metadata?.chapters || "";
  const fraction = String(chapterText).match(/(\d+)\s*\/\s*(\d+|\?)/);
  if (fraction) return Math.max(1, Number(fraction[2] === "?" ? fraction[1] : fraction[2]) || Number(fraction[1]) || 1);
  const single = String(chapterText).match(/(\d+)\s*(章|chapter|chapters)/i);
  if (single) return Math.max(1, Number(single[1]) || 1);
  const html = work?.contentHtml || "";
  const classCount = (html.match(/\bclass=["'][^"']*chapter/gi) || []).length;
  if (classCount > 1) return classCount;
  return 1;
}

function lightweightWordText(work) {
  if (work?.metadata?.words && work.metadata.words !== "字数未知") return work.metadata.words;
  const cached = Number(work?.wordCount || work?.metadata?.wordCount || 0);
  if (cached) return `${cached} 字`;
  return "字数待统计";
}

function lightweightReadingRatio(work) {
  if (!work) return 0;
  if (work.reading?.wholeRatio !== undefined) return Math.max(0, Math.min(1, Number(work.reading.wholeRatio || 0)));
  const total = Math.max(1, lightweightChapterCount(work));
  const index = Math.max(0, Math.min(total - 1, Number(work.reading?.chapterIndex || 0)));
  const ratio = Math.max(0, Math.min(1, Number(work.reading?.ratio || 0)));
  return Math.max(0, Math.min(1, (index + ratio) / total));
}

function readingToWholeRatio(work, chapters = getChapters(work)) {
  const total = Math.max(1, chapters.length);
  if (work.reading?.wholeRatio !== undefined) {
    return Math.max(0, Math.min(1, Number(work.reading.wholeRatio || 0)));
  }
  const index = currentChapterIndex(work, chapters);
  const ratio = Math.max(0, Math.min(1, Number(work.reading?.ratio || 0)));
  return Math.max(0, Math.min(1, (index + ratio) / total));
}

function chapterStartRatio(index, chapters = []) {
  const total = Math.max(1, chapters.length || 1);
  return Math.max(0, Math.min(1, index / total));
}

function renderContinuousChapters(chapters) {
  return chapters.map((chapter, index) => `
    <section class="reader-chapter" data-reader-chapter="${index}">
      <h2>${escapeHtml(chapter.title || `第 ${index + 1} 章`)}</h2>
      ${chapter.html || ""}
    </section>
  `).join("");
}

function filteredWorks() {
  const query = $("#searchInput").value.trim().toLowerCase();
  return state.works
    .filter((work) => workInFolder(work, state.selectedFolder))
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

function normalizeHexColor(value, fallback = "#007AFF") {
  const raw = String(value || "").trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) return `#${short[1].split("").map((char) => char + char).join("")}`.toUpperCase();
  const long = raw.match(/^#?([0-9a-f]{6})$/i);
  return long ? `#${long[1]}`.toUpperCase() : fallback;
}

function hexToRgb(value) {
  const hex = normalizeHexColor(value).slice(1);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function isDarkHex(value) {
  const { r, g, b } = hexToRgb(value);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 96;
}

function renderProgressColorChoices() {
  const current = normalizeHexColor(state.progressAccent || defaultState.progressAccent);
  const groups = $("#progressColorGroups");
  if (!groups) return;
  groups.innerHTML = PROGRESS_PALETTES.map((palette) => `
    <section class="progress-color-group">
      <h3>${escapeHtml(palette.group)}</h3>
      <div class="progress-color-grid">
        ${palette.colors.map(([name, color]) => {
          const hex = normalizeHexColor(color);
          const active = hex === current ? "active" : "";
          const dark = isDarkHex(hex) ? "dark-swatch" : "";
          return `
            <button type="button" class="progress-color-choice ${active} ${dark}" data-progress-accent="${hex}">
              <span style="--choice-color: ${hex}"></span>
              <b>${escapeHtml(name)}</b>
              <small>${hex}</small>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `).join("");
}

function openProgressColorDialog() {
  renderProgressColorChoices();
  $("#progressColorDialog")?.showModal();
}

function renderFolders() {
  const countFor = (folderId) => {
    if (folderId === "all") return state.works.length;
    return state.works.filter((work) => workInFolder(work, folderId)).length;
  };
  $("#folderList").innerHTML = visibleFolders().map((folder) => `
    <button class="folder-card ${state.selectedFolder === folder.id ? "active" : ""}" data-folder="${folder.id}">
      <span>${escapeHtml(folder.name)}</span>
      <small>${countFor(folder.id)} 篇</small>
    </button>
  `).join("");
}

function syncFolderActiveState() {
  document.querySelectorAll("#folderList [data-folder]").forEach((button) => {
    button.classList.toggle("active", button.dataset.folder === state.selectedFolder);
  });
}

function renderWorks() {
  const works = filteredWorks();
  $("#workList").innerHTML = works.length ? works.map((work) => {
    normalizeWork(work, { light: true });
    const rel = work.metadata?.relationships?.[0] || work.customTags?.[0] || folderNamesForWork(work);
    const chapterCount = lightweightChapterCount(work);
    const chapterText = work.metadata?.chapters || "";
    const complete = /(\d+)\s*\/\s*\1/.test(chapterText) || /complete|完结/i.test(work.metadata?.status || "");
    const status = complete ? "完结" : (chapterText ? "连载" : "未知");
    const ratio = lightweightReadingRatio(work);
    const progress = Math.round(ratio * 100);
    const safeProgress = Math.min(100, Math.max(0, progress));
    const progressText = progress > 0 ? `进度：${Math.min(100, progress)}%` : "未读";
    const customTags = (work.customTags || []).slice(0, 3);
    const contrastClass = isDarkHex(state.progressAccent) && safeProgress > 18 ? "progress-contrast" : "";
    return `
      <button class="work-card ${contrastClass} ${state.selectedWorkId === work.id ? "active" : ""}" data-work="${work.id}" style="--work-progress: ${safeProgress}%;">
        <span class="work-progress-wash" aria-hidden="true"></span>
        <span class="work-progress-edge" aria-hidden="true"></span>
        <h3 class="work-title-line"><span>${escapeHtml(work.title)}</span><small>${status}</small><b>›</b></h3>
        <p>${escapeHtml(work.author || "作者待补")} · ${escapeHtml(rel)}</p>
        <p class="work-progress-text">${progressText} · ${chapterCount} 章 · ${escapeHtml(lightweightWordText(work))}</p>
        ${customTags.length ? `<div class="mini-tag-row">${customTags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      </button>
    `;
  }).join("") : `<div class="empty-state compact-empty"><p>这里还没有作品。</p></div>`;
}

function syncWorkCardProgress(work, ratio = lightweightReadingRatio(work)) {
  if (!work) return;
  const card = document.querySelector(`[data-work="${cssEscape(work.id)}"]`);
  if (!card) return;
  const progress = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  card.style.setProperty("--work-progress", `${progress}%`);
  const progressLine = card.querySelector(".work-progress-text");
  if (progressLine) {
    progressLine.textContent = `${progress > 0 ? `进度：${Math.min(100, progress)}%` : "未读"} · ${lightweightChapterCount(work)} 章 · ${lightweightWordText(work)}`;
  }
}

function updateReaderChapterLabels(work = activeWork(), chapters = work ? getChapters(work) : []) {
  if (!work || !chapters.length) return;
  const index = currentChapterIndex(work, chapters);
  const chapter = chapters[index] || chapters[0];
  $("#chapterTitle").textContent = `${index + 1}/${chapters.length} ${chapter.title}`;
  $("#openChapterDialog").textContent = `${index + 1}/${chapters.length}`;
  $("#prevChapter").disabled = index === 0;
  $("#nextChapter").disabled = index === chapters.length - 1;
  $("#consolePrevChapter").hidden = index === 0;
  $("#consoleNextChapter").hidden = index === chapters.length - 1;
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

  $("#workFolder").textContent = folderNamesForWork(work);
  $("#workTitle").textContent = work.title;
  $("#workAuthor").textContent = work.author || "作者待补";
  $("#noteInput").value = work.note || "";
  $("#summaryBlock").innerHTML = work.summaryHtml ? `<label>简介</label><div>${work.summaryHtml}</div>` : "";
  updateReaderChapterLabels(work, chapters);

  $("#workContent").innerHTML = renderContinuousChapters(chapters);
  $("#workContent").style.setProperty("--reader-font-size", `${state.readerFontSize || 18}px`);
  $("#workContent").style.setProperty("--reader-font-family", readerFontFamilyValue());
  $("#workContent").style.setProperty("--reader-line-height", `${state.readerLineHeight || 1.8}`);
  $("#workContent").style.setProperty("--reader-side-margin", `${state.readerSideMargin || 34}px`);
  $("#workContent").style.setProperty("--reader-vertical-margin", `${state.readerVerticalMargin || 42}px`);
  prepareReaderImages();
  resetPageCache();
  applyHighlights(work);

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
  if (pendingChapterJump) {
    const { index: jumpIndex, ratio } = pendingChapterJump;
    pendingChapterJump = null;
    requestAnimationFrame(() => jumpToChapterElement(jumpIndex, ratio));
  }
  if (pendingHighlightJumpId) {
    const id = pendingHighlightJumpId;
    pendingHighlightJumpId = null;
    requestAnimationFrame(() => jumpToHighlightMark(id));
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

function renderReaderNavTabs() {
  const tabs = ["info", "chapters", "highlights"];
  if (!tabs.includes(readerNavTab)) readerNavTab = "chapters";
  document.querySelectorAll("[data-reader-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.readerTab === readerNavTab);
  });
  document.querySelectorAll("[data-reader-section]").forEach((section) => {
    section.hidden = section.dataset.readerSection !== readerNavTab;
  });
}

function renderReaderInfoPanel(work) {
  const metaHtml = renderMetadata(work);
  const customTags = (work.customTags || []).filter(Boolean);
  const summary = work.summaryHtml || "";
  $("#readerInfoPanel").innerHTML = `
    <section class="reader-info-hero">
      <h3>${escapeHtml(work.title || "作品信息")}</h3>
      <p>${escapeHtml(work.author || "作者待补")}</p>
    </section>
    ${metaHtml ? `<section class="reader-info-meta">${metaHtml}</section>` : `<p class="status">这篇暂时没有导入到标签信息。</p>`}
    ${customTags.length ? `
      <section class="reader-info-local-tags">
        <b>我的标签</b>
        <div class="tag-row">${customTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
      </section>
    ` : ""}
    <section class="reader-info-summary">
      <b>简介</b>
      ${summary ? `<div>${summary}</div>` : `<p class="status">这篇暂时没有导入到简介。</p>`}
    </section>
  `;
}

function worksWithHighlights() {
  return (state.works || [])
    .map(normalizeWork)
    .filter((work) => (work.highlights || []).length)
    .sort((a, b) => {
      const at = Math.max(...(a.highlights || []).map((item) => new Date(item.createdAt || a.updatedAt || 0).getTime()));
      const bt = Math.max(...(b.highlights || []).map((item) => new Date(item.createdAt || b.updatedAt || 0).getTime()));
      return bt - at;
    });
}

function sortedHighlights(work) {
  return [...(work?.highlights || [])].sort((a, b) => {
    const chapterDelta = Number(a.chapterIndex || 0) - Number(b.chapterIndex || 0);
    if (chapterDelta) return chapterDelta;
    return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  });
}

function setHighlightPreviewByOffset(offset) {
  const selected = highlightLibraryWorkId ? state.works.find((work) => work.id === highlightLibraryWorkId) : null;
  const highlights = sortedHighlights(selected);
  if (!selected || !highlights.length) return;
  const currentIndex = Math.max(0, highlights.findIndex((highlight) => highlight.id === highlightLibraryPreviewId));
  const nextIndex = (currentIndex + offset + highlights.length) % highlights.length;
  highlightLibraryPreviewId = highlights[nextIndex].id;
  renderHighlightLibrary();
}

function renderHighlightLibrary() {
  const works = worksWithHighlights();
  const selected = highlightLibraryWorkId ? state.works.find((work) => work.id === highlightLibraryWorkId) : null;
  $("#highlightLibraryBack").hidden = !selected;
  $("#highlightLibraryTitle").textContent = selected ? "摘录" : "摘录";
  $("#highlightLibraryHint").textContent = selected
    ? `${selected.title || "未命名作品"} · ${selected.author || "作者待补"}`
    : "按作品整理所有高亮句子。";

  if (!selected) {
    $("#highlightLibraryList").innerHTML = works.length ? works.map((work) => `
      <button type="button" class="highlight-work-row" data-highlight-work="${work.id}">
        <b>${escapeHtml(work.title || "未命名作品")}</b>
        <span>${escapeHtml(work.author || "作者待补")}</span>
        <small>${(work.highlights || []).length} 条摘录</small>
      </button>
    `).join("") : `<p class="status">还没有高亮。</p>`;
    return;
  }

  const highlights = sortedHighlights(selected);
  const preview = highlightLibraryPreviewId ? highlights.find((highlight) => highlight.id === highlightLibraryPreviewId) : null;
  if (preview) {
    const previewIndex = Math.max(0, highlights.findIndex((highlight) => highlight.id === preview.id));
    $("#highlightLibraryHint").textContent = `${selected.title || "未命名作品"} · 第 ${Number(preview.chapterIndex || 0) + 1} 章`;
    $("#highlightLibraryList").innerHTML = `
      <article class="highlight-preview-card">
        <div class="highlight-preview-top">
          <span class="highlight-preview-pin ${escapeHtml(preview.color || "yellow")}"></span>
          <span>${previewIndex + 1} / ${highlights.length}</span>
        </div>
        <div class="highlight-preview-paper">
          <button type="button" class="highlight-preview-nav prev" data-library-preview-move="-1" aria-label="上一条">‹</button>
          <p>${escapeHtml(preview.text || "")}</p>
          <button type="button" class="highlight-preview-nav next" data-library-preview-move="1" aria-label="下一条">›</button>
        </div>
        <small>${preview.note ? escapeHtml(preview.note) : "无备注"} · 第 ${Number(preview.chapterIndex || 0) + 1} 章</small>
        <div class="highlight-preview-actions">
          <button type="button" class="ghost-button" data-library-preview-back>摘录列表</button>
          <button type="button" class="mini-delete" data-library-delete-highlight="${preview.id}">删除</button>
          <button type="button" data-library-preview-jump="${preview.id}">跳到原文</button>
        </div>
      </article>
    `;
    return;
  }
  $("#highlightLibraryList").innerHTML = highlights.length ? highlights.map((highlight) => `
    <button type="button" class="highlight-passage-row" data-library-highlight-preview="${highlight.id}">
      <span class="highlight-dot ${escapeHtml(highlight.color || "yellow")}" aria-hidden="true"></span>
      <span class="highlight-passage-text">
        <span>${escapeHtml(highlight.text || "")}</span>
        <small>${highlight.note ? escapeHtml(highlight.note) : "无备注"} · 第 ${Number(highlight.chapterIndex || 0) + 1} 章</small>
      </span>
      <span class="highlight-passage-arrow" aria-hidden="true">›</span>
    </button>
  `).join("") : `<p class="status">这本还没有高亮。</p>`;
}

function renderChapterDialog() {
  const work = activeWork();
  if (!work) return;
  const chapters = getChapters(work);
  const index = currentChapterIndex(work, chapters);
  $("#chapterProgressText").textContent = `当前：${index + 1}/${chapters.length} · ${Math.round(readingToWholeRatio(work, chapters) * 100)}%`;
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
    <p>${escapeHtml(work.author || "作者待补")} · ${infoTags.length} 个标签 · ${work.summaryHtml ? "有简介" : "无简介"}</p>
  `;
  renderReaderInfoPanel(work);
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
  renderReaderNavTabs();
}

function renderAll() {
  state.readerTurnMode = normalizedTurnMode();
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
  document.documentElement.classList.toggle("eye-care", Boolean(state.readerEyeCare && (state.readerBg || "white") === "medium"));
  document.documentElement.classList.remove("turn-tap", "turn-swipe", "turn-both", "turn-scroll");
  document.documentElement.classList.add(`turn-${normalizedTurnMode()}`);
  document.body.classList.toggle("import-open", importDrawerOpen);
  document.body.classList.toggle("cloud-open", cloudPanelOpen);
  document.documentElement.style.setProperty("--reader-font-size", `${state.readerFontSize || 18}px`);
  document.documentElement.style.setProperty("--reader-font-family", readerFontFamilyValue());
  document.documentElement.style.setProperty("--reader-line-height", `${state.readerLineHeight || 1.8}`);
  document.documentElement.style.setProperty("--reader-side-margin", `${state.readerSideMargin || 34}px`);
  document.documentElement.style.setProperty("--reader-vertical-margin", `${state.readerVerticalMargin || 42}px`);
  document.documentElement.style.setProperty("--reader-dim-opacity", `${Math.max(0, Math.min(0.45, (100 - Number(state.readerBrightness || 100)) / 150))}`);
  const progressRgb = hexToRgb(state.progressAccent || defaultState.progressAccent);
  document.documentElement.style.setProperty("--shelf-progress-rgb", `${progressRgb.r}, ${progressRgb.g}, ${progressRgb.b}`);
  document.documentElement.style.setProperty("--shelf-progress-color", normalizeHexColor(state.progressAccent || defaultState.progressAccent));
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

function normalizedTurnMode(mode = state.readerTurnMode) {
  if (mode === "both" || mode === "scroll") return "scroll";
  if (mode === "swipe") return "swipe";
  return "tap";
}

function renderSettingsLabels() {
  const font = $("#settingsFontSize");
  const line = $("#settingsLineHeight");
  const margin = $("#settingsSideMargin");
  const marginValue = $("#settingsSideMarginValue");
  const verticalMargin = $("#settingsVerticalMargin");
  const brightness = $("#settingsBrightness");
  if (font) font.textContent = "54";
  if (line) line.textContent = Number(state.readerLineHeight || 1.8).toFixed(1);
  if (margin) margin.textContent = "›";
  if (marginValue) marginValue.textContent = `${state.readerSideMargin || 20}px`;
  if (verticalMargin) verticalMargin.textContent = `${state.readerVerticalMargin || 42}px`;
  if (brightness) brightness.value = state.readerBrightness || 100;
  $("#settingsNightButton")?.classList.toggle("active", Boolean(state.readerEyeCare || (state.readerBg || "white") === "medium"));
  const mode = normalizedTurnMode();
  document.querySelectorAll("[data-turn-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.turnMode === mode);
  });
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

async function moveWorkToVisibleIndex(id, targetIndex) {
  const works = orderedVisibleWorks();
  const fromIndex = works.findIndex((work) => work.id === id);
  if (fromIndex < 0) return false;
  const safeTarget = Math.max(0, Math.min(targetIndex, works.length - 1));
  if (fromIndex === safeTarget) return false;
  const [moving] = works.splice(fromIndex, 1);
  works.splice(safeTarget, 0, moving);
  const base = Date.now() + works.length + 100;
  const now = new Date().toISOString();
  works.forEach((work, index) => {
    work.sortOrder = base - index;
    if (work.id === id) work.updatedAt = now;
  });
  await saveState();
  renderWorks();
  document.body.classList.add("shelf-dragging");
  document.querySelector(`[data-work="${cssEscape(id)}"]`)?.classList.add("dragging");
  return true;
}

function dragTargetIndexFromPoint(y, id) {
  const cards = [...document.querySelectorAll("#workList [data-work]")];
  if (!cards.length) return 0;
  let targetIndex = cards.length - 1;
  for (const [index, card] of cards.entries()) {
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      targetIndex = index;
      break;
    }
  }
  const currentIndex = cards.findIndex((card) => card.dataset.work === id);
  if (currentIndex >= 0 && targetIndex > currentIndex) targetIndex -= 1;
  return Math.max(0, targetIndex);
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

function renderManageFolderTags(work) {
  const ids = workFolderIds(work).filter((id) => state.folders.some((folder) => folder.id === id));
  $("#manageFolderTagList").innerHTML = ids.length
    ? ids.map((id) => `
      <button type="button" class="folder-membership-chip" data-remove-folder-id="${escapeHtml(id)}" title="从这个文件夹移出">
        <span>${escapeHtml(folderName(id))}</span>
        <b aria-hidden="true">×</b>
      </button>
    `).join("")
    : `<span class="empty-tag-note">还没有加入文件夹</span>`;
}

function batchSearchWorks() {
  const query = $("#batchSearchInput")?.value.trim().toLowerCase() || "";
  return state.works
    .map(normalizeWork)
    .filter((work) => {
      if (!query) return true;
      const haystack = [
        work.title,
        work.author,
        work.note,
        ...(work.customTags || []),
        ...(work.metadata?.relationships || []),
        ...(work.metadata?.fandoms || [])
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => (Number(b.sortOrder || 0) - Number(a.sortOrder || 0)) || (new Date(b.importedAt) - new Date(a.importedAt)));
}

function renderBatchGroupDialog() {
  const works = batchSearchWorks();
  const selectedCount = batchSelectedWorkIds.size;
  $("#batchCountText").textContent = selectedCount ? `已选 ${selectedCount} 篇` : `共 ${state.works.length} 篇`;
  $("#batchWorkList").innerHTML = works.length ? works.map((work) => {
    const checked = batchSelectedWorkIds.has(work.id) ? "checked" : "";
    const selectedClass = checked ? "selected" : "";
    return `
      <label class="batch-work-row ${selectedClass}">
        <input type="checkbox" value="${work.id}" ${checked} />
        <span>
          <b>${escapeHtml(work.title || "未命名作品")}</b>
          <small>${escapeHtml(work.author || "作者待补")} · ${escapeHtml(folderNamesForWork(work))}</small>
        </span>
      </label>
    `;
  }).join("") : `<p class="status">没有找到文章。</p>`;

  const folders = state.folders.filter((folder) => folder.id !== "all" && folder.id !== "unfiled");
  $("#batchFolderList").innerHTML = folders.map((folder) => {
    const checked = batchSelectedFolderIds.has(folder.id) ? "checked" : "";
    const selectedClass = checked ? "selected" : "";
    return `
      <label class="batch-folder-chip ${selectedClass}">
        <input type="checkbox" value="${folder.id}" ${checked} />
        <span>${escapeHtml(folder.name)}</span>
      </label>
    `;
  }).join("");
  $("#batchSubmitButton").disabled = !batchSelectedWorkIds.size || !batchSelectedFolderIds.size;
}

async function openBatchGroupDialog() {
  ensureFolderNames(["CA", "想看", "看完"]);
  batchSelectedWorkIds = new Set();
  batchSelectedFolderIds = new Set();
  $("#batchSearchInput").value = $("#searchInput").value.trim();
  await saveState();
  renderAll();
  renderBatchGroupDialog();
  $("#batchGroupDialog").showModal();
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
  $("#manageFolderSelect").value = work.folderId && work.folderId !== "unfiled" ? work.folderId : (workFolderIds(work)[0] || "unfiled");
  $("#manageTagInput").value = "";
  const swatch = $("#manageProgressColorSwatch");
  if (swatch) swatch.style.background = normalizeHexColor(state.progressAccent || defaultState.progressAccent);
  renderManageFolderTags(work);
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

function startProgressColorPress(event) {
  event.preventDefault();
  event.stopPropagation();
  startLongPress(event, () => openProgressColorDialog());
}

function startWorkPress(event, id) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (event.pointerType === "mouse") return;
  clearTimeout(longPressTimer);
  event.currentTarget?.setPointerCapture?.(event.pointerId);
  longPressPoint = { x: event.clientX, y: event.clientY };
  workDrag = { id, active: false, moved: false, lastY: event.clientY, lastTargetIndex: null, pointerType: event.pointerType || "mouse" };
  longPressTimer = setTimeout(() => {
    if (!workDrag || workDrag.id !== id) return;
    workDrag.active = true;
    suppressShelfClick = true;
    document.body.classList.add("shelf-dragging");
    document.querySelector(`[data-work="${cssEscape(id)}"]`)?.classList.add("dragging");
  }, 300);
}

async function moveDraggedWork(event) {
  if (!workDrag) return;
  if (!workDrag.active) {
    const movedEarly = Math.abs(event.clientX - longPressPoint.x) > 16 || Math.abs(event.clientY - longPressPoint.y) > 16;
    if (movedEarly) cancelWorkPress();
    return;
  }
  event.preventDefault();
  const targetIndex = dragTargetIndexFromPoint(event.clientY, workDrag.id);
  if (targetIndex === workDrag.lastTargetIndex) return;
  workDrag.lastTargetIndex = targetIndex;
  workDrag.moved = true;
  workDrag.lastY = event.clientY;
  await moveWorkToVisibleIndex(workDrag.id, targetIndex);
}

function finishWorkPress() {
  clearTimeout(longPressTimer);
  const drag = workDrag;
  workDrag = null;
  longPressPoint = null;
  document.body.classList.remove("shelf-dragging");
  document.querySelectorAll(".work-card.dragging").forEach((card) => card.classList.remove("dragging"));
  if (!drag) return;
  if (drag.active && !drag.moved && drag.pointerType !== "mouse") openWorkManageDialog(drag.id);
  if (drag.active && (drag.moved || drag.pointerType !== "mouse")) suppressShelfClick = true;
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
  state.readerVerticalMargin = nextState.readerVerticalMargin || state.readerVerticalMargin;
  state.readerTurnMode = nextState.readerTurnMode || state.readerTurnMode;
  state.readerBg = nextState.readerBg || state.readerBg;
  state.progressAccent = normalizeHexColor(nextState.progressAccent || state.progressAccent || defaultState.progressAccent);
  state.readerBrightness = nextState.readerBrightness || state.readerBrightness;
  state.readerEyeCare = nextState.readerEyeCare ?? state.readerEyeCare;
  state.theme = nextState.theme || state.theme;
  await saveState();
  renderAll();
}

function setCloudStatus(message) {
  const node = $("#cloudStatus");
  if (node) node.textContent = message;
}

function cloudRestErrorText(error) {
  const message = error?.message || "未知错误";
  if (/backup cloud channel|备用通道/i.test(message)) {
    return "备用同步通道也失败了。请稍后再试，或检查 Render 是否已经部署新版。";
  }
  if (/failed to fetch|network|load failed/i.test(message)) {
    return "连不上云端。新版会自动走备用同步通道；如果仍失败，请确认 Render 已部署新版。";
  }
  if (/statement timeout|canceling statement|timeout/i.test(message)) {
    return "云端旧书架太大，读取或写入超时。请在有完整书库的设备点「只上传」，先把云端压缩成新版。";
  }
  if (/504|云端备用通道连接 Supabase 超时/i.test(message)) {
    return "云端旧书架太大，备用通道读取超时。请在有完整书库的设备点「只上传」，先把云端压缩成新版。";
  }
  if (/shared_library_states|schema cache|relation|404/i.test(message)) {
    return "云端同步表还没建好。需要在 Supabase 运行同步码 SQL。";
  }
  if (/row-level security|permission|401|403|unauthorized|forbidden/i.test(message)) {
    return "云端表权限没放行。需要在 Supabase 运行新版同步码 SQL。";
  }
  return message;
}

function isCloudStateTimeout(error) {
  return /statement timeout|canceling statement|timeout|504|云端备用通道连接 Supabase 超时/i.test(error?.message || "");
}

function syncCodeFromPostgrestQuery(query = "") {
  const match = query.match(/[?&]sync_code=eq\.([^&]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function supabaseProxyRest(path, { method = "GET", query = "", body = null } = {}) {
  if (path !== "shared_library_states") throw new Error("backup cloud channel only supports shelf sync");
  const syncCode = body?.sync_code || syncCodeFromPostgrestQuery(query);
  const response = await fetch(`${CLOUD_PROXY_BASE}/api/cloud${method === "GET" ? `?syncCode=${encodeURIComponent(syncCode)}` : ""}`, {
    method,
    headers: {
      accept: "application/json",
      ...(method === "POST" ? { "content-type": "application/json" } : {})
    },
    body: method === "POST" ? JSON.stringify({ syncCode, state: body?.state }) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("备用同步通道还没部署新版。请上传最外层文件并等待 Render 更新。");
  }
  if (!response.ok) throw new Error(json?.error || `备用通道 ${response.status}`);
  if (method === "GET") return json ? [json] : [];
  return json;
}

async function supabaseRest(path, { method = "GET", query = "", body = null, prefer = "" } = {}) {
  if (path === "shared_library_states") {
    try {
      return await supabaseProxyRest(path, { method, query, body });
    } catch (proxyError) {
      if (method === "POST") throw proxyError;
    }
  }
  const url = `${SUPABASE_URL}/rest/v1/${path}${query}`;
  const headers = {
    apikey: SUPABASE_KEY,
    authorization: `Bearer ${SUPABASE_KEY}`,
    accept: "application/json"
  };
  if (body !== null) headers["content-type"] = "application/json";
  if (prefer) headers.prefer = prefer;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    if (path === "shared_library_states") return supabaseProxyRest(path, { method, query, body });
    throw error;
  }
  if (!response.ok) {
    let detail = "";
    try {
      const json = await response.json();
      detail = json.message || json.details || JSON.stringify(json);
    } catch {
      detail = await response.text();
    }
    const error = new Error(`${response.status} ${detail}`.trim());
    if (path === "shared_library_states") return supabaseProxyRest(path, { method, query, body });
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
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
  if (SAFE_MODE) setCloudStatus("安全模式：已暂停自动云端同步。可以先导出书架或手动同步。");
}

function cloneLibraryState(value) {
  return structuredClone({
    ...defaultState,
    ...value,
    folders: value?.folders || defaultState.folders,
    works: (value?.works || []).map(normalizeWork)
  });
}

function cloudWorkContentScore(work = {}) {
  const html = work.contentHtml || "";
  if (!html) return 0;
  const textLength = textFromHtml(html).replace(/\s/g, "").length;
  const imageCount = (html.match(/<img\b/gi) || []).length;
  const chapterCount = Math.max(1, (html.match(/\bclass=["'][^"']*chapter/gi) || []).length);
  const hasChapterRoot = /id=["']chapters["']|class=["'][^"']*reader-chapter/i.test(html) ? 1000 : 0;
  return textLength + imageCount * 500 + Math.max(0, chapterCount - 1) * 300 + hasChapterRoot;
}

function usefulValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  return Boolean(text && !/^(未知|作者待补|字数未知|0 字|undefined|null)$/i.test(text));
}

function uniqueValues(values = []) {
  return [...new Set(values.filter((item) => item !== null && item !== undefined && String(item).trim()).map((item) => String(item).trim()))];
}

function mergeAnnotationList(localItems = [], cloudItems = []) {
  const map = new Map();
  for (const item of [...localItems, ...cloudItems]) {
    if (!item) continue;
    const key = item.id || `${item.chapterIndex || 0}|${item.text || item.title || ""}`.slice(0, 220);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }
    const existingTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
    const nextTime = new Date(item.updatedAt || item.createdAt || 0).getTime();
    map.set(key, nextTime >= existingTime ? { ...existing, ...item } : { ...item, ...existing });
  }
  return [...map.values()];
}

function mergeMetadata(localMetadata = {}, cloudMetadata = {}, newerMetadata = {}, richerMetadata = {}) {
  const merged = { ...localMetadata, ...cloudMetadata, ...newerMetadata };
  const keys = new Set([
    ...Object.keys(localMetadata || {}),
    ...Object.keys(cloudMetadata || {}),
    ...Object.keys(newerMetadata || {}),
    ...Object.keys(richerMetadata || {})
  ]);
  for (const key of keys) {
    const values = [localMetadata?.[key], cloudMetadata?.[key], newerMetadata?.[key], richerMetadata?.[key]].filter((value) => value !== undefined);
    if (values.some(Array.isArray)) {
      merged[key] = uniqueValues(values.flatMap((value) => Array.isArray(value) ? value : usefulValue(value) ? [value] : []));
      continue;
    }
    if (!usefulValue(merged[key])) {
      const fallback = values.find(usefulValue);
      if (fallback !== undefined) merged[key] = fallback;
    }
  }
  for (const key of ["words", "chapters"]) {
    if (usefulValue(richerMetadata?.[key])) merged[key] = richerMetadata[key];
  }
  return merged;
}

function mergeWorkRecords(localWork, cloudWork) {
  const local = normalizeWork(structuredClone(localWork || {}));
  const cloud = normalizeWork(structuredClone(cloudWork || {}));
  const localTime = new Date(local.updatedAt || local.importedAt || 0).getTime();
  const cloudTime = new Date(cloud.updatedAt || cloud.importedAt || 0).getTime();
  const newer = cloudTime >= localTime ? cloud : local;
  const older = cloudTime >= localTime ? local : cloud;
  const localScore = cloudWorkContentScore(local);
  const cloudScore = cloudWorkContentScore(cloud);
  const richer = cloudScore > localScore ? cloud : local;
  const merged = normalizeWork({
    ...older,
    ...newer,
    title: usefulValue(newer.title) ? newer.title : older.title,
    author: usefulValue(newer.author) ? newer.author : older.author,
    sourceUrl: usefulValue(newer.sourceUrl) ? newer.sourceUrl : older.sourceUrl,
    contentHtml: richer.contentHtml || newer.contentHtml || older.contentHtml || "",
    summaryHtml: textFromHtml(richer.summaryHtml || "").length >= textFromHtml(newer.summaryHtml || older.summaryHtml || "").length
      ? richer.summaryHtml
      : (newer.summaryHtml || older.summaryHtml || ""),
    metadata: mergeMetadata(local.metadata, cloud.metadata, newer.metadata, richer.metadata),
    folderId: newer.folderId || older.folderId || "unfiled",
    folderIds: uniqueValues([...(local.folderIds || []), ...(cloud.folderIds || [])]).filter((id) => id !== "all" && id !== "unfiled"),
    customTags: uniqueValues([...(local.customTags || []), ...(cloud.customTags || [])]),
    note: usefulValue(newer.note) ? newer.note : (older.note || ""),
    bookmarks: mergeAnnotationList(local.bookmarks, cloud.bookmarks),
    highlights: mergeAnnotationList(local.highlights, cloud.highlights),
    reading: newer.reading || older.reading || { chapterIndex: 0, ratio: 0 },
    sortOrder: Math.min(Number(local.sortOrder || Date.now()), Number(cloud.sortOrder || Date.now())),
    importedAt: local.importedAt && cloud.importedAt
      ? (new Date(local.importedAt).getTime() <= new Date(cloud.importedAt).getTime() ? local.importedAt : cloud.importedAt)
      : (local.importedAt || cloud.importedAt || new Date().toISOString()),
    updatedAt: new Date(Math.max(localTime || 0, cloudTime || 0) || Date.now()).toISOString()
  });
  if (cloudScore > localScore && cloudScore > 120) merged.updatedAt = cloud.updatedAt || merged.updatedAt;
  if (localScore > cloudScore && localScore > 120) merged.updatedAt = local.updatedAt || merged.updatedAt;
  return merged;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function gzipBase64Text(text) {
  if (typeof CompressionStream === "undefined") return "";
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return arrayBufferToBase64(buffer);
}

async function gunzipBase64Text(value) {
  if (typeof DecompressionStream === "undefined") throw new Error("这个浏览器暂时不能解压云端书库。");
  const stream = new Blob([base64ToUint8Array(value)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

async function serializeCloudState(payload) {
  const json = JSON.stringify(payload);
  try {
    const compressed = await gzipBase64Text(json);
    if (compressed && compressed.length < json.length * 0.9) {
      return {
        _vellumCompressed: 1,
        format: "gzip-base64-json",
        data: compressed,
        originalLength: json.length,
        compressedLength: compressed.length,
        writer: payload._lastWriter || "",
        writerAt: payload._lastWriterAt || new Date().toISOString()
      };
    }
  } catch {
    // Fall back to plain JSON if the browser cannot compress.
  }
  return payload;
}

async function deserializeCloudState(rawState) {
  if (!rawState?._vellumCompressed) return cloneLibraryState(rawState);
  const text = await gunzipBase64Text(rawState.data || "");
  return cloneLibraryState(JSON.parse(text));
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
    workMap.set(cloudWork.id, mergeWorkRecords(existing, cloudWork));
  }
  merged.works = [...workMap.values()];
  merged.readerFontSize = localState.readerFontSize || cloudState.readerFontSize || defaultState.readerFontSize;
  merged.readerFontFamily = localState.readerFontFamily || cloudState.readerFontFamily || defaultState.readerFontFamily;
  merged.readerLineHeight = localState.readerLineHeight || cloudState.readerLineHeight || defaultState.readerLineHeight;
  merged.readerSideMargin = localState.readerSideMargin || cloudState.readerSideMargin || defaultState.readerSideMargin;
  merged.readerVerticalMargin = localState.readerVerticalMargin || cloudState.readerVerticalMargin || defaultState.readerVerticalMargin;
  merged.readerTurnMode = localState.readerTurnMode || cloudState.readerTurnMode || defaultState.readerTurnMode;
  merged.readerBg = localState.readerBg || cloudState.readerBg || defaultState.readerBg;
  merged.progressAccent = normalizeHexColor(localState.progressAccent || cloudState.progressAccent || defaultState.progressAccent);
  merged.readerBrightness = localState.readerBrightness || cloudState.readerBrightness || defaultState.readerBrightness;
  merged.readerEyeCare = localState.readerEyeCare ?? cloudState.readerEyeCare ?? defaultState.readerEyeCare;
  merged.theme = localState.theme || cloudState.theme || defaultState.theme;
  merged.updatedAt = new Date().toISOString();
  return merged;
}

async function getCloudState() {
  if (!state.syncCode) return null;
  const query = `?select=state,updated_at&sync_code=eq.${encodeURIComponent(state.syncCode)}&limit=1`;
  const rows = await supabaseRest("shared_library_states", { query });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row?.state ? await deserializeCloudState(row.state) : null;
}

async function saveCloudNow({ silent = false } = {}) {
  if (!state.syncCode || syncingCloud) return;
  syncingCloud = true;
  if (!silent) setCloudStatus("正在上传云端……");
  try {
    const payload = cloneLibraryState(state);
    payload._lastWriter = CLIENT_ID;
    payload._lastWriterAt = new Date().toISOString();
    const cloudState = await serializeCloudState(payload);
    const uploadResult = await supabaseRest("shared_library_states", {
      method: "POST",
      query: "?on_conflict=sync_code",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        sync_code: state.syncCode,
        state: cloudState,
        updated_at: new Date().toISOString()
      }
    });
    const compressed = cloudState?._vellumCompressed || uploadResult?.compressed || uploadResult?.sharded;
    const mode = uploadResult?.sharded ? `，分篇 ${uploadResult.works || payload.works.length} 篇` : (compressed ? "，已压缩" : "");
    if (!silent) setCloudStatus(`云端已保存：${payload.works.length} 篇${mode} · ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    if (!silent && state.works.length && isCloudStateTimeout(error)) {
      const oldCode = state.syncCode;
      const shouldRebuild = confirm(`这个同步码 ${oldCode} 里的旧云端书架太大，已经卡住了。\n\n要换一个新同步码，并把这台设备上的 ${state.works.length} 篇书重新上传到新云端吗？\n\n另一台设备之后填新同步码同步就好。`);
      if (shouldRebuild) {
        state.syncCode = makeSyncCode();
        const input = $("#cloudCode");
        if (input) input.value = state.syncCode;
        await dbSet("library", state);
        renderCloudPanel();
        syncingCloud = false;
        await saveCloudNow({ silent: false });
        setCloudStatus(`旧同步码已跳过。新同步码：${state.syncCode}。另一台设备填这个码同步。`);
        return;
      }
    }
    setCloudStatus(`云端保存失败：${cloudRestErrorText(error)}`);
  } finally {
    syncingCloud = false;
  }
}

function queueCloudSave() {
  if (!state.syncCode || syncingCloud || SAFE_MODE) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => saveCloudNow({ silent: true }), 1200);
}

function stopCloudRealtime() {
  clearInterval(cloudRealtimeTimer);
  cloudRealtimeTimer = null;
  cloudRealtimeChannel = null;
}

function startCloudRealtime() {
  stopCloudRealtime();
  if (!supabase || !state.syncCode || SAFE_MODE) return;
  cloudRealtimeTimer = setInterval(async () => {
    if (syncingCloud || !state.syncCode) return;
    try {
      const remoteState = await getCloudState();
      if (!remoteState || remoteState._lastWriter === CLIENT_ID) return;
      syncingCloud = true;
      state = mergeLibraryState(state, remoteState);
      await dbSet("library", state);
      syncingCloud = false;
      renderAll();
      setCloudStatus(`已自动同步：${new Date().toLocaleTimeString()}`);
    } catch (error) {
      syncingCloud = false;
      setCloudStatus(`自动同步失败：${cloudRestErrorText(error)}`);
    }
  }, 60000);
  setCloudStatus("同步码已连接。为避免大书库卡顿，自动同步会低频检查；需要立刻同步请点「立即同步」。");
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
  const localCount = state.works.length;
  const cloudCount = cloudState.works?.length || 0;
  state = merge ? mergeLibraryState(state, cloudState) : cloneLibraryState(cloudState);
  await dbSet("library", state);
  syncingCloud = false;
  renderAll();
  setCloudStatus(merge
    ? `已合并云端书架：本机 ${localCount} 篇，云端 ${cloudCount} 篇，现在 ${state.works.length} 篇。`
    : `已下载云端书架：${state.works.length} 篇。`);
  if (merge) await saveCloudNow({ silent: true });
}

async function refreshCloudSession({ initial = false } = {}) {
  renderCloudPanel();
  if (state.syncCode) {
    setCloudStatus(SAFE_MODE ? "安全模式：同步码已连接，但不会自动读取云端。" : "同步码已连接。");
    startCloudRealtime();
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
      throw new Error(`${error.message} 我已把链接放进后台导入，会自动重试；你不用反复点。`);
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
      const src = img.getAttribute("src")
        || img.getAttribute("data-src")
        || img.getAttribute("data-original")
        || img.getAttribute("data-lazy-src")
        || img.getAttribute("data-cfsrc")
        || img.getAttribute("data-orig-src")
        || img.getAttribute("data-hi-res-src")
        || img.getAttribute("data-full-src")
        || img.getAttribute("data-image-src")
        || img.getAttribute("data-actualsrc")
        || img.getAttribute("data-url")
        || img.getAttribute("data-img-url")
        || img.getAttribute("data-preview-src")
        || img.getAttribute("data-large-file")
        || img.getAttribute("data-medium-file")
        || img.getAttribute("data-orig-file");
      if (src) img.setAttribute("src", new URL(src, location.href).href);
      const srcset = img.getAttribute("srcset")
        || img.getAttribute("data-srcset")
        || img.getAttribute("data-lazy-srcset")
        || img.getAttribute("data-cfsrcset")
        || img.getAttribute("data-original-srcset");
      if (!src && srcset) img.setAttribute("src", new URL(srcset.split(",")[0].trim().split(/\s+/)[0], location.href).href);
    });
    normalizeImages(chapters, location.href);
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
    if (normalizedTurnMode() === "scroll") {
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
    if (normalizedTurnMode() === "scroll") {
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

function visibleReaderChapterIndex() {
  const work = activeWork();
  const content = $("#workContent");
  if (!work || !content) return 0;
  const chapters = getChapters(work);
  const sections = [...content.querySelectorAll("[data-reader-chapter]")];
  if (!sections.length) return currentChapterIndex(work, chapters);
  const box = content.getBoundingClientRect();
  const targetX = box.left + Math.min(box.width - 1, Math.max(1, box.width * 0.5));
  const targetY = box.top + Math.min(box.height - 1, Math.max(1, box.height * 0.34));
  let best = { index: currentChapterIndex(work, chapters), score: Infinity };
  for (const section of sections) {
    const index = Number(section.dataset.readerChapter || 0);
    const rects = [...section.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1);
    for (const rect of rects) {
      const insideX = targetX >= rect.left && targetX <= rect.right;
      const insideY = targetY >= rect.top && targetY <= rect.bottom;
      const dx = insideX ? 0 : Math.min(Math.abs(targetX - rect.left), Math.abs(targetX - rect.right));
      const dy = insideY ? 0 : Math.min(Math.abs(targetY - rect.top), Math.abs(targetY - rect.bottom));
      const score = dx + dy * 1.6;
      if (score < best.score) best = { index, score };
      if (insideX && insideY) return Math.max(0, Math.min(index, chapters.length - 1));
    }
  }
  return Math.max(0, Math.min(best.index, chapters.length - 1));
}

function selectedReaderChapterIndex() {
  const selection = window.getSelection();
  const node = activeSelectionRange?.startContainer || selection?.anchorNode;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const chapter = element?.closest?.("[data-reader-chapter]");
  if (chapter) return Number(chapter.dataset.readerChapter || 0);
  return visibleReaderChapterIndex();
}

function jumpToChapterElement(index, innerRatio = 0) {
  const content = $("#workContent");
  if (!content) return false;
  const section = content.querySelector(`[data-reader-chapter="${Number(index)}"]`);
  if (!section) return false;
  const ratio = Math.max(0, Math.min(1, Number(innerRatio || 0)));
  if (normalizedTurnMode() === "scroll") {
    const top = Math.max(0, section.offsetTop + Math.max(0, section.scrollHeight - content.clientHeight) * ratio);
    content.scrollTo({ top, behavior: "auto" });
    updateProgressBar();
    return true;
  }
  const contentRect = content.getBoundingClientRect();
  const rect = [...section.getClientRects()].find((item) => item.width > 1 && item.height > 1) || section.getBoundingClientRect();
  const rawLeft = content.scrollLeft + rect.left - contentRect.left;
  const metrics = refreshPageCache(true);
  const targetPage = Math.round(Math.max(0, Math.min(metrics.max, rawLeft)) / metrics.step) + 1;
  setReaderPage(targetPage);
  updateProgressBar();
  return true;
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
  const mode = normalizedTurnMode();
  lastReaderActionAt = Date.now();
  hideSelectionToolbar();
  if (controlsOpen) setControlsOpen(false);
  const content = $("#workContent");
  if (mode === "scroll") {
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
  setReaderPage(metrics.current + delta, mode === "swipe");
  updateProgressBar();
  queueProgressPersist(mode === "swipe" ? 180 : 140);
}

function readerPageKey() {
  const work = activeWork();
  const content = $("#workContent");
  if (!work || !content) return "";
  return [
    work.id || state.selectedWorkId || "",
    content.clientWidth,
    state.readerFontSize,
    state.readerFontFamily,
    state.readerLineHeight,
    state.readerSideMargin,
    state.readerVerticalMargin,
    state.readerTurnMode
  ].join("|");
}

function resetPageCache() {
  pageCache = { key: "", step: 1, max: 0, total: 1, current: 1 };
}

function refreshPageCache(force = false) {
  const content = $("#workContent");
  const key = readerPageKey();
  if (!content || !key || normalizedTurnMode() === "scroll") return pageCache;
  const step = Math.max(1, content.clientWidth);
  if (!force && pageCache.key === key && pageCache.step === step) return pageCache;
  const max = Math.max(0, content.scrollWidth - step);
  const total = Math.max(1, Math.round(max / step) + 1);
  const current = Math.min(total, Math.max(1, Math.round(content.scrollLeft / step) + 1));
  pageCache = { key, step, max, total, current };
  return pageCache;
}

function setReaderPage(page, animate = false) {
  const content = $("#workContent");
  const metrics = refreshPageCache();
  const current = Math.min(metrics.total, Math.max(1, page));
  pageCache.current = current;
  const left = Math.min(metrics.max, (current - 1) * metrics.step);
  if (animate) {
    cancelAnimationFrame(pageTurnAnimation);
    content.classList.add("page-turning");
    const start = content.scrollLeft;
    const distance = left - start;
    const duration = 120;
    const startedAt = performance.now();
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const ratio = Math.min(1, (now - startedAt) / duration);
      content.scrollLeft = start + distance * easeOut(ratio);
      if (ratio < 1) {
        pageTurnAnimation = requestAnimationFrame(step);
      } else {
        content.scrollLeft = left;
        content.classList.remove("page-turning");
      }
    };
    pageTurnAnimation = requestAnimationFrame(step);
  } else {
    cancelAnimationFrame(pageTurnAnimation);
    content.classList.remove("page-turning");
    content.scrollLeft = left;
  }
}

function syncPageFromScroll() {
  if (!isPagedMode() || normalizedTurnMode() === "scroll") return;
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
  const mode = normalizedTurnMode();
  return isPagedMode() && (mode === "tap" || mode === "swipe");
}

function isDesktopReaderLayout() {
  return window.matchMedia?.("(min-width: 760px) and (pointer: fine)")?.matches;
}

function setControlsOpen(open) {
  controlsOpen = open;
  $("#readingBar").classList.toggle("hidden", !activeWork() || !controlsOpen);
  $("#readerConsole").classList.toggle("hidden", !activeWork() || !controlsOpen);
}

function snapToNearestPage() {
  const content = $("#workContent");
  if (!activeWork() || !isPagedMode() || normalizedTurnMode() === "scroll") return;
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
  const chapters = getChapters(work);
  normalizeWork(work);
  work.reading.wholeRatio = ratio;
  work.reading.ratio = ratio;
  work.reading.chapterIndex = visibleReaderChapterIndex();
  $("#progressRange").value = Math.round(ratio * 1000);
  $("#progressText").textContent = `${Math.round(ratio * 100)}%`;
  $("#consoleMenuProgress").textContent = `目录 · ${Math.round(ratio * 100)}%`;
  const bookmarkCount = (work.highlights || []).length;
  $("#consoleBookmarkCount").textContent = String(bookmarkCount);
  updateReaderChapterLabels(work, chapters);
  updatePageCount();
  syncWorkCardProgress(work, ratio);
}

function updatePageCount() {
  const work = activeWork();
  const count = $("#readerPageCount");
  if (!work || !count) return;
  const content = $("#workContent");
  if (isPagedMode() && normalizedTurnMode() === "scroll") {
    count.textContent = `${Math.round(chapterScrollRatio() * 100)}%`;
    return;
  }
  const metrics = isPagedMode() ? refreshPageCache() : { current: 1, total: 1 };
  count.textContent = `${metrics.current} / ${metrics.total}`;
}

function requestReadingFullscreen() {
  lockPortraitMode();
  if (!isPagedMode() || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen()
    .then(lockPortraitMode)
    .catch(() => {});
}

function exitReadingFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
}

async function persistProgress() {
  const work = activeWork();
  if (!work) return;
  normalizeWork(work);
  work.reading.wholeRatio = chapterScrollRatio();
  work.reading.ratio = work.reading.wholeRatio;
  work.reading.chapterIndex = visibleReaderChapterIndex();
  work.updatedAt = new Date().toISOString();
  await saveState();
  updateProgressBar();
}

function changeChapter(delta) {
  const work = activeWork();
  if (!work) return;
  const chapters = getChapters(work);
  const nextIndex = Math.max(0, Math.min(visibleReaderChapterIndex() + delta, chapters.length - 1));
  const nextRatio = chapterStartRatio(nextIndex, chapters);
  work.reading.chapterIndex = nextIndex;
  work.reading.wholeRatio = nextRatio;
  work.reading.ratio = nextRatio;
  work.updatedAt = new Date().toISOString();
  pendingJump = nextRatio;
  pendingChapterJump = { index: nextIndex, ratio: 0 };
  saveState().then(renderAll);
}

function goToChapter(index, ratio = 0) {
  const work = activeWork();
  if (!work) return;
  const chapters = getChapters(work);
  const nextIndex = Math.max(0, Math.min(index, chapters.length - 1));
  const nextRatio = Math.max(0, Math.min(1, chapterStartRatio(nextIndex, chapters) + (ratio / Math.max(1, chapters.length))));
  work.reading.chapterIndex = nextIndex;
  work.reading.wholeRatio = nextRatio;
  work.reading.ratio = nextRatio;
  work.updatedAt = new Date().toISOString();
  pendingJump = nextRatio;
  pendingChapterJump = { index: nextIndex, ratio };
  saveState().then(renderAll);
}

function goToHighlight(highlight) {
  if (!highlight) return;
  const work = activeWork();
  if (!work) return;
  const chapters = getChapters(work);
  const index = Math.max(0, Math.min(Number(highlight.chapterIndex || 0), chapters.length - 1));
  const nextRatio = chapterStartRatio(index, chapters);
  work.reading.chapterIndex = index;
  work.reading.wholeRatio = nextRatio;
  work.reading.ratio = nextRatio;
  work.updatedAt = new Date().toISOString();
  pendingJump = nextRatio;
  pendingChapterJump = { index, ratio: 0 };
  pendingHighlightJumpId = highlight.id;
  saveState().then(renderAll);
}

function jumpToHighlightMark(id) {
  const content = $("#workContent");
  const mark = content?.querySelector(`[data-highlight-id="${cssEscape(id)}"]`);
  if (!content || !mark) return;
  mark.classList.add("jump-focus");
  mark.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  window.setTimeout(() => {
    updateProgressBar();
    persistProgress();
  }, 80);
  window.setTimeout(() => mark.classList.remove("jump-focus"), 1600);
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
  work.reading.wholeRatio = ratio;
  work.reading.ratio = ratio;
  work.updatedAt = new Date().toISOString();
  await saveState();
  updateProgressBar();
}

let bookmarkSaving = false;

async function addBookmarkFromControl(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (bookmarkSaving) return;
  bookmarkSaving = true;
  await addBookmark();
  window.setTimeout(() => {
    bookmarkSaving = false;
  }, 180);
}

function applyHighlights(work) {
  const root = $("#workContent");
  const highlights = work.highlights || [];
  for (const highlight of highlights) {
    const chapterIndex = Number(highlight.chapterIndex || 0);
    const host = root.querySelector(`[data-reader-chapter="${chapterIndex}"]`) || root;
    markFirstText(host, highlight);
  }
}

function markFirstText(root, highlight) {
  const text = typeof highlight === "string" ? highlight : highlight.text;
  if (!text || text.length < 2) return false;
  const wanted = text.replace(/\s+/g, " ").trim();
  const nodes = [];
  const chars = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.parentElement?.closest(".reader-highlight")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while ((node = walker.nextNode())) {
    for (let offset = 0; offset < node.nodeValue.length; offset += 1) {
      const char = /\s/.test(node.nodeValue[offset]) ? " " : node.nodeValue[offset];
      const previous = chars[chars.length - 1]?.char;
      if (char === " " && previous === " ") continue;
      chars.push({ char, node, offset });
    }
  }
  const fullText = chars.map((item) => item.char).join("").trim();
  const index = fullText.indexOf(wanted);
  if (index < 0) return false;
  const leadingSpaces = chars.findIndex((item) => item.char.trim());
  const startIndex = Math.max(0, index + Math.max(0, leadingSpaces));
  const endIndex = Math.min(chars.length - 1, startIndex + wanted.length - 1);
  const start = chars[startIndex];
  const end = chars[endIndex];
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  const span = document.createElement("mark");
  span.className = `reader-highlight ${highlight.color || "yellow"}`;
  if (highlight.id) span.dataset.highlightId = highlight.id;
  if (highlight.note) span.title = highlight.note;
  try {
    range.surroundContents(span);
  } catch {
    const fragment = range.extractContents();
    span.append(fragment);
    range.insertNode(span);
  }
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
  const text = selectedReaderText() || activeSelectionText;
  if (!text || text.length < 2) return;
  normalizeWork(work);
  const chapterIndex = selectedReaderChapterIndex();
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

async function removeHighlightFromWork(workId, highlightId) {
  const work = state.works.find((item) => item.id === workId);
  if (!work) return;
  work.highlights = (work.highlights || []).filter((item) => item.id !== highlightId);
  work.updatedAt = new Date().toISOString();
  await saveState();
  renderAll();
  if (!(work.highlights || []).length) highlightLibraryWorkId = null;
  renderHighlightLibrary();
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
  activeSelectionRange = null;
}

function showSelectionToolbarFromRect(rect, { mode = "selection" } = {}) {
  const toolbar = $("#selectionToolbar");
  if (!toolbar || !rect) return;
  toolbar.classList.toggle("highlight-existing", mode === "highlight");
  toolbar.classList.remove("hidden");
  const isMobile = window.matchMedia("(max-width: 879px)").matches;
  const width = Math.min(toolbar.offsetWidth || (isMobile ? 286 : 280), window.innerWidth - 20);
  const left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.left + rect.width / 2 - width / 2));
  let top;
  if (isMobile) {
    const below = rect.bottom + 18;
    const above = rect.top - 58;
    top = below + 52 < window.innerHeight ? below : Math.max(14, above);
  } else {
    top = rect.top > 70 ? rect.top - 56 : Math.min(window.innerHeight - 58, rect.bottom + 12);
  }
  toolbar.style.left = `${left}px`;
  toolbar.style.top = `${top}px`;
}

function updateSelectionToolbar() {
  if (Date.now() < toolbarActionUntil) return;
  if (Date.now() - lastReaderActionAt < 650) return hideSelectionToolbar();
  if (!document.body.classList.contains("reading")) return hideSelectionToolbar();
  const selection = window.getSelection();
  const text = selectedReaderText();
  if (!selection || !text || text.length < 2) return hideSelectionToolbar();
  activeHighlightId = null;
  activeSelectionText = text;
  const range = selection.getRangeAt(0);
  activeSelectionRange = range.cloneRange();
  const rect = Array.from(range.getClientRects()).find((item) => item.width > 0 && item.height > 0) || range.getBoundingClientRect();
  showSelectionToolbarFromRect(rect);
}

function showHighlightToolbar(mark) {
  activeHighlightId = mark.dataset.highlightId || null;
  activeSelectionText = mark.textContent?.replace(/\s+/g, " ").trim() || "";
  activeSelectionRange = null;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  showSelectionToolbarFromRect(mark.getBoundingClientRect(), { mode: "highlight" });
}

function openImagePreview(img) {
  const work = activeWork();
  const original = img.getAttribute("data-original-src") || originalImageUrlFromProxy(img.currentSrc || img.src || img.getAttribute("src") || "");
  if (original) {
    const refreshed = retryImageUrl(img, work);
    if (refreshed) {
      img.classList.remove("reader-image-broken");
      img.src = refreshed;
    }
  }
  const src = img.currentSrc || img.src || img.getAttribute("src");
  if (!src) return;
  previewImageUrl = src;
  const preview = $("#imagePreview");
  preview.src = src;
  preview.alt = img.alt || "预览图片";
  $("#imagePreviewDialog").showModal();
}

async function downloadPreviewImage() {
  if (!previewImageUrl) return;
  try {
    const response = await fetch(previewImageUrl);
    const blob = await response.blob();
    const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg").split(";")[0];
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `image-${Date.now()}.${ext}`;
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    const link = document.createElement("a");
    link.href = previewImageUrl;
    link.download = `image-${Date.now()}.jpg`;
    link.click();
  }
}

async function boot() {
  supabase = { mode: "rest" };
  db = await openDb();
  state = { ...defaultState, ...(await dbGet("library") || {}) };
  let imageMigrationNeeded = false;
  state.works = (state.works || []).map((work) => {
    const before = work.contentHtml || "";
    const normalized = normalizeWork(work, { light: true });
    if ((normalized.contentHtml || "") !== before) imageMigrationNeeded = true;
    return normalized;
  });
  state.readerLineHeight ||= defaultState.readerLineHeight;
  state.readerSideMargin ||= defaultState.readerSideMargin;
  state.readerVerticalMargin ||= defaultState.readerVerticalMargin;
  state.readerTurnMode ||= defaultState.readerTurnMode;
  state.readerBg ||= defaultState.readerBg;
  state.readerBrightness ||= defaultState.readerBrightness;
  state.readerEyeCare ??= defaultState.readerEyeCare;
  if (["paper", "green", "gray"].includes(state.readerBg)) state.readerBg = "light";
  if (state.readerBg === "dark") state.readerBg = "black";
  state.readerFontSize = Math.max(12, Math.min(32, Number(state.readerFontSize || defaultState.readerFontSize)));
  state.readerLineHeight = Math.max(1.4, Math.min(2.4, Number(state.readerLineHeight || defaultState.readerLineHeight)));
  state.readerSideMargin = Math.max(12, Math.min(32, Number(state.readerSideMargin || defaultState.readerSideMargin)));
  state.readerVerticalMargin = Math.max(28, Math.min(76, Number(state.readerVerticalMargin || defaultState.readerVerticalMargin)));
  state.readerBrightness = Math.max(45, Math.min(100, Number(state.readerBrightness || defaultState.readerBrightness)));
  state.progressAccent = normalizeHexColor(state.progressAccent || defaultState.progressAccent);
  if (state.progressAccent === "#007AFF") state.progressAccent = defaultState.progressAccent;
  normalizePendingImports();
  if (!state.folders.some((folder) => folder.id === "all")) state.folders.unshift(defaultState.folders[0]);
  if (!state.folders.some((folder) => folder.id === "unfiled")) state.folders.push(defaultState.folders[1]);
  if (state.selectedFolder === "unfiled") state.selectedFolder = "all";
  state.selectedWorkId = null;
  if (imageMigrationNeeded) await dbSet("library", state);
  renderAll();
  if (!SAFE_MODE) schedulePendingImports();
  if (supabase) {
    await refreshCloudSession({ initial: false });
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

$("#highlightLibraryButton").addEventListener("click", () => {
  highlightLibraryWorkId = null;
  renderHighlightLibrary();
  $("#highlightLibraryDialog").showModal();
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

$("#progressColorGroups")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-progress-accent]");
  if (!button) return;
  state.progressAccent = normalizeHexColor(button.dataset.progressAccent, defaultState.progressAccent);
  await saveState();
  renderAll();
  renderProgressColorChoices();
  const swatch = $("#manageProgressColorSwatch");
  if (swatch) swatch.style.background = state.progressAccent;
});

$("#manageProgressColorButton")?.addEventListener("click", () => {
  $("#workManageDialog")?.close();
  openProgressColorDialog();
});

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
    try {
      await loadCloudIntoLocal({ merge: true });
    } catch (error) {
      if (!state.works.length || !isCloudStateTimeout(error)) throw error;
      setCloudStatus("云端旧数据读取超时，正在先上传本机压缩书架……");
      await saveCloudNow({ silent: false });
    }
    await saveCloudNow({ silent: true });
    setCloudStatus("同步码已连接。手机电脑填同一个码就会同步。");
  } catch (error) {
    state.syncCode = "";
    renderCloudPanel();
    setCloudStatus(`同步开启失败：${cloudRestErrorText(error)}`);
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
    try {
      await loadCloudIntoLocal({ merge: true });
    } catch (error) {
      if (!state.works.length || !isCloudStateTimeout(error)) throw error;
      setCloudStatus("云端旧数据读取超时，正在先上传本机压缩书架……");
      await saveCloudNow({ silent: false });
    }
    await saveCloudNow({ silent: true });
    setCloudStatus(`同步完成：现在本机有 ${state.works.length} 篇 · ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setCloudStatus(`同步失败：${cloudRestErrorText(error)}`);
  }
});

$("#cloudDownloadButton").addEventListener("click", async () => {
  if (!confirm("用云端书架合并到本机？本机已有作品不会被直接清空。")) return;
  try {
    await loadCloudIntoLocal({ merge: true });
  } catch (error) {
    setCloudStatus(`云端读取失败：${cloudRestErrorText(error)}`);
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
  syncFolderActiveState();
  await saveState();
  renderWorks();
  renderReader();
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

$("#workList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-work]");
  if (!button) return;
  if (suppressShelfClick) {
    suppressShelfClick = false;
    return;
  }
  state.selectedWorkId = button.dataset.work;
  const work = activeWork();
  pendingJump = work ? readingToWholeRatio(work) : 0;
  requestReadingFullscreen();
  renderAll();
  saveState().catch(() => {});
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

$("#batchManageButton").addEventListener("click", openBatchGroupDialog);

$("#batchSearchInput").addEventListener("input", renderBatchGroupDialog);

$("#batchSelectAllButton").addEventListener("click", () => {
  batchSearchWorks().forEach((work) => batchSelectedWorkIds.add(work.id));
  renderBatchGroupDialog();
});

$("#batchClearButton").addEventListener("click", () => {
  batchSelectedWorkIds.clear();
  renderBatchGroupDialog();
});

$("#batchWorkList").addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[type='checkbox']");
  if (!checkbox) return;
  if (checkbox.checked) batchSelectedWorkIds.add(checkbox.value);
  else batchSelectedWorkIds.delete(checkbox.value);
  renderBatchGroupDialog();
});

$("#batchFolderList").addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[type='checkbox']");
  if (!checkbox) return;
  if (checkbox.checked) batchSelectedFolderIds.add(checkbox.value);
  else batchSelectedFolderIds.delete(checkbox.value);
  renderBatchGroupDialog();
});

$("#batchGroupForm").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "save") return;
  event.preventDefault();
  if (!batchSelectedWorkIds.size) {
    $("#batchCountText").textContent = "先勾选文章";
    return;
  }
  if (!batchSelectedFolderIds.size) {
    $("#batchCountText").textContent = "先选择分组";
    return;
  }
  const now = new Date().toISOString();
  for (const work of state.works) {
    if (!batchSelectedWorkIds.has(work.id)) continue;
    normalizeWork(work);
    for (const folderId of batchSelectedFolderIds) {
      if (!work.folderIds.includes(folderId)) work.folderIds.push(folderId);
    }
    if (!work.folderId || work.folderId === "unfiled") work.folderId = [...batchSelectedFolderIds][0];
    work.updatedAt = now;
  }
  await saveState();
  $("#batchGroupDialog").close();
  renderAll();
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
  work.folderIds = work.folderId === "unfiled"
    ? workFolderIds(work)
    : [...new Set([...workFolderIds(work), work.folderId])];
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

$("#manageFolderTagList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-folder-id]");
  const work = workById(managedWorkId);
  if (!button || !work) return;
  const removedId = button.dataset.removeFolderId;
  const nextIds = workFolderIds(work).filter((id) => id !== removedId);
  work.folderIds = nextIds;
  if (work.folderId === removedId || !nextIds.includes(work.folderId)) {
    work.folderId = nextIds[0] || "unfiled";
  }
  work.updatedAt = new Date().toISOString();
  await saveState();
  renderAll();
  openWorkManageDialog(work.id);
});

$("#manageFolderSelect").addEventListener("change", async (event) => {
  const work = workById(managedWorkId);
  if (!work) return;
  work.folderId = event.target.value;
  work.folderIds = work.folderId === "unfiled"
    ? []
    : [...new Set([...workFolderIds(work), work.folderId])];
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
    work.folderIds = workFolderIds(work).filter((id) => id !== folder.id);
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
$("#bookmarkButton").addEventListener("pointerdown", addBookmarkFromControl);
$("#consoleTopBookmarkButton")?.addEventListener("pointerdown", addBookmarkFromControl);

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
  setControlsOpen(false);
  $("#settingsTurnMode").value = normalizedTurnMode();
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

$("#settingsTocButton")?.addEventListener("click", () => {
  $("#readerSettingsDialog").close();
  openReaderDialog();
});

$("#settingsNightTabButton")?.addEventListener("click", () => {
  $("#settingsNightButton").click();
});

$("#settingsBackgroundShortcut")?.addEventListener("click", () => {
  $("#backgroundDialog")?.showModal();
});

$("#settingsSpacingButton")?.addEventListener("click", () => {
  $("#settingsSpacingPanel")?.toggleAttribute("hidden");
});

$("#chapterBookmarkButton")?.addEventListener("pointerdown", async (event) => {
  await addBookmarkFromControl(event);
  readerNavTab = "bookmarks";
  renderChapterDialog();
});

$("#readerNavTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-reader-tab]");
  if (!button) return;
  readerNavTab = button.dataset.readerTab || "chapters";
  renderReaderNavTabs();
});

$("#consoleLibraryButton").addEventListener("click", () => openReaderDialog("chapters"));
$("#consoleAddBookmarkButton").addEventListener("pointerdown", async (event) => {
  await addBookmarkFromControl(event);
  setControlsOpen(false);
});
$("#consoleBookmarkPanelButton").addEventListener("click", () => openReaderDialog("highlights"));
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
  await persistProgress();
  state.readerTurnMode = normalizedTurnMode(event.target.value);
  pendingJump = activeWork() ? readingToWholeRatio(activeWork()) : null;
  await saveState();
  renderAll();
});

document.querySelectorAll("[data-turn-mode]").forEach((button) => {
  button.addEventListener("click", async () => {
    await persistProgress();
    const mode = normalizedTurnMode(button.dataset.turnMode);
    state.readerTurnMode = mode;
    const select = $("#settingsTurnMode");
    if (select) select.value = mode;
    pendingJump = activeWork() ? readingToWholeRatio(activeWork()) : null;
    await saveState();
    renderAll();
  });
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
    if (button.dataset.stepper === "verticalMargin") {
      state.readerVerticalMargin = Math.max(28, Math.min(76, (state.readerVerticalMargin || 42) + delta * 4));
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
  const next = !(state.readerEyeCare || state.readerBg === "medium");
  state.readerEyeCare = next;
  state.readerBg = next ? "medium" : "white";
  state.theme = "light";
  await saveState();
  renderAll();
});

$("#settingsBrightness")?.addEventListener("input", (event) => {
  state.readerBrightness = Math.max(45, Math.min(100, Number(event.target.value || 100)));
  document.documentElement.style.setProperty("--reader-dim-opacity", `${Math.max(0, Math.min(0.45, (100 - Number(state.readerBrightness || 100)) / 150))}`);
});

$("#settingsBrightness")?.addEventListener("change", async () => {
  await saveState();
  renderAll();
});

$("#readerSettingsDialog")?.addEventListener("pointerdown", (event) => {
  if (event.target?.closest?.("#settingsBrightness")) event.stopPropagation();
});

document.querySelectorAll("[data-bg]").forEach((button) => {
  button.addEventListener("click", async () => {
    state.readerBg = button.dataset.bg;
    state.readerEyeCare = button.dataset.bg === "medium";
    state.theme = state.readerBg === "black" ? "dark" : "light";
    await saveState();
    renderAll();
  });
});

$("#workContent").addEventListener("click", (event) => {
  if (!activeWork()) return;
  const image = event.target.closest("img");
  if (image) {
    event.preventDefault();
    event.stopPropagation();
    lastReaderActionAt = Date.now();
    hideSelectionToolbar();
    setControlsOpen(false);
    openImagePreview(image);
    return;
  }
  const rect = $("#workContent").getBoundingClientRect();
  const x = (event.clientX - rect.left) / Math.max(1, rect.width);
  const isMenuZone = x >= 0.3 && x <= 0.7;
  const mark = event.target.closest(".reader-highlight");
  if (mark) {
    event.preventDefault();
    event.stopPropagation();
    suppressNextClick = false;
    showHighlightToolbar(mark);
    return;
  }
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;
  if (!isPagedMode()) {
    if (isDesktopReaderLayout()) openReaderDialog("chapters");
    else setControlsOpen(!controlsOpen);
    return;
  }
  if (isMenuZone) {
    if (isDesktopReaderLayout()) {
      setControlsOpen(false);
      openReaderDialog("chapters");
    } else {
      setControlsOpen(!controlsOpen);
    }
    return;
  }
  if (normalizedTurnMode() === "scroll") return;
  if (x < 0.3) turnPage(-1);
  else if (x > 0.7) turnPage(1);
});

$("#workContent").addEventListener("pointerdown", (event) => {
  const mark = event.target.closest(".reader-highlight");
  if (!mark) return;
  event.preventDefault();
  event.stopPropagation();
  suppressNextClick = true;
  showHighlightToolbar(mark);
});

$("#workContent").addEventListener("mouseup", () => setTimeout(updateSelectionToolbar, 80));
$("#workContent").addEventListener("touchend", () => {
  lastTouchSelectionAt = Date.now();
  setTimeout(updateSelectionToolbar, 360);
  setTimeout(updateSelectionToolbar, 680);
  setTimeout(updateSelectionToolbar, 980);
});

document.addEventListener("selectionchange", () => {
  if (!document.body.classList.contains("reading")) return;
  if (Date.now() - lastReaderActionAt < 650) return;
  clearTimeout(selectionTimer);
  const delay = Date.now() - lastTouchSelectionAt < 900 ? 520 : 120;
  selectionTimer = setTimeout(updateSelectionToolbar, delay);
});

async function handleSelectionToolbarAction(event) {
  event.preventDefault();
  event.stopPropagation();
  toolbarActionUntil = Date.now() + 1000;
  const colorButton = event.target.closest("[data-highlight-color]");
  const actionButton = event.target.closest("[data-highlight-action]");
  if (colorButton) {
    if (activeHighlightId) {
      const work = activeWork();
      const highlight = work?.highlights?.find((item) => item.id === activeHighlightId);
      if (highlight) {
        highlight.color = colorButton.dataset.highlightColor || "yellow";
        work.updatedAt = new Date().toISOString();
        hideSelectionToolbar();
        await saveState();
        renderAll();
      }
      return;
    }
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
    const chapterIndex = work ? selectedReaderChapterIndex() : 0;
    const match = work?.highlights?.find((item) => item.chapterIndex === chapterIndex && item.text === text);
    if (match) await removeHighlight(match.id);
    else hideSelectionToolbar();
  }
}

$("#selectionToolbar").addEventListener("pointerdown", (event) => {
  toolbarActionUntil = Date.now() + 1000;
  const actionable = event.target.closest("[data-highlight-color], [data-highlight-action]");
  if (actionable) {
    toolbarPointerHandledAt = Date.now();
    handleSelectionToolbarAction(event);
  }
  event.preventDefault();
  event.stopPropagation();
});
$("#selectionToolbar").addEventListener("touchstart", (event) => {
  toolbarActionUntil = Date.now() + 1000;
  event.stopPropagation();
}, { passive: true });
$("#selectionToolbar").addEventListener("click", (event) => {
  if (Date.now() - toolbarPointerHandledAt < 700) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  handleSelectionToolbarAction(event);
});

$("#closeImagePreview").addEventListener("click", () => $("#imagePreviewDialog").close());
$("#downloadPreviewImage").addEventListener("click", downloadPreviewImage);
$("#imagePreviewDialog").addEventListener("click", (event) => {
  if (event.target === $("#imagePreviewDialog")) $("#imagePreviewDialog").close();
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
  const isSwipe = Math.abs(dx) >= 28 && Math.abs(dx) > Math.abs(dy) * 1.08 && elapsed < 850;
  touchStart = null;
  if (!isSwipe) return;
  suppressNextClick = true;
  turnPage(dx < 0 ? 1 : -1);
}, { passive: true });

$("#workContent").addEventListener("scroll", () => {
  scheduleReaderScrollUpdate();
  clearTimeout(progressTimer);
  progressTimer = setTimeout(persistProgress, normalizedTurnMode() === "scroll" ? 450 : 900);
  clearTimeout(snapTimer);
  if (normalizedTurnMode() === "swipe") {
    snapTimer = setTimeout(snapToNearestPage, 90);
  }
}, { passive: true });

window.addEventListener("resize", () => {
  resetPageCache();
  requestAnimationFrame(() => {
    scrollToChapterRatio(activeWork() ? readingToWholeRatio(activeWork()) : 0);
    updateProgressBar();
  });
}, { passive: true });

window.addEventListener("scroll", () => {
  if (!activeWork()) return;
  updateProgressBar();
  clearTimeout(progressTimer);
  progressTimer = setTimeout(persistProgress, 900);
}, { passive: true });

window.addEventListener("pagehide", () => {
  if (!activeWork()) return;
  persistProgress();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && activeWork()) persistProgress();
});

function openReaderDialog(tab = "chapters") {
  readerNavTab = tab;
  renderChapterDialog();
  $("#chapterDialog").showModal();
}

$("#openChapterDialog").addEventListener("click", () => openReaderDialog("chapters"));
$("#barTocButton").addEventListener("click", () => openReaderDialog("chapters"));
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
  goToHighlight(highlight);
});

$("#highlightLibraryBack").addEventListener("click", () => {
  if (highlightLibraryPreviewId) {
    highlightLibraryPreviewId = null;
    renderHighlightLibrary();
    return;
  }
  highlightLibraryWorkId = null;
  renderHighlightLibrary();
});

$("#closeHighlightLibrary").addEventListener("click", () => $("#highlightLibraryDialog").close());

$("#highlightLibraryList").addEventListener("click", async (event) => {
  const workButton = event.target.closest("[data-highlight-work]");
  if (workButton) {
    highlightLibraryWorkId = workButton.dataset.highlightWork;
    highlightLibraryPreviewId = null;
    renderHighlightLibrary();
    return;
  }

  const selected = highlightLibraryWorkId ? state.works.find((work) => work.id === highlightLibraryWorkId) : null;
  if (!selected) return;

  const deleteButton = event.target.closest("[data-library-delete-highlight]");
  if (deleteButton) {
    if (deleteButton.dataset.libraryDeleteHighlight === highlightLibraryPreviewId) highlightLibraryPreviewId = null;
    await removeHighlightFromWork(selected.id, deleteButton.dataset.libraryDeleteHighlight);
    return;
  }

  const previewBack = event.target.closest("[data-library-preview-back]");
  if (previewBack) {
    highlightLibraryPreviewId = null;
    renderHighlightLibrary();
    return;
  }

  const previewMove = event.target.closest("[data-library-preview-move]");
  if (previewMove) {
    setHighlightPreviewByOffset(Number(previewMove.dataset.libraryPreviewMove || 0));
    return;
  }

  const previewButton = event.target.closest("[data-library-highlight-preview]");
  if (previewButton) {
    highlightLibraryPreviewId = previewButton.dataset.libraryHighlightPreview;
    renderHighlightLibrary();
    return;
  }

  const jumpButton = event.target.closest("[data-library-preview-jump]");
  if (!jumpButton) return;
  const highlight = selected.highlights?.find((item) => item.id === jumpButton.dataset.libraryPreviewJump);
  if (!highlight) return;
  state.selectedWorkId = selected.id;
  $("#highlightLibraryDialog").close();
  goToHighlight(highlight);
});

$("#highlightLibraryList").addEventListener("touchstart", (event) => {
  if (!highlightLibraryPreviewId || !event.touches?.length) return;
  const touch = event.touches[0];
  highlightLibrarySwipe = { x: touch.clientX, y: touch.clientY };
});

$("#highlightLibraryList").addEventListener("touchend", (event) => {
  if (!highlightLibraryPreviewId || !highlightLibrarySwipe || !event.changedTouches?.length) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - highlightLibrarySwipe.x;
  const dy = touch.clientY - highlightLibrarySwipe.y;
  highlightLibrarySwipe = null;
  if (Math.abs(dx) < 46 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
  setHighlightPreviewByOffset(dx < 0 ? 1 : -1);
});

[
  "#readerSettingsDialog",
  "#backgroundDialog",
  "#chapterDialog",
  "#highlightLibraryDialog",
  "#progressColorDialog",
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

lockPortraitMode();
window.addEventListener("orientationchange", () => setTimeout(lockPortraitMode, 80));
screen.orientation?.addEventListener?.("change", lockPortraitMode);

boot().catch((error) => {
  $("#importStatus").textContent = `启动失败：${error.message}`;
});
