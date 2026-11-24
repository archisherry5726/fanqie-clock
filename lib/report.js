'use strict';

/**
 * 时间画像生成器
 *
 * 设计原则（对应教研库里的段位判断）：
 * 1. 只做确定性统计，不调用任何模型。数字错了就是灾难，而模型会错。
 * 2. 描述已记录的使用情况，不从完成率推断工具有效性。
 * 3. 样本不足时明确说"样本不足"，不许拿 2 段数据编结论。
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');

const BUCKETS = [
  { name: '清晨 6–9', from: 6, to: 9 },
  { name: '上午 9–12', from: 9, to: 12 },
  { name: '午后 12–14', from: 12, to: 14 },
  { name: '下午 14–18', from: 14, to: 18 },
  { name: '晚上 18–22', from: 18, to: 22 },
  { name: '深夜 22–6', from: 22, to: 6 }
];

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function md(d) { return pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

function bucketOf(hour) {
  for (const b of BUCKETS) {
    if (b.from < b.to) {
      if (hour >= b.from && hour < b.to) return b.name;
    } else {
      if (hour >= b.from || hour < b.to) return b.name;
    }
  }
  return BUCKETS[0].name;
}

function build(days, endDate) {
  days = days || 7;
  const end = endDate || new Date();
  const windowEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
  const windowStart = new Date(windowEnd.getFullYear(), windowEnd.getMonth(),
    windowEnd.getDate() - (days - 1), 0, 0, 0, 0);

  const all = [...store.aggregate().values()].filter(s => s.start);
  const win = all.filter(s => {
    const t = new Date(s.start);
    return t >= windowStart && t <= windowEnd;
  });
  win.sort((a, b) => new Date(a.start) - new Date(b.start));

  const done = win.filter(s => s.status === 'done' || s.status === 'extended');
  const ongoing = win.filter(s => !s.status);
  const voided = win.filter(s => s.status === 'void');
  const totalMinutes = Math.round(done.reduce((a, s) => a + (s.actual || 0) / 60, 0));
  const noteCount = win.reduce((a, s) => a + s.notes.length, 0);
  const withNote = win.filter(s => s.notes.length > 0).length;

  // 按类别
  const cats = {};
  for (const key of Object.keys(store.CATEGORY_LABEL)) {
    cats[key] = { key: key, label: store.CATEGORY_LABEL[key], done: 0, voided: 0, minutes: 0, notes: 0 };
  }
  for (const s of win) {
    const key = s.category || 'create';
    const c = cats[key] || (cats[key] = { key: key, label: key, done: 0, voided: 0, minutes: 0, notes: 0 });
    if (s.status === 'void') c.voided += 1;
    else if (s.status === 'done' || s.status === 'extended') { c.done += 1; c.minutes += Math.round((s.actual || 0) / 60); }
    c.notes += s.notes.length;
  }

  // 按天
  const byDay = {};
  for (const s of win) {
    const k = ymd(new Date(s.start));
    if (!byDay[k]) byDay[k] = { done: 0, voided: 0, minutes: 0 };
    if (s.status === 'void') byDay[k].voided += 1;
    else if (s.status === 'done' || s.status === 'extended') { byDay[k].done += 1; byDay[k].minutes += Math.round((s.actual || 0) / 60); }
  }

  // 时段分布
  const byBucket = {};
  for (const s of done) {
    const k = bucketOf(new Date(s.start).getHours());
    byBucket[k] = (byBucket[k] || 0) + 1;
  }
  const topBucket = Object.keys(byBucket).sort((a, b) => byBucket[b] - byBucket[a])[0] || null;

  return {
    days, windowStart, windowEnd,
    win, done, voided, ongoing, totalMinutes, noteCount, withNote,
    cats: Object.values(cats), byDay, byBucket, topBucket
  };
}

// Usage counts describe behavior, not causal evidence of productivity.
function verdict(c) {
  return '仅记录使用情况';
}

function conclusion(d) {
  if (!d.win.length) return '这段时间没有记录。是否需要这个工具，仍要结合你的实际体验判断。';
  return '记录了完成 ' + d.done.length + ' 段、作废 ' + d.voided.length + ' 段、进行中 ' + d.ongoing.length + ' 段。完成时长共 ' + d.totalMinutes + ' 分钟。计时记录不能单独证明效率提高或工具是否适合某类任务。';
}

function render(d) {
  const L = [];
  L.push('# 时间画像 · ' + md(d.windowStart) + ' — ' + md(d.windowEnd) + '（' + d.days + ' 天）');
  L.push('');
  L.push('> 由番茄时钟本地生成。只统计事实，不做评价。');
  L.push('');
  L.push('## 一句话');
  L.push('');
  L.push(conclusion(d));
  L.push('');

  L.push('## 总量');
  L.push('');
  L.push('| 项 | 数值 |');
  L.push('|---|---|');
  L.push('| 完成 | ' + d.done.length + ' 段 |');
  L.push('| 作废 | ' + d.voided.length + ' 段（不计失败） |');
  L.push('| 进行中 | ' + d.ongoing.length + ' 段（不计入完成或作废） |');
  L.push('| 专注时长 | ' + d.totalMinutes + ' 分钟 |');
  L.push('| 留了话的段 | ' + d.withNote + ' / ' + d.win.length + ' |');
  L.push('| 记下的句子 | ' + d.noteCount + ' 条 |');
  L.push('');

  L.push('## 按类别');
  L.push('');
  L.push('| 类别 | 完成 | 作废 | 分钟 | 完成率 | 说明 |');
  L.push('|---|---|---|---|---|---|');
  for (const c of d.cats) {
    const total = c.done + c.voided;
    if (!total) continue;
    const rate = Math.round(c.done / total * 100) + '%';
    L.push('| ' + c.label + ' | ' + c.done + ' | ' + c.voided + ' | ' + c.minutes + ' | ' + rate + ' | ' + verdict(c) + ' |');
  }
  if (!d.cats.some(c => c.done + c.voided > 0)) L.push('| — | — | — | — | — | — |');
  L.push('');

  const dayKeys = Object.keys(d.byDay).sort();
  if (dayKeys.length) {
    L.push('## 逐日');
    L.push('');
    L.push('| 日期 | 完成 | 作废 | 分钟 |');
    L.push('|---|---|---|---|');
    for (const k of dayKeys) {
      const v = d.byDay[k];
      L.push('| ' + k.slice(5) + ' | ' + v.done + ' | ' + v.voided + ' | ' + v.minutes + ' |');
    }
    L.push('');
  }

  if (d.topBucket) {
    const parts = Object.keys(d.byBucket).sort((a, b) => d.byBucket[b] - d.byBucket[a])
      .map(k => k + ' ' + d.byBucket[k] + ' 段');
    L.push('## 时段');
    L.push('');
    L.push(parts.join(' · '));
    L.push('');
    L.push('已完成记录的开始时间最多落在 **' + d.topBucket + '**。这只是使用时间分布，不代表这个时段效率最高。');
    if (d.done.length < 3) L.push('');
    if (d.done.length < 3) L.push('（只有 ' + d.done.length + ' 段完成，这条先只当参考。）');
    L.push('');
  }

  const notes = [];
  for (const s of d.win) {
    for (const n of s.notes) notes.push({ t: n.t, text: n.text, cat: s.category });
  }
  if (notes.length) {
    L.push('## 那几句话');
    L.push('');
    const sample = notes.length > 24 ? notes.slice(-24) : notes;
    for (const n of sample) {
      const dt = new Date(n.t);
      L.push('- `' + md(dt) + ' ' + hm(dt) + '` ' + n.text);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('口径：完成率 = 完成段数 ÷（完成段数 + 作废段数）；进行中不计入分子或分母；分钟只累计完成段；时段按完成段的开始时间统计。完成率不用于判断工具有效性。');
  L.push('');
  return L.join('\n');
}

function generate(opts) {
  opts = opts || {};
  const d = build(opts.days || 7, opts.end ? new Date(opts.end) : new Date());
  const text = render(d);
  const dir = path.join(store.getConfig().recordDir, '周报');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ymd(d.windowEnd) + ' 近' + d.days + '天.md');
  fs.writeFileSync(file, text, 'utf8');
  return { file: file, text: text, data: d };
}

module.exports = { build, render, generate, verdict, bucketOf };
