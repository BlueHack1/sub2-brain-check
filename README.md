# Sub2 Degradation Monitor

从当前 Balance Monitor 项目抽出的独立降智检测项目，可单独复制整个目录、安装和运行。

## 启动

需要 Node.js 20.19 或更高版本，推荐 Node.js 22 LTS。

```powershell
cd E:\workspace\vscode\nodejs\balance-monitor\sub2-degradation-monitor
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:3100>。也可以双击 `start-local.bat`，首次使用会安装依赖并构建。

开发模式：`npm run dev`。测试：`npm test`。类型检查：`npm run type-check`。

## 使用

1. 连接信息与检测设置都在同一个检测页。输入 Sub2 站点地址和管理员 API Key，点击“获取账号”。成功后 Key 转存后端内存并清空输入框；如果之前保存的定时检测是开启状态，重新输入 Key 后会自动恢复后台检测。
2. 在账号管理中勾选需要检测的账号。可按名称或 ID 搜索，或筛选可检测账号。
3. 设置模型、推理强度、周期、并发、等待上限和超时，点击“保存检测设置”只保存检测参数。账号区实时显示“已选 N 个 / 已保存 M 个”。
4. 在账号区点击“保存并开始检测”会同时保存当前参数与勾选、立即执行一轮，然后按周期持续运行；“保存账号选择”只保存勾选；“立即检测已保存账号”只执行一轮。每行“检测”可单独测试。重新获取账号保留仍可检测的勾选，筛选列表的全选不会清除隐藏选择。取消“启用定时检测”并保存设置可暂停定时任务，保留 Key。
5. 队列显示等待、运行、完成、失败和取消状态；账号行“详情”可查看最近一次完整回复。

仅保留 OpenAI 的 API Key 和 OAuth 账号。检测前使用管理员 Key 从 Sub2 单账号导出接口读取当前凭据，随后由本服务直接请求上游，不调用 Sub2 的 `/test`。本服务不使用 refresh token、不调用刷新接口，也不在 401 后自动重试。

API Key 按账号能力设置选择 Responses 或 Chat Completions，使用配置的 HTTPS `base_url`；OAuth 参照 Sub2 源码请求 `https://chatgpt.com/backend-api/codex/responses`，携带 access token、ChatGPT 账号 ID、配套客户端身份头和 `store:false`。两者均发送十五题提示词和设置的推理强度，并应用模型映射和账号代理。账号自定义请求头仅对 API Key 生效，OAuth 不应用；OAuth 的账号自定义 UA 按官方身份配对规则处理。Agent Identity 签名账号和影子账号暂不支持。

Responses 检测使用管理员接口 `GET /api/v1/admin/settings` 读取连接站点的客户端设置，版本优先级为面板指定值 → Sub2 自动同步值 → 官方内置默认值，同时重建 UA、originator、version。设置缓存 60 秒，“重新获取账号”后下次检测重读；不会自行查询 Codex 发布版本或修改 Sub2 设置。设置接口不可用时保留上次设置，首次则使用本次核对源码的内置值 `0.146.0`，页面显示回退原因。低于官方最低版本门槛时也按官方规则回退。页面显示的是默认客户端，OAuth 账号的有效自定义 UA 可改变客户端名和平台后缀，版本仍跟随站点设置。

源码核对记录见 [流程对照](docs/sub2-official-account-test-flow.md)。默认 OpenAI OAuth 不启用 Sub2 的 Anthropic 专用 uTLS 功能；Node 与 Go 的原生传输不保证相同。

## 配置与执行行为

无需 MySQL、Redis 或原项目服务。每个 Sub2 站点的配置、账号选择和最近结果独立保存在 `data/<站点地址的 SHA-256>.json`。文件通过临时文件替换写入；每个账号只保留最近结果。队列在内存中运行，完成记录最多保留 10 分钟 / 200 条。

管理员 Key 和读取到的上游凭据仅保存在后端内存中，不写入配置文件、不返回给前端、不使用浏览器存储。点击“停止并清除 Key”会停止调度、取消等待与运行中的请求并清除凭据。关闭网页不影响已开启的后台检测，不再因 12 小时无访问而自动停止。服务进程退出或重启会清除内存中的 Key，需重新输入；如果本地已保存的定时开关为开启状态，重新输入 Key 后会自动恢复检测。浏览器控制会话 Cookie 有效期 30 天，Cookie 到期或清理不会清除后台 Key、停止已运行任务；重新输入有效 Key 可重新建立控制会话。

这是单管理员、单活动站点工具。同一个服务上再次登录会替换之前的会话。完整响应被判定为降智时，调用 `POST /api/v1/admin/accounts/{id}/schedulable`（`{"schedulable":false}`）关闭该账号在 Sub2 的调度；失败或未确认会明确显示。本工具不会自动恢复调度。

同一账号的等待或运行任务会去重。并发数与等待上限之和必须容纳所有勾选账号；超过等待上限的请求会明确拒绝。全量周期按每轮启动时间计算，上一轮仍在运行的账号不会重复提交。关闭定时开关会取消等待任务，已运行请求会完成；退出登录则中止全部请求。

## 检测判定

保留原项目的知识测试提示词与判定规则：Q01–Q15 都有非空答案，且答案不为“不清楚”时显示“通过”；缺题或回答“不清楚”时显示“疑似降智”。HTTP、网络、超时和响应错误显示“检测异常”。**此规则只判断回答完整性，不核验答案事实正确性，也不能证明模型的真实身份。**

必须收到协议完成信号才执行判定。Responses 提前 EOF、`[DONE]`、失败或未完成事件，以及 Chat Completions 截断，都作为检测异常处理，不触发关闭调度。

## 可选环境变量

复制 `.env.example` 为 `.env` 后按需设置。本项目从自己的工作目录读取 `.env`，不会读取原项目配置。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `3100` | 服务端口 |
| `DATA_DIR` | `./data` | 配置和结果目录 |
| `UPSTREAM_PROXY_URL` | 空 | 显式设置时作为 Sub2 与上游请求的统一 HTTP 代理，优先于账号代理；留空时检测使用账号的 HTTP/HTTPS/SOCKS 代理 |
| `COOKIE_SECURE` | `false` | 使用 HTTPS 部署时设置为 `true` |

前端静态页面与 API 由同一个 Fastify 服务提供。远程访问可通过 HTTPS 反向代理到此服务，保留原始 `Host` 请求头。

## 目录和来源

```text
src/app.ts                 登录会话、配置和检测 API
src/monitor.ts             账号选择、定时调度与生命周期
src/queue.ts               有界 FIFO 队列、并发限制与账号去重
src/settings.ts            原项目的设置默认值、范围与容量校验
src/assessment.ts          原项目的降智提示词与回答判定
src/probe.ts               从原项目提取的 Responses / Chat Completions 检测
src/first-text-parser.ts   原项目的响应解析器
src/upstream.ts            独立 Sub2 管理员 Key 客户端
src/store.ts               本地配置与最近检测结果
public/                    登录、账号、设置、队列与检测详情页面
test/                      使用模拟 Sub2 / 模型接口验证流程
```

提取来源为原项目 `backend/src/upstream/first-text.ts`、`first-text-parser.ts` 以及 `backend/src/accounts/degradation-check-*`；登录、存储和页面已适配为独立项目。运行时不引用原项目代码或凭据。
