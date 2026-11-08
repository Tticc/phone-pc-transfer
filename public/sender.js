(() => {
  'use strict';
  // Credentials in the fragment are never sent to the server or left in history.
  const fragment = location.hash.slice(1);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const $ = id => document.getElementById(id);
  const storageKey = 'phone-pc-transfer-sender-token';
  const legacyStorageKey = 'lan-drop-sender-token';
  let token = '', limits = null, connected = false, sendingText = false, uploading = false, checking = false, polling = false, selected = [], toastTimer, generation = 0;
  const cards = new Map();
  const blobs = new Map();
  const archiveUrls = new Set();

  function show(el, value) { el.classList.toggle('hidden', !value); }
  function message(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); show($(id), Boolean(text)); }
  function toast(text) { $('toast').textContent = text; show($('toast'), true); clearTimeout(toastTimer); toastTimer = setTimeout(() => show($('toast'), false), 4000); }
  function bytes(value) { if (!value) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const i = Math.min(3, Math.floor(Math.log(value) / Math.log(1000))); return `${(value / 1000 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }

  function saveToken(value) {
    token = value;
    try {
      if (value) {
        sessionStorage.setItem(storageKey, value);
      } else {
        sessionStorage.removeItem(storageKey);
        sessionStorage.removeItem(legacyStorageKey);
      }
    } catch { /* Memory-only operation remains available when storage is disabled. */ }
  }

  function releaseItems() {
    for (const entry of blobs.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    for (const url of archiveUrls) URL.revokeObjectURL(url);
    archiveUrls.clear(); blobs.clear(); cards.clear(); $('sender-items').replaceChildren();
    $('sender-item-count').textContent = '0';
    $('sender-usage').textContent = '电脑与手机发送的内容会同步在此';
    show($('sender-items-empty'), true);
    show($('sender-download-all'), false);
  }

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
    connected = false; saveToken(''); generation++; releaseItems();
    status('连接已失效', '请在电脑上重新配对，再扫描新的二维码。', 'expired');
    message('sender-error', error.message || '当前凭证已过期。', true);
    controls();
  }

  async function api(path, options = {}, timeout = 15000) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) { const body = await response.json().catch(() => ({})); const error = new Error(body.error || `请求失败（${response.status}）`); error.status = response.status; throw error; }
      // Keep the deadline active until the response body is fully received.
      const body = response.status === 204 ? null : await response.blob();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { if (error.name === 'AbortError') throw new Error('请求超时，请检查网络后重试。'); throw error; }
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

  async function copy(text, fallback) {
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error();
      await navigator.clipboard.writeText(text); toast('已复制文字');
    } catch {
      const selection = window.getSelection(); const range = document.createRange();
      range.selectNodeContents(fallback); selection.removeAllRanges(); selection.addRange(range);
      toast('文字已选中，请长按复制。');
    }
  }

  function textContentWithLinks(element, text) {
    const pattern = /https?:\/\/[^\s<>"'`]+/gi; let end = 0;
    for (const match of text.matchAll(pattern)) {
      element.append(document.createTextNode(text.slice(end, match.index)));
      try {
        const url = new URL(match[0]);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        const a = document.createElement('a'); a.href = url.href; a.textContent = match[0]; a.target = '_blank'; a.rel = 'noopener noreferrer'; element.append(a);
      } catch { element.append(document.createTextNode(match[0])); }
      end = match.index + match[0].length;
    }
    element.append(document.createTextNode(text.slice(end)));
  }

  async function loadBlob(item) {
    if (blobs.has(item.id)) return blobs.get(item.id).promise;
    const current = generation; const entry = {};
    entry.promise = (async () => {
      if (!connected || !token) throw new Error('连接已断开');
      const response = await api(`/api/files/${encodeURIComponent(item.id)}`, {}, 120000);
      const raw = await response.blob();
      const mime = typeof item.mime === 'string' && /^image\/[a-z0-9.+-]+$/i.test(item.mime) ? item.mime : 'application/octet-stream';
      const blob = new Blob([raw], { type: mime });
      if (current !== generation || !blobs.has(item.id)) throw new Error('内容已更新');
      entry.url = URL.createObjectURL(blob); return entry.url;
    })().catch(err => { if (blobs.get(item.id) === entry) blobs.delete(item.id); throw err; });
    blobs.set(item.id, entry); return entry.promise;
  }

  function download(url, name) {
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.target = '_blank';
    document.body.append(anchor); anchor.click(); anchor.remove();
  }

  function button(label, action) {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'text-button'; el.textContent = label; el.addEventListener('click', action); return el;
  }

  function renderItem(item) {
    const card = document.createElement('article'); card.className = 'item';
    const body = document.createElement('div'); body.className = 'item-body';
    const meta = document.createElement('div'); meta.className = 'item-meta';
    const tag = document.createElement('span');
    const isPc = item.sender === 'pc';
    tag.className = `sender-tag ${isPc ? 'tag-pc' : 'tag-phone'}`;
    tag.textContent = isPc ? '电脑发送' : '手机发送';
    const kind = document.createElement('span'); kind.className = 'item-kind'; kind.textContent = item.type === 'text' ? '文字 / 链接' : '图片';
    const time = document.createElement('time'); const date = new Date(item.createdAt); time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    meta.append(tag, kind, time); body.append(meta); card.append(body);
    const footer = document.createElement('div'); footer.className = 'item-footer';
    const name = document.createElement('span'); name.className = 'item-name';
    const actions = document.createElement('div'); actions.className = 'item-actions';
    if (item.type === 'text') {
      const content = document.createElement('div'); content.className = 'item-text'; textContentWithLinks(content, String(item.text || '')); body.append(content);
      name.textContent = `${[...String(item.text || '')].length.toLocaleString()} 字符`;
      actions.append(button('复制文字', () => copy(String(item.text || ''), content)));
    } else {
      name.textContent = `${item.name || '图片'} · ${bytes(item.size)}`; name.title = item.name || '图片';
      const placeholder = document.createElement('div'); placeholder.className = 'image-fallback'; placeholder.textContent = '正在加载图片…'; body.append(placeholder);
      const current = generation;
      loadBlob(item).then(url => {
        if (current !== generation || !card.isConnected) return;
        const img = new Image(); img.className = 'item-image'; img.alt = item.name || '图片';
        img.onload = () => placeholder.replaceWith(img);
        img.onerror = () => { placeholder.textContent = '此格式无法直接预览（如 HEIC），仍可下载原图。'; };
        img.src = url;
      }).catch(() => { if (current !== generation) return; placeholder.textContent = '预览加载失败，可点击下载原图。'; });
      actions.append(button('下载原图', async event => {
        if (!connected || !token) return;
        const control = event.currentTarget; control.disabled = true;
        try {
          const url = await loadBlob(item);
          download(url, item.name || `image-${item.id}`);
          toast('已开始下载图片');
        } catch (e) { handleError(e); }
        finally { control.disabled = false; }
      }));
    }
    footer.append(name, actions); card.append(footer); return card;
  }

  async function pollSession() {
    if (!token || !connected || polling) return;
    polling = true; const current = generation;
    try {
      const res = await api('/api/session', {}, 10000);
      const data = await res.json();
      if (current !== generation) return;
      const items = Array.isArray(data.items) ? data.items : [];
      const keep = new Set(items.map(i => i.id));
      for (const [id, card] of cards) {
        if (!keep.has(id)) { card.remove(); cards.delete(id); const b = blobs.get(id); if (b && b.url) URL.revokeObjectURL(b.url); blobs.delete(id); }
      }
      for (const item of items) {
        if (!cards.has(item.id)) { const card = renderItem(item); cards.set(item.id, card); $('sender-items').append(card); }
      }
      $('sender-item-count').textContent = items.length;
      $('sender-usage').textContent = items.length ? `${items.length} 项内容 · 已使用 ${bytes(data.usedBytes)}${limits ? ` / ${bytes(limits.sessionBytes)}` : ''}` : '电脑与手机发送的内容会同步在此';
      show($('sender-items-empty'), items.length === 0);
      const hasImages = items.some(i => i.type === 'image');
      show($('sender-download-all'), hasImages);
    } catch (err) {
      if (current !== generation) return;
      if (err.status === 401 || err.status === 410) expire(err);
    } finally {
      polling = false;
    }
  }

  $('text-input').addEventListener('input', updateText);
  $('text-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!connected || sendingText || !limits) return;
    const text = $('text-input').value;
    if (!text.trim()) return;
    if ([...text].length > limits.textChars) { message('sender-error', `文字超过 ${limits.textChars} 字符限制。`, true); return; }
    sendingText = true; controls(); message('sender-error', ''); $('send-text').textContent = '正在发送…';
    try {
      await api('/api/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }, 20000);
      $('text-input').value = ''; updateText(); toast('文字已发送'); await pollSession();
    } catch (error) { handleError(error); }
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
        if (event.lengthComputable) { const percent = Math.min(100, Math.round(event.loaded / event.total * 100)); $('progress-bar').style.width = `${percent}%`; $('progress-label').textContent = percent === 100 ? '上传完成，处理中…' : `正在上传 ${percent}% · ${bytes(event.loaded)} / ${bytes(event.total)}`; }
        else $('progress-label').textContent = `正在上传 · 已发送 ${bytes(event.loaded)}`;
      };
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* Non-JSON failures still receive an actionable message. */ }
        if (xhr.status >= 200 && xhr.status < 300) { if (!Array.isArray(data.items)) { reject(new Error('服务器响应不完整，发送结果尚未确认。')); return; } resolve(data); }
        else { const error = new Error(data.error || `上传失败（${xhr.status}）。请检查列表后手动重试。`); error.status = xhr.status; reject(error); }
      };
      xhr.onerror = () => reject(new Error('上传连接中断，结果尚未确认。请先检查列表，再手动重试。'));
      xhr.ontimeout = () => reject(new Error('上传超过 120 秒，结果尚未确认。'));
      xhr.onabort = () => reject(new Error('上传已中止。'));
      const body = new FormData(); files.forEach(file => { const data = file.type.startsWith('image/') ? file : new Blob([file], { type: /\.heif$/i.test(file.name) ? 'image/heif' : 'image/heic' }); body.append('files', data, file.name); }); xhr.send(body);
    });
  }

  $('send-images').addEventListener('click', async () => {
    if (!connected || uploading || !selected.length) return;
    try { validateSelection(selected); } catch (error) { message('upload-message', error.message, true); return; }
    uploading = true; controls(); message('upload-message', ''); show($('upload-progress'), true); $('progress-bar').style.width = '0%'; $('progress-label').textContent = '准备上传…'; $('send-images').textContent = '正在发送…';
    try {
      const data = await upload(selected); message('upload-message', `${data.items.length} 张图片已发送。`); $('progress-bar').style.width = '100%'; $('progress-label').textContent = '发送完成'; selected = []; $('image-files').value = ''; renderSelection();
      await pollSession();
    } catch (error) { $('progress-label').textContent = '上传未确认 · 请检查列表'; handleError(error, 'upload-message'); }
    finally { uploading = false; $('send-images').textContent = selected.length ? '手动重试 ↗' : '发送图片 ↗'; controls(); }
  });

  $('sender-download-all').addEventListener('click', async () => {
    if (!token || !connected) return;
    const btn = $('sender-download-all'); btn.disabled = true;
    try {
      const res = await api('/api/archive', {}, 120000); const blob = await res.blob();
      const url = URL.createObjectURL(blob); archiveUrls.add(url);
      download(url, `Phone-PC-Transfer-${new Date().toISOString().slice(0, 10)}.zip`);
      setTimeout(() => { if (archiveUrls.delete(url)) URL.revokeObjectURL(url); }, 60000);
      toast('已开始下载 ZIP 压缩包');
    } catch (e) { handleError(e); }
    finally { btn.disabled = false; }
  });

  $('disconnect').addEventListener('click', async () => {
    if (!confirm('断开与电脑的连接？再次发送需要重新扫码配对。')) return;
    $('disconnect').disabled = true;
    try { await api('/api/sender/disconnect', { method: 'POST' }); connected = false; saveToken(''); generation++; releaseItems(); status('已主动断开', '需要继续发送时，请在电脑上重新配对。'); message('sender-error', ''); }
    catch (error) { handleError(error); } finally { controls(); }
  });

  async function check() {
    if (!token || checking) return; checking = true;
    try {
      const data = await (await api('/api/sender', {}, 10000)).json();
      if (!data.connected) { expire(new Error('电脑会话已断开。')); return; }
      connected = true; status('已连接到电脑', '内容仅通过当前局域网传输。', 'connected'); message('sender-error', ''); controls();
      await pollSession();
    } catch (error) {
      if (error.status === 401 || error.status === 410) expire(error);
      else { status('连接暂时不稳定', '已保留当前内容，正在重试。'); message('sender-error', '暂时无法连接电脑。请确认电脑页面开启。', true); }
    } finally { checking = false; }
  }

  function parseCode() {
    if (!fragment) return '';
    if (fragment.startsWith('code=')) return new URLSearchParams(fragment).get('code') || '';
    try { return decodeURIComponent(fragment); } catch { throw new Error('配对链接格式不正确，请重新扫码。'); }
  }

  async function init() {
    let code;
    try { code = parseCode(); } catch (error) { expire(error); return; }
    if (code) saveToken('');
    else { try { token = sessionStorage.getItem(storageKey) || sessionStorage.getItem(legacyStorageKey) || ''; } catch { token = ''; } }
    try {
      const config = await (await api('/api/config')).json(); $('sender-idle').textContent = config.idleMinutes || 30;
      if (config.limits) setLimits(config.limits);
      if (code) {
        const data = await (await api('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })).json();
        if (!data.senderToken) throw new Error('服务未返回发送凭证，请重新扫码。');
        setLimits(data.limits || config.limits); saveToken(data.senderToken); connected = true; status('已连接到电脑', '内容仅通过当前局域网传输。', 'connected'); controls();
        await pollSession();
      } else if (token) await check();
      else { status('等待扫描配对二维码', '请在电脑接收页生成二维码，再用手机扫描。'); message('sender-error', '此页面没有可用的配对凭证。请从电脑页面重新扫码。', true); }
    } catch (error) { handleError(error); if (!connected) status('暂时无法连接', '请检查网络，或在电脑上重新配对后扫码。', 'expired'); }
    controls();
  }

  window.addEventListener('beforeunload', event => { if (uploading || sendingText) { event.preventDefault(); event.returnValue = ''; } });
  setInterval(check, 6000);
  setInterval(pollSession, 3000);
  init();
})();
