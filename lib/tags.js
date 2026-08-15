/**
 * tags.js — 会话标签（插件自管标记体系）
 *
 * 与会话归属（dsh 工作区根，本体管理）解耦：标签只存插件自己的
 * state/session-tags.json，面板按标签分组显示会话。删除插件不影响
 * dsh 本体的工作区分组。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_FILE = path.join(
  process.env.DSH_CHANNELS_STATE_DIR?.trim() ||
    path.join(fileURLToPath(new URL("../", import.meta.url)), "state"),
  "session-tags.json",
);

/** 读取标签映射 {sessionId: [tag...]}。 */
export function readTags() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function writeTags(tags) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + ".tmp-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(tags, null, 2), "utf-8");
  fs.renameSync(tmp, STATE_FILE);
}

/** 全部标签列表（去重，按使用次数排序）。 */
export function listTags() {
  const bySession = readTags();
  const counter = new Map();
  for (const tags of Object.values(bySession)) {
    for (const t of tags || []) counter.set(t, (counter.get(t) || 0) + 1);
  }
  const all = [...counter.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  return { bySession, all };
}

/** 设置会话标签（数组，去重、去空、限长）。 */
export function setSessionTags(sessionId, tags) {
  const bySession = readTags();
  const clean = Array.isArray(tags)
    ? [...new Set(tags.map((t) => String(t).trim()).filter((t) => t && t.length <= 30))]
    : [];
  if (clean.length === 0) delete bySession[sessionId];
  else bySession[sessionId] = clean;
  writeTags(bySession);
  return { ok: true, tags: clean };
}

/** 删除一个标签（从所有会话移除），返回受影响会话数。 */
export function removeTag(tag) {
  const bySession = readTags();
  let affected = 0;
  for (const [sid, tags] of Object.entries(bySession)) {
    const next = (tags || []).filter((t) => t !== tag);
    if (next.length !== (tags || []).length) {
      if (next.length === 0) delete bySession[sid];
      else bySession[sid] = next;
      affected += 1;
    }
  }
  writeTags(bySession);
  return { ok: true, affected };
}

/** 重命名标签（所有会话同步改名；目标已存在时合并去重），返回受影响会话数。 */
export function renameTag(oldTag, newTag) {
  const target = String(newTag || "").trim();
  if (!target || target === oldTag) return { ok: true, changed: false };
  const bySession = readTags();
  let affected = 0;
  for (const [sid, tags] of Object.entries(bySession)) {
    if (!(tags || []).includes(oldTag)) continue;
    const next = [...new Set(tags.map((t) => (t === oldTag ? target : t)))];
    bySession[sid] = next;
    affected += 1;
  }
  if (affected > 0) writeTags(bySession);
  return { ok: true, affected };
}
