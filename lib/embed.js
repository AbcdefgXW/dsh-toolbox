/**
 * embed.js — 语义搜索（在线 embedding API，OpenAI 兼容）
 *
 * 流程：
 * - 索引构建（首次/增量）：会话用户消息 → embedding API → 向量存 state/embed-index.json
 * - 查询：关键词 → embedding → 与索引向量余弦相似度 → 返回相关度排序命中
 * - 降级：无 key / API 失败 / 超时 → 返回 { ok: false, fallback: true }（前端走关键词搜索）
 * - 搜索 Tab 勾选「语义」即使用语义匹配（无独立开关，有 Key 就能用）
 *
 * 配置（工具箱设置，存 state/settings.json，不进 git）：
 * - embedBaseUrl（默认 https://api.siliconflow.cn/v1）
 * - embedApiKey（用户自己的 key）
 * - embedModel（默认 BAAI/bge-m3）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR = process.env.DSH_CHANNELS_STATE_DIR?.trim() ||
  path.join(fileURLToPath(new URL("../", import.meta.url)), "state");
const INDEX_FILE = path.join(STATE_DIR, "embed-index.json");

const BATCH = 16; // 批量 embedding 条数
const MAX_MESSAGES_PER_SESSION = 500; // 每会话最多索引条数（控制成本）
const EMBED_TIMEOUT_MS = 15000;

/** 读取索引。 */
function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return { sessions: {}, builtAt: 0 };
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
  } catch {
    return { sessions: {}, builtAt: 0 };
  }
}

function saveIndex(idx) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = INDEX_FILE + ".tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(idx), "utf-8");
    fs.renameSync(tmp, INDEX_FILE);
  } catch {}
}

/** 调用 OpenAI 兼容 /embeddings。 */
async function embedTexts(cfg, texts) {
  const base = String(cfg.embedBaseUrl || "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
  const key = String(cfg.embedApiKey || "").trim();
  const model = String(cfg.embedModel || "BAAI/bge-m3").trim();
  if (!key) throw new Error("未配置 embedding API Key");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const resp = await fetch(base + "/embeddings", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try { const j = await resp.json(); msg = (j.message || j.error?.message || msg) + (j.code ? " (" + j.code + ")" : ""); } catch {}
      throw new Error(msg);
    }
    const j = await resp.json();
    if (!Array.isArray(j.data)) throw new Error("响应缺少 data");
    return j.data.map((d) => d.embedding);
  } finally {
    clearTimeout(timer);
  }
}

/** 余弦相似度。 */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 构建/增量更新索引。
 * @param cfg 配置
 * @param listAll 函数：返回 [{sessionId, path}]（复用 listAllSessions）
 * @param readMessages 函数：(sessionPath, limit) => [{seq, content}]
 * @returns {{ok, indexed, total, error?}}
 */
export async function buildEmbedIndex(cfg, listAll, readMessages) {
  const idx = loadIndex();
  const all = await listAll();
  const sessions = new Map(all.map((s) => [s.sessionId, s]));
  const existing = idx.sessions || {};
  const toEmbed = []; // {sessionId, seq, content}
  let changed = false;

  for (const s of all) {
    const prev = existing[s.sessionId];
    const prevSeq = prev && Array.isArray(prev.items) ? Math.max(...prev.items.map((i) => i.seq), -1) : -1;
    let msgs;
    try {
      msgs = (await readMessages(s.path, MAX_MESSAGES_PER_SESSION)) || [];
    } catch {
      continue;
    }
    // 只索引新增消息（seq > prevSeq）
    for (const m of msgs) {
      if (m.role !== "user") continue; // 只索引用户消息（控制成本）
      if (m.seq > prevSeq) {
        const content = String(m.content || "").trim();
        if (!content) continue; // 跳过空内容（部分 API 拒绝空 input）
        // 超长截断（bge-m3 上下文 8192 token，中文约 1 字符≈1 token，留余量）
        toEmbed.push({ sessionId: s.sessionId, seq: m.seq, content: content.length > 6000 ? content.slice(0, 6000) : content });
      }
    }
    if (msgs.length > 0) changed = true;
  }
  if (toEmbed.length === 0) return { ok: true, indexed: 0, total: 0, upToDate: true };

  // 索引要变了，先清查询缓存
  clearEmbedCache();

  // 分批 embedding
  const batches = [];
  for (let i = 0; i < toEmbed.length; i += BATCH) batches.push(toEmbed.slice(i, i + BATCH));
  let indexed = 0;
  for (const batch of batches) {
    let vecs;
    try {
      vecs = await embedTexts(cfg, batch.map((b) => b.content));
    } catch (err) {
      return { ok: false, indexed, error: String(err), fallback: true };
    }
    for (let i = 0; i < batch.length; i++) {
      const b = batch[i];
      (existing[b.sessionId] ||= { items: [] }).items.push({ seq: b.seq, v: vecs[i] });
      indexed++;
    }
    // 每批保存一次（防中断丢进度）
    idx.sessions = existing;
    idx.builtAt = Date.now();
    saveIndex(idx);
  }
  return { ok: true, indexed, total: indexed };
}

// 语义查询 TTL 缓存：同一关键词 60 秒内直接返回，不重复调 embedding API（省钱）。
// 被取消的查询不缓存。索引重建后清空。
let embedCache = { at: 0, kw: "", result: null };

/** 清空语义查询缓存（索引变更后调用）。 */
export function clearEmbedCache() {
  embedCache = { at: 0, kw: "", result: null };
}

/** 语义查询：关键词 → 向量 → 与索引比对。 */
export async function embedQuery(cfg, keyword, topN = 20, signal, resolveSnippet) {
  const kw = String(keyword || "").trim();
  const now = Date.now();
  const ttlSec = Number(cfg.searchCacheSeconds);
  const ttlMs = (Number.isFinite(ttlSec) && ttlSec >= 0 ? ttlSec : 120) * 1000; // 0 = 不缓存
  if (ttlMs > 0 && embedCache.kw === kw && embedCache.result && now - embedCache.at < ttlMs) {
    return {
      ...embedCache.result,
      cache: { cached: true, ttlSeconds: ttlSec, expiresInMs: Math.max(0, ttlMs - (now - embedCache.at)) },
    };
  }
  if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
  const idx = loadIndex();
  const total = Object.values(idx.sessions || {}).reduce((n, s) => n + (s.items?.length || 0), 0);
  if (total === 0) return { ok: false, fallback: true, error: "索引为空（请先在搜索 Tab 勾选「语义」触发索引构建，稍后重试）" };
  let qv;
  try {
    [qv] = await embedTexts(cfg, [kw]);
  } catch (err) {
    return { ok: false, fallback: true, error: String(err) };
  }
  if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
  const scored = [];
  for (const [sessionId, s] of Object.entries(idx.sessions || {})) {
    for (const item of s.items || []) {
      scored.push({ sessionId, seq: item.seq, score: cosine(qv, item.v) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  // 候选阈值放宽到 0.3（字面命中兜底：短查询 vs 长句的 embedding 分数天然偏低，如「你是 dsh」仅 0.66）
  // 最终阈值过滤由调用方（index.js）按配置（默认 80）执行；候选数为每组上限的 3 倍
  if (scored.length === 0) return { ok: false, fallback: true, error: "索引为空（请先在搜索 Tab 勾选「语义」触发索引构建，稍后重试）" };
  const cfgScore = Number(cfg.embedMinScore);
  const minScore = (Number.isFinite(cfgScore) && cfgScore >= 0 && cfgScore <= 100 ? cfgScore : 80) / 100;
  const cfgTop = Number(cfg.embedTopN);
  const hitLimit = Number.isFinite(cfgTop) && cfgTop > 0 ? Math.max(cfgTop, 20) * 3 : (topN > 0 ? topN * 3 : Infinity); // 候选放宽
  const filtered = scored.filter((h) => h.score >= 0.3);
  if (filtered.length === 0) {
    return { ok: false, fallback: true, error: "语义匹配度过低（最高 " + Math.round(scored[0].score * 100) + "% < 阈值 " + Math.round(minScore * 100) + "%），「" + kw.slice(0, 20) + "」更适合用关键词搜索，或换更具体的描述" };
  }
  const hits = filtered.slice(0, hitLimit).map((h) => ({ sessionId: h.sessionId, seq: h.seq, score: Number(h.score.toFixed(3)) }));
  // 按需补内容预览：只解压命中消息所在会话（逐帧流式，与关键词同内存机制）；结果随缓存复用
  // resolveSnippet(sessionId, seqs) => Promise<{seq: snippet}>，按会话批量，避免重复读文件
  if (typeof resolveSnippet === "function") {
    const bySession = new Map();
    for (const h of hits) {
      if (!bySession.has(h.sessionId)) bySession.set(h.sessionId, []);
      bySession.get(h.sessionId).push(h.seq);
    }
    for (const [sid, seqs] of bySession) {
      let map = {};
      try {
        map = (await resolveSnippet(sid, seqs)) || {};
      } catch {
        map = {};
      }
      for (const h of hits) {
        if (h.sessionId === sid) h.snippet = map[h.seq] || "";
      }
    }
  }
  const result = { ok: true, hits, total, cache: { cached: false, ttlSeconds: ttlSec, expiresInMs: ttlMs } };
  embedCache = { at: Date.now(), kw, result };
  return result;
}

/** 清空索引（换 key / 手动重置时）。 */
export function clearEmbedIndex() {
  try { if (fs.existsSync(INDEX_FILE)) fs.rmSync(INDEX_FILE); } catch {}
  clearEmbedCache();
}

/** 列出可用模型（OpenAI 兼容 GET /models）。 */
export async function listEmbedModels(cfg) {
  const base = String(cfg.embedBaseUrl || "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
  const key = String(cfg.embedApiKey || "").trim();
  if (!key) throw new Error("未配置 embedding API Key");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const resp = await fetch(base + "/models", {
      headers: { Authorization: "Bearer " + key },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try { const j = await resp.json(); msg = (j.message || j.error?.message || msg) + (j.code ? " (" + j.code + ")" : ""); } catch {}
      throw new Error(msg);
    }
    const j = await resp.json();
    const arr = Array.isArray(j.data) ? j.data : [];
    const ids = arr.map((m) => m.id).filter(Boolean).sort();
    return { ids, current: String(cfg.embedModel || "").trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** 测试连接：发一个最小 embedding 请求，返回延迟与向量维度。 */
export async function testEmbedConnection(cfg) {
  const t0 = Date.now();
  const vecs = await embedTexts(cfg, ["hi"]);
  const dim = Array.isArray(vecs[0]) ? vecs[0].length : 0;
  return { latencyMs: Date.now() - t0, dim, model: String(cfg.embedModel || "BAAI/bge-m3").trim() };
}
