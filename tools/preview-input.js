'use strict';
// 离屏渲染输入浮层的两个状态，截图到 /tmp，不占屏幕
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PREVIEW_OUT || '/tmp';

app.whenReady().then(async function () {
  const win = new BrowserWindow({
    width: 560, height: 330,
    frame: false, show: false,
    transparent: true,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'input.html'));
  await new Promise(function (r) { setTimeout(r, 500); });

  const cases = [
    ['input-finish', 236, 'finish', { minutes: 25, category: 'think', noteCount: 2 }],
    ['input-note', 168, 'note', { categoryLabel: '独立创作' }]
  ];

  for (const c of cases) {
    win.setContentSize(560, c[1]);
    await new Promise(function (r) { setTimeout(r, 200); });
    const payload = JSON.stringify({ mode: c[2], payload: c[3] });
    const r = await win.webContents.executeJavaScript(
      '(function(){ try { if (!window.__open) return "NO __open"; window.__open(' + payload + '); ' +
      'return document.getElementById("title").textContent + " | cats hidden=" + document.getElementById("cats").hidden; } ' +
      'catch(e) { return "ERR " + e.message; } })()'
    );
    console.log(c[0], '->', r);
    const panelH = await win.webContents.executeJavaScript(
      'Math.ceil(document.getElementById("panel").getBoundingClientRect().height)'
    );
    const panelW = await win.webContents.executeJavaScript(
      'Math.ceil(document.getElementById("panel").getBoundingClientRect().width)'
    );
    win.setContentSize(panelW, panelH);
    await new Promise(function (r2) { setTimeout(r2, 250); });
    await new Promise(function (r) { setTimeout(r, 500); });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'pv-' + c[0] + '.png'), img.toPNG());
    console.log('saved', c[0], img.getSize().width + 'x' + img.getSize().height);
  }

  app.quit();
});
