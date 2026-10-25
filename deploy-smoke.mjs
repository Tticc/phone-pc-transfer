import assert from 'node:assert/strict';
const origin = process.argv[2] || 'http://localhost:9100';
async function api(route, {token, json, ...options} = {}) {
  const res = await fetch(origin + route, {...options, signal:AbortSignal.timeout(15000), headers:{...(token ? {Authorization:`Bearer ${token}`} : {}), ...(json !== undefined ? {'Content-Type':'application/json'} : {})}, ...(json !== undefined ? {body:JSON.stringify(json)} : {})});
  assert.ok(res.ok, `${route}: ${res.status}`); return res;
}
assert.equal((await (await api('/health')).json()).ok, true);
const config = await (await api('/api/config')).json();
assert.equal(config.publicUrl, 'http://192.168.1.3:9100');
const s = await (await api('/api/sessions',{method:'POST',json:{}})).json();
const p = await (await api('/api/pair',{method:'POST',json:{code:new URL(s.pairUrl).hash.slice(1)}})).json();
await api('/api/text',{method:'POST',token:p.senderToken,json:{text:'WSL 9100 部署验证 😀'}});
const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const form = new FormData(); form.append('files',new Blob([data],{type:'image/png'}),'smoke.png');
const uploaded = await (await api('/api/images',{method:'POST',token:p.senderToken,body:form})).json();
const got = Buffer.from(await (await api(`/api/files/${uploaded.items[0].id}`,{token:s.receiverToken})).arrayBuffer());
assert.deepEqual(got,data);
const zip = await api('/api/archive',{token:s.receiverToken}); assert.equal(zip.headers.get('content-type'),'application/zip'); await zip.arrayBuffer();
await api('/api/items',{method:'DELETE',token:s.receiverToken});
await api('/api/disconnect',{method:'POST',token:s.receiverToken});
assert.equal((await (await api('/api/session',{token:s.receiverToken})).json()).items.length,0);
console.log('PASS: health, configured URL, pairing, Chinese text, image upload, exact-byte download, ZIP, clear and disconnect');
