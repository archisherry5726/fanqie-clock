'use strict';
// 离屏渲染四个状态，截图存到 /tmp，不占屏幕
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PREVIEW_OUT || '/tmp';

function st(over) {
  return Object.assign({
    phase: 'running',
    planned: 1500,
    elapsed: 558,
    remaining: 942,
    progress: 0.628,
    category: 'create',
    categoryLabel: '独立创作',
    noteCount: 2,
    mode: 'fullscreen',
    urgent: false,
    sound: true,
    todayCount: 3,
    todayMinutes: 75,
    lastCategory: 'create'
  }, over);
}

const CASES = [
  ['full-idle',    st({ phase: 'idle', remaining: 1500, elapsed: 0, progress: 1, category: null, categoryLabel: '' })],
  ['full-running', st({})],
  ['full-urgent',  st({ remaining: 171, elapsed: 1329, progress: 0.114, urgent: true })],
  ['full-paused',  st({ phase: 'paused', remaining: 640, elapsed: 860, progress: 0.427 })],
  ['full-done',    st({ phase: 'finishing', remaining: 0, elapsed: 1500, progress: 0, urgent: true })],
  ['pet-running',  st({ mode: 'pet' })],
  ['pet-idle',     st({ mode: 'pet', phase: 'idle', remaining: 1500, progress: 1, categoryLabel: '' })],
  ['pet-urgent',   st({ mode: 'pet', remaining: 171, progress: 0.114, urgent: true })]
];

app.whenReady().then(async function () {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    frame: false, show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#0F0E0D',
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(function (r) { setTimeout(r, 400); });

  for (const pair of CASES) {
    const name = pair[0];
    const state = pair[1];
    const pet = state.mode === 'pet';

    win.setContentSize(pet ? 176 : 1280, pet ? 96 : 800);
    await new Promise(function (r) { setTimeout(r, 150); });

    await win.webContents.executeJavaScript(
      'window.__render(' + JSON.stringify(state) + '); document.body.dataset.mode="' + state.mode + '";'
    );
    await new Promise(function (r) { setTimeout(r, 700); });

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, 'pv-' + name + '.png'), img.toPNG());
    console.log('saved', name, img.getSize().width + 'x' + img.getSize().height);
  }

  app.quit();
});
