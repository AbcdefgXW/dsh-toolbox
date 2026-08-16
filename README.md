# dsh-toolbox

[English](README.en.md) | [简体中文](README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-blue)
![dsh](https://img.shields.io/badge/dsh-plugin-ready-4caf50.svg)

> dsh（DeepSeek Harness）增强工具箱插件：会话管理 / 回收站 / 子目录管理 / 全文搜索 / 预设编辑 / 配置编辑 / 归档管理。

## ✨ 功能

- **💬 会话管理**：删除（进回收站）、复制（官方 fork + 「-副本x」命名）、移动（工作区之间）、重设工作区根、标签分组（点选式编辑器：已有标签点击即选，避免手输错；标签管理：删除/重命名，重命名可合并重复标签）、查看会话内容（只读）、对话管理（截断/编辑，默认关闭需显式开启）、空会话自动标注「（空会话）工作区名」
- **⏰ 定时心跳**：定时唤醒 AI 执行巡检/汇报等任务（类似 OpenClaw 心跳模式）——两种调度：**间隔心跳**（每 N 分钟）与**定点定时**（每天几点 / 每周几 / 每月几号），各自独立提示语与目标；目标可选**主工作区根（内部巡检）或任意会话，以及 📱 微信 / QQ / 飞书 IM 渠道**（唤醒渠道 bot 执行任务并把 AI 回复推送回手机）。调度运行在 **dsh 后端进程**中——**无需保持网页打开**，容器（dsh 服务）运行即生效。渠道推送为**可选集成**：依赖自研渠道桥插件 dsh-im-bridge 提供的 `dsh-channels-push` 服务（见下文「IM 渠道推送（可选）」），未安装时自动回退主工作区心跳
- **📃 长消息折叠**：消息超过阈值行数（默认 15，可调）自动折叠显示，点击「展开全部」查看；用户消息默认开启，AI 回复默认关闭（纯渲染层增强，不修改任何数据）
- **🗑️ 回收站**：删除的会话/子目录进回收站（默认保留 30 天，可调），可恢复 / 彻底删除 / 查看被删会话内容
- **📁 子目录管理**：工作区下建目录 / 重命名 / 删除 / 复制，会话批量归属
- **🔍 自研搜索**：全文搜索所有会话（高亮 + 跳转 + 可取消；逐帧流式解压，内存友好；同关键词 60 秒内缓存）
- **⚙️ 预设编辑**：在线编辑 Agent 预设文件
- **📄 配置编辑**：在线编辑 dsh 配置文件（YAML 校验 + 原子写）
- **🗄 归档管理**：查看 / 恢复 / 删除官方归档会话
- **🧹 释放内存**：清空插件缓存并尝试触发 GC（彻底释放需重启容器）

## 📸 截图

**会话管理**（删除 / 复制 / 移动 / 重设 / 标签 / 查看 / 空会话标注）：

![会话管理](assets/session-manage.png)

**回收站**（删除的会话进回收站，可恢复 / 彻底删除 / 查看内容）：

![会话回收站](assets/session-trash.png)

**子目录管理**（工作区下建目录 / 重命名 / 删除 / 复制）：

![子目录](assets/subdirs.png)

**开关设置项**（分区化设置：⏰ 定时心跳 / 🔧 功能开关 / 🗑️ 回收站）：

![开关设置项 1](assets/settings-1.png)

![开关设置项 2](assets/settings-2.png)

## 环境要求

- **dsh** 运行时（插件作为 dsh 插件加载；前端依赖 dsh web 运行时注入的 `react`、`@deepseek-ai/dsh-client-ui-primitives` 等）
- **Node.js ≥ 22.13**（会话文件解压使用 `node:zlib` 的 zstd 支持）
- **平台**：代码跨平台（全 Node 内置 API，无 shell 依赖）。默认路径按 Linux 约定（`/home/dsh`、`/workspace`）；**Windows / macOS 部署请设置环境变量 `DSH_HOME` 与 `DSH_CHANNELS_CWD`** 指向实际目录（见下文「环境变量」）

## 安装

### 方式一：dsh 命令（推荐）

```bash
# GitHub 仓库分发（自动 clone + 装依赖）
dsh plugin --profile web add github:AbcdefgXW/dsh-toolbox

# 或已发布 npm 包
dsh plugin --profile web add dsh-toolbox
```

若未自动注册，在 profile 的 `cordis.patch.yml` 加入：

```yaml
- insert:
    - id: dsh-toolbox
      name: dsh-toolbox
```

### 方式二：手动

```bash
git clone https://github.com/AbcdefgXW/dsh-toolbox.git
cd dsh-toolbox
npm install --omit=dev
```

将插件目录放入 dsh 插件加载路径（如 `$DSH_HOME/plugins/` 或 compose 挂载卷），按上述方式注册，重启 `dsh web`。

> `@deepseek-ai/*` 依赖为 dsh 运行时自带包，版本与 dsh 发布对齐；`js-yaml` 为插件自身依赖（配置编辑校验用）。

## 使用

重启 `dsh web` 后，浏览器强刷（Ctrl+Shift+R）：

1. **🧰 工具箱**（左下角按钮，移动端为 🧰 图标）——7 个 Tab：
   - **💬 会话**：按工作区/标签分组列出会话；每行可删除（进回收站）、复制（`-副本x`）、移动、重设工作区根、打标签、查看内容；空会话标注「（空会话）」
   - **🗑️ 回收站**：被删会话/子目录，可恢复 / 彻底删除 / 查看被删内容
   - **📁 子目录**：工作区下建/改/删/复制目录，会话批量归属
   - **🔍 搜索**：关键词全文搜索所有会话，高亮 + 点击跳转
   - **⚙️ 预设**：在线编辑 Agent 预设（`~/.agent-presets`）
   - **📄 配置**：在线编辑 dsh 配置文件（YAML 校验 + 原子写）
   - **🗄 归档**：查看 / 恢复 / 删除官方归档会话
2. **设置 → 工具箱**：功能开关 + 定时心跳配置
3. **⏰ 定时心跳**（可选，OpenClaw 心跳模式）：设置 → 工具箱 → 定时心跳
   - 开关 + 间隔（分钟）+ 提示语（`{time}` 替换为当前时间）+ 下次触发倒计时
   - 定点定时：每天几点 / 每周几 / 每月几号，独立提示语与目标
   - 目标：主工作区根（内部巡检）/ 任意会话 / 📱 微信·QQ·飞书（需 dsh-im-bridge，结果推送手机）
   - 调度运行在 dsh 后端进程，网页无需保持打开
4. **📃 长消息折叠**（默认开）：超过阈值的消息自动折叠，点「展开全部」查看（阈值可调）

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 数据目录（会话/配置/缓存） | `/home/dsh` |
| `DSH_CHANNELS_CWD` | 当前工作区根（会话 cwd 基准） | `/workspace` |

未设置时使用上述默认值；其余路径全部由插件自身目录（`import.meta.url`）推导，无硬编码。

## 数据与安全

- **运行时数据**存于插件 `state/` 目录（设置、回收站、备份、标签）——不随代码发布，`.gitignore` 已排除
- 插件会读写：`$DSH_HOME/sessions/`（会话文件，多帧 zstd）、`$DSH_HOME/storages/workspace.json`（工作区注册）、dsh 配置文件（仅配置编辑功能使用时）
- **删除 = 移入回收站**（默认 30 天保留，可恢复），非物理删除
- **对话管理（截断/编辑）**：修改会话文件后需重启容器完整生效；默认关闭，需在设置中显式开启
- **IM 渠道推送提示**：定时心跳推送到 IM 渠道时，微信走模拟网页协议（ilinkai），**主动频繁发消息存在账号风控风险**——建议心跳间隔 ≥ 15 分钟、提示语内容正常化、避免短时间大量推送；QQ 官方开放平台主动消息需**申请「主动消息权限」**（未开通时推送会静默失败）；飞书为官方 API，合规无风险

## IM 渠道推送（可选）

定时心跳的「📱 微信 / QQ / 飞书」目标是**可选集成**：dsh-toolbox 通过 cordis 服务 `dsh-channels-push` 调用渠道插件完成「唤醒渠道 bot 执行任务 → AI 回复回传 IM」。

- **dsh-im-bridge** 为自研渠道桥插件（微信 ilinkai / QQ 开放平台 / 飞书开放平台），**不随本仓库分发**，需单独安装（[dsh-im-bridge](https://github.com/AbcdefgXW/dsh-im-bridge)）
- 未安装该服务时：渠道目标不可用（选择后会提示"渠道推送服务不可用"），主工作区根 / 指定会话的心跳不受任何影响
- 第三方渠道插件若提供同名服务亦可对接（当前无公开适配规范，属实现约定）

## 开发

- `index.js` 后端（cordis Service + typert remote，方法名 = 端点名）；`client.js` 前端（无构建管线，`window.__ModuleLoader__` 加载）
- 新增端点三处同步：后端方法 + 后端 `invocation` 注册 + 前端 `DESCRIPTORS`
- 会话文件重写必须用官方多帧格式（`lib/zstd.js compressSessionText`：header 帧恰好一行 + 每 500 行事件帧），单帧全压会导致 dsh 加载崩溃

## License

MIT — 见 [LICENSE](LICENSE)
