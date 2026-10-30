// Web Worker: runs sannycore (C++ -> WebAssembly) so compile/decompile works with no server.
// Files next to this script: sannycore.js + sannycore.wasm (build_wasm.sh) and sannydata.pack (pack_data.py).
'use strict';
const BASE = new URL('.', self.location.href).href;
let M = null, bootPromise = null, curMode = null;

async function boot(packUrl) {
  importScripts(BASE + 'sannycore.js');                                   // defines createSannyCore()
  M = await createSannyCore({ locateFile: (f) => BASE + f });
  const res = await fetch(packUrl || BASE + 'sannydata.pack');
  if (!res.ok) throw new Error('sannydata.pack not found (HTTP ' + res.status + ')');
  const buf = new Uint8Array(await res.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const magic = new TextDecoder().decode(buf.subarray(0, 5));
  if (magic !== 'SBPK1') throw new Error('sannydata.pack: bad format');
  const jl = dv.getUint32(6, true);
  const idx = JSON.parse(new TextDecoder().decode(buf.subarray(10, 10 + jl)));
  let pos = 10 + jl;
  M.FS.mkdir('/data');
  for (const f of idx.files) {
    const parts = f.p.split('/');
    let dir = '/data';
    for (let i = 0; i < parts.length - 1; i++) {
      dir += '/' + parts[i];
      try { M.FS.mkdir(dir); } catch (e) { /* exists */ }
    }
    M.FS.writeFile('/data/' + f.p, buf.subarray(pos, pos + f.s));
    pos += f.s;
  }
}
function ensureBoot(packUrl) { return bootPromise || (bootPromise = boot(packUrl).catch((e) => { bootPromise = null; throw e; })); }

function cstr(s) {                       // JS string -> malloc'd UTF-8 (caller frees)
  const n = M.lengthBytesUTF8(s) + 1, p = M._malloc(n);
  M.stringToUTF8(s, p, n);
  return p;
}
function str(p) { return p ? M.UTF8ToString(p) : ''; }
function useMode(mode) {
  if (curMode === mode) return true;
  const a = cstr('/data'), b = cstr(mode);
  const ok = M._sb_init(a, b);
  M._free(a); M._free(b);
  if (ok) curMode = mode;
  return !!ok;
}

const handlers = {
  async init(m) { await ensureBoot(m.packUrl); return {}; },

  async modes() {
    await ensureBoot();
    const d = cstr('/data'); const t = str(M._sb_list_modes(d)); M._free(d);
    return { text: t };
  },

  async compile(m) {
    await ensureBoot();
    if (!useMode(m.mode)) return { ok: false, error: str(M._sb_error()) || 'Invalid edit mode: ' + m.mode };
    M._sb_options(m.allowUnverified ? 1 : 0, m.strict ? 1 : 0);
    const s = cstr(m.source);
    const ok = M._sb_compile(s, m.addExtra ? 1 : 0, m.flags | 0);
    M._free(s);
    const error = str(M._sb_error()), kind = str(M._sb_kind());
    if (!ok) return { ok: false, error, kind };
    const bytes = M.HEAPU8.slice(M._sb_out_ptr(), M._sb_out_ptr() + M._sb_out_len());
    return { ok: true, bytes, kind, error, _t: [bytes.buffer] };
  },

  async decompile(m) {
    await ensureBoot();
    if (!useMode(m.mode)) return { ok: false, error: str(M._sb_error()) || 'Invalid edit mode: ' + m.mode };
    M._sb_options(m.allowUnverified ? 1 : 0, 0);
    const p = M._malloc(m.bytes.length || 1);
    M.HEAPU8.set(m.bytes, p);
    let embedded = '';
    if (m.useSource) { embedded = str(M._sb_embedded_source(p, m.bytes.length)); }
    if (embedded) { M._free(p); return { ok: true, text: embedded, kind: 'embedded', error: '' }; }
    const d = cstr(m.directive || '');
    const ok = M._sb_decompile(p, m.bytes.length, m.scriptStyle === false ? 0 : 1, d);
    M._free(p); M._free(d);
    const error = str(M._sb_error()), kind = str(M._sb_kind());
    return ok ? { ok: true, text: str(M._sb_text()), kind, error } : { ok: false, error, kind };
  },
};

self.onmessage = async (e) => {
  const m = e.data;
  try {
    const r = await handlers[m.type](m);
    const t = r._t; delete r._t;
    self.postMessage(Object.assign({ id: m.id, done: true }, r), t || []);
  } catch (err) {
    self.postMessage({ id: m.id, done: true, ok: false, fatal: true, error: String((err && err.message) || err) });
  }
};
