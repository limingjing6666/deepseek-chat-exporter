// ============================================================
// DeepSeek Chat Exporter — Content Script v2.3
// v2.1: 适配 DeepSeek 新版 fragments 格式
// v2.2: 导出文件附件（图片/文件）
// v2.3: 修复「用户消息丢失」——fragments 解析改为容错式，不再依赖 type 白名单
// 核心：API 直取（完整）+ DOM 滚动（兜底）
// ============================================================

const VERSION = '2.3.0';

// ---- 1. 配置 ----

const CONFIG = {
  // API 通道
  apiBase: 'https://chat.deepseek.com/api/v0',
  historyEndpoint: '/chat/history_messages',
  fileBase: 'https://chat.deepseek.com',

  // DOM 通道（兜底）
  scrollStep: 800,
  scrollInterval: 300,
  settleTime: 1500,
  maxStagnantRetries: 3,
  maxTotalScrolls: 200,
};

// ---- 2. DOM 选择器 ----

const SELECTORS = {
  scrollContainer: '._6d215eb.ds-scroll-area',
  messageItem: '._81e7b5e',
  textContent: '._72b6158',
  aiMessageClass: '_19d617c',
  thinkingContainer: '.ef46fbc6',
  thinkingContent: '.ef46fbc6 .fae5876e',
  label: '._942b85d',
  sidebarItem: '.ds-conversation-item, [class*="conversation"], .ds-sidebar, [class*="sidebar"]',
};

// ---- 3. 工具函数 ----

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---- 3a. API 消息解析（v2.3 容错式）----
// 教训：v2.1/v2.2 用白名单只认 type === 'TEXT'。DeepSeek 把用户消息的
// fragment 类型换成别的枚举值后，正文解析成空串，再被「空消息过滤」整条丢掉，
// 结果就是导出里只剩 AI 回复。现在改为：只有 THINK / FILE 走特殊分支，
// 其余凡是带文本的一律当正文，任何未知新类型都不会再丢内容。

let LAST_RAW = null; // 调试用：缓存最近一次 API 原始响应

function normType(t) {
  return String(t == null ? '' : t).toUpperCase();
}

/** 把任意形态的字段强制转成字符串（对象/数组也能兜住） */
function coerceText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(coerceText).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    // 常见包装：{ text } / { content } / { value } / { parts: [...] }
    for (const k of ['text', 'content', 'value', 'body', 'parts']) {
      if (v[k] != null) {
        const s = coerceText(v[k]);
        if (s) return s;
      }
    }
  }
  return '';
}

/** 从各种可能字段名里取出正文 */
function pickContent(f) {
  if (!f || typeof f !== 'object') return '';
  return coerceText(f.content) || coerceText(f.text) || coerceText(f.value) || '';
}

function normalizeFile(file, forceImage) {
  if (!file || typeof file !== 'object') return null;
  const signed = file.signed_path || file.signed_url || file.url || file.download_url || null;
  return {
    id: file.id || file.file_id || null,
    name: file.file_name || file.name || file.filename || '未命名附件',
    size: file.file_size || file.size || null,
    isImage: forceImage || !!file.is_image || normType(file.type) === 'IMAGE',
    width: file.width || null,
    height: file.height || null,
    url: signed ? (signed.startsWith('http') ? signed : `${CONFIG.fileBase}${signed}`) : null,
    status: file.status || null,
  };
}

/** 从一个 fragment / 消息体里收集附件 */
function collectFilesFrom(f, out) {
  if (!f || typeof f !== 'object') return;
  for (const g of [f.files, f.file_list, f.attachments, f.images]) {
    if (!Array.isArray(g)) continue;
    const forceImg = g === f.images;
    for (const file of g) {
      const nf = normalizeFile(file, forceImg);
      if (nf) out.push(nf);
    }
  }
  if (f.file && typeof f.file === 'object') {
    const nf = normalizeFile(f.file);
    if (nf) out.push(nf);
  }
}

/** 解析单条原始消息 → 统一格式 */
function parseRawMessage(m) {
  const isAi = normType(m.role) === 'ASSISTANT';

  const textParts = [];
  const thinkParts = [];
  const files = [];

  const frags = Array.isArray(m.fragments) ? m.fragments : [];

  for (const f of frags) {
    if (!f || typeof f !== 'object') continue;
    const t = normType(f.type);
    const body = pickContent(f);

    // 思考过程
    if (t === 'THINK' || t === 'THINKING' || t === 'REASONING' || t === 'COT') {
      if (body) thinkParts.push(body);
      continue;
    }

    // 纯附件 fragment
    if (t === 'FILE' || t === 'FILES' || t === 'IMAGE' || t === 'ATTACHMENT') {
      collectFilesFrom(f, files);
      continue;
    }

    // 其余一切（TEXT / REQUEST / RESPONSE / 未来新类型）→ 正文
    if (body) textParts.push(body);
    collectFilesFrom(f, files); // 顺手捡夹带的附件
  }

  // 正文兜底链：fragments → content → text
  let text = textParts.join('\n\n');
  if (!text) text = coerceText(m.content) || coerceText(m.text);

  // 思考兜底链
  const thinking = thinkParts.join('\n\n') || coerceText(m.thinking_content) || null;
  const thinkingSecs = typeof m.thinking_elapsed_secs === 'number' && m.thinking_elapsed_secs > 0
    ? m.thinking_elapsed_secs
    : null;

  // 顶层也可能挂附件
  collectFilesFrom(m, files);

  return {
    id: m.message_id ?? m.id ?? null,
    isAi,
    text,
    thinking,
    thinkingSecs,
    timestamp: m.inserted_at
      ? new Date(m.inserted_at * 1000)
      : (m.inserted_at_ms ? new Date(m.inserted_at_ms) : null),
    files: files.length ? files : undefined,
    _empty: !text && !thinking && files.length === 0,
  };
}

// ---- 3b. 其他工具 ----

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 下载文件并转为 base64 data URL（供 HTML 内嵌使用）
 */
async function fetchFileAsDataURL(fileUrl) {
  const token = extractToken();
  const resp = await fetch(fileUrl, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    credentials: 'include',
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve({ dataUrl: reader.result, mime: blob.type });
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Markdown 轻量渲染（代码块 / 粗体 / 行内代码 / 换行）
 * v2.3: 代码块先用占位符摘出来，避免最后一步的 \n→<br> 破坏 <pre> 内换行
 */
function renderMarkdownLite(text) {
  const codeBlocks = [];
  let html = escapeHtml(text).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre class="code-block"><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  // 行内代码
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  // 粗体
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 换行（此时代码块已不在正文中）
  html = html.replace(/\n/g, '<br>');
  // 还原代码块
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeBlocks[+i]);
  return html;
}

/**
 * 从页面 URL 提取 chat_session_id
 * 支持格式：
 *   /a/chat/s/<session_id>                          → 分享页
 *   /chat/<any>/<session_id>?first_message_id=...    → 普通页
 */
function extractSessionId() {
  const url = location.href;
  // 分享页: /a/chat/s/4e130776-8ccb-407d-a268-ce933962ead0
  const shareMatch = url.match(/\/a\/chat\/s\/([a-f0-9-]+)/);
  if (shareMatch) return shareMatch[1];
  // 普通页: URL中可能包含 session_id 参数
  const urlObj = new URL(url);
  const fromParam = urlObj.searchParams.get('chat_session_id');
  if (fromParam) return fromParam;
  return null;
}

/**
 * 从 localStorage 提取 userToken
 */
function extractToken() {
  try {
    const raw = localStorage.getItem('userToken');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.value || null;
  } catch {
    return null;
  }
}

// ---- 4. 通道1：API 直取 ★ 核心方法 ★ ----

async function fetchViaAPI() {
  const sessionId = extractSessionId();
  if (!sessionId) throw new Error('API: 无法从 URL 提取 session_id');

  const token = extractToken();
  if (!token) throw new Error('API: 未找到 userToken（未登录？）');

  const url = `${CONFIG.apiBase}${CONFIG.historyEndpoint}?chat_session_id=${sessionId}`;
  console.log('[DS Exporter] API 直取:', url);

  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    credentials: 'include',
  });

  if (!resp.ok) throw new Error(`API: HTTP ${resp.status}`);

  const json = await resp.json();

  // 错误码检查（v2.3：若数据结构本身可用，就不因 code 语义变化而误判失败）
  if (json.code !== 0 && !Array.isArray(json?.data?.biz_data?.chat_messages)) {
    throw new Error(`API: ${json.msg || 'unknown error'} (code ${json.code})`);
  }

  // 提取消息
  const rawMessages = json?.data?.biz_data?.chat_messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new Error('API: 返回数据中无消息');
  }

  const title = json?.data?.biz_data?.chat_session?.title || 'DeepSeek 对话';
  console.log(`[DS Exporter] API 返回 ${rawMessages.length} 条消息`);

  // 缓存原始响应，供「导出原始数据」调试用
  LAST_RAW = json;

  // ---- 转换为统一格式（v2.3：容错解析，不静默丢消息）----
  const messages = [];
  let unparsed = 0;

  for (const m of rawMessages) {
    const msg = parseRawMessage(m);
    if (msg._empty) {
      unparsed++;
      // 关键修复：宁可留占位，也不整条丢弃。
      // 以前这里直接 continue，导致用户消息一旦解析失败就彻底消失。
      msg.text = `[未解析出内容 · 原始字段: ${Object.keys(m).join(', ')}]`;
    }
    delete msg._empty;
    messages.push(msg);
  }

  const userCount = messages.filter(x => !x.isAi).length;
  const aiCount = messages.length - userCount;
  console.log(`[DS Exporter] 解析结果: 用户 ${userCount} 条 / AI ${aiCount} 条 / 未解析 ${unparsed} 条`);

  // ---- 一致性自检 ----
  let warning;
  if (messages.length > 0 && userCount === 0) {
    warning = 'API 未解析到任何用户消息，接口结构可能已变化，请用「原始数据」导出反馈';
  } else if (unparsed > 0) {
    warning = `${unparsed} 条消息未解析出内容（已在导出中标记）`;
  }

  // 分页检测：若接口改为分批返回，早期消息会被截断
  const biz = json?.data?.biz_data || {};
  if (biz.has_more === true || biz.has_more === 1) {
    warning = (warning ? warning + '；' : '') + '接口提示还有更多消息未拉取';
  }

  return { source: 'api', title, messages, warning, userCount, aiCount, unparsed };
}

// ---- 5. 通道2：DOM 滚动（兜底，仅 API 不可用时）----

function getVisibleCount() {
  return document.querySelectorAll(SELECTORS.messageItem).length;
}

function isAtBottom(container) {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 10;
}

function isSidebarElement(el) {
  return el.closest(SELECTORS.sidebarItem) !== null;
}

async function loadAllMessagesDOM() {
  const container = document.querySelector(SELECTORS.scrollContainer);
  if (!container) throw new Error('DOM: 未找到聊天容器');

  let prev = 0, stale = 0, steps = 0;
  console.log('[DS Exporter] DOM 滚动加载...');

  while (stale < CONFIG.maxStagnantRetries && steps < CONFIG.maxTotalScrolls) {
    steps++;
    container.scrollTop = Math.min(container.scrollTop + CONFIG.scrollStep, container.scrollHeight);
    await sleep(CONFIG.scrollInterval);

    if (isAtBottom(container)) {
      container.scrollTop = container.scrollHeight;
      await sleep(CONFIG.settleTime);
    }

    const cur = getVisibleCount();
    if (cur === prev) { stale++; }
    else { stale = 0; prev = cur; }

    if (isAtBottom(container) && stale >= CONFIG.maxStagnantRetries) break;
  }

  await sleep(CONFIG.settleTime);
  console.log(`[DS Exporter] DOM 可见消息: ${getVisibleCount()}`);
}

function parseMessageDOM(el, idx) {
  if (isSidebarElement(el)) return null;

  const textEl = el.querySelector(SELECTORS.textContent);
  let text = textEl ? textEl.textContent.trim() : '';

  let thinking = '';
  const tc = el.querySelector(SELECTORS.thinkingContainer);
  if (tc) {
    const inner = tc.querySelector(SELECTORS.thinkingContent) || tc;
    thinking = inner.textContent.trim();
  }

  // v2.3 兜底：主选择器失效（类名随版本变化）时，退回整段文本
  // 克隆一份再剔除思考块/按钮，避免把 thinking 混进正文造成重复
  if (!text) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(`${SELECTORS.thinkingContainer}, button, svg`).forEach(n => n.remove());
    text = clone.textContent.trim();
  }

  // 完全空的才丢弃（以前只要正文为空就丢，用户消息因此可能整条消失）
  if (!text && !thinking) return null;

  const isAi = el.classList.contains(SELECTORS.aiMessageClass) || thinking.length > 0;
  const labelEl = el.querySelector(SELECTORS.label);
  return { id: idx + 1, isAi, text, thinking: thinking || null, label: labelEl ? labelEl.textContent.trim() : '' };
}

async function fetchViaDOM() {
  await loadAllMessagesDOM();
  const items = document.querySelectorAll(SELECTORS.messageItem);
  const messages = [];

  for (let i = 0; i < items.length; i++) {
    const msg = parseMessageDOM(items[i], i);
    if (msg) messages.push(msg);
  }

  // 合并连续 AI 消息
  const merged = [];
  let pending = null;
  for (const m of messages) {
    if (m.isAi) {
      if (pending) {
        if (m.thinking && !pending.thinking) pending.thinking = m.thinking;
        if (m.text) pending.text += '\n\n' + m.text;
      } else { pending = { ...m }; }
    } else {
      if (pending) { merged.push(pending); pending = null; }
      merged.push(m);
    }
  }
  if (pending) merged.push(pending);

  // 检测倒序并翻转
  if (merged.length > 1 && merged[0].isAi && !merged[1].isAi) {
    merged.reverse();
  }

  const title = document.title.replace(' - DeepSeek', '').trim() || 'DeepSeek 对话';
  return { source: 'dom', title, messages: merged };
}

// ---- 6. 统一采集入口 ----

async function collectMessages() {
  let apiError = null;

  // 优先通道1
  try {
    const result = await fetchViaAPI();
    console.log(`[DS Exporter] ✅ API 通道成功: ${result.messages.length} 条`);
    return result;
  } catch (apiErr) {
    apiError = apiErr;
    console.warn('[DS Exporter] ⚠️ API 通道失败:', apiErr.message);
    console.log('[DS Exporter] → 降级到 DOM 通道...');
  }

  // 兜底通道2
  try {
    const result = await fetchViaDOM();
    console.log(`[DS Exporter] ✅ DOM 通道完成: ${result.messages.length} 条 (注意：可能不完整)`);
    return result;
  } catch (domErr) {
    throw new Error(`两个通道均失败。API: ${apiError?.message || 'N/A'}; DOM: ${domErr.message}`);
  }
}

// ---- 7. 格式渲染 ----

function toMarkdown(result) {
  const { title, messages, source } = result;
  if (!messages.length) return `# ${title}\n\n> 无消息内容`;

  let md = `# ${title}\n\n`;
  md += `> 导出时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
  md += `> 消息总数：${messages.length} 条 | 采集通道：${source === 'api' ? 'API（完整）' : 'DOM（可能不完整）'}\n\n---\n\n`;

  for (const m of messages) {
    md += `### ${m.isAi ? '🤖 AI' : '👤 用户'} · 第 ${m.id} 条\n\n`;

    // 附件
    if (m.files && m.files.length > 0) {
      for (const f of m.files) {
        const sizeStr = f.size ? ` (${formatFileSize(f.size)})` : '';
        if (f.isImage && f.url) {
          md += `📷 **${f.name}**${sizeStr}${f.width && f.height ? ` ${f.width}×${f.height}` : ''}\n\n`;
          md += `![${f.name}](${f.url})\n\n`;
        } else if (f.url) {
          md += `📎 **${f.name}**${sizeStr} — [下载](${f.url})\n\n`;
        } else {
          md += `📎 **${f.name}**${sizeStr}\n\n`;
        }
      }
    }

    if (m.thinking) {
      md += `> **💭 ${m.thinkingSecs ? `思考 ${m.thinkingSecs.toFixed(1)} 秒` : '思考过程'}：**\n>\n`;
      for (const line of m.thinking.split('\n')) md += `> ${line}\n`;
      md += `>\n\n`;
    }

    md += m.text + '\n\n';
    if (m.thinkingSecs) md += `*⏱️ ${m.thinkingSecs.toFixed(1)}s*\n\n`;
    md += '---\n\n';
  }
  md += `*由 DeepSeek Chat Exporter v${VERSION} 导出 · ${source === 'api' ? '完整版' : 'DOM版（可能缺失早期AI回复）'}*\n`;
  return md;
}

function toJSON(result) {
  const data = {
    title: result.title,
    url: location.href,
    source: result.source,
    exportTime: new Date().toISOString(),
    totalMessages: result.messages.length,
    messages: result.messages.map(m => ({
      id: m.id,
      role: m.isAi ? 'assistant' : 'user',
      content: m.text,
      thinking: m.thinking || undefined,
      thinkingElapsedSecs: m.thinkingSecs || undefined,
      timestamp: m.timestamp?.toISOString() || undefined,
      files: m.files || undefined,
    })),
  };
  return JSON.stringify(data, null, 2);
}

function toText(result) {
  const lines = [
    `=== ${result.title} ===`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `消息数：${result.messages.length} | 通道：${result.source}`,
    '========================================\n',
  ];
  for (const m of result.messages) {
    lines.push(`── ${m.isAi ? '🤖 AI' : '👤 用户'} · ${m.id} ──`);
    if (m.files && m.files.length > 0) {
      lines.push('\n【附件】');
      for (const f of m.files) {
        const sizeStr = f.size ? ` (${formatFileSize(f.size)})` : '';
        lines.push(`  📎 ${f.name}${sizeStr}${f.isImage ? ' [图片]' : ''}${f.url ? '\n     ' + f.url : ''}`);
      }
    }
    if (m.thinking) { lines.push('\n【思考过程】\n' + m.thinking); }
    lines.push('\n' + m.text + '\n');
    lines.push('───────────────────────────────\n');
  }
  return lines.join('\n');
}

// ---- 7b. HTML 渲染（单文件完整导出）----

async function toHTML(result) {
  const { title, messages, source } = result;
  const exportTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  let fileCount = 0;
  let thinkingCount = 0;

  // 预加载所有附件为 base64
  for (const m of messages) {
    if (m.thinking) thinkingCount++;
    if (m.files) {
      for (const f of m.files) {
        if (f.url && f.status === 'SUCCESS') {
          try {
            const { dataUrl, mime } = await fetchFileAsDataURL(f.url);
            f.dataUrl = dataUrl;
            f.mime = mime;
            fileCount++;
          } catch {
            // 保留 url，降级为链接
          }
        }
      }
    }
  }

  const iconAi = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/></svg>';
  const iconUser = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const iconThink = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>';
  const iconImg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  const iconClip = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

  const userCount = result.userCount ?? messages.filter(m => !m.isAi).length;
  const aiCount = result.aiCount ?? (messages.length - userCount);

  let body = '';
  for (const m of messages) {
    const roleClass = m.isAi ? 'ai' : 'user';
    const roleLabel = m.isAi ? 'DeepSeek AI' : '用户';
    const avatarIcon = m.isAi ? iconAi : iconUser;
    const timeStr = m.timestamp
      ? m.timestamp.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';

    body += `<article class="msg ${roleClass}">\n`;
    body += `  <div class="msg-header">\n`;
    body += `    <div class="role-wrap"><span class="avatar">${avatarIcon}</span><span class="role">${roleLabel}</span></div>\n`;
    if (timeStr) body += `    <span class="time">${timeStr}</span>\n`;
    body += `  </div>\n`;

    // 附件
    if (m.files && m.files.length > 0) {
      body += `  <div class="files">\n`;
      for (const f of m.files) {
        const sizeStr = f.size ? ` (${formatFileSize(f.size)})` : '';
        if (f.isImage && f.dataUrl) {
          body += `    <div class="file-item"><div class="file-head"><span class="file-name">${iconImg}<span>${escapeHtml(f.name)}${sizeStr}</span></span></div>`;
          body += `<img class="chat-image" src="${f.dataUrl}" alt="${escapeHtml(f.name)}" loading="lazy"></div>\n`;
        } else if (f.dataUrl) {
          body += `    <div class="file-item file-row"><span class="file-name">${iconClip}<span>${escapeHtml(f.name)}${sizeStr}</span></span>`;
          body += `<a class="file-link" href="${f.dataUrl}" download="${escapeHtml(f.name)}">下载文件</a></div>\n`;
        } else if (f.url) {
          body += `    <div class="file-item file-row"><span class="file-name">${iconClip}<span>${escapeHtml(f.name)}${sizeStr}</span></span>`;
          body += `<a class="file-link" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">打开链接</a></div>\n`;
        }
      }
      body += `  </div>\n`;
    }

    // 思考过程（可折叠）
    if (m.thinking) {
      const secsLabel = m.thinkingSecs ? `深度思考 · ${m.thinkingSecs.toFixed(1)} 秒` : '深度思考过程';
      body += `  <details class="thinking"><summary><span class="think-title">${iconThink}<span>${secsLabel}</span></span><span class="think-chevron" aria-hidden="true"></span></summary>\n`;
      body += `    <div class="thinking-content">${renderMarkdownLite(m.thinking)}</div>\n`;
      body += `  </details>\n`;
    }

    // 正文
    if (m.text) {
      body += `  <div class="msg-body">${renderMarkdownLite(m.text)}</div>\n`;
    }

    body += `</article>\n`;
  }

  const toggleThinkBtn = thinkingCount > 0
    ? `<button type="button" class="toolbar-btn" id="toggleAllThinking" data-open="false">展开全部思考 (${thinkingCount})</button>`
    : '';
  const toggleScript = thinkingCount > 0
    ? `<script>
(function(){
  var btn = document.getElementById('toggleAllThinking');
  if (!btn) return;
  btn.addEventListener('click', function(){
    var open = btn.getAttribute('data-open') !== 'true';
    document.querySelectorAll('details.thinking').forEach(function(d){ d.open = open; });
    btn.setAttribute('data-open', String(open));
    btn.textContent = (open ? '收起全部思考' : '展开全部思考') + ' (${thinkingCount})';
  });
})();
</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f6f8fc;
  --surface: #ffffff;
  --surface-sub: #f8fafc;
  --border: #e2e8f0;
  --text: #0f172a;
  --text-sub: #475569;
  --text-muted: #94a3b8;
  --brand: #4d6bfe;
  --brand-soft: rgba(77, 107, 254, 0.08);
  --brand-border: rgba(77, 107, 254, 0.22);
  --user: #0ea5e9;
  --code-bg: #0f172a;
  --code-fg: #e2e8f0;
  --inline-bg: #f1f5f9;
  --ok-bg: #ecfdf5;
  --ok-fg: #047857;
  --warn-bg: #fffbeb;
  --warn-fg: #b45309;
  --shadow: 0 1px 3px rgba(15, 23, 42, 0.05), 0 1px 2px rgba(15, 23, 42, 0.03);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b1120;
    --surface: #111827;
    --surface-sub: #1e293b;
    --border: #263244;
    --text: #f1f5f9;
    --text-sub: #cbd5e1;
    --text-muted: #64748b;
    --brand: #6382ff;
    --brand-soft: rgba(99, 130, 255, 0.12);
    --brand-border: rgba(99, 130, 255, 0.28);
    --user: #38bdf8;
    --code-bg: #020617;
    --code-fg: #e2e8f0;
    --inline-bg: #1e293b;
    --ok-bg: rgba(16, 185, 129, 0.14);
    --ok-fg: #6ee7b7;
    --warn-bg: rgba(245, 158, 11, 0.14);
    --warn-fg: #fcd34d;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
.container { max-width: 860px; margin: 0 auto; padding: 28px 16px 64px; }

.header {
  background: var(--surface);
  border: 1px solid var(--border);
  border-top: 3px solid var(--brand);
  border-radius: 14px;
  padding: 20px 24px;
  margin-bottom: 18px;
  box-shadow: var(--shadow);
}
.header-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.header h1 {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.3px;
  line-height: 1.35;
}
.toolbar-btn {
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: var(--brand);
  background: var(--brand-soft);
  border: 1px solid var(--brand-border);
  border-radius: 8px;
  padding: 5px 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity .15s, background-color .15s;
}
.toolbar-btn:hover { opacity: .88; }
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-sub);
}
.meta .badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
}
.badge.api { background: var(--ok-bg); color: var(--ok-fg); }
.badge.dom { background: var(--warn-bg); color: var(--warn-fg); }

.msg {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 22px;
  margin-bottom: 14px;
  box-shadow: var(--shadow);
}
.msg.ai { border-left: 3px solid var(--brand); }
.msg.user { border-left: 3px solid var(--user); }

.msg-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  font-size: 13px;
}
.role-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.avatar {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
}
.avatar svg { width: 14px; height: 14px; }
.msg.ai .avatar { background: linear-gradient(135deg, #5b7bff 0%, #3b5bdb 100%); }
.msg.user .avatar { background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%); }
.role { font-weight: 600; font-size: 13.5px; }
.msg.ai .role { color: var(--brand); }
.msg.user .role { color: var(--user); }
.time { color: var(--text-muted); font-size: 11px; }

.msg-body {
  font-size: 14.5px;
  line-height: 1.8;
  word-break: break-word;
}
.msg-body p { margin-bottom: 8px; }

.files { margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; }
.file-item {
  background: var(--surface-sub);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
}
.file-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.file-head { margin-bottom: 8px; }
.file-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-sub);
  word-break: break-all;
}
.file-name svg { width: 15px; height: 15px; flex-shrink: 0; color: var(--brand); }
.chat-image {
  max-width: 100%;
  max-height: 520px;
  border-radius: 8px;
  display: block;
  border: 1px solid var(--border);
}
.file-link {
  display: inline-block;
  padding: 4px 12px;
  background: var(--brand);
  color: #fff;
  border-radius: 6px;
  text-decoration: none;
  font-size: 12px;
  font-weight: 500;
}
.file-link:hover { opacity: .9; }

.thinking {
  background: var(--brand-soft);
  border: 1px solid var(--brand-border);
  border-radius: 10px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.thinking summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--brand);
  user-select: none;
}
.thinking summary::-webkit-details-marker { display: none; }
.think-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.think-title svg { width: 15px; height: 15px; flex-shrink: 0; }
.think-chevron {
  width: 8px;
  height: 8px;
  border-right: 1.8px solid currentColor;
  border-bottom: 1.8px solid currentColor;
  transform: rotate(45deg);
  transition: transform .15s ease;
  margin-right: 4px;
}
.thinking[open] .think-chevron { transform: rotate(-135deg); margin-top: 4px; }
.thinking-content {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--brand-border);
  font-size: 13px;
  color: var(--text-sub);
  line-height: 1.8;
}

.code-block {
  background: var(--code-bg);
  color: var(--code-fg);
  border: 1px solid var(--border);
  padding: 13px 16px;
  border-radius: 10px;
  overflow-x: auto;
  margin: 10px 0;
  font-size: 13px;
  line-height: 1.55;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', ui-monospace, monospace;
}
.inline-code {
  background: var(--inline-bg);
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 13px;
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', ui-monospace, monospace;
}

.footer {
  text-align: center;
  color: var(--text-muted);
  font-size: 11.5px;
  margin-top: 28px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

@media print {
  body { background: #fff; color: #000; }
  .container { max-width: 100%; padding: 0; }
  .header, .msg { box-shadow: none; break-inside: avoid-page; }
  .toolbar-btn { display: none; }
}
</style>
</head>
<body>
<div class="container">
  <header class="header">
    <div class="header-top">
      <h1>${escapeHtml(title)}</h1>
      ${toggleThinkBtn}
    </div>
    <div class="meta">
      <span>导出时间：${exportTime}</span>
      <span>消息总数：${messages.length} 条（用户 ${userCount} / AI ${aiCount}）</span>
      ${fileCount > 0 ? `<span>附件：${fileCount} 个（已内嵌）</span>` : ''}
      <span class="badge ${source === 'api' ? 'api' : 'dom'}">${source === 'api' ? 'API 完整版' : 'DOM 抓取'}</span>
    </div>
  </header>
  ${body}
  <footer class="footer">
    由 DeepSeek Chat Exporter v${VERSION} 导出 · 单文件完整备份
  </footer>
</div>
${toggleScript}
</body>
</html>`;
}

// ---- 8. 导出执行 ----

/** 文件名安全化：去非法字符 / 结尾点空格，按字符（非码元）截断避免切坏 emoji */
function safeFilename(s, max = 80) {
  const cleaned = String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const chars = Array.from(cleaned);
  const out = chars.length > max ? chars.slice(0, max).join('') : cleaned;
  return out || 'DeepSeek_对话';
}

function timestampForFilename() {
  return new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
}

function downloadString(content, filename, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return filename;
}

async function exportChat(format = 'markdown') {
  if (format === 'debug') return exportRawDebug();

  try {
    const result = await collectMessages();

    const safeTitle = safeFilename(result.title);

    let content, ext, mime;
    switch (format) {
      case 'html': content = await toHTML(result); ext = 'html'; mime = 'text/html'; break;
      case 'json': content = toJSON(result); ext = 'json'; mime = 'application/json'; break;
      case 'text': content = toText(result); ext = 'txt'; mime = 'text/plain'; break;
      default:     content = toMarkdown(result); ext = 'md'; mime = 'text/markdown';
    }

    const filename = downloadString(
      content,
      `deepseek_${safeTitle}_${timestampForFilename()}.${ext}`,
      mime
    );

    const userCount = result.userCount ?? result.messages.filter(m => !m.isAi).length;
    const aiCount = result.aiCount ?? (result.messages.length - userCount);

    // 合并通道级警告 + 采集自检警告
    const warnings = [];
    if (result.source === 'dom') warnings.push('DOM 通道：早期 AI 回复可能缺失');
    if (result.warning) warnings.push(result.warning);

    return {
      success: true,
      count: result.messages.length,
      userCount,
      aiCount,
      source: result.source,
      format,
      filename,
      warning: warnings.length ? warnings.join('；') : undefined,
    };
  } catch (err) {
    console.error('[DS Exporter] 导出失败:', err);
    return { success: false, error: err.message, format };
  }
}

// ---- 8c. 调试：导出原始 API 数据结构 ----
// 用于接口改版时快速定位字段变化，包含原始响应 + 解析预览 + DOM 侧信息

async function exportRawDebug() {
  const out = {
    exporterVersion: VERSION,
    collectedAt: new Date().toISOString(),
    pageUrl: location.href,
    extractedSessionId: extractSessionId(),
    hasToken: !!extractToken(),
  };

  try {
    const sessionId = extractSessionId();
    const token = extractToken();
    if (!sessionId) throw new Error('无法从 URL 提取 session_id');
    if (!token) throw new Error('未找到 userToken（未登录？）');

    const resp = await fetch(
      `${CONFIG.apiBase}${CONFIG.historyEndpoint}?chat_session_id=${sessionId}`,
      { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' }
    );

    out.apiHttpStatus = resp.status;
    const json = await resp.json();
    LAST_RAW = json;
    out.rawApiResponse = json;

    const msgs = json?.data?.biz_data?.chat_messages;
    if (Array.isArray(msgs)) {
      out.messageCount = msgs.length;
      out.rolesInOrder = msgs.map(m => m.role);
      out.fragmentTypeMatrix = msgs.map(m =>
        Array.isArray(m.fragments) ? m.fragments.map(f => f.type) : null
      );
      out.topLevelKeys = [...new Set(msgs.flatMap(m => Object.keys(m)))];
      out.fragmentKeys = [...new Set(
        msgs.flatMap(m => (Array.isArray(m.fragments) ? m.fragments : []))
            .flatMap(f => (f && typeof f === 'object' ? Object.keys(f) : []))
      )];
      out.parsePreview = msgs.map((m, i) => {
        const p = parseRawMessage(m);
        return {
          index: i,
          role: m.role,
          isAi: p.isAi,
          textLen: (p.text || '').length,
          thinkingLen: (p.thinking || '').length,
          files: (p.files || []).length,
          textHead: (p.text || '').slice(0, 40),
        };
      });
    }
  } catch (e) {
    out.apiError = e.message;
  }

  try {
    out.dom = {
      hasScrollContainer: !!document.querySelector(SELECTORS.scrollContainer),
      messageItemCount: document.querySelectorAll(SELECTORS.messageItem).length,
      hasTextSelector: !!document.querySelector(SELECTORS.textContent),
    };
  } catch {}

  const filename = downloadString(
    JSON.stringify(out, null, 2),
    `deepseek_debug_${timestampForFilename()}.json`,
    'application/json'
  );

  return {
    success: true,
    format: 'debug',
    filename,
    count: out.messageCount || 0,
    source: 'debug',
    warning: out.apiError ? `API 调用失败：${out.apiError}` : undefined,
  };
}

// ---- 8b. 附件下载 ----

async function downloadFiles() {
  const result = await collectMessages();
  const allFiles = [];
  for (const m of result.messages) {
    if (m.files) {
      for (const f of m.files) {
        if (f.url && f.status === 'SUCCESS') {
          allFiles.push(f);
        }
      }
    }
  }

  if (allFiles.length === 0) {
    return { success: true, count: 0, message: '当前对话无附件' };
  }

  const token = extractToken();
  const safeTitle = safeFilename(result.title, 60);

  let downloaded = 0;
  const errors = [];

  for (const f of allFiles) {
    try {
      const resp = await fetch(f.url, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      // a.download 不支持路径分隔符，用 "会话名_文件名" 代替目录结构
      const filename = `${safeFilename('deepseek_' + safeTitle, 40)}_${safeFilename(f.name, 80)}`;

      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      downloaded++;
      await sleep(300); // 避免过快触发下载
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }

  return {
    success: downloaded > 0,
    count: downloaded,
    total: allFiles.length,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function getStatus() {
  const token = extractToken();
  const sessionId = extractSessionId();
  const domCount = getVisibleCount();
  const hasContainer = !!document.querySelector(SELECTORS.scrollContainer);

  const channel = token && sessionId ? 'api' : (hasContainer ? 'dom' : 'none');

  return {
    ready: channel !== 'none',
    channel,
    visibleCount: domCount,
    hasToken: !!token,
    hasSessionId: !!sessionId,
    url: location.href,
  };
}

// ---- 10. Popup 通信 ----

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[DS Exporter] 收到消息:', request.action);
  if (request.action === 'export') {
    exportChat(request.format || 'markdown').then(sendResponse);
    return true;
  }
  if (request.action === 'downloadFiles') {
    downloadFiles().then(sendResponse);
    return true;
  }
  if (request.action === 'getStatus') {
    sendResponse(getStatus());
    return true;
  }
  sendResponse({ error: `未知操作: ${request.action}` });
  return true;
});

console.log(`[DS Exporter] v${VERSION} Content Script 已加载`);
console.log('[DS Exporter] 状态:', getStatus());
