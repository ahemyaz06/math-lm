import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/graph-math.js', ['graph-math.js', 'text/javascript']],
  ['/sound-engine.js', ['sound-engine.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
]);

const port = Number(process.env.PORT || 4180);

const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405);
    return res.end();
  }
  const pathname = req.url.split('?')[0];
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ app: 'sound-lab', version: '0.2.0' }));
  }
  const entry = files.get(pathname);
  if (!entry) {
    res.writeHead(404);
    return res.end('Not found');
  }
  try {
    const data = await readFile(new URL('./public/' + entry[0], import.meta.url));
    res.writeHead(200, {
      'Content-Type': entry[1] + '; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(500);
    res.end('Unable to read application file.');
  }
});

server.on('error', (error) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. If Sound Lab is running, open http://127.0.0.1:${port}/. Otherwise choose another PORT.`
      : error.message
  );
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Sound Lab ready: ${url}\nFolder: ${fileURLToPath(new URL('.', import.meta.url))}\nPress Ctrl+C to stop.`);
  if (process.argv.includes('--open')) {
    const program = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const opener = spawn(program, [url], { stdio: 'ignore', windowsHide: true });
    opener.on('error', () => console.log(`Open ${url} in your browser.`));
    opener.unref();
  }
});
