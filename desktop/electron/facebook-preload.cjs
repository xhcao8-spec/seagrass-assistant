const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seagrassPlatform', {
  version: '0.1.0',
  platform: 'Facebook',
  customerClassification: true,
});

const CACHE_KEY = 'seagrass:facebook-translation-cache:v1';
const OUTGOING_KEY = 'seagrass:facebook-outgoing-originals:v1';
const TRANSLATION_ATTR = 'data-seagrass-facebook-translation';
const ACTION_ATTR = 'data-seagrass-facebook-translate-action';
const REQUEST_TIMEOUT_MS = 75_000;
const SCAN_DELAY_MS = 450;
const SCAN_COOLDOWN_MS = 650;
const pending = new Set();

const defaults = {
  provider: 'deepseek',
  sendTranslation: true,
  messageTranslation: true,
  inputLanguage: 'zh',
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
  sendLanguage: 'en',
  skipChineseMessages: true,
  fontColor: '#089b87',
  fontSize: '12',
};

let settings = { ...defaults };
let workspaceId = '';
let ownerMemberId = '';
let scanTimer;
let scanBlockedUntil = 0;
let scanAfterCooldownTimer;
let observer;
let internalSend = false;
let composerBusy = false;
let composerStatusTimer;
let customerUiTimer;

const customerStages = [
  { code: 'new', label: '新客户', color: '#0f9f88', background: '#e8f8f3' },
  { code: 'intent', label: '意向客户', color: '#b26a00', background: '#fff4dc' },
  { code: 'following', label: '跟进中', color: '#2563eb', background: '#eaf1ff' },
  { code: 'won', label: '已成交', color: '#9333a8', background: '#f8eafd' },
  { code: 'invalid', label: '无效客户', color: '#c33b4a', background: '#ffedf0' },
];

function normalized(value) {
  return String(value || '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function loadJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

let translationCache = loadJson(CACHE_KEY, {});
let outgoingOriginals = loadJson(OUTGOING_KEY, []);
if (!translationCache || typeof translationCache !== 'object' || Array.isArray(translationCache)) {
  translationCache = {};
}
if (!Array.isArray(outgoingOriginals)) outgoingOriginals = [];

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(translationCache));
  } catch {}
}

function saveOutgoingOriginals() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  outgoingOriginals = outgoingOriginals
    .filter((item) => item && item.at > cutoff && item.originalText && item.sentText)
    .slice(-300);
  try {
    localStorage.setItem(OUTGOING_KEY, JSON.stringify(outgoingOriginals));
  } catch {}
}

function inferLanguage(text) {
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  if (/\p{Script=Cyrillic}/u.test(text)) return 'ru';
  if (/\p{Script=Arabic}/u.test(text)) return 'ar';
  if (/\p{Script=Devanagari}/u.test(text)) return 'hi';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'ja';
  return 'auto';
}

function languageBase(value) {
  const code = String(value || '').trim().toLowerCase().replace(/_/gu, '-');
  if (/^zh(?:-|$)/u.test(code)) return 'zh';
  return code.split('-')[0];
}

function sameLanguage(left, right) {
  const a = languageBase(left);
  const b = languageBase(right);
  return Boolean(a && b && a !== 'auto' && b !== 'auto' && a === b);
}

function isTranslatableText(value) {
  const text = normalized(value);
  if (!text || text.length > 5000 || !/\p{L}/u.test(text)) return false;
  if (/^(?:https?:\/\/|www\.)\S+$/iu.test(text)) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text)) return false;
  if (/^\+?[\d\s().-]{5,}$/u.test(text)) return false;
  return true;
}

function isVisible(node) {
  if (!node?.isConnected) return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function facebookMain() {
  const mains = [...document.querySelectorAll('[role="main"]')].filter(isVisible);
  return mains.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
    || document.body;
}

function currentContact() {
  const path = location.pathname.replace(/\/+$/u, '');
  const contactId = path.match(/\/messages\/(?:e2ee\/)?t\/([^/?#]+)/iu)?.[1] || '';
  const main = facebookMain();
  const candidates = [...main.querySelectorAll('h1, h2, h3, [dir="auto"]')]
    .filter((node) => {
      if (!isVisible(node) || node.closest('[role="navigation"], [role="menu"], [role="dialog"]')) return false;
      const rect = node.getBoundingClientRect();
      return rect.top >= 0 && rect.top < Math.min(190, innerHeight * 0.25)
        && rect.left > innerWidth * 0.2
        && normalized(node.textContent).length <= 100;
    })
    .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
  const ignored = /^(聊天|chat|messenger|facebook|搜索|search)$/iu;
  const displayName = candidates.map((node) => normalized(node.textContent)).find((text) => text && !ignored.test(text)) || '';
  return {
    platform_contact_id: contactId || `path:${stableHash(path)}`,
    display_name: displayName || 'Facebook 客户',
    workspace_id: workspaceId,
    owner_member_id: ownerMemberId || null,
  };
}

function customerTagButton() {
  return document.querySelector('[data-seagrass-facebook-customer-button]');
}

function positionCustomerButton(button) {
  const composer = findComposer();
  const main = facebookMain();
  const rect = main.getBoundingClientRect();
  const top = Math.max(74, Math.min(132, rect.top + 58));
  button.style.top = `${Math.round(top)}px`;
  // Facebook keeps call/video/info controls at the far right of the chat
  // header. Place our compact tag entry immediately before those controls.
  button.style.right = rect.width < 560 ? '132px' : '184px';
  if (composer && rect.width < 420) button.style.right = '112px';
}

function makeTagChip({ label, color, background, selected = false, removable = false }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.textContent = removable ? `${label}  ×` : label;
  chip.dataset.tagLabel = label;
  chip.dataset.selected = selected ? '1' : '0';
  Object.assign(chip.style, {
    border: `1px solid ${color}55`,
    borderRadius: '7px',
    padding: '5px 9px',
    background: selected ? background : '#fff',
    color,
    font: '12px/1.2 system-ui, sans-serif',
    cursor: 'pointer',
  });
  return chip;
}

function closeCustomerPopover() {
  document.querySelector('[data-seagrass-facebook-customer-popover]')?.remove();
}

async function openCustomerPopover() {
  closeCustomerPopover();
  const contact = currentContact();
  const popover = document.createElement('div');
  popover.setAttribute('data-seagrass-facebook-customer-popover', '');
  Object.assign(popover.style, {
    position: 'fixed',
    top: '92px',
    right: '22px',
    zIndex: '2147483647',
    width: '340px',
    maxWidth: 'calc(100vw - 32px)',
    padding: '16px',
    border: '1px solid #d7e3eb',
    borderRadius: '14px',
    background: '#fff',
    boxShadow: '0 16px 48px rgba(15, 36, 50, .2)',
    color: '#102a43',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });
  popover.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div>
        <div style="font-size:15px;font-weight:700">客户标签 · <span data-customer-name></span></div>
        <div style="margin-top:3px;color:#8293a0;font-size:11px">仅保存分类和标签</div>
      </div>
      <button type="button" data-close style="border:0;background:transparent;color:#758692;font-size:20px;cursor:pointer">×</button>
    </div>
    <div style="margin-top:14px;color:#506778;font-size:12px">常用分类</div>
    <div data-stages style="display:flex;flex-wrap:wrap;gap:7px;margin-top:8px"></div>
    <div style="margin-top:14px;color:#506778;font-size:12px">自定义标签</div>
    <div data-custom-tags style="display:flex;flex-wrap:wrap;gap:7px;margin-top:8px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input data-tag-input placeholder="例如：需要报价" style="min-width:0;flex:1;height:34px;border:1px solid #cad9e2;border-radius:8px;padding:0 10px;outline:none" />
      <button type="button" data-add style="height:34px;border:1px solid #0ba896;border-radius:8px;background:#effaf7;color:#087f73;padding:0 11px;cursor:pointer">添加</button>
    </div>
    <div data-status style="min-height:18px;margin-top:9px;color:#81939b;font-size:11px">正在读取…</div>
    <button type="button" data-save style="width:100%;height:38px;margin-top:5px;border:0;border-radius:9px;background:#0ba896;color:#fff;font-weight:700;cursor:pointer">保存客户标签</button>
  `;
  popover.querySelector('[data-customer-name]').textContent = contact.display_name;
  popover.querySelector('[data-close]').addEventListener('click', closeCustomerPopover);
  const stages = popover.querySelector('[data-stages]');
  const customTags = popover.querySelector('[data-custom-tags]');
  let selectedStage = 'new';
  let tags = [];

  const render = () => {
    stages.replaceChildren();
    for (const stage of customerStages) {
      const chip = makeTagChip({ ...stage, selected: stage.code === selectedStage });
      chip.addEventListener('click', () => {
        selectedStage = stage.code;
        render();
      });
      stages.appendChild(chip);
    }
    customTags.replaceChildren();
    tags.forEach((label, index) => {
      const palette = customerStages[index % customerStages.length];
      const chip = makeTagChip({ ...palette, label, selected: true, removable: true });
      chip.addEventListener('click', () => {
        tags = tags.filter((tag) => tag !== label);
        render();
      });
      customTags.appendChild(chip);
    });
    if (!tags.length) {
      const empty = document.createElement('span');
      empty.textContent = '暂未添加自定义标签';
      empty.style.cssText = 'color:#98a6b2;font-size:11px';
      customTags.appendChild(empty);
    }
  };
  const addTag = () => {
    const input = popover.querySelector('[data-tag-input]');
    const label = normalized(input.value);
    if (!label || tags.includes(label)) return;
    tags.push(label.slice(0, 30));
    input.value = '';
    render();
  };
  popover.querySelector('[data-add]').addEventListener('click', addTag);
  popover.querySelector('[data-tag-input]').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addTag();
    }
  });
  document.documentElement.appendChild(popover);
  render();

  let customerId = '';
  try {
    const customer = await ipcRenderer.invoke('customer:lookup-current', contact);
    if (!popover.isConnected) return;
    customerId = customer?.id || '';
    selectedStage = customer?.stage || 'new';
    tags = Array.isArray(customer?.tags) ? customer.tags.map(normalized).filter(Boolean) : [];
    popover.querySelector('[data-status]').textContent = customer ? '已读取保存的标签' : '尚未归类';
    render();
  } catch {
    popover.querySelector('[data-status]').textContent = '标签读取失败';
  }

  popover.querySelector('[data-save]').addEventListener('click', async () => {
    const save = popover.querySelector('[data-save]');
    const status = popover.querySelector('[data-status]');
    save.disabled = true;
    status.textContent = '正在保存…';
    try {
      const customer = await ipcRenderer.invoke('customer:save-current', {
        ...contact,
        id: customerId || undefined,
        stage: selectedStage,
        tags,
      });
      customerId = customer?.id || customerId;
      status.textContent = '标签已保存';
      status.style.color = '#087f73';
    } catch (error) {
      status.textContent = error?.message || '保存失败';
      status.style.color = '#c33b4a';
    } finally {
      save.disabled = false;
    }
  });
}

function ensureCustomerUi() {
  const contact = currentContact();
  const isConversation = /\/messages\/(?:e2ee\/)?t\//iu.test(location.pathname);
  let button = customerTagButton();
  if (!isConversation || !contact.platform_contact_id) {
    button?.remove();
    closeCustomerPopover();
    return;
  }
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-seagrass-facebook-customer-button', '');
    button.textContent = '客户标签';
    Object.assign(button.style, {
      position: 'fixed',
      zIndex: '2147483645',
      height: '30px',
      padding: '0 12px',
      border: '1px solid #0ba896',
      borderRadius: '9px',
      background: '#effaf7',
      color: '#087f73',
      font: '600 12px/1 system-ui, sans-serif',
      boxShadow: '0 3px 12px rgba(10, 121, 108, .12)',
      cursor: 'pointer',
    });
    button.addEventListener('click', () => void openCustomerPopover());
    document.documentElement.appendChild(button);
  }
  positionCustomerButton(button);
}

function scheduleCustomerUi() {
  if (customerUiTimer) clearTimeout(customerUiTimer);
  customerUiTimer = setTimeout(() => {
    customerUiTimer = undefined;
    ensureCustomerUi();
  }, 500);
}

function findComposer() {
  return [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
    .filter((node) => {
      if (!isVisible(node)) return false;
      const rect = node.getBoundingClientRect();
      const label = String(node.getAttribute('aria-label') || '').toLowerCase();
      return rect.width > 80 && rect.bottom > innerHeight * 0.55 && !/(search|搜索)/u.test(label);
    })
    .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
}

function hasBubbleAppearance(node) {
  const style = getComputedStyle(node);
  const color = style.backgroundColor;
  const radius = Number.parseFloat(style.borderRadius) || 0;
  return radius >= 4 && color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent';
}

function bubbleFor(anchor) {
  const row = anchor.closest('[role="row"]');
  let current = anchor.parentElement;
  let fallback = anchor.parentElement;
  while (current && current !== row && current !== document.body) {
    const rect = current.getBoundingClientRect();
    if (rect.width >= anchor.getBoundingClientRect().width) fallback = current;
    if (hasBubbleAppearance(current) && rect.width < innerWidth * 0.72) return current;
    current = current.parentElement;
  }
  return fallback;
}

function messageDirection(bubble, main) {
  const bubbleRect = bubble.getBoundingClientRect();
  const mainRect = main.getBoundingClientRect();
  const center = bubbleRect.left + bubbleRect.width / 2;
  const mainCenter = mainRect.left + mainRect.width / 2;
  return center >= mainCenter ? 'outgoing' : 'incoming';
}

function messageEntries() {
  const main = facebookMain();
  const composer = findComposer();
  const seen = new Set();
  const entries = [];
  const anchors = [...main.querySelectorAll('[dir="auto"]')];
  for (const anchor of anchors) {
    if (!isVisible(anchor) || anchor.closest(`[${TRANSLATION_ATTR}], [${ACTION_ATTR}]`)) continue;
    if (composer && (anchor === composer || composer.contains(anchor) || anchor.contains(composer))) continue;
    if (anchor.closest('[role="navigation"], [role="banner"], [role="dialog"], [role="menu"], [role="button"]')) continue;
    if (anchor.querySelector('[dir="auto"]')) continue;
    const text = normalized(anchor.textContent);
    if (!isTranslatableText(text)) continue;
    const bubble = bubbleFor(anchor);
    if (!bubble || seen.has(bubble) || bubble.contains(composer)) continue;
    const rect = bubble.getBoundingClientRect();
    if (rect.top > innerHeight || rect.bottom < 0 || rect.width > innerWidth * 0.78) continue;
    const row = bubble.closest('[role="row"]') || bubble;
    const direction = messageDirection(bubble, main);
    const rowLabel = normalized(row.getAttribute?.('aria-label'));
    const key = `facebook:${stableHash(`${location.pathname}:${direction}:${rowLabel}:${text}`)}`;
    seen.add(bubble);
    entries.push({ anchor, bubble, row, text, direction, key });
  }
  return entries;
}

function translationStyle() {
  return {
    display: 'block',
    margin: '4px 8px 2px',
    paddingTop: '4px',
    borderTop: `1px dashed ${settings.fontColor || defaults.fontColor}55`,
    color: settings.fontColor || defaults.fontColor,
    fontSize: `${Number(settings.fontSize) || 12}px`,
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: '400',
    lineHeight: '1.45',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    pointerEvents: 'auto',
  };
}

function ensureTranslation(entry) {
  let node = entry.bubble.querySelector(`:scope > [${TRANSLATION_ATTR}]`)
    || entry.bubble.querySelector(`[${TRANSLATION_ATTR}]`);
  if (!node) {
    node = document.createElement('div');
    node.setAttribute(TRANSLATION_ATTR, '');
    node.setAttribute('data-message-key', entry.key);
    entry.bubble.appendChild(node);
  }
  Object.assign(node.style, translationStyle());
  node.style.setProperty('display', 'block', 'important');
  node.style.setProperty('visibility', 'visible', 'important');
  node.style.setProperty('opacity', '1', 'important');
  return node;
}

function removeArtifacts(entry) {
  entry.bubble.querySelectorAll(`[${TRANSLATION_ATTR}], [${ACTION_ATTR}]`).forEach((node) => node.remove());
}

function invokeTranslation(payload) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('translation_request_timeout')), REQUEST_TIMEOUT_MS);
  });
  return Promise.race([
    ipcRenderer.invoke('platform:translate', payload),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

function outgoingOriginal(entry) {
  const path = location.pathname;
  const match = [...outgoingOriginals].reverse().find((item) => (
    item.path === path && normalized(item.sentText) === entry.text
  ));
  return match?.originalText || '';
}

function addOutgoingOriginal(originalText, sentText) {
  outgoingOriginals.push({
    originalText: normalized(originalText),
    sentText: normalized(sentText),
    path: location.pathname,
    at: Date.now(),
  });
  saveOutgoingOriginals();
}

function ensureAction(entry, translated) {
  let action = entry.bubble.querySelector(`[${ACTION_ATTR}]`);
  if (!action) {
    action = document.createElement('div');
    action.setAttribute(ACTION_ATTR, '');
    action.setAttribute('role', 'button');
    action.setAttribute('tabindex', '0');
    Object.assign(action.style, {
      display: 'block',
      width: 'fit-content',
      margin: '2px 8px 4px',
      color: '#667085',
      fontSize: '11px',
      lineHeight: '1.4',
      textDecoration: 'underline',
      cursor: 'pointer',
      pointerEvents: 'auto',
    });
    entry.bubble.appendChild(action);
    const run = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (action.dataset.loading === '1') return;
      void translateEntry(entry, { forceFresh: true, action });
    };
    action.addEventListener('click', run);
    action.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') run(event);
    });
  }
  if (action.dataset.loading !== '1') action.textContent = translated ? '重新翻译' : '翻译';
  return action;
}

async function translateEntry(entry, { forceFresh = false, action = null } = {}) {
  if (!entry.bubble.isConnected || pending.has(entry.key)) return;
  const displayLanguage = settings.targetLanguage || settings.inputLanguage || 'zh';
  const inferred = inferLanguage(entry.text);
  const localOriginal = entry.direction === 'outgoing' ? outgoingOriginal(entry) : '';
  if (localOriginal && normalized(localOriginal) !== entry.text) {
    const node = ensureTranslation(entry);
    node.textContent = localOriginal;
    ensureAction(entry, true);
    return;
  }
  if (settings.skipChineseMessages && sameLanguage(inferred, displayLanguage)) {
    removeArtifacts(entry);
    return;
  }
  const cached = translationCache[entry.key];
  if (!forceFresh && cached?.text && cached.provider === settings.provider
      && sameLanguage(cached.targetLanguage, displayLanguage)) {
    const node = ensureTranslation(entry);
    node.textContent = cached.text;
    ensureAction(entry, true);
    return;
  }
  if (!settings.messageTranslation && !forceFresh) {
    ensureAction(entry, false);
    return;
  }

  pending.add(entry.key);
  const node = ensureTranslation(entry);
  node.textContent = '翻译中…';
  if (action) {
    action.dataset.loading = '1';
    action.textContent = '翻译中…';
    action.style.textDecoration = 'none';
  }
  try {
    const sourceLanguage = entry.direction === 'incoming'
      ? (settings.sourceLanguage || inferred || 'auto')
      : 'auto';
    const result = await invokeTranslation({
      text: entry.text,
      messageId: entry.key,
      idempotency_key: forceFresh ? `manual:${entry.key}:${Date.now()}` : `msg:${entry.key}`,
      provider: settings.provider,
      sourceLanguage,
      targetLanguage: displayLanguage,
      forceFresh,
      billable: forceFresh ? false : undefined,
      direction: entry.direction,
    });
    const resultText = normalized(result?.text);
    if (!resultText || resultText === entry.text) {
      node.remove();
      ensureAction(entry, false);
      return;
    }
    translationCache[entry.key] = {
      text: resultText,
      provider: result.provider || settings.provider,
      sourceLanguage: result.source_language || sourceLanguage,
      targetLanguage: result.target_language || displayLanguage,
    };
    saveCache();
    if (entry.bubble.isConnected) {
      const current = ensureTranslation(entry);
      current.textContent = resultText;
      ensureAction(entry, true);
    } else {
      scheduleScan();
    }
  } catch {
    if (entry.bubble.isConnected) {
      const current = ensureTranslation(entry);
      current.textContent = '翻译暂时不可用';
      current.style.color = '#98a2b3';
      const retry = ensureAction(entry, false);
      retry.textContent = '翻译失败，重试';
    }
  } finally {
    pending.delete(entry.key);
    if (action) {
      action.dataset.loading = '';
      action.style.textDecoration = 'underline';
    }
  }
}

function scanMessages() {
  if (!/(?:^|\.)facebook\.com$/iu.test(location.hostname)) return;
  scanBlockedUntil = Date.now() + SCAN_COOLDOWN_MS;
  for (const entry of messageEntries()) void translateEntry(entry);
}

function scheduleScan() {
  if (scanTimer) return;
  const wait = Math.max(SCAN_DELAY_MS, scanBlockedUntil - Date.now());
  if (scanAfterCooldownTimer) clearTimeout(scanAfterCooldownTimer);
  scanTimer = setTimeout(() => {
    scanTimer = undefined;
    scanAfterCooldownTimer = undefined;
    scanMessages();
  }, wait);
  scanAfterCooldownTimer = scanTimer;
}

function ensureComposerStatus() {
  const composer = findComposer();
  if (!composer) return null;
  let status = document.querySelector('[data-seagrass-facebook-composer-status]');
  if (!status) {
    status = document.createElement('div');
    status.setAttribute('data-seagrass-facebook-composer-status', '');
    Object.assign(status.style, {
      position: 'fixed',
      zIndex: '2147483646',
      padding: '4px 9px',
      borderRadius: '10px',
      background: '#ffffff',
      boxShadow: '0 4px 18px rgba(15, 23, 42, .16)',
      color: settings.fontColor || defaults.fontColor,
      font: '12px/1.3 system-ui, sans-serif',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(status);
  }
  const rect = composer.getBoundingClientRect();
  status.style.left = `${Math.max(12, rect.left)}px`;
  status.style.bottom = `${Math.max(12, innerHeight - rect.top + 6)}px`;
  return status;
}

function showComposerStatus(text, isError = false) {
  const status = ensureComposerStatus();
  if (!status) return;
  status.textContent = text;
  status.style.color = isError ? '#b42318' : (settings.fontColor || defaults.fontColor);
  status.style.display = 'block';
  if (composerStatusTimer) clearTimeout(composerStatusTimer);
  if (text !== '翻译中…') {
    composerStatusTimer = setTimeout(() => { status.style.display = 'none'; }, 2400);
  }
}

async function translateAndSend(composer) {
  if (composerBusy) return;
  const text = normalized(composer?.textContent);
  if (!text) return;
  const sourceLanguage = settings.inputLanguage || 'zh';
  const targetLanguage = settings.sendLanguage || 'auto';
  if (!settings.sendTranslation || targetLanguage === 'auto' || sameLanguage(sourceLanguage, targetLanguage)) {
    internalSend = true;
    await ipcRenderer.invoke('platform:send-composer').catch(() => undefined);
    setTimeout(() => { internalSend = false; }, 250);
    return;
  }

  composerBusy = true;
  showComposerStatus('翻译中…');
  try {
    const result = await invokeTranslation({
      text,
      messageId: `facebook-composer:${stableHash(`${location.pathname}:${text}:${targetLanguage}`)}`,
      provider: settings.provider,
      sourceLanguage,
      targetLanguage,
      direction: 'send',
    });
    const sentText = normalized(result?.text);
    if (!sentText) throw new Error('empty_translation');
    if (sentText !== text) {
      const replaced = await ipcRenderer.invoke('platform:replace-composer-text', { text: sentText });
      if (!replaced?.ok) throw new Error(replaced?.reason || 'composer_replace_failed');
      addOutgoingOriginal(text, sentText);
    } else {
      addOutgoingOriginal(text, text);
    }
    internalSend = true;
    showComposerStatus('已翻译，正在发送');
    await ipcRenderer.invoke('platform:send-composer');
    setTimeout(() => { internalSend = false; }, 300);
  } catch {
    showComposerStatus('发送翻译失败，请重试', true);
  } finally {
    composerBusy = false;
  }
}

function isSendButton(target) {
  const button = target?.closest?.('button, [role="button"]');
  if (!button) return false;
  const label = normalized([
    button.getAttribute('aria-label'),
    button.getAttribute('title'),
    button.textContent,
  ].filter(Boolean).join(' '));
  return /(?:^|\s)(send|发送|enviar|envoyer|senden|invia|отправить|gönder|إرسال)(?:\s|$)/iu.test(label);
}

document.addEventListener('keydown', (event) => {
  if (internalSend || composerBusy || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  const composer = findComposer();
  if (!composer || (event.target !== composer && !composer.contains(event.target))) return;
  if (!settings.sendTranslation) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void translateAndSend(composer);
}, true);

document.addEventListener('click', (event) => {
  if (internalSend || composerBusy || !settings.sendTranslation || !isSendButton(event.target)) return;
  const composer = findComposer();
  if (!composer || !normalized(composer.textContent)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void translateAndSend(composer);
}, true);

ipcRenderer.on('platform:settings', (_event, payload = {}) => {
  const { languageCatalog: _catalog, workspaceId: scope, ownerMemberId: member, ...windowSettings } = payload;
  workspaceId = String(scope || workspaceId || '');
  ownerMemberId = String(member || ownerMemberId || '');
  settings = {
    ...defaults,
    ...windowSettings,
    inputLanguage: windowSettings.inputLanguage || windowSettings.targetLanguage || defaults.inputLanguage,
  };
  document.querySelectorAll(`[${TRANSLATION_ATTR}], [${ACTION_ATTR}]`).forEach((node) => node.remove());
  scheduleScan();
  scheduleCustomerUi();
});

window.addEventListener('DOMContentLoaded', () => {
  observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.addedNodes.length || mutation.removedNodes.length)) {
      scheduleScan();
      scheduleCustomerUi();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();
  scheduleCustomerUi();
});

window.addEventListener('scroll', scheduleScan, { passive: true, capture: true });
window.addEventListener('resize', scheduleScan, { passive: true });
window.addEventListener('resize', scheduleCustomerUi, { passive: true });
