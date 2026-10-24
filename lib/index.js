/**
 * `dsh-ai-relay` — ask other AIs to help with the work.
 *
 * Registers two agent tools:
 *  - `ai_ask`: send one prompt to a configured external model (OpenAI-compatible
 *    chat-completions endpoint or Anthropic's Messages API) and return its answer.
 *  - `ai_list`: list configured routes and whether each one has a usable key.
 *
 * Credentials never live in the cordis config: a route names an environment
 * variable (`apiKeyEnv`) or a key in a local JSON file (`keysFile`). Requests
 * reuse plain `fetch`, so the plugin has no runtime dependencies.
 *
 * @module dsh-ai-relay
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-ai-relay';
export const inject = ['tools'];

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_KEYS_FILE = path.join(os.homedir(), '.dsh', 'ai-relay.keys.json');
const MAX_PROMPT_CHARS = 200_000;
const MAX_TASK_MAX_TOKENS = 8192;

/** Strip trailing slashes so route joining stays predictable. */
function trimBase(baseURL) {
  if (typeof baseURL !== 'string') return '';
  return baseURL.trim().replace(/\/+$/, '');
}

/** Join a route base and a path; a trailing `/v1` in the base is respected. */
function joinURL(baseURL, pathname) {
  const base = trimBase(baseURL);
  if (base === '') return '';
  if (base.endsWith('/v1')) return `${base}${pathname}`;
  return `${base}/v1${pathname}`;
}

/** Read the optional key file; a missing or malformed file means "no file keys". */
function readKeysFile(file) {
  if (typeof file !== 'string' || file.trim() === '') return {};
  try {
    const text = fs.readFileSync(file.trim(), 'utf8');
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
  } catch {
    return {};
  }
}

/** Which credential wins: an explicit env var, then the key file. */
function resolveKey(provider, keys) {
  const envName = typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : '';
  if (envName !== '') {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim() !== '') {
      return { key: value.trim(), source: `env:${envName}` };
    }
  }
  const stored = keys[provider.id];
  if (typeof stored === 'string' && stored.trim() !== '') {
    return { key: stored.trim(), source: 'keys-file' };
  }
  return { key: '', source: '' };
}

/** Coerce an assistant message payload (string or content-part array) to text. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part === null || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .filter((part) => part !== '')
      .join('\n');
  }
  return '';
}

/** One request with a bounded timeout and a single retry for transient failures. */
async function requestJson(url, options, timeoutMs, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let body;
      try {
        body = text === '' ? {} : JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 2_000) };
      }
      if (!response.ok) {
        const detail = typeof body?.error?.message === 'string' ? body.error.message : text.slice(0, 400);
        const error = new Error(`HTTP ${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status ?? 0);
      const transient = error?.name === 'AbortError' || status === 0 || status === 408 || status === 429 || status >= 500;
      if (!transient || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('request failed');
}

/** Call an OpenAI-compatible chat-completions route. */
async function callOpenAI(route, key, input, timeoutMs, retries) {
  const url = joinURL(route.baseURL, '/chat/completions');
  const body = { model: route.model, messages: [] };
  if (typeof input.system === 'string' && input.system.trim() !== '') {
    body.messages.push({ role: 'system', content: input.system.trim() });
  }
  body.messages.push({ role: 'user', content: input.prompt });
  if (Number.isFinite(input.maxTokens)) body.max_tokens = input.maxTokens;
  if (Number.isFinite(input.temperature)) body.temperature = input.temperature;

  const headers = { 'content-type': 'application/json', ...(route.headers ?? {}) };
  if (key !== '') headers.authorization = `Bearer ${key}`;
  const data = await requestJson(url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs, retries);

  const text = contentText(data?.choices?.[0]?.message?.content);
  const usage = data?.usage && typeof data.usage === 'object'
    ? {
        inputTokens: Number(data.usage.prompt_tokens ?? 0),
        outputTokens: Number(data.usage.completion_tokens ?? 0),
        totalTokens: Number(data.usage.total_tokens ?? 0),
      }
    : undefined;
  return { text, usage, model: typeof data?.model === 'string' ? data.model : route.model };
}

/** Call an Anthropic Messages route. */
async function callAnthropic(route, key, input, timeoutMs, retries) {
  const url = joinURL(route.baseURL, '/messages');
  const body = {
    model: route.model,
    max_tokens: Number.isFinite(input.maxTokens) ? input.maxTokens : 1024,
    messages: [{ role: 'user', content: input.prompt }],
  };
  if (typeof input.system === 'string' && input.system.trim() !== '') body.system = input.system.trim();
  if (Number.isFinite(input.temperature)) body.temperature = input.temperature;

  const headers = {
    'content-type': 'application/json',
    'anthropic-version': typeof route.anthropicVersion === 'string' ? route.anthropicVersion : DEFAULT_ANTHROPIC_VERSION,
    ...(route.headers ?? {}),
  };
  if (key !== '') headers['x-api-key'] = key;
  const data = await requestJson(url, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs, retries);

  const text = Array.isArray(data?.content) ? contentText(data.content) : '';
  const usage = data?.usage && typeof data.usage === 'object'
    ? { inputTokens: Number(data.usage.input_tokens ?? 0), outputTokens: Number(data.usage.output_tokens ?? 0) }
    : undefined;
  return { text, usage, model: typeof data?.model === 'string' ? data.model : route.model };
}

/** Validate one configured route; drop it with a note instead of failing the plugin. */
function normalizeRoute(raw, seen) {
  if (raw === null || typeof raw !== 'object') return { error: 'route is not an object' };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') return { error: 'route is missing id' };
  if (seen.has(id)) return { error: `duplicate route id "${id}"` };
  const api = raw.api === 'anthropic' ? 'anthropic' : raw.api === undefined ? 'openai' : String(raw.api);
  if (api !== 'openai' && api !== 'anthropic') return { error: `route "${id}" uses unsupported api "${String(raw.api)}"` };
  const baseURL = trimBase(raw.baseURL);
  if (baseURL === '') return { error: `route "${id}" is missing baseURL` };
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (model === '') return { error: `route "${id}" is missing model` };
  seen.add(id);
  return {
    route: {
      id,
      api,
      baseURL,
      model,
      label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : id,
      apiKeyEnv: typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : '',
      anthropicVersion: typeof raw.anthropicVersion === 'string' ? raw.anthropicVersion : '',
      headers: raw.headers !== null && typeof raw.headers === 'object' ? raw.headers : undefined,
    },
  };
}

export function apply(ctx, config = {}) {
  const seen = new Set();
  const routes = new Map();
  const problems = [];
  const rawList = Array.isArray(config.providers) ? config.providers : [];
  for (const raw of rawList) {
    const parsed = normalizeRoute(raw, seen);
    if (parsed.error) {
      problems.push(parsed.error);
      continue;
    }
    routes.set(parsed.route.id, parsed.route);
  }

  const keysFile = typeof config.keysFile === 'string' && config.keysFile.trim() !== ''
    ? config.keysFile.trim()
    : DEFAULT_KEYS_FILE;
  const timeoutMs = Number.isFinite(Number(config.timeoutMs)) && Number(config.timeoutMs) > 0
    ? Math.min(600_000, Math.max(5_000, Number(config.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
  const retries = Number.isFinite(Number(config.maxRetries)) && Number(config.maxRetries) >= 0
    ? Math.min(3, Math.floor(Number(config.maxRetries)))
    : 1;
  const defaultProvider = typeof config.defaultProvider === 'string' ? config.defaultProvider.trim() : '';

  function pickRoute(requested) {
    if (routes.size === 0) {
      throw new Error('dsh-ai-relay: 没有配置任何 provider，先到 cordis.patch.yml 的 ai-relay 配置里加一条路由');
    }
    const want = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : defaultProvider;
    if (want !== '') {
      const route = routes.get(want);
      if (route === undefined) throw new Error(`dsh-ai-relay: 找不到 provider "${want}"`);
      return route;
    }
    return routes.values().next().value;
  }

  const disposers = [];

  disposers.push(
    ctx.tools.register({
      name: 'ai_ask',
      description:
        'Ask another AI model (a configured external route) one self-contained question and get its answer back. Use it to draft, review, translate, or brainstorm with a different model than the one driving you — the external model sees ONLY the prompt and system text you pass, not this conversation. Credentials and routes live in the plugin config; never paste API keys into the prompt.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: {
            type: 'string',
            description: 'The full task for the external model. Self-contained: it cannot see the current conversation.',
          },
          provider: {
            type: 'string',
            description: 'Route id to use. Omit to use the configured default (or the only route).',
          },
          system: {
            type: 'string',
            description: 'Optional system prompt for the external model.',
          },
          max_tokens: {
            type: 'number',
            description: 'Response budget. Defaults to the provider default (Anthropic 1024).',
          },
          temperature: {
            type: 'number',
            description: 'Sampling temperature, if the provider accepts it.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' },
            provider: { type: 'string' },
            model: { type: 'string' },
            text: { type: 'string' },
            latencyMs: { type: 'number' },
            usage: { type: 'object' },
            error: { type: 'string' },
            hint: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const v = value ?? {};
          if (v.ok !== true) {
            const hint = typeof v.hint === 'string' && v.hint !== '' ? `（${v.hint}）` : '';
            return [{ type: 'text', text: `外部模型调用失败：${String(v.error ?? '未知错误')}${hint}` }];
          }
          const usage = v.usage && typeof v.usage === 'object'
            ? ` · tokens ${Number(v.usage.inputTokens ?? 0)}→${Number(v.usage.outputTokens ?? 0)}`
            : '';
          return [
            {
              type: 'text',
              text: `[${v.provider} / ${v.model} · ${Number(v.latencyMs ?? 0)}ms${usage}]\n${String(v.text ?? '')}`,
            },
          ];
        },
      },
      async execute(args) {
        const raw = args ?? {};
        const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
        if (prompt === '') throw new Error('ai_ask: prompt 不能为空');
        const startedAt = Date.now();
        let route;
        try {
          route = pickRoute(raw.provider);
        } catch (error) {
          return { ok: false, error: error.message, hint: '检查插件配置里的 providers 列表' };
        }
        if (prompt.length > MAX_PROMPT_CHARS) {
          return { ok: false, error: `prompt 太长（${prompt.length} 字符，上限 ${MAX_PROMPT_CHARS}）`, provider: route.id };
        }
        const keys = readKeysFile(keysFile);
        const credential = resolveKey(route, keys);
        if (credential.key === '') {
          return {
            ok: false,
            provider: route.id,
            error: '没有可用的 API 密钥',
            hint: `在环境变量 ${route.apiKeyEnv || '(未配置 apiKeyEnv)'} 或 ${keysFile} 里给 "${route.id}" 配一个 key`,
          };
        }
        const maxTokens = Number.isFinite(Number(raw.max_tokens))
          ? Math.min(MAX_TASK_MAX_TOKENS, Math.max(1, Math.floor(Number(raw.max_tokens))))
          : undefined;
        const temperature = Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : undefined;
        const input = {
          prompt,
          system: typeof raw.system === 'string' ? raw.system : '',
          maxTokens,
          temperature,
        };
        try {
          const call = route.api === 'anthropic' ? callAnthropic : callOpenAI;
          const result = await call(route, credential.key, input, timeoutMs, retries);
          return {
            ok: true,
            provider: route.id,
            model: result.model,
            text: result.text,
            usage: result.usage,
            latencyMs: Date.now() - startedAt,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const hint =
            /401|403/.test(message)
              ? '密钥被拒：检查 ' + (route.apiKeyEnv || route.id) + ' 是否有效、有没有多余空格'
              : /404/.test(message)
                ? '端点找不到：确认 baseURL 是否要写到 /v1'
                : undefined;
          return { ok: false, provider: route.id, error: message, hint, latencyMs: Date.now() - startedAt };
        }
      },
      presentCall(args) {
        const provider = typeof args?.provider === 'string' && args.provider.trim() !== '' ? args.provider.trim() : defaultProvider || 'default';
        return { card: 'generic', title: `ai_ask: ${provider}`, kind: 'read' };
      },
    }),
  );

  disposers.push(
    ctx.tools.register({
      name: 'ai_list',
      description:
        'List the external AI routes this plugin is configured with: id, label, protocol, model, endpoint host, and whether a credential is available. Never returns key material.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          required: ['routes'],
          properties: {
            routes: { type: 'array' },
            keysFile: { type: 'string' },
            problems: { type: 'array' },
          },
        },
        render: (_args, value) => {
          const v = value ?? {};
          const rows = Array.isArray(v.routes) ? v.routes : [];
          if (rows.length === 0) return [{ type: 'text', text: '还没有配置任何外部模型路由。' }];
          const lines = rows.map((route) => {
            const key = route.hasKey ? '有密钥' : '缺密钥';
            return `- ${route.id} · ${route.label} · ${route.api} · ${route.model} · ${route.host} · ${key}${route.isDefault ? ' · 默认' : ''}`;
          });
          if (Array.isArray(v.problems) && v.problems.length > 0) {
            lines.push('', ...v.problems.map((problem) => `⚠ ${problem}`));
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute() {
        const keys = readKeysFile(keysFile);
        const rows = Array.from(routes.values()).map((route) => {
          let host = '';
          try {
            host = new URL(route.baseURL).host;
          } catch {
            host = route.baseURL;
          }
          const credential = resolveKey(route, keys);
          return {
            id: route.id,
            label: route.label,
            api: route.api,
            model: route.model,
            host,
            hasKey: credential.key !== '',
            keySource: credential.source,
            isDefault: route.id === defaultProvider,
          };
        });
        return { routes: rows, keysFile, problems };
      },
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* a disposer that throws must not strand the rest */
      }
    }
  };
}
