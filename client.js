/**
 * client.js — dsh-toolbox 前端（浏览器端）
 *
 * 手写 client（无构建管线），遵循 dsh 客户端插件约定：
 * - window.__ModuleLoader__.load({id, factory})
 * - 调用后端：ctx.remote.$mount({package, descriptors}) → ctx.remote.<namespace>.<method>(...)
 * - 设置分组：ctx.slots.register({name: "settings.section", id, order, label, component})
 * - 设置数据：ctx.settingsScope.bind({namespace}) → getSnapshot()/set(field, value)
 *
 * 注意：浏览器直接加载，不能用 JSX 语法——用 react/jsx-runtime 的 jsx()。
 */
window.__ModuleLoader__.load({
  id: "dsh-toolbox",
  factory: (require) => {
    const { jsx } = require("react/jsx-runtime");
    const React = require("react");
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    const TOOLS_NS = "dsh-toolbox";

    /** strict codec：前端只校验 mode === "strict"；schema.parse 运行时透传任意值。 */
    const anySchema = { parse: (v) => v };
    const strictCodec = (typeSymbol) => ({ mode: "strict", typeSymbol, schema: anySchema });

    /** 与后端一致的端点声明（用于 $mount 生成前端调用方法）。 */
    const DESCRIPTORS = [
      ["info", []],
      ["sessions.list", []],
      ["sessions.header", ["sessionId"]],
      ["sessions.delete", ["sessionId"]],
      ["sessions.copy", ["sessionId"]],
      ["sessions.resetCwd", ["sessionId"]],
      ["sessions.move", ["targetCwd", "sessionId"]],
      ["sessions.detach", ["sessionId"]],
      ["workspace.list", []],
      ["workspace.create", ["name"]],
      ["workspace.rename", ["oldName", "newName"]],
      ["workspace.moveSessions", ["name", "targetCwd"]],
      ["workspace.delete", ["name", "sessionsAction"]],
      ["workspace.copy", ["name"]],
      ["search.query", ["keyword"]],
      ["officialSearch.get", []],
      ["officialSearch.set", ["enabled"]],
      ["presets.list", []],
      ["presets.read", ["presetId", "fileName"]],
      ["presets.save", ["presetId", "fileName", "content"]],
      ["tags.list", []],
      ["tags.set", ["sessionId", "tags"]],
      ["tags.remove", ["tag"]],
      ["tags.rename", ["oldTag", "newTag"]],
      ["messages.list", ["sessionId", "limit"]],
      ["messages.truncate", ["sessionId", "seq"]],
      ["messages.edit", ["sessionId", "seq", "content"]],
      ["configfile.read", []],
      ["configfile.save", ["content"]],
      ["archived.list", []],
      ["archived.restore", ["sessionId"]],
      ["archived.delete", ["sessionId"]],
      ["trash.list", []],
      ["trash.view", ["entryDir", "limit"]],
      ["trash.restore", ["entryDir"]],
      ["trash.empty", []],
      ["trash.purge", ["entryDir"]],
      ["config.get", []],
      ["config.set", ["key", "value"]],
      ["tools.gc", []],
    ].map(([method, params]) => ({
      id: `dsh-toolbox#${method}`,
      service: "dsh-toolbox-api",
      namespace: "dsh-toolbox",
      method,
      invocation: { kind: "direct" },
      parameters: params.map((wire) => ({
        name: wire,
        wire,
        source: "json",
        codec: strictCodec(`dsh-toolbox#${method}:${wire}`),
      })),
      ...(method === "search.query" ? { cancellation: { parameter: "signal" } } : {}),
      result: strictCodec(`dsh-toolbox#${method}:result`),
    }));

    /** 设置开关定义（与后端 settings.js 一致）。 */
    const SWITCHES = [
      { key: "sessionManage", label: "会话管理", desc: "会话列表操作：删除 / 移动 / 复制 / 重设工作区根（默认：开）" },
      { key: "dialogueManage", label: "对话管理", desc: "⚠️ 需重启生效。会话内消息：截断到此 / 编辑消息（改内容并删除后续回复），操作后也需重启完整生效（默认：关）", default: false },
      { key: "workspaceManage", label: "子目录管理", desc: "工作区子目录：新增 / 重命名 / 删除 / 复制 / 移动（默认：开）" },
      { key: "presetEdit", label: "预设编辑", desc: "设置 → Agent 预设 → 自定义 agent 加「编辑」按钮（默认：开）" },

      { key: "configEditor", label: "配置编辑器", desc: "「打开配置文件」在线编辑能力，dsh 默认只读（默认：开）" },
      { key: "customSearch", label: "自研搜索", desc: "关键词搜索所有会话内容：高亮 + 跳转 + 可取消（默认：开）" },
      { key: "officialSearch", label: "官方搜索开关", desc: "⚠️ 需重启生效。启用 dsh 官方全文搜索（openAt: startup）（默认：关）", default: false },
      { key: "collapseUserMsg", label: "用户长消息折叠", desc: "你发送的消息超过「折叠行数阈值」时自动折叠显示，点击「展开全部」查看（默认：开；改后刷新页面生效）" },
      { key: "collapseAiMsg", label: "AI 长消息折叠", desc: "AI 回复超过「折叠行数阈值」时自动折叠显示（默认：关；阈值同上）", default: false },
    ];

    /** 定时心跳开关（独立分区渲染，配置项紧跟其后）。 */
    const SWITCH_HEART = { key: "scheduleTask", label: "定时心跳", desc: "定时向目标会话注入心跳消息，唤醒 AI 执行巡检/汇报等任务（类似 OpenClaw 心跳模式）。⚠️ 会消耗 token；默认：关", default: false };

    /** 设置表单组件（渲染到 设置 → 工具箱 分组）。 */
    function ToolsSettingsSection(props) {
      const [doc, setDoc] = React.useState(null);
      const tools = props.tools;

      const unwrap = (resp) => (resp && typeof resp === "object" && resp.ok === true && resp.value !== undefined ? resp.value : resp);

      const refresh = React.useCallback(() => {
        if (!tools || typeof tools["config.get"] !== "function") return;
        tools["config.get"]()
          .then((resp) => setDoc(unwrap(resp) || {}))
          .catch((e) => console.error("dsh-toolbox: config.get 失败", e));
      }, [tools]);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      // 折叠引擎设置同步：设置变化立即写入 window.__dsdCollapse（无需刷新页面）
      React.useEffect(() => {
        if (!doc) return;
        try {
          window.__dsdCollapse = window.__dsdCollapse || {};
          window.__dsdCollapse.userOn = doc.collapseUserMsg !== false;
          window.__dsdCollapse.userThreshold = Number(doc.collapseUserThreshold) > 0 ? Number(doc.collapseUserThreshold) : 15;
          window.__dsdCollapse.aiOn = doc.collapseAiMsg === true;
          // 重扫：已折叠的按新设置恢复/重新折叠
          if (typeof window.__dsdScan === "function") setTimeout(window.__dsdScan, 100);
        } catch {}
      }, [doc]);

      if (!tools || typeof tools["config.set"] !== "function") {
        return jsx("div", { style: { padding: 16, opacity: 0.6 }, children: "工具箱加载中…" });
      }

      const toggle = (key, value) => {
        console.log("dsh-toolbox: toggle", key, "→", value);
        try {
          tools["config.set"](key, value)
            .then((resp) => { console.log("dsh-toolbox: config.set 成功", key, "→", JSON.stringify(resp)); setDoc(unwrap(resp) || {}); })
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝", key, e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错", key, e);
        }
      };

      const retention = doc?.trashRetentionDays ?? 7;
      const setRetention = (value) => {
        try {
          tools["config.set"]("trashRetentionDays", Math.max(0, Math.floor(Number(value) || 0)))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(天数)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(天数)", e);
        }
      };

      const threshold = doc?.collapseUserThreshold ?? 15;
      const setThreshold = (value) => {
        try {
          tools["config.set"]("collapseUserThreshold", Math.max(0, Math.floor(Number(value) || 0)))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(阈值)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(阈值)", e);
        }
      };

      const scheduleInterval = doc?.scheduleInterval ?? 60;
      const setScheduleInterval = (value) => {
        try {
          tools["config.set"]("scheduleInterval", Math.max(5, Math.floor(Number(value) || 60)))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(心跳间隔)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(心跳间隔)", e);
        }
      };
      const schedulePrompt = doc?.schedulePrompt ?? "";
      const setSchedulePrompt = (value) => {
        try {
          tools["config.set"]("schedulePrompt", String(value || ""))
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(心跳提示语)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(心跳提示语)", e);
        }
      };
      // 定点定时（每天/每周/每月）：JSON 存取
      let cron = { type: "off", time: "09:00", day: 1, date: 1 };
      try {
        const raw = String(doc?.scheduleCron || "off").trim();
        if (raw !== "off") cron = { ...cron, ...JSON.parse(raw) };
      } catch {}
      const setCronField = (patch) => {
        const next = { ...cron, ...patch };
        const value = next.type === "off" ? "off" : JSON.stringify({ type: next.type, time: next.time, day: next.day, date: next.date });
        try {
          tools["config.set"]("scheduleCron", value)
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(定点定时)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(定点定时)", e);
        }
      };
      // 心跳目标会话：下拉选择（空 = 主工作区根）
      const [sessList, setSessList] = React.useState([]);
      React.useEffect(() => {
        if (!tools || typeof tools["sessions.list"] !== "function") return;
        tools["sessions.list"]()
          .then((resp) => setSessList(unwrap(resp) || []))
          .catch(() => {});
      }, [tools, unwrap]);
      const scheduleTarget = String(doc?.scheduleTarget || "");
      const setScheduleTarget = (value) => {
        try {
          tools["config.set"]("scheduleTarget", value)
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(心跳目标)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(心跳目标)", e);
        }
      };
      const scheduleCronTarget = String(doc?.scheduleCronTarget || "");
      const setScheduleCronTarget = (value) => {
        try {
          tools["config.set"]("scheduleCronTarget", value)
            .then((resp) => setDoc(unwrap(resp) || {}))
            .catch((e) => console.error("dsh-toolbox: config.set 拒绝(定点目标)", e));
        } catch (e) {
          console.error("dsh-toolbox: config.set 同步抛错(定点目标)", e);
        }
      };
      // 会话下拉选项（两个目标共用）：主工作区根 / 📱 IM 渠道 / 💬 其他会话
      const channelName = (id) => {
        if (String(id).startsWith("ch-weixin")) return "微信";
        if (String(id).startsWith("ch-qq")) return "QQ";
        if (String(id).startsWith("ch-feishu")) return "飞书";
        return null;
      };
      const chSessions = sessList.filter((s) => channelName(s.sessionId));
      const otherSessions = sessList.filter((s) => !channelName(s.sessionId));
      const sessOptions = [
        jsx("option", { key: "", value: "", children: "主工作区根（默认，内部巡检）" }),
        chSessions.length > 0 && jsx("optgroup", {
          key: "ch",
          label: "📱 IM 渠道（结果推送到手机）",
          children: chSessions.map((s) => jsx("option", { key: s.sessionId, value: s.sessionId, children: "📱 " + channelName(s.sessionId) })),
        }),
        otherSessions.length > 0 && jsx("optgroup", {
          key: "s",
          label: "💬 其他会话",
          children: otherSessions.map((s) => jsx("option", { key: s.sessionId, value: s.sessionId, children: (s.cwd ? String(s.cwd).replace(/[/\\]+$/, "").split(/[/\\]/).pop() + " · " : "") + s.sessionId.slice(0, 18) + "…" })),
        }),
      ].filter(Boolean);

      const row = (sw) => {
        const value = doc?.[sw.key] ?? (sw.default !== false);
        return jsx("div", {
          style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(128,128,128,0.15)" },
          children: [
            jsx("div", { style: { flex: 1, minWidth: 0, paddingRight: 16 }, children: [
              jsx("div", { style: { fontWeight: 500 }, children: sw.label }),
              jsx("div", { style: { fontSize: 12, opacity: 0.65, marginTop: 2 }, children: sw.desc }),
            ] }),
            jsx("input", {
              type: "checkbox",
              checked: !!value,
              onChange: (e) => toggle(sw.key, e.target.checked),
              style: { width: 18, height: 18, flex: "none" },
            }),
          ],
        });
      };

      const sectionTitle = (text) => jsx("div", {
        style: { fontSize: 12, fontWeight: 700, opacity: 0.85, padding: "10px 0 2px", borderTop: "1px solid rgba(128,128,128,0.28)", marginTop: 10, letterSpacing: 0.5 },
        children: text,
      });

      return jsx("div", {
        style: { padding: "0 4px" },
        children: [
          jsx("div", { style: { fontSize: 13, opacity: 0.7, marginBottom: 8 }, children: "每个功能可独立开关；带 ⚠️ 的切换后需重启生效。" }),

          // ── 分区一：定时心跳（开关 + 全部配置项） ──
          sectionTitle("⏰ 定时心跳"),
          row(SWITCH_HEART),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "心跳间隔（分钟，最小 5，默认 60）" }),
              jsx("input", {
                type: "number",
                min: 5,
                value: scheduleInterval,
                onChange: (e) => setScheduleInterval(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "心跳提示语（{time} 自动替换为当前时间）" }),
            ],
          }),
          jsx("textarea", {
            value: schedulePrompt,
            onChange: (e) => setSchedulePrompt(e.target.value),
            placeholder: "留空使用默认提示语",
            rows: 2,
            style: { width: "100%", boxSizing: "border-box", fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit", outline: "none", marginBottom: 8, resize: "vertical" },
          }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", flexWrap: "wrap" },
            children: [
              jsx("label", { style: { flex: "none" }, children: "心跳目标会话" }),
              jsx("select", {
                value: scheduleTarget,
                onChange: (e) => setScheduleTarget(e.target.value),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit", maxWidth: 260 },
                children: sessOptions,
              }),
            ],
          }),
          jsx("div", { style: { fontSize: 12, opacity: 0.6, marginBottom: 8 }, children: "间隔心跳注入到哪：主工作区 = 内部巡检；选 📱 微信/QQ/飞书 = 结果定时推送到手机；指定会话 = 只注入该会话。" }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", flexWrap: "wrap" },
            children: [
              jsx("label", { style: { flex: "none" }, children: "定点定时" }),
              jsx("select", {
                value: cron.type,
                onChange: (e) => setCronField({ type: e.target.value }),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
                children: [
                  jsx("option", { value: "off", children: "关闭" }),
                  jsx("option", { value: "daily", children: "每天" }),
                  jsx("option", { value: "weekly", children: "每周" }),
                  jsx("option", { value: "monthly", children: "每月" }),
                ],
              }),
              cron.type !== "off" && jsx("input", {
                type: "time",
                value: cron.time,
                onChange: (e) => setCronField({ time: e.target.value }),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
              }),
              cron.type === "weekly" && jsx("select", {
                value: String(cron.day),
                onChange: (e) => setCronField({ day: Number(e.target.value) }),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
                children: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((label, i) => jsx("option", { key: i, value: String(i), children: label })),
              }),
              cron.type === "monthly" && jsx("select", {
                value: String(cron.date),
                onChange: (e) => setCronField({ date: Number(e.target.value) }),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit" },
                children: Array.from({ length: 31 }, (_, i) => jsx("option", { key: i + 1, value: String(i + 1), children: i + 1 + " 号" })),
              }),
            ],
          }),
          jsx("div", { style: { fontSize: 12, opacity: 0.6 }, children: "在指定时间点额外触发一次心跳（如每天 09:00、每周一 09:00、每月 1 号 09:00）。" }),
          jsx("div", {
            style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", flexWrap: "wrap" },
            children: [
              jsx("label", { style: { flex: "none" }, children: "定点定时目标会话" }),
              jsx("select", {
                value: scheduleCronTarget,
                onChange: (e) => setScheduleCronTarget(e.target.value),
                style: { fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit", maxWidth: 260 },
                children: sessOptions,
              }),
            ],
          }),
          jsx("div", { style: { fontSize: 12, opacity: 0.6, marginBottom: 8 }, children: "定点定时注入到哪：与间隔心跳可不同（如：间隔心跳主工作区巡检 + 每天 09:00 推送微信晨报）。" }),

          // ── 分区二：功能开关（含折叠） ──
          sectionTitle("🔧 功能开关"),
          ...SWITCHES.map(row),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "折叠行数阈值（用户/AI 消息超过该行数即折叠，默认 15，0 = 不折叠）" }),
              jsx("input", {
                type: "number",
                min: 0,
                value: threshold,
                onChange: (e) => setThreshold(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),

          // ── 分区三：回收站 ──
          sectionTitle("🗑️ 回收站"),
          jsx("div", {
            style: { display: "flex", alignItems: "center", padding: "8px 0", gap: 8 },
            children: [
              jsx("label", { style: { flex: 1 }, children: "回收站保留天数（0 = 不自动清除）" }),
              jsx("input", {
                type: "number",
                min: 0,
                value: retention,
                onChange: (e) => setRetention(e.target.value),
                style: { width: 72 },
              }),
            ],
          }),
          jsx("div", { style: { fontSize: 12, opacity: 0.6, marginTop: 8 }, children: "回收站自动清除：启动时 + 每 6 小时扫描一次。" }),
        ],
      });
    }

    /** 工具箱面板：会话管理 + 回收站（子目录/搜索后续加）
     * 自绘 overlay（官方 Modal 宽度固定不可调）：桌面 760px、移动端 94vw。
     * props.list = SessionListState（root scope 注入的 useSessions 快照，含 byId/current）。
     */
    function ToolboxPanel(props) {
      const [tab, setTab] = React.useState("sessions");
      const [sessions, setSessions] = React.useState([]);
      const [trash, setTrash] = React.useState([]);
      const [subdirs, setSubdirs] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [msg, setMsg] = React.useState("");
      const [moveFor, setMoveFor] = React.useState(null);
      const [groupDelFor, setGroupDelFor] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState({});
      const [subCollapsed, setSubCollapsed] = React.useState({});
      const [tags, setTags] = React.useState({ bySession: {}, all: [] });
      const [dialogFor, setDialogFor] = React.useState(null);
      const [dialogReadonly, setDialogReadonly] = React.useState(false);
      const [dialogMsgs, setDialogMsgs] = React.useState([]);
      const [dialogBusy, setDialogBusy] = React.useState(false);

      const tools = props.tools;
      const unwrap = props.unwrap;
      const forkSession = props.forkSession;
      // 直接订阅官方 sessions store（root scope 注入的 useSessions），
      // 切会话时本组件自行重渲染，不依赖 Host 中转。
      const list = props.useSessions ? props.useSessions((s) => s) : undefined;
      const currentId = list && list.current;
      const workspaces = props.useWorkspaces ? props.useWorkspaces((s) => s) : undefined;
      const wsList = Array.isArray(workspaces) ? workspaces : (workspaces && workspaces.items) || [];
      const prevCurrent = React.useRef(currentId);
      React.useEffect(() => {
        if (prevCurrent.current !== currentId) {
          console.log("dsh-toolbox: 当前会话变化", prevCurrent.current, "→", currentId);
          prevCurrent.current = currentId;
        }
      }, [currentId]);

      const refreshSessions = React.useCallback(() => {
        tools["sessions.list"]()
          .then((resp) => setSessions(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: sessions.list 失败", e));
      }, [tools, unwrap]);

      const refreshTrash = React.useCallback(() => {
        tools["trash.list"]()
          .then((resp) => setTrash(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: trash.list 失败", e));
      }, [tools, unwrap]);

      const refreshSubdirs = React.useCallback(() => {
        tools["workspace.list"]()
          .then((resp) => setSubdirs(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: workspace.list 失败", e));
      }, [tools, unwrap]);

      const refreshTags = React.useCallback(() => {
        tools["tags.list"]()
          .then((resp) => setTags(unwrap(resp) || { bySession: {}, all: [] }))
          .catch((e) => console.error("dsh-toolbox: tags.list 失败", e));
      }, [tools, unwrap]);

      const [cfg, setCfg] = React.useState({});
      React.useEffect(() => {
        tools["config.get"]()
          .then((resp) => setCfg(unwrap(resp) || {}))
          .catch(() => {});
      }, [tools, unwrap]);
      const dialogueOn = cfg.dialogueManage === true; // 默认关：只有显式开启才显示对话按钮

      // 当前 tab 被开关隐藏时自动切回可用 tab
      React.useEffect(() => {
        const avail = ["sessions", "trash", "subdirs", "search", "presets", "config", "archived"].filter((t) => {
          if (t === "sessions") return cfg.sessionManage !== false;
          if (t === "subdirs") return cfg.workspaceManage !== false;
          if (t === "search") return cfg.customSearch !== false;
          if (t === "presets") return cfg.presetEdit !== false;
          if (t === "config") return cfg.configEditor !== false;
          return true; // trash/archived 常显
        });
        if (!avail.includes(tab)) setTab(avail[0] || "trash");
      }, [tab, cfg]);

      React.useEffect(() => {
        if (!props.open) return;
        refreshSessions();
        refreshSubdirs();
        refreshTags();
      }, [props.open, refreshSessions, refreshSubdirs, refreshTags]);

      // 回收站懒加载：切到该 Tab 才解压统计（全量解压较重，避免打开工具箱就吃内存）
      React.useEffect(() => {
        if (props.open && tab === "trash") refreshTrash();
      }, [props.open, tab, refreshTrash]);

      React.useEffect(() => {
        if (!props.open) return;
        const onKey = (e) => { if (e.key === "Escape") props.onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [props.open, props.onClose]);

      const run = async (label, fn) => {
        setBusy(true);
        setMsg("");
        try {
          const resp = await fn();
          const r = unwrap(resp);
          if (r && r.ok === false) {
            let detail = "";
            if (r.error) detail = typeof r.error === "object" ? (r.error.message || JSON.stringify(r.error)) : String(r.error);
            setMsg(label + " 失败：" + (detail || "未知错误"));
          } else setMsg(label + " ✅" + (r && r.needRestart ? "（需重启完整生效）" : ""));
          refreshSessions();
          refreshTrash();
        } catch (e) {
          setMsg(label + " 失败：" + (e && e.message ? e.message : String(e)));
        } finally {
          setBusy(false);
        }
      };

      const confirm = (text) => window.confirm(text);

      // 移动目标列表：仅注册工作区 + 未分组（文件系统子目录不是工作区，不列出）
      const moveTargets = [
        { type: "label", id: "lbl-ws", text: "工作区" },
        ...(wsList || []).map((w) => ({ id: w.path, label: w.path + (w.title && w.title !== w.path ? "（" + w.title + "）" : "") })),
        { type: "label", id: "lbl-ung", text: "未分组" },
        { id: "UNGROUPED", label: "移出工作区（未分组）" },
      ];

      // 一级分组：工作区根（dsh 本体层）；二级：标签（插件层）
      const registeredPaths = new Set((wsList || []).map((w) => w.path));
      const byRoot = {};
      for (const s of sessions) {
        const root = registeredPaths.has(s.cwd) ? s.cwd : "(未分组)";
        (byRoot[root] ||= []).push(s);
      }
      const rootGroups = Object.keys(byRoot).sort((a, b) => (a === "(未分组)" ? 1 : b === "(未分组)" ? -1 : 0));
      // 当前会话所在一级组（默认折叠：非当前组折叠，当前组展开）
      const curSession = sessions.find((x) => x.sessionId === currentId);
      const currentRoot = curSession ? (registeredPaths.has(curSession.cwd) ? curSession.cwd : "(未分组)") : null;
      const mainTag = (sid) => (tags.bySession[sid] || [])[0] || "(未标记)";
      const currentTag = curSession ? mainTag(curSession.sessionId) : null;
      const isCollapsed = (g) => (collapsed[g] === undefined ? g !== currentRoot : collapsed[g]);
      const toggleCollapsed = (g) => setCollapsed({ ...collapsed, [g]: !isCollapsed(g) });
      // 二级（标签小节）折叠：默认展开
      const isSubCollapsed = (k) => !!subCollapsed[k];
      const toggleSubCollapsed = (k) => setSubCollapsed({ ...subCollapsed, [k]: !subCollapsed[k] });

      // 打标签：打开点选式标签编辑器（已有标签点击即选，避免手输错字符）
      const [tagEditorFor, setTagEditorFor] = React.useState(null);
      const editTags = (sessionId) => setTagEditorFor(sessionId);


      // 对话管理：打开消息面板
      const openDialog = (sessionId) => {
        setDialogFor(sessionId);
        setDialogMsgs([]);
        tools["messages.list"](sessionId, 30)
          .then((resp) => { const r = unwrap(resp); setDialogMsgs((r && r.messages) || []); })
          .catch((e) => setMsg("消息读取失败：" + (e && e.message ? e.message : String(e))));
      };
      // 回收站查看：读回收站 data 目录的消息（只读）
      const openTrashView = (entryDir, title) => {
        setDialogFor("trash:" + entryDir);
        setDialogMsgs([]);
        setDialogReadonly(true);
        tools["trash.view"](entryDir, 30)
          .then((resp) => { const r = unwrap(resp); setDialogMsgs((r && r.messages) || []); })
          .catch((e) => setMsg("消息读取失败：" + (e && e.message ? e.message : String(e))));
        setMsg("回收站查看：正在加载「" + (title || entryDir) + "」…");
      };
      // 复制完整会话 ID（悬停/点击副行也可复制）
      const copyId = (id, e) => {
        if (e) e.stopPropagation();
        const done = () => setMsg("已复制会话 ID ✅（可用于 NAS 定位会话文件）");
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(id).then(done).catch(() => { fallbackCopy(id); done(); });
          } else { fallbackCopy(id); done(); }
        } catch { fallbackCopy(id); done(); }
      };
      const fallbackCopy = (text) => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        } catch {}
      };
      const dialogRun = (label, fn, after) => {
        setDialogBusy(true);
        fn()
          .then((resp) => {
            const r = unwrap(resp);
            if (r && r.ok === false) setMsg(label + " 失败：" + (r.error || ""));
            else {
              setMsg(label + " ✅ 已修改会话文件（需重启容器完整生效；重启前请勿继续使用该会话）");
              if (after) after();
            }
          })
          .catch((e) => setMsg(label + " 失败：" + (e && e.message ? e.message : String(e))))
          .finally(() => setDialogBusy(false));
      };

      // 批量删除（当前会话跳过）
      const delSessions = (list, label) => {
        const deletable = list.filter((s) => s.sessionId !== currentId);
        if (deletable.length === 0) { setMsg("没有可删除的会话（当前会话除外）"); return; }
        if (!confirm("删除" + label + "下 " + deletable.length + " 个会话？全部移入回收站，左侧立即隐藏")) return;
        setBusy(true);
        setMsg("");
        let done = 0, failed = 0;
        Promise.all(deletable.map((s) =>
          tools["sessions.delete"](s.sessionId)
            .then((resp) => { const rr = unwrap(resp); if (rr && rr.ok === false) failed += 1; else done += 1; })
            .catch(() => { failed += 1; })
        ))
          .then(() => { setMsg("删除完成：" + done + " 个已删除" + (failed ? "，" + failed + " 个失败" : "")); refreshSessions(); })
          .finally(() => setBusy(false));
      };

      const sessionRow = (sess) => {
        const sum = list && list.byId ? list.byId[sess.sessionId] : undefined;
        const title = emptySessionLabel(sess) || (sum && sum.displayTitle) || "(无标题)";
        const isCurrent = sess.sessionId === currentId;
        const short = sess.sessionId.length > 40 ? sess.sessionId.slice(0, 37) + "…" : sess.sessionId;
        return jsx("div", {
          key: sess.sessionId,
          style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px 6px 24px", borderBottom: "1px solid rgba(128,128,128,0.12)", flexWrap: "wrap", background: isCurrent ? "rgba(47,125,50,0.14)" : "transparent", borderRadius: 4 },
          children: [
            jsx("div", { style: { flex: 1, minWidth: 160, overflow: "hidden" }, children: [
              jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 }, children: [
                isCurrent ? jsx("span", { style: { flex: "none", fontSize: 11, fontWeight: 600, color: "#fff", background: "#2f7d32", borderRadius: 4, padding: "1px 5px" }, children: "当前" }) : null,
                (tags.bySession[sess.sessionId] || []).map((tg) => jsx("span", { key: tg, style: { flex: "none", fontSize: 10, background: "rgba(80,120,255,0.25)", color: "#9db8ff", borderRadius: 4, padding: "1px 5px" }, children: tg })),
                jsx("span", { style: { fontSize: 13, fontWeight: isCurrent ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title }, children: title }),
              ] }),
              jsx("div", {
                style: { fontSize: 11, opacity: 0.55, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "copy", textDecoration: "underline dotted rgba(128,128,128,0.4)", title: sess.sessionId + "（点击复制完整 ID）" },
                onClick: (e) => copyId(sess.sessionId, e),
                children: "📋 " + short + (sess.cwd ? " · " + sess.cwd : "") + (fmtStats(sess) ? " · " + fmtStats(sess) : ""),
              }),
            ] }),
            jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => { setDialogReadonly(true); openDialog(sess.sessionId); },
              title: "查看会话内容（只读）",
              children: "👁 查看",
            }),
            dialogueOn && jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => { setDialogReadonly(false); openDialog(sess.sessionId); },
              title: isCurrent ? "当前会话可查看，截断/编辑需重启后操作" : undefined,
              children: "💬 对话",
            }),
            jsx(P.Button, { size: "sm", disabled: busy, onClick: () => editTags(sess.sessionId), children: "🏷 标签" }),
            jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => {
                if (!confirm("分叉复制会话「" + title + "」？")) return;
                setBusy(true); setMsg("");
                Promise.resolve(props.forkSession(sess.sessionId))
                  .then((newId) => { setMsg("复制 ✅ 新会话：" + (newId || "")); refreshSessions(); })
                  .catch((e) => {
                const m = e && e.message ? e.message : String(e);
                setMsg(m.includes("fork-unavailable") || m.includes("no completed turn") ? "复制 失败：该会话没有已完成的对话（空会话），无法分叉" : "复制 失败：" + m);
              })
                  .finally(() => setBusy(false));
              },
              children: "复制",
            }),
            jsx(P.Button, {
              size: "sm", disabled: busy || isCurrent, title: isCurrent ? "当前会话不可删除" : undefined,
              onClick: () => confirm("删除会话「" + title + "」？文件将移入回收站（可恢复），左侧立即隐藏") && run("删除", () => tools["sessions.delete"](sess.sessionId)),
              children: "删除",
            }),
            jsx(P.Menu, {
              portal: true,
              open: moveFor === sess.sessionId,
              anchor: jsx(P.Button, {
                size: "sm", disabled: busy || isCurrent || moveFor !== null, title: isCurrent ? "当前会话不可移动" : undefined,
                onClick: () => setMoveFor(moveFor === sess.sessionId ? null : sess.sessionId),
                children: "移动▾",
              }),
              items: moveTargets,
              onSelect: (id) => {
                setMoveFor(null);
                if (id === "UNGROUPED") { run("移出工作区", () => tools["sessions.detach"](sess.sessionId)).then(refreshSessions); return; }
                run("移动", () => tools["sessions.move"](id, sess.sessionId)).then(refreshSessions);
              },
              onClose: () => setMoveFor(null),
            }),
            jsx(P.Button, {
              size: "sm", disabled: busy || isCurrent, title: isCurrent ? "当前会话不可重设" : undefined,
              onClick: () => confirm("重设「" + title + "」的工作区根为当前根？") && run("重设", () => tools["sessions.resetCwd"](sess.sessionId)),
              children: "重设",
            }),
          ],
        });
      };

      const trashRow = (item) => {
        const name = emptySessionLabel(item) || item.title || item.name;
        return jsx("div", {
          key: item.entryDir,
          style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", borderBottom: "1px solid rgba(128,128,128,0.12)", flexWrap: "wrap" },
          children: [
            jsx("div", { style: { flex: 1, minWidth: 160, overflow: "hidden" }, children: [
              jsx("div", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title: name }, children: (item.type === "session" ? "[会话] " : "[目录] ") + name }),
              jsx("div", {
                style: { fontSize: 11, opacity: 0.55, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: item.type === "session" ? "copy" : undefined, textDecoration: item.type === "session" ? "underline dotted rgba(128,128,128,0.4)" : undefined, title: item.type === "session" ? (item.name || "") + "（点击复制完整 ID）" : undefined },
                onClick: item.type === "session" ? (e) => copyId(item.name || "", e) : undefined,
                children: (item.type === "session" ? "📋 " : "") + new Date(item.deletedAt).toLocaleString() + (fmtStats(item) ? " · " + fmtStats(item) : ""),
              }),
            ] }),
            item.type === "session" && jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => openTrashView(item.entryDir, item.title || item.name),
              title: "查看被删会话内容（只读）",
              children: "👁 查看",
            }),
            jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => run("恢复", () => tools["trash.restore"](item.entryDir)).then(() => {
                setMsg("恢复成功，正在刷新列表…");
                setTimeout(() => window.location.reload(), 900);
              }),
              children: "恢复",
            }),
            jsx(P.Button, {
              size: "sm", disabled: busy,
              onClick: () => confirm("彻底删除回收站中的「" + name + "」？不可恢复！") && run("彻底删除", () => tools["trash.purge"](item.entryDir)),
              children: "彻底删除",
            }),
          ],
        });
      };

      const tabBtn = (id, label, icon) => jsx(P.Button, {
        size: "sm",
        variant: tab === id ? "primary" : "outline",
        onClick: () => setTab(id),
        style: { marginRight: 6, marginBottom: 4, fontWeight: tab === id ? 700 : 400 },
        children: icon + " " + label,
      });

      if (!props.open) return null;
      const overlayStyle = {
        position: "fixed", inset: 0, zIndex: 1000, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", padding: 12,
      };
      const cardStyle = {
        background: "var(--dsw-specific-surface-float, #202024)",
        color: "var(--dsw-alias-label-primary, #eee)",
        borderRadius: 12, padding: "14px 16px 16px", boxSizing: "border-box",
        width: "min(760px, 94vw)", maxWidth: "94vw", maxHeight: "80vh", overflowY: "auto",
        boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
      };
      return jsx("div", {
        style: overlayStyle,
        onClick: (e) => {
          if (window.__dsdDrag) { e.stopPropagation(); return; }
          props.onClose();
        },
        children: [
        jsx("div", {
        style: cardStyle,
        onClick: (e) => { e.stopPropagation(); if (window.__dsdDrag) window.__dsdDrag = false; },
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }, children: [
            jsx("div", { style: { fontSize: 15, fontWeight: 600 }, children: "🧰 工具箱" }),
            jsx("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
              jsx(P.Button, {
                size: "sm", variant: "outline", disabled: busy,
                onClick: () => {
                  setBusy(true); setMsg("");
                  tools["tools.gc"]()
                    .then((resp) => {
                      const r = unwrap(resp);
                      setMsg(r && r.ok === false ? "释放失败：" + (r.error || "") : (r && r.note) || "已执行");
                      if (r && r.gcRan) setMsg((r.note || "已触发 GC") + "——建议刷新页面释放前端内存");
                    })
                    .catch((e) => setMsg("释放失败：" + (e && e.message ? e.message : String(e))))
                    .finally(() => setBusy(false));
                },
                title: "清空插件缓存并尝试触发 GC（彻底释放需重启容器）",
                children: "🧹 释放内存",
              }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: props.onClose, children: "✕" }),
            ] }),
          ] }),
          jsx("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", marginBottom: 8 }, children: [
            cfg.sessionManage !== false && tabBtn("sessions", "会话", "💬"),
            tabBtn("trash", "回收站", "🗑️"),
            cfg.workspaceManage !== false && tabBtn("subdirs", "子目录", "📁"),
            cfg.customSearch !== false && tabBtn("search", "搜索", "🔍"),
            cfg.presetEdit !== false && tabBtn("presets", "预设", "⚙️"),
            cfg.configEditor !== false && tabBtn("config", "配置", "📄"),
            tabBtn("archived", "归档", "🗄"),
          ] }),
          msg ? jsx("div", { style: { fontSize: 12, marginBottom: 6, opacity: 0.85 }, children: msg }) : null,
          tab === "sessions" && jsx("div", {
            children: sessions.length === 0
              ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "没有会话" })
              : rootGroups.map((root) => {
                  // 组内二级：按标签分小节
                  const byTagIn = {};
                  for (const s of byRoot[root]) (byTagIn[mainTag(s.sessionId)] ||= []).push(s);
                  return jsx("div", {
                    key: root,
                    children: [
                      jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "8px 4px 2px" }, children: [
                        jsx("div", {
                          style: {
                            flex: 1, fontSize: 12,
                            fontWeight: root === currentRoot ? 700 : 500,
                            opacity: root === currentRoot ? 1 : 0.6,
                            color: root === "(未分组)" ? "#e8a33d" : "#4caf50", // 正式工作区绿、未分组橙（通用，不写死具体路径）
                            cursor: "pointer", userSelect: "none",
                          },
                          onClick: () => toggleCollapsed(root),
                          children: (isCollapsed(root) ? "▸ " : "▾ ") + (root === "(未分组)" ? "🗂 未分组" : "📁 " + String(root).replace(/[/\\]+$/, "").split(/[/\\]/).pop()) + "（" + byRoot[root].length + "）" + (root === currentRoot ? " ◀" : ""),
                        }),
                        jsx(P.Button, {
                          size: "sm", variant: "outline", disabled: busy,
                          onClick: () => delSessions(byRoot[root], root === "(未分组)" ? "未分组" : "「" + root + "」"),
                          children: "删除分组",
                        }),
                      ] }),
                      isCollapsed(root) ? null : Object.keys(byTagIn).map((tag) => jsx("div", {
                        key: root + ":" + tag,
                        children: [
                          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px 0 16px" }, children: [
                            jsx("div", {
                              style: {
                                flex: 1, fontSize: 11,
                                fontWeight: tag === currentTag && root === currentRoot ? 700 : 500,
                                opacity: tag === currentTag && root === currentRoot ? 1 : 0.65,
                                color: tag === "(未标记)" ? undefined : "#9db8ff",
                                cursor: "pointer", userSelect: "none",
                              },
                              onClick: () => toggleSubCollapsed(root + ":" + tag),
                              children: (isSubCollapsed(root + ":" + tag) ? "▸ " : "▾ ") + (tag === "(未标记)" ? "🗂 未标记" : "🏷 " + tag) + "（" + byTagIn[tag].length + "）" + (tag === currentTag && root === currentRoot ? " ◀" : ""),
                            }),
                            tag !== "(未标记)" && jsx(P.Button, {
                              size: "sm", variant: "outline", disabled: busy,
                              onClick: () => {
                                if (!confirm("删除标签「" + tag + "」？该标签将从所有会话移除（会话本身不动）")) return;
                                run("删除标签", () => tools["tags.remove"](tag)).then(refreshTags);
                              },
                              children: "删标签",
                            }),
                          ] }),
                          isSubCollapsed(root + ":" + tag) ? null : byTagIn[tag].map(sessionRow),
                        ],
                      })),
                    ],
                  });
                }),
          }),
          tab === "trash" && jsx("div", {
            children: [
              jsx("div", { style: { marginBottom: 6 }, children: jsx(P.Button, { size: "sm", disabled: busy || trash.length === 0, onClick: () => confirm("清空回收站？不可恢复！") && run("清空", () => tools["trash.empty"]()), children: "清空回收站" }) }),
              trash.length === 0
                ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "回收站是空的" })
                : trash.map(trashRow),
            ],
          }),
          (tab === "subdirs") && jsx(SubdirsTab, { tools, unwrap, run, confirm, subdirs, refreshSubdirs, sessions, currentId, refreshSessions, wsList }),
          (tab === "search") && jsx(SearchTab, { tools, unwrap, list, openSession: props.openSession }),
          (tab === "presets") && jsx(PresetsTab, { tools, unwrap, run }),
          (tab === "config") && jsx(ConfigTab, { tools, unwrap }),
          (tab === "archived") && jsx(ArchivedTab, { tools, unwrap, run, confirm, currentId, openView: (id) => { setDialogReadonly(true); openDialog(id); }, onCopy: copyId }),
        ],
      }),
        dialogFor && jsx(DialogOverlay, {
          msgs: dialogMsgs,
          busy: dialogBusy,
          readonly: dialogReadonly,
          isCurrent: dialogFor === currentId,
          summary: dialogFor
            ? dialogFor.startsWith("trash:")
              ? "回收站：" + (trash.find((t) => dialogFor === "trash:" + t.entryDir)?.title || "")
              : (list && list.byId && list.byId[dialogFor] ? list.byId[dialogFor].displayTitle : dialogFor)
            : "",
          id: dialogFor
            ? dialogFor.startsWith("trash:")
              ? (trash.find((t) => dialogFor === "trash:" + t.entryDir)?.name || "")
              : dialogFor
            : "",
          onCopy: copyId,
          onClose: () => setDialogFor(null),
          onJump: dialogFor && dialogFor.startsWith("trash:")
            ? null
            : () => { setDialogFor(null); props.onClose(); openSession(dialogFor); },
          onTruncate: (m) => {
            const sum = list && list.byId ? list.byId[dialogFor] : undefined;
            if (sum && sum.running) { alert("该会话正在运行（AI 回复中），请等待完成后操作"); return; }
            if (!confirm("截断到此？将删除「" + m.content.slice(0, 30) + "…」及之后所有消息。")) return;
            dialogRun("截断", () => tools["messages.truncate"](dialogFor, m.seq), () => openDialog(dialogFor));
          },
          onEdit: (m) => {
            const sum = list && list.byId ? list.byId[dialogFor] : undefined;
            if (sum && sum.running) { alert("该会话正在运行（AI 回复中），请等待完成后操作"); return; }
            const next = window.prompt("新内容（保存后删除后续回复）：", m.content);
            if (next === null || !next.trim()) return;
            dialogRun("编辑", () => tools["messages.edit"](dialogFor, m.seq, next), () => openDialog(dialogFor));
          },
        }),
        tagEditorFor && jsx(TagEditor, {
          title: list && list.byId && list.byId[tagEditorFor] ? list.byId[tagEditorFor].displayTitle : tagEditorFor,
          current: tags.bySession[tagEditorFor] || [],
          all: tags.all || [],
          bySession: tags.bySession || {},
          busy,
          run,
          onTagsChanged: refreshTags,
          onClose: () => setTagEditorFor(null),
          onSave: (next) => {
            run("标签", () => tools["tags.set"](tagEditorFor, next)).then(refreshTags);
            setTagEditorFor(null);
          },
        }),
      ] });
    }

    /** 通用代码编辑器：自动换行（默认勾选）+ 全屏（Esc/再点退出）+ 保存 */
    function CodeEditor(props) {
      const { title, initial, onSave, onClose } = props;
      const [value, setValue] = React.useState(initial);
      // initial 变化时重置内容（防止连续打开不同文件时显示旧内容）
      React.useEffect(() => {
        setValue(initial);
      }, [initial]);
      const [wrap, setWrap] = React.useState(true);
      const [full, setFull] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [err, setErr] = React.useState("");
      const [height, setHeight] = React.useState(320);
      const heightRef = React.useRef(320);
      const setH = (v) => { heightRef.current = v; setHeight(v); };

      // 自绘拖条：document 级事件 + 高度硬限制（200px ~ 70vh），横向不可调
      const startDrag = (e) => {
        e.preventDefault();
        window.__dsdDrag = true; // 拖拽标志：拖后 100ms 内的 click 视为拖拽残留
        const getY = (ev) => (ev.touches && ev.touches.length > 0 ? ev.touches[0].clientY : ev.clientY);
        const startY = getY(e);
        const startH = heightRef.current;
        const onMove = (ev) => {
          ev.preventDefault();
          const next = Math.min(Math.max(startH + (getY(ev) - startY), 200), Math.floor(window.innerHeight * 0.7));
          setH(next);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.removeEventListener("touchmove", onMove);
          document.removeEventListener("touchend", onUp);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          setTimeout(() => { window.__dsdDrag = false; }, 120);
        };
        document.body.style.cursor = "ns-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("touchend", onUp);
      };

      React.useEffect(() => {
        if (!full) return;
        const onKey = (e) => { if (e.key === "Escape") setFull(false); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [full]);

      const save = async () => {
        setSaving(true);
        setErr("");
        try {
          await onSave(value);
          onClose();
        } catch (e) {
          setErr(e && e.message ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      };

      const editorStyle = {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 13, lineHeight: 1.6,
        whiteSpace: wrap ? "pre-wrap" : "pre",
        wordBreak: wrap ? "break-word" : "normal",
        overflowX: wrap ? "hidden" : "auto",
        overflowY: "auto",
        width: "100%", height: full ? "auto" : height + "px", flex: full ? 1 : "none",
        resize: "none", // 禁用原生拖拽，用自绘拖条
        boxSizing: "border-box", padding: 10, borderRadius: 8,
        border: "1px solid rgba(128,128,128,0.35)",
        background: "rgba(0,0,0,0.25)", color: "inherit", outline: "none",
      };
      const overlayStyle = full ? {
        position: "fixed", inset: 0, zIndex: 2000, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.72)", padding: 12,
      } : null;
      const cardStyle = full
        ? { width: "min(1100px, 96vw)", height: "min(92vh, 1000px)", display: "flex", flexDirection: "column", background: "var(--dsw-specific-surface-float, #1c1c20)", color: "var(--dsw-alias-label-primary, #eee)", borderRadius: 12, padding: 14, boxSizing: "border-box", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }
        : { width: "100%", background: "var(--dsw-specific-surface-float, #1c1c20)", color: "var(--dsw-alias-label-primary, #eee)", borderRadius: 12, padding: 14, boxSizing: "border-box", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" };

      return jsx("div", { style: overlayStyle, onClick: full ? (e) => { if (window.__dsdDrag) { e.stopPropagation(); return; } if (e.target === e.currentTarget) setFull(false); } : undefined, children: jsx("div", {
        style: cardStyle,
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }, children: [
            jsx("div", { style: { flex: 1, fontSize: 14, fontWeight: 600, minWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title }, children: title }),
            jsx("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }, children: [
              jsx("input", { type: "checkbox", checked: wrap, onChange: (e) => setWrap(e.target.checked) }),
              "自动换行",
            ] }),
            jsx(P.Button, { size: "sm", variant: "outline", onClick: () => setFull(!full), children: full ? "退出全屏" : "全屏" }),
            jsx(P.Button, { size: "sm", variant: "outline", disabled: saving, onClick: onClose, children: "取消" }),
            jsx(P.Button, { size: "sm", variant: "primary", disabled: saving, onClick: save, children: saving ? "保存中…" : "保存" }),
          ] }),
          err ? jsx("div", { style: { fontSize: 12, color: "#f27474", marginBottom: 6 }, children: err }) : null,
          jsx("textarea", {
            value: value,
            onChange: (e) => setValue(e.target.value),
            spellCheck: false,
            style: editorStyle,
          }),
          !full && jsx("div", {
            onMouseDown: startDrag,
            style: { height: 6, cursor: "ns-resize", background: "rgba(128,128,128,0.28)", borderRadius: 3, marginTop: 6, flex: "none", touchAction: "none" },
            title: "拖动调节高度（200px ~ 视口 70%）",
          }),
        ],
      }) });
    }

    /** 预设编辑 Tab */
    function PresetsTab(props) {
      const { tools, unwrap, run } = props;
      const [presets, setPresets] = React.useState([]);
      const [editing, setEditing] = React.useState(null); // {presetId, fileName, content, title}
      const [loading, setLoading] = React.useState(false);

      const refresh = React.useCallback(() => {
        setLoading(true);
        tools["presets.list"]()
          .then((resp) => setPresets(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: presets.list 失败", e))
          .finally(() => setLoading(false));
      }, [tools, unwrap]);

      React.useEffect(() => { refresh(); }, [refresh]);

      const openFile = (presetId, fileName) => {
        tools["presets.read"](presetId, fileName)
          .then((resp) => {
            const r = unwrap(resp);
            if (r && r.ok === false) { alert("读取失败：" + (r.error || "")); return; }
            setEditing({ presetId, fileName, content: r.content, title: presetId + " / " + fileName });
          })
          .catch((e) => alert("读取失败：" + (e.message || e)));
      };

      const saveFile = (content) => {
        return tools["presets.save"](editing.presetId, editing.fileName, content).then((resp) => {
          const r = unwrap(resp);
          if (r && r.ok === false) throw new Error(r.error || "保存失败");
          return r;
        });
      };

      const row = (p) => jsx("div", {
        key: p.id,
        style: { padding: "8px 4px", borderBottom: "1px solid rgba(128,128,128,0.12)" },
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }, children: [
            jsx("div", { style: { flex: 1, minWidth: 140 }, children: [
              jsx("div", { style: { fontSize: 13, fontWeight: 600 }, children: p.name || p.id }),
              jsx("div", { style: { fontSize: 11, opacity: 0.6 }, children: p.id }),
            ] }),
            p.files.map((f) => jsx(P.Button, {
              key: f.name, size: "sm", variant: "outline",
              onClick: () => openFile(p.id, f.name),
              children: "编辑 " + f.name,
            })),
          ] }),
          p.description ? jsx("div", { style: { fontSize: 12, opacity: 0.7, marginTop: 4 }, children: p.description }) : null,
        ],
      });

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }, children: [
            jsx("div", { style: { flex: 1, fontSize: 12, opacity: 0.7 }, children: "编辑 Agent 预设文件（~/.agent-presets），保存即时生效，新会话生效" }),
            jsx(P.Button, { size: "sm", onClick: refresh, children: "刷新" }),
          ] }),
          loading && presets.length === 0
            ? jsx("div", { style: { opacity: 0.6, padding: 12 }, children: "加载中…" })
            : presets.length === 0
              ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "没有自定义预设" })
              : presets.map(row),
          editing ? jsx(CodeEditor, {
            key: editing.presetId + ":" + editing.fileName,
            title: editing.title,
            initial: editing.content,
            onSave: saveFile,
            onClose: () => setEditing(null),
          }) : null,
        ],
      });
    }

    /** 对话管理面板：消息列表 + 截断/编辑（安全模型：只删尾或改尾） */
    function DialogOverlay(props) {
      const { msgs, busy, isCurrent, onClose, onTruncate, onEdit, summary, readonly, onJump, id, onCopy } = props;
      const [expanded, setExpanded] = React.useState({});
      const [copied, setCopied] = React.useState(false);
      const roleLabel = (r) => r === "user" ? "我" : "AI";
      const roleColor = (r) => r === "user" ? "#4caf50" : "#4a8fd6";
      const fmtTime = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
      const doCopy = () => {
        if (!onCopy || !id) return;
        onCopy(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      };

      return jsx("div", {
        style: { position: "fixed", inset: 0, zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)", padding: 12 },
        onClick: (e) => { if (window.__dsdDrag) { e.stopPropagation(); return; } onClose(); },
        children: jsx("div", {
          style: { width: "min(680px, 94vw)", maxHeight: "78vh", display: "flex", flexDirection: "column", background: "var(--dsw-specific-surface-float, #1c1c20)", color: "var(--dsw-alias-label-primary, #eee)", borderRadius: 12, padding: 14, boxSizing: "border-box", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" },
          onClick: (e) => e.stopPropagation(),
          children: [
            jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }, children: [
              jsx("div", { style: { flex: 1, fontSize: 14, fontWeight: 600 }, children: (readonly ? "👁 会话内容：" : "💬 对话管理：") + (summary || "") }),
              onJump && jsx(P.Button, {
                size: "sm", variant: "outline",
                onClick: onJump,
                title: "关闭工具箱并打开此会话（不挡页面）",
                children: "跳转到此会话",
              }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: onClose, children: "关闭" }),
            ] }),
            id ? jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap", fontSize: 10, opacity: 0.6 }, children: [
              jsx("span", { style: { wordBreak: "break-all", flex: 1, minWidth: 0, fontFamily: "ui-monospace, Menlo, monospace" }, children: "ID: " + id }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: doCopy, title: "复制完整会话 ID（NAS 定位会话文件用）", children: copied ? "已复制 ✓" : "📋 复制 ID" }),
            ] }) : null,
            jsx("div", { style: { fontSize: 11, opacity: 0.65, marginBottom: 8 }, children: readonly
              ? "只读查看会话内容（最近 30 条消息）。"
              : "截断 = 删除本条及之后所有消息；编辑 = 改本条内容并删除后续回复。" + (isCurrent ? " ⚠️ 当前会话：操作后必须重启才生效，重启前请勿继续在此会话对话（否则事件序号错乱会损坏会话）。" : " 修改后需重启完整生效。") }),
            jsx("div", { style: { flex: 1, overflowY: "auto", border: "1px solid rgba(128,128,128,0.15)", borderRadius: 8, padding: 8 }, children: [
              msgs.length === 0
                ? jsx("div", { style: { opacity: 0.5, padding: 12, fontSize: 13 }, children: "没有消息" })
                : msgs.map((m) => {
                    const isExp = !!expanded[m.seq];
                    const preview = m.content.length > 200 && !isExp ? m.content.slice(0, 200) + "…" : m.content;
                    return jsx("div", {
                      key: m.seq,
                      style: { padding: "6px 4px", borderBottom: "1px solid rgba(128,128,128,0.1)" },
                      children: [
                        jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }, children: [
                          jsx("span", { style: { flex: "none", fontSize: 11, fontWeight: 600, color: roleColor(m.role), borderRadius: 4, padding: "1px 6px", background: roleColor(m.role) + "22" }, children: roleLabel(m.role) }),
                          jsx("span", { style: { fontSize: 11, opacity: 0.5 }, children: fmtTime(m.time) + " · seq " + m.seq }),
                          jsx("div", { style: { flex: 1 } }),
                          !readonly && jsx(P.Button, {
                            size: "sm", disabled: busy,
                            onClick: () => onTruncate(m),
                            children: "截断到此",
                          }),
                          !readonly && jsx(P.Button, {
                            size: "sm", disabled: busy,
                            onClick: () => onEdit(m),
                            children: "编辑",
                          }),
                        ] }),
                        jsx("div", {
                          style: { fontSize: 12, lineHeight: 1.5, cursor: m.content.length > 200 ? "pointer" : undefined, whiteSpace: "pre-wrap", wordBreak: "break-word" },
                          onClick: () => m.content.length > 200 && setExpanded({ ...expanded, [m.seq]: !isExp }),
                          children: preview,
                        }),
                      ],
                    });
                  }),
            ] }),
          ],
        }),
      });
    }

    /** 配置文件在线编辑 Tab（插件化，替代 dsh-patches） */
    function ConfigTab(props) {
      const { tools, unwrap } = props;
      const [path, setPath] = React.useState("");
      const [content, setContent] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [err, setErr] = React.useState("");
      const [savedMsg, setSavedMsg] = React.useState("");

      const load = () => {
        setLoading(true);
        setErr("");
        tools["configfile.read"]()
          .then((resp) => {
            const r = unwrap(resp);
            if (r && r.ok === false) { setErr(r.error || "读取失败"); setContent(null); return; }
            setPath(r.path || "");
            setContent(r.content || "");
          })
          .catch((e) => setErr("读取失败：" + (e && e.message ? e.message : String(e))))
          .finally(() => setLoading(false));
      };
      React.useEffect(() => { load(); }, []);

      const save = (text) => {
        setSavedMsg("");
        return tools["configfile.save"](text).then((resp) => {
          const r = unwrap(resp);
          if (r && r.ok === false) throw new Error(r.error || "保存失败");
          setSavedMsg("已保存到 " + (r.path || path) + "（需重启容器生效）");
          return r;
        });
      };

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }, children: [
            jsx("div", { style: { flex: 1, fontSize: 12, opacity: 0.7 }, children: "dsh 配置文件在线编辑（YAML 校验 + 原子写，保存后需重启生效）" }),
            jsx(P.Button, { size: "sm", onClick: load, children: "重新加载" }),
          ] }),
          path ? jsx("div", { style: { fontSize: 11, opacity: 0.6, marginBottom: 6 }, children: "文件：" + path }) : null,
          err ? jsx("div", { style: { fontSize: 12, color: "#f27474", marginBottom: 6 }, children: err }) : null,
          savedMsg ? jsx("div", { style: { fontSize: 12, color: "#4caf50", marginBottom: 6 }, children: savedMsg }) : null,
          loading && content === null
            ? jsx("div", { style: { opacity: 0.6, padding: 12 }, children: "加载中…" })
            : content !== null
              ? jsx(CodeEditor, {
                  key: "config:" + path,
                  title: "配置文件：" + (path || "settings"),
                  initial: content,
                  onSave: save,
                  onClose: () => {},
                })
              : null,
        ],
      });
    }

    /** 格式化会话大小：B → KB → MB（保留 1 位小数）。 */
    function fmtSize(bytes) {
      if (!bytes || bytes <= 0) return "0 B";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    /** 格式化会话统计副行：大小 · 轮数。 */
    function fmtStats(it) {
      const parts = [];
      if (it && typeof it.size === "number") parts.push(fmtSize(it.size));
      if (it && typeof it.turns === "number") parts.push(it.turns + " 轮");
      return parts.join(" · ");
    }

    /**
     * 空会话标签：turns 为 0 时返回「（空会话）工作区名」（工作区名 = cwd 的 basename，
     * 与官方 displayTitle fallback 一致），否则返回 null。
     */
    function emptySessionLabel(it) {
      if (!it || typeof it.turns !== "number" || it.turns !== 0) return null;
      const base = String(it.cwd || "").replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "";
      return "（空会话）" + (base && base !== "?" ? base : "未命名");
    }

    /** 标签编辑器：点选已有标签（避免手输错字符产生分裂标签）+ 输入新标签 + 管理（删除/重命名） */
    function TagEditor(props) {
      const { title, current, all, bySession, onSave, onClose, busy, onTagsChanged, run } = props;
      const [selected, setSelected] = React.useState([...(current || [])]);
      const [input, setInput] = React.useState("");
      const [manage, setManage] = React.useState(false);
      const toggle = (tag) => {
        setSelected((s) => (s.includes(tag) ? s.filter((t) => t !== tag) : [...s, tag]));
      };
      const addNew = () => {
        const tags = input.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
        if (tags.length === 0) return;
        setSelected((s) => [...new Set([...s, ...tags])]);
        setInput("");
      };
      const available = (all || []).filter((t) => !selected.includes(t));
      // 标签使用数统计
      const usage = {};
      for (const ts of Object.values(bySession || {})) {
        for (const t of ts || []) usage[t] = (usage[t] || 0) + 1;
      }
      const renameTag = (oldTag) => {
        const next = window.prompt("重命名标签「" + oldTag + "」为（留空取消；与已有标签同名 = 合并）：", oldTag);
        if (next === null) return;
        const target = next.trim();
        if (!target || target === oldTag) return;
        run("重命名标签", () => tools["tags.rename"](oldTag, target))
          .then(() => {
            setSelected((s) => (s.includes(oldTag) ? [...new Set([...s.filter((t) => t !== oldTag), target])] : s));
            onTagsChanged && onTagsChanged();
          });
      };
      const deleteTag = (tag) => {
        if (!window.confirm("删除标签「" + tag + "」？将从所有会话移除（会话本身不动）")) return;
        run("删除标签", () => tools["tags.remove"](tag))
          .then(() => {
            setSelected((s) => s.filter((t) => t !== tag));
            onTagsChanged && onTagsChanged();
          });
      };
      const chip = (text, onClick, prefix) => jsx("span", {
        key: text,
        onClick,
        title: "点击" + (prefix === "✕ " ? "移除" : "添加"),
        style: {
          display: "inline-flex", alignItems: "center", gap: 3,
          fontSize: 12, cursor: "pointer", userSelect: "none",
          background: prefix === "✕ " ? "rgba(47,125,50,0.22)" : "rgba(80,120,255,0.18)",
          color: prefix === "✕ " ? "#7ecb83" : "#9db8ff",
          borderRadius: 10, padding: "2px 8px",
        },
        children: prefix + text,
      });
      return jsx("div", {
        style: { position: "fixed", inset: 0, zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)", padding: 12 },
        onClick: onClose,
        children: jsx("div", {
          style: { width: "min(520px, 94vw)", maxHeight: "78vh", display: "flex", flexDirection: "column", background: "var(--dsw-specific-surface-float, #1c1c20)", color: "var(--dsw-alias-label-primary, #eee)", borderRadius: 12, padding: 14, boxSizing: "border-box", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" },
          onClick: (e) => e.stopPropagation(),
          children: [
            jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }, children: [
              jsx("div", { style: { flex: 1, fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: manage ? "🗑 管理标签" : "🏷 设置标签：" + (title || "") }),
              jsx(P.Button, { size: "sm", variant: "outline", onClick: onClose, children: "✕" }),
            ] }),
            manage ? jsx("div", { style: { flex: 1, overflowY: "auto", marginBottom: 10 }, children: [
              jsx("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 6 }, children: "全部标签（含使用数），可重命名/删除：" }),
              Object.keys(usage).length === 0
                ? jsx("div", { style: { fontSize: 12, opacity: 0.5, padding: 8 }, children: "（还没有任何标签）" })
                : Object.keys(usage).sort((a, b) => usage[b] - usage[a]).map((t) => jsx("div", {
                    key: t,
                    style: { display: "flex", alignItems: "center", gap: 6, padding: "5px 4px", borderBottom: "1px solid rgba(128,128,128,0.1)" },
                    children: [
                      jsx("span", { style: { flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: t + "（" + usage[t] + " 个会话）" }),
                      jsx(P.Button, { size: "sm", disabled: busy, onClick: () => renameTag(t), children: "重命名" }),
                      jsx(P.Button, { size: "sm", disabled: busy, onClick: () => deleteTag(t), children: "删除" }),
                    ],
                  })),
            ] }) : jsx("div", { children: [
              jsx("div", { style: { display: "flex", gap: 6, marginBottom: 12 }, children: [
                jsx("input", {
                  value: input,
                  onChange: (e) => setInput(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") addNew(); },
                  placeholder: "输入新标签（多个用逗号分隔）",
                  style: { flex: 1, minWidth: 0, fontSize: 13, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "rgba(0,0,0,0.25)", color: "inherit", outline: "none" },
                }),
                jsx(P.Button, { size: "sm", onClick: addNew, children: "添加" }),
              ] }),
              jsx("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 6 }, children: "已选（点击移除）：" }),
              jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }, children: selected.length === 0 ? jsx("span", { style: { fontSize: 12, opacity: 0.5 }, children: "（无）" }) : selected.map((t) => chip(t, () => toggle(t), "✕ ")) }),
              jsx("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 6 }, children: "已有标签（点击添加，无需手输）：" }),
              jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }, children: available.length === 0 ? jsx("span", { style: { fontSize: 12, opacity: 0.5 }, children: "（没有其他标签）" }) : available.map((t) => chip(t, () => toggle(t), "+ ")) }),
            ] }),
            jsx("div", { style: { display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center" }, children: [
              jsx(P.Button, { size: "sm", variant: "outline", onClick: () => setManage(!manage), children: manage ? "← 返回选择" : "🗑 管理标签" }),
              jsx("div", { style: { display: "flex", gap: 6 }, children: [
                jsx(P.Button, { size: "sm", variant: "outline", onClick: onClose, children: "取消" }),
                !manage && jsx(P.Button, { size: "sm", variant: "primary", disabled: busy, onClick: () => onSave(selected), children: "保存" }),
              ] }),
            ] }),
          ],
        }),
      });
    }

    /** 归档会话 Tab：查看/恢复/删除 dsh 官方归档的会话 */
    function ArchivedTab(props) {
      const { tools, unwrap, run, confirm, currentId, openView, onCopy } = props;
      const [items, setItems] = React.useState([]);
      const [loading, setLoading] = React.useState(false);
      const [msg, setMsg] = React.useState("");

      const refresh = React.useCallback(() => {
        setLoading(true);
        tools["archived.list"]()
          .then((resp) => setItems(unwrap(resp) || []))
          .catch((e) => console.error("dsh-toolbox: archived.list 失败", e))
          .finally(() => setLoading(false));
      }, [tools, unwrap]);
      React.useEffect(() => { refresh(); }, [refresh]);

      const row = (it) => {
        const isCurrent = it.sessionId === currentId;
        const title = emptySessionLabel(it) || it.title || "(无标题)";
        const short = it.sessionId.length > 40 ? it.sessionId.slice(0, 37) + "…" : it.sessionId;
        return jsx("div", {
          key: it.sessionId,
          style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", borderBottom: "1px solid rgba(128,128,128,0.12)", flexWrap: "wrap" },
          children: [
            jsx("div", { style: { flex: 1, minWidth: 160, overflow: "hidden" }, children: [
              jsx("div", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title }, children: (isCurrent ? "▶ " : "") + title }),
              jsx("div", {
                style: { fontSize: 11, opacity: 0.55, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "copy", textDecoration: "underline dotted rgba(128,128,128,0.4)", title: it.sessionId + "（点击复制完整 ID）" },
                onClick: (e) => onCopy && onCopy(it.sessionId, e),
                children: "📋 " + short + (it.cwd ? " · " + it.cwd : "") + (fmtStats(it) ? " · " + fmtStats(it) : ""),
              }),
            ] }),
            jsx(P.Button, {
              size: "sm", disabled: busy || isCurrent,
              onClick: () => openView(it.sessionId),
              title: "查看会话内容（只读）",
              children: "👁 查看",
            }),
            jsx(P.Button, {
              size: "sm", disabled: isCurrent,
              onClick: () => confirm("恢复归档会话「" + title + "」？重启后左侧重新显示") && run("恢复", () => tools["archived.restore"](it.sessionId)).then(() => { refresh(); setTimeout(() => window.location.reload(), 900); }),
              children: "恢复",
            }),
            jsx(P.Button, {
              size: "sm", disabled: isCurrent,
              onClick: () => confirm("删除归档会话「" + title + "」？文件进回收站（可恢复），并从归档列表移除") && run("删除", () => tools["archived.delete"](it.sessionId)).then(refresh),
              children: "删除",
            }),
          ],
        });
      };

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }, children: [
            jsx("div", { style: { flex: 1, fontSize: 12, opacity: 0.7 }, children: "dsh 官方归档的会话（左侧隐藏，文件仍在 sessions 区）。恢复后重启显示；删除进回收站" }),
            jsx(P.Button, { size: "sm", onClick: refresh, children: "刷新" }),
          ] }),
          msg ? jsx("div", { style: { fontSize: 12, marginBottom: 6 }, children: msg }) : null,
          loading && items.length === 0
            ? jsx("div", { style: { opacity: 0.6, padding: 12 }, children: "加载中…" })
            : items.length === 0
              ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "没有归档会话" })
              : items.map(row),
        ],
      });
    }

    /** 子目录管理 Tab */
    function SubdirsTab(props) {
      const { tools, unwrap, run, confirm, subdirs, refreshSubdirs, sessions, currentId, refreshSessions, wsList } = props;
      const [newName, setNewName] = React.useState("");
      const [menuFor, setMenuFor] = React.useState(null);
      const [moveMenuFor, setMoveMenuFor] = React.useState(null);
      const [sessMoveFor, setSessMoveFor] = React.useState(null);
      const [expanded, setExpanded] = React.useState({});

      const create = () => {
        const name = newName.trim();
        if (!name) return;
        run("新建", () => tools["workspace.create"](name)).then(refreshSubdirs);
        setNewName("");
      };

      // 子目录内会话（cwd 以子目录为前缀）
      const sessionsIn = (d) => (sessions || []).filter((s) => s.cwd === d.path || s.cwd.startsWith(d.path + "/"));

      // 批量移动目标：仅注册工作区 + 未分组
      const moveTargets = [
        { type: "label", id: "lbl-ws", text: "工作区" },
        ...(wsList || []).map((w) => ({ id: w.path, label: w.path + (w.title && w.title !== w.path ? "（" + w.title + "）" : "") })),
        { type: "label", id: "lbl-ung", text: "未分组" },
        { id: "UNGROUPED", label: "移出工作区（未分组）" },
      ];

      const titleOf = (sid) => {
        // 无 list 数据，用 id 截断显示
        return sid.length > 40 ? sid.slice(0, 37) + "…" : sid;
      };

      const row = (d) => {
        const inside = sessionsIn(d);
        const isOpen = !!expanded[d.name];
        const delItems = [
          { id: "trash", label: "删除 + 会话一并进回收站", danger: true },
          { id: "reset", label: "删除，会话重设到工作区根", danger: true },
          { id: "only", label: "仅删目录（会话 cwd 悬空）", danger: true },
        ];
        return jsx("div", {
          key: d.name,
          style: { borderBottom: "1px solid rgba(128,128,128,0.12)" },
          children: [
            jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 4px", flexWrap: "wrap" }, children: [
              jsx("div", {
                style: { flex: 1, minWidth: 140, cursor: "pointer", overflow: "hidden" },
                onClick: () => setExpanded({ ...expanded, [d.name]: !isOpen }),
                children: [
                  jsx("div", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title: d.name }, children: (isOpen ? "▾ " : "▸ ") + d.name }),
                  jsx("div", { style: { fontSize: 11, opacity: 0.55 }, children: d.sessionCount + " 个会话 · 点击展开" }),
                ],
              }),
              jsx(P.Button, {
                size: "sm", disabled: !!menuFor || !!moveMenuFor,
                onClick: () => {
                  const n = window.prompt("新名称：", d.name);
                  if (n === null || n.trim() === "" || n.trim() === d.name) return;
                  run("重命名", () => tools["workspace.rename"](d.name, n.trim())).then(refreshSubdirs);
                },
                children: "重命名",
              }),
              jsx(P.Button, { size: "sm", disabled: !!menuFor || !!moveMenuFor, onClick: () => run("复制", () => tools["workspace.copy"](d.name)).then(refreshSubdirs), children: "复制" }),
              jsx(P.Menu, {
                portal: true,
                open: moveMenuFor === d.name,
                anchor: jsx(P.Button, { size: "sm", variant: "outline", disabled: !!menuFor, onClick: () => setMoveMenuFor(moveMenuFor === d.name ? null : d.name), children: "移动会话▾" }),
                items: moveTargets,
                onSelect: (id) => {
                  setMoveMenuFor(null);
                  if (id === "UNGROUPED") {
                    confirm("把「" + d.name + "」内的 " + inside.length + " 个会话全部移出工作区（未分组）？") &&
                      run("移出工作区", () => Promise.all(inside.map((x) => tools["sessions.detach"](x.sessionId)))).then(refreshSubdirs);
                    return;
                  }
                  confirm("把「" + d.name + "」内的 " + inside.length + " 个会话全部移动到 " + id + "？") &&
                    run("批量移动", () => tools["workspace.moveSessions"](d.name, id)).then(refreshSubdirs);
                },
                onClose: () => setMoveMenuFor(null),
              }),
              jsx(P.Menu, {
                portal: true,
                open: menuFor === d.name,
                anchor: jsx(P.Button, { size: "sm", variant: "outline", onClick: () => setMenuFor(menuFor === d.name ? null : d.name), children: "删除▾" }),
                items: delItems,
                onSelect: (id) => {
                  setMenuFor(null);
                  const actionLabel = { trash: "目录及关联会话将移入回收站", reset: "目录删除，关联会话重设到工作区根", only: "仅删除目录（会话 cwd 可能悬空）" }[id];
                  confirm("删除子目录「" + d.name + "」？" + actionLabel + "（需重启完整生效）") &&
                    run("删除", () => tools["workspace.delete"](d.name, id)).then(refreshSubdirs);
                },
                onClose: () => setMenuFor(null),
              }),
            ] }),
            isOpen && jsx("div", { style: { padding: "2px 4px 6px 16px" }, children: [
              inside.length === 0
                ? jsx("div", { style: { opacity: 0.5, fontSize: 12, padding: "2px 0" }, children: "（没有会话）" })
                : inside.map((sess) => {
                    const isCurrent = sess.sessionId === currentId;
                    return jsx("div", {
                      key: sess.sessionId,
                      style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 0", flexWrap: "wrap" },
                      children: [
                        jsx("div", { style: { flex: 1, minWidth: 120, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", title: sess.sessionId }, children: (isCurrent ? "▶ " : "") + titleOf(sess.sessionId) }),
                        jsx(P.Button, {
                          size: "sm", disabled: isCurrent,
                          onClick: () => confirm("删除会话「" + sess.sessionId + "」？进回收站") && run("删除", () => tools["sessions.delete"](sess.sessionId)).then(refreshSessions),
                          children: "删除",
                        }),
                        jsx(P.Menu, {
                          portal: true,
                          open: sessMoveFor === sess.sessionId,
                          anchor: jsx(P.Button, { size: "sm", disabled: isCurrent, onClick: () => setSessMoveFor(sessMoveFor === sess.sessionId ? null : sess.sessionId), children: "移动▾" }),
                          items: moveTargets,
                          onSelect: (id) => {
                            setSessMoveFor(null);
                            if (id === "UNGROUPED") { run("移出工作区", () => tools["sessions.detach"](sess.sessionId)).then(refreshSessions); return; }
                            run("移动", () => tools["sessions.move"](id, sess.sessionId)).then(refreshSessions);
                          },
                          onClose: () => setSessMoveFor(null),
                        }),
                      ],
                    });
                  }),
            ] }),
          ],
        });
      };

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }, children: [
            jsx("input", {
              value: newName,
              onChange: (e) => setNewName(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") create(); },
              placeholder: "新子目录名（/workspace 下）",
              style: { flex: 1, minWidth: 160, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "transparent", color: "inherit" },
            }),
            jsx(P.Button, { size: "sm", variant: "primary", disabled: !newName.trim(), onClick: create, children: "新建" }),
            jsx(P.Button, { size: "sm", onClick: refreshSubdirs, children: "刷新" }),
          ] }),
          subdirs.length === 0
            ? jsx("div", { style: { opacity: 0.5, padding: 8, fontSize: 13 }, children: "工作区根没有子目录" })
            : subdirs.map(row),
        ],
      });
    }

    /** 搜索状态持久化（面板关闭重开保留，模块级不随组件卸载重置） */
    let searchPersist = { kw: "", hits: [], searching: false, msg: "" };

    /** 自研搜索 Tab */
    function SearchTab(props) {
      const { tools, unwrap, list, openSession } = props;
      const [kw, setKw] = React.useState(searchPersist.kw);
      const [hits, setHits] = React.useState(searchPersist.hits);
      const [searching, setSearching] = React.useState(searchPersist.searching);
      const [msg, setMsg] = React.useState(searchPersist.msg);
      const abortRef = React.useRef(null);
      // 已点击的记录标记（本轮搜索内生效；新搜索/手动清除时重置）
      const [clicked, setClicked] = React.useState({});

      // 状态变化写回持久层（重开面板恢复）
      React.useEffect(() => {
        searchPersist.kw = kw;
        searchPersist.hits = hits;
        searchPersist.searching = searching;
        searchPersist.msg = msg;
      }, [kw, hits, searching, msg]);

      const doSearch = () => {
        const keyword = kw.trim();
        if (!keyword || searching) return;
        setClicked({}); // 新搜索清除点击标记
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setSearching(true);
        setMsg("");
        tools["search.query"](keyword, ctrl.signal)
          .then((resp) => {
            const r = unwrap(resp);
            const arr = r && r.hits ? r.hits : [];
            setHits(arr);
            if (arr.length === 0) setMsg("无命中");
          })
          .catch((e) => {
            if (e && e.name !== "AbortError") setMsg("搜索失败：" + (e.message || String(e)));
          })
          .finally(() => {
            setSearching(false);
            abortRef.current = null;
          });
      };
      const cancel = () => {
        try { abortRef.current && abortRef.current.abort(); } catch {}
        setSearching(false);
      };

      const highlight = (text) => {
        const k = kw.trim().toLowerCase();
        const idx = String(text).toLowerCase().indexOf(k);
        if (idx < 0 || !k) return text;
        return jsx(React.Fragment, { children: [
          text.slice(0, idx),
          jsx("mark", { style: { background: "#f5c518", color: "#000", borderRadius: 2, padding: "0 1px" }, children: text.slice(idx, idx + k.length) }),
          text.slice(idx + k.length),
        ] });
      };

      const row = (h) => {
        const sum = list && list.byId ? list.byId[h.sessionId] : undefined;
        const title = (sum && sum.displayTitle) || h.sessionId.slice(0, 32);
        const hkey = h.sessionId + ":" + (h.seq ?? h.line);
        const isClicked = !!clicked[hkey];
        return jsx("div", {
          key: hkey,
          style: {
            padding: "6px 4px", borderBottom: "1px solid rgba(128,128,128,0.12)",
            cursor: "pointer", borderRadius: 4,
            borderLeft: isClicked ? "3px solid #4a8fd6" : "3px solid transparent",
            opacity: isClicked ? 0.55 : 1,
            background: isClicked ? "rgba(74,143,214,0.08)" : "transparent",
          },
          onClick: (e) => {
            e.preventDefault(); e.stopPropagation();
            setClicked({ ...clicked, [hkey]: true });
            if (openSession) openSession(h.sessionId, kw, h.seq);
          },
          title: "点击打开会话并定位",
          children: [
            jsx("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 2 }, children: title + " · 第 " + h.line + " 行" }),
            jsx("div", { style: { fontSize: 12, lineHeight: 1.5 }, children: highlight(h.snippet) }),
          ],
        });
      };

      return jsx("div", {
        children: [
          jsx("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }, children: [
            jsx("input", {
              value: kw,
              onChange: (e) => setKw(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") doSearch(); },
              placeholder: "搜索所有会话内容…",
              style: { flex: 1, minWidth: 160, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "transparent", color: "inherit" },
            }),
            searching
              ? jsx(P.Button, { size: "sm", variant: "outline", onClick: cancel, children: "取消" })
              : jsx(P.Button, { size: "sm", variant: "primary", disabled: !kw.trim(), onClick: doSearch, children: "搜索" }),
            Object.keys(clicked).length > 0 && jsx(P.Button, {
              size: "sm", variant: "outline",
              onClick: () => setClicked({}),
              title: "清除已点击记录的标记样式",
              children: "清除标记（" + Object.keys(clicked).length + "）",
            }),
          ] }),
          msg ? jsx("div", { style: { fontSize: 12, marginBottom: 6, opacity: 0.85 }, children: msg }) : null,
          searching
            ? jsx("div", { style: { opacity: 0.6, padding: 12, fontSize: 13 }, children: "搜索中…（逐帧解压全部会话，最多约 10 秒）" })
            : hits.map(row),
        ],
      });
    }

    function apply(ctx) {
      // ── 0. 长消息折叠引擎（纯渲染增强：超阈值行数的消息自动折叠，点击展开） ──
      // 设置存 window.__dsdCollapse（设置页改动即时同步，见 ToolsSettingsSection）
      window.__dsdCollapse = window.__dsdCollapse || { userOn: true, userThreshold: 15, aiOn: false };
      try {
        // 折叠样式（前缀 dsd- 防冲突）
        if (!document.getElementById("dsh-toolbox-collapse-css")) {
          const st = document.createElement("style");
          st.id = "dsh-toolbox-collapse-css";
          st.textContent = [
            ".dsd-fold { position: relative; }",
            ".dsd-fold.dsd-folded { max-height: var(--dsd-fold-h, 360px); overflow: hidden; }",
            ".dsd-fold.dsd-folded::after { content: \"\"; position: absolute; left: 0; right: 0; bottom: 0; height: 44px; background: linear-gradient(transparent, var(--dsw-specific-surface-float, #1c1c20)); pointer-events: none; }",
            ".dsd-fold.dsd-open { max-height: none; overflow: visible; }",
            ".dsd-fold.dsd-open::after { display: none; }",
            ".dsd-fold-btn { position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); z-index: 5; font-size: 12px; cursor: pointer; user-select: none; border: none; border-radius: 999px; padding: 2px 12px; color: var(--dsw-alias-label-primary, #eee); background: var(--dsw-specific-button-secondary, rgba(128,128,128,0.4)); white-space: nowrap; }",
            ".dsd-fold-btn:hover { background: var(--dsw-specific-button-secondary-hover, rgba(128,128,128,0.6)); }",
          ].join("\n");
          document.head.appendChild(st);
        }
        // 处理单个候选容器：超阈值 → 折叠 + 按钮；设置关闭 → 恢复展开（幂等）
        const foldTarget = (el) => {
          if (!el) return;
          const cfg = window.__dsdCollapse || {};
          const want = el.dataset.dsdKind === "ai" ? cfg.aiOn === true : cfg.userOn !== false;
          const threshold = Number(cfg.userThreshold) > 0 ? Number(cfg.userThreshold) : 15;
          if (!want || threshold <= 0) {
            if (el.dataset.dsdFold === "1") {
              el.classList.remove("dsd-fold", "dsd-folded", "dsd-open");
              const btn = el.querySelector(".dsd-fold-btn");
              if (btn) btn.remove();
              delete el.dataset.dsdFold;
            }
            return;
          }
          if (el.dataset.dsdFold === "1") return; // 已处理
          let lineH = 24;
          try { lineH = parseFloat(getComputedStyle(el).lineHeight) || 24; } catch {}
          const maxH = Math.round(threshold * lineH) + 24; // 阈值行高 + 余量
          let fullH = 0;
          try { fullH = el.scrollHeight; } catch { return; }
          if (fullH <= maxH) return; // 不够长，不折叠
          el.dataset.dsdFold = "1";
          el.classList.add("dsd-fold", "dsd-folded");
          el.style.setProperty("--dsd-fold-h", maxH + "px");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "dsd-fold-btn";
          btn.textContent = "展开全部 ▾";
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            const open = el.classList.toggle("dsd-open");
            el.classList.toggle("dsd-folded", !open);
            btn.textContent = open ? "收起 ▴" : "展开全部 ▾";
          });
          el.appendChild(btn);
        };
        // 在新增子树里找候选：用户气泡（_userRow 内 _bubble）与 AI markdown（_markdown）
        const scan = (root) => {
          const cfg = window.__dsdCollapse || {};
          try {
            if (cfg.userOn !== false) {
              root.querySelectorAll('div[class*="_userRow"] div[class*="_bubble"]').forEach((el) => { el.dataset.dsdKind = "user"; foldTarget(el); });
            }
            if (cfg.aiOn === true) {
              root.querySelectorAll('div[class*="_markdown"]').forEach((el) => { el.dataset.dsdKind = "ai"; foldTarget(el); });
            }
          } catch {}
        };
        // 设置变化后重扫（设置页同步 window.__dsdCollapse 后调用）
        window.__dsdScan = () => { try { scan(document.body); } catch {} };
        // MutationObserver：监听消息列表变化（防抖）
        let scanTimer = null;
        const observer = new MutationObserver((muts) => {
          const cfg = window.__dsdCollapse || {};
          if (cfg.userOn === false && cfg.aiOn !== true) return;
          if (scanTimer) return; // 已在队列中
          scanTimer = setTimeout(() => {
            scanTimer = null;
            try {
              let any = false;
              for (const m of muts) {
                if (m.type !== "childList" || !m.addedNodes) continue;
                for (const n of m.addedNodes) {
                  if (n.nodeType !== 1) continue;
                  scan(n);
                  any = true;
                }
              }
              // 首次全量扫描一次（页面已有历史消息）
              if (!observer._dsdBoot) { observer._dsdBoot = true; scan(document.body); }
            } catch {}
          }, 300);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // 首次全量扫描（历史消息也折叠）
        setTimeout(() => { try { scan(document.body); } catch {} }, 800);
      } catch (e) {
        console.warn("dsh-toolbox: 折叠引擎启动失败", e);
      }

      // ── 1. 注册后端端点（生成 ctx.remote.dshToolbox.* 调用方法） ──
      ctx.remote.$mount({ package: "dsh-toolbox", descriptors: DESCRIPTORS }).then(() => {
        // ── 2. 设置分组（设置 → 工具箱）：$mount 完成后再注册，组件能拿到 tools
        // namespace 服务 key = "remote.dsh-toolbox"（remoteServiceKey = `remote.${namespace}`）
        const tools = ctx.get("remote.dsh-toolbox");
        console.log("dsh-toolbox: $mount 完成 | tools =", typeof tools, "| tools 键 =", tools ? Object.keys(tools).slice(0, 6).join(",") : "无");
        const unwrap = (resp) => (resp && typeof resp === "object" && resp.ok === true && resp.value !== undefined ? resp.value : resp);
        // 初始化折叠设置（页面加载即用真实配置；设置页改动由 ToolsSettingsSection 同步）
        try {
          if (tools && typeof tools["config.get"] === "function") {
            tools["config.get"]().then((resp) => {
              const d = unwrap(resp) || {};
              window.__dsdCollapse = window.__dsdCollapse || {};
              window.__dsdCollapse.userOn = d.collapseUserMsg !== false;
              window.__dsdCollapse.userThreshold = Number(d.collapseUserThreshold) > 0 ? Number(d.collapseUserThreshold) : 15;
              window.__dsdCollapse.aiOn = d.collapseAiMsg === true;
              if (typeof window.__dsdScan === "function") setTimeout(window.__dsdScan, 100);
            }).catch(() => {});
          }
        } catch (e) { console.warn("dsh-toolbox: 折叠设置初始化失败", e); }
        // 打开会话（官方 sessions 服务）；带 keyword/seq 时定位到关键词所在消息
        const openSession = (sessionId, keyword, seq) => {
          try {
            const svc = ctx.get("sessions");
            if (svc && typeof svc.open === "function") svc.open(sessionId);
            else { console.warn("dsh-toolbox: sessions 服务不可用", sessionId); return; }
          } catch (e) {
            console.error("dsh-toolbox: openSession 失败", sessionId, e);
            return;
          }
          const kwText = typeof keyword === "string" ? keyword.trim() : "";
          if (kwText.length < 2 && seq == null) return;
          const flash = (el) => {
            if (!el) return;
            el.scrollIntoView({ block: "center", behavior: "smooth" });
            const prev = el.style.background;
            el.style.background = "rgba(245,197,24,0.35)";
            setTimeout(() => { el.style.background = prev; }, 2500);
          };
          const tryLocate = () => {
            // 1) 官方消息 DOM 若有 data-seq 属性则直接命中
            if (seq != null) {
              const el = document.querySelector('[data-seq="' + seq + '"]');
              if (el) { flash(el); return; }
            }
            // 2) 滚动会话区到底部（触发虚拟滚动渲染最新消息）
            let best = null, bestH = 0;
            for (const s of document.querySelectorAll("main, [class*='conversation'], [class*='scroll'], [class*='message']")) {
              if (s.scrollHeight > bestH) { best = s; bestH = s.scrollHeight; }
            }
            if (best) best.scrollTop = best.scrollHeight;
            // 3) 等渲染后文本查找（取最后一个匹配，靠近最新）
            setTimeout(() => {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              const matches = [];
              let node;
              while ((node = walker.nextNode())) {
                const t = node.textContent || "";
                if (t.includes(kwText)) matches.push(node.parentElement);
              }
              if (matches.length > 0) flash(matches[matches.length - 1]);
            }, 500);
          };
          setTimeout(tryLocate, 700);
        };
        // 官方分叉复制：store 感知左侧立即可见；fork 后自定义命名为「原标题-副本x」
        const forkSession = (sessionId) => {
          const svc = ctx.get("sessions");
          if (!svc || typeof svc.fork !== "function") throw new Error("sessions 服务不可用");
          return svc.fork({ sessionId }).then(async (childId) => {
            // 复制后不跳转：仅创建副本，保持当前会话不变
            try {
              const snap = svc.list ? svc.list.getSnapshot() : undefined;
              const src = snap && snap.byId ? snap.byId[sessionId] : undefined;
              const srcTitle = (src && (src.title || src.displayTitle)) || "未命名会话";
              const existing = new Set(Object.values(snap?.byId || {}).map((s) => s.displayTitle));
              let n = 1;
              while (existing.has(srcTitle + "-副本" + n)) n += 1;
              const child = svc.binding ? svc.binding(childId)?.session : undefined;
              if (child && typeof child.rename === "function") {
                const r = await child.rename(srcTitle + "-副本" + n);
                if (!r || !r.ok) console.warn("dsh-toolbox: 副本重命名失败", r && r.error);
              }
            } catch (e) {
              console.warn("dsh-toolbox: 副本命名跳过", e);
            }
            return childId;
          });
        };

        // 工具箱面板状态（挂到模块级变量，按钮与面板共享）
        let panelOpen = false;
        const panelState = { open: false, listeners: new Set() };
        const setPanelOpen = (v) => {
          panelState.open = v;
          panelState.listeners.forEach((fn) => fn(v));
        };
        const usePanelOpen = () => {
          const [open, setOpen] = React.useState(panelState.open);
          React.useEffect(() => {
            panelState.listeners.add(setOpen);
            return () => panelState.listeners.delete(setOpen);
          }, []);
          return open;
        };

        // 移动端适配：窄屏（≤720px）隐藏按钮文字，只显示 🧰 图标（防竖排/遮挡）
        if (!document.getElementById("dsh-toolbox-btn-css")) {
          const st = document.createElement("style");
          st.id = "dsh-toolbox-btn-css";
          st.textContent = "@media (max-width: 720px) { .dsh-toolbox-btn-text { display: none !important; } }";
          document.head.appendChild(st);
        }

        const ToolboxButton = () => {
          const open = usePanelOpen();
          return jsx(P.Button, {
            size: "sm",
            variant: "outline",
            title: "工具箱：会话管理 / 回收站 / 子目录 / 搜索",
            onClick: () => setPanelOpen(!open),
            children: jsx("span", {
              style: { display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" },
              children: [
                jsx("span", { children: "🧰" }),
                jsx("span", { className: "dsh-toolbox-btn-text", children: "工具箱" }),
              ],
            }),
          });
        };
        const ToolboxPanelHost = (slotProps) => {
          const open = usePanelOpen();
          return open
            ? jsx(ToolboxPanel, { tools, unwrap, useSessions: slotProps.useSessions, useWorkspaces: slotProps.useWorkspaces, openSession, forkSession, open, onClose: () => setPanelOpen(false) })
            : null;
        };

        ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: "dsh-toolbox",
              order: 10,
            },
            ToolboxButton,
          ),
        );
        ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: "dsh-toolbox-panel",
              order: 11,
            },
            ToolboxPanelHost,
          ),
        );
        const ToolsSection = () => jsx(ToolsSettingsSection, { tools });
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-toolbox",
              order: 100,
              label: () => "工具箱",
            },
            ToolsSection,
          ),
        );
        // 设置页「预设编辑」分组：自定义 agent（~/.agent-presets）在线编辑入口
        // 动态显隐：presetEdit 开关关闭 → 整个分组（含标题）移除；开启 → 恢复。
        // 轮询放 apply 层而非组件内（组件随条目移除被卸载，轮询必须独立存活）。
        const PresetsSection = () => jsx(PresetsTab, { tools, unwrap, run: undefined });
        let presetsDisposer = null;
        const registerPresets = () => {
          if (presetsDisposer) return;
          presetsDisposer = ctx.slots.register(
            { name: "settings.section", id: "dsh-toolbox-presets", order: 110, label: () => "预设编辑" },
            PresetsSection,
          );
        };
        const unregisterPresets = () => {
          if (presetsDisposer) { presetsDisposer(); presetsDisposer = null; }
        };
        registerPresets(); // 默认显示
        let lastPresetOn = null;
        const pollPresets = () => {
          tools["config.get"]()
            .then((resp) => {
              const on = (unwrap(resp) || {}).presetEdit !== false;
              if (on === lastPresetOn) return;
              lastPresetOn = on;
              if (on) registerPresets(); else unregisterPresets();
            })
            .catch(() => {});
        };
        const presetsTimer = setInterval(pollPresets, 2000);
        ctx.on("dispose", () => { clearInterval(presetsTimer); unregisterPresets(); });
      }).catch((err) => {
        console.error("dsh-toolbox: remote 挂载失败，工具箱不可用", err);
      });
    }

    return { apply, inject: ["remote", "slots", "settingsScope", "connection"] };
  },
});
