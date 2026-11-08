import assert from 'node:assert/strict';
const origin = process.argv[2] || 'http://localhost:9100';
async function api(route, {token, json, ...options} = {}) {
  const res = await fetch(origin + route, {...options, signal:AbortSignal.timeout(15000), headers:{...(token ? {Authorization:`Bearer ${token}`} : {}), ...(json !== undefined ? {'Content-Type':'application/json'} : {})}, ...(json !== undefined ? {body:JSON.stringify(json)} : {})});
  assert.ok(res.ok, `${route}: ${res.status}`); return res;
}
assert.equal((await (await api('/health')).json()).ok, true);
const config = await (await api('/api/config')).json();
assert.ok(typeof config.publicUrl === 'string' && config.publicUrl.length > 0, 'publicUrl is configured');
const s = await (await api('/api/sessions',{method:'POST',json:{}})).json();
const p = await (await api('/api/pair',{method:'POST',json:{code:new URL(s.pairUrl).hash.slice(1)}})).json();

// 1. Phone sends text and image
await api('/api/text',{method:'POST',token:p.senderToken,json:{text:'手机发送测试 😀'}});
const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const formPhone = new FormData(); formPhone.append('files',new Blob([data],{type:'image/png'}),'phone-smoke.png');
const phoneUploaded = await (await api('/api/images',{method:'POST',token:p.senderToken,body:formPhone})).json();

// 2. PC downloads phone's image
const gotFromPhone = Buffer.from(await (await api(`/api/files/${phoneUploaded.items[0].id}`,{token:s.receiverToken})).arrayBuffer());
assert.deepEqual(gotFromPhone, data);

// 3. PC sends text and image
await api('/api/text',{method:'POST',token:s.receiverToken,json:{text:'电脑发送测试 💻'}});
const formPc = new FormData(); formPc.append('files',new Blob([data],{type:'image/png'}),'pc-smoke.png');
const pcUploaded = await (await api('/api/images',{method:'POST',token:s.receiverToken,body:formPc})).json();

// 4. Phone queries session and downloads PC's image
const phoneState = await (await api('/api/session',{token:p.senderToken})).json();
assert.equal(phoneState.items.length, 4);
const gotFromPc = Buffer.from(await (await api(`/api/files/${pcUploaded.items[0].id}`,{token:p.senderToken})).arrayBuffer());
assert.deepEqual(gotFromPc, data);

// 5. ZIP download and cleanup
const zip = await api('/api/archive',{token:s.receiverToken}); assert.equal(zip.headers.get('content-type'),'application/zip'); await zip.arrayBuffer();
await api('/api/items',{method:'DELETE',token:s.receiverToken});
assert.equal((await (await api('/api/session',{token:s.receiverToken})).json()).items.length,0);
await api('/api/session',{method:'DELETE',token:s.receiverToken});
console.log('PASS: health, bidirectional text and images, exact-byte downloads, ZIP, clear and clean session termination');
