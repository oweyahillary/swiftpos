// Wraps the till's compiled preload (apps/desktop/dist/main/preload.js, read only) for a plain browser page:
// require('electron') answers with a shim whose ipcRenderer.invoke goes to window.__ipc (mock.js).
const fs = require('fs');
const src = fs.readFileSync(require('path').resolve(__dirname, '../../../desktop/dist/main/preload.js'), 'utf8');
const shim = `{
  contextBridge: { exposeInMainWorld: (n, api) => { window[n] = api; } },
  ipcRenderer: {
    invoke: (ch, ...a) => window.__ipc(ch, ...a),
    on: () => {}, removeListener: () => {}, send: () => {}, sendSync: () => '1.0.20',
  },
}`;
const out = `(function(){ var module = { exports: {} }; var exports = module.exports;
var process = { platform: 'win32', env: {}, versions: {} };
var require = function (m) { if (m === 'electron') return ${shim}; throw new Error('preload require ' + m); };
${src}
})();`;
fs.writeFileSync(__dirname + '/preload.bundle.js', out);
console.log('ok', out.length);
