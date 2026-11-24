'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu,
        nativeImage, shell, powerSaveBlocker, powerMonitor, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./lib/store');
const report = require('./lib/report');
const { performance } = require('node:perf_hooks');

// 开发与打包共用同一份数据目录
app.setPath('userData', store.APP_DIR);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let displayWin = null;
let inputWin = null;
let tray = null;
let sleepBlocker = null;
let autoFinishTimer = null;
let tickTimer = null;
let inputReady = false;
let pendingInput = null;
let moveTimer = null;
let modeRevision = 0;
let applyingUntil = 0; // 自己正在切屏的时间窗；期间忽略系统发来的显示器变化事件

const PET_SIZE = { width: 176, height: 96 };

const T = {
  phase: 'idle',        // idle | running | paused | finishing
  startedAt: 0,
  startedMono: 0,
  endedAt: 0,
  pausedTotal: 0,
  pausedAt: 0,
  planned: 1500,
  sessionId: null,
  category: null,
  notes: [],
  warned: false,
  mode: 'fullscreen'
};

// ---------------- 计时 ----------------

function makeId() {
  const d = new Date();
  return '' + d.getFullYear() + store.pad(d.getMonth() + 1) + store.pad(d.getDate()) +
    '-' + store.pad(d.getHours()) + store.pad(d.getMinutes()) +
    '-' + Math.random().toString(36).slice(2, 6);
}

function elapsedMs() {
  if (T.phase === 'idle' || !T.startedAt) return 0;
  if (T.phase === 'finishing') return T.planned * 1000;
  const live = T.phase === 'paused' ? T.pausedAt : performance.now();
  const v = live - T.startedMono - T.pausedTotal;
  return Math.max(0, v);
}

function snapshot() {
  const planned = T.planned;
  const elapsed = Math.min(planned, Math.floor(elapsedMs() / 1000));
  const remaining = T.phase === 'idle' ? planned : Math.max(0, planned - elapsed);
  const stats = store.todayStats();
  const cfg = store.getConfig();
  return {
    phase: T.phase,
    planned,
    elapsed,
    remaining,
    progress: planned ? (T.phase === 'idle' ? 1 : Math.max(0, 1-elapsedMs()/(planned*1000))) : 1,
    motion: cfg.motion !== false,
    category: T.category,
    categoryLabel: store.CATEGORY_LABEL[T.category] || '',
    noteCount: T.notes.length,
    mode: T.mode,
    urgent: T.phase === 'running' && remaining <= 180,
    sound: cfg.sound,
    todayCount: stats.count,
    todayMinutes: stats.minutes,
    lastCategory: cfg.lastCategory || 'create'
  };
}

function broadcast() {
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.webContents.send('state', snapshot());
  }
}

function playSound(kind) {
  if (!store.getConfig().sound) return;
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.webContents.send('play-sound', kind);
  }
}

function startSleepBlocker() {
  if (sleepBlocker !== null) return;
  if (!store.getConfig().preventSleep) return;
  try { sleepBlocker = powerSaveBlocker.start('prevent-display-sleep'); } catch (e) { sleepBlocker = null; }
}

function stopSleepBlocker() {
  if (sleepBlocker === null) return;
  try { if (powerSaveBlocker.isStarted(sleepBlocker)) powerSaveBlocker.stop(sleepBlocker); } catch (e) {}
  sleepBlocker = null;
}

function startSession() {
  if (T.phase === 'running' || T.phase === 'paused' || T.phase === 'finishing') return;
  const cfg = store.getConfig();
  T.sessionId = makeId();
  T.startedAt = Date.now();
  T.startedMono = performance.now();
  T.endedAt = 0;
  T.pausedTotal = 0;
  T.pausedAt = 0;
  T.planned = cfg.plannedSeconds || 1500;
  T.notes = [];
  T.warned = false;
  T.category = cfg.lastCategory || 'create';
  T.phase = 'running';
  store.appendEvent({ type: 'start', id: T.sessionId, planned: T.planned, category: T.category });
  startSleepBlocker();
  broadcast();
  refreshTrayMenu();
  toast('开始 · ' + store.CATEGORY_LABEL[T.category]);
}

function pauseSession() {
  if (T.phase !== 'running') return;
  T.pausedAt = performance.now();
  T.phase = 'paused';
  stopSleepBlocker();
  broadcast();
  refreshTrayMenu();
  toast('已暂停');
}

function resumeSession() {
  if (T.phase !== 'paused') return;
  T.pausedTotal += performance.now() - T.pausedAt;
  T.pausedAt = 0;
  T.phase = 'running';
  startSleepBlocker();
  broadcast();
  refreshTrayMenu();
  toast('继续');
}

function toggleTimer() {
  if (T.phase === 'idle') startSession();
  else if (T.phase === 'running') pauseSession();
  else if (T.phase === 'paused') resumeSession();
}

function finishTimer() {
  if (T.phase !== 'running') return;
  T.phase = 'finishing';
  T.endedAt = Date.now();
  stopSleepBlocker();
  store.appendEvent({ type: 'end', id: T.sessionId, actual: T.planned, status: 'done', category: T.category });
  playSound('done');
  broadcast();
  refreshTrayMenu();
  showInput('finish', {
    category: T.category,
    noteCount: T.notes.length,
    minutes: Math.round(T.planned / 60)
  });
  clearTimeout(autoFinishTimer);
  autoFinishTimer = setTimeout(function () {
    commitFinish({ category: T.category, text: '', auto: true });
  }, 60000);
}

function commitFinish(data) {
  clearTimeout(autoFinishTimer);
  if (!T.sessionId || T.phase !== 'finishing') return;
  hideInput();
  const id = T.sessionId;
  const startISO = store.localISO(new Date(T.startedAt));
  const category = data.category || T.category || 'create';
  const notes = T.notes.slice();

  if (data.text && data.text.trim()) {
    const n = { t: store.localISO(), text: data.text.trim() };
    notes.push(n);
    store.appendEvent({ type: 'note', id: id, text: n.text });
  }
  if (category !== T.category) {
    store.appendEvent({ type: 'category', id: id, category: category });
  }
  store.saveConfig({ lastCategory: category });

  const session = {
    id: id,
    start: startISO,
    end: store.localISO(new Date(T.endedAt)),
    planned: T.planned,
    actual: T.planned,
    category: category,
    status: 'done',
    notes: notes,
    interrupted: false
  };
  try {
    store.writeSessionToMD(session);
    toast('已存下 · ' + (store.CATEGORY_LABEL[category] || '') + ' ' + Math.round(T.planned / 60) + '′');
  } catch (e) {
    toast('写入失败：' + e.message);
  }
  resetState();
}

function voidSession() {
  if (!T.sessionId || T.phase === 'finishing') return;
  const actual = Math.round(elapsedMs() / 1000);
  const id = T.sessionId;
  store.appendEvent({ type: 'void', id: id, actual: actual });
  const session = {
    id: id,
    start: store.localISO(new Date(T.startedAt)),
    end: store.localISO(),
    planned: T.planned,
    actual: actual,
    category: T.category,
    status: 'void',
    notes: T.notes.slice(),
    interrupted: false
  };
  try { store.writeSessionToMD(session); } catch (e) { toast('写入失败：' + e.message); }
  hideInput();
  resetState();
  toast('已作废 · 不计入失败');
}

function resetState() {
  clearTimeout(autoFinishTimer);
  autoFinishTimer = null;
  stopSleepBlocker();
  T.phase = 'idle';
  T.startedAt = 0;
  T.pausedTotal = 0;
  T.pausedAt = 0;
  T.sessionId = null;
  T.notes = [];
  T.warned = false;
  T.category = store.getConfig().lastCategory || 'create';
  T.planned = store.getConfig().plannedSeconds || 1500;
  broadcast();
  refreshTrayMenu();
}

function tick() {
  if (T.phase !== 'running' && T.phase !== 'paused') return;
  broadcast();
  if (T.phase !== 'running') return;
  const rem = T.planned - elapsedMs() / 1000;
  if (!T.warned && rem <= 180) {
    T.warned = true;
    playSound('warn');
    broadcast();
  }
  if (rem <= 0) finishTimer();
}

// ---------------- 窗口 ----------------

// 屏幕按位置排序（先上后下、先左后右），这样「下一块屏」每次都是可预期的
function orderedDisplays() {
  return screen.getAllDisplays().slice().sort(function (a, b) {
    if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y;
    return a.bounds.x - b.bounds.x;
  });
}

// 全屏时钟放哪块屏。
// 规则：显式指定优先 → 否则放「面积最小的那块」。
// 为什么不是「主屏 / 非主屏」：她的大屏才是办公屏，而 macOS 的主屏往往另有其人。
// 面积最小的那块通常就是被闲置的屏，放仪表最合理；选错了在菜单里改一次就永久记住。
function pickDisplay() {
  const displays = screen.getAllDisplays();
  const cfg = store.getConfig();
  if (cfg.displayId === 'cursor') return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (cfg.displayId != null) {
    const found = displays.find(function (d) { return d.id === cfg.displayId; });
    if (found) return found;
  }
  const sorted = displays.slice().sort(function (a, b) {
    return a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height;
  });
  return sorted[0] || screen.getPrimaryDisplay();
}

// 给菜单和提示用的屏名，带分辨率，方便她确认「刚才挪到了哪块」
function displayName(d) {
  const size = d.bounds.width + '×' + d.bounds.height;
  const name = (d.label || '显示器').trim();
  const main = d.id === screen.getPrimaryDisplay().id ? ' · 主屏' : '';
  return name + ' · ' + size + main;
}

// 手动指定时钟屏。'cursor' = 跟着鼠标那块，null = 自动（最小那块）
function chooseDisplay(value) {
  store.saveConfig({ displayId: value });
  if (T.mode === 'fullscreen') {
    applyMode('fullscreen', false);
  } else {
    // 名片态跟着鼠标走，所以只记下选择，等切全屏时生效
    store.saveConfig({ petPos: null });
    applyMode('pet', false);
  }
  refreshTrayMenu();
  if (value === null) toast('时钟屏：自动（放在最小的一块屏）');
  else if (value === 'cursor') toast('时钟屏：跟着鼠标所在屏');
  else toast('时钟屏 → ' + displayName(pickDisplay()));
}

// 一键挪到下一块屏：全屏态点不到界面，所以这个必须有键盘入口
function cycleDisplay() {
  const displays = orderedDisplays();
  if (displays.length < 2) {
    toast('只接着一块屏，没地方可挪');
    return;
  }
  const cur = pickDisplay();
  const idx = displays.findIndex(function (d) { return d.id === cur.id; });
  const next = displays[(idx + 1) % displays.length];
  store.saveConfig({ displayId: next.id, petPos: null });
  applyMode(T.mode, false);
  refreshTrayMenu();
  toast('时钟 → ' + displayName(next));
}

function resolveMode() {
  const cfg = store.getConfig();
  const multi = screen.getAllDisplays().length > 1;
  // 单屏时绝不进全屏态：那是一块不透明的整屏，会把她唯一的工作屏盖掉
  if (!multi) return 'pet';
  if (cfg.mode === 'fullscreen' || cfg.mode === 'pet') return cfg.mode;
  return 'fullscreen';
}

function boundsFor(mode, display) {
  const wa = display.workArea || display.bounds;
  if (mode === 'pet') {
    // 上次拖到哪就回到哪；但只在这块屏内才认，换了屏就用右上角默认位
    const p = store.getConfig().petPos;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
        p.x >= wa.x - 40 && p.x < wa.x + wa.width &&
        p.y >= wa.y - 40 && p.y < wa.y + wa.height) {
      const x = Math.min(Math.max(p.x, wa.x), wa.x + wa.width - PET_SIZE.width);
      const y = Math.min(Math.max(p.y, wa.y), wa.y + wa.height - PET_SIZE.height);
      return { x: Math.round(x), y: Math.round(y),
               width: PET_SIZE.width, height: PET_SIZE.height };
    }
    return {
      x: Math.round(wa.x + wa.width - PET_SIZE.width - 28),
      y: Math.round(wa.y + 28),
      width: PET_SIZE.width,
      height: PET_SIZE.height
    };
  }
  // 全屏态盖满整块屏（含菜单栏），否则顶部那条进度线会被系统菜单栏压住
  return { x: display.bounds.x, y: display.bounds.y,
           width: display.bounds.width, height: display.bounds.height };
}

// 全屏态固定在「不是主屏」的那块屏；名片态跟着鼠标走，因为她要把它拉回正在工作的屏
function displayForMode(mode) {
  if (mode === 'fullscreen') return pickDisplay();
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// 系统会在启动、换屏、唤醒后静默丢掉 simpleFullScreen（窗口刚显示时尤其容易），
// 丢了的表现就是「顶部菜单栏又回来了」。所以上面那一步之后要盯一会儿，直到真的进去。
// 注意：它自己也会触发 display-metrics-changed，所以必须落在「自己切屏」的时间窗之外，
// 否则会变成「补一次全屏 → 系统发事件 → 再补一次」的死循环，屏幕上就是一直在跳。
function isSimpleFS() {
  try { return displayWin.isSimpleFullScreen(); } catch (e) { return false; }
}

function sameRect(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function ensureSimpleFS(tries) {
  const left = tries == null ? 3 : tries;
  if (!displayWin || displayWin.isDestroyed() || T.mode !== 'fullscreen') return;
  // 正在"让开"：此刻就该待在全屏之外，别把她刚让开的那片屏又抢回来
  if (clockAway) return;
  if (Date.now() < applyingUntil) {
    setTimeout(function () { ensureSimpleFS(left); }, 400);
    return;
  }
  if (isSimpleFS()) return;
  applyingUntil = Date.now() + 900;
  try { displayWin.setSimpleFullScreen(true); } catch (e) {}
  if (left > 0) setTimeout(function () { ensureSimpleFS(left - 1); }, 700);
}

function applyMode(mode, persist) {
  if (!displayWin || displayWin.isDestroyed()) return;
  const display = displayForMode(mode);
  const b = boundsFor(mode, display);
  if (persist) store.saveConfig({ mode: mode });

  // 幂等：已经是这个状态就什么都不做。
  // 这一条是「不再跳」的关键——进全屏本身会改 visible workArea，
  // 系统随即发 display-metrics-changed，若这里不判重就会自己触发自己，无限循环。
  const settled = T.mode === mode && sameRect(displayWin.getBounds(), b) &&
                  (mode !== 'fullscreen' || isSimpleFS());
  if (settled) return;

  T.mode = mode;
  applyingUntil = Date.now() + 1200;

  // 切形态 / 换屏之前先把"让开"状态收掉，否则窗口会一直藏着叫不回来
  if (clockAway) { clockAway = false; try { displayWin.show(); } catch (e) {} }

  if (mode === 'fullscreen') {
    // 默认仍让鼠标穿透：这一屏是「墙上的钟」，不该抢走点击。
    // 只有鼠标移到右上角退出按钮附近时，由渲染层通知这里临时接管（见 hot-zone）。
    displayWin.setIgnoreMouseEvents(true, { forward: true });
    displayWin.setMovable(false);
    // 已经处在 simpleFullScreen 时改 bounds 会被系统忽略，
    // 所以换屏必须先退出 simpleFullScreen，挪过去再进
    const revision = ++modeRevision;
    const wasFullscreen = isSimpleFS();
    try { displayWin.setSimpleFullScreen(false); } catch (e) {}
    displayWin.setAlwaysOnTop(true, 'screen-saver');
    // macOS restores the previous frame while leaving simple fullscreen.
    // Move only after that restore, then enter fullscreen on the new display.
    setTimeout(function () {
      if (!displayWin || displayWin.isDestroyed() || T.mode !== 'fullscreen' || revision !== modeRevision) return;
      displayWin.setBounds(b);
      setTimeout(function () {
        if (!displayWin || displayWin.isDestroyed() || T.mode !== 'fullscreen' || revision !== modeRevision) return;
        try { displayWin.setSimpleFullScreen(true); } catch (e) {}
        ensureSimpleFS();
      }, 150);
    }, wasFullscreen ? 250 : 0);
  } else {
    ++modeRevision;
    // 名片要浮在所有窗口之上，否则被工作窗口一盖就再也看不见了
    try { displayWin.setSimpleFullScreen(false); } catch (e) {}
    displayWin.setIgnoreMouseEvents(false);
    displayWin.setFocusable(true);
    displayWin.setAlwaysOnTop(true, 'floating');
    displayWin.setMovable(true);
    displayWin.setBounds(b);
  }
  displayWin.webContents.send('mode', mode);
  if (process.env.POMODORO_DEBUG) {
    console.log('[mode]', mode, 'want', JSON.stringify(b), 'got', JSON.stringify(displayWin.getBounds()),
      'display', JSON.stringify({ bounds: display.bounds, workArea: display.workArea, scale: display.scaleFactor }));
  }
  broadcast();
  refreshTrayMenu();
}

function toggleMode() {
  if (T.mode === 'pet' && screen.getAllDisplays().length < 2) {
    toast('只有一块屏 · 保留桌面名片'); return;
  }
  applyMode(T.mode === 'fullscreen' ? 'pet' : 'fullscreen', true);
  toast(T.mode === 'fullscreen' ? '全屏常驻' : '桌面名片');
}

// 插拔外接屏时重算：只剩一块屏就退回名片态，否则全屏会盖住她唯一的工作屏
function reconcileDisplays() {
  if (!displayWin || displayWin.isDestroyed()) return;
  // 自己刚切完屏，系统还在连续发事件（进全屏会让 visible workArea 变大），
  // 这段时间内一律不理，否则会形成「改全屏 → 事件 → 再改全屏」的回环
  if (Date.now() < applyingUntil) return;
  // 「让开」期间不是全屏几何，重算只会把她刚让开的那片屏抢回来
  if (clockAway) return;

  const count = screen.getAllDisplays().length;
  if (count <= 1 && T.mode === 'fullscreen') {
    applyMode('pet', true);
    toast('只剩一块屏 · 已退回桌面名片');
    return;
  }

  // 她手动指定过的那块屏被拔掉了：临时借用还在的屏，插回来自动回去
  const cfg = store.getConfig();
  let chosenMissing = false;
  if (cfg.displayId != null && cfg.displayId !== 'cursor') {
    chosenMissing = !screen.getAllDisplays().some(function (d) { return d.id === cfg.displayId; });
  }

  // 目标几何没变就只刷菜单，绝不动窗口——大部分 display 事件都属于这一类
  const target = displayForMode(T.mode);
  const b = boundsFor(T.mode, target);
  const unchanged = sameRect(displayWin.getBounds(), b) &&
                    (T.mode !== 'fullscreen' || isSimpleFS());
  if (unchanged) {
    refreshTrayMenu();
    if (chosenMissing) toast('选定的屏已断开 · 暂借 ' + displayName(target));
    return;
  }

  applyMode(T.mode, false);
  refreshTrayMenu();
  if (chosenMissing) toast('选定的屏已断开 · 暂借 ' + displayName(target));
}

function createDisplayWindow() {
  const display = displayForMode(resolveMode());
  const mode = resolveMode();
  T.mode = mode;
  const b = boundsFor(mode, display);

  displayWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    // 必须为 true：simpleFullScreen 要求窗口「具备全屏能力」，
    // 设成 false 时 macOS 会静默拒绝，表现为顶部菜单栏永远压在时钟上
    fullscreenable: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    // 窗口平时不是 key window，缺了这个开关时点退出按钮的第一下只会「激活窗口」，
    // 点击本身被 macOS 吃掉，得点两下才生效——那就变成点四下了
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  displayWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  displayWin.once('ready-to-show', function () {
    displayWin.showInactive();
    applyMode(mode, false);
  });

  // setVisibleOnAllWorkspaces 可能把 simpleFullScreen 顶掉，之后再兜一次。
  // 只留这一个兜底入口：每多一个钩子（focus/show）就多一条回环的可能。
  try { displayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}

  // 名片态拖动后记住位置（拖完 400ms 落盘，避免拖动过程中频繁写配置）
  displayWin.on('moved', function () {
    if (T.mode !== 'pet' || !displayWin || displayWin.isDestroyed()) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(function () {
      if (!displayWin || displayWin.isDestroyed()) return;
      const b = displayWin.getBounds();
      store.saveConfig({ petPos: { x: b.x, y: b.y } });
    }, 400);
  });

  displayWin.on('closed', function () { displayWin = null; });
}

function createInputWindow() {
  inputReady = false;
  inputWin = new BrowserWindow({
    width: 560, height: 180,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  inputWin.setAlwaysOnTop(true, 'screen-saver');
  inputWin.loadFile(path.join(__dirname, 'renderer', 'input.html'));
  inputWin.on('blur', function () {
    // 归因浮层不因失焦关闭（防误关丢记录）；记一句的浮层失焦即收起
    if (inputWin && !inputWin.isDestroyed() && inputWin.isVisible()) {
      inputWin.webContents.send('check-blur');
    }
  });
  inputWin.on('closed', function () { inputWin = null; });
}

function showInput(mode, payload) {
  if (!inputWin || inputWin.isDestroyed()) createInputWindow();
  const h = mode === 'finish' ? 236 : 168;
  const pt = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  const w = 560;
  inputWin.setBounds({
    x: Math.round(display.bounds.x + (display.bounds.width - w) / 2),
    y: Math.round(display.bounds.y + display.bounds.height * 0.3),
    width: w,
    height: h
  });
  const data = { mode: mode, payload: payload || {} };
  if (inputReady) {
    inputWin.webContents.send('open', data);
  } else {
    pendingInput = data;
  }
  if (process.env.POMODORO_TEST === '1') return; // 测试时不真的弹窗抢焦点
  inputWin.show();
  inputWin.focus();
  inputWin.moveTop();
}

function hideInput() {
  if (inputWin && !inputWin.isDestroyed()) inputWin.hide();
}

// ---------------- 提示 ----------------

function toast(text) {
  if (displayWin && !displayWin.isDestroyed()) {
    displayWin.webContents.send('toast', text);
  }
}

// 时间画像：纯本地统计，写完只提示路径，不弹 Finder、不抢焦点
function makeReport(days) {
  try {
    const r = report.generate({ days: days });
    toast('已生成 · 周报/' + path.basename(r.file));
    return true;
  } catch (e) {
    console.error('report error', e);
    toast('生成失败：' + e.message);
    return false;
  }
}

// 满 7 天自动出一页画像，不需要她记得去点
function maybeAutoReport() {
  const cfg = store.getConfig();
  if (!cfg.lastReport) {
    store.saveConfig({ lastReport: store.localISO(new Date()) });
    return;
  }
  const days = (Date.now() - new Date(cfg.lastReport).getTime()) / 86400000;
  if (days < 7) return;
  if (makeReport(7)) store.saveConfig({ lastReport: store.localISO(new Date()) });
}

// ---------------- 托盘 ----------------

function trayIcon() {
  const p = path.join(__dirname, 'assets', 'trayTemplate.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createEmpty();
}

// 「时钟显示在哪块屏」子菜单：每块屏一条，外加「跟鼠标」和「自动」
function displayMenuItems() {
  const cfg = store.getConfig();
  const current = pickDisplay();
  const items = orderedDisplays().map(function (d) {
    return {
      label: displayName(d),
      type: 'radio',
      checked: cfg.displayId != null && cfg.displayId !== 'cursor' && cfg.displayId === d.id,
      click: function () { chooseDisplay(d.id); }
    };
  });
  items.push({ type: 'separator' });
  items.push({
    label: '放在最小的一块屏（自动）',
    type: 'radio',
    checked: cfg.displayId == null,
    click: function () { chooseDisplay(null); }
  });
  items.push({
    label: '跟着鼠标所在屏',
    type: 'radio',
    checked: cfg.displayId === 'cursor',
    click: function () { chooseDisplay('cursor'); }
  });
  items.push({ type: 'separator' });
  items.push({
    label: '挪到下一块屏（⌥⌘D）',
    enabled: screen.getAllDisplays().length > 1,
    click: cycleDisplay
  });
  items.push({
    label: '现在在：' + displayName(current),
    enabled: false
  });
  return items;
}

function buildMenuTemplate() {
  const running = T.phase === 'running';
  const paused = T.phase === 'paused';
  const active = running || paused;
  const stats = store.todayStats();
  return [
    { label: '今天 ' + stats.count + ' 段 · ' + stats.minutes + ' 分钟', enabled: false },
    { type: 'separator' },
    {
      label: T.phase === 'finishing' ? '正在保存这一段…' : running ? '暂停' : (paused ? '继续' : '开始 25 分钟'),
      enabled: T.phase !== 'finishing',
      click: toggleTimer
    },
    { label: '记一句…', accelerator: 'Alt+Command+N', enabled: active, click: function () { openNote(); } },
    { label: '作废这一段', accelerator: 'Alt+Command+K', enabled: active, click: voidSession },
    { type: 'separator' },
    {
      label: T.mode === 'fullscreen' ? '切成桌面名片' : '切成全屏常驻',
      accelerator: 'Alt+Command+F',
      click: toggleMode
    },
    { label: '时钟显示在哪块屏', submenu: displayMenuItems() },
    {
      label: clockAway ? '把时钟叫回来' : '让开一会儿（用 Dock / 调度中心）',
      accelerator: 'Alt+Command+H',
      enabled: T.mode === 'fullscreen',
      click: toggleClockAway
    },
    {
      label: '生成时间画像',
      submenu: [
        { label: '近 7 天', click: function () { makeReport(7); } },
        { label: '近 30 天', click: function () { makeReport(30); } }
      ]
    },
    { label: '打开记录文件夹', click: function () { shell.openPath(store.getConfig().recordDir); } },
    { label: '打开数据文件夹', click: function () { shell.openPath(store.DATA_DIR); } },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: function (item) {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
      }
    },
    {
      label: '结束提示音',
      type: 'checkbox',
      checked: store.getConfig().sound !== false,
      click: function (item) { store.saveConfig({ sound: item.checked }); }
    },
    { label: '进度点平滑移动', type: 'checkbox', checked: store.getConfig().motion !== false,
      click: function (item) { store.saveConfig({ motion: item.checked }); broadcast(); }
    },
    { label: '时钟屏不休眠', type: 'checkbox', checked: store.getConfig().preventSleep !== false,
      click: function (item) {
        store.saveConfig({ preventSleep: item.checked });
        if (item.checked && (T.phase === 'running')) startSleepBlocker();
        if (!item.checked) stopSleepBlocker();
      }
    },
    { type: 'separator' },
    { label: '退出', accelerator: 'Command+Q', click: function () { app.quit(); } }
  ];
}

function refreshTrayMenu() {
  const template = buildMenuTemplate();
  // Dock 右键菜单：菜单栏图标被系统挤没时，这是唯一的兜底入口
  try { app.dock.setMenu(Menu.buildFromTemplate(template)); } catch (e) {}
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('番茄时钟');
  refreshTrayMenu();
  tray.on('click', function () { tray.popUpContextMenu(); });
}

// 极简应用菜单：只保留「退出」和「编辑」。编辑菜单必须留，否则输入框里的 ⌘V 会失效
function createAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '番茄时钟',
      submenu: [
        { label: '关于番茄时钟', role: 'about' },
        { type: 'separator' },
        { label: '隐藏', role: 'hide' },
        { type: 'separator' },
        { label: '退出番茄时钟', accelerator: 'Command+Q', click: function () { app.quit(); } }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '拷贝', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    }
  ]));
}

// ---------------- 输入浮层 ----------------

function addNote(text) {
  if (!text || !text.trim()) return false;
  if (!T.sessionId) return false;
  const clean = String(text).trim().slice(0, 1000);
  T.notes.push({ t: store.localISO(), text: clean });
  store.appendEvent({ type: 'note', id: T.sessionId, text: clean });
  broadcast();
  return true;
}

function openNote() {
  if (T.phase === 'idle' || T.phase === 'finishing') {
    toast('先开始一段');
    return;
  }
  showInput('note', { categoryLabel: store.CATEGORY_LABEL[T.category] || '' });
}

// ---------------- IPC ----------------

function wireIpc() {
  ipcMain.on('renderer-ready', function (ev) {
    if (displayWin && ev.sender === displayWin.webContents) {
      displayWin.webContents.send('mode', T.mode);
      displayWin.webContents.send('state', snapshot());
    }
    if (inputWin && ev.sender === inputWin.webContents) {
      inputReady = true;
      if (pendingInput) {
        inputWin.webContents.send('open', pendingInput);
        pendingInput = null;
      }
    }
  });

  ipcMain.on('note', function (ev, text) {
    const ok = addNote(text);
    hideInput();
    if (ok) toast('记下了');
  });

  ipcMain.on('finish', function (ev, data) {
    hideInput();
    commitFinish(data || {});
  });

  ipcMain.on('input-cancel', function () {
    hideInput();
    // 归因浮层被取消，不自动提交，等超时自动收口
  });

  ipcMain.on('should-close-on-blur', function () {
    hideInput();
  });

  // 浮层按内容自适应高度：锚点保持在顶部，只改高度，不跳位置
  ipcMain.on('input-resize', function (ev, h) {
    if (!inputWin || inputWin.isDestroyed() || ev.sender !== inputWin.webContents) return;
    const cur = inputWin.getBounds();
    const want = Math.max(110, Math.min(640, Math.round(Number(h) || cur.height)));
    if (Math.abs(want - cur.height) < 2) return;
    inputWin.setBounds({ x: cur.x, y: cur.y, width: cur.width, height: want });
  });

  ipcMain.on('cmd', function (ev, name) {
    if (name === 'toggle') toggleTimer();
    else if (name === 'mode') toggleMode();
    else if (name === 'void') voidSession();
    else if (name === 'note') openNote();
    else if (name === 'hide-input') hideInput();
    else if (name === 'quit') app.quit();
  });

  // 全屏态下的「可点区域」：渲染层判断鼠标是否落在退出按钮上，
  // 落上去才取消穿透，否则整块屏都点不动（那会让人以为电脑卡了）
  ipcMain.on('hot-zone', function (ev, over) {
    if (!displayWin || displayWin.isDestroyed()) return;
    if (ev.sender !== displayWin.webContents) return;
    if (T.mode !== 'fullscreen') return;
    if (over) displayWin.setIgnoreMouseEvents(false);
    else displayWin.setIgnoreMouseEvents(true, { forward: true });
  });
}

// ⌥⌘H：让时钟暂时让开。
// 为什么非得这样：全屏用的是 setSimpleFullScreen，它会在**应用级**把 Dock 和菜单栏
// 一起藏掉——只把窗口层级降下去没有用，Dock 压根不会被画出来。
// 要让她能用程序坞 / 调度中心 / 访达，只能真的先退出全屏、把窗口收起来。
let clockAway = false;

function setClockAway(away) {
  if (!displayWin || displayWin.isDestroyed()) return;
  if (T.mode !== 'fullscreen') return;      // 名片态本来就占不住那片屏，不用让
  if (away === clockAway) return;
  clockAway = away;
  if (away) {
    displayWin.hide();                      // 先藏再退全屏，避免退回那一瞬闪一下
    try { displayWin.setSimpleFullScreen(false); } catch (e) {}
  } else {
    displayWin.show();
    try { displayWin.setSimpleFullScreen(true); } catch (e) {}
    ensureSimpleFS();
  }
  refreshTrayMenu();
}

function toggleClockAway() { setClockAway(!clockAway); }

// ---------------- 快捷键 ----------------

function registerShortcuts() {
  const map = {
    'Alt+Command+P': toggleTimer,
    'Alt+Command+N': openNote,
    'Alt+Command+K': voidSession,
    'Alt+Command+F': toggleMode,
    'Alt+Command+D': cycleDisplay,
    'Alt+Command+H': toggleClockAway
  };
  const failed = [];
  Object.keys(map).forEach(function (acc) {
    const ok = globalShortcut.register(acc, map[acc]);
    if (!ok) failed.push(acc);
  });
  if (failed.length) {
    setTimeout(function () {
      toast('快捷键被占用：' + failed.join(' '));
    }, 1500);
  }
}

// ---------------- 测试通道（仅 POMODORO_TEST=1 时启用，打包后不触发） ----------------

function wireTestChannel() {
  if (process.env.POMODORO_TEST !== '1') return;
  const rl = require('readline').createInterface({ input: process.stdin });
  console.log('[test] ready');
  function runTestCommand(line) {
    const raw = line.trim();
    if (!raw) return;
    const i = raw.indexOf(' ');
    const cmd = i === -1 ? raw : raw.slice(0, i);
    const rest = i === -1 ? '' : raw.slice(i + 1);
    try {
      if (cmd === 'start') startSession();
      else if (cmd === 'advance') { T.startedMono -= Math.max(0, Number(rest) || 0) * 1000; tick(); }
      else if (cmd === 'pause') pauseSession();
      else if (cmd === 'resume') resumeSession();
      else if (cmd === 'void') voidSession();
      else if (cmd === 'note') console.log('[note] ' + (addNote(rest) ? 'ok' : 'skip'));
      else if (cmd === 'finish') commitFinish({ category: rest || 'create', text: '' });
      else if (cmd === 'setmin') { store.saveConfig({ plannedSeconds: Math.round(Number(rest) * 60) }); startSession(); }
      else if (cmd === 'mode') toggleMode();
      else if (cmd === 'display') console.log('[display] current=' + displayName(pickDisplay()) +
        ' chosen=' + JSON.stringify(store.getConfig().displayId) +
        ' bounds=' + JSON.stringify(displayWin.getBounds()) +
        ' simpleFS=' + displayWin.isSimpleFullScreen());
      else if (cmd === 'nextdisplay') cycleDisplay();
      else if (cmd === 'menu') {
        const t = buildMenuTemplate();
        t.forEach(function (it) {
          console.log('[menu] ' + it.label + (it.submenu ? ' > [' + it.submenu.map(function (s) {
            return (s.type === 'separator' ? '—' : (s.checked ? '✓ ' : '') + s.label);
          }).join(' | ') + ']' : ''));
        });
      }
      else if (cmd === 'choose') chooseDisplay(rest === 'auto' ? null : (rest === 'cursor' ? 'cursor' : Number(rest)));
      else if (cmd === 'report') makeReport(Number(rest) || 7);
      else if (cmd === 'snap') console.log('[snap] ' + JSON.stringify(snapshot()));
      else if (cmd === 'bounds') console.log('[bounds] ' + JSON.stringify(displayWin.getBounds()));
      else if (cmd === 'tray') {
        const img = trayIcon();
        console.log('[tray] bounds=' + JSON.stringify(tray ? tray.getBounds() : null) +
          ' imgEmpty=' + img.isEmpty() + ' size=' + JSON.stringify(img.getSize()) +
          ' template=' + img.isTemplateImage());
      }
      else if (cmd === 'open-note') openNote();
      else if (cmd === 'quit') app.quit();
      else console.log('[test] unknown ' + cmd);
    } catch (e) {
      console.log('[test] error ' + e.message);
    }
  }
  rl.on('line', runTestCommand);
  app.on('pomo-test-command', runTestCommand);
  rl.on('close', function () {});
}

// ---------------- 生命周期 ----------------

app.on('second-instance', function () {
  if (displayWin) displayWin.showInactive();
});

app.whenReady().then(function () {
  store.loadConfig();
  store.loadState();
  T.planned = store.getConfig().plannedSeconds || 1500;

  // 启动对账：把上次没写完的记录补进 md
  let filled = [];
  try { filled = store.reconcile(); } catch (e) { console.error('reconcile error', e); }

  createDisplayWindow();
  createInputWindow();
  createAppMenu();
  createTray();
  wireIpc();
  registerShortcuts();
  wireTestChannel();

  // 插拔屏幕后重算窗口：别让全屏态盖住她唯一的工作屏
  let displayTimer = null;
  function onDisplayChange(ev) {
    if (process.env.POMODORO_DEBUG) console.log('[disp-event]', ev);
    clearTimeout(displayTimer);
    displayTimer = setTimeout(reconcileDisplays, 600);
  }
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);
  screen.on('display-metrics-changed', onDisplayChange);

  powerMonitor.on('suspend', function () { pauseSession(); });
  tickTimer = setInterval(tick, 250);

  if (filled.length) {
    setTimeout(function () { toast('补写了 ' + filled.length + ' 条上次未落盘记录'); }, 2000);
  }

  const cfg = store.getConfig();
  if (!cfg.greeted) {
    setTimeout(function () {
      toast('⌥⌘P 开始 · ⌥⌘N 记一句 · ⌥⌘H 让开 · ⌥⌘F 切全屏');
    }, 2500);
    store.saveConfig({ greeted: true });
  }

  // 启动 8 秒后检查要不要自动出周报，别和启动提示抢
  setTimeout(function () { try { maybeAutoReport(); } catch (e) { console.error(e); } }, 8000);

  const recDir = store.getConfig().recordDir;
  if (!fs.existsSync(recDir)) {
    try { fs.mkdirSync(recDir, { recursive: true }); } catch (e) {}
  }
});

app.on('will-quit', function () {
  globalShortcut.unregisterAll();
  clearInterval(tickTimer);
  stopSleepBlocker();
  if (T.sessionId && T.phase === 'finishing') commitFinish({});
  if (T.sessionId && (T.phase === 'running' || T.phase === 'paused')) {
    const actual = Math.round(elapsedMs() / 1000);
    store.appendEvent({ type: 'void', id: T.sessionId, actual: actual });
    try {
      store.writeSessionToMD({
        id: T.sessionId,
        start: store.localISO(new Date(T.startedAt)),
        end: store.localISO(),
        planned: T.planned,
        actual: actual,
        category: T.category,
        status: 'void',
        notes: T.notes.slice(),
        interrupted: false
      });
    } catch (e) {}
  }
});

app.on('window-all-closed', function () {
  // 托盘常驻，不退出
});

app.on('activate', function () {
  if (!displayWin) createDisplayWindow();
  // 点 Dock 图标也当成"把时钟叫回来"：让开之后最自然的找回动作就是点它
  else if (clockAway) setClockAway(false);
});
