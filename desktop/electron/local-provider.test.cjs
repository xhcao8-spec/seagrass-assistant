const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalProvider } = require('./local-provider.cjs');

function setup(t, fetchImpl, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seagrass-provider-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from([...value].reverse().join('')),
    decryptString: value => [...value.toString()].reverse().join('') };
  return { directory, provider: createLocalProvider({ directory, safeStorage, fetchImpl, sleep: async () => {}, ...options }) };
}
const completion = content => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content } }] }) });

test('key is encrypted at rest and never returned in settings; blank key preserves it', async t => {
  let authorization;
  const { provider, directory } = setup(t, async (_url, opts) => { authorization = opts.headers.Authorization; return { ok: true, json: async () => ({}) }; });
  const meta = provider.save({ apiKey: 'unit-test-key-123', model: 'deepseek-flash' });
  assert.deepEqual(meta, { model: 'deepseek-flash', modelLabel: 'DeepSeek V4.1 Flash', hasKey: true });
  assert.ok(!fs.readFileSync(path.join(directory, 'deepseek-settings.json'), 'utf8').includes('unit-test-key-123'));
  provider.save({ apiKey: '', concurrency: 2 });
  await provider.test();
  assert.equal(authorization, 'Bearer unit-test-key-123');
  provider.save({ removeKey: true });
  await assert.rejects(provider.test(), /填写自己的/);
});
test('no plaintext fallback if system encryption unavailable', t => {
  const { provider } = setup(t, null, { safeStorage: { isEncryptionAvailable: () => false } });
  assert.throws(() => provider.save({ apiKey: 'unit-test-key' }), /安全存储不可用/);
  assert.equal(provider.metadata().hasKey, false);
});
test('requests only go to DeepSeek and preserve translation role/target', async t => {
  const { provider } = setup(t, async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(opts.redirect, 'error');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.messages[1].content, '你好');
    assert.match(body.messages[0].content, /fr/);
    return completion('Bonjour');
  });
  provider.save({ apiKey: 'unit-test-key' });
  assert.equal((await provider.translate({ text: '你好', targetLanguage: 'fr' })).text, 'Bonjour');
});
test('AI purpose, sender identity and configurable count survive request construction', async t => {
  const { provider } = setup(t, async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const data = JSON.parse(body.messages[1].content);
    assert.equal(data.my_reply_goal, '只聊旅行，不谈业务');
    assert.deepEqual(data.conversation.map(row => row.speaker), ['对方', '我']);
    assert.match(body.messages[0].content, /严格给出 4 条/);
    assert.match(body.messages[0].content, /不得被历史话题盖过/);
    return completion(JSON.stringify({ suggestions: Array.from({ length: 4 }, (_, i) => ({ text: `回复${i}`, translation: '译文' })) }));
  });
  provider.save({ apiKey: 'unit-test-key' });
  const result = await provider.suggest({ count: 4, replyMode: 'deep', goal: '只聊旅行，不谈业务', messages: [
    { direction: 'incoming', original_text: '想去哪儿' }, { direction: 'outgoing', original_text: '我想去巴黎' }, { original_text: '未知归属不能猜' },
  ] });
  assert.equal(result.suggestions.length, 4);
});
test('balance is actual upstream amount and currency, not character quota', async t => {
  const { provider } = setup(t, async url => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '1.00' }] }) };
  });
  provider.save({ apiKey: 'unit-test-key' });
  assert.deepEqual(await provider.balance(), { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] });
});
test('upstream failures never leak provider body or key', async t => {
  const { provider } = setup(t, async () => ({ ok: false, status: 401, text: async () => 'unit-test-key leaked upstream' }));
  provider.save({ apiKey: 'unit-test-key' });
  await assert.rejects(provider.test(), error => /API Key 无效/.test(error.message) && !error.message.includes('unit-test-key'));
});
test('all 25 requests dispatch immediately even with a legacy concurrency setting', async t => {
  let active = 0, peak = 0;
  const { provider } = setup(t, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return completion('hello');
  });
  provider.save({ apiKey: 'unit-test-key', concurrency: 2 });
  await Promise.all(Array.from({ length: 25 }, () => provider.translate({ text: '你好' })));
  assert.equal(peak, 25);
  assert.equal(provider.metadata().concurrency, undefined);
});
test('each timed out request retries twice with a fresh abort signal then stops', async t => {
  const signals = [];
  const { provider } = setup(t, (_url, opts) => new Promise((resolve,reject) => {
    signals.push(opts.signal);
    opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }), { timeoutMs: 30 });
  provider.save({ apiKey: 'unit-test-key', concurrency: 1 });
  const results = await Promise.allSettled([provider.test(), provider.test()]);
  assert.ok(results.every(row => row.status === 'rejected' && /超时/.test(row.reason.message)));
  assert.equal(signals.length, 6);
  assert.equal(new Set(signals).size, 6);
  assert.ok(results.every(row => /已自动重试 2 次/.test(row.reason.message)));
});

test('persistent rate limit retries twice with backoff and stops', async t=>{
 let calls=0;const delays=[];
 const {provider}=setup(t,async()=>{calls++;return {ok:false,status:429};},{sleep:async ms=>delays.push(ms)});
 provider.save({apiKey:'unit-test-key'});
 await assert.rejects(provider.test(),/限流.*已自动重试 2 次/);assert.equal(calls,3);
 assert.deepEqual(delays,[1000,2000]);
});

test('temporary failures recover automatically without changing the translation payload', async t=>{
 for (const status of [408,429,500,502,503,504,'network','json']) {
   let calls=0;const bodies=[];
   const {provider}=setup(t,async (_url,opts)=>{
     bodies.push(opts.body);calls++;
     if(calls===1){
       if(status==='network')throw new TypeError('network offline');
       if(status==='json')return {ok:true,json:async()=>{throw new SyntaxError('invalid json');}};
       return {ok:false,status};
     }
     return completion('Bonjour');
   });
   provider.save({apiKey:'unit-test-key'});
   assert.equal((await provider.translate({text:'你好',targetLanguage:'fr'})).text,'Bonjour');
   assert.equal(calls,2);assert.equal(bodies[0],bodies[1]);
 }
});

test('insufficient balance, invalid Key and other permanent HTTP errors never retry', async t=>{
 for (const status of [400,401,402,403,404]) {
   let calls=0;
   const {provider}=setup(t,async()=>{calls++;return {ok:false,status};},{sleep:async()=>assert.fail('must not retry')});
   provider.save({apiKey:'unit-test-key'});
   await assert.rejects(provider.translate({text:'你好'}), status===402 ? /余额不足/ : /DeepSeek|Key/);
   assert.equal(calls,1);
 }
});

test('Retry-After is respected and a long server cooldown is never shortened', async t=>{
 for(const seconds of [3,120]){
   let calls=0;const delays=[];
   const {provider}=setup(t,async()=>{calls++;return calls===1?{ok:false,status:429,headers:{get:()=>String(seconds)}}:completion('Bonjour');},{sleep:async ms=>delays.push(ms)});
   provider.save({apiKey:'unit-test-key'});
   if(seconds===3){await provider.translate({text:'你好'});assert.equal(calls,2);assert.deepEqual(delays,[3000]);}
   else{await assert.rejects(provider.translate({text:'你好'}),/限流/);assert.equal(calls,1);assert.deepEqual(delays,[]);}
 }
});

test('existing text-only model preference migrates to current vision model',async t=>{
 const {provider,directory}=setup(t,async(_url,opts)=>{assert.equal(JSON.parse(opts.body).model,'deepseek-flash');return completion('bonjour');});
 provider.save({apiKey:'unit-test-key'});
 const file=path.join(directory,'deepseek-settings.json');const old=JSON.parse(fs.readFileSync(file));old.model='deepseek-v4-pro';old.concurrency=1;fs.writeFileSync(file,JSON.stringify(old));
 assert.equal(provider.metadata().model,'deepseek-flash');
 await provider.translate({text:'你好',targetLanguage:'fr'});
});

test('image-only incoming message is sent as actual multimodal input',async t=>{
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=';
 const {provider}=setup(t,async(_url,opts)=>{
   const body=JSON.parse(opts.body),parts=body.messages[1].content;
   assert.equal(body.model,'deepseek-flash');assert.equal(body.messages[1].role,'user');
   assert.equal(parts[2].type,'image_url');assert.equal(parts[2].image_url.url,image);
   assert.match(parts[1].text,/发送方：对方/);
   const context=JSON.parse(parts[0].text);assert.equal(context.my_reply_goal,'夸一下这张照片');assert.equal(context.conversation[0].image_count,1);
   return completion(JSON.stringify({suggestions:[{text:'很漂亮',translation:'很漂亮'}]}));
 });
 provider.save({apiKey:'unit-test-key'});
 const result=await provider.suggest({count:1,goal:'夸一下这张照片',messages:[{direction:'incoming',original_text:'',image_count:1,images:[{dataUrl:image}]}]});
 assert.equal(result.imageCount,1);
});
