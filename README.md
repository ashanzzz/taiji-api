# Taiji API

Node.js 24 后端、管理前端、OpenAI 风格中转接口，以及有预算的模型能力测试。
只使用你自己的授权账号。不提取站点后台密钥，不绕过验证码、额度或权限。

## 快速启动

1. 安装 Node.js 24。
2. 复制 `.env.example` 为 `.env`。
3. 分别生成 `PROXY_API_KEY` 和 `ADMIN_KEY`。不要使用相同密钥。
4. 运行 `npm test` 和 `npm start`。
5. 打开本机 3000 端口的管理页面，使用 `ADMIN_KEY` 登录。
6. 在设置页填写太极账号密码，保存后加载模型。

生成随机密钥：

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

如果未设置 ADMIN_KEY，服务会生成 `data/auth.json`。只在本机读取该文件。
管理登录与太极账号登录是两件事。NewAPI 密钥不能访问管理接口。

## 功能

- 管理页：服务概览、模型目录、流式调试、能力测试、设置、日志。
- 支持从稳定入口发现实际域名，并可配置实际域名覆盖和默认模型。
- 新域名必须加入受信任主机列表后，服务才会发送账号凭证。
- 账号密码由 AES-256-GCM 加密保存。密码不会从管理 API 返回。
- 只记录请求状态与测试指标，普通对话正文不会写入日志。
- 支持流式与非流式文本对话、base64 图片及 usage。
- 支持跨网络分块的 `<think>` 标签解析，输出 reasoning_content。
- 有预算的上下文、思考等级与输出参数测试，可取消并查看历史报告。
- 每天在 Asia/Shanghai 指定时段随机安排一次签到，重启后保留计划。
- GitHub Actions 自动测试、容器冒烟测试、构建 amd64/arm64 镜像并推送 GHCR。

## NewAPI 接入

渠道使用 OpenAI 类型。Base URL 填本服务地址，不追加 `/v1`。
密钥使用 PROXY_API_KEY。模型 ID 从 `/v1/models` 获取。
同一 Docker 网络内可使用 `http://taiji-adapter:3000`。

```sh
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_RELAY_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"openai::gpt-6-astra","messages":[{"role":"user","content":"只回复 OK"}],"stream":true,"stream_options":{"include_usage":true}}'
```

这是部分 OpenAI 风格兼容，不是完整协议实现。详见 `docs/API.md`。
如果 NewAPI 默认附带 max_tokens，请移除该参数。本服务明确拒绝未经验证的输出上限参数。

## 能力测试的含义

上下文测试使用随机内容和三个不同位置的随机标记，逐档测试。
界面中的输入规模按字符计数。平台返回的 tokens 单独列出，未做独立核验。
测试成功只建立下限。失败可能来自站点、账号、路由、超时或模型。
不要将平台显示名称当作底层模型身份保证。

思考测试分开记录平台声明、参数接受结果及可见 think 标签。
参数被接受不代表内部推理等级生效。耗时和正文解释也不能证明。

输出测试检查候选 max_tokens 字段。当前实测没有证明它能控制输出上限。
因此正式接口不会悄悄忽略该参数，也不会虚构最大输出能力。
每个测试最多六次请求，单次三分钟，响应有字符安全上限。
测试可能消耗账号积分，必须在界面中确认后开始。

## Docker

在 `.env` 中配置密钥。账号可以在启动后从前端配置。

```sh
docker compose up -d --build
docker compose logs -f
```

默认只向本机开放端口。局域网部署时将 BIND_ADDRESS 改为宿主机局域网 IP。
NewAPI 和本服务在同一 Docker 网络时，无需对外暴露端口。
公网部署必须使用 HTTPS 反向代理，并设置 SECURE_COOKIES=true。
局域网 HTTP 会明文传输管理登录与表单数据，只应在受信任网络临时使用。

从私有 GHCR 拉取：

```sh
# 使用具有 read:packages 权限的凭证，交互输入。不要把凭证写入脚本。
docker login ghcr.io -u YOUR_GITHUB_USER
docker compose pull
docker compose up -d --no-build
```

数据保存在 taiji-data 卷。重建镜像不会删除数据。
不要运行 `docker compose down -v`，除非你明确要删除设置和测试记录。
仅部署一个副本。不要让多个进程共用同一数据目录。

## 签到

在设置中启用并设置随机时段。缺省为关闭，便于首次部署检查。
调度器先查当月记录，今天已签到时不再领取。
提交前记录当天尝试。失败、验证码或结果未知时，今天不自动重试。
如果电脑睡眠或服务关闭，错过整个时间窗口时安排下一天，不补发多次请求。
更换账号会重置本地签到状态，下一次仍会先查询网站记录。

## 安全与维护

- `.env`、`data/`、原始研究文件和日志均被 Git 与 Docker 构建上下文排除。
- master.key 与加密配置必须一起备份。加密不能保护已完全失陷的主机。
- 不要将运行数据放入公共同步盘。Windows 同步软件可能短暂锁文件。
- 不使用通配 CORS。管理 cookie 为 HttpOnly、SameSite=Strict。
- API 校验公开 HTTPS 目标，并固定已校验的 DNS 地址。
- 生成请求的网络错误不会自动重放，避免重复扣费。
- 原始网站模型列表不表示所有模型均已实测可用。
- 原密码曾出现在历史对话中，建议修改后从前端更新。

## 文档

- `docs/PLAN.md`：范围与验收计划。
- `docs/ARCHITECTURE.md`：模块职责与升级步骤。
- `docs/API.md`：接口与错误语义。
- `docs/TEST-RESULTS.md`：本次实测证据和未确认事项。
- `docs/UI.md`：界面设计与交互规范。
- `docs/OPERATIONS.md`：部署、备份、恢复与回滚。

## 验证

```sh
npm run check
npm test
```

单元与 HTTP 测试不需要太极账号，也不会产生上游消费。
`scripts/live-probes.mjs` 是显式选择的真实测试，会消耗账号额度。不要在 CI 自动运行。
