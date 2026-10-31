// Offline Mode UI + glue for index.html. Runs compile/decompile in offline-engine.js (sannycore WebAssembly worker).
(function () {
  'use strict';
  const KEY = 'cleo_offline_mode';
  const BASE = new URL('offline/', document.baseURI).href;
  const CACHE = 'cleo-offline-engine-v1';
  const FILES = ['offline-engine.js', 'sannycore.js', 'sannycore.wasm', 'sannydata.pack'];
  const $ = (id) => document.getElementById(id);

  // Google Analytics (GA4) events: only counts and the game id are sent, never any script content.
  function track(name, params) { try { if (typeof gtag === 'function') gtag('event', name, params || {}); } catch (e) { /* ignore */ } }
  const resultOf = (r) => r.ok ? 'success' : (/Invalid edit mode|9100|not initialised/.test(r.error || '') ? 'unsupported_game' : 'error');
  const net = () => (navigator.onLine ? 'online' : 'offline');

  let worker = null, seq = 0, bootOk = false;
  const pending = new Map();

  function getWorker() {
    if (worker) return worker;
    worker = new Worker(BASE + 'offline-engine.js');
    worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p.res(e.data); } };
    worker.onerror = (e) => { pending.forEach((p) => p.res({ ok: false, fatal: true, error: e.message || 'worker error' })); pending.clear(); worker = null; bootOk = false; };
    return worker;
  }
  function call(type, payload, transfer) {
    return new Promise((res) => { const id = ++seq; pending.set(id, { res }); getWorker().postMessage(Object.assign({ id, type }, payload), transfer || []); });
  }

  async function isInstalled() {
    try { for (const f of FILES) if (!(await caches.match(BASE + f))) return false; return true; } catch (e) { return false; }
  }
  async function install(onProgress) {
    const cache = await caches.open(CACHE);
    for (let i = 0; i < FILES.length; i++) {
      const url = BASE + FILES[i];
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error(FILES[i] + ' not found on server (HTTP ' + res.status + ')');
      const total = +res.headers.get('content-length') || 0;
      if (res.body && total) {
        const rd = res.body.getReader(); const chunks = []; let got = 0;
        for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); got += value.length; onProgress && onProgress(FILES[i], got, total); }
        await cache.put(url, new Response(new Blob(chunks), { headers: res.headers }));
      } else { await cache.put(url, res); onProgress && onProgress(FILES[i], 1, 1); }
    }
  }

  const isOn = () => localStorage.getItem(KEY) === '1';
  function setStatus(t, cls) { const s = $('offline-status'); if (s) { s.textContent = t; s.className = 'text-[11px] ' + (cls || 'text-gray-400'); } }

  async function refreshUI() {
    const inst = await isInstalled(), t = $('offline-toggle');
    if (t) { t.checked = isOn() && inst; }
    const b = $('offline-install-btn');
    if (b) b.textContent = inst ? '↻ Update offline engine' : '⬇ Download offline engine';
    setStatus(inst ? (isOn() ? '✅ Offline Mode ON — compile/decompile runs on your phone, no internet needed.' : 'Engine installed. Turn the switch on to use it.') : 'Engine not downloaded yet (one-time download, then works with no internet).', inst && isOn() ? 'text-good' : 'text-gray-400');
  }

  async function doInstall() {
    const b = $('offline-install-btn'); if (b) b.disabled = true;
    try {
      await install((f, g, t) => setStatus('Downloading ' + f + ' … ' + Math.round((g / t) * 100) + '%', 'text-amber'));
      setStatus('Starting engine…', 'text-amber');
      const r = await call('init', {});
      if (!r.ok && r.fatal) throw new Error(r.error);
      bootOk = true;
      track('offline_engine_install', { result: 'success' });
    } catch (e) { track('offline_engine_install', { result: 'fail' }); localStorage.setItem(KEY, '0'); setStatus('❌ ' + e.message, 'text-bad'); if (b) b.disabled = false; return false; }
    if (b) b.disabled = false;
    await refreshUI(); return true;
  }

  async function ready() {
    if (bootOk) return true;
    if (!(await isInstalled())) return false;
    const r = await call('init', {});
    bootOk = !!(r.ok || !r.fatal);
    if (!bootOk) log('Offline engine failed to start: ' + r.error, 'error');
    return bootOk;
  }

  function log(m, t) { try { logLine(escapeHtml(m), t || 'info'); } catch (e) { console.log(m); } }
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bytesToB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; };
  function showModal(text) { const m = $('compileModal'), s = $('modalStatusText'), c = $('cancelCompileBtn'); if (m) m.style.display = 'flex'; if (c) c.style.display = 'none'; if (s) s.innerText = text; }
  function hideModal(delay) { const m = $('compileModal'); setTimeout(() => { if (m) m.style.display = 'none'; }, delay || 0); }

  // Returns true when handled offline, false when the caller should use the server instead.
  async function tryCompile(ctx) {
    const { code, currentFilename, selectedGame, compilerConfig, startTime } = ctx;
    if (!(await ready())) return fallbackOrFail('Offline engine is not downloaded yet. Use "Download offline engine" above.');
    showModal('Compiling offline…');
    const compileBtn = $('compile-btn'), spinner = $('compile-spinner');
    compileBtn.disabled = true; spinner.classList.remove('hidden');
    log('Compiling offline (' + selectedGame + ', sannycore WASM)…', 'info');
    try {
      const r = await call('compile', { mode: selectedGame, source: code, addExtra: !!compilerConfig.addExtraInfo, flags: 0x1420 });
      track('offline_compile', { game: selectedGame, result: resultOf(r), ms: Date.now() - startTime, network: net() });
      if (!r.ok) {
        const unsupported = /Invalid edit mode|9100|not initialised/.test(r.error || '');
        if (unsupported && navigator.onLine) { hideModal(); log('Game "' + selectedGame + '" is not supported offline — using the server.', 'warn'); return false; }
        hideModal();
        const msg = (r.error || 'Offline compile failed.').trim();
        log(msg.split('\n')[0], 'error');
        const ln = /\(line (\d+)\)/.exec(msg); if (ln) setEditorErrorMarker(+ln[1], msg.split('\n')[0]);
        showErrorModal(msg, 'Offline engine (sannycore WASM)', false);
        return true;
      }
      if (r.error && r.error.trim()) log(r.error.trim(), 'warn');
      const ext = (/\{\$CLEO\s+\.?(\w+)\s*\}/i.exec(code) || [])[1];
      const filename = r.kind === 'main.scm' ? 'main.scm' : currentFilename.replace(/\.txt$/i, '') + '.' + (ext ? ext.toLowerCase() : 'cs');
      const bytes = r.bytes;
      clearEditorErrorMarkers();
      const cur = openTabs.find((t) => t.id === activeTabId); if (cur) cur.content = editor.getValue();
      const id = 'tab-' + Date.now();
      openTabs.push({ id, name: filename, content: latin1(bytes), fileBase64: bytesToB64(bytes), binary: true });
      switchTab(id); saveTabsToLocalStorage();
      const sec = ((Date.now() - startTime) / 1000).toFixed(1);
      log('Offline compile OK in ' + sec + 's — ' + filename + ' (' + bytes.length + ' bytes)', 'success');
      showModal('Done in ' + sec + 's!'); hideModal(700);
      const token = localStorage.getItem('gh_token'), repo = localStorage.getItem('gh_repo');
      if (token && repo) {
        const save = localStorage.getItem('gh_autosave') === 'true' || confirm('Auto-save is off. Do you want to save this compiled output to GitHub?');
        if (save) commitToGitHub(bytesToB64(bytes), filename, true, false);
      }
      return true;
    } finally { compileBtn.disabled = false; spinner.classList.add('hidden'); $('compile-btn-text').textContent = 'Compile'; }
  }

  async function tryDecompile(ctx) {
    const { fileName, base64Data, selectedGame, useSource, startTime } = ctx;
    if (!(await ready())) return fallbackOrFail('Offline engine is not downloaded yet. Use "Download offline engine" above.');
    showModal('Decompiling offline…');
    log('Decompiling offline (' + selectedGame + ', sannycore WASM)…', 'info');
    const m = /\.(csa|cs|csi)$/i.exec(fileName);
    const bytes = b64ToBytes(base64Data);
    const r = await call('decompile', { mode: selectedGame, bytes, useSource, scriptStyle: true, directive: m ? '.' + m[1].toLowerCase() : '' });
    track('offline_decompile', { game: selectedGame, result: resultOf(r), ms: Date.now() - startTime, network: net() });
    if (!r.ok) {
      const unsupported = /Invalid edit mode|9100|not initialised/.test(r.error || '');
      hideModal();
      if (unsupported && navigator.onLine) { log('Game "' + selectedGame + '" is not supported offline — using the server.', 'warn'); return false; }
      showErrorModal((r.error || 'Offline decompile failed.').trim(), 'Offline engine (sannycore WASM)', true); return true;
    }
    if (r.error && r.error.trim()) log(r.error.trim().split('\n').slice(0, 5).join(' | '), 'warn');
    const cur = openTabs.find((t) => t.id === activeTabId); if (cur && editor) cur.content = editor.getValue();
    const id = 'tab-' + Date.now();
    openTabs.push({ id, name: fileName.replace(/\.(cs|csa|csi|sc|scm)$/i, '.txt'), content: r.text });
    switchTab(id);
    const sec = ((Date.now() - startTime) / 1000).toFixed(1);
    log('Offline decompile OK in ' + sec + 's — ' + fileName + (r.kind === 'main.scm' ? ' (main.scm)' : ''), 'success');
    showModal('Done in ' + sec + 's!'); hideModal(700);
    return true;
  }

  function fallbackOrFail(msg) {
    if (navigator.onLine) { log(msg + ' Using the server instead.', 'warn'); return false; }
    alert('📴 ' + msg); log(msg, 'error'); return true;   // handled (nothing more to do)
  }

  window.OfflineMode = {
    isOn,
    // true: caller must stop (handled offline); false: continue with the server request
    async runCompile(ctx) { if (!isOn()) return false; return tryCompile(ctx); },
    async runDecompile(ctx) { if (!isOn()) return false; return tryDecompile(ctx); },
  };

  window.addEventListener('DOMContentLoaded', () => {
    const t = $('offline-toggle'), b = $('offline-install-btn');
    if (b) b.addEventListener('click', doInstall);
    if (t) t.addEventListener('change', async () => {
      if (t.checked && !(await isInstalled())) { t.checked = false; localStorage.setItem(KEY, '1'); await doInstall(); return; }
      localStorage.setItem(KEY, t.checked ? '1' : '0'); track('offline_mode_toggle', { enabled: t.checked ? 'on' : 'off' }); refreshUI();
    });
    refreshUI();
    // once per browser session: counts users who have Offline Mode switched on
    isInstalled().then((inst) => { if (inst && isOn() && !sessionStorage.getItem('offline_active_sent')) { sessionStorage.setItem('offline_active_sent', '1'); track('offline_mode_active', { network: net() }); } });
  });
})();
