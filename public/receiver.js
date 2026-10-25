(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let token = '', config = null, pairUrl = '', expired = false, polling = false, generation = 0, pollGeneration = 0, hasImages = false, wasPaired = false;
  const cards = new Map();
  const blobs = new Map();
  let toastTimer, initializing = true, creating = false, ending = false, retryAt = 0, retryTimer, retryPublicUrl = '';
  const archiveUrls = new Set();
  function updateCreateControls() {
    const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    $('create-button').disabled = creating || ending || seconds > 0;
    $('new-session').disabled = creating || ending;
    $('retry-create').disabled = creating || ending || seconds > 0;
    $('retry-create').textContent = seconds ? `${seconds} 秒后可手动重试` : '重试创建会话';
    if (!seconds) { clearInterval(retryTimer); retryTimer = null; }
  }
  function sessionControls() {
    show($('end-session'), Boolean(token) && !expired);
    $('end-session').disabled = ending;
    $('end-session').textContent = ending ? '正在结束会话…' : '结束会话';
    $('repair-button').disabled = ending || expired;
    $('disconnect-button').disabled = ending || expired;
    $('download-all').disabled = ending || expired || !hasImages;
    $('clear-items').disabled = ending || expired || !cards.size;
    for (const control of $('items').querySelectorAll('button')) control.disabled = ending || expired;
  }
  const sessionKey = 'lan-drop-receiver';
  function rememberSession(value) { try { if (value) sessionStorage.setItem(sessionKey, value); else sessionStorage.removeItem(sessionKey); } catch {} }
  function savedSession() { try { return sessionStorage.getItem(sessionKey) || ''; } catch { return ''; } }
  function show(el, visible) { el.classList.toggle('hidden', !visible); }
  function notice(id, message, error = false) { const el = $(id); el.textContent = message; el.classList.toggle('error', error); show(el, Boolean(message)); }
  function toast(message) { $('toast').textContent = message; show($('toast'), true); clearTimeout(toastTimer); toastTimer = setTimeout(() => show($('toast'), false), 3500); }
  function bytes(value) { if (!value) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const i = Math.min(3, Math.floor(Math.log(value) / Math.log(1000))); return `${(value / 1000 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }
  async function api(path, options = {}, timeout = 15000) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) { const data = await response.json().catch(() => ({})); const error = new Error(data.error || `请求失败（${response.status}）`); error.status = response.status; error.retryAfterSeconds = data.retryAfterSeconds; throw error; }
      // Consume the body before clearing the timeout: headers alone are not a completed download.
      const body = response.status === 204 ? null : await response.blob();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { if (error.name === 'AbortError') throw new Error('请求超时，请检查网络后重试。'); throw error; }
    finally { clearTimeout(timer); }
  }
  function state(label, kind = '') { $('connection-label').textContent = label; $('connection-state').className = `status ${kind}`; }
  function expire(error) {
    expired = true; token = ''; rememberSession(''); generation++; sessionControls();
    state('会话已失效', 'expired'); notice('connection-error', `${error.message}。请创建新会话。`, true);
    pairUrl = ''; $('pair-link').value = '';
    show($('pair-panel'), false); show($('paired-panel'), false); show($('disconnect-button'), false); show($('repair-button'), false); show($('new-session'), true);
    $('download-all').disabled = true; $('clear-items').disabled = true;
    for (const button of $('items').querySelectorAll('button')) button.disabled = true;
  }
  function handleError(error, target = 'inbox-notice') { if (error.status === 401 || error.status === 410) expire(error); else notice(target, error.message || '网络暂不可用，请稍后重试。', true); }
  function validateUrl(value) {
    let url; try { url = new URL(value); } catch { throw new Error('请输入完整地址，例如 http://192.168.1.8:9100'); }
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('请使用不带路径、账号或参数的 HTTP 地址。');
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname) || ['[::1]', '0.0.0.0', '[::]'].includes(hostname)) throw new Error('localhost / 回环地址仅此电脑可访问，请输入 Windows 局域网 IP。');
    return url.origin;
  }
  function releaseItems() {
    for (const entry of blobs.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    for (const url of archiveUrls) URL.revokeObjectURL(url);
    archiveUrls.clear(); blobs.clear(); cards.clear(); $('items').replaceChildren();
  }
  function setPair(value) {
    const url = new URL(value, location.origin);
    if (url.protocol !== 'http:') throw new Error('服务返回了无效配对链接。');
    pairUrl = url.href; $('pair-link').value = pairUrl; show($('qr-failure'), false); show($('qr-image'), true);
    $('qr-image').src = `/api/qr?url=${encodeURIComponent(pairUrl)}`; show($('pair-panel'), true); show($('paired-panel'), false);
  }
  async function create(publicUrl) {
    if (creating || ending || token || Date.now() < retryAt) return;
    creating = true; retryPublicUrl = publicUrl; updateCreateControls(); notice('connection-error', '');
    try {
      const response = await api('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicUrl }) });
      const data = await response.json();
      if (!data.id || !data.receiverToken || !data.pairUrl) throw new Error('服务返回的会话信息不完整。');
      generation++; releaseItems(); token = data.receiverToken; rememberSession(token); expired = false; wasPaired = false; hasImages = false;
      retryAt = 0; clearInterval(retryTimer); retryTimer = null; show($('retry-create'), false);
      setPair(data.pairUrl); state('等待手机扫码连接'); show($('setup-form'), false); show($('new-session'), false); show($('repair-button'), true); sessionControls();
      notice('inbox-notice', ''); await poll();
    } catch (error) {
      if (error.status === 429) {
        const delay = Number(error.retryAfterSeconds);
        const seconds = Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : 30;
        retryAt = Date.now() + seconds * 1000;
        notice('connection-error', `${error.message} 请等待 ${seconds} 秒后手动重试；不会自动创建会话。`, true);
        clearInterval(retryTimer); retryTimer = setInterval(updateCreateControls, 1000);
      } else handleError(error, 'connection-error');
      if (!token) { show($('setup-form'), true); show($('retry-create'), true); state('创建失败，请查看下方提示', 'expired'); }
    } finally { creating = false; updateCreateControls(); }
  }
  async function endSession() {
    if (!token || expired || ending || creating) return;
    if (!confirm('结束会话将删除所有尚未保存的文字和图片，并断开手机。此操作无法恢复，请先下载需要的内容。确定结束吗？')) return;
    ending = true; const current = generation; pollGeneration++; sessionControls(); updateCreateControls();
    try {
      await api('/api/session', { method: 'DELETE' });
      if (current !== generation) return;
      generation++; token = ''; rememberSession(''); expired = false; pairUrl = ''; wasPaired = false; hasImages = false;
      releaseItems(); $('pair-link').value = ''; $('qr-image').removeAttribute('src');
      $('item-count').textContent = '0'; $('usage').textContent = '等待第一份灵感抵达';
      show($('empty-state'), true);
      for (const id of ['pair-panel', 'paired-panel', 'disconnect-button', 'repair-button', 'setup-form', 'retry-create']) show($(id), false);
      show($('new-session'), true); notice('inbox-notice', ''); notice('connection-error', '');
      state('会话已结束，可创建新会话'); toast('会话已结束，手机已断开。');
    } catch (error) {
      if (current !== generation) return;
      if (error.status === 409) notice('connection-error', '会话正在上传或打包，请等待操作完成后再结束。已接收内容和连接保持不变。', true);
      else handleError(error, 'connection-error');
    } finally { ending = false; sessionControls(); updateCreateControls(); }
  }
  async function copy(text, fallback) {
    try { if (!navigator.clipboard || !window.isSecureContext) throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(text); toast('已复制'); }
    catch {
      if (fallback instanceof HTMLInputElement) { fallback.focus(); fallback.select(); }
      else { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(fallback); selection.removeAllRanges(); selection.addRange(range); }
      toast('内容已选中，请按 Ctrl+C 或长按复制。');
    }
  }
  function textContentWithLinks(element, text) {
    const pattern = /https?:\/\/[^\s<>"'`]+/gi; let end = 0;
    for (const match of text.matchAll(pattern)) {
      element.append(document.createTextNode(text.slice(end, match.index)));
      try { const url = new URL(match[0]); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); const a = document.createElement('a'); a.href = url.href; a.textContent = match[0]; a.target = '_blank'; a.rel = 'noopener noreferrer'; element.append(a); }
      catch { element.append(document.createTextNode(match[0])); }
      end = match.index + match[0].length;
    }
    element.append(document.createTextNode(text.slice(end)));
  }
  function button(label, action) { const el = document.createElement('button'); el.type = 'button'; el.className = 'text-button'; el.textContent = label; el.addEventListener('click', action); return el; }
  async function loadBlob(item) {
    if (blobs.has(item.id)) return blobs.get(item.id).promise;
    const current = generation; const entry = {};
    entry.promise = (async () => {
      if (ending || expired || !token) throw new Error('会话正在结束或已失效。');
      const response = await api(`/api/files/${encodeURIComponent(item.id)}`, {}, 120000);
      const raw = await response.blob();
      const mime = typeof item.mime === 'string' && /^image\/[a-z0-9.+-]+$/i.test(item.mime) ? item.mime : 'application/octet-stream';
      const blob = new Blob([raw], { type: mime });
      if (current !== generation || !blobs.has(item.id)) throw new Error('会话内容已更新，请重新操作。');
      entry.url = URL.createObjectURL(blob); return entry.url;
    })().catch(error => { if (blobs.get(item.id) === entry) blobs.delete(item.id); throw error; });
    blobs.set(item.id, entry); return entry.promise;
  }
  function download(url, name) { const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); }
  function renderItem(item) {
    const card = document.createElement('article'); card.className = 'item';
    const body = document.createElement('div'); body.className = 'item-body';
    const meta = document.createElement('div'); meta.className = 'item-meta';
    const kind = document.createElement('span'); kind.className = 'item-kind'; kind.textContent = item.type === 'text' ? '文字 / 链接' : '图片';
    const time = document.createElement('time'); const date = new Date(item.createdAt); time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    meta.append(kind, time); body.append(meta); card.append(body);
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
        const image = new Image(); image.className = 'item-image'; image.alt = item.name || '接收的图片';
        image.onload = () => placeholder.replaceWith(image);
        image.onerror = () => { placeholder.textContent = '此浏览器暂不支持预览此格式（如 HEIC），仍可下载原图。'; };
        image.src = url;
      }).catch(error => { if (current !== generation || ending) return; placeholder.textContent = '预览加载失败，仍可点击下载重试。'; if (error.status === 401 || error.status === 410) expire(error); });
      actions.append(button('下载原图', async event => {
        if (ending || expired || !token) return;
        const current = generation, control = event.currentTarget; control.disabled = true;
        try { const url = await loadBlob(item); if (current !== generation || ending) return; download(url, item.name || `image-${item.id}`); toast('已开始下载，请确认浏览器保存位置。'); }
        catch (error) { if (current === generation && !ending) handleError(error); } finally { if (current === generation) control.disabled = expired || ending; }
      }));
    }
    footer.append(name, actions); card.append(footer); return card;
  }
  function render(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    const keep = new Set(items.map(item => item.id));
    for (const [id, card] of cards) if (!keep.has(id)) { card.remove(); cards.delete(id); const blob = blobs.get(id); if (blob && blob.url) URL.revokeObjectURL(blob.url); blobs.delete(id); }
    for (const item of items) {
      if (!cards.has(item.id)) { const card = renderItem(item); cards.set(item.id, card); $('items').append(card); }
    }
    $('item-count').textContent = items.length;
    $('usage').textContent = items.length ? `${items.length} 项内容 · 已使用 ${bytes(data.usedBytes)}${config && config.limits ? ` / ${bytes(config.limits.sessionBytes)}` : ''}` : '等待第一份灵感抵达';
    hasImages = items.some(item => item.type === 'image');
    show($('empty-state'), items.length === 0); $('download-all').disabled = !hasImages; $('clear-items').disabled = !items.length;
    if (wasPaired && !data.paired) { pairUrl = ''; $('pair-link').value = ''; }
    wasPaired = Boolean(data.paired);
    state(data.paired ? '手机已连接 · 可以开始发送' : pairUrl ? '等待手机扫码连接' : '手机已断开，请重新配对', data.paired ? 'connected' : '');
    show($('disconnect-button'), Boolean(data.paired));
    show($('pair-panel'), !data.paired && Boolean(pairUrl)); show($('paired-panel'), Boolean(data.paired));
  }
  async function poll() {
    if (!token || expired || polling || ending || initializing) return;
    polling = true; const current = generation, epoch = pollGeneration;
    try { const response = await api('/api/session', {}, 10000); const data = await response.json(); if (current !== generation || epoch !== pollGeneration || ending) return; render(data); notice('inbox-notice', ''); }
    catch (error) { if (current !== generation || epoch !== pollGeneration || ending) return; if (error.status === 401 || error.status === 410) expire(error); else notice('inbox-notice', '连接暂时中断，正在重试。已接收内容仍保留在这里。', true); }
    finally { polling = false; }
  }
  $('setup-form').addEventListener('submit', event => { event.preventDefault(); try { create(validateUrl($('public-url').value.trim())); } catch (error) { notice('connection-error', error.message, true); } });
  $('new-session').addEventListener('click', () => { if (creating || ending || token) return; expired = false; generation++; show($('new-session'), false); show($('setup-form'), true); state('填写地址后重新创建会话'); });
  $('end-session').addEventListener('click', endSession);
  $('retry-create').addEventListener('click', () => { try { create(validateUrl($('public-url').value.trim() || retryPublicUrl)); } catch (error) { notice('connection-error', error.message, true); } });
  $('copy-link').addEventListener('click', () => copy(pairUrl, $('pair-link')));
  $('qr-image').addEventListener('error', () => { show($('qr-image'), false); show($('qr-failure'), true); });
  $('disconnect-button').addEventListener('click', async () => {
    if (!confirm('断开当前手机？已接收内容会保留，再次连接需要重新配对。')) return;
    if (ending || !token || expired) return;
    const current = generation; pollGeneration++; $('disconnect-button').disabled = true;
    try {
      await api('/api/disconnect', { method: 'POST' }); if (current !== generation || ending) return; pairUrl = ''; $('pair-link').value = ''; wasPaired = false;
      show($('pair-panel'), false); show($('paired-panel'), false); show($('disconnect-button'), false);
      state('手机已断开，请重新配对'); notice('connection-error', '');
    } catch (error) { if (current === generation && !ending) handleError(error, 'connection-error'); }
    finally { if (current === generation) $('disconnect-button').disabled = ending || expired; }
  });
  $('repair-button').addEventListener('click', async () => {
    if (!confirm('将断开当前手机，并使旧配对链接失效。已接收内容不受影响。继续吗？')) return;
    if (ending || !token || expired) return;
    const current = generation; pollGeneration++; $('repair-button').disabled = true;
    try { const response = await api('/api/repair', { method: 'POST' }); const data = await response.json(); if (current !== generation || ending) return; wasPaired = false; setPair(data.pairUrl); show($('disconnect-button'), false); state('等待手机重新扫码连接'); notice('connection-error', ''); }
    catch (error) { if (current === generation && !ending) handleError(error, 'connection-error'); } finally { if (current === generation) $('repair-button').disabled = ending || expired; }
  });
  $('clear-items').addEventListener('click', async () => {
    if (!confirm('清空接收箱？尚未下载的内容将无法恢复。')) return;
    if (ending || expired || !token) return;
    const current = generation; $('clear-items').disabled = true; pollGeneration++;
    try { await api('/api/items', { method: 'DELETE' }); if (current !== generation || ending) return; await poll(); if (current === generation && !ending) toast('接收箱已清空'); }
    catch (error) { if (current === generation && !ending) handleError(error); } finally { if (current === generation) $('clear-items').disabled = ending || expired || !cards.size; }
  });
  $('download-all').addEventListener('click', async () => {
    if (ending || expired || !token) return;
    const current = generation; $('download-all').disabled = true;
    try {
      const response = await api('/api/archive', {}, 120000); const blob = await response.blob();
      if (current !== generation || ending) return;
      const url = URL.createObjectURL(blob); archiveUrls.add(url); download(url, `LAN-Drop-${new Date().toISOString().slice(0, 10)}.zip`);
      setTimeout(() => { if (archiveUrls.delete(url)) URL.revokeObjectURL(url); }, 60000); toast('已开始下载 ZIP，请确认浏览器保存位置。');
    } catch (error) { if (current === generation && !ending) handleError(error); } finally { if (current === generation) $('download-all').disabled = ending || expired || !hasImages; }
  });
  async function init() {
    try {
      config = await (await api('/api/config')).json(); $('idle-note').textContent = `关闭空会话页面约 ${Math.ceil((config.receiverGraceSeconds || 120) / 60)} 分钟后释放；有内容请显式结束，或等待闲置 ${config.idleMinutes || 30} 分钟自动清理。刷新不会主动删除会话。`;
      if (config.publicUrl) $('public-url').value = config.publicUrl;
      token = savedSession();
      if (token) {
        try {
          const data = await (await api('/api/session')).json();
          if (!data.paired && !data.pairUrl) data.pairUrl = (await (await api('/api/repair', { method: 'POST' })).json()).pairUrl;
          if (data.pairUrl) setPair(data.pairUrl);
          render(data); show($('setup-form'), false); show($('repair-button'), true); sessionControls(); return;
        } catch (error) {
          if (error.status !== 401 && error.status !== 410) throw error;
          token = ''; rememberSession('');
        }
      }
      if (config.publicUrl) { await create(validateUrl(config.publicUrl)); }
      else { show($('setup-form'), true); state('输入电脑地址，开始接收'); }
    } catch (error) { state('需要设置连接地址'); show($('setup-form'), true); notice('connection-error', error.message, true); }
    finally { initializing = false; sessionControls(); }
  }
  // Polls are the receiver heartbeat. Never delete on unload/pagehide: refresh and backgrounding must retain content.
  setInterval(poll, 2000); init();
})();
