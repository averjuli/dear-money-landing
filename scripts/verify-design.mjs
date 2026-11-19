import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Browser QA uses the locally installed Edge and Node's built-in CDP transport.
// Run the preview first, then: node scripts/verify-design.mjs
const origin = process.env.PREVIEW_URL || 'http://localhost:4173';
const executable = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const debuggingPort = 9224;
const compareOriginal = process.argv.includes('--compare-original');
const widths = process.argv.includes('--responsive') ? [280, 320, 360, 375, 393, 430, 600, 768, 1024, 1440] : [393, 1440];
const browser = spawn(executable, [
  '--headless=new', '--hide-scrollbars', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${debuggingPort}`,
  `--user-data-dir=${path.resolve('.preview-browser')}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
browser.stderr.on('data', data => console.error(String(data).slice(0, 2000)));
browser.on('error', error => { console.error(error); process.exitCode = 1; });

async function connect() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json();
      const target = targets.find(item => item.type === 'page');
      if (target) return target.webSocketDebuggerUrl;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Edge debugging endpoint did not become available');
}

let socket;
try {
  socket = new WebSocket(await connect());
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  console.log('Connected to Edge');
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.enable');
  await mkdir('screenshots', { recursive: true });
  const report = [];
  for (const width of widths) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 600 });
    const captures = {};
    for (const [label, pathname] of [['reference', '/design/index.html'], ['landing', '/']]) {
      await call('Page.navigate', { url: `${origin}${pathname}` });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate('document.readyState === "complete"')) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      const details = await evaluate(`({
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        fonts: {
          golos: Array.from(document.fonts).some(face => face.family.includes('Golos Text') && face.status === 'loaded'),
          unbounded: Array.from(document.fonts).some(face => face.family.includes('Unbounded') && face.status === 'loaded')
        },
        text: document.body.innerText.replace(/\\s+/g, ' ').trim(),
        links: Array.from(document.querySelectorAll('a'), a => ({text: a.textContent, href: a.getAttribute('href')})),
        h1Count: document.querySelectorAll('h1').length,
        mockups: document.querySelectorAll('[role="img"]').length,
        outOfBounds: Array.from(document.querySelectorAll('body *')).filter(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.width > 0 && (bounds.left < -0.5 || bounds.right > innerWidth + 0.5);
        }).map(element => element.className || element.tagName),
        smallTouchTargets: Array.from(document.querySelectorAll('a')).filter(element => element.getBoundingClientRect().height < 44).map(element => element.textContent)
      })`);
      const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: details.height, scale: 1 } });
      const screenshot = Buffer.from(data, 'base64');
      await writeFile(`screenshots/${label}-${width}.png`, screenshot);
      captures[label] = { ...details, screenshot };
    }
    const { reference, landing } = captures;
    if (compareOriginal) assert.equal(landing.text, reference.text, `Text must match at ${width}px`);
    assert.ok(landing.scrollWidth <= width, `Horizontal overflow at ${width}px`);
    assert.deepEqual(landing.outOfBounds, [], `Elements outside the viewport at ${width}px`);
    assert.deepEqual(landing.smallTouchTargets, [], `Links must be at least 44px high at ${width}px`);
    assert.ok(landing.fonts.golos && landing.fonts.unbounded, `Local brand fonts must load at ${width}px`);
    assert.equal(landing.h1Count, 1);
    assert.equal(landing.mockups, 4);
    assert.equal(landing.links.filter(link => link.href === 'https://app.dearmoney.space/').length, 3);
    assert.equal(landing.links.filter(link => link.href === '#how').length, 2);
    const anchor = await evaluate(`(async () => {
      document.querySelector('a[href="#how"]').click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      return { hash: location.hash, top: document.getElementById('how').getBoundingClientRect().top };
    })()`);
    assert.equal(anchor.hash, '#how');
    assert.ok(Math.abs(anchor.top) < 1, 'How anchor should scroll into view');
    report.push({ width, height: landing.height, referenceHeight: reference.height, fonts: landing.fonts, referenceFonts: reference.fonts, originalComparisonRequired: compareOriginal, identicalScreenshots: landing.screenshot.equals(reference.screenshot), textMatches: landing.text === reference.text, appLinks: 3, anchorWorks: true, noHorizontalOverflow: true, allElementsFit: true, touchTargetsAtLeast44px: true });
    console.log(JSON.stringify(report.at(-1), null, 2));
  }
  await writeFile('screenshots/report.json', `${JSON.stringify(report, null, 2)}\n`);
  if (compareOriginal) {
    assert.ok(report.every(result => result.identicalScreenshots), 'Screenshots differ from the reference; inspect screenshots/');
    console.log('Both viewport screenshots match the reference exactly.');
  } else {
    console.log(`Layout, fonts, touch targets, links and navigation pass at ${widths.join(', ')}px. Copy revisions intentionally differ from the original design; inspect updated screenshots/.`);
  }
  if (!report.every(result => result.fonts.golos && result.fonts.unbounded)) {
    console.log('Required Google Fonts are unavailable. Screenshots use fallback fonts; visual verification with the required fonts remains incomplete. See MANUAL_CHECK.md.');
  }
} finally {
  socket?.close();
  browser.kill();
}
