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
    key: "scheduleTask",
    label: "定时心跳",
    description: "定时向主工作区会话注入心跳消息，唤醒 AI 执行巡检/汇报等任务（类似 OpenClaw 心跳模式）。⚠️ 会消耗 token；默认关；间隔与提示语见下方（改动 1 分钟内生效）",
    hot: false,
    default: false,
  },
  {
    key: "scheduleInterval",
    label: "心跳间隔（分钟）",
    description: "两次心跳之间的间隔，最小 5 分钟，默认 60 分钟",
    hot: false,
    default: 60,
  },
  {
    key: "schedulePrompt",
    label: "心跳提示语",
    description: "注入给 AI 的心跳内容；{time} 会自动替换为当前时间",
    hot: false,
    default: "【定时心跳】请检查当前是否有待办、提醒或需要主动汇报的事项；如有请简要汇报，没有则简短确认即可。",
  },
  {
    key: "scheduleCron",
    label: "定点定时",
    description: "在指定时间点触发心跳：每天几点 / 每周几 / 每月几号（JSON：{\"type\":\"daily|weekly|monthly\",\"time\":\"HH:mm\",\"day\":0-6,\"date\":1-31}；\"off\" 关闭）",
    hot: false,
    default: "off",
  },
  {
    key: "scheduleTarget",
    label: "心跳目标会话",
    description: "间隔心跳注入到哪个会话：留空 = 主工作区根（默认）；指定 = 只注入该会话",
    hot: false,
    default: "",
  },
  {
    key: "scheduleCronTarget",
    label: "定点定时目标会话",
    description: "定点定时（每天/每周/每月）注入到哪个会话：留空 = 主工作区根（默认）；指定 = 只注入该会话",
    hot: false,
    default: "",
  },
  {
    key: "scheduleCronPrompt",
    label: "定点定时提示语",
    description: "定点定时注入的内容；{time} 会自动替换为当前时间（与间隔心跳提示语独立）",
    hot: false,
    default: "【定时任务】现在是 {time}。请执行定时任务：检查待办与提醒、汇总值得告知用户的事项，并简明汇报。",
  },
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
    key: "lanBind",
    label: "局域网访问（LAN 绑定）",
    description: "把 dsh web 从 127.0.0.1 重绑到 0.0.0.0，局域网设备可访问（默认开）。⚠️ 需重启生效；0.0.0.0 = 局域网任何设备可驱动 agent（含 shell），建议防火墙限制 3080；非本机访问特权 API 需在 profile cordis.patch.yml 配置 client-connection 的 trustedHosts",
    hot: false,
    default: true,
  },
  {
    key: "customSearch",
    label: "自研搜索",
    description: "关键词搜索所有会话内容：高亮 + 跳转 + 可取消（默认关）。⚠️ 占内存，使用后必须重启 DSH 服务才会释放",
    hot: true,
    default: false,
  },
  {
    key: "trashRetentionDays",
    label: "回收站保留天数",
    description: "删除的会话/子目录在回收站的保留天数，0 = 不自动清除",
    hot: false,
    default: 30,
  },
  {
    key: "collapseUserMsg",
    label: "用户长消息折叠",
    description: "你发送的消息超过「折叠行数阈值」时自动折叠显示，点击「展开全部」查看（改后刷新页面生效）",
    hot: false,
    default: true,
  },
  {
    key: "collapseUserThreshold",
    label: "折叠行数阈值",
    description: "消息超过该行数即折叠（默认 15 行，0 = 不折叠）；用户与 AI 消息共用此阈值",
    hot: false,
    default: 15,
  },
  {
    key: "embedBaseUrl",
    label: "Embedding API 地址",
    description: "OpenAI 兼容端点，默认 SiliconFlow：https://api.siliconflow.cn/v1（也支持阿里云等兼容服务）；清空 = 用默认地址",
    hot: false,
    default: "https://api.siliconflow.cn/v1",
  },
  {
    key: "embedApiKey",
    label: "Embedding API Key",
    description: "在对应平台（如 cloud.siliconflow.cn → API 密钥）生成的 Key；清空 = 禁用语义搜索（自动降级关键词）",
    hot: false,
    default: "",
  },
  {
    key: "embedModel",
    label: "Embedding 模型",
    description: "如 BAAI/bge-m3（SiliconFlow）或 text-embedding-v3（阿里云）；可用「获取模型」拉取列表，清空 = 用默认模型",
    hot: false,
    default: "BAAI/bge-m3",
  },
  {
    key: "searchCacheSeconds",
    label: "搜索缓存秒数",
    description: "关键词/语义搜索同词缓存时长（秒），缓存期内重复搜索不重复解压/不重复调 API；0 = 不缓存（默认 120）",
    hot: false,
    default: 120,
  },
  {
    key: "embedEnabled",
    label: "语义搜索开关",
    description: "总开关（默认关）。开启后搜索 Tab 才可切换到「🧠 语义」模式；关闭时只能关键词搜索（省内存）",
    hot: false,
    default: false,
  },
  {
    key: "embedMinScore",
    label: "语义相关度阈值",
    description: "低于该相关度（0-100，默认 80）的语义命中视为噪声，自动降级关键词搜索",
    hot: false,
    default: 80,
  },
  {
    key: "embedTopN",
    label: "语义显示条数",
    description: "只显示相关度前 N 条语义命中；0 = 不限制",
    hot: false,
    default: 20,
  },
  {
    key: "searchDateFrom",
    label: "关键词时间范围（起）",
    description: "关键词搜索只显示该时间之后的记录（空 = 不限），配合快捷按钮使用",
    hot: false,
    default: "",
  },
  {
    key: "searchDateTo",
    label: "关键词时间范围（止）",
    description: "关键词搜索只显示该时间之前的记录（空 = 不限）",
    hot: false,
    default: "",
  },
  {
    key: "collapseAiMsg",
    label: "AI 长消息折叠",
    description: "AI 回复超过「折叠行数阈值」时自动折叠显示（默认关闭；阈值同上）",
    hot: false,
    default: false,
  },
];

/** 数值型开关单独处理。 */
const NUMBER_KEYS = new Set(["trashRetentionDays", "collapseUserThreshold", "scheduleInterval", "searchCacheSeconds", "embedMinScore", "embedTopN"]);

/** 文本型开关（提示语等）。 */
const STRING_KEYS = new Set(["schedulePrompt", "scheduleCron", "scheduleTarget", "scheduleCronTarget", "scheduleCronPrompt", "embedBaseUrl", "embedApiKey", "embedModel", "searchDateFrom", "searchDateTo"]);

/** 持久化 schema（settings 文档）。 */
export const ToolsSettingsSchema = z.object(
  Object.fromEntries(
    TOOL_SWITCHES.map((s) => [
      s.key,
      NUMBER_KEYS.has(s.key)
        ? z.number().min(0).default(s.default)
        : STRING_KEYS.has(s.key)
          ? z.string().default(s.default)
          : z.boolean().default(s.default),
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
