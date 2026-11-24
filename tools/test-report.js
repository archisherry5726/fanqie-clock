'use strict';
// 时间画像的离线测试：检查统计口径与输出，不从使用量推导有效性
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.tmpdir(), 'pomo-rep-' + Date.now());
process.env.POMODORO_HOME = ROOT;

const store = require('../lib/store');
const report = require('../lib/report');

store.loadConfig();
store.saveConfig({ recordDir: path.join(ROOT, '记录') });

const checks = [];
function chk(name, ok) { checks.push([name, ok]); }

// ---------- 场景 A：一片空白 ----------
const emptyText = report.render(report.build(7, new Date()));
chk('空数据不会崩', typeof emptyText === 'string' && emptyText.length > 100);
chk('空数据明确说"没记录"', emptyText.includes('没有记录'));

// ---------- 场景 B：只有 2 段（样本不足） ----------
const today = new Date();
function iso(d, hh, mm) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0);
  return store.localISO(x);
}
store.appendEvent({ t: iso(today, 9, 0), type: 'start', id: 'b1', planned: 1500, category: 'create' });
store.appendEvent({ t: iso(today, 9, 25), type: 'end', id: 'b1', actual: 1500, status: 'done', category: 'create' });
store.appendEvent({ t: iso(today, 10, 0), type: 'start', id: 'b2', planned: 1500, category: 'create' });
store.appendEvent({ t: iso(today, 10, 25), type: 'end', id: 'b2', actual: 1500, status: 'done', category: 'create' });

const small = report.build(7, today);
chk('类别只描述使用情况', report.verdict(small.cats.find(c => c.key === 'create')) === '仅记录使用情况');
chk('结论明确使用记录不能证明效率', report.render(small).includes('不能单独证明效率提高'));

// ---------- 场景 C：独立创作 4 段全完成；协作 3 段全作废 ----------
let n = 0;
for (let i = 0; i < 4; i++) {
  n++;
  const id = 'c' + n;
  store.appendEvent({ t: iso(today, 14, i * 30), type: 'start', id: id, planned: 1500, category: 'create' });
  store.appendEvent({ t: iso(today, 14, i * 30 + 25), type: 'end', id: id, actual: 1500, status: 'done', category: 'create' });
}
for (let i = 0; i < 3; i++) {
  n++;
  const id = 'c' + n;
  store.appendEvent({ t: iso(today, 16, i * 30), type: 'start', id: id, planned: 1500, category: 'collab' });
  store.appendEvent({ t: iso(today, 16, i * 30 + 5), type: 'void', id: id, actual: 300 });
}

const rich = report.build(7, today);
const createCat = rich.cats.find(c => c.key === 'create');
const collabCat = rich.cats.find(c => c.key === 'collab');
chk('独立创作完成计数', createCat.done === 6 && createCat.voided === 0);
chk('协作作废计数', collabCat.done === 0 && collabCat.voided === 3);
const richText = report.render(rich);
chk('移除有效性断言', !richText.includes('对「独立创作」有效'));
chk('移除未见效断言', !richText.includes('对「协作」未见效'));
chk('作废不计入分钟', rich.totalMinutes === 6 * 25);
chk('完成率按段算', richText.includes('100%') && richText.includes('0%'));

// 进行中的会话不能在分类/逐日统计中冒充已完成。
store.appendEvent({ t: iso(today, 18, 0), type: 'start', id: 'ongoing', planned: 1500, category: 'think' });
const active = report.build(7, today);
chk('进行中单独统计', active.ongoing.length === 1 && active.done.length === 6);
chk('分类不计未完成', active.cats.find(c => c.key === 'think').done === 0);
chk('逐日不计未完成', active.byDay[store.ymd(today)].done === 6);
// ---------- 写文件 ----------
const out = report.generate({ days: 7, end: today });
chk('周报落在 周报/ 目录', fs.existsSync(out.file) && out.file.includes('周报'));
chk('文件名带天数', path.basename(out.file).includes('近7天'));
chk('写入内容非空', fs.readFileSync(out.file, 'utf8').length > 300);

// ---------- 时段 ----------
chk('时段统计识别出 下午', rich.topBucket === '下午 14–18');

let bad = 0;
console.log('');
for (const [name, ok] of checks) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) bad++;
}
console.log(bad === 0 ? '\n全部通过（' + checks.length + ' 项）' : '\n失败 ' + bad + ' 项');
console.log('\n===== 周报正文预览 =====\n');
console.log(fs.readFileSync(out.file, 'utf8'));
process.exit(bad === 0 ? 0 : 1);
