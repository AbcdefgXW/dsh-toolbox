/**
 * settings.js — dsh-tools 设置 schema
 *
 * 每个功能独立开关。规则：
 * - 纯前端行为 → 热开关（立即生效）
 * - 动 dsh 核心配置 → 冷开关（需重启，标题带 ⚠️ 提醒）
 *
 * 扩展约定：新增功能 = 在 schema 加字段 + 加开关定义（name/label/description），
 * 前端按 toolsSettings 统一读取，不需要改框架。
 */
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

export const TOOLS_NAMESPACE = "dsh-tools";

/** 开关定义表：供前端生成设置 UI 与后端校验。 */
export const TOOL_SWITCHES = [
  {
    key: "sessionManage",
    label: "会话管理",
    description: "会话列表操作：删除 / 移动 / 复制 / 重设工作区根",
    hot: true, // 热开关
    default: true,
  },
  {
    key: "dialogueManage",
    label: "对话管理",
    description: "⚠️ 需重启生效。会话内消息：截断到此（删除本条及之后）/ 编辑消息（改内容并删除后续回复）。操作后也需重启才完整生效（dsh 事件流不可变，热改有损坏风险）",
    hot: false, // 冷开关（后端端点需重启加载）
    default: false,
  },
  {
    key: "workspaceManage",
    label: "子目录管理",
    description: "工作区子目录：新增 / 重命名 / 删除 / 复制 / 移动",
    hot: true,
    default: true,
  },
  {
    key: "presetEdit",
    label: "预设编辑",
    description: "设置 → Agent 预设 → 自定义 agent 加「编辑」按钮",
    hot: true,
    default: true,
  },
  {
    key: "configEditor",
    label: "配置编辑器",
    description: "「打开配置文件」在线编辑能力（默认 dsh 只读，启用后提供编辑）",
    hot: true,
    default: true,
  },
  {
    key: "officialSearch",
    label: "官方搜索开关",
    description: "启用 dsh 官方全文搜索（openAt: startup + 持久索引）。⚠️ 需重启生效，关闭恢复官方默认（never）",
    hot: false, // 冷开关：改 session-query-sqlite 配置，需重启
    default: false,
  },
  {
    key: "customSearch",
    label: "自研搜索",
    description: "关键词搜索所有会话内容：高亮 + 跳转 + 可取消",
    hot: true,
    default: true,
  },
  {
    key: "trashRetentionDays",
    label: "回收站保留天数",
    description: "删除的会话/子目录在回收站的保留天数，0 = 不自动清除",
    hot: false,
    default: 30,
  },
];

/** 数值型开关单独处理。 */
const NUMBER_KEYS = new Set(["trashRetentionDays"]);

/** 持久化 schema（settings 文档）。 */
export const ToolsSettingsSchema = z.object(
  Object.fromEntries(
    TOOL_SWITCHES.map((s) => [
      s.key,
      NUMBER_KEYS.has(s.key) ? z.number().min(0).default(s.default) : z.boolean().default(s.default),
    ]),
  ),
);

/** 按 key 找开关定义。 */
export function toolSwitch(key) {
  return TOOL_SWITCHES.find((s) => s.key === key);
}

/** 注册设置（由后端 apply 调用）。 */
export function registerToolsSettings(settings) {
  settings.register(settingsNamespace(TOOLS_NAMESPACE), ToolsSettingsSchema);
}
