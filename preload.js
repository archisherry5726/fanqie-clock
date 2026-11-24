'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ready: function () { ipcRenderer.send('renderer-ready'); },

  onState: function (cb) { ipcRenderer.on('state', function (_, s) { cb(s); }); },
  onMode: function (cb) { ipcRenderer.on('mode', function (_, m) { cb(m); }); },
  onOpen: function (cb) { ipcRenderer.on('open', function (_, d) { cb(d); }); },
  onToast: function (cb) { ipcRenderer.on('toast', function (_, t) { cb(t); }); },
  onPlaySound: function (cb) { ipcRenderer.on('play-sound', function (_, k) { cb(k); }); },
  onCheckBlur: function (cb) { ipcRenderer.on('check-blur', function () { cb(); }); },

  note: function (text) { ipcRenderer.send('note', text); },
  finish: function (data) { ipcRenderer.send('finish', data); },
  cancel: function () { ipcRenderer.send('input-cancel'); },
  requestCloseOnBlur: function () { ipcRenderer.send('should-close-on-blur'); },
  resize: function (h) { ipcRenderer.send('input-resize', h); },
  cmd: function (name) { ipcRenderer.send('cmd', name); },
  quit: function () { ipcRenderer.send('cmd', 'quit'); },
  hotZone: function (over) { ipcRenderer.send('hot-zone', !!over); }
});
