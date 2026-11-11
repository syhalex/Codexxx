# Codexxx

在 Windows 上集中管理 Codex 和 Antigravity 的登录、额度、中转与会话。

## Windows 下载版

从 [GitHub Releases](https://github.com/syhalex/Codexxx/releases/latest) 下载 `Codexxx-win-x64.zip`，完整解压后双击 `Codexxx.exe`。下载包内含 Node.js 24，桌面窗口使用 Microsoft Edge WebView2 Evergreen Runtime。系统缺少 WebView2 时，启动器会提供微软的官方下载入口。

从页面标题旁可直达 Codex 和 Antigravity 的账号详情。账号、额度、会话和中转状态来自本机工作区。

### 从源码构建

安装 Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载和 Windows SDK，然后在项目目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\desktop\build.ps1`。构建脚本会校验依赖并在 `output` 中生成 Windows x64 ZIP。构建后也可以在源码目录使用 Node.js 24 或更新版本运行 `npm start`，通过 `http://127.0.0.1:4812` 打开浏览器界面。

## 账号

在客户端完成登录后，选择「导入账号」和「当前客户端登录」。也可以导入凭据 JSON 或官方平台 API 密钥。导入订阅登录后，工作台会立即查询额度。

| 平台 | 客户端登录来源 | 额度 | 本地中转 |
| --- | --- | --- | --- |
| Codex | Codex 文件模式的 `auth.json` | 订阅窗口 | Responses 支持登录或 OpenAI API 密钥，Chat Completions 使用 OpenAI API 密钥 |
| Antigravity | Windows 凭据管理器中的共享登录和桌面端回退文件 | 模型窗口 | Gemini GenerateContent 和流式接口，支持共享登录或 Gemini API 密钥 |

登录不同账号后分别导入，即可在首页的平台卡片或账号详情中切换。切号前关闭使用同一份登录的客户端和终端，完成后重新打开。工作台会保存当前登录，必要时续期目标账号，并在核对写入的凭据后更新当前账号。

Codex 切号支持 `auth.json` 文件模式，并检查 `config.toml` 中的登录方式。Antigravity 切号会同步 Windows 系统凭据、桌面回退文件和已初始化的 `agy` 登录；当前账号可从详情页重新同步。Antigravity 登录续期需要签发该凭据的 OAuth 客户端配置。可以通过导入 JSON 提供 `client_id` 和 `client_secret`，或在本机启动环境中设置 `LOCAL_WORKSPACE_GOOGLE_CLIENT_ID` 和 `LOCAL_WORKSPACE_GOOGLE_CLIENT_SECRET`。没有这组配置时，可以在客户端重新登录后再导入。

账号详情提供终端启动、标签、切换、额度刷新、导出和回收站。终端启动要求对应 CLI 在 `PATH` 中，订阅账号会先切换本机客户端登录。账号资料导出默认只包含资料，选择含登录凭据的 JSON 可用于恢复登录。移入回收站后可恢复账号资料和凭据。

## 额度

额度条和百分比按剩余量统一着色，低于 25% 显示黄色。Codex 按上游返回的时长命名各窗口。Antigravity 将 Claude、Gemini 和 Gemini 4 Argon 的共享窗口、模型明细以及 AI 积分分开展示，按账号实际返回的数据填充。

工作台运行时会在启动后检查订阅账号额度，并约每 30 分钟刷新一次。打开「唤醒模型」时读取当前账号的可选模型。新模型会在平台向该账号开放后出现在菜单中，有额度数据的模型也会出现在额度明细中。

「唤醒模型」加载所选账号的模型目录，选择后发送一次短测试请求，成功后刷新订阅额度。Antigravity 订阅账号按客户端菜单读取模型，并使用桌面应用附带的 Language Server 唤醒。Gemini API 密钥账号通过 Gemini API 唤醒。

Codex 登录账号的首页卡片和账号详情显示订阅有效期。可用卡片上的刷新图标查询当前工作区的订阅状态。

## API 服务

1. 在「API 服务」的账号池勾选需要加入的账号，可以同时选择多个 Codex 账号。保存后在服务连接区启动服务。
2. 为客户端填入页面上的 Base URL 和 API 密钥。Codex 和 Gemini 客户端的接口路径可在「请求端点」查看。鉴权支持 `Authorization: Bearer <密钥>`、`x-api-key` 和 `x-goog-api-key`。
3. 请求记录自动刷新，显示实际使用的账号、上游状态、耗时，以及尝试过的其他账号。

服务监听 `127.0.0.1`。Codex 登录账号使用带完整输入上下文的 HTTP 流式 Responses。新会话默认轮询，也可选择优先使用近期查询到的剩余额度较高的 Codex 账号。携带会话标识时优先复用原账号。上游在输出前返回 HTTP 401 或 429 时，符合条件的请求可尝试池中其他成员，单次请求最多尝试三个账号。引用已存储内容或携带账号绑定加密上下文的请求沿用原账号。

## 会话

会话按工作目录分组，项目默认折叠。可以搜索、置顶、改名、归档、导出 JSON 或复制继续会话的命令。置顶、改名和归档记录保存在工作台。Codex 和带有 JSONL 日志的 Antigravity 会话可预览文本消息。仅有二进制记录的 Antigravity 会话提供摘要和继续命令。

会话用量按请求时间汇总近 24 小时、7 天或 30 天的本机记录。输入含缓存命中，合计含输入和输出。Antigravity 从本机会话数据库读取各请求的模型和 Token，旧会话可使用文本日志。工作台每日同步 LiteLLM 的公开 API 费率，用当前费率重新估算本机记录。同步失败时沿用上次成功的费率，内置参考费率覆盖部分历史模型。缺少模型或费率的请求会标为未计价。[LiteLLM 费率目录](https://docs.litellm.ai/docs/proxy/model_cost_map)

## 2FA

在首页或账号页打开「2FA 管理」，输入 Base32 密钥或粘贴 TOTP 验证器链接。可搜索、编辑、删除条目和复制当前验证码。使用单独的备份口令导出加密 JSON，或将备份导入另一份工作台。

凭据和工作台配置保存在 `%LOCALAPPDATA%\LocalWorkspace`，由 Windows 当前用户的 DPAPI 保护。可通过 `LOCAL_WORKSPACE_DATA` 自定义数据目录，通过 `LOCAL_WORKSPACE_PORT` 自定义工作台端口。

功能参考 [Cockpit Tools](https://github.com/jlcodes99/cockpit-tools)。界面参考 [WhereIsMyTime](https://github.com/syhalex/where-is-my-time)。

平台图标来源为 [Codex 桌面应用原始图标存档](https://github.com/backnotprop/orchestrator/blob/main/assets/providers/README.md)和 [Google Antigravity 媒体资源](https://antigravity.google/press)。
