# dsh-toolbox

[English](README.en.md) | [简体中文](README.md)

![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-blue)
![dsh](https://img.shields.io/badge/dsh-plugin-ready-4caf50.svg)

> dsh（DeepSeek Harness）增强工具箱插件：会话管理 / 回收站 / 子目录管理 / 全文搜索 / 预设编辑 / 配置编辑 / 归档管理。

## ✨ 功能

- **💬 会话管理**：删除（进回收站）、复制（官方 fork + 「-副本x」命名）、移动（工作区之间）、重设工作区根、标签分组（点选式编辑器：已有标签点击即选，避免手输错；标签管理：删除/重命名，重命名可合并重复标签）、查看会话内容（只读）、对话管理（截断/编辑，默认关闭需显式开启）、空会话自动标注「（空会话）工作区名」
- **📃 长消息折叠**：消息超过阈值行数（默认 15，可调）自动折叠显示，点击「展开全部」查看；用户消息默认开启，AI 回复默认关闭（纯渲染层增强，不修改任何数据）
- **🗑️ 回收站**：删除的会话/子目录进回收站（默认保留 30 天，可调），可恢复 / 彻底删除 / 查看被删会话内容
- **📁 子目录管理**：工作区下建目录 / 重命名 / 删除 / 复制，会话批量归属
- **🔍 自研搜索**：全文搜索所有会话（高亮 + 跳转 + 可取消；逐帧流式解压，内存友好；同关键词 60 秒内缓存）
- **⚙️ 预设编辑**：在线编辑 Agent 预设文件
- **📄 配置编辑**：在线编辑 dsh 配置文件（YAML 校验 + 原子写）
- **🗄 归档管理**：查看 / 恢复 / 删除官方归档会话
- **🧹 释放内存**：清空插件缓存并尝试触发 GC（彻底释放需重启容器）

## 📸 截图

<!-- TODO: 在此添加界面截图 -->

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

重启 `dsh web` 后，浏览器强刷（Ctrl+Shift+R），点击左下角 **🧰 工具箱** 打开面板（移动端窄屏显示为 🧰 图标）。更多开关在 **设置 → 工具箱**。

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

## 开发

- `index.js` 后端（cordis Service + typert remote，方法名 = 端点名）；`client.js` 前端（无构建管线，`window.__ModuleLoader__` 加载）
- 新增端点三处同步：后端方法 + 后端 `invocation` 注册 + 前端 `DESCRIPTORS`
- 会话文件重写必须用官方多帧格式（`lib/zstd.js compressSessionText`：header 帧恰好一行 + 每 500 行事件帧），单帧全压会导致 dsh 加载崩溃

## License

MIT — 见 [LICENSE](LICENSE)
