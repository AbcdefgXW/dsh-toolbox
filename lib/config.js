/**
 * config.js — dsh-toolbox 自己的设置存储
 *
 * dsh 的 settings 体系对 Web 客户端有硬编码白名单（settings-not-exposed），
 * 插件自己的开关走独立 JSON 存储：state/settings.json
 * - 默认值与 settings.js 的 TOOL_SWITCHES 一致
 * - 原子写（临时文件 + rename）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR = process.env.DSH_CHANNELS_STATE_DIR?.trim() ||
  path.join(fileURLToPath(new URL("../", import.meta.url)), "state");
const CONFIG_PATH = path.join(STATE_DIR, "settings.json");

/** 默认配置（与 settings.js 的 TOOL_SWITCHES 默认一致）。 */
const DEFAULTS = {
  scheduleTask: false,
  scheduleInterval: 60,
  schedulePrompt: "【定时心跳】请检查当前是否有待办、提醒或需要主动汇报的事项；如有请简要汇报，没有则简短确认即可。",
  scheduleCron: "off",
  scheduleTarget: "",
  scheduleCronTarget: "",
  scheduleCronPrompt: "【定时任务】现在是 {time}。请执行定时任务：检查待办与提醒、汇总值得告知用户的事项，并简明汇报。",
  sessionManage: true,
  workspaceManage: true,
  presetEdit: true,
  editorEnhance: true,
  configEditor: true,
  officialSearch: false,
  customSearch: false,
  lanBind: false,
  trashRetentionDays: 30,
  searchCacheSeconds: 120,
  embedBaseUrl: "https://api.siliconflow.cn/v1",
  embedApiKey: "",
  embedModel: "BAAI/bge-m3",
  embedEnabled: false,
  embedMinScore: 80,
  embedTopN: 20,
  searchDateFrom: "",
  searchDateTo: "",
};

export function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    // 损坏则回退默认
  }
  return { ...DEFAULTS };
}

/** 全部设置恢复默认（保留 Embedding API Key，其余回 DEFAULTS；真实写入配置文件）。 */
export function resetConfig() {
  const current = getConfig();
  const keep = { embedApiKey: current.embedApiKey || "" };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = CONFIG_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(keep, null, 2), "utf-8");
    fs.renameSync(tmp, CONFIG_PATH);
  } catch {
    // 写入失败也返回默认（getConfig 容错）
  }
  return { ...DEFAULTS, ...keep };
}

export function setConfigField(key, value) {
  const current = getConfig();
  current[key] = value;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf-8");
  fs.renameSync(tmp, CONFIG_PATH);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // best-effort
  }
  return current;
}
