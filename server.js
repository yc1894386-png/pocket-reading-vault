import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.PORT || 4173);
const sourceHost = [[ "archive", "of", "our", "own" ].join(""), "org"].join(".");
const downloadHost = `download.${sourceHost}`;
const importCache = new Map();
const imageCache = new Map();
const publicBaseUrl = process.env.PUBLIC_BASE_URL || "https://pocket-reading-vault.onrender.com";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, value) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*"
  });
  res.end(value);
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

function tagsFromHtml(value = "") {
  const linked = allMatches(value, /<a[^>]*>([\s\S]*?)<\/a>/gi);
  if (linked.length) return linked;
  return textOnly(value).split(/,\s*/).map((item) => item.trim()).filter(Boolean);
}

function textLengthFromHtml(value = "") {
  return textOnly(value).replace(/\s/g, "").length;
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

function proxiedImageUrl(value, baseUrl) {
  const absolute = absoluteUrl(value, baseUrl);
  if (!isProxyableImageUrl(absolute)) return absolute;
  return `${publicBaseUrl}/api/image?url=${encodeURIComponent(absolute)}`;
}

function rewriteSrcset(value = "", baseUrl) {
  return value.split(",").map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return "";
    const [rawUrl, ...rest] = trimmed.split(/\s+/);
    return [proxiedImageUrl(rawUrl, baseUrl), ...rest].join(" ");
  }).filter(Boolean).join(", ");
}

function cleanWorkHtml(html, sourceUrl) {
  const start = html.match(/<div[^>]+id=["']chapters["'][^>]*>/i);
  let chapters = "";
  if (start?.index !== undefined) {
    const tail = html.slice(start.index);
    const end = tail.search(/<div[^>]+id=["'](afterword|feedback|kudos|comments_placeholder)["'][^>]*>/i);
    chapters = end >= 0 ? tail.slice(0, end) : tail;
  } else {
    chapters = firstMatch(html, /<div[^>]+id=["']chapters["'][^>]*>([\s\S]*?)<\s*\/\s*div\s*>/i);
  }

  return chapters
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=["'][\s\S]*?["']/gi, "")
    .replace(/href=["']javascript:[\s\S]*?["']/gi, "")
    .replace(/<img\b([^>]*)>/gi, (tag, attrs) => {
      const src = firstMatch(attrs, /\s(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/i);
      const srcset = firstMatch(attrs, /\ssrcset=["']([^"']+)["']/i);
      let nextAttrs = attrs
        .replace(/\s(?:src|srcset|data-src|data-original|data-lazy-src)=["'][^"']*["']/gi, "")
        .replace(/\sloading=["'][^"']*["']/i, "")
        .replace(/\sdecoding=["'][^"']*["']/i, "");
      if (src) nextAttrs += ` src="${proxiedImageUrl(src, sourceUrl)}"`;
      if (!src && srcset) nextAttrs += ` src="${proxiedImageUrl(srcset.split(",")[0].trim().split(/\s+/)[0], sourceUrl)}"`;
      if (srcset) nextAttrs += ` srcset="${rewriteSrcset(srcset, sourceUrl)}"`;
      nextAttrs += ` loading="lazy" decoding="async"`;
      return `<img${nextAttrs}>`;
    })
    .replace(/\bhref=["']([^"']+)["']/gi, (_, url) => `href="${absoluteUrl(url, sourceUrl)}"`);
}

async function proxyImage(targetUrl) {
  if (!isProxyableImageUrl(targetUrl)) {
    const error = new Error("不支持这个图片地址。");
    error.status = 400;
    throw error;
  }
  const cached = imageCache.get(targetUrl);
  if (cached && Date.now() - cached.at < 1000 * 60 * 60 * 24) return cached;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(targetUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "referer": new URL(targetUrl).origin,
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      }
    });
    if (!response.ok) {
      const error = new Error(`图片源返回了 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const type = response.headers.get("content-type") || "application/octet-stream";
    const bytes = Buffer.from(await response.arrayBuffer());
    const image = { type, bytes, at: Date.now() };
    imageCache.set(targetUrl, image);
    if (imageCache.size > 160) imageCache.delete(imageCache.keys().next().value);
    return image;
  } finally {
    clearTimeout(timeout);
  }
}

function parseSourceWork(html, sourceUrl) {
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
    throw new Error("没有在这个页面里找到正文。请确认链接是 作品页，并且作品可以公开访问。");
  }

  return {
    title,
    author: author || "作者待补",
    sourceUrl,
    importedAt: new Date().toISOString(),
    summaryHtml: summary,
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
  if (parsed.hostname.toLowerCase() !== sourceHost && !parsed.hostname.toLowerCase().endsWith(`.${sourceHost}`)) {
    throw new Error("目前只支持指定作品站点的链接。");
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
  return {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "referer": url,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "cookie": "view_adult=true; viewed_adult=true"
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
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
  const work = parseSourceWork(result.html, result.url);
  importCache.set(cacheKey, { at: Date.now(), work });
  return work;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type, accept"
      });
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
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
      if (!source) return sendText(res, 400, "缺少图片地址。");
      try {
        const image = await proxyImage(source);
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
