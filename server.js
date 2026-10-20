#!/usr/bin/env node
// shooting-star: 의존성 없는 로컬 문서 관리 서버
// usage: ss [dir] [--port 4000] [--host 127.0.0.1] [--fg] [--no-open] [--last] [--stop]
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { exec, spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const flag = (n) => args.includes('--' + n) && args.splice(args.indexOf('--' + n), 1).length > 0;
const PORT = Number(opt('port', 4000));
const HOST = opt('host', '127.0.0.1');
const FG = flag('fg'), STOP = flag('stop'), LAST = flag('last'), NO_OPEN = flag('no-open');
const HOME = os.homedir();
const DEFAULT_ROOT = fs.realpathSync(path.resolve((args[0] || process.cwd()).replace(/^~(?=$|\/)/, HOME)));
const PUBLIC = path.join(__dirname, 'public');
const FAV_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'shooting-star', 'favorites.json');
const readFavs = () => { try { return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')).filter((x) => typeof x === 'string'); } catch { return []; } };
const SETTINGS_FILE = path.join(path.dirname(FAV_FILE), 'settings.json');
const readSettings = () => { try { const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; } };
const LAST_FILE = path.join(path.dirname(FAV_FILE), 'last.json'); // 마지막으로 연 워크스페이스
const readLast = () => { try { const r = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')).root; return isDirSafe(r) ? r : null; } catch { return null; } };
const MAX_SIZE = 5 * 1024 * 1024;
const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '.venv', '__pycache__']);
// 파일 검색에서만 제외하는 빌드/캐시 폴더 (트리에는 그대로 보임)
const SEARCH_IGNORE = new Set(['build', 'dist', 'target', 'out', '.gradle', '.idea', '.dart_tool', 'Pods', '.next', 'coverage', '.cache', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tox', 'venv', 'site-packages']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function isDirSafe(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// 요청 경로(상대)를 root 안의 절대경로로 변환. 밖으로 나가면 예외.
function resolveSafe(root, rel) {
  const abs = path.resolve(root, '.' + path.sep + (rel || ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw httpError(403, 'outside root');
  return abs;
}
// 요청별 워크스페이스 루트 (브라우저 탭마다 다른 폴더를 열 수 있음)
function rootOf(req, url) {
  const raw = req.headers['x-ss-root'] ? decodeURIComponent(req.headers['x-ss-root']) : url.searchParams.get('root');
  if (!raw) return DEFAULT_ROOT;
  if (!path.isAbsolute(raw)) throw httpError(400, 'root must be absolute');
  try {
    const r = fs.realpathSync(raw);
    if (!fs.statSync(r).isDirectory()) throw 0;
    return r;
  } catch { throw httpError(400, 'invalid root'); }
}
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_SIZE * 2) { reject(httpError(413, 'too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

async function listDir(root, rel) {
  const abs = resolveSafe(root, rel);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try { isDir = (await fsp.stat(path.join(abs, e.name))).isDirectory(); } catch { continue; }
    }
    out.push({ name: e.name, dir: isDir });
  }
  out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
  return out;
}

// 전체 파일 목록(빠른 검색용). 얕은 폴더부터(BFS) 훑어서 큰 저장소가 한도를 독점하지 못하게 한다.
const FILE_LIMIT = 300000;
async function walkAll(root, start = '') {
  const acc = []; let level = [start];
  while (level.length && acc.length < FILE_LIMIT) {
    const next = [];
    await Promise.all(level.map(async (rel) => {
      let entries;
      try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (IGNORE.has(e.name) || e.isSymbolicLink()) continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { if (!SEARCH_IGNORE.has(e.name)) next.push(r); }
        else acc.push(r);
      }
    }));
    level = next;
  }
  return { files: acc.slice(0, FILE_LIMIT), truncated: acc.length >= FILE_LIMIT };
}

// ───────── 파일 인덱스 ─────────
// 워크스페이스를 열면 백그라운드로 파일 목록을 인덱싱하고, fs.watch 이벤트가 알려 준 경로만 증분 갱신한다.
// 검색 팝업은 디스크를 다시 훑지 않고 이 메모리 인덱스를 바로 쓴다.
const INDEX_MAX_ROOTS = 4;
const indexes = new Map(); // root → { set, arr, ready, truncated, building, watcher, pending, timer, ts }
const isIgnoredRel = (rel) => rel.split('/').some((s) => IGNORE.has(s) || SEARCH_IGNORE.has(s));
const indexFiles = (ix) => (ix.arr ||= [...ix.set]);
function getIndex(root) {
  let ix = indexes.get(root);
  if (ix) { indexes.delete(root); indexes.set(root, ix); return ix; } // LRU
  ix = { set: new Set(), arr: null, ready: false, truncated: false, building: null, watcher: null, pending: new Set(), timer: null, ts: 0 };
  indexes.set(root, ix);
  while (indexes.size > INDEX_MAX_ROOTS) {
    const [k, old] = indexes.entries().next().value;
    try { old.watcher?.close(); } catch {} clearTimeout(old.timer); indexes.delete(k);
  }
  try { // macOS(FSEvents) / Linux(Node 20+) 재귀 감시. 안 되면 접근 시 TTL 전체 재스캔으로 대체
    ix.watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
      const rel = name && String(name).split(path.sep).join('/');
      if (!rel || isIgnoredRel(rel)) return;
      ix.pending.add(rel); clearTimeout(ix.timer); ix.timer = setTimeout(() => flush(root, ix), 300);
    });
    ix.watcher.on('error', () => { ix.watcher = null; });
  } catch {}
  rebuild(root, ix);
  return ix;
}
function rebuild(root, ix) { // 전체 스캔 (최초 / 변경이 너무 많을 때 / 감시 불가 시)
  if (ix.building) return ix.building;
  ix.pending.clear();
  ix.building = walkAll(root)
    .then((r) => { ix.set = new Set(r.files); ix.arr = null; ix.truncated = r.truncated; ix.ready = true; ix.ts = Date.now(); })
    .catch(() => {})
    .finally(() => { ix.building = null; });
  return ix.building;
}
async function flush(root, ix) { // 변경된 경로만 반영
  if (ix.building) { ix.timer = setTimeout(() => flush(root, ix), 300); return; }
  const rels = [...ix.pending]; ix.pending.clear();
  if (rels.length > 2000) return rebuild(root, ix);
  for (const rel of rels) {
    try {
      const st = await fsp.lstat(path.join(root, rel));
      if (st.isDirectory()) for (const f of (await walkAll(root, rel)).files) ix.set.add(f);
      else if (st.isFile()) ix.set.add(rel);
    } catch { // 삭제/이동: 파일이면 그 항목, 폴더면 하위 전체 제거
      ix.set.delete(rel);
      const pre = rel + '/'; for (const f of ix.set) if (f.startsWith(pre)) ix.set.delete(f);
    }
  }
  ix.arr = null; ix.ts = Date.now();
}
function markDirty(root) { // 우리 API 로 만든 변경은 감시 이벤트가 오기 전에도 반영
  const ix = indexes.get(root); if (!ix || ix.watcher) return;
  rebuild(root, ix);
}

// ───────── 파일 내용 검색 (Find in Files) ─────────
// ripgrep 이 있으면 사용하고, 없으면 인덱스 위에서 Node 로 직접 스캔한다.
const RG = (() => {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(HOME, '.cargo/bin'), path.join(HOME, '.local/bin')]);
  for (const d of dirs) { const p = path.join(d, 'rg'); try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {} }
  return null;
})();
const BINARY_EXT = new Set('png jpg jpeg gif webp ico icns bmp tiff pdf zip gz tgz bz2 xz 7z rar tar jar war class dex so dylib dll exe o a bin pyc pyo woff woff2 ttf otf eot mp3 mp4 mov avi mkv wav flac ogg webm sqlite sqlite3 db parquet pkl npy npz onnx pt pth safetensors gguf ckpt wasm psd ai lock'.split(' '));
const SEARCH_LIMIT = 2000, FILE_MAX = 1024 * 1024, LINE_CUT = 400;

function globToRe(g) {
  const body = g.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0001/g, '.*');
  return new RegExp(g.includes('/') ? '^' + body + '$' : '^(?:.*/)?' + body + '$', 'i');
}
function buildRegex({ q, cs, word, regex }) {
  let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (word) src = `\\b(?:${src})\\b`;
  try { return new RegExp(src, cs ? 'g' : 'gi'); } catch (e) { throw httpError(400, 'invalid regex: ' + e.message); }
}
// 한 줄을 결과 형태로
function lineHit(lineNo, text, ranges) {
  let off = 0; // 긴 줄은 첫 일치 위치 주변만 보여 준다 (off = 잘라낸 앞부분 길이)
  if (text.length > LINE_CUT) {
    off = Math.max(0, ranges[0][0] - 80);
    text = text.slice(off, off + LINE_CUT);
    ranges = ranges.map(([s, e]) => [s - off, Math.min(e - off, LINE_CUT)]).filter(([s]) => s < LINE_CUT);
  }
  return { line: lineNo, text, ranges, off };
}

async function searchNode(root, o, signal) {
  const ix = getIndex(root); if (!ix.ready) await ix.building;
  const globs = o.glob ? o.glob.split(',').map((g) => g.trim()).filter(Boolean).map(globToRe) : [];
  const re = buildRegex(o);
  const exts = o.glob ? null : (o.exts.length ? new Set(o.exts) : null); // 마스크를 직접 쓰면 그것이 우선
  const files = indexFiles(ix).filter((f) => {
    const ext = path.extname(f).slice(1).toLowerCase();
    if (BINARY_EXT.has(ext)) return false;
    if (exts) return exts.has(ext);
    return !globs.length || globs.some((g) => g.test(f));
  });
  const results = []; let matches = 0, truncated = false, next = 0;
  async function worker() {
    while (next < files.length && !truncated && !signal.aborted) {
      const f = files[next++];
      let buf;
      try {
        const abs = path.join(root, f), st = await fsp.stat(abs);
        if (st.size > FILE_MAX || st.size === 0) continue;
        buf = await fsp.readFile(abs);
      } catch { continue; }
      if (buf.subarray(0, 4000).includes(0)) continue;
      const text = buf.toString('utf8');
      re.lastIndex = 0;
      if (!re.test(text)) continue; // 대부분의 파일은 여기서 빠르게 탈락
      const hits = [], lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ranges = []; let m; re.lastIndex = 0;
        while ((m = re.exec(lines[i]))) { if (!m[0]) { re.lastIndex++; continue; } ranges.push([m.index, m.index + m[0].length]); }
        if (ranges.length) { hits.push(lineHit(i + 1, lines[i].replace(/\r$/, ''), ranges)); matches += ranges.length; }
        if (matches >= SEARCH_LIMIT) { truncated = true; break; }
      }
      if (hits.length) results.push({ path: f, matches: hits });
    }
  }
  await Promise.all(Array.from({ length: 48 }, worker));
  return { results, matches, truncated, engine: 'node' };
}

function searchRg(root, o, signal) {
  return new Promise((resolve, reject) => {
    const args = ['--json', '--hidden', '--max-filesize', '1M', o.cs ? '-s' : '-i'];
    if (!o.regex) args.push('-F');
    if (o.word) args.push('-w');
    for (const d of [...IGNORE, ...SEARCH_IGNORE]) args.push('-g', '!' + d);
    if (o.glob) for (const g of o.glob.split(',').map((x) => x.trim()).filter(Boolean)) args.push('-g', g);
    else for (const e of o.exts) args.push('-g', '*.' + e);
    args.push('-e', o.q, '--', '.');
    const child = spawn(RG, args, { cwd: root });
    const byPath = new Map(); let matches = 0, truncated = false, err = '', buf = '';
    const stop = () => { try { child.kill(); } catch {} };
    signal.addEventListener('abort', stop);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      buf += d; const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        let ev; try { ev = JSON.parse(l); } catch { continue; }
        if (ev.type !== 'match' || !ev.data.path.text || ev.data.lines.text == null) continue;
        const rel = ev.data.path.text.replace(/^\.\//, ''), raw = ev.data.lines.text.replace(/\r?\n$/, '');
        const b = Buffer.from(ev.data.lines.text); // 바이트 오프셋 → 문자 오프셋
        const ranges = ev.data.submatches.map((m) => [b.subarray(0, m.start).toString().length, b.subarray(0, m.end).toString().length]);
        if (!byPath.has(rel)) byPath.set(rel, []);
        byPath.get(rel).push(lineHit(ev.data.line_number, raw, ranges)); matches += ranges.length;
        if (matches >= SEARCH_LIMIT) { truncated = true; stop(); return; }
      }
    });
    child.on('close', (code) => {
      if (code > 1 && !truncated && !signal.aborted) return reject(httpError(400, err.trim().split('\n')[0] || 'search failed'));
      resolve({ results: [...byPath].map(([p, m]) => ({ path: p, matches: m })), matches, truncated, engine: 'rg' });
    });
    child.on('error', reject);
  });
}

async function searchFiles(root, o, signal) {
  const out = RG ? await searchRg(root, o, signal) : await searchNode(root, o, signal);
  out.results.sort((a, b) => a.path.localeCompare(b.path));
  return { ...out, files: out.results.length };
}

async function api(req, res, url, root) {
  const p = url.searchParams.get('path') || '';
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'POST /api/quit':
      send(res, 200, { ok: true }); return setTimeout(() => process.exit(0), 50);
    case 'GET /api/settings':
      return send(res, 200, readSettings());
    case 'PUT /api/settings': {
      const { settings } = JSON.parse(await readBody(req));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw httpError(400, 'bad settings');
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
      return send(res, 200, { ok: true });
    }
    case 'PUT /api/last': {
      const { root: r } = JSON.parse(await readBody(req));
      if (typeof r !== 'string' || !path.isAbsolute(r) || !isDirSafe(r)) throw httpError(400, 'bad root');
      fs.mkdirSync(path.dirname(LAST_FILE), { recursive: true });
      fs.writeFileSync(LAST_FILE, JSON.stringify({ root: r }) + '\n');
      return send(res, 200, { ok: true });
    }
    case 'GET /api/favorites':
      return send(res, 200, readFavs());
    case 'PUT /api/favorites': {
      const { list } = JSON.parse(await readBody(req));
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && path.isAbsolute(x))) throw httpError(400, 'bad list');
      fs.mkdirSync(path.dirname(FAV_FILE), { recursive: true });
      fs.writeFileSync(FAV_FILE, JSON.stringify([...new Set(list)], null, 2) + '\n');
      return send(res, 200, { ok: true });
    }
    case 'GET /api/info':
      getIndex(root); // 워크스페이스를 열면 인덱싱 시작
      return send(res, 200, { app: 'shooting-star', root, name: path.basename(root) || root, home: HOME, last: readLast() });
    case 'GET /api/browse': { // 폴더 선택기: 절대경로의 하위 폴더 목록
      const dir = fs.realpathSync(path.resolve((p || HOME).replace(/^~(?=$|\/)/, HOME)));
      const list = (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((e) => (e.isDirectory() || (e.isSymbolicLink() && isDirSafe(path.join(dir, e.name)))) && !e.name.startsWith('.'))
        .map((e) => e.name).sort((a, b) => a.localeCompare(b));
      return send(res, 200, { path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, dirs: list });
    }
    case 'GET /api/tree':
      return send(res, 200, await listDir(root, p));
    case 'GET /api/search': {
      const q = url.searchParams.get('q') || '';
      if (!q) return send(res, 200, { results: [], files: 0, matches: 0, truncated: false });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); }); // 클라이언트가 취소하면 중단
      const flag = (k) => url.searchParams.get(k) === '1';
      const exts = (url.searchParams.get('exts') || '').split(',').map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter((e) => /^[\w+-]+$/.test(e));
      return send(res, 200, await searchFiles(root, { q, cs: flag('case'), word: flag('word'), regex: flag('regex'), glob: url.searchParams.get('glob') || '', exts }, ac.signal));
    }
    case 'GET /api/files': {
      const ix = getIndex(root);
      if (!ix.ready) await ix.building;
      else if (!ix.watcher && Date.now() - ix.ts > 10000) rebuild(root, ix); // 감시 불가 시 TTL
      return send(res, 200, indexFiles(ix));
    }
    case 'GET /api/index': {
      const ix = getIndex(root);
      return send(res, 200, { ready: ix.ready, building: !!ix.building, count: ix.set.size, truncated: ix.truncated, watching: !!ix.watcher, ts: ix.ts });
    }
    case 'GET /api/file': {
      const abs = resolveSafe(root, p);
      const st = await fsp.stat(abs);
      if (!st.isFile()) throw httpError(400, 'not a file');
      if (st.size > MAX_SIZE) throw httpError(413, 'file too large (>5MB)');
      const buf = await fsp.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) throw httpError(415, 'binary file');
      return send(res, 200, { content: buf.toString('utf8'), mtime: st.mtimeMs, size: st.size });
    }
    case 'PUT /api/file': {
      const abs = resolveSafe(root, p);
      const { content, mtime } = JSON.parse(await readBody(req));
      // 외부에서 수정된 파일을 덮어쓰지 않도록 mtime 검사
      if (mtime != null) {
        try {
          const st = await fsp.stat(abs);
          if (Math.abs(st.mtimeMs - mtime) > 1) throw httpError(409, 'file changed on disk');
        } catch (e) { if (e.status) throw e; }
      }
      await fsp.writeFile(abs, content, 'utf8');
      return send(res, 200, { mtime: (await fsp.stat(abs)).mtimeMs });
    }
    case 'POST /api/create': {
      const abs = resolveSafe(root, p);
      const { dir } = JSON.parse(await readBody(req) || '{}');
      if (fs.existsSync(abs)) throw httpError(409, 'already exists');
      if (dir) await fsp.mkdir(abs, { recursive: true });
      else { await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, '', { flag: 'wx' }); }
      markDirty(root);
      return send(res, 200, { ok: true });
    }
    case 'POST /api/rename': {
      const { to } = JSON.parse(await readBody(req));
      const from = resolveSafe(root, p), dest = resolveSafe(root, to);
      if (fs.existsSync(dest)) throw httpError(409, 'target exists');
      await fsp.rename(from, dest); markDirty(root);
      return send(res, 200, { ok: true });
    }
    case 'DELETE /api/file': {
      const abs = resolveSafe(root, p);
      if (abs === root) throw httpError(403, 'cannot delete root');
      await fsp.rm(abs, { recursive: true }); markDirty(root);
      return send(res, 200, { ok: true });
    }
    default:
      throw httpError(404, 'no such api');
  }
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC, path.normalize(rel));
  if (!abs.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  try {
    const data = await fsp.readFile(abs);
    send(res, 200, data, MIME[path.extname(abs)] || 'application/octet-stream');
  } catch { send(res, 404, 'not found', 'text/plain'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // DNS rebinding / 타 사이트에서의 요청 방지
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]', HOST].includes(host)) throw httpError(403, 'bad host');
    if (url.pathname === '/raw') { // 마크다운 안의 상대경로 이미지 등
      const abs = resolveSafe(rootOf(req, url), url.searchParams.get('path') || '');
      const ext = path.extname(abs).toLowerCase();
      const type = { ...MIME, '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
      if (!type || ext === '.html' || ext === '.js') throw httpError(415, 'unsupported');
      return send(res, 200, await fsp.readFile(abs), type);
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers['x-ss'] !== '1') throw httpError(403, 'missing header');
      return await api(req, res, url, rootOf(req, url));
    }
    await serveStatic(res, decodeURIComponent(url.pathname));
  } catch (e) {
    const status = e.status || (e.code === 'ENOENT' ? 404 : 500);
    send(res, status, { error: e.message });
  }
});

// ───────── 실행 / 창 열기 ─────────
const BASE = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
const appUrl = () => {
  const last = LAST && readLast(); // --last: 마지막으로 연 폴더, 없으면 기본 폴더
  return `${BASE}/?root=${encodeURIComponent(last || DEFAULT_ROOT)}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function running() {
  try { return (await (await fetch(`${BASE}/api/info`)).json()).app === 'shooting-star'; } catch { return false; }
}
// Chromium 계열이 있으면 주소창 없는 독립 창(--app)으로, 없으면 기본 브라우저로 연다
function openWindow(url) {
  const sh = (c) => exec(c, () => {});
  if (process.env.SS_APP_WINDOW !== '0') {
    if (process.platform === 'darwin') {
      for (const name of ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Vivaldi']) {
        for (const dir of ['/Applications', path.join(HOME, 'Applications')]) {
          if (fs.existsSync(`${dir}/${name}.app`)) return sh(`open -na "${dir}/${name}.app" --args --app="${url}"`);
        }
      }
    } else {
      for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']) {
        if (spawnSync('which', [bin]).status === 0) return spawn(bin, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
      }
    }
  }
  sh(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${url}"`);
}

async function main() {
  if (STOP) {
    try { await fetch(`${BASE}/api/quit`, { method: 'POST', headers: { 'X-SS': '1' } }); console.log('stopped'); }
    catch { console.log('실행 중이 아닙니다'); }
    return;
  }
  if (FG) { // 포그라운드 서버
    server.on('error', (e) => { console.error(e.message); process.exit(1); });
    return server.listen(PORT, HOST, () => {
      console.log(`shooting-star → ${appUrl()}`);
      if (!NO_OPEN) openWindow(appUrl());
    });
  }
  // 기본: 백그라운드로 띄우고(이미 있으면 재사용) 이 폴더를 창으로 연다 — `code .` 처럼
  if (!(await running())) {
    spawn(process.execPath, [__filename, '--fg', '--no-open', '--port', String(PORT), '--host', HOST, DEFAULT_ROOT],
      { detached: true, stdio: 'ignore', cwd: DEFAULT_ROOT }).unref();
    for (let i = 0; i < 50 && !(await running()); i++) await sleep(100);
    if (!(await running())) { console.error(`서버를 시작하지 못했습니다 (포트 ${PORT} 사용 중?)`); process.exit(1); }
  }
  if (!NO_OPEN) openWindow(appUrl());
  console.log(`shooting-star → ${DEFAULT_ROOT}`);
}
main();
