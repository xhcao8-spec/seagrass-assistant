'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

function createLocalProxies({ directory, safeStorage }) {
  const filename = path.join(directory, 'local-proxies.json');
  function read() {
    if (!fs.existsSync(filename)) return [];
    const rows = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(rows)) throw new Error('本地代理文件损坏');
    return rows;
  }
  function write(rows) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(`${filename}.tmp`, JSON.stringify(rows, null, 2), { mode: 0o600 });
    fs.renameSync(`${filename}.tmp`, filename);
  }
  function list() {
    return read().map(row => ({ ...row, encryptedPassword: undefined,
      password: row.encryptedPassword ? safeStorage.decryptString(Buffer.from(row.encryptedPassword, 'base64')) : '',
    }));
  }
  function create(input = {}) {
    const host = String(input.host || '').trim();
    const port = Number(input.port);
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理地址或端口无效');
    const password = String(input.password || '');
    if (password && !safeStorage.isEncryptionAvailable()) throw new Error('安全存储不可用，未保存代理密码');
    const row = { id: crypto.randomUUID(), name: String(input.name || host).slice(0, 100), host, port,
      proxy_type: input.proxy_type === 'SOCKS5' ? 'SOCKS5' : 'HTTP', username: String(input.username || ''),
      encryptedPassword: password ? safeStorage.encryptString(password).toString('base64') : '',
      status: 'untested', last_checked_at: null };
    write([...read(), row]);
    return list().find(item => item.id === row.id);
  }
  function remove(id) { write(read().filter(row => row.id !== id)); return { deleted: true }; }
  async function test(id) {
    const row = read().find(item => item.id === id);
    if (!row) throw new Error('代理不存在');
    const start = Date.now();
    const reachable = await new Promise(resolve => {
      const socket = net.createConnection({ host: row.host, port: row.port });
      let settled = false;
      const finish = ok => { if (settled) return; settled = true; socket.destroy(); resolve(ok); };
      socket.setTimeout(8000);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
    const status = reachable ? 'healthy' : 'unhealthy';
    const checked_at = new Date().toISOString();
    write(read().map(item => item.id === id ? { ...item, status, last_checked_at: checked_at } : item));
    return { status, checked_at, latency_ms: Date.now() - start,
      detail: reachable ? '代理端口可连接；账号认证和平台访问请打开窗口验证' : '无法连接代理端口' };
  }
  return { list, create, remove, test };
}
module.exports = { createLocalProxies };
