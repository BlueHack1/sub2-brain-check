# Sub2 OpenAI 账号测试源码与当前实现

参考仓库：`Wei-Shaw/sub2api`，2026-10-16 核对 main 提交 `455d317d6a87d8519a52c8769a0727824c403171`。结论来自源码，当前项目只保留 OpenAI。

## 官方流程

```text
点击测试连接
→ POST /api/v1/admin/accounts/{id}/test
→ 后端从数据库读取账号凭据、能力设置、代理与请求头覆写
→ 按 API Key / OAuth 构造上游请求
→ 解析上游 SSE
→ 输出统一 test_start / content / error / test_complete 事件
→ 前端拼接 content.text，收到完成事件后显示结果
```

源码：[前端组件](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/frontend/src/components/admin/account/AccountTestModal.vue)、[OpenAI 测试服务](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/service/account_test_service.go#L799)、[管理员认证](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/server/middleware/admin_auth.go)。

## 凭据与上游请求

两类账号都可用管理员 `x-api-key` 调用 `GET /api/v1/admin/accounts/data?ids={id}&include_proxies=true` 获取现有凭据。普通账号列表与凭据导出是两个不同接口，前者不能代替后者。

| 项目 | API Key | OAuth |
| --- | --- | --- |
| 凭据字段 | `credentials.api_key`、`base_url` | `credentials.access_token`、`chatgpt_account_id` |
| 默认上游 | `https://api.openai.com` | `https://chatgpt.com/backend-api/codex/responses` |
| 协议 | 按账号能力选择 Responses / Chat Completions | Responses |
| 认证 | `Authorization: Bearer ...` | `Authorization: Bearer ...` |
| 请求参数 | 官方完整 instructions，不额外限制 max tokens | 官方完整 instructions、`store:false`，不发 `max_output_tokens` |
| 账号与身份头 | Responses 携带 Codex 身份、OpenAI-Beta、随机 X-Codex-Window-ID；Chat Completions 不补 Codex 身份 | 配套 UA、originator、version，`OpenAI-Beta`、账号 ID，按需 FedRAMP 头 |

API Key 协议遵循 `extra.openai_responses_mode` 和 `openai_responses_supported`。两种类型均应用账号代理和模型映射（精确或最长的末尾 `*` 匹配），OAuth 在映射后按官方规则归一化 Codex 模型别名。账号请求头覆写仅对 API Key 生效，过滤认证、账号 ID、连接控制等保护头，并在最终发送前应用；OAuth 不应用这组覆盖，但支持账号自定义 UA。

源码：[能力设置](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/pkg/openai_compat/upstream_capability.go)、[身份解析](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/service/openai_codex_identity.go)、[账号头](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/service/openai_chatgpt_headers.go)。

当前已移除旧的固定客户端版本。检测 Responses 时，用同一管理员 Key 读取 `GET /api/v1/admin/settings`，仅保留以下三个字符串字段：

- `openai_codex_client_version`：面板手动指定版本，优先。
- `openai_codex_client_version_synced`：Sub2 自动同步版本，手动值未配置或非法时采用。
- `openai_codex_user_agent`：面板全局 UA，保留有效官方客户端名和平台后缀，重建版本。

版本无有效配置时使用本次官方源码内置 `0.146.0`，默认 originator 为 `codex-tui`；低于 `0.144.0` 时按官方门槛回退到内置版本。账号自定义 UA 仅贡献官方客户端名、OS/架构/终端，头部和尾部的版本声明统一重建。非法 UA 回退到规范身份。UA、originator 和 version 保持配套。

设置缓存 60 秒，并发检测共用读取；账号列表刷新会使缓存过期，下次检测重读。设置读取最多 5 秒，失败时使用上次设置或官方内置值，并在页面显示原因；首次失败时无法保证与远端的实际版本相同。只读设置，不修改远端，不独立跟随 Codex 发布。官方版本自动同步默认开启，启动及每 6 小时查询稳定发布；直接读取站点设置能避免本项目与站点选择不同版本。

依据：[版本设置优先级](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/service/setting_gateway_runtime.go)、[版本同步服务](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/service/openai_codex_version_sync_service.go)、[默认版本常量](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/service/openai_gateway_service.go)、[请求头覆写适用范围](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/service/account_header_override.go)。

两者分别使用 Go 和 Node 的网络传输实现，不保证原生握手、HTTP 版本、连接池或头部在传输层的表现相同。

TLS 指纹功能不能泛化到 OpenAI：本提交 `Account.IsTLSFingerprintEnabled()` 明确只支持 Anthropic OAuth/SetupToken，OpenAI 直接返回 false。`ResolveTLSProfile()` 因而返回 nil，`DoWithTLS(..., nil)` 会退回普通 `Do()`。默认导入 OpenAI OAuth、仅绑定代理，不会启用这套 uTLS 指纹模拟。额外启用 OpenAI 出站插件属于另一条可配置路径，不在默认账号导入行为内。

依据：[平台与开关限制](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/service/account.go#L2410)、[普通传输回退](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/repository/http_upstream.go#L242)、[OpenAI 测试传输分支](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/service/openai_plugin_transport.go#L21)。

官方普通 Responses 测试固定发送 `hi`，不采用通用 prompt，也不提供推理强度设置。因此当前项目直接请求上游，使用十五题提示词和用户设置的推理强度，不调用官方 `/test`。

## 完整结果与错误

Responses 顺序拼接 `response.output_text.delta` 文本，兼容完成事件的完整输出；收到 `response.completed` 或 `response.done` 才可判定完整。提前 EOF、仅 `[DONE]`、`response.failed`、`response.incomplete` 和流内错误均属于检测异常，HTTP 200 不能单独代表成功。

Chat Completions 提取 `choices[0].delta.content`，兼容完整 message，以结束原因或 `[DONE]` 完成。输出被 `length` 或 `content_filter` 截断时作为异常处理。异常不会触发关闭调度。当前页面每两秒读取后端的队列与最终结果。

## 导出结构修复

官方 `DataAccount` 是便携备份对象，**没有账号 ID 和运行时 status**。原代码按导出对象 ID 查找，误报“不支持”。当前使用单 ID 查询关联唯一无 ID 对象；多条无 ID 对象或 ID 不匹配则明确失败。代理通过 `proxy_key` 关联。

源码：[导出结构与接口](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/handler/admin/account_data.go#L53)。Agent Identity 需要额外签名；影子账号不持凭据且被导出排除，当前应使用普通凭据账号或其父账号。

## 当前项目执行流程

```text
管理员 Key 获取 OpenAI 账号列表
→ 检测前导出 Sub2 当前保存的该账号凭据和代理
→ Responses 检测读取站点客户端设置，生成配套身份头
→ 本服务直接请求上游，发送十五题与推理强度
→ 收集完整响应并判定
→ degraded 时调用 POST /api/v1/admin/accounts/{id}/schedulable
   请求体：{"schedulable":false}
→ 确认返回的账号 ID 正确且 schedulable=false
→ 保存回复与关闭结果，在页面展示
```

不使用 refresh token、不主动刷新、不在 401 后自动重试。关闭调度失败或响应未确认时保留降智结果并明确显示操作失败。历史结果不会在启动时触发操作，后续检测通过也不会自动恢复调度。若本地已保存“启用定时检测”，服务重启后重新输入管理员 Key 会自动恢复定时检测；Key 缺失期间不会请求上游。

关闭调度源码：[路由](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/server/routes/admin.go#L410)、[SetSchedulable](https://github.com/Wei-Shaw/sub2api/blob/455d317d6a87d8519a52c8769a0727824c403171/backend/internal/handler/admin/account_handler.go#L2763)。

## 本次核对结论与范围

| 环节 | 当前实现与官方普通文本测试的关系 |
| --- | --- |
| 凭据 | 官方从库读取；本项目通过单账号导出读取现有凭据，不刷 Token |
| 上游请求 | OAuth 固定 Codex Responses 地址；API 按账号能力选择协议和 base_url |
| 版本与 UA | 跟随连接站点设置优先级，兼容全局和 OAuth 账号 UA，保留官方内置回退 |
| 负载 | Responses 采用官方完整 DefaultInstructions 和 OAuth store:false；将 hi 换成十五题，并加入所选推理强度 |
| 映射和覆盖 | 对齐精确/末尾通配符映射、OAuth 模型归一化、API Key 请求头覆盖与保护名单 |
| SSE | 都等待 Responses 完成事件；本项目额外把 incomplete、无文本、非法 JSON 作为异常，支持完成事件完整文本和非流 JSON 完成响应 |
| 前端 | 官方转发统一 SSE 到前端；本项目后端收集并判定，页面轮询队列与最终结果 |
| 账号副作用 | 官方会更新部分配额/能力信息，401 标记错误、429 对账；本项目仅在新完成结果判为降智时关闭调度，其他错误只报告 |
| 传输 | 使用导出账号代理；本机网络出口与 Sub2 服务器可能不同，Node 原生网络栈也不同 |

核对范围是默认 OpenAI 文本 API Key/OAuth。未复刻可选出站插件、Agent Identity、影子账号解析、图片/压缩测试，以及 OpenCode 等专门上游的会话头逻辑。普通代理可用，但不复制 Sub2 的代理过期回退策略。本次验证使用模拟 Sub2 和上游，未使用真实 OAuth Token 对上游执行探测，不能据此声称逐字节 1:1 或保证实网成功。
