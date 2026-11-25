# Edge Add-ons 商店提交材料

## 扩展名称

DeepSeek Chat Exporter

## 详细描述

DeepSeek Chat Exporter 帮助你一键将 chat.deepseek.com 上的完整对话记录导出为标准 Markdown（.md）文件。

功能特点：
• 双通道采集：API 直取（完整可靠）+ DOM 滚动（未登录时兜底）
• 完整保留对话要素：你的提问、AI 回复、深度思考过程（Thinking）与思考耗时，以及附件与图片链接
• 纯净 Markdown 排版：开箱即用，轻松导入 Obsidian / Notion / 各类笔记与文档工具
• 导出速度快：API 模式下瞬间完成本地打包下载
• 本地处理零上传：所有数据仅在本地浏览器处理，不上传任何外部服务器

使用方式：
1. 在 chat.deepseek.com 打开任意对话页面
2. 点击浏览器右上角扩展图标
3. 点击「导出 Markdown」按钮，自动下载 `.md` 文件

适用场景：
• 重要 AI 对话存档与本地备份
• 导入知识库（Obsidian / Notion / Typora）
• 整理研究资料与代码问答笔记
• 分享或归档完整思考过程

---

## 隐私设置填写参考（Partner Center）

- **单一用途描述**：将用户当前打开的 DeepSeek（chat.deepseek.com）网页端对话记录在本地导出为 Markdown（.md）文件，完整保留用户提问、AI 回复、深度思考过程与附件链接。
- **activeTab 理由**：仅在用户点击扩展图标时读取当前激活标签页是否为 chat.deepseek.com 对话页，并通过消息通信触发当前对话的本地采集与下载。
- **主机权限理由（https://chat.deepseek.com/*）**：在 DeepSeek 对话页面注入内容脚本，仅在用户触发导出时读取当前会话 ID 与本地认证信息请求官方历史接口（或在未登录时读取页面 DOM 节点），全部处理在本地浏览器完成，不向任何第三方服务器传输或存储用户数据。
- **是否使用远程代码**：否
- **数据使用量**：全部不勾选（不收集或上传任何用户数据）

---

## 提交清单

- [x] zip 包：`deepseek-chat-exporter.zip`（v2.3.0）
- [x] 商店徽标：`300×300` PNG（新版鲸鱼导出图标）
- [x] 宣传截图：`1280×800` PNG（弹窗界面 + Markdown 导出效果展示）
- [x] 权限精简：已移除未使用的 `storage` 权限，仅保留 `activeTab` 与 `chat.deepseek.com/*`
