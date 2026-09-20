// Electron may keep running after the launcher/development terminal closes.
// In that case stdout/stderr can emit EPIPE when a later warning is logged;
// handle that expected condition so it cannot crash the main process.
for (const output of [process.stdout, process.stderr]) {
  output?.on?.('error', (error) => {
    if (error?.code !== 'EPIPE') {
      process.nextTick(() => {
        throw error;
      });
    }
  });
}

const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  session,
  Menu,
  Tray,
  clipboard,
  nativeImage,
  ipcMain,
  screen,
  safeStorage,
  shell,
} = require('electron');
const isDev = !app.isPackaged;
// Never inherit a development shell's disabled TLS verification for API keys.
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
// Updates open the fixed download page; there is no updater service dependency.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { SocksProxyAgent } = require('socks-proxy-agent');
const translationLanguages = require('./translation-languages.json');
const { createProfileManager } = require('./profile-manager.cjs');

// 某些无 GPU 的环境（远程桌面/沙箱/虚拟机）下 Chromium GPU 进程反复崩溃，
// 用 SEAGRASS_DISABLE_GPU=1 强制走软件渲染。仅本地排障用，不影响正式包。
if (process.env.SEAGRASS_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}
// Keep WhatsApp Web on the compatible TCP/TLS path. Some Electron/Chromium
// sessions get ERR_CONNECTION_RESET while the system browser is healthy.
app.commandLine.appendSwitch('disable-quic');
app.setPath('userData', path.join(app.getPath('appData'), 'SeagrassStandalone'));
const { createLocalProvider } = require('./local-provider.cjs');
const { createLocalProxies } = require('./local-proxies.cjs');
const release = require('./release.json');
const localProvider = createLocalProvider({ directory: app.getPath('userData'), safeStorage });
const localProxies = createLocalProxies({ directory: app.getPath('userData'), safeStorage });
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow;
let mainView;
let tray;
let assistantWindow;
let assistantContext = null;
let assistantLiveMessageBatch = null;
let assistantContextRefreshTimer = null;
// AI 建议回复现在作为主窗口内的底部面板显示。原来的独立窗口变量保留
// 只是为了兼容旧版本进程，不再创建新的 BrowserWindow。
let inlineAssistantVisible = false;
// Keep this in sync with .assistant-inline-panel in src/styles.css. The
// platform WebContentsView is a native compositor layer, so it must reserve
// the full panel height or it will cover the Vue controls underneath it.
const INLINE_ASSISTANT_HEIGHT = 350;
// Keep the platform view at its current height when the inline assistant opens.
// The native window grows downward by the panel height, then returns to the
// recorded bounds when the panel closes.  No display/work-area clamping is
// applied: users may deliberately move the combined window partly off-screen.
let inlineAssistantCollapsedBounds = null;
let inlineAssistantRestoreMaximized = false;
let inlineAssistantPendingRestoreBounds = null;
let inlineAssistantPendingRestoreMaximized = false;
let inlineAssistantTransition = 0;
let inlineAssistantTransitionTimer = null;
let inlineAssistantDetachedPlatformId = '';
let inlineAssistantTogglePending = false;
let mainWindowLayoutTimer = null;
// --- Resize burst detection ---
// During continuous window dragging, resize events fire every ~16ms. Calling
// setBounds() on a heavy platform WebContentsView (WhatsApp/LINE/Zalo/Telegram)
// on every tick forces Chromium to synchronously re-raster the page, causing
// severe lag. We detect the burst, detach the platform view for the duration,
// and re-attach it once the drag settles.
let resizeBurstActive = false;
let resizeBurstSettleTimer = null;
let resizeBurstDetachedPlatformId = '';
const RESIZE_BURST_SETTLE_MS = 120;
const platformViews = new Map();
let activePlatformViewId = '';
const platformWindowRegistry = new Map();
const translationCache = new Map();
const customerRegistry = new Map();
// Backend translation can wait in the shared queue and retry a transient
// provider error. Keep the desktop timeout longer than that whole window.
const TRANSLATION_FETCH_TIMEOUT_MS = 75 * 1000;
// The API may queue behind the shared AI admission limit and retry a
// transient provider failure.  Twenty seconds was shorter than that path,
// so the desktop aborted otherwise valid DeepSeek responses.
// The API owns a 50-second end-to-end budget and the public proxy waits 60
// seconds. Stop the desktop request in the same bounded window instead of
// leaving a failed generation spinning for three minutes.
const ASSISTANT_SUGGEST_TIMEOUT_MS = 58 * 1000;
const CUSTOMER_FETCH_TIMEOUT_MS = 5 * 1000;
const MESSAGE_SYNC_TIMEOUT_MS = 8 * 1000;
const MESSAGE_SYNC_RETRY_BASE_DELAY_MS = 1500;
const MESSAGE_SYNC_RETRY_MAX_DELAY_MS = 30 * 1000;
const PLATFORM_URLS = {
  WhatsApp: 'https://web.whatsapp.com/',
  LINE: 'https://web.line.me/',
  Zalo: 'https://chat.zalo.me/',
  Telegram: 'https://web.telegram.org/',
  LinkedIn: 'https://www.linkedin.com/messaging/',
  Facebook: 'https://www.facebook.com/messages/',
  Instagram: 'https://www.instagram.com/direct/inbox/',
  X: 'https://x.com/messages',
};
const PLATFORM_ALLOWED_HOSTS = {
  WhatsApp: ['web.whatsapp.com'],
  LINE: ['line.me'],
  Zalo: ['zalo.me'],
  Telegram: ['telegram.org'],
  LinkedIn: ['linkedin.com'],
  Facebook: ['facebook.com', 'messenger.com'],
  Instagram: ['instagram.com', 'facebook.com'],
  X: ['x.com', 'twitter.com'],
};

function isAllowedPlatformUrl(platform, value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    return (PLATFORM_ALLOWED_HOSTS[platform] || []).some((host) => (
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    ));
  } catch {
    return false;
  }
}

function isBrokenPlatformDisplayName(value) {
  const text = String(value ?? '').trim();
  return !text || /^(?:[?\uFFFD]+)$/u.test(text);
}

function platformDisplayName(record = {}) {
  // Display labels are normalized before they reach the native window title.
  const platform = String(record.platform || '').trim() || '平台';
  const candidate = String(record.title || record.account || '').trim();
  if (!isBrokenPlatformDisplayName(candidate)) return candidate;
  return `${platform}窗口`;
}

function normalizePlatformDisplayRecord(record = {}) {
  const next = { ...record };
  if (next.mode !== 'proxy' && next.mode !== 'direct') {
    next.mode = (
      next.profileBinding?.mode === 'proxy'
      || Boolean(next.proxyId || next.profileBinding?.proxyId)
      || Boolean(next.proxy?.host && next.proxy?.port)
    ) ? 'proxy' : 'direct';
  }
  const displayName = platformDisplayName(next);
  if (isBrokenPlatformDisplayName(next.title)) next.title = displayName;
  if (isBrokenPlatformDisplayName(next.account)) next.account = displayName;
  return next;
}

const DESKTOP_CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const PLATFORM_CONTENT_OFFSET = { x: 210, y: 72 };
const PLATFORM_LOAD_TIMEOUT_MS = 45000;
const DEV_RENDERER_URL = process.env.SEAGRASS_DEV_SERVER_URL
  || 'http://127.0.0.1:4183';
const activeWorkspaceScope = 'local';
const activeUserScope = 'local';
let profileManager;
let appUpdateState = {
  status: isDev ? 'dev' : 'idle',
  version: app.getVersion(),
  updateVersion: '',
  progress: 0,
  message: '',
};

function publishAppUpdateState(patch = {}) {
  appUpdateState = {
    ...appUpdateState,
    ...patch,
    version: app.getVersion(),
  };
  if (mainView && !mainView.webContents.isDestroyed()) {
    mainView.webContents.send('app:update-state', appUpdateState);
  }
  return appUpdateState;
}

function isActiveWorkspace(workspaceId) {
  return Boolean(activeWorkspaceScope && workspaceId && workspaceId === activeWorkspaceScope);
}

// Local desktop state is shared by all logins on the same Windows account.
// Workspace scope is not enough here: team members may share a workspace, and
// legacy/demo records used to have only `ws_demo` without a user owner.
function isActiveScopedRecord(record = {}) {
  const workspaceId = record.workspaceId ?? record.workspace_id;
  if (!isActiveWorkspace(workspaceId)) return false;
  if (!activeUserScope) return true;
  const ownerUserId = record.ownerUserId ?? record.owner_user_id;
  return ownerUserId === activeUserScope;
}

function platformRuntimeProfile() {
  return {
    userAgent: DESKTOP_CHROME_USER_AGENT,
    locale: 'zh-CN',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron || '',
    chromiumVersion: process.versions.chrome || '',
    webRTCPolicy: 'disable_non_proxied_udp',
  };
}

function ensurePlatformProfile(config = {}) {
  if (!profileManager) throw new Error('Profile manager is not ready');
  const profile = profileManager.ensure({
    ...config,
    runtime: platformRuntimeProfile(),
  });
  if (profile?.bindingConflict) {
    platformRuntimeLog('profile-binding-conflict', {
      profileId: profile.id,
      platform: profile.platform,
      accountKey: profile.accountKey,
      bindingMismatchFields: profile.bindingMismatchFields,
    });
    const error = new Error(
      'Profile binding conflict: ' + (profile.bindingMismatchFields || []).join(', '),
    );
    error.code = 'PROFILE_BINDING_CONFLICT';
    error.profileId = profile.id;
    error.bindingMismatchFields = profile.bindingMismatchFields || [];
    throw error;
  }
  platformRuntimeLog('profile-bound', {
    profileId: profile.id,
    platform: profile.platform,
    accountKey: profile.accountKey,
    proxyMode: profile.proxyBinding.mode,
    consistency: profile.consistency,
    mismatchFields: profile.mismatchFields,
    runtimeRiskChangedFields: profile.runtimeRiskChangedFields,
    runtimeSignature: profile.runtimeSignature,
  });
  return profile;
}

function platformRegistryPath() {
  return path.join(app.getPath('userData'), 'platform-windows.json');
}

function encryptProxyPassword(password) {
  if (!password || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.encryptString(password).toString('base64');
  } catch {
    return '';
  }
}

function decryptProxyPassword(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}

function runtimeProxy(configProxy) {
  if (!configProxy) return undefined;
  return {
    ...configProxy,
    password: configProxy.password || decryptProxyPassword(configProxy.passwordEncrypted),
  };
}

function translationCachePath() {
  return path.join(app.getPath('userData'), 'translation-cache.json');
}

const DEFAULT_SYSTEM_SETTINGS = {
  language: '简体中文',
  defaultView: '应用中心',
  openWindowOnLaunch: true,
  launchOnStartup: false,
  sidebarCollapsed: false,
  closeBehavior: '保留在托盘和任务栏中',
};
const SYSTEM_LANGUAGE_OPTIONS = ['简体中文', 'English'];
const SYSTEM_VIEW_OPTIONS = ['应用中心', '上次打开页面'];
const SYSTEM_CLOSE_OPTIONS = ['保留在托盘和任务栏中', '最小化到托盘', '直接退出应用'];

function normalizeSystemSettings(settings = {}) {
  const input = settings && typeof settings === 'object' ? settings : {};
  return {
    language: SYSTEM_LANGUAGE_OPTIONS.includes(input.language)
      ? input.language
      : DEFAULT_SYSTEM_SETTINGS.language,
    defaultView: SYSTEM_VIEW_OPTIONS.includes(input.defaultView)
      ? input.defaultView
      : DEFAULT_SYSTEM_SETTINGS.defaultView,
    openWindowOnLaunch: Object.prototype.hasOwnProperty.call(input, 'openWindowOnLaunch')
      ? Boolean(input.openWindowOnLaunch)
      : DEFAULT_SYSTEM_SETTINGS.openWindowOnLaunch,
    launchOnStartup: Object.prototype.hasOwnProperty.call(input, 'launchOnStartup')
      ? Boolean(input.launchOnStartup)
      : DEFAULT_SYSTEM_SETTINGS.launchOnStartup,
    sidebarCollapsed: Object.prototype.hasOwnProperty.call(input, 'sidebarCollapsed')
      ? Boolean(input.sidebarCollapsed)
      : DEFAULT_SYSTEM_SETTINGS.sidebarCollapsed,
    closeBehavior: SYSTEM_CLOSE_OPTIONS.includes(input.closeBehavior)
      ? input.closeBehavior
      : DEFAULT_SYSTEM_SETTINGS.closeBehavior,
  };
}
function systemSettingsPath() { return path.join(app.getPath('userData'), 'system-settings.json'); }
function readSystemSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(systemSettingsPath(), 'utf8'));
    const normalized = normalizeSystemSettings(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      fs.writeFileSync(systemSettingsPath(), JSON.stringify(normalized, null, 2), 'utf8');
    }
    return normalized;
  }
  catch { return normalizeSystemSettings(); }
}
function writeSystemSettings(settings = {}) {
  const next = normalizeSystemSettings(settings);
  // A development electron.exe without an app argument opens the Electron
  // welcome screen at login. Only the installed executable may register itself.
  if (!isDev) app.setLoginItemSettings({ openAtLogin: Boolean(next.launchOnStartup) });
  fs.mkdirSync(path.dirname(systemSettingsPath()), { recursive: true });
  fs.writeFileSync(systemSettingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function trayIconPath() {
  return [
    path.join(__dirname, '../dist/brand/seagrass-logo.ico'),
    path.join(__dirname, '../public/brand/seagrass-logo.ico'),
    path.join(__dirname, '../dist/brand/seagrass-logo.png'),
    path.join(__dirname, '../public/brand/seagrass-logo.png'),
    path.join(__dirname, '../src/assets/brand/seagrass-logo.png'),
  ].find((candidate) => fs.existsSync(candidate));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

const ASSISTANT_PANEL_SIZE = {
  width: 1080,
  height: 300,
  minWidth: 760,
  minHeight: 260,
};
const ASSISTANT_PANEL_GAP = 10;

function assistantPanelPath() {
  return path.join(__dirname, 'assistant-panel.html');
}

function assistantInitialBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const mainBounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(mainBounds);
  const workArea = display?.workArea || {
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
  };
  const width = Math.min(
    Math.max(ASSISTANT_PANEL_SIZE.minWidth, Math.min(ASSISTANT_PANEL_SIZE.width, mainBounds.width)),
    Math.max(ASSISTANT_PANEL_SIZE.minWidth, workArea.width - 24),
  );
  const height = Math.min(
    ASSISTANT_PANEL_SIZE.height,
    Math.max(ASSISTANT_PANEL_SIZE.minHeight, workArea.height - 24),
  );
  const minX = workArea.x + 12;
  const maxX = Math.max(minX, workArea.x + workArea.width - width - 12);
  const x = Math.max(minX, Math.min(mainBounds.x, maxX));
  const belowY = mainBounds.y + mainBounds.height + ASSISTANT_PANEL_GAP;
  const workBottom = workArea.y + workArea.height;
  const y = belowY + height <= workBottom - 12
    ? belowY
    : workBottom - height - 12;

  // This is used only when the panel is created for the first time. Once the
  // user drags the panel, its native window position is left untouched.
  return { x, y, width, height };
}

function assistantWindowIsCompletelyOffscreen(windowBounds) {
  if (!windowBounds) return true;
  return screen.getAllDisplays().every((display) => {
    const area = display.workArea;
    return windowBounds.x + windowBounds.width <= area.x
      || windowBounds.x >= area.x + area.width
      || windowBounds.y + windowBounds.height <= area.y
      || windowBounds.y >= area.y + area.height;
  });
}

function sendAssistantContext() {
  let safeContext = null;
  try {
    safeContext = assistantContext === null
      ? null
      : JSON.parse(JSON.stringify(assistantContext));
  } catch {
    safeContext = null;
  }
  const payload = {
    visible: inlineAssistantVisible,
    context: safeContext,
  };
  if (mainView && !mainView.webContents.isDestroyed()) {
    mainView.webContents.send('assistant:context', payload);
  }
  // 兼容已经存在的旧版独立面板实例；新启动的版本不会再创建它。
  if (assistantWindow && !assistantWindow.isDestroyed() && !assistantWindow.webContents.isLoading()) {
    assistantWindow.webContents.send('assistant:context', safeContext);
  }
}

function clearInlineAssistantTransitionTimer() {
  if (!inlineAssistantTransitionTimer) return;
  clearTimeout(inlineAssistantTransitionTimer);
  inlineAssistantTransitionTimer = null;
}

function detachActivePlatformForAssistantTransition() {
  if (!mainWindow || mainWindow.isDestroyed()) return '';
  const id = activePlatformViewId;
  const item = id && platformViews.get(id);
  if (!item || item.removing || !item.attached || !liveWebContents(item)) return '';
  if (!safeRemoveChildView(mainWindow.contentView, item.view, 'assistant-transition')) return '';
  item.attached = false;
  item.concealed = false;
  inlineAssistantDetachedPlatformId = id;
  platformRuntimeLog('assistant-platform-detached', { id });
  return id;
}

function restorePlatformAfterAssistantTransition(expectedId = inlineAssistantDetachedPlatformId) {
  if (!expectedId) return false;
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || mainWindow.isMinimized()
    || activePlatformViewId !== expectedId
  ) return false;
  const item = platformViews.get(expectedId);
  if (!item || item.removing || !liveWebContents(item)) return false;
  if (item.attached) safeRemoveChildView(mainWindow.contentView, item.view, 'assistant-restore-existing');
  if (!safeAddChildView(mainWindow.contentView, item.view, undefined, 'assistant-restore')) return false;
  item.attached = true;
  item.concealed = false;
  setPlatformViewBounds(item);
  inlineAssistantDetachedPlatformId = '';
  platformRuntimeLog('assistant-platform-restored', { id: expectedId });
  return true;
}

function ensureAssistantWindow() {
  if (assistantWindow && !assistantWindow.isDestroyed()) return assistantWindow;
  assistantWindow = new BrowserWindow({
    width: ASSISTANT_PANEL_SIZE.width,
    height: ASSISTANT_PANEL_SIZE.height,
    minWidth: ASSISTANT_PANEL_SIZE.minWidth,
    minHeight: ASSISTANT_PANEL_SIZE.minHeight,
    frame: false,
    // Native window/taskbar icon; the in-app brand remains the approved SVG.
    icon: trayIconPath(),
    resizable: true,
    show: false,
    // Keep it as a normal top-level desktop window. It must not inherit the
    // main window's layout or become an unmovable embedded panel.
    skipTaskbar: false,
    backgroundColor: '#f6f9fb',
    title: '海草跨境助手 · AI建议回复',
    webPreferences: {
      preload: path.join(__dirname, 'assistant-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  assistantWindow.setMenuBarVisibility(false);
  // It is a normal frameless utility window. Its header supplies the drag
  // region, while its controls opt out of dragging in assistant-panel.html.
  if (typeof assistantWindow.setMovable === 'function') assistantWindow.setMovable(true);
  assistantWindow.on('closed', () => {
    assistantWindow = undefined;
  });
  assistantWindow.webContents.on('did-finish-load', sendAssistantContext);
  void assistantWindow.loadFile(assistantPanelPath());
  return assistantWindow;
}

function showAssistantWindow() {
  if (!assistantContext || !mainWindow || mainWindow.isDestroyed()) return;
  cancelResizeBurst();
  if (!inlineAssistantVisible) {
    clearInlineAssistantTransitionTimer();
    const transition = ++inlineAssistantTransition;
    const wasMaximized = typeof mainWindow.isMaximized === 'function'
      && mainWindow.isMaximized();
    const collapsedBounds = wasMaximized
      && typeof mainWindow.getNormalBounds === 'function'
      ? mainWindow.getNormalBounds()
      : mainWindow.getBounds();
    inlineAssistantCollapsedBounds = { ...collapsedBounds };
    inlineAssistantRestoreMaximized = wasMaximized;

    // WhatsApp/LINE/Zalo/Telegram are native Chromium compositor surfaces.
    // Resizing the outer BaseWindow while one remains attached forces Windows
    // to synchronously re-raster the full platform page and the Vue shell. On
    // some GPUs that blocks the desktop for several seconds. Detaching a
    // WebContentsView preserves its DOM/session, so remove only its surface
    // during the native resize and put the exact same live view back afterward.
    const detachedPlatformId = detachActivePlatformForAssistantTransition();
    if (wasMaximized) mainWindow.unmaximize();
    inlineAssistantVisible = true;
    const startedAt = Date.now();
    mainWindow.setSize(
      collapsedBounds.width,
      collapsedBounds.height + INLINE_ASSISTANT_HEIGHT,
      false,
    );
    applyMainWindowViewLayout();
    // Mount the lightweight Vue panel only after the native resize has
    // completed, then restore the platform surface on the following frame.
    inlineAssistantTransitionTimer = setTimeout(() => {
      inlineAssistantTransitionTimer = null;
      if (
        transition !== inlineAssistantTransition
        || !inlineAssistantVisible
        || !mainWindow
        || mainWindow.isDestroyed()
      ) return;
      sendAssistantContext();
      inlineAssistantTransitionTimer = setTimeout(() => {
        inlineAssistantTransitionTimer = null;
        if (transition !== inlineAssistantTransition || !inlineAssistantVisible) return;
        restorePlatformAfterAssistantTransition(detachedPlatformId);
        inlineAssistantTogglePending = false;
        platformRuntimeLog('assistant-inline-opened', {
          elapsedMs: Date.now() - startedAt,
          width: collapsedBounds.width,
          height: collapsedBounds.height + INLINE_ASSISTANT_HEIGHT,
        });
      }, 34);
    }, 34);
    return;
  }
  inlineAssistantTogglePending = false;
  sendAssistantContext();
}

async function updateAssistantWindowContext(item) {
  return updateAssistantWindowContextWithPayload(item, {});
}

function normalizeAssistantContextMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(message => ['incoming', 'outgoing'].includes(message?.direction)).slice(-50).map((message) => {
    const direction = message?.direction === 'incoming' ? 'incoming' : 'outgoing';
    const originalText = String(message?.original_text || message?.text || '').trim().slice(0, 20_000);
    const imageCount = Math.min(4, Math.max(0, Number(message?.image_count) || 0));
    if (!originalText && !imageCount) return null;
    const translatedText = String(message?.translated_text || message?.translation || '').trim().slice(0, 20_000);
    return {
      direction,
      original_text: originalText,
      image_count: imageCount,
      translated_text: translatedText || null,
      message_at: message?.message_at || null,
    };
  }).filter(Boolean);
}

function assistantMessagesOverlap(left, right) {
  if (!left || !right || left.direction !== right.direction) return false;
  const leftTexts = [left.original_text, left.translated_text]
    .map((value) => String(value || '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase())
    .filter(Boolean);
  const rightTexts = new Set(
    [right.original_text, right.translated_text]
      .map((value) => String(value || '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase())
      .filter(Boolean),
  );
  return leftTexts.some((text) => rightTexts.has(text));
}

function mergeAssistantContextMessages(archivedMessages, liveMessages) {
  if (!liveMessages.length) return archivedMessages.slice(-50);
  const older = archivedMessages.filter(
    (archived) => !liveMessages.some((live) => assistantMessagesOverlap(archived, live)),
  );
  // Live DOM messages are appended last and retain WhatsApp's visual order;
  // this makes the final item authoritative even when old archive timestamps
  // were captured in one identical batch.
  return [...older, ...liveMessages].slice(-50);
}

async function updateAssistantWindowContextWithPayload(item, payload = {}) {
  if (!item) return;
  const record = platformWindowRegistry.get(item.id);
  const workspaceId = record?.workspaceId || item.workspaceId || '';
  if (!isActiveWorkspace(workspaceId)) return;
  const platformContactId = String(payload.platformContactId || '').trim();
  const liveMessages = normalizeAssistantContextMessages(payload.messages);
  const serializedMessages = liveMessages;
  const contextIdentity = `${item.id}:${platformContactId}`;
  const windowDisplayName = platformDisplayName(record || item);
  // Use cached metadata immediately. Model discovery and a possible cloud
  // history refresh are deliberately kept off the click-to-open path.
  const aiModel = assistantAiModelCache || fallbackAssistantAiModels()[0];
  assistantContext = {
    platform: item.platform,
    platformWindowId: item.id,
    workspaceId,
    account: windowDisplayName,
    windowTitle: windowDisplayName,
    platformContactId,
    customerName: String(payload.customerName || '当前客户'),
    customerLanguage: String(payload.customerLanguage || 'auto'),
    outputLanguage: String(payload.outputLanguage || 'auto'),
    translationProvider: String(
      payload.translationProvider
        || item.translationSettings?.provider
        || 'deepseek',
    ).trim().toLowerCase(),
    translationLanguage: 'zh',
    languageLabels: Object.fromEntries(
      translationLanguages.map((language) => [language.code, language.name]),
    ),
    aiModel,
    messages: serializedMessages,
  };
  assistantLiveMessageBatch = liveMessages.length ? {
    identity: contextIdentity,
    scanId: 'inline-toggle',
    indexedMessages: new Map(liveMessages.map((message, index) => [index, message])),
  } : null;
  platformRuntimeLog('assistant-context-ready', {
    platformWindowId: item.id,
    platformContactId,
    messageCount: serializedMessages.length,
  });

  void (async () => {

    const resolvedModel = await getAssistantAiModel();
    const activeIdentity = assistantContext
      ? `${assistantContext.platformWindowId}:${assistantContext.platformContactId || ''}`
      : '';
    if (activeIdentity !== contextIdentity) return;
    assistantContext.aiModel = resolvedModel;

    if (inlineAssistantVisible) sendAssistantContext();
  })().catch((error) => {
    platformRuntimeLog('assistant-context-background-refresh-failed', {
      platformWindowId: item.id,
      message: error?.message || String(error),
    });
  });
}

function refreshAssistantContextFromCapturedMessage(item, payload = {}) {
  if (!assistantContext || assistantContext.platformWindowId !== item?.id) return;
  if (!isActiveWorkspace(assistantContext.workspaceId)) return;
  const contactId = String(payload.platform_contact_id || '').trim();
  if (!contactId || (assistantContext.platformContactId && assistantContext.platformContactId !== contactId)) return;
  const identity = `${item.id}:${contactId}`;
  const scanId = String(payload.dom_scan_id || '').trim();
  const domIndex = payload.dom_index;
  const domOrderAuthoritative = payload.dom_order_authoritative !== false;
  const normalizedCaptured = normalizeAssistantContextMessages([payload])[0] || null;
  if (scanId && Number.isInteger(domIndex) && domOrderAuthoritative && normalizedCaptured) {
    if (
      !assistantLiveMessageBatch
      || assistantLiveMessageBatch.identity !== identity
      || assistantLiveMessageBatch.scanId !== scanId
    ) {
      assistantLiveMessageBatch = {
        identity,
        scanId,
        indexedMessages: new Map(),
      };
    }
    assistantLiveMessageBatch.indexedMessages.set(domIndex, normalizedCaptured);
  } else if (!domOrderAuthoritative) {
    // The user is reading an older virtualised segment. Do not append those
    // mounted bubbles as though they were the newest turn.
    assistantLiveMessageBatch = null;
  }

  if (assistantContextRefreshTimer) clearTimeout(assistantContextRefreshTimer);
  assistantContextRefreshTimer = setTimeout(() => {
    assistantContextRefreshTimer = null;
    const activeIdentity = assistantContext
      ? `${assistantContext.platformWindowId}:${assistantContext.platformContactId || ''}`
      : '';
    if (activeIdentity !== identity) return;
    const liveMessages = assistantLiveMessageBatch?.identity === identity
      ? [...assistantLiveMessageBatch.indexedMessages.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, message]) => message)
      : [];
    if (liveMessages.length) assistantContext.messages = mergeAssistantContextMessages(assistantContext.messages, liveMessages);
    if (inlineAssistantVisible || (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible())) {
      sendAssistantContext();
    }
  }, 90);
}

function hideAssistantWindow({ clearContext = true } = {}) {
  if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.hide();
  cancelResizeBurst();
  clearInlineAssistantTransitionTimer();
  const hasInlineAssistantTransition = inlineAssistantVisible
    || Boolean(inlineAssistantCollapsedBounds)
    || Boolean(inlineAssistantDetachedPlatformId);
  if (!hasInlineAssistantTransition) {
    inlineAssistantTogglePending = false;
    if (clearContext) {
      assistantContext = null;
      assistantLiveMessageBatch = null;
      if (assistantContextRefreshTimer) clearTimeout(assistantContextRefreshTimer);
      assistantContextRefreshTimer = null;
    }
    sendAssistantContext();
    return;
  }
  inlineAssistantTogglePending = true;
  const transition = ++inlineAssistantTransition;
  const collapsedBounds = inlineAssistantCollapsedBounds;
  const shouldRestoreMaximized = inlineAssistantRestoreMaximized;
  const detachedPlatformId = detachActivePlatformForAssistantTransition()
    || inlineAssistantDetachedPlatformId;
  inlineAssistantVisible = false;
  inlineAssistantCollapsedBounds = null;
  inlineAssistantRestoreMaximized = false;
  // Unmount the Vue panel before shrinking the native window. This keeps the
  // renderer work small and also prevents a stale panel from flashing over the
  // platform view when users click AI repeatedly.
  sendAssistantContext();
  if (mainWindow && !mainWindow.isDestroyed() && collapsedBounds) {
    if (mainWindow.isMinimized()) {
      inlineAssistantPendingRestoreBounds = collapsedBounds;
      inlineAssistantPendingRestoreMaximized = shouldRestoreMaximized;
    } else {
      mainWindow.setSize(collapsedBounds.width, collapsedBounds.height, false);
      mainWindow.setPosition(collapsedBounds.x, collapsedBounds.y, false);
      if (shouldRestoreMaximized) mainWindow.maximize();
    }
  }
  if (clearContext) {
    assistantContext = null;
    assistantLiveMessageBatch = null;
    if (assistantContextRefreshTimer) clearTimeout(assistantContextRefreshTimer);
    assistantContextRefreshTimer = null;
  }
  applyMainWindowViewLayout();
  inlineAssistantTransitionTimer = setTimeout(() => {
    inlineAssistantTransitionTimer = null;
    if (transition !== inlineAssistantTransition || inlineAssistantVisible) return;
    restorePlatformAfterAssistantTransition(detachedPlatformId);
    inlineAssistantTogglePending = false;
  }, shouldRestoreMaximized ? 80 : 34);
}

function ensureTray() {
  if (tray) return;
  const iconPath = trayIconPath();
  if (!iconPath) return;
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('海草跨境助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示海草跨境助手', click: showMainWindow },
    { type: 'separator' },
    { label: '退出应用', click: () => app.quit() },
  ]));
  tray.on('click', showMainWindow);
}

function customerRegistryPath() {
  return path.join(app.getPath('userData'), 'chat-marks.json');
}

function normalizedCustomerIdentityPart(value) {
  return String(value || '').trim().toLowerCase();
}
function customerIdentityKey(customer) { return [customer.platform, customer.platform_window_id, customer.platform_contact_id].map(normalizedCustomerIdentityPart).join('|'); }
function mergeLocalCustomers(primary, secondary) {
 const preferred = String(primary.updated_at) >= String(secondary.updated_at) ? primary : secondary;
 return normalizeLocalCustomer({ ...preferred, tags: [...new Set([...(primary.tags || []), ...(secondary.tags || [])])] }, preferred);
}

function dedupeLocalCustomerRegistry() {
  const byIdentity = new Map();
  let changed = false;
  for (const customer of [...customerRegistry.values()]) {
    const identity = customerIdentityKey(customer);
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, customer);
      continue;
    }
    const merged = mergeLocalCustomers(previous, customer);
    customerRegistry.delete(previous.id);
    customerRegistry.delete(customer.id);
    customerRegistry.set(merged.id, merged);
    byIdentity.set(identity, merged);
    changed = true;
  }
  if (changed) persistCustomerRegistry();
  return changed;
}

function loadCustomerRegistry() {
  try {
    const customers = JSON.parse(fs.readFileSync(customerRegistryPath(), 'utf8'));
    if (!Array.isArray(customers)) return;
    for (const customer of customers) {
      if (customer?.id && customer?.platform_window_id && customer?.platform_contact_id) {
        customerRegistry.set(customer.id, normalizeLocalCustomer(customer, customer));
      }
    }
    dedupeLocalCustomerRegistry();
  } catch {
    // The local-first customer store is created on the first saved customer.
  }
}

function persistCustomerRegistry() {
  const filePath = customerRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify([...customerRegistry.values()], null, 2), 'utf8');
}
function findLocalCustomerByIdentity(customer) {
 if (!isActiveWorkspace(customer.workspace_id || activeWorkspaceScope)) return null;
 return [...customerRegistry.values()].find(item => isActiveScopedRecord(item) && customerIdentityKey(item) === customerIdentityKey(customer)) || null;
}

function cleanCustomerTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || '').trim().slice(0, 60))
    .filter(Boolean))].slice(0, 30);
}

const customerTranslationBooleanKeys = new Set([
  'sendTranslationOverride',
  'messageTranslationOverride',
  'skipChineseMessagesOverride',
]);

const customerTranslationStringKeys = new Set([
  'preferredLanguage',
  'preferredProvider',
  'inputLanguageOverride',
  'sendLanguageOverride',
  'sourceLanguageOverride',
  'targetLanguageOverride',
  'groupTranslationOverride',
  'fontColorOverride',
  'fontSizeOverride',
]);

function cleanCustomerTranslationSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  const cleaned = {};
  for (const [key, value] of Object.entries(settings)) {
    if (customerTranslationBooleanKeys.has(key) && typeof value === 'boolean') {
      cleaned[key] = value;
      continue;
    }
    if (customerTranslationStringKeys.has(key) && typeof value === 'string') {
      const normalized = value.trim().slice(0, 64);
      if (normalized) cleaned[key] = normalized;
    }
  }
  return cleaned;
}
function normalizeLocalCustomer(payload, existing = null) {
 const stages = new Set(['new','intent','following','won','invalid']);
 return {
   id: existing?.id || 'mark_' + crypto.randomUUID(),
   workspace_id: 'local', owner_user_id: 'local',
   platform: payload.platform || existing?.platform,
   platform_window_id: payload.platform_window_id || existing?.platform_window_id,
   platform_contact_id: payload.platform_contact_id || existing?.platform_contact_id,
   display_name: String(payload.display_name || existing?.display_name || '联系人').trim().slice(0,320),
   stage: stages.has(payload.stage) ? payload.stage : (existing?.stage || 'new'),
   tags: payload.tags === undefined ? (existing?.tags || []) : cleanCustomerTags(payload.tags),
   preferred_language: payload.preferred_language === undefined ? (existing?.preferred_language ?? null) : payload.preferred_language,
   preferred_provider: 'deepseek', preferred_route: null,
   translation_settings: cleanCustomerTranslationSettings(payload.translation_settings ?? existing?.translation_settings),
   updated_at: new Date().toISOString()
 };
}

function notifyCustomerChanged(customer) {
  if (mainView?.webContents && !mainView.webContents.isDestroyed()) {
    mainView.webContents.send('customer:changed', customer);
  }
  for (const item of platformViews.values()) {
    if (item.id !== customer?.platform_window_id) continue;
    if (!item.view?.webContents || item.view.webContents.isDestroyed()) continue;
    item.view.webContents.send('customer:changed', customer);
  }
}

function saveLocalCustomer(payload) {
  const workspaceId = String(payload.workspace_id || activeWorkspaceScope || '').trim();
  if (!isActiveWorkspace(workspaceId)) throw new Error('workspace_scope_required');
  const existingById = payload.id
    ? customerRegistry.get(payload.id)
      && isActiveScopedRecord(customerRegistry.get(payload.id))
      ? customerRegistry.get(payload.id)
      : null
    : null;
  const existingByIdentity = findLocalCustomerByIdentity({ ...payload, workspace_id: workspaceId });
  const existing = existingById || existingByIdentity;
  let customer = normalizeLocalCustomer({ ...payload, workspace_id: workspaceId }, existing);
  if (existingByIdentity && existingByIdentity.id !== customer.id) {
    customer = mergeLocalCustomers(customer, existingByIdentity);
  }
  if (existingById && existingById.id !== customer.id) {
    customer = mergeLocalCustomers(customer, existingById);
  }
  for (const candidate of [existingById, existingByIdentity]) {
    if (candidate?.id && candidate.id !== customer.id) customerRegistry.delete(candidate.id);
  }
  customerRegistry.set(customer.id, normalizeLocalCustomer(customer, customer));
  dedupeLocalCustomerRegistry();
  persistCustomerRegistry();
  notifyCustomerChanged(customer);
  return customer;
}

function platformRuntimeLog(event, details = {}) {
  try {
    const logPath = path.join(app.getPath('userData'), 'platform-runtime.log');
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 512 * 1024) {
      fs.writeFileSync(logPath, '', 'utf8');
    }
    const entry = JSON.stringify({ time: new Date().toISOString(), event, ...details });
    fs.appendFileSync(logPath, `${entry}\n`, 'utf8');
  } catch {
    // Diagnostics must never interrupt the platform window.
  }
}

function loadTranslationCache() {
  try {
    const data = JSON.parse(fs.readFileSync(translationCachePath(), 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [key, value] of Object.entries(data)) {
        if (value?.text) translationCache.set(key, value);
      }
    }
  } catch {
    // The cache is optional on first launch.
  }
}

function persistTranslationCache() {
  const filePath = translationCachePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const entries = [...translationCache.entries()].slice(-2000);
  fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8');
}

function getTranslationCacheKey(event, payload) {
  const platformWindow = [...platformViews.values()].find(
    (item) => item.view.webContents.id === event.sender.id,
  );
  const scope = platformWindow
    ? `${platformWindow.platform}:${platformWindow.id}`
    : 'desktop';
  const source = payload.sourceLanguage || 'auto';
  const target = payload.targetLanguage || 'zh';
  const provider = payload.provider || 'deepseek';
  const messageId = payload.messageId || payload.text;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([scope, messageId, payload.text, source, target, provider]))
    .digest('hex');
}

function languageFamily(language) {
  const value = String(language || '').trim().toLowerCase().replaceAll('_', '-');
  if (!value || value === 'auto') return '';
  if (value === 'cht' || value.startsWith('zh')) return 'zh';
  if (value.startsWith('en')) return 'en';
  if (value.startsWith('pt')) return 'pt';
  return value.split('-', 1)[0];
}

function sameTranslationLanguage(sourceLanguage, targetLanguage) {
  const source = languageFamily(sourceLanguage);
  const target = languageFamily(targetLanguage);
  return Boolean(source && target && source === target);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TRANSLATION_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

let assistantAiModelCache = null;
let assistantAiModelsCache = null;
let assistantAiModelFetchedAt = 0;
let assistantSelectedModelCode = '';
function fallbackAssistantAiModels() { const model = localProvider.metadata().model; return [{ code: 'deepseek', provider: 'deepseek', display_name: 'DeepSeek V4.1 Flash', model_name: model, enabled: true, is_default: true }]; }
async function getAssistantAiModels() { return fallbackAssistantAiModels(); }

async function getAssistantAiModel(preferredCode = '') {
  const models = await getAssistantAiModels();
  const requested = String(preferredCode || '').trim();
  assistantAiModelCache = models.find((item) => item?.code === requested)
    || models.find((item) => item?.code === assistantSelectedModelCode)
    || models.find((item) => item?.is_default)
    || models[0]
    || fallbackAssistantAiModels()[0];
  return assistantAiModelCache;
}

function platformItemForSender(sender) {
  return [...platformViews.values()].find((item) => (
    item.view.webContents.id === sender.id && isActiveScopedRecord(item)
  ));
}

function loadPlatformWindowRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(platformRegistryPath(), 'utf8'));
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item?.id && PLATFORM_URLS[item.platform]) {
          platformWindowRegistry.set(item.id, normalizePlatformDisplayRecord(item));
        }
      }
    }
  } catch {
    // 首次运行没有注册表时使用空列表。
  }
}

function persistPlatformWindowRegistry() {
  const filePath = platformRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify([...platformWindowRegistry.values()], null, 2), 'utf8');
}

function upsertPlatformWindow(config) {
  if (!isActiveWorkspace(config.workspaceId)) throw new Error('workspace_scope_required');
  const previous = platformWindowRegistry.get(config.id);
  const sameWorkspace = previous?.workspaceId === config.workspaceId;
  const profile = ensurePlatformProfile(config);
  const hasExplicitMode = Object.prototype.hasOwnProperty.call(config, 'mode');
  const mode = hasExplicitMode
    ? (config.mode === 'proxy' ? 'proxy' : 'direct')
    : normalizePlatformDisplayRecord(previous || config).mode;
  const proxy = runtimeProxy(config.proxy || (sameWorkspace && mode === 'proxy' ? previous?.proxy : undefined));
  const storedPassword = config.proxy?.passwordEncrypted || previous?.proxy?.passwordEncrypted || '';
  const record = {
    id: config.id,
    profileId: profile.id,
    title: config.title || config.account || config.id,
    platform: config.platform,
    account: config.account || config.title || config.id,
    accountId: config.accountId || profile.accountKey,
    workspaceId: config.workspaceId,
    ownerUserId: config.ownerUserId || (sameWorkspace ? previous?.ownerUserId : null),
    ownerMemberId: config.ownerMemberId || (sameWorkspace ? previous?.ownerMemberId : null),
    mode,
    proxyId: Object.prototype.hasOwnProperty.call(config, 'proxyId')
      ? config.proxyId
      : (profile.proxyBinding.proxyId || (sameWorkspace ? previous?.proxyId : null)),
    profileConsistency: profile.consistency,
    profileScope: profile.profileScope,
    profileBinding: {
      mode: profile.proxyBinding.mode,
      proxyId: profile.proxyBinding.proxyId,
      type: profile.proxyBinding.type,
      host: profile.proxyBinding.host,
      port: profile.proxyBinding.port,
    },
    profileIsolation: profile.isolation,
    translationSettings: config.translationSettings || (sameWorkspace ? previous?.translationSettings : undefined),
    // 代理密码不写入注册表，后续接入系统安全存储。
    proxy: mode === 'proxy' && proxy ? {
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || '',
      passwordEncrypted: proxy.password
        ? (encryptProxyPassword(proxy.password) || storedPassword)
        : storedPassword,
    } : undefined,
    cloudSynced: previous?.cloudSynced === true,
    cloudUpdatedAt: previous?.cloudUpdatedAt || null,
  };
  platformWindowRegistry.set(record.id, record);
  persistPlatformWindowRegistry();
  return record;
}

function getPlatformBounds() {
  if (!mainWindow) return { x: 0, y: 0, width: 0, height: 0 };
  const [width, height] = mainWindow.getContentSize();
  const assistantHeight = inlineAssistantVisible ? INLINE_ASSISTANT_HEIGHT : 0;
  return {
    x: PLATFORM_CONTENT_OFFSET.x,
    y: PLATFORM_CONTENT_OFFSET.y,
    width: Math.max(0, width - PLATFORM_CONTENT_OFFSET.x),
    height: Math.max(240, height - PLATFORM_CONTENT_OFFSET.y - assistantHeight),
  };
}

function sameBounds(left, right) {
  return left
    && right
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

// WebContentsView objects may be destroyed asynchronously while an IPC call,
// timer, or native window event is still running. Keep lifecycle operations
// behind these guards so stale callbacks cannot crash the main process.
function liveWebContents(source) {
  try {
    const webContents = source?.view?.webContents || source?.webContents;
    if (!webContents || typeof webContents.isDestroyed !== 'function' || webContents.isDestroyed()) return null;
    return webContents;
  } catch {
    return null;
  }
}

function safeRemoveChildView(contentView, view, reason = 'unknown') {
  if (!contentView || !view) return false;
  try {
    contentView.removeChildView(view);
    return true;
  } catch (error) {
    platformRuntimeLog('view-remove-error', {
      reason,
      message: error?.message || String(error),
    });
    return false;
  }
}

function safeAddChildView(contentView, view, index, reason = 'unknown') {
  if (!contentView || !view) return false;
  try {
    if (typeof index === 'number') contentView.addChildView(view, index);
    else contentView.addChildView(view);
    return true;
  } catch (error) {
    platformRuntimeLog('view-add-error', {
      reason,
      message: error?.message || String(error),
    });
    return false;
  }
}

function safeWebContentsUrl(source) {
  const webContents = liveWebContents(source);
  if (!webContents) return '';
  try {
    return webContents.getURL();
  } catch {
    return '';
  }
}

function setViewBoundsIfChanged(view, bounds) {
  if (!view || typeof view.setBounds !== 'function' || !liveWebContents(view)) return false;
  try {
    const current = typeof view.getBounds === 'function' ? view.getBounds() : null;
    if (sameBounds(current, bounds)) return false;
    view.setBounds(bounds);
    return true;
  } catch (error) {
    platformRuntimeLog('view-bounds-error', {
      message: error?.message || String(error),
    });
    return false;
  }
}

function setPlatformViewBounds(item) {
  if (item?.concealed) return false;
  return setViewBoundsIfChanged(item?.view, getPlatformBounds());
}

function applyMainWindowViewLayout() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainView) return;
  const [width, height] = mainWindow.getContentSize();
  setViewBoundsIfChanged(mainView, { x: 0, y: 0, width, height });
  // During a continuous resize burst the platform view is detached to avoid
  // per-tick re-rasterization. Only update its bounds when the burst is over.
  if (resizeBurstActive) return;
  const active = (activePlatformViewId && platformViews.get(activePlatformViewId))
    || [...platformViews.values()].find((item) => item.attached);
  if (active?.attached) setPlatformViewBounds(active);
}

function restoreMainViewSurface(reason = 'unknown') {
  if (!mainWindow || mainWindow.isDestroyed() || !mainView || !liveWebContents(mainView)) return;
  const activeId = activePlatformViewId;
  const active = activeId ? platformViews.get(activeId) : null;
  try {
    // On Windows the WebContentsView compositor surface can disappear even
    // though its DOM is fully loaded. Re-attaching the main view at index 0
    // recreates that native surface without reloading Vue or clearing state.
    safeRemoveChildView(mainWindow.contentView, mainView, `main-restore:${reason}`);
    if (!safeAddChildView(mainWindow.contentView, mainView, 0, `main-restore:${reason}`)) return;
  } catch (error) {
    platformRuntimeLog('main-view-restore-error', {
      reason,
      message: error?.message || String(error),
    });
  }
  applyMainWindowViewLayout();
  if (active && !active.removing && !active.concealed && liveWebContents(active)) showPlatformView(activeId);
  platformRuntimeLog('main-view-restored', { reason, activePlatformViewId: activeId || '' });
}

function cancelResizeBurst() {
  if (resizeBurstSettleTimer) {
    clearTimeout(resizeBurstSettleTimer);
    resizeBurstSettleTimer = null;
  }
  if (!resizeBurstActive) return;
  const id = resizeBurstDetachedPlatformId;
  resizeBurstDetachedPlatformId = '';
  resizeBurstActive = false;
  if (!id) return;
  const item = platformViews.get(id);
  if (!item || item.removing || !liveWebContents(item)) return;
  if (activePlatformViewId !== id) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  if (item.attached || item.concealed) return;
  if (!safeAddChildView(mainWindow.contentView, item.view, undefined, 'resize-burst-cancel')) return;
  item.attached = true;
  item.concealed = false;
  setPlatformViewBounds(item);
  platformRuntimeLog('resize-burst-cancelled', { id });
}

function flagResizeBurst() {
  // Don't interfere with assistant open/close transitions.
  if (inlineAssistantDetachedPlatformId) return;
  const activeId = activePlatformViewId;
  const item = activeId && platformViews.get(activeId);
  if (!item || item.removing || !item.attached || !liveWebContents(item)) return;

  if (!resizeBurstActive) {
    // Start of a continuous resize burst — detach the heavy platform view so
    // Chromium does not re-raster WhatsApp/LINE/Zalo/Telegram on every tick.
    resizeBurstActive = true;
    resizeBurstDetachedPlatformId = activeId;
    if (mainWindow && !mainWindow.isDestroyed()) {
      safeRemoveChildView(mainWindow.contentView, item.view, 'resize-burst-detach');
    }
    item.attached = false;
    platformRuntimeLog('resize-burst-detach', { id: activeId });
  }

  // (Re)schedule the settle timer — if no new resize arrives within the window
  // the burst is over and we restore the platform view at its final bounds.
  if (resizeBurstSettleTimer) clearTimeout(resizeBurstSettleTimer);
  resizeBurstSettleTimer = setTimeout(() => {
    resizeBurstSettleTimer = null;
    const id = resizeBurstDetachedPlatformId;
    resizeBurstDetachedPlatformId = '';
    resizeBurstActive = false;
    if (!id) return;
    const restoreItem = platformViews.get(id);
    if (!restoreItem || restoreItem.removing || !liveWebContents(restoreItem)) return;
    if (activePlatformViewId !== id) return;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    if (restoreItem.attached || restoreItem.concealed) return;
    if (!safeAddChildView(mainWindow.contentView, restoreItem.view, undefined, 'resize-burst-restore')) return;
    restoreItem.attached = true;
    restoreItem.concealed = false;
    setPlatformViewBounds(restoreItem);
    platformRuntimeLog('resize-burst-restore', { id });
  }, RESIZE_BURST_SETTLE_MS);
}

function scheduleMainWindowViewLayout() {
  if (mainWindowLayoutTimer) return;
  // Coalesce the burst of native resize notifications into one compositor
  // update. This also makes manual window resizing noticeably smoother.
  mainWindowLayoutTimer = setTimeout(() => {
    mainWindowLayoutTimer = null;
    applyMainWindowViewLayout();
  }, 16);
  // Detect continuous resize (window dragging) and detach the heavy platform
  // view for the duration to prevent per-tick re-rasterization.
  flagResizeBurst();
}

function sendPlatformTranslationSettings(item) {
  const webContents = liveWebContents(item);
  if (!item?.translationSettings || item.removing || !webContents) return;
  try {
    webContents.send('platform:settings', {
    ...item.translationSettings,
    workspaceId: item.workspaceId || activeWorkspaceScope || '',
    ownerMemberId: item.ownerMemberId || '',
    profileId: item.profileId,
    profileConsistency: item.profileConsistency || 'stable',
    languageCatalog: translationLanguages,
    });
  } catch (error) {
    platformRuntimeLog('platform-settings-send-error', { id: item.id, message: error?.message || String(error) });
    return;
  }
  platformRuntimeLog('platform-settings-sent', {
    id: item.id,
    provider: item.translationSettings.provider,
    messageTranslation: Boolean(item.translationSettings.messageTranslation),
    sendTranslation: Boolean(item.translationSettings.sendTranslation),
  });
}

const PLATFORM_NETWORK_LOOKUP_URL = 'https://ipwho.is/?lang=zh';
const PLATFORM_NETWORK_LOOKUP_TIMEOUT_MS = 8_000;
const PLATFORM_NETWORK_INFO_TTL_MS = 10 * 60 * 1000;

function sendPlatformNetworkInfo(item) {
  const webContents = liveWebContents(item);
  if (!item || item.removing || !webContents) return;
  try {
    webContents.send('platform:network-info', item.networkInfo || {
      state: 'loading',
      ip: '',
      location: '',
    });
  } catch {
    // The platform renderer may be between navigations. did-finish-load sends
    // the latest value again, so a missed update here is harmless.
  }
}

function platformNetworkKey(config = {}) {
  const proxy = config.proxy;
  if (!proxy?.host || !proxy?.port) return 'direct';
  return [
    normalizeProxyType(proxy.type),
    normalizeProxyHost(proxy.host),
    String(proxy.port),
    String(proxy.username || ''),
  ].join('|');
}

function networkLocationFromLookup(payload = {}) {
  let country = String(payload.country || '').trim();
  const countryCode = String(payload.country_code || '').trim().toUpperCase();
  if (countryCode) {
    try {
      country = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(countryCode) || country;
    } catch {
      // Fall back to the lookup service's country label on older runtimes.
    }
  }
  return [country, payload.region, payload.city]
    .map((part) => String(part || '').trim())
    .filter((part, index, all) => part && all.indexOf(part) === index)
    .join(' · ');
}

async function refreshPlatformNetworkInfo(item, config = {}) {
  if (!item || item.removing || !liveWebContents(item)) return;
  const key = platformNetworkKey(config);
  const now = Date.now();
  if (
    item.networkInfoKey === key
    && item.networkInfo?.state === 'ready'
    && now - Number(item.networkInfo.checkedAt || 0) < PLATFORM_NETWORK_INFO_TTL_MS
  ) {
    sendPlatformNetworkInfo(item);
    return;
  }
  if (item.networkInfoPromise && item.networkInfoKey === key) return item.networkInfoPromise;

  item.networkInfoKey = key;
  item.networkInfoRequestId = Number(item.networkInfoRequestId || 0) + 1;
  const requestId = item.networkInfoRequestId;
  item.networkInfo = { state: 'loading', ip: '', location: '', checkedAt: now };
  sendPlatformNetworkInfo(item);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLATFORM_NETWORK_LOOKUP_TIMEOUT_MS);
  item.networkInfoPromise = (async () => {
    try {
      // session.fetch uses this platform window's own proxy configuration, so
      // the returned address is the real exit IP seen by WhatsApp.
      const response = await item.session.fetch(PLATFORM_NETWORK_LOOKUP_URL, {
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'User-Agent': 'SeagrassNetworkInfo/1.0' },
      });
      if (!response.ok) throw new Error(`network_lookup_${response.status}`);
      const payload = await response.json();
      if (payload?.success === false || !payload?.ip) throw new Error('network_lookup_invalid');
      if (item.removing || item.networkInfoRequestId !== requestId) return;
      item.networkInfo = {
        state: 'ready',
        ip: String(payload.ip),
        location: networkLocationFromLookup(payload),
        checkedAt: Date.now(),
      };
      sendPlatformNetworkInfo(item);
    } catch (error) {
      if (item.removing || item.networkInfoRequestId !== requestId) return;
      item.networkInfo = {
        state: 'error',
        ip: '',
        location: '',
        checkedAt: Date.now(),
      };
      sendPlatformNetworkInfo(item);
      platformRuntimeLog('platform-network-info-failed', {
        id: item.id,
        mode: key === 'direct' ? 'direct' : 'proxy',
        message: error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error)),
      });
    } finally {
      clearTimeout(timeout);
      if (item.networkInfoRequestId === requestId) item.networkInfoPromise = null;
    }
  })();
  return item.networkInfoPromise;
}

function normalizeProxyType(type = '') {
  return type.toLowerCase().includes('socks') ? 'socks5' : 'http';
}

function normalizeProxyHost(host = '') {
  const value = String(host).trim();
  if (!value) return '';
  if (value.startsWith('[') && value.endsWith(']')) return value;
  return value.includes(':') ? `[${value}]` : value;
}

function proxyUpstreamProtocol(type = '') {
  const value = String(type).toLowerCase();
  if (value.includes('socks')) return 'socks5';
  return value === 'https' ? 'https' : 'http';
}

function socksProxyUrl(proxy) {
  const host = normalizeProxyHost(proxy.host);
  const username = encodeURIComponent(String(proxy.username || ''));
  const password = encodeURIComponent(String(proxy.password || ''));
  const credentials = username || password ? `${username}:${password}@` : '';
  return `socks5h://${credentials}${host}:${proxy.port}`;
}

async function closeSocksHttpBridge(item) {
  const bridge = item?.proxyBridge;
  if (!bridge) return;
  item.proxyBridge = null;
  item.proxyBridgeKey = '';
  if (bridge.process && !bridge.process.killed) bridge.process.kill();
  bridge.agent?.destroy();
  for (const socket of bridge.sockets || []) socket.destroy();
  if (!bridge.server?.listening) return;
  await new Promise((resolve) => bridge.server.close(() => resolve()));
}

function targetForConnect(value = '') {
  const target = String(value).trim();
  const match = target.match(/^\[([^\]]+)\]:(\d+)$/u)
    || target.match(/^([^:]+):(\d+)$/u);
  if (!match) return null;
  return { host: match[1], port: Number(match[2]) };
}

async function ensureSocksHttpBridge(item, proxy) {
  const bridgeKey = `${proxy.type}|${proxy.host}|${proxy.port}|${proxy.username || ''}`;
  const bridgeAlive = item.proxyBridge?.server?.listening;
  if (item.proxyBridge && item.proxyBridgeKey === bridgeKey && bridgeAlive) {
    return { port: item.proxyBridge.port };
  }
  await closeSocksHttpBridge(item);

  // 内联本地桥：在主进程内创建 HTTP CONNECT 服务器，把 HTTPS 隧道转发到
  // 上游 SOCKS5 代理。不再 spawn 独立子进程（asar/ELECTRON_RUN_AS_NODE 在
  // 打包环境下有兼容问题，会导致桥静默失败、窗口打不开）。
  const proxyUrl = socksProxyUrl(proxy);
  const agent = new SocksProxyAgent(proxyUrl, { timeout: 20_000 });
  const server = http.createServer((_request, response) => {
    response.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Only HTTPS CONNECT is supported by this local bridge.');
  });
  server.on('connect', (request, clientSocket, head) => {
    const target = targetForConnect(request.url);
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    agent.connect({ destroy() {} }, {
      host: target.host,
      port: target.port,
      secureEndpoint: false,
    }).then((socket) => {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clientSocket.destroy();
        socket.destroy();
      };
      clientSocket.once('error', close);
      socket.once('error', close);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) socket.write(head);
      clientSocket.pipe(socket);
      socket.pipe(clientSocket);
      clientSocket.once('close', close);
      socket.once('close', close);
    }).catch((error) => {
      platformRuntimeLog('socks-bridge-connect-failed', {
        id: item.id,
        error: String(error?.message || error),
      });
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  });
  server.on('clientError', (error, socket) => {
    platformRuntimeLog('socks-bridge-http-error', {
      id: item.id,
      error: String(error?.message || error),
    });
    socket.destroy();
  });

  let port = 0;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = server.address().port;
  } catch (error) {
    agent.destroy();
    throw new Error(`SOCKS bridge failed to listen: ${String(error?.message || error)}`);
  }
  item.proxyBridge = { server, agent, port, sockets: new Set() };
  item.proxyBridgeKey = bridgeKey;
  platformRuntimeLog('socks-bridge-started', {
    id: item.id,
    upstreamProtocol: 'socks5h',
    localPort: port,
    proxyUrl: proxyUrl.replace(/:[^:@/]+@/u, ':***@'),
  });
  return { port };
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clearPlatformLoadTimer(item) {
  if (item.loadTimer) {
    clearTimeout(item.loadTimer);
    item.loadTimer = undefined;
  }
}

function showPlatformLoadFailure(item, reason = '网络连接失败') {
  const webContents = liveWebContents(item);
  if (item?.fallback || item?.removing || !webContents) return;
  clearPlatformLoadTimer(item);
  item.loading = false;
  item.loaded = false;
  item.failed = true;
  item.fallback = true;
  // 首次加载失败时视图可能仍处于延迟挂载状态（加载动画中），必须把
  // 错误页挂载上来，否则用户只会一直看到加载动画。
  if (activePlatformViewId === item.id && !item.attached && mainWindow && !mainWindow.isDestroyed()) {
    if (safeAddChildView(mainWindow.contentView, item.view, undefined, 'load-failure-show')) {
      item.attached = true;
      item.concealed = false;
      setPlatformViewBounds(item);
    }
  }
  sendPlatformLoadState(item);

  const platformUrl = PLATFORM_URLS[item.platform];
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>平台页面无法打开</title>
    <style>
      :root { color-scheme: light; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #16233b; }
      main { width: min(560px, calc(100vw - 48px)); padding: 34px 38px; border: 1px solid #e1e9f2; border-radius: 18px; background: #fff; box-shadow: 0 14px 40px rgba(34, 65, 103, .08); }
      .mark { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 14px; background: #eaf2ff; color: #2468f2; font-size: 24px; }
      h1 { margin: 18px 0 8px; font-size: 22px; font-weight: 700; }
      p { margin: 8px 0; line-height: 1.7; color: #61718a; }
      .reason { margin-top: 18px; padding: 12px 14px; border-radius: 10px; background: #f5f8fc; color: #6f7e91; font-size: 13px; }
      .actions { display: flex; gap: 10px; margin-top: 24px; }
      button { border: 0; border-radius: 9px; padding: 10px 16px; font-size: 14px; cursor: pointer; }
      .primary { background: #2468f2; color: #fff; }
      .secondary { background: #eef4fb; color: #36516f; }
    </style>
  </head>
  <body>
    <main>
      <div class="mark">↗</div>
      <h1>${escapeHtml(item.platform)} 页面暂时无法打开</h1>
      <p>请检查网络连接，或点击窗口标签旁的设置图标，为当前应用配置代理后重试。</p>
      <div class="reason">${escapeHtml(reason)}</div>
      <div class="actions">
        <button class="primary" onclick="location.href='${platformUrl}'">重新加载</button>
        <button class="secondary" onclick="history.back()">返回应用中心</button>
      </div>
    </main>
  </body>
</html>`;
  void webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`).catch((error) => {
    platformRuntimeLog('platform-failure-render-error', {
      id: item.id,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

function startPlatformLoad(item) {
  clearPlatformLoadTimer(item);
  item.loading = true;
  item.loaded = false;
  item.failed = false;
  item.fallback = false;
  item.loadTimer = setTimeout(() => {
    if (item?.loading && !item.loaded && platformViews.get(item.id) === item) {
      showPlatformLoadFailure(item, '连接平台超时，请检查网络或代理设置');
    }
  }, PLATFORM_LOAD_TIMEOUT_MS);
}

async function configurePlatformSession(item, config) {
  if (!item || item.removing || !liveWebContents(item)) throw new Error('platform_view_unavailable');
  const proxy = config?.proxy;
  const webContents = liveWebContents(item);
  const networkConfigKey = crypto
    .createHash('sha256')
    .update(JSON.stringify(proxy?.host && proxy?.port
      ? {
          mode: 'proxy',
          type: normalizeProxyType(proxy.type),
          host: normalizeProxyHost(proxy.host),
          port: String(proxy.port),
          username: proxy.username || '',
          password: proxy.password || '',
        }
      : { mode: 'direct' }))
    .digest('hex');

  // Switching back to an existing tab must only re-attach its native view.
  // Reapplying the same proxy configuration closes Chromium's live sockets
  // and clears DNS, which makes Facebook navigate again and leaves the Vue
  // shell showing a fresh loading spinner on every tab switch.
  if (item.networkConfigKey === networkConfigKey) {
    platformRuntimeLog('proxy-config-reused', {
      id: item.id,
      mode: proxy?.host && proxy?.port ? 'proxy' : 'direct',
    });
    return;
  }
  webContents.setWebRTCIPHandlingPolicy(proxy?.host && proxy?.port
    ? 'disable_non_proxied_udp'
    : 'default');
  if (!proxy?.host || !proxy?.port) {
    item.proxyCredentials = { username: '', password: '' };
    await closeSocksHttpBridge(item);
    await item.session.closeAllConnections();
    await item.session.clearHostResolverCache().catch(() => {});
    await item.session.setProxy({ mode: 'direct' });
    item.networkConfigKey = networkConfigKey;
    platformRuntimeLog('proxy-configured', {
      id: item.id,
      mode: 'direct',
      safeStorage: safeStorage.isEncryptionAvailable(),
    });
    void refreshPlatformNetworkInfo(item, config);
    return;
  }
  const protocol = normalizeProxyType(proxy.type);
  const host = normalizeProxyHost(proxy.host);
  item.proxyCredentials = {
    username: proxy.username || '',
    password: proxy.password || '',
  };
  const upstreamProtocol = proxyUpstreamProtocol(proxy.type);
  let proxyRules;
  let localPort;
  if (protocol === 'socks5') {
    const bridge = await ensureSocksHttpBridge(item, proxy);
    localPort = bridge.port;
    // Electron's proxyRules grammar expects host:port entries here. The
    // bridge itself is HTTP and handles HTTPS through CONNECT.
    // The bridge speaks HTTP CONNECT.  Do not publish it as a SOCKS rule:
    // Chromium may select the `socks` entry for wss and then attempt a
    // SOCKS handshake against our HTTP bridge, which leaves WhatsApp's auth
    // WebSocket in ERR_SOCKS_CONNECTION_FAILED and the QR code spinning.
    proxyRules = `http=127.0.0.1:${localPort};https=127.0.0.1:${localPort}`;
  } else {
    await closeSocksHttpBridge(item);
    // HTTP/HTTPS proxies should also be advertised only for HTTP(S).  A
    // mismatched `socks` entry can make Chromium route WebSocket auth through
    // the wrong protocol and prevent platforms from producing a QR code.
    proxyRules = `http=${upstreamProtocol}://${host}:${proxy.port};https=${upstreamProtocol}://${host}:${proxy.port}`;
  }
  await item.session.closeAllConnections();
  await item.session.clearHostResolverCache().catch(() => {});
  await item.session.setProxy({
    mode: 'fixed_servers',
    proxyRules,
    proxyBypassRules: 'localhost,127.0.0.1',
  });
  item.networkConfigKey = networkConfigKey;
  let resolvedProxy = '';
  try {
    resolvedProxy = await item.session.resolveProxy(PLATFORM_URLS[item.platform]);
  } catch (error) {
    resolvedProxy = `resolve-error:${error?.message || String(error)}`;
  }
  platformRuntimeLog('proxy-configured', {
    id: item.id,
    mode: 'proxy',
    protocol,
    upstreamProtocol,
    hostKind: host.includes(':') ? 'ipv6' : 'host',
    port: Number(proxy.port),
    localPort,
    hasUsername: Boolean(item.proxyCredentials.username),
    hasPassword: Boolean(item.proxyCredentials.password),
    resolvedProxy,
    safeStorage: safeStorage.isEncryptionAvailable(),
  });
  void refreshPlatformNetworkInfo(item, config);
}

function hidePlatformViews(exceptId = '') {
  hideAssistantWindow();
  activePlatformViewId = exceptId || '';
  for (const [id, item] of platformViews) {
    if (id === exceptId) continue;
    if (item.attached && mainWindow && !item.removing) {
      safeRemoveChildView(mainWindow.contentView, item.view, 'hide-platform');
      item.attached = false;
      item.concealed = false;
      platformRuntimeLog('view-hidden', { id });
    }
  }
}

function concealPlatformView(id) {
  const item = platformViews.get(id);
  if (!item || item.removing || !mainWindow || !liveWebContents(item)) {
    return { id, concealed: false };
  }
  if (assistantContext?.platformWindowId === id) hideAssistantWindow();
  // WebContentsView is a native compositor surface above the Vue renderer.
  // Moving it off-screen is not reliable: a resize/layout pass can restore
  // its bounds and cover renderer modals. Detach it while the modal is open,
  // then showPlatformView() will attach the same live session again.
  if (item.attached) {
    safeRemoveChildView(mainWindow.contentView, item.view, 'conceal-platform');
    item.attached = false;
  }
  item.concealed = true;
  platformRuntimeLog('view-concealed', { id });
  return { id, concealed: true };
}

function showPlatformView(id) {
  const item = platformViews.get(id);
  const webContents = liveWebContents(item);
  if (!item || item.removing || !mainWindow || !webContents) {
    platformRuntimeLog('view-show-missing', { id });
    return { id, shown: false };
  }
  hidePlatformViews(id);
  // 首次加载进行中：暂不挂载原生视图（挂上就是白屏），先让 Vue 渲染层
  // 显示加载动画；did-finish-load 之后再挂载，用户看到的是
  // 加载动画 → 平台自身页面，没有空白期。
  if (item.loading && !item.loaded) {
    activePlatformViewId = id;
    item.concealed = false;
    sendPlatformLoadState(item);
    platformRuntimeLog('view-show-deferred', { id });
    return { id, shown: true, loaded: false, loading: true };
  }
  // Re-attach the active native view on every switch. WebContentsView is a
  // sibling of the Vue renderer; re-adding it makes it the topmost child and
  // prevents the renderer from covering it with the white platform shell.
  if (item.attached) {
    safeRemoveChildView(mainWindow.contentView, item.view, 'show-platform-existing');
    item.attached = false;
  }
  if (!safeAddChildView(mainWindow.contentView, item.view, undefined, 'show-platform')) {
    item.attached = false;
    return { id, shown: false };
  }
  item.attached = true;
  activePlatformViewId = id;
  item.concealed = false;
  setPlatformViewBounds(item);
  sendPlatformTranslationSettings(item);
  updateAssistantWindowContext(item);
  sendPlatformLoadState(item);
  platformRuntimeLog('view-shown', { id, loaded: item.loaded, url: safeWebContentsUrl(item) });
  return { id, shown: true, loaded: item.loaded };
}

function sendPlatformLoadState(item) {
  if (!item || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('platform:load-state', {
      id: item.id,
      loading: Boolean(item.loading),
      loaded: Boolean(item.loaded),
      failed: Boolean(item.failed),
    });
  } catch {
    /* 渲染器可能尚未就绪 */
  }
}

async function createPlatformView(config) {
  const platform = PLATFORM_URLS[config.platform] ? config.platform : null;
  if (!platform) throw new Error('Unsupported platform');

  const profile = ensurePlatformProfile({ ...config, platform });
  const partition = profile.isolation?.partition
    || ('persist:seagrass-' + platform.toLowerCase() + '-' + profile.id);
  const platformSession = session.fromPartition(partition);
  const item = {
    id: config.id,
    profileId: profile.id,
    platform,
    session: platformSession,
    workspaceId: config.workspaceId || activeWorkspaceScope,
    ownerUserId: config.ownerUserId || activeUserScope,
    ownerMemberId: config.ownerMemberId || null,
    profileConsistency: profile.consistency,
    proxyCredentials: { username: '', password: '' },
    proxyBridge: null,
    proxyBridgeKey: '',
    networkConfigKey: '',
    translationSettings: config.translationSettings || null,
    networkInfo: { state: 'loading', ip: '', location: '', checkedAt: 0 },
    networkInfoKey: '',
    networkInfoRequestId: 0,
    networkInfoPromise: null,
    attached: false,
    concealed: false,
    removing: false,
    loaded: false,
    loading: false,
    view: new WebContentsView({
      webPreferences: {
        preload: path.join(
          __dirname,
          platform === 'Facebook' ? 'facebook-preload.cjs' : 'platform-preload.cjs',
        ),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: platformSession,
        // 加载完成挂载瞬间避免刺眼白屏（与渲染层平台占位底色一致）。
        backgroundColor: '#f6f9fc',
      },
    }),
  };

  platformSession.on('login', (event, _webContents, _request, authInfo, callback) => {
    if (!item.proxyCredentials.username && !item.proxyCredentials.password) return;
    if (authInfo.isProxy) {
      event.preventDefault();
      callback(item.proxyCredentials.username, item.proxyCredentials.password);
    }
  });

  item.view.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedPlatformUrl(platform, url)) return { action: 'allow' };
    return { action: 'deny' };
  });
  item.view.webContents.on('will-navigate', (_event, url) => {
    if (isAllowedPlatformUrl(platform, url)) startPlatformLoad(item);
  });
  const markPlatformDocumentReady = (eventName) => {
    if (item.fallback || item.removing || !platformViews.has(item.id) || !liveWebContents(item)) return;
    if (item.loaded && !item.loading) return;
    clearPlatformLoadTimer(item);
    item.loaded = true;
    item.loading = false;
    if (activePlatformViewId === item.id) {
      // Loading can commit a new native surface after the renderer has already
      // painted its white platform placeholder. Re-attaching here keeps the
      // loaded platform surface above the Vue renderer on the very first open.
      showPlatformView(item.id);
    } else if (item.attached) {
      setPlatformViewBounds(item);
    }
    sendPlatformTranslationSettings(item);
    sendPlatformNetworkInfo(item);
    sendPlatformLoadState(item);
    platformRuntimeLog(eventName, { id: item.id, url: safeWebContentsUrl(item) });
  };
  // Facebook's authentication and checkpoint routes can leave
  // did-finish-load delayed even after the new document is interactive.
  // dom-ready is enough to reveal the page and prevents a completed login
  // challenge from remaining hidden behind our loading shell.
  item.view.webContents.on('dom-ready', () => markPlatformDocumentReady('document-ready'));
  item.view.webContents.on('did-finish-load', () => markPlatformDocumentReady('load-finished'));
  item.view.webContents.on('preload-error', (_event, preloadPath, error) => {
    platformRuntimeLog('preload-error', {
      id: item.id,
      preloadPath,
      error: error?.message || String(error),
    });
  });
  item.view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (item.removing || !platformViews.has(item.id) || !isMainFrame || errorCode === -3) return;
    platformRuntimeLog('load-failed', { id: item.id, errorCode, errorDescription });
    if (errorCode === -101 && !item.connectionResetRetried) {
      item.connectionResetRetried = true;
      void item.session.closeAllConnections().catch(() => {});
      void item.session.clearHostResolverCache().catch(() => {});
      setTimeout(() => {
        if (item.removing || platformViews.get(item.id) !== item || !liveWebContents(item)) return;
        startPlatformLoad(item);
        void liveWebContents(item).loadURL(PLATFORM_URLS[item.platform], {
          userAgent: profile.runtime.userAgent,
        }).catch(() => {});
      }, 800);
      return;
    }
    showPlatformLoadFailure(item, errorDescription || '平台页面加载失败');
  });
  item.view.webContents.on('render-process-gone', () => {
    if (item.removing || platformViews.get(item.id) !== item) return;
    item.attached = false;
    showPlatformLoadFailure(item, '平台页面进程已退出，请重新加载');
  });
  item.view.webContents.setUserAgent(profile.runtime.userAgent);

  platformViews.set(config.id, item);
  await configurePlatformSession(item, config);
  return item;
}

async function activatePlatformView(config) {
  if (!isActiveWorkspace(config.workspaceId) || !activeUserScope) throw new Error('workspace_scope_required');
  platformRuntimeLog('activate-start', { id: config.id, platform: config.platform, mode: config.mode || 'direct' });
  const requestedConfig = { ...config, proxy: runtimeProxy(config.proxy) };
  const record = upsertPlatformWindow(requestedConfig);
  const runtimeConfig = {
    ...record,
    ...requestedConfig,
    mode: record.mode,
    proxyId: record.proxyId,
    proxy: runtimeProxy(requestedConfig.proxy || record.proxy),
  };
  const profile = profileManager.get(record.profileId) || ensurePlatformProfile({ ...runtimeConfig, profileId: record.profileId });
  let item = platformViews.get(config.id);
  if (item && !isActiveScopedRecord(item)) {
    removePlatformView(item.id);
    item = undefined;
  }
  if (item?.removing || !liveWebContents(item)) {
    removePlatformView(config.id);
    item = undefined;
  }
  if (!item) item = await createPlatformView({ ...runtimeConfig, profileId: profile.id });
  item.workspaceId = runtimeConfig.workspaceId || item.workspaceId || activeWorkspaceScope || '';
  item.ownerUserId = runtimeConfig.ownerUserId || item.ownerUserId || activeUserScope || null;
  item.ownerMemberId = runtimeConfig.ownerMemberId || item.ownerMemberId || null;
  if (runtimeConfig.translationSettings) item.translationSettings = runtimeConfig.translationSettings;
  await configurePlatformSession(item, runtimeConfig);
  const needsFirstLoad = !item.loaded && !item.loading;
  if (needsFirstLoad) startPlatformLoad(item);
  const shown = showPlatformView(config.id);
  if (needsFirstLoad) {
    void liveWebContents(item)?.loadURL(PLATFORM_URLS[item.platform], {
      userAgent: profile.runtime.userAgent,
    }).catch(() => {
      showPlatformLoadFailure(item, '平台页面加载失败，请检查网络或代理设置');
    });
  }
  platformRuntimeLog('activate-complete', { id: item.id, loaded: item.loaded, loading: item.loading });
  return {
    id: config.id,
    platform: item.platform,
    url: safeWebContentsUrl(item),
    shown: Boolean(shown?.shown),
    loaded: item.loaded,
  };
}

function removePlatformView(id) {
  const item = platformViews.get(id);
  if (!item) return;
  if (item.removing) return;
  item.removing = true;
  platformViews.delete(id);
  if (assistantContext?.platformWindowId === id) hideAssistantWindow();
  if (item.attached && mainWindow && !mainWindow.isDestroyed()) {
    safeRemoveChildView(mainWindow.contentView, item.view, 'remove-platform');
  }
  item.attached = false;
  if (activePlatformViewId === id) activePlatformViewId = '';
  void closeSocksHttpBridge(item).catch(() => {});
  const webContents = liveWebContents(item);
  if (webContents) {
    try { webContents.close(); } catch (error) {
      platformRuntimeLog('view-close-error', { id, message: error?.message || String(error) });
    }
  }
}

function createWindow() {
  const win = new BaseWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    frame: false,
    // Native window/taskbar icon; the in-app brand remains the approved SVG.
    icon: trayIconPath(),
    title: '海草跨境助手',
    backgroundColor: '#f6f9fb',
  });
  mainWindow = win;
  if (typeof win.setMovable === 'function') win.setMovable(true);

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainView = view;

  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1440, height: 900 });

  const localRendererPath = path.join(__dirname, '../dist/index.html');
  let localRendererLoaded = false;
  const loadLocalRenderer = () => {
    if (localRendererLoaded) return;
    localRendererLoaded = true;
    void view.webContents.loadFile(localRendererPath);
    platformRuntimeLog('renderer-local-fallback', { path: localRendererPath });
  };
  if (isDev) {
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      platformRuntimeLog('renderer-dev-load-failed', { errorCode, errorDescription });
      loadLocalRenderer();
    });
    void view.webContents.loadURL(DEV_RENDERER_URL).catch((error) => {
      platformRuntimeLog('renderer-dev-load-error', { message: error?.message || String(error) });
      loadLocalRenderer();
    });
  } else {
    loadLocalRenderer();
  }
  view.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      restoreMainViewSurface('renderer-loaded');
      publishAppUpdateState({});
    }, 0);
  });
  win.on('resize', scheduleMainWindowViewLayout);
  let platformRestoreTimers = [];
  const clearPlatformRestoreTimers = () => {
    for (const timer of platformRestoreTimers) clearTimeout(timer);
    platformRestoreTimers = [];
  };
  const restoreActivePlatformView = (reason) => {
    const restoredId = activePlatformViewId;
    if (!restoredId) return;
    clearPlatformRestoreTimers();
    // Windows can finish rebuilding the compositor after the native restore
    // event. Re-attach once immediately and twice after the compositor has had
    // a chance to settle; every attempt is idempotent.
    for (const delay of [0, 140, 420]) {
      const timer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
        if (activePlatformViewId !== restoredId) return;
        const result = showPlatformView(restoredId);
        platformRuntimeLog('view-restored', {
          id: restoredId,
          reason,
          delay,
          shown: Boolean(result?.shown),
        });
      }, delay);
      platformRestoreTimers.push(timer);
    }
  };
  const restorePendingAssistantBounds = () => {
    const bounds = inlineAssistantPendingRestoreBounds;
    if (!bounds || !mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const shouldRestoreMaximized = inlineAssistantPendingRestoreMaximized;
    inlineAssistantPendingRestoreBounds = null;
    inlineAssistantPendingRestoreMaximized = false;
    mainWindow.setSize(bounds.width, bounds.height, false);
    mainWindow.setPosition(bounds.x, bounds.y, false);
    if (shouldRestoreMaximized) mainWindow.maximize();
  };
  win.on('minimize', () => {
    hideAssistantWindow({ clearContext: false });
    clearPlatformRestoreTimers();
    const minimizedId = activePlatformViewId;
    const active = minimizedId && platformViews.get(minimizedId);
    // Explicitly detach before Windows tears down the compositor surface.
    // Keeping the stale child attached is what produced the white platform
    // shell after restoring the app from the taskbar.
    if (active?.attached && !active.removing && mainWindow) {
      safeRemoveChildView(mainWindow.contentView, active.view, 'window-minimize');
      active.attached = false;
      active.concealed = false;
      platformRuntimeLog('view-detached-minimize', { id: minimizedId });
    }
  });
  win.on('restore', () => {
    restorePendingAssistantBounds();
    restoreMainViewSurface('window-restore');
    restoreActivePlatformView('restore');
  });
  win.on('show', () => {
    restorePendingAssistantBounds();
    restoreMainViewSurface('window-show');
    restoreActivePlatformView('show');
  });

  win.on('closed', () => {
    clearPlatformRestoreTimers();
    if (mainWindowLayoutTimer) clearTimeout(mainWindowLayoutTimer);
    mainWindowLayoutTimer = null;
    if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.close();
    inlineAssistantVisible = false;
    assistantContext = null;
    assistantLiveMessageBatch = null;
    if (assistantContextRefreshTimer) clearTimeout(assistantContextRefreshTimer);
    assistantContextRefreshTimer = null;
    for (const id of [...platformViews.keys()]) removePlatformView(id);
    if (liveWebContents(view)) {
      try { view.webContents.close(); } catch (error) {
        platformRuntimeLog('main-view-close-error', { message: error?.message || String(error) });
      }
    }
    if (mainWindow === win) mainWindow = undefined;
    if (mainView === view) mainView = undefined;
  });

  // BaseWindow can remain hidden on a fresh Electron process until an
  // explicit show call is made. Showing it here keeps the renderer and the
  // embedded platform view interactive immediately after startup.
  win.show();
}

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => {
  const behavior = readSystemSettings().closeBehavior;
  if (behavior === '直接退出应用') {
    app.quit();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  hideAssistantWindow({ clearContext: false });
  if (behavior === '最小化到托盘') mainWindow.hide();
  else mainWindow.minimize();
});

ipcMain.handle('app:get-version', () => app.getVersion());

// 原生确认框：平台窗口（WhatsApp 等）是 WebContentsView 原生视图层，
// DOM 弹窗会被它盖住。这里用原生 modal BrowserWindow 确认框，
// 层级高于所有 WebContentsView，不会被遮挡。
ipcMain.handle('confirm-dialog', (event, message) => {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const parent = BrowserWindow.fromWebContents(event.sender)
      || (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
    const win = new BrowserWindow({
      parent,
      modal: Boolean(parent),
      width: 400,
      height: 190,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'confirm-preload.cjs'),
      },
    });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => settle(false));
    ipcMain.once('confirm-result', (_event, ok) => {
      settle(Boolean(ok));
      if (!win.isDestroyed()) win.destroy();
    });
    // 必须用 loadFile（file:// 才会加载 preload）；data: URL 不执行
    // preload，confirmBridge 会是 undefined，点确定时主进程收不到结果，
    // Promise 永不 resolve，前端表现为点了确定没任何反应。
    const payload = encodeURIComponent(String(message || '确认操作'));
    win.loadFile(path.join(__dirname, 'confirm-dialog.html'), { hash: payload });
  });
});
ipcMain.handle('app:check-update', async (event) => { assertMainSender(event); clipboard.writeText(release.password); await shell.openExternal(release.downloadUrl); return publishAppUpdateState({ status: 'idle', message: '提取码已复制：' + release.password + '，请在蓝奏云粘贴。' }); });

ipcMain.handle('system:get-settings', () => readSystemSettings());
ipcMain.handle('system:save-settings', (_event, settings = {}) => writeSystemSettings(settings));
ipcMain.handle('system:reset-settings', () => writeSystemSettings(DEFAULT_SYSTEM_SETTINGS));

ipcMain.handle('shell:open-external', async (_event, value) => {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, reason: 'unsupported_protocol' };
  }
  await shell.openExternal(url.toString());
  return { ok: true };
});

// Platform pages only need the already-synced local rows for rendering tags
// in the native chat list. Avoid a cloud refresh on every WhatsApp DOM update.
ipcMain.handle('customer:list-platform', (event) => {
  const item = platformItemForSender(event.sender);
  if (!item) return [];
  return [...customerRegistry.values()]
    .filter((customer) => (
      isActiveScopedRecord(customer)
      && customer.workspace_id === item.workspaceId
      && customer.platform_window_id === item.id
    ))
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
});

ipcMain.on('platform:message-captured', (event, payload = {}) => {
  const item = platformItemForSender(event.sender);
  if (!item) return;
  refreshAssistantContextFromCapturedMessage(item, payload);
});

ipcMain.handle('customer:save-current', async (event, payload = {}) => {
  const item = platformItemForSender(event.sender);
  if (!item) throw new Error('platform_window_not_found');
  const record = platformWindowRegistry.get(item.id);
  const workspaceId = String(payload.workspace_id || record?.workspaceId || activeWorkspaceScope || '').trim();
  if (!isActiveWorkspace(workspaceId)) throw new Error('workspace_scope_required');
  const customer = saveLocalCustomer({
    ...payload,
    workspace_id: workspaceId,
    owner_member_id: payload.owner_member_id || null,
    owner_name: payload.owner_name || '当前用户',
    platform: item.platform,
    platform_window_id: item.id,
    platform_account: record?.account || record?.title || item.id,
  });
  return customer;
});

ipcMain.handle('customer:lookup-current', (event, payload = {}) => {
  const item = platformItemForSender(event.sender);
  if (!item || !payload.platform_contact_id) return null;
  const workspaceId = String(payload.workspace_id || item.workspaceId || activeWorkspaceScope || '').trim();
  if (!isActiveWorkspace(workspaceId)) return null;
  const exact = findLocalCustomerByIdentity({
    workspace_id: workspaceId,
    platform: item.platform,
    platform_window_id: item.id,
    platform_contact_id: payload.platform_contact_id,
  });
  if (exact) return exact;

  // WhatsApp can replace its internal conversation id after a reconnect.
  // Use an unambiguous display-name match in this same account as a fallback.
  const displayName = normalizedCustomerIdentityPart(payload.display_name);
  if (!displayName) return null;
  const matches = [...customerRegistry.values()].filter((customer) => (
    isActiveScopedRecord(customer)
    && customer.workspace_id === workspaceId
    && normalizedCustomerIdentityPart(customer.platform) === normalizedCustomerIdentityPart(item.platform)
    && normalizedCustomerIdentityPart(customer.platform_window_id) === normalizedCustomerIdentityPart(item.id)
    && normalizedCustomerIdentityPart(customer.display_name) === displayName
  ));
  return matches.length === 1 ? matches[0] : null;
});

ipcMain.handle('platform:open', async (_event, config) => {
  if (!config?.id || !config?.platform) throw new Error('Invalid platform configuration');
  if (!isActiveWorkspace(config.workspaceId)) throw new Error('workspace_scope_required');
  return activatePlatformView({ ...config, proxy: runtimeProxy(config.proxy) });
});
ipcMain.handle('platform:list', async () => {
  return [...platformWindowRegistry.values()]
    .filter((record) => isActiveScopedRecord(record))
    .map(normalizePlatformDisplayRecord);
});
ipcMain.handle('platform:profiles', () => profileManager?.list()
  .filter((profile) => isActiveScopedRecord(profile)) || []);
ipcMain.handle('platform:hide', () => {
  hidePlatformViews();
  // WebContentsView is a native sibling of the Vue renderer. Returning the
  // focus here makes the first click on the login form work after logout.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    if (mainView?.webContents && !mainView.webContents.isDestroyed()) {
      mainView.webContents.focus();
    }
  }
  return { ok: true };
});
ipcMain.handle('platform:conceal', (_event, id) => {
  const record = platformWindowRegistry.get(id);
  return record && isActiveScopedRecord(record)
    ? concealPlatformView(id)
    : { id, concealed: false };
});
ipcMain.handle('platform:show', (_event, id) => {
  const record = platformWindowRegistry.get(id);
  return record && isActiveScopedRecord(record)
    ? showPlatformView(id)
    : { id, shown: false };
});
ipcMain.handle('platform:set-sidebar-collapsed', (_event, collapsed) => {
  PLATFORM_CONTENT_OFFSET.x = collapsed ? 72 : 210;
  const settings = readSystemSettings();
  if (settings.sidebarCollapsed !== Boolean(collapsed)) {
    writeSystemSettings({ ...settings, sidebarCollapsed: Boolean(collapsed) });
  }
  applyMainWindowViewLayout();
  return { collapsed: Boolean(collapsed), offset: PLATFORM_CONTENT_OFFSET.x };
});
ipcMain.handle('platform:update-config', async (_event, id, changes = {}) => {
  const previous = platformWindowRegistry.get(id);
  if (!previous || !isActiveScopedRecord(previous)) throw new Error('platform_window_not_found');
  const platform = PLATFORM_URLS[changes.platform] ? changes.platform : previous.platform;
  const config = {
    ...previous,
    ...changes,
    id,
    platform,
    profileId: previous.profileId || id,
    workspaceId: previous.workspaceId,
    ownerUserId: previous.ownerUserId,
    ownerMemberId: previous.ownerMemberId,
    title: String(changes.title || previous.title || id).trim(),
    account: String(changes.account || previous.account || changes.title || id).trim(),
    accountId: String(changes.accountId || previous.accountId || previous.account || id).trim(),
    mode: changes.mode === 'proxy' ? 'proxy' : 'direct',
    proxyId: changes.mode === 'proxy' ? (changes.proxyId || null) : null,
    proxy: changes.mode === 'proxy' ? changes.proxy : undefined,
  };
  profileManager.rebind(config.profileId, { ...config, runtime: platformRuntimeProfile() });
  removePlatformView(id);
  const updated = upsertPlatformWindow(config);
  return normalizePlatformDisplayRecord(updated);
});
ipcMain.handle('platform:close', (_event, id) => {
  const record = platformWindowRegistry.get(id);
  if (!record || !isActiveScopedRecord(record)) return { id, closed: false };
  removePlatformView(id);
  return { id, closed: true };
});
ipcMain.handle('platform:delete', async (_event, id) => {
  const record = platformWindowRegistry.get(id);
  if (!record || !isActiveScopedRecord(record)) return { deleted: false, id };
  removePlatformView(id);
  const deleted = platformWindowRegistry.delete(id);
  if (deleted) persistPlatformWindowRegistry();
  return { deleted, id };
});
ipcMain.handle('platform:update-settings', (_event, id, settings) => {
  const record = platformWindowRegistry.get(id);
  if (!record || !isActiveScopedRecord(record)) throw new Error('platform_window_not_found');
  const item = platformViews.get(id);
  if (item) {
    item.translationSettings = settings;
    sendPlatformTranslationSettings(item);
  }
  record.translationSettings = settings;
  persistPlatformWindowRegistry();
  return { id, settings };
});
ipcMain.handle('platform:test-translation', async (event, settings = {}) => { assertMainSender(event); return localProvider.translate({ text: 'Hello, how are you?', sourceLanguage: 'en', targetLanguage: settings.targetLanguage || 'zh' }); });
async function replaceComposerTextForPlatform(item, text) {
  if (!item || !['WhatsApp', 'Facebook'].includes(item.platform)) {
    throw new Error('Composer replacement is not available to this platform view');
  }
  const webContents = item.view.webContents;
  const composerLookup = item.platform === 'Facebook'
    ? `(() => {
        const candidates = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            const label = String(node.getAttribute('aria-label') || '').toLowerCase();
            return rect.width > 80 && rect.height > 10 && rect.bottom > window.innerHeight * 0.55
              && !/(search|搜索)/u.test(label);
          });
        return candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
      })()`
    : `document.querySelector('#main [data-testid="conversation-compose-box-input"]')
        || document.querySelector('#main footer [contenteditable="true"][role="textbox"]')
        || document.querySelector('#main footer [contenteditable="true"]')`;
  const focused = await webContents.executeJavaScript(`
    (() => {
      const composer = ${composerLookup};
      if (!composer) return false;
      composer.focus();
      return true;
    })()
  `, true);
  if (!focused) return { ok: false, reason: 'composer_not_found' };

  const selectAllModifier = process.platform === 'darwin' ? 'meta' : 'control';
  webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'A',
    modifiers: [selectAllModifier],
  });
  webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: 'A',
    modifiers: [selectAllModifier],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await webContents.insertText(text);

  const serializedText = JSON.stringify(text);
  const result = await webContents.executeJavaScript(`
    (async () => {
      const expected = ${serializedText};
      const normalize = (value) => String(value || '').replace(/\\u00a0/g, ' ').trim();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const composer = ${composerLookup};
      const actual = composer?.textContent || '';
      return {
        ok: Boolean(composer) && normalize(actual) === normalize(expected),
        reason: composer ? 'composer_text_mismatch' : 'composer_not_found_after_insert',
        actual,
      };
    })()
  `, true);
  if (result?.ok) {
    try {
      webContents.send('platform:assistant-text-inserted', { text });
    } catch (error) {
      platformRuntimeLog('assistant-text-sync-error', { id: item.id, message: error?.message || String(error) });
    }
  }
  return result;
}

async function pasteAssistantImageForPlatform(item, imageDataUrl) {
  if (!item || item.platform !== 'WhatsApp') {
    return { ok: false, reason: 'image_paste_not_supported' };
  }
  if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,/iu.test(imageDataUrl)) {
    return { ok: false, reason: 'invalid_image_data' };
  }
  const image = nativeImage.createFromDataURL(imageDataUrl);
  if (image.isEmpty()) return { ok: false, reason: 'invalid_image_data' };
  const webContents = liveWebContents(item);
  if (!webContents) return { ok: false, reason: 'platform_window_not_found' };

  const previousClipboard = {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    image: clipboard.readImage(),
  };
  const focused = await webContents.executeJavaScript(`
    (() => {
      const composer = document.querySelector('#main [data-testid="conversation-compose-box-input"]')
        || document.querySelector('#main footer [contenteditable="true"][role="textbox"]')
        || document.querySelector('#main footer [contenteditable="true"]');
      if (!composer) return false;
      composer.focus();
      return true;
    })()
  `, true);
  if (!focused) return { ok: false, reason: 'composer_not_found' };

  try {
    clipboard.writeImage(image);
    const pasteModifier = process.platform === 'darwin' ? 'meta' : 'control';
    webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: [pasteModifier] });
    webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: [pasteModifier] });
    await new Promise((resolve) => setTimeout(resolve, 420));
    const previewVisible = await webContents.executeJavaScript(`
      (() => Boolean(
        document.querySelector('[data-testid="media-editor"]')
        || document.querySelector('[data-testid="media-preview"]')
        || document.querySelector('[data-testid="media-caption-input-container"]')
        || document.querySelector('[role="dialog"] canvas')
      ))()
    `, true).catch(() => false);
    return { ok: Boolean(previewVisible), reason: previewVisible ? undefined : 'image_preview_not_found' };
  } finally {
    setTimeout(() => {
      try {
        const formats = {};
        if (previousClipboard.text) formats.text = previousClipboard.text;
        if (previousClipboard.html) formats.html = previousClipboard.html;
        if (previousClipboard.image && !previousClipboard.image.isEmpty()) formats.image = previousClipboard.image;
        if (Object.keys(formats).length) clipboard.write(formats);
        else clipboard.clear();
      } catch {}
    }, 250);
  }
}

async function pasteAssistantImagePathForPlatform(item, imagePath) {
  if (!imagePath || typeof imagePath !== 'string') return { ok: false, reason: 'invalid_image_path' };
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) return { ok: false, reason: 'image_not_found' };
  return pasteAssistantImageForPlatform(item, image.toDataURL());
}

ipcMain.handle('platform:replace-composer-text', async (event, payload = {}) => {
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text || text.length > 5000) throw new Error('Invalid composer text');
  const item = [...platformViews.values()].find(
    (candidate) => candidate.view.webContents.id === event.sender.id,
  );
  return replaceComposerTextForPlatform(item, text);
});

ipcMain.handle('platform:send-composer', async (event) => {
  const item = [...platformViews.values()].find(
    (candidate) => candidate.view.webContents.id === event.sender.id,
  );
  if (!item || !['WhatsApp', 'Facebook'].includes(item.platform)) {
    return { ok: false, reason: 'platform_not_supported' };
  }
  const webContents = liveWebContents(item);
  if (!webContents) return { ok: false, reason: 'platform_window_not_found' };
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  return { ok: true };
});

ipcMain.on('assistant:hide', () => hideAssistantWindow({ clearContext: false }));
ipcMain.handle('assistant:inline-hide', () => {
  hideAssistantWindow({ clearContext: false });
  return { ok: true, visible: false };
});
ipcMain.handle('assistant:inline-toggle', async (_event, payload = {}) => {
  if (inlineAssistantTogglePending) {
    return { ok: false, visible: inlineAssistantVisible, reason: 'assistant_transition_pending' };
  }
  inlineAssistantTogglePending = true;
  const requestedId = String(payload.platformWindowId || '').trim();
  const item = (requestedId && platformViews.get(requestedId))
    || platformItemForSender(_event.sender)
    || [...platformViews.values()].find((candidate) => candidate.attached);
  if (!item) {
    inlineAssistantTogglePending = false;
    return { ok: false, visible: false, reason: 'platform_window_not_found' };
  }
  const requestedContactId = String(payload.platformContactId || '').trim();
  if (
    inlineAssistantVisible
    && assistantContext?.platformWindowId === item.id
    && String(assistantContext?.platformContactId || '') === requestedContactId
  ) {
    hideAssistantWindow({ clearContext: false });
    return { ok: true, visible: false, context: assistantContext };
  }
  try {
    await updateAssistantWindowContextWithPayload(item, payload);
    showAssistantWindow();
    return { ok: true, visible: inlineAssistantVisible, context: assistantContext };
  } catch (error) {
    inlineAssistantTogglePending = false;
    throw error;
  }
});
ipcMain.handle('assistant:list-models', async () => getAssistantAiModels());
ipcMain.handle('assistant:select-model', async (_event, payload = {}) => {
  const requestedCode = String(payload.code || '').trim();
  const model = (await getAssistantAiModels()).find((item) => item?.code === requestedCode);
  if (!model) throw new Error('ai_model_not_available');
  assistantSelectedModelCode = requestedCode;
  assistantAiModelCache = model;
  if (assistantContext) {
    assistantContext.aiModel = model;
    sendAssistantContext();
  }
  return model;
});
ipcMain.on('assistant:toggle', (event, payload = {}) => {
  if (inlineAssistantTogglePending) return;
  inlineAssistantTogglePending = true;
  const item = platformItemForSender(event.sender);
  if (!item) {
    inlineAssistantTogglePending = false;
    return;
  }
  if (
    inlineAssistantVisible
    && assistantContext?.platformWindowId === item.id
    && String(assistantContext?.platformContactId || '') === String(payload.platformContactId || '').trim()
  ) {
    hideAssistantWindow({ clearContext: false });
    return;
  }
  void (async () => {
    try {
      await updateAssistantWindowContextWithPayload(item, payload);
      showAssistantWindow();
    } catch {
      inlineAssistantTogglePending = false;
    }
  })();
});

async function localizeAssistantMetadata(suggestion) {
  // Purpose, rationale and the internal Chinese translation are generated by
  // the AI endpoint and belong to AI-credit billing. Do not call the public
  // translation endpoint from here, otherwise one AI suggestion would also
  // consume translation characters invisibly.
  return { ...suggestion };
}

const assistantReadRequests = new Map();
function requestAssistantSnapshot(item, contactId, checkOnly = false) {
  return new Promise((resolve,reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { assistantReadRequests.delete(requestId); reject(new Error('读取当前聊天超时，请重新打开聊天后重试。')); }, 6000);
    assistantReadRequests.set(requestId,{sender:item.view.webContents,contactId,resolve,reject,timer});
    try { item.view.webContents.send('assistant:collect-context',{requestId,contactId,checkOnly}); }
    catch { clearTimeout(timer); assistantReadRequests.delete(requestId); reject(new Error('聊天窗口已关闭。')); }
  });
}
ipcMain.on('assistant:collected-context',(event,payload={}) => {
  const pending=assistantReadRequests.get(payload.requestId);
  if(!pending || pending.sender !== event.sender) return;
  clearTimeout(pending.timer); assistantReadRequests.delete(payload.requestId);
  if(!payload.ok || payload.contactId !== pending.contactId) pending.reject(new Error(payload.reason || '聊天已切换，请重新打开 AI 回复。'));
  else pending.resolve(payload);
});
async function collectAssistantVisionContext(item,context) {
  const assertCurrent=async()=>{
    if(assistantContext!==context || item.view.webContents.isDestroyed()) throw new Error('聊天已切换或关闭，请重新生成。');
    await requestAssistantSnapshot(item,context.platformContactId,true);
  };
  const snapshot=await requestAssistantSnapshot(item,context.platformContactId);
  return require('./assistant-capture.cjs').readChatImages({snapshot,assertCurrent,captureRect:async rect=>{
    let image=await item.view.webContents.capturePage(rect);
    if(image.isEmpty()) throw new Error('无法读取聊天图片，请打开图片后重试。');
    const size=image.getSize();
    if(Math.max(size.width,size.height)>1600) image=image.resize(size.width>size.height?{width:1600}:{height:1600});
    return 'data:image/jpeg;base64,'+image.toJPEG(86).toString('base64');
  }});
}
ipcMain.handle('assistant:suggest', async (event, payload = {}) => {
   assertMainSender(event);
   const context = assistantContext;
   if (!context || !Array.isArray(context.messages)) throw new Error('请先打开对话并读取聊天记录。');
   const item = platformViews.get(context.platformWindowId);
   const messages = item?.platform === 'WhatsApp' ? await collectAssistantVisionContext(item, context) : context.messages;
   if (assistantContext !== context) throw new Error('聊天已切换，请重新生成。');
   const result = await localProvider.suggest({ ...payload, messages, customerLanguage: context.customerLanguage,
     outputLanguage: payload.outputLanguage || context.outputLanguage });
   if (assistantContext !== context) throw new Error('聊天已切换，本次建议已丢弃，请在当前聊天重新生成。');
   if (item?.platform === 'WhatsApp') await requestAssistantSnapshot(item, context.platformContactId, true);
   return result;
 });
ipcMain.handle('assistant:copy-to-composer', async (_event, payload = {}) => {
  const imageDataUrl = typeof payload.imageDataUrl === 'string' ? payload.imageDataUrl.trim() : '';
  const imagePath = typeof payload.imagePath === 'string' ? payload.imagePath.trim() : '';
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const originalText = typeof payload.originalText === 'string' ? payload.originalText.trim() : '';
  if (!imageDataUrl && !imagePath && (!text || text.length > 5000)) throw new Error('Invalid assistant text');
  if (originalText.length > 5000) throw new Error('Invalid assistant translation');
  const windowId = String(payload.platformWindowId || assistantContext?.platformWindowId || '');
  const item = platformViews.get(windowId);
  if (!item) return { ok: false, reason: 'platform_window_not_found' };
  if (payload.platformContactId && item.platform === 'WhatsApp') await requestAssistantSnapshot(item, String(payload.platformContactId), true);
  if (imagePath) return pasteAssistantImagePathForPlatform(item, imagePath);
  if (imageDataUrl) return pasteAssistantImageForPlatform(item, imageDataUrl);
  if (item.platform === 'WhatsApp') {
    const result = await replaceComposerTextForPlatform(item, text);
    // The AI panel already has the internal Chinese translation. Pass it to
    // the platform preload so the sent bubble can render it without making a
    // second billable translation request.
    const webContents = liveWebContents(item);
    if (result?.ok && originalText && webContents) {
      try {
        webContents.send('platform:remember-outgoing-original', {
          originalText,
          sentText: text,
        });
      } catch (error) {
        platformRuntimeLog('outgoing-original-send-error', { id: item.id, message: error?.message || String(error) });
      }
    }
    return result;
  }
  clipboard.writeText(text);
  return { ok: false, reason: 'clipboard_fallback' };
});
ipcMain.handle('platform:replace-search-text', async (event, payload = {}) => {
  const text = typeof payload.text === 'string' ? payload.text.slice(0, 320) : '';
  const item = platformItemForSender(event.sender);
  if (!item || item.platform !== 'WhatsApp') {
    throw new Error('Search replacement is only available to a WhatsApp platform view');
  }
  const webContents = item.view.webContents;
  const focused = await webContents.executeJavaScript(`
    (() => {
      const search = document.querySelector('#side input[role="textbox"]')
        || document.querySelector('#side input[aria-label]')
        || document.querySelector('#side input[type="text"]')
        || document.querySelector('#side [contenteditable="true"][role="textbox"]')
        || document.querySelector('[data-testid="chat-list-search"] [contenteditable="true"]')
        || [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
          .find((node) => node.closest('#side'));
      if (!search) return false;
      search.focus();
      return true;
    })()
  `, true);
  if (!focused) return { ok: false, reason: 'search_not_found' };
  if (!text) {
    const cleared = await webContents.executeJavaScript(`
      (() => {
        const search = document.querySelector('#side input[role="textbox"]')
          || document.querySelector('#side input[aria-label]')
          || document.querySelector('#side input[type="text"]')
          || document.querySelector('#side [contenteditable="true"][role="textbox"]')
          || document.querySelector('[data-testid="chat-list-search"] [contenteditable="true"]')
          || [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
            .find((node) => node.closest('#side'));
        if (!search) return false;
        if ('value' in search) {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set;
          setter?.call(search, '');
          search.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward',
            data: null,
          }));
          search.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          search.textContent = '';
          search.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward',
            data: null,
          }));
        }
        return true;
      })()
    `, true);
    return { ok: Boolean(cleared), text };
  }
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  if (text) webContents.insertText(text);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { ok: true, text };
});
ipcMain.handle('platform:translate', async (event, payload = {}) => {
   if (!platformItemForSender(event.sender)) throw new Error('platform_window_not_found');
   if (!payload.text || typeof payload.text !== 'string') throw new Error('Translation text is required');
   if (sameTranslationLanguage(payload.sourceLanguage, payload.targetLanguage)) return { text: payload.text, provider: 'deepseek', skipped: true };
   const cacheKey = getTranslationCacheKey(event, { ...payload, provider: localProvider.metadata().model });
   const cached = translationCache.get(cacheKey);
   if (cached && !payload.forceFresh) return { ...cached, cached: true };
   const result = await localProvider.translate(payload);
   translationCache.set(cacheKey, result); persistTranslationCache();
   return { ...result, cached: false };
 });

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    const id = activePlatformViewId;
    if (id) setTimeout(() => showPlatformView(id), 160);
  });

  app.whenReady().then(() => {
  // 系统通知/任务栏/设备授权等处显示的应用名默认取 package.json 的
  // "name"（@seagrass/desktop），这里显式设置为中文产品名，避免通知
  // 标题等位置出现英文内部标识。
  app.setName('海草跨境助手');
  // Windows 通知中心（Toast）的来源名默认是 "electron.app.<name>"。
  // 显式设置 AppUserModelId 后，通知来源会显示为应用的显示名（海草跨境助手），
  // 而不是 electron.app 前缀；同时让任务栏图标分组与安装版一致。
  app.setAppUserModelId('cn.mutusv.seagrass.standalone');
  Menu.setApplicationMenu(null);
  profileManager = createProfileManager({
    userDataPath: app.getPath('userData'),
    runtime: platformRuntimeProfile(),
  });
  profileManager.load();
  loadPlatformWindowRegistry();
  loadTranslationCache();
  loadCustomerRegistry();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  createWindow();
  if (isDev && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.focus();
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setAlwaysOnTop(false);
      mainWindow.focus();
    }, 2000);
  }
  ensureTray();

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function assertMainSender(event) {
  if (!mainView || event.sender !== mainView.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('仅允许应用设置页面操作');
}
ipcMain.handle('local:settings', event => { assertMainSender(event); return localProvider.metadata(); });
ipcMain.handle('local:save-settings', (event, input) => { assertMainSender(event); const result = localProvider.save(input); assistantAiModelCache = null; return result; });
ipcMain.handle('local:test', async event => { assertMainSender(event); return localProvider.test(); });
ipcMain.handle('local:balance', async event => { assertMainSender(event); return localProvider.balance(); });
ipcMain.handle('local:proxies', event => { assertMainSender(event); return localProxies.list(); });
ipcMain.handle('local:create-proxy', (event, input) => { assertMainSender(event); return localProxies.create(input); });
ipcMain.handle('local:delete-proxy', (event, id) => { assertMainSender(event); if ([...platformWindowRegistry.values()].some(row => row.proxyId === id || row.profileBinding?.proxyId === id)) throw new Error('请先解除窗口与该代理的关联'); return localProxies.remove(id); });
ipcMain.handle('local:test-proxy', (event, id) => { assertMainSender(event); return localProxies.test(id); });
