/**
 * embed.js — 语义搜索（在线 embedding API，OpenAI 兼容）
 *
 * 流程：
 * - 开启后后台增量构建索引：会话用户消息 → embedding API → 向量存 state/embed-index.json
 * - 查询：关键词 → embedding → 与索引向量余弦相似度 → 返回相关度排序命中
 * - 降级：无 key / API 失败 / 超时 → 返回 { ok: false, fallback: true }（前端走关键词搜索）
 *
 * 配置（工具箱设置）：
 * - embedSearch（开关，默认关）
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
      msgs = readMessages(s.path, MAX_MESSAGES_PER_SESSION) || [];
    } catch {
      continue;
    }
    // 只索引新增消息（seq > prevSeq）
    for (const m of msgs) {
      if (m.role !== "user") continue; // 只索引用户消息（控制成本）
      if (m.seq > prevSeq) toEmbed.push({ sessionId: s.sessionId, seq: m.seq, content: m.content });
    }
    if (msgs.length > 0) changed = true;
  }
  if (toEmbed.length === 0) return { ok: true, indexed: 0, total: 0, upToDate: true };

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

/** 语义查询：关键词 → 向量 → 与索引比对。 */
export async function embedQuery(cfg, keyword, topN = 20) {
  const idx = loadIndex();
  const total = Object.values(idx.sessions || {}).reduce((n, s) => n + (s.items?.length || 0), 0);
  if (total === 0) return { ok: false, fallback: true, error: "索引为空（请先开启语义搜索并等待索引构建）" };
  let qv;
  try {
    [qv] = await embedTexts(cfg, [keyword]);
  } catch (err) {
    return { ok: false, fallback: true, error: String(err) };
  }
  const scored = [];
  for (const [sessionId, s] of Object.entries(idx.sessions || {})) {
    for (const item of s.items || []) {
      scored.push({ sessionId, seq: item.seq, score: cosine(qv, item.v) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return { ok: true, hits: scored.slice(0, topN).map((h) => ({ sessionId: h.sessionId, seq: h.seq, score: Number(h.score.toFixed(3)) })), total };
}

/** 清空索引（开关关闭或换 key 时）。 */
export function clearEmbedIndex() {
  try { if (fs.existsSync(INDEX_FILE)) fs.rmSync(INDEX_FILE); } catch {}
}
