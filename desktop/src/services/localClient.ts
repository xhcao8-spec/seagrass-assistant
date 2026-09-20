import { computed, ref } from 'vue';

export interface LocalSettings { hasKey: boolean; model: string; modelLabel?: string }
export interface LocalProxy {
  id: string; name: string; host: string; port: number; proxy_type: string;
  username: string; password: string; status: string; last_checked_at: string | null;
}
export interface LocalBridge {
  settings(): Promise<LocalSettings>;
  saveSettings(input: { apiKey?: string; removeKey?: boolean }): Promise<LocalSettings>;
  test(): Promise<{ ok: boolean }>;
  balance(): Promise<{ is_available: boolean; balance_infos: Array<{ currency: string; total_balance: string }> }>;
  proxies(): Promise<LocalProxy[]>;
  createProxy(input: Record<string, unknown>): Promise<LocalProxy>;
  deleteProxy(id: string): Promise<unknown>;
  testProxy(id: string): Promise<{ status: string; checked_at: string; detail: string; latency_ms: number }>;
}
export function localBridge(): LocalBridge {
  const bridge = (window as Window & { seagrassDesktop?: { local?: LocalBridge } }).seagrassDesktop?.local;
  if (!bridge) throw new Error('请在海草跨境助手桌面软件中使用此功能');
  return bridge;
}
export const localSettings = ref<LocalSettings>({ hasKey: false, model: 'deepseek-flash', modelLabel: 'DeepSeek V4.1 Flash' });
export const balanceLoading = ref(false);
export const balanceError = ref('');
export const balanceRows = ref<Array<{ currency: string; total_balance: string }>>([]);
export const balanceUpdatedAt = ref('');
export const balanceAvailable = ref<boolean | null>(null);
let balanceEpoch = 0;
export const balanceSummary = computed(() => {
  if (!localSettings.value.hasKey) return '未配置 Key';
  if (balanceLoading.value && !balanceRows.value.length) return '查询中…';
  if (balanceError.value) return '查询失败';
  return balanceRows.value.map(row => `${row.currency === 'CNY' ? '¥' : '$'}${row.total_balance}`).join(' / ') || '待查询';
});
export function clearBalance() {
  balanceEpoch++;
  balanceRows.value = []; balanceUpdatedAt.value = ''; balanceError.value = ''; balanceAvailable.value = null; balanceLoading.value = false;
}
export async function refreshBalance() {
  if (!localSettings.value.hasKey || balanceLoading.value) return;
  const epoch = balanceEpoch;
  balanceLoading.value = true; balanceError.value = '';
  try {
    const result = await localBridge().balance();
    if (epoch !== balanceEpoch) return;
    balanceRows.value = result.balance_infos;
    balanceAvailable.value = result.is_available;
    balanceUpdatedAt.value = new Date().toLocaleTimeString();
  } catch (error) {
    if (epoch === balanceEpoch) balanceError.value = cleanLocalError(error);
  } finally { if (epoch === balanceEpoch) balanceLoading.value = false; }
}
export function cleanLocalError(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 240);
}
export async function loadLocalSettings() { localSettings.value = await localBridge().settings(); }
export async function openExternal(url: string) {
  const bridge = (window as Window & { seagrassDesktop?: { external?: { open(url: string): Promise<unknown> } } }).seagrassDesktop;
  if (!bridge?.external) throw new Error('请在桌面软件内打开链接');
  await bridge.external.open(url);
}
