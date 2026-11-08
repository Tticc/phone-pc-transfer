import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

const PUBLIC_URL = 'http://192.168.1.24:8080';
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 13, 10, 128, 42]);

async function fixture(t, overrides = {}, options = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'lan-drop-test-'));
  let app;
  // Always provide a complete isolated env; never mutate process.env.
  t.after(async () => {
    try { if (app) await app.close(); }
    finally { await rm(base, { recursive: true, force: true }); }
  });
  app = await createApp({ ...options, env: {
    DATA_DIR: base, PUBLIC_URL, TEXT_CHARS: '100', FILE_BYTES: '1024',
    BATCH_COUNT: '3', SESSION_BYTES: '4096', MAX_SESSIONS: '8',
    IDLE_MS: '60000', PAIR_MS: '30000', ...overrides,
  } });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, { token, json, headers = {}, ...init } = {}) => fetch(origin + route, {
    signal: AbortSignal.timeout(10000), ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  async function json(route, init, status = 200) {
    const response = await request(route, init);
    const body = await response.json();
    assert.equal(response.status, status, `${route}: ${JSON.stringify(body)}`);
    return body;
  }
  async function session() { return json('/api/sessions', { method: 'POST', json: {} }, 201); }
  async function pair(s) {
    return json('/api/pair', { method: 'POST', json: { code: new URL(s.pairUrl).hash.slice(1) } });
  }
  const state = s => json('/api/session', { token: s.receiverToken });
  const upload = (senderToken, files = [{ bytes: IMAGE, name: 'photo.png', mime: 'image/png' }], fields = []) => {
    const form = new FormData();
    for (const file of files) form.append(file.field || 'files', new Blob([file.bytes], { type: file.mime || 'image/png' }), file.name || 'photo.png');
    for (const [name, value] of fields) form.append(name, value);
    return request('/api/images', { method: 'POST', token: senderToken, body: form });
  };
  async function diskFiles() {
    const entries = await readdir(base, { recursive: true, withFileTypes: true });
    return entries.filter(entry => entry.isFile());
  }
  return { ...app, base, origin, request, json, session, pair, state, upload, diskFiles };
}

async function expectError(response, status) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length);
  return body;
}

// Read the ZIP central directory with native Buffer APIs (no test dependency).
// The central directory supplies sizes even when local headers use data descriptors.
function zipEntries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'ZIP end-of-central-directory exists');
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 10), 0, 'ZIP uses lossless stored entries');
    const size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    entries.push({ name: bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'), bytes: bytes.subarray(start, start + size) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function eventually(check, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('complete receiver, QR, one-phone pairing, text, binary download and ZIP flow', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.json('/health'), { ok: true });
  const config = await f.json('/api/config');
  assert.equal(config.publicUrl, PUBLIC_URL);
  assert.equal(config.limits.fileBytes, 1024);
  assert.equal(config.receiverGraceSeconds, 120);
  const s = await f.session();
  assert.equal(new URL(s.pairUrl).origin, PUBLIC_URL);
  assert.match(new URL(s.pairUrl).hash, /^#[\w-]{43}$/);
  assert.equal(s.receiverToken.length, 43);
  assert.equal((await f.state(s)).paired, false);
  const qr = await f.request(`/api/qr?url=${encodeURIComponent(s.pairUrl)}`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);
  const phone = await f.pair(s);
  assert.notEqual(phone.senderToken, s.receiverToken);
  assert.equal((await f.state(s)).paired, true);
  await f.json('/api/sender', { token: phone.senderToken });
  await expectError(await f.request('/api/pair', { method: 'POST', json: { code: new URL(s.pairUrl).hash.slice(1) } }), 410);
  await expectError(await f.request(`/api/qr?url=${encodeURIComponent(s.pairUrl)}`), 410);
  const text = '中文 hello\n👩‍💻 <script>alert(1)</script>';
  const posted = await f.json('/api/text', { method: 'POST', token: phone.senderToken, json: { text } }, 201);
  assert.equal(posted.item.text, text);
  assert.equal(posted.item.size, Buffer.byteLength(text));
  const second = Buffer.from([255, 216, 0, 1, 2, 255, 217]);
  const uploaded = await f.upload(phone.senderToken, [
    { bytes: IMAGE, name: '照片.png' }, { bytes: second, name: 'photo.jpg', mime: 'image/jpeg' },
  ]);
  assert.equal(uploaded.status, 201);
  const { items } = await uploaded.json();
  assert.equal(items.length, 2);
  for (const [index, item] of items.entries()) {
    assert.equal('disk' in item, false);
    assert.equal(item.size, [IMAGE, second][index].length);
    const download = await f.request(`/api/files/${item.id}`, { token: s.receiverToken });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), [IMAGE, second][index]);
  }
  const state = await f.state(s);
  assert.equal(state.items.length, 3);
  assert.equal(state.usedBytes, Buffer.byteLength(text) + IMAGE.length + second.length);
  assert.ok(state.items.every(item => !('disk' in item)));
  const archive = await f.request('/api/archive', { token: s.receiverToken });
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get('content-type'), 'application/zip');
  const entries = zipEntries(Buffer.from(await archive.arrayBuffer()));
  assert.deepEqual(entries.map(entry => entry.name), ['1-照片.png', '2-photo.jpg']);
  assert.deepEqual(entries.map(entry => entry.bytes), [IMAGE, second]);
});

test('re-pair and disconnect revoke old phone and outstanding pair codes', async t => {
  const f = await fixture(t);
  const s = await f.session();
  const first = await f.pair(s);
  await f.json('/api/text', { method: 'POST', token: first.senderToken, json: { text: 'keep me' } }, 201);
  const repair = await f.json('/api/repair', { method: 'POST', token: s.receiverToken });
  await expectError(await f.request('/api/sender', { token: first.senderToken }), 401);
  await expectError(await f.request('/api/text', { method: 'POST', token: first.senderToken, json: { text: 'no' } }), 401);
  assert.equal((await f.state(s)).items[0].text, 'keep me');
  const replacement = await f.json('/api/repair', { method: 'POST', token: s.receiverToken });
  await expectError(await f.request('/api/pair', { method: 'POST', json: { code: new URL(repair.pairUrl).hash.slice(1) } }), 410);
  const second = await f.pair(replacement);
  await f.json('/api/disconnect', { method: 'POST', token: s.receiverToken });
  await expectError(await f.request('/api/sender', { token: second.senderToken }), 401);
  assert.equal((await f.state(s)).paired, false);
});

test('sender disconnect revokes its token, preserves inbox and permits receiver re-pair', async t => {
  const f = await fixture(t);
  const s = await f.session();
  const phone = await f.pair(s);
  await f.json('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'preserved' } }, 201);
  await expectError(await f.request('/api/sender/disconnect', { method: 'POST', token: s.receiverToken }), 401);
  await f.json('/api/sender/disconnect', { method: 'POST', token: phone.senderToken });
  await expectError(await f.request('/api/sender', { token: phone.senderToken }), 401);
  await expectError(await f.request('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'rejected' } }), 401);
  const state = await f.state(s);
  assert.equal(state.paired, false);
  assert.equal(state.items[0].text, 'preserved');
  const next = await f.json('/api/repair', { method: 'POST', token: s.receiverToken });
  await f.pair(next);
  assert.equal((await f.state(s)).paired, true);
});

test('clear removes physical files, resets quota and leaves pair usable', async t => {
  const f = await fixture(t);
  const s = await f.session();
  const phone = await f.pair(s);
  const uploaded = await f.upload(phone.senderToken);
  assert.equal(uploaded.status, 201);
  const { items: [item] } = await uploaded.json();
  assert.equal((await f.diskFiles()).length, 1);
  await f.json('/api/items', { method: 'DELETE', token: s.receiverToken });
  assert.equal((await f.diskFiles()).length, 0);
  const state = await f.state(s);
  assert.equal(state.usedBytes, 0);
  assert.deepEqual(state.items, []);
  assert.equal(state.paired, true);
  await expectError(await f.request(`/api/files/${item.id}`, { token: s.receiverToken }), 404);
  await expectError(await f.request('/api/archive', { token: s.receiverToken }), 404);
  assert.equal((await f.upload(phone.senderToken)).status, 201);
});

test('text character and cumulative UTF-8 byte limits include exact boundaries', async t => {
  const f = await fixture(t, { TEXT_CHARS: '2', SESSION_BYTES: '8' });
  const s = await f.session();
  const phone = await f.pair(s);
  await f.json('/api/text', { method: 'POST', token: phone.senderToken, json: { text: '😀😀' } }, 201);
  assert.equal((await f.state(s)).usedBytes, 8);
  await expectError(await f.request('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'a' } }), 413);
  await f.json('/api/items', { method: 'DELETE', token: s.receiverToken });
  await expectError(await f.request('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'abc' } }), 413);
  assert.equal((await f.state(s)).usedBytes, 0);
});

test('rejected multipart batches are atomic and leave no temporary files or quota', async t => {
  const cases = [
    { name: 'file size', env: { FILE_BYTES: '9' }, files: [{ bytes: IMAGE }], status: 413 },
    { name: 'batch count', env: { BATCH_COUNT: '1' }, files: [{ bytes: IMAGE }, { bytes: IMAGE }], status: 413 },
    { name: 'session bytes', env: { SESSION_BYTES: '9' }, files: [{ bytes: IMAGE }], status: 413 },
    { name: 'non-image', files: [{ bytes: IMAGE }, { bytes: Buffer.from('evil'), mime: 'text/html' }], status: 415 },
    { name: 'wrong field', files: [{ bytes: IMAGE, field: 'other' }], status: 415 },
    { name: 'extra field', files: [{ bytes: IMAGE }], fields: [['caption', 'x']], status: 400 },
    { name: 'empty batch', files: [], status: 400 },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const f = await fixture(t, scenario.env);
    const s = await f.session();
    const phone = await f.pair(s);
    await expectError(await f.upload(phone.senderToken, scenario.files, scenario.fields), scenario.status);
    assert.deepEqual((await f.state(s)).items, []);
    assert.equal((await f.state(s)).usedBytes, 0);
    assert.equal((await f.diskFiles()).length, 0);
    // A rejection must release busy as well as disk/quota resources.
    await f.json('/api/items', { method: 'DELETE', token: s.receiverToken });
    assert.equal((await f.upload(phone.senderToken, [{ bytes: Buffer.from([1]) }])).status, 201);
  });
});

test('pair timeout, idle timeout, cleanup and maximum live sessions use injected clock', async t => {
  let clock = 1000000;
  const f = await fixture(t, { MAX_SESSIONS: '1' }, { now: () => clock, pairMs: 50, idleMs: 1000 });
  const s = await f.session();
  await expectError(await f.request('/api/sessions', { method: 'POST', json: {} }), 429);
  clock += 51;
  await expectError(await f.request(`/api/qr?url=${encodeURIComponent(s.pairUrl)}`), 410);
  await expectError(await f.request('/api/pair', { method: 'POST', json: { code: new URL(s.pairUrl).hash.slice(1) } }), 410);
  const repair = await f.json('/api/repair', { method: 'POST', token: s.receiverToken });
  const phone = await f.pair(repair);
  assert.equal((await f.upload(phone.senderToken)).status, 201);
  assert.equal((await f.diskFiles()).length, 1);
  clock += 999;
  assert.equal((await f.state(s)).paired, true);
  clock += 1;
  await expectError(await f.request('/api/session', { token: s.receiverToken }), 401);
  await expectError(await f.request('/api/sender', { token: phone.senderToken }), 401);
  await f.cleanup();
  assert.equal((await f.diskFiles()).length, 0);
  await f.session();
});

test('authentication isolates sessions and receiver/sender roles', async t => {
  const f = await fixture(t);
  const a = await f.session();
  const b = await f.session();
  const phone = await f.pair(a);
  const response = await f.upload(phone.senderToken);
  const { items: [item] } = await response.json();
  for (const token of [undefined, 'wrong']) {
    await expectError(await f.request('/api/session', { token }), 401);
    await expectError(await f.request(`/api/files/${item.id}`, { token }), 401);
    await expectError(await f.request('/api/text', { method: 'POST', token, json: { text: 'unauthorized' } }), 401);
  }
  // Phone sender can read its own session and download files
  const senderSession = await f.json('/api/session', { token: phone.senderToken });
  assert.equal(senderSession.items.length, 1);
  assert.equal(senderSession.role, 'sender');
  const file = await f.request(`/api/files/${item.id}`, { token: phone.senderToken });
  assert.equal(file.status, 200);

  // Phone sender cannot perform receiver-only management actions
  await expectError(await f.request('/api/session', { method: 'DELETE', token: phone.senderToken }), 401);
  await expectError(await f.request('/api/items', { method: 'DELETE', token: phone.senderToken }), 401);
  await expectError(await f.request('/api/repair', { method: 'POST', token: phone.senderToken }), 401);

  // PC receiver can also send text and files
  const pcText = await f.json('/api/text', { method: 'POST', token: a.receiverToken, json: { text: 'from pc' } }, 201);
  assert.equal(pcText.item.sender, 'pc');

  // Other session's token cannot access session A's items
  await expectError(await f.request(`/api/files/${item.id}`, { token: b.receiverToken }), 404);
  await expectError(await f.request('/api/archive', { token: b.receiverToken }), 404);
  assert.deepEqual((await f.state(b)).items, []);
});

test('bidirectional transfer allows pc and phone to exchange text and photos', async t => {
  const f = await fixture(t);
  const s = await f.session();
  const phone = await f.pair(s);

  // 1. PC sends text
  const pcText = await f.json('/api/text', { method: 'POST', token: s.receiverToken, json: { text: '你好，手机！' } }, 201);
  assert.equal(pcText.item.sender, 'pc');
  assert.equal(pcText.item.text, '你好，手机！');

  // 2. PC uploads photo
  const pcUpload = await f.upload(s.receiverToken, [{ bytes: IMAGE, name: 'pc-photo.png' }]);
  assert.equal(pcUpload.status, 201);
  const { items: [pcImg] } = await pcUpload.json();
  assert.equal(pcImg.sender, 'pc');

  // 3. Phone sends text
  const phoneText = await f.json('/api/text', { method: 'POST', token: phone.senderToken, json: { text: '收到，电脑！' } }, 201);
  assert.equal(phoneText.item.sender, 'phone');

  // 4. Phone uploads photo
  const phoneUpload = await f.upload(phone.senderToken, [{ bytes: IMAGE, name: 'phone-photo.png' }]);
  assert.equal(phoneUpload.status, 201);
  const { items: [phoneImg] } = await phoneUpload.json();
  assert.equal(phoneImg.sender, 'phone');

  // 5. Phone queries /api/session and sees all 4 items with correct origin tags
  const phoneState = await f.json('/api/session', { token: phone.senderToken });
  assert.equal(phoneState.items.length, 4);
  assert.deepEqual(phoneState.items.map(i => i.sender), ['pc', 'pc', 'phone', 'phone']);

  // 6. Phone can download the image sent by PC
  const downloadByPhone = await f.request(`/api/files/${pcImg.id}`, { token: phone.senderToken });
  assert.equal(downloadByPhone.status, 200);
  assert.deepEqual(Buffer.from(await downloadByPhone.arrayBuffer()), IMAGE);

  // 7. PC can download the image sent by Phone
  const downloadByPC = await f.request(`/api/files/${phoneImg.id}`, { token: s.receiverToken });
  assert.equal(downloadByPC.status, 200);
  assert.deepEqual(Buffer.from(await downloadByPC.arrayBuffer()), IMAGE);

  // 8. PC can stage items before phone pairs, and phone sees them immediately after pairing
  const s2 = await f.session();
  await f.json('/api/text', { method: 'POST', token: s2.receiverToken, json: { text: '提前准备好的内容' } }, 201);
  const phone2 = await f.pair(s2);
  const state2 = await f.json('/api/session', { token: phone2.senderToken });
  assert.equal(state2.items.length, 1);
  assert.equal(state2.items[0].text, '提前准备好的内容');
});

test('cross-origin mutations denied, same-origin works, responses have defensive headers', async t => {
  const f = await fixture(t);
  for (const origin of ['https://evil.example', 'http://evil.example', f.origin.replace('http:', 'https:')]) {
    await expectError(await f.request('/api/sessions', { method: 'POST', json: {}, headers: { Origin: origin } }), 403);
  }
  const response = await f.request('/api/sessions', { method: 'POST', json: {}, headers: { Origin: f.origin } });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const preflight = await f.request('/api/sessions', { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('invalid public URLs, JSON, text, routes and malformed multipart fail safely', async t => {
  const f = await fixture(t);
  for (const publicUrl of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'http://0.0.0.0:8080', 'https://192.168.1.24', 'http://user:pass@192.168.1.24', `${PUBLIC_URL}/path`, `${PUBLIC_URL}/?query=1`, `${PUBLIC_URL}/#hash`, 'not a URL']) {
    await expectError(await f.request('/api/sessions', { method: 'POST', json: { publicUrl } }), 400);
  }
  await expectError(await f.request('/api/sessions', { method: 'POST', body: '{}' }), 415);
  await expectError(await f.request('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), 400);
  await expectError(await f.request('/api/sessions', { method: 'POST', json: { junk: 'x'.repeat(5000) } }), 413);
  const s = await f.session();
  const phone = await f.pair(s);
  for (const text of ['', '   ', 123, false, {}, []]) {
    await expectError(await f.request('/api/text', { method: 'POST', token: phone.senderToken, json: { text } }), 400);
  }
  await expectError(await f.request('/api/images', { method: 'POST', token: phone.senderToken, body: 'not multipart' }), 400);
  await expectError(await f.request('/api/images', { method: 'POST', token: phone.senderToken, headers: { 'Content-Type': 'multipart/form-data; boundary=broken' }, body: '--broken\r\ninvalid' }), 400);
  await expectError(await f.request('/api/missing', { token: s.receiverToken }), 404);
  await expectError(await f.request('/missing'), 404);
  await expectError(await f.request('/api/qr?url=' + 'x'.repeat(2049)), 400);
  await expectError(await f.request(`/api/qr?url=${encodeURIComponent(s.pairUrl + 'tampered')}`), 410);
  assert.equal((await f.diskFiles()).length, 0);
});

test('truncated multipart removes partial file without deleting earlier successful content', async t => {
  const f = await fixture(t);
  const s = await f.session();
  const phone = await f.pair(s);
  const good = await f.upload(phone.senderToken);
  assert.equal(good.status, 201);
  const { items: [saved] } = await good.json();
  const boundary = 'truncated-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="truncated.png"\r\nContent-Type: image/png\r\n\r\n`), IMAGE,
  ]);
  const malformed = await f.request('/api/images', { method: 'POST', token: phone.senderToken, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
  await expectError(malformed, 400);
  const state = await f.state(s);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].id, saved.id);
  assert.equal(state.usedBytes, IMAGE.length);
  assert.equal((await f.diskFiles()).length, 1);
  const download = await f.request(`/api/files/${saved.id}`, { token: s.receiverToken });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), IMAGE);
  await eventually(async () => {
    const response = await f.request('/api/items', { method: 'DELETE', token: s.receiverToken });
    assert.ok([200, 409].includes(response.status));
    return response.status === 200;
  }, 'completed download must release its busy lock');
});

test('null JSON and malformed Origin are client errors, not internal errors', async t => {
  const f = await fixture(t);
  for (const route of ['/api/sessions', '/api/pair']) {
    await expectError(await f.request(route, { method: 'POST', json: null }), 400);
  }
  await expectError(await f.request('/api/sessions', { method: 'POST', json: {}, headers: { Origin: 'null' } }), 403);
  await expectError(await f.request('/api/sessions', { method: 'POST', json: {}, headers: { Origin: 'invalid' } }), 403);
});

test('in-flight upload blocks clear and concurrent upload; re-pair rolls back staged file', async t => {
  const f = await fixture(t);
  const s = await f.session();
  const phone = await f.pair(s);
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const boundary = 'test-upload-boundary';
  controller.enqueue(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n`));
  controller.enqueue(IMAGE);
  const pending = f.request('/api/images', { method: 'POST', token: phone.senderToken, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, duplex: 'half' });
  // Attach a rejection handler immediately so fixture teardown cannot create an unhandled rejection.
  pending.catch(() => {});
  await eventually(async () => (await f.diskFiles()).length === 1, 'upload must have staged its partial file');
  await expectError(await f.request('/api/items', { method: 'DELETE', token: s.receiverToken }), 409);
  await expectError(await f.request('/api/session', { method: 'DELETE', token: s.receiverToken }), 409);
  await expectError(await f.upload(phone.senderToken), 409);
  await expectError(await f.request('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'concurrent mutation' } }), 409);
  await f.json('/api/repair', { method: 'POST', token: s.receiverToken });
  controller.enqueue(Buffer.from(`\r\n--${boundary}--\r\n`));
  controller.close();
  await expectError(await pending, 409);
  assert.deepEqual((await f.state(s)).items, []);
  assert.equal((await f.state(s)).usedBytes, 0);
  assert.equal((await f.diskFiles()).length, 0);
  await f.json('/api/items', { method: 'DELETE', token: s.receiverToken });
});

test('simultaneous pairing has exactly one winner and live-session cap is atomic', async t => {
  const f = await fixture(t, { MAX_SESSIONS: '1' });
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.request('/api/sessions', { method: 'POST', json: {} })));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 429).length, 7);
  const s = await responses.find(response => response.status === 201).json();
  const code = new URL(s.pairUrl).hash.slice(1);
  const pairs = await Promise.all(Array.from({ length: 8 }, () => f.request('/api/pair', { method: 'POST', json: { code } })));
  assert.equal(pairs.filter(response => response.status === 200).length, 1);
  assert.equal(pairs.filter(response => response.status === 410).length, 7);
});

test('exact upload boundaries and mixed text/file quota are enforced cumulatively', async t => {
  const f = await fixture(t, { FILE_BYTES: '10', SESSION_BYTES: '12', BATCH_COUNT: '2' });
  const s = await f.session();
  const phone = await f.pair(s);
  await f.json('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'ok' } }, 201);
  const response = await f.upload(phone.senderToken);
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.equal(uploaded.items[0].size, 10);
  assert.equal((await f.state(s)).usedBytes, 12);
  await expectError(await f.upload(phone.senderToken, [{ bytes: Buffer.from([1]) }]), 413);
  assert.equal((await f.diskFiles()).length, 1);
  assert.equal((await f.state(s)).usedBytes, 12);
  await f.json('/api/items', { method: 'DELETE', token: s.receiverToken });
  const batch = await f.upload(phone.senderToken, [{ bytes: Buffer.from([1]) }, { bytes: Buffer.from([2]) }]);
  assert.equal(batch.status, 201);
  assert.equal((await batch.json()).items.length, 2);
});

test('upload filenames cannot expose disk paths or escape ZIP root', async t => {
  const f = await fixture(t);
  const s = await f.session();
  const phone = await f.pair(s);
  const response = await f.upload(phone.senderToken, [{ bytes: IMAGE, name: '..\\..\\secret.png' }]);
  assert.equal(response.status, 201);
  const { items: [item] } = await response.json();
  assert.equal(item.name, 'secret.png');
  assert.equal('disk' in item, false);
  const archive = await f.request('/api/archive', { token: s.receiverToken });
  const [entry] = zipEntries(Buffer.from(await archive.arrayBuffer()));
  assert.equal(entry.name, '1-secret.png');
  assert.deepEqual(entry.bytes, IMAGE);
});

test('aborted upload rolls back disk and quota and releases busy lock', async t => {
  const f = await fixture(t);
  const s = await f.session();
  const phone = await f.pair(s);
  const abort = new AbortController();
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  const boundary = 'test-abort-boundary';
  controller.enqueue(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n`));
  controller.enqueue(IMAGE);
  const pending = f.request('/api/images', { method: 'POST', token: phone.senderToken, signal: abort.signal, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, duplex: 'half' });
  pending.catch(() => {});
  await eventually(async () => (await f.diskFiles()).length === 1, 'aborted upload must have begun writing');
  abort.abort();
  controller.close();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await eventually(async () => (await f.diskFiles()).length === 0, 'aborted upload must remove its staged file');
  assert.equal((await f.state(s)).usedBytes, 0);
  assert.deepEqual((await f.state(s)).items, []);
  assert.equal((await f.upload(phone.senderToken)).status, 201);
});

test('receiver grace config supports env and options with options taking precedence', async t => {
  for (const scenario of [
    { name: 'env', env: { RECEIVER_GRACE_MS: '45000' }, options: {}, seconds: 45 },
    { name: 'options override env', env: { RECEIVER_GRACE_MS: '45000' }, options: { receiverGraceMs: 1500 }, seconds: 1.5 },
  ]) await t.test(scenario.name, async t => {
    const f = await fixture(t, scenario.env, scenario.options);
    assert.equal((await f.json('/api/config')).receiverGraceSeconds, scenario.seconds);
  });
});

test('closing receiver without heartbeats reclaims empty sessions, including paired sessions, at grace boundary', async t => {
  for (const paired of [false, true]) await t.test(paired ? 'paired' : 'unpaired', async t => {
    let clock = 1000000;
    const f = await fixture(t, { MAX_SESSIONS: '1', RECEIVER_GRACE_MS: '1000' }, { now: () => clock, idleMs: 10000 });
    const s = await f.session();
    const phone = paired ? await f.pair(s) : null;
    // Simulate closing the receiver: no further GET /api/session requests.
    clock += 999;
    await f.cleanup();
    await expectError(await f.request('/api/sessions', { method: 'POST', json: {} }), 429);
    clock += 1;
    await f.cleanup();
    await expectError(await f.request('/api/session', { token: s.receiverToken }), 401);
    if (phone) await expectError(await f.request('/api/sender', { token: phone.senderToken }), 401);
    await expectError(await f.request(`/api/qr?url=${encodeURIComponent(s.pairUrl)}`), 410);
    await expectError(await f.request('/api/pair', { method: 'POST', json: { code: new URL(s.pairUrl).hash.slice(1) } }), 410);
    assert.equal((await readdir(f.base, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory()).length, 1, 'only the app root remains after cleanup');
    await f.session();
  });
});

test('creation performs grace cleanup without waiting for scheduled cleanup', async t => {
  let clock = 1000000;
  const f = await fixture(t, { MAX_SESSIONS: '1' }, { now: () => clock, receiverGraceMs: 1000, idleMs: 10000 });
  const old = await f.session();
  clock += 1000;
  const next = await f.session();
  assert.notEqual(next.id, old.id);
  await expectError(await f.request('/api/session', { token: old.receiverToken }), 401);
});

test('receiver heartbeats retain empty sessions but never extend business idle expiry', async t => {
  let clock = 1000000;
  const f = await fixture(t, { MAX_SESSIONS: '1' }, { now: () => clock, receiverGraceMs: 1000, idleMs: 3000 });
  const s = await f.session();
  const expiresAt = (await f.state(s)).expiresAt;
  assert.equal(expiresAt, clock + 3000, 'lastActivity starts at creation time');
  for (const elapsed of [900, 1800, 2700, 2999]) {
    clock = 1000000 + elapsed;
    assert.equal((await f.state(s)).expiresAt, expiresAt, 'heartbeat must not update lastActivity');
    await f.cleanup();
    await expectError(await f.request('/api/sessions', { method: 'POST', json: {} }), 429);
  }
  clock = expiresAt;
  await f.cleanup();
  await expectError(await f.request('/api/session', { token: s.receiverToken }), 401);
  await f.session();
});

test('receiver heartbeat grace is measured from its last successful poll', async t => {
  let clock = 1000000;
  const f = await fixture(t, { MAX_SESSIONS: '1' }, { now: () => clock, receiverGraceMs: 1000, idleMs: 10000 });
  const s = await f.session();
  clock += 900;
  await f.state(s);
  clock += 999;
  await f.cleanup();
  await expectError(await f.request('/api/sessions', { method: 'POST', json: {} }), 429);
  clock += 1;
  await f.cleanup();
  await expectError(await f.request('/api/session', { token: s.receiverToken }), 401);
  await f.session();
});

test('sender presence is not a receiver heartbeat and cannot keep empty abandoned session alive', async t => {
  let clock = 1000000;
  const f = await fixture(t, { MAX_SESSIONS: '1' }, { now: () => clock, receiverGraceMs: 1000, idleMs: 10000 });
  const s = await f.session();
  const phone = await f.pair(s);
  clock += 900;
  await f.json('/api/sender', { token: phone.senderToken });
  clock += 100;
  await f.cleanup();
  await expectError(await f.request('/api/sender', { token: phone.senderToken }), 401);
  await f.session();
});

test('text and image content survive receiver grace but still expire at business idle timeout', async t => {
  for (const kind of ['text', 'image']) await t.test(kind, async t => {
    let clock = 1000000;
    const f = await fixture(t, { MAX_SESSIONS: '1' }, { now: () => clock, receiverGraceMs: 1000, idleMs: 5000 });
    const s = await f.session();
    const phone = await f.pair(s);
    if (kind === 'text') await f.json('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'do not lose me' } }, 201);
    else assert.equal((await f.upload(phone.senderToken)).status, 201);
    clock += 1001;
    await f.cleanup();
    await expectError(await f.request('/api/sessions', { method: 'POST', json: {} }), 429);
    assert.equal((await f.state(s)).items.length, 1);
    assert.equal((await f.diskFiles()).length, kind === 'image' ? 1 : 0);
    clock = 1004999;
    await f.cleanup();
    assert.equal((await f.state(s)).items.length, 1);
    clock += 1;
    await f.cleanup();
    await expectError(await f.request('/api/session', { token: s.receiverToken }), 401);
    assert.equal((await f.diskFiles()).length, 0);
    await f.session();
  });
});

test('business activity restarts empty-session grace even with no new receiver heartbeat', async t => {
  let clock = 1000000;
  const f = await fixture(t, { MAX_SESSIONS: '1' }, { now: () => clock, receiverGraceMs: 1000, idleMs: 10000 });
  const s = await f.session();
  const phone = await f.pair(s);
  await f.json('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'clear later' } }, 201);
  clock += 900;
  await f.json('/api/items', { method: 'DELETE', token: s.receiverToken });
  clock += 999;
  await f.cleanup();
  await expectError(await f.request('/api/sessions', { method: 'POST', json: {} }), 429);
  clock += 1;
  await f.cleanup();
  await expectError(await f.request('/api/session', { token: s.receiverToken }), 401);
  await f.session();
});

test('explicit receiver end removes content, disk, tokens, outstanding QR and releases slot immediately', async t => {
  const f = await fixture(t, { MAX_SESSIONS: '1' });
  const s = await f.session();
  const phone = await f.pair(s);
  await f.json('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'private text' } }, 201);
  const upload = await f.upload(phone.senderToken);
  assert.equal(upload.status, 201);
  const { items: [item] } = await upload.json();
  for (const token of [undefined, 'wrong', phone.senderToken]) {
    await expectError(await f.request('/api/session', { method: 'DELETE', token }), 401);
  }
  assert.equal((await f.state(s)).items.length, 2, 'sender cannot end receiver session');
  assert.equal((await f.diskFiles()).length, 1);
  // Disconnect the phone to create an outstanding QR while retaining its revoked token.
  const repair = await f.json('/api/repair', { method: 'POST', token: s.receiverToken });
  await f.json('/api/session', { method: 'DELETE', token: s.receiverToken });
  assert.equal((await f.diskFiles()).length, 0);
  assert.equal((await readdir(f.base, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory()).length, 1, 'session directory itself is removed');
  for (const route of ['/api/session', '/api/archive', `/api/files/${item.id}`]) {
    await expectError(await f.request(route, { token: s.receiverToken }), 401);
  }
  await expectError(await f.request('/api/session', { method: 'DELETE', token: s.receiverToken }), 401);
  await expectError(await f.request('/api/sender', { token: phone.senderToken }), 401);
  await expectError(await f.request('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'late' } }), 401);
  await expectError(await f.upload(phone.senderToken), 401);
  for (const pairUrl of [s.pairUrl, repair.pairUrl]) {
    await expectError(await f.request(`/api/qr?url=${encodeURIComponent(pairUrl)}`), 410);
    await expectError(await f.request('/api/pair', { method: 'POST', json: { code: new URL(pairUrl).hash.slice(1) } }), 410);
  }
  const next = await f.session();
  assert.notEqual(next.id, s.id);
  assert.deepEqual((await f.state(next)).items, []);
});

test('ending a paired session revokes the currently active sender immediately', async t => {
  const f = await fixture(t, { MAX_SESSIONS: '1' });
  const s = await f.session();
  const phone = await f.pair(s);
  await f.json('/api/session', { method: 'DELETE', token: s.receiverToken });
  await expectError(await f.request('/api/sender', { token: phone.senderToken }), 401);
  await expectError(await f.request('/api/text', { method: 'POST', token: phone.senderToken, json: { text: 'late' } }), 401);
  await expectError(await f.upload(phone.senderToken), 401);
  await f.session();
});

test('text request awaiting its body revalidates sender after receiver ends session', async t => {
  const f = await fixture(t, { MAX_SESSIONS: '1' });
  const s = await f.session();
  const phone = await f.pair(s);
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  controller.enqueue(Buffer.from('{"text":"'));
  // The server request event runs after its handler has reached the pending body read.
  const arrived = new Promise(resolve => f.server.once('request', resolve));
  const pending = f.request('/api/text', { method: 'POST', token: phone.senderToken, headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' });
  pending.catch(() => {});
  await arrived;
  await f.json('/api/session', { method: 'DELETE', token: s.receiverToken });
  const next = await f.session();
  controller.enqueue(Buffer.from('must not be committed"}'));
  controller.close();
  await expectError(await pending, 401);
  assert.deepEqual((await f.state(next)).items, []);
  assert.equal((await f.diskFiles()).length, 0);
});

test('capacity errors give actionable Chinese guidance and consistent Retry-After metadata', async t => {
  const f = await fixture(t, { MAX_SESSIONS: '1' }, { receiverGraceMs: 1500 });
  await f.session();
  const response = await f.request('/api/sessions', { method: 'POST', json: {} });
  const body = await expectError(response, 429);
  assert.ok(Number.isSafeInteger(body.retryAfterSeconds) && body.retryAfterSeconds > 0);
  assert.equal(response.headers.get('retry-after'), String(body.retryAfterSeconds));
  assert.match(body.error, /[\u3400-\u9fff]/);
  assert.match(body.error, /等待|稍后|重试|结束|关闭/);
});

test('failed session removal revokes access, retains capacity and retries physical cleanup', async t => {
  const f = await fixture(t, { MAX_SESSIONS: '1' });
  const s = await f.session();
  const phone = await f.pair(s);
  assert.equal((await f.upload(phone.senderToken)).status, 201);
  const originalRm = fs.rm;
  let failedAttempts = 0;
  // syncBuiltinESMExports updates server.js's named rm binding too. Scope the
  // fault to this UUID so unrelated fixture cleanup is never intercepted.
  fs.rm = async (target, options) => {
    if (path.basename(String(target)) === s.id) {
      failedAttempts++;
      throw Object.assign(new Error('injected EPERM: session directory is locked'), { code: 'EPERM' });
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();
  try {
    await expectError(await f.request('/api/session', { method: 'DELETE', token: s.receiverToken }), 500);
    await expectError(await f.request('/api/session', { token: s.receiverToken }), 401);
    await expectError(await f.request('/api/sender', { token: phone.senderToken }), 401);
    await expectError(await f.request('/api/pair', { method: 'POST', json: { code: new URL(s.pairUrl).hash.slice(1) } }), 410);
    assert.equal((await f.diskFiles()).length, 1, 'failed deletion retains the physical file');
    await assert.rejects(f.cleanup(), { code: 'EPERM' });
    // Creation runs cleanup first and reports its filesystem error; crucially
    // it must not treat the retired session as a released capacity slot.
    await expectError(await f.request('/api/sessions', { method: 'POST', json: {} }), 500);
    assert.ok(failedAttempts >= 3, 'each cleanup retries the retained retired session');
    const dirs = (await readdir(f.base, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory());
    assert.equal(dirs.length, 2, 'only the app root and the original session directory exist');
  } finally {
    fs.rm = originalRm;
    syncBuiltinESMExports();
  }
  await f.cleanup();
  assert.equal((await f.diskFiles()).length, 0, 'successful retry removes the private file');
  const dirs = (await readdir(f.base, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory());
  assert.equal(dirs.length, 1, 'successful retry removes the session directory itself');
  const next = await f.session();
  assert.notEqual(next.id, s.id);
  assert.deepEqual((await f.state(next)).items, []);
});

test('concurrent creates after grace reclamation retain the atomic live-session cap', async t => {
  let clock = 1000000;
  const f = await fixture(t, { MAX_SESSIONS: '2' }, { now: () => clock, receiverGraceMs: 1000, idleMs: 10000 });
  const old = await f.session();
  clock += 900;
  const live = await f.session();
  clock += 100;
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.request('/api/sessions', { method: 'POST', json: {} })));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 429).length, 11);
  const next = await responses.find(response => response.status === 201).json();
  await expectError(await f.request('/api/session', { token: old.receiverToken }), 401);
  assert.deepEqual((await f.state(live)).items, []);
  assert.deepEqual((await f.state(next)).items, []);
  assert.equal((await readdir(f.base, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory()).length, 3, 'app root plus exactly two live session directories');
});
