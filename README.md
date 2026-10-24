# dsh-ai-relay

让鲸鲸把活分给别的 AI：把 OpenAI 兼容的端点、Anthropic 的 Messages API、或者任何自建网关，变成 DSH 里的两个工具。

- `ai_ask` — 把一段自包含的提问发给外部模型，拿回答。可以挑 provider，也可以给 system prompt。
- `ai_list` — 看当前配了哪些路由、各自用哪个模型、有没有密钥（不吐密钥本身）。

## 它解决什么

DSH 自己的 Models 页管的是「**你**在输入框里选哪个模型跟你对话」。这个插件管的是另一件事：**鲸鲸在干活的时候，能不能顺手把某个子问题甩给另一个模型**——写文案、翻英文、做个第二意见、换个模型的视角挑错。

外部模型看不到当前会话，只能看到你传进去的那段 prompt。这不是缺陷，是设计：一次问答，账算得清，上下文不串味。

## 安装

```bash
# 在 DSH 的 profile 目录里
cd ~/.dsh/profiles/desktop
node pnpm.mjs add link:E:/path/to/dsh-ai-relay
```

然后确认 `package.json` 的 `dsh.profile.bundles` 里有 `dsh-ai-relay`，重启 DSH 生效。

## 配置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加（或直接改本插件自带的 patch）：

```yaml
- insert:
    - id: ai-relay
      name: 'dsh-ai-relay'
      config:
        defaultProvider: gpt
        keysFile: C:/Users/you/.dsh/ai-relay.keys.json
        providers:
          - id: gpt
            label: GPT-4o mini
            api: openai
            baseURL: https://api.openai.com/v1
            model: gpt-4o-mini
            apiKeyEnv: OPENAI_API_KEY
          - id: claude
            label: Claude
            api: anthropic
            baseURL: https://api.anthropic.com
            model: claude-sonnet-4-5
            apiKeyEnv: ANTHROPIC_API_KEY
          - id: my-gateway
            label: 自建网关
            api: openai
            baseURL: https://gateway.example.com/v1
            model: some-model
            apiKeyEnv: GATEWAY_API_KEY
            headers:
              x-org: whale
```

字段说明：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 路由名，`ai_ask` 的 `provider` 参数就是它 |
| `api` | 否 | `openai`（默认，聊天补全）或 `anthropic` |
| `baseURL` | 是 | 写到 `/v1` 为止；插件自己拼 `/chat/completions` 或 `/messages` |
| `model` | 是 | 请求里的模型 id |
| `apiKeyEnv` | 否 | 从哪个环境变量取密钥 |
| `headers` | 否 | 额外请求头（网关鉴权、组织 id 之类） |

## 密钥

两条路，都不进配置文件：

1. **环境变量**：路由的 `apiKeyEnv` 指向的那个变量。
2. **本地密钥文件**：默认 `~/.dsh/ai-relay.keys.json`，内容按路由 id 索引：

```json
{ "gpt": "sk-...", "claude": "sk-ant-..." }
```

找密钥的顺序：环境变量 → 密钥文件。都没有时 `ai_ask` 直接返回 `ok:false` 并说明该配哪个变量，不会发一个没鉴权的请求出去。

## 用起来长什么样

```
ai_ask(prompt: "把这段中文翻成自然的英文，保留技术词：……", provider: "claude")
→ [claude / claude-sonnet-4-5 · 1840ms · tokens 312→418]
   ...
```

失败时返回 `ok:false` 加一句人话提示（密钥被拒 / 端点 404 / 超时），不抛异常打断整轮。

## 参数

`ai_ask`：

- `prompt`（必填，上限 20 万字符）
- `provider` — 路由 id；不填用 `defaultProvider`，再不行用第一条
- `system` — 可选系统提示
- `max_tokens` — 上限 8192，Anthropic 默认 1024
- `temperature`

`ai_list`：无参数。

## 测试

```bash
node test/test.mjs
```

自带的测试会起一个本地 mock 服务，模拟 OpenAI 与 Anthropic 两种响应，覆盖成功、缺密钥、未知 provider、401、坏配置。不联网、不需要真密钥。

## 边界

- 只做「一问一答」，不转发工具调用，也不续写上下文。
- 不替你保存历史；要留档就把回答写进你自己的笔记。
- 超时默认 120 秒，`timeoutMs` 可调（5 秒到 10 分钟）。

MIT.
