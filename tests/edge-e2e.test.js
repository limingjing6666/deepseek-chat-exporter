// ============================================================
// DeepSeek Chat Exporter — Microsoft Edge 真实浏览器端到端测试
// 运行方式: node tests/edge-e2e.test.js
// 可选环境变量: HEADLESS=false 可视化观察 Edge 窗口执行过程
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function requirePlaywright() {
  try {
    return require('playwright');
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

const { chromium } = requirePlaywright();

const EXT_DIR = path.resolve(__dirname, '..');
const SESSION_URL = 'https://chat.deepseek.com/a/chat/s/00000000-0000-4000-8000-000000000001';
const HEADLESS = process.env.HEADLESS !== 'false';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function readDownloadText(download) {
  const filePath = await download.path();
  const text = fs.readFileSync(filePath, 'utf8');
  await download.delete().catch(() => {});
  return { filename: download.suggestedFilename(), text };
}

async function reloadPopupForActiveTab(activePage, popupPage) {
  await activePage.bringToFront();
  await popupPage.evaluate(() => location.reload());
  await popupPage.waitForFunction(() => {
    const t = document.getElementById('statusText')?.textContent || '';
    return t && t !== '检测中...';
  }, { timeout: 5000 });
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-exporter-edge-e2e-'));
  let ctx;
  let cdp;

  // 当前测试场景路由控制
  let mode = 'api'; // 'api' | 'dom'

  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      channel: 'msedge',
      headless: HEADLESS,
      acceptDownloads: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    });

    // 拦截 DeepSeek 与外部测试页面请求（实际扩展逻辑、Popup 与内容脚本均在真实 Edge 中运行）
    await ctx.route('https://example.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!DOCTYPE html><html><head><title>Example</title></head><body>Not DeepSeek</body></html>',
      })
    );

    await ctx.route('https://chat.deepseek.com/**', (route) => {
      const url = route.request().url();
      if (url.includes('/api/v0/chat/history_messages')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 0,
            data: {
              biz_data: {
                chat_session: {
                id: '00000000-0000-4000-8000-000000000001',
                title: 'Edge E2E 测试会话',
              },
                chat_messages: [
                  {
                    message_id: 1,
                    role: 'USER',
                    fragments: [
                      { type: 'REQUEST', content: '请解释一下快速排序的复杂度' },
                      {
                        type: 'FILE',
                        files: [
                          {
                            id: 'img-1',
                            file_name: 'diagram.png',
                            file_size: 2048,
                            is_image: true,
                            width: 800,
                            height: 600,
                            signed_path: '/files/diagram.png',
                            status: 'SUCCESS',
                          },
                        ],
                      },
                    ],
                  },
                  {
                    message_id: 2,
                    role: 'ASSISTANT',
                    thinking_elapsed_secs: 4.2,
                    fragments: [
                      { type: 'THINK', content: '先分析平均和最坏时间复杂度。' },
                      { type: 'RESPONSE', content: '平均时间复杂度为 O(n log n)。\n\n```js\nconsole.log("ok");\n```' },
                    ],
                  },
                ],
              },
            },
          }),
        });
      }

      if (mode === 'dom') {
        return route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!DOCTYPE html>
<html><head><title>DOM 兜底会话 - DeepSeek</title></head>
<body>
  <script>localStorage.removeItem('userToken');</script>
  <div class="_6d215eb ds-scroll-area" style="height:300px;overflow:auto;">
    <div class="_81e7b5e"><div class="_72b6158">DOM 用户提问内容</div></div>
    <div class="_81e7b5e _19d617c">
      <div class="ef46fbc6"><div class="fae5876e">DOM 思考内容</div></div>
      <div class="_72b6158">DOM AI 回复内容</div>
    </div>
  </div>
</body></html>`,
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html>
<html><head><title>Edge E2E 测试会话 - DeepSeek</title></head>
<body>
  <script>localStorage.setItem('userToken', JSON.stringify({ value: 'e2e-mock-token' }));</script>
  <div id="app">DeepSeek Session</div>
</body></html>`,
      });
    });

    cdp = await ctx.browser().newBrowserCDPSession();
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
    assert.ok(extId, 'Extensions.loadUnpacked 未返回扩展 ID');
    console.log(`\n[Edge] 已加载未打包扩展: ${extId} (headless=${HEADLESS})`);

    const pageErrors = [];
    const workPage = await ctx.newPage();
    const popupPage = await ctx.newPage();
    popupPage.on('pageerror', (e) => pageErrors.push(e.message));

    // ---- 1. 扩展弹窗基础加载与图标检查 ----
    console.log('\n[1] 扩展弹窗加载与资源校验');
    await popupPage.goto(`chrome-extension://${extId}/popup.html`);
    const logoLoaded = await popupPage.evaluate(() => {
      const img = document.querySelector('img.brand-logo');
      return !!img && img.complete && img.naturalWidth === 128;
    });
    check('弹窗标题正确', (await popupPage.title()) === 'DeepSeek Chat Exporter');
    check('新版鲸鱼图标正常加载 (128px)', logoLoaded);
    check('仅保留 Markdown 主导出按钮', (await popupPage.locator('.act').count()) === 1);
    check('导出按钮 data-format=markdown', (await popupPage.getAttribute('#btnExportMd', 'data-format')) === 'markdown');

    // ---- 2. 非 DeepSeek 页面禁用态 ----
    console.log('\n[2] 非 chat.deepseek.com 页面禁用校验');
    await workPage.goto('https://example.com/');
    await reloadPopupForActiveTab(workPage, popupPage);
    check('状态显示未匹配页面', (await popupPage.textContent('#statusText')) === '未匹配页面');
    check('导出按钮被禁用', await popupPage.isDisabled('#btnExportMd'));
    check('调试按钮被禁用', await popupPage.isDisabled('#btnDebug'));

    // ---- 3. API 模式完整导出 Markdown + 真实文件下载 ----
    console.log('\n[3] API 模式：状态识别与真实 .md 文件下载');
    mode = 'api';
    await workPage.goto(SESSION_URL);
    await workPage.waitForTimeout(300);
    await reloadPopupForActiveTab(workPage, popupPage);

    check('状态显示 API 就绪', (await popupPage.textContent('#statusText')) === 'API 就绪');
    check('通道提示为 API 模式', (await popupPage.getAttribute('#channelInfo', 'class')).includes('api'));
    check('导出按钮已启用', !(await popupPage.isDisabled('#btnExportMd')));

    const mdDlPromise = workPage.waitForEvent('download');
    await popupPage.click('#btnExportMd');
    const mdDl = await readDownloadText(await mdDlPromise);

    check('下载文件名符合 .md 规范', /^deepseek_Edge_E2E_测试会话_\d{8}T\d{6}\.md$/.test(mdDl.filename), mdDl.filename);
    check('Markdown 包含标题', mdDl.text.includes('# Edge E2E 测试会话'));
    check('Markdown 包含用户非 TEXT 类型消息', mdDl.text.includes('请解释一下快速排序的复杂度'));
    check('Markdown 包含图片附件', mdDl.text.includes('![diagram.png](https://chat.deepseek.com/files/diagram.png)'));
    check('Markdown 包含思考过程与耗时', mdDl.text.includes('思考 4.2 秒') && mdDl.text.includes('先分析平均和最坏时间复杂度。'));
    check('Markdown 包含 AI 回复与代码块', mdDl.text.includes('平均时间复杂度为 O(n log n)。') && mdDl.text.includes('```js'));

    await popupPage.waitForFunction(() => document.getElementById('result')?.classList.contains('success'));
    const apiResultText = await popupPage.textContent('#resultBody');
    check('弹窗展示用户/AI 消息统计与文件名', apiResultText.includes('已导出 2 条消息（用户 1 / AI 1）') && apiResultText.includes(mdDl.filename));

    // ---- 4. 调试原始数据 JSON 下载 ----
    console.log('\n[4] 导出原始数据（排查用）真实 JSON 下载');
    const dbgDlPromise = workPage.waitForEvent('download');
    await popupPage.click('#btnDebug');
    const dbgDl = await readDownloadText(await dbgDlPromise);
    check('调试文件名符合规范', /^deepseek_debug_\d{8}T\d{6}\.json$/.test(dbgDl.filename), dbgDl.filename);
    const dbgJson = JSON.parse(dbgDl.text);
    check('调试 JSON 版本与消息数正确', dbgJson.exporterVersion === '2.3.0' && dbgJson.messageCount === 2);
    check('调试 JSON 记录角色序列', JSON.stringify(dbgJson.rolesInOrder) === JSON.stringify(['USER', 'ASSISTANT']));

    // ---- 5. DOM 兜底模式测试 ----
    console.log('\n[5] DOM 兜底模式采集与降级提示');
    mode = 'dom';
    await workPage.goto(SESSION_URL);
    await workPage.waitForTimeout(300);
    await reloadPopupForActiveTab(workPage, popupPage);

    check('状态显示 DOM 模式', (await popupPage.textContent('#statusText')) === 'DOM 模式');
    check('通道提示为 DOM 警告态', (await popupPage.getAttribute('#channelInfo', 'class')).includes('dom'));

    const domDlPromise = workPage.waitForEvent('download');
    await popupPage.click('#btnExportMd');
    const domDl = await readDownloadText(await domDlPromise);
    check('DOM 模式导出包含用户与 AI 消息', domDl.text.includes('DOM 用户提问内容') && domDl.text.includes('DOM AI 回复内容'));
    check('DOM 模式导出包含思考内容', domDl.text.includes('DOM 思考内容'));
    await popupPage.waitForFunction(() => document.getElementById('result')?.classList.contains('warn'));
    check('DOM 模式弹窗提示 warn 状态', (await popupPage.getAttribute('#result', 'class')).includes('warn'));

    // ---- 6. 浅色 / 深色模式与布局溢出校验 ----
    console.log('\n[6] 浅色 / 深色主题适配与无溢出校验');
    await popupPage.emulateMedia({ colorScheme: 'light' });
    const lightBg = await popupPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await popupPage.emulateMedia({ colorScheme: 'dark' });
    const darkBg = await popupPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const overflow = await popupPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('浅色/深色模式背景色正常切换', lightBg !== darkBg, `light=${lightBg}, dark=${darkBg}`);
    check('弹窗无横向滚动溢出', !overflow);
    check('弹窗运行期间无 JS 异常', pageErrors.length === 0, pageErrors.join('; '));

    console.log(`\n结果: ${passed} 通过 / ${failed} 失败\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
    if (ctx) {
      for (const p of ctx.pages()) await p.close().catch(() => {});
      await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 3000))]);
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('E2E 执行异常:', err);
  process.exit(1);
});
