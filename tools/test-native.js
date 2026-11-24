'use strict';
let electron;
try { ({ _electron: electron } = require('playwright')); }
catch (e) {
  if (!process.env.PLAYWRIGHT_PATH) {
    console.error('需要 playwright 才能跑端到端测试：npm i -D playwright，或设置 PLAYWRIGHT_PATH 指向已安装的路径');
    process.exit(1);
  }
  ({ _electron: electron } = require(process.env.PLAYWRIGHT_PATH));
}
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pomo-native-'));const out=process.env.POMO_TEST_OUT||path.join(root,'results');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({recordDir:path.join(root,'records'),plannedSeconds:1500,greeted:true,sound:false,mode:'pet'}));
const env={...process.env,POMODORO_HOME:root,POMODORO_TEST:'1'};delete env.ELECTRON_RUN_AS_NODE;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let app,logs='',checks=[],errors=[];
const check=(v,n)=>{assert.ok(v,n);checks.push(n);console.log('PASS '+n)};
(async()=>{
 const launchArgs=(process.env.POMO_TEST_APP?['--no-sandbox']:['--no-sandbox',path.resolve(__dirname,'..')]);
 app=await electron.launch({executablePath:process.env.POMO_TEST_APP||require('electron'),args:launchArgs,env,timeout:30000});
 const proc=app.process();proc.stdout.on('data',x=>logs+=x);proc.stderr.on('data',x=>logs+=x);
 const cmd=x=>app.evaluate(({app},command)=>app.emit('pomo-test-command',command),x);
 const snap=async()=>{let pos=logs.length;await cmd('snap');for(let i=0;i<50;i++){const m=logs.slice(pos).match(/\[snap\] (\{.*\})/);if(m)return JSON.parse(m[1]);await wait(50)}throw Error('snap timeout '+logs.slice(-2000))};
 for(let i=0;i<60&&app.windows().length<2;i++)await wait(100);
 const windows=app.windows();const page=windows.find(w=>w.url().endsWith('index.html'));const input=windows.find(w=>w.url().endsWith('input.html'));assert.ok(page&&input);
 page.on('pageerror',e=>errors.push(e.message));input.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>document.querySelectorAll('.crayon-digit').length===5);
 check((await snap()).phase==='idle','启动为空闲，不自动开一段');
 check(await page.locator('#bar path.b-body').count()===1,'进度点已换成手绘番茄');
 await page.evaluate(()=>{document.body.dataset.mode='fullscreen'});
 check(await page.locator('#start').evaluate(e=>{const c=getComputedStyle(e);return c.display!=='none'&&parseFloat(c.opacity)>0.5}),'空闲态显示开始按钮');
 check(await page.locator('#meta').evaluate(e=>{const r=e.getBoundingClientRect();return r.width>60&&r.left<innerWidth*.2}),'左下角常驻状态行可见');
 // 用界面上的开始按钮启动，不走快捷键——这是 sherry 明确要的能力
 // （用元素自身触发，因为测试窗口此时是名片尺寸，按钮不在视口内）
 await page.locator('#start').evaluate(e=>e.click());
 await wait(300);
 check((await snap()).phase==='running','点界面上的开始按钮就启动（不用快捷键）');
 await page.evaluate(()=>{document.body.dataset.mode='pet'});
 cmd('menu');await wait(100);check(logs.includes('[menu] 暂停'),'开始后菜单更新为暂停');
 cmd('note 第一条中文记录');cmd('note 第二条记录');await wait(100);check((await snap()).noteCount===2,'随手记进入当前会话');
 cmd('advance 60');await wait(100);let s=await snap();check(s.remaining<=1440&&s.remaining>=1439,'一分钟后倒计时准确');
 cmd('pause');await wait(100);let paused=await snap();await wait(1100);check((await snap()).remaining===paused.remaining,'暂停期间不计时');
 check(await page.locator('#clock').evaluate(e=>getComputedStyle(e).opacity)==='0.55','暂停有静态视觉区别');
 check(await page.locator('#start-cap').textContent()==='继续','暂停时按钮文案变「继续」');
 cmd('resume');await wait(100);check((await snap()).phase==='running','暂停后继续');
 // The machine clock changes, the elapsed duration must not jump with it.
 const before=await snap();await app.evaluate(()=>{global.__pomoRealNow=Date.now;Date.now=()=>global.__pomoRealNow()+3600000});
 const after=await snap();check(Math.abs(before.remaining-after.remaining)<=1,'系统时间前移一小时不改变倒计时');
 await app.evaluate(()=>{Date.now=global.__pomoRealNow});
 await app.evaluate(({powerMonitor})=>powerMonitor.emit('suspend'));await wait(100);check((await snap()).phase==='paused','系统睡眠事件自动暂停');
 cmd('resume');await wait(100);
 // IME selection must not submit; next normal Enter submits once even if repeated.
 await cmd('open-note');
 await input.waitForFunction(()=>document.querySelector('#entry').placeholder==='现在想到什么…');
 await input.locator('#entry').fill('中文选字');
 await input.locator('#entry').dispatchEvent('keydown',{key:'Enter',isComposing:true,bubbles:true});await wait(200);
 check((await snap()).noteCount===2,'中文输入法选字回车不提交');
 await input.locator('#entry').dispatchEvent('keydown',{key:'Enter',bubbles:true});await input.locator('#entry').dispatchEvent('keydown',{key:'Enter',bubbles:true});await wait(200);
 check((await snap()).noteCount===3,'正常回车保存且连按不会重复提交');
 // Use test-only clock advancement; run the production completion and persistence code.
 // 最后三分钟必须整块变红：这是设计里唯一的"活物感"，别让它再悄悄失效
 const beforeUrgent=await snap();
 cmd('advance '+(beforeUrgent.remaining-240));await wait(200);
 check((await snap()).urgent===false,'剩 4 分钟还不算紧急');
 const calmColor=await page.locator('#clock').evaluate(e=>getComputedStyle(e).color);
 cmd('advance 120');await wait(200);
 check((await snap()).urgent===true,'剩 2 分钟进入紧急态');
 await wait(950);
 const hotColor=await page.locator('#clock').evaluate(e=>getComputedStyle(e).color);
 const rgb=(hotColor.match(/\d+/g)||[0,0,0]).map(Number);
 check(calmColor!==hotColor&&rgb[0]-rgb[1]>50&&rgb[0]-rgb[2]>50,'紧急时整块数字变赭红');
 cmd('advance 300');await wait(200);check((await snap()).phase==='finishing','到期进入完成归类');
 check(await page.locator('#clock').getAttribute('aria-label').then(v=>v.includes('00:00')),'完成显示零，不回跳');
 await input.locator('[data-cat=collab]').dispatchEvent('click');await input.locator('#entry').dispatchEvent('keydown',{key:'Enter',bubbles:true});await wait(200);check((await snap()).phase==='idle','完成后回到空闲');
 let md=fs.readFileSync(path.join(root,'records',new Date().toISOString().slice(0,7)+'.md'),'utf8');
 check(md.includes('协作')&&md.includes('中文选字')&&md.includes('25′'),'完成、改类别、中文随手记写入 Obsidian 格式');
 cmd('finish think');await wait(150);check((md.match(/pomodoro:/g)||[]).length===1&&fs.readFileSync(path.join(root,'records',new Date().toISOString().slice(0,7)+'.md'),'utf8')===md,'过时完成提交不会重复落盘');
 cmd('start');await wait(100);cmd('void');await wait(100);check((await snap()).phase==='idle','作废后复位');
 cmd('report 7');await wait(200);check(fs.readdirSync(path.join(root,'records','周报')).length===1,'原生菜单路径可生成本地报告');
 const displays=await app.evaluate(({screen})=>screen.getAllDisplays().map(d=>({id:d.id,bounds:d.bounds,workArea:d.workArea})));
 cmd('mode');await wait(1200);check((await snap()).mode===(displays.length>1?'fullscreen':'pet'),'全屏/单屏降级模式正确');
 if(displays.length>1){
  cmd('choose '+displays[0].id);await wait(1400);let bounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html')).getBounds());
  
  check(bounds.x===displays[0].bounds.x&&bounds.width===displays[0].bounds.width,'全屏实际落在选定显示器');
  cmd('nextdisplay');await wait(1400);bounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html')).getBounds());
  check(bounds.x!==displays[0].bounds.x||bounds.y!==displays[0].bounds.y,'可以挪到另一块真实显示器');
 }
 // Capture approved layout at actual window resolution, then small card.
 await wait(2400);
 await page.screenshot({path:path.join(out,'native-fullscreen.png')});
 if((await snap()).mode==='fullscreen'){cmd('mode');await wait(1200)}
 await wait(2400);
 await page.screenshot({path:path.join(out,'native-card.png')});
 const layout=await page.evaluate(()=>{const c=document.querySelector('#clock').getBoundingClientRect();return{x:c.x,y:c.y,right:c.right,bottom:c.bottom,w:innerWidth,h:innerHeight}});
 check(layout.x>=0&&layout.right<=layout.w&&layout.bottom<=layout.h,'小窗数字完整，没有溢出裁切');
 check(errors.length===0,'界面没有 JavaScript 错误');
 // Simulate available-display inventory without unplugging the user's hardware.
 await app.evaluate(({screen})=>{global.__pomoDisplays=screen.getAllDisplays;screen.getAllDisplays=()=>[screen.getPrimaryDisplay()]});
 await cmd('mode');await wait(150);check((await snap()).mode==='pet','单屏不会覆盖唯一工作屏');
 await app.evaluate(({screen})=>{screen.getAllDisplays=global.__pomoDisplays});
 
 // Quit active session, then relaunch same data home: one interrupted record, no duplicates.
 cmd('start');await wait(100);cmd('note 退出前保存');await wait(100);cmd('quit');await app.waitForEvent('close');app=null;
 const events=fs.readFileSync(path.join(root,'data/events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 check(events.filter(e=>e.type==='void').length===2,'退出中断会话也留下作废结局');
 const month=path.join(root,'records',new Date().toISOString().slice(0,7)+'.md');const saved=fs.readFileSync(month,'utf8');
 app=await electron.launch({executablePath:process.env.POMO_TEST_APP||require('electron'),args:launchArgs,env});
 await wait(1500);check(fs.readFileSync(month,'utf8')===saved,'退出重开后对账不重复写记录');
 await app.close();app=null;
 
 fs.writeFileSync(path.join(out,'native-verification.json'),JSON.stringify({root,checks,displays,errors,method:'Production native state transitions; 25-minute duration advanced through POMODORO_TEST-only monotonic clock hook; system suspend emitted, no physical sleep/hotplug.'},null,2));
 console.log('ALL '+checks.length+' PASSED. '+out);
})().catch(async e=>{console.error(e);fs.writeFileSync(path.join(out,'failure.log'),logs+'\n'+e.stack);if(app)await app.close();process.exitCode=1});
