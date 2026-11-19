import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Serve only the independent reference and its public assets during browser QA.
export async function startDesignServer() {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const allowed = pathname === '/design/index.html'
      || pathname === '/public/assets/fonts.css'
      || pathname === '/public/favicon.svg'
      || /^\/public\/assets\/fonts\/[a-zA-Z0-9_.-]+\.woff2$/.test(pathname);
    if (!allowed) {
      response.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await readFile(path.join(root, pathname));
      const type = pathname.endsWith('.html') ? 'text/html; charset=utf-8'
        : pathname.endsWith('.css') ? 'text/css; charset=utf-8'
          : pathname.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2';
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
