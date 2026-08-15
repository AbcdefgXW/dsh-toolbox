/**
 * workspace.js — 工作区子目录管理（后端）
 *
 * 工作区根（/workspace）下的一级子目录视为"分组"：
 * 新增 / 重命名 / 删除 / 复制（连同子目录内的会话）/ 移动（改子目录所属——即重命名）
 *
 * 会话跟随子目录：子目录内的会话 cwd 是 工作区根/子目录 时，复制子目录要连带复制会话。
 */
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT, listAllSessions, copySession, nextCopySuffix } from "./sessions.js";

/** 列出工作区根的一级子目录（不含隐藏/系统目录）。 */
export function listSubdirs() {
  if (!fs.existsSync(WORKSPACE_ROOT)) return [];
  return fs
    .readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map((d) => ({
      name: d.name,
      path: path.join(WORKSPACE_ROOT, d.name),
      sessionCount: 0, // 异步统计，见 refreshSessionCounts
    }));
}

/** 异步刷新每个子目录的会话数（cwd 以该子目录开头的会话）。 */
export async function refreshSessionCounts(subdirs) {
  const sessions = await listAllSessions();
  for (const d of subdirs) {
    const prefix = path.join(WORKSPACE_ROOT, d.name);
    d.sessionCount = sessions.filter((s) => s.cwd === prefix || s.cwd.startsWith(prefix + path.sep)).length;
  }
  return subdirs;
}

export function createSubdir(name) {
  const target = path.join(WORKSPACE_ROOT, name);
  if (fs.existsSync(target)) return { ok: false, error: "目录已存在" };
  fs.mkdirSync(target, { recursive: true });
  return { ok: true };
}

export function renameSubdir(oldName, newName) {
  if (oldName === newName) return { ok: true, unchanged: true };
  const from = path.join(WORKSPACE_ROOT, oldName);
  const to = path.join(WORKSPACE_ROOT, newName);
  if (!fs.existsSync(from)) return { ok: false, error: "目录不存在" };
  if (fs.existsSync(to)) return { ok: false, error: "目标目录已存在" };
  fs.renameSync(from, to);
  return { ok: true };
}

export function deleteSubdir(name) {
  const target = path.join(WORKSPACE_ROOT, name);
  if (!fs.existsSync(target)) return { ok: false, error: "目录不存在" };
  fs.rmSync(target, { recursive: true, force: true });
  return { ok: true };
}

/**
 * 复制子目录（连同内部会话）。
 * 新目录名：`name-副本x`（x 最小可用）。内部会话复制时保持原名。
 */
export async function copySubdir(name) {
  const from = path.join(WORKSPACE_ROOT, name);
  if (!fs.existsSync(from)) return { ok: false, error: "目录不存在" };
  const siblings = listSubdirs().map((d) => d.name);
  const newName = nextCopySuffix(name, siblings);
  const to = path.join(WORKSPACE_ROOT, newName);
  fs.mkdirSync(to, { recursive: true });

  // 复制普通文件（含隐藏）
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }

  // 复制关联会话（cwd 在源子目录内的会话 → 复制到新子目录路径，会话名不变）
  const fromPrefix = from;
  const toPrefix = to;
  const sessions = await listAllSessions();
  for (const s of sessions) {
    if (!(s.cwd === fromPrefix || s.cwd.startsWith(fromPrefix + path.sep))) continue;
    const newCwd = toPrefix + s.cwd.slice(fromPrefix.length);
    await copySession(s.path, newCwd, s.sessionId);
  }

  return { ok: true, newName };
}
