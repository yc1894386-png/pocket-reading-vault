import http from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("./public", import.meta.url));
const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 4173);
const sourceHost = [[ "archive", "of", "our", "own" ].join(""), "org"].join(".");
const downloadHost = `download.${sourceHost}`;
const lofterHostPattern = /(^|\.)lofter\.com$/i;
const shoubanjiangHostPattern = /(^|\.)shoubanjiang\.com$/i;
const shauthorHostPattern = /(^|\.)shauthor\.com$/i;
const importCache = new Map();
const imageCache = new Map();
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "https://pocket-reading-vault.onrender.com";
const supabaseUrl = process.env.SUPABASE_URL || "https://bhliywysdezcykoyyozw.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY || "sb_publishable_hh04jm0Nqp3_Jq-3FTcs5w_FbuaSO0v";
const cloudflareWorkerUrl = (process.env.CLOUDFLARE_WORKER_URL || "https://vellum-sync.yc1894386.workers.dev").replace(/\/+$/, "");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100 * 1024 * 1024) {
        reject(new Error("请求太大了。"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("云端请求格式不对。"));
      }
    });
    req.on("error", reject);
  });
}

function sendText(res, status, value) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(value);
}

async function proxyCloudflareSync(req, res, url) {
  const pathname = url.pathname.replace(/^\/api\/sync/, "") || "/";
  const target = `${cloudflareWorkerUrl}${pathname}${url.search || ""}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 22000);
  try {
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > 35 * 1024 * 1024) {
            reject(new Error("同步请求太大了。"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    }
    const response = await fetch(target, {
      method: req.method,
      signal: controller.signal,
      headers: {
        accept: req.headers.accept || "application/json",
        ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {})
      },
      body
    });
    const text = await response.text();
    res.writeHead(response.status, {
      "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, accept",
      "cache-control": "no-store"
    });
    return res.end(text);
  } catch (error) {
    return sendJson(res, error.name === "AbortError" ? 504 : 502, {
      error: error.name === "AbortError" ? "同域同步代理响应超时。" : (error.message || "同域同步代理失败。")
    });
  } finally {
    clearTimeout(timeout);
  }
}

function decodeEntities(value = "") {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_, name) => named[name.toLowerCase()] ?? `&${name};`)
    .trim();
}

function textOnly(value = "") {
  return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

function firstMatch(html, pattern) {
  const match = html.match(pattern);
  return match ? match[1] : "";
}

function allMatches(html, pattern) {
  return [...html.matchAll(pattern)].map((match) => textOnly(match[1])).filter(Boolean);
}

function ddHtmlByLabel(html, labels) {
  const patterns = labels.map((label) => new RegExp(label, "i"));
  for (const match of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const label = textOnly(match[1]).replace(/:$/, "").trim();
    if (patterns.some((pattern) => pattern.test(label))) return match[2];
  }
  return "";
}

function htmlByHeading(html, labels = []) {
  const patterns = labels.map((label) => label instanceof RegExp ? label : new RegExp(label, "i"));
  const headingPattern = /<(h2|h3|h4|dt|strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(headingPattern)) {
    const label = textOnly(match[2]).replace(/:$/, "").trim();
    if (!patterns.some((pattern) => pattern.test(label))) continue;
    const after = html.slice(match.index + match[0].length);
    const next = after.match(/^\s*(<(blockquote|div|section|p)\b[\s\S]*?<\/\2>)/i);
    if (next?.[1] && textLengthFromHtml(next[1]) > 0) return next[1];
  }
  return "";
}

function extractNotesHtml(html = "") {
  const direct = firstMatch(html, /<div[^>]+class=["'][^"']*notes[^"']*["'][^>]*>[\s\S]*?<blockquote[^>]+class=["'][^"']*userstuff[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>[\s\S]*?<\/div>/i)
    || firstMatch(html, /<div[^>]+class=["'][^"']*notes[^"']*["'][^>]*>[\s\S]*?<blockquote[^>]*>([\s\S]*?)<\/blockquote>[\s\S]*?<\/div>/i)
    || firstMatch(html, /<section[^>]+class=["'][^"']*notes[^"']*["'][^>]*>[\s\S]*?<blockquote[^>]*>([\s\S]*?)<\/blockquote>[\s\S]*?<\/section>/i)
    || firstMatch(html, /<[^>]+id=["']notes["'][^>]*>[\s\S]*?<blockquote[^>]*>([\s\S]*?)<\/blockquote>[\s\S]*?<\/[^>]+>/i);
  if (textLengthFromHtml(direct)) return direct;
  const byHeading = htmlByHeading(html, [/^notes?$/i, /^作者的话$/, /^作话$/, /^备注$/]);
  return textLengthFromHtml(byHeading) ? byHeading : "";
}

function tagsFromHtml(value = "") {
  const linked = allMatches(value, /<a[^>]*>([\s\S]*?)<\/a>/gi);
  if (linked.length) return linked;
  return textOnly(value).split(/,\s*/).map((item) => item.trim()).filter(Boolean);
}

function textLengthFromHtml(value = "") {
  return textOnly(value).replace(/\s/g, "").length;
}

function jsonScriptValue(html, variableName) {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<script[^>]*>\\s*${escaped}\\s*=\\s*([\\s\\S]*?)\\s*<\\/script>`, "i"));
  if (!match?.[1]) return null;
  const raw = match[1].replace(/;\s*$/, "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseTitleParts(rawValue = "") {
  const raw = textOnly(rawValue)
    .replace(/\s*\|\s*Archive[\s\S]*$/i, "")
    .replace(/\s*-\s*Archive of Our Own[\s\S]*$/i, "")
    .replace(/\s*-\s*AO3[\s\S]*$/i, "");
  const parts = raw.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const author = parts[parts.length - 1];
    const title = parts.slice(0, -1).filter((part) => !/^chapter\s+\d+/i.test(part)).join(" - ");
    return { title: title || parts[0], author };
  }
  return { title: raw, author: "" };
}

function absoluteUrl(value, baseUrl) {
  if (!value || /^(https?:|data:|blob:)/i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function isProxyableImageUrl(value = "") {
  return /^https?:\/\//i.test(value) && !/^(https?:\/\/)(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.|0\.0\.0\.0)/i.test(value);
}

function isSourceHost(hostname = "") {
  const host = hostname.toLowerCase();
  return host === sourceHost || host.endsWith(`.${sourceHost}`);
}

function isPrivateHostname(hostname = "") {
  const host = hostname.toLowerCase();
  return host === "localhost"
    || host === "0.0.0.0"
    || host.startsWith("127.")
    || host.startsWith("10.")
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    || /^\[?::1\]?$/.test(host);
}

function proxiedImageUrl(value, baseUrl) {
  const absolute = absoluteUrl(value, baseUrl);
  if (!isProxyableImageUrl(absolute)) return absolute;
  const params = new URLSearchParams({ url: absolute });
  if (baseUrl) params.set("ref", baseUrl);
  return `${publicBaseUrl}/api/image?${params.toString()}`;
}

function rewriteSrcset(value = "", baseUrl) {
  return value.split(",").map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return "";
    const [rawUrl, ...rest] = trimmed.split(/\s+/);
    return [proxiedImageUrl(rawUrl, baseUrl), ...rest].join(" ");
  }).filter(Boolean).join(", ");
}

function attrValue(attrs = "", names = []) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = attrs.match(new RegExp(`\\s${escaped}=["']([^"']+)["']`, "i"));
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return "";
}

function firstSrcsetUrl(value = "") {
  return value.split(",")[0]?.trim().split(/\s+/)[0] || "";
}

function extractElementHtml(html, openTagIndex) {
  const open = html.slice(openTagIndex).match(/^<([a-z0-9:-]+)\b[^>]*>/i);
  if (!open) return "";
  const tag = open[1].toLowerCase();
  let depth = 0;
  const pattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = openTagIndex;
  let match;
  while ((match = pattern.exec(html))) {
    const isClose = /^<\//.test(match[0]);
    depth += isClose ? -1 : 1;
    if (depth === 0) return html.slice(openTagIndex, pattern.lastIndex);
  }
  return html.slice(openTagIndex);
}

function findElementHtml(html, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.index !== undefined) {
      const extracted = extractElementHtml(html, match.index);
      if (textLengthFromHtml(extracted) > 40) return extracted;
    }
  }
  return "";
}

function largestElementHtml(html, pattern) {
  let best = "";
  for (const match of html.matchAll(pattern)) {
    const extracted = extractElementHtml(html, match.index);
    if (textLengthFromHtml(extracted) > textLengthFromHtml(best)) best = extracted;
  }
  return best;
}

function explainMissingBody(html, sourceUrl) {
  const plain = textOnly(html).toLowerCase();
  if (/cloudflare|checking your browser|attention required|just a moment/i.test(html)) {
    return "原站给后端返回了防护/验证页，不是作品正文。链接没错，但站点这次没有把正文放行；稍后重试，或在原站 Download → HTML 后导入文件。";
  }
  if (/login|log in|sign in|restricted|archive locked|only registered users/i.test(plain)) {
    return "这个链接需要登录或被限制访问。网页里没有公开正文，所以后端不能直接保存；请在原站登录后 Download → HTML，再回这里导入 HTML 文件。";
  }
  if (/adult content|proceed|view adult/i.test(plain)) {
    return "原站返回的是成人内容确认页，不是作品正文。我已经带了确认参数，但这次仍没放行；请稍后重试，或用 Download → HTML 文件导入。";
  }
  if (/retry later|rate limit|too many requests|429/i.test(plain)) {
    return "原站正在限流，返回的不是作品正文。先等几分钟再试；急着保存就用 Download → HTML 文件导入。";
  }
  if (/works\/\d+/i.test(sourceUrl)) {
    return "链接看起来没错，但这次拿到的页面结构里没有正文容器。可能是原站临时返回了空壳页/提示页；我已加备用识别规则，仍失败时请用 Download → HTML 导入。";
  }
  return "没有在这个页面里找到正文。请确认链接是作品页；如果你确定链接没错，通常是原站这次返回了提示页而不是正文。";
}

function cleanWorkHtml(html, sourceUrl) {
  let chapters = findElementHtml(html, [
    /<div[^>]+id=["']chapters["'][^>]*>/i,
    /<div[^>]+id=["']workskin["'][^>]*>/i,
    /<main\b[^>]*>/i,
    /<article\b[^>]*>/i
  ]);
  if (!chapters) chapters = largestElementHtml(html, /<(div|section|blockquote)[^>]+class=["'][^"']*userstuff[^"']*["'][^>]*>/gi);

  return sanitizeImportedHtml(chapters, sourceUrl);
}

function sanitizeImportedHtml(html = "", sourceUrl = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=["'][\s\S]*?["']/gi, "")
    .replace(/href=["']javascript:[\s\S]*?["']/gi, "")
    .replace(/<img\b([^>]*)>/gi, (tag, attrs) => {
      const src = attrValue(attrs, [
        "src",
        "data-src",
        "data-original",
        "data-lazy-src",
        "data-cfsrc",
        "data-orig-src",
        "data-hi-res-src",
        "data-full-src",
        "data-image-src",
        "data-original-src",
        "data-actualsrc",
        "data-url",
        "data-img-url",
        "data-preview-src",
        "data-large-file",
        "data-medium-file",
        "data-orig-file"
      ]);
      const srcset = attrValue(attrs, [
        "srcset",
        "data-srcset",
        "data-lazy-srcset",
        "data-cfsrcset",
        "data-original-srcset"
      ]);
      const original = src || firstSrcsetUrl(srcset);
      let nextAttrs = attrs
        .replace(/\s(?:src|srcset|data-src|data-original|data-lazy-src|data-cfsrc|data-orig-src|data-hi-res-src|data-full-src|data-image-src|data-original-src|data-actualsrc|data-url|data-img-url|data-preview-src|data-large-file|data-medium-file|data-orig-file|data-srcset|data-lazy-srcset|data-cfsrcset|data-original-srcset)=["'][^"']*["']/gi, "")
        .replace(/\sloading=["'][^"']*["']/i, "")
        .replace(/\sdecoding=["'][^"']*["']/i, "");
      if (original) {
        nextAttrs += ` src="${proxiedImageUrl(original, sourceUrl)}"`;
        nextAttrs += ` data-original-src="${absoluteUrl(original, sourceUrl)}"`;
      }
      if (srcset) nextAttrs += ` srcset="${rewriteSrcset(srcset, sourceUrl)}"`;
      nextAttrs += ` loading="lazy" decoding="async"`;
      return `<img${nextAttrs}>`;
    })
    .replace(/\bhref=["']([^"']+)["']/gi, (_, url) => `href="${absoluteUrl(url, sourceUrl)}"`);
}

function validReferer(value = "") {
  try {
    const parsed = new URL(value);
    return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

async function fetchImageAttempt(targetUrl, referer, signal) {
  const headers = {
    "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  };
  if (referer) {
    headers.referer = referer;
    try {
      headers.origin = new URL(referer).origin;
    } catch {}
  }
  return fetch(targetUrl, {
    redirect: "follow",
    signal,
    headers
  });
}

async function proxyImage(targetUrl, refererUrl = "") {
  if (!isProxyableImageUrl(targetUrl)) {
    const error = new Error("不支持这个图片地址。");
    error.status = 400;
    throw error;
  }
  const referer = validReferer(refererUrl);
  const cached = imageCache.get(`${targetUrl}|${referer}`);
  if (cached && Date.now() - cached.at < 1000 * 60 * 60 * 24) return cached;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const targetOrigin = new URL(targetUrl).origin;
    const referers = [...new Set([
      referer,
      targetOrigin,
      `${targetOrigin}/`,
      `https://${sourceHost}/`,
      ""
    ].filter((item) => item !== undefined))];
    let response;
    let lastError;
    for (const nextReferer of referers) {
      try {
        response = await fetchImageAttempt(targetUrl, nextReferer, controller.signal);
        if (response.ok) break;
        lastError = new Error(`图片源返回了 ${response.status}`);
        lastError.status = response.status;
      } catch (error) {
        lastError = error;
      }
    }
    if (!response || !response.ok) throw lastError || new Error("图片暂时不能读取。");
    if (!response.ok) {
      const error = new Error(`图片源返回了 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const type = response.headers.get("content-type") || "application/octet-stream";
    const bytes = Buffer.from(await response.arrayBuffer());
    const image = { type, bytes, at: Date.now() };
    imageCache.set(`${targetUrl}|${referer}`, image);
    if (imageCache.size > 160) imageCache.delete(imageCache.keys().next().value);
    return image;
  } finally {
    clearTimeout(timeout);
  }
}

function cleanSyncCode(value = "") {
  return String(value).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
}

function cloudShardKey(syncCode, work = {}) {
  const hash = createHash("sha1")
    .update(`${syncCode}|${work.id || work.sourceUrl || work.title || Math.random()}`)
    .digest("base64url")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 10);
  return `${syncCode}-W-${hash}`.slice(0, 32);
}

function compressCloudState(state) {
  if (!state || state._vellumCompressed) return state;
  const json = JSON.stringify(state);
  const compressed = gzipSync(Buffer.from(json, "utf8")).toString("base64");
  return {
    _vellumCompressed: 1,
    format: "gzip-base64-json",
    data: compressed,
    originalLength: json.length,
    compressedLength: compressed.length,
    writer: state._lastWriter || "",
    writerAt: state._lastWriterAt || new Date().toISOString(),
    compressedBy: "render"
  };
}

function decompressCloudState(state) {
  if (!state?._vellumCompressed) return state;
  const text = gunzipSync(Buffer.from(state.data || "", "base64")).toString("utf8");
  return JSON.parse(text);
}

function lightweightWork(work = {}, shardKey = "") {
  const {
    contentHtml,
    summaryHtml,
    notesHtml,
    highlights,
    bookmarks,
    ...rest
  } = work;
  return {
    ...rest,
    contentHtml: "",
    summaryHtml: "",
    notesHtml: "",
    highlights: [],
    bookmarks: [],
    shardKey,
    hasCloudShard: true
  };
}

function makeShardedManifest(state, syncCode) {
  const works = Array.isArray(state?.works) ? state.works : [];
  return {
    ...state,
    works: works.map((work) => lightweightWork(work, cloudShardKey(syncCode, work))),
    _vellumSharded: 1,
    shardVersion: 1,
    shardCount: works.length,
    shardedAt: new Date().toISOString()
  };
}

function buildShardRows(syncCode, state) {
  const works = Array.isArray(state?.works) ? state.works : [];
  const now = new Date().toISOString();
  const rows = [
    {
      sync_code: syncCode,
      state: compressCloudState(makeShardedManifest(state, syncCode)),
      updated_at: now
    }
  ];
  for (const work of works) {
    rows.push({
      sync_code: cloudShardKey(syncCode, work),
      state: compressCloudState({
        _vellumWorkShard: 1,
        parentSyncCode: syncCode,
        workId: work.id || "",
        work,
        updatedAt: work.updatedAt || now
      }),
      updated_at: work.updatedAt || now
    });
  }
  return rows;
}

async function supabaseSharedRequest({ method = "GET", syncCode = "", state = null }) {
  const code = cleanSyncCode(syncCode);
  if (!/^[A-Z0-9-]{8,32}$/.test(code)) {
    const error = new Error("同步码格式不对。");
    error.status = 400;
    throw error;
  }
  const headers = {
    apikey: supabaseKey,
    authorization: `Bearer ${supabaseKey}`,
    accept: "application/json"
  };
  let url = `${supabaseUrl}/rest/v1/shared_library_states`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const options = { method, headers, signal: controller.signal };
  if (method === "GET") {
    url += `?select=state,updated_at&sync_code=eq.${encodeURIComponent(code)}&limit=1`;
  } else {
    headers["content-type"] = "application/json";
    headers.prefer = "resolution=merge-duplicates,return=minimal";
    url += "?on_conflict=sync_code";
    options.body = JSON.stringify({
      sync_code: code,
      state,
      updated_at: new Date().toISOString()
    });
  }
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      let detail = "";
      try {
        const json = await response.json();
        detail = json.message || json.details || JSON.stringify(json);
      } catch {
        detail = await response.text();
      }
      const error = new Error(`${response.status} ${detail}`.trim());
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("云端备用通道连接 Supabase 超时。");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function supabaseSharedBulkUpsert(rows = []) {
  if (!rows.length) return null;
  const url = `${supabaseUrl}/rest/v1/shared_library_states?on_conflict=sync_code`;
  const headers = {
    apikey: supabaseKey,
    authorization: `Bearer ${supabaseKey}`,
    accept: "application/json",
    "content-type": "application/json",
    prefer: "resolution=merge-duplicates,return=minimal"
  };
  for (let index = 0; index < rows.length; index += 25) {
    const batch = rows.slice(index, index + 25);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(batch)
      });
      if (!response.ok) {
        let detail = "";
        try {
          const json = await response.json();
          detail = json.message || json.details || JSON.stringify(json);
        } catch {
          detail = await response.text();
        }
        const error = new Error(`${response.status} ${detail}`.trim());
        error.status = response.status;
        throw error;
      }
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("云端分篇上传超时。");
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

async function supabaseSharedGetMany(syncCodes = []) {
  const rows = [];
  const uniqueCodes = [...new Set(syncCodes.map(cleanSyncCode).filter(Boolean))];
  for (let index = 0; index < uniqueCodes.length; index += 40) {
    const batch = uniqueCodes.slice(index, index + 40);
    const encoded = batch.map((code) => `"${code}"`).join(",");
    const url = `${supabaseUrl}/rest/v1/shared_library_states?select=sync_code,state,updated_at&sync_code=in.(${encoded})`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          apikey: supabaseKey,
          authorization: `Bearer ${supabaseKey}`,
          accept: "application/json"
        }
      });
      if (!response.ok) {
        let detail = "";
        try {
          const json = await response.json();
          detail = json.message || json.details || JSON.stringify(json);
        } catch {
          detail = await response.text();
        }
        const error = new Error(`${response.status} ${detail}`.trim());
        error.status = response.status;
        throw error;
      }
      rows.push(...await response.json());
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("云端分篇读取超时。");
        timeoutError.status = 504;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  return rows;
}

async function saveCloudStateSharded(syncCode, state) {
  const plainState = decompressCloudState(state);
  const rows = buildShardRows(syncCode, plainState);
  await supabaseSharedBulkUpsert(rows);
  return {
    ok: true,
    sharded: true,
    works: Array.isArray(plainState?.works) ? plainState.works.length : 0,
    rows: rows.length
  };
}

async function loadCloudStateSharded(row) {
  if (!row?.state) return row;
  const state = decompressCloudState(row.state);
  if (!state?._vellumSharded) {
    row.state = state;
    return row;
  }
  const refs = Array.isArray(state.works) ? state.works : [];
  const shardKeys = refs.map((work) => work.shardKey).filter(Boolean);
  const shardRows = await supabaseSharedGetMany(shardKeys);
  const shardMap = new Map(shardRows.map((item) => [item.sync_code, decompressCloudState(item.state)]));
  row.state = {
    ...state,
    works: refs.map((ref) => {
      const shard = shardMap.get(ref.shardKey);
      return shard?.work ? { ...ref, ...shard.work } : ref;
    })
  };
  return row;
}

function parseLofterWork(html, sourceUrl) {
  const init = jsonScriptValue(html, "window.__initialize_data__");
  const payload = init?.postData?.data || init?.data || {};
  const postView = payload?.postData?.postView || payload?.postView || {};
  const blogInfo = payload?.blogInfo || {};
  if (!postView?.id && !postView?.title && !postView?.digest && !postView?.photoPostView) {
    throw new Error("LOFTER 页面没有把作品数据放出来。可能需要登录、被限制访问，或页面临时没有加载完整数据。");
  }

  const photoView = postView.photoPostView || {};
  const textView = postView.textPostView || {};
  const title = textOnly(postView.title || textView.title || photoView.title || "") || "LOFTER 未命名作品";
  const author = textOnly(blogInfo.blogNickName || blogInfo.blogName || "") || "LOFTER 作者";
  const caption = photoView.caption || textView.content || postView.content || postView.digest || "";
  const photoLinks = [
    ...(photoView.photoLinks || []),
    ...(postView.photoLinks || [])
  ];
  const seenImages = new Set();
  const imageHtml = photoLinks.map((photo, index) => {
    const raw = photo.raw || photo.orign || photo.origin || photo.url || photo.middle || "";
    if (!raw || seenImages.has(raw)) return "";
    seenImages.add(raw);
    const proxied = proxiedImageUrl(raw, sourceUrl);
    const original = absoluteUrl(raw, sourceUrl);
    const alt = `${title} 图片 ${index + 1}`;
    const width = Number(photo.ow || photo.width || 0);
    const height = Number(photo.oh || photo.height || 0);
    const sizeAttrs = `${width ? ` width="${width}"` : ""}${height ? ` height="${height}"` : ""}`;
    return `<figure class="lofter-image"><img src="${proxied}" data-original-src="${original}" alt="${alt}" loading="lazy" decoding="async"${sizeAttrs}></figure>`;
  }).filter(Boolean).join("\n");

  const contentHtml = `<article class="lofter-work">
    <section class="lofter-caption">${caption}</section>
    ${imageHtml}
  </article>`;
  if (textLengthFromHtml(contentHtml) < 10 && !imageHtml) {
    throw new Error("LOFTER 页面能打开，但没有找到正文或图片。这个页面可能需要登录或被作者限制。");
  }

  const tags = Array.isArray(postView.tagList) ? postView.tagList.map(textOnly).filter(Boolean) : [];
  const words = textLengthFromHtml(contentHtml);
  return {
    title,
    author,
    sourceUrl,
    importedAt: new Date().toISOString(),
    summaryHtml: tags.length ? `<p>${tags.map((tag) => `#${tag}`).join(" ")}</p>` : "",
    contentHtml,
    metadata: {
      rating: "LOFTER",
      categories: ["LOFTER"],
      fandoms: tags,
      warnings: [],
      relationships: [],
      characters: [],
      freeforms: tags,
      words: `${words} 字`,
      chapters: "1/1",
      status: "完结",
      language: "中文",
      kudos: payload?.postData?.postCountView?.favoriteCount ? String(payload.postData.postCountView.favoriteCount) : ""
    }
  };
}

async function parseReadableWork(html, sourceUrl) {
  let JSDOM;
  let Readability;
  try {
    ({ JSDOM } = await import("jsdom"));
    ({ Readability } = await import("@mozilla/readability"));
  } catch {
    throw new Error("通用阅读模式还没有安装完成。请上传包含 package.json 的最外层文件，等 Render 重新部署后再试。");
  }

  const dom = new JSDOM(html, {
    url: sourceUrl,
    contentType: "text/html"
  });
  const reader = new Readability(dom.window.document, {
    charThreshold: 120,
    keepClasses: true
  });
  const article = reader.parse();
  if (!article?.content || textLengthFromHtml(article.content) < 80) {
    throw new Error("通用阅读模式没有提取到足够正文。这个网页可能是动态加载、需要登录，或正文被分页/防护隐藏。");
  }

  const contentHtml = sanitizeImportedHtml(article.content, sourceUrl);
  const title = textOnly(article.title || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)) || "网页导入";
  const byline = textOnly(article.byline || "");
  const excerpt = article.excerpt ? `<p>${textOnly(article.excerpt)}</p>` : "";
  return {
    title,
    author: byline || new URL(sourceUrl).hostname.replace(/^www\./, ""),
    sourceUrl,
    importedAt: new Date().toISOString(),
    summaryHtml: excerpt,
    contentHtml,
    metadata: {
      rating: "网页",
      categories: ["通用阅读模式"],
      fandoms: [],
      warnings: [],
      relationships: [],
      characters: [],
      freeforms: ["通用导入"],
      words: `${textLengthFromHtml(contentHtml)} 字`,
      chapters: "1/1",
      status: "网页导入",
      language: ""
    }
  };
}

function uniqueShoubanjiangChapters(html, sourceUrl) {
  const items = [];
  const seen = new Set();
  for (const match of html.matchAll(/<li>\s*<a[^>]+href=["']([^"']*\/book\/\d+\/\d+(?:_\d+)?\.html)["'][^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi)) {
    const href = absoluteUrl(match[1], sourceUrl);
    const canonical = href.replace(/_(\d+)(\.html)$/i, "$2");
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    items.push({
      url: canonical,
      title: textOnly(match[2]) || `第 ${items.length + 1} 章`,
      order: Number(canonical.match(/\/(\d+)(?:_\d+)?\.html/i)?.[1] || items.length)
    });
  }
  return items.sort((a, b) => a.order - b.order);
}

function parseShoubanjiangPage(html, pageUrl) {
  const rawTitle = textOnly(firstMatch(html, /<div[^>]+class=["']chapter_name["'][^>]*>([\s\S]*?)<\/div>/i));
  const title = rawTitle.replace(/\s*\(\s*\d+\s*\/\s*\d+\s*\)\s*$/i, "").trim();
  let content = firstMatch(html, /<div[^>]+class=["']chapter_content["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!content || textOnly(content).replace(/\s/g, "").length < 20) {
    throw new Error("章节页没有返回正文，可能被原站临时拦截了。");
  }
  content = content
    .replace(/内容未完，下一页继续阅读/g, "")
    .replace(/^\s*<br\s*\/?>/i, "");
  const nextPageHref = firstMatch(html, /<a[^>]+href=["']([^"']+)["'][^>]*>\s*下一页\s*<\/a>/i);
  const nextPage = nextPageHref ? absoluteUrl(nextPageHref, pageUrl) : "";
  return { title, content: sanitizeImportedHtml(content, pageUrl), nextPage };
}

async function parseShoubanjiangWork(html, sourceUrl) {
  if (!/catalog_info|catalog_list|chapter_list|\/book\/\d+\/\d+(?:_\d+)?\.html/i.test(html)) {
    throw new Error("这个站点这次返回的是拦截页，不是真正目录。请稍后再试，或在浏览器打开原文后用手动导入保存。");
  }
  const title = textOnly(firstMatch(html, /<div[^>]+class=["']catalog_info_right["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/i))
    || textOnly(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)).replace(/最新章节[\s\S]*$/i, "")
    || "笔趣阁小说";
  const author = textOnly(firstMatch(html, /<div[^>]+class=["']catalog_author["'][^>]*>\s*作者：\s*(?:<a[^>]*>)?([\s\S]*?)(?:<\/a>)?\s*<\/div>/i)) || "作者待补";
  const category = textOnly(firstMatch(html, /<span[^>]+class=["']s1["'][^>]*>([\s\S]*?)<\/span>/i));
  const status = textOnly(firstMatch(html, /<span[^>]+class=["']s2["'][^>]*>([\s\S]*?)<\/span>/i));
  const intro = firstMatch(html, /<div[^>]+class=["']catalog_intor["'][^>]*>([\s\S]*?)<\/div>/i)
    .replace(/^\s*本书简介：?/i, "");
  const chapters = uniqueShoubanjiangChapters(html, sourceUrl).slice(0, 80);
  if (!chapters.length) {
    throw new Error("这个目录页能打开，但没有找到章节链接。");
  }

  const pageCounter = { count: 0, clipped: false };
  const maxPages = 360;
  const fetchChapter = async (chapter, index) => {
    const parts = [];
    let currentUrl = chapter.url;
    let chapterTitle = chapter.title;
    const seenPages = new Set();
    for (let page = 0; currentUrl && page < 40; page += 1) {
      if (seenPages.has(currentUrl) || pageCounter.count >= maxPages) {
        pageCounter.clipped = pageCounter.count >= maxPages;
        break;
      }
      seenPages.add(currentUrl);
      pageCounter.count += 1;
      const pageHtml = await fetchHtml(currentUrl, "章节页");
      const parsed = parseShoubanjiangPage(pageHtml, currentUrl);
      chapterTitle = parsed.title || chapterTitle;
      if (parsed.content) parts.push(parsed.content);
      const sameChapter = parsed.nextPage
        && parsed.nextPage.replace(/_(\d+)(\.html)$/i, "$2") === chapter.url;
      currentUrl = sameChapter ? parsed.nextPage : "";
    }
    return {
      index,
      html: `<section class="chapter" id="chapter-${index + 1}">
        <h2>${textOnly(chapterTitle) || `第 ${index + 1} 章`}</h2>
        <div class="chapter-body">${parts.join("<br><br>")}</div>
      </section>`
    };
  };

  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, chapters.length) }, async () => {
    while (cursor < chapters.length && pageCounter.count < maxPages) {
      const index = cursor;
      cursor += 1;
      results[index] = await fetchChapter(chapters[index], index);
    }
  });
  await Promise.all(workers);

  const contentHtml = results.filter(Boolean).sort((a, b) => a.index - b.index).map((item) => item.html).join("\n");
  const clippedNote = pageCounter.clipped
    ? "<p>注：为了避免一次导入过久，这次先保存了前 180 个分页；剩余章节可以之后再做增量导入。</p>"
    : "";
  const summaryHtml = `<p>${intro ? textOnly(intro) : ""}</p>${clippedNote}`;
  return {
    title,
    author,
    sourceUrl,
    importedAt: new Date().toISOString(),
    summaryHtml,
    contentHtml,
    metadata: {
      rating: "网页",
      categories: category ? [category] : ["网页小说"],
      fandoms: [],
      warnings: [],
      relationships: [],
      characters: [],
      freeforms: ["笔趣阁目录导入"],
      words: `${textLengthFromHtml(contentHtml)} 字`,
      chapters: `${results.filter(Boolean).length}/${chapters.length}`,
      status: pageCounter.clipped ? "部分导入" : (status || "网页导入"),
      language: "中文"
    }
  };
}

function uniqueShauthorChapters(html, sourceUrl) {
  const allIndex = html.indexOf("全部章节");
  const allHtml = allIndex >= 0 ? html.slice(allIndex) : html;
  const allBlock = firstMatch(allHtml, /<ul[^>]*class=["']p2["'][^>]*>([\s\S]*?)<\/ul>/i)
    || firstMatch(allHtml, /<ul[^>]*>([\s\S]*?)<\/ul>/i)
    || allHtml;
  const items = [];
  const seen = new Set();
  for (const match of allBlock.matchAll(/<a[^>]+href=["']([^"']*\/read_[^"']+\/[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = absoluteUrl(match[1], sourceUrl);
    const canonical = href.replace(/_(\d+)(\.html)$/i, "$2");
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    items.push({
      url: canonical,
      title: textOnly(match[2]) || `第 ${items.length + 1} 章`
    });
  }
  return items;
}

async function fetchHtmlWithRetry(url, label, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchHtml(url, label);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(700 * attempt);
    }
  }
  throw lastError;
}

function parseShauthorPage(html, pageUrl) {
  const rawTitle = textOnly(firstMatch(html, /<div[^>]+id=["']chapterSet["'][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const title = rawTitle
    .replace(/\s*\(\s*\d+\s*\/\s*\d+\s*\)\s*/i, "")
    .replace(/_[\s\S]*$/i, "")
    .trim();
  let content = firstMatch(html, /<div[^>]+id=["']novelcontent["'][^>]*>([\s\S]*?)<div[^>]+class=["']page_chapter["'][^>]*>/i)
    || firstMatch(html, /<div[^>]+id=["']novelcontent["'][^>]*>([\s\S]*?)<\/div>/i);
  content = content
    .replace(/<p>\s*<font[^>]*>[\s\S]*?<\/font>\s*<\/p>/gi, "")
    .replace(/内容未完，下一页继续阅读/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/^\s*<br\s*\/?>/i, "");
  if (!content || textOnly(content).replace(/\s/g, "").length < 20) {
    throw new Error("章节页没有返回正文，可能被站点临时拦截或限速了。");
  }
  const nextPageHref = firstMatch(html, /<a[^>]+href=["']([^"']+)["'][^>]*class=["']p4["'][^>]*>\s*下一页\s*<\/a>/i)
    || firstMatch(html, /<a[^>]+class=["']p4["'][^>]*href=["']([^"']+)["'][^>]*>\s*下一页\s*<\/a>/i)
    || firstMatch(html, /<a[^>]+href=["']([^"']+)["'][^>]*>\s*下一页\s*<\/a>/i);
  const nextPage = nextPageHref ? absoluteUrl(nextPageHref, pageUrl) : "";
  return { title, content: sanitizeImportedHtml(content, pageUrl), nextPage };
}

async function parseShauthorWork(html, sourceUrl) {
  if (!/info_chapters|\/read_[^"']+\/[^"']+\.html/i.test(html)) {
    throw new Error("这个页面没有返回可读取的章节目录，可能是站点临时拦截或页面结构变化。");
  }
  const title = textOnly(firstMatch(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || firstMatch(html, /<h1[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>\s*<\/h1>/i)
    || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)).replace(/_[\s\S]*$/i, "") || "网页小说";
  const author = textOnly(firstMatch(html, /<p[^>]*class=["']author["'][^>]*>([\s\S]*?)<\/p>/i)
    || firstMatch(html, /_\(([^)]+)\)_最新章节列表/i)
    || firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)的最新上架小说/i)) || "作者待补";
  const intro = firstMatch(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["'][^>]*>/i)
    || firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i);
  const chapters = uniqueShauthorChapters(html, sourceUrl).slice(0, 100);
  if (!chapters.length) throw new Error("这个目录页能打开，但没有找到章节链接。");

  const pageCounter = { count: 0, clipped: false };
  const maxPages = 360;
  const fetchChapter = async (chapter, index) => {
    const parts = [];
    let currentUrl = chapter.url;
    let chapterTitle = chapter.title;
    const seenPages = new Set();
    for (let page = 0; currentUrl && page < 45; page += 1) {
      if (seenPages.has(currentUrl) || pageCounter.count >= maxPages) {
        pageCounter.clipped = pageCounter.count >= maxPages;
        break;
      }
      seenPages.add(currentUrl);
      pageCounter.count += 1;
      const pageHtml = await fetchHtmlWithRetry(currentUrl, "章节页", 2);
      const parsed = parseShauthorPage(pageHtml, currentUrl);
      chapterTitle = parsed.title || chapterTitle;
      if (parsed.content) parts.push(parsed.content);
      const sameChapter = parsed.nextPage
        && parsed.nextPage.replace(/_(\d+)(\.html)$/i, "$2") === chapter.url;
      currentUrl = sameChapter ? parsed.nextPage : "";
    }
    if (!parts.length) throw new Error(`第 ${index + 1} 章没有抓到正文`);
    return {
      index,
      html: `<section class="chapter" id="chapter-${index + 1}">
        <h2>${textOnly(chapterTitle) || `第 ${index + 1} 章`}</h2>
        <div class="chapter-body">${parts.join("<br><br>")}</div>
      </section>`
    };
  };

  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, chapters.length) }, async () => {
    while (cursor < chapters.length && pageCounter.count < maxPages) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await fetchChapter(chapters[index], index);
      } catch {
        results[index] = null;
      }
    }
  });
  await Promise.all(workers);

  const saved = results.filter(Boolean);
  if (!saved.length) throw new Error("章节目录能打开，但章节正文读取失败。可能是站点临时限速，请稍后再试。");
  const contentHtml = saved.sort((a, b) => a.index - b.index).map((item) => item.html).join("\n");
  const clippedNote = pageCounter.clipped || saved.length < chapters.length
    ? `<p>注：这次保存了 ${saved.length}/${chapters.length} 章；站点有分页/限速，剩余章节可以稍后重新导入覆盖。</p>`
    : "";
  return {
    title,
    author,
    sourceUrl,
    importedAt: new Date().toISOString(),
    summaryHtml: `<p>${textOnly(intro || "")}</p>${clippedNote}`,
    contentHtml,
    metadata: {
      rating: "网页",
      categories: ["网页小说"],
      fandoms: [],
      warnings: [],
      relationships: [],
      characters: [],
      freeforms: ["大众文学目录导入"],
      words: `${textLengthFromHtml(contentHtml)} 字`,
      chapters: `${saved.length}/${chapters.length}`,
      status: saved.length === chapters.length ? "网页导入" : "部分导入",
      language: "中文"
    }
  };
}

async function parseImportedWork(html, sourceUrl) {
  const hostname = new URL(sourceUrl).hostname;
  if (lofterHostPattern.test(hostname)) return parseLofterWork(html, sourceUrl);
  if (shoubanjiangHostPattern.test(hostname)) return parseShoubanjiangWork(html, sourceUrl);
  if (shauthorHostPattern.test(hostname)) return parseShauthorWork(html, sourceUrl);
  if (isSourceHost(hostname)) return parseSourceWork(html, sourceUrl);
  return parseReadableWork(html, sourceUrl);
}

function parseSourceWork(html, sourceUrl) {
  if (lofterHostPattern.test(new URL(sourceUrl).hostname)) return parseLofterWork(html, sourceUrl);
  const titleParts = parseTitleParts(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const title = textOnly(firstMatch(html, /<h2[^>]+class=["'][^"']*title[^"']*heading[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i))
    || textOnly(firstMatch(html, /<h1[^>]+class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i))
    || titleParts.title
    || "未命名作品";
  const author = textOnly(firstMatch(html, /<h3[^>]+class=["'][^"']*byline[^"']*heading[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i))
    || textOnly(firstMatch(html, /<[^>]+class=["'][^"']*byline[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i))
    || textOnly(firstMatch(html, /<a[^>]+rel=["']author["'][^>]*>([\s\S]*?)<\/a>/i))
    || textOnly(firstMatch(html, /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["'][^>]*>/i))
    || textOnly(firstMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']author["'][^>]*>/i))
    || titleParts.author;
  const summary = firstMatch(html, /<blockquote[^>]+class=["'][^"']*userstuff[^"']*summary[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i)
    || firstMatch(html, /<div[^>]+class=["'][^"']*summary[^"']*["'][^>]*>[\s\S]*?<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i);
  const notesHtml = extractNotesHtml(html);
  const rating = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*rating[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["rating", "分级"]));
  const categories = tagsFromHtml(firstMatch(html, /<dd[^>]+class=["'][^"']*category[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["category", "分类"]));
  const fandoms = tagsFromHtml(firstMatch(html, /<dd[^>]+class=["'][^"']*fandom[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["fandoms?", "原作"]));
  const warnings = tagsFromHtml(firstMatch(html, /<dd[^>]+class=["'][^"']*warning[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["archive warnings?", "warnings?", "警告"]));
  const relationships = tagsFromHtml(firstMatch(html, /<dd[^>]+class=["'][^"']*relationship[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["relationships?", "关系", "CP"]));
  const characters = tagsFromHtml(firstMatch(html, /<dd[^>]+class=["'][^"']*character[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["characters?", "角色"]));
  const freeforms = tagsFromHtml(firstMatch(html, /<dd[^>]+class=["'][^"']*freeform[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["additional tags?", "freeforms?", "其他标签"]));
  const words = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*words[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i))
    || textOnly(ddHtmlByLabel(html, ["words", "字数"]));
  const chapters = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*chapters[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["chapters", "章节"]));
  const status = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*status[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["status", "状态"]));
  const language = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*language[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i) || ddHtmlByLabel(html, ["language", "语言"]));
  const contentHtml = cleanWorkHtml(html, sourceUrl);

  if (!contentHtml || contentHtml.length < 80) {
    throw new Error(explainMissingBody(html, sourceUrl));
  }

  return {
    title,
    author: author || "作者待补",
    sourceUrl,
    importedAt: new Date().toISOString(),
    summaryHtml: summary,
    notesHtml,
    contentHtml,
    metadata: {
      rating,
      categories,
      fandoms,
      warnings,
      relationships,
      characters,
      freeforms,
      words: words || `${textLengthFromHtml(contentHtml)} 字`,
      chapters,
      status,
      language
    }
  };
}

function normalizeSourceUrl(url) {
  const parsed = new URL(url);
  if (!/^https?:$/i.test(parsed.protocol) || isPrivateHostname(parsed.hostname)) {
    throw new Error("这个链接不能导入。请使用公开的 http/https 网页链接。");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (lofterHostPattern.test(hostname)) {
    return parsed;
  }
  if (shoubanjiangHostPattern.test(hostname)) {
    parsed.hash = "";
    return parsed;
  }
  if (!isSourceHost(hostname)) {
    return parsed;
  }
  parsed.pathname = parsed.pathname.replace(/\/chapters\/\d+\/?$/i, "");
  parsed.searchParams.set("view_adult", "true");
  parsed.searchParams.set("view_full_work", "true");
  return parsed;
}

function getWorkId(parsed) {
  return parsed.pathname.match(/\/works\/(\d+)/i)?.[1] || "";
}

function getDownloadUrls(parsed) {
  if (lofterHostPattern.test(parsed.hostname)) return [];
  if (shoubanjiangHostPattern.test(parsed.hostname)) return [];
  if (!isSourceHost(parsed.hostname)) return [];
  const workId = getWorkId(parsed);
  if (!workId) return [];
  return [
    `https://${downloadHost}/downloads/${workId}/work.html`,
    `https://${sourceHost}/downloads/${workId}/work.html`,
    `https://${downloadHost}/downloads/${workId}/fic.html`,
    `https://${sourceHost}/downloads/${workId}/fic.html`
  ];
}

function requestHeaders(url) {
  const parsed = new URL(url);
  const isLofter = lofterHostPattern.test(parsed.hostname);
  return {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "referer": url,
    "user-agent": isLofter
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "cookie": "view_adult=true; viewed_adult=true"
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtmlWithPython(url, label) {
  const script = `
import sys
import urllib.request
url = sys.argv[1]
req = urllib.request.Request(url, headers={
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cookie": "view_adult=true; viewed_adult=true",
})
with urllib.request.urlopen(req, timeout=30) as res:
    status = getattr(res, "status", 200)
    if status < 200 or status >= 300:
        raise RuntimeError(f"{status}")
    sys.stdout.buffer.write(res.read())
`.trim();
  const commands = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  const errors = [];
  for (const command of commands) {
    try {
      const { stdout } = await execFileAsync(command, ["-c", script, url], {
        timeout: 35000,
        maxBuffer: 1024 * 1024 * 12,
        windowsHide: true
      });
      if (stdout && stdout.trim()) return stdout;
    } catch (error) {
      errors.push(error);
    }
  }
  const error = new Error(`${label}备用读取也失败了`);
  error.cause = errors[errors.length - 1];
  throw error;
}

async function fetchHtml(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: requestHeaders(url)
      });

      if (!response.ok) {
        const error = new Error(`${label}返回了 ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.text();
    } catch (error) {
      const hostname = new URL(url).hostname;
      if (shoubanjiangHostPattern.test(hostname)) return await fetchHtmlWithPython(url, label);
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFirstAvailable(candidates) {
  const errors = [];
  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return {
          html: await fetchHtml(candidate.url, candidate.label),
          url: candidate.url
        };
      } catch (error) {
        errors.push(error);
        if (attempt < 3 && [429, 525].includes(error.status)) await wait(1200 * attempt);
        else break;
      }
    }
  }

  const statuses = errors.map((error) => error.status).filter(Boolean);
  if (statuses.includes(429)) {
    throw new Error("原站正在限流（429），它觉得访问太频繁了。我已经试过作品页和备用 HTML 下载源；先等 5 到 10 分钟再试。如果急着保存，请在原站点 Download → HTML 后回这里导入 HTML 文件。");
  }
  if (statuses.includes(403)) {
    throw new Error("原站或 HTML 下载源拒绝访问（403）。这通常是站点临时防护，不是链接错了；我已经试过多个备用下载地址。请稍后重试，或用 Download → HTML 文件导入。");
  }
  if (statuses.includes(525)) {
    throw new Error("原站返回了 525，备用 HTML 下载源也没有成功。可以稍后再试，或先用原站 Download → HTML 导入。");
  }
  const lastError = errors[errors.length - 1];
  throw new Error(lastError?.message || "暂时不能读取这个链接。");
}

async function importSource(url) {
  const parsed = normalizeSourceUrl(url);
  const cacheKey = getWorkId(parsed) || parsed.toString();
  const cached = importCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 1000 * 60 * 60 * 12) return cached.work;
  const candidates = [{ url: parsed.toString(), label: "原站" }];
  for (const downloadUrl of getDownloadUrls(parsed)) {
    candidates.push({ url: downloadUrl, label: "HTML 下载源" });
  }

  const result = await fetchFirstAvailable(candidates);
  const work = await parseImportedWork(result.html, result.url);
  importCache.set(cacheKey, { at: Date.now(), work });
  return work;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, accept"
      });
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/sync" || url.pathname.startsWith("/api/sync/")) {
      return proxyCloudflareSync(req, res, url);
    }

    if (url.pathname === "/api/import") {
      const source = url.searchParams.get("url");
      if (!source) return sendJson(res, 400, { error: "缺少原站链接。" });
      try {
        return sendJson(res, 200, await importSource(source));
      } catch (error) {
        return sendJson(res, 422, { error: error.message });
      }
    }

    if (url.pathname === "/api/image") {
      const source = url.searchParams.get("url");
      const referer = url.searchParams.get("ref") || "";
      if (!source) return sendText(res, 400, "缺少图片地址。");
      try {
        const image = await proxyImage(source, referer);
        res.writeHead(200, {
          "content-type": image.type,
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=604800",
          "content-length": image.bytes.length
        });
        return res.end(image.bytes);
      } catch (error) {
        return sendText(res, error.status || 502, error.message || "图片暂时不能读取。");
      }
    }

    if (url.pathname === "/api/cloud") {
      try {
        if (req.method === "GET") {
          const syncCode = url.searchParams.get("syncCode") || "";
          const rows = await supabaseSharedRequest({ method: "GET", syncCode });
          const row = Array.isArray(rows) ? rows[0] || null : rows;
          return sendJson(res, 200, await loadCloudStateSharded(row));
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          return sendJson(res, 200, await saveCloudStateSharded(body.syncCode, body.state));
        }
        return sendJson(res, 405, { error: "不支持这个云端请求。" });
      } catch (error) {
        return sendJson(res, error.status || 502, { error: error.message || "云端备用通道失败。" });
      }
    }

    const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(root, safePath);
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    const file = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      const file = await readFile(join(root, "index.html"));
      res.writeHead(200, { "content-type": mimeTypes[".html"] });
      return res.end(file);
    }
    res.writeHead(500);
    res.end("Internal Server Error");
  }
});

server.listen(port, () => {
  console.log(`Pocket Shelf is running at http://localhost:${port}`);
});
