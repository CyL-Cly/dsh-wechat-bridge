# dsh-wechat-bridge

用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）替换 [wechat-robot-client](https://github.com/hp0912/wechat-robot-client) **内置 AI 对话**，协议收发仍走闭源 `wechat-ipad`，客户端容器继续负责登录与发消息。

```
微信 ←→ wechat-ipad ←→ wechat-robot-client
                              │ webhook（system_settings.webhook_url）
                              ▼
                     dsh-wechat-bridge  ←→  dsh --profile sdk（DeepSeekHarness）
                              │ POST /api/v1/robot/message/send/text
                              ▼
                     wechat-robot-client → wechat-ipad → 微信
```

本仓库是 **本地适配 fork / sibling**，尚未推 GitHub（需授权后再 `git remote add` 推送）。

---

## 目的

| 能力 | 谁负责 |
|------|--------|
| 收消息 / 发消息 / 扫码登录 | wechat-robot-client + wechat-ipad |
| Agent 推理、工具、会话 | DeepSeek Harness（SDK profile） |
| 入站过滤、会话映射、回写 | **本 bridge** |

---

## 关闭内置 AI，切到 bridge

内置路径：`startup/plugin.go` → `FriendAIChat` / `ChatRoomAIChat` → `AIChatPlugin` → `AgentService.ChatWithTools`。  
开关是全局/群设置里的 **`chat_ai_enabled`**（见 `model/global_settings.go`）。

### 1. 管理后台关掉内置聊天 AI

- 全局设置：`chat_ai_enabled = false`
- 各群/好友若单独开了 AI，一并关掉  
  （否则内置插件与 bridge 会双回复）

绘图 / TTS / 拍一拍 / 欢迎等可继续用内置，不冲突。

### 2. 配置消息 Webhook

客户端会在同步到新消息后 `POST` 整包 `SyncMessage` 到 `system_settings.webhook_url`，并自动带上：

`?robot_id=&robot_code=&robot_wxid=`

（实现：`service/message.go` → `MessageWebhook`）

把 URL 设为 bridge：

```text
http://<bridge主机>:8787/webhook
```

同 Docker 网络示例：

```text
http://dsh-wechat-bridge:8787/webhook
```

可选在 `webhook_headers` 里加 `X-Bridge-Secret: <同 BRIDGE_WEBHOOK_SECRET>`。

### 3. 确认发消息 API

bridge 回写：

```http
POST {WECHAT_CLIENT_BASE_URL}/api/v1/robot/message/send/text
Content-Type: application/json

{"to_wxid":"<会话wxid>","content":"...","at":["群内发送者wxid"]}
```

对应 `router`：`/api/v1/robot/message/send/text`。

---

## 在本机（box）构建运行

```bash
cd /workspace/dsh-wechat-bridge
cp .env.example .env
# 先联调可 AGENT_MODE=echo（不拉 dsh）
pnpm install   # 或 npm install
pnpm run build
pnpm start
# 开发：pnpm dev
```

健康检查：`GET http://127.0.0.1:8787/health`  
冒烟：`./scripts/smoke-echo.sh`

### 环境变量（摘要）

| 变量 | 说明 |
|------|------|
| `BRIDGE_PORT` | 默认 `8787` |
| `BRIDGE_WEBHOOK_SECRET` | 可选，校验 webhook header |
| `WECHAT_CLIENT_BASE_URL` | 客户端根地址，如 `http://127.0.0.1:9001` |
| `AGENT_MODE` | `sdk`（默认）或 `echo` |
| `DSH_BIN` | 本地 `dsh` 可执行；空则用 npm `@deepseek-ai/dsh` |
| `DSH_HOME` | harness 数据目录 |
| `DSH_PROFILE` | 默认 `sdk` |
| `DSH_PROVIDER` / `DSH_MODEL` | 如 `deepseek-official` / `deepseek-v4-flash` |
| `DEEPSEEK_API_KEY` | 模型密钥 |
| `AI_TRIGGER` | 群聊触发前缀；空=群也全量（不推荐） |
| `SESSION_SCOPE` | `chat_sender`（默认）或 `chat` |

完整列表见 `.env.example`。

---

## 与 `/workspace/deepseek-harness` 的关系

| 路径 | 角色 |
|------|------|
| `/workspace/deepseek-harness` | 上游浅克隆，本地分支 `wechat-bridge`，见其 `WECHAT.md` |
| `/workspace/dsh-wechat-bridge` | **推荐部署单元**：HTTP + SDK 客户端 |
| `plugin/` | Cordis 占位插件，默认可不启用 |

源码构建 dsh（可选，磁盘/内存够时）：

```bash
cd /workspace/deepseek-harness
pnpm install && pnpm run build
# 然后在 bridge .env：
# DSH_BIN=/workspace/deepseek-harness/apps/cli/... 或 node 入口
```

box 上整仓 install 较重（依赖多、内存吃紧），联调优先用 npm 预构建包 + `AGENT_MODE=echo` 测通道。

---

## 拷到 home（`/opt`）

在 **用户明确授权 SSH 操作之后**（本轮只在 box 改）：

```bash
# 示例
rsync -av --exclude node_modules --exclude .dsh-home \
  /workspace/dsh-wechat-bridge/ home:/opt/dsh-wechat-bridge/
# home 上：
cd /opt/dsh-wechat-bridge && cp .env.example .env && npm ci && npm run build
# 按 deploy/docker-compose.snippet.yml 挂进现有网络
# 管理后台：关 chat_ai_enabled；webhook_url → http://dsh-wechat-bridge:8787/webhook
```

现有部署根目录通常是 `/opt/wechat-robot-client`（含 client/server 容器）。

---

## 目录

```
src/           HTTP webhook + dsh SDK + 发消息
plugin/        可选 Cordis 插件脚手架
deploy/        compose 片段
scripts/       echo 冒烟
```

---

## 阻塞项

1. **GitHub fork 推送**：当前未授权 `cursor-github`；仓库已 `git init`，可稍后加 remote 推送。  
2. **DEEPSEEK_API_KEY / dsh credentials**：`AGENT_MODE=sdk` 必需。  
3. **home 拷贝与 Docker 组网**：需用户批准 SSH/不可逆部署后再做。  
4. **整仓 dsh `pnpm install`**：box 可用内存偏低时建议跳过，用 npm 发行版 `dsh`。  
5. 群聊触发词、会话隔离、多机器人多端口：按 `.env` 调；图片/语音入站未做（`TEXT_ONLY=true`）。

---

## 许可

桥接代码 MIT（可自定）。DeepSeek Harness / wechat-robot-client 遵循各自上游许可；`wechat-ipad` 闭源。
