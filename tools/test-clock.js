'use strict';
// 右下角「此刻 / 今天 / 农历」与退出按钮的自检
const { app, BrowserWindow } = require('electron');
const path = require('path');

let fails = 0;
function ok(cond, label, detail) {
  if (cond) console.log('  ✓ ' + label);
  else { fails++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

app.whenReady().then(async function () {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false, frame: false,
    paintWhenInitiallyHidden: true, backgroundColor: '#0F0E0D',
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(600);

  const js = function (code) { return win.webContents.executeJavaScript(code); };

  console.log('\n[1] 实时时间');
  const t1 = await js('document.getElementById("now-time").textContent');
  ok(/^\d{2}:\d{2}:\d{2}$/.test(t1), '显示 时:分:秒', t1);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  ok(t1.slice(0, 2) === hh, '小时与系统一致', t1.slice(0, 2) + ' vs ' + hh);
  await wait(2200);
  const t2 = await js('document.getElementById("now-time").textContent');
  ok(t1 !== t2, '两秒后数字在走', t1 + ' → ' + t2);
  const widths = await js(
    'Array.from(document.querySelectorAll("#now-time .n")).map(function(e){' +
    'return Math.round(e.getBoundingClientRect().width);})'
  );
  ok(widths.every(function (w) { return w === widths[0]; }), '六位数字等宽（不会左右抖）', JSON.stringify(widths));

  console.log('\n[2] 公历与星期');
  const dline = await js('document.getElementById("now-date").textContent');
  ok(/^\d{4}\.\d{2}\.\d{2}\s+星期[一二三四五六日]$/.test(dline), '格式 2026.11.20  星期五', JSON.stringify(dline));

  console.log('\n[3] 农历');
  const cases = [
    [2026, 11, 20, '农历丙午年十月十二'],
    [2026, 2, 17, '农历丙午年正月初一'],
    [2026, 1, 1, '农历乙巳年十一月十三'],
    [2025, 7, 25, '农历乙巳年闰六月初一'],
    [2025, 6, 25, '农历乙巳年六月初一'],
    [2026, 10, 6, '农历丙午年八月廿六'],
    [2027, 2, 6, '农历丙午年腊月三十'],
    [2026, 8, 13, '农历丙午年七月初一']
  ];
  for (const c of cases) {
    const got = await js('window.__lunarOfDate(' + c[0] + ',' + c[1] + ',' + c[2] + ')');
    ok(got === c[3], c[0] + '-' + c[1] + '-' + c[2] + ' = ' + c[3], got);
  }
  const lline = await js('document.getElementById("now-lunar").textContent');
  ok(/^农历/.test(lline) && lline.length > 4, '页面上印着农历（' + lline + '）');

  console.log('\n[4] 退出按钮');
  ok(await js('!!document.getElementById("quit")'), '按钮存在');
  const icon = await js('var r=document.getElementById("quit").getBoundingClientRect();' +
    '[Math.round(r.width),Math.round(r.height),Math.round(window.innerWidth-r.right),Math.round(r.top)]');
  ok(icon[0] >= 24 && icon[0] <= 34, '按钮尺寸合理（' + icon[0] + 'px）', JSON.stringify(icon));
  ok(icon[2] >= 20 && icon[2] <= 60 && icon[3] >= 20 && icon[3] <= 60, '贴在右上角', JSON.stringify(icon));

  const hz = await js(
    'window.__hz=[]; window.api={quit:function(){},hotZone:function(v){window.__hz.push(v);}};' +
    'function mv(x,y){document.dispatchEvent(new MouseEvent("mousemove",{clientX:x,clientY:y,bubbles:true}));}' +
    'mv(40,400); var far=window.__hz.slice();' +
    'mv(window.innerWidth-46, 44); var near=window.__hz.slice();' +
    'mv(40,400); [far, near, window.__hz]'
  );
  ok(hz[0].length === 0, '鼠标在远处时不接管点击（保持穿透）', JSON.stringify(hz[0]));
  ok(hz[1].length === 1 && hz[1][0] === true, '靠到按钮上才接管点击', JSON.stringify(hz[1]));
  ok(hz[2].length === 2 && hz[2][1] === false, '离开后立刻归还穿透', JSON.stringify(hz[2]));

  const first = await js(
    'window.__quitCalled=0; window.api={quit:function(){window.__quitCalled++;}};' +
    'document.getElementById("quit").click();' +
    '[document.getElementById("quit").dataset.armed, window.__quitCalled]'
  );
  ok(first[0] === '1' && first[1] === 0, '第一次点击只上膛、不退出', JSON.stringify(first));
  const second = await js(
    'document.getElementById("quit").click(); [window.__quitCalled]'
  );
  ok(second[0] === 1, '第二次点击才真退出', JSON.stringify(second));

  const auto = await js(
    'document.getElementById("quit").click();' +
    'new Promise(function(r){ setTimeout(function(){ r(document.getElementById("quit").dataset.armed); }, 3300); })'
  );
  ok(auto === '0', '3 秒不动自动收枪', String(auto));

  console.log('\n[5] 开始按钮与进度番茄');

  // 统一的状态构造器，避免每处都写全字段
  const st = function (over) {
    return JSON.stringify(Object.assign({
      phase: 'running', planned: 1500, remaining: 942, progress: 0.628,
      mode: 'fullscreen', urgent: false, categoryLabel: '独立创作',
      todayCount: 3, motion: true
    }, over));
  };
  const render = async function (over) {
    await js('window.__render(' + st(over) + ')');
    await wait(320);
  };

  ok(await js('!document.getElementById("tomato")'), '左上角那颗番茄已移除');
  ok(await js('document.getElementById("bar").tagName.toLowerCase()==="svg"'), '进度点已换成番茄图形（不再是圆点 div）');
  ok(await js('document.querySelectorAll("#bar .b-body").length===1 && document.querySelectorAll("#bar .b-calyx").length===3'),
     '番茄有果身 + 三根萼叶（两片侧叶 + 一根果柄）');

  // 果身必须是不透明的底色实填，才能把笔迹线从背后断开。
  // 一旦有人用元素 opacity 做"变淡"，线会从果身里透出来变成脏痕（v1.6 踩过）。
  const barPaint = await js(
    '[getComputedStyle(document.getElementById("bar")).opacity,' +
    ' getComputedStyle(document.querySelector("#bar .b-body")).fill]'
  );
  ok(parseFloat(barPaint[0]) === 1, '番茄整体不透明（变淡靠描边 alpha，不靠元素 opacity）', 'opacity=' + barPaint[0]);
  ok(!/rgba\([^)]*,\s*0?\.\d+\s*\)/.test(barPaint[1]) && !/transparent/.test(barPaint[1]),
     '果身填色是实色（能盖住横线）', barPaint[1]);

  // 进度番茄的位置跟着进度走（只验证写进 style 的值，避开 transition）
  await render({ progress: 1 });
  const leftEnd = await js('document.getElementById("bar").style.left');
  await render({ progress: 0 });
  const rightEnd = await js('document.getElementById("bar").style.left');
  ok(leftEnd === '0%' && rightEnd === '100%', '番茄位置从线的左端走到右端', leftEnd + ' → ' + rightEnd);

  // 空闲态：按钮在左下角，贴着状态行上方、左边缘与状态行对齐
  await render({ phase: 'idle', remaining: 1500, progress: 1, categoryLabel: '', todayCount: 0 });
  const geo = await js(
    'var b=document.getElementById("start").getBoundingClientRect();' +
    'var c=document.getElementById("clock").getBoundingClientRect();' +
    'var m=document.getElementById("meta-left").getBoundingClientRect();' +
    '[Math.round(b.width),Math.round(b.height),Math.round(b.top-c.bottom),' +
    'Math.round(b.left-m.left),Math.round(m.top-b.bottom),' +
    'parseFloat(getComputedStyle(document.getElementById("start")).opacity)]'
  );
  ok(geo[0] >= 70 && geo[1] >= 26, '按钮可点范围够大（' + geo[0] + '×' + geo[1] + '）', JSON.stringify(geo));
  ok(geo[2] > 20, '按钮在数字下方，不压数字（相距 ' + geo[2] + 'px）', JSON.stringify(geo));
  ok(Math.abs(geo[3]) <= 3, '按钮左边缘与左下状态行对齐（差 ' + Math.abs(geo[3]) + 'px）', JSON.stringify(geo));
  ok(geo[4] >= 4, '按钮在状态行上方，不压那行字（间距 ' + geo[4] + 'px）', JSON.stringify(geo));
  ok(geo[5] > 0.5, '空闲时按钮可见（opacity ' + geo[5] + '）');
  ok(await js('document.getElementById("start-cap").textContent') === '开始', '空闲时文案是「开始」');

  // 点一次就发开始命令
  const clicked = await js(
    'window.__cmd=[]; window.api={cmd:function(n){window.__cmd.push(n);},hotZone:function(){}};' +
    'document.getElementById("start").click(); window.__cmd'
  );
  ok(clicked.length === 1 && clicked[0] === 'toggle', '点一次就发出开始命令', JSON.stringify(clicked));

  // 空闲态鼠标压到按钮上要接管点击
  const hotIdle = await js(
    'window.__hz=[]; window.api={quit:function(){},hotZone:function(v){window.__hz.push(v);}};' +
    'var r=document.getElementById("start").getBoundingClientRect();' +
    'document.dispatchEvent(new MouseEvent("mousemove",{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));' +
    'window.__hz.slice()'
  );
  ok(hotIdle.length === 1 && hotIdle[0] === true, '空闲时鼠标在按钮上才接管点击', JSON.stringify(hotIdle));

  // 运行态：按钮必须真的不可见，而且不能接管点击——
  // 一个看不见的按钮如果还吃点击，用户会以为电脑卡了
  await render({ phase: 'running' });
  await wait(600); // 等淡出 transition 走完（0.45s）
  const runState = await js(
    'window.__hz=[];' +
    'var s=document.getElementById("start");var r=s.getBoundingClientRect();' +
    // 先把"当前是否接管"归零到远处，再看压到按钮位置会不会变
    'document.dispatchEvent(new MouseEvent("mousemove",{clientX:40,clientY:300,bubbles:true}));' +
    'window.__hz.length=0;' +
    'document.dispatchEvent(new MouseEvent("mousemove",{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true}));' +
    '[parseFloat(getComputedStyle(s).opacity), window.__hz.slice()]'
  );
  ok(runState[0] < 0.05, '运行中按钮完全隐藏（opacity ' + runState[0] + '）');
  ok(runState[1].length === 0, '运行中不接管点击（桌面照常可点）', JSON.stringify(runState[1]));

  // 暂停态：文案是「继续」
  await render({ phase: 'paused', remaining: 640, progress: 0.427 });
  ok(await js('document.getElementById("start-cap").textContent') === '继续', '暂停时文案变「继续」');
  ok(await js('parseFloat(getComputedStyle(document.getElementById("start")).opacity)') > 0.5, '暂停时按钮可见');

  await render({});

  console.log('\n[6] 名片态不显示时间块');
  await js('document.body.dataset.mode="pet"');
  const hidden = await js('getComputedStyle(document.getElementById("now")).display');
  ok(hidden === 'none', '名片态隐藏右下角时间块', hidden);
  const qp = await js('var r=document.getElementById("quit").getBoundingClientRect();[Math.round(r.width),Math.round(r.top)]');
  ok(qp[0] <= 24, '名片态按钮收成小尺寸（' + qp[0] + 'px）', JSON.stringify(qp));

  console.log('\n' + (fails === 0 ? '全部通过' : fails + ' 项失败'));
  app.exit(fails === 0 ? 0 : 1);
});
