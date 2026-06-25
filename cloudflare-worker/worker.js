const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept",
  "access-control-max-age": "86400"
};

const KV_SOFT_LIMIT = 24 * 1024 * 1024;
const R2_OBJECT_PREFIX = "library";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function cleanSyncCode(value = "") {
  return String(value).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
}

function validSyncCode(value = "") {
  return /^[A-Z0-9-]{8,32}$/.test(value);
}

function legacyKey(syncCode) {
  return `library:${syncCode}`;
}

function manifestKey(syncCode) {
  return `v2:${syncCode}:manifest`;
}

function progressKey(syncCode) {
  return `v2:${syncCode}:progress`;
}

function safeObjectId(value = "") {
  return encodeURIComponent(String(value || "untitled")).replace(/%/g, "~");
}

function workObjectKey(syncCode, workId) {
  return `${R2_OBJECT_PREFIX}/${syncCode}/works/${safeObjectId(workId)}.json`;
}

function isR2Pointer(value) {
  return Boolean(value && value.provider === "cloudflare-r2" && value.r2Key);
}

async function readJsonBody(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: "BAD_JSON" };
  }
}

function lightWork(work = {}) {
  const {
    contentHtml,
    summaryHtml,
    bookmarks,
    highlights,
    ...rest
  } = work;
  return {
    ...rest,
    contentHtml: "",
    summaryHtml: "",
    bookmarks: [],
    highlights: [],
    hasCloudShard: true,
    shardKey: workObjectKey("", work.id || work.sourceUrl || work.title || "")
  };
}

function makeManifestState(state = {}, syncCode = "") {
  const works = Array.isArray(state.works) ? state.works : [];
  return {
    ...state,
    works: works.map((work) => ({
      ...lightWork(work),
      shardKey: workObjectKey(syncCode, work.id || work.sourceUrl || work.title || "")
    })),
    _vellumSharded: 2,
    _vellumCloudMode: state._vellumCloudMode || "kv-progress-r2-works-v1",
    shardCount: works.length,
    shardedAt: new Date().toISOString()
  };
}

function makeProgressState(state = {}, writer = "") {
  const works = {};
  for (const work of Array.isArray(state.works) ? state.works : []) {
    if (!work?.id) continue;
    works[work.id] = {
      reading: work.reading || {},
      sortOrder: work.sortOrder,
      folderId: work.folderId,
      folderIds: work.folderIds || [],
      updatedAt: work.updatedAt || work.reading?.updatedAt || new Date().toISOString()
    };
  }
  return {
    works,
    updated_at: new Date().toISOString(),
    writer
  };
}

function mergeManifestStates(existingState = {}, incomingState = {}) {
  const deletedFolderIds = [...new Set([
    ...(existingState.deletedFolderIds || []),
    ...(incomingState.deletedFolderIds || [])
  ].filter((id) => id && id !== "all" && id !== "unfiled"))];
  const deletedSet = new Set(deletedFolderIds);
  const folders = new Map();
  for (const folder of [...(existingState.folders || []), ...(incomingState.folders || [])]) {
    if (folder?.id && !deletedSet.has(folder.id)) folders.set(folder.id, folder);
  }
  const works = new Map();
  for (const work of [...(existingState.works || []), ...(incomingState.works || [])]) {
    if (!work?.id) continue;
    const old = works.get(work.id) || {};
    works.set(work.id, {
      ...old,
      ...work,
      folderIds: [...new Set([...(old.folderIds || []), ...(work.folderIds || [])])].filter((id) => !deletedSet.has(id)),
      updatedAt: work.updatedAt || old.updatedAt
    });
  }
  return {
    ...existingState,
    ...incomingState,
    folders: [...folders.values()],
    deletedFolderIds,
    works: [...works.values()]
  };
}

function readingRatioValue(reading = {}) {
  const value = Number(reading.wholeRatio ?? reading.ratio ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function pickProgressEntry(existing = {}, incoming = {}) {
  const existingTime = new Date(existing.reading?.updatedAt || existing.updatedAt || 0).getTime() || 0;
  const incomingTime = new Date(incoming.reading?.updatedAt || incoming.updatedAt || 0).getTime() || 0;
  const existingRatio = readingRatioValue(existing.reading);
  const incomingRatio = readingRatioValue(incoming.reading);
  if (Math.abs(incomingRatio - existingRatio) > 0.02) {
    return incomingRatio > existingRatio ? { ...existing, ...incoming } : { ...incoming, ...existing };
  }
  if (existingTime || incomingTime) return incomingTime >= existingTime ? { ...existing, ...incoming } : { ...incoming, ...existing };
  return incomingRatio >= existingRatio
    ? { ...existing, ...incoming }
    : { ...incoming, ...existing };
}

function mergeProgressStates(existing = {}, incoming = {}) {
  const works = { ...(existing.works || {}) };
  for (const [workId, entry] of Object.entries(incoming.works || {})) {
    works[workId] = pickProgressEntry(works[workId] || {}, entry || {});
  }
  return {
    ...existing,
    ...incoming,
    works,
    updated_at: incoming.updated_at || existing.updated_at || new Date().toISOString()
  };
}

function applyProgressToWork(work = {}, progress = {}) {
  const entry = progress.works?.[work.id];
  if (!entry) return work;
  const workTime = new Date(work.reading?.updatedAt || work.updatedAt || 0).getTime() || 0;
  const entryTime = new Date(entry.reading?.updatedAt || entry.updatedAt || 0).getTime() || 0;
  const workRatio = readingRatioValue(work.reading);
  const entryRatio = readingRatioValue(entry.reading);
  if (entryTime >= workTime || entryRatio > workRatio + 0.02) {
    work.reading = entry.reading || work.reading || {};
    if (entry.sortOrder !== undefined) work.sortOrder = entry.sortOrder;
    if (entry.folderId) work.folderId = entry.folderId;
    if (Array.isArray(entry.folderIds)) work.folderIds = entry.folderIds;
    work.updatedAt = entry.updatedAt || work.updatedAt;
  }
  return work;
}

async function putWorkShard(env, syncCode, work = {}, updatedAt = new Date().toISOString()) {
  const id = work.id || work.sourceUrl || work.title || crypto.randomUUID();
  await env.VELLUM_BUCKET.put(workObjectKey(syncCode, id), JSON.stringify({ ...work, id }), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      syncCode,
      workId: String(id),
      updated_at: work.updatedAt || updatedAt
    }
  });
  return id;
}

async function writeShardedManifest(env, syncCode, state = {}) {
  const updatedAt = new Date().toISOString();
  const existing = await env.VELLUM_SYNC.get(manifestKey(syncCode), { type: "json" }).catch(() => null);
  const mergedState = existing?.state ? mergeManifestStates(existing.state, state) : state;
  const works = Array.isArray(mergedState.works) ? mergedState.works : [];
  const manifest = {
    state: makeManifestState(mergedState, syncCode),
    updated_at: updatedAt,
    provider: "cloudflare-r2-v2",
    sharded: true,
    works: works.length
  };
  const existingProgress = await env.VELLUM_SYNC.get(progressKey(syncCode), { type: "json" }).catch(() => null);
  const progress = mergeProgressStates(existingProgress || {}, makeProgressState(mergedState, mergedState._lastWriter || ""));

  await env.VELLUM_SYNC.put(manifestKey(syncCode), JSON.stringify(manifest), {
    metadata: { updated_at: updatedAt, provider: "cloudflare-r2-v2" }
  });
  await env.VELLUM_SYNC.put(progressKey(syncCode), JSON.stringify(progress), {
    metadata: { updated_at: updatedAt, provider: "cloudflare-kv-progress" }
  });

  return {
    ok: true,
    provider: "cloudflare-r2-v2",
    sharded: true,
    manifestOnly: true,
    updated_at: updatedAt,
    works: works.length
  };
}

async function readLegacyState(env, syncCode) {
  const stored = await env.VELLUM_SYNC.get(legacyKey(syncCode), { type: "json" });
  if (!stored) return null;

  if (isR2Pointer(stored)) {
    if (!env.VELLUM_BUCKET) return { error: "R2_BINDING_MISSING" };
    const object = await env.VELLUM_BUCKET.get(stored.r2Key);
    if (!object) return null;
    const state = await object.json();
    return {
      state,
      updated_at: stored.updated_at || object.uploaded?.toISOString?.() || new Date().toISOString(),
      provider: "cloudflare-r2",
      bytes: stored.bytes || object.size || 0
    };
  }

  return stored;
}

async function writeLegacyState(env, syncCode, state) {
  const updatedAt = new Date().toISOString();
  const payload = {
    state,
    updated_at: updatedAt,
    provider: "cloudflare-kv",
    mode: state?._vellumCloudMode || "standard"
  };
  const text = JSON.stringify(payload);

  if (env.VELLUM_BUCKET && text.length > KV_SOFT_LIMIT * 0.7) {
    const objectKey = `${R2_OBJECT_PREFIX}/${syncCode}/state.json`;
    await env.VELLUM_BUCKET.put(objectKey, JSON.stringify(state), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { syncCode, updated_at: updatedAt }
    });
    const pointer = {
      r2Key: objectKey,
      updated_at: updatedAt,
      provider: "cloudflare-r2",
      bytes: text.length,
      mode: state?._vellumCloudMode || "standard",
      compressed: Boolean(state?._vellumCompressed)
    };
    await env.VELLUM_SYNC.put(legacyKey(syncCode), JSON.stringify(pointer), {
      metadata: { updated_at: updatedAt, provider: "cloudflare-r2" }
    });
    return {
      ok: true,
      provider: "cloudflare-r2",
      updated_at: updatedAt,
      bytes: text.length,
      compressed: Boolean(state?._vellumCompressed)
    };
  }

  if (text.length > KV_SOFT_LIMIT) {
    return { error: "KV_VALUE_TOO_LARGE", bytes: text.length };
  }

  await env.VELLUM_SYNC.put(legacyKey(syncCode), text, {
    metadata: { updated_at: updatedAt, provider: "cloudflare-kv" }
  });
  return {
    ok: true,
    provider: "cloudflare-kv",
    updated_at: updatedAt,
    bytes: text.length,
    compressed: Boolean(state?._vellumCompressed)
  };
}

async function readShardedState(env, syncCode) {
  const manifest = await env.VELLUM_SYNC.get(manifestKey(syncCode), { type: "json" });
  if (!manifest) return null;
  if (!env.VELLUM_BUCKET) return { error: "R2_BINDING_MISSING" };

  const progress = await env.VELLUM_SYNC.get(progressKey(syncCode), { type: "json" }) || {};
  const refs = Array.isArray(manifest.state?.works) ? manifest.state.works : [];
  const works = await Promise.all(refs.map(async (ref) => {
    const key = ref.shardKey || workObjectKey(syncCode, ref.id || ref.sourceUrl || ref.title || "");
    const object = await env.VELLUM_BUCKET.get(key);
    if (!object) return applyProgressToWork({ ...ref }, progress);
    const work = await object.json();
    return applyProgressToWork({ ...ref, ...work }, progress);
  }));

  return {
    state: {
      ...manifest.state,
      works,
      _vellumSharded: 2
    },
    updated_at: progress.updated_at || manifest.updated_at,
    provider: "cloudflare-r2-v2",
    sharded: true,
    works: works.length
  };
}

async function readShardedManifest(env, syncCode) {
  const manifest = await env.VELLUM_SYNC.get(manifestKey(syncCode), { type: "json" });
  if (!manifest) return null;
  const progress = await env.VELLUM_SYNC.get(progressKey(syncCode), { type: "json" }) || {};
  return {
    ...manifest,
    state: {
      ...manifest.state,
      works: (manifest.state?.works || []).map((work) => applyProgressToWork({ ...work }, progress))
    },
    updated_at: progress.updated_at || manifest.updated_at,
    provider: "cloudflare-r2-v2",
    sharded: true,
    manifestOnly: true
  };
}

async function readShardedIndex(env, syncCode) {
  const manifest = await env.VELLUM_SYNC.get(manifestKey(syncCode), { type: "json" });
  if (!manifest) return null;
  const progress = await env.VELLUM_SYNC.get(progressKey(syncCode), { type: "json" }) || {};
  return {
    ...manifest,
    state: {
      ...manifest.state,
      works: (manifest.state?.works || []).map((work) => applyProgressToWork({ ...work }, progress))
    },
    updated_at: progress.updated_at || manifest.updated_at,
    provider: "cloudflare-r2-v2",
    sharded: true,
    manifestOnly: true,
    indexOnly: true,
    progressIncluded: true
  };
}

async function readProgress(env, syncCode) {
  return await env.VELLUM_SYNC.get(progressKey(syncCode), { type: "json" }) || { works: {}, updated_at: "" };
}

async function readWorkBatch(env, syncCode, ids = []) {
  if (!env.VELLUM_BUCKET) return { error: "R2_BINDING_MISSING" };
  const progress = await env.VELLUM_SYNC.get(progressKey(syncCode), { type: "json" }) || {};
  const works = [];
  for (const id of ids.filter(Boolean)) {
    const object = await env.VELLUM_BUCKET.get(workObjectKey(syncCode, id));
    if (!object) continue;
    const work = await object.json();
    works.push(applyProgressToWork(work, progress));
  }
  return {
    ok: true,
    provider: "cloudflare-r2-v2",
    works
  };
}

async function writeShardedState(env, syncCode, state = {}) {
  if (!env.VELLUM_BUCKET) return writeLegacyState(env, syncCode, state);
  const updatedAt = new Date().toISOString();
  const works = Array.isArray(state.works) ? state.works : [];

  for (const work of works) {
    await putWorkShard(env, syncCode, work, updatedAt);
  }
  await writeShardedManifest(env, syncCode, state);

  return {
    ok: true,
    provider: "cloudflare-r2-v2",
    sharded: true,
    updated_at: updatedAt,
    works: works.length,
    compressed: false
  };
}

async function writeWorkBatch(env, syncCode, body = {}) {
  if (!env.VELLUM_BUCKET) return { error: "R2_BINDING_MISSING" };
  const updatedAt = new Date().toISOString();
  const works = Array.isArray(body.works) ? body.works : [];
  const saved = [];
  for (const work of works) {
    if (!work) continue;
    saved.push(await putWorkShard(env, syncCode, work, updatedAt));
  }
  if (saved.length) {
    await writeProgress(env, syncCode, {
      syncCode,
      works: Object.fromEntries(works.filter((work) => work?.id).map((work) => [work.id, {
        reading: work.reading || {},
        sortOrder: work.sortOrder,
        folderId: work.folderId,
        folderIds: work.folderIds || [],
        updatedAt: work.updatedAt || updatedAt
      }])),
      writer: body.writer || ""
    });
  }
  return {
    ok: true,
    provider: "cloudflare-r2-v2",
    batch: true,
    updated_at: updatedAt,
    works: saved.length
  };
}

async function writeProgress(env, syncCode, body = {}) {
  const now = new Date().toISOString();
  const current = await env.VELLUM_SYNC.get(progressKey(syncCode), { type: "json" }) || { works: {} };
  current.works ||= {};

  const incoming = body.works && typeof body.works === "object"
    ? body.works
    : body.workId
      ? { [body.workId]: body }
      : {};

  for (const [workId, entry] of Object.entries(incoming)) {
    if (!workId) continue;
    const existing = current.works[workId] || {};
    const normalizedEntry = {
      ...entry,
      updatedAt: entry.updatedAt || entry.reading?.updatedAt || now
    };
    current.works[workId] = pickProgressEntry(existing, normalizedEntry);
  }

  current.updated_at = now;
  current.writer = body.writer || current.writer || "";
  await env.VELLUM_SYNC.put(progressKey(syncCode), JSON.stringify(current), {
    metadata: { updated_at: now, provider: "cloudflare-kv-progress" }
  });

  return {
    ok: true,
    provider: "cloudflare-kv-progress",
    updated_at: now,
    works: Object.keys(incoming).length
  };
}

async function handleCloudGet(env, syncCode) {
  const sharded = await readShardedState(env, syncCode);
  if (sharded) return sharded;
  return await readLegacyState(env, syncCode);
}

async function handleCloudPost(env, syncCode, state) {
  if (env.VELLUM_BUCKET) return writeShardedState(env, syncCode, state);
  return writeLegacyState(env, syncCode, state);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!env.VELLUM_SYNC) {
      return json({ error: "KV_BINDING_MISSING" }, 500);
    }

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "vellum-sync",
        storage: env.VELLUM_BUCKET ? "cloudflare-kv-progress+r2-works" : "cloudflare-kv",
        r2: Boolean(env.VELLUM_BUCKET),
        imageMode: "links-by-default",
        protocol: env.VELLUM_BUCKET ? "v2-sharded" : "kv-single"
      });
    }

    const isCloudPath = url.pathname === "/api/cloud" || url.pathname === "/api/v2/cloud";
    const isIndexPath = url.pathname === "/api/v2/index";
    const isManifestPath = url.pathname === "/api/v2/manifest";
    const isWorksPath = url.pathname === "/api/v2/works";
    const isProgressPath = url.pathname === "/api/v2/progress";
    if (!isCloudPath && !isIndexPath && !isManifestPath && !isWorksPath && !isProgressPath) return json({ error: "NOT_FOUND" }, 404);

    if (request.method === "GET" && isCloudPath) {
      const syncCode = cleanSyncCode(url.searchParams.get("syncCode") || "");
      if (!validSyncCode(syncCode)) return json({ error: "BAD_SYNC_CODE" }, 400);
      const stored = await handleCloudGet(env, syncCode);
      if (stored?.error) return json(stored, 500);
      return json(stored || null);
    }

    if (request.method === "GET" && isManifestPath) {
      const syncCode = cleanSyncCode(url.searchParams.get("syncCode") || "");
      if (!validSyncCode(syncCode)) return json({ error: "BAD_SYNC_CODE" }, 400);
      const stored = await readShardedManifest(env, syncCode);
      if (stored?.error) return json(stored, 500);
      return json(stored || null);
    }

    if (request.method === "GET" && isIndexPath) {
      const syncCode = cleanSyncCode(url.searchParams.get("syncCode") || "");
      if (!validSyncCode(syncCode)) return json({ error: "BAD_SYNC_CODE" }, 400);
      const stored = await readShardedIndex(env, syncCode);
      if (stored?.error) return json(stored, 500);
      return json(stored || null);
    }

    if (request.method === "GET" && isProgressPath) {
      const syncCode = cleanSyncCode(url.searchParams.get("syncCode") || "");
      if (!validSyncCode(syncCode)) return json({ error: "BAD_SYNC_CODE" }, 400);
      return json(await readProgress(env, syncCode));
    }

    if (request.method === "GET" && isWorksPath) {
      const syncCode = cleanSyncCode(url.searchParams.get("syncCode") || "");
      if (!validSyncCode(syncCode)) return json({ error: "BAD_SYNC_CODE" }, 400);
      const ids = (url.searchParams.get("ids") || "").split(",").map((id) => decodeURIComponent(id)).filter(Boolean);
      const stored = await readWorkBatch(env, syncCode, ids.slice(0, 12));
      if (stored?.error) return json(stored, 500);
      return json(stored);
    }

    if (request.method === "POST" && isCloudPath) {
      const body = await readJsonBody(request);
      if (body.error) return json({ error: body.error }, 400);
      const syncCode = cleanSyncCode(body.syncCode || "");
      if (!validSyncCode(syncCode)) return json({ error: "BAD_SYNC_CODE" }, 400);
      if (!body.state) return json({ error: "STATE_MISSING" }, 400);
      const result = await handleCloudPost(env, syncCode, body.state);
      if (result.error) return json(result, 413);
      return json(result);
    }

    if (request.method === "POST" && isManifestPath) {
      const body = await readJsonBody(request);
      if (body.error) return json({ error: body.error }, 400);
      const syncCode = cleanSyncCode(body.syncCode || "");
      if (!validSyncCode(syncCode)) return json({ error: "BAD_SYNC_CODE" }, 400);
      if (!body.state) return json({ error: "STATE_MISSING" }, 400);
      if (!env.VELLUM_BUCKET) return json({ error: "R2_BINDING_MISSING" }, 500);
      return json(await writeShardedManifest(env, syncCode, body.state));
    }

    if (request.method === "POST" && isWorksPath) {
      const body = await readJsonBody(request);
      if (body.error) return json({ error: body.error }, 400);
      const syncCode = cleanSyncCode(body.syncCode || "");
      if (!validSyncCode(syncCode)) return json({ error: "BAD_SYNC_CODE" }, 400);
      const result = await writeWorkBatch(env, syncCode, body);
      if (result.error) return json(result, 500);
      return json(result);
    }

    if (request.method === "POST" && isProgressPath) {
      const body = await readJsonBody(request);
      if (body.error) return json({ error: body.error }, 400);
      const syncCode = cleanSyncCode(body.syncCode || "");
      if (!validSyncCode(syncCode)) return json({ error: "BAD_SYNC_CODE" }, 400);
      const result = await writeProgress(env, syncCode, body);
      return json(result);
    }

    return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  }
};
