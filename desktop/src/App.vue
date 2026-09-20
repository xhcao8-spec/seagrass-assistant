<script setup lang="ts">
import LocalAccount from './components/LocalAccount.vue';
import LocalAiSettings from './components/LocalAiSettings.vue';
import { localBridge, localSettings, loadLocalSettings, balanceSummary, refreshBalance, cleanLocalError } from './services/localClient';
import type { LocalProxy } from './services/localClient';
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { siFacebook, siInstagram, siLine, siTelegram, siWhatsapp, siX, siZalo } from 'simple-icons';
import seagrassLogo from './assets/brand/seagrass-logo.svg';
import LanguageSelect from './components/LanguageSelect.vue';




type ViewKey = 'home' | 'accounts' | 'connections' | 'settings' | 'platform';



type PlatformName = 'WhatsApp' | 'LINE' | 'Zalo' | 'Telegram' | 'LinkedIn' | 'Facebook' | 'Instagram' | 'X';




interface TabItem {
  id: string;
  profileId?: string;
  title: string;
  platform?: PlatformName;
  account?: string;
  accountId?: string;
}




interface PlatformCard {
  platform: PlatformName;
  version: string;
  latestVersion: string;
}




interface Customer {
  id: string;
  name: string;
  phone: string;
  platform: PlatformName;
  account: string;
  owner: string;
  ownerMemberId: string;
  stageCode: 'new' | 'intent' | 'following' | 'won' | 'invalid';
  stage: string;
  tags: string[];
  lastContact: string;
  avatar: string;
  avatarDataUrl: string;
  note: string;
  platformWindowId: string;
  platformContactId: string;
  preferredLanguage: string;
  preferredProvider: string;
  preferredRoute: string;
  syncStatus: 'synced' | 'pending';
  updatedAt: string;
}




interface AssistantContext {
  platform?: string;
  platformWindowId?: string;
  workspaceId?: string;
  account?: string;
  windowTitle?: string;
  platformContactId?: string;
  customerName?: string;
  customerLanguage?: string;
  outputLanguage?: string;
  translationProvider?: string;
  translationLanguage?: string;
  languageLabels?: Record<string, string>;
  aiModel?: Record<string, unknown> | null;
  messages?: Array<Record<string, unknown>>;
}




interface AssistantSuggestion {
  [key: string]: unknown;
  title?: string;
  text?: string;
  translation?: string;
  purpose?: string;
  rationale?: string;
}




interface QuickReplyGroupItem {
  id: string;
  kind: 'phrase' | 'image';
  name: string;
  scope: 'personal' | 'workspace';
  ownerMemberId: string;
  assignedMemberIds: string[];
  phrases?: Array<{ id: string; content: string }>;
  images?: Array<{ id: string; name: string; imageDataUrl?: string; imagePath?: string }>;
}




interface ProxyItem {
  id: string;
  name: string;
  type: string;
  host: string;
  port: string;
  username: string;
  password: string;
  status: '正常' | '异常' | '未测试';
  usedBy: string;
  scope: '个人';
  assignedMembers: string[];
  assignedMemberIds: string[];
  lastCheck: string;
}




type PlatformConnectionMode = 'direct' | 'proxy';




interface PlatformSessionConfig {
  mode: PlatformConnectionMode;
  proxyId?: string;
  proxy?: {
    type: string;
    host: string;
    port: string;
    username?: string;
    password?: string;
  };
}




interface PlatformWindowRecordView {
  id: string;
  profileId?: string;
  title?: string;
  platform?: PlatformName;
  account?: string;
  accountId?: string;
  mode?: PlatformConnectionMode;
  proxyId?: string | null;
  proxy?: PlatformSessionConfig['proxy'];
  profileBinding?: { mode?: PlatformConnectionMode; proxyId?: string | null };
  translationSettings?: Partial<WindowTranslationSettings>;
}




function restoredPlatformConnectionMode(record?: PlatformWindowRecordView): PlatformConnectionMode {
  if (record?.mode === 'proxy' || record?.mode === 'direct') return record.mode;
  if (
    record?.profileBinding?.mode === 'proxy'
    || Boolean(record?.proxyId || record?.profileBinding?.proxyId)
    || Boolean(record?.proxy?.host && record?.proxy?.port)
  ) return 'proxy';
  return 'direct';
}




interface WindowTranslationSettings {
  provider: string;
  route: string;
  sendTranslation: boolean;
  messageTranslation: boolean;
  inputLanguage: string;
  sourceLanguage: string;
  targetLanguage: string;
  sendLanguage: string;
  skipChineseMessages: boolean;
  groupTranslation: 'manual' | 'auto';
  fontColor: string;
  fontSize: string;
  translationSeparator: boolean;
}




function defaultWindowTranslationSettings(): WindowTranslationSettings {
  return {
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
}




function normalizeWindowTranslationSettings(
  settings?: Partial<WindowTranslationSettings> | null,
): WindowTranslationSettings {
  const normalized = { ...defaultWindowTranslationSettings(), ...(settings || {}) };
  normalized.route = 'default-1';
  normalized.inputLanguage = String(
    settings?.inputLanguage || settings?.targetLanguage || normalized.inputLanguage || 'zh',
  );
  // 旧版本「自动跟随当前客户」选项已移除，历史保存的 auto 一律落到默认英语。
  if (!normalized.sendLanguage || normalized.sendLanguage === 'auto') normalized.sendLanguage = 'en';
  return normalized;
}




interface DesktopBridge {
  windowControls?: Record<string, () => void>;
  app?: {
    getVersion: () => Promise<string>;
    checkForUpdates: () => Promise<AppUpdateState>;
    onUpdateState: (listener: (state: AppUpdateState) => void) => () => void;
  };
  system?: {
    getSettings: () => Promise<Record<string, unknown>>;
    saveSettings: (settings: Record<string, unknown>) => Promise<Record<string, unknown>>;
    resetSettings: () => Promise<Record<string, unknown>>;
  };
  confirmDialog?: (message: string) => Promise<boolean>;
  external?: {
    open: (url: string) => Promise<{ ok?: boolean; reason?: string }>;
  };
  platform?: {
    open: (config: Record<string, unknown>) => Promise<{ shown?: boolean; loaded?: boolean; id?: string }>;
    list: () => Promise<PlatformWindowRecordView[]>;
    hide: () => Promise<unknown>;
    conceal?: (id: string) => Promise<unknown>;
    show?: (id: string) => Promise<{ id?: string; shown?: boolean; loaded?: boolean }>;
    setSidebarCollapsed?: (collapsed: boolean) => Promise<{ collapsed?: boolean; offset?: number }>;
    updateConfig?: (id: string, config: Record<string, unknown>) => Promise<PlatformWindowRecordView>;
    close: (id: string) => Promise<unknown>;
    delete: (id: string) => Promise<unknown>;
    updateSettings?: (id: string, settings: WindowTranslationSettings) => Promise<unknown>;
    testTranslation?: (settings?: Partial<WindowTranslationSettings>) => Promise<{ text?: string }>;
    onLoadState?: (listener: (state: { id: string; loading: boolean; loaded: boolean; failed: boolean }) => void) => () => void;
  };
  assistant?: {
    toggle: (payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    hide: () => Promise<Record<string, unknown>>;
    listModels: () => Promise<Array<Record<string, unknown>>>;
    selectModel: (code: string) => Promise<Record<string, unknown>>;
    suggest: (payload?: Record<string, unknown>) => Promise<{ suggestions?: AssistantSuggestion[]; imageCount?: number }>;
    copyToComposer: (payload?: Record<string, unknown>) => Promise<{ ok?: boolean; reason?: string }>;
    onContext: (listener: (payload: { visible?: boolean; context?: AssistantContext | null }) => void) => () => void;
  };
}




const navItems: Array<{ key: ViewKey; label: string; icon: string }> = [
  { key: 'home', label: '应用中心', icon: 'grid' },
  { key: 'accounts', label: '余额', icon: 'account' },
  { key: 'connections', label: '代理', icon: 'proxy' },
  { key: 'settings', label: '系统设置', icon: 'settings' },
];




const iconPaths: Record<string, string[]> = {
  grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  account: ['M4 6.5h16a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2Z', 'M2 10h20', 'M15 15h4'],
  person: ['M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M3.5 20a5 5 0 0 1 10 0', 'M16 7h5', 'M16 12h5', 'M16 17h5'],
  team: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M17 11a3 3 0 1 0-1.2-5.8', 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 14.2a5.6 5.6 0 0 1 5.5 5.8'],
  link: ['M10 13.5 8.5 15a4 4 0 0 1-5.7-5.7l2.5-2.5A4 4 0 0 1 11 6', 'M14 10.5 15.5 9a4 4 0 0 1 5.7 5.7l-2.5 2.5A4 4 0 0 1 13 18', 'm8 16 8-8'],
  proxy: ['M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z', 'M5 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z', 'M19 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z', 'M9.7 8.7 7 14', 'm14.3 8.7 2.7 5.3', 'M8 17h8'],
  settings: ['M9.9 3.3 10.4 2h3.2l.5 1.3a8.8 8.8 0 0 1 2.1.9l1.3-.6 2.3 2.3-.6 1.3c.4.7.7 1.4.9 2.1l1.3.5v3.2l-1.3.5a8.8 8.8 0 0 1-.9 2.1l.6 1.3-2.3 2.3-1.3-.6a8.8 8.8 0 0 1-2.1.9l-.5 1.3h-3.2l-.5-1.3a8.8 8.8 0 0 1-2.1-.9l-1.3.6-2.3-2.3.6-1.3a8.8 8.8 0 0 1-.9-2.1L2 13v-3.2l1.3-.5a8.8 8.8 0 0 1 .9-2.1l-.6-1.3 2.3-2.3 1.3.6a8.8 8.8 0 0 1 2.1-.9Z', 'M15.5 11.4a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z'],
  home: ['M3 11.5 12 4l9 7.5', 'M5.5 10v9h13v-9', 'M9 19v-5h6v5'],
  chevron: ['m7 10 5 5 5-5'],
  search: ['m20 20-4.5-4.5', 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  cloud: ['M7.5 18.5h9a4.5 4.5 0 0 0 .7-8.9A6 6 0 0 0 5.8 8.4 5 5 0 0 0 7.5 18.5Z'],
  shield: ['M12 3 19 6v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z', 'm9 12 2 2 4-4'],
  tabs: ['M4 6h16v12H4z', 'M8 3h12v3', 'M8 9h8', 'M8 13h5'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['m6 6 12 12', 'm18 6-12 12'],
  arrow: ['M5 12h13', 'm13 6 6 6-6 6'],
  copy: ['M8 8h11v12H8z', 'M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1'],
  sparkle: ['m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Z', 'm19 15 .6 2.4L22 18l-2.4.6L19 21l-.6-2.4L16 18l2.4-.6L19 15Z'],
};




const UiIcon = defineComponent({
  name: 'UiIcon',
  props: { name: { type: String, required: true } },
  setup(props) {
    return () => h('svg', { class: 'ui-icon', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' }, (iconPaths[props.name] ?? iconPaths.grid).map((d) => h('path', { d })));
  },
});




const PlatformIcon = defineComponent({
  name: 'PlatformIcon',
  props: { platform: { type: String, required: true }, small: Boolean },
  setup(props) {
    const icons = {
      WhatsApp: siWhatsapp,
      LINE: siLine,
      Zalo: siZalo,
      Telegram: siTelegram,
      Facebook: siFacebook,
      Instagram: siInstagram,
      X: siX,
    };
    return () => {
      const platform = props.platform as PlatformName;
      const children = platform === 'LinkedIn'
        ? [h('b', { class: 'linkedin-glyph', 'aria-hidden': 'true' }, 'in')]
        : [h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
            h('path', { d: (icons[platform as keyof typeof icons] ?? siWhatsapp).path }),
          ])];
      return h('span', {
        class: ['platform-icon', `platform-${platform.toLowerCase()}`, { small: props.small }],
        role: 'img',
        'aria-label': platformDisplayLabel(platform),
      }, children);
    };
  },
});




const LogoMark = defineComponent({
  name: 'LogoMark',
  inheritAttrs: true,
  setup(_, { attrs }) {
    return () => h('img', { ...attrs, src: seagrassLogo, alt: '海草跨境助手', role: 'img', draggable: 'false' });
  },
});




const activeView = ref<ViewKey>('home');



const sidebarCollapsed = ref(window.localStorage.getItem('seagrass:sidebar-collapsed') === '1');




// 自定义确认弹窗：替代 window.confirm。
// Electron 的原生 confirm 是同步阻塞的，关闭后渲染进程的输入焦点与
// 中文输入法（IME）状态不会立即恢复，导致紧接着输入时短暂打不出字。
// 用异步的组件内弹窗不阻塞渲染进程，彻底规避该问题。
const confirmState = ref<{ message: string; resolve: (value: boolean) => void } | null>(null);



const confirmDialogOpen = computed(() => confirmState.value !== null);




function showConfirm(message: string): Promise<boolean> {
  // 优先用原生确认框（不会被 WhatsApp 等原生视图遮挡），
  // 原生不可用时降级为页面内弹窗。
  const native = desktopBridge()?.confirmDialog;
  if (typeof native === 'function') {
    return native(message).catch(() => domConfirm(message));
  }
  return domConfirm(message);
}




function domConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.value = { message, resolve };
  });
}




function confirmDialogDone(ok: boolean) {
  const state = confirmState.value;
  if (!state) return;
  confirmState.value = null;
  state.resolve(ok);
}



const activeTabId = ref('');



const notice = ref('');



const setupPlatform = ref<PlatformCard | null>(null);



const editingPlatformWindowId = ref('');



const setupWindowName = ref('');



const setupConnectionMode = ref<'direct' | 'proxy'>('direct');



const setupProxyId = ref('new');



const setupProxyName = ref('');



const setupProxyType = ref('HTTP/HTTPS');



const setupProxyAddress = ref('');



const setupProxyPort = ref('');



const setupProxyUsername = ref('');



const setupProxyPassword = ref('');



const setupShowName = ref(true);



const setupShowNotifications = ref(true);



const setupMute = ref(false);



const setupAutoLoad = ref(true);



type AppUpdateStatus = 'dev' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';



interface AppUpdateState {
  status: AppUpdateStatus;
  version: string;
  updateVersion?: string;
  progress?: number;
  message?: string;
}




const appVersion = ref('1.1.0');



const appUpdateState = ref<AppUpdateState>({ status: 'idle', version: appVersion.value, updateVersion: '', progress: 0 });



const proxyFormVisible = ref(false);



const proxyForm = ref({ name: '', type: 'HTTP/HTTPS', host: '', port: '', username: '', password: '', scope: '个人' as const });



const systemSettings = ref({
  language: '简体中文',
  defaultView: '应用中心',
  openWindowOnLaunch: true,
  launchOnStartup: false,
  sidebarCollapsed: false,
  closeBehavior: '保留在托盘和任务栏中',
});



const windowTranslationSettings = ref<Record<string, WindowTranslationSettings>>({});



const windowSettingsVisible = ref(false);



const windowSettingsTab = ref<TabItem | null>(null);



let windowSettingsRequestId = 0;



const windowSettingsDraft = ref<WindowTranslationSettings>(defaultWindowTranslationSettings());



const windowSettingsOriginal = ref<WindowTranslationSettings>(defaultWindowTranslationSettings());



const translationTestState = ref<'idle' | 'testing' | 'success' | 'error'>('idle');



const assistantPanelVisible = ref(false);



const assistantLoading = ref(false);



const assistantError = ref('');



const assistantGoal = ref('');



const assistantSuggestions = ref<AssistantSuggestion[]>([]);



const assistantContext = ref<AssistantContext | null>(null);



const storedAssistantReplyMode = window.localStorage.getItem('seagrass:assistant-reply-mode');



const storedAssistantReplyCount = Number(window.localStorage.getItem('seagrass:assistant-reply-count'));



const assistantReplyMode = ref<'quick' | 'deep'>(storedAssistantReplyMode === 'quick' ? 'quick' : 'deep');



const assistantReplyCount = ref(Math.min(4, Math.max(1, Number.isInteger(storedAssistantReplyCount) ? storedAssistantReplyCount : 2)));



let unsubscribeAssistantContext: (() => void) | undefined;



let unsubscribeAppUpdate: (() => void) | undefined;




const assistantMode = ref<'ai' | 'quick'>('ai');



const quickReplyTab = ref<'phrase' | 'image'>('phrase');



const quickReplyGroups = ref<QuickReplyGroupItem[]>([]);



const quickReplyLoading = ref(false);



const quickReplyExpandedGroupId = ref('');



const quickReplyManageVisible = ref(false);



const quickReplyManageKind = ref<'phrase' | 'image'>('phrase');



const quickReplyManageMode = ref<'group' | 'content'>('group');



const quickReplyNewGroupName = ref('');



const quickReplyNewPhrase = ref('');



const quickReplyNewImageName = ref('');



const quickReplyNewImageDataUrl = ref('');



const quickReplyNewImagePath = ref('');



const quickReplyPendingImages = ref<Array<{ name: string; path: string; dataUrl: string }>>([]);



const quickReplyEditingGroupId = ref('');



const quickReplyGroupSearch = ref('');



function quickReplyLocalStorageKey() { return 'seagrass:quick-replies:local'; }




function readLocalQuickReplyGroups(): QuickReplyGroupItem[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(quickReplyLocalStorageKey()) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}




function writeLocalQuickReplyGroups(groups: QuickReplyGroupItem[]) {
  window.localStorage.setItem(quickReplyLocalStorageKey(), JSON.stringify(groups));
}




function newLocalId(prefix: string) {
  return `${prefix}-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}




const tabs = ref<TabItem[]>([]);



const platformWindows = ref<TabItem[]>([]);



const draggingTabId = ref('');



const dragTargetTabId = ref('');



const dragTargetSide = ref<'before' | 'after'>('before');



const tabScroller = ref<HTMLElement | null>(null);



const tabOverviewOpen = ref(false);




const supportedPlatforms: PlatformName[] = [
  'WhatsApp', 'LINE', 'Zalo', 'Telegram', 'LinkedIn', 'Facebook', 'Instagram', 'X',
];




const platformCards: PlatformCard[] = [
  { platform: 'WhatsApp', version: '1.6.3', latestVersion: '1.6.3' },
  { platform: 'LinkedIn', version: '0.1.0', latestVersion: '0.1.0' },
  { platform: 'Facebook', version: '0.1.0', latestVersion: '0.1.0' },
  { platform: 'Instagram', version: '0.1.0', latestVersion: '0.1.0' },
  { platform: 'X', version: '0.1.0', latestVersion: '0.1.0' },
];




function platformDisplayLabel(platform: PlatformName) {
  return platform === 'X' ? 'X（Twitter）' : platform;
}




function platformHasUpdate(card: PlatformCard) {
  return card.version !== card.latestVersion;
}




function updatePlatformModule(card: PlatformCard) {
  showNotice(platformHasUpdate(card) ? `${card.platform} 有新版本，请在创建应用窗口时完成更新` : `${card.platform} 已是最新版`);
}




// These maps are runtime state only. Demo entries here used to survive an
// account switch and made a newly logged-in account appear to own another
// account's windows. They are rebuilt from the scoped native registry.
const connectionModes: Record<string, string> = {};



const platformSessionConfigs: Record<string, PlatformSessionConfig> = {};




const customers = ref<Customer[]>([]);



const customerSearch = ref('');



const customerPlatformFilter = ref<'all' | PlatformName>('all');



const customerStageFilter = ref<'all' | Customer['stageCode']>('all');



const customerOwnerFilter = ref('all');



const customerTagFilter = ref('all');



const customerPage = ref(1);



const customerPageSize = 20;



let unsubscribePlatformLoadState: (() => void) | undefined;



let appInitialized = false;




interface PlatformLoadState { id: string; loading: boolean; loaded: boolean; failed: boolean }



const platformLoadStates = ref<Record<string, PlatformLoadState>>({});



const activePlatformLoading = computed(() => {
  const id = activePlatformTab.value?.id;
  return id ? Boolean(platformLoadStates.value[id]?.loading) : false;
});



const currentWorkspaceId = computed(() => 'local');



const currentMemberId = computed(() => 'local');



const canManageProxies = computed(() => true);



async function prepareApp() {
   if (appInitialized) return; appInitialized = true;
   loadWindowTranslationSettings(); await loadPlatformWindows();
   await loadProxies(); await loadQuickReplyGroups();
   await loadLocalSettings();
   if (!localSettings.value.hasKey) { activeView.value = 'settings'; activeTabId.value = ''; }
   else { void refreshBalance(); await openStartupPlatformWindow(); }
 }



async function initializeSession() {
   try {
     const saved = await desktopBridge()?.system?.getSettings();
     if (saved) {
       systemSettings.value = { ...systemSettings.value, ...saved };
       sidebarCollapsed.value = Boolean(saved.sidebarCollapsed);
       await desktopBridge()?.platform?.setSidebarCollapsed?.(sidebarCollapsed.value);
       const previous = window.localStorage.getItem('seagrass:last-view');
       if (saved.defaultView === '上次打开页面' && navItems.some(item => item.key === previous)) activeView.value = previous as ViewKey;
     }
     await prepareApp();
   } catch (error) { showNotice(cleanLocalError(error)); }
 }




const proxies = ref<ProxyItem[]>([]);



const setupSelectedProxy = computed(() => proxies.value.find((proxy) => proxy.id === setupProxyId.value));



const setupUsesNewProxy = computed(() => setupProxyId.value === 'new');




function formatCustomerTime(value?: string | null) {
  if (!value) return '尚未联系';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}



function mapProxy(raw: LocalProxy): ProxyItem { return { id: raw.id, name: raw.name, type: raw.proxy_type,
   host: raw.host, port: String(raw.port), username: raw.username || '', password: raw.password || '',
   status: raw.status === 'healthy' ? '正常' : raw.status === 'unhealthy' ? '异常' : '未测试',
   usedBy: Object.values(platformSessionConfigs).filter(config => config.proxyId === raw.id).length + ' 个窗口',
   scope: '个人', assignedMembers: [], assignedMemberIds: [], lastCheck: raw.last_checked_at ? formatCustomerTime(raw.last_checked_at) : '尚未测试' }; }



async function loadProxies() { try { proxies.value = (await localBridge().proxies()).map(mapProxy); } catch (error) { showNotice(cleanLocalError(error)); } }



const filteredCustomers = computed(() => {
  const query = customerSearch.value.trim().toLowerCase();
  return customers.value.filter((customer) => {
    const searchable = [customer.name, customer.phone, customer.account, customer.platform, ...customer.tags]
      .join(' ')
      .toLowerCase();
    return (!query || searchable.includes(query))
      && (customerPlatformFilter.value === 'all' || customer.platform === customerPlatformFilter.value)
      && (customerStageFilter.value === 'all' || customer.stageCode === customerStageFilter.value)
      && (customerOwnerFilter.value === 'all' || customer.ownerMemberId === customerOwnerFilter.value)
      && (customerTagFilter.value === 'all' || customer.tags.includes(customerTagFilter.value));
  });
});



const customerPageCount = computed(() => Math.max(1, Math.ceil(filteredCustomers.value.length / customerPageSize)));



watch(
  [customerSearch, customerPlatformFilter, customerStageFilter, customerOwnerFilter, customerTagFilter],
  () => { customerPage.value = 1; },
);



watch(customerPageCount, (count) => {
  if (customerPage.value > count) customerPage.value = count;
});



const activePlatformTab = computed(() => tabs.value.find((tab) => tab.id === activeTabId.value));



const createdWindows = computed(() => platformWindows.value.filter((tab) => tab.platform).map((tab) => ({
  platform: tab.platform!,
  account: tab.account ?? '待登录',
  name: tab.title,
  mode: connectionModes[tab.id] ?? '直连',
  status: '已打开',
  tabId: tab.id,
})));



const ctaLabel = () => '打开应用';




function selectNav(item: { key: ViewKey; label: string }) {
  hideNativePlatform();
  activeView.value = item.key;
  activeTabId.value = '';
}




function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  systemSettings.value.sidebarCollapsed = sidebarCollapsed.value;
  window.localStorage.setItem('seagrass:sidebar-collapsed', sidebarCollapsed.value ? '1' : '0');
  void desktopBridge()?.platform?.setSidebarCollapsed?.(sidebarCollapsed.value);
}




function selectTab(tab: TabItem) {
  tabOverviewOpen.value = false;
  activeTabId.value = tab.id;
  activeView.value = 'platform';
  showNativePlatform(tab);
  void nextTick(() => revealTab(tab.id));
}




function revealTab(tabId: string) {
  const scroller = tabScroller.value;
  const tab = scroller?.querySelector<HTMLElement>(`[data-platform-tab-id="${CSS.escape(tabId)}"]`);
  tab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}




function handleTabWheel(event: WheelEvent) {
  const scroller = tabScroller.value;
  if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
  event.preventDefault();
  scroller.scrollLeft += event.deltaY || event.deltaX;
}




async function toggleTabOverview() {
  if (tabOverviewOpen.value) {
    await closeTabOverview();
    return;
  }
  tabOverviewOpen.value = true;
  if (activeView.value === 'platform' && activeTabId.value) {
    await desktopBridge()?.platform?.conceal?.(activeTabId.value);
  }
}




async function closeTabOverview(restorePlatform = true) {
  tabOverviewOpen.value = false;
  if (restorePlatform && activeView.value === 'platform' && activeTabId.value) {
    await desktopBridge()?.platform?.show?.(activeTabId.value);
  }
}




function selectTabFromOverview(tab: TabItem) {
  tabOverviewOpen.value = false;
  selectTab(tab);
}



function platformTabOrderStorageKey() { return 'seagrass:tab-order:local'; }




function readPlatformTabOrder() {
  try {
    const value = JSON.parse(window.localStorage.getItem(platformTabOrderStorageKey()) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}




function orderPlatformTabs(items: TabItem[], preferredOrder = readPlatformTabOrder()) {
  const indexes = new Map(preferredOrder.map((id, index) => [id, index]));
  return items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((left, right) => {
      const leftIndex = indexes.get(left.item.id);
      const rightIndex = indexes.get(right.item.id);
      if (leftIndex === undefined && rightIndex === undefined) return left.originalIndex - right.originalIndex;
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    })
    .map(({ item }) => item);
}




function persistPlatformTabOrder() {
  try {
    window.localStorage.setItem(
      platformTabOrderStorageKey(),
      JSON.stringify(platformWindows.value.map((tab) => tab.id)),
    );
  } catch {
    // 排序保存失败不影响当前窗口继续使用。
  }
}




function startTabDrag(event: DragEvent, tab: TabItem) {
  const target = event.target as Element | null;
  if (target?.closest('.tab-settings-trigger, .tab-close')) {
    event.preventDefault();
    return;
  }
  draggingTabId.value = tab.id;
  dragTargetTabId.value = '';
  dragTargetSide.value = 'before';
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tab.id);
  }
}




function markTabDragTarget(event: DragEvent, tab: TabItem) {
  if (!draggingTabId.value || draggingTabId.value === tab.id) return;
  event.preventDefault();
  dragTargetTabId.value = tab.id;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dragTargetSide.value = event.clientX >= bounds.left + bounds.width / 2 ? 'after' : 'before';
  const scroller = tabScroller.value;
  if (scroller) {
    const scrollerBounds = scroller.getBoundingClientRect();
    if (event.clientX < scrollerBounds.left + 42) scroller.scrollLeft -= 22;
    else if (event.clientX > scrollerBounds.right - 42) scroller.scrollLeft += 22;
  }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}




function markOverviewDragTarget(event: DragEvent, tab: TabItem) {
  if (!draggingTabId.value || draggingTabId.value === tab.id) return;
  event.preventDefault();
  dragTargetTabId.value = tab.id;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dragTargetSide.value = event.clientY >= bounds.top + bounds.height / 2 ? 'after' : 'before';
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}




function finishTabDrop(event: DragEvent, targetTab: TabItem) {
  event.preventDefault();
  const sourceId = draggingTabId.value || event.dataTransfer?.getData('text/plain') || '';
  if (!sourceId || sourceId === targetTab.id) {
    endTabDrag();
    return;
  }
  const reordered = [...tabs.value];
  const sourceIndex = reordered.findIndex((tab) => tab.id === sourceId);
  if (sourceIndex < 0) {
    endTabDrag();
    return;
  }
  const [moved] = reordered.splice(sourceIndex, 1);
  const targetIndex = reordered.findIndex((tab) => tab.id === targetTab.id);
  if (targetIndex < 0) {
    endTabDrag();
    return;
  }
  reordered.splice(targetIndex + (dragTargetSide.value === 'after' ? 1 : 0), 0, moved);
  tabs.value = reordered;
  const openOrder = reordered.map((tab) => tab.id);
  const remainingOrder = platformWindows.value
    .map((tab) => tab.id)
    .filter((id) => !openOrder.includes(id));
  platformWindows.value = orderPlatformTabs(platformWindows.value, [...openOrder, ...remainingOrder]);
  persistPlatformTabOrder();
  void nextTick(() => revealTab(sourceId));
  endTabDrag();
}




function endTabDrag() {
  draggingTabId.value = '';
  dragTargetTabId.value = '';
  dragTargetSide.value = 'before';
}




function closeTab(tab: TabItem) {
  void desktopBridge()?.platform?.close(tab.id);
  const index = tabs.value.findIndex((item) => item.id === tab.id);
  tabs.value = tabs.value.filter((item) => item.id !== tab.id);
  if (activeTabId.value === tab.id) {
    const fallback = tabs.value[Math.max(0, index - 1)] ?? tabs.value[0];
    if (fallback) {
      selectTab(fallback);
    } else {
      hideNativePlatform();
      activeTabId.value = '';
      activeView.value = 'home';
    }
  }
}




function handlePlatformCard(card: PlatformCard) {
  editingPlatformWindowId.value = '';
  setupPlatform.value = card;
  setupWindowName.value = '';
  setupConnectionMode.value = 'direct';
  setupProxyId.value = 'new';
  setupProxyName.value = '';
  setupProxyType.value = 'HTTP/HTTPS';
  setupProxyAddress.value = '';
  setupProxyPort.value = '';
  setupProxyUsername.value = '';
  setupProxyPassword.value = '';
}




function closePlatformSetup() {
  setupPlatform.value = null;
  editingPlatformWindowId.value = '';
}




function editRunningWindow(tabId: string) {
  const tab = platformWindows.value.find((item) => item.id === tabId);
  if (!tab?.platform) return;
  const config = platformSessionConfigs[tabId] || { mode: 'direct' as const };
  editingPlatformWindowId.value = tabId;
  setupPlatform.value = platformCards.find((card) => card.platform === tab.platform)
    || { platform: tab.platform, version: '0.1.0', latestVersion: '0.1.0' };
  setupWindowName.value = tab.title;
  setupConnectionMode.value = config.mode;
  setupProxyId.value = config.proxyId || 'new';
  setupProxyName.value = '';
  setupProxyType.value = config.proxy?.type === 'SOCKS5' ? 'SOCKS5' : 'HTTP/HTTPS';
  setupProxyAddress.value = config.proxy?.host || '';
  setupProxyPort.value = config.proxy?.port ? String(config.proxy.port) : '';
  setupProxyUsername.value = config.proxy?.username || '';
  setupProxyPassword.value = config.proxy?.password || '';
}




async function createApplication() {
  if (!setupPlatform.value) return;
  const platform = setupPlatform.value.platform;
  const title = setupWindowName.value.trim() || '未命名窗口';
  const existingTab = editingPlatformWindowId.value
    ? platformWindows.value.find((item) => item.id === editingPlatformWindowId.value)
    : undefined;
  const id = existingTab?.id || `${platform.toLowerCase()}-${Date.now().toString(36)}`;
  let proxyConfig: PlatformSessionConfig['proxy'];
  if (setupConnectionMode.value === 'proxy') {
    if (!setupUsesNewProxy.value) {
      const selected = setupSelectedProxy.value;
      if (!selected) {
        showNotice('请选择一个可用代理，或选择添加新代理');
        return;
      }
      proxyConfig = {
        type: selected.type,
        host: selected.host,
        port: selected.port,
        username: selected.username,
        password: selected.password,
      };
    } else {
      const port = Number.parseInt(setupProxyPort.value, 10);
      if (!setupProxyAddress.value.trim() || !Number.isFinite(port) || port < 1 || port > 65535) {
        showNotice('请填写有效的新代理地址和端口');
        return;
      }
      try {
        const created = await localBridge().createProxy({
          name: setupProxyName.value.trim() || `${platform} 路 ${title}`,
          proxy_type: setupProxyType.value === 'SOCKS5' ? 'SOCKS5' : 'HTTP',
          host: setupProxyAddress.value.trim(),
          port,
          username: setupProxyUsername.value.trim() || undefined,
          password: setupProxyPassword.value || undefined,
          scope: 'personal',
        });
      const mapped = mapProxy(created);
        proxies.value = [mapped, ...proxies.value.filter((item) => item.id !== mapped.id)];
        proxyConfig = {
          type: mapped.type,
          host: mapped.host,
          port: mapped.port,
          username: mapped.username,
          password: mapped.password,
        };
        setupProxyId.value = mapped.id;
      } catch {
        showNotice('新代理保存失败，请检查网络或权限');
        return;
      }
    }
  }
  const tab = existingTab
    ? { ...existingTab, title, platform }
    : { id, profileId: id, title, platform, account: title, accountId: title } satisfies TabItem;
  if (existingTab) {
    let updated: PlatformWindowRecordView | undefined;
    try {
      updated = await desktopBridge()?.platform?.updateConfig?.(id, {
        profileId: existingTab.profileId || id,
        title,
        platform,
        account: existingTab.account || title,
        accountId: existingTab.accountId || existingTab.account || title,
        mode: setupConnectionMode.value,
        proxyId: setupConnectionMode.value === 'proxy' && setupProxyId.value !== 'new' ? setupProxyId.value : null,
        ...(proxyConfig ? { proxy: proxyConfig } : {}),
      });
    } catch {
      showNotice('窗口设置保存失败，请检查代理配置');
      return;
    }
    if (updated) tab.profileId = typeof updated.profileId === 'string' ? updated.profileId : tab.profileId;
    Object.assign(existingTab, tab);
    const openTab = tabs.value.find((item) => item.id === id);
    if (openTab) Object.assign(openTab, tab);
  } else {
    tabs.value.push(tab);
  }
  registerPlatformWindow(tab);
  connectionModes[id] = setupConnectionMode.value === 'proxy' ? '代理' : '直连';
  platformSessionConfigs[id] = {
    mode: setupConnectionMode.value,
    ...(setupConnectionMode.value === 'proxy' && setupProxyId.value !== 'new'
      ? { proxyId: setupProxyId.value }
      : {}),
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
  };
  activeTabId.value = id;
  activeView.value = 'platform';
  showNativePlatform(tab);
  closePlatformSetup();
  showNotice(existingTab ? `已更新应用窗口：${title}` : `已创建应用窗口：${title}`);
}




function switchRunning(tabId: string) {
  const tab = tabs.value.find((item) => item.id === tabId) ?? platformWindows.value.find((item) => item.id === tabId);
  if (tab && !tabs.value.some((item) => item.id === tab.id)) tabs.value.push(tab);
  if (tab) selectTab(tab);
}




async function deleteRunningWindow(tabId: string) {
  const tab = tabs.value.find((item) => item.id === tabId) ?? platformWindows.value.find((item) => item.id === tabId);
  if (!tab) return;
  if (!(await showConfirm(`确定删除“${tab.title}”窗口吗？这不会删除平台账号。`))) return;

  await desktopBridge()?.platform?.delete?.(tabId);
  const index = tabs.value.findIndex((item) => item.id === tabId);
  tabs.value = tabs.value.filter((item) => item.id !== tabId);
  platformWindows.value = platformWindows.value.filter((item) => item.id !== tabId);
  delete connectionModes[tabId];
  delete platformSessionConfigs[tabId];
  delete windowTranslationSettings.value[tabId];
  persistWindowTranslationSettings();

  if (activeTabId.value === tabId) {
    const fallback = tabs.value[Math.max(0, index - 1)] ?? tabs.value[0];
    if (fallback) selectTab(fallback);
    else {
      await hideNativePlatform();
      activeTabId.value = '';
      activeView.value = 'home';
    }
  }
  showNotice(`窗口“${tab.title}”已删除`);
}




function desktopBridge() {
  return (window as Window & { seagrassDesktop?: DesktopBridge }).seagrassDesktop;
}



function appUpdateButtonLabel() { return '下载新版'; }



function appUpdateStatusHint() { return '打开蓝奏云下载页，提取码：9ysu'; }



async function handleAppUpdate() { try { const result = await desktopBridge()?.app?.checkForUpdates(); if (result?.message) showNotice(result.message); } catch (error) { showNotice(cleanLocalError(error)); } }




function getWindowTranslationSettings(id: string): WindowTranslationSettings {
  return normalizeWindowTranslationSettings(windowTranslationSettings.value[id]);
}



function windowTranslationSettingsStorageKey() { return 'seagrass:translation-settings:local'; }




function persistWindowTranslationSettings() {
  try {
    window.localStorage.setItem(windowTranslationSettingsStorageKey(), JSON.stringify(windowTranslationSettings.value));
  } catch {
    // Local persistence is optional during the first renderer load.
  }
}




function loadWindowTranslationSettings() {
  windowTranslationSettings.value = {};
  try {
    const value = JSON.parse(window.localStorage.getItem(windowTranslationSettingsStorageKey()) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [id, settings] of Object.entries(value)) {
      windowTranslationSettings.value[id] = normalizeWindowTranslationSettings(
        settings as Partial<WindowTranslationSettings>,
      );
    }
  } catch {
    // Keep defaults if the local setting cache is unavailable.
  }
}




async function openWindowTranslationSettings(tab: TabItem | undefined) {
  if (!tab?.platform) return;
  const requestId = ++windowSettingsRequestId;

  // The settings button can be clicked from a different tab than the one
  // currently displayed. Activate that exact native platform view first;
  // otherwise conceal/show may operate on the previous tab and leave a blank
  // compositor surface behind the modal.
  activeTabId.value = tab.id;
  activeView.value = 'platform';
  try {
    await showNativePlatform(tab);
  } catch {
    // The settings dialog is still useful when the platform is offline.
  }
  if (requestId !== windowSettingsRequestId) return;

  windowSettingsTab.value = { ...tab };
  windowSettingsOriginal.value = { ...getWindowTranslationSettings(tab.id) };
  windowSettingsDraft.value = { ...windowSettingsOriginal.value };
  translationTestState.value = 'idle';
  try {
    await desktopBridge()?.platform?.conceal?.(tab.id);
  } catch {
    // The modal can still be closed even if the native view disappeared.
  }
  if (requestId !== windowSettingsRequestId) return;
  windowSettingsVisible.value = true;
}




async function closeWindowTranslationSettings(committed = false) {
  windowSettingsRequestId += 1;
  const settingsTab = windowSettingsTab.value;

  // Hide the modal before touching the native WebContentsView. If the native
  // bridge is slow or unavailable, the close button must still work.
  windowSettingsVisible.value = false;

  if (!committed && settingsTab?.platform) {
    try {
      await desktopBridge()?.platform?.updateSettings?.(settingsTab.id, { ...windowSettingsOriginal.value });
    } catch {
      // Closing is still successful even when restoring native settings fails.
    }
  }

  if (settingsTab?.platform) {
    try {
      await desktopBridge()?.platform?.show?.(settingsTab.id);
      activeTabId.value = settingsTab.id;
      activeView.value = 'platform';
    } catch {
      // The platform view can be reopened from the application center.
    }
  }
  windowSettingsTab.value = null;
}




function resetWindowTranslationSettings() {
  windowSettingsDraft.value = defaultWindowTranslationSettings();
  translationTestState.value = 'idle';
}




async function testWindowTranslation() {
  translationTestState.value = 'testing';
  try {
    const result = await desktopBridge()?.platform?.testTranslation?.({
      provider: windowSettingsDraft.value.provider,
      sourceLanguage: windowSettingsDraft.value.sourceLanguage,
      targetLanguage: windowSettingsDraft.value.targetLanguage,
    });
    if (!result?.text) throw new Error('translation_test_failed');
    translationTestState.value = 'success';
    showNotice(`翻译接口正常：${result.text}`);
  } catch {
    translationTestState.value = 'error';
    showNotice('翻译接口测试失败，请检查服务或密钥配置');
  }
}




async function saveWindowTranslationSettings() {
  const tab = windowSettingsTab.value;
  if (!tab) return;
  windowSettingsDraft.value = normalizeWindowTranslationSettings(windowSettingsDraft.value);
  windowTranslationSettings.value[tab.id] = { ...windowSettingsDraft.value };
  persistWindowTranslationSettings();
  await desktopBridge()?.platform?.updateSettings?.(tab.id, { ...windowSettingsDraft.value });
  await closeWindowTranslationSettings(true);
  showNotice('当前窗口的翻译设置已保存');
}




watch(windowSettingsDraft, (settings) => {
  const tab = windowSettingsTab.value;
  if (!windowSettingsVisible.value || !tab?.platform) return;
  void desktopBridge()?.platform?.updateSettings?.(tab.id, { ...settings });
}, { deep: true });




function hideNativePlatform() {
  return desktopBridge()?.platform?.hide();
}




function registerPlatformWindow(tab: TabItem) {
  if (!tab.platform) return;
  const existing = platformWindows.value.find((item) => item.id === tab.id);
  if (existing) {
    Object.assign(existing, tab);
  } else {
    platformWindows.value.push({ ...tab });
    persistPlatformTabOrder();
  }
}




async function loadPlatformWindows() {
  const platformApi = desktopBridge()?.platform;
  if (!platformApi) return;
  try {
    const records = await platformApi.list();
    const restored = records
      .filter((record) => typeof record.id === 'string' && supportedPlatforms.includes(record.platform as PlatformName))
      .map((record) => ({
      id: String(record.id),
      profileId: typeof record.profileId === 'string' ? record.profileId : String(record.id),
      title: String(record.title || record.account || record.id),
      platform: record.platform as PlatformName,
      account: String(record.account || record.title || record.id),
      accountId: String(record.accountId || record.account || record.title || record.id),
      } satisfies TabItem));
    platformWindows.value = orderPlatformTabs(restored);
    restored.forEach((tab) => {
      const record = records.find((item) => item.id === tab.id);
      const mode = restoredPlatformConnectionMode(record);
      connectionModes[tab.id] = mode === 'proxy' ? '代理' : '直连';
      platformSessionConfigs[tab.id] = {
        mode,
        proxyId: typeof record?.proxyId === 'string'
          ? record.proxyId
          : typeof record?.profileBinding?.proxyId === 'string'
            ? record.profileBinding.proxyId
            : undefined,
        proxy: record?.proxy as PlatformSessionConfig['proxy'],
      };
      if (!windowTranslationSettings.value[tab.id] && record?.translationSettings) {
        windowTranslationSettings.value[tab.id] = {
          ...defaultWindowTranslationSettings(),
          ...(record.translationSettings as Partial<WindowTranslationSettings>),
        };
      }
    });
  } catch {
    showNotice('已创建窗口列表暂时无法读取');
  }
}




async function openStartupPlatformWindow() {
  if (!systemSettings.value.openWindowOnLaunch || !platformWindows.value.length) return;
  for (const tab of platformWindows.value) {
    if (!tab.platform) continue;
    if (!tabs.value.some((item) => item.id === tab.id)) tabs.value.push({ ...tab });
    await showNativePlatform(tab);
  }
  const last = platformWindows.value.at(-1);
  if (last) {
    activeTabId.value = last.id;
    activeView.value = 'platform';
  }
}




async function showNativePlatform(tab: TabItem) {
  if (!tab.platform) return;
  const config = platformSessionConfigs[tab.id] ?? { mode: 'direct' as const };
  const bridge = desktopBridge()?.platform;
  if (!bridge?.open) return;
  try {
    const result = await bridge.open({
      id: tab.id,
      profileId: tab.profileId || tab.id,
      title: tab.title,
      platform: tab.platform,
      account: tab.account ?? tab.title,
      accountId: tab.accountId ?? tab.account ?? tab.title,
      workspaceId: currentWorkspaceId.value,
      ownerUserId: 'local',
      ownerMemberId: currentMemberId.value,
      mode: config.mode,
      proxyId: config.proxyId,
      proxy: config.proxy,
      translationSettings: { ...getWindowTranslationSettings(tab.id) },
    });
    // 首次打开尚未加载完成：乐观标记为加载中，让平台区域先显示加载动画，
    // 主进程随后会通过 platform:load-state 同步真实状态。
    if (result && result.loaded === false) {
      platformLoadStates.value = {
        ...platformLoadStates.value,
        [tab.id]: { id: tab.id, loading: true, loaded: false, failed: false },
      };
    }
    // The Vue platform shell is rendered in the same tick that the native
    // WebContentsView is opened. Re-assert the native view after Vue has
    // committed that shell so the first open has the same z-order as a manual
    // tab click. This call is intentionally unconditional and idempotent.
    await nextTick();
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    const shown = await bridge.show?.(tab.id);
    if (result?.shown === false && shown?.shown === false) {
      throw new Error('platform_view_not_shown');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '');
    showNotice(message.includes('Profile binding conflict')
      ? '此窗口的账号或代理绑定已变化，请恢复原代理后重试，或新建窗口'
      : '平台页面暂时无法打开，请检查网络或代理设置');
  }
}



onMounted(() => {
  unsubscribeAppUpdate = desktopBridge()?.app?.onUpdateState((state) => {
    appUpdateState.value = { ...appUpdateState.value, ...state };
    if (state.version) appVersion.value = state.version;
  });
  void desktopBridge()?.app?.getVersion().then((version) => {
    if (version) appVersion.value = version;
  });
  unsubscribeAssistantContext = desktopBridge()?.assistant?.onContext((payload) => {
    const previousIdentity = assistantContextIdentity(assistantContext.value);
    const nextIdentity = assistantContextIdentity(payload?.context || null);
    if (previousIdentity !== nextIdentity || !payload?.visible) {
      assistantGeneration++;
      assistantLoading.value = false;
      assistantSuggestions.value = [];
      assistantError.value = '';
    }
    assistantPanelVisible.value = Boolean(payload?.visible);
    assistantContext.value = payload?.context || null;
    if (!assistantPanelVisible.value) {
      assistantLoading.value = false;
      assistantError.value = '';
      assistantSuggestions.value = [];
    } else {
      void loadQuickReplyGroups();
    }
  });
  unsubscribePlatformLoadState = desktopBridge()?.platform?.onLoadState?.((state) => {
    if (!state?.id) return;
    platformLoadStates.value = {
      ...platformLoadStates.value,
      [state.id]: { id: state.id, loading: Boolean(state.loading), loaded: Boolean(state.loaded), failed: Boolean(state.failed) },
    };
  });
  watch(activeView, (view) => window.localStorage.setItem('seagrass:last-view', view), { immediate: true });
  void initializeSession();
});



onBeforeUnmount(() => { unsubscribeAppUpdate?.(); unsubscribeAssistantContext?.(); unsubscribePlatformLoadState?.(); });




function showNotice(message: string) {
  notice.value = message;
  window.setTimeout(() => { notice.value = ''; }, 2200);
}




function saveSystemSettings() {
  void desktopBridge()?.system?.saveSettings({ ...systemSettings.value }).then((saved) => {
    systemSettings.value = { ...systemSettings.value, ...saved };
    showNotice('系统设置已保存');
  }).catch(() => showNotice('系统设置保存失败'));
}




function resetSystemSettings() {
  systemSettings.value = {
    language: '简体中文',
    defaultView: '应用中心',
    openWindowOnLaunch: true,
    launchOnStartup: false,
    sidebarCollapsed: false,
    closeBehavior: '保留在托盘和任务栏中',
  };
  sidebarCollapsed.value = false;
  window.localStorage.setItem('seagrass:sidebar-collapsed', '0');
  void desktopBridge()?.platform?.setSidebarCollapsed?.(false);
  void desktopBridge()?.system?.resetSettings().then((saved) => {
    systemSettings.value = { ...systemSettings.value, ...saved };
    showNotice('已恢复默认设置');
  }).catch(() => showNotice('恢复默认设置失败'));
}




function openProxyForm() {
  proxyForm.value = { name: '', type: 'HTTP/HTTPS', host: '', port: '', username: '', password: '', scope: '个人' };
  proxyFormVisible.value = true;
}




function closeProxyForm() {
  proxyFormVisible.value = false;
}




async function saveProxy() {
  const form = proxyForm.value;
  if (!form.name.trim() || !form.host.trim() || !form.port.trim()) {
    showNotice('请先填写代理名称、地址和端口');
    return;
  }
  try {
    const port = Number.parseInt(form.port, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      showNotice('请输入有效的代理端口');
      return;
    }
    const created = await localBridge().createProxy({
      name: form.name.trim(),
      proxy_type: form.type === 'SOCKS5' ? 'SOCKS5' : 'HTTP',
      host: form.host.trim(),
      port,
      username: form.username.trim() || undefined,
      password: form.password || undefined,
      scope: 'personal',
    });
    proxies.value.unshift(mapProxy(created));
    proxyFormVisible.value = false;
    showNotice('代理已保存到本机');
  } catch {
    showNotice('代理保存失败，请检查网络或权限');
  }
}




async function removeProxy(id: string) {
  try {
    await localBridge().deleteProxy(id);
    proxies.value = proxies.value.filter((proxy) => proxy.id !== id);
    showNotice('代理已从本机移除');
  } catch {
    showNotice('代理删除失败，请稍后重试');
  }
}




async function testProxy(proxy: ProxyItem) {
  showNotice('正在测试 ' + proxy.name + '，请稍候');
  try {
    const result = await localBridge().testProxy(proxy.id);
    const index = proxies.value.findIndex((item) => item.id === proxy.id);
    if (index >= 0) {
      proxies.value[index] = {
        ...proxies.value[index],
        status: result.status === 'healthy' ? '正常' : '异常',
        lastCheck: formatCustomerTime(result.checked_at),
      };
    }
    showNotice(String(result.detail) + (result.latency_ms == null ? '' : ', latency ' + String(result.latency_ms) + ' ms'));
  } catch {
    showNotice('代理测试失败，请检查网络或权限');
  }
}




function callWindowControl(action: 'minimize' | 'toggleMaximize' | 'close') {
  desktopBridge()?.windowControls?.[action]?.();
}




function assistantSuggestionText(suggestion: AssistantSuggestion) {
  return String(suggestion.text || suggestion.reply || suggestion.content || '');
}




function assistantSuggestionMeta(suggestion: AssistantSuggestion, field: 'purpose' | 'rationale') {
  return String(suggestion[field] || '');
}




function assistantSuggestionTitle(suggestion: AssistantSuggestion, index: number) {
  const deepTitles = ['自然接话式', '关心陪伴式', '真诚深入式', '轻松延续式'];
  const quickTitles = ['简洁式', '自然式', '温和式', '跟进式'];
  const fallback = assistantReplyMode.value === 'deep' ? deepTitles[index] : quickTitles[index];
  return String(suggestion.title || fallback || `建议 ${index + 1}`);
}




function changeAssistantReplySettings() {
  assistantGeneration++;
  assistantLoading.value = false;
  window.localStorage.setItem('seagrass:assistant-reply-mode', assistantReplyMode.value);
  window.localStorage.setItem('seagrass:assistant-reply-count', String(assistantReplyCount.value));
  assistantSuggestions.value = [];
  assistantError.value = '';
}




const assistantModelLabel = computed(() => {
  const model = assistantContext.value?.aiModel;
  return String(model?.name || model?.display_name || model?.label || model?.code || 'DeepSeek');
});




const assistantPlatformLabel = computed(() => {
  const context = assistantContext.value;
  if (!context) return '当前平台';
  return [context.platform, context.windowTitle || context.account].filter(Boolean).join(' · ') || '当前平台';
});




function toIpcSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}



function assistantRequestErrorMessage(error: unknown) { return cleanLocalError(error); }



let assistantGeneration = 0;


function assistantContextIdentity(context: AssistantContext | null) {
  return context ? `${context.platformWindowId || ''}:${context.platformContactId || ''}` : '';
}



async function generateAssistantSuggestions() {
  const bridge = desktopBridge()?.assistant;
  if (!bridge || !assistantContext.value) return;
  const generation = ++assistantGeneration;
  const identity = assistantContextIdentity(assistantContext.value);
  assistantLoading.value = true;
  assistantError.value = '';
  assistantSuggestions.value = [];
  try {
    const result = await bridge.suggest({
      // Vue wraps nested values in a Proxy. Electron IPC can only clone
      // plain data, so never pass the reactive message array across it.
      messages: toIpcSafe(assistantContext.value.messages || []),
      customerName: assistantContext.value.customerName,
      customerLanguage: assistantContext.value.customerLanguage,
      outputLanguage: assistantContext.value.outputLanguage,
      translationLanguage: assistantContext.value.translationLanguage || 'zh',
      goal: assistantGoal.value.trim() || null,
      replyMode: assistantReplyMode.value,
      count: assistantReplyCount.value,
    });
    if (generation !== assistantGeneration || identity !== assistantContextIdentity(assistantContext.value)) return;
    assistantSuggestions.value = Array.isArray(result?.suggestions) ? result.suggestions : [];
    if (result.imageCount) showNotice(`已结合当前聊天的 ${result.imageCount} 张图片生成建议`);
    if (!assistantSuggestions.value.length) assistantError.value = 'AI 暂时没有生成可用建议，请重试';
  } catch (error) {
    if (generation === assistantGeneration) assistantError.value = assistantRequestErrorMessage(error);
  } finally {
    if (generation === assistantGeneration) assistantLoading.value = false;
  }
}




async function copyAssistantSuggestion(suggestion: AssistantSuggestion) {
  const text = assistantSuggestionText(suggestion);
  if (!text) return;
  const result = await desktopBridge()?.assistant?.copyToComposer({
    platformWindowId: assistantContext.value?.platformWindowId,
    platformContactId: assistantContext.value?.platformContactId,
    text,
    originalText: String(suggestion.translation || ''),
  }).catch(() => ({ ok: false }));
  showNotice(result?.ok === false ? '暂时无法写入平台输入框' : '建议已复制到输入框，可修改后发送');
}



function isQuickReplyManageable(_group: QuickReplyGroupItem) { return true; }




function quickReplySearchMatch(group: QuickReplyGroupItem) {
  const q = quickReplyGroupSearch.value.trim().toLowerCase();
  if (!q) return true;
  if (group.name.toLowerCase().includes(q)) return true;
  if (group.kind === 'phrase') return (group.phrases || []).some((item) => item.content.toLowerCase().includes(q));
  return (group.images || []).some((item) => item.name.toLowerCase().includes(q));
}




const filteredQuickReplyGroups = computed(() => quickReplyGroups.value.filter(
  (group) => group.kind === quickReplyTab.value && quickReplySearchMatch(group),
));




const activeQuickReplyGroup = computed(() => filteredQuickReplyGroups.value.find(
  (group) => group.id === quickReplyExpandedGroupId.value,
) || filteredQuickReplyGroups.value[0] || null);




function quickReplyGroupItemCount(group: QuickReplyGroupItem) {
  const items = group.kind === 'phrase' ? group.phrases : group.images;
  return items ? items.length : null;
}




function quickReplyImageSource(image: { imageDataUrl?: string; imagePath?: string }) {
  if (image.imageDataUrl) return image.imageDataUrl;
  if (image.imagePath) return `file:///${image.imagePath.replace(/\\/g, '/')}`;
  return '';
}




function selectQuickReplyTab(tab: 'phrase' | 'image') {
  quickReplyTab.value = tab;
  quickReplyManageVisible.value = false;
  quickReplyManageKind.value = tab;
  quickReplyManageMode.value = 'group';
  quickReplyEditingGroupId.value = '';
  quickReplyNewPhrase.value = '';
  quickReplyNewImageName.value = '';
  quickReplyNewImageDataUrl.value = '';
  quickReplyGroupSearch.value = '';
  const first = quickReplyGroups.value.find((group) => group.kind === tab);
  quickReplyExpandedGroupId.value = first?.id || '';
  if (first) void loadQuickReplyGroupDetail(first.id);
}




function selectQuickReplyGroup(group: QuickReplyGroupItem) {
  quickReplyExpandedGroupId.value = group.id;
  void loadQuickReplyGroupDetail(group.id);
}



async function loadQuickReplyGroups() {
   quickReplyGroups.value = readLocalQuickReplyGroups();
   const selected = quickReplyGroups.value.find(group => group.id === quickReplyExpandedGroupId.value && group.kind === quickReplyTab.value) || quickReplyGroups.value.find(group => group.kind === quickReplyTab.value);
   quickReplyExpandedGroupId.value = selected?.id || '';
 }



async function loadQuickReplyGroupDetail(_groupId: string) { /* Local groups already contain their content. */ }




async function insertQuickReplyPhrase(group: QuickReplyGroupItem, phrase: { id: string; content: string }) {
  const result = await desktopBridge()?.assistant?.copyToComposer({
    platformWindowId: assistantContext.value?.platformWindowId,
    text: phrase.content,
    originalText: '',
  }).catch(() => ({ ok: false }));
  showNotice(result?.ok === false ? '暂时无法写入平台输入框' : '话术已插入输入框');
}




async function insertQuickReplyImage(group: QuickReplyGroupItem, image: { id: string; name: string; imageDataUrl?: string; imagePath?: string }) {
  const result = await desktopBridge()?.assistant?.copyToComposer({
    platformWindowId: assistantContext.value?.platformWindowId,
    imageDataUrl: image.imageDataUrl,
    imagePath: image.imagePath,
  }).catch(() => ({ ok: false }));
  showNotice(result?.ok === false ? '暂时无法打开图片预览，请重试' : '图片已放入发送预览，可继续编辑后发送');
}




function openQuickReplyAdd(group: QuickReplyGroupItem | null) {
  quickReplyManageKind.value = quickReplyTab.value;
  quickReplyManageMode.value = group ? 'content' : 'group';
  quickReplyManageVisible.value = true;
  quickReplyNewGroupName.value = '';
  quickReplyNewPhrase.value = '';
  quickReplyNewImageName.value = '';
  quickReplyNewImageDataUrl.value = '';
  quickReplyPendingImages.value = [];
  quickReplyEditingGroupId.value = group?.id || '';
}




function closeQuickReplyManage() {
  quickReplyManageVisible.value = false;
}




async function createQuickReplyGroup() {
  const name = quickReplyNewGroupName.value.trim();
  if (!name) {
    showNotice('请输入分组名称');
    return;
  }
  try {
    const created: QuickReplyGroupItem = { id: newLocalId('group'), kind: quickReplyManageKind.value, name, scope: 'personal', ownerMemberId: currentMemberId.value, assignedMemberIds: [], phrases: [], images: [] };
    quickReplyGroups.value.push(created);
    writeLocalQuickReplyGroups(readLocalQuickReplyGroups().concat(created));
    quickReplyNewGroupName.value = '';
    quickReplyEditingGroupId.value = created.id;
    quickReplyExpandedGroupId.value = created.id;
    quickReplyManageMode.value = 'content';
    showNotice('分组已创建');
  } catch (error: unknown) {
    showNotice(error instanceof Error ? error.message : '创建分组失败');
  }
}




async function saveQuickReplyPhrase() {
  const contents = quickReplyNewPhrase.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const groupId = quickReplyEditingGroupId.value;
  if (!contents.length) {
    showNotice('请输入话术内容');
    return;
  }
  if (!groupId) {
    showNotice('请先选择分组');
    return;
  }
  try {
    const group = quickReplyGroups.value.find((item) => item.id === groupId);
    if (!group) return;
    {
      group.phrases = [...(group.phrases || []), ...contents.map((content) => ({ id: newLocalId('phrase'), content }))];
      writeLocalQuickReplyGroups(readLocalQuickReplyGroups().map((item) => item.id === group.id ? group : item));
    }
    quickReplyNewPhrase.value = '';
    closeQuickReplyManage();
    showNotice('话术已添加');
  } catch (error: unknown) {
    showNotice(error instanceof Error ? error.message : '添加话术失败');
  }
}




function onQuickReplyImagePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  quickReplyPendingImages.value = [];
  let remaining = files.length;
  files.forEach((file) => {
    const path = (file as File & { path?: string }).path || '';
    const reader = new FileReader();
    reader.onload = () => {
      quickReplyPendingImages.value = [...quickReplyPendingImages.value, { name: file.name.replace(/\.[^.]+$/, ''), path, dataUrl: String(reader.result || '') }];
      remaining -= 1;
      if (!remaining) {
        const first = quickReplyPendingImages.value[0];
        quickReplyNewImagePath.value = first?.path || '';
        quickReplyNewImageDataUrl.value = first?.dataUrl || '';
      }
    };
    reader.readAsDataURL(file);
  });
}




async function saveQuickReplyImage() {
  const name = quickReplyNewImageName.value.trim();
  const groupId = quickReplyEditingGroupId.value;
  if (!groupId) {
    showNotice('请先选择分组');
    return;
  }
  if (!quickReplyNewImageDataUrl.value && !quickReplyPendingImages.value.length) {
    showNotice('请选择图片');
    return;
  }
  try {
    const group = quickReplyGroups.value.find((item) => item.id === groupId);
    if (!group) return;
    const items = quickReplyPendingImages.value.length ? quickReplyPendingImages.value : [{ name: name || '图片', path: quickReplyNewImagePath.value, dataUrl: quickReplyNewImageDataUrl.value }];
    {
      group.images = [...(group.images || []), ...items.map((item) => item.path
        ? { id: newLocalId('image'), name: name || item.name, imagePath: item.path, imageDataUrl: item.dataUrl }
        : { id: newLocalId('image'), name: name || item.name, imageDataUrl: item.dataUrl })];
      writeLocalQuickReplyGroups(readLocalQuickReplyGroups().map((item) => item.id === group.id ? group : item));
    }
    quickReplyNewImageName.value = '';
    quickReplyNewImageDataUrl.value = '';
    quickReplyNewImagePath.value = '';
    quickReplyPendingImages.value = [];
    closeQuickReplyManage();
    showNotice('图片已添加');
  } catch (error: unknown) {
    showNotice(error instanceof Error ? error.message : '添加图片失败');
  }
}




async function deleteQuickReplyPhrase(group: QuickReplyGroupItem, phraseId: string) {
  try {
    
    group.phrases = (group.phrases || []).filter((item) => item.id !== phraseId);
    if (group.scope === 'personal') writeLocalQuickReplyGroups(readLocalQuickReplyGroups().map((item) => item.id === group.id ? group : item));
    showNotice('话术已删除');
  } catch (error: unknown) {
    showNotice(error instanceof Error ? error.message : '删除话术失败');
  }
}




async function deleteQuickReplyImage(group: QuickReplyGroupItem, imageId: string) {
  try {
    
    group.images = (group.images || []).filter((item) => item.id !== imageId);
    if (group.scope === 'personal') writeLocalQuickReplyGroups(readLocalQuickReplyGroups().map((item) => item.id === group.id ? group : item));
    showNotice('图片已删除');
  } catch (error: unknown) {
    showNotice(error instanceof Error ? error.message : '删除图片失败');
  }
}




async function deleteQuickReplyGroup(group: QuickReplyGroupItem) {
  try {
    
    quickReplyGroups.value = quickReplyGroups.value.filter((item) => item.id !== group.id);
    if (group.scope === 'personal') writeLocalQuickReplyGroups(readLocalQuickReplyGroups().filter((item) => item.id !== group.id));
    if (quickReplyExpandedGroupId.value === group.id) quickReplyExpandedGroupId.value = '';
    showNotice('分组已删除');
  } catch (error: unknown) {
    showNotice(error instanceof Error ? error.message : '删除分组失败');
  }
}




function closeInlineAssistant() {
  void desktopBridge()?.assistant?.hide();
}
</script>
<template>
  <div class="app-shell">
    
    
    <header class="topbar">
      <div class="brand-block">
        <LogoMark class="brand-mark" aria-label="海草 Logo" />
        <div class="brand-copy">
          <strong>海草跨境助手</strong>
          <span>SEAGRASS ASSISTANT</span>
        </div>
      </div>

      <div class="tabbar" role="tablist" aria-label="平台标签页">
        <div ref="tabScroller" class="tab-scroller" @wheel="handleTabWheel">
          <div
            v-for="tab in tabs"
            :key="tab.id"
            class="app-tab"
            :class="{
              active: activeTabId === tab.id,
              dragging: draggingTabId === tab.id,
              'drag-before': dragTargetTabId === tab.id && dragTargetSide === 'before',
              'drag-after': dragTargetTabId === tab.id && dragTargetSide === 'after',
            }"
            role="tab"
            tabindex="0"
            draggable="true"
            :data-platform-tab-id="tab.id"
            :title="`拖动调整“${tab.title}”的位置`"
            @click="selectTab(tab)"
            @keydown.enter="selectTab(tab)"
            @dragstart="startTabDrag($event, tab)"
            @dragover="markTabDragTarget($event, tab)"
            @drop="finishTabDrop($event, tab)"
            @dragend="endTabDrag"
          >
            <PlatformIcon :platform="tab.platform!" :small="true" />
            <span>{{ tab.title }}</span>
            <button class="tab-settings-trigger" type="button" aria-label="窗口翻译设置" @click.stop="openWindowTranslationSettings(tab)"><UiIcon name="settings" /></button>
            <UiIcon name="close" class="tab-close" @click.stop="closeTab(tab)" />
          </div>
        </div>
        <button class="tab-overview-trigger" :class="{ active: tabOverviewOpen }" type="button" title="查看全部窗口" aria-label="查看全部窗口" @click.stop="toggleTabOverview">
          <UiIcon name="tabs" />
          <span>{{ tabs.length }}</span>
        </button>
        <button v-if="tabOverviewOpen" class="tab-overview-backdrop" type="button" aria-label="关闭窗口列表" @click="closeTabOverview()"></button>
        <section v-if="tabOverviewOpen" class="tab-overview-menu" aria-label="全部窗口">
          <header><strong>全部窗口</strong><span>{{ tabs.length }}</span></header>
          <div>
            <button
              v-for="tab in tabs"
              :key="`overview-${tab.id}`"
              type="button"
              draggable="true"
              :class="{
                active: activeTabId === tab.id,
                dragging: draggingTabId === tab.id,
                'drag-before': dragTargetTabId === tab.id && dragTargetSide === 'before',
                'drag-after': dragTargetTabId === tab.id && dragTargetSide === 'after',
              }"
              @click="selectTabFromOverview(tab)"
              @dragstart="startTabDrag($event, tab)"
              @dragover="markOverviewDragTarget($event, tab)"
              @drop.stop="finishTabDrop($event, tab)"
              @dragend="endTabDrag"
            >
              <PlatformIcon :platform="tab.platform!" :small="true" />
              <span>{{ tab.title }}</span>
              <i></i>
            </button>
          </div>
        </section>
      </div>

      <div class="window-actions" aria-label="窗口控制">
        <button class="window-control" type="button" aria-label="最小化" @click="callWindowControl('minimize')">−</button>
        <button class="window-control" type="button" aria-label="最大化" @click="callWindowControl('toggleMaximize')"><span class="window-square"></span></button>
        <button class="window-control close" type="button" aria-label="关闭" @click="callWindowControl('close')">×</button>
      </div>
    </header>

    <div class="app-body" :class="{ 'sidebar-is-collapsed': sidebarCollapsed }">
      <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <nav class="side-nav">
          <button
            class="sidebar-collapse-button"
            type="button"
            :aria-label="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
            :title="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
            @click="toggleSidebar"
          >
            <UiIcon name="chevron" />
          </button>
          <button
            v-for="item in navItems"
            :key="`${item.key}-${item.label}`"
            type="button"
            class="nav-item"
            :class="{ active: activeView === item.key && (item.key !== 'settings' || activeTabId === '') }"
            :aria-label="item.label"
            :title="sidebarCollapsed ? item.label : undefined"
            @click="selectNav(item)"
          >
            <UiIcon :name="item.icon" />
            <span>{{ item.label }}</span>
          </button>
        </nav>
        <div v-show="!sidebarCollapsed" class="sidebar-bottom">
          
          <section class="sidebar-info" aria-label="应用信息">
            <div class="sidebar-info-heading"><span>海草助手</span><i class="sidebar-info-dot" :class="`status-${appUpdateState.status}`" :title="appUpdateStatusHint()"></i></div>
            <div class="sidebar-info-row"><span>版本</span><strong>v{{ appVersion }}</strong></div>
            <button
              class="sidebar-update-button"
              type="button"
              :disabled="['checking', 'downloading', 'installing'].includes(appUpdateState.status)"
              @click="handleAppUpdate"
            >
              <span>{{ appUpdateButtonLabel() }}</span>
              <span v-if="appUpdateState.status === 'available' || appUpdateState.status === 'downloaded'" aria-hidden="true">›</span>
            </button>
            <div v-if="appUpdateState.status === 'downloading'" class="sidebar-download-track" aria-hidden="true">
              <i :style="{ width: `${Math.max(0, Math.min(100, appUpdateState.progress || 0))}%` }"></i>
            </div>
            <div class="sidebar-balance local-sidebar-balance"><span>DeepSeek</span><strong>{{ balanceSummary }}</strong></div>
          </section>
        </div>
      </aside>

      <main class="main-content">
        <section v-if="activeView === 'home'" class="page home-page">
          <div class="page-heading">
            <div>
              <h1>应用中心</h1>
            </div>
            <button class="secondary-button" type="button" @click="showNotice('新增平台功能正在完善')">
              <UiIcon name="plus" /> 添加平台
            </button>
          </div>

          <div class="home-workspace">
            <section class="platform-section">
              <div class="section-caption">
                <span>已接入平台</span>
                <span class="caption-note">模块版本独立更新</span>
              </div>
              <div class="platform-grid">
                <article v-for="card in platformCards" :key="card.platform" class="platform-card">
                  <PlatformIcon :platform="card.platform" />
                  <div class="platform-card-content">
                    <h2>{{ platformDisplayLabel(card.platform) }}</h2>
                    <div class="platform-card-meta">
                      <div class="meta-line">模块版本：v{{ card.version }}</div>
                      <div class="platform-version-state" :class="{ available: platformHasUpdate(card) }">
                        <i></i>
                        <span>{{ platformHasUpdate(card) ? '有更新' : '已是最新版本' }}</span>
                        <small v-if="platformHasUpdate(card)">v{{ card.latestVersion }}</small>
                      </div>
                    </div>
                  </div>
                  <div class="platform-card-actions">
                    <button class="outline-button" type="button" @click="handlePlatformCard(card)">{{ ctaLabel() }}</button>
                    <button v-if="platformHasUpdate(card)" class="update-button" type="button" @click="updatePlatformModule(card)">更新</button>
                  </div>
                </article>
              </div>
            </section>

            <aside class="running-section">
              <div class="section-caption">
                <span>已创建的窗口</span>
                <span class="running-count">{{ createdWindows.length }}</span>
              </div>
              <div class="running-list">
                <article v-for="app in createdWindows" :key="app.tabId" class="running-card">
                  <div class="running-card-main">
                    <PlatformIcon :platform="app.platform" />
                    <div class="running-copy">
                      <strong>{{ app.name }}</strong>
                      <div><i class="status-dot"></i><span>{{ app.status }}</span><em></em><span>{{ app.mode }}</span></div>
                    </div>
                  </div>
                  <div class="running-actions">
                    <button class="mini-button" type="button" @click="switchRunning(app.tabId)">打开</button>
                    <button class="mini-button" type="button" @click="editRunningWindow(app.tabId)">设置</button>
                    <button class="mini-button danger" type="button" @click="deleteRunningWindow(app.tabId)">删除</button>
                  </div>
                </article>
              </div>
            </aside>
          </div>
        </section>

        

        <section v-else-if="activeView === 'platform'" class="page platform-page">
          <div v-if="activePlatformLoading" class="platform-loading" aria-label="平台页面加载中">
            <span class="platform-loading-spinner" aria-hidden="true"></span>
            <strong>正在打开 {{ activePlatformTab?.platform ?? '平台' }}…</strong>
            <small>首次打开需要加载页面，请稍候</small>
          </div>
          <div v-else class="platform-workspace"><p class="local-note">平台窗口正在准备。如果未显示，请从应用中心重新打开。</p></div>
        </section>

        <LocalAccount v-else-if="activeView === 'accounts'" @configure="selectNav(navItems.find(item => item.key === 'settings')!)" />

        <section v-else-if="activeView === 'connections'" class="page proxy-page">
          <div class="page-heading">
            <div>
              <h1>代理</h1>
            </div>
            <button class="primary-button" type="button" @click="openProxyForm"><UiIcon name="plus" />添加代理</button>
          </div>

          <section v-if="proxyFormVisible" class="proxy-editor">
             <div class="panel-heading"><div><h2>添加代理</h2><p>代理信息仅用于应用窗口连接，不会自动分配给平台账号。</p></div><button class="icon-button" type="button" @click="closeProxyForm">×</button></div>
            <div class="proxy-form-grid">
              <label class="form-field"><span>代理名称</span><input v-model="proxyForm.name" placeholder="例如：美国客服线路" /></label>
              <label class="form-field"><span>代理类型</span><select v-model="proxyForm.type"><option>HTTP/HTTPS</option><option>SOCKS5</option></select></label>
               
              <label class="form-field"><span>IP 地址 / 域名</span><input v-model="proxyForm.host" placeholder="请输入代理地址" /></label>
              <label class="form-field"><span>端口</span><input v-model="proxyForm.port" placeholder="例如：8080" /></label>
               <label class="form-field"><span>代理账号（选填）</span><input v-model="proxyForm.username" placeholder="选填" /></label>
               <label class="form-field"><span>代理密码（选填）</span><input v-model="proxyForm.password" type="password" placeholder="选填" /></label>
            </div>
              
             <div class="proxy-editor-actions"><button class="secondary-button" type="button" @click="closeProxyForm">取消</button><button class="primary-button" type="button" @click="saveProxy">保存代理</button></div>
          </section>

          <section class="proxy-panel">
             <div class="panel-heading"><div><h2>代理列表</h2><p>已添加 {{ proxies.length }} 条代理线路，仅保存在本机，可在创建应用窗口时选择。</p></div><button class="secondary-button" type="button" @click="proxies.forEach(testProxy)">全部测试</button></div>
            <div class="proxy-list">
              <article v-for="proxy in proxies" :key="proxy.id" class="proxy-row">
              <div class="proxy-row-main"><span class="proxy-status" :class="proxy.status === '正常' ? 'ok' : 'error'"></span><div><strong>{{ proxy.name }}</strong><small>{{ proxy.type }} · {{ proxy.host }}:{{ proxy.port }}</small></div></div>
                 <div class="proxy-row-use"><span>当前使用</span><strong>{{ proxy.usedBy }}</strong><small class="proxy-scope private">仅本机</small></div>
              <div class="proxy-row-check"><span :class="proxy.status === '正常' ? 'status-ok' : 'status-error'">{{ proxy.status }}</span><small>检测于 {{ proxy.lastCheck }}</small></div>
                <div class="proxy-row-actions"><button class="table-action" type="button" @click="testProxy(proxy)">测试连接</button><button v-if="canManageProxies" class="table-action danger" type="button" @click="removeProxy(proxy.id)">删除</button></div>
              </article>
               <div v-if="proxies.length === 0" class="empty-state"><UiIcon name="proxy" /><strong>还没有代理</strong><span>添加一条代理线路后，可在创建应用窗口时选择。</span><button class="primary-button" type="button" @click="openProxyForm">添加代理</button></div>
            </div>
          </section>
        </section>

        

        <section v-else-if="activeView === 'settings'" class="page settings-page">
          <div class="page-heading">
            <div>
              <h1>系统设置</h1>
            </div>
          </div>

          <section class="settings-panel">
            <LocalAiSettings />
            <div class="settings-section">
              <h2>基础设置</h2>
              <label class="settings-row">
                <span>语言设置</span>
                <select v-model="systemSettings.language"><option>简体中文</option><option>English</option></select>
              </label>
              <label class="settings-row">
                <span>默认显示页面</span>
                <select v-model="systemSettings.defaultView"><option>应用中心</option><option>上次打开页面</option></select>
              </label>
              <label class="settings-row">
                <span>关闭窗口操作</span>
                <select v-model="systemSettings.closeBehavior"><option>保留在托盘和任务栏中</option><option>最小化到托盘</option><option>直接退出应用</option></select>
              </label>
            </div>
            <div class="settings-section">
              <h2>启动设置</h2>
              <label class="settings-check"><input v-model="systemSettings.openWindowOnLaunch" type="checkbox" /><span>打开应用时自动打开所有已创建的应用窗口</span></label>
              <label class="settings-check"><input v-model="systemSettings.launchOnStartup" type="checkbox" /><span>开机启动海草跨境助手</span></label>
            </div>
            <footer class="settings-footer">
              <button class="secondary-button" type="button" @click="resetSystemSettings">恢复默认</button>
              <button class="primary-button" type="button" @click="saveSystemSettings">保存设置</button>
            </footer>
          </section>
        </section>

        <section v-else class="page simple-page">
          <div class="page-heading"><div><h1>系统设置</h1><p>配置应用启动、显示和窗口行为。</p></div></div>
          <div class="simple-card"><div class="simple-icon"><UiIcon name="settings" /></div><div><h2>功能模块正在接入</h2><p>应用中心和平台窗口已经准备好。</p></div></div>
        </section>
      </main>
    </div>

    <section
      v-if="assistantPanelVisible"
      class="assistant-inline-panel"
      :class="{ 'assistant-has-ai-results': assistantMode === 'ai' && assistantSuggestions.length > 0 }"
      aria-label="智能回复"
    >
      <header class="assistant-inline-header">
        <div class="assistant-inline-title">
          <span class="assistant-title-icon"><UiIcon name="sparkle" /></span>
          <span class="assistant-title-copy"><strong>智能回复</strong><small>{{ assistantPlatformLabel }}</small></span>
        </div>
        <nav class="assistant-mode-tabs" aria-label="回复方式">
          <button type="button" :class="{ active: assistantMode === 'ai' }" @click="assistantMode = 'ai'">AI 建议</button>
          <button type="button" :class="{ active: assistantMode === 'quick' }" @click="assistantMode = 'quick'">快捷回复</button>
        </nav>
        <div class="assistant-header-actions">
          <span v-if="assistantMode === 'ai'" class="assistant-model-chip"><i></i>{{ assistantModelLabel }}</span>
          <button class="assistant-inline-close" type="button" aria-label="关闭智能回复" @click="closeInlineAssistant">×</button>
        </div>
      </header>

      <template v-if="assistantMode === 'ai'">
        <div class="assistant-ai-workspace">
          <div class="assistant-inline-toolbar">
            <label class="assistant-goal-field">
              <span>这次希望 AI 帮你完成什么？</span>
              <input v-model="assistantGoal" placeholder="例如：回应对方分享的照片，像朋友聊天" @keyup.enter="generateAssistantSuggestions" />
            </label>
            <div class="assistant-generation-options" aria-label="生成设置">
              <label class="assistant-reply-mode-field">
                <span>回复模式</span>
                <select v-model="assistantReplyMode" aria-label="回复模式" :disabled="assistantLoading" @change="changeAssistantReplySettings">
                  <option value="quick">快速回复</option>
                  <option value="deep">精聊回复</option>
                </select>
              </label>
              <label class="assistant-reply-count-field">
                <span>建议数量</span>
                <select v-model.number="assistantReplyCount" aria-label="建议数量" :disabled="assistantLoading" @change="changeAssistantReplySettings">
                  <option :value="1">1 条</option>
                  <option :value="2">2 条</option>
                  <option :value="3">3 条</option>
                  <option :value="4">4 条</option>
                </select>
              </label>
            </div>
            <button class="assistant-generate-button" type="button" :disabled="assistantLoading" @click="generateAssistantSuggestions">{{ assistantLoading ? '正在生成…' : `生成${assistantReplyCount}条建议` }}</button>
          </div>
          <div class="assistant-inline-body">
            <div v-if="assistantLoading" class="assistant-inline-state assistant-loading-state"><span></span><strong>正在阅读当前对话</strong><small>{{ assistantReplyMode === 'deep' ? `正在学习你在当前聊天中的表达方式，并生成${assistantReplyCount}条建议` : `通常几秒钟即可生成${assistantReplyCount}条建议` }}</small></div>
            <div v-else-if="assistantError" class="assistant-inline-state error"><strong>暂时无法生成建议</strong><small>{{ assistantError }}</small><button type="button" @click="generateAssistantSuggestions">重新生成</button></div>
            <div v-else-if="!assistantSuggestions.length" class="assistant-inline-state assistant-empty-state"><span class="assistant-empty-icon"><UiIcon name="sparkle" /></span><strong>准备好后，生成 {{ assistantReplyCount }} 条{{ assistantReplyMode === 'deep' ? '精聊' : '快速' }}建议</strong><small>{{ assistantReplyMode === 'deep' ? '会区分客户与我的消息，并参考我在当前对话中的聊天风格' : 'AI 仅读取当前对话，不会替你自动发送' }}</small></div>
            <template v-else>
              <div class="assistant-results-heading"><span><strong>建议回复</strong><small>{{ assistantReplyMode === 'deep' ? '按不同交流深度生成，可先核对译文再插入' : '结合当前对话生成，可先核对译文再插入' }}</small></span><button type="button" @click="generateAssistantSuggestions">重新生成</button></div>
              <div class="assistant-inline-suggestion-grid" :class="`count-${Math.min(assistantSuggestions.length, 4)}`">
                <article v-for="(suggestion, index) in assistantSuggestions" :key="`${index}-${assistantSuggestionText(suggestion)}`" class="assistant-inline-card" :class="{ primary: index === 0 }">
                  <div class="assistant-card-heading">
                    <span><strong>{{ assistantSuggestionTitle(suggestion, index) }}</strong><em v-if="assistantSuggestionMeta(suggestion, 'purpose')">{{ assistantSuggestionMeta(suggestion, 'purpose') }}</em></span>
                    <button type="button" @click="copyAssistantSuggestion(suggestion)">插入输入框</button>
                  </div>
                  <p>{{ assistantSuggestionText(suggestion) }}</p>
                  <div v-if="suggestion.translation" class="assistant-translation"><strong>译文</strong><span>{{ suggestion.translation }}</span></div>
                  <small v-if="assistantSuggestionMeta(suggestion, 'rationale')" class="assistant-rationale">依据：{{ assistantSuggestionMeta(suggestion, 'rationale') }}</small>
                </article>
              </div>
            </template>
          </div>
        </div>
      </template>

      <div v-else class="quick-reply-panel">
        <aside class="quick-reply-sidebar">
          <label class="quick-reply-search"><span class="sr-only">搜索分组或回复内容</span><input v-model.trim="quickReplyGroupSearch" placeholder="搜索分组或回复内容" /></label>
          <div class="quick-reply-tabs">
            <button type="button" :class="{ active: quickReplyTab === 'phrase' }" @click="selectQuickReplyTab('phrase')">话术</button>
            <button type="button" :class="{ active: quickReplyTab === 'image' }" @click="selectQuickReplyTab('image')">图片</button>
          </div>
          <div v-if="quickReplyLoading" class="quick-reply-sidebar-state">正在加载…</div>
          <template v-else>
            <div class="quick-reply-group-heading"><strong>分组</strong><button type="button" @click="openQuickReplyAdd(null)">＋ 新建</button></div>
            <div v-if="filteredQuickReplyGroups.length" class="quick-reply-group-chips">
              <button v-for="group in filteredQuickReplyGroups" :key="group.id" type="button" :class="{ active: activeQuickReplyGroup?.id === group.id }" @click="selectQuickReplyGroup(group)">
                <span>{{ group.name }}</span><small>{{ quickReplyGroupItemCount(group) ?? '…' }}</small>
              </button>
            </div>
            <div v-else class="quick-reply-sidebar-state">还没有分组</div>
          </template>
        </aside>

        <main class="quick-reply-content">
          <div v-if="quickReplyManageVisible" class="quick-reply-manage-inline">
            <div class="quick-reply-manage-heading"><span><strong>{{ quickReplyManageMode === 'content' ? `添加到「${activeQuickReplyGroup?.name || ''}」` : `新建${quickReplyManageKind === 'phrase' ? '话术' : '图片'}分组` }}</strong><small>{{ quickReplyManageMode === 'content' ? '填好后点击下方按钮即可保存' : '分组建好后即可继续添加内容' }}</small></span></div>
            <div v-if="quickReplyManageMode === 'group'" class="quick-reply-manage-create-row">
              <input v-model.trim="quickReplyNewGroupName" :placeholder="`新建${quickReplyManageKind === 'phrase' ? '话术' : '图片'}分组名称`" @keyup.enter="createQuickReplyGroup" />
              <button class="quick-reply-manage-button primary" type="button" @click="createQuickReplyGroup">创建分组</button>
            </div>
            <template v-if="quickReplyManageMode === 'content' && quickReplyEditingGroupId">
              <div v-if="quickReplyManageKind === 'phrase'" class="quick-reply-manage-add"><textarea v-model.trim="quickReplyNewPhrase" rows="7" placeholder="每行一条话术，可一次添加多条"></textarea><button class="quick-reply-manage-button primary" type="button" @click="saveQuickReplyPhrase">添加话术</button></div>
              <div v-else class="quick-reply-manage-add"><div class="quick-reply-manage-image-row"><input v-model.trim="quickReplyNewImageName" placeholder="图片名称（可不填，自动使用文件名）" /><label class="quick-reply-manage-file"><input type="file" accept="image/*" multiple @change="onQuickReplyImagePicked" />选择图片（可多选）</label></div><div v-if="quickReplyPendingImages.length" class="quick-reply-manage-tip">已选择 {{ quickReplyPendingImages.length }} 张图片</div><div v-if="quickReplyNewImageDataUrl" class="quick-reply-manage-preview"><img :src="quickReplyNewImageDataUrl" alt="预览" /></div><button class="quick-reply-manage-button primary" type="button" @click="saveQuickReplyImage">添加图片</button></div>
            </template>
            <p v-else-if="quickReplyManageMode === 'group'" class="quick-reply-manage-tip">创建后会自动进入新分组，不需要再次选择分组。</p>
          </div>
          <div v-else-if="quickReplyLoading" class="assistant-inline-state">正在加载快捷回复…</div>
          <div v-else-if="!filteredQuickReplyGroups.length" class="assistant-inline-state assistant-empty-state"><strong>还没有{{ quickReplyTab === 'phrase' ? '话术' : '图片' }}分组</strong><small>创建分组后，常用内容会集中显示在这里</small><button type="button" @click="openQuickReplyAdd(null)">新建分组</button></div>
          <template v-else-if="activeQuickReplyGroup">
            <header class="quick-reply-content-header">
              <span><strong>{{ activeQuickReplyGroup.name }}</strong><small>{{ quickReplyGroupItemCount(activeQuickReplyGroup) ?? 0 }} 条{{ quickReplyTab === 'phrase' ? '话术' : '图片' }} · 仅本机可见</small></span>
              <div><button v-if="activeQuickReplyGroup.scope === 'personal' || isQuickReplyManageable(activeQuickReplyGroup)" class="danger" type="button" @click="deleteQuickReplyGroup(activeQuickReplyGroup)">删除分组</button><button class="primary" type="button" @click="openQuickReplyAdd(activeQuickReplyGroup)">＋ 添加{{ quickReplyTab === 'phrase' ? '话术' : '图片' }}</button></div>
            </header>
            <div class="quick-reply-group-list">
              <template v-if="activeQuickReplyGroup.kind === 'phrase'">
                <div v-if="!(activeQuickReplyGroup.phrases || []).length" class="assistant-inline-state assistant-empty-state"><strong>该分组还没有话术</strong><small>添加常用回复后，可一键插入当前输入框</small></div>
                <article v-for="phrase in activeQuickReplyGroup.phrases || []" :key="phrase.id" class="quick-reply-item">
                  <p>{{ phrase.content }}</p><div class="quick-reply-item-actions"><button type="button" @click="insertQuickReplyPhrase(activeQuickReplyGroup, phrase)">插入</button><button v-if="isQuickReplyManageable(activeQuickReplyGroup)" class="danger" type="button" @click="deleteQuickReplyPhrase(activeQuickReplyGroup, phrase.id)">删除</button></div>
                </article>
              </template>
              <template v-else>
                <div v-if="!(activeQuickReplyGroup.images || []).length" class="assistant-inline-state assistant-empty-state"><strong>该分组还没有图片</strong><small>添加产品图或报价图后，可直接插入对话</small></div>
                <article v-for="image in activeQuickReplyGroup.images || []" :key="image.id" class="quick-reply-item quick-reply-image-item"><div class="quick-reply-image-thumb"><img :src="quickReplyImageSource(image)" :alt="image.name" /></div><div class="quick-reply-item-meta"><strong>{{ image.name }}</strong></div><div class="quick-reply-item-actions"><button type="button" @click="insertQuickReplyImage(activeQuickReplyGroup, image)">插入</button><button v-if="isQuickReplyManageable(activeQuickReplyGroup)" class="danger" type="button" @click="deleteQuickReplyImage(activeQuickReplyGroup, image.id)">删除</button></div></article>
              </template>
            </div>
          </template>
        </main>
      </div>
      <footer class="assistant-inline-footer"><span>{{ assistantMode === 'ai' ? '生成时读取当前对话及最近 4 张已加载图片 · 不自动发送' : '本机话术 · 插入后仍可编辑' }}</span><span>DeepSeek {{ balanceSummary }}</span></footer>
    </section>

    

    <div v-if="windowSettingsVisible && windowSettingsTab" class="modal-backdrop window-settings-backdrop" @click.self="() => closeWindowTranslationSettings()">
      <section class="window-settings-modal" role="dialog" aria-modal="true" aria-label="窗口翻译设置">
        <header class="modal-header window-settings-header">
          <div class="window-settings-title"><strong>窗口翻译设置</strong><small>未单独设置的客户将使用这里的默认规则</small></div>
          <button class="modal-close window-settings-close" type="button" aria-label="关闭" @click.stop.prevent="() => closeWindowTranslationSettings()">×</button>
        </header>
        <div class="window-settings-body">
          <section class="window-settings-section translation-service-section">
            <div class="window-settings-section-heading">
              <div class="window-settings-section-title"><span class="settings-section-icon service"><UiIcon name="link" /></span><h2>翻译服务</h2></div>
              <button class="translation-inline-test" type="button" :disabled="translationTestState === 'testing'" @click="testWindowTranslation">{{ translationTestState === 'testing' ? '测试中…' : '测试翻译' }}</button>
            </div>
            <div class="window-settings-grid two-columns translation-service-fields">
              <label class="window-form-field"><span>AI 翻译模型</span><select v-model="windowSettingsDraft.provider"><option value="deepseek">DeepSeek</option></select><small class="window-form-hint">当前模型：{{ localSettings.model }}</small></label>
              <label class="window-form-field"><span>翻译线路</span><select v-model="windowSettingsDraft.route"><option value="default-1">默认线路</option></select></label>
            </div>
            <div v-if="translationTestState === 'success'" class="translation-test-result success">当前翻译服务可用</div>
            <div v-else-if="translationTestState === 'error'" class="translation-test-result error">当前翻译服务暂不可用，请检查密钥或网络</div>
          </section>
          <section class="window-settings-section translation-rule-section">
            <div class="window-settings-section-heading compact-heading"><div class="window-settings-section-title"><span class="settings-section-icon send"><UiIcon name="arrow" /></span><h2>我的回复</h2><p>发送前翻译成客户的语言</p></div></div>
            <div class="window-rule-grid">
              <label class="window-toggle-inline"><span>发送翻译</span><input v-model="windowSettingsDraft.sendTranslation" type="checkbox" /><i></i></label><span></span>
              <label class="window-form-field"><span>发送语言</span><LanguageSelect v-model="windowSettingsDraft.sendLanguage" /></label>
            </div>
          </section>
          <section class="window-settings-section translation-rule-section">
            <div class="window-settings-section-heading compact-heading"><div class="window-settings-section-title"><span class="settings-section-icon message"><UiIcon name="copy" /></span><h2>客户消息</h2><p>客户语言 → 译文（我的语言）</p></div></div>
            <div class="window-rule-grid message-rule-grid">
              <label class="window-toggle-inline"><span>消息翻译</span><input v-model="windowSettingsDraft.messageTranslation" type="checkbox" /><i></i></label><span></span>
              <label class="window-form-field"><span>客户消息语言</span><LanguageSelect v-model="windowSettingsDraft.sourceLanguage" include-auto auto-label="自动检测客户语言" /></label>
              <label class="window-form-field"><span>译文显示语言</span><LanguageSelect v-model="windowSettingsDraft.targetLanguage" /></label>
              <div class="window-rule-options full-width"><label class="window-checkbox"><input v-model="windowSettingsDraft.skipChineseMessages" type="checkbox" /><span>屏蔽包含中文的消息</span><small>不调用翻译接口，不扣字符</small></label><label class="window-form-field compact-select"><span>群组翻译</span><select v-model="windowSettingsDraft.groupTranslation"><option value="manual">手动翻译群组消息</option><option value="auto">自动翻译群组消息</option></select></label></div>
            </div>
          </section>
          <section class="window-settings-section last translation-style-section">
            <div class="window-settings-section-heading compact-heading"><div class="window-settings-section-title"><span class="settings-section-icon display"><UiIcon name="sparkle" /></span><h2>显示样式</h2></div></div>
            <div class="window-settings-grid style-grid"><label class="window-form-field"><span>字体大小</span><select v-model="windowSettingsDraft.fontSize"><option value="11">小（11px）</option><option value="12">中（12px）</option><option value="14">大（14px）</option></select></label><label class="window-form-field"><span>字体颜色</span><span class="color-input-wrap"><input v-model="windowSettingsDraft.fontColor" type="color" /><code>{{ windowSettingsDraft.fontColor }}</code></span></label><div class="translation-preview"><span :style="{ color: windowSettingsDraft.fontColor, fontSize: `${windowSettingsDraft.fontSize}px` }">译文预览：你好，很高兴认识你。</span></div></div>
            <label class="window-checkbox translation-separator-option"><input v-model="windowSettingsDraft.translationSeparator" type="checkbox" /><span>消息与译文之间显示分隔线</span><small>开启后在原文和译文之间显示细线</small></label>
          </section>
        </div>
        <footer class="modal-footer window-settings-footer"><button class="window-settings-reset" type="button" @click="resetWindowTranslationSettings">恢复默认</button><span class="window-settings-footer-spacer"></span><button class="window-settings-save" type="button" @click="saveWindowTranslationSettings">保存窗口设置</button></footer>
      </section>
    </div>

    

    <div v-if="setupPlatform" class="modal-backdrop" @click.self="closePlatformSetup">
      <section class="platform-setup-modal" role="dialog" aria-modal="true" :aria-label="`${editingPlatformWindowId ? '编辑' : '创建'} ${platformDisplayLabel(setupPlatform.platform)} 应用窗口`">
        <header class="modal-header">
          <div class="modal-title"><PlatformIcon :platform="setupPlatform.platform" /><strong>{{ editingPlatformWindowId ? '编辑' : '创建' }} {{ platformDisplayLabel(setupPlatform.platform) }} 应用</strong></div>
          <button class="modal-close" type="button" aria-label="关闭" @click="closePlatformSetup">×</button>
        </header>

        <div class="modal-body">
          <section class="module-summary">
            <PlatformIcon :platform="setupPlatform.platform" />
            <div class="module-copy">
               <div class="module-name-row"><strong>{{ platformDisplayLabel(setupPlatform.platform) }}</strong><span>模块版本 v{{ setupPlatform.version }}</span><span>最新版本 v{{ setupPlatform.latestVersion }}</span></div>
              <div class="module-update" :class="{ available: setupPlatform.version !== setupPlatform.latestVersion }">
                <span class="info-mark">i</span>
                 <div><strong>{{ setupPlatform.version === setupPlatform.latestVersion ? '当前已是最新版本' : '有新版本可更新' }}</strong><small>{{ setupPlatform.version === setupPlatform.latestVersion ? '平台模块已经是最新版本，可以直接创建应用窗口。' : '更新模块不会删除已创建的账号 Profile。' }}</small></div>
              </div>
            </div>
             <button v-if="setupPlatform.version !== setupPlatform.latestVersion" class="small-secondary-button" type="button" @click="showNotice('模块更新检查已完成')">检查更新</button>
             <button v-if="setupPlatform.version !== setupPlatform.latestVersion" class="small-primary-button" type="button" @click="showNotice('模块更新将在确认后执行')">更新模块</button>
          </section>

          <section class="setup-section">
            <h3>应用窗口</h3>
            <div class="setup-grid">
              <label class="form-field"><span>窗口名称</span><input v-model="setupWindowName" placeholder="例如：555、客服一号" /></label>
            </div>
          </section>

          <section class="setup-section">
            <h3>平台行为</h3>
            <div class="behavior-row">
              <label class="toggle-field"><span>显示应用名称</span><input v-model="setupShowName" type="checkbox" /><i></i></label>
              <label class="toggle-field"><span>显示消息通知</span><input v-model="setupShowNotifications" type="checkbox" /><i></i></label>
              <label class="toggle-field"><span>静音</span><input v-model="setupMute" type="checkbox" /><i></i></label>
               <label class="toggle-field"><span>启动时自动加载</span><input v-model="setupAutoLoad" type="checkbox" /><i></i></label>
            </div>
          </section>

          <section class="setup-section">
            <h3>网络连接</h3>
            <div class="connection-choice">
              <label><input v-model="setupConnectionMode" type="radio" value="direct" /> 直连</label>
              <label><input v-model="setupConnectionMode" type="radio" value="proxy" /> 使用代理</label>
            </div>
            <div v-if="setupConnectionMode === 'proxy'" class="setup-proxy-source">
              <label class="form-field"><span>代理来源</span><select v-model="setupProxyId"><option value="new">添加新代理并保存</option><option v-for="proxy in proxies" :key="proxy.id" :value="proxy.id">{{ proxy.name }} · {{ proxy.scope }}</option></select></label>
            </div>
            <div v-if="setupConnectionMode === 'proxy' && setupUsesNewProxy" class="setup-grid proxy-grid">
              <label class="form-field"><span>代理名称</span><input v-model="setupProxyName" placeholder="例如：美国客服线路" /></label>
              <label class="form-field"><span>代理类型</span><select v-model="setupProxyType" :disabled="setupConnectionMode !== 'proxy'"><option>HTTP/HTTPS</option><option>SOCKS5</option></select></label>
               <label class="form-field"><span>IP 地址</span><input v-model="setupProxyAddress" :disabled="setupConnectionMode !== 'proxy'" placeholder="请输入 IP 地址" /></label>
              <label class="form-field"><span>端口号</span><input v-model="setupProxyPort" :disabled="setupConnectionMode !== 'proxy'" placeholder="请输入端口" /></label>
              <label class="form-field"><span>代理账号</span><input v-model="setupProxyUsername" :disabled="setupConnectionMode !== 'proxy'" placeholder="选填" /></label>
              <label class="form-field span-two"><span>代理密码</span><input v-model="setupProxyPassword" :disabled="setupConnectionMode !== 'proxy'" type="password" placeholder="选填" /></label>
            </div>
             <div v-else-if="setupConnectionMode === 'proxy' && setupSelectedProxy" class="setup-proxy-selected"><UiIcon name="proxy" /><div><strong>{{ setupSelectedProxy.name }}</strong><small>{{ setupSelectedProxy.type }} · {{ setupSelectedProxy.host }}:{{ setupSelectedProxy.port }} · {{ setupSelectedProxy.scope }}</small></div><span :class="setupSelectedProxy.status === '正常' ? 'status-ok' : 'status-error'">{{ setupSelectedProxy.status === '正常' ? '已测试可用' : setupSelectedProxy.status }}</span></div>
          </section>

           <div class="setup-notice"><span>i</span>代理、Profile 和账号登录状态会按应用窗口单独保存。</div>
           <div class="setup-steps"><div><b>1</b><span>{{ editingPlatformWindowId ? '保存窗口设置' : '创建应用窗口' }}<small>设置窗口名称和网络</small></span></div><span class="step-arrow">→</span><div><b>2</b><span>登录平台账号<small>首次使用扫码或登录</small></span></div></div>
        </div>

        <footer class="modal-footer"><button class="secondary-button" type="button" @click="closePlatformSetup">关闭</button><button class="primary-button" type="button" @click="createApplication">{{ editingPlatformWindowId ? '保存窗口设置' : '创建应用窗口' }}</button></footer>
      </section>
    </div>

    
    
    

    

    

    <transition name="notice"><div v-if="notice" class="notice-toast">{{ notice }}</div></transition>

    <transition name="fade">
      <div v-if="confirmDialogOpen" class="confirm-overlay" @click.self="confirmDialogDone(false)">
        <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
          <h3 id="confirm-title">确认操作</h3>
          <p class="confirm-message">{{ confirmState?.message }}</p>
          <div class="confirm-actions">
            <button class="secondary-button" type="button" @click="confirmDialogDone(false)">取消</button>
            <button class="danger-button" type="button" @click="confirmDialogDone(true)">确定</button>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>
