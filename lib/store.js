'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 应用数据目录：macOS 走 Application Support，Windows 走 %APPDATA%，其它走 ~/.config
function defaultAppDir() {
  let base;
  if (process.platform === 'darwin') base = path.join(os.homedir(), 'Library', 'Application Support');
  else if (process.platform === 'win32') base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  else base = path.join(os.homedir(), '.config');
  return path.join(base, '番茄时钟');
}

const APP_DIR = process.env.POMODORO_HOME || defaultAppDir();
const DATA_DIR = path.join(APP_DIR, 'data');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const JSONL_FILE = path.join(DATA_DIR, 'events.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const CATEGORY_LABEL = { create: '独立创作', think: '深度思考', collab: '协作' };

const DEFAULT_CONFIG = {
  // 记录默认落在「文稿/番茄时钟/记录」，想挂到自己的笔记库里就把 config.json 的
  // recordDir 改成目标目录，或者启动前设置 POMODORO_RECORD_DIR 环境变量。
  recordDir: process.env.POMODORO_HOME ? path.join(APP_DIR, 'records')
    : (process.env.POMODORO_RECORD_DIR || path.join(os.homedir(), 'Documents', '番茄时钟', '记录')),
  plannedSeconds: 1500,
  sound: true,
  motion: true,
  mode: 'auto',
  displayId: null,
  preventSleep: true,
  lastCategory: 'create'
};

let config = null;
let writtenIds = new Set();

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function pad(n) { return String(n).padStart(2, '0'); }

function localISO(d) {
  d = d || new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
}

function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

function loadConfig() {
  ensureDirs();
  try {
    config = Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (e) {
    config = Object.assign({}, DEFAULT_CONFIG);
  }
  if (!config.recordDir) config.recordDir = DEFAULT_CONFIG.recordDir;
  return config;
}

function getConfig() { return config || loadConfig(); }

function saveConfig(patch) {
  config = Object.assign({}, getConfig(), patch || {});
  atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- L1 事实层：append-only 事件流 ----------

function appendEvent(ev) {
  ensureDirs();
  const line = JSON.stringify(Object.assign({ t: localISO() }, ev)) + '\n';
  fs.appendFileSync(JSONL_FILE, line, 'utf8');
}

function readEvents() {
  let raw = '';
  try { raw = fs.readFileSync(JSONL_FILE, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) { /* 损坏行跳过，不中断 */ }
  }
  return out;
}

// 把事件流聚合成会话表
function aggregate() {
  const sessions = new Map();
  for (const ev of readEvents()) {
    let s = sessions.get(ev.id);
    if (!s) {
      s = { id: ev.id, start: null, end: null, planned: 1500, actual: 0,
            category: null, status: null, notes: [], interrupted: false };
      sessions.set(ev.id, s);
    }
    switch (ev.type) {
      case 'start':
        s.start = ev.t; s.planned = ev.planned || 1500; s.category = ev.category || null;
        break;
      case 'note':
        s.notes.push({ t: ev.t, text: ev.text });
        break;
      case 'category':
        s.category = ev.category;
        break;
      case 'end':
        s.end = ev.t; s.actual = ev.actual || 0; s.status = ev.status || 'done';
        if (ev.category) s.category = ev.category;
        break;
      case 'void':
        s.end = ev.t; s.actual = ev.actual || 0; s.status = 'void';
        break;
    }
  }
  return sessions;
}

// ---------- 已写入 MD 的记录（防止重复） ----------

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    writtenIds = new Set(j.writtenIds || []);
  } catch (e) { writtenIds = new Set(); }
}

function saveState() {
  atomicWrite(STATE_FILE, JSON.stringify({ writtenIds: [...writtenIds] }, null, 2));
}

// ---------- L2 阅读层：按月一个 md ----------

function renderSession(s) {
  const start = new Date(s.start);
  const endDate = s.end ? new Date(s.end) : null;
  const startHM = hm(start);
  const endHM = endDate ? hm(endDate) : '';
  const sec = s.actual || 0;
  const mins = Math.max(1, Math.round(sec / 60));
  const durText = sec < 30 ? '不到 1 分钟' : mins + ' 分钟';

  let head;
  if (s.status === 'void' || s.interrupted) {
    head = '### ' + startHM + '–' + (endHM || startHM) + ' · 作废（' + durText + '）';
  } else {
    const cat = CATEGORY_LABEL[s.category] || '未归类';
    head = '### ' + startHM + '–' + endHM + ' · ' + mins + '′ · ' + cat;
  }

  const body = s.notes.map(n => '- ' + hm(new Date(n.t)) + ' ' + n.text).join('\n');
  return body ? head + '\n' + body : head;
}

function monthFile(session) {
  const d = new Date(session.start);
  return {
    file: path.join(getConfig().recordDir, d.getFullYear() + '-' + pad(d.getMonth() + 1) + '.md'),
    title: d.getFullYear() + '-' + pad(d.getMonth() + 1),
    dayLine: '## ' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + WEEK[d.getDay()]
  };
}

function writeSessionToMD(session) {
  const { file, title, dayLine } = monthFile(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const marker = '<!-- pomodoro:' + encodeURIComponent(session.id) + ' -->';
  if (writtenIds.has(session.id) || content.includes(marker)) {
    writtenIds.add(session.id); saveState(); return file;
  }
  if (!content.trim()) content = '# ' + title + '\n\n';
  if (!content.startsWith('# ')) content = '# ' + title + '\n\n' + content;

  const block = marker + '\n' + renderSession(session);
  const lines = content.split('\n');
  const dayIdx = lines.findIndex(l => l.trim() === dayLine);

  if (dayIdx === -1) {
    content = content.replace(/\s+$/, '') + '\n\n' + dayLine + '\n\n' + block + '\n';
  } else {
    let nextIdx = lines.length;
    for (let i = dayIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { nextIdx = i; break; }
    }
    let insertAt = nextIdx;
    while (insertAt > dayIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    const before = lines.slice(0, insertAt).join('\n').replace(/\s+$/, '');
    const after = lines.slice(nextIdx).join('\n').replace(/^\s+/, '');
    content = before + '\n\n' + block + '\n' + (after ? '\n' + after + '\n' : '');
  }

  atomicWrite(file, content);
  writtenIds.add(session.id);
  saveState();
  return file;
}

// 启动时对账：把有结局、但没写进 md 的会话补上；把没结局的标记为中断
function reconcile() {
  loadState();
  const sessions = aggregate();
  const filled = [];
  for (const s of sessions.values()) {
    if (!s.start) continue;
    if (!s.end) {
      // 有开始没结束 = 崩溃或强制退出
      const lastT = s.notes.length ? new Date(s.notes[s.notes.length - 1].t) : new Date(s.start);
      s.actual = Math.max(0, Math.round((lastT - new Date(s.start)) / 1000));
      s.status = 'void';
      s.interrupted = true;
      s.end = lastT.toISOString();
      appendEvent({ type: 'void', id: s.id, t: s.end, actual: s.actual, recovered: true });
    }
    if (writtenIds.has(s.id)) continue;
    try {
      writeSessionToMD(s);
      filled.push(s.id);
    } catch (e) {
      console.error('reconcile 写入失败', s.id, e.message);
    }
  }
  return filled;
}

function recentSessions(n) {
  const all = [...aggregate().values()].filter(s => s.start);
  all.sort((a, b) => new Date(b.start) - new Date(a.start));
  return all.slice(0, n || 20);
}

function todayStats() {
  const today = ymd(new Date());
  const all = [...aggregate().values()].filter(s => s.start && s.status && ymd(new Date(s.start)) === today);
  const done = all.filter(s => s.status !== 'void');
  const totalMin = done.reduce((a, s) => a + (s.actual || 0) / 60, 0);
  return { count: done.length, minutes: Math.round(totalMin) };
}

module.exports = {
  APP_DIR, DATA_DIR, JSONL_FILE,
  WEEK, CATEGORY_LABEL, DEFAULT_CONFIG,
  pad, localISO, hm, ymd,
  loadConfig, getConfig, saveConfig,
  appendEvent, readEvents, aggregate,
  writeSessionToMD, reconcile, loadState,
  recentSessions, todayStats,
  ensureDirs
};
