# Issue #001: Codex 客户端对话持续处于“思考中”且无回馈（下游未运行导致网关长超时 500）

- **状态**: 已关闭 / 已定位并修复 (Resolved / Documented)
- **触发时间**: 2026-09-20 19:55:21 ~ 20:04:36 (Asia/Shanghai)
- **影响组件**: Codex 桌面客户端、NewAPI 聚合网关、Taiji API 本地服务
- **涉及模型**: `openai::gpt-6-astra`

---

## 一、现象描述 (Symptoms)

1. 用户在 Codex 桌面端（Codex Desktop 26.915.31945）测试与模型 `openai::gpt-6-astra` 对话（测试用例包含“*对话测试，测试随机工具调用*”和“*你好*”）。
2. 发送消息后，Codex 界面长期显示“**思考中…**”，没有任何流式文本或阶段性回馈。
3. 持续等待约 **5.5 分钟（330 秒）** 后请求终止失败，界面未收到任何有效回答。

---

## 二、架构调用链路 (Architecture Path)

```text
[Codex Desktop 客户端]
        │
        ▼ (POST /v1/responses, wire_api=responses)
[NewAPI 聚合网关 (192.168.8.11:3001)]
        │
        ▼ (TCP / HTTP POST /v1/chat/completions)
[Taiji API 本地中转服务 (192.168.8.116:3000)]
        │
        ▼ (HTTPS Stream / Web Session)
[太极 Web 平台上游]
```

---

## 三、根本原因深度分析 (Root Cause Analysis)

### 1. 本地 Taiji API 服务因导出异常退出且未运行
- **本地服务状态**：检查系统端口与进程，3000 端口未处于监听状态。
- **本地日志停止**：`data/logs.json` 最新一条请求记录停留在 `19:49:39`（19:49:21 有一次耗时 6.6 秒的请求正常完成），之后无任何流量打入。
- **启动异常根源**：此前代码在更新工具桥接模块时，`src/tool-bridge.js` 遗漏了 `validateToolHistory` 的导出，导致模块加载时抛出 `SyntaxError`，服务停止后无法正常重启。

### 2. 跨主机网络防火墙静默丢包（DROP），导致握手无响应
- NewAPI 位于局域网 `192.168.8.11`，Taiji API 服务位于本地 `192.168.8.116`。
- 本地 3000 端口无服务监听时，Windows 防火墙对局域网入站 SYN 数据包默认采取**静默丢弃（DROP）**策略，而不是立即返回 TCP RST（ECONNREFUSED）。
- 发送方 NewAPI 的 TCP 协议栈误以为网络丢包，进行指数退避重传，TCP 握手持续挂起。

### 3. 网关超时与错误码封装（5.5 分钟 500 报错）
- NewAPI 的 HTTP Client 在与下游建连等待满额后触发超时（默认 300 秒超时限制加上重试/退避缓冲，总计耗时约 330 秒）。
- 超时后，NewAPI 将下游超时错误统一封装为 `HTTP 500 Internal Server Error`，并通过 SSE 错误报文返回给调用方 Codex。
- **时间线取证**（来自 `~/.codex/logs_2.sqlite`）：
  - **请求 1**：`19:55:22` 发起 $\rightarrow$ `20:00:53` 收到 500 响应，总耗时 **331 秒**。
    `Request completed method=POST url=http://192.168.8.11:3001/v1/responses status=500 Internal Server Error, x-oneapi-request-id=202609201155223912236018268d9d626mYKmB9`
  - **请求 2**：`19:59:06` 发起 $\rightarrow$ `20:04:36` 收到 500 响应，总耗时 **330 秒**。
    `Request completed method=POST url=http://192.168.8.11:3001/v1/responses status=500 Internal Server Error, x-oneapi-request-id=202609201159061585149498268d9d68TwQvPj8`

### 4. 客户端流式状态机表现为“一直思考中”
- Codex 使用 SSE 长连接。在接收到 HTTP 状态行/首个数据块（Chunk）之前，连接维持在挂起状态。
- Codex 前端将“连接已建立但未收到首个 Token”的状态渲染为“**思考中…**”。
- 因而在这长达 5.5 分钟的超时等待期间，用户直观看到的就是“一直思考中”。等 5.5 分钟后连接以 500 终止，仍没有生成任何文本。

### 5. 模型原生能力限制（Function Calling / Tools）
- 测试用例尝试调用工具，但根据 `data/tests.json` 的实测报告，上游平台对 `openai::gpt-6-astra` **不支持原生 OpenAI Function Calling**。
- 本地即使启用实验性文本 Prompt 桥接（`EXPERIMENTAL_TOOL_BRIDGE`），也只能以整段缓冲（buffered）形式返回，无法稳定支持 Codex 的原生 Agent 工具调度。

---

## 四、解决方案与验证 (Resolution & Verification)

1. **代码修复与验证**：
   - 补齐 `src/tool-bridge.js` 中的函数导出，完善类型与格式校验。
   - 运行单元测试验证：
     ```bash
     npm test
     ```
     `33 pass / 0 fail` 全部通过，语法校验 `node --check src/index.js` 正常。
2. **服务重启**：
   - 重新启动服务：`npm start`，确保控制台输出：
     `Taiji API listening on 0.0.0.0:3000`
   - 验证健康检查接口：
     ```bash
     curl http://127.0.0.1:3000/healthz
     # 返回: {"status":"ok","version":"0.2.0"}
     ```
3. **运维与使用建议**：
   - **快速失败（Fail-Fast）**：建议在 NewAPI 渠道配置中调低该渠道的请求超时时间（如缩短至 60 秒），当下游离线时尽快报错，避免客户端长时间悬挂。
   - **模型用途约束**：`openai::gpt-6-astra` 仅可用于普通文本问答测试，严禁将其配置为 Codex 的主要编码或原生工具执行智能体（Agent）后端。
