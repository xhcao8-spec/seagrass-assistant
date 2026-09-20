<script setup lang="ts">
import { ref } from 'vue';
import { localBridge, localSettings, loadLocalSettings, clearBalance, refreshBalance, cleanLocalError, openExternal } from '../services/localClient';
const key = ref('');
const busy = ref(false);
const status = ref('');
async function save() {
  busy.value = true; status.value = '';
  try {
    await localBridge().saveSettings({ apiKey: key.value });
    key.value = ''; clearBalance(); await loadLocalSettings();
    status.value = '已安全保存到本机。'; void refreshBalance();
  } catch (error) { status.value = cleanLocalError(error); }
  finally { busy.value = false; }
}
async function test() {
  busy.value = true; status.value = '';
  try { await localBridge().test(); status.value = '连接成功，API Key 可以访问 DeepSeek。'; }
  catch (error) { status.value = cleanLocalError(error); }
  finally { busy.value = false; }
}
async function remove() {
  busy.value = true;
  try { await localBridge().saveSettings({ removeKey: true }); key.value = ''; clearBalance(); await loadLocalSettings(); status.value = '已移除本机 API Key，不会删除聊天数据。'; }
  catch (error) { status.value = cleanLocalError(error); }
  finally { busy.value = false; }
}
async function openKeys() {
  try { await openExternal('https://platform.deepseek.com/api_keys'); }
  catch (error) { status.value = cleanLocalError(error); }
}
</script>

<template>
  <div class="settings-section local-ai-settings">
    <h2>DeepSeek API</h2>
    <p class="local-note">使用你自己的 Key。Key 加密保存在本机，翻译与 AI 费用由 DeepSeek 按其实际规则计费。</p>
    <label class="settings-row"><span>API Key</span><input v-model="key" type="password" autocomplete="off" spellcheck="false" :placeholder="localSettings.hasKey ? '已保存；留空保留原 Key' : '粘贴你的 DeepSeek API Key'" /></label>
    <div class="settings-row"><span>当前模型</span><strong>DeepSeek V4.1 Flash · 支持识图</strong></div>
    <div class="local-settings-actions">
      <button class="primary-button" :disabled="busy" @click="save">保存 API 设置</button>
      <button class="secondary-button" :disabled="busy || !localSettings.hasKey" @click="test">测试已保存的 Key</button>
      <button class="secondary-button" @click="openKeys">获取 API Key</button>
      <button class="table-action danger" :disabled="busy || !localSettings.hasKey" @click="remove">移除 Key</button>
    </div>
    <p v-if="status" class="local-note" role="status">{{ status }}</p>
    <details class="local-tutorial" :open="!localSettings.hasKey">
      <summary>第一次使用？查看配置教程</summary>
      <ol>
        <li>点击“获取 API Key”，在 DeepSeek 开放平台注册或登录，创建自己的 API Key。</li>
        <li>复制 Key，粘贴到上面的输入框，点击“保存 API 设置”。不要把 Key 发给别人或放进截图。</li>
        <li>点击“测试已保存的 Key”。成功后，到“余额”刷新 DeepSeek 余额；余额不足需去 DeepSeek 官方平台处理。</li>
        <li>进入“应用中心”创建平台窗口，扫码或登录你自己的聊天账号。</li>
        <li>点击窗口齿轮设置收发翻译语言。打开聊天后使用翻译，或点击输入框旁的 AI 按钮生成 1—4 条建议。</li>
        <li>AI 草稿可插入输入框，但不会自动发送。发出前请核对含义、对象和事实。</li>
      </ol>
      <p>WhatsApp AI 回复会结合当前聊天最近 4 张已加载图片。请先滚动到最新消息并加载照片，再点击生成。只有生成时才把相关文字和图片发送给 DeepSeek，不建立图片归档。</p>
      <p>软件仍需联网。聊天标签、话术和平台登录资料保留在本机。软件不设并发上限；临时限流、网络错误或超时会自动重试最多 2 次，余额不足或 Key 无效时停止并提示。旧版本的数据不会自动搬入。</p>
      <p>更新：点击左下角“下载新版”，自动复制提取码 <strong>9ysu</strong> 并打开蓝奏云，在网页里粘贴即可。手动下载安装，不会强制退出软件。</p>
    </details>
  </div>
</template>
