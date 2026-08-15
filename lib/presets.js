/**
 * presets.js — Agent 预设编辑（后端）
 *
 * 用户预设目录：$DSH_HOME/.agent-presets/<id>/（preset.yml 元数据 + agent.cordis.yml 主体）。
 * 安全：只允许读写预设目录内的文件（路径白名单校验）。
 */
import fs from "node:fs";
import path from "node:path";

const PRESETS_ROOT = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, ".agent-presets")
  : "/home/dsh/.agent-presets";

/** 列出用户预设（含文件清单）。 */
export function listPresets() {
  if (!fs.existsSync(PRESETS_ROOT)) return [];
  return fs
    .readdirSync(PRESETS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const dir = path.join(PRESETS_ROOT, d.name);
      let meta = {};
      try {
        const raw = fs.readFileSync(path.join(dir, "preset.yml"), "utf-8");
        const nameMatch = raw.match(/^name:\s*(.+)$/m);
        const descMatch = raw.match(/^description:\s*(.+)$/m);
        meta = { name: nameMatch ? nameMatch[1].trim() : d.name, description: descMatch ? descMatch[1].trim() : "" };
      } catch {
        meta = { name: d.name, description: "" };
      }
      const files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => {
          const p = path.join(dir, f.name);
          const st = fs.statSync(p);
          return { name: f.name, size: st.size, mtime: st.mtimeMs };
        });
      return { id: d.name, ...meta, dir, files };
    });
}

/** 校验路径在预设目录内（防目录穿越）。 */
function safeResolve(presetId, fileName) {
  const dir = path.join(PRESETS_ROOT, presetId);
  const resolved = path.resolve(dir, fileName);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) throw new Error("路径越界");
  return resolved;
}

/** 读取预设内文件。 */
export function readPresetFile(presetId, fileName) {
  const p = safeResolve(presetId, fileName);
  if (!fs.existsSync(p)) return { ok: false, error: "文件不存在" };
  const content = fs.readFileSync(p, "utf-8");
  return { ok: true, presetId, fileName, content };
}

/** 保存预设内文件（原子写）。 */
export function savePresetFile(presetId, fileName, content) {
  const p = safeResolve(presetId, fileName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) return { ok: false, error: "预设目录不存在" };
  if (typeof content !== "string") return { ok: false, error: "内容必须是字符串" };
  const tmp = p + ".tmp-" + Date.now();
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, p);
  return { ok: true, presetId, fileName, size: Buffer.byteLength(content, "utf-8") };
}
