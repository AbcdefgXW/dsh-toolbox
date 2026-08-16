/**
 * search.js — 自研搜索 + 官方搜索开关（后端）
 *
 * 1) customSearch：解压所有会话文件，关键词全文搜索，返回命中片段。
 *    支持中止（AbortSignal）。
 * 2) officialSearch 开关：改写 profile 的 cordis.patch.yml 中
 *    session-query-sqlite 的 config（openAt startup/never），需重启生效。
 */
import fs from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { listAllSessions } from "./sessions.js";
import { scanZstdFrames } from "./zstd.js";

const PROFILE_PATCH = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, "profiles", "web", "cordis.patch.yml")
  : "/home/dsh/profiles/web/cordis.patch.yml";

// 搜索 TTL 缓存：同一关键词 60 秒内直接返回，避免重复全量解压（内存友好）。
// 取消的搜索不缓存。
let searchCache = { at: 0, kw: "", hits: null, partial: false };

/** 清空搜索缓存（释放内存按钮用）。 */
export function clearSearchCache() {
  searchCache = { at: 0, kw: "", hits: null, partial: false };
}

/** 搜索时间预算：会话多时到点即停，返回已找到的命中（partial=true），避免无限等待。 */
const SEARCH_TIME_BUDGET_MS = 8000;

/**
 * 全文搜索所有会话（逐帧流式解压：内存峰值 = 单帧 ~500 行，而非整个会话）。
 * @param {string} keyword 关键词（大小写不敏感）
 * @param {AbortSignal} [signal] 取消信号
 * @param {number} [limit] 最大命中条数
 * @returns {Promise<{hits: Array, partial: boolean}>} partial=true 表示超时截断
 */
export async function searchSessions(keyword, signal, limit = 100) {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return { hits: [], partial: false };
  const now = Date.now();
  if (searchCache.kw === kw && searchCache.hits && now - searchCache.at < 60_000) {
    return { hits: searchCache.hits, partial: searchCache.partial };
  }
  const hits = [];
  const sessions = await listAllSessions();
  const startAt = Date.now();
  let partial = false;

  for (const s of sessions) {
    if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
    if (Date.now() - startAt > SEARCH_TIME_BUDGET_MS) { partial = true; break; }
    const file = path.join(s.path, "session.jsonl.zstd");
    if (!fs.existsSync(file)) continue;
    try {
      const buf = fs.readFileSync(file);
      const frames = scanZstdFrames(buf);
      if (frames.length === 0) {
        // 单帧场景（如插件写回的小文件）：整体解
        hits.push(...searchText(zstdDecompressSync(buf).toString("utf-8"), kw, s, 1, hits.length, limit));
        if (hits.length >= limit) break;
        continue;
      }
      let lineNo = 0;
      for (const fr of frames) {
        if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
        const text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString("utf-8");
        hits.push(...searchText(text, kw, s, lineNo, hits.length, limit));
        lineNo += text.split("\n").length;
        if (hits.length >= limit) break;
      }
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      // 单个会话读取失败跳过
    }
    if (hits.length >= limit) break;
  }
  searchCache = { at: Date.now(), kw, hits, partial };
  return { hits, partial };
}

/** 在一段文本中逐行搜索并收集命中（baseLineNo 为该段起始行号，0-based）。 */
function searchText(text, kw, s, baseLineNo, hitStart, limit) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.toLowerCase().includes(kw)) continue;
    // 提取文本内容
    let content = "";
    let seq;
    try {
      const ev = JSON.parse(line);
      seq = ev.seq;
      const blocks = ev.data?.message?.content ?? ev.data?.content ?? [];
      content = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    } catch {
      content = line;
    }
    if (!content) continue;
    // 关键词上下文窗口：命中位置前后截取（前端高亮用）
    const ci = content.toLowerCase().indexOf(kw);
    const cs = Math.max(0, ci - 60);
    const ce = Math.min(content.length, ci + kw.length + 120);
    out.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      seq,
      line: baseLineNo + i + 1,
      snippet: (cs > 0 ? "…" : "") + content.slice(cs, ce) + (ce < content.length ? "…" : ""),
    });
    if (hitStart + out.length >= limit) break;
  }
  return out;
}

/**
 * 官方搜索开关：改写 cordis.patch.yml 中 session-query-sqlite 的 openAt。
 * @param {boolean} enabled true=startup（持久索引），false=never（官方默认）
 * @returns {{ok: boolean, needRestart: true, error?: string}}
 */
export function setOfficialSearch(enabled) {
  try {
    if (!fs.existsSync(PROFILE_PATCH)) return { ok: false, error: `找不到 ${PROFILE_PATCH}` };
    let text = fs.readFileSync(PROFILE_PATCH, "utf-8");

    const blockOn = `
# dsh-tools：官方搜索开关（openAt: startup，持久索引）⚠️ 由插件管理
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /home/dsh/session-query.sqlite
    openAt: startup
`;
    const marker = "id: session-query-sqlite";

    if (enabled && !text.includes(marker)) {
      // 在 dsh-channels insert 前插入
      text = text.replace(/\n- insert:/, "\n" + blockOn + "\n- insert:");
      fs.writeFileSync(PROFILE_PATCH, text, "utf-8");
      return { ok: true, needRestart: true };
    }
    if (!enabled && text.includes(marker)) {
      // 移除整个 block（从注释行到 config 块结束）
      const lines = text.split("\n");
      const out = [];
      let skipping = false;
      for (const line of lines) {
        if (line.includes("# dsh-tools：官方搜索开关") || line.trim() === "- id: session-query-sqlite") skipping = true;
        if (skipping) {
          if (line.trim().startsWith("- id:")) continue; // 本块开头
          if (line.trim() === "" || line.trim().startsWith("-")) { skipping = false; }
          continue;
        }
        out.push(line);
      }
      fs.writeFileSync(PROFILE_PATCH, out.join("\n"), "utf-8");
      return { ok: true, needRestart: true };
    }
    return { ok: true, needRestart: false, unchanged: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** 读取当前官方搜索状态。 */
export function getOfficialSearchState() {
  try {
    if (!fs.existsSync(PROFILE_PATCH)) return { enabled: false };
    const text = fs.readFileSync(PROFILE_PATCH, "utf-8");
    const m = text.match(/id: session-query-sqlite[\s\S]*?openAt:\s*(\w+)/);
    return { enabled: m ? m[1] === "startup" : false };
  } catch {
    return { enabled: false, error: "读取失败" };
  }
}
