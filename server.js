import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.PORT || 4173);
const sourceHost = [[ "archive", "of", "our", "own" ].join(""), "org"].join(".");
const downloadHost = `download.${sourceHost}`;

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

function absoluteUrl(value, baseUrl) {
  if (!value || /^(https?:|data:|blob:)/i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
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
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+=["'][\s\S]*?["']/gi, "")
    .replace(/href=["']javascript:[\s\S]*?["']/gi, "")
    .replace(/\b(src|href)=["']([^"']+)["']/gi, (_, name, url) => `${name}="${absoluteUrl(url, sourceUrl)}"`);
}

function parseSourceWork(html, sourceUrl) {
  const title = textOnly(firstMatch(html, /<h2[^>]+class=["'][^"']*title[^"']*heading[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i))
    || textOnly(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i))
    || textOnly(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)).replace(/\s+-\s+[\s\S]*$/i, "").replace(/\s*\|\s*Archive Site.*$/i, "")
    || "未命名作品";
  const author = textOnly(firstMatch(html, /<h3[^>]+class=["'][^"']*byline[^"']*heading[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i))
    || textOnly(firstMatch(html, /<[^>]+class=["'][^"']*byline[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i));
  const summary = firstMatch(html, /<blockquote[^>]+class=["'][^"']*userstuff[^"']*summary[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i)
    || firstMatch(html, /<div[^>]+class=["'][^"']*summary[^"']*["'][^>]*>[\s\S]*?<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i);
  const rating = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*rating[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i));
  const categories = allMatches(firstMatch(html, /<dd[^>]+class=["'][^"']*category[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i), /<a[^>]*>([\s\S]*?)<\/a>/gi);
  const fandoms = allMatches(firstMatch(html, /<dd[^>]+class=["'][^"']*fandom[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i), /<a[^>]*>([\s\S]*?)<\/a>/gi);
  const warnings = allMatches(firstMatch(html, /<dd[^>]+class=["'][^"']*warning[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i), /<a[^>]*>([\s\S]*?)<\/a>/gi);
  const relationships = allMatches(firstMatch(html, /<dd[^>]+class=["'][^"']*relationship[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i), /<a[^>]*>([\s\S]*?)<\/a>/gi);
  const characters = allMatches(firstMatch(html, /<dd[^>]+class=["'][^"']*character[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i), /<a[^>]*>([\s\S]*?)<\/a>/gi);
  const freeforms = allMatches(firstMatch(html, /<dd[^>]+class=["'][^"']*freeform[^"']*tags[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i), /<a[^>]*>([\s\S]*?)<\/a>/gi);
  const words = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*words[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i));
  const chapters = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*chapters[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i));
  const status = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*status[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i));
  const language = textOnly(firstMatch(html, /<dd[^>]+class=["'][^"']*language[^"']*["'][^>]*>([\s\S]*?)<\/dd>/i));
  const contentHtml = cleanWorkHtml(html, sourceUrl);

  if (!contentHtml || contentHtml.length < 80) {
    throw new Error("没有在这个页面里找到正文。请确认链接是 作品页，并且作品可以公开访问。");
  }

  return {
    title,
    author,
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
      words,
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

function getDownloadUrl(parsed) {
  const workId = getWorkId(parsed);
  return workId ? `https://${downloadHost}/downloads/${workId}/fic.html` : "";
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
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return {
          html: await fetchHtml(candidate.url, candidate.label),
          url: candidate.url
        };
      } catch (error) {
        errors.push(error);
        if (attempt < 2) await wait(800);
      }
    }
  }

  const statuses = errors.map((error) => error.status).filter(Boolean);
  if (statuses.includes(525)) {
    throw new Error("原站返回了 525，备用 HTML 下载源也没有成功。可以稍后再试，或先用原站 Download → HTML 导入。");
  }
  const lastError = errors[errors.length - 1];
  throw new Error(lastError?.message || "暂时不能读取这个链接。");
}

async function importSource(url) {
  const parsed = normalizeSourceUrl(url);
  const candidates = [{ url: parsed.toString(), label: "原站" }];
  const downloadUrl = getDownloadUrl(parsed);
  if (downloadUrl) candidates.push({ url: downloadUrl, label: "HTML 下载源" });

  const result = await fetchFirstAvailable(candidates);
  return parseSourceWork(result.html, result.url);
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
