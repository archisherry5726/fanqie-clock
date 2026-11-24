(function () {
'use strict';

const api = window.api;
const titleEl = document.getElementById('title');
const subEl = document.getElementById('sub');
const catsEl = document.getElementById('cats');
const entry = document.getElementById('entry');
const footEl = document.getElementById('foot');
const catButtons = Array.prototype.slice.call(catsEl.querySelectorAll('button'));

const ORDER = ['create', 'think', 'collab'];
let mode = 'note';
let category = 'create';
let submitting = false;

function setCategory(c) {
  category = c;
  catButtons.forEach(function (b) {
    b.classList.toggle('on', b.dataset.cat === c);
  });
}

function open(d) {
  submitting = false;
  const p = d.payload || {};
  mode = d.mode || 'note';

  if (mode === 'finish') {
    titleEl.textContent = (p.minutes || 25) + '′ 完成';
    subEl.textContent = '这段算什么';
    catsEl.hidden = false;
    entry.placeholder = '再说一句（可留空）';
    footEl.textContent = 'Enter 存下 · ⌘1 / ⌘2 / ⌘3 选类别';
    setCategory(p.category || 'create');
  } else {
    titleEl.textContent = '记一句';
    subEl.textContent = p.categoryLabel || '';
    catsEl.hidden = true;
    entry.placeholder = '现在想到什么…';
    footEl.textContent = 'Enter 存下 · Esc 收起';
  }

  entry.value = '';
  requestAnimationFrame(function () {
    entry.focus();
    entry.setSelectionRange(0, 0);
    // 让窗口高度贴着内容，不留固定空白
    if (api && api.resize) {
      const h = Math.ceil(document.getElementById('panel').getBoundingClientRect().height);
      api.resize(h);
    }
  });
}

function submit() {
  if (submitting) return;
  submitting = true;
  const text = entry.value.trim();
  if (mode === 'finish') {
    api.finish({ category: category, text: text });
  } else {
    api.note(text);
  }
}

entry.addEventListener('keydown', function (e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    // 记一句：直接收起，不留下任何东西
    // 归因：收起浮层，60 秒后仍会自动按当前类别落盘（不丢记录，也不挡路）
    api.cancel();
    return;
  }
  if (e.metaKey && ['1', '2', '3'].indexOf(e.key) !== -1) {
    e.preventDefault();
    setCategory(ORDER[Number(e.key) - 1]);
  }
});

catsEl.addEventListener('click', function (e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  setCategory(btn.dataset.cat);
  entry.focus();
});

window.__open = open; // 供离屏预览调用

if (api) {
  api.onOpen(open);
  api.onCheckBlur(function () {
    if (mode === 'note') api.requestCloseOnBlur();
  });
  api.ready();
}

})();
