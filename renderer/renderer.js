'use strict';

const body = document.body;
const clockEl = document.getElementById('clock');
const penGlyphs = {"0": "M 61 19 C 26 14 13 56 16 104 C 17 147 31 174 56 170 C 86 165 92 124 91 83 C 90 43 83 19 61 19", "1": "M 24 46 Q 42 35 57 18 L 51 169", "2": "M 17 48 C 24 20 55 10 76 25 C 100 43 90 68 70 91 L 20 160 Q 53 157 91 163", "3": "M 18 30 Q 56 10 80 29 C 99 48 78 77 49 83 C 79 80 96 103 85 133 C 74 164 41 177 14 155", "4": "M 68 21 L 15 116 Q 49 120 93 116 M 76 19 L 71 169", "5": "M 88 22 Q 59 19 28 23 L 20 88 C 38 73 74 75 86 99 C 102 134 77 166 51 169 Q 27 173 12 154", "6": "M 79 23 C 44 15 16 60 15 112 C 12 149 32 176 59 168 C 91 159 97 125 84 103 C 70 81 40 83 18 111", "7": "M 13 25 Q 45 19 94 24 C 72 69 49 119 32 169", "8": "M 56 88 C 23 76 14 52 29 31 C 49 3 89 17 88 45 C 86 68 72 77 56 88 C 27 104 12 123 22 149 C 34 180 83 175 90 147 C 98 117 74 97 56 88", "9": "M 86 87 C 68 108 36 105 23 84 C 6 58 26 17 57 19 C 91 18 97 51 88 97 C 82 135 62 168 30 170", ":": "M 49 62 L 48 64 M 45 123 L 44 125"};
// 每个字形在 110 宽格子里的实际左边界不同（12–24），逐个平移到统一的 16，
// 这样不管第一位是 1 还是 0，数字块左边缘都严丝合缝地压在下面那条笔迹线上
const GLYPH_DX = {"0":0.4,"1":-8,"2":-1,"3":2,"4":1,"5":4,"6":1.3,"7":3,"8":-2.9,"9":-0.8};
// 每个数字落笔的高低略有差别，是"手写"而不是"排版"，±1.5px 以内，肉眼只觉得自然
const GLYPH_DY = {"0":0.6,"1":-0.5,"2":0.3,"3":0.8,"4":-0.7,"5":0.5,"6":0.2,"7":-0.4,"8":0.7,"9":0.1};
let lastDrawnDigits = '';
      function drawCrayonTime(text) {
        if (text === lastDrawnDigits) return;
        lastDrawnDigits = text;
        clockEl.setAttribute('aria-label', text);
        clockEl.innerHTML = '<span class="crayon-digits" aria-hidden="true">' + Array.from(text, char => {
          const colon = char === ':';
          return '<svg class="crayon-digit'+(colon?' colon':'')+'" viewBox="'+(colon?'25 0 45 190':'0 0 110 190')+'"><g mask="url(#crayon-mask)" filter="url(#crayon-wobble)">'+(colon?'<circle cx="49" cy="62" r="10" fill="currentColor"/><circle cx="45" cy="124" r="10" fill="currentColor"/>':'<path transform="translate('+(GLYPH_DX[char]||0)+' '+(GLYPH_DY[char]||0)+')" d="'+penGlyphs[char]+'" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>')+'</g></svg>';
        }).join('') + '</span>';
      }
const bar = document.getElementById('bar');
const trail = document.getElementById('trail');
const metaLeft = document.getElementById('meta-left');
const toastEl = document.getElementById('toast');
const nowNums = Array.prototype.slice.call(document.querySelectorAll('#now-time .n'));
const nowDate = document.getElementById('now-date');
const nowLunar = document.getElementById('now-lunar');
const quitBtn = document.getElementById('quit');
const startBtn = document.getElementById('start');
const startCap = document.getElementById('start-cap');

let toastTimer = null;
let lastRemaining = -1;

function digits(sec) {
  sec = Math.max(0, Math.floor(sec));
  const totalMin = Math.floor(sec / 60);
  const m = Math.min(99, totalMin);
  const s = sec % 60;
  return [Math.floor(m / 10), m % 10, Math.floor(s / 10), s % 10];
}

function setTime(sec) {
  if (sec === lastRemaining) return;
  lastRemaining = sec;
  const d = digits(sec);
  drawCrayonTime(''+d[0]+d[1]+':'+d[2]+d[3]);
}

/* ---------- 右下角：此刻 / 今天 / 农历 ---------- */

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// 农历交给系统 ICU（Electron 自带完整 tzdata/ICU），比自己维护万年历表可靠，
// 闰月、大小月都由系统算准；取不到就整行不显示，绝不显示错的。
let lunarFmt = null;
try {
  lunarFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese',
    { year: 'numeric', month: 'long', day: 'numeric' });
} catch (e) { lunarFmt = null; }

const CN_DAY = ['', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];

function lunarOf(d) {
  if (!lunarFmt) return '';
  try {
    const parts = lunarFmt.formatToParts(d);
    let month = '', day = '', yearName = '';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === 'month') month = p.value;
      else if (p.type === 'day') day = p.value;
      else if (p.type === 'yearName') yearName = p.value;
    }
    const n = parseInt(day, 10);
    const cn = CN_DAY[n] || String(n);
    return '农历' + (yearName ? yearName + '年' : '') + month + cn;
  } catch (e) { return ''; }
}

let lunarKey = '';
let lunarText = '';

function refreshDate(d) {
  const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  if (key === lunarKey) return;
  lunarKey = key;
  lunarText = lunarOf(d);
  nowDate.textContent = d.getFullYear() + '.' +
    String(d.getMonth() + 1).padStart(2, '0') + '.' +
    String(d.getDate()).padStart(2, '0') + '  ' + WEEK[d.getDay()];
  nowLunar.textContent = lunarText;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function refreshNow() {
  const d = new Date();
  const s = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  for (let i = 0; i < nowNums.length; i++) {
    if (nowNums[i].textContent !== s[i]) nowNums[i].textContent = s[i];
  }
  refreshDate(d);
}

// 对齐到整秒再触发，不累积漂移；只有真正跨秒才写 DOM
let nowTimer = null;

function tickNow() {
  refreshNow();
  const delay = 1000 - (Date.now() % 1000) + 8;
  nowTimer = setTimeout(tickNow, delay);
}

function startNow() {
  if (nowTimer) return;
  tickNow();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshNow();
  });
}

/* ---------- 退出 ---------- */

// 全屏时主进程默认让窗口「鼠标穿透」，这一屏的点击照常落到桌面上。
// 只有当鼠标逼近右上角按钮时才临时接管，否则按钮点不到、平时的桌面也点不到。
// '' = 不在任何热区；'quit' / 'start' = 当前接管的是哪一颗
// 用字符串而不是布尔：鼠标靠近哪颗，哪颗就立刻亮起来，
// 用户不需要先移动再观察（真机上前几次点击失效，就是因为亮灯晚了一步）
let hot = '';

function setHot(next) {
  if (next === hot) return;
  hot = next;
  body.dataset.hot = next;
  if (window.api && window.api.hotZone) window.api.hotZone(!!next);
}

const HOT_PAD = 12;

function inBox(el, x, y, pad) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  return x >= r.left - pad && x <= r.right + pad &&
         y >= r.top - pad && y <= r.bottom + pad;
}

// 全屏时整块屏是穿透的，只有鼠标落在这两个按钮上才临时接管点击。
// 开始按钮只在 idle / paused 存在，其余时候必须让开——
// 否则一个看不见的按钮会把桌面的点击抢走，用户会以为电脑卡了。
function nearHot(x, y) {
  if (inBox(quitBtn, x, y, HOT_PAD)) return 'quit';
  const ph = body.dataset.phase;
  // 开始按钮的热区放宽到 28px：它是鼠标要"瞄准"的目标，容差大一点才好点
  if ((ph === 'idle' || ph === 'paused') && inBox(startBtn, x, y, 28)) return 'start';
  return '';
}

document.addEventListener('mousemove', function (e) {
  setHot(nearHot(e.clientX, e.clientY));
}, { passive: true });

// 鼠标整块离开窗口（relatedTarget 为空）时立刻归还穿透，别把桌面锁死
document.addEventListener('mouseout', function (e) {
  if (!e.relatedTarget) setHot('');
});

window.addEventListener('blur', function () { setHot(''); });

let quitArmTimer = null;

function disarmQuit() {
  quitBtn.dataset.armed = '0';
  clearTimeout(quitArmTimer);
}

quitBtn.addEventListener('click', function () {
  if (quitBtn.dataset.armed === '1') {
    disarmQuit();
    if (window.api) window.api.quit();
    return;
  }
  quitBtn.dataset.armed = '1';
  clearTimeout(quitArmTimer);
  quitArmTimer = setTimeout(disarmQuit, 3000);
});

/* ---------- 开始 / 继续 ---------- */

startBtn.addEventListener('click', function () {
  // 先归还穿透再发命令：鼠标停在按钮上不动时不会有下一次 mousemove，
  // 不主动收回的话这块屏会一直忽略状态、把桌面的点击吃掉
  setHot('');
  if (window.api) window.api.cmd('toggle');
});

/* ---------- 进度：走过的部分重新描一遍 ---------- */

// 路径长度是 viewBox 单位，跟窗口大小无关，量一次就够
let trailLen = 0;

function initTrail() {
  try {
    trailLen = trail.getTotalLength();
    trail.style.strokeDasharray = trailLen + ' ' + trailLen;
    trail.style.strokeDashoffset = trailLen;
  } catch (e) { trailLen = 0; }
}

function setProgress(p) {
  p = Math.max(0, Math.min(1, Number(p) || 0));
  const done = 1 - p;                      // 已经过去的部分
  bar.style.left = (done * 100) + '%';
  if (trailLen) trail.style.strokeDashoffset = (p * trailLen).toFixed(2);
}

/* ---------- 声音：柔和的正弦，不用系统 beep ---------- */

let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(ctx, freq, at, dur, gainValue) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(gainValue, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

function playSound(kind) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime + 0.02;
  if (kind === 'done') {
    tone(ctx, 523.25, now, 1.6, 0.05);
    tone(ctx, 659.25, now + 0.16, 1.5, 0.045);
    tone(ctx, 783.99, now + 0.32, 2.0, 0.04);
  } else {
    tone(ctx, 659.25, now, 1.0, 0.035);
  }
}

/* ---------- 提示 ---------- */

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
}

/* ---------- 状态渲染 ---------- */

const PHASE_LABEL = { idle: '未开始', running: '专注中', paused: '已暂停', finishing: '这一段完成' };

function render(s) {
  body.dataset.phase = s.phase;
  body.dataset.urgent = s.urgent ? 'true' : 'false';
  body.dataset.mode = s.mode;

  // 暂停时这个按钮是"继续"，不是"开始"
  if (startCap) startCap.textContent = s.phase === 'paused' ? '继续' : '开始';

  // 状态一变，之前"接管点击"的理由可能已经消失（开跑后按钮就没了），
  // 不能等下一次 mousemove 才收——那期间鼠标停着不动，这块屏会一直吃掉桌面点击
  if (hot === 'start' && s.phase !== 'idle' && s.phase !== 'paused') setHot('');

  setTime(s.remaining);
  setProgress(s.progress);
  body.dataset.motion = s.motion === false ? 'off' : 'on';
  clockEl.setAttribute('aria-label', (PHASE_LABEL[s.phase] || '') + ' ' + String(Math.floor(s.remaining/60)).padStart(2,'0') + ':' + String(s.remaining%60).padStart(2,'0')); 

  if (s.phase === 'idle') {
    metaLeft.textContent = '空闲 · 一段 ' + Math.round(s.planned / 60) + ' 分钟';
  } else if (s.phase === 'paused') {
    metaLeft.textContent = '已暂停 · ' + (s.categoryLabel || '');
  } else if (s.phase === 'finishing') {
    metaLeft.textContent = '正在存入 Obsidian…';
  } else {
    // 今天已完成 N 段，正在跑的是第 N+1 段
    const n = ' · 今天第 ' + (s.todayCount + 1) + ' 段';
    metaLeft.textContent = (s.categoryLabel || '') + n;
  }
}

/* ---------- 事件 ---------- */

window.__render = render;
window.__lunar = lunarOf;
window.__lunarOfDate = function (y, m, d) { return lunarOf(new Date(y, m - 1, d, 12, 0, 0)); };

setTime(1500);
initTrail();
setProgress(1);
startNow();

if (window.api) {
  window.api.onState(render);
  window.api.onMode(function (mode) { body.dataset.mode = mode; });
  window.api.onToast(toast);
  window.api.onPlaySound(playSound);
  window.api.ready();
}
