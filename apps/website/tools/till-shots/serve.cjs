// Serves the built till renderer (apps/desktop/dist/renderer, read only) on :5180.
const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '../../../desktop/dist/renderer');
// The demo brands' logos and the demo products' photos come from the website's own public folder.
const site = path.resolve(__dirname, '../../public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const base = /^\/demo-(products|brands)\//.test(p) ? site : root;
  const f = path.join(base, p);
  if (!f.startsWith(path.normalize(base)) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(5180, () => console.log('serving :5180'));
