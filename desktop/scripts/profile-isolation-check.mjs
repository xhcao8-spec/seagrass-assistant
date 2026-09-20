import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProfileManager, PROFILE_SCHEMA_VERSION } = require('../electron/profile-manager.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seagrass-profile-check-'));
const runtime = {
  userAgent: 'Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  platform: 'win32',
  arch: 'x64',
  electronVersion: '37.0.0',
  chromiumVersion: '138.0.7204.35',
  webRTCPolicy: 'disable_non_proxied_udp',
};

const proxy = {
  type: 'SOCKS5',
  host: '[2A0F:1CC5:401:BA::A]',
  port: 1080,
  username: 'proxylogin',
  password: 'secret-must-not-be-persisted',
};

const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seagrass-profile-legacy-'));
fs.writeFileSync(path.join(legacyRoot, 'account-profiles.json'), JSON.stringify([{
  schemaVersion: 1,
  id: 'legacy-wa',
  platform: 'WhatsApp',
  accountKey: 'Legacy',
  windowId: 'legacy-wa',
  title: 'Legacy',
  proxyBinding: {
    mode: 'proxy',
    type: 'SOCKS5',
    host: '[2A0F:1CC5:401:BA::A]',
    port: '1080',
  },
}]));
const legacyManager = createProfileManager({ userDataPath: legacyRoot, runtime });
legacyManager.load();
const legacyReopened = legacyManager.ensure({
  id: 'legacy-wa',
  profileId: 'legacy-wa',
  platform: 'WhatsApp',
  accountId: 'Legacy',
  title: 'Legacy',
  mode: 'proxy',
  proxy,
});
assert.equal(legacyReopened.bindingConflict, false);

const manager = createProfileManager({ userDataPath: root, runtime });
const first = manager.ensure({
  id: 'whatsapp-window-1',
  profileId: 'whatsapp-window-1',
  platform: 'WhatsApp',
  accountId: 'Alice',
  title: 'Alice',
  mode: 'proxy',
  proxyId: 'proxy-1',
  proxy,
});

assert.equal(first.schemaVersion, PROFILE_SCHEMA_VERSION);
assert.equal(first.bindingConflict, false);
assert.equal(first.proxyBinding.host, '2a0f:1cc5:401:ba::a');
assert.equal(first.proxyBinding.port, 1080);
assert.equal(first.isolation.storage, 'persistent');
assert.match(first.isolation.partition, /^persist:seagrass-whatsapp-/);
assert.equal(Object.hasOwn(first, 'password'), false);

const reopened = manager.ensure({
  id: 'whatsapp-window-1',
  profileId: 'whatsapp-window-1',
  platform: 'WhatsApp',
  accountId: 'Alice',
  title: 'Alice',
  mode: 'proxy',
  proxyId: 'proxy-1',
  proxy: { ...proxy, host: '2a0f:1cc5:401:ba::a' },
});
assert.equal(reopened.bindingConflict, false);
assert.equal(reopened.isolation.partition, first.isolation.partition);
assert.equal(reopened.runtimeSignature, first.runtimeSignature);

const accountConflict = manager.ensure({
  id: 'whatsapp-window-1',
  profileId: 'whatsapp-window-1',
  platform: 'WhatsApp',
  accountId: 'Bob',
  title: 'Bob',
  mode: 'proxy',
  proxyId: 'proxy-1',
  proxy,
});
assert.equal(accountConflict.bindingConflict, true);
assert.ok(accountConflict.bindingMismatchFields.includes('accountKey'));
assert.equal(manager.get('whatsapp-window-1').accountKey, 'Alice');

const proxyConflict = manager.ensure({
  id: 'whatsapp-window-1',
  profileId: 'whatsapp-window-1',
  platform: 'WhatsApp',
  accountId: 'Alice',
  title: 'Alice',
  mode: 'proxy',
  proxyId: 'proxy-2',
  proxy: { ...proxy, port: 1081 },
});
assert.equal(proxyConflict.bindingConflict, true);
assert.ok(proxyConflict.bindingMismatchFields.includes('proxyId'));
assert.ok(proxyConflict.bindingMismatchFields.includes('proxyPort'));

const second = manager.ensure({
  id: 'line-window-1',
  profileId: 'line-window-1',
  platform: 'LINE',
  accountId: 'Cindy',
  title: 'Cindy',
  mode: 'direct',
});
assert.equal(second.bindingConflict, false);
assert.notEqual(second.isolation.partition, first.isolation.partition);

const reloaded = createProfileManager({ userDataPath: root, runtime });
reloaded.load();
assert.equal(reloaded.get('whatsapp-window-1').accountKey, 'Alice');
assert.equal(reloaded.get('whatsapp-window-1').proxyBinding.host, '2a0f:1cc5:401:ba::a');
assert.equal(reloaded.list().length, 2);

const persisted = fs.readFileSync(path.join(root, 'account-profiles.json'), 'utf8');
assert.equal(persisted.includes('secret-must-not-be-persisted'), false);

console.log(JSON.stringify({
  ok: true,
  profiles: reloaded.list().map((profile) => ({
    id: profile.id,
    platform: profile.platform,
    accountKey: profile.accountKey,
    partition: profile.isolation.partition,
    proxyMode: profile.proxyBinding.mode,
    consistency: profile.consistency,
  })),
}));
