'use strict';
// 落盘链路的离线测试：不启动 GUI，直接检查 JSONL -> MD 的产物
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.tmpdir(), 'pomo-test-' + Date.now());
process.env.POMODORO_HOME = ROOT;

const store = require('../lib/store');

const REC = path.join(ROOT, '记录');
store.loadConfig();
store.saveConfig({ recordDir: REC });

const D = '2026-11-20';
function ts(hhmmss) { return D + 'T' + hhmmss + '+08:00'; }

// 1) 正常一段：两条随手记
store.appendEvent({ t: ts('09:12:04'), type: 'start', id: 's1', planned: 1500, category: 'create' });
store.appendEvent({ t: ts('09:18:22'), type: 'note', id: 's1', text: '寿皇殿展陈第二版，卡在动线' });
store.appendEvent({ t: ts('09:24:10'), type: 'note', id: 's1', text: '想到可以拿「进门→转身」当章节切分' });
store.appendEvent({ t: ts('09:37:31'), type: 'end', id: 's1', actual: 1500, status: 'done', category: 'create' });

// 2) 一段一句话都没写
store.appendEvent({ t: ts('10:05:00'), type: 'start', id: 's2', planned: 1500, category: 'think' });
store.appendEvent({ t: ts('10:30:00'), type: 'end', id: 's2', actual: 1500, status: 'done', category: 'think' });

// 3) 归因时改了类别
store.appendEvent({ t: ts('11:00:00'), type: 'start', id: 's3', planned: 1500, category: 'create' });
store.appendEvent({ t: ts('11:10:00'), type: 'note', id: 's3', text: '其实这是在跟人对接' });
store.appendEvent({ t: ts('11:25:00'), type: 'end', id: 's3', actual: 1500, status: 'done', category: 'create' });
store.appendEvent({ t: ts('11:25:05'), type: 'category', id: 's3', category: 'collab' });

// 4) 作废
store.appendEvent({ t: ts('14:20:00'), type: 'start', id: 's4', planned: 1500, category: 'create' });
store.appendEvent({ t: ts('14:28:00'), type: 'void', id: 's4', actual: 480 });

// 5) 崩溃：有 start 和 note，没有 end
store.appendEvent({ t: ts('16:00:00'), type: 'start', id: 's5', planned: 1500, category: 'think' });
store.appendEvent({ t: ts('16:12:00'), type: 'note', id: 's5', text: '这条写在崩溃之前' });

const filled = store.reconcile();
console.log('补写条数：', filled.length);

const md = fs.readFileSync(path.join(REC, '2026-11.md'), 'utf8');
console.log('\n===== 2026-11.md =====\n');
console.log(md);

// 再跑一次，应该补 0 条（幂等）
const again = store.reconcile();
console.log('第二次补写条数（应为 0）：', again.length);

// 幂等性 + 内容校验
const checks = [
  ['按月一个文件', fs.existsSync(path.join(REC, '2026-11.md'))],
  ['日期标题', md.includes('## 11-20 周五')],
  ['段落标题带类别', md.includes('### 09:12–09:37 · 25′ · 独立创作')],
  ['随手记带时刻', md.includes('- 09:18 寿皇殿展陈第二版，卡在动线')],
  ['空正文段只留标题', md.includes('### 10:05–10:30 · 25′ · 深度思考')],
  ['改过的类别生效', md.includes('### 11:00–11:25 · 25′ · 协作')],
  ['作废段', md.includes('作废（8 分钟）')],
  ['崩溃段按作废处理', md.includes('### 16:00–16:12 · 作废（12 分钟）')],
  ['崩溃段保留了已有记录', md.includes('这条写在崩溃之前')],
  ['二次运行不重复写', again.length === 0],
  ['没有出现重复标题', (md.match(/### 09:12/g) || []).length === 1]
];

console.log('\n===== 断言 =====');
let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) bad++;
}
console.log(bad === 0 ? '\n全部通过' : '\n失败 ' + bad + ' 项');
process.exit(bad === 0 ? 0 : 1);
