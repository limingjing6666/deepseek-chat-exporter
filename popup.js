// ============================================================
// DeepSeek Chat Exporter — Popup v2.3.0 (Markdown Only)
// ============================================================

const STATUS_ICONS = {
  api: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  dom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  none: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
};

const RESULT_ICONS = {
  success: STATUS_ICONS.api,
  warn: STATUS_ICONS.dom,
  error: STATUS_ICONS.none,
};

document.addEventListener('DOMContentLoaded', async () => {
  const el = {
    statusPill: document.getElementById('statusPill'),
    statusText: document.getElementById('statusText'),
    channelInfo: document.getElementById('channelInfo'),
    channelIcon: document.getElementById('channelIcon'),
    channelText: document.getElementById('channelText'),
    exportBtn: document.getElementById('btnExportMd'),
    descMd: document.getElementById('descMd'),
    progress: document.getElementById('progress'),
    progressText: document.getElementById('progressText'),
    result: document.getElementById('result'),
    resultIcon: document.getElementById('resultIcon'),
    resultBody: document.getElementById('resultBody'),
    debugBtn: document.getElementById('btnDebug'),
  };

  function setStatus(text, type) {
    el.statusText.textContent = text;
    el.statusPill.className = `status-pill ${type}`;
  }

  function setChannel(text, type) {
    el.channelInfo.className = `channel ${type}`;
    el.channelIcon.innerHTML = STATUS_ICONS[type] || '';
    el.channelText.textContent = text;
  }

  function showResult({ cls, lines = [], filename = '' }) {
    el.result.className = `result ${cls}`;
    el.resultIcon.innerHTML = RESULT_ICONS[cls] || '';
    el.resultBody.textContent = '';

    for (const line of lines) {
      const span = document.createElement('span');
      span.className = 'result-line';
      span.textContent = line;
      el.resultBody.appendChild(span);
    }

    if (filename) {
      const fileTag = document.createElement('span');
      fileTag.className = 'result-file';
      fileTag.textContent = filename;
      el.resultBody.appendChild(fileTag);
    }
  }

  function setButtons(disabled) {
    if (el.exportBtn) el.exportBtn.disabled = disabled;
    if (el.debugBtn) el.debugBtn.disabled = disabled;
  }

  function showProgress(text) {
    el.progress.classList.add('active');
    el.progressText.textContent = text;
    el.result.className = 'result';
  }

  function hideProgress() {
    el.progress.classList.remove('active');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('chat.deepseek.com')) {
    setStatus('未匹配页面', 'none');
    setChannel('请先打开 chat.deepseek.com 对话页面', 'none');
    setButtons(true);
    return;
  }

  try {
    const st = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
    if (!st?.ready) {
      setStatus('页面未就绪', 'none');
      setChannel('未检测到对话内容，请进入具体对话或刷新重试', 'none');
      setButtons(true);
      return;
    }

    if (st.channel === 'api') {
      setStatus('API 就绪', 'api');
      setChannel('API 直取模式 · 完整导出对话与思考过程', 'api');
      el.descMd.textContent = '含对话正文、思考过程与耗时';
    } else {
      setStatus('DOM 模式', 'dom');
      setChannel('DOM 兜底模式 · 早期 AI 回复可能缺失，建议登录', 'dom');
      el.descMd.textContent = 'DOM 兜底采集，可能缺失部分回复';
    }
  } catch (e) {
    setStatus('连接失败', 'none');
    setChannel('无法连接页面脚本，请刷新 DeepSeek 页面后重试', 'none');
    showResult({ cls: 'error', lines: [e.message] });
    setButtons(true);
    return;
  }

  if (el.exportBtn) {
    el.exportBtn.addEventListener('click', async () => {
      setButtons(true);
      showProgress('正在导出 Markdown...');

      try {
        const r = await chrome.tabs.sendMessage(tab.id, { action: 'export', format: 'markdown' });
        hideProgress();
        setButtons(false);

        if (r.success) {
          const split = (r.userCount != null) ? `（用户 ${r.userCount} / AI ${r.aiCount}）` : '';
          const lines = [`已导出 ${r.count} 条消息${split}`];
          if (r.userCount === 0) {
            lines.push('未采集到任何用户消息，可点右下角「导出原始数据」排查');
          }
          if (r.warning) lines.push(r.warning);
          const cls = (r.userCount === 0 || r.source !== 'api') ? 'warn' : 'success';
          showResult({ cls, lines, filename: r.filename });
          setStatus('导出完成', r.source === 'api' ? 'api' : 'dom');
        } else {
          showResult({ cls: 'error', lines: [r.error || '导出失败'] });
          setStatus('导出失败', 'none');
        }
      } catch (e) {
        hideProgress();
        setButtons(false);
        showResult({ cls: 'error', lines: [`通信异常：${e.message}`] });
      }
    });
  }

  if (el.debugBtn) {
    el.debugBtn.addEventListener('click', async () => {
      setButtons(true);
      showProgress('正在收集原始数据结构...');
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { action: 'export', format: 'debug' });
        hideProgress();
        setButtons(false);
        if (r.success) {
          const lines = [`已导出原始数据（消息 ${r.count} 条）`];
          if (r.warning) lines.push(r.warning);
          lines.push('可将此 JSON 文件发给开发者以精确定位字段变化');
          showResult({
            cls: r.warning ? 'warn' : 'success',
            lines,
            filename: r.filename,
          });
        } else {
          showResult({ cls: 'error', lines: [r.error || '调试导出失败'] });
        }
      } catch (e) {
        hideProgress();
        setButtons(false);
        showResult({ cls: 'error', lines: [`通信异常：${e.message}`] });
      }
    });
  }
});
