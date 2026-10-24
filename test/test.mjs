/**
 * Tests for dsh-ai-relay — no network, no real keys.
 *
 * Spins up a local HTTP server that imitates both an OpenAI-compatible
 * chat-completions route and an Anthropic Messages route, then drives the
 * registered tools through a fake plugin context.
 *
 * Run: node test/test.mjs
 */

import http from 'node:http';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

/** Collect the registered tool definitions from a fake cordis context. */
function fakeContext() {
  const tools = new Map();
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => {};
      },
    },
  };
  return { ctx, tools };
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function startServer() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw === '' ? {} : JSON.parse(raw);
    seen.push({ url: req.url, headers: req.headers, body });

    if (req.url === '/v1/chat/completions') {
      if (req.headers.authorization !== 'Bearer test-key') {
        json(res, 401, { error: { message: 'bad key' } });
        return;
      }
      json(res, 200, {
        model: body.model,
        choices: [{ message: { role: 'assistant', content: `echo:${body.messages.at(-1).content}` } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      });
      return;
    }
    if (req.url === '/v1/messages') {
      if (req.headers['x-api-key'] !== 'anthropic-key') {
        json(res, 401, { error: { message: 'bad key' } });
        return;
      }
      json(res, 200, {
        model: body.model,
        content: [{ type: 'text', text: `claude:${body.messages[0].content}` }],
        usage: { input_tokens: 5, output_tokens: 2 },
      });
      return;
    }
    json(res, 404, { error: { message: 'no route' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, port, seen };
}

const { server, port, seen } = await startServer();
const base = `http://127.0.0.1:${port}`;

process.env.TEST_OPENAI_KEY = 'test-key';
delete process.env.TEST_ANTHROPIC_KEY;

const { ctx, tools } = fakeContext();
apply(ctx, {
  providers: [
    {
      id: 'mock-openai',
      label: 'Mock GPT',
      api: 'openai',
      baseURL: `${base}/v1`,
      model: 'mock-model',
      apiKeyEnv: 'TEST_OPENAI_KEY',
    },
    {
      id: 'mock-claude',
      api: 'anthropic',
      baseURL: base,
      model: 'mock-claude',
      apiKeyEnv: 'TEST_ANTHROPIC_KEY',
      anthropicVersion: '2023-06-01',
    },
  ],
  defaultProvider: 'mock-openai',
  maxRetries: 0,
});

assert.equal(tools.size, 2, 'two tools registered');
assert.ok(tools.has('ai_ask') && tools.has('ai_list'), 'tool names');

// --- ai_ask: OpenAI-compatible success -------------------------------------
const openai = await tools.get('ai_ask').execute({ prompt: 'hello', system: 'be brief', max_tokens: 64 });
assert.equal(openai.ok, true, `openai call ok: ${JSON.stringify(openai)}`);
assert.equal(openai.text, 'echo:hello');
assert.equal(openai.provider, 'mock-openai');
assert.deepEqual(openai.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
const openaiReq = seen.find((entry) => entry.url === '/v1/chat/completions');
assert.equal(openaiReq.body.model, 'mock-model');
assert.equal(openaiReq.body.messages[0].role, 'system');
assert.equal(openaiReq.body.max_tokens, 64);

// --- ai_ask: Anthropic route, but its key is unset -------------------------
const noKey = await tools.get('ai_ask').execute({ prompt: 'hi', provider: 'mock-claude' });
assert.equal(noKey.ok, false);
assert.match(noKey.hint, /TEST_ANTHROPIC_KEY/, 'hint names the env var');

// --- ai_ask: Anthropic success ---------------------------------------------
process.env.TEST_ANTHROPIC_KEY = 'anthropic-key';
const claude = await tools.get('ai_ask').execute({ prompt: 'yo', provider: 'mock-claude' });
assert.equal(claude.ok, true, `anthropic ok: ${JSON.stringify(claude)}`);
assert.equal(claude.text, 'claude:yo');
const claudeReq = seen.find((entry) => entry.url === '/v1/messages');
assert.equal(claudeReq.headers['anthropic-version'], '2023-06-01');
assert.equal(claudeReq.body.max_tokens, 1024, 'anthropic default max tokens');

// --- ai_ask: unknown provider ----------------------------------------------
const unknown = await tools.get('ai_ask').execute({ prompt: 'x', provider: 'nope' });
assert.equal(unknown.ok, false);
assert.match(unknown.error, /找不到 provider/);

// --- ai_ask: empty prompt rejects -------------------------------------------
await assert.rejects(() => tools.get('ai_ask').execute({ prompt: '   ' }), /不能为空/);

// --- ai_ask: server error surfaces as ok:false ------------------------------
process.env.TEST_OPENAI_KEY = 'wrong-key';
const denied = await tools.get('ai_ask').execute({ prompt: 'x' });
assert.equal(denied.ok, false);
assert.match(denied.error, /HTTP 401/);
assert.match(denied.hint, /密钥被拒/);

// --- ai_list ----------------------------------------------------------------
const list = await tools.get('ai_list').execute({});
assert.equal(list.routes.length, 2);
const listed = list.routes.find((route) => route.id === 'mock-claude');
assert.equal(listed.hasKey, true);
assert.equal(listed.keySource, 'env:TEST_ANTHROPIC_KEY');
assert.equal(list.routes.find((route) => route.id === 'mock-openai').isDefault, true);
assert.equal(JSON.stringify(list).includes('anthropic-key'), false, 'no key material leaked');

// --- bad routes are reported, not fatal -------------------------------------
const { ctx: ctx2, tools: tools2 } = fakeContext();
apply(ctx2, { providers: [{ id: 'broken', api: 'openai' }] });
assert.equal(tools2.size, 2);
const brokenList = await tools2.get('ai_list').execute({});
assert.equal(brokenList.routes.length, 0);
assert.match(brokenList.problems.join(' '), /missing baseURL/);

server.close();
console.log('dsh-ai-relay tests: all assertions passed');
