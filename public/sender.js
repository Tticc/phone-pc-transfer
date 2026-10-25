(() => {
  'use strict';
  // Credentials in the fragment are never sent to the server or left in history.
  const fragment = location.hash.slice(1);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const $ = id => document.getElementById(id);
  const storageKey = 'lan-drop-sender-token';
  let token = '', limits = null, connected = false, sendingText = false, uploading = false, checking = false, selected = [], toastTimer;
  function show(el, value) { el.classList.toggle('hidden', !value); }
  function message(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); show($(id), Boolean(text)); }
  function toast(text) { $('toast').textContent = text; show($('toast'), true); clearTimeout(toastTimer); toastTimer = setTimeout(() => show($('toast'), false), 4000); }
  function bytes(value) { if (!value) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const i = Math.min(3, Math.floor(Math.log(value) / Math.log(1000))); return `${(value / 1000 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }
  function saveToken(value) { token = value; try { if (value) sessionStorage.setItem(storageKey, value); else sessionStorage.removeItem(storageKey); } catch { /* Memory-only operation remains available when storage is disabled. */ } }
  function controls() {
    const ready = connected && Boolean(limits);
    $('text-input').disabled = !ready || sendingText;
    $('send-text').disabled = !ready || sendingText || !$('text-input').value.trim() || [...$('text-input').value].length > (limits ? limits.textChars : 0);
    $('image-files').disabled = !ready || uploading; $('file-picker-label').classList.toggle('disabled', !ready || uploading);
    $('send-images').disabled = !ready || uploading || !selected.length;
    $('reset-files').disabled = uploading; show($('reset-files'), Boolean(selected.length));
    show($('disconnect'), connected); $('disconnect').disabled = uploading || sendingText;
  }
  function status(title, detail, kind = '') { $('sender-status').textContent = title; $('sender-status-detail').textContent = detail; $('sender-status-dot').className = `status-dot ${kind}`; }
  function expire(error) {
    connected = false; saveToken(''); status('连接已失效', '请在电脑上重新配对，再扫描新的二维码。', 'expired'); message('sender-error', error.message || '当前凭证已过期。', true); controls();
  }
  async function api(path, options = {}, timeout = 15000) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) { const body = await response.json().catch(() => ({})); const error = new Error(body.error || `请求失败（${response.status}）`); error.status = response.status; throw error; }
      // Keep the deadline active until the response body is fully received.
      const body = response.status === 204 ? null : await response.blob();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { if (error.name === 'AbortError') throw new Error('请求超时，结果尚未确认。请检查电脑接收箱后手动重试，以免重复发送。'); throw error; }
    finally { clearTimeout(timer); }
  }
  function handleError(error, target = 'sender-error') { if (error.status === 401 || error.status === 410) expire(error); else message(target, error.message || '网络连接失败，请手动重试。', true); }
  function setLimits(value) {
    if (!value || !['textChars', 'fileBytes', 'batchCount', 'sessionBytes'].every(key => Number.isFinite(value[key]) && value[key] > 0)) throw new Error('无法获取有效的发送限制，请重新扫描二维码。');
    limits = value; $('file-limits').textContent = `每批最多 ${limits.batchCount} 张 · 单张不超过 ${bytes(limits.fileBytes)} · 会话总量 ${bytes(limits.sessionBytes)}`; updateText();
  }
  function updateText() { const count = [...$('text-input').value].length; $('text-count').textContent = `${count.toLocaleString()}${limits ? ` / ${limits.textChars.toLocaleString()}` : ''} 字符`; $('text-count').style.color = limits && count > limits.textChars ? 'var(--danger)' : ''; controls(); }
  function renderSelection() {
    $('selected-files').replaceChildren();
    selected.forEach(file => { const li = document.createElement('li'); const name = document.createElement('span'); name.className = 'file-name'; name.textContent = file.name; const size = document.createElement('span'); size.className = 'file-size'; size.textContent = bytes(file.size); li.append(name, size); $('selected-files').append(li); });
    $('selection-size').textContent = selected.length ? `${selected.length} 张 · ${bytes(selected.reduce((total, file) => total + file.size, 0))}` : '尚未选择图片'; controls();
  }
  function validateSelection(files) {
    if (!files.length) return;
    if (files.length > limits.batchCount) throw new Error(`一次最多选择 ${limits.batchCount} 张图片，请重新选择。`);
    for (const file of files) {
      if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) throw new Error(`“${file.name}”不是支持的图片文件。`);
      if (file.size > limits.fileBytes) throw new Error(`“${file.name}”超过单张 ${bytes(limits.fileBytes)} 的限制。`);
      if (!file.size) throw new Error(`“${file.name}”为空文件，请重新选择。`);
    }
    if (files.reduce((total, file) => total + file.size, 0) > limits.sessionBytes) throw new Error(`所选图片总量超过会话 ${bytes(limits.sessionBytes)} 的限制，请减少图片。`);
  }
  $('text-input').addEventListener('input', updateText);
  $('text-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!connected || sendingText || !limits) return;
    const text = $('text-input').value;
    if (!text.trim()) return;
    if ([...text].length > limits.textChars) { message('sender-error', `文字超过 ${limits.textChars} 字符限制。`, true); return; }
    sendingText = true; controls(); message('sender-error', ''); $('send-text').textContent = '正在发送…';
    try { await api('/api/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }, 20000); $('text-input').value = ''; updateText(); toast('文字已送达，请在电脑端保存。'); }
    catch (error) { handleError(error); }
    finally { sendingText = false; $('send-text').textContent = '发送文字 ↗'; controls(); }
  });
  $('image-files').addEventListener('change', () => {
    message('upload-message', ''); show($('upload-progress'), false);
    try { const files = Array.from($('image-files').files); validateSelection(files); selected = files; }
    catch (error) { selected = []; message('upload-message', error.message, true); $('image-files').value = ''; }
    renderSelection();
  });
  $('reset-files').addEventListener('click', () => { selected = []; $('image-files').value = ''; renderSelection(); message('upload-message', ''); show($('upload-progress'), false); });
  function upload(files) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/images'); xhr.timeout = 120000; xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) { const percent = Math.min(100, Math.round(event.loaded / event.total * 100)); $('progress-bar').style.width = `${percent}%`; $('progress-label').textContent = percent === 100 ? '上传完成，等待电脑确认…' : `正在上传 ${percent}% · ${bytes(event.loaded)} / ${bytes(event.total)}`; }
        else $('progress-label').textContent = `正在上传 · 已发送 ${bytes(event.loaded)}`;
      };
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* Non-JSON failures still receive an actionable message. */ }
        if (xhr.status >= 200 && xhr.status < 300) { if (!Array.isArray(data.items)) { reject(new Error('服务器响应不完整，发送结果尚未确认。请检查电脑接收箱后决定是否重试。')); return; } resolve(data); }
        else { const error = new Error(data.error || `上传失败（${xhr.status}）。请检查电脑接收箱后手动重试。`); error.status = xhr.status; reject(error); }
      };
      xhr.onerror = () => reject(new Error('上传连接中断，结果尚未确认。请先检查电脑接收箱，再手动重试，以免重复。'));
      xhr.ontimeout = () => reject(new Error('上传超过 120 秒，结果尚未确认。不会自动重发，请先检查电脑接收箱，再手动重试。'));
      xhr.onabort = () => reject(new Error('上传已中止。请检查电脑接收箱后决定是否重试。'));
      const body = new FormData(); files.forEach(file => { const data = file.type.startsWith('image/') ? file : new Blob([file], { type: /\.heif$/i.test(file.name) ? 'image/heif' : 'image/heic' }); body.append('files', data, file.name); }); xhr.send(body);
    });
  }
  $('send-images').addEventListener('click', async () => {
    if (!connected || uploading || !selected.length) return;
    try { validateSelection(selected); } catch (error) { message('upload-message', error.message, true); return; }
    uploading = true; controls(); message('upload-message', ''); show($('upload-progress'), true); $('progress-bar').style.width = '0%'; $('progress-label').textContent = '准备上传…'; $('send-images').textContent = '正在发送…';
    try { const data = await upload(selected); message('upload-message', `${data.items.length} 张图片已送达。请在电脑端下载保存。`); $('progress-bar').style.width = '100%'; $('progress-label').textContent = '电脑已确认接收'; selected = []; $('image-files').value = ''; renderSelection(); }
    catch (error) { $('progress-label').textContent = '上传未确认 · 请先检查电脑接收箱'; handleError(error, 'upload-message'); }
    finally { uploading = false; $('send-images').textContent = selected.length ? '手动重试 ↗' : '发送图片 ↗'; controls(); }
  });
  $('disconnect').addEventListener('click', async () => {
    if (!confirm('断开与电脑的连接？再次发送需要重新扫码配对。')) return;
    $('disconnect').disabled = true;
    try { await api('/api/sender/disconnect', { method: 'POST' }); connected = false; saveToken(''); status('已主动断开', '需要继续发送时，请在电脑上重新配对。'); message('sender-error', ''); }
    catch (error) { handleError(error); } finally { controls(); }
  });
  async function check() {
    if (!token || checking) return; checking = true;
    try { const data = await (await api('/api/sender', {}, 10000)).json(); if (!data.connected) { expire(new Error('电脑会话已断开。')); return; } connected = true; status('已连接到电脑', '内容仅通过当前局域网传输。', 'connected'); message('sender-error', ''); controls(); }
    catch (error) { if (error.status === 401 || error.status === 410) expire(error); else { status('连接暂时不稳定', '已保留当前内容，正在检查连接。'); message('sender-error', '暂时无法连接电脑。发送前请确认接收页面仍开启。', true); } }
    finally { checking = false; }
  }
  function parseCode() {
    if (!fragment) return '';
    // Accept the contract's #credential and a conventional #code=credential.
    if (fragment.startsWith('code=')) return new URLSearchParams(fragment).get('code') || '';
    try { return decodeURIComponent(fragment); } catch { throw new Error('配对链接格式不正确，请重新扫码。'); }
  }
  async function init() {
    let code;
    try { code = parseCode(); } catch (error) { expire(error); return; }
    if (code) saveToken('');
    else { try { token = sessionStorage.getItem(storageKey) || ''; } catch { token = ''; } }
    try {
      // Configuration is public and restores limits on same-tab refresh.
      const config = await (await api('/api/config')).json(); $('sender-idle').textContent = config.idleMinutes || 30;
      if (config.limits) setLimits(config.limits);
      if (code) {
        const data = await (await api('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
        if (!data.senderToken) throw new Error('服务未返回发送凭证，请重新扫码。');
        setLimits(data.limits || config.limits); saveToken(data.senderToken); connected = true; status('已连接到电脑', '内容仅通过当前局域网传输。', 'connected'); controls();
      } else if (token) await check();
      else { status('等待扫描配对二维码', '请在电脑接收页生成二维码，再用手机扫描。'); message('sender-error', '此页面没有可用的配对凭证。请从电脑页面重新扫码。', true); }
    } catch (error) { handleError(error); if (!connected) status('暂时无法连接', '请检查网络，或在电脑上重新配对后扫码。', 'expired'); }
    controls();
  }
  window.addEventListener('beforeunload', event => { if (uploading || sendingText) { event.preventDefault(); event.returnValue = ''; } });
  setInterval(check, 6000); init();
})();
