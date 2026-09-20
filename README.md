# 海草跨境助手

Windows 桌面聊天辅助工具。沿用原有 Logo 和界面，使用用户自己的 DeepSeek API Key，不需要海草账号或业务服务器。

> **开发进度：由于时间有限，目前暂时只完善 WhatsApp，后续将逐步完善其他平台。**
> Facebook、Instagram、LinkedIn、X 等平台入口仍在逐步适配中，不代表功能已全部完成。

## 下载软件

不懂编程也可以直接使用：下载 Windows 安装包，不需要自行编译源码。

- [GitHub 最新版本与安装包](https://github.com/xhcao8-spec/seagrass-assistant/releases/latest)：展开 **Assets**，下载 `SeagrassAssistant-Setup-版本号.exe`。
- [蓝奏云下载](https://wwamz.lanzouu.com/b01euscfwj)：提取码 **9ysu**。
- [官方网站](https://www.mutusv.cn)：下载入口与在线使用教程。

GitHub 中的 `Source code (zip)` / `Source code (tar.gz)` 是源码，不是安装程序。不同下载渠道的版本以实际上传的文件为准。

## 五分钟上手

1. 安装并打开海草跨境助手，进入 **系统设置 → DeepSeek API**。
2. 登录 [DeepSeek 开放平台](https://platform.deepseek.com/)，在 [API Keys](https://platform.deepseek.com/api_keys) 创建自己的 Key。
3. 在软件中粘贴 Key，点击 **保存 API 设置 → 测试已保存的 Key**。不要把 Key 发给别人。
4. 打开 **余额** 查看自己的 DeepSeek API 余额。软件不出售套餐；API 使用费由 DeepSeek 计收。
5. 在 **应用中心** 创建 WhatsApp 窗口，使用手机 WhatsApp 的已关联设备功能扫码登录。
6. 点击窗口齿轮设置翻译语言；在聊天中使用翻译和 AI 建议回复，核对内容后再发送。

完整步骤、图片使用、常见问题和备份方法见 [中文使用教程](docs/使用教程.md)。

## 使用

请先阅读 [中文使用教程](docs/使用教程.md)。

- WhatsApp 多窗口、收发翻译、AI 草稿、聊天标签和本地快捷回复；AI 回复支持当前聊天图片理解。
- 账户页直接查询 DeepSeek 余额，不售卖套餐，不显示字符额度或 AI 次数额度。
- 无团队共享、员工账号、云同步、充值订单和强制更新。
- 下载入口：[蓝奏云文件夹](https://wwamz.lanzouu.com/b01euscfwj)，提取码 **9ysu**。

**使用仍需联网**：平台聊天需要联网；翻译和 AI 会将所需聊天文本发送到 DeepSeek。Key 使用 Electron safeStorage 加密保存在本机，不保存在前端 localStorage，不发送给海草官网。

当前版本 1.1.0，使用 DeepSeek V4.1 Flash（`deepseek-flash`）。软件不设置并发上限；临时限流、网络错误、超时或暂时服务异常会自动重试最多 2 次，余额不足或 Key 无效则停止并提示。更新按钮复制蓝奏云提取码后打开下载页。识图仅在生成时读取当前 WhatsApp 聊天最近的最多 4 张已加载图片，文字和图片都由 DeepSeek 处理。

## 项目结构

- `desktop/`：Electron + Vue 客户端，无业务后端依赖。
- `website/`：保留 Stitch 布局的静态官网，仅说明和下载入口。
- `docs/`：使用、发布与数据说明。

## 开发与构建

使用 Node.js 22 或更新的 LTS，以及 pnpm。首次安装需要联网下载依赖和 Electron。

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm package:win
```

如果包管理器提示阻止 Electron 的安装脚本，请按提示允许 `electron` 和 `esbuild` 的构建脚本，再重新构建。开发端口为 4183，不与旧版的 4173 冲突。

想修改代码的开发者可以先阅读 [开发与编译说明](docs/开发与编译.md)。

安装包输出到 `release/`。静态网站输出到 `website/dist/`；宝塔仅需部署该目录，不需要 Python、数据库或 `/api/v1` 反向代理。

新旧版的数据目录与安装标识分开。新版使用 `%APPDATA%/SeagrassStandalone`，不自动搬运旧版 Cookie、Key 或客户数据。首次打开平台需要重新登录，这不是清空旧版数据。软件名称仍为“海草跨境助手”。

没有“客户数据”页面，也不建立聊天历史归档。聊天里的标签及单独翻译设置保存在本机的 `chat-marks.json`；AI 仅读取当前加载的对话。翻译缓存和平台自身的登录缓存仍会保留在本机，请勿公开运行数据目录。

## 开源许可

本项目源码以 [GNU GPL v3.0](LICENSE)（GPL-3.0-only）发布，允许使用、研究、修改及商用。分发原版或修改版时，需遵守该许可证并提供对应源码，保留版权及许可声明。本软件按现状提供，不作担保。

第三方组件保留各自许可证，见 [第三方许可声明](THIRD-PARTY-NOTICES.md)。品牌名称与 Logo 的商标权不因开源许可证而转让；本项目不代表相关平台官方。

只发布本目录中的源码、文档和必要素材；不要发布 `node_modules`、`.migration-tools`、运行数据、日志、Key、旧服务器备份或已有用户的聊天数据。第三方依赖与品牌标识仍受各自许可约束。

## 后续计划与反馈

- 持续完善 WhatsApp 页面变化适配、翻译稳定性、发送方识别和 AI 回复质量。
- 逐步完善 Facebook、Instagram、LinkedIn、X 等平台的功能。
- 持续补充使用教程、错误提示和自动化测试。

欢迎在 [Issues](https://github.com/xhcao8-spec/seagrass-assistant/issues) 提交问题或建议。请附软件版本、系统版本、复现步骤和脱敏截图，不要提交 API Key、平台登录二维码、手机号或真实聊天隐私。

本项目不是 WhatsApp、Meta 或 DeepSeek 的官方产品。使用聊天平台及 API 时，请遵守相关服务条款；AI 可能产生误解或不准确内容，尤其是金额、身份、承诺等信息，请人工审核。
