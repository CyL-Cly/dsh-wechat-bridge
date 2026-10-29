# dsh-wechat-bridge

用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）替换 [wechat-robot-client](https://github.com/hp0912/wechat-robot-client) **内置 AI 对话**，协议收发仍走闭源 `wechat-ipad`，客户端容器继续负责登录与发消息。

- GitHub：https://github.com/CyL-Cly/dsh-wechat-bridge
- home 推荐克隆（代理）：

```bash
git clone https://v6.gh-proxy.org/github.com/CyL-Cly/dsh-wechat-bridge.git /opt/dsh-wechat-bridge
```

```
微信 ←→ wechat-ipad ←→ wechat-robot-client
                              │ webhook（system_settings.webhook_url）
                              ▼
                     dsh-wechat-bridge  ←→  dsh --profile sdk（DeepSeekHarness）
                              │ POST /api/v1/robot/message/send/text
                              ▼
                     wechat-robot-client → wechat-ipad → 微信
```

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
- 各群/好友若单独开了 AI，一并关掉（否则会双回复）

绘图 / TTS / 拍一拍 / 欢迎等可继续用内置，不冲突。

### 2. 配置消息 Webhook

客户端同步到新消息后 `POST` 整包 `SyncMessage` 到 `system_settings.webhook_url`，并带上：

`?robot_id=&robot_code=&robot_wxid=`

（`service/message.go` → `MessageWebhook`）

```text
http://<bridge主机>:8787/webhook
# Docker 同网：
http://dsh-wechat-bridge:8787/webhook
```

可选 `webhook_headers`：`X-Bridge-Secret` = `BRIDGE_WEBHOOK_SECRET`。

### 3. 发消息 API

```http
POST {WECHAT_CLIENT_BASE_URL}/api/v1/robot/message/send/text
Content-Type: application/json

{"to_wxid":"<会话wxid>","content":"...","at":["群内发送者wxid"]}
```

---

## 构建运行

```bash
cp .env.example .env
npm install          # 核心：sdk-client；不强制装完整 dsh
npm run build
# 先通链路：
AGENT_MODE=echo npm start
# 真推理：
npm run install:dsh  # 可选依赖 @deepseek-ai/dsh（体积大）
# 或 DSH_BIN 指向源码构建产物
AGENT_MODE=sdk DEEPSEEK_API_KEY=sk-... npm start
```

健康检查：`GET /health`  
冒烟：`./scripts/smoke-echo.sh`

### 环境变量（摘要）

| 变量 | 说明 |
|------|------|
| `BRIDGE_PORT` | 默认 `8787` |
| `BRIDGE_WEBHOOK_SECRET` | 可选 |
| `WECHAT_CLIENT_BASE_URL` | 如 `http://127.0.0.1:9001` 或 `http://client_<CODE>:9001` |
| `AGENT_MODE` | `sdk`（默认）或 `echo` |
| `DSH_BIN` | 本地 dsh；空则解析 npm `@deepseek-ai/dsh` |
| `DSH_HOME` / `DSH_PROFILE` | 默认 `./.dsh-home` / `sdk` |
| `DSH_PROVIDER` / `DSH_MODEL` | 如 `deepseek-official` / `deepseek-v4-flash` |
| `DEEPSEEK_API_KEY` | sdk 模式必需 |
| `AI_TRIGGER` | 群聊触发前缀；空=群也全量 |
| `SESSION_SCOPE` | `chat_sender`（默认）或 `chat` |

详见 `.env.example`。

---

## 部署到 home（`/opt`）

```bash
git clone https://v6.gh-proxy.org/github.com/CyL-Cly/dsh-wechat-bridge.git /opt/dsh-wechat-bridge
cd /opt/dsh-wechat-bridge
cp .env.example .env
# 编辑 WECHAT_CLIENT_BASE_URL、DEEPSEEK_API_KEY、AI_TRIGGER 等
npm ci && npm run build
# 需要 sdk 模式时：
npm run install:dsh
# 参考 deploy/docker-compose.snippet.yml 挂进 wechat 网络
# 后台：关 chat_ai_enabled；webhook_url → http://dsh-wechat-bridge:8787/webhook
```

现有栈通常在 `/opt/wechat-robot-client`。

---

## 与 deepseek-harness 源码的关系

本仓库是 **sibling HTTP bridge**（推荐部署单元），不是整仓 fork 推送。

本地 box 另有浅克隆 `/workspace/deepseek-harness`（分支 `wechat-bridge` + `WECHAT.md`），可选作 `DSH_BIN` 源。`plugin/` 是 Cordis 占位，默认可不启用。

---

## 目录

```
src/           HTTP webhook + dsh SDK + 发消息
plugin/        可选 Cordis 脚手架
deploy/        compose 片段
scripts/       echo 冒烟
```

---

## 已知限制 / 阻塞

1. **`AGENT_MODE=sdk`** 需要 `DEEPSEEK_API_KEY`（或 dsh credentials）+ 可解析的 `dsh`（`npm run install:dsh` 或 `DSH_BIN`）。  
2. **home Docker 组网 / 关内置 AI** 需在目标机操作（本仓库只提供步骤与 compose 片段）。  
3. **`@deepseek-ai/dsh` 可选依赖** 树很大；内存紧时先 `AGENT_MODE=echo` 通 webhook→发消息。  
4. 目前只处理文本（`TEXT_ONLY=true`）；图片/语音未接入。  
5. 上游 dsh 仍处开发者预览，API 可能破坏性变更。

---

## 许可

桥接代码 MIT。DeepSeek Harness / wechat-robot-client 遵循各自上游；`wechat-ipad` 闭源。
