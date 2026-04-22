# memo-agent

memo-agent 是一个基于终端的 AI 助手应用（Hermes Agent 简化版），采用 TypeScript + React + Ink 构建，直接连接 OpenAI 兼容
 API，具备持久化记忆、MCP 工具扩展和智能上下文压缩等特性。

---

## 功能特性

- **持久化记忆** — `NOTES.md` 跨会话保留上下文，自动注入每次对话的 system prompt；启用 `auto_update` 后每轮结束自动判断并写入
- **会话链归档** — 上下文压缩时创建新 session 并通过 `parent_session_id` 链式关联旧会话，历史永不丢失
- **三区上下文压缩** — 超长对话自动归档中间历史，保留首轮和最近 ~20k tokens，对话永不截断
- **Slash 命令** — `/notes`、`/history`、`/search`、`/compact`、`/cost` 等，`/help` 查看全部
- **Recipes 系统** — 自定义 `.md` 模板文件，`/recipe-name [参数]` 一键调用；支持 `watchPaths` 在修改匹配文件后自动推荐相关 recipe
- **MCP 工具扩展** — 通过 Model Context Protocol 接入外部工具服务器
- **会话持久化** — SQLite 存储全部历史，`/resume` 恢复任意历史会话，支持全文搜索
- **Profile 隔离** — 多 profile 独立配置、记忆、会话数据，互不干扰
- **权限守卫** — `ask`/`auto` 两种模式，危险命令（`rm -rf` 等）强制确认，路径安全限制；支持 `disabledTools` 彻底屏蔽指定工具
- **富文本 UI** — React + Ink 渲染，流式输出，状态栏实时显示 token 用量与费用
- **输入增强** — 光标定位（←/→ 移动，可中途修改）、历史记录（↑/↓ 切换）、streaming 期间输入排队不丢失

---

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置

复制示例配置文件并填写 API 信息：

```bash
cp .env.example .env
```

```env
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=sk-...
MODEL_NAME=gpt-4o
```

或者创建 `~/.memo-agent/config.yaml`（见 [配置文件](#配置文件)）。

### 启动

```bash
# 开发模式（tsx 热重载）
npm run dev

# 构建后运行
npm run build
npm start

# 全局安装后使用 memo 命令
npm install -g .
slave
```

---

## 命令行参数

```
memo [options]

OPTIONS
  --profile <name>        使用指定 profile（默认: "default"）
  --model <name>          覆盖配置中的模型名
  --resume <session-id>   恢复指定历史会话
  --auto                  以 auto 权限模式启动（无需确认）
  --version, -v           打印版本号
  --help, -h              打印帮助
```

示例：

```bash
memo --profile work
memo --model gpt-4o-mini
memo --resume abc12345
memo --auto
```

---

## 终端输入操作

| 操作 | 效果 |
|------|------|
| `←` / `→` | 在输入行内移动光标，支持中途插入或删除 |
| `↑` / `↓` | 切换历史输入（最多 50 条），↓ 返回当前编辑内容 |
| `Backspace` / `Delete` | 删除光标左侧字符 |
| 粘贴 / 多字符输入 | 光标正确跳到所有字符末尾 |
| streaming 期间打字 | 字符排队显示（灰色 + `(queued)`），idle 后可继续编辑提交 |
| `Ctrl+C`（streaming 中） | 中断请求，已流出的部分内容保留在屏幕上（标注 `[interrupted]`） |
| `Ctrl+C`（idle，连按两次） | 退出 |

---

## 状态栏

底部状态栏实时显示：

```
● memo-agent │ gpt-4o    tokens: 1234/128k (15%)  │  $0.0042  │  mode:ask  │  profile:default
```

| 字段 | 说明 |
|------|------|
| `●` / `○` | streaming 中 / idle |
| `tokens` | 本次会话已用 token / 模型上限，超 70% 变黄，超 85% 变红 |
| `$X.XXXX` | 本次会话估算费用（USD） |
| `mode` | 当前权限模式（ask / auto） |
| `profile` | 当前 profile 名称 |

---

## Slash 命令

在对话中输入以下命令：

| 命令 | 说明 |
|------|------|
| `/help` | 显示所有可用命令和 recipe |
| `/notes [show\|clear]` | 查看或清空持久化笔记（NOTES.md） |
| `/history [n]` | 显示最近 n 条会话（默认 10） |
| `/search <关键词>` | 全文搜索所有历史消息 |
| `/compact [焦点描述]` | 手动触发上下文归档压缩 |
| `/model [名称]` | 查看或切换当前模型 |
| `/cost` | 显示本次会话 token 消耗和估算费用 |
| `/clear` | 清空当前会话上下文（记忆保留） |
| `/resume [会话ID]` | 提示用 `--resume` 参数恢复会话 |
| `/profile [名称]` | 查看或切换 profile |
| `/recipes` | 列出已安装的 recipe |
| `/mode [ask\|auto]` | 切换工具执行权限模式 |
| `/exit` | 退出 memo-agent（别名：`/quit`） |

---

## Recipes 系统

Recipe 是可复用的 prompt 模板，存放为 `.md` 文件。

### 存放位置

- **全局**：`~/.memo-agent/recipes/`
- **项目级**（优先）：`.memo-agent/recipes/`

### Recipe 文件格式

```markdown
---
name: review
description: 对当前改动进行代码审查
allowedTools: [ReadFile, SearchCode, ListFiles]
---
请对以下改动进行代码审查，重点关注安全、性能、可维护性。

$ARGUMENTS
```

| 字段 | 说明 |
|------|------|
| `name` | 调用名称（小写字母 + 连字符） |
| `description` | `/recipes` 列表中显示的描述 |
| `allowedTools` | 该 recipe 执行时预授权的工具（跳过权限确认） |
| `watchPaths` | 文件路径匹配时自动推荐该 recipe（可选） |
| `$ARGUMENTS` | 调用时传入的参数占位符 |

### 调用 Recipe

```
/review src/main.ts
/fix-types
/summarize-pr
```

---

## 持久化记忆

### NOTES.md — 工作笔记（可读写）

路径：`~/.memo-agent/memory/NOTES.md`（或 profile 目录下）

- agent 可通过 `WriteNotes` 工具追加笔记
- 启用 `memory.auto_update: true` 后，每轮对话结束自动判断是否有值得保留的信息并写入；写入时在终端展示保存的内容
- 每次会话启动自动注入到 system prompt
- `/notes show` 查看，`/notes clear` 清空

### PROFILE.md — 用户偏好（只读）

路径：`~/.memo-agent/memory/PROFILE.md`

只有用户手动编辑，agent 不会修改。适合放置：

```markdown
我是一名后端工程师，主要使用 Go 和 TypeScript。
代码风格：函数式优先，避免过度抽象。
回答请用中文，代码注释用英文。
```

---

## 上下文压缩

对话上下文分三个区域管理：

```
┌──────────────────────────────────┐
│  HEAD（锚定区）                   │  system prompt + 首轮对话，永不压缩
├──────────────────────────────────┤
│  MIDDLE（归档区）                 │  超阈值后用 LLM 生成摘要替换
├──────────────────────────────────┤
│  TAIL（活跃区）                   │  最近 ~20k tokens，完整保留
└──────────────────────────────────┘
```

触发时机（可在配置中调整）：
- **70%** 上下文用量 → 状态栏警告（黄色）
- **85%** 上下文用量 → 自动触发归档
- 手动触发：`/compact [焦点描述]`

---

## 工具系统

### 内置工具

| 工具 | 说明 | 权限 |
|------|------|------|
| `ReadFile` | 读取文件内容，支持行号范围（限 cwd / profile 目录内） | 只读 |
| `WriteFile` | 创建或覆盖文件（限 cwd / profile 目录内） | 写入 |
| `EditFile` | 精确字符串替换；支持 `replace_all: true` 全量替换 | 写入 |
| `ListFiles` | Glob 模式列出文件 | 只读 |
| `SearchCode` | 正则搜索文件内容（优先 rg，备用 grep），全局结果数限制 | 只读 |
| `RunCommand` | 执行 shell 命令，30s 超时 | 高危 |
| `WriteNotes` | 追加内容到 NOTES.md | 写入 |
| `ReadNotes` | 读取当前 NOTES.md | 只读 |
| `CreateTask` | 创建会话内任务（ID 从 1 开始，`/clear` 后重置） | 写入 |
| `UpdateTask` | 更新任务状态、`blockedBy`、`blocks` | 写入 |
| `ListTasks` | 列出当前会话所有任务 | 只读 |
| `GetTask` | 获取任务详情（含依赖关系） | 只读 |
| `SearchHistory` | 全文检索历史消息（跨所有会话） | 只读 |
| `ListSessions` | 列出历史会话（含会话链父子关系） | 只读 |

### MCP 工具扩展

在 `config.yaml` 中配置 MCP 服务器，工具自动注册为 `mcp__<服务器名>__<工具名>`：

```yaml
mcp_servers:
  github:
    type: stdio
    command: npx
    args: ["@modelcontextprotocol/server-github"]
  filesystem:
    type: stdio
    command: npx
    args: ["@modelcontextprotocol/server-filesystem", "/tmp"]
```

MCP 服务器在后台并行连接，不阻塞启动。

---

## 权限系统

### 模式

| 模式 | 行为 |
|------|------|
| `ask`（默认） | 写操作和 shell 命令弹出确认 |
| `auto` | 自动执行（危险命令仍需确认） |

切换方式：`/mode auto` 或启动时 `--auto`。

### 权限确认操作

出现权限对话框时：
- `Enter` / `y` — 本次允许（默认）
- `a` — 本 session 始终允许
- `n` — 拒绝

### 安全项目目录自动放行

当 `cwd`（当前工作目录）**不是**核心/敏感目录时，`WriteFile` 和 `EditFile` 对目录内文件的操作自动放行，无需确认。

**核心目录**（仍需确认）：
- 家目录本身 `~`（但 `~/projects/foo` 是安全的）
- 文件系统根 `/` 及系统树（`/etc`、`/usr`、`/bin` 等）
- 家目录的敏感子目录（`~/.ssh`、`~/.aws`、`~/.config`、`~/.kube` 等）

`RunCommand` 不受此规则影响，始终走原有的 ask/auto 逻辑。

### 危险命令强制确认

无论任何模式，以下命令始终弹出确认：

`rm -rf`、`git push --force`、`git reset --hard`、`sudo`、`dd if=`、`mkfs`、`shutdown`、`kill -9` 等。

### 配置允许/拒绝规则

```yaml
permissions:
  mode: ask
  allow:
    - ReadFile
    - ListFiles
    - SearchCode
    - "RunCommand(git status)"
  deny:
    - "RunCommand(rm *)"
  disabled_tools:
    - RunCommand     # 完全屏蔽，model 看不到此工具
```

---

## 配置文件

### 文件位置

| 路径 | 作用 |
|------|------|
| `~/.memo-agent/config.yaml` | 全局默认配置 |
| `~/.memo-agent/profiles/<name>/config.yaml` | 指定 profile 的配置 |
| `.env` | 项目根目录环境变量（最高优先级） |

### 完整配置示例

```yaml
# 主模型配置
model:
  provider: openai           # openai | custom
  base_url: "${MODEL_BASE_URL}"
  api_key: "${MODEL_API_KEY}"
  name: gpt-4o
  timeout_ms: 60000

# 辅助模型（用于上下文归档压缩，建议配置低价模型）
auxiliary:
  provider: openai
  base_url: "${AUX_BASE_URL}"
  api_key: "${AUX_API_KEY}"
  name: gpt-4o-mini
  timeout_ms: 60000

# 持久化记忆
memory:
  auto_update: true          # 每轮结束自动判断并写入 NOTES.md（默认开启）
  max_inject_tokens: 4000    # 注入 system prompt 的最大 token 数

# 上下文压缩阈值
context:
  warn_threshold: 0.70       # 70% 时显示警告
  compress_threshold: 0.85   # 85% 时自动归档
  tail_tokens: 20000         # 活跃区保留的 token 数

# 权限控制
permissions:
  mode: ask                  # ask | auto
  allow:
    - ReadFile
    - ListFiles
    - SearchCode
    - ReadNotes
    - SearchHistory
    - ListSessions
  deny: []
  disabled_tools: []         # 完全屏蔽的工具名列表，例如 [RunCommand]

# MCP 服务器
mcp_servers:
  github:
    type: stdio
    command: npx
    args: ["@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"
```

---

## Profile 隔离

不同场景使用独立的配置、记忆和会话：

```
~/.memo-agent/                  # default profile
  config.yaml
  memory/
    NOTES.md
    PROFILE.md
  sessions.db
  recipes/

~/.memo-agent/profiles/work/    # work profile
  config.yaml                    # 可使用不同模型、API key
  memory/
  sessions.db
  recipes/
```

切换方式：

```bash
memo --profile work
memo --profile research
```

---

## 会话管理

```bash
# 查看最近 10 条会话
/history

# 查看最近 20 条
/history 20

# 全文搜索历史消息（/search 命令由人使用）
/search "sqlite WAL mode"

# 恢复历史会话（先用 /history 获取 session ID）
memo --resume abc12345

# 清空当前会话（不影响 NOTES.md）
/clear
```

model 也可通过工具主动查阅历史：

- `SearchHistory` — 全文检索所有历史消息，适合回答"我们之前讨论过什么"
- `ListSessions` — 列出历史会话列表，含会话链父子关系（压缩归档后自动形成）

---

## 目录结构

```
memo-agent/
├── src/
│   ├── cli/
│   │   └── index.ts              # 入口：参数解析、启动流程
│   ├── engine/
│   │   ├── conversationEngine.ts # 核心：多轮会话循环、工具调用
│   │   └── commandRouter.ts      # Slash 命令分发（纯函数）
│   ├── model/
│   │   ├── client.ts             # OpenAI client 工厂
│   │   └── streaming.ts          # 流式响应 async generator
│   ├── context/
│   │   ├── compressor.ts         # 三区归档压缩
│   │   ├── tokenBudget.ts        # Token 预算追踪与估算
│   │   └── promptBuilder.ts      # System prompt 动态构建
│   ├── memory/
│   │   ├── notesManager.ts       # NOTES.md 读写
│   │   └── profileReader.ts      # PROFILE.md 只读
│   ├── tools/
│   │   ├── registry.ts           # 工具注册中心（支持 disableTools）
│   │   ├── pathUtils.ts          # 共享路径安全校验
│   │   ├── searchHistory.ts      # 历史消息全文搜索工具
│   │   ├── listSessions.ts       # 历史会话列表工具
│   │   └── *.ts                  # 各工具实现（自注册）
│   ├── recipes/
│   │   └── recipeRegistry.ts     # Recipe 加载与模板展开
│   ├── session/
│   │   └── db.ts                 # SQLite 会话存储（WAL + FTS5）
│   ├── permissions/
│   │   └── guard.ts              # 集中权限决策
│   ├── mcp/
│   │   └── mcpBridge.ts          # MCP 协议工具桥接
│   ├── config/
│   │   └── loader.ts             # 配置加载与合并
│   ├── ui/
│   │   ├── App.tsx               # 主界面（状态机）
│   │   ├── MessageList.tsx       # 消息列表渲染
│   │   └── StatusBar.tsx         # 底部状态栏
│   └── types/
│       ├── messages.ts           # ChatMessage、StreamEvent
│       ├── config.ts             # SlaveAgentConfig
│       ├── errors.ts             # SlaveAgentError 判别联合
│       ├── tool.ts               # Tool 接口
│       └── session.ts            # SessionRow、MessageRow
├── .memo-agent/
│   └── recipes/                  # 项目级 recipe 文件
├── .env.example
├── package.json
├── tsconfig.json
└── prd.md
```

---

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript 5（strict + ESM） |
| 终端 UI | React 18 + Ink 5 |
| 数据库 | better-sqlite3（WAL 模式 + FTS5 全文索引） |
| 模型 SDK | openai（OpenAI-compatible API） |
| 工具协议 | @modelcontextprotocol/sdk |
| 配置解析 | js-yaml + dotenv |
| 构建 | tsx（开发）/ tsc（生产） |

---

## 开发

```bash
# 类型检查
npm run typecheck

# 开发模式（tsx，无需构建）
npm run dev

# 生产构建
npm run build

# 运行构建产物
npm start
```

### 添加自定义工具

1. 在 `src/tools/` 下新建 `myTool.ts`
2. 实现 `Tool` 接口，在文件末尾调用 `registerTool(myTool)`
3. 在 `src/tools/index.ts` 添加 `import "./myTool.js"`

```typescript
import type { Tool, ToolContext, ToolResult } from "../types/tool.js";
import { registerTool } from "./registry.js";

const myTool: Tool = {
  name: "MyTool",
  description: "描述工具的用途",
  inputSchema: {
    type: "object",
    properties: {
      param: { type: "string", description: "参数说明" },
    },
    required: ["param"],
  },
  maxResultChars: 10_000,
  isReadOnly(): boolean { return true; },
  isEnabled(): boolean { return true; },

  async call(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const param = input["param"] as string;
    return { content: `Result: ${param}` };
  },
};

registerTool(myTool);
```

---

## 安全说明

- **路径限制**：`ReadFile`、`WriteFile`、`EditFile` 只允许操作当前工作目录或 profile 目录内的文件，越界访问返回错误
- **安全项目目录**：在非核心目录（项目目录）工作时，文件写操作自动放行；家目录本身、系统路径、敏感隐藏目录仍需确认（详见[安全项目目录自动放行](#安全项目目录自动放行)）
- **注入扫描**：`NOTES.md`、`PROFILE.md`、recipe 文件注入前自动扫描 prompt injection 特征，命中则跳过注入并在 UI 中显示警告
- **命令拦截**：`RunCommand` 的危险命令黑名单在任何模式下强制确认
- **FTS5 安全**：搜索查询自动转义，防止 FTS5 语法注入
- **工具屏蔽**：通过 `permissions.disabled_tools` 可彻底从模型视野中移除指定工具
- **日志脱敏**：运行时警告通过 UI 事件流或 stderr 输出，不干扰终端 UI 渲染
