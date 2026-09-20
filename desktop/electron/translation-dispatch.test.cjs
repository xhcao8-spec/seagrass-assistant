const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./platform-preload.cjs'), 'utf8');
const functions = source.slice(source.indexOf('function invokeTranslation('), source.indexOf('function loadTranslationCache('));

function setup(invoke) {
  let now = 1000;
  const context = {
    recentTranslationCache: new Map(), RECENT_TRANSLATION_DEDUPE_MS: 30000,
    TRANSLATION_REQUEST_TIMEOUT_MS: 210000, manualTranslationRequestSequence: 0,
    Date: { now: () => now }, ipcRenderer: { invoke },
    window: { setTimeout: () => 1, clearTimeout() {} }, setTimeout: () => 1,
  };
  vm.runInNewContext(functions, context);
  return { context, advance: ms => { now += ms; } };
}

test('different message translations dispatch concurrently without a serial queue', async () => {
  const pending = [];
  const { context } = setup((_channel, payload) => new Promise(resolve => pending.push({ payload, resolve })));
  const first = context.requestTranslation({ messageId: 'first', text: 'one' });
  const second = context.requestTranslation({ messageId: 'second', text: 'two' });
  assert.equal(pending.length, 2);
  pending.forEach(row => row.resolve({ text: row.payload.text }));
  await Promise.all([first, second]);
});

test('scroll rescans reuse pending translation even during a long automatic retry', async () => {
  let calls = 0, finish;
  const h = setup(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = h.context.requestTranslation({ messageId: 'same' });
  h.advance(90000);
  const again = h.context.requestTranslation({ messageId: 'same' });
  assert.equal(first, again); assert.equal(calls, 1);
  finish({ text: 'done' }); await first;
  assert.equal(h.context.recentTranslationCache.get('same').pending, false);
  assert.equal(h.context.recentTranslationCache.get('same').at, 91000);
});

test('rejected translations are evicted so another request can really try again', async () => {
  let calls = 0;
  const { context } = setup(async () => { calls++; if (calls === 1) throw new Error('temporary'); return { text: 'done' }; });
  await assert.rejects(context.requestTranslation({ messageId: 'same' }), /temporary/);
  assert.equal(context.recentTranslationCache.size, 0);
  assert.equal((await context.requestTranslation({ messageId: 'same' })).text, 'done');
  assert.equal(calls, 2);
});

test('preload never adds another retry loop to a provider balance or final failure', async () => {
  for (const message of ['DeepSeek 账户余额不足', '请求超时（已自动重试 2 次）']) {
    let calls = 0;
    const { context } = setup(async () => { calls++; throw new Error(message); });
    await assert.rejects(context.requestTranslationWithSilentRetry({ messageId: 'same' }), error => error.message === message);
    assert.equal(calls, 1);
  }
});

test('translation failure shows the actual safe reason instead of hiding insufficient balance', () => {
  const describe = source.slice(source.indexOf('function describeTranslationError('), source.indexOf('function findComposerInput('));
  const display = source.slice(source.indexOf('function showUnavailable('), source.indexOf('function removeManualTranslationAction('));
  const context = {};
  vm.runInNewContext(describe + display, context);
  const node = { textContent: '', style: {} };
  context.showUnavailable(node, new Error("Error invoking remote method 'platform:translate': Error: DeepSeek 账户余额不足，请到 DeepSeek 官方充值。"));
  assert.equal(node.textContent, 'DeepSeek 账户余额不足，请到 DeepSeek 官方充值。');
  context.showUnavailable(node);
  assert.equal(node.textContent, '翻译暂时不可用');
});
