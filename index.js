/**
 * index.js — dsh-toolbox 后端入口（cordis 插件）
 *
 * 机制（踩坑后定案）：
 * - 实现 = cordis Service（实例挂 typertRemote 绑定，方法名 = 端点名）
 * - 声明 = ctx.typert.register({package, schemas: [], invocations}) → localStore（strict 路径）
 * - invoke 时按 service key 找 ctx 服务 + 直接调方法（不依赖装饰器 marker）
 *
 * 扩展约定：新功能 = lib/ 加模块 + 这里加一个方法 + 一条 invocation。
 */
import { Service } from "@deepseek-ai/cordis";
import { bindTypertRemote } from "@deepseek-ai/dsh-typert-protocol";
import {
  registerToolsSettings,
  TOOL_SWITCHES,
  TOOLS_NAMESPACE,
} from "./lib/settings.js";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import {
  listAllSessions,
  deleteSession,
  copySession,
  resetSessionCwd,
  nextCopySuffix,
  forkSession,
  readSessionTitle,
  readSessionStats,
  readSessionStatsLite,
  clearProjCache,
  WORKSPACE_ROOT,
} from "./lib/sessions.js";
import {
  listSubdirs,
  createSubdir,
  renameSubdir,
  deleteSubdir,
  copySubdir,
  refreshSessionCounts,
} from "./lib/workspace.js";
import {
  searchSessions,
  setOfficialSearch,
  getOfficialSearchState,
  clearSearchCache,
} from "./lib/search.js";
import {
  trashItem,
  listTrash,
  restoreTrashEntry,
  emptyTrash,
  startTrashWatcher,
} from "./lib/trash.js";
import { getConfig, setConfigField } from "./lib/config.js";
import { listPresets, readPresetFile, savePresetFile } from "./lib/presets.js";
import { decompressFirstFrame } from "./lib/zstd.js";
import { listTags, setSessionTags, removeTag, renameTag } from "./lib/tags.js";
import { listMessages, truncateSessionAt, editMessageAt } from "./lib/messages.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 插件自身目录（发布到任意位置都能正确找到 state/）
const PLUGIN_STATE_DIR = path.join(fileURLToPath(new URL("./", import.meta.url)), "state");

// 心跳运行状态（tools.debug 端点读取，排查用）
let heartbeatState = { running: false, lastBeatAt: 0, lastResult: "", lastTarget: "" };

export const name = "dsh-toolbox";

export const inject = ["settings", "typert", "agents"];

/** 端点实现：一个 Service，方法名 = typert 端点 method。 */
class ToolsApi extends Service {
  constructor(ctx) {
    super(ctx, "dsh-toolbox-api");
    this.typertRemote = bindTypertRemote(this, this.name, { namespace: "dsh-toolbox" });
  }

  // ── 基础 ──
  async info() {
    return {
      workspaceRoot: WORKSPACE_ROOT,
      switches: TOOL_SWITCHES.map(({ key, label, hot, default: def }) => ({ key, label, hot, default: def })),
    };
  }

  // ── 会话管理 ──
  async "sessions.list"() {
    const all = await listAllSessions();
    return all.map((s) => {
      const stats = readSessionStatsLite(s.path, s.sessionId);
      return { sessionId: s.sessionId, cwd: s.cwd, title: stats?.title ?? null, size: stats?.size ?? 0, turns: stats?.turns ?? 0 };
    });
  }

  /** 释放内存：清空插件缓存 + 尽力触发 GC（dsh 未开 --expose-gc 时只清缓存）。 */
  async "tools.gc"() {
    const cleared = [];
    try { clearSearchCache(); cleared.push("搜索缓存"); } catch {}
    try { clearProjCache(); cleared.push("会话统计缓存"); } catch {}
    let gcRan = false;
    try {
      if (typeof global.gc === "function") { global.gc(); gcRan = true; }
    } catch {}
    return {
      ok: true,
      gcRan,
      cleared,
      note: gcRan
        ? "已清空插件缓存并触发 GC（堆内存尽力回收）"
        : "已清空插件缓存；dsh 未开启 --expose-gc，无法强制 GC——彻底释放需重启容器",
    };
  }

  /** 调试信息：心跳运行状态 + live root agents 快照（排查渠道推送问题）。 */
  async "tools.debug"() {
    const agents = this.ctx.get("agents");
    const roots = [];
    try {
      if (agents && typeof agents.roots === "function") {
        for (const a of agents.roots()) {
          roots.push({ id: a.id, cwd: a?.session?.header?.cwd, followup: typeof a.followup === "function" });
        }
      }
    } catch {}
    return { ok: true, heartbeat: { ...heartbeatState }, agents: roots };
  }

  async "sessions.header"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    return s ? s.header : null;
  }

  async "sessions.delete"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    try {
      trashItem({ type: "session", name: s.sessionId, sourcePath: s.path, meta: { cwd: s.cwd } });
    } catch (err) {
      logErr("sessions.delete", err);
      throw err;
    }
    // 官方归档：左侧列表立即隐藏（live 内存残留也看不见）
    let archived = false;
    try {
      const reg = this.ctx.get("workspaceRegistry");
      if (reg && typeof reg.archiveSession === "function") {
        await reg.archiveSession(sessionId);
        archived = true;
      }
    } catch (err) {
      logErr("sessions.delete.archive", err);
    }
    return { ok: true, needRestart: !archived, archived };
  }

  async "sessions.copy"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    const siblings = all.filter((x) => x.cwd === s.cwd).map((x) => x.sessionId);
    const newId = nextCopySuffix(s.sessionId, siblings);
    const sessions = this.ctx.get("sessions");
    try {
      // 官方 fork：store 感知，左侧立即可见
      await forkSession(sessions, s.sessionId, newId);
      return { ok: true, newSessionId: newId, method: "fork" };
    } catch (forkErr) {
      // 注意：不再文件复制兜底——copySession 单帧格式官方加载器不认（曾致会话列表崩溃）。
      // 前端复制已改走官方 fork API；此端点保留仅用于诊断。
      logErr("sessions.copy(fork)", forkErr);
      return { ok: false, error: "官方分叉失败：" + String(forkErr) };
    }
  }

  async "sessions.resetCwd"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    const result = await resetSessionCwd(s.path, WORKSPACE_ROOT);
    if (!result.ok) return result;
    try {
      await syncWorkspaceAfterMove(this.ctx, sessionId, WORKSPACE_ROOT);
    } catch (err) {
      logErr("sessions.resetCwd.sync", err);
    }
    return { ...result, needRestart: true };
  }

  async "sessions.move"(targetCwd, sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    const result = await resetSessionCwd(s.path, targetCwd);
    if (!result.ok) return result;
    try {
      await syncWorkspaceAfterMove(this.ctx, sessionId, targetCwd);
    } catch (err) {
      logErr("sessions.move.sync", err);
    }
    return { ...result, needRestart: true };
  }

  async "sessions.detach"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    const reg = this.ctx.get("workspaceRegistry");
    if (reg && reg.entities && typeof reg.entities.values === "function") {
      for (const e of [...reg.entities.values()]) {
        if (typeof e.detachSession !== "function") continue;
        try { await e.detachSession(sessionId); } catch (err) { logErr("sessions.detach", err); }
      }
    }
    return { ok: true, synced: true };
  }

  // ── 子目录管理 ──
  async "workspace.list"() {
    return refreshSessionCounts(listSubdirs());
  }

  async "workspace.create"(name) {
    return createSubdir(name);
  }

  async "workspace.rename"(oldName, newName) {
    const r = renameSubdir(oldName, newName);
    if (!r.ok) return r;
    // 会话 cwd 跟随：cwd 以旧目录为前缀的会话 → 更新为新路径（保持相对结构）
    const from = path.join(WORKSPACE_ROOT, oldName);
    const to = path.join(WORKSPACE_ROOT, newName);
    const all = await listAllSessions();
    let moved = 0;
    for (const s of all) {
      if (!(s.cwd === from || s.cwd.startsWith(from + path.sep))) continue;
      const newCwd = to + s.cwd.slice(from.length);
      const rr = await resetSessionCwd(s.path, newCwd);
      if (rr.ok) moved += 1;
    }
    return { ok: true, movedSessions: moved };
  }

  async "workspace.moveSessions"(name, targetCwd) {
    const prefix = path.join(WORKSPACE_ROOT, name);
    const all = await listAllSessions();
    let moved = 0;
    for (const s of all) {
      if (!(s.cwd === prefix || s.cwd.startsWith(prefix + path.sep))) continue;
      const rr = await resetSessionCwd(s.path, targetCwd);
      if (rr.ok) moved += 1;
    }
    return { ok: true, moved };
  }

  async "workspace.delete"(name, sessionsAction) {
    const target = path.join(WORKSPACE_ROOT, name);
    if (!fs.existsSync(target)) return { ok: false, error: "目录不存在" };
    // 关联会话：cwd 以该子目录开头的会话（会话文件在 sessions 区，不在子目录内）
    const all = await listAllSessions();
    const prefix = target;
    const related = all.filter((s) => s.cwd === prefix || s.cwd.startsWith(prefix + path.sep));
    trashItem({ type: "subdir", name, sourcePath: target });
    let moved = 0;
    if (sessionsAction === "trash") {
      // 一并进回收站
      for (const s of related) {
        trashItem({ type: "session", name: s.sessionId, sourcePath: s.path, meta: { cwd: s.cwd } });
        moved += 1;
      }
    } else if (sessionsAction === "reset") {
      // 会话重设到工作区根（避免 cwd 悬空）
      for (const s of related) {
        const r = await resetSessionCwd(s.path, WORKSPACE_ROOT);
        if (r.ok) moved += 1;
      }
    }
    return { ok: true, needRestart: true, relatedSessions: related.length, movedSessions: moved };
  }

  async "workspace.copy"(name) {
    return copySubdir(name);
  }

  // ── 搜索 ──
  async "search.query"(keyword, signal) {
    const hits = await searchSessions(keyword, signal);
    return { ok: true, hits };
  }

  async "officialSearch.get"() {
    return getOfficialSearchState();
  }

  async "officialSearch.set"(enabled) {
    return setOfficialSearch(Boolean(enabled));
  }

  // ── 自定义配置（绕开 dsh settings 白名单） ──
  async "config.get"() {
    return getConfig();
  }

  async "config.set"(key, value) {
    return setConfigField(key, value);
  }

  // ── Agent 预设编辑 ──
  async "presets.list"() {
    return listPresets();
  }

  async "presets.read"(presetId, fileName) {
    return readPresetFile(presetId, fileName);
  }

  async "presets.save"(presetId, fileName, content) {
    return savePresetFile(presetId, fileName, content);
  }

  // ── 会话标签（插件自管标记，不碰 dsh 本体） ──
  async "tags.list"() {
    return listTags();
  }

  async "tags.set"(sessionId, tags) {
    return setSessionTags(sessionId, tags);
  }

  async "tags.remove"(tag) {
    return removeTag(tag);
  }

  async "tags.rename"(oldTag, newTag) {
    return renameTag(oldTag, newTag);
  }

  // ── 对话管理（截断/编辑，安全模型：只允许删尾或改尾） ──
  async "messages.list"(sessionId, limit) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    return listMessages(s.path, limit || 20);
  }

  async "messages.truncate"(sessionId, seq) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    if (typeof seq !== "number" || !Number.isFinite(seq)) return { ok: false, error: "seq 无效" };
    return truncateSessionAt(s.path, seq);
  }

  async "messages.edit"(sessionId, seq, content) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    if (typeof seq !== "number" || !Number.isFinite(seq)) return { ok: false, error: "seq 无效" };
    if (typeof content !== "string" || !content.trim()) return { ok: false, error: "内容无效" };
    return editMessageAt(s.path, seq, content);
  }

  // ── 配置文件在线编辑（插件化，替代 dsh-patches 补丁） ──
  async "configfile.read"() {
    try {
      const settings = this.ctx.get("settings");
      if (!settings) return { ok: false, error: "settings 服务不可用" };
      const p = settings.documentPath;
      if (!p || !fs.existsSync(p)) return { ok: false, error: "配置文件不存在：" + String(p) };
      return { ok: true, path: p, content: fs.readFileSync(p, "utf-8") };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async "configfile.save"(content) {
    if (typeof content !== "string") return { ok: false, error: "内容无效" };
    try {
      // YAML 校验（与官方 saveDocument 一致：不可解析/非 map 根则拒绝）
      // js-yaml 为插件自身依赖（package.json dependencies），用 createRequire 解析
      const req = createRequire(import.meta.url);
      const yaml = req("js-yaml");
      const parsed = yaml.load(content);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "配置必须是 YAML 映射（map）" };
      }
      const settings = this.ctx.get("settings");
      if (!settings) return { ok: false, error: "settings 服务不可用" };
      const p = settings.documentPath;
      if (!p) return { ok: false, error: "无配置文件路径" };
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + ".tmp-" + Date.now();
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, p);
      return { ok: true, path: p, needRestart: true };
    } catch (err) {
      return { ok: false, error: "保存失败：" + String(err) };
    }
  }

  // ── 归档会话（dsh 官方 archivedSessionIds，左侧隐藏但文件还在） ──
  async "archived.list"() {
    const all = await listAllSessions();
    const reg = this.ctx.get("workspaceRegistry");
    const archived = [];
    if (reg && typeof reg.requireState === "function") {
      try {
        const ids = reg.requireState().archivedSessionIds || [];
        for (const id of ids) {
          const s = all.find((x) => x.sessionId === id);
          if (s) {
            const stats = readSessionStatsLite(s.path, s.sessionId);
            archived.push({
              sessionId: id,
              cwd: s.cwd,
              title: stats?.title ?? null,
              size: stats?.size ?? 0,
              turns: stats?.turns ?? 0,
            });
          }
        }
      } catch (err) {
        logErr("archived.list", err);
      }
    }
    return archived;
  }

  /** 归档 Tab 的删除：进回收站 + 从归档列表移除（不留残影）。 */
  async "archived.delete"(sessionId) {
    const all = await listAllSessions();
    const s = all.find((x) => x.sessionId === sessionId);
    if (!s) return { ok: false, error: "会话不存在" };
    try {
      trashItem({ type: "session", name: s.sessionId, sourcePath: s.path, meta: { cwd: s.cwd } });
    } catch (err) {
      logErr("archived.delete", err);
      throw err;
    }
    const reg = this.ctx.get("workspaceRegistry");
    if (reg && typeof reg.requireState === "function" && typeof reg.setState === "function") {
      try {
        const state = reg.requireState();
        if (Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.includes(sessionId)) {
          await reg.setState({
            ...state,
            archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
          });
        }
      } catch (err) {
        logErr("archived.delete.unarchive", err);
      }
    }
    return { ok: true };
  }

  async "archived.restore"(sessionId) {
    const reg = this.ctx.get("workspaceRegistry");
    if (!reg || typeof reg.requireState !== "function" || typeof reg.setState !== "function") {
      return { ok: false, error: "workspace 服务不可用" };
    }
    try {
      const state = reg.requireState();
      if (!Array.isArray(state.archivedSessionIds) || !state.archivedSessionIds.includes(sessionId)) {
        return { ok: true, unchanged: true };
      }
      await reg.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      });
      return { ok: true, needRestart: true };
    } catch (err) {
      logErr("archived.restore", err);
      return { ok: false, error: String(err) };
    }
  }

  // ── 回收站 ──
  async "trash.list"() {
    const entries = listTrash();
    return entries.map((e) => {
      if (e.type !== "session" || !e.entryDir) return e;
      const file = path.join(e.entryDir, "data", "session.jsonl.zstd");
      if (!fs.existsSync(file)) return e;
      try {
        // 统计缓存：meta.json 里已存过且文件未变 → 直接复用（避免重复解压）
        const mtime = fs.statSync(file).mtimeMs;
        if (e.statsMtime === mtime && typeof e.stTitle === "string") {
          return { ...e, title: e.stTitle, size: e.stSize, turns: e.stTurns };
        }
        const stats = readSessionStats(path.join(e.entryDir, "data"));
        if (stats) {
          const metaPath = path.join(e.entryDir, "meta.json");
          const meta = { ...e, stTitle: stats.title, stSize: stats.size, stTurns: stats.turns, statsMtime: mtime };
          delete meta.title; delete meta.size; delete meta.turns;
          try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8"); } catch {}
          return { ...e, title: stats.title, size: stats.size, turns: stats.turns };
        }
      } catch {}
      return e;
    });
  }

  /** 查看回收站会话内容（只读，读 data 目录的会话文件）。 */
  async "trash.view"(entryDir, limit = 30) {
    const dataPath = path.join(entryDir, "data");
    if (!fs.existsSync(dataPath)) return { ok: false, error: "回收站条目数据缺失" };
    return listMessages(dataPath, limit);
  }

  async "trash.restore"(entryDir) {
    const r = restoreTrashEntry(entryDir);
    if (r.ok) {
      try {
        const sessionId = sessionIdFromPath(r.restoredTo);
        if (sessionId) {
          const reg = this.ctx.get("workspaceRegistry");
          if (reg && typeof reg.requireState === "function" && typeof reg.setState === "function") {
            const state = reg.requireState();
            if (Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.includes(sessionId)) {
              await reg.setState({
                ...state,
                archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
              });
            }
          } else {
            unarchiveSessionId(sessionId); // fallback：改 workspace.json（需重启）
          }
        }
      } catch (err) {
        logErr("trash.restore.unarchive", err);
      }
    }
    return r;
  }

  async "trash.empty"() {
    return emptyTrash();
  }

  async "trash.purge"(entryDir) {
    try {
      fs.rmSync(entryDir, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}

/** 构造 invocation descriptor（strict 路径）。 */
function invocation(method, params = [], cancellation = false) {
  return {
    id: `dsh-toolbox#${method}`,
    service: "dsh-toolbox-api",
    namespace: "dsh-toolbox",
    method,
    invocation: { kind: "direct" },
    parameters: params.map((wire) => ({
      name: wire,
      wire,
      source: "json",
      codec: { mode: "src-json" },
    })),
    ...(cancellation ? { cancellation: { parameter: "signal" } } : {}),
    result: { mode: "src-json" },
  };
}

/** 从恢复路径提取会话 id（路径 → header.id）。 */
function sessionIdFromPath(sessionPathOrId) {
  if (!sessionPathOrId) return null;
  const p = String(sessionPathOrId).replace(/\/$/, "");
  if (fs.existsSync(path.join(p, "session.jsonl.zstd"))) {
    try {
      const text = decompressFirstFrame(path.join(p, "session.jsonl.zstd"));
      const first = JSON.parse(text.trim().split("\n")[0]);
      if (first && first.id) return first.id;
    } catch {}
  }
  return null;
}

/** 从 workspace.json 的 archivedSessionIds 移除指定会话（fallback，重启后生效）。 */
function unarchiveSessionId(sessionId) {
  const file = path.join(process.env.DSH_HOME || "/home/dsh", "storages", "workspace.json");
  if (!fs.existsSync(file)) return;
  const j = JSON.parse(fs.readFileSync(file, "utf-8"));
  const arr = j.global && j.global.archivedSessionIds;
  if (!Array.isArray(arr)) return;
  const idx = arr.indexOf(sessionId);
  if (idx < 0) return;
  arr.splice(idx, 1);
  const tmp = file + ".tmp-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

/** 移动/重设后同步 workspace 归属：从所有工作区 detach，再 attach 到匹配新 cwd 的工作区。
 * 匹配规则：新 cwd 是注册工作区 → attach 它；是注册工作区的子路径 → attach 父工作区；
 * 否则不 attach（左侧显示"未分组"）。 */
async function syncWorkspaceAfterMove(ctx, sessionId, newCwd) {
  const reg = ctx.get("workspaceRegistry");
  if (!reg) return { ok: true, synced: false };
  let entities = [];
  try {
    entities = reg.entities && typeof reg.entities.values === "function" ? [...reg.entities.values()] : [];
  } catch (e) {
    logErr("sync.detach.list", e);
  }
  // detach 全部（detachSession 幂等，只移除包含它的）
  for (const e of entities) {
    if (typeof e.detachSession !== "function") continue;
    try { await e.detachSession(sessionId); } catch (err) { logErr("sync.detach", err); }
  }
  // attach 匹配工作区：精确匹配或子路径归属
  let attached = false;
  for (const e of entities) {
    const p = e.record && e.record.path;
    if (typeof p !== "string") continue;
    if (newCwd === p || newCwd.startsWith(p + "/")) {
      if (typeof e.attachSession === "function") {
        try { await e.attachSession(sessionId); attached = true; } catch (err) { logErr("sync.attach", err); }
      }
      break;
    }
  }
  return { ok: true, synced: true, attached };
}

/** 错误落盘日志（排查用，写插件 state/err.log）。 */
function logErr(where, err) {
  try {
    fs.appendFileSync(
      path.join(PLUGIN_STATE_DIR, "err.log"),
      new Date().toISOString() + " [" + where + "] " + String(err && (err.stack || err.message) ? (err.stack || err.message) : err) + "\n",
      "utf-8",
    );
  } catch {}
}

export function apply(ctx) {
  const log = ctx.logger;

  // ── 0. 启动探针（排查 client 加载） ──
  try {
    fs.mkdirSync(PLUGIN_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PLUGIN_STATE_DIR, "started.log"), new Date().toISOString() + " dsh-toolbox apply 执行\n", "utf-8");
    try {
      const cm = ctx.get("clientModules");
      if (cm) {
        const g = cm.graph();
        fs.writeFileSync(path.join(PLUGIN_STATE_DIR, "graph.log"),
          "entries: " + JSON.stringify((g.entries || []).map((e) => e.id)) + "\n", "utf-8");
      } else {
        fs.appendFileSync(path.join(PLUGIN_STATE_DIR, "graph.log"), "clientModules 服务不可用\n", "utf-8");
      }
    } catch (graphErr) {
      fs.appendFileSync(path.join(PLUGIN_STATE_DIR, "graph.log"), "graph 读取失败: " + String(graphErr) + "\n", "utf-8");
    }
  } catch (probeErr) {
    console.error("dsh-toolbox 探针失败:", String(probeErr));
  }

  // ── 1. 设置项注册 ──
  ctx.inject(["settings"], (settingsCtx) => {
    registerToolsSettings(settingsCtx.settings);
    log.info(`dsh-toolbox: 已注册 ${TOOL_SWITCHES.length} 个功能开关`);
  });

  // ── 2. 服务注册 + 端点声明 ──
  // 注意：Service 构造时已自动注册（provide(name, this)），这里只需实例化
  new ToolsApi(ctx);
  ctx.typert.register({
    package: "dsh-toolbox",
    face: "host",
    schemas: [],
    invocations: [
      invocation("info"),
      invocation("sessions.list"),
      invocation("sessions.header", ["sessionId"]),
      invocation("sessions.delete", ["sessionId"]),
      invocation("sessions.copy", ["sessionId"]),
      invocation("sessions.resetCwd", ["sessionId"]),
      invocation("sessions.move", ["targetCwd", "sessionId"]),
      invocation("sessions.detach", ["sessionId"]),
      invocation("workspace.list"),
      invocation("workspace.create", ["name"]),
      invocation("workspace.rename", ["oldName", "newName"]),
      invocation("workspace.moveSessions", ["name", "targetCwd"]),
      invocation("workspace.delete", ["name", "sessionsAction"]),
      invocation("workspace.copy", ["name"]),
      invocation("search.query", ["keyword"], true),
      invocation("officialSearch.get"),
      invocation("officialSearch.set", ["enabled"]),
      invocation("config.get"),
      invocation("config.set", ["key", "value"]),
      invocation("presets.list"),
      invocation("presets.read", ["presetId", "fileName"]),
      invocation("presets.save", ["presetId", "fileName", "content"]),
      invocation("tags.list"),
      invocation("tags.set", ["sessionId", "tags"]),
      invocation("tags.remove", ["tag"]),
      invocation("tags.rename", ["oldTag", "newTag"]),
      invocation("messages.list", ["sessionId", "limit"]),
      invocation("messages.truncate", ["sessionId", "seq"]),
      invocation("messages.edit", ["sessionId", "seq", "content"]),
      invocation("configfile.read"),
      invocation("configfile.save", ["content"]),
      invocation("archived.list"),
      invocation("archived.restore", ["sessionId"]),
      invocation("archived.delete", ["sessionId"]),
      invocation("trash.list"),
      invocation("trash.view", ["entryDir", "limit"]),
      invocation("trash.restore", ["entryDir"]),
      invocation("trash.empty"),
      invocation("trash.purge", ["entryDir"]),
      invocation("tools.gc"),
      invocation("tools.debug"),
    ],
  });
  log.info("dsh-toolbox: API 已注册（19 端点）");

  // ── 3. 回收站自动清除（TTL 读设置，启动一次 + 每 6 小时） ──
  let retentionDays = 30;
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings
      .get(settingsNamespace(TOOLS_NAMESPACE))
      .then((doc) => {
        retentionDays = doc?.trashRetentionDays ?? 30;
      })
      .catch(() => {});
  });
  const stopTrash = startTrashWatcher(() => retentionDays);
  ctx.on("dispose", stopTrash);

  // ── 4. 定时心跳（类似 OpenClaw 心跳模式）：定期向主工作区 live agent 注入用户消息唤醒执行 ──
  // 消息构造与官方 dsh-schedule 一致（role:user + source.plugin），无需依赖 dsh-llm。
  let lastBeatAt = 0;
  let heartbeatTimer = null;
  const HEART_LOG = path.join(PLUGIN_STATE_DIR, "heartbeat.log");
  const logHeart = (msg) => { try { fs.appendFileSync(HEART_LOG, new Date().toISOString() + " " + msg + "\n", "utf-8"); } catch {} };
  const doHeartbeat = async (targetOpt, promptOpt) => {
    try {
      const cfg = getConfig();
      if (!cfg.scheduleTask) return;
      const agents = ctx.agents;
      if (!agents || typeof agents.roots !== "function") return;
      const base = String(promptOpt ?? cfg.schedulePrompt ?? "").trim() ||
        "【定时心跳】请检查当前是否有待办、提醒或需要主动汇报的事项；如有请简要汇报，没有则简短确认即可。";
      const text = base.replace(/\{time\}/g, new Date().toLocaleString("zh-CN", { hour12: false }));
      const message = {
        role: "user",
        id: crypto.randomUUID(),
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "dsh-toolbox" },
      };
      let injected = 0;
      // 目标会话：调用方传入（间隔=scheduleTarget / 定点=scheduleCronTarget），空 = 主工作区根
      const target = String(targetOpt ?? "").trim();
      heartbeatState.lastBeatAt = Date.now();
      heartbeatState.lastTarget = target || "(主工作区根)";
      if (target) {
        // 查找目标 agent：优先 registry 直查，再 roots 遍历（渠道 agent 可能不在 roots）
        let agent = null;
        try { if (typeof agents.get === "function") agent = agents.get(target); } catch {}
        if (!agent) agent = agents.roots().find((a) => a.id === target) || null;
        if (agent && typeof agent.followup === "function") {
          await agent.followup(message);
          injected = 1;
          heartbeatState.lastResult = "已注入 " + target;
          logHeart("心跳注入 OK → " + target);
        } else {
          const ids = agents.roots().map((a) => a.id).join(" | ");
          heartbeatState.lastResult = "未找到目标（roots: " + ids.slice(0, 300) + "）";
          logHeart("心跳未找到目标 " + target + "；当前 roots: " + ids);
          log.info(`dsh-toolbox: 定时心跳目标会话未找到 ${target}（roots: ${ids}）`);
        }
      } else {
        for (const agent of agents.roots()) {
          try {
            // 只心跳主工作区根的 live agent；渠道（ch-*）与子代理跳过
            const cwd = agent?.session?.header?.cwd;
            if (cwd && cwd !== WORKSPACE_ROOT) continue;
            if (agent.id && String(agent.id).startsWith("ch-")) continue;
            if (typeof agent.followup === "function") {
              await agent.followup(message);
              injected += 1;
            }
          } catch (e) {
            logErr("heartbeat.followup", e);
          }
        }
        heartbeatState.lastResult = "已注入 " + injected + " 个会话（主工作区根）";
      }
      if (injected > 0) log.info(`dsh-toolbox: 定时心跳已注入 ${injected} 个会话`);
    } catch (e) {
      heartbeatState.lastResult = "异常: " + String(e).slice(0, 200);
      logErr("heartbeat", e);
    }
  };
  // 调度器：每 60 秒检查一次设置；开关开且距上次 ≥ 间隔（最小 5 分钟）→ 心跳；
  // 另检查定点定时（每天/每周/每月，分钟级，同分钟不重复触发）
  let lastCronKey = "";
  const checkCron = async () => {
    try {
      const cfg = getConfig();
      if (!cfg.scheduleTask) return;
      let cron = null;
      try {
        const raw = String(cfg.scheduleCron || "off").trim();
        if (raw !== "off") cron = JSON.parse(raw);
      } catch {}
      if (!cron || cron.type === "off" || !cron.time) return;
      const now = new Date();
      const hm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
      if (hm !== String(cron.time)) return;
      if (cron.type === "weekly" && now.getDay() !== Number(cron.day)) return;
      if (cron.type === "monthly" && now.getDate() !== Number(cron.date)) return;
      const key = now.toISOString().slice(0, 16);
      if (key === lastCronKey) return;
      lastCronKey = key;
      log.info("dsh-toolbox: 定点定时触发 " + JSON.stringify(cron));
      await doHeartbeat(cfg.scheduleCronTarget, cfg.scheduleCronPrompt);
    } catch (e) {
      logErr("heartbeat.cron", e);
    }
  };
  let prevTaskOn = null; // 开关状态跟踪：刚打开时开始计时，不立即触发
  const startHeartbeat = () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(async () => {
      try {
        const cfg = getConfig();
        const taskOn = cfg.scheduleTask === true;
        if (taskOn && prevTaskOn === false) lastBeatAt = Date.now(); // 刚打开：从现在起算
        prevTaskOn = taskOn;
        heartbeatState.running = taskOn;
        if (!taskOn) { lastBeatAt = 0; return; }
        const minutes = Math.max(5, Math.floor(Number(cfg.scheduleInterval) || 60));
        if (Date.now() - lastBeatAt >= minutes * 60 * 1000) {
          lastBeatAt = Date.now();
          await doHeartbeat(cfg.scheduleTarget);
        }
        await checkCron();
      } catch (e) {
        logErr("heartbeat.scheduler", e);
      }
    }, 60 * 1000);
    heartbeatTimer.unref?.();
  };
  startHeartbeat();
  ctx.on("dispose", () => { if (heartbeatTimer) clearInterval(heartbeatTimer); });
}
