const { contextBridge, ipcRenderer } = require('electron');

// Keep this sandbox-safe copy aligned with message-text-filter.cjs. Electron's
// sandboxed preload cannot import arbitrary local CommonJS modules at runtime.
const URL_ONLY_PATTERN = /^(?:https?:\/\/|www\.)\S+$/iu;
const EMAIL_ONLY_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_ONLY_PATTERN = /^\+?[\d\s().-]{5,}$/u;
const TIME_ONLY_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/u;
const DATE_ONLY_PATTERN = /^(?:\d{2,4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|\d{1,2}月\d{1,2}日)(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/u;
const FILE_META_ONLY_PATTERN = /^\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb|字节)(?:\s*[·|/]\s*\d{1,2}:\d{2}(?::\d{2})?)?$/iu;
const NON_LANGUAGE_ONLY_PATTERN = /^[\p{N}\p{P}\p{S}\p{Z}\p{M}]+$/u;

// A chat bubble can contain a keyboard mash (for example
// "fkasnfksnfksnkf") that technically consists of letters but has no useful
// language to translate.  Keep this deliberately conservative: only reject
// long, whitespace-free ASCII-letter runs with strong noise signals. Normal
// sentences, names, accented languages, and short words continue through.
function isLikelyNoiseMessageText(value) {
  const text = String(value ?? '').trim().toLocaleLowerCase();
  if (text.length < 10 || !/^[a-z0-9]+$/u.test(text)) return false;

  const letters = [...text].filter((letter) => /[a-z]/u.test(letter));
  const digits = [...text].filter((letter) => /\d/u.test(letter));
  if (letters.length < 8) return false;
  const hasNumericSuffix = /[a-z]\d{2,}$/u.test(text);
  const vowels = letters.filter((letter) => 'aeiouy'.includes(letter)).length;
  let consonantRun = 0;
  let longestConsonantRun = 0;
  for (const letter of letters) {
    if ('aeiouy'.includes(letter)) {
      consonantRun = 0;
    } else {
      consonantRun += 1;
      longestConsonantRun = Math.max(longestConsonantRun, consonantRun);
    }
  }

  const distinctRatio = new Set(letters).size / letters.length;
  const bigrams = Array.from(
    { length: letters.length - 1 },
    (_, index) => text.slice(index, index + 2),
  );
  const repeatedBigramCount = bigrams
    .reduce((count, bigram, index, all) => count + (all.indexOf(bigram) < index ? 1 : 0), 0);

  const keyboardMash = /(?:asdf|fdsa|qwer|rewq|zxcv|vcxz|jkl|lkj|qaz|zaq|wsx|xsw|edc|cde)/u.test(text);
  const lowVowelNoise = vowels / letters.length <= 0.18 && letters.length >= 10;
  const repetitiveNoise = repeatedBigramCount >= 2 && distinctRatio <= 0.55 && letters.length >= 12;
  const randomAlphaNumericSuffix = hasNumericSuffix && digits.length >= 2 && letters.length >= 8;

  return keyboardMash || lowVowelNoise || longestConsonantRun >= 6 || repetitiveNoise || randomAlphaNumericSuffix;
}

function isTranslatableMessageText(value) {
  const text = String(value ?? '').replace(/\u00a0/gu, ' ').trim();
  if (!text) return false;
  if (
    URL_ONLY_PATTERN.test(text)
    || EMAIL_ONLY_PATTERN.test(text)
    || PHONE_ONLY_PATTERN.test(text)
    || TIME_ONLY_PATTERN.test(text)
    || DATE_ONLY_PATTERN.test(text)
    || FILE_META_ONLY_PATTERN.test(text)
    || NON_LANGUAGE_ONLY_PATTERN.test(text)
    || isLikelyNoiseMessageText(text)
  ) return false;

  return /\p{L}/u.test(text);
}

contextBridge.exposeInMainWorld('seagrassPlatform', {
  version: '0.1.0',
});

const pendingTranslationKeys = new Set();
// Separate manual retries from automatic scans.  WhatsApp can rebuild a
// message row (and remove the action) while a manual request is in flight;
// this flag lets the next scan keep showing a loading state instead of
// restoring the old composer reference.
const manualTranslationKeys = new Set();
const TRANSLATION_CACHE_STORAGE_KEY = 'seagrass:translation-cache:v1';
const CONVERSATION_LANGUAGE_STORAGE_KEY = 'seagrass:conversation-languages:v1';
const OUTGOING_ORIGINALS_STORAGE_KEY = 'seagrass:outgoing-originals:v1';
const TRANSLATION_STATUS_SELECTOR = '[data-seagrass-translation-status]';
const NETWORK_BADGE_SELECTOR = '[data-seagrass-network-badge]';
const FAILED_TRANSLATION_TTL_MS = 5 * 60 * 1000;
// Covers three 60s attempts and bounded retry delays in the main process.
const TRANSLATION_REQUEST_TIMEOUT_MS = 210 * 1000;
const OUTGOING_ORIGINAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A pending local-send binding is only useful while WhatsApp is creating the
// corresponding bubble. Keeping it for days lets an old same-text send claim
// a new bubble after a reload.
const OUTGOING_ORIGINAL_PENDING_TTL_MS = 15 * 60 * 1000;
// --- Message-scan throttling ---
// WhatsApp Web mutates its DOM almost continuously (animations, timestamps,
// presence, typing state). The MutationObserver below used to scan the whole
// document on every change, which kept scanMessages() running constantly and
// drove CPU to ~80% while a chat was open. Changes are now filtered to
// message-related nodes only, debounced, and rate-limited by a cooldown.
const SCAN_DEBOUNCE_MS = 500;
const SCAN_COOLDOWN_MS = 600;
const SCROLL_DEFER_MS = 200;  // 滚动期间延迟扫描，避免每次 scroll 像素都跑 scanMessages()
const MANUAL_ACTION_REPAIR_COOLDOWN_MS = 1000;
const MANUAL_ACTION_WATCHDOG_MS = 1800;
let scanScheduled = false;
let messageScanCooldownUntil = 0;
let messageScanPending = false;
let scrollFrameRequested = false;
let isScrolling = false;
let scrollEndTimer = null;
let messageScanSequence = 0;
const messageDomPositions = new WeakMap();
// WhatsApp occasionally rebuilds a message subtree after our translation line
// is inserted. Keep manual actions recoverable, but remember removals that our
// own cleanup paths requested so the observer does not re-add them immediately.
const intentionalManualActionRemovals = new WeakSet();
const manualActionRepairAt = new WeakMap();
const defaultTranslationSettings = {
  provider: 'deepseek',
  route: 'default-1',
  sendTranslation: true,
  messageTranslation: true,
  inputLanguage: 'zh',
  sourceLanguage: 'auto',
  targetLanguage: 'zh',
  sendLanguage: 'en',
  skipChineseMessages: true,
  groupTranslation: 'manual',
  fontColor: '#089b87',
  fontSize: '12',
  translationSeparator: false,
};
const providerLabels = {
  deepseek: 'DeepSeek',
};
const translationProviderCodes = ['deepseek'];
const routeLabels = {
  'default-1': '默认线路',
};
const customerStageLabels = Object.freeze({
  new: '新客户',
  intent: '意向客户',
  following: '跟进中',
  won: '已成交',
  invalid: '无效客户',
});
let chatCustomerCache = [];
let chatCustomerRefreshPromise;
let chatTagRenderTimer;
const translationRouteCodes = ['default-1'];
let languageLabels = {
  auto: '自动识别',
  'zh-cn': '中文（简体）',
  'zh-chs': '中文（简体）',
  'zh-hans': '中文（简体）',
  'zh-tw': '中文（繁体）',
  'zh-cht': '中文（繁体）',
  'zh-hant': '中文（繁体）',
};
let customerLanguageOptions = [];
let translationSettings = { ...defaultTranslationSettings };
let platformNetworkInfo = { state: 'loading', ip: '', location: '' };
let networkBadgeMountTimer;
// 在收到主进程注入的当前账号作用域前，不归属到任何工作区。
let workspaceId = '';
let ownerMemberId = '';
let composerTranslationState = 'idle';
let composerTranslationError = '';
let composerTranslationResetTimer;
const hiddenComposerPlaceholders = new WeakMap();
let lastTranslatedComposer = {
  text: '',
  targetLanguage: '',
  conversationKey: '',
};
let rawSendFallback = {
  text: '',
  conversationKey: '',
};
// AI suggestions already arrive in the customer's language.  Keep their
// internal Chinese reference attached to the exact composer text until the
// user actually sends it.  Recording it only when the suggestion is copied
// is racy: WhatsApp may rebuild the composer/message DOM before the send
// bubble exists and the reference then gets lost.
let pendingAiOutgoingOriginal = {
  originalText: '',
  sentText: '',
  conversationKey: '',
};

function configureLanguageCatalog(catalog) {
  if (!Array.isArray(catalog)) return;
  const translationLanguages = catalog.filter(
    (language) => language && typeof language.code === 'string' && typeof language.name === 'string',
  );
  languageLabels = {
    auto: '自动识别',
    ...Object.fromEntries(translationLanguages.map((language) => [language.code, language.name])),
    'zh-cn': '中文（简体）',
    'zh-chs': '中文（简体）',
    'zh-hans': '中文（简体）',
    'zh-tw': '中文（繁体）',
    'zh-cht': '中文（繁体）',
    'zh-hant': '中文（繁体）',
  };
  customerLanguageOptions = [...new Set(translationLanguages.map((language) => language.code))];
}

// 自动扫描级去重：同一条消息在 RECENT_TRANSLATION_DEDUPE_MS 毫秒内重复触发
// 翻译时，直接复用上一次结果，避免滚动扫描/双调用路径重复扣费。用户主动
// 点击“翻译/重新翻译”时会显式绕过这层去重，重新请求 DeepSeek，可能产生 API 用量。
const RECENT_TRANSLATION_DEDUPE_MS = 30_000;
const recentTranslationCache = new Map();
let manualTranslationRequestSequence = 0;

function invokeTranslation(payload, { forceFresh = false } = {}) {
  let timeout;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeout = window.setTimeout(
      () => reject(new Error('translation_request_timeout')),
      TRANSLATION_REQUEST_TIMEOUT_MS,
    );
  });
  // 普通自动请求使用稳定去重键，命中本机缓存时不请求 API。手动请求由
  // 调用方传入一次性幂等键，并跳过前端近期请求去重，确保每次点击都重走
  // 翻译流程；API 实际计费以 DeepSeek 为准。
  const normalizedPayload = forceFresh
    ? {
      ...payload,
      forceFresh: true,
      idempotency_key: payload.idempotency_key
        || `manual:${payload.messageId || 'translation'}:${Date.now()}:${++manualTranslationRequestSequence}`,
    }
    : payload.messageId && !payload.idempotency_key
      ? { ...payload, idempotency_key: `msg:${payload.messageId}` }
      : payload;

  const dedupeKey = forceFresh ? '' : (payload.messageId || payload.idempotency_key);
  if (dedupeKey) {
    const cached = recentTranslationCache.get(dedupeKey);
    if (cached && (cached.pending || Date.now() - cached.at < RECENT_TRANSLATION_DEDUPE_MS)) {
      window.clearTimeout(timeout);
      // 正在请求（包括自动重试）或命中近期缓存时复用同一结果。
      return cached.promise;
    }
  }

  const promise = Promise.race([
    ipcRenderer.invoke('platform:translate', normalizedPayload),
    timeoutPromise,
  ]).finally(() => window.clearTimeout(timeout));

  if (dedupeKey) {
    recentTranslationCache.set(dedupeKey, { promise, at: Date.now(), pending: true });
    promise.then(() => {
      const cached = recentTranslationCache.get(dedupeKey);
      if (cached?.promise === promise) { cached.pending = false; cached.at = Date.now(); }
      // 缓存项保留 RECENT_TRANSLATION_DEDUPE_MS 毫秒后失效；过期清理避免 Map 无限增长。
      setTimeout(() => {
        if (recentTranslationCache.get(dedupeKey)?.promise === promise) {
          recentTranslationCache.delete(dedupeKey);
        }
      }, RECENT_TRANSLATION_DEDUPE_MS + 5_000);
    }, () => {
      // A rejected promise is not a translation result. Keeping it here used
      // to make retries return the same cached failure without a new request.
      if (recentTranslationCache.get(dedupeKey)?.promise === promise) recentTranslationCache.delete(dedupeKey);
    });
  }

  return promise;
}

function requestTranslation(payload, { priority = false, forceFresh = false } = {}) {
  return invokeTranslation(payload, { forceFresh });
}

// Retries are owned by the main process. Do not multiply retries here, and
// never repeat a balance/authentication failure.
function requestTranslationWithSilentRetry(
  payload,
  { priority = false, forceFresh = false } = {},
) {
  return requestTranslation(payload, { priority, forceFresh });
}

function loadTranslationCache() {
  try {
    const value = JSON.parse(window.localStorage.getItem(TRANSLATION_CACHE_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function loadConversationLanguages() {
  try {
    const value = JSON.parse(window.localStorage.getItem(CONVERSATION_LANGUAGE_STORAGE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function loadOutgoingOriginals() {
  try {
    const value = JSON.parse(window.localStorage.getItem(OUTGOING_ORIGINALS_STORAGE_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return compactOutgoingOriginals(value);
  } catch {
    return [];
  }
}

const translationCache = loadTranslationCache();
const conversationLanguages = loadConversationLanguages();
let outgoingOriginals = loadOutgoingOriginals();
// Migrate storage written by older builds immediately. Otherwise stale
// unbound same-text records could survive until the first new send.
saveOutgoingOriginals();
pruneSameLanguageOutgoingCache();

function colorWithAlpha(color, alpha) {
  const value = String(color || '').trim();
  const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu);
  if (!match) return value;
  const hex = match[1].length === 3
    ? match[1].split('').map((channel) => channel + channel).join('')
    : match[1];
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${channels.join(', ')}, ${alpha})`;
}

function translationStyle(conversationKey = currentConversationKey()) {
  const languageState = conversationLanguageState(conversationKey);
  const style = {
    marginTop: '3px',
    color: languageState.fontColor,
    fontSize: `${languageState.fontSize}px`,
    lineHeight: '1.45',
    whiteSpace: 'pre-wrap',
  };
  if (languageState.translationSeparator) {
    style.borderTop = `1px dashed ${colorWithAlpha(languageState.fontColor, 0.38)}`;
    style.paddingTop = '3px';
  }
  return style;
}

function saveTranslationCache() {
  try {
    const keys = Object.keys(translationCache);
    // 保留最近 8000 条翻译缓存（原为 1000 条）。聊天记录一长，老消息的
    // 缓存会被过早清掉，滚动回看时重新翻译并重复扣费——这就是"已翻译过的
    // 消息翻看时再次扣数"的根因之一。8000 条约占 3-4MB localStorage，可接受。
    for (const key of keys.slice(0, Math.max(0, keys.length - 8000))) delete translationCache[key];
    window.localStorage.setItem(TRANSLATION_CACHE_STORAGE_KEY, JSON.stringify(translationCache));
  } catch {
    // Page storage is optional; the in-memory cache still works for this load.
  }
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function normalizedMessageText(value) {
  return String(value ?? '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function shouldRenderOutgoingOriginal(originalText, sentText) {
  const normalizedOriginal = normalizedMessageText(originalText);
  const normalizedSent = normalizedMessageText(sentText);
  if (!normalizedOriginal || !normalizedSent || normalizedOriginal === normalizedSent) return false;

  // A stale binding can differ only by punctuation/wording while both sides
  // are in the same language. Rendering it creates the exact duplicate line
  // seen in the chat screenshot. A real translated send (for example zh ->
  // ja or zh -> en) has different detected scripts and still needs the user's
  // original text below the outgoing bubble.
  const originalLanguage = comparableMessageLanguage(normalizedOriginal);
  const sentLanguage = comparableMessageLanguage(normalizedSent);
  if (
    originalLanguage
    && sentLanguage
    && languagesEquivalent(originalLanguage, sentLanguage)
  ) return false;
  return true;
}

function comparableMessageLanguage(text) {
  const script = inferScriptLanguage(text);
  if (script) return script;
  // Latin text does not identify one language reliably (English, French,
  // Spanish and many others use the same script). Keep it unknown here so a
  // real English -> French/Spanish translation is not removed as a
  // same-language duplicate. Exact text equality is handled separately.
  return '';
}

function clearSameLanguageOutgoingState(message, text, messageKey, cached) {
  const messageLanguage = comparableMessageLanguage(text);
  if (!messageLanguage) return;

  message.querySelectorAll('[data-seagrass-translation]').forEach((node) => {
    const translationLanguage = comparableMessageLanguage(node.textContent || '');
    if (translationLanguage && languagesEquivalent(translationLanguage, messageLanguage)) node.remove();
  });

  if (
    cached?.text
    && (cached.kind === 'outgoing-original' || cached.provider === 'composer-original')
    && languagesEquivalent(comparableMessageLanguage(cached.text), messageLanguage)
  ) {
    delete translationCache[messageKey];
    saveTranslationCache();
  }
}

function pruneSameLanguageOutgoingCache() {
  let changed = false;
  for (const item of outgoingOriginals) {
    if (!item?.messageId || shouldRenderOutgoingOriginal(item.originalText, item.sentText)) continue;
    const cached = translationCache[item.messageId];
    if (cached?.kind === 'outgoing-original' || cached?.provider === 'composer-original') {
      delete translationCache[item.messageId];
      changed = true;
    }
  }
  if (changed) saveTranslationCache();
}

function compactOutgoingOriginals(items) {
  const now = Date.now();
  const bound = [];
  const pending = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.conversationKey || !item?.originalText || !item?.sentText) continue;
    const createdAt = Number(item.createdAt || 0);
    if (!Number.isFinite(createdAt) || now - createdAt > OUTGOING_ORIGINAL_TTL_MS) continue;

    if (item.messageId) {
      bound.push(item);
      continue;
    }

    if (now - createdAt > OUTGOING_ORIGINAL_PENDING_TTL_MS) continue;
    const key = `${item.conversationKey}:${normalizedMessageText(item.originalText)}:${normalizedMessageText(item.sentText)}`;
    const previous = pending.get(key);
    if (!previous || Number(previous.createdAt || 0) <= createdAt) pending.set(key, item);
  }

  return [...bound, ...pending.values()]
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
    .slice(-500);
}

function saveOutgoingOriginals() {
  try {
    outgoingOriginals = compactOutgoingOriginals(outgoingOriginals);
    window.localStorage.setItem(OUTGOING_ORIGINALS_STORAGE_KEY, JSON.stringify(outgoingOriginals));
  } catch {
    // The normal translation cache remains available if page storage is unavailable.
  }
}

function visibleOutgoingMessageIds(sentText) {
  const normalizedSentText = normalizedMessageText(sentText);
  return visibleMessageRoots()
    .filter((message) => messageDirection(message) === 'outgoing')
    .map((message) => {
      const anchor = findMessageText(message);
      const text = normalizedMessageText(anchor?.textContent);
      return text === normalizedSentText ? messageIdFor(message, text) : '';
    })
    .filter(Boolean)
    .slice(-100);
}

function rememberOutgoingOriginal(originalText, sentText, conversationKey) {
  const normalizedOriginal = normalizedMessageText(originalText);
  const normalizedSent = normalizedMessageText(sentText);
  if (!normalizedOriginal || !normalizedSent || !conversationKey) return '';

  // A message can be observed several times while WhatsApp replaces the
  // composer bubble. Keep one pending binding per original/sent pair so a
  // repeated DOM scan cannot consume the same mapping for another bubble.
  const existing = outgoingOriginals.find((item) => (
    !item.messageId
    && item.conversationKey === conversationKey
    && normalizedMessageText(item.originalText) === normalizedOriginal
    && normalizedMessageText(item.sentText) === normalizedSent
  ));
  if (existing) {
    existing.createdAt = Date.now();
    // Keep a single pending binding for identical consecutive sends. Older
    // builds created several unbound records and could match one bubble more
    // than once after WhatsApp rebuilt the message list.
    outgoingOriginals = outgoingOriginals.filter((item) => (
      item === existing
      || item.messageId
      || item.conversationKey !== conversationKey
      || normalizedMessageText(item.originalText) !== normalizedOriginal
      || normalizedMessageText(item.sentText) !== normalizedSent
    ));
    saveOutgoingOriginals();
    return existing.id;
  }

  const id = `${Date.now()}:${stableHash(`${conversationKey}:${normalizedOriginal}:${normalizedSent}`)}`;
  outgoingOriginals.push({
    id,
    conversationKey,
    originalText: normalizedOriginal,
    sentText: normalizedSent,
    ignoredMessageIds: visibleOutgoingMessageIds(normalizedSent),
    createdAt: Date.now(),
    messageId: '',
  });
  saveOutgoingOriginals();
  return id;
}

function originalForOutgoingMessage(messageId, sentText, conversationKey) {
  const normalizedSent = normalizedMessageText(sentText);
  if (!messageId || !normalizedSent || !conversationKey) return '';

  const alreadyBound = outgoingOriginals.find(
    (item) => item.messageId === messageId && item.conversationKey === conversationKey,
  );
  if (alreadyBound?.originalText) return alreadyBound.originalText;

  const candidate = outgoingOriginals.slice().reverse().find((item) => (
    !item.messageId
    && item.conversationKey === conversationKey
    && normalizedMessageText(item.sentText) === normalizedSent
    && !item.ignoredMessageIds?.includes(messageId)
  ));
  if (!candidate) return '';

  candidate.messageId = messageId;
  candidate.matchedAt = Date.now();
  saveOutgoingOriginals();
  return candidate.originalText;
}

function renderOutgoingOriginal(message, anchor, sentText, originalText, conversationKey, messageKey) {
  const normalizedSent = normalizedMessageText(sentText);
  const normalizedOriginal = normalizedMessageText(originalText);
  if (!normalizedSent || !normalizedOriginal) return false;

  // If the outgoing message was sent unchanged, there is no useful second
  // line. More importantly, do not send the same text through the translation
  // API just because message scanning revisited the bubble.
  if (!shouldRenderOutgoingOriginal(normalizedOriginal, normalizedSent)) {
    message.querySelectorAll('[data-seagrass-translation]').forEach((node) => node.remove());
    emitConversationMessage(message, sentText);
    return true;
  }

  const translation = ensureTranslationNode(message, anchor, messageKey);
  translation.setAttribute('data-seagrass-translation', '');
  translation.textContent = originalText;
  Object.assign(translation.style, translationStyle(conversationKey));
  if (!translation.isConnected) anchor.parentElement?.appendChild(translation);

  translationCache[messageKey] = {
    text: originalText,
    provider: 'composer-original',
    sourceLanguage: conversationLanguageState(conversationKey).inputLanguage,
    targetLanguage: conversationLanguageState(conversationKey).outgoingResolved || translationSettings.targetLanguage,
    kind: 'outgoing-original',
  };
  saveTranslationCache();
  emitConversationMessage(message, sentText, {
    text: sentText,
    provider: 'composer-original',
  });
  return true;
}

function ensureTranslationNode(message, anchor, messageKey = '') {
  const nodes = [...message.querySelectorAll('[data-seagrass-translation]')];
  const translation = nodes.shift() || document.createElement('div');
  for (const duplicate of nodes) duplicate.remove();
  translation.setAttribute('data-seagrass-translation', '');
  if (messageKey) translation.setAttribute('data-seagrass-message-key', messageKey);
  const targetParent = anchor?.parentElement;
  if (targetParent && translation.parentElement !== targetParent) targetParent.appendChild(translation);
  else if (!translation.isConnected) targetParent?.appendChild(translation);
  return translation;
}

function renderCachedDisplayTranslation(message, anchor, cached, messageKey, conversationKey, plan = null) {
  if (!cached?.text) return false;
  const translation = ensureTranslationNode(message, anchor, messageKey);
  translation.textContent = cached.text;
  Object.assign(translation.style, translationStyle(conversationKey));
  if (plan) ensureManualTranslationAction(message, anchor, plan, 'translated');
  return true;
}

function languageLabel(language) {
  const normalized = String(language || 'auto').trim().toLowerCase();
  return languageLabels[normalized] || String(language || '自动识别');
}

function conversationKeyFromDataId(dataId) {
  const match = String(dataId || '').match(/^(?:true|false)_([^_]+)_/i);
  return match?.[1] ? `chat:${stableHash(match[1])}` : '';
}

function conversationKeyForMessage(message) {
  // Prefer the active conversation identity. WhatsApp message data-id values
  // are message-scoped and can use a different namespace from the stable
  // contact key used by the local/cloud archive. Mixing the two makes the AI
  // panel see an empty conversation even though the chat is visibly populated.
  const activeKey = currentConversationKey();
  if (activeKey) return activeKey;
  const dataNode = [message, message.closest('[data-id]')].find(
    (node) => node?.getAttribute?.('data-id'),
  );
  return conversationKeyFromDataId(dataNode?.getAttribute('data-id')) || currentConversationKey();
}

function currentConversationKey() {
  const main = document.querySelector('[data-testid="conversation-panel-wrapper"]')
    || document.querySelector('#main');
  const headerTitle = document.querySelector(
    '[data-testid="conversation-header"] [data-testid="conversation-info-header-chat-title"]',
  )?.textContent?.trim()
    || document.querySelector(
      '#main header [data-testid="conversation-info-header-chat-title"]',
    )?.textContent?.trim();
  const selectedChatTitle = [...document.querySelectorAll('[aria-selected="true"]')]
    .map((node) => node.querySelector('[data-testid="cell-frame-title"]')?.textContent?.trim())
    .find(Boolean);
  const identity = headerTitle || selectedChatTitle;
  if (identity) return `contact:${stableHash(`${location.hostname}:${identity}`)}`;

  if (main) {
    for (const node of main.querySelectorAll('[data-id]')) {
      const key = conversationKeyFromDataId(node.getAttribute('data-id'));
      if (key) return key;
    }
  }
  return '';
}

function inferScriptLanguage(text) {
  if (/[฀-๿]/u.test(text)) return 'th';
  if (/[가-힯]/u.test(text)) return 'ko';
  if (/[぀-ヿ]/u.test(text)) return 'ja';
  if (/[؀-ۿ]/u.test(text)) return 'ar';
  if (/[Ѐ-ӿ]/u.test(text)) return 'ru';
  if (/[㐀-䶿一-鿿豈-﫿]/u.test(text)) return 'zh';
  return '';
}

function normalizeLanguageCode(language) {
  const value = String(language || '').trim().toLowerCase().replaceAll('_', '-');
  if (!value || value === 'auto') return '';
  if (value === 'cht' || value.startsWith('zh')) return 'zh';
  if (value.startsWith('en')) return 'en';
  if (value.startsWith('pt')) return 'pt';
  return value.split('-')[0];
}

function languagesEquivalent(left, right) {
  const normalizedLeft = normalizeLanguageCode(left);
  const normalizedRight = normalizeLanguageCode(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function shouldSkipIncomingTranslation({ inferredLanguage, sourceLanguage, targetLanguage, skipChineseMessages }) {
  // The message's detected script is the strongest signal for the no-op rule.
  // A stale/manual customer language must not force Chinese text through an
  // English source setting and back into Chinese.
  const source = normalizeLanguageCode(inferredLanguage) || normalizeLanguageCode(sourceLanguage);
  const target = normalizeLanguageCode(targetLanguage);
  return Boolean(
    (skipChineseMessages && normalizeLanguageCode(inferredLanguage) === 'zh')
    || languagesEquivalent(source, target),
  );
}

function shouldSkipOutgoingDisplayTranslation({ text, inferredLanguage, targetLanguage, skipChineseMessages }) {
  const source = normalizeLanguageCode(inferredLanguage)
    || (/[\u3400-\u9fff]/u.test(String(text || '')) ? 'zh' : '');
  const target = normalizeLanguageCode(targetLanguage);
  return Boolean(
    (skipChineseMessages && source === 'zh')
    || languagesEquivalent(source, target),
  );
}

function translationCacheMatches(cached, { provider, sourceLanguage, targetLanguage }) {
  if (!cached || (!cached.text && cached.status !== 'failed')) return false;
  if (cached.kind === 'outgoing-original' || cached.provider === 'composer-original') return true;
  if (provider && cached.provider && cached.provider !== provider) return false;
  if (targetLanguage && cached.targetLanguage && !languagesEquivalent(cached.targetLanguage, targetLanguage)) return false;
  if (
    sourceLanguage
    && sourceLanguage !== 'auto'
    && cached.sourceLanguage
    && !languagesEquivalent(cached.sourceLanguage, sourceLanguage)
  ) return false;
  return true;
}

// A manual click is a deliberate preview/retry of the text currently shown
// in the platform bubble.  For locally translated outgoing messages the
// normal cache entry is the Chinese composer reference, so it must not win
// over a fresh manual result when WhatsApp rebuilds the bubble.
function isManualDisplayTranslation(cached, sourceText = '') {
  if (!cached?.text) return false;
  if (cached.kind !== 'manual-display' && cached.manual !== true) return false;
  return normalizedMessageText(cached.text) !== normalizedMessageText(sourceText);
}

function saveConversationLanguages() {
  try {
    const entries = Object.entries(conversationLanguages)
      .sort((left, right) => (left[1]?.updatedAt || 0) - (right[1]?.updatedAt || 0))
      .slice(-200);
    window.localStorage.setItem(
      CONVERSATION_LANGUAGE_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Conversation language history is a local convenience only.
  }
}

function recordConversationLanguage(language, conversationKey) {
  const normalized = String(language || '').trim().toLowerCase();
  if (!normalized || normalized === 'auto' || !conversationKey) return;
  const current = conversationLanguages[conversationKey] || {};
  const previousDetected = current.detectedLanguage || current.language;
  if (previousDetected !== normalized) {
    conversationLanguages[conversationKey] = {
      ...current,
      language: undefined,
      detectedLanguage: normalized,
      updatedAt: Date.now(),
    };
    saveConversationLanguages();
  }
  updateTranslationStatus();
}

function conversationLanguageEntry(conversationKey) {
  if (!conversationKey) return {};
  if (conversationLanguages[conversationKey]) return conversationLanguages[conversationKey];
  if (!conversationKey.startsWith('contact:')) return {};

  const legacyEntry = Object.entries(conversationLanguages)
    .filter(([key]) => key.startsWith('view:'))
    .sort((left, right) => (right[1]?.updatedAt || 0) - (left[1]?.updatedAt || 0))[0];
  if (!legacyEntry) return {};

  const [legacyKey, legacyValue] = legacyEntry;
  conversationLanguages[conversationKey] = {
    ...legacyValue,
    updatedAt: Date.now(),
  };
  delete conversationLanguages[legacyKey];
  saveConversationLanguages();
  return conversationLanguages[conversationKey];
}

function conversationLanguageState(conversationKey = currentConversationKey()) {
  const entry = conversationLanguageEntry(conversationKey);
  const preferred = String(entry.preferredLanguage || '').trim().toLowerCase();
  const detected = String(entry.detectedLanguage || entry.language || '').trim().toLowerCase();
  const providerOverride = String(entry.preferredProvider || '').trim().toLowerCase();
  const windowProvider = String(translationSettings.provider || '').trim().toLowerCase();
  const provider = translationProviderCodes.includes(providerOverride)
    ? providerOverride
    : translationProviderCodes.includes(windowProvider)
      ? windowProvider
      : defaultTranslationSettings.provider;
  const route = defaultTranslationSettings.route;
  const hasStringOverride = (key) => (
    Object.prototype.hasOwnProperty.call(entry, key)
    && typeof entry[key] === 'string'
    && entry[key].trim()
  );
  const stringOverride = (key) => (
    hasStringOverride(key) ? String(entry[key]).trim().toLowerCase() : ''
  );
  const hasBooleanOverride = (key) => typeof entry[key] === 'boolean';
  const windowInputLanguage = String(
    translationSettings.inputLanguage
      || translationSettings.targetLanguage
      || defaultTranslationSettings.inputLanguage,
  ).trim().toLowerCase();
  const windowSourceLanguage = String(
    translationSettings.sourceLanguage || defaultTranslationSettings.sourceLanguage,
  ).trim().toLowerCase();
  const windowTargetLanguage = String(
    translationSettings.targetLanguage || defaultTranslationSettings.targetLanguage,
  ).trim().toLowerCase();
  const windowSendFallback = translationSettings.sendLanguage !== 'auto'
    ? String(translationSettings.sendLanguage || '').trim().toLowerCase()
    : '';
  const hasSendLanguageOverride = hasStringOverride('sendLanguageOverride');
  const sendLanguage = hasSendLanguageOverride
    ? stringOverride('sendLanguageOverride')
    : preferred || String(translationSettings.sendLanguage || 'auto').trim().toLowerCase();
  const inputLanguage = stringOverride('inputLanguageOverride') || windowInputLanguage;
  const sourceLanguage = stringOverride('sourceLanguageOverride')
    || windowSourceLanguage
    || 'auto';
  const targetLanguage = stringOverride('targetLanguageOverride') || windowTargetLanguage;
  const sendTranslation = hasBooleanOverride('sendTranslationOverride')
    ? entry.sendTranslationOverride
    : Boolean(translationSettings.sendTranslation);
  const messageTranslation = hasBooleanOverride('messageTranslationOverride')
    ? entry.messageTranslationOverride
    : Boolean(translationSettings.messageTranslation);
  const skipChineseMessages = hasBooleanOverride('skipChineseMessagesOverride')
    ? entry.skipChineseMessagesOverride
    : Boolean(translationSettings.skipChineseMessages);
  const groupTranslation = stringOverride('groupTranslationOverride')
    || translationSettings.groupTranslation
    || defaultTranslationSettings.groupTranslation;
  const fontColor = stringOverride('fontColorOverride')
    || translationSettings.fontColor
    || defaultTranslationSettings.fontColor;
  const fontSize = stringOverride('fontSizeOverride')
    || translationSettings.fontSize
    || defaultTranslationSettings.fontSize;
  const translationSeparator = Boolean(translationSettings.translationSeparator);
  const autoOutgoingFallback = detected
    || (sourceLanguage !== 'auto' ? sourceLanguage : '')
    || windowSendFallback;
  return {
    key: conversationKey,
    entry,
    preferred,
    detected,
    providerOverride: translationProviderCodes.includes(providerOverride) ? providerOverride : '',
    routeOverride: '',
    provider,
    route,
    sendTranslation,
    messageTranslation,
    sendTranslationOverride: hasBooleanOverride('sendTranslationOverride')
      ? entry.sendTranslationOverride
      : undefined,
    messageTranslationOverride: hasBooleanOverride('messageTranslationOverride')
      ? entry.messageTranslationOverride
      : undefined,
    inputLanguage,
    inputLanguageOverride: stringOverride('inputLanguageOverride'),
    sourceLanguage,
    sourceLanguageOverride: stringOverride('sourceLanguageOverride'),
    targetLanguage,
    targetLanguageOverride: stringOverride('targetLanguageOverride'),
    sendLanguage,
    sendLanguageOverride: hasSendLanguageOverride ? stringOverride('sendLanguageOverride') : '',
    skipChineseMessages,
    skipChineseMessagesOverride: hasBooleanOverride('skipChineseMessagesOverride')
      ? entry.skipChineseMessagesOverride
      : undefined,
    groupTranslation,
    groupTranslationOverride: stringOverride('groupTranslationOverride'),
    fontColor,
    fontColorOverride: stringOverride('fontColorOverride'),
    fontSize,
    fontSizeOverride: stringOverride('fontSizeOverride'),
    translationSeparator,
    windowSendFallback,
    incomingRequestLanguage: sourceLanguage || 'auto',
    incomingTargetLanguage: targetLanguage,
    incomingResolved: sourceLanguage !== 'auto' ? sourceLanguage : detected,
    // 「自动跟随当前客户」已移除：历史 auto 配置一律按默认英语处理。
    outgoingResolved: sendLanguage !== 'auto' && sendLanguage ? sendLanguage : 'en',
  };
}

function setPreferredConversationLanguage(language, { refresh = true } = {}) {
  const state = conversationLanguageState();
  if (!state.key) return;
  const current = conversationLanguages[state.key] || {};
  const normalized = String(language || '').trim().toLowerCase();
  const next = { ...current, updatedAt: Date.now() };
  if (!normalized || normalized === 'auto') {
    delete next.preferredLanguage;
    delete next.sendLanguageOverride;
  } else {
    next.preferredLanguage = normalized;
    next.sendLanguageOverride = normalized;
  }
  conversationLanguages[state.key] = next;
  saveConversationLanguages();
  rawSendFallback = { text: '', conversationKey: '' };
  if (composerTranslationState !== 'loading') composerTranslationState = 'idle';
  if (refresh) {
    refreshMessageTranslations();
    updateTranslationStatus();
  }
}

function setConversationTranslationOverrides(provider, route, { refresh = true } = {}) {
  const state = conversationLanguageState();
  if (!state.key) return;
  const current = conversationLanguages[state.key] || {};
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const next = { ...current, updatedAt: Date.now() };
  if (translationProviderCodes.includes(normalizedProvider)) {
    next.preferredProvider = normalizedProvider;
  } else {
    delete next.preferredProvider;
  }
  delete next.preferredRoute;
  conversationLanguages[state.key] = next;
  saveConversationLanguages();
  rawSendFallback = { text: '', conversationKey: '' };
  if (composerTranslationState !== 'loading') composerTranslationState = 'idle';
  if (refresh) {
    refreshMessageTranslations();
    updateTranslationStatus();
  }
}

const conversationOverrideKeys = [
  'preferredLanguage',
  'preferredProvider',
  'sendTranslationOverride',
  'messageTranslationOverride',
  'inputLanguageOverride',
  'sendLanguageOverride',
  'sourceLanguageOverride',
  'targetLanguageOverride',
  'skipChineseMessagesOverride',
  'groupTranslationOverride',
  'fontColorOverride',
  'fontSizeOverride',
];

function setConversationSettingsOverrides(overrides = {}, { refresh = true } = {}) {
  const state = conversationLanguageState();
  if (!state.key) return;
  const current = conversationLanguages[state.key] || {};
  const next = { ...current, updatedAt: Date.now() };
  for (const key of conversationOverrideKeys) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    const value = overrides[key];
    if (value === undefined || value === null || value === '' || value === 'inherit') delete next[key];
    else next[key] = value;
  }
  delete next.preferredRoute;
  conversationLanguages[state.key] = next;
  saveConversationLanguages();
  rawSendFallback = { text: '', conversationKey: '' };
  if (composerTranslationState !== 'loading') composerTranslationState = 'idle';
  if (refresh) {
    refreshMessageTranslations();
    updateTranslationStatus();
  }
}

function clearConversationSettingsOverrides({ refresh = true } = {}) {
  setConversationSettingsOverrides(
    Object.fromEntries(conversationOverrideKeys.map((key) => [key, undefined])),
    { refresh },
  );
}

function updateCustomerServiceControls(popover, languageState = conversationLanguageState()) {
  if (!popover) return;
  const providerSelect = popover.querySelector('[data-seagrass-customer-provider]');
  const routeSelect = popover.querySelector('[data-seagrass-customer-route]');
  const effective = popover.querySelector('[data-seagrass-customer-effective]');
  if (!providerSelect || !routeSelect) return;
  const isOpen = !popover.hidden && popover.style.display !== 'none';
  if (!isOpen) {
    providerSelect.value = languageState.providerOverride || 'inherit';
    routeSelect.value = 'default-1';
  }
  const selectedProvider = providerSelect.value === 'inherit'
    ? languageState.provider
    : providerSelect.value;
  if (effective) {
    const providerLabel = providerLabels[selectedProvider] || providerLabels[languageState.provider] || '翻译服务';
    const routeLabel = routeLabels[defaultTranslationSettings.route];
    effective.textContent = `当前生效：${providerLabel} / ${routeLabel}`;
  }
}

function populateCustomerLanguageSelect(select, { includeAuto = false } = {}) {
  if (!select) return;
  const previous = select.value;
  select.replaceChildren();
  const inheritOption = document.createElement('option');
  inheritOption.value = 'inherit';
  inheritOption.textContent = '跟随窗口默认';
  select.appendChild(inheritOption);
  if (includeAuto) {
    const autoOption = document.createElement('option');
    autoOption.value = 'auto';
    autoOption.textContent = '自动检测';
    select.appendChild(autoOption);
  }
  for (const language of customerLanguageOptions) {
    const option = document.createElement('option');
    option.value = language;
    option.textContent = languageLabel(language);
    select.appendChild(option);
  }
  select.value = [...select.options].some((option) => option.value === previous) ? previous : 'inherit';
}

function syncCustomerLanguageSelects(popover) {
  if (!popover) return;
  populateCustomerLanguageSelect(popover.querySelector('[data-seagrass-customer-input-language]'), { includeAuto: true });
  populateCustomerLanguageSelect(popover.querySelector('[data-seagrass-customer-send-language]'));
  populateCustomerLanguageSelect(popover.querySelector('[data-seagrass-customer-source-language]'), { includeAuto: true });
  populateCustomerLanguageSelect(popover.querySelector('[data-seagrass-customer-target-language]'));
}

function setSelectValue(select, value, fallback = 'inherit') {
  if (!select) return;
  const next = String(value || fallback);
  select.value = [...select.options].some((option) => option.value === next) ? next : fallback;
}

function updateCustomerModeControls(popover) {
  if (!popover) return;
  const sendInherit = popover.querySelector('[data-seagrass-customer-send-inherit]');
  const messageInherit = popover.querySelector('[data-seagrass-customer-message-inherit]');
  const sendEnabled = popover.querySelector('[data-seagrass-customer-send-enabled]');
  const messageEnabled = popover.querySelector('[data-seagrass-customer-message-enabled]');
  if (sendEnabled && sendInherit) {
    sendEnabled.disabled = sendInherit.checked;
    sendEnabled.closest('[data-seagrass-customer-switch]')?.classList.toggle('is-inherited', sendInherit.checked);
  }
  if (messageEnabled && messageInherit) {
    messageEnabled.disabled = messageInherit.checked;
    messageEnabled.closest('[data-seagrass-customer-switch]')?.classList.toggle('is-inherited', messageInherit.checked);
  }
  const colorInherit = popover.querySelector('[data-seagrass-customer-color-inherit]');
  const fontColor = popover.querySelector('[data-seagrass-customer-font-color]');
  if (fontColor && colorInherit) fontColor.disabled = colorInherit.checked;
}

function updateCustomerPreview(popover) {
  const preview = popover?.querySelector('[data-seagrass-customer-preview]');
  if (!preview) return;
  const state = conversationLanguageState();
  const fontSizeSelect = popover.querySelector('[data-seagrass-customer-font-size]');
  const fontColor = popover.querySelector('[data-seagrass-customer-font-color]');
  preview.style.fontSize = `${fontSizeSelect?.value === 'inherit' ? state.fontSize : fontSizeSelect?.value || state.fontSize}px`;
  preview.style.color = popover.querySelector('[data-seagrass-customer-color-inherit]')?.checked
    ? state.fontColor
    : fontColor?.value || state.fontColor;
}

function updateCustomerWindowStateHints(popover) {
  if (!popover) return;
  const setHint = (key, inherited, windowValue) => {
    const hint = popover.querySelector(`[data-seagrass-window-state="${key}"]`);
    if (!hint) return;
    hint.textContent = inherited ? `窗口当前：${windowValue}` : '当前客户：单独设置';
    hint.classList.toggle('is-customer-override', !inherited);
  };
  const selectInherits = (selector) => popover.querySelector(selector)?.value === 'inherit';
  const fontSizeLabel = {
    11: '小（11px）',
    12: '中（12px）',
    14: '大（14px）',
  }[String(translationSettings.fontSize)] || `${translationSettings.fontSize || defaultTranslationSettings.fontSize}px`;
  setHint(
    'send-enabled',
    popover.querySelector('[data-seagrass-customer-send-inherit]')?.checked,
    translationSettings.sendTranslation ? '已开启' : '已关闭',
  );
  setHint(
    'message-enabled',
    popover.querySelector('[data-seagrass-customer-message-inherit]')?.checked,
    translationSettings.messageTranslation ? '已开启' : '已关闭',
  );
  setHint('send-language', selectInherits('[data-seagrass-customer-send-language]'), languageLabel(translationSettings.sendLanguage));
  setHint('source-language', selectInherits('[data-seagrass-customer-source-language]'), languageLabel(translationSettings.sourceLanguage));
  setHint('target-language', selectInherits('[data-seagrass-customer-target-language]'), languageLabel(translationSettings.targetLanguage));
  setHint(
    'skip-chinese',
    selectInherits('[data-seagrass-customer-skip-chinese]'),
    translationSettings.skipChineseMessages ? '已开启，不调用接口' : '已关闭',
  );
  setHint(
    'group-translation',
    selectInherits('[data-seagrass-customer-group-translation]'),
    translationSettings.groupTranslation === 'auto' ? '自动翻译群组消息' : '手动翻译群组消息',
  );
  setHint(
    'provider',
    selectInherits('[data-seagrass-customer-provider]'),
    providerLabels[translationSettings.provider] || providerLabels[defaultTranslationSettings.provider] || '翻译服务',
  );
  setHint('font-size', selectInherits('[data-seagrass-customer-font-size]'), fontSizeLabel);
  setHint(
    'font-color',
    popover.querySelector('[data-seagrass-customer-color-inherit]')?.checked,
    String(translationSettings.fontColor || defaultTranslationSettings.fontColor).toUpperCase(),
  );
}

function populateCustomerTranslationControls(popover, languageState = conversationLanguageState(), { force = false } = {}) {
  if (!popover) return;
  const isOpen = !popover.hidden && popover.style.display !== 'none';
  if (isOpen && !force) return;
  syncCustomerLanguageSelects(popover);
  const sendInherit = popover.querySelector('[data-seagrass-customer-send-inherit]');
  const messageInherit = popover.querySelector('[data-seagrass-customer-message-inherit]');
  const sendEnabled = popover.querySelector('[data-seagrass-customer-send-enabled]');
  const messageEnabled = popover.querySelector('[data-seagrass-customer-message-enabled]');
  sendInherit.checked = languageState.sendTranslationOverride === undefined;
  messageInherit.checked = languageState.messageTranslationOverride === undefined;
  sendEnabled.checked = languageState.sendTranslation;
  messageEnabled.checked = languageState.messageTranslation;
  setSelectValue(popover.querySelector('[data-seagrass-customer-provider]'), languageState.providerOverride || 'inherit');
  setSelectValue(popover.querySelector('[data-seagrass-customer-route]'), 'default-1', 'default-1');
  setSelectValue(popover.querySelector('[data-seagrass-customer-input-language]'), languageState.inputLanguageOverride || 'inherit');
  setSelectValue(
    popover.querySelector('[data-seagrass-customer-send-language]'),
    languageState.sendLanguageOverride || (languageState.preferred ? languageState.preferred : 'inherit'),
  );
  setSelectValue(popover.querySelector('[data-seagrass-customer-source-language]'), languageState.sourceLanguageOverride || 'inherit');
  setSelectValue(popover.querySelector('[data-seagrass-customer-target-language]'), languageState.targetLanguageOverride || 'inherit');
  setSelectValue(
    popover.querySelector('[data-seagrass-customer-skip-chinese]'),
    languageState.skipChineseMessagesOverride === undefined
      ? 'inherit'
      : String(languageState.skipChineseMessagesOverride),
  );
  setSelectValue(popover.querySelector('[data-seagrass-customer-group-translation]'), languageState.groupTranslationOverride || 'inherit');
  setSelectValue(popover.querySelector('[data-seagrass-customer-font-size]'), languageState.fontSizeOverride || 'inherit');
  const colorInherit = popover.querySelector('[data-seagrass-customer-color-inherit]');
  const fontColor = popover.querySelector('[data-seagrass-customer-font-color]');
  colorInherit.checked = !languageState.fontColorOverride;
  fontColor.value = languageState.fontColor;
  updateCustomerModeControls(popover);
  updateCustomerPreview(popover);
  updateCustomerServiceControls(popover, languageState);
  updateCustomerWindowStateHints(popover);
}

function customerTranslationOverridesFromPopover(popover) {
  const value = (selector) => popover.querySelector(selector)?.value || 'inherit';
  const optionalString = (selector) => {
    const selected = value(selector);
    return selected === 'inherit' ? undefined : selected;
  };
  const sendInherit = popover.querySelector('[data-seagrass-customer-send-inherit]').checked;
  const messageInherit = popover.querySelector('[data-seagrass-customer-message-inherit]').checked;
  const skipChinese = value('[data-seagrass-customer-skip-chinese]');
  const colorInherit = popover.querySelector('[data-seagrass-customer-color-inherit]').checked;
  const sendLanguage = optionalString('[data-seagrass-customer-send-language]');
  return {
    preferredLanguage: sendLanguage && sendLanguage !== 'auto' ? sendLanguage : undefined,
    preferredProvider: optionalString('[data-seagrass-customer-provider]'),
    sendTranslationOverride: sendInherit
      ? undefined
      : popover.querySelector('[data-seagrass-customer-send-enabled]').checked,
    messageTranslationOverride: messageInherit
      ? undefined
      : popover.querySelector('[data-seagrass-customer-message-enabled]').checked,
    inputLanguageOverride: optionalString('[data-seagrass-customer-input-language]'),
    sendLanguageOverride: sendLanguage,
    sourceLanguageOverride: optionalString('[data-seagrass-customer-source-language]'),
    targetLanguageOverride: optionalString('[data-seagrass-customer-target-language]'),
    skipChineseMessagesOverride: skipChinese === 'inherit' ? undefined : skipChinese === 'true',
    groupTranslationOverride: optionalString('[data-seagrass-customer-group-translation]'),
    fontColorOverride: colorInherit
      ? undefined
      : popover.querySelector('[data-seagrass-customer-font-color]').value,
    fontSizeOverride: optionalString('[data-seagrass-customer-font-size]'),
  };
}

function ensureCustomerSettingsStyles() {
  if (document.querySelector('[data-seagrass-customer-settings-styles]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-seagrass-customer-settings-styles', '');
  style.textContent = `
    [data-seagrass-customer-popover] {
      position: fixed; z-index: 2147483647; width: min(820px, calc(100vw - 24px));
      max-height: calc(100vh - 32px); display: none; grid-template-rows: auto minmax(0, 1fr) auto;
      overflow: hidden; border: 1px solid #d8e3ec; border-radius: 12px; background: #fff;
      box-shadow: 0 22px 64px rgba(29, 52, 79, .22); color: #40576f;
      font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; white-space: normal;
      box-sizing: border-box;
    }
    [data-seagrass-customer-popover] *, [data-seagrass-customer-popover] *::before,
    [data-seagrass-customer-popover] *::after { box-sizing: border-box; }
    [data-seagrass-customer-dialog-head] {
      min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 18px;
      padding: 0 24px; border-bottom: 1px solid #e2e9ef; background: #fff;
    }
    [data-seagrass-customer-dialog-head] > div { min-width: 0; display: grid; gap: 4px; }
    [data-seagrass-customer-title] { color: #102d4d; font-size: 18px; font-weight: 700; }
    [data-seagrass-customer-dialog-head] small { color: #7b8da1; font-size: 11px; font-weight: 400; }
    [data-seagrass-customer-close] {
      width: 30px; height: 30px; padding: 0; border: 0; border-radius: 6px; background: transparent;
      color: #7d8ea0; font: 22px/28px system-ui, sans-serif; cursor: pointer;
    }
    [data-seagrass-customer-close]:hover { color: #244c72; background: #f1f5f8; }
    [data-seagrass-customer-body] { min-height: 0; overflow: auto; padding: 16px 18px 20px; background: #f7fafc; }
    [data-seagrass-customer-mode-grid] {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;
    }
    [data-seagrass-customer-rules] { display: block; }
    [data-seagrass-customer-mode-card] {
      min-height: 88px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start;
      gap: 8px 14px; padding: 14px 16px; border: 1px solid #dce5ed; border-radius: 8px; background: #fff;
    }
    [data-seagrass-customer-mode-card] > div { display: grid; gap: 4px; }
    [data-seagrass-customer-mode-card] strong { color: #183955; font-size: 14px; }
    [data-seagrass-customer-mode-card] small { color: #2372e8; font-size: 10px; }
    [data-seagrass-customer-mode-card] small b { margin: 0 5px; font-weight: 500; }
    [data-seagrass-customer-inherit] {
      grid-column: 1 / -1; display: inline-flex; align-items: center; gap: 6px; width: max-content;
      color: #718398; font-size: 10px; cursor: pointer;
    }
    [data-seagrass-window-state] {
      display: block; margin-top: 1px; color: #078579; font-size: 9px; font-weight: 500; line-height: 1.35;
    }
    [data-seagrass-window-state].is-customer-override { color: #2372e8; }
    [data-seagrass-customer-mode-card] > [data-seagrass-window-state] { grid-column: 1 / -1; margin-top: -4px; }
    [data-seagrass-customer-inherit] input, [data-seagrass-customer-color-field] input[type="checkbox"] {
      width: 14px; height: 14px; margin: 0; accent-color: #0aa594;
    }
    [data-seagrass-customer-switch] { position: relative; cursor: pointer; }
    [data-seagrass-customer-switch] input { position: absolute; opacity: 0; pointer-events: none; }
    [data-seagrass-customer-switch] i {
      width: 38px; height: 22px; position: relative; display: block; border-radius: 14px; background: #bcc8d3;
    }
    [data-seagrass-customer-switch] i::after {
      position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; content: "";
      border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(25,54,79,.22);
    }
    [data-seagrass-customer-switch] input:checked + i { background: #0aa594; }
    [data-seagrass-customer-switch] input:checked + i::after { transform: translateX(16px); }
    [data-seagrass-customer-switch].is-inherited { opacity: .65; cursor: default; }
    [data-seagrass-customer-section] {
      display: grid; gap: 12px; margin-top: 12px; padding: 15px 18px 16px;
      border: 1px solid #dce5ed; border-radius: 8px; background: #fff;
    }
    [data-seagrass-customer-section-heading] { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    [data-seagrass-customer-section-heading] strong { color: #183955; font-size: 13px; }
    [data-seagrass-customer-section-heading] small { color: #8191a3; font-size: 10px; }
    [data-seagrass-customer-service-grid], [data-seagrass-customer-form-grid], [data-seagrass-customer-style-grid] {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;
    }
    [data-seagrass-customer-rules] > [data-seagrass-customer-section] { min-width: 0; }
    [data-seagrass-customer-popover] label { min-width: 0; }
    [data-seagrass-customer-service-grid] > label, [data-seagrass-customer-form-grid] > label,
    [data-seagrass-customer-style-grid] > label, [data-seagrass-customer-classification] label {
      display: grid; gap: 5px; color: #536a82; font-size: 10px;
    }
    [data-seagrass-customer-popover] select, [data-seagrass-customer-popover] input[type="text"],
    [data-seagrass-customer-popover] textarea {
      width: 100%; min-width: 0; border: 1px solid #ccd9e5; border-radius: 6px; outline: 0;
      color: #324c67; background: #fff; font: 11px system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    [data-seagrass-customer-popover] select, [data-seagrass-customer-popover] input[type="text"] { height: 36px; padding: 0 10px; }
    [data-seagrass-customer-popover] select:focus, [data-seagrass-customer-popover] input[type="text"]:focus,
    [data-seagrass-customer-popover] textarea:focus { border-color: #50b9af; box-shadow: 0 0 0 3px rgba(10,165,148,.09); }
    [data-seagrass-customer-popover] select:disabled { color: #738398; background: #f3f6f8; cursor: default; }
    [data-seagrass-customer-effective] { color: #087f73; font-size: 10px; }
    [data-seagrass-customer-style-grid] { grid-template-columns: minmax(0, .8fr) minmax(0, 1.15fr) minmax(190px, 1.2fr); align-items: end; }
    [data-seagrass-customer-color-field] > div { height: 36px; display: flex; align-items: center; gap: 10px; }
    [data-seagrass-customer-color-field] > div > label { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    [data-seagrass-customer-font-color] { width: 42px; height: 32px; padding: 2px; border: 1px solid #ccd9e5; border-radius: 6px; background: #fff; }
    [data-seagrass-customer-preview] {
      min-height: 36px; display: flex; align-items: center; padding: 0 11px;
      border: 1px solid #dce5ed; border-radius: 6px; background: #f8fbfc;
    }
    [data-seagrass-customer-tag-groups] { display: grid; gap: 10px; }
    [data-seagrass-customer-tag-group] { display: grid; gap: 7px; }
    [data-seagrass-customer-tag-group] > span { color: #536a82; font-size: 10px; }
    [data-seagrass-customer-common-tags], [data-seagrass-customer-selected-tags] {
      min-height: 28px; display: flex; flex-wrap: wrap; align-items: center; gap: 7px;
    }
    [data-seagrass-stage-tag], [data-seagrass-selected-tag] {
      min-height: 26px; display: inline-flex; align-items: center; gap: 5px; padding: 0 10px;
      border: 1px solid #d4e1e8; border-radius: 6px; background: #f7fafb; color: #536a82;
      font: 600 10px/1 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer;
    }
    [data-seagrass-stage-tag] { color: var(--tag-color); border-color: var(--tag-border); background: var(--tag-bg); }
    [data-seagrass-stage-tag][aria-pressed="true"] { box-shadow: inset 0 0 0 1px currentColor, 0 2px 7px rgba(23,55,79,.08); }
    [data-seagrass-stage-tag][data-stage="new"] { --tag-color: #087f73; --tag-border: #8fd1c8; --tag-bg: #eaf8f5; }
    [data-seagrass-stage-tag][data-stage="intent"] { --tag-color: #ad6b0a; --tag-border: #edc77e; --tag-bg: #fff7e8; }
    [data-seagrass-stage-tag][data-stage="following"] { --tag-color: #2f6fc5; --tag-border: #a9c9ef; --tag-bg: #edf5ff; }
    [data-seagrass-stage-tag][data-stage="won"] { --tag-color: #8a3fb0; --tag-border: #d8b9e7; --tag-bg: #f8effc; }
    [data-seagrass-stage-tag][data-stage="invalid"] { --tag-color: #b24b57; --tag-border: #e7b7bd; --tag-bg: #fff0f2; }
    [data-seagrass-selected-tag] {
      color: var(--tag-color, #176b63); border-color: var(--tag-border, #b9ddd7);
      background: var(--tag-bg, #eff9f7); cursor: default;
    }
    [data-seagrass-selected-tag] button {
      width: 15px; height: 15px; display: grid; place-items: center; padding: 0; border: 0;
      border-radius: 4px; color: #5e817d; background: transparent; font: 14px/1 system-ui; cursor: pointer;
    }
    [data-seagrass-selected-tag] button:hover { color: #174f4a; background: #dcefeb; }
    [data-seagrass-customer-tag-composer] { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    [data-seagrass-customer-add-tag] {
      height: 36px; padding: 0 14px; border: 1px solid #8ccbc5; border-radius: 6px;
      color: #087f73; background: #f2fbf9; font: 600 11px system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer;
    }
    [data-seagrass-customer-add-tag]:active { transform: translateY(1px); }
    [data-seagrass-customer-actions] {
      min-height: 64px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center;
      gap: 12px; padding: 11px 18px; border-top: 1px solid #e2e9ef; background: #fff;
    }
    [data-seagrass-customer-reset], [data-seagrass-customer-save] {
      height: 38px; padding: 0 18px; border-radius: 6px; font: 600 11px system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer;
    }
    [data-seagrass-customer-reset] { border: 1px solid #8ccbc5; color: #0b8f84; background: #fff; }
    [data-seagrass-customer-save] { border: 1px solid #0aa594; color: #fff; background: #0aa594; }
    [data-seagrass-customer-save-status] { overflow: hidden; color: #81939b; font-size: 10px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
    [data-seagrass-chat-customer-tags] {
      min-width: 0; min-height: 16px; display: flex; align-items: center; gap: 4px; margin-top: 1px;
      overflow: hidden; white-space: nowrap; pointer-events: none;
      font: 600 9px/16px system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    [data-seagrass-chat-tag] {
      max-width: 92px; height: 16px; display: inline-flex; align-items: center; padding: 0 6px;
      overflow: hidden; border: 1px solid var(--tag-border, #c8e3de); border-radius: 4px;
      color: var(--tag-color, #176b63); background: var(--tag-bg, #edf8f5);
      text-overflow: ellipsis; white-space: nowrap;
    }
    [data-seagrass-chat-tag-more] { flex: 0 0 auto; color: #7a8c99; }
    @media (max-width: 720px) {
      [data-seagrass-customer-popover] { width: calc(100vw - 20px); max-height: calc(100vh - 20px); }
      [data-seagrass-customer-dialog-head] { padding: 0 16px; }
      [data-seagrass-customer-body] { padding: 10px; }
      [data-seagrass-customer-mode-grid], [data-seagrass-customer-service-grid],
      [data-seagrass-customer-form-grid], [data-seagrass-customer-style-grid], [data-seagrass-customer-tag-composer] { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
}

function customerTagsFromPicker(popover) {
  return String(popover?.querySelector('[data-seagrass-customer-tags]')?.value || '')
    .split(/[,，、]/u)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 30);
}

const customerTagPalettes = Object.freeze([
  ['#176b63', '#b9ddd7', '#eff9f7'],
  ['#2f6fc5', '#b9d1ee', '#edf5ff'],
  ['#8a3fb0', '#d8b9e7', '#f8effc'],
  ['#ad6b0a', '#edc77e', '#fff7e8'],
  ['#b24b57', '#e7b7bd', '#fff0f2'],
  ['#506aa0', '#c1cee7', '#f0f4fb'],
]);

function customerStageForTag(tag) {
  return Object.entries(customerStageLabels).find(([, label]) => label === tag)?.[0] || '';
}

function customerTagPalette(tag) {
  const stage = customerStageForTag(tag);
  const fixed = {
    new: ['#087f73', '#8fd1c8', '#eaf8f5'],
    intent: ['#ad6b0a', '#edc77e', '#fff7e8'],
    following: ['#2f6fc5', '#a9c9ef', '#edf5ff'],
    won: ['#8a3fb0', '#d8b9e7', '#f8effc'],
    invalid: ['#b24b57', '#e7b7bd', '#fff0f2'],
  };
  if (stage) return fixed[stage];
  let hash = 0;
  for (const character of String(tag || '')) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return customerTagPalettes[hash % customerTagPalettes.length];
}

function applyCustomerTagPalette(element, tag) {
  const [color, border, background] = customerTagPalette(tag);
  element.style.setProperty('--tag-color', color);
  element.style.setProperty('--tag-border', border);
  element.style.setProperty('--tag-bg', background);
}

function renderCustomerTagPicker(popover) {
  if (!popover) return;
  const tags = customerTagsFromPicker(popover);
  for (const button of popover.querySelectorAll('[data-seagrass-stage-tag]')) {
    const label = customerStageLabels[button.dataset.stage] || button.textContent.trim();
    button.setAttribute('aria-pressed', String(tags.includes(label)));
  }

  const selected = popover.querySelector('[data-seagrass-customer-selected-tags]');
  if (!selected) return;
  selected.replaceChildren();
  if (!tags.length) {
    const empty = document.createElement('span');
    empty.textContent = '暂未选择标签';
    Object.assign(empty.style, { color: '#8a99a8', fontSize: '10px' });
    selected.appendChild(empty);
    return;
  }
  for (const tag of tags) {
    const chip = document.createElement('span');
    chip.setAttribute('data-seagrass-selected-tag', '');
    const stage = customerStageForTag(tag);
    if (stage) chip.dataset.stage = stage;
    applyCustomerTagPalette(chip, tag);
    const text = document.createElement('span');
    text.textContent = tag;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.tag = tag;
    remove.setAttribute('aria-label', `移除标签 ${tag}`);
    remove.textContent = '×';
    chip.append(text, remove);
    selected.appendChild(chip);
  }
}

function setCustomerTagPicker(popover, stage = 'new', tags = []) {
  if (!popover) return;
  const normalizedStage = Object.hasOwn(customerStageLabels, stage) ? stage : 'new';
  popover.querySelector('[data-seagrass-customer-stage]').value = normalizedStage;
  popover.querySelector('[data-seagrass-customer-tags]').value = [...new Set(tags)]
    .map((tag) => String(tag || '').trim())
    .filter(Boolean)
    .slice(0, 30)
    .join('，');
  renderCustomerTagPicker(popover);
}

function addCustomerTagFromInput(popover) {
  const input = popover?.querySelector('[data-seagrass-customer-tag-input]');
  if (!input) return;
  const tag = input.value.trim().slice(0, 60);
  if (!tag) return;
  const matchingStage = customerStageForTag(tag);
  if (matchingStage) popover.querySelector('[data-seagrass-customer-stage]').value = matchingStage;
  const tags = customerTagsFromPicker(popover);
  if (!tags.includes(tag)) tags.push(tag);
  popover.querySelector('[data-seagrass-customer-tags]').value = tags.slice(0, 30).join('，');
  input.value = '';
  renderCustomerTagPicker(popover);
}

function bindCustomerTagPicker(popover) {
  if (!popover || popover.__seagrassTagPickerBound) return;
  popover.__seagrassTagPickerBound = true;
  for (const button of popover.querySelectorAll('[data-seagrass-stage-tag]')) {
    button.addEventListener('click', () => {
      popover.querySelector('[data-seagrass-customer-stage]').value = button.dataset.stage || 'new';
      const label = customerStageLabels[button.dataset.stage] || button.textContent.trim();
      const tags = customerTagsFromPicker(popover);
      if (!tags.includes(label)) tags.push(label);
      popover.querySelector('[data-seagrass-customer-tags]').value = tags.slice(0, 30).join('，');
      renderCustomerTagPicker(popover);
    });
  }
  popover.querySelector('[data-seagrass-customer-add-tag]').addEventListener('click', () => {
    addCustomerTagFromInput(popover);
  });
  popover.querySelector('[data-seagrass-customer-tag-input]').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addCustomerTagFromInput(popover);
  });
  popover.querySelector('[data-seagrass-customer-selected-tags]').addEventListener('click', (event) => {
    const remove = event.target.closest?.('button[data-tag]');
    if (!remove) return;
    const tags = customerTagsFromPicker(popover).filter((tag) => tag !== remove.dataset.tag);
    popover.querySelector('[data-seagrass-customer-tags]').value = tags.join('，');
    renderCustomerTagPicker(popover);
  });
  setCustomerTagPicker(popover, 'new', []);
}

function ensureTranslationStatus() {
  if (!location.hostname.includes('web.whatsapp.com') || !document.body) return null;
  let status = document.querySelector(TRANSLATION_STATUS_SELECTOR);
  if (status) return status;

  status = document.createElement('div');
  status.setAttribute('data-seagrass-translation-status', '');
  status.setAttribute('role', 'group');
  status.setAttribute('aria-label', '当前客户翻译状态');
  status.innerHTML = [
    '<i data-seagrass-status-dot></i>',
    '<span data-seagrass-status-scope>当前客户</span>',
    '<strong data-seagrass-status-provider></strong>',
    '<span data-seagrass-status-route></span>',
    '<b data-seagrass-status-separator>·</b>',
    '<span data-seagrass-status-language-label>客户语言</span>',
    '<select data-seagrass-status-language aria-label="设置当前客户语言"></select>',
    '<b data-seagrass-status-arrow>→</b>',
    '<span data-seagrass-status-target></span>',
    '<button data-seagrass-customer-settings type="button">客户设置</button>',
    '<button data-seagrass-compose-translate type="button"></button>',
    '<div data-seagrass-customer-popover hidden>',
    '<div data-seagrass-customer-dialog-head>',
    '<div><strong data-seagrass-customer-title>客户设置</strong><small>仅影响当前客户；未单独设置的项目跟随窗口默认</small></div>',
    '<button data-seagrass-customer-close type="button" aria-label="关闭">×</button>',
    '</div>',
    '<div data-seagrass-customer-body>',
    '<div data-seagrass-customer-mode-grid>',
    '<article data-seagrass-customer-mode-card>',
    '<div><strong>发送翻译</strong><small>我的输入 <b>→</b> 客户语言</small></div>',
    '<label data-seagrass-customer-switch><input data-seagrass-customer-send-enabled type="checkbox" /><i></i></label>',
    '<label data-seagrass-customer-inherit><input data-seagrass-customer-send-inherit type="checkbox" />跟随窗口默认</label>',
    '<small data-seagrass-window-state="send-enabled"></small>',
    '</article>',
    '<article data-seagrass-customer-mode-card>',
    '<div><strong>消息翻译</strong><small>客户消息 <b>→</b> 我的显示语言</small></div>',
    '<label data-seagrass-customer-switch><input data-seagrass-customer-message-enabled type="checkbox" /><i></i></label>',
    '<label data-seagrass-customer-inherit><input data-seagrass-customer-message-inherit type="checkbox" />跟随窗口默认</label>',
    '<small data-seagrass-window-state="message-enabled"></small>',
    '</article>',
    '</div>',
    '<div data-seagrass-customer-rules>',
    '<section data-seagrass-customer-section>',
    '<div data-seagrass-customer-section-heading><strong>翻译规则</strong><small>收发语言与群组规则</small></div>',
    '<div data-seagrass-customer-form-grid>',
    '<label><span>发送语言</span><select data-seagrass-customer-send-language></select><small data-seagrass-window-state="send-language"></small></label>',
    '<label><span>客户消息语种</span><select data-seagrass-customer-source-language></select><small data-seagrass-window-state="source-language"></small></label>',
    '<label><span>译文显示语言</span><select data-seagrass-customer-target-language></select><small data-seagrass-window-state="target-language"></small></label>',
    '<label><span>屏蔽包含中文的消息</span><select data-seagrass-customer-skip-chinese><option value="inherit">跟随窗口默认</option><option value="true">开启，不调用接口</option><option value="false">关闭</option></select><small data-seagrass-window-state="skip-chinese"></small></label>',
    '<label><span>群组翻译</span><select data-seagrass-customer-group-translation><option value="inherit">跟随窗口默认</option><option value="manual">手动翻译群组消息</option><option value="auto">自动翻译群组消息</option></select><small data-seagrass-window-state="group-translation"></small></label>',
    '</div>',
    '</section>',
    '</div>',
    '<section data-seagrass-customer-section>',
    '<div data-seagrass-customer-section-heading><strong>翻译服务</strong><small>平台可单独覆盖，线路统一使用默认线路</small></div>',
    '<div data-seagrass-customer-service-grid>',
    '<label><span>AI 翻译模型</span><select data-seagrass-customer-provider><option value="inherit">跟随窗口默认</option><option value="deepseek">DeepSeek</option></select><small data-seagrass-window-state="provider"></small></label>',
    '<label><span>翻译线路</span><select data-seagrass-customer-route disabled><option value="default-1">默认线路</option></select></label>',
    '</div>',
     '<small data-seagrass-customer-effective></small>',
     '</section>',
     '<section data-seagrass-customer-section>',
    '<div data-seagrass-customer-section-heading><strong>显示样式</strong><small>仅改变当前客户译文</small></div>',
    '<div data-seagrass-customer-style-grid>',
    '<label><span>字体大小</span><select data-seagrass-customer-font-size><option value="inherit">跟随窗口默认</option><option value="11">小（11px）</option><option value="12">中（12px）</option><option value="14">大（14px）</option></select><small data-seagrass-window-state="font-size"></small></label>',
    '<label data-seagrass-customer-color-field><span>字体颜色</span><div><label><input data-seagrass-customer-color-inherit type="checkbox" />跟随窗口默认</label><input data-seagrass-customer-font-color type="color" /></div><small data-seagrass-window-state="font-color"></small></label>',
    '<div data-seagrass-customer-preview>译文预览：你好，很高兴认识你。</div>',
    '</div>',
    '</section>',
    '<section data-seagrass-customer-section data-seagrass-customer-classification>',
    '<div data-seagrass-customer-section-heading><strong>客户标签</strong><small>保存后显示在左侧聊天列表</small></div>',
    '<div data-seagrass-customer-tag-groups>',
    '<div data-seagrass-customer-tag-group>',
    '<span>常用标签</span>',
    '<div data-seagrass-customer-common-tags>',
    '<button data-seagrass-stage-tag data-stage="new" type="button">新客户</button>',
    '<button data-seagrass-stage-tag data-stage="intent" type="button">意向客户</button>',
    '<button data-seagrass-stage-tag data-stage="following" type="button">跟进中</button>',
    '<button data-seagrass-stage-tag data-stage="won" type="button">已成交</button>',
    '<button data-seagrass-stage-tag data-stage="invalid" type="button">无效客户</button>',
    '</div>',
    '<input data-seagrass-customer-stage type="hidden" value="new" />',
    '</div>',
    '<div data-seagrass-customer-tag-group>',
    '<span>已选标签（点击 × 可删除）</span>',
    '<div data-seagrass-customer-selected-tags></div>',
    '<div data-seagrass-customer-tag-composer>',
    '<input data-seagrass-customer-tag-input type="text" maxlength="60" placeholder="输入标签，例如：需要报价" />',
    '<button data-seagrass-customer-add-tag type="button">添加标签</button>',
    '</div>',
    '<input data-seagrass-customer-tags type="hidden" value="" />',
    '</div>',
    '</div>',
    '</section>',
    '</div>',
    '<div data-seagrass-customer-actions>',
    '<button data-seagrass-customer-reset type="button">恢复窗口默认</button>',
    '<span data-seagrass-customer-save-status></span>',
    '<button data-seagrass-customer-save type="button">保存客户设置</button>',
    '</div>',
    '</div>',
  ].join('');
  Object.assign(status.style, {
    position: 'fixed',
    left: '50%',
    bottom: '74px',
    zIndex: '2147483647',
    display: 'none',
    alignItems: 'center',
    gap: '6px',
    minHeight: '30px',
    maxWidth: 'calc(100vw - 28px)',
    padding: '5px 10px',
    border: '1px solid #d8e4e8',
    borderRadius: '9px',
    background: 'rgba(255, 255, 255, 0.96)',
    boxShadow: '0 5px 18px rgba(34, 73, 86, 0.12)',
    color: '#536471',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: '11px',
    lineHeight: '18px',
    whiteSpace: 'nowrap',
    pointerEvents: 'auto',
    transform: 'translateX(-50%)',
    boxSizing: 'border-box',
    userSelect: 'none',
  });
  Object.assign(status.querySelector('[data-seagrass-status-dot]').style, {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: '#12a594',
    flex: '0 0 auto',
  });
  Object.assign(status.querySelector('[data-seagrass-status-provider]').style, {
    color: '#087f73',
    fontWeight: '650',
  });
  Object.assign(status.querySelector('[data-seagrass-status-scope]').style, {
    color: '#637c87',
    fontWeight: '650',
  });
  for (const selector of ['[data-seagrass-status-separator]', '[data-seagrass-status-arrow]']) {
    Object.assign(status.querySelector(selector).style, {
      color: '#9aabb4',
      fontWeight: '400',
    });
  }
  const languageSelect = status.querySelector('[data-seagrass-status-language]');
  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = '自动识别';
  languageSelect.appendChild(autoOption);
  for (const language of customerLanguageOptions) {
    const option = document.createElement('option');
    option.value = language;
    option.textContent = languageLabel(language);
    languageSelect.appendChild(option);
  }
  Object.assign(languageSelect.style, {
    height: '22px',
    maxWidth: '136px',
    padding: '0 22px 0 7px',
    border: '1px solid #cddce1',
    borderRadius: '6px',
    outline: 'none',
    background: '#f8fbfc',
    color: '#244752',
    font: 'inherit',
    cursor: 'pointer',
  });
  languageSelect.addEventListener('change', () => {
    setPreferredConversationLanguage(languageSelect.value);
  });

  const translateButton = status.querySelector('[data-seagrass-compose-translate]');
  Object.assign(translateButton.style, {
    height: '24px',
    marginLeft: '2px',
    padding: '0 9px',
    border: '1px solid #8bcfc6',
    borderRadius: '6px',
    background: '#f0fbf9',
    color: '#087f73',
    font: 'inherit',
    fontWeight: '650',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  translateButton.addEventListener('click', translateComposerForCurrentCustomer);

  const customerSettingsButton = status.querySelector('[data-seagrass-customer-settings]');
  Object.assign(customerSettingsButton.style, {
    height: '24px',
    padding: '0 8px',
    border: '1px solid #d4e1e5',
    borderRadius: '6px',
    background: '#fff',
    color: '#607984',
    font: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  const customerPopover = status.querySelector('[data-seagrass-customer-popover]');
  /* Customer dialog layout is now defined by ensureCustomerSettingsStyles().
     Keep this former inline-style block disabled until it can be removed in a
     later mechanical cleanup; executing it would override the responsive UI. */
  /*
  Object.assign(customerPopover.style, {
    position: 'fixed',
    width: '380px',
    maxWidth: 'calc(100vw - 20px)',
    maxHeight: 'calc(100vh - 24px)',
    overflowY: 'auto',
    zIndex: '2147483647',
    display: 'none',
    gap: '0',
    padding: '0',
    border: '1px solid #d8e4e8',
    borderRadius: '9px',
    background: '#fff',
    boxShadow: '0 8px 24px rgba(34, 73, 86, 0.18)',
    color: '#536471',
    whiteSpace: 'normal',
    boxSizing: 'border-box',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-dialog-head]').style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: '40px',
    padding: '0 13px',
    borderBottom: '1px solid #e6edef',
    boxSizing: 'border-box',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-title]').style, {
    color: '#244752',
    fontWeight: '650',
    fontSize: '13px',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-close]').style, {
    width: '24px',
    height: '24px',
    padding: '0',
    border: '0',
    borderRadius: '5px',
    background: 'transparent',
    color: '#81939b',
    font: '20px/22px system-ui, sans-serif',
    cursor: 'pointer',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-description]').style, {
    display: 'block',
    padding: '8px 13px 4px',
    color: '#81939b',
    fontSize: '10px',
    lineHeight: '1.4',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-language-field]').style, {
    display: 'grid',
    gap: '4px',
    padding: '6px 13px 8px',
    borderBottom: '1px solid #edf2f3',
    color: '#526b75',
    fontSize: '10px',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-provider-field]').style, {
    display: 'grid',
    gap: '7px',
    padding: '9px 13px 10px',
    borderBottom: '1px solid #edf2f3',
    background: '#fbfdfd',
    color: '#526b75',
    fontSize: '10px',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-provider-heading]').style, {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '8px',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-provider-heading] strong').style, {
    color: '#244752',
    fontSize: '11px',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-provider-heading] small').style, {
    color: '#81939b',
    fontSize: '9px',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-service-grid]').style, {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: '7px',
  });
  for (const label of customerPopover.querySelectorAll('[data-seagrass-customer-service-grid] label')) {
    Object.assign(label.style, { display: 'grid', gap: '3px', minWidth: '0' });
  }
  for (const field of customerPopover.querySelectorAll('[data-seagrass-customer-provider], [data-seagrass-customer-route]')) {
    Object.assign(field.style, {
      width: '100%',
      height: '28px',
      minWidth: '0',
      padding: '0 7px',
      border: '1px solid #cddce1',
      borderRadius: '6px',
      outline: 'none',
      background: '#fff',
      color: '#244752',
      font: '10px system-ui, -apple-system, "Segoe UI", sans-serif',
      boxSizing: 'border-box',
      cursor: 'pointer',
    });
  }
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-effective]').style, {
    color: '#087f73',
    fontSize: '9px',
    lineHeight: '1.35',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-classification]').style, {
    display: 'grid',
    gap: '7px',
    padding: '9px 13px',
    color: '#526b75',
    fontSize: '10px',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-classification] > strong').style, {
    color: '#244752',
    fontSize: '11px',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-form-row]').style, {
    display: 'grid',
    gridTemplateColumns: '96px minmax(0, 1fr)',
    gap: '7px',
  });
  for (const label of customerPopover.querySelectorAll('[data-seagrass-customer-classification] label')) {
    Object.assign(label.style, { display: 'grid', gap: '3px', minWidth: '0' });
  }
  for (const field of customerPopover.querySelectorAll('[data-seagrass-customer-stage], [data-seagrass-customer-tags]')) {
    Object.assign(field.style, {
      width: '100%',
      minWidth: '0',
      padding: '0 8px',
      border: '1px solid #d4e1e5',
      borderRadius: '6px',
      outline: 'none',
      background: '#fff',
      color: '#244752',
      font: '10px system-ui, -apple-system, "Segoe UI", sans-serif',
      boxSizing: 'border-box',
    });
  }
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-stage]').style, { height: '28px' });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-tags]').style, { height: '28px' });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-actions]').style, {
    display: 'grid',
    gridTemplateColumns: 'auto auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '6px',
    padding: '9px 10px',
    borderTop: '1px solid #edf2f3',
    background: '#fbfdfd',
  });
  const resetCustomerButton = customerPopover.querySelector('[data-seagrass-customer-reset]');
  Object.assign(resetCustomerButton.style, {
    height: '28px',
    padding: '0 6px',
    border: '0',
    borderRadius: '5px',
    background: 'transparent',
    color: '#087f73',
    font: '10px system-ui, -apple-system, "Segoe UI", sans-serif',
    fontWeight: '650',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  const saveCustomerButton = customerPopover.querySelector('[data-seagrass-customer-save]');
  Object.assign(saveCustomerButton.style, {
    height: '30px',
    padding: '0 11px',
    border: '1px solid #0aa895',
    borderRadius: '7px',
    background: '#0aa895',
    color: '#fff',
    font: '10px system-ui, -apple-system, "Segoe UI", sans-serif',
    fontWeight: '650',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });
  Object.assign(customerPopover.querySelector('[data-seagrass-customer-save-status]').style, {
    minWidth: '0',
    overflow: 'hidden',
    color: '#81939b',
    fontSize: '9px',
    textAlign: 'center',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  Object.assign(translateButton.style, {
    height: '28px',
    marginLeft: '0',
    padding: '0 7px',
    borderRadius: '6px',
    fontSize: '10px',
  });
  customerPopover.querySelector('[data-seagrass-customer-language-field]').appendChild(languageSelect);
  customerPopover.querySelector('[data-seagrass-customer-actions]').prepend(translateButton);
  */
  ensureCustomerSettingsStyles();
  bindCustomerTagPicker(customerPopover);
  syncCustomerLanguageSelects(customerPopover);
  const resetCustomerButton = customerPopover.querySelector('[data-seagrass-customer-reset]');
  const saveCustomerButton = customerPopover.querySelector('[data-seagrass-customer-save]');
  const customerProviderSelect = customerPopover.querySelector('[data-seagrass-customer-provider]');
  const customerRouteSelect = customerPopover.querySelector('[data-seagrass-customer-route]');
  customerProviderSelect.addEventListener('change', () => {
    updateCustomerServiceControls(customerPopover);
    updateCustomerWindowStateHints(customerPopover);
  });
  customerRouteSelect.value = 'default-1';
  for (const selector of [
    '[data-seagrass-customer-send-inherit]',
    '[data-seagrass-customer-message-inherit]',
    '[data-seagrass-customer-color-inherit]',
  ]) {
    customerPopover.querySelector(selector).addEventListener('change', () => {
      const state = conversationLanguageState();
      if (customerPopover.querySelector('[data-seagrass-customer-send-inherit]').checked) {
        customerPopover.querySelector('[data-seagrass-customer-send-enabled]').checked = Boolean(translationSettings.sendTranslation);
      }
      if (customerPopover.querySelector('[data-seagrass-customer-message-inherit]').checked) {
        customerPopover.querySelector('[data-seagrass-customer-message-enabled]').checked = Boolean(translationSettings.messageTranslation);
      }
      if (customerPopover.querySelector('[data-seagrass-customer-color-inherit]').checked) {
        customerPopover.querySelector('[data-seagrass-customer-font-color]').value = state.fontColor;
      }
      updateCustomerModeControls(customerPopover);
      updateCustomerPreview(customerPopover);
      updateCustomerWindowStateHints(customerPopover);
    });
  }
  customerPopover.querySelector('[data-seagrass-customer-font-size]').addEventListener('change', () => {
    updateCustomerPreview(customerPopover);
    updateCustomerWindowStateHints(customerPopover);
  });
  customerPopover.querySelector('[data-seagrass-customer-font-color]').addEventListener('input', () => {
    updateCustomerPreview(customerPopover);
  });
  for (const field of customerPopover.querySelectorAll([
    '[data-seagrass-customer-send-language]',
    '[data-seagrass-customer-source-language]',
    '[data-seagrass-customer-target-language]',
    '[data-seagrass-customer-skip-chinese]',
    '[data-seagrass-customer-group-translation]',
  ].join(','))) {
    field.addEventListener('change', () => updateCustomerWindowStateHints(customerPopover));
  }
  status.__seagrassCustomerLanguageSelect = languageSelect;
  status.__seagrassComposeTranslateButton = translateButton;
  status.__seagrassCustomerPopover = customerPopover;
  const setCustomerPopoverOpen = (open) => {
    customerPopover.hidden = !open;
    customerPopover.style.display = open ? 'grid' : 'none';
    customerSettingsButton.setAttribute('aria-expanded', String(open));
    if (open) {
      const body = customerPopover.querySelector('[data-seagrass-customer-body]');
      if (body) body.scrollTop = 0;
      positionCustomerPopover();
      void loadCurrentCustomerIntoPopover(customerPopover);
    }
  };
  status.__seagrassSetCustomerPopoverOpen = setCustomerPopoverOpen;
  customerSettingsButton.addEventListener('click', () => {
    setCustomerPopoverOpen(customerPopover.style.display === 'none');
  });
  resetCustomerButton?.addEventListener('click', () => {
    clearConversationSettingsOverrides({ refresh: false });
    populateCustomerTranslationControls(customerPopover, conversationLanguageState(), { force: true });
    void saveCurrentCustomerFromPopover(customerPopover);
  });
  saveCustomerButton?.addEventListener('click', () => {
    void saveCurrentCustomerFromPopover(customerPopover);
  });
  customerPopover.querySelector('[data-seagrass-customer-close]').addEventListener('click', () => {
    setCustomerPopoverOpen(false);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!status.contains(event.target) && !customerPopover.contains(event.target)) {
      setCustomerPopoverOpen(false);
    }
  });
  document.body.appendChild(status);
  document.body.appendChild(customerPopover);
  setCustomerPopoverOpen(false);
  const inlineCustomerControl = document.createElement('button');
  inlineCustomerControl.setAttribute('data-seagrass-inline-customer', '');
  inlineCustomerControl.type = 'button';
  inlineCustomerControl.title = '客户设置：语言与归类';
  inlineCustomerControl.setAttribute('aria-label', '设置当前客户语言');
  inlineCustomerControl.innerHTML = [
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    '<path d="M4 7h16M4 12h16M4 17h16"></path>',
    '<circle cx="9" cy="7" r="1.8"></circle>',
    '<circle cx="15" cy="12" r="1.8"></circle>',
    '<circle cx="11" cy="17" r="1.8"></circle>',
    '</svg>',
  ].join('');
  Object.assign(inlineCustomerControl.style, {
    position: 'relative',
    zIndex: '2',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 34px',
    alignSelf: 'center',
    height: '40px',
    width: '34px',
    padding: '0',
    border: '0',
    borderRadius: '0',
    background: 'transparent',
    color: '#111b21',
    font: '650 11px/24px system-ui, -apple-system, "Segoe UI", sans-serif',
    cursor: 'pointer',
    boxSizing: 'border-box',
  });
  Object.assign(inlineCustomerControl.querySelector('svg').style, {
    width: '17px',
    height: '17px',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.8',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  });
  inlineCustomerControl.addEventListener('click', () => customerSettingsButton.click());
  document.body.appendChild(inlineCustomerControl);
  status.__seagrassInlineCustomerControl = inlineCustomerControl;

  const assistantControl = document.createElement('button');
  assistantControl.setAttribute('data-seagrass-ai-reply', '');
  assistantControl.type = 'button';
  assistantControl.setAttribute('aria-label', 'AI 建议与快捷回复');
  assistantControl.title = 'AI 建议与快捷回复';
  assistantControl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z"></path><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z"></path></svg>';
  Object.assign(assistantControl.style, {
    position: 'relative',
    zIndex: '2',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 38px',
    alignSelf: 'center',
    width: '38px',
    height: '30px',
    margin: '0 2px',
    padding: '0',
    border: '1px solid #cfe0ff',
    borderRadius: '7px',
    background: '#f3f7ff',
    color: '#246bfe',
    font: '700 11px/28px system-ui, -apple-system, "Segoe UI", sans-serif',
    cursor: 'pointer',
    boxSizing: 'border-box',
  });
  Object.assign(assistantControl.querySelector('svg').style, {
    width: '17px',
    height: '17px',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.8',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  });
  assistantControl.addEventListener('mouseenter', () => {
    assistantControl.style.background = '#e9f0ff';
  });
  assistantControl.addEventListener('mouseleave', () => {
    assistantControl.style.background = '#f3f7ff';
  });
  assistantControl.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (assistantControl.dataset.seagrassPending === '1') return;
    const languageState = conversationLanguageState();
    assistantControl.dataset.seagrassPending = '1';
    assistantControl.disabled = true;
    void ipcRenderer.invoke('assistant:inline-toggle', {
      platformContactId: currentConversationKey(),
      customerName: currentCustomerDisplayName(),
      customerLanguage: languageState.incomingResolved || languageState.incomingRequestLanguage || 'auto',
      outputLanguage: languageState.outgoingResolved || translationSettings.sendLanguage || 'auto',
      translationProvider: languageState.provider,
      // The visible WhatsApp DOM is the authoritative order for the current
      // turn. Local history can contain identical fallback timestamps when a
      // WhatsApp locale changes its data-pre-plain-text format.
      messages: assistantMessagesFromVisibleDom(),
    }).catch(() => undefined).finally(() => {
      assistantControl.dataset.seagrassPending = '0';
      assistantControl.disabled = false;
    });
  });
  document.body.appendChild(assistantControl);
  status.__seagrassAssistantControl = assistantControl;

  const composerHint = document.createElement('span');
  composerHint.setAttribute('data-seagrass-composer-hint', '');
  Object.assign(composerHint.style, {
    position: 'absolute',
    left: '50%',
    top: 'auto',
    bottom: 'calc(100% + 4px)',
    zIndex: '2',
    display: 'none',
    alignItems: 'center',
    height: '22px',
    overflow: 'hidden',
    padding: '0 4px 0 6px',
    border: '0',
    background: 'transparent',
    color: defaultTranslationSettings.fontColor,
    font: '12px/22px system-ui, -apple-system, "Segoe UI", sans-serif',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    userSelect: 'none',
    boxSizing: 'border-box',
    transform: 'translateX(-50%)',
  });
  document.body.appendChild(composerHint);
  status.__seagrassComposerHint = composerHint;

  const composerProgress = document.createElement('span');
  composerProgress.setAttribute('data-seagrass-composer-progress', '');
  composerProgress.setAttribute('role', 'status');
  composerProgress.setAttribute('aria-live', 'polite');
  Object.assign(composerProgress.style, {
    position: 'absolute',
    right: '2px',
    top: '50%',
    zIndex: '3',
    display: 'none',
    alignItems: 'center',
    height: '24px',
    padding: '0 7px 0 18px',
    background: 'linear-gradient(90deg, rgba(255,255,255,0), #fff 14px, #fff 100%)',
    color: '#008f79',
    font: '600 12px/24px system-ui, -apple-system, "Segoe UI", sans-serif',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    userSelect: 'none',
    boxSizing: 'border-box',
    transform: 'translateY(-50%)',
  });
  document.body.appendChild(composerProgress);
  status.__seagrassComposerProgress = composerProgress;
  document.addEventListener('input', (event) => {
    const composer = findComposerInput();
    if (!composer || !event.target?.closest?.('#main footer')) return;

    setNativeComposerPlaceholderHidden(composer.parentElement, composer, false);
    window.requestAnimationFrame(() => {
      const currentComposer = findComposerInput();
      if (!currentComposer) return;
      const currentText = currentComposer.textContent?.trim() || '';
      if (
        (lastTranslatedComposer.text && currentText !== lastTranslatedComposer.text)
        || (composerTranslationState === 'success' && currentText !== lastTranslatedComposer.text)
      ) {
        lastTranslatedComposer = { text: '', targetLanguage: '', conversationKey: '' };
        if (composerTranslationResetTimer) window.clearTimeout(composerTranslationResetTimer);
        composerTranslationResetTimer = undefined;
        composerTranslationState = 'idle';
      }
      if (rawSendFallback.text && currentText !== rawSendFallback.text) {
        rawSendFallback = { text: '', conversationKey: '' };
        if (composerTranslationState !== 'loading') composerTranslationState = 'idle';
      }
      if (
        pendingAiOutgoingOriginal.sentText
        && (
          currentText !== pendingAiOutgoingOriginal.sentText
          || pendingAiOutgoingOriginal.conversationKey !== currentConversationKey()
        )
      ) {
        // The user edited the AI draft or switched chats.  Do not let an old
        // Chinese reference attach itself to a later, unrelated message.
        pendingAiOutgoingOriginal = { originalText: '', sentText: '', conversationKey: '' };
      }
      updateTranslationStatus();
    });
  }, true);
  return status;
}

function exactTextElement(root, expected) {
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (String(node.nodeValue || '').trim() === expected) return node.parentElement;
  }
  return null;
}

function whatsAppTitleElement(root) {
  return root?.querySelector?.('[data-testid="wa-wordmark"], [data-icon="wa-wordmark"], [aria-label="WhatsApp"]')
    || exactTextElement(root, 'WhatsApp');
}

function findWhatsAppSidebarHeader() {
  const preferred = [
    document.querySelector('#side > header'),
    document.querySelector('#side header'),
  ].filter(Boolean);
  const candidates = preferred.length ? preferred : [...document.querySelectorAll('header')];
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  return candidates.find((header) => {
    const bounds = header.getBoundingClientRect();
    return bounds.width >= 260
      && bounds.height >= 44
      && bounds.height <= 100
      && bounds.left < viewportWidth * 0.55
      && Boolean(whatsAppTitleElement(header));
  }) || null;
}

function positionNetworkBadge(badge, header) {
  const headerBounds = header.getBoundingClientRect();
  const titleElement = whatsAppTitleElement(header);
  // The wordmark wrapper stretches across the whole flexible title area;
  // measure the actual SVG so that space reserved for the badge is accurate.
  const titleBounds = (titleElement?.querySelector?.('svg') || titleElement)?.getBoundingClientRect();
  if (!titleBounds?.width || !headerBounds.width) {
    badge.style.display = 'none';
    return;
  }
  const actionBounds = [...header.querySelectorAll('button, [role="button"]')]
    .map((element) => element.getBoundingClientRect())
    .filter((bounds) => bounds.width > 0 && bounds.left > titleBounds.right + 8)
    .sort((left, right) => left.left - right.left);
  const actionLeft = actionBounds[0]?.left || headerBounds.right - 96;
  const left = Math.round(titleBounds.right - headerBounds.left + 16);
  const width = Math.min(190, Math.floor(actionLeft - headerBounds.left - left - 10));
  if (width < 92) {
    badge.style.display = 'none';
    return;
  }
  badge.style.display = 'flex';
  badge.style.left = `${left}px`;
  badge.style.width = `${width}px`;
  badge.querySelector('[data-seagrass-network-location]').style.display = width < 138 ? 'none' : 'block';
}

function updateNetworkBadge() {
  if (!location.hostname.includes('web.whatsapp.com') || !document.body) return;
  const header = findWhatsAppSidebarHeader();
  if (!header) return;
  let badge = header.querySelector(NETWORK_BADGE_SELECTOR);
  if (!badge) {
    badge = document.createElement('div');
    badge.setAttribute('data-seagrass-network-badge', '');
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    badge.innerHTML = [
      '<span data-seagrass-network-dot></span>',
      '<span data-seagrass-network-copy>',
      '<strong data-seagrass-network-ip></strong>',
      '<small data-seagrass-network-location></small>',
      '</span>',
    ].join('');
    const computedPosition = window.getComputedStyle(header).position;
    if (computedPosition === 'static') header.style.setProperty('position', 'relative');
    Object.assign(badge.style, {
      position: 'absolute',
      top: '50%',
      zIndex: '8',
      height: '38px',
      alignItems: 'center',
      gap: '7px',
      padding: '5px 9px',
      border: '1px solid #d8e8e3',
      borderRadius: '8px',
      background: 'rgba(247, 252, 250, .96)',
      color: '#38534b',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      lineHeight: '1.2',
      pointerEvents: 'none',
      transform: 'translateY(-50%)',
      boxSizing: 'border-box',
      overflow: 'hidden',
    });
    Object.assign(badge.querySelector('[data-seagrass-network-dot]').style, {
      width: '7px',
      height: '7px',
      flex: '0 0 auto',
      borderRadius: '50%',
      background: '#aab9b4',
    });
    Object.assign(badge.querySelector('[data-seagrass-network-copy]').style, {
      minWidth: '0',
      display: 'block',
      overflow: 'hidden',
    });
    for (const selector of ['[data-seagrass-network-ip]', '[data-seagrass-network-location]']) {
      Object.assign(badge.querySelector(selector).style, {
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });
    }
    Object.assign(badge.querySelector('[data-seagrass-network-ip]').style, {
      fontSize: '11px',
      fontWeight: '650',
      color: '#24483e',
    });
    Object.assign(badge.querySelector('[data-seagrass-network-location]').style, {
      marginTop: '2px',
      fontSize: '9px',
      color: '#768b84',
    });
    header.appendChild(badge);
  }

  const ipElement = badge.querySelector('[data-seagrass-network-ip]');
  const locationElement = badge.querySelector('[data-seagrass-network-location]');
  const dot = badge.querySelector('[data-seagrass-network-dot]');
  if (platformNetworkInfo.state === 'ready' && platformNetworkInfo.ip) {
    ipElement.textContent = `IP ${platformNetworkInfo.ip}`;
    locationElement.textContent = platformNetworkInfo.location || '归属地未知';
    dot.style.background = '#18a77b';
    badge.title = [platformNetworkInfo.ip, platformNetworkInfo.location].filter(Boolean).join(' · ');
  } else if (platformNetworkInfo.state === 'error') {
    ipElement.textContent = 'IP 暂时不可用';
    locationElement.textContent = '归属地查询失败';
    dot.style.background = '#d8a642';
    badge.title = '出口 IP 查询失败，不影响当前窗口连接';
  } else {
    ipElement.textContent = '正在查询出口 IP…';
    locationElement.textContent = '';
    dot.style.background = '#aab9b4';
    badge.title = '正在通过当前窗口线路查询出口 IP';
  }
  positionNetworkBadge(badge, header);
}

function scheduleNetworkBadgeMount() {
  if (networkBadgeMountTimer) return;
  networkBadgeMountTimer = window.setTimeout(() => {
    networkBadgeMountTimer = undefined;
    updateNetworkBadge();
  }, 120);
}

function currentCustomerDisplayName() {
  const selectors = [
    '[data-testid="conversation-header"] [data-testid="conversation-info-header-chat-title"]',
    '[data-testid="conversation-header"] [title]',
    '[data-testid="conversation-header"] span[dir="auto"]',
    '#main header [data-testid="conversation-info-header-chat-title"]',
    '#main header [title]',
    '#main header span[dir="auto"]',
  ];
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.textContent?.trim();
    if (value) return value;
  }
  return '当前客户';
}

function normalizedPhone(value) {
  const match = String(value || '').match(/\+?\d[\d\s().-]{5,}\d/u)?.[0] || '';
  const digits = match.replace(/\D/gu, '');
  if (digits.length < 7) return '';
  return match.trim().startsWith('+') ? `+${digits}` : digits;
}

function formatPhoneForDisplay(value) {
  const phone = normalizedPhone(value);
  return phone || null;
}

function isVisibleElement(element) {
  if (!element) return false;
  const bounds = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return bounds.width > 0 && bounds.height > 0
    && style.display !== 'none'
    && style.visibility !== 'hidden';
}

function normalizedChatListIdentity(value) {
  return String(value || '')
    .replace(/^\d+\s*条未读消息/u, '')
    .replace(/[（(]自己[）)]$/u, '')
    .replace(/\s+/gu, '')
    .trim()
    .toLocaleLowerCase();
}

function customerForChatListTitle(title) {
  const identity = normalizedChatListIdentity(title);
  if (!identity) return null;
  const digits = identity.replace(/\D/gu, '');
  return chatCustomerCache.find((customer) => {
    const name = normalizedChatListIdentity(customer.display_name);
    if (name && (name === identity || identity.endsWith(name))) return true;
    const phoneDigits = normalizedPhone(customer.phone).replace(/\D/gu, '');
    return digits.length >= 7 && phoneDigits.length >= 7 && digits === phoneDigits;
  }) || null;
}

function customerChatTags(customer) {
  if (!customer) return [];
  const result = [];
  for (const rawTag of Array.isArray(customer.tags) ? customer.tags : []) {
    const label = String(rawTag || '').trim();
    if (!label || result.some((item) => item.label === label)) continue;
    result.push({ label, stage: customerStageForTag(label) });
  }
  return result;
}

function renderChatListCustomerTags() {
  if (!location.hostname.includes('web.whatsapp.com')) return;
  const activeRows = new Set();
  for (const titleNode of document.querySelectorAll('[data-testid="cell-frame-title"]')) {
    const row = titleNode.closest('[role="row"]');
    if (!row) continue;
    activeRows.add(row);
    const customer = customerForChatListTitle(titleNode.textContent);
    let bar = row.querySelector('[data-seagrass-chat-customer-tags]');
    if (!customer) {
      bar?.remove();
      continue;
    }
    const titleCell = titleNode.closest('[role="gridcell"]');
    const contentColumn = titleCell?.parentElement;
    if (!contentColumn) continue;
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('data-seagrass-chat-customer-tags', '');
      contentColumn.appendChild(bar);
    }
    const tags = customerChatTags(customer);
    const signature = tags.map((item) => `${item.stage}:${item.label}`).join('|');
    if (bar.dataset.signature === signature) continue;
    bar.dataset.signature = signature;
    bar.replaceChildren();
    for (const item of tags.slice(0, 3)) {
      const chip = document.createElement('span');
      chip.setAttribute('data-seagrass-chat-tag', '');
      if (item.stage) chip.dataset.stage = item.stage;
      applyCustomerTagPalette(chip, item.label);
      chip.textContent = item.label;
      chip.title = item.label;
      bar.appendChild(chip);
    }
    if (tags.length > 3) {
      const more = document.createElement('span');
      more.setAttribute('data-seagrass-chat-tag-more', '');
      more.textContent = `+${tags.length - 3}`;
      bar.appendChild(more);
    }
  }
  for (const bar of document.querySelectorAll('[data-seagrass-chat-customer-tags]')) {
    if (!activeRows.has(bar.closest('[role="row"]'))) bar.remove();
  }
}

function scheduleChatListCustomerTags() {
  if (chatTagRenderTimer) return;
  chatTagRenderTimer = window.setTimeout(() => {
    chatTagRenderTimer = undefined;
    renderChatListCustomerTags();
  }, 80);
}

async function refreshChatCustomerCache() {
  if (chatCustomerRefreshPromise) return chatCustomerRefreshPromise;
  chatCustomerRefreshPromise = ipcRenderer.invoke('customer:list-platform')
    .then((customers) => {
      chatCustomerCache = Array.isArray(customers) ? customers : [];
      scheduleChatListCustomerTags();
      return chatCustomerCache;
    })
    .catch(() => [])
    .finally(() => { chatCustomerRefreshPromise = undefined; });
  return chatCustomerRefreshPromise;
}

function isChatListRelatedMutation(mutation) {
  if (mutation.type !== 'childList' || !mutation.addedNodes.length) return false;
  for (const node of mutation.addedNodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (node.matches?.('[data-testid="chat-list"], [data-testid="cell-frame-title"], [role="row"]')) return true;
    if (node.querySelector?.('[data-testid="cell-frame-title"]')) return true;
  }
  return false;
}

function selectedChatContainer() {
  const selected = [...document.querySelectorAll('[aria-selected="true"]')]
    .find((node) => node.querySelector('[data-testid="cell-frame-title"]'));
  if (!selected) return null;
  let container = selected;
  for (let depth = 0; depth < 6 && container?.parentElement; depth += 1) {
    const bounds = container.getBoundingClientRect();
    if (bounds.width >= 240 && bounds.height >= 44 && bounds.height <= 120) return container;
    container = container.parentElement;
  }
  return selected;
}

function currentCustomerAvatarRect() {
  const container = selectedChatContainer();
  const image = [...(container?.querySelectorAll('img') || [])]
    .find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return isVisibleElement(candidate) && bounds.width >= 24 && bounds.height >= 24;
    });
  if (!image) return null;
  const bounds = image.getBoundingClientRect();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function currentCustomerSnapshot(extra = {}) {
  const displayName = currentCustomerDisplayName();
  const phone = formatPhoneForDisplay(extra.phone || displayName);
  const conversationKey = currentConversationKey();
  const languageState = conversationLanguageState(conversationKey);
  return {
    workspace_id: workspaceId,
    owner_member_id: ownerMemberId,
    platform_contact_id: conversationKey || `contact:${stableHash(`${location.hostname}:${phone || displayName}`)}`,
    display_name: displayName,
    phone,
    avatar_rect: currentCustomerAvatarRect(),
    preferred_language: languageState.preferred || null,
    preferred_provider: languageState.providerOverride || null,
    preferred_route: languageState.routeOverride || null,
    last_contact_at: new Date().toISOString(),
    ...extra,
  };
}

function waitForCondition(predicate, timeoutMs = 2500, intervalMs = 80) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const result = predicate();
      if (result || Date.now() - startedAt >= timeoutMs) {
        resolve(result || null);
        return;
      }
      window.setTimeout(check, intervalMs);
    };
    check();
  });
}

function contactInfoText() {
  const bodyText = document.body?.innerText || '';
  const markerIndex = bodyText.lastIndexOf('联系人信息');
  return markerIndex >= 0 ? bodyText.slice(markerIndex, markerIndex + 1800) : '';
}

function phoneFromContactInfo() {
  const text = contactInfoText();
  if (!text) return '';
  const matches = text.match(/\+?\d[\d\s().-]{5,}\d/gu) || [];
  return matches.map(normalizedPhone).find(Boolean) || '';
}

async function readCurrentCustomerPhone() {
  const directPhone = normalizedPhone(currentCustomerDisplayName());
  if (directPhone) return directPhone;
  const wasOpen = Boolean(contactInfoText());
  const title = document.querySelector(
    '#main header [data-testid="conversation-info-header-chat-title"]',
  );
  if (!wasOpen && title) {
    const clickTarget = title.closest('[role="button"]') || title;
    clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  const phone = await waitForCondition(phoneFromContactInfo, 2600, 100);
  if (!wasOpen) {
    const mainLeft = document.querySelector('#main')?.getBoundingClientRect().left || 0;
    const closeButton = [...document.querySelectorAll('button,[role="button"]')]
      .filter((button) => (
        button.getAttribute('aria-label') === '关闭'
        && !button.closest('[data-seagrass-customer-popover]')
        && isVisibleElement(button)
        && button.getBoundingClientRect().x > mainLeft
      ))
      .at(-1);
    closeButton?.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
  }
  return phone || '';
}

function setCustomerSaveStatus(popover, text, state = '') {
  const status = popover?.querySelector('[data-seagrass-customer-save-status]');
  if (!status) return;
  status.textContent = text;
  status.style.color = state === 'error' ? '#c65b63' : state === 'success' ? '#087f73' : '#81939b';
}

async function loadCurrentCustomerIntoPopover(popover) {
  if (!popover) return;
  const snapshot = currentCustomerSnapshot();
  setCustomerSaveStatus(popover, '读取聊天标记…');
  try {
    const customer = await ipcRenderer.invoke('customer:lookup-current', snapshot);
    popover.__seagrassCustomerId = customer?.id || '';
    const localEntry = conversationLanguageEntry(snapshot.platform_contact_id);
    if (customer?.translation_settings && typeof customer.translation_settings === 'object') {
      clearConversationSettingsOverrides({ refresh: false });
      setConversationSettingsOverrides(customer.translation_settings, { refresh: false });
    } else {
      if (
        customer?.preferred_language
        && !localEntry.preferredLanguage
        && !localEntry.sendLanguageOverride
      ) {
        setConversationSettingsOverrides({
          preferredLanguage: customer.preferred_language,
          sendLanguageOverride: customer.preferred_language,
        }, { refresh: false });
      }
      if (customer?.preferred_provider && !localEntry.preferredProvider) {
        setConversationTranslationOverrides(customer.preferred_provider, 'default-1', { refresh: false });
      }
    }
    setCustomerTagPicker(popover, customer?.stage || 'new', customer?.tags || []);
    popover.__seagrassCustomerNote = customer?.note || '';
    const languageState = conversationLanguageState();
    populateCustomerTranslationControls(popover, languageState, { force: true });
    refreshMessageTranslations();
    updateTranslationStatus();
    setCustomerSaveStatus(
      popover,
      customer ? '标签已保存在本机' : '尚未归类',
      customer ? 'success' : '',
    );
  } catch {
    setCustomerSaveStatus(popover, '聊天标记读取失败', 'error');
  }
}

async function saveCurrentCustomerFromPopover(popover) {
  if (!popover) return;
  const button = popover.querySelector('[data-seagrass-customer-save]');
  const stage = popover.querySelector('[data-seagrass-customer-stage]').value;
  const tags = customerTagsFromPicker(popover);
  const note = popover.__seagrassCustomerNote || '';
  const translationOverrides = customerTranslationOverridesFromPopover(popover);
  setConversationSettingsOverrides(translationOverrides);
  const provider = translationOverrides.preferredProvider;
  const preferredLanguage = translationOverrides.preferredLanguage;
  button.disabled = true;
  button.style.opacity = '0.7';
  setCustomerSaveStatus(popover, '正在保存…');
  try {
    const phone = await readCurrentCustomerPhone();
    const customer = await ipcRenderer.invoke('customer:save-current', currentCustomerSnapshot({
      id: popover.__seagrassCustomerId || undefined,
      phone: phone || undefined,
      stage,
      tags,
      note,
      preferred_language: preferredLanguage || null,
      preferred_provider: provider || null,
      preferred_route: null,
      translation_settings: Object.fromEntries(
        Object.entries(translationOverrides).filter(([, value]) => value !== undefined),
      ),
    }));
    popover.__seagrassCustomerId = customer.id;
    setCustomerSaveStatus(
      popover,
      '标签已保存在本机',
      'success',
    );
  } catch (error) {
    setCustomerSaveStatus(popover, error?.message || '保存失败', 'error');
  } finally {
    button.disabled = false;
    button.style.opacity = '1';
  }
}

function positionCustomerPopover() {
  const popover = document.querySelector('[data-seagrass-customer-popover]');
  if (!popover || popover.hidden) return;
  const mainBounds = document.querySelector('#main')?.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const bounds = popover.getBoundingClientRect();
  const width = bounds.width || 360;
  const height = bounds.height || 260;
  const areaLeft = Number.isFinite(mainBounds?.left) ? mainBounds.left : 0;
  const areaTop = Number.isFinite(mainBounds?.top) ? mainBounds.top : 0;
  const areaWidth = mainBounds?.width || viewportWidth;
  const areaHeight = mainBounds?.height || viewportHeight;
  const left = Math.min(
    Math.max(12, areaLeft + (areaWidth - width) / 2),
    Math.max(12, viewportWidth - width - 12),
  );
  const top = Math.min(
    Math.max(12, areaTop + (areaHeight - height) / 2),
    Math.max(12, viewportHeight - height - 12),
  );
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function setStatusText(status, selector, text) {
  const node = status.querySelector(selector);
  if (node && node.textContent !== text) node.textContent = text;
}

function setNativeComposerPlaceholderHidden(composerContainer, composer, hidden) {
  if (!composerContainer || !composer) return;
  const placeholderText = composer.getAttribute('aria-placeholder')?.trim();
  const placeholderNodes = [...composerContainer.children].filter((node) => (
    node !== composer
    && node.getAttribute?.('aria-hidden') === 'true'
    && (!placeholderText || node.textContent?.trim() === placeholderText)
  ));

  for (const node of placeholderNodes) {
    if (hidden) {
      if (!hiddenComposerPlaceholders.has(node)) {
        hiddenComposerPlaceholders.set(node, {
          value: node.style.getPropertyValue('visibility'),
          priority: node.style.getPropertyPriority('visibility'),
        });
      }
      if (node.style.getPropertyValue('visibility') !== 'hidden') {
        node.style.setProperty('visibility', 'hidden', 'important');
      }
      continue;
    }

    const original = hiddenComposerPlaceholders.get(node);
    if (!original) continue;
    node.style.removeProperty('visibility');
    if (original.value) node.style.setProperty('visibility', original.value, original.priority);
    hiddenComposerPlaceholders.delete(node);
  }
}

function updateTranslationStatus() {
  const status = ensureTranslationStatus();
  if (!status) return;

  const main = document.querySelector('#main');
  const mainBounds = main?.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  if (!viewportWidth) {
    status.style.display = 'none';
    return;
  }
  status.style.display = 'none';
  const contentLeft = Number.isFinite(mainBounds?.left) ? mainBounds.left : 0;
  const contentWidth = mainBounds?.width || viewportWidth;
  status.style.left = `${Math.round(contentLeft + 14)}px`;
  status.style.maxWidth = `${Math.max(240, Math.round(contentWidth - 28))}px`;
  status.style.transform = 'none';

  const inlineCustomerControl = status.__seagrassInlineCustomerControl;
  const assistantControl = status.__seagrassAssistantControl;
  const composerHint = status.__seagrassComposerHint;
  const composerProgress = status.__seagrassComposerProgress;
  const footerBounds = document.querySelector('#main footer')?.getBoundingClientRect();
  const composer = findComposerInput();
  const composerContainer = composer?.parentElement;
  const composerRow = composerContainer?.parentElement;
  const composerHasText = Boolean(composer?.textContent?.trim());
  if (composer) composer.style.setProperty('caret-color', '#00a884', 'important');
  if (composerRow) composerRow.style.setProperty('position', 'relative');
  if (inlineCustomerControl && composerRow && footerBounds?.width) {
    if (inlineCustomerControl.parentElement !== composerRow) {
      composerRow.insertBefore(inlineCustomerControl, composerRow.firstElementChild);
    }
    inlineCustomerControl.style.display = 'inline-flex';
  } else if (inlineCustomerControl) {
    inlineCustomerControl.style.display = 'none';
  }
  if (assistantControl && composerRow && footerBounds?.width) {
    if (assistantControl.parentElement !== composerRow) {
      composerRow.insertBefore(assistantControl, inlineCustomerControl?.parentElement === composerRow
        ? inlineCustomerControl
        : composerRow.firstElementChild);
    }
    assistantControl.style.display = 'inline-flex';
  } else if (assistantControl) {
    assistantControl.style.display = 'none';
  }

  const languageState = conversationLanguageState();
  if (
    status.__seagrassActiveConversationKey
    && status.__seagrassActiveConversationKey !== languageState.key
  ) {
    status.__seagrassSetCustomerPopoverOpen?.(false);
  }
  status.__seagrassActiveConversationKey = languageState.key;
  if (
    lastTranslatedComposer.text
    && lastTranslatedComposer.conversationKey !== languageState.key
  ) {
    lastTranslatedComposer = { text: '', targetLanguage: '', conversationKey: '' };
    if (composerTranslationResetTimer) window.clearTimeout(composerTranslationResetTimer);
    composerTranslationResetTimer = undefined;
    composerTranslationState = 'idle';
  }

  const provider = providerLabels[languageState.provider]
    || languageState.provider
    || '翻译服务';
  const route = routeLabels[languageState.route]
    || languageState.route
    || '默认线路';
  const messageTranslationEnabled = languageState.messageTranslation;
  const sendTranslationEnabled = languageState.sendTranslation;
  const statusEnabled = messageTranslationEnabled || sendTranslationEnabled;
  const languageSelect = status.__seagrassCustomerLanguageSelect;
  const autoOption = languageSelect.querySelector('option[value="auto"]');
  const autoDescription = languageState.sendLanguageOverride === 'auto'
    ? (languageState.detected ? `自动识别（${languageLabel(languageState.detected)}）` : '自动识别客户语言')
    : languageState.windowSendFallback
      ? `窗口默认（${languageLabel(languageState.windowSendFallback)}）`
    : languageState.detected
      ? `自动识别（${languageLabel(languageState.detected)}）`
      : '自动跟随当前客户';
  if (autoOption.textContent !== autoDescription) autoOption.textContent = autoDescription;
  languageSelect.value = languageState.preferred || 'auto';
  // Keep the send-translation hint visible while the user is typing. Hiding
  // it as soon as composerHasText became true made the customer/language
  // direction disappear exactly when it was most useful.
  if (composerHint && composerRow && footerBounds?.width) {
    if (composerHint.parentElement !== composerRow) composerRow.appendChild(composerHint);
    const hasCustomerOverride = Object.keys(languageState.entry || {}).some((key) => key.endsWith('Override'))
      || Boolean(languageState.preferredProvider || languageState.preferred);
    const scopeLabel = hasCustomerOverride ? '[客户]' : '[全局]';
    const sourceSetting = languageState.inputLanguage || 'auto';
    const outgoingSetting = languageState.sendLanguage || 'auto';
    const sourceLabel = sourceSetting === 'auto' ? '自动检测' : languageLabel(sourceSetting);
    const outgoingLabel = outgoingSetting === 'auto' ? '自动检测' : languageLabel(outgoingSetting);
    composerHint.textContent = `${scopeLabel} 发送消息 [${provider}] ${sourceLabel} => ${outgoingLabel}`;
    // Keep the composer direction hint visually consistent with the effective
    // translation style, including per-customer font-color overrides.
    composerHint.style.color = languageState.fontColor || defaultTranslationSettings.fontColor;
    composerHint.style.display = 'inline-flex';
    composerHint.style.maxWidth = 'calc(100% - 2px)';
    setNativeComposerPlaceholderHidden(composerContainer, composer, !composerHasText);
  } else if (composerHint) {
    composerHint.style.display = 'none';
    setNativeComposerPlaceholderHidden(composerContainer, composer, false);
  }
  if (composerProgress && composerContainer && footerBounds?.width) {
    if (composerProgress.parentElement !== composerContainer) {
      composerContainer.appendChild(composerProgress);
    }
    const progressLabels = {
      loading: '自动翻译中…',
      success: '正在发送…',
      language: '请选择客户语言；再次发送原文',
      error: `${provider}翻译失败；再次发送原文`,
    };
    const progressText = progressLabels[composerTranslationState] || '';
    composerProgress.textContent = progressText;
    composerProgress.title = composerTranslationError;
    composerProgress.dataset.seagrassError = composerTranslationError;
    composerProgress.style.display = progressText ? 'inline-flex' : 'none';
  } else if (composerProgress) {
    composerProgress.style.display = 'none';
  }
  if (inlineCustomerControl) {
    const inlineLanguage = languageState.preferred
      || languageState.windowSendFallback
      || languageState.detected;
    inlineCustomerControl.title = `当前客户语言：${inlineLanguage ? languageLabel(inlineLanguage) : '自动跟随'}；点击打开客户设置`;
  }
  const customerTitle = status.__seagrassCustomerPopover?.querySelector('[data-seagrass-customer-title]');
  if (customerTitle) customerTitle.textContent = `客户设置 · ${currentCustomerDisplayName()}`;
  populateCustomerTranslationControls(status.__seagrassCustomerPopover, languageState);

  setStatusText(status, '[data-seagrass-status-provider]', provider);
  setStatusText(status, '[data-seagrass-status-route]', route);
  setStatusText(
    status,
    '[data-seagrass-status-target]',
    languageLabel(languageState.targetLanguage || 'zh'),
  );
  status.querySelector('[data-seagrass-status-arrow]').style.display = messageTranslationEnabled ? '' : 'none';
  status.querySelector('[data-seagrass-status-target]').style.display = messageTranslationEnabled ? '' : 'none';
  status.querySelector('[data-seagrass-status-dot]').style.background = statusEnabled ? '#12a594' : '#aebbc2';

  const translateButton = status.__seagrassComposeTranslateButton;
  translateButton.style.display = sendTranslationEnabled ? '' : 'none';
  translateButton.disabled = composerTranslationState === 'loading';
  translateButton.style.cursor = translateButton.disabled ? 'wait' : 'pointer';
  translateButton.style.opacity = translateButton.disabled ? '0.7' : '1';
  const buttonLabels = {
    idle: '译入输入框',
    loading: '翻译中…',
    success: '已处理',
    empty: '请先输入消息',
    language: '请先选择语言',
    skipped: '无需翻译',
    error: '翻译失败',
  };
  translateButton.textContent = buttonLabels[composerTranslationState] || buttonLabels.idle;
  status.title = '每个客户会话独立保存语言；发送时先翻译，再调用当前平台发送。';
  if (
    status.__seagrassCustomerPopover
    && !status.__seagrassCustomerPopover.hidden
    && status.__seagrassCustomerPopover.style.display !== 'none'
  ) {
    positionCustomerPopover();
  }
}

function setComposerTranslationState(state, resetDelay = 0) {
  composerTranslationState = state;
  if (state !== 'error') composerTranslationError = '';
  if (composerTranslationResetTimer) window.clearTimeout(composerTranslationResetTimer);
  if (resetDelay > 0) {
    composerTranslationResetTimer = window.setTimeout(() => {
      composerTranslationState = 'idle';
      updateTranslationStatus();
    }, resetDelay);
  }
  updateTranslationStatus();
}

function describeTranslationError(error) {
  const raw = String(error?.detail || error?.code || error?.message || error || 'translation_failed');
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 240);
}

function findComposerInput() {
  return document.querySelector('#main [data-testid="conversation-compose-box-input"]')
    || document.querySelector('#main footer [contenteditable="true"][data-tab]')
    || document.querySelector('#main footer [contenteditable="true"][role="textbox"]')
    || document.querySelector('#main footer [contenteditable="true"]');
}

async function replaceComposerText(composer, text) {
  const result = await ipcRenderer.invoke('platform:replace-composer-text', { text });
  if (!result?.ok) {
    throw new Error(`composer_replace_failed:${result?.reason || 'unknown'}`);
  }
  const currentComposer = findComposerInput();
  if (!currentComposer || currentComposer.textContent?.trim() !== text.trim()) {
    throw new Error('composer_replace_failed:isolated_world_text_mismatch');
  }
  return true;
}

async function translateComposerForCurrentCustomer({ autoSend = false, sendButton = null } = {}) {
  const languageState = conversationLanguageState();
  if (!languageState.sendTranslation || composerTranslationState === 'loading') return;
  if (composerTranslationState !== 'idle') setComposerTranslationState('idle');
  const composer = findComposerInput();
  const text = composer?.textContent?.trim();
  if (!composer || !text) {
    setComposerTranslationState('empty', 1800);
    return;
  }
  if (!isTranslatableMessageText(text)) {
    setComposerTranslationState('skipped', 1400);
    return;
  }

  if (!languageState.outgoingResolved) {
    rawSendFallback = { text, conversationKey: languageState.key };
    setComposerTranslationState('language');
    document.querySelector(TRANSLATION_STATUS_SELECTOR)?.__seagrassCustomerLanguageSelect?.focus();
    return;
  }

  const sourceLanguage = languageState.inputLanguage || defaultTranslationSettings.inputLanguage;
  const targetLanguage = languageState.outgoingResolved;
  if (languagesEquivalent(sourceLanguage, targetLanguage)) {
    // The message is already in the target language. Keep the native text,
    // bypass the API, and allow the original send action to continue.
    lastTranslatedComposer = {
      text,
      targetLanguage,
      conversationKey: languageState.key,
    };
    setComposerTranslationState('skipped', 1400);
    if (autoSend) {
      window.setTimeout(() => {
        const currentComposer = findComposerInput();
        if (
          !currentComposer
          || currentComposer.textContent?.trim() !== text
          || lastTranslatedComposer.text !== text
          || lastTranslatedComposer.targetLanguage !== targetLanguage
          || lastTranslatedComposer.conversationKey !== languageState.key
        ) return;
        const button = sendButton?.isConnected
          ? sendButton.closest?.('button, [role="button"]') || sendButton
          : findCurrentSendButton();
        if (button) {
          rememberOutgoingOriginal(text, text, languageState.key);
          button.click();
        }
      }, 60);
    }
    return;
  }
  setComposerTranslationState('loading');
  try {
    const result = await requestTranslationWithSilentRetry({
      text,
      messageId: `composer:${stableHash(`${text}:${sourceLanguage}:${languageState.outgoingResolved}`)}`,
      provider: languageState.provider,
      sourceLanguage,
      targetLanguage,
    }, { priority: true });
    if (!result?.text) throw new Error('translation_result_empty');
    if (findComposerInput() !== composer || composer.textContent?.trim() !== text) {
      setComposerTranslationState('idle');
      return;
    }
    await replaceComposerText(composer, result.text);
    rawSendFallback = { text: '', conversationKey: '' };
    lastTranslatedComposer = {
      text: result.text.trim(),
      targetLanguage,
      conversationKey: languageState.key,
    };
    setComposerTranslationState('success', 2200);
    if (autoSend) {
      window.setTimeout(() => {
        const currentComposer = findComposerInput();
        if (
          !currentComposer
          || currentComposer.textContent?.trim() !== result.text.trim()
          || lastTranslatedComposer.text !== result.text.trim()
          || lastTranslatedComposer.targetLanguage !== targetLanguage
          || lastTranslatedComposer.conversationKey !== languageState.key
        ) return;
        const button = sendButton?.isConnected
          ? sendButton.closest?.('button, [role="button"]') || sendButton
          : findCurrentSendButton();
        if (button) {
          rememberOutgoingOriginal(text, result.text, languageState.key);
          button.click();
        }
      }, 60);
    }
  } catch (error) {
    composerTranslationError = describeTranslationError(error);
    console.warn('[seagrass] translation detail:', error?.detail || error?.message || error);
    console.error('[seagrass] composer translation failed', error);
    if (findComposerInput() === composer && composer.textContent?.trim() === text) {
      rawSendFallback = { text, conversationKey: languageState.key };
      setComposerTranslationState('error');
    } else {
      setComposerTranslationState('idle');
    }
  }
}

function findSendButton(target) {
  return target?.closest?.(
    '#main [data-testid="send"], #main [data-icon="send"], #main button[aria-label="Send"], #main button[aria-label*="Send"], #main button[aria-label*="发送"], #main [role="button"][aria-label*="Send"], #main [role="button"][aria-label*="发送"]',
  );
}

function findCurrentSendButton() {
  return document.querySelector(
    '#main [data-testid="send"], #main [data-icon="send"], #main button[aria-label="Send"], #main button[aria-label*="Send"], #main button[aria-label*="发送"], #main [role="button"][aria-label*="Send"], #main [role="button"][aria-label*="发送"]',
  );
}

function handleSendIntent(event) {
  const languageState = conversationLanguageState();
  const composer = findComposerInput();
  if (!composer) return;

  let sendButton = null;
  if (event.type === 'keydown') {
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || event.isComposing
      || event.keyCode === 229
      || !event.target?.closest?.('#main footer')
    ) return;
    const editable = event.target?.closest?.('[contenteditable="true"]');
    if (editable && editable !== composer) return;
    sendButton = findCurrentSendButton();
  } else {
    sendButton = findSendButton(event.target);
    if (!sendButton) return;
  }

  const text = composer.textContent?.trim() || '';
  if (!text) return;

  const pendingAi = pendingAiOutgoingOriginal;
  if (
    pendingAi.sentText
    && pendingAi.originalText
    && pendingAi.conversationKey === languageState.key
    && normalizedMessageText(pendingAi.sentText) === normalizedMessageText(text)
  ) {
    // The AI text is already in the target/customer language.  Commit the
    // Chinese reference at the send boundary and let the native WhatsApp
    // send continue.  This avoids a second translation request and keeps the
    // reference line attached even when send-translation is disabled.
    event.preventDefault();
    event.stopImmediatePropagation();
    pendingAiOutgoingOriginal = { originalText: '', sentText: '', conversationKey: '' };
    rememberOutgoingOriginal(pendingAi.originalText, text, languageState.key);
    lastTranslatedComposer = {
      text,
      targetLanguage: languageState.outgoingResolved || '',
      conversationKey: languageState.key,
    };
    setComposerTranslationState('success', 2200);
    window.setTimeout(() => {
      const currentComposer = findComposerInput();
      if (!currentComposer || normalizedMessageText(currentComposer.textContent) !== normalizedMessageText(text)) return;
      const button = sendButton?.isConnected
        ? sendButton.closest?.('button, [role="button"]') || sendButton
        : findCurrentSendButton();
      if (button) button.click();
    }, 0);
    return;
  }
  if (pendingAi.sentText) {
    pendingAiOutgoingOriginal = { originalText: '', sentText: '', conversationKey: '' };
  }

  if (!languageState.sendTranslation) return;
  if (!isTranslatableMessageText(text)) return;

  if (
    rawSendFallback.text === text
    && rawSendFallback.conversationKey === languageState.key
  ) {
    // Translation previously failed and the user is explicitly sending the
    // typed text. Mark it as locally authored so the message observer does
    // not translate that outgoing bubble a second time.
    rememberOutgoingOriginal(text, text, languageState.key);
    rawSendFallback = { text: '', conversationKey: '' };
    if (composerTranslationResetTimer) window.clearTimeout(composerTranslationResetTimer);
    composerTranslationResetTimer = undefined;
    composerTranslationState = 'idle';
    updateTranslationStatus();
    return;
  }
  if (
    lastTranslatedComposer.text === text
    && lastTranslatedComposer.targetLanguage === languageState.outgoingResolved
    && lastTranslatedComposer.conversationKey === languageState.key
  ) {
    lastTranslatedComposer = { text: '', targetLanguage: '', conversationKey: '' };
    if (composerTranslationResetTimer) window.clearTimeout(composerTranslationResetTimer);
    composerTranslationResetTimer = undefined;
    composerTranslationState = 'idle';
    updateTranslationStatus();
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  void translateComposerForCurrentCustomer({ autoSend: true, sendButton });
}

document.addEventListener('click', handleSendIntent, true);
document.addEventListener('keydown', handleSendIntent, true);

function messageDirection(message) {
  const classNode = message?.matches?.('.message-in, .message-out')
    ? message
    : message?.closest?.('.message-in, .message-out');
  if (classNode?.matches?.('.message-in')) return 'incoming';
  if (classNode?.matches?.('.message-out')) return 'outgoing';

  // New WhatsApp Web builds no longer expose message-in/message-out classes,
  // but retain an explicit tail-in/tail-out marker on each message bubble.
  if (message?.querySelector?.('[data-testid="tail-in"]')) return 'incoming';
  if (message?.querySelector?.('[data-testid="tail-out"]')) return 'outgoing';

  // In some WhatsApp builds data-testid="msg-container" is the outer row and
  // the authoritative from-me data-id lives on a child node. Prefer the id
  // closest to the actual message text before falling back to visual position.
  const textAnchor = findMessageText(message);
  const dataNodes = [
    textAnchor?.closest?.('[data-id]'),
    message,
    message?.closest?.('[data-id]'),
    ...(message?.querySelectorAll?.(
      '[data-id^="true_"], [data-id^="false_"], [data-id^="in_"], [data-id^="out_"]',
    ) || []),
  ].filter(Boolean);
  for (const dataNode of dataNodes) {
    const dataId = String(dataNode?.getAttribute?.('data-id') || '');
    if (/^(?:false|in)(?:_|$)/iu.test(dataId)) return 'incoming';
    if (/^(?:true|out)(?:_|$)/iu.test(dataId)) return 'outgoing';
  }

  // WhatsApp has changed its class names several times. On builds without
  // message-in/message-out, the bubble position is still stable: customer
  // messages sit on the left and our messages sit on the right.
  const mainBounds = (
    document.querySelector('[data-testid="conversation-panel-wrapper"]')
    || document.querySelector('#main')
  )?.getBoundingClientRect?.();
  const visualNode = classNode
    || message?.querySelector?.('[data-testid="msg-container"], .copyable-text')
    || message;
  const messageBounds = visualNode?.getBoundingClientRect?.();
  if (mainBounds && messageBounds && messageBounds.width > 0) {
    const messageCenter = messageBounds.left + messageBounds.width / 2;
    const mainCenter = mainBounds.left + mainBounds.width / 2;
    const threshold = Math.max(36, mainBounds.width * 0.06);
    if (messageCenter < mainCenter - threshold) return 'incoming';
    if (messageCenter > mainCenter + threshold) return 'outgoing';
  }

  return 'unknown';
}

function isIncomingMessage(message) {
  return messageDirection(message) === 'incoming';
}

function messageTimestampFor(message) {
  const candidates = [
    message,
    ...(message?.querySelectorAll?.('[data-pre-plain-text]') || []),
    ...(message?.closest?.('[data-pre-plain-text]') ? [message.closest('[data-pre-plain-text]')] : []),
  ];
  for (const node of candidates) {
    const raw = node?.getAttribute?.('data-pre-plain-text');
    if (!raw) continue;
    const value = String(raw).match(/^\s*\[([^\]]+)\]/u)?.[1]?.trim() || '';
    if (!value) continue;
    // WhatsApp changes this field with the browser locale. Support both
    // [DD/MM/YYYY, HH:mm] and [HH:mm, DD/MM/YYYY], plus year-first/Chinese
    // dates. Date.parse cannot reliably read DD/MM/YYYY, so extract the date
    // and clock independently and construct a local Date explicitly.
    const normalized = value
      .replace(/[，]/gu, ',')
      .replace(/[年.\-]/gu, '/')
      .replace(/[月]/gu, '/')
      .replace(/[日]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    const timeMatch = normalized.match(/(?:^|[\s,])(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:$|[\s,])/iu);
    const yearFirst = normalized.match(/(?:^|[\s,])(\d{4})\/(\d{1,2})\/(\d{1,2})(?:$|[\s,])/u);
    const dayOrMonthFirst = yearFirst
      ? null
      : normalized.match(/(?:^|[\s,])(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:$|[\s,])/u);
    if (timeMatch && (yearFirst || dayOrMonthFirst)) {
      let year;
      let month;
      let day;
      if (yearFirst) {
        year = Number(yearFirst[1]);
        month = Number(yearFirst[2]);
        day = Number(yearFirst[3]);
      } else {
        const first = Number(dayOrMonthFirst[1]);
        const second = Number(dayOrMonthFirst[2]);
        year = Number(dayOrMonthFirst[3]);
        const localeRegion = String(navigator.language || '').split('-')[1]?.toUpperCase() || '';
        const localeUsesMonthFirst = ['US', 'PH'].includes(localeRegion);
        const usesMonthFirst = first <= 12 && (
          second > 12
          || (second <= 12 && localeUsesMonthFirst)
        );
        day = usesMonthFirst ? second : first;
        month = usesMonthFirst ? first : second;
      }
      if (year < 100) year += 2000;
      let hour = Number(timeMatch[1]);
      const minute = Number(timeMatch[2]);
      const second = Number(timeMatch[3] || 0);
      const meridiem = String(timeMatch[4] || '').toUpperCase();
      if (meridiem === 'PM' && hour < 12) hour += 12;
      if (meridiem === 'AM' && hour === 12) hour = 0;
      const parsed = new Date(year, month - 1, day, hour, minute, second);
      if (
        parsed.getFullYear() === year
        && parsed.getMonth() === month - 1
        && parsed.getDate() === day
        && parsed.getHours() === hour
        && parsed.getMinutes() === minute
      ) return parsed.toISOString();
    }
    // 其它含完整日期的格式（如英文月份名 14 Aug 2026）交给 Date.parse。
    if (!/(?:\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2})/u.test(value)) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      return new Date(timestamp).toISOString();
    }
  }
  return '';
}

function messageIdFor(message, text) {
  const dataNode = [message, message.closest('[data-id]')].find(
    (node) => node?.getAttribute('data-id'),
  );
  if (dataNode?.getAttribute('data-id')) return dataNode.getAttribute('data-id');
  // Fallback 不再包含 ordinal（消息在可见列表中的位置索引）：滚动加载/新消息
  // 加入会让同一消息的 ordinal 变化，导致 key 变、翻译缓存失配、重新翻译扣费。
  // 用 direction + timestamp + text 作为稳定指纹，同文本消息共用缓存反而更省。
  const timestamp = messageTimestampFor(message);
  return `text:${stableHash(`${location.pathname}:${messageDirection(message)}:${timestamp}:${text}`)}`;
}

function isConversationAtLatestMessage() {
  // WhatsApp virtualises its list. While the user is reading older history,
  // the mounted DOM is not the latest conversation segment. Known WhatsApp
  // builds expose a visible "scroll to bottom" action in that state.
  const scrollToLatest = document.querySelector([
    '[data-testid="scroll-to-bottom"]',
    'button[aria-label="Scroll to bottom"]',
    'button[aria-label="回到底部"]',
    'button[aria-label="滚动到底部"]',
  ].join(','));
  return !(scrollToLatest && scrollToLatest.getClientRects().length);
}

function emitConversationMessage(message, text, translation = null) {
  const messageKey = messageIdFor(message, text);
  const direction = messageDirection(message);
  if (direction === 'unknown') return;
  const incoming = direction === 'incoming';
  const conversationKey = conversationKeyForMessage(message) || currentConversationKey();
  if (!messageKey || !conversationKey || !text) return;
  const cached = translationCache[messageKey];
  const languageState = conversationLanguageState(conversationKey);
  const cachedIsCurrent = !incoming || (
    translationCacheMatches(cached, {
      provider: languageState.provider,
      sourceLanguage: languageState.incomingRequestLanguage,
      targetLanguage: languageState.targetLanguage,
    })
    && !shouldSkipIncomingTranslation({
      inferredLanguage: inferScriptLanguage(text),
      sourceLanguage: languageState.incomingRequestLanguage,
      targetLanguage: languageState.targetLanguage,
      skipChineseMessages: languageState.skipChineseMessages,
    })
  );
  const outgoingOriginal = incoming ? '' : originalForOutgoingMessage(messageKey, text, conversationKey);
  const hasLocalOutgoingBinding = Boolean(outgoingOriginal);
  const hasDistinctOutgoingOriginal = Boolean(
    outgoingOriginal && shouldRenderOutgoingOriginal(outgoingOriginal, text),
  );
  const cachedDisplayTranslation = cachedIsCurrent
    && !hasLocalOutgoingBinding
    && cached?.kind !== 'outgoing-original'
    && cached?.provider !== 'composer-original'
    ? cached
    : null;
  const originalText = hasDistinctOutgoingOriginal ? outgoingOriginal : text;
  const translatedText = incoming
    ? (translation?.text || (cachedIsCurrent ? cached?.text : null) || null)
    : (
      hasDistinctOutgoingOriginal
        ? text
        // 本机原样发送但界面渲染了目标语言译文（如直接打英文）时，译文一并上报。
        : (translation?.text || cachedDisplayTranslation?.text || null)
    );
  const translationProvider = incoming
    ? (translation?.provider || (cachedIsCurrent ? cached?.provider : null) || null)
    : (
      hasDistinctOutgoingOriginal
        ? (translation?.provider || 'composer-original')
        : (translation?.provider || cachedDisplayTranslation?.provider || null)
    );
  const platformTimestamp = messageTimestampFor(message);
  const domPosition = messageDomPositions.get(canonicalMessageRoot(message)) || null;
  ipcRenderer.send('platform:message-captured', {
    message_key: messageKey,
    platform_contact_id: conversationKey,
    display_name: currentCustomerDisplayName(),
    direction,
    original_text: originalText,
    translated_text: translatedText,
    translation_provider: translationProvider,
    send_status: 'sent',
    // Prefer WhatsApp's own timestamp. The source marker lets the main
    // process repair legacy records that previously stored scan time as the
    // message time.
    message_at: platformTimestamp || new Date().toISOString(),
    message_time_source: platformTimestamp ? 'platform' : 'capture',
    dom_scan_id: domPosition?.scanId || '',
    dom_index: Number.isInteger(domPosition?.index) ? domPosition.index : null,
    dom_order_authoritative: isConversationAtLatestMessage(),
  });
}

function assistantImageNodes(message) {
  return [...message.querySelectorAll('img')].filter(image => {
    if (!image.complete || image.naturalWidth < 72 || image.naturalHeight < 72) return false;
    if (image.closest('[data-seagrass-translation], [data-testid*="quoted"], [data-testid*="sticker"], [data-testid*="avatar"], [data-testid*="link-preview"]')) return false;
    if (/avatar|profile|sticker|emoji|头像|贴纸/i.test((image.alt || '') + ' ' + (image.getAttribute('data-testid') || ''))) return false;
    const rect = image.getBoundingClientRect();
    return rect.width >= 72 && rect.height >= 72 && rect.bottom > 0 && rect.top < innerHeight;
  });
}

function assistantImageSnapshot(image) {
  const rect = image.getBoundingClientRect();
  try {
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.86) };
  } catch {
    // Cross-origin media cannot be read by canvas. Only an entirely visible
    // image can fall back to a bounded capture; never capture the whole screen.
    if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return null;
    return { rect: { x: Math.ceil(rect.left), y: Math.ceil(rect.top), width: Math.floor(rect.width), height: Math.floor(rect.height) } };
  }
}

function assistantMessagesFromVisibleDom(includeImages = false) {
  if (!isConversationAtLatestMessage()) return [];
  const main = document.querySelector('#main');
  const roots = visibleMessageRoots().filter(message => !main || main.contains(message)).slice(-50);
  const selectedImages = includeImages ? new Set(roots.flatMap(assistantImageNodes).slice(-4)) : new Set();
  return roots.map((message) => {
    const anchor = findMessageText(message);
    const text = anchor?.textContent?.trim() || '';
    const direction = messageDirection(message);
    const imageNodes = assistantImageNodes(message);
    if ((!text && !imageNodes.length) || text.length > 5000 || direction === 'unknown') return null;
    const translation = [...message.querySelectorAll('[data-seagrass-translation]')]
      .map((node) => node.textContent?.trim() || '')
      .find((value) => value && value !== text) || '';
    return {
      message_key: messageIdFor(message, text),
      direction,
      original_text: text,
      image_count: imageNodes.length,
      ...(includeImages ? { images: imageNodes.filter(image => selectedImages.has(image)).map(assistantImageSnapshot).filter(Boolean) } : {}),
      translated_text: translation || null,
      message_at: messageTimestampFor(message) || null,
    };
  }).filter(Boolean).slice(-50);
}

ipcRenderer.on('assistant:collect-context', (_event, request) => {
  const contactId = currentConversationKey();
  const matches = Boolean(contactId && contactId === request?.contactId);
  const latest = isConversationAtLatestMessage();
  ipcRenderer.send('assistant:collected-context', {
    requestId: request?.requestId,
    contactId,
    ok: matches && latest,
    reason: !matches ? '聊天已切换，请重新打开当前聊天的 AI 回复。' : !latest ? '请先滚动到聊天底部，再生成回复。' : '',
    messages: matches && latest && !request.checkOnly ? assistantMessagesFromVisibleDom(true) : [],
    viewport: { width: innerWidth, height: innerHeight },
  });
});

function refreshMessageTranslations() {
  document.querySelectorAll('[data-seagrass-translation], [data-seagrass-translate-manually]')
    .forEach((node) => {
      if (node.matches?.('[data-seagrass-translate-manually]')) {
        intentionalManualActionRemovals.add(node);
      }
      node.remove();
    });
  scheduleScan();
}

function clearSameTextTranslationState(message, text, messageKey) {
  const normalizedText = normalizedMessageText(text);
  if (!normalizedText) return;
  message.querySelectorAll('[data-seagrass-translation]').forEach((node) => node.remove());
  if (messageKey && translationCache[messageKey]?.text
    && normalizedMessageText(translationCache[messageKey].text) === normalizedText) {
    delete translationCache[messageKey];
    saveTranslationCache();
  }
}

function scheduleScan() {
  const now = Date.now();
  // 滚动期间（用户连续滚滑）：延迟到停止滚动后再扫，避免 scanMessages() 在滚动画过程中频繁运行
  if (isScrolling && !messageScanPending) {
    messageScanPending = true;
    window.setTimeout(() => {
      messageScanPending = false;
      scheduleScan();
    }, SCROLL_DEFER_MS);
    return;
  }
  if (now < messageScanCooldownUntil) {
    // Inside the post-scan cooldown: coalesce further changes into a single
    // pending scan that runs once the cooldown expires, so a burst of DOM
    // changes (WhatsApp renders dozens of nodes per second) does not keep
    // scanMessages() running back-to-back.
    if (!messageScanPending) {
      messageScanPending = true;
      window.setTimeout(() => {
        messageScanPending = false;
        scheduleScan();
      }, messageScanCooldownUntil - now);
    }
    return;
  }
  if (scanScheduled) return;
  scanScheduled = true;
  window.setTimeout(() => {
    scanScheduled = false;
    messageScanCooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
    scanMessages();
  }, SCAN_DEBOUNCE_MS);
}

function messageLikeDataId(node) {
  const value = String(node?.getAttribute?.('data-id') || '');
  return /^(?:true|false|in|out)(?:_|$)/iu.test(value);
}

// A quoted/replied-to message can carry its own message-shaped data-id inside
// the new bubble. Always promote that nested node to the outer message root;
// otherwise the quote is scanned as a separate message and the new reply body
// is either missed or attached to the wrong translation cache key.
function canonicalMessageRoot(candidate) {
  if (!candidate) return null;
  const containerRoot = candidate.matches?.('[data-testid="msg-container"]')
    ? candidate
    : candidate.closest?.('[data-testid="msg-container"]');
  if (containerRoot) return containerRoot;

  const classRoot = candidate.matches?.('.message-in, .message-out')
    ? candidate
    : candidate.closest?.('.message-in, .message-out');
  if (classRoot) return classRoot;

  let root = candidate.matches?.('[data-id]')
    ? candidate
    : candidate.closest?.('[data-id]');
  if (!root) return candidate;

  let ancestor = root.parentElement?.closest?.('[data-id]');
  while (ancestor) {
    if (messageLikeDataId(ancestor)) root = ancestor;
    ancestor = ancestor.parentElement?.closest?.('[data-id]');
  }
  return root;
}

function visibleMessageRoots() {
  const roots = [];
  const seen = new Set();
  const candidates = document.querySelectorAll(
    '[data-testid="msg-container"], .message-in, .message-out, [data-id^="true_"], [data-id^="false_"], [data-id^="in_"], [data-id^="out_"]',
  );
  for (const candidate of candidates) {
    const message = canonicalMessageRoot(candidate);
    if (!message || seen.has(message)) continue;
    seen.add(message);
    roots.push(message);
  }
  return roots;
}

function findMessageText(message) {
  // WhatsApp renders the quoted preview before the actual reply and both can
  // use selectable-text. The last selectable node is the newly sent/received
  // body; the old first-node strategy translated the quoted text instead.
  const selectable = [...message.querySelectorAll('[data-testid="selectable-text"]')]
    .filter((node) => (
      node.textContent?.trim()
      && !node.closest('[data-seagrass-translation], [data-seagrass-translate-manually]')
    ));
  if (selectable.length) return selectable[selectable.length - 1];
  const spans = [...message.querySelectorAll('span[dir="auto"]')]
    .filter((node) => (
      node.textContent?.trim()
      && !node.closest('[data-seagrass-translation], [data-seagrass-translate-manually]')
    ));
  return spans[spans.length - 1] || null;
}

function removeQuotedTranslationArtifacts(message, anchor) {
  if (!message || !anchor) return;
  const bodyOwner = anchor.closest?.('[data-id]');
  if (!bodyOwner) return;
  message.querySelectorAll(
    '[data-seagrass-translation], [data-seagrass-translate-manually]',
  ).forEach((node) => {
    const nodeOwner = node.closest?.('[data-id]');
    if (!nodeOwner || nodeOwner === bodyOwner) return;
    if (node.matches?.('[data-seagrass-translate-manually]')) {
      intentionalManualActionRemovals.add(node);
    }
    node.remove();
  });
}

function showUnavailable(translation, error) {
  translation.textContent = error ? describeTranslationError(error) : '翻译暂时不可用';
  translation.style.color = '#a3aab4';
}

function removeManualTranslationAction(message) {
  message?.querySelectorAll?.('[data-seagrass-translate-manually]')
    .forEach((node) => {
      intentionalManualActionRemovals.add(node);
      node.remove();
    });
}

function removeTranslationArtifacts(message) {
  message?.querySelectorAll?.('[data-seagrass-translation], [data-seagrass-translate-manually]')
    .forEach((node) => {
      if (node.matches?.('[data-seagrass-translate-manually]')) {
        intentionalManualActionRemovals.add(node);
      }
      node.remove();
    });
}

// 给每条消息统一添加翻译按钮：
// - 无译文 / 译文与原文相同 → 「翻译」（点击翻译）
// - 已有译文 → 「重新翻译」（点击清缓存重译）
// 中译英发送的消息也保留按钮：译文行是发送前的原文，用户仍可手动重新
// 翻译当前消息。按钮必须稳定存在，不能被 outgoing-original 分支清掉。
function ensureMessageTranslateButton(message, anchor, plan) {
  if (!message || !anchor || !plan?.key) return null;
  if (!isTranslatableMessageText(plan.text)) {
    // Remove an action left by an older scan/build when the message text is
    // later recognised as a non-language string or keyboard mash.
    removeTranslationArtifacts(message);
    return null;
  }
  const translationNode = message.querySelector('[data-seagrass-translation]');
  const hasTranslation = translationNode
    && normalizedMessageText(translationNode.textContent) !== normalizedMessageText(plan.text);
  return ensureManualTranslationAction(message, anchor, plan, hasTranslation ? 'translated' : 'idle');
}

function ensureManualTranslationAction(message, anchor, plan, state = 'idle') {
  if (!message || !anchor || !plan?.key) return null;
  if (!isTranslatableMessageText(plan.text)) {
    removeTranslationArtifacts(message);
    return null;
  }

  const existing = message.querySelector('[data-seagrass-translate-manually]');
  if (existing) {
    // The platform can keep the injected action while replacing the message
    // text subtree.  Refresh the plan on every scan so a later click never
    // sends the text captured by an older DOM node.
    existing.__seagrassTranslationPlan = { ...plan };
    // 已有按钮：只更新文案（不打断"翻译中…/翻译失败，重试"的状态）。
    if (existing.dataset.loading !== '1') {
      existing.textContent = state === 'translated' ? '重新翻译' : '翻译';
      existing.style.textDecoration = 'underline';
    }
    return existing;
  }
  // 按钮放在译文正下方（与译文相同的插入位置），保证可见：
  // - 有译文 → 紧跟译文节点后面插入
  // - 无译文 → 追加到消息文本父元素（译文通常会渲染的位置）
  const translationAnchor = message.querySelector('[data-seagrass-translation]');
  const anchorParent = anchor.parentElement;
  const parent = (translationAnchor?.isConnected ? translationAnchor.parentElement : null)
    || anchorParent
    || message;
  if (!parent) return null;

  // WhatsApp's message subtree is React-owned and its global button rules vary
  // across builds. A neutral div avoids native button resets/reconciliation
  // while retaining keyboard and screen-reader button semantics.
  const action = document.createElement('div');
  action.setAttribute('role', 'button');
  action.setAttribute('tabindex', '0');
  action.textContent = state === 'translated' ? '重新翻译' : '翻译';
  action.setAttribute('data-seagrass-translate-manually', '');
  action.setAttribute('aria-label', '翻译这条消息');
  Object.assign(action.style, {
    display: 'block',
    margin: '3px 0 0 0',
    padding: '0',
    border: '0',
    background: 'transparent',
    color: '#6b7280',
    fontSize: '12px',
    lineHeight: '1.45',
    textAlign: 'left',
    textDecoration: 'underline',
    cursor: 'pointer',
    clear: 'both',
    position: 'relative',
    zIndex: '2',
    pointerEvents: 'auto',
    alignSelf: 'flex-start',
    flex: '0 0 100%',
    maxWidth: 'fit-content',
    width: 'fit-content',
  });
  // WhatsApp ships a few high-specificity rules for interactive descendants;
  // make the injected action visible even when those rules are marked
  // !important, without changing the surrounding bubble layout.
  action.style.setProperty('display', 'block', 'important');
  action.style.setProperty('visibility', 'visible', 'important');
  action.style.setProperty('opacity', '1', 'important');
  action.__seagrassTranslationPlan = { ...plan };

  action.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const storedPlan = action.__seagrassTranslationPlan || plan;
    const liveAnchor = message?.isConnected ? findMessageText(message) : null;
    const liveText = liveAnchor?.textContent?.trim() || storedPlan.text;
    if (!liveText || !isTranslatableMessageText(liveText)) return;
    const liveDirection = messageDirection(message);
    const activePlan = {
      ...storedPlan,
      key: message?.isConnected ? messageIdFor(message, liveText) : storedPlan.key,
      text: liveText,
      incoming: liveDirection === 'incoming'
        ? true
        : liveDirection === 'outgoing'
          ? false
          : Boolean(storedPlan.incoming),
      inferredLanguage: inferScriptLanguage(liveText) || storedPlan.inferredLanguage || '',
      conversationKey: conversationKeyForMessage(message) || storedPlan.conversationKey || currentConversationKey(),
    };
    action.__seagrassTranslationPlan = activePlan;
    if (action.dataset.loading === '1' || pendingTranslationKeys.has(activePlan.key)) return;

    const currentState = conversationLanguageState(activePlan.conversationKey);
    const provider = currentState.provider;
    const sourceLanguage = activePlan.incoming
      ? (
        currentState.incomingRequestLanguage !== 'auto'
          ? currentState.incomingRequestLanguage
          : (activePlan.inferredLanguage || 'auto')
      )
      : 'auto';
    const targetLanguage = activePlan.incoming
      ? (currentState.targetLanguage || defaultTranslationSettings.targetLanguage)
      : (currentState.inputLanguage || defaultTranslationSettings.inputLanguage);

    delete translationCache[activePlan.key];
    saveTranslationCache();
    pendingTranslationKeys.add(activePlan.key);
    manualTranslationKeys.add(activePlan.key);
    action.dataset.loading = '1';
    action.textContent = '翻译中…';
    action.style.textDecoration = 'none';
    // Replace the visible line immediately.  Otherwise the old composer
    // reference remains on screen while the fresh request is in flight and
    // looks like the retranslation did nothing.
    if (liveAnchor?.isConnected && message.contains(liveAnchor)) {
      const loadingTranslation = ensureTranslationNode(message, liveAnchor, activePlan.key);
      loadingTranslation.textContent = '翻译中…';
      Object.assign(loadingTranslation.style, translationStyle(activePlan.conversationKey));
    }
    const manualIdempotencyKey = `manual:${activePlan.key}:${Date.now()}:${++manualTranslationRequestSequence}`;

    requestTranslationWithSilentRetry({
      text: activePlan.text,
      messageId: activePlan.key,
      idempotency_key: manualIdempotencyKey,
      // Manual display translation is a user-facing preview/retry. It still
      // invokes the provider, but must not consume the member's translation
      // character quota. Automatic message/composer translation keeps the
      // default billable=true path below.
      billable: false,
      provider,
      sourceLanguage,
      targetLanguage,
    }, { priority: true, forceFresh: true }).then((result) => {
      const resultText = normalizedMessageText(result?.text);
      if (!resultText || resultText === normalizedMessageText(activePlan.text)) {
        if (message?.isConnected) clearSameTextTranslationState(message, activePlan.text, activePlan.key);
        else {
          delete translationCache[activePlan.key];
          saveTranslationCache();
          scheduleScan();
        }
        action.dataset.loading = '';
        action.textContent = '翻译';
        action.style.textDecoration = 'underline';
        if (message?.isConnected) emitConversationMessage(message, activePlan.text);
        return;
      }
      const actualSourceLanguage = result.source_language
        || result.sourceLanguage
        || (sourceLanguage !== 'auto' ? sourceLanguage : '')
        || activePlan.inferredLanguage;
      translationCache[activePlan.key] = {
        text: resultText,
        provider: result.provider || provider,
        sourceLanguage: actualSourceLanguage,
        targetLanguage: result.target_language || result.targetLanguage || targetLanguage,
        kind: 'manual-display',
        manual: true,
      };
      saveTranslationCache();
      if (activePlan.incoming && actualSourceLanguage) {
        recordConversationLanguage(actualSourceLanguage, activePlan.conversationKey);
      }
      const currentAnchor = message?.isConnected ? findMessageText(message) : null;
      if (!currentAnchor || !currentAnchor.isConnected || !message.contains(currentAnchor)) {
        // WhatsApp may have replaced the whole message row while the request
        // was in flight.  The keyed manual cache lets the next scan restore
        // the result on the replacement row.
        action.dataset.loading = '';
        action.textContent = '重新翻译';
        action.style.textDecoration = 'underline';
        scheduleScan();
        return;
      }
      const currentText = normalizedMessageText(currentAnchor.textContent);
      if (currentText && currentText !== normalizedMessageText(activePlan.text)) {
        action.dataset.loading = '';
        action.textContent = '重新翻译';
        action.style.textDecoration = 'underline';
        scheduleScan();
        return;
      }
      const translation = ensureTranslationNode(message, currentAnchor, activePlan.key);
      Object.assign(translation.style, translationStyle(activePlan.conversationKey));
      translation.textContent = resultText;
      action.dataset.loading = '';
      action.textContent = '重新翻译';
      action.style.textDecoration = 'underline';
      ensureManualTranslationAction(message, currentAnchor, activePlan, 'translated');
      emitConversationMessage(message, activePlan.text, {
        text: resultText,
        provider: result.provider || provider,
      });
    }).catch((error) => {
      action.dataset.loading = '';
      action.textContent = '翻译失败，重试';
      action.style.textDecoration = 'underline';
      if (message?.isConnected) {
        const currentAnchor = findMessageText(message);
        if (currentAnchor) {
          const currentTranslation = ensureTranslationNode(message, currentAnchor, activePlan.key);
          showUnavailable(currentTranslation, error);
        }
      } else {
        scheduleScan();
      }
    }).finally(() => {
      pendingTranslationKeys.delete(activePlan.key);
      manualTranslationKeys.delete(activePlan.key);
    });
  });

  action.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    action.click();
  });

  if (translationAnchor?.isConnected) {
    translationAnchor.insertAdjacentElement('afterend', action);
  } else {
    parent.appendChild(action);
  }
  return action;
}

function addTranslation(message, anchor, text) {
  const incoming = isIncomingMessage(message);
  const conversationKey = conversationKeyForMessage(message);
  const languageState = conversationLanguageState(conversationKey);
  if (!isTranslatableMessageText(text)) return;
  const inferredLanguage = inferScriptLanguage(text);
  if (incoming && inferredLanguage) {
    recordConversationLanguage(inferredLanguage, conversationKey);
  }
  const key = messageIdFor(message, text);
  // Incoming text is translated into the user's display language. For an
  // outgoing bubble coming from another device, the reading line must also
  // be in the user's language, not in the customer's send language.
  const targetLanguage = incoming
    ? (languageState.targetLanguage || defaultTranslationSettings.targetLanguage)
    : (languageState.inputLanguage || defaultTranslationSettings.inputLanguage);
  // Incoming messages may use the manually selected "客户消息语种".
  // Outgoing bubbles are different: they can be sent from WhatsApp Web,
  // another computer, or a phone.  Unless originalForOutgoingMessage found
  // the local composer binding above, the only trustworthy source is the
  // actual bubble text, so let the provider detect it.  Reusing the incoming
  // language/customer send-language here is what previously made an English
  // bubble get treated as Japanese (or skipped as Chinese).
  const requestSourceLanguage = incoming
    ? (
      languageState.incomingRequestLanguage !== 'auto'
        ? languageState.incomingRequestLanguage
        : (inferredLanguage || 'auto')
    )
    : 'auto';
  let cached = translationCache[key];

  // Remove stale same-language lines left by older builds before resolving a
  // current binding. Direction classes are not stable across WhatsApp Web
  // builds, so this cleanup must not depend on detecting incoming/outgoing
  // first. A Japanese bubble must never display another Japanese line merely
  // because an old composer-original cache entry or DOM node exists.
  clearSameLanguageOutgoingState(message, text, key, cached);
  cached = translationCache[key];

  // A previous provider request may have returned the source text unchanged.
  // Treat that as no translation, regardless of whether it came from the
  // cache or was already rendered into the message bubble.
  if (cached?.text && normalizedMessageText(cached.text) === normalizedMessageText(text)) {
    clearSameTextTranslationState(message, text, key);
    removeManualTranslationAction(message);
    emitConversationMessage(message, text);
    return;
  }

  // Never leave a stale translation under a message that is already in the
  // user's language. This check must happen before the existing-node/cache
  // checks, otherwise a previous setting can keep showing a wrong translation.
  if (
    incoming
    && shouldSkipIncomingTranslation({
      inferredLanguage,
      sourceLanguage: requestSourceLanguage,
      targetLanguage,
      skipChineseMessages: languageState.skipChineseMessages,
    })
  ) {
    removeTranslationArtifacts(message);
    return;
  }

  if (!incoming) {
    const originalText = originalForOutgoingMessage(key, text, conversationKey);
    const hasLocalComposerBinding = Boolean(originalText);
    const hasDistinctOutgoingOriginal = Boolean(
      originalText && shouldRenderOutgoingOriginal(originalText, text),
    );
    if (hasDistinctOutgoingOriginal) {
      const manualAction = message.querySelector('[data-seagrass-translate-manually]');
      const manualRequestInFlight = manualTranslationKeys.has(key)
        || (manualAction?.dataset.loading === '1' && pendingTranslationKeys.has(key));
      if (manualRequestInFlight) {
        // While a manual retry is running, keep the old line from being
        // restored by the outgoing-original branch.  The fresh result will
        // replace this loading marker and is then protected by the manual
        // cache below.
        const loadingTranslation = ensureTranslationNode(message, anchor, key);
        loadingTranslation.textContent = '翻译中…';
        Object.assign(loadingTranslation.style, translationStyle(conversationKey));
        ensureManualTranslationAction(message, anchor, {
          key,
          text,
          incoming: false,
          inferredLanguage,
          conversationKey,
        }, 'translated');
        emitConversationMessage(message, text);
        return;
      }
      const manualDisplayCache = isManualDisplayTranslation(cached, text)
        && translationCacheMatches(cached, {
          provider: languageState.provider,
          sourceLanguage: 'auto',
          targetLanguage,
        });
      if (manualDisplayCache) {
        // A manual retranslation is authoritative for this render pass.  Do
        // not call renderOutgoingOriginal here, or the next WhatsApp redraw
        // would overwrite the new result with the typed composer text.
        renderCachedDisplayTranslation(message, anchor, cached, key, conversationKey, {
          key,
          text,
          incoming: false,
          inferredLanguage,
          conversationKey,
        });
        emitConversationMessage(message, text, cached);
        return;
      }
      // This branch must run before the existing-node/cache checks. A bubble
      // may already have an old provider translation attached from the first
      // DOM scan; once its local send binding is known, that old translation
      // is no longer authoritative and must never be shown or billed again.
      renderOutgoingOriginal(message, anchor, text, originalText, conversationKey, key);
      ensureMessageTranslateButton(message, anchor, {
        key,
        text,
        incoming: false,
        inferredLanguage,
        conversationKey,
      });
      return;
    }

    // The message was created by this device and its sent text is unchanged.
    // 本机原样发送（发送语言与原文相同，未做发送翻译，例如直接打英文发给
    // 英文客户）：不自动翻译成目标语言，避免无谓的额度消耗；消息旁保留
    // 翻译按钮，需要确认内容时点击才翻译。
    if (hasLocalComposerBinding) {
      // A manual click may have just created a real display translation for
      // this otherwise same-text outgoing bubble. Do not let the next
      // WhatsApp/scan pass erase it (the old behavior made the button flash
      // between "重新翻译" and "翻译").
      const manualAction = message.querySelector('[data-seagrass-translate-manually]');
      const hasManualDisplayTranslation = isManualDisplayTranslation(cached, text)
        && translationCacheMatches(cached, {
          provider: languageState.provider,
          sourceLanguage: 'auto',
          targetLanguage,
        });
      if (hasManualDisplayTranslation) {
        // Same-text outgoing bubbles intentionally skip automatic translation,
        // but a manually requested result is persisted in translationCache.
        // Rebuild the visible line from that cache on reload/virtualized DOM
        // replacement; otherwise the new result is saved yet the old/empty
        // bubble appears until the user clicks again.
        renderCachedDisplayTranslation(message, anchor, cached, key, conversationKey, {
          key,
          text,
          incoming: false,
          inferredLanguage,
          conversationKey,
        });
      } else if (manualAction?.dataset.loading !== '1') {
        message.querySelectorAll('[data-seagrass-translation]')
          .forEach((node) => node.remove());
      }
      emitConversationMessage(message, text);
      return;
    }

    // A same-text binding means that the message was sent in the already
    // selected language. Chinese (or the configured display language) does
    // not need a second line, but an English message still needs a Chinese
    // reading line when it was sent from another device or through an older
    // send path that only recorded the sent text.
    if (
      shouldSkipOutgoingDisplayTranslation({
        text,
        inferredLanguage,
        targetLanguage,
        skipChineseMessages: languageState.skipChineseMessages,
      })
    ) {
      removeTranslationArtifacts(message);
      emitConversationMessage(message, text);
      return;
    }

    // Older builds stored an outgoing-original cache entry even when the
    // original and sent text were identical. It is not a translation result;
    // discard it so the normal outgoing display translation can run once.
    if (cached?.kind === 'outgoing-original' || cached?.provider === 'composer-original') {
      delete translationCache[key];
      saveTranslationCache();
      cached = undefined;
    }
  }

  const manualActionPlan = {
    key,
    text,
    incoming,
    inferredLanguage,
    conversationKey,
  };
  if (!languageState.messageTranslation) {
    ensureManualTranslationAction(message, anchor, manualActionPlan);
    return;
  }
  const existingTranslation = message.querySelector('[data-seagrass-translation]');
  if (existingTranslation && existingTranslation.dataset.seagrassMessageKey === key) {
    if (
      isManualDisplayTranslation(cached, text)
      && translationCacheMatches(cached, {
        provider: languageState.provider,
        sourceLanguage: requestSourceLanguage,
        targetLanguage,
      })
    ) {
      // A React redraw can leave the injected node in place but restore its
      // previous text.  Re-apply the keyed manual result before returning.
      renderCachedDisplayTranslation(message, anchor, cached, key, conversationKey, manualActionPlan);
      emitConversationMessage(message, text, cached);
      return;
    }
    if (manualTranslationKeys.has(key)) {
      existingTranslation.textContent = '翻译中…';
      Object.assign(existingTranslation.style, translationStyle(conversationKey));
      ensureManualTranslationAction(message, anchor, manualActionPlan, 'translated');
      return;
    }
    if (normalizedMessageText(existingTranslation.textContent) === normalizedMessageText(text)) {
      clearSameTextTranslationState(message, text, key);
      removeManualTranslationAction(message);
      emitConversationMessage(message, text);
    }
    return;
  }
  if (existingTranslation) {
    message.querySelectorAll('[data-seagrass-translation]').forEach((node) => node.remove());
  }

  if (
    isManualDisplayTranslation(cached, text)
    && translationCacheMatches(cached, {
      provider: languageState.provider,
      sourceLanguage: requestSourceLanguage,
      targetLanguage,
    })
  ) {
    // Keep the action beside a manually requested result so the user can
    // retry it again after WhatsApp virtualises/rebuilds the row.
    renderCachedDisplayTranslation(message, anchor, cached, key, conversationKey, manualActionPlan);
    if (incoming) recordConversationLanguage(cached.sourceLanguage || inferredLanguage, conversationKey);
    emitConversationMessage(message, text, cached);
    return;
  }

  if (
    translationCacheMatches(cached, {
      provider: languageState.provider,
      sourceLanguage: requestSourceLanguage,
      targetLanguage,
    })
    && cached?.text
  ) {
    removeManualTranslationAction(message);
    if (incoming) recordConversationLanguage(cached.sourceLanguage || inferredLanguage, conversationKey);
    const translation = ensureTranslationNode(message, anchor, key);
    translation.textContent = cached.text;
    Object.assign(translation.style, translationStyle(conversationKey));
    anchor.parentElement?.appendChild(translation);
    emitConversationMessage(message, text, cached);
    return;
  }
  if (
    translationCacheMatches(cached, {
      provider: languageState.provider,
      sourceLanguage: requestSourceLanguage,
      targetLanguage,
    })
    && cached?.status === 'failed'
    && Date.now() - cached.failedAt < FAILED_TRANSLATION_TTL_MS
  ) {
    const translation = ensureTranslationNode(message, anchor, key);
    Object.assign(translation.style, translationStyle(conversationKey), {
      marginTop: '3px',
      color: '#a3aab4',
      fontSize: '12px',
      lineHeight: '1.45',
      whiteSpace: 'pre-wrap',
    });
    anchor.parentElement?.appendChild(translation);
    showUnavailable(translation, cached.error);
    ensureManualTranslationAction(message, anchor, manualActionPlan);
    return;
  }
  if (pendingTranslationKeys.has(key)) return;
  pendingTranslationKeys.add(key);

  const translation = ensureTranslationNode(message, anchor, key);
  translation.textContent = '翻译中…';
  Object.assign(translation.style, translationStyle(conversationKey));
  anchor.parentElement?.appendChild(translation);

  requestTranslationWithSilentRetry({
    text,
    messageId: key,
    provider: languageState.provider,
    sourceLanguage: requestSourceLanguage,
    targetLanguage,
  }).then((result) => {
    // A local composer binding can arrive after the first DOM scan. In that
    // race, the old provider request must not overwrite the locally-authored
    // line with a second translation result.
    if (!incoming) {
      const localOriginal = originalForOutgoingMessage(key, text, conversationKey);
      if (localOriginal) {
        if (!shouldRenderOutgoingOriginal(localOriginal, text)) {
          message.querySelectorAll('[data-seagrass-translation]').forEach((node) => node.remove());
          ensureManualTranslationAction(message, anchor, manualActionPlan);
          emitConversationMessage(message, text);
        } else {
          renderOutgoingOriginal(message, anchor, text, localOriginal, conversationKey, key);
          ensureMessageTranslateButton(message, anchor, {
            key,
            text,
            incoming: false,
            inferredLanguage,
            conversationKey,
          });
        }
        return;
      }
    }
    if (result?.text) {
      const sourceLanguage = result.source_language
        || result.sourceLanguage
        || (requestSourceLanguage !== 'auto' ? requestSourceLanguage : '')
        || inferredLanguage;
      const resultText = normalizedMessageText(result.text);
      // A provider can legitimately return the input unchanged for same-
      // language text. Never render that as a second purple copy; it is not a
      // translation and makes the conversation look duplicated.
      if (!resultText || resultText === normalizedMessageText(text)) {
        clearSameTextTranslationState(message, text, key);
        ensureManualTranslationAction(message, anchor, manualActionPlan, 'idle');
        emitConversationMessage(message, text);
        return;
      }
      translationCache[key] = {
        text: resultText,
        provider: result.provider,
        sourceLanguage,
        targetLanguage: result.target_language || result.targetLanguage || targetLanguage,
      };
      saveTranslationCache();
      if (incoming) recordConversationLanguage(sourceLanguage, conversationKey);
      if (!message.isConnected) {
        scheduleScan();
        return;
      }
      const currentTranslation = translation.isConnected && message.contains(translation)
        ? translation
        : ensureTranslationNode(message, anchor, key);
      Object.assign(currentTranslation.style, translationStyle(conversationKey));
      currentTranslation.textContent = resultText;
      // Keep the action after automatic translation so it becomes
      // "重新翻译" instead of disappearing with the loading state.
      ensureManualTranslationAction(message, anchor, manualActionPlan, 'translated');
      emitConversationMessage(message, text, {
        text: resultText,
        provider: result.provider,
      });
      if (currentTranslation !== translation) scheduleScan();
    } else {
      translationCache[key] = {
        status: 'failed',
        failedAt: Date.now(),
        provider: languageState.provider,
        sourceLanguage: requestSourceLanguage,
        targetLanguage,
      };
      saveTranslationCache();
      ensureManualTranslationAction(message, anchor, manualActionPlan);
      if (message.isConnected) {
        const currentTranslation = translation.isConnected && message.contains(translation)
          ? translation
          : ensureTranslationNode(message, anchor, key);
        showUnavailable(currentTranslation);
      } else {
        scheduleScan();
      }
    }
  }).catch((error) => {
    translationCache[key] = {
      status: 'failed',
      error: describeTranslationError(error),
      failedAt: Date.now(),
      provider: languageState.provider,
      sourceLanguage: requestSourceLanguage,
      targetLanguage,
    };
    saveTranslationCache();
    ensureManualTranslationAction(message, anchor, manualActionPlan);
    if (message.isConnected) {
      const currentTranslation = translation.isConnected && message.contains(translation)
        ? translation
        : ensureTranslationNode(message, anchor, key);
      showUnavailable(currentTranslation, error);
    } else {
      scheduleScan();
    }
  }).finally(() => {
    pendingTranslationKeys.delete(key);
  });
}

function scanMessages() {
  if (!location.hostname.includes('web.whatsapp.com')) return;
  updateTranslationStatus();
  const visibleMessages = visibleMessageRoots();
  const scanId = `${Date.now()}-${++messageScanSequence}`;
  visibleMessages.forEach((message, index) => {
    messageDomPositions.set(message, { scanId, index });
  });
  for (const message of visibleMessages) {
    const anchor = findMessageText(message);
    const text = anchor?.textContent?.trim();
    if (!anchor || !text || text.length > 5000) continue;
    removeQuotedTranslationArtifacts(message, anchor);
    if (!isTranslatableMessageText(text)) {
      emitConversationMessage(message, text);
      removeTranslationArtifacts(message);
      continue;
    }

    // Resolve a locally-sent binding before archiving the bubble. Without
    // this ordering the first scan can persist the translated platform text
    // as the user's original text, before addTranslation gets a chance to
    // restore the composer input.
    if (!isIncomingMessage(message)) {
      const messageKey = messageIdFor(message, text);
      const conversationKey = conversationKeyForMessage(message);
      if (originalForOutgoingMessage(messageKey, text, conversationKey)) {
        addTranslation(message, anchor, text);
        ensureMessageTranslateButton(message, anchor, {
          key: messageKey,
          text,
          incoming: false,
          inferredLanguage: inferScriptLanguage(text),
          conversationKey,
        });
        continue;
      }
    }

    emitConversationMessage(message, text);
    addTranslation(message, anchor, text);
    ensureMessageTranslateButton(message, anchor, {
      key: messageIdFor(message, text),
      text,
      incoming: isIncomingMessage(message),
      inferredLanguage: inferScriptLanguage(text),
      conversationKey: conversationKeyForMessage(message),
    });
  }

}

function normalizedContactText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function currentConversationMatches(customer) {
  if (!customer) return false;
  const currentKey = currentConversationKey();
  if (customer.platform_contact_id && currentKey === customer.platform_contact_id) return true;
  const currentName = normalizedContactText(currentCustomerDisplayName());
  const targetName = normalizedContactText(customer.display_name);
  if (targetName && currentName === targetName) return true;
  const targetDigits = normalizedPhone(customer.phone).replace(/\D/gu, '');
  const currentDigits = normalizedPhone(currentCustomerDisplayName()).replace(/\D/gu, '');
  return Boolean(targetDigits && currentDigits && targetDigits === currentDigits);
}

function clickableChatRow(titleNode) {
  let node = titleNode;
  const mainLeft = document.querySelector('#main')?.getBoundingClientRect().left || window.innerWidth;
  for (let depth = 0; depth < 8 && node; depth += 1) {
    const bounds = node.getBoundingClientRect();
    if (
      bounds.left < mainLeft
      && bounds.width >= 220
      && bounds.height >= 42
      && bounds.height <= 120
    ) return node;
    node = node.parentElement;
  }
  return titleNode;
}

function visibleChatSearchCandidates(query, customer) {
  const normalizedQuery = normalizedContactText(query);
  const queryDigits = normalizedPhone(query).replace(/\D/gu, '');
  const targetName = normalizedContactText(customer.display_name);
  const targetDigits = normalizedPhone(customer.phone).replace(/\D/gu, '');
  return [...document.querySelectorAll('[data-testid="cell-frame-title"]')]
    .filter(isVisibleElement)
    .map((titleNode) => {
      const row = clickableChatRow(titleNode);
      const title = normalizedContactText(titleNode.textContent);
      const rowText = normalizedContactText(row.textContent);
      const rowDigits = rowText.replace(/\D/gu, '');
      const exactName = Boolean(targetName && title === targetName);
      const exactPhone = Boolean(targetDigits && rowDigits.includes(targetDigits));
      const matchesQuery = title === normalizedQuery
        || rowText.includes(normalizedQuery)
        || Boolean(queryDigits && rowDigits.includes(queryDigits));
      return { titleNode, row, exactName, exactPhone, matchesQuery };
    })
    .filter((candidate) => candidate.exactPhone || candidate.exactName || candidate.matchesQuery);
}

async function openWhatsAppConversation(customer) {
  if (!location.hostname.includes('web.whatsapp.com')) {
    return { ok: false, reason: 'unsupported_platform' };
  }
  if (currentConversationMatches(customer)) {
    return { ok: true, matchedBy: 'current_conversation' };
  }

  const phone = formatPhoneForDisplay(customer.phone);
  const queries = [...new Set([phone, customer.display_name].filter(Boolean))];
  for (const query of queries) {
    const replaced = await ipcRenderer.invoke('platform:replace-search-text', { text: query });
    if (!replaced?.ok) continue;
    const candidates = await waitForCondition(() => {
      const found = visibleChatSearchCandidates(query, customer);
      return found.length ? found : null;
    }, 3500, 120);
    if (!candidates?.length) continue;

    const exactPhone = candidates.filter((candidate) => candidate.exactPhone);
    const exactName = candidates.filter((candidate) => candidate.exactName);
    const choices = exactPhone.length ? exactPhone : exactName.length ? exactName : candidates;
    if (!phone && choices.length !== 1) {
      await ipcRenderer.invoke('platform:replace-search-text', { text: '' });
      return { ok: false, reason: 'conversation_ambiguous' };
    }
    const target = choices[0]?.row;
    if (!target) continue;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    const matched = await waitForCondition(() => currentConversationMatches(customer), 6000, 120);
    if (matched) return { ok: true, matchedBy: exactPhone.length ? 'phone' : 'name' };
  }
  await ipcRenderer.invoke('platform:replace-search-text', { text: '' }).catch(() => undefined);
  return { ok: false, reason: 'conversation_not_found' };
}

function isMessageRelatedMutation(mutation) {
  if (mutation.type !== 'childList' || !mutation.addedNodes.length) return false;
  for (const node of mutation.addedNodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (node.matches?.('[data-testid="msg-container"], .message-in, .message-out, [data-id]')) return true;
    if (node.querySelector?.('[data-testid="msg-container"], .message-in, .message-out, [data-id]')) return true;
  }
  return false;
}

function messageForMutationTarget(target) {
  const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  return canonicalMessageRoot(element);
}

function removedManualTranslationAction(mutation) {
  if (mutation.type !== 'childList' || !mutation.removedNodes.length) return false;
  for (const node of mutation.removedNodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const actions = node.matches?.('[data-seagrass-translate-manually]')
      ? [node]
      : [...(node.querySelectorAll?.('[data-seagrass-translate-manually]') || [])];
    if (actions.some((action) => !intentionalManualActionRemovals.has(action))) return true;
  }
  return false;
}

function repairMissingManualTranslationAction(message) {
  if (!message?.isConnected || message.querySelector('[data-seagrass-translate-manually]')) return;
  const now = Date.now();
  const lastAttempt = manualActionRepairAt.get(message) || 0;
  if (now - lastAttempt < MANUAL_ACTION_REPAIR_COOLDOWN_MS) return;
  manualActionRepairAt.set(message, now);
  // Let WhatsApp finish its current reconciliation before re-inserting. The
  // cooldown above prevents a persistent native cleanup rule from creating a
  // mutation loop when it removes the action again.
  window.setTimeout(() => {
    if (!message.isConnected || message.querySelector('[data-seagrass-translate-manually]')) return;
    const anchor = findMessageText(message);
    const text = anchor?.textContent?.trim() || '';
    if (!anchor || !text || text.length > 5000 || !isTranslatableMessageText(text)) return;
    removeQuotedTranslationArtifacts(message, anchor);
    ensureMessageTranslateButton(message, anchor, {
      key: messageIdFor(message, text),
      text,
      incoming: isIncomingMessage(message),
      inferredLanguage: inferScriptLanguage(text),
      conversationKey: conversationKeyForMessage(message),
    });
  }, 0);
}

function ensureVisibleManualTranslationActions() {
  if (!location.hostname.includes('web.whatsapp.com')) return;
  for (const message of visibleMessageRoots()) {
    if (!isVisibleElement(message)) continue;
    if (message.querySelector('[data-seagrass-translate-manually]')) continue;
    const anchor = findMessageText(message);
    const text = anchor?.textContent?.trim() || '';
    if (!anchor || !text || text.length > 5000) continue;
    removeQuotedTranslationArtifacts(message, anchor);
    if (!isTranslatableMessageText(text)) {
      // Also clean actions created by an older scan before the noise filter
      // was enabled; otherwise the watchdog would leave a stale button.
      removeTranslationArtifacts(message);
      continue;
    }
    const incoming = isIncomingMessage(message);
    const conversationKey = conversationKeyForMessage(message);
    const inferredLanguage = inferScriptLanguage(text);
    const languageState = conversationLanguageState(conversationKey);
    if (incoming && shouldSkipIncomingTranslation({
      inferredLanguage,
      sourceLanguage: languageState.incomingRequestLanguage,
      targetLanguage: languageState.targetLanguage,
      skipChineseMessages: languageState.skipChineseMessages,
    })) continue;
    if (!incoming) {
      if (shouldSkipOutgoingDisplayTranslation({
        text,
        inferredLanguage,
        targetLanguage: languageState.inputLanguage,
        skipChineseMessages: languageState.skipChineseMessages,
      })) continue;
    }
    ensureMessageTranslateButton(message, anchor, {
      key: messageIdFor(message, text),
      text,
      incoming,
      inferredLanguage,
      conversationKey,
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  if (!location.hostname.includes('web.whatsapp.com')) return;
  updateTranslationStatus();
  scheduleNetworkBadgeMount();
  void refreshChatCustomerCache();
  scheduleScan();
  window.setInterval(ensureVisibleManualTranslationActions, MANUAL_ACTION_WATCHDOG_MS);
  // Only message-bearing DOM additions should trigger a scan. WhatsApp Web
  // mutates its DOM almost continuously (animations, timestamps, presence,
  // typing state); filtering them out here is what keeps CPU usage sane
  // while a chat is open.
  const observer = new MutationObserver((mutations) => {
    // WhatsApp may replace the whole sidebar header during navigation. Only
    // retry when our badge is actually absent; ordinary message mutations
    // must not turn this lightweight decoration into a polling loop.
    if (!document.querySelector(NETWORK_BADGE_SELECTOR)) scheduleNetworkBadgeMount();
    if (mutations.some(isChatListRelatedMutation)) scheduleChatListCustomerTags();
    const messageMutations = mutations.filter(isMessageRelatedMutation);
    const messagesToRepair = new Set();
    for (const mutation of mutations) {
      if (!removedManualTranslationAction(mutation)) continue;
      const message = messageForMutationTarget(mutation.target);
      if (message && !message.querySelector('[data-seagrass-translate-manually]')) {
        messagesToRepair.add(message);
      }
    }
    if (!messageMutations.length && !messagesToRepair.size) return;
    // Mutation 期间：标记滚动中（用户大概率在滚动看历史），避免高频扫描
    markScrolling();
    // The regular scan also gives a removed action a second chance after
    // WhatsApp has finished rebuilding the message text subtree.
    if (messageMutations.length || messagesToRepair.size) scheduleScan();
    messagesToRepair.forEach(repairMissingManualTranslationAction);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
});
function onScrollThrottled() {
  markScrolling();
  if (scrollFrameRequested) return;
  scrollFrameRequested = true;
  window.requestAnimationFrame(() => {
    scrollFrameRequested = false;
    scheduleScan();
  });
}
function markScrolling() {
  isScrolling = true;
  if (scrollEndTimer) window.clearTimeout(scrollEndTimer);
  scrollEndTimer = window.setTimeout(() => {
    isScrolling = false;
    scheduleScan();  // 停止滚动后强制 coalesce 一次
  }, 120);
}
window.addEventListener('resize', updateTranslationStatus, { passive: true });
window.addEventListener('resize', scheduleNetworkBadgeMount, { passive: true });
window.addEventListener('scroll', onScrollThrottled, { passive: true, capture: true });

ipcRenderer.on('platform:remember-outgoing-original', (_event, payload = {}) => {
  const originalText = String(payload.originalText || '').trim();
  const sentText = String(payload.sentText || '').trim();
  // 同文本也必须记录：当发送语言与用户语言相同，或发送翻译被关闭时，
  // 这条消息仍然是本地发送的，不能被消息扫描器当成外部消息再次翻译。
  if (!originalText || !sentText) return;
  pendingAiOutgoingOriginal = {
    originalText,
    sentText,
    conversationKey: currentConversationKey(),
  };
  scheduleScan();
});

ipcRenderer.on('customer:changed', (_event, customer = {}) => {
  if (!customer?.id) return;
  const index = chatCustomerCache.findIndex((item) => item.id === customer.id);
  if (index >= 0) chatCustomerCache.splice(index, 1, customer);
  else chatCustomerCache.push(customer);
  scheduleChatListCustomerTags();
});

ipcRenderer.on('platform:settings', (_event, settings) => {
  configureLanguageCatalog(settings?.languageCatalog);
  workspaceId = typeof settings?.workspaceId === 'string' && settings.workspaceId ? settings.workspaceId : workspaceId;
  ownerMemberId = typeof settings?.ownerMemberId === 'string' && settings.ownerMemberId ? settings.ownerMemberId : ownerMemberId;
  const { languageCatalog: _languageCatalog, workspaceId: _workspaceId, ownerMemberId: _ownerMemberId, ...windowSettings } = settings || {};
  translationSettings = {
    ...defaultTranslationSettings,
    ...windowSettings,
    route: 'default-1',
    inputLanguage: String(
      windowSettings.inputLanguage
        || windowSettings.targetLanguage
        || defaultTranslationSettings.inputLanguage,
    ),
  };
  const status = document.querySelector(TRANSLATION_STATUS_SELECTOR);
  if (status) {
    const languageSelect = status.__seagrassCustomerLanguageSelect;
    const knownCodes = new Set([...languageSelect.options].map((option) => option.value));
    for (const language of customerLanguageOptions) {
      if (knownCodes.has(language)) continue;
      const option = document.createElement('option');
      option.value = language;
      option.textContent = languageLabel(language);
      languageSelect.appendChild(option);
    }
  }
  syncCustomerLanguageSelects(status?.__seagrassCustomerPopover);
  // A customer may explicitly enable message translation even when the
  // window default is disabled. Refresh using the effective customer policy.
  refreshMessageTranslations();
  updateTranslationStatus();
  scheduleScan();
});

ipcRenderer.on('platform:network-info', (_event, info = {}) => {
  platformNetworkInfo = {
    state: ['loading', 'ready', 'error'].includes(info?.state) ? info.state : 'error',
    ip: typeof info?.ip === 'string' ? info.ip : '',
    location: typeof info?.location === 'string' ? info.location : '',
  };
  updateNetworkBadge();
});

ipcRenderer.on('platform:open-conversation', (_event, payload = {}) => {
  const requestId = payload.requestId;
  Promise.resolve()
    .then(() => openWhatsAppConversation(payload.customer))
    .then((result) => ipcRenderer.send('platform:conversation-result', requestId, result))
    .catch((error) => ipcRenderer.send('platform:conversation-result', requestId, {
      ok: false,
      reason: error?.message || 'conversation_navigation_failed',
    }));
});
