# DeepSeek Chat Exporter

一键将 [DeepSeek（chat.deepseek.com）](https://chat.deepseek.com/) 网页端对话记录导出为标准 Markdown（`.md`）文件的浏览器扩展（Manifest V3）。

- **Microsoft Edge 扩展商店**：[DeepSeek Chat Exporter](https://microsoftedge.microsoft.com/addons/detail/gjcnegdbpdngedmopbdnkodhnlplnmmf)

## 功能特点

- **双通道采集**：
  - **API 直取模式**：调用 DeepSeek 历史消息接口获取完整对话，不受前端虚拟列表折叠限制。
  - **DOM 滚动兜底**：未登录或无法提取令牌时自动回退为页面滚动抓取。
- **完整保留内容**：保留用户提问、AI 回复、深度思考过程（Thinking）及思考耗时、附件与图片链接。
- **纯净 Markdown 输出**：可直接导入 Obsidian、Notion、Typora 等笔记软件。
- **纯本地处理**：所有采集、解析与文件生成均在本地浏览器内完成，不向任何第三方服务器传输数据。
- **调试排查支持**：弹窗底部提供「导出原始数据（排查用）」，接口结构变化时可导出解析诊断 JSON。

## 安装方式

### 方式一：商店安装
前往 [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/gjcnegdbpdngedmopbdnkodhnlplnmmf) 直接安装（当前 v2.3.0 正在审核中）。

### 方式二：本地加载开发版
1. 克隆本仓库到本地：
   ```bash
   git clone https://github.com/limingjing6666/deepseek-chat-exporter.git
   ```
2. 在 Edge / Chrome 地址栏打开 `edge://extensions`（或 `chrome://extensions`）。
3. 开启右上角 **开发人员模式**。
4. 点击 **加载解压缩的扩展**，选择本项目根目录即可。

## 使用方法

1. 打开 `https://chat.deepseek.com` 并进入任意对话页面。
2. 点击浏览器工具栏中的 **DeepSeek Chat Exporter** 鲸鱼图标。
3. 确认状态为「API 就绪」或「DOM 模式」后，点击 **导出 Markdown**，浏览器将自动下载 `.md` 文件。

## 项目结构

```text
├── manifest.json          # MV3 扩展清单（v2.3.0）
├── content.js             # 内容脚本：API/DOM 双通道采集与 Markdown 渲染
├── popup.html             # 扩展弹窗界面（支持浅色 / 深色模式自适应）
├── popup.js               # 弹窗交互与状态通信逻辑
├── icon16.png             # 工具栏图标 (16×16)
├── icon48.png             # 扩展管理图标 (48×48)
├── icon128.png            # 商店与弹窗图标 (128×128)
├── tests/
│   └── edge-e2e.test.js   # 基于 Playwright + Microsoft Edge 的真实浏览器 E2E 测试
├── STORE_LISTING.md       # Edge 商店上架说明参考
└── PRIVACY.md             # 隐私政策说明
```

## 端到端测试（Microsoft Edge）

项目包含基于 Playwright 调用本机 Microsoft Edge 的真实扩展 E2E 测试（以网络拦截模拟页面与接口响应，验证扩展加载、状态识别、`.md` 与调试 `.json` 真实下载及浅/深色主题）：

```bash
# 需要本机安装 Microsoft Edge 及 playwright（全局或本地）
node tests/edge-e2e.test.js

# 可视化窗口运行
HEADLESS=false node tests/edge-e2e.test.js
```

## 隐私说明

详见 [PRIVACY.md](./PRIVACY.md)。本扩展不收集、存储或上传任何用户聊天数据到外部服务器。
