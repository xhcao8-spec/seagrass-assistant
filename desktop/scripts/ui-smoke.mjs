import fs from 'node:fs/promises';
import path from 'node:path';

const cdpBase = process.env.SEAGRASS_CDP_URL || 'http://127.0.0.1:9222';
const outputDirectory = path.resolve(process.cwd(), '测试产物', '界面截图');

async function targets() {
  const response = await fetch(`${cdpBase}/json`);
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`);
  return response.json();
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'Runtime evaluation failed');
    }
    return result.result?.value;
  };
  return { socket, send, evaluate };
}

async function waitFor(evaluate, expression, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function screenshot(client, filename) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const outputPath = path.join(outputDirectory, filename);
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(outputPath, Buffer.from(result.data, 'base64'));
  return outputPath;
}

async function inspectGlobalSettings(target) {
  const client = await connect(target);
  try {
    await client.send('Page.enable');
    await client.send('Page.reload', { ignoreCache: true });
    await waitFor(client.evaluate, `document.readyState === 'complete' && Boolean(document.querySelector('.app-shell'))`, 30_000);
    await waitFor(client.evaluate, `(() => {
      const auth = document.querySelector('.auth-screen');
      return !auth || getComputedStyle(auth).display === 'none';
    })()`, 30_000);
    await waitFor(client.evaluate, `Boolean(document.querySelector('[aria-label="窗口翻译设置"]'))`);
    await client.evaluate(`document.querySelector('[aria-label="窗口翻译设置"]').click()`);
    await waitFor(client.evaluate, `Boolean(document.querySelector('.window-settings-modal'))`);
    const report = await client.evaluate(`(() => {
      const modal = document.querySelector('.window-settings-modal');
      const route = [...modal.querySelectorAll('.window-form-field')]
        .find((label) => label.textContent.includes('翻译线路'))?.querySelector('select');
      const bounds = modal.getBoundingClientRect();
      return {
        title: modal.querySelector('.window-settings-title strong')?.textContent,
        sectionTitles: [...modal.querySelectorAll('.window-settings-section-title h2')].map((node) => node.textContent),
        routeOptions: [...(route?.options || [])].map((option) => ({ value: option.value, text: option.textContent })),
        hasInputLanguage: Boolean([...modal.querySelectorAll('label')].find((node) => node.textContent.includes('我的输入语言'))),
        hasSendLanguage: Boolean([...modal.querySelectorAll('label')].find((node) => node.textContent.includes('发送语言（客户语言）'))),
        hasMessageLanguage: Boolean([...modal.querySelectorAll('label')].find((node) => node.textContent.includes('客户消息语种'))),
        hasTargetLanguage: Boolean([...modal.querySelectorAll('label')].find((node) => node.textContent.includes('译文显示语言（我的语言）'))),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      };
    })()`);
    const image = await screenshot(client, 'global-translation-settings.png');
    await client.evaluate(`document.querySelector('.window-settings-header [aria-label="关闭"]')?.click()`);
    return { report, image };
  } finally {
    client.socket.close();
  }
}

async function inspectCustomerSettings(target) {
  const client = await connect(target);
  try {
    await client.send('Page.enable');
    await client.send('Page.reload', { ignoreCache: true });
    await waitFor(client.evaluate, `document.readyState === 'complete'`, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await waitFor(client.evaluate, `(() => {
      const popover = document.querySelector('[data-seagrass-customer-popover]');
      if (popover?.style.display === 'grid') return true;
      const trigger = document.querySelector('[data-seagrass-customer-settings]');
      if (!trigger || !popover) return false;
      trigger.click();
      return popover.style.display === 'grid';
    })()`, 30_000);
    await waitFor(client.evaluate, `document.querySelector('[data-seagrass-customer-popover]')?.style.display === 'grid'`);
    const report = await client.evaluate(`(() => {
      const modal = document.querySelector('[data-seagrass-customer-popover]');
      const route = modal.querySelector('[data-seagrass-customer-route]');
      const bounds = modal.getBoundingClientRect();
      return {
        title: modal.querySelector('[data-seagrass-customer-title]')?.textContent,
        sectionTitles: [...modal.querySelectorAll('[data-seagrass-customer-section-heading] strong')].map((node) => node.textContent),
        routeOptions: [...route.options].map((option) => ({ value: option.value, text: option.textContent })),
        routeDisabled: route.disabled,
        hasIndependentSendToggle: Boolean(modal.querySelector('[data-seagrass-customer-send-enabled]')),
        hasIndependentMessageToggle: Boolean(modal.querySelector('[data-seagrass-customer-message-enabled]')),
        hasWindowInheritance: modal.querySelectorAll('[data-seagrass-customer-inherit]').length === 2,
        hasClassification: Boolean(modal.querySelector('[data-seagrass-customer-classification]')),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      };
    })()`);
    const image = await screenshot(client, 'customer-translation-settings.png');
    await client.evaluate(`document.querySelector('[data-seagrass-customer-close]')?.click()`);
    return { report, image };
  } finally {
    client.socket.close();
  }
}

const availableTargets = await targets();
const mainTarget = availableTargets.find((target) => target.type === 'page' && target.url.startsWith('http://127.0.0.1:4173'));
if (!mainTarget) throw new Error('Desktop renderer target was not found');

const globalSettings = await inspectGlobalSettings(mainTarget);
const refreshedTargets = await targets();
const whatsappTarget = refreshedTargets.find((target) => target.type === 'page' && target.url.startsWith('https://web.whatsapp.com'));
if (!whatsappTarget) throw new Error('WhatsApp platform target was not found');
const customerSettings = await inspectCustomerSettings(whatsappTarget);

const failures = [];
if (globalSettings.report.title !== '全局翻译设置') failures.push('global title');
if (globalSettings.report.routeOptions.length !== 1 || globalSettings.report.routeOptions[0].value !== 'default-1') failures.push('global route');
if (!globalSettings.report.hasInputLanguage || !globalSettings.report.hasSendLanguage) failures.push('global send rules');
if (!globalSettings.report.hasMessageLanguage || !globalSettings.report.hasTargetLanguage) failures.push('global message rules');
if (customerSettings.report.routeOptions.length !== 1 || customerSettings.report.routeOptions[0].value !== 'default-1') failures.push('customer route');
if (!customerSettings.report.routeDisabled) failures.push('customer route lock');
if (!customerSettings.report.hasIndependentSendToggle || !customerSettings.report.hasIndependentMessageToggle) failures.push('customer toggles');
if (!customerSettings.report.hasWindowInheritance || !customerSettings.report.hasClassification) failures.push('customer inheritance/classification');
if (failures.length) throw new Error(`UI smoke checks failed: ${failures.join(', ')}`);

console.log(JSON.stringify({ globalSettings, customerSettings }, null, 2));
