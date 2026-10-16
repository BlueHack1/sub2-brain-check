# Sub2 Brain Check

Sub2 降智检测工具。项目从原有 Balance Monitor 中抽取为独立 Node.js 服务，用 Sub2 管理员 API Key 获取账号和当前凭据，再由本服务直接请求 OpenAI 上游，判断账号返回是否完整，并在发现降智时关闭该账号的 Sub2 调度。

## 功能

- 支持 OpenAI API Key 和 OpenAI OAuth 账号。
- 只保留 GPT 检测模型，可配置推理强度、检测周期、并发数、等待队列上限和超时。
- 通过管理员 Key 获取账号列表和账号当前凭据。
- API Key 按账号能力选择 Responses 或 Chat Completions 请求。
- OAuth 按 Sub2 使用的 Codex 请求方式访问上游，使用当前 access token、账号 ID、客户端身份和 `store: false`。
- 不调用 Sub2 的测试接口，不主动刷新 OAuth token，也不在 401 后自动重试；下一轮检测会重新从管理员接口读取凭据。
- 检测结果沿用原项目的 15 个问题和判定规则：回答完整且不含“没看清楚”等不确定回答为通过，缺题或不确定回答为疑似降智。
- 检测结果为降智时，调用 Sub2 管理员接口关闭该账号调度，并在页面显示关闭结果。
- 页面关闭后后台检测继续运行；Node 服务重启后 Key 会清除，重新输入有效 Key 后会按本地保存的启用状态自动恢复。
- 同一账号的等待或运行任务不会重复入队，队列有并发限制、容量限制、取消和历史清理。

## 快速开始

需要 Node.js 20.19 或更高版本，推荐 Node.js 22 LTS。

```powershell
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:3100>，填写 Sub2 地址和管理员 API Key，点击“获取账号”。也可以直接运行 `start-local.bat`。

开发模式：

```powershell
npm run dev
```

验证项目：

```powershell
npm test
npm run type-check
```

## 使用流程

1. 在检测页填写 Sub2 地址和管理员 Key，获取账号列表。
2. 勾选需要检测的账号。页面会显示当前勾选数量和已保存数量。
3. 在降智设置中选择模型、推理强度、周期、并发和超时，点击“保存检测设置”。该按钮只保存检测参数。
4. 在账号区域点击“保存并开始检测”，保存当前账号选择并立即执行一轮检测；之后按周期自动执行。
5. “保存账号选择”只保存勾选；“立即检测已保存账号”只执行一轮，不改变定时开关。
6. 点击“停止并清除 Key”会停止调度、取消等待任务并清除后端内存中的凭据。

## 配置

复制 `.env.example` 为 `.env` 后按需修改：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `3100` | 服务端口 |
| `DATA_DIR` | `./data` | 本地配置和结果目录 |
| `UPSTREAM_PROXY_URL` | 空 | 统一上游代理，可使用 HTTP、HTTPS 或 SOCKS 代理 |
| `COOKIE_SECURE` | `false` | HTTPS 部署时设置为 `true` |

## 数据和凭据

每个 Sub2 地址对应一个 `data/<地址 SHA-256>.json` 文件，保存检测设置、账号选择和最近检测结果。目录权限为 700，文件权限为 600，并使用临时文件替换写入。

管理员 Key、Sub2 返回的 API Key、OAuth access token 和其他上游凭据只保存在后端进程内存中，不写入配置文件、不放入浏览器存储，也不会返回给前端。Node 服务退出或重启后需要重新输入管理员 Key。

## 检测和队列规则

每一轮开始时先通过管理员接口刷新账号列表，再为选中的可检测账号读取当前凭据并入队。刷新由 Sub2 负责，工具本身不会调用 token 刷新接口。

队列采用有界 FIFO：同一账号存在等待或运行任务时直接复用已有任务；超过等待上限的任务会被拒绝；停止定时检测会取消等待任务，正在执行的请求会完成或被服务关闭中止。完成记录最多保留 10 分钟或 200 条。

## 项目结构

```text
src/app.ts                 登录会话、HTTP API 和静态页面
src/monitor.ts             账号刷新、定时调度和检测生命周期
src/queue.ts               并发限制、账号去重和等待队列
src/settings.ts            设置默认值和校验
src/assessment.ts          降智检测问题和判定规则
src/probe.ts               Responses / Chat Completions 检测请求
src/upstream.ts            Sub2 管理员 API 和账号凭据读取
src/store.ts               本地设置与检测结果存储
public/                    页面、脚本和样式
test/                      API、队列、OAuth 和前端状态测试
docs/                      Sub2 官方账号测试流程对照记录
```

## 安全边界

本工具面向单管理员、单活跃 Sub2 站点使用。管理员 Key 只用于读取账号和凭据，以及在降智后关闭账号调度；工具不会自动恢复已关闭的账号调度，也不会把凭据提交到第三方服务。通过 HTTPS 反向代理对外提供服务时，应启用 `COOKIE_SECURE=true` 并限制访问来源。

