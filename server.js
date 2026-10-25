import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import Busboy from 'busboy';
import QRCode from 'qrcode';
import yazl from 'yazl';

const root = path.dirname(fileURLToPath(import.meta.url));
const token = () => randomBytes(32).toString('base64url');
const fail = (status, message) => Object.assign(new Error(message), { status });
const integer = (value, fallback) => { const n = Number(value ?? fallback); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Limits must be positive integers'); return n; };
function publicAddress(value) {
  let u; try { u = new URL(value); } catch { throw fail(400, '请输入完整的 HTTP 局域网地址'); }
  if (u.protocol !== 'http:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname)) throw fail(400, '手机地址必须是 HTTP 局域网入口，不能是 localhost，且不能带路径');
  return u.origin;
}
async function jsonBody(req, max = 500000) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, '需要 JSON 请求');
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > max) throw fail(413, '请求内容过大'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw fail(400, 'JSON 格式错误'); }
}
export async function createApp(options = {}) {
  const env = options.env || process.env;
  const limits = { textChars: integer(env.TEXT_CHARS, 100000), fileBytes: integer(env.FILE_BYTES, 50000000), batchCount: integer(env.BATCH_COUNT, 20), sessionBytes: integer(env.SESSION_BYTES, 200000000) };
  const idleMs = integer(options.idleMs ?? env.IDLE_MS, 1800000);
  const pairMs = integer(options.pairMs ?? env.PAIR_MS, 300000);
  const receiverGraceMs = integer(options.receiverGraceMs ?? env.RECEIVER_GRACE_MS, 120000);
  const maxSessions = integer(env.MAX_SESSIONS, 8);
  const publicUrl = env.PUBLIC_URL ? publicAddress(env.PUBLIC_URL) : '';
  const base = env.DATA_DIR || tmpdir(); await mkdir(base, { recursive: true });
  const dataDir = await mkdtemp(path.join(base, 'lan-drop-'));
  let creating = 0;
  const sessions = new Map(); const receivers = new Map(); const senders = new Map(); const codes = new Map();
  const now = options.now || Date.now;
  const touch = s => { s.lastActivity = now(); };
  const wireItems = s => s.items.map(({ disk, ...item }) => item);
  const pair = s => { if (s.code) codes.delete(s.code); s.code = token(); s.pairUntil = now() + pairMs; codes.set(s.code, s); return `${s.publicUrl}/send#${s.code}`; };
  function revoke(s) { if (s.sender) senders.delete(s.sender); s.sender = null; if (s.code) codes.delete(s.code); s.code = null; }
  async function remove(s) {
    if (s.removal) return s.removal;
    // Revoke before filesystem work. Keep the slot until deletion succeeds; failed deletion is retried.
    if (!s.retired) { s.retired = true; s.epoch++; revoke(s); receivers.delete(s.receiver); }
    s.removal = rm(s.dir, { recursive: true, force: true }).then(() => { sessions.delete(s.id); });
    try { await s.removal; } finally { s.removal = null; }
  }
  const reclaimAt = s => Math.min(s.lastActivity + idleMs, s.items.length ? Infinity : Math.max(s.receiverSeen, s.lastActivity) + receiverGraceMs);
  async function cleanup() {
    let error;
    for (const s of sessions.values()) if (s.retired || (!s.busy && now() >= reclaimAt(s))) {
      try { await remove(s); } catch (e) { error ||= e; }
    }
    if (error) throw error;
  }
  const timer = setInterval(() => { cleanup().catch(() => console.error('Temporary content cleanup failed')); }, Math.min(idleMs, receiverGraceMs, 30000)); timer.unref();
  function auth(req, role) { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const s = (role === 'receiver' ? receivers : senders).get(t); if (!s || (!s.busy && now() - s.lastActivity >= idleMs)) throw fail(401, '连接已失效，请在电脑重新配对'); return s; }
  function send(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
  async function upload(req, s) {
    if (s.busy) throw fail(409, '正在处理其他操作，请稍后重试');
    s.busy++; touch(s); const epoch = s.epoch; const staged = []; const jobs = []; let error; let bytes = 0;
    const mark = e => { error ||= e; };
    try {
      let parser; try { parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: limits.batchCount, fileSize: limits.fileBytes + 1, fields: 0, parts: limits.batchCount + 1 } }); } catch { throw fail(400, '无效的图片上传请求'); }
      parser.on('file', (field, stream, info) => {
        const id = randomUUID(); const disk = path.join(s.dir, id); const name = path.basename(info.filename.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'photo';
        const mime = info.mimeType.toLowerCase();
        const item = { id, type: 'image', name, mime, size: 0, createdAt: new Date().toISOString(), disk };
        staged.push(item);
        if (field !== 'files' || !mime.startsWith('image/')) { mark(fail(415, '请选择图片文件')); stream.resume(); return; }
        stream.on('limit', () => mark(fail(413, '单张图片超过大小限制')));
        const meter = new Transform({ transform(chunk, encoding, callback) {
          item.size += chunk.length; bytes += chunk.length;
          if (item.size > limits.fileBytes) mark(fail(413, '单张图片超过大小限制'));
          if (s.usedBytes + bytes > limits.sessionBytes) mark(fail(413, '会话暂存空间已满，请在电脑清空内容'));
          callback(null, error ? undefined : chunk);
        } });
        // Continue draining rejected files so the multipart parser can finish and return a useful error.
        jobs.push(pipeline(stream, meter, createWriteStream(disk, { flags: 'wx', mode: 0o600 })).catch(mark));
      });
      parser.on('filesLimit', () => mark(fail(413, '每批图片数量超限')));
      parser.on('partsLimit', () => mark(fail(413, '每批图片数量超限')));
      parser.on('fieldsLimit', () => mark(fail(400, '上传不能包含额外字段')));
      await pipeline(req, parser).catch(e => mark(e.status ? e : fail(400, '上传中断或格式错误')));
      await Promise.all(jobs);
      if (error) throw error;
      if (!staged.length) throw fail(400, '请选择至少一张图片');
      if (s.epoch !== epoch || !s.sender) throw fail(409, '配对已更改，请重新发送');
      s.items.push(...staged); s.usedBytes += bytes; touch(s);
      return { items: staged.map(({ disk, ...item }) => item) };
    } catch (e) { await Promise.all(jobs); await Promise.all(staged.map(i => rm(i.disk, { force: true }))); throw e; }
    finally { s.busy--; }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const u = new URL(req.url, 'http://local'); const route = u.pathname; const method = req.method;
      // No CORS. Reject browser cross-origin mutations to prevent drive-by requests.
      if (!['GET', 'HEAD'].includes(method) && req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { throw fail(403, '不允许跨站请求'); }
        if (origin.host !== req.headers.host || origin.protocol !== 'http:') throw fail(403, '不允许跨站请求');
      }
      if (route === '/health' && method === 'GET') return send(res, { ok: true });
      if (route === '/api/config' && method === 'GET') return send(res, { publicUrl, limits, idleMinutes: idleMs / 60000, receiverGraceSeconds: receiverGraceMs / 1000 });
      if (route === '/api/sessions' && method === 'POST') {
        const body = await jsonBody(req, 4096); await cleanup();
        if (sessions.size + creating >= maxSessions) {
          const earliest = Math.min(...[...sessions.values()].filter(s => !s.busy).map(reclaimAt));
          const retryAfterSeconds = Number.isFinite(earliest) ? Math.max(1, Math.ceil((earliest - now()) / 1000)) : Math.ceil(receiverGraceMs / 1000);
          res.setHeader('Retry-After', String(retryAfterSeconds));
          return send(res, { error: '接收会话名额已满。请在旧接收页点击“结束接收会话”；已关闭的空页面将在失联宽限期后释放，有内容的会话请先保存后结束。也可稍后手动重试。', retryAfterSeconds }, 429);
        }
        const address = publicAddress(body.publicUrl || publicUrl);
        creating++;
        try {
          const id = randomUUID(); const dir = path.join(dataDir, id); await mkdir(dir);
          const s = { id, dir, publicUrl: address, receiver: token(), sender: null, code: null, items: [], usedBytes: 0, busy: 0, epoch: 0, lastActivity: now(), receiverSeen: now() };
          sessions.set(id, s); receivers.set(s.receiver, s);
          return send(res, { id, receiverToken: s.receiver, pairUrl: pair(s) }, 201);
        } finally { creating--; }
      }
      if (route === '/api/qr' && method === 'GET') {
        const value = u.searchParams.get('url') || ''; if (value.length > 2048) throw fail(400, '二维码地址过长');
        const code = value.split('#')[1]; const s = codes.get(code);
        if (!s || value !== `${s.publicUrl}/send#${s.code}` || now() > s.pairUntil) throw fail(410, '二维码过期，请重新配对');
        const svg = await QRCode.toString(value, { type: 'svg', margin: 2, width: 256 }); res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(svg);
      }
      if (route === '/api/pair' && method === 'POST') {
        const { code } = await jsonBody(req, 4096); const s = codes.get(code);
        if (!s || now() > s.pairUntil || now() - s.lastActivity >= idleMs) throw fail(410, '二维码已使用或过期，请在电脑重新配对');
        codes.delete(code); s.code = null; s.sender = token(); senders.set(s.sender, s); touch(s);
        return send(res, { senderToken: s.sender, limits });
      }
      if (route === '/api/sender' && method === 'GET') { auth(req, 'sender'); return send(res, { connected: true }); }
      if (route === '/api/sender/disconnect' && method === 'POST') { const s = auth(req, 'sender'); revoke(s); s.epoch++; touch(s); return send(res, { ok: true }); }
      if (route === '/api/text' && method === 'POST') {
        const s = auth(req, 'sender'); const epoch = s.epoch; const { text } = await jsonBody(req, limits.textChars * 4 + 1024);
        auth(req, 'sender');
        if (s.epoch !== epoch || !s.sender) throw fail(409, '配对已更改');
        if (s.busy) throw fail(409, '传输或下载中，请稍后发送');
        if (typeof text !== 'string' || !text.trim()) throw fail(400, '请输入文字');
        if ([...text].length > limits.textChars) throw fail(413, '文字超过字符限制');
        const size = Buffer.byteLength(text); if (s.usedBytes + size > limits.sessionBytes) throw fail(413, '会话暂存空间已满');
        // Bound metadata even for very small messages.
        if (s.items.length >= 2000) throw fail(413, '内容条目过多，请清空后继续');
        const item = { id: randomUUID(), type: 'text', text, size, createdAt: new Date().toISOString() };
        s.items.push(item); s.usedBytes += size; touch(s); return send(res, { item }, 201);
      }
      if (route === '/api/images' && method === 'POST') { const s = auth(req, 'sender'); if (s.items.length + limits.batchCount > 2000) throw fail(413, '内容条目过多，请清空后继续'); return send(res, await upload(req, s), 201); }
      if (route.startsWith('/api/')) {
        const s = auth(req, 'receiver');
        if (route === '/api/session' && method === 'GET') { s.receiverSeen = now(); return send(res, { paired: !!s.sender, pairUrl: s.code && now() <= s.pairUntil ? `${s.publicUrl}/send#${s.code}` : null, items: wireItems(s), usedBytes: s.usedBytes, expiresAt: s.lastActivity + idleMs }); }
        if (route === '/api/session' && method === 'DELETE') {
          if (s.busy) throw fail(409, '传输、下载或清理中，请完成后再结束会话');
          await remove(s); return send(res, { ok: true });
        }
        if (route === '/api/disconnect' && method === 'POST') { revoke(s); s.epoch++; touch(s); return send(res, { ok: true }); }
        if (route === '/api/repair' && method === 'POST') { revoke(s); s.epoch++; touch(s); return send(res, { pairUrl: pair(s) }); }
        if (route === '/api/items' && method === 'DELETE') {
          if (s.busy) throw fail(409, '传输或下载中，请稍后清空');
          s.busy++; s.clearing = true; s.epoch++;
          try { await Promise.all(s.items.filter(i => i.disk).map(i => rm(i.disk, { force: true }))); s.items = []; s.usedBytes = 0; touch(s); return send(res, { ok: true }); }
          finally { s.busy--; s.clearing = false; }
        }
        if (route.startsWith('/api/files/') && method === 'GET') {
          if (s.clearing) throw fail(409, '正在清空，请稍后重试');
          const item = s.items.find(i => i.id === route.slice(11) && i.disk); if (!item) throw fail(404, '文件不存在或已清理');
          s.busy++; touch(s);
          try { const file = await stat(item.disk); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}` }); await pipeline(createReadStream(item.disk), res); }
          finally { s.busy--; touch(s); } return;
        }
        if (route === '/api/archive' && method === 'GET') {
          if (s.clearing) throw fail(409, '正在清空，请稍后重试');
          const files = s.items.filter(i => i.disk); if (!files.length) throw fail(404, '没有可下载图片');
          const zip = new yazl.ZipFile(); files.forEach((i, n) => zip.addFile(i.disk, `${n + 1}-${i.name}`, { compress: false }));
          s.busy++; touch(s); res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="lan-drop.zip"' });
          try { zip.on('error', e => zip.outputStream.destroy(e)); zip.end(); await pipeline(zip.outputStream, res); } finally { s.busy--; touch(s); } return;
        }
        throw fail(404, '接口不存在');
      }
      const pages = { '/': ['index.html', 'text/html'], '/send': ['send.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/receiver.js': ['receiver.js', 'text/javascript'], '/sender.js': ['sender.js', 'text/javascript'] };
      if (method !== 'GET' || !pages[route]) throw fail(404, '页面不存在');
      const [name, mime] = pages[route]; const content = await readFile(path.join(root, 'public', name)); res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(content);
    } catch (e) { if (!res.headersSent && !res.destroyed) send(res, { error: e.status ? e.message : '服务暂时无法处理请求，请重试' }, e.status || 500); else if (!res.destroyed) res.destroy(); }
  });
  server.requestTimeout = 120000; server.headersTimeout = 15000; server.timeout = 120000;
  return { server, limits, cleanup, async close() { clearInterval(timer); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp(); const port = integer(process.env.PORT, 9100);
  app.server.listen(port, '0.0.0.0', () => console.log(`LAN Drop listening on port ${port}; HTTP trusted LAN only`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
