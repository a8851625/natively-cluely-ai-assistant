// RAG answers on a self-hosted gateway (2026-10-29) — regression for the user
// report: "停止录音之后问这个会议的问题，提示 No AI provider configured，但
// deepseek-flash 明明能回答" (live answers and meeting notes worked on
// `litellm/deepseek-flash`; asking about the saved meeting did not).
//
// Root cause:
//   `streamChatWithGemini` is the RAG answer chain — RAGManager.queryMeeting
//   ("chat with this meeting") and queryGlobal (global search) are its only
//   callers. Its ladder was built CLOUD-ONLY: Natively API, Codex CLI, OpenAI,
//   Claude, DeepSeek, Gemini, Groq. It had no rung for the OpenAI-compatible
//   gateways (LiteLLM, NVIDIA NIM, OpenRouter, 9Router, Sidrune, AgentRouter)
//   and none for a user-configured cURL/custom provider, so `providers.length`
//   was 0 and it yielded `noProviderAvailableMessage()` — "No AI provider
//   configured. Please add at least one API key in Settings." — even though the
//   user's key WAS configured and the same model answered everywhere else
//   (that path, _streamChatInner, has the gateway branches; the summary path
//   uses selectedModelTextCall, which has them too).
//
// The fix adds `selectedGatewayStreamAttempt()` and pushes it ahead of the
// cloud ladder. These tests pin:
//   (1) the RAG chain actually streams from a LiteLLM-selected model instead of
//       emitting the no-provider sentence,
//   (2) the no-provider sentence still fires for a cloud-only setup (the case
//       it was written for — the fix must not paper over a real empty config),
//   (3) every gateway family maps to its own rung,
//   (4) cloud families are untouched (helper returns null),
//   (5) a selected custom/cURL provider leads, and the "custom disabled" toggle
//       still wins over it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const distDir = path.resolve(repoRoot, 'dist-electron');
const llmHelperPath = path.resolve(distDir, 'electron/LLMHelper.js');

if (!fs.existsSync(llmHelperPath)) {
  throw new Error(`LLMHelper.js not found at ${llmHelperPath} — run \`npm run build:electron\` first`);
}

const cjsRequire = createRequire(import.meta.url);

// --- Electron stub -----------------------------------------------------------
// LLMHelper -> ModelVersionManager / CredentialsManager call `app.getPath`.
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-gateway-test-'));
const electronStub = {
  app: {
    isReady: () => true,
    getPath: name => (name === 'userData' ? tmpUserData : os.tmpdir()),
    getName: () => 'natively-test',
    getVersion: () => '0.0.0-test',
  },
  shell: { openPath: async () => '' },
  ipcMain: { on: () => {}, handle: () => {}, removeAllListeners: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
};
const electronStubModule = new Module('electron');
electronStubModule.exports = electronStub;
electronStubModule.loaded = true;
cjsRequire.cache.electron = electronStubModule;
try { cjsRequire.cache[cjsRequire.resolve('electron')] = electronStubModule; } catch { /* ok */ }

const { LLMHelper } = cjsRequire(llmHelperPath);

const NO_PROVIDER = 'No AI provider configured. Please add at least one API key in Settings.';

/**
 * A helper with no cloud client, no keys, and the provider-disable gate stubbed
 * open — so what a test sees is only what the gateway rung decides.
 */
function makeHelper(modelId) {
  const helper = new LLMHelper(undefined, false);
  helper.isProviderDisabled = () => false;
  helper.setModel(modelId, []);
  return helper;
}

async function collect(gen) {
  let out = '';
  for await (const chunk of gen) out += chunk;
  return out;
}

test('RAG chain: a LiteLLM-selected model answers from LiteLLM instead of "No AI provider configured"', async () => {
  const helper = makeHelper('litellm/deepseek-flash');
  helper._litellmClient = { chat: { completions: { create: async () => { throw new Error('network must not be reached'); } } } };
  const calls = [];
  helper.streamWithLiteLLM = async function* (message) {
    calls.push(message);
    yield '这个会议讨论了';
    yield '面试安排。';
  };

  const text = await collect(helper.streamChatWithGemini('Summarize this meeting: ...'));

  assert.equal(text, '这个会议讨论了面试安排。', 'the RAG answer must come from the LiteLLM rung');
  assert.equal(text.includes(NO_PROVIDER), false, 'must NOT be the no-provider sentence');
  assert.deepEqual(calls, ['Summarize this meeting: ...'], 'the RAG prompt is what LiteLLM receives');
});

test('RAG chain: a cloud-only setup with no keys still reports no provider', async () => {
  const helper = makeHelper('gemini');
  const text = await collect(helper.streamChatWithGemini('question'));
  assert.equal(text, NO_PROVIDER, 'an actually-empty config must keep saying so');
});

test('selectedGatewayStreamAttempt maps every gateway family to its own rung', () => {
  const cases = [
    ['litellm/deepseek-flash', '_litellmClient', 'LiteLLM (deepseek-flash)'],
    ['nvidia_nim/llama-3.3-70b', '_nvidiaNimClient', 'NVIDIA NIM (llama-3.3-70b)'],
    ['openrouter/deepseek-chat', '_openrouterClient', 'OpenRouter (deepseek-chat)'],
    ['ninerouter/deepseek-chat', '_ninerouterClient', '9Router (deepseek-chat)'],
  ];
  for (const [modelId, field, expectedName] of cases) {
    const helper = makeHelper(modelId);
    helper[field] = { fake: true };
    const attempt = helper.selectedGatewayStreamAttempt('q', undefined, undefined, undefined);
    assert.ok(attempt, `${modelId} must produce a rung`);
    assert.equal(attempt.name, expectedName);
  }

  // Fluxion / AgentRouter gate on a credential helper rather than a client.
  const fluxion = makeHelper('fluxion/some-model');
  fluxion.hasFluxionCredential = () => true;
  assert.equal(fluxion.selectedGatewayStreamAttempt('q', undefined, undefined, undefined).name, 'Sidrune (some-model)');
  fluxion.hasFluxionCredential = () => false;
  assert.equal(fluxion.selectedGatewayStreamAttempt('q', undefined, undefined, undefined), null, 'no credential → no rung');

  const agentRouter = makeHelper('agentrouter/some-model');
  agentRouter.hasAgentRouterCredential = () => true;
  assert.match(agentRouter.selectedGatewayStreamAttempt('q', undefined, undefined, undefined).name, /^AgentRouter \(/);
});

test('selectedGatewayStreamAttempt returns null for cloud families (existing ladder unchanged)', () => {
  for (const modelId of ['gemini', 'gemini-2.5-flash', 'openai/gpt-5', 'claude/sonnet-4', 'groq/llama', 'deepseek/deepseek-flash']) {
    const helper = makeHelper(modelId);
    assert.equal(
      helper.selectedGatewayStreamAttempt('q', undefined, undefined, undefined),
      null,
      `${modelId} is covered by the cloud ladder — the gateway rung must not interfere`,
    );
  }
});

test('selectedGatewayStreamAttempt returns null when the gateway client is missing', () => {
  const helper = makeHelper('litellm/deepseek-flash');
  helper._litellmClient = null;
  assert.equal(helper.selectedGatewayStreamAttempt('q', undefined, undefined, undefined), null);
});

test('a selected custom provider leads the RAG chain', async () => {
  const helper = makeHelper('litellm/deepseek-flash');
  helper.customProvider = { id: 'litellm-curl', name: 'LiteLLM cURL', curlCommand: 'curl x', responsePath: 'choices[0].message.content' };
  helper.streamWithCustom = async function* () { yield 'custom-answer'; };

  const text = await collect(helper.streamChatWithGemini('question'));
  assert.equal(text, 'custom-answer');
});

test('the "custom providers disabled" toggle still wins over a selected custom provider', () => {
  const helper = makeHelper('litellm/deepseek-flash');
  helper.customProvider = { id: 'litellm-curl', name: 'LiteLLM cURL', curlCommand: 'curl x', responsePath: 'choices[0].message.content' };
  helper.isProviderDisabled = family => family === 'custom';
  assert.equal(
    helper.selectedGatewayStreamAttempt('q', undefined, undefined, undefined),
    null,
    'a user who switched custom providers off must not have them fire from the RAG chain',
  );
});

test('a selected cURL provider is used as a buffered rung', async () => {
  const helper = makeHelper('custom_curl/litellm');
  helper.activeCurlProvider = { id: 'c1', name: 'LiteLLM', curlCommand: 'curl x', responsePath: 'choices[0].message.content' };
  helper.executeCustomProvider = async () => 'curl-answer';

  const attempt = helper.selectedGatewayStreamAttempt('q', undefined, undefined, undefined);
  assert.equal(attempt.name, 'Custom cURL (LiteLLM)');
  assert.equal(await collect(attempt.execute()), 'curl-answer');
});
