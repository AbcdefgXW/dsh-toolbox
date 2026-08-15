/**
 * trash.js — 回收站（后端）
 *
 * 删除的会话/子目录移入回收站（可恢复），支持：
 * - 恢复（移回原位）
 * - 清空
 * - 自动清除（TTL，设置项 trashRetentionDays；0=不自动清）
 *
 * 位置：插件 state/trash/（跟随插件迁移）。
 * 每条目一个目录：{type}-{seq}-{name}/ 内含 meta.json（原路径/时间）+ 原内容。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRASH_ROOT = path.join(
  process.env.DSH_CHANNELS_STATE_DIR?.trim() ||
    path.join(fileURLToPath(new URL("../", import.meta.url)), "state"),
  "trash",
);

/** 跨设备安全移动（rename 失败时 fallback 复制+删除）。 */
function moveAcrossDevices(src, dst) {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err?.code !== "EXDEV") throw err;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** 把路径移入回收站。 */
export function trashItem({ type, name, sourcePath, meta = {} }) {
  fs.mkdirSync(TRASH_ROOT, { recursive: true });
  const seq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const entryDir = path.join(TRASH_ROOT, `${type}-${seq}-${sanitize(name)}`);
  fs.mkdirSync(entryDir, { recursive: true });
  moveAcrossDevices(sourcePath, path.join(entryDir, "data"));
  fs.writeFileSync(
    path.join(entryDir, "meta.json"),
    JSON.stringify({ type, name, sourcePath, deletedAt: Date.now(), ...meta }, null, 2),
    "utf-8",
  );
  return entryDir;
}

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

/** 回收站列表。 */
export function listTrash() {
  if (!fs.existsSync(TRASH_ROOT)) return [];
  return fs
    .readdirSync(TRASH_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const metaPath = path.join(TRASH_ROOT, d.name, "meta.json");
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        return { entryDir: path.join(TRASH_ROOT, d.name), ...meta };
      } catch {
        return { entryDir: path.join(TRASH_ROOT, d.name), type: "unknown", name: d.name, deletedAt: 0 };
      }
    })
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
}

/** 恢复：移回原路径（原路径被占用时改名 -恢复x）。 */
export function restoreTrashEntry(entryDir) {
  const metaPath = path.join(entryDir, "meta.json");
  if (!fs.existsSync(metaPath)) return { ok: false, error: "元数据丢失" };
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  const dataPath = path.join(entryDir, "data");
  if (!fs.existsSync(dataPath)) return { ok: false, error: "数据缺失" };
  let target = meta.sourcePath;
  if (fs.existsSync(target)) {
    let n = 1;
    const base = target;
    while (fs.existsSync(target)) {
      target = `${base}-恢复${n}`;
      n += 1;
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  moveAcrossDevices(dataPath, target);
  fs.rmSync(entryDir, { recursive: true, force: true });
  return { ok: true, restoredTo: target };
}

/** 清空回收站。 */
export function emptyTrash() {
  if (!fs.existsSync(TRASH_ROOT)) return { ok: true, count: 0 };
  let count = 0;
  for (const d of fs.readdirSync(TRASH_ROOT)) {
    fs.rmSync(path.join(TRASH_ROOT, d), { recursive: true, force: true });
    count += 1;
  }
  return { ok: true, count };
}

/**
 * 自动清除：删除超过 retentionDays 的条目。
 * @param {number} retentionDays 0 = 不自动清
 * @returns 清除的条目数
 */
export function purgeTrash(retentionDays) {
  if (!retentionDays || retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const entry of listTrash()) {
    if ((entry.deletedAt ?? 0) < cutoff) {
      fs.rmSync(entry.entryDir, { recursive: true, force: true });
      purged += 1;
    }
  }
  return purged;
}

/** 启动定时自动清除（启动时一次 + 每 intervalMs 一次）。 */
export function startTrashWatcher(getRetentionDays) {
  const run = () => {
    try {
      purgeTrash(getRetentionDays());
    } catch {
      // best-effort
    }
  };
  run();
  const timer = setInterval(run, 6 * 60 * 60 * 1000); // 每 6 小时
  timer.unref?.();
  return () => clearInterval(timer);
}
