# 海草跨境助手 · SeaGrass Assistant

**用 AI 翻译聊天，用更自然的语言沟通。**

海草跨境助手是一款开源的 Windows 聊天辅助工具，面向跨语言沟通、外贸交流和日常聊天。通过 **DeepSeek V4.1 Flash** 提供消息翻译、聊天建议回复与图片理解，填入自己的 DeepSeek API Key 即可使用。

> 由于时间有限，目前暂时只完善 WhatsApp，后续将逐步完善其他平台。
> Facebook、Instagram、LinkedIn、X 等入口正在适配，暂不代表这些平台的全部功能已完成。

[下载软件](https://github.com/xhcao8-spec/seagrass-assistant/releases/latest) · [使用教程](docs/使用教程.md) · [官方网站](https://www.mutusv.cn) · [反馈问题](https://github.com/xhcao8-spec/seagrass-assistant/issues)

## 核心功能与优势

### AI 聊天翻译

- 使用大模型理解原文语义并生成译文，尽量保留原文的语气、人称、段落、表情和数字。
- 在聊天页面查看原文与译文，减少复制、切换翻译工具的操作。
- 支持接收消息翻译与发送内容翻译，可分别选择目标语言。
- 支持自动翻译、手动翻译和重新翻译；不同窗口、不同聊天可使用各自的翻译设置。

### 更贴近对话的 AI 建议回复

- 参考当前已加载的聊天内容，区分“我”和“对方”，生成供你审核的回复草稿。
- **快速回复**适合简短回应；**精聊回复**更关注话题、语气和对方的情绪。
- 可以填写本次回复目的，例如“回应他的旅行分享，像朋友聊天，不谈业务”。
- 尝试参考你在当前对话中的称呼、用词、长短和表情，让草稿更符合你的表达习惯。
- 每次可选择 **1—4 条建议**，附中文参考，插入输入框后可继续修改；不会自动发送。

### 图片也能参与聊天建议

WhatsApp 当前聊天中已加载的图片可以作为 AI 回复的上下文。生成时最多读取最近 **4 张可读取图片**，结合消息文字、顺序和发送方理解话题。图片需先加载完成；未读取到的图片不会被当成已看过。

### 多窗口与日常沟通工具

- 多窗口登录与切换，独立的窗口配置，顶部标签可整理顺序。
- 聊天标签和专属翻译设置，方便区分不同联系人。
- 本地快捷话术、图片和分组，减少重复输入。
- 可为窗口配置自己的网络代理。
- 查看自己的 DeepSeek API 余额；网络异常、超时和临时限流会按规则自动重试。

## 使用哪个 AI 模型？

| 项目 | 当前配置 |
| --- | --- |
| 模型 | **DeepSeek V4.1 Flash** |
| API 模型名 | `deepseek-flash` |
| 用途 | 聊天翻译、快速/精聊回复、聊天图片理解 |
| 调用方式 | 软件直接请求 DeepSeek 官方 API，使用你自己填写的 Key |

软件免费开源，**DeepSeek API 使用费由 DeepSeek 计收**。你可以在软件“余额”页面查看 API 账户金额。模型表现受原文、上下文、图片清晰度等影响，AI 译文和建议均需人工核对。

## 下载与五分钟上手

- **[GitHub 下载](https://github.com/xhcao8-spec/seagrass-assistant/releases/latest)**：展开 Assets，下载 `SeagrassAssistant-Setup-版本号.exe`。
- **[蓝奏云下载](https://wwamz.lanzouu.com/b01euscfwj)**：提取码 **9ysu**。
- 支持 Windows 10 / 11，当前提供 x64 安装包。不同渠道的版本以实际文件为准。

`Source code (zip)` / `Source code (tar.gz)` 是源码，不是安装程序。普通用户下载 `.exe` 即可。

1. 安装并打开软件，进入 **系统设置 → DeepSeek API**。
2. 登录 [DeepSeek 开放平台](https://platform.deepseek.com/)，在 [API Keys](https://platform.deepseek.com/api_keys) 创建自己的 Key。
3. 粘贴 Key，点击 **保存 API 设置 → 测试已保存的 Key**。
4. 点击左侧 **余额**，确认 API 账户有可用余额。
5. 在 **应用中心** 创建 WhatsApp 窗口，用手机的“已关联设备”扫码。
6. 点击窗口齿轮设置翻译语言，打开聊天即可使用翻译与 AI 建议。

详细步骤、图片使用和常见问题见 **[中文使用教程](docs/使用教程.md)**。

## 隐私与使用提示

- Key 通过 Electron `safeStorage` 加密保存在本机，不发送给海草官网。
- 翻译和 AI 请求所需的文本、图片会发送到 DeepSeek，请确认你有权处理这些内容。
- AI 仅读取当前加载的对话，并不了解所有历史；请特别核对金额、时间、身份、事实和承诺。
- 临时失败最多自动重试 2 次；余额不足或 Key 无效会停止并提示。超时重试可能产生额外 API 用量。
- 设置、标签和话术保存在本机。数据目录 `%APPDATA%/SeagrassStandalone` 含登录资料，请勿公开分享；备份方法见教程。

## 开发与构建

```sh
git clone https://github.com/xhcao8-spec/seagrass-assistant.git
cd seagrass-assistant
pnpm install
pnpm dev
```

使用 Node.js 22 LTS 或更新的兼容 LTS、pnpm 9.15.0。更多环境配置见 [开发与编译说明](docs/开发与编译.md)。

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm package:win
```

- `desktop/`：Electron + Vue 桌面客户端。
- `website/`：静态官网。
- `docs/`：中文教程、发布与开发说明。
- 安装包输出到 `release/`，官网输出到 `website/dist/`。

## 后续计划与反馈

持续完善 WhatsApp 的页面适配、翻译稳定性、发送方识别、图片理解和 AI 回复质量，并逐步完善其他平台。

欢迎在 [Issues](https://github.com/xhcao8-spec/seagrass-assistant/issues) 提交版本、系统、复现步骤和脱敏截图。请勿提交 Key、登录二维码、手机号或真实聊天隐私。

## 开源许可

项目源码使用 **[GPL-3.0-only](LICENSE)**，允许使用、研究、修改及商用。分发原版或修改版时，须按许可证提供对应源码并保留版权和许可声明。软件按现状提供，不作担保。

第三方组件保留各自许可，见 [第三方许可声明](THIRD-PARTY-NOTICES.md)。品牌名称和 Logo 的商标权不因开源而转让。本项目不是 WhatsApp、Meta 或 DeepSeek 的官方产品，使用时请遵守相关平台条款。
