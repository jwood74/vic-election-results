import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { api } from '../lib/api.mjs';
import { ARCHIVE, collect, parseDistrict, readPage } from '../lib/vec.mjs';

let snapshot;
let inflight;
let freshUntil = 0;
async function archivePreview() {
  const entries = await Promise.all(['bass', 'melbourne', 'richmond', 'hawthorn', 'northcote', 'gippsland-east'].map(async id => {
    const source = `${ARCHIVE}/results-by-district/${id}-district-results`;
    return { id, ...parseDistrict(await readPage(source), source) };
  }));
  return { status: 'archive', at: new Date().toISOString(), source: ARCHIVE, loaded: entries.length, results: entries };
}
const results = api(async () => {
  if (Date.now() < freshUntil) return snapshot;
  return inflight ??= (process.env.ARCHIVE_PREVIEW === '1' ? archivePreview() : collect(snapshot))
    .then(value => { snapshot = value; freshUntil = Date.now() + 60_000; return value; })
    .finally(() => { inflight = null; });
});

const types = { html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json' };
const port = Number(process.env.PORT ?? 8888);
const tcpPreview = process.env.ARCHIVE_PREVIEW === '1' && process.env.TCP_SWING_PREVIEW === '1';
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/results') {
      const response = await results(new Request(url, { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (tcpPreview && url.searchParams.has('district') && response.ok) {
        const data = await response.json();
        if (data.tcp?.status === 'ok') {
          data.tcpPreview = true;
          const shifts = [4.2, -3.1, 0, 1.8, -2.6];
          data.tcp.booths = data.tcp.booths.map((booth, i) => {
            const total = booth.votes[0] + booth.votes[1];
            const next = Math.max(0, Math.min(total, booth.votes[0] + Math.round(total * shifts[i % shifts.length] / 100)));
            return { ...booth, votes: [next, total - next] };
          });
        }
        return res.end(JSON.stringify(data));
      }
      return res.end(await response.text());
    }
    const filename = ['/', '/status', '/status/'].includes(url.pathname) ? 'index.html' : url.pathname.slice(1);
    if (!/^(?:data\/)?[a-z0-9-]+\.(?:html|js|css|json)$/.test(filename)) return res.writeHead(404).end();
    const body = await readFile(new URL(`../public/${filename}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': `${types[filename.split('.').at(-1)]}; charset=utf-8` }).end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
