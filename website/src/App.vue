<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import desktopDocument from './stitch/desktop.html?raw';
import mobileDocument from './stitch/mobile.html?raw';

const notice = ref('');
const mobileMenuOpen = ref(false);
let noticeTimer = 0;
const githubRelease = 'https://github.com/xhcao8-spec/seagrass-assistant/releases/latest';
const githubRepository = 'https://github.com/xhcao8-spec/seagrass-assistant';
const platformNotice = '由于时间有限，目前暂时只完善 WhatsApp，后续将逐步完善其他平台。';

const extractBody = (document: string) => document.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || '';
const escapeHtml = (value: unknown) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const steps = [
  { title: '01 下载软件', summary: 'Windows 10 / 11，任选下方渠道。', facts: ['蓝奏云提取码：9ysu', 'GitHub 请下载 Releases 中的 .exe', '无需注册海草账号'] },
  { title: '02 填入自己的 Key', summary: '在 DeepSeek 开放平台创建 API Key。', facts: ['系统设置 → DeepSeek API', '粘贴 Key → 保存 → 测试连接', '余额页面可查询官方余额'] },
  { title: '03 开始使用', summary: '创建平台窗口，登录自己的聊天账号。', facts: ['齿轮设置收发翻译语言', 'AI 生成 1—4 条备选草稿', '本地标签和话术，不自动发送'] },
];
const tutorial = [
  ['下载安装', '选择蓝奏云或 GitHub 下载。蓝奏云提取码是 9ysu；GitHub 进入最新版本的 Assets，下载 SeagrassAssistant-Setup 开头、.exe 结尾的安装包，不要把 Source code 当成安装包。运行安装程序后打开海草跨境助手。'],
  ['获取并填写 DeepSeek Key', '进入 DeepSeek 开放平台 platform.deepseek.com，登录后在 API Keys 页面创建 Key。软件内进入“系统设置 → DeepSeek API”，粘贴完整 Key，点击“保存 API 设置”，再“测试已保存的 Key”。保存后输入框清空是正常的，请不要将 Key 发给别人。'],
  ['查看余额与费用', '点击左侧“余额”并刷新，显示的是你自己的 DeepSeek API 账户余额。软件不收取套餐费，但翻译和 AI 调用可能消耗 DeepSeek 余额；DeepSeek 聊天网页版权益不等同于 API 余额。查询失败不代表余额为零。'],
  ['登录 WhatsApp 并设置翻译', '在“应用中心”创建 WhatsApp 窗口，使用手机 WhatsApp 的“已关联设备”扫码。点击窗口齿轮，选择发送语言、客户消息语言和译文显示语言。聊天中的手动“重新翻译”会发起新请求。首次使用新版可能需要重新扫码，不会自动迁移旧版登录信息。'],
  ['使用 AI 建议回复与识图', '打开当前聊天并滚动到最新消息，点击输入框附近的 AI 按钮。填写这次回复目的，选择快速或精聊模式及 1—4 条建议。核对原文和中文参考后再插入输入框。WhatsApp 图片需先加载完成，生成时最多读取最近 4 张可读取图片；AI 不会自动发送草稿。'],
  ['标签、快捷回复和数据保存', '聊天标记、专属翻译设置和快捷话术只保存在本机，没有客户数据库、团队共享或云同步。备份数据时先退出软件，再备份 %APPDATA%/SeagrassStandalone；不要公开此目录，换电脑需要重新填写 Key。'],
  ['失败重试与隐私', '网络异常、超时、临时限流会自动重试最多 2 次；余额不足或 Key 无效直接停止并提示。软件不设并发上限，但 DeepSeek 仍有自身限制。超时重试可能产生额外 API 用量。翻译和 AI 所需文本、选中的聊天图片会发送给 DeepSeek，草稿使用前请自行核对。'],
  ['平台进度与反馈', platformNotice + '其他平台入口不代表功能已全部完成。遇到问题可在 GitHub Issues 反馈，但请隐藏 Key、手机号、登录二维码和客户隐私。'],
];
function downloadLinks() {
  const style = 'flex-1 text-center font-label-md text-label-md px-md py-sm rounded-lg border border-primary';
  return `<div class="flex flex-wrap gap-sm mt-md"><a data-download="lanzou" class="${style} bg-primary text-on-primary" href="https://wwamz.lanzouu.com/b01euscfwj" target="_blank" rel="noopener noreferrer">蓝奏云下载</a><a class="${style} text-primary" href="${githubRelease}" target="_blank" rel="noopener noreferrer">GitHub 下载</a></div>`;
}
function tutorialHtml() {
  return '<div class="flex flex-col gap-sm">' + tutorial.map(([title, body]) => `<details class="group bg-surface rounded-lg border border-outline-variant/30 overflow-hidden"><summary class="flex items-center justify-between p-md cursor-pointer font-headline-sm text-headline-sm text-on-surface list-none"><span>${escapeHtml(title)}</span><span class="material-symbols-outlined">expand_more</span></summary><div class="px-md pb-md font-body-md text-body-md text-on-surface-variant">${escapeHtml(body)}</div></details>`).join('') + `<a class="text-primary text-body-sm mt-md" href="${githubRepository}/blob/main/docs/使用教程.md" target="_blank" rel="noopener noreferrer">查看 GitHub 完整使用教程 →</a></div>`;
}
function guideCards(mobile = false) {
  return steps.map((step, index) => '<div class="' + (mobile ? 'bg-surface rounded-xl p-6 border border-outline-variant w-[85%] shrink-0 snap-center' : 'flex-shrink-0 w-[320px] snap-center bg-surface rounded-xl border border-outline-variant/30 ambient-shadow p-lg flex flex-col relative overflow-hidden') + '"><h3 class="font-headline-md text-headline-md text-on-surface mb-xs">' + escapeHtml(step.title) + '</h3><p class="font-body-sm text-body-sm text-on-surface-variant mb-md">' + escapeHtml(step.summary) + '</p><ul class="flex flex-col gap-sm">' + step.facts.map(fact => '<li class="flex items-center gap-sm text-body-sm text-on-surface-variant"><span class="material-symbols-outlined text-primary text-[18px]">check_circle</span>' + escapeHtml(fact) + '</li>').join('') + '</ul>' + (index === 0 ? downloadLinks() : '') + '</div>').join('');
}
function desktopPricing() { return '<div class="flex overflow-x-auto no-scrollbar gap-lg pb-md snap-x snap-mandatory">' + guideCards() + '</div>'; }
function mobilePricing() { return '<section class="py-12 px-md bg-surface-container-low border-t border-outline-variant/30" id="mobile-pricing"><h2 class="font-headline-sm text-headline-sm text-center mb-8">下载与使用指南</h2><div class="flex flex-row gap-4 overflow-x-auto snap-x snap-mandatory pb-4 -mx-md px-md no-scrollbar">' + guideCards(true) + '</div><p class="font-body-sm text-body-sm text-on-surface-variant mt-4">软件不出售套餐；翻译和 AI 使用自有 Key，费用由 DeepSeek 计收。</p><p class="font-body-sm text-body-sm text-on-surface-variant mt-4">' + platformNotice + '</p><div id="mobile-help" class="mt-xl"><h2 class="font-headline-sm text-headline-sm mb-md">使用教程</h2>' + tutorialHtml() + '</div></section>'; }

function prepareDesktop() {
  let html = extractBody(desktopDocument);
  html = html.replaceAll('<span class="material-symbols-outlined text-primary text-[28px] icon-filled" data-icon="waves">waves</span>', '<img class="w-8 h-8" src="/brand/seagrass-logo.svg" alt="海草跨境助手" />');
  html = html.replaceAll('<span class="material-symbols-outlined text-primary text-[24px] icon-filled" data-icon="waves">waves</span>', '<img class="w-6 h-6" src="/brand/seagrass-logo.svg" alt="海草跨境助手" />');
  html = html.replace('支持超过 100 种语言的实时互译', '支持软件当前提供的多种语言实时互译');
  html = html.replace('© 2024 海草跨境助手 (SeaGrass) 版权所有.', '© 2026 海草跨境助手 版权所有。');
  html = html.replace('提供免费试用 · 无需绑定信用卡', 'Windows 10 / 11 · 官方最新版');
  html = html.replace('<section class="py-xl md:py-xxl bg-background border-t border-outline-variant/20">', '<section class="py-xl md:py-xxl bg-background border-t border-outline-variant/20" id="solutions">');
  const pricing = `<section class="py-xl md:py-xxl bg-background border-t border-outline-variant/20" id="pricing"><div class="max-w-container-max mx-auto px-md md:px-lg"><div class="text-center mb-xl"><h2 class="font-headline-lg text-headline-lg text-on-surface mb-sm">使用指南</h2><p class="font-body-lg text-body-lg text-on-surface-variant max-w-2xl mx-auto">无需海草账号，自备 DeepSeek API Key；API 费用由 DeepSeek 计收</p></div>${desktopPricing()}</div></section>`;
  html = html.replace(/<section class="py-xl md:py-xxl bg-background border-t border-outline-variant\/20" id="pricing">[\s\S]*?<\/section><section class="py-xl md:py-xxl bg-surface-container-lowest" id="help">/, `${pricing}<section class="py-xl md:py-xxl bg-surface-container-lowest" id="help">`);
  html = html.replace(/<section class="py-xl md:py-xxl bg-surface-container-lowest" id="help">[\s\S]*?<\/section>/, `<section class="py-xl md:py-xxl bg-surface-container-lowest" id="help"><div class="max-w-3xl mx-auto px-md md:px-lg"><div class="text-center mb-xl"><h2 class="font-headline-lg text-headline-lg text-on-surface mb-sm">使用教程</h2><p class="text-body-md text-on-surface-variant">${platformNotice}</p></div>${tutorialHtml()}</div></section>`);
  html = html.replaceAll('资费方案', '使用指南')
    .replaceAll('团队资产协同', '本地快捷回复')
    .replaceAll('云端共享话术库、产品图片与文档。统一团队服务标准，新人也能快速上手。', '话术与图片保存在自己的电脑，按分组整理，随时插入聊天输入框。')
    .replaceAll('本地化处理与端到端加密，确保您的商业机密与客户隐私绝对安全。', '设置、标签和话术保存在本机；翻译和 AI 所需文本会发送至 DeepSeek，请留意隐私。')
    .replaceAll('绑定平台', '配置 API Key')
    .replaceAll('一键授权您常用的电商或社交账号。', '进入系统设置，填入自己的 DeepSeek Key 并测试连接。');
  return html;
}

function prepareMobile() {
  let html = extractBody(mobileDocument);
  html = html.replace('<div class="font-headline-md text-headline-md font-bold text-primary dark:text-primary-fixed-dim">\n                SeaGrass\n            </div>', '<div class="flex items-center gap-2 font-headline-sm text-headline-sm font-bold text-primary"><img class="w-8 h-8" src="/brand/seagrass-logo.svg" alt="海草跨境助手" /><span>海草跨境助手</span></div>');
  html = html.replace('V2.0 跨境利器全新升级', '多平台沟通全新升级');
  html = html.replace('支持 WhatsApp, Shopify, 阿里国际站等主流沟通及后台场景嵌入。', platformNotice);
  html = html.replace('获取 Windows 客户端或浏览器插件。', '获取海草跨境助手 Windows 客户端。');
  html = html.replace('<section class="py-12 px-md bg-surface-container-lowest border-t border-outline-variant/30">', '<section class="py-12 px-md bg-surface-container-lowest border-t border-outline-variant/30" id="mobile-features">');
  html = html.replace('<section class="py-12 px-md bg-surface">', '<section class="py-12 px-md bg-surface" id="mobile-solutions">');
  html = html.replace(/<section class="py-12 px-md bg-surface-container-low border-t border-outline-variant\/30">[\s\S]*?<\/section>\s*<\/main>/, `${mobilePricing()}</main>`);
  html = html.replace('<span class="font-label-md text-label-md text-on-surface">免费试用</span>', '<span class="font-label-md text-label-md text-on-surface">下载软件</span>');
  html = html.replace('<span class="font-body-sm text-body-sm text-on-surface-variant">解锁全部高级功能</span>', '<span class="font-body-sm text-body-sm text-on-surface-variant">Windows 官方最新版</span>');
  html = html.replace('>免费试用</button>', '>立即下载</button>');
  html = html.replaceAll('资费方案', '使用指南')
    .replaceAll('团队资产协同', '本地快捷回复')
    .replaceAll('云端共享话术库、产品图片与文档。统一团队服务标准，新人也能快速上手。', '话术与图片保存在自己的电脑，按分组整理，随时插入聊天输入框。')
    .replaceAll('本地化处理与端到端加密，确保您的商业机密与客户隐私绝对安全。', '设置、标签和话术保存在本机；翻译和 AI 所需文本会发送至 DeepSeek，请留意隐私。')
    .replaceAll('绑定平台', '配置 API Key')
    .replaceAll('一键授权您常用的电商或社交账号。', '进入系统设置，填入自己的 DeepSeek Key 并测试连接。');
  return html;
}

const desktopHtml = computed(prepareDesktop);
const mobileHtml = computed(prepareMobile);

function showNotice(message: string) {
  clearTimeout(noticeTimer); notice.value = message;
  noticeTimer = window.setTimeout(() => { notice.value = ''; }, 2400);
}

function download() {
  document.querySelector(window.matchMedia('(min-width: 768px)').matches ? '#pricing' : '#mobile-pricing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function handleContentClick(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('[data-download="lanzou"]')) {
    showNotice('蓝奏云提取码：9ysu');
    void navigator.clipboard?.writeText('9ysu').then(() => showNotice('提取码已复制：9ysu')).catch(() => {});
    return;
  }
  const button = (event.target as HTMLElement).closest('button');
  if (button?.textContent?.trim() === 'menu') { mobileMenuOpen.value = true; return; }
  if (button?.textContent?.includes('下载')) download();
}

watch(mobileMenuOpen, (open) => { document.body.style.overflow = open ? 'hidden' : ''; });
onUnmounted(() => { document.body.style.overflow = ''; });
</script>

<template>
  <div class="stitch-site">
    <div class="desktop-site hidden md:block bg-background text-on-background font-body-md text-body-md antialiased pt-16" @click="handleContentClick" v-html="desktopHtml"></div>
    <div class="mobile-site md:hidden bg-background text-on-background font-body-md text-body-md antialiased min-h-screen pb-24" @click="handleContentClick" v-html="mobileHtml"></div>
    <transition name="overlay">
      <div v-if="mobileMenuOpen" aria-hidden="true" class="md:hidden fixed inset-0 bg-on-background z-40 opacity-50" @click="mobileMenuOpen=false"></div>
    </transition>
    <transition name="drawer">
      <nav v-if="mobileMenuOpen" aria-label="主导航" class="md:hidden fixed inset-y-0 left-0 z-[60] py-md bg-surface h-full w-[280px] rounded-r-xl shadow-xl flex flex-col">
        <div class="flex items-center justify-between px-md pb-md mb-sm border-b border-outline-variant">
          <div class="font-headline-sm text-headline-sm font-bold text-primary flex items-center gap-sm">
            <img class="w-8 h-8" src="/brand/seagrass-logo.svg" alt="海草跨境助手" />
            <span>海草跨境助手</span>
          </div>
          <button aria-label="关闭菜单" class="p-2 rounded-full hover:bg-surface-container-highest transition-colors text-on-surface-variant active:scale-95 duration-150" @click="mobileMenuOpen=false">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <ul class="flex flex-col gap-xs px-sm py-sm flex-grow overflow-y-auto">
          <li><a class="flex items-center gap-md mx-2 px-4 py-3 bg-secondary-container text-on-secondary-container rounded-full hover:bg-surface-container-highest transition-colors active:opacity-80 font-label-md text-label-md" href="#mobile-features" @click="mobileMenuOpen=false"><span class="material-symbols-outlined icon-filled">star</span>产品功能</a></li>
          <li><a class="flex items-center gap-md mx-2 px-4 py-3 text-on-surface-variant hover:bg-surface-container-highest transition-colors active:opacity-80 rounded-lg font-label-md text-label-md" href="#mobile-solutions" @click="mobileMenuOpen=false"><span class="material-symbols-outlined">lightbulb</span>解决方案</a></li>
          <li><a class="flex items-center gap-md mx-2 px-4 py-3 text-on-surface-variant hover:bg-surface-container-highest transition-colors active:opacity-80 rounded-lg font-label-md text-label-md" href="#mobile-pricing" @click="mobileMenuOpen=false"><span class="material-symbols-outlined">sell</span>使用指南</a></li>
          <li><a class="flex items-center gap-md mx-2 px-4 py-3 text-on-surface-variant hover:bg-surface-container-highest transition-colors active:opacity-80 rounded-lg font-label-md text-label-md" href="#mobile-help" @click="mobileMenuOpen=false"><span class="material-symbols-outlined">help</span>帮助中心</a></li>
        </ul>
        <div class="p-md mt-auto border-t border-outline-variant bg-surface-container-lowest rounded-br-xl">
          <button class="w-full flex items-center justify-center gap-sm bg-primary text-on-primary py-3 px-4 rounded-lg font-label-md text-label-md shadow-sm hover:bg-surface-tint active:scale-95 duration-150 transition-all" @click="mobileMenuOpen=false; download()"><span class="material-symbols-outlined">download</span>下载 Windows 版</button>
        </div>
      </nav>
    </transition>
    <transition name="toast"><div v-if="notice" class="site-notice">{{ notice }}</div></transition>
  </div>
</template>
