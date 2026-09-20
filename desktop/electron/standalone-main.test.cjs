const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function mainHarness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seagrass-main-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = { appData: directory, userData: directory };
  const handles = new Map(), listeners = new Map(), opened = [], copied = [];
  let translations = 0;
  const provider = { metadata: () => ({ model: 'test-model', hasKey: false }),
    save: () => ({ hasKey: true }), test: async () => ({ ok: true }), balance: async () => ({}),
    translate: async () => ({ text: 'translation-' + (++translations), provider: 'deepseek' }), suggest: async () => ({ suggestions: [] }) };
  const electron = {
    app: { isPackaged: true, getVersion: () => '1.1.0', getPath: key => paths[key], setPath: (key,value) => paths[key]=value,
      commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) },
    ipcMain: { handle: (key,fn) => handles.set(key,fn), on: (key,fn) => listeners.set(key,fn) },
    shell: { openExternal: async url => opened.push(url) },
    clipboard: { writeText: value => copied.push(value) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
  };
  const localRequire = createRequire(path.join(__dirname, 'main.cjs'));
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './local-provider.cjs' ? { createLocalProvider: () => provider } : localRequire(name),
    process: { env: {}, platform: 'win32', stdout: { on() {} }, stderr: { on() {} } },
    __dirname, console, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), context);
  fs.mkdirSync(paths.userData, { recursive: true });
  context.mainSender = { mainFrame: {}, isDestroyed: () => false, send() {} };
  context.platformSender = { isDestroyed: () => false, send() {} };
  vm.runInContext(`mainView = { webContents: mainSender }; platformViews.set('wa-test', { id: 'wa-test', platform: 'WhatsApp', workspaceId: 'local', ownerUserId: 'local', view: { webContents: platformSender } });`, context);
  const event = { sender: context.mainSender, senderFrame: context.mainSender.mainFrame };
  return { handles, listeners, event, context, opened, copied, provider, directory: paths.userData, translations: () => translations };
}
test('no login/billing IPC is registered; key settings are inaccessible to platform or subframe', t => {
  const h = mainHarness(t);
  assert.ok(![...h.handles.keys()].some(name => /auth:|billing:|app:install|app:download/.test(name)));
  assert.throws(() => h.handles.get('local:settings')({ sender: h.context.platformSender }), /仅允许/);
  assert.throws(() => h.handles.get('local:settings')({ sender: h.event.sender, senderFrame: {} }), /仅允许/);
  assert.equal(h.handles.get('local:settings')(h.event).model, 'test-model');
});
test('customer directory is removed; chat tags persist without customer profiles or message archives', async t => {
  const h = mainHarness(t);
  for (const channel of ['customer:list','customer:create','customer:update','customer:delete','customer:messages','platform:open-conversation']) assert.equal(h.handles.has(channel),false);
  const event = { sender: h.context.platformSender };
  const payload = { platform_contact_id:'contact-test', display_name:'测试联系人', tags:['朋友'], note:'不应保存', phone:'不应保存', avatar_data_url:'不应保存', translation_settings:{sendLanguage:'fr'} };
  const row = await h.handles.get('customer:save-current')(event,payload);
  const lookup = h.handles.get('customer:lookup-current')(event,payload);
  assert.equal(lookup.id,row.id);
  assert.equal(lookup.tags[0],'朋友');
  assert.equal(lookup.note,undefined);
  assert.equal(lookup.phone,undefined);
  assert.equal(lookup.avatar_data_url,undefined);
  const updated = await h.handles.get('customer:save-current')(event,{...payload,tags:['跟进']});
  assert.equal(updated.id,row.id);
  assert.equal(h.handles.get('customer:list-platform')(event).length,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.directory,'chat-marks.json'),'utf8'))[0].tags[0],'跟进');
  h.listeners.get('platform:message-captured')(event,{platform_contact_id:'contact-test',direction:'incoming',original_text:'不要归档这句话'});
  assert.deepEqual(fs.readdirSync(h.directory),['chat-marks.json']);
  vm.runInContext('customerRegistry.clear(); loadCustomerRegistry();',h.context);
  assert.equal(h.handles.get('customer:lookup-current')(event,payload).tags[0],'跟进');
});

test('AI context only reads live conversation and preserves sender directions', async t => {
  const h=mainHarness(t);
  await vm.runInContext(`updateAssistantWindowContextWithPayload(platformViews.get('wa-test'), {platformContactId:'contact-test',messages:[{direction:'outgoing',original_text:'我已经吃过饭了'},{direction:'incoming',original_text:'今天好吗'}]})`,h.context);
  assert.equal(vm.runInContext('assistantContext.messages.length',h.context),2);
  assert.equal(vm.runInContext('assistantContext.messages[0].direction',h.context),'outgoing');
  assert.equal(vm.runInContext('assistantContext.messages[1].direction',h.context),'incoming');
  await vm.runInContext(`updateAssistantWindowContextWithPayload(platformViews.get('wa-test'), {platformContactId:'other-contact',messages:[]})`,h.context);
  assert.equal(vm.runInContext('assistantContext.messages.length',h.context),0);
});
test('translation caches automatic requests but manual retranslation requests fresh output', async t => {
  const h = mainHarness(t);
  const event = { sender: h.context.platformSender };
  const payload = { text: 'hello', sourceLanguage: 'en', targetLanguage: 'zh' };
  const translate = h.handles.get('platform:translate');
  assert.equal((await translate(event, payload)).text, 'translation-1');
  assert.equal((await translate(event, payload)).cached, true);
  assert.equal((await translate(event, { ...payload, forceFresh: true })).text, 'translation-2');
  assert.equal(h.translations(), 2);
});
test('update only opens fixed Blue Lanzou URL without installing or restarting', async t => {
  const h = mainHarness(t);
  const result = await h.handles.get('app:check-update')(h.event);
  assert.deepEqual(h.opened, ['https://wwamz.lanzouu.com/b01euscfwj']);
  assert.deepEqual(h.copied, ['9ysu']);
  assert.match(result.message, /已复制/);
  assert.match(result.message, /9ysu/);
});

test('AI reads fresh photo context, validates sender IPC and forwards images only to provider',async t=>{
 const h=mainHarness(t);
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=';
 await vm.runInContext(`updateAssistantWindowContextWithPayload(platformViews.get('wa-test'),{platformContactId:'photo-contact',messages:[]})`,h.context);
 h.context.platformSender.send=(channel,request)=>{
   assert.equal(channel,'assistant:collect-context');
   const respond=h.listeners.get('assistant:collected-context');
   respond({sender:{}},{requestId:request.requestId,ok:false,reason:'forged'});
   respond({sender:h.context.platformSender},{requestId:request.requestId,contactId:'photo-contact',ok:true,messages:request.checkOnly?[]:[{direction:'incoming',image_count:1,images:[{dataUrl:image}]}],viewport:{width:800,height:600}});
 };
 let called=0;
 h.provider.suggest=async payload=>{called++;assert.equal(payload.messages[0].images[0].dataUrl,image);assert.equal(payload.messages[0].direction,'incoming');return {suggestions:[{text:'nice photo'}],imageCount:1};};
 const result=await h.handles.get('assistant:suggest')(h.event,{count:1});
 assert.equal(result.imageCount,1);assert.equal(called,1);
 assert.equal(vm.runInContext('assistantReadRequests.size',h.context),0);
 assert.equal(vm.runInContext('JSON.stringify(assistantContext).includes("base64")',h.context),false);
});

test('switching actual chat prevents submitting old context even before UI catches up',async t=>{
 const h=mainHarness(t);
 await vm.runInContext(`updateAssistantWindowContextWithPayload(platformViews.get('wa-test'),{platformContactId:'old-contact',messages:[{direction:'incoming',original_text:'old'}]})`,h.context);
 h.context.platformSender.send=(_channel,request)=>h.listeners.get('assistant:collected-context')({sender:h.context.platformSender},{requestId:request.requestId,contactId:'new-contact',ok:false,reason:'聊天已切换'});
 let called=false;h.provider.suggest=async()=>{called=true;return {};};
 await assert.rejects(h.handles.get('assistant:suggest')(h.event,{}),/聊天已切换/);assert.equal(called,false);
});
