#!/usr/bin/env node
// shooting-star: 의존성 없는 로컬 문서 관리 서버
// usage: ss [dir] [--port 4000] [--host 127.0.0.1] [--fg] [--no-open] [--last] [--stop]
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { exec, execFile, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
// `ss run …`: 서버를 띄우지 않고 스크립트 레지스트리 CLI 로 동작 (run.js)
if (process.argv[2] === 'run') { require('./run').cli(process.argv.slice(3)).then((c) => process.exit(c)); return; }
if (process.argv[2] === 'db') { require('./db').cli(process.argv.slice(3)).then((c) => process.exit(c)); return; }
const RUN = require('./run');
const DB = require('./db');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const flag = (n) => args.includes('--' + n) && args.splice(args.indexOf('--' + n), 1).length > 0;
const PORT = Number(opt('port', 4000));
const HOST = opt('host', '127.0.0.1');
const FG = flag('fg'), STOP = flag('stop'), STATUS = flag('status'), DOCTOR = flag('doctor'), LAST = flag('last'), NO_OPEN = flag('no-open');
const HOME = os.homedir();
const DEFAULT_ROOT = fs.realpathSync(path.resolve((args[0] || process.cwd()).replace(/^~(?=$|\/)/, HOME)));
const PUBLIC = path.join(__dirname, 'public');
const FAV_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'shooting-star', 'favorites.json');
const readFavs = () => { try { return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')).filter((x) => typeof x === 'string'); } catch { return []; } };
const SETTINGS_FILE = path.join(path.dirname(FAV_FILE), 'settings.json');
const readSettings = () => { try { const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; } };
// 마지막으로 연 폴더가 없을 때의 시작 위치: 설정(defaultRoot) > ~/projects > 홈
const defaultWorkspace = () => {
  const cfg = readSettings().defaultRoot;
  for (const c of [cfg && String(cfg).replace(/^~(?=$|\/)/, HOME), path.join(HOME, 'projects')]) if (c && path.isAbsolute(c) && isDirSafe(c)) return fs.realpathSync(c);
  return HOME;
};
// 메모: ~/.shooting-star/memos/*.md (평범한 마크다운 파일)
const MEMO_DIR = path.join(HOME, '.shooting-star', 'memos');
const ensureMemoDir = () => { fs.mkdirSync(MEMO_DIR, { recursive: true }); return MEMO_DIR; };
const LAST_FILE = path.join(path.dirname(FAV_FILE), 'last.json'); // 마지막으로 연 워크스페이스
const readLast = () => { try { const r = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')).root; return isDirSafe(r) ? r : null; } catch { return null; } };
// 버전 / 업데이트 확인 (GitHub Releases 의 최신 태그와 비교. 설정에서 끌 수 있음)
const REPO = 'AndersonJo/Shooting-Star';
const VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
// 서버 코드의 지문: 버전은 그대로여도 코드가 바뀌면(git pull 등) 이전 코드로 떠 있는 서버를 알아볼 수 있다
const BUILD = crypto.createHash('sha1').update(fs.readFileSync(__filename)).update(fs.readFileSync(path.join(__dirname, 'run.js'))).update(fs.readFileSync(path.join(__dirname, 'db.js'))).digest('hex').slice(0, 12);
let updateCache = { t: 0, data: null };
const API_BASE = process.env.SS_GITHUB_API || 'https://api.github.com';
// 설치 방식: git(소스) / brew(cask) / app(zip 으로 설치한 앱) / deb / unknown — 업데이트 방법이 다르다
function installKind() {
  if (process.env.SS_INSTALL_KIND) return { kind: process.env.SS_INSTALL_KIND, app: process.env.SS_APP_PATH || null, dir: __dirname };
  const m = /^(.*\.app)\/Contents\/Resources\/app$/.exec(__dirname);
  if (m) return { kind: ['/opt/homebrew/Caskroom/shooting-star', '/usr/local/Caskroom/shooting-star'].some(fs.existsSync) ? 'brew' : 'app', app: m[1] };
  if (__dirname.startsWith('/opt/shooting-star')) return { kind: 'deb' };
  if (fs.existsSync(path.join(__dirname, '.git'))) return { kind: 'git', dir: __dirname };
  return { kind: 'unknown' };
}
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
async function gitStatus(dir) { // 소스 설치: 원격보다 몇 커밋 뒤처졌는지
  try {
    await execP('git', ['-C', dir, 'fetch', '--quiet'], { env: GIT_ENV, timeout: 30000 });
    const up = (await execP('git', ['-C', dir, 'rev-parse', '--abbrev-ref', '@{u}'], { env: GIT_ENV })).trim();
    const behind = Number((await execP('git', ['-C', dir, 'rev-list', '--count', `HEAD..${up}`], { env: GIT_ENV })).trim());
    const dirty = (await execP('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], { env: GIT_ENV })).trim().length > 0;
    return { behind, upstream: up, dirty };
  } catch { return null; }
}
async function checkUpdate(force) {
  if (!force && updateCache.data && Date.now() - updateCache.t < 6 * 3600e3) return updateCache.data;
  const ik = installKind();
  let data = { current: VERSION, latest: null, available: false, url: `https://github.com/${REPO}/releases`, kind: ik.kind };
  try {
    const r = await fetch(`${API_BASE}/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'shooting-star', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
    if (r.ok) { const j = await r.json(), latest = String(j.tag_name || '').replace(/^v/, ''); if (/^\d+\.\d+\.\d+/.test(latest)) data = { ...data, latest, available: cmpVer(latest, VERSION) > 0, url: j.html_url || data.url }; }
  } catch {}
  if (ik.kind === 'git') { // 소스 설치는 릴리스가 아니라 main 의 새 커밋을 기준으로 한다
    const g = await gitStatus(ik.dir);
    if (g) data = { ...data, behind: g.behind, dirty: g.dirty, available: g.behind > 0 };
  }
  updateCache = { t: Date.now(), data }; return data;
}
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
  if (abs !== root && !abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) throw httpError(403, 'outside root');
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

const readRaw = (req, limit) => new Promise((resolve, reject) => { // 이미지 같은 바이너리 업로드용 (JSON 이 아님)
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(httpError(413, `too large (>${Math.round(limit / 1048576)}MB)`)); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
// 내용이 실제로 그 확장자의 이미지인지 확인 (확장자만 바꾼 임의 파일을 막는다)
function sniffImage(buf, ext) {
  const head = buf.subarray(0, 16);
  if (ext === '.png') return head.readUInt32BE(0) === 0x89504e47;
  if (ext === '.jpg' || ext === '.jpeg') return head[0] === 0xff && head[1] === 0xd8;
  if (ext === '.gif') return head.toString('latin1', 0, 4) === 'GIF8';
  if (ext === '.webp') return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
  if (ext === '.bmp') return head.toString('latin1', 0, 2) === 'BM';
  if (ext === '.avif') return head.toString('latin1', 4, 8) === 'ftyp';
  if (ext === '.svg') return /<svg[\s>]/i.test(buf.subarray(0, 2048).toString('utf8'));
  return false;
}
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

// ───────── 이미지: 크기 읽기 / 화면용 축소본 / 스트리밍 ─────────
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif' };
const THUMB_DIR = path.join(HOME, '.shooting-star', 'cache', 'thumbs');
// 헤더만 읽어 픽셀 크기를 얻는다 (디코딩 없이). 모르면 null.
function imageSize(b) {
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };                       // PNG
    if (b.toString('latin1', 0, 4) === 'GIF8') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };                                      // GIF
    if (b.toString('latin1', 0, 2) === 'BM') return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };                    // BMP
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {                                                  // WebP
      const t = b.toString('latin1', 12, 16);
      if (t === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (t === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
      if (t === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {                                                                                                   // JPEG: SOF 마커 탐색
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}
async function readHead(abs, n = 262144) { const fh = await fsp.open(abs, 'r'); try { const b = Buffer.alloc(n); const { bytesRead } = await fh.read(b, 0, n, 0); return b.subarray(0, bytesRead); } finally { await fh.close(); } }
const execP = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { timeout: 60000, maxBuffer: 1 << 20, ...opts }, (e, out, err) => (e ? rej(Object.assign(e, { stderr: String(err || '') })) : res(String(out)))));
const RESIZER = (() => { // 축소본 생성 도구: macOS 는 sips(기본 탑재), Linux 는 있으면 vips/ImageMagick
  if (process.platform === 'darwin') return 'sips';
  for (const c of ['vipsthumbnail', 'magick', 'convert']) if (spawnSync('which', [c]).status === 0) return c;
  return null;
})();
async function imageInfo(abs, st) {
  const ext = path.extname(abs).toLowerCase();
  let dim = imageSize(await readHead(abs));
  if (!dim && RESIZER === 'sips' && ['.heic', '.heif', '.tif', '.tiff', '.avif'].includes(ext)) { // 헤더 파서가 없는 형식은 sips 로
    try { const o = await execP('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', abs]); dim = { w: +/pixelWidth: (\d+)/.exec(o)?.[1], h: +/pixelHeight: (\d+)/.exec(o)?.[1] }; if (!dim.w) dim = null; } catch {}
  }
  return { w: dim?.w ?? null, h: dim?.h ?? null, size: st.size, mtime: st.mtimeMs, ext: ext.slice(1) };
}
let thumbRunning = 0; const thumbQueue = [], thumbJobs = new Map();
const limited = (fn) => new Promise((resolve, reject) => {   // 동시에 3개까지만 변환
  const run = () => { thumbRunning++; fn().then(resolve, reject).finally(() => { thumbRunning--; thumbQueue.shift()?.(); }); };
  thumbRunning < 3 ? run() : thumbQueue.push(run);
});
// 화면 크기에 맞게 줄인 이미지(캐시). 필요 없거나 만들 수 없으면 null → 원본을 그대로 보낸다.
async function thumbFor(abs, st, w) {
  const ext = path.extname(abs).toLowerCase();
  if (!RESIZER || !['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.heic', '.heif'].includes(ext)) return null;
  const needsConvert = ['.tif', '.tiff', '.heic', '.heif'].includes(ext);     // 브라우저가 못 보는 형식은 항상 변환
  if (!needsConvert) {
    if (st.size < 300 * 1024) return null;
    const dim = imageSize(await readHead(abs)); if (dim && Math.max(dim.w, dim.h) <= w) return null;   // 이미 화면보다 작음
  }
  const png = ext === '.png', key = crypto.createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}|${w}|${png}`).digest('hex');
  const out = path.join(THUMB_DIR, `${key}.${png ? 'png' : 'jpg'}`);
  if (fs.existsSync(out)) return { file: out, type: png ? 'image/png' : 'image/jpeg' };
  if (!thumbJobs.has(out)) {
    thumbJobs.set(out, limited(async () => {   // 같은 이미지를 동시에 요청해도 한 번만 변환
      await fsp.mkdir(THUMB_DIR, { recursive: true });
      const tmp = out + '.tmp' + process.pid + (ext === '.png' ? '.png' : '.jpg');
      if (RESIZER === 'sips') await execP('sips', ['-s', 'format', png ? 'png' : 'jpeg', ...(png ? [] : ['-s', 'formatOptions', '85']), '-Z', String(w), abs, '--out', tmp]);
      else if (RESIZER === 'vipsthumbnail') await execP('vipsthumbnail', [abs, '-s', String(w), '-o', tmp + (png ? '' : '[Q=85]')]);
      else await execP(RESIZER, [abs + '[0]', '-auto-orient', '-resize', `${w}x${w}>`, '-quality', '85', tmp]);
      await fsp.rename(tmp, out);
    }).finally(() => thumbJobs.delete(out)));
  }
  try { await thumbJobs.get(out); return { file: out, type: png ? 'image/png' : 'image/jpeg' }; } catch { return null; }
}
async function pruneThumbs() { // 캐시가 800MB 를 넘으면 오래된 것부터 600MB 까지 정리
  try {
    const files = await Promise.all((await fsp.readdir(THUMB_DIR)).map(async (n) => { const p = path.join(THUMB_DIR, n), st = await fsp.stat(p); return { p, size: st.size, t: st.atimeMs }; }));
    let total = files.reduce((a, f) => a + f.size, 0); if (total < 800 * 1048576) return;
    for (const f of files.sort((a, b) => a.t - b.t)) { if (total < 600 * 1048576) break; await fsp.unlink(f.p).catch(() => {}); total -= f.size; }
  } catch {}
}
function sendFile(req, res, abs, type, st, extra = {}) { // ETag 로 재검증(304) + 스트리밍 (큰 이미지를 통째로 메모리에 올리지 않는다)
  const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
  const headers = { ETag: etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...extra };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, ...headers });
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
}

// ───────── 업데이트 적용 ─────────
let updateJob = null; // { state: running|done|error|manual, kind, log: [], error, manual }
const findBrew = () => process.env.SS_BREW || ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew'].find((p) => fs.existsSync(p)) || null;
function relaunchApp(app) { // 앱을 종료하고 새 버전으로 다시 연다. (서버는 새 앱이 시작될 때 코드가 다르면 스스로 교체된다)
  if (process.env.SS_NO_RELAUNCH) return;
  setTimeout(() => {
    spawn('sh', ['-c', 'sleep 1; pkill -TERM -f "$1/Contents/MacOS/shooting-star"; sleep 1; open -a "$1"', 'sh', app], { detached: true, stdio: 'ignore' }).unref();
  }, 800);
}
function restartServer() { // 새 코드로 서버 교체: 기본 모드의 ss 가 '코드가 다른 서버'를 알아보고 종료/재시작한다
  if (process.env.SS_NO_RELAUNCH) return;
  setTimeout(() => spawn(process.execPath, [__filename, '--no-open', '--port', String(PORT)], { detached: true, stdio: 'ignore', cwd: HOME }).unref(), 800);
}
async function downloadTo(url, file) {
  const r = await fetch(url, { headers: { 'User-Agent': 'shooting-star' }, redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`다운로드 실패 (${r.status}): ${url}`);
  await require('stream/promises').pipeline(require('stream').Readable.fromWeb(r.body), fs.createWriteStream(file));
}
async function doUpdate(job) {
  const log = (m) => job.log.push(m);
  const ik = installKind(); job.kind = ik.kind;
  const info = await checkUpdate(true);
  if (ik.kind === 'git') {
    if (info.dirty) throw new Error('로컬에 커밋하지 않은 변경이 있어 자동 업데이트할 수 없습니다 (git stash 후 다시 시도).');
    log('git pull --ff-only …');
    const before = (await execP('git', ['-C', ik.dir, 'rev-parse', 'HEAD'], { env: GIT_ENV })).trim();
    const out = await execP('git', ['-C', ik.dir, 'pull', '--ff-only'], { env: GIT_ENV, timeout: 120000 });
    log(out.trim().split('\n').slice(-2).join(' / '));
    const changed = (await execP('git', ['-C', ik.dir, 'diff', '--name-only', before, 'HEAD'], { env: GIT_ENV })).split('\n');
    const app = nativeApp();
    if (app && changed.some((f) => f.startsWith('macos/') || f === 'scripts/make-app.sh')) { log('네이티브 앱 다시 빌드 …'); await execP(path.join(ik.dir, 'scripts/make-app.sh'), [app, 'dev'], { timeout: 600000 }); job.relaunchApp = app; }
    log('서버를 새 코드로 재시작합니다'); job.restart = true;
  } else if (ik.kind === 'brew') {
    const brew = findBrew(); if (!brew) throw new Error('brew 를 찾을 수 없습니다.');
    log('brew upgrade --cask shooting-star … (1~2분 걸릴 수 있습니다)');
    const out = await execP(brew, ['upgrade', '--cask', 'shooting-star'], { timeout: 900000, env: { ...process.env, PATH: `${path.dirname(brew)}:${process.env.PATH || '/usr/bin:/bin'}` } });
    log(out.trim().split('\n').slice(-2).join(' / ')); job.relaunchApp = ik.app || '/Applications/shooting-star.app';
  } else if (ik.kind === 'app') {
    const rel = await (await fetch(`${API_BASE}/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'shooting-star' }, signal: AbortSignal.timeout(10000) })).json();
    const zipA = (rel.assets || []).find((a) => /-macos\.zip$/.test(a.name)), shaA = (rel.assets || []).find((a) => zipA && a.name === zipA.name + '.sha256');
    if (!zipA || !shaA) throw new Error('릴리스에서 macOS 앱을 찾지 못했습니다.');
    const parent = path.dirname(ik.app), work = path.join(parent, `.shooting-star-update-${process.pid}`);
    try { await fsp.mkdir(work, { recursive: true }); } catch { throw new Error(`${parent} 에 쓸 권한이 없습니다. 릴리스 페이지에서 직접 받아 주세요.`); }
    try {
      log(`${zipA.name} 다운로드 …`); const zip = path.join(work, zipA.name); await downloadTo(zipA.browser_download_url, zip);
      const want = (await (await fetch(shaA.browser_download_url, { headers: { 'User-Agent': 'shooting-star' } })).text()).trim().split(/\s+/)[0];
      const got = crypto.createHash('sha256').update(await fsp.readFile(zip)).digest('hex');
      if (want !== got) throw new Error('다운로드 파일의 sha256 이 일치하지 않습니다. 중단합니다.');
      log('sha256 확인됨 · 압축 해제 …'); await execP('ditto', ['-x', '-k', zip, path.join(work, 'x')]);
      const fresh = path.join(work, 'x', 'shooting-star.app');
      if (!fs.existsSync(path.join(fresh, 'Contents/Info.plist'))) throw new Error('압축 파일 안에서 앱을 찾지 못했습니다.');
      log('앱 교체 …'); const backup = `${ik.app}.old-${Date.now()}`;
      await fsp.rename(ik.app, backup);
      try { await fsp.rename(fresh, ik.app); } catch (e) { await fsp.rename(backup, ik.app); throw e; }   // 실패하면 원래 앱 복구
      fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
      job.relaunchApp = ik.app;
    } finally { fsp.rm(work, { recursive: true, force: true }).catch(() => {}); }
  } else if (ik.kind === 'deb') {
    job.manual = `sudo apt install ./shooting-star_${info.latest ?? 'X.Y.Z'}_all.deb   (${info.url} 에서 .deb 를 받은 뒤)`; job.state = 'manual'; return;
  } else { job.manual = `${info.url} 에서 새 버전을 받아 설치하세요.`; job.state = 'manual'; return; }
  job.state = 'done'; updateCache = { t: 0, data: null };
  if (job.relaunchApp) relaunchApp(job.relaunchApp); else if (job.restart) restartServer();
}

// ───────── 파일 인덱스 ─────────
// 워크스페이스를 열면 백그라운드로 파일 목록을 인덱싱하고, fs.watch 이벤트가 알려 준 경로만 증분 갱신한다.
// 검색 팝업은 디스크를 다시 훑지 않고 이 메모리 인덱스를 바로 쓴다.
const INDEX_MAX_ROOTS = 4;
const indexes = new Map(); // root → { set, arr, ready, truncated, building, watcher, pending, timer, ts }
const isIgnoredRel = (rel) => rel.split('/').some((s) => IGNORE.has(s) || SEARCH_IGNORE.has(s));
const indexFiles = (ix) => (ix.arr ||= [...ix.set]);
const sseClients = new Map(); // root → Set(res) : 화면(EventSource) 연결
function broadcast(root, paths) { // paths 가 비어 있으면 '전체 새로고침'
  const set = sseClients.get(root); if (!set || !set.size) return;
  const data = `data: ${JSON.stringify({ paths: paths.slice(0, 500), all: !paths.length || paths.length > 500 })}\n\n`;
  for (const r of set) { try { r.write(data); } catch {} }
}
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
  if (rels.length > 2000) return rebuild(root, ix).then(() => broadcast(root, []));
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
  broadcast(root, rels);   // 인덱스를 먼저 갱신한 뒤 알린다 (화면이 필터 폴더 목록을 다시 받을 때 최신이 되도록)
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
    if (o.dir && !f.startsWith(o.dir + '/')) return false;
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
    args.push('-e', o.q, '--', o.dir || '.');
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


// ───────── Git: 작업 폴더 안의 repo 들과 변경된 파일 ─────────
const GIT_VIEW_ENV = { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0' };   // status 가 index.lock 을 잡아 사용자의 git 명령과 부딪히지 않게
const git = (repo, args, opts = {}) => execP('git', ['-c', 'core.quotepath=off', '-C', repo, ...args], { env: GIT_VIEW_ENV, maxBuffer: 16 << 20, ...opts });
const gitMsg = (e) => ((e.stderr || '') + (e.stdout || '') || e.message).trim().split('\n').slice(-6).join('\n');

// root 아래(깊이 5)의 repo 를 찾는다. root 가 어떤 repo 의 하위 폴더라면 그 repo 도 포함.
async function findRepos(root) {
  const repos = []; let visited = 0, level = [root];
  for (let depth = 0; depth <= 5 && level.length && visited < 4000; depth++) {
    const next = [];
    for (const dir of level) {
      visited++;
      let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      if (ents.some((e) => e.name === '.git')) repos.push(dir);
      for (const e of ents) if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !IGNORE.has(e.name) && !SEARCH_IGNORE.has(e.name)) next.push(path.join(dir, e.name));
    }
    level = next;
  }
  if (!repos.includes(root)) {
    try { const top = fs.realpathSync((await git(root, ['rev-parse', '--show-toplevel'])).trim()); if (top && !repos.includes(top)) repos.unshift(top); } catch {}
  }
  return repos.sort();
}
async function gitRepoOf(root, p) {   // 요청의 repo(절대경로)가 이 워크스페이스의 repo 인지 확인
  if (!p || !path.isAbsolute(p)) throw httpError(400, 'bad repo');
  const abs = path.resolve(p);
  if (!(await findRepos(root)).includes(abs)) throw httpError(403, 'not a repo of this workspace');
  return abs;
}
// `git status --porcelain=v1 -b -z` 해석
function parseStatus(out) {
  const recs = out.split('\0'); const head = recs.shift() || '', files = [];
  const m = /^## (?:No commits yet on |Initial commit on )?(.*)$/.exec(head); let branch = m ? m[1] : '', upstream = '', ahead = 0, behind = 0;
  const um = /^(.*?)\.\.\.(\S+)(?: \[(.*)\])?$/.exec(branch);
  if (um) {
    branch = um[1]; upstream = um[2];
    const a = /ahead (\d+)/.exec(um[3] || ''), b = /behind (\d+)/.exec(um[3] || '');
    ahead = a ? +a[1] : 0; behind = b ? +b[1] : 0;
  }
  if (/^HEAD \(no branch\)/.test(branch)) branch = 'HEAD (detached)';
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]; if (r.length < 4) continue;
    const x = r[0], y = r[1], f = { path: r.slice(3), x, y };
    if (x === 'R' || x === 'C') f.from = recs[++i];
    files.push(f);
  }
  return { branch, upstream, ahead, behind, files };
}
async function gitPush(repo) {
  const st = await gitStatus(repo);
  let args = ['push'];
  if (!st.upstream) {   // 처음 push 하는 브랜치: origin(없으면 첫 remote)에 upstream 설정
    const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
    if (!remotes.length) throw httpError(400, '원격 저장소(remote)가 설정되어 있지 않습니다');
    args = ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], 'HEAD'];
  }
  try { await git(repo, args, { timeout: 120000 }); } catch (e) { throw httpError(500, gitMsg(e)); }
}
async function gitStatus(repo) {
  const out = await git(repo, ['status', '--porcelain=v1', '-b', '-z', '-uall']);
  return parseStatus(out);
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
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && path.isAbsolute(x.replace(/^f:/, '')))) throw httpError(400, 'bad list');
      fs.mkdirSync(path.dirname(FAV_FILE), { recursive: true });
      fs.writeFileSync(FAV_FILE, JSON.stringify([...new Set(list)], null, 2) + '\n');
      return send(res, 200, { ok: true });
    }
    case 'GET /api/run/list':
      return send(res, 200, { scripts: RUN.list().map(({ scriptPath, ...m }) => ({ ...m, scriptPath })), dir: RUN.DIR, running: [...RUN.jobs.values()].filter((j) => !j.endedAt).map((j) => ({ id: j.id, name: j.name })), history: RUN.history(30) });
    case 'POST /api/run/exec': { // 등록된 이름만 실행한다 (임의 명령 실행 아님)
      const { name, params } = JSON.parse(await readBody(req));
      const job = RUN.start(RUN.get(name), params && typeof params === 'object' ? params : {}, { cwd: root, source: 'ui' });
      return send(res, 200, { id: job.id, cmdline: job.cmdline, cwd: job.cwd, startedAt: job.startedAt });
    }
    case 'GET /api/run/stream': { // 실행 출력 (SSE): 지금까지의 출력 → 이어서 실시간 → end
      const id = url.searchParams.get('id') || '', job = RUN.jobs.get(id);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      if (!job) { ev('data', RUN.readLog(id)); ev('end', { code: null, gone: true }); return res.end(); }
      if (job.buf) ev('data', job.buf);
      if (job.endedAt) { ev('end', { code: job.code, signal: job.signal, ms: job.endedAt - job.startedAt }); return res.end(); }
      const onData = (s) => ev('data', s), onEnd = (r) => { ev('end', { ...r, ms: job.endedAt - job.startedAt }); res.end(); };
      job.on('data', onData); job.once('end', onEnd);
      res.on('close', () => { job.off('data', onData); job.off('end', onEnd); });
      return;
    }
    case 'POST /api/run/kill': {
      const { id } = JSON.parse(await readBody(req));
      return send(res, 200, { ok: RUN.kill(id) });
    }
    case 'GET /api/run/log':
      return send(res, 200, { log: RUN.readLog(url.searchParams.get('id') || '') });
    case 'POST /api/run/new': { // 빈 스크립트 + 매니페스트를 만든다 (이후 편집기에서 수정)
      const { name, lang } = JSON.parse(await readBody(req));
      const ext = { bash: '.sh', python: '.py', node: '.js' }[lang] || '.sh';
      const body = { '.sh': '#!/usr/bin/env bash\nset -euo pipefail\n\necho "hello from ${SS_RUN_NAME}"\n', '.py': '#!/usr/bin/env python3\nimport os\n\nprint("hello from", os.environ["SS_RUN_NAME"])\n', '.js': '#!/usr/bin/env node\nconsole.log("hello from", process.env.SS_RUN_NAME);\n' }[ext];
      const tmp = path.join(os.tmpdir(), `ss-new-${process.pid}-${Date.now()}${ext}`);
      fs.writeFileSync(tmp, body);
      try { RUN.add({ name, description: '' }, tmp, {}); } finally { fs.rmSync(tmp, { force: true }); }
      const m = RUN.get(name);
      return send(res, 200, { name, script: m.scriptPath, manifest: path.join(RUN.DIR, name + '.json') });
    }
    case 'POST /api/run/install': // Claude 연동: skill + SessionStart hook + 실행 권한 (~/.claude)
      return send(res, 200, RUN.install());
    case 'DELETE /api/run/script': {
      RUN.remove(url.searchParams.get('name') || '');
      return send(res, 200, { ok: true });
    }
    case 'GET /api/db/connections':
      return send(res, 200, { connections: DB.listConnections(), kinds: Object.fromEntries(Object.entries(DB.KINDS).map(([k, v]) => [k, { label: v.label, port: v.port || null, file: !!v.file }])) });
    case 'PUT /api/db/connection': {
      const { conn, password } = JSON.parse(await readBody(req));
      return send(res, 200, DB.saveConnection(conn || {}, password));
    }
    case 'DELETE /api/db/connection':
      DB.deleteConnection(url.searchParams.get('id') || '');
      return send(res, 200, { ok: true });
    case 'POST /api/db/test': {
      const { conn, password } = JSON.parse(await readBody(req));
      return send(res, 200, await DB.test(conn || {}, password));
    }
    case 'POST /api/db/driver': // 드라이버 설치 (npm → ~/.shooting-star/drivers)
      return send(res, 200, await DB.installDriver(JSON.parse(await readBody(req)).kind));
    case 'GET /api/db/children':
      return send(res, 200, { items: await DB.children(url.searchParams.get('id') || '', { schema: url.searchParams.get('schema') || undefined, table: url.searchParams.get('table') || undefined }) });
    case 'GET /api/db/selectsql':
      return send(res, 200, { sql: DB.selectAll(url.searchParams.get('id') || '', url.searchParams.get('schema') || '', url.searchParams.get('table') || '') });
    case 'POST /api/db/query': {
      const { id, sql, limit, offset } = JSON.parse(await readBody(req));
      return send(res, 200, await DB.query(id, sql, { limit, offset }));
    }
    case 'POST /api/db/count': {
      const { id, sql } = JSON.parse(await readBody(req));
      return send(res, 200, await DB.count(id, sql));
    }
    case 'GET /api/db/history':
      return send(res, 200, { items: DB.history({ id: url.searchParams.get('id') || undefined, q: url.searchParams.get('q') || undefined, limit: url.searchParams.get('limit') || 100 }) });
    case 'POST /api/db/cancel':
      return send(res, 200, await DB.cancel(JSON.parse(await readBody(req)).id));
    case 'GET /api/db/names':
      return send(res, 200, { items: await DB.names(url.searchParams.get('id') || '') });
    case 'GET /api/db/keys':
      return send(res, 200, { pk: await DB.keys(url.searchParams.get('id') || '', url.searchParams.get('schema') || '', url.searchParams.get('table') || '') });
    case 'POST /api/db/update': {
      const { id, schema, table, changes } = JSON.parse(await readBody(req));
      return send(res, 200, await DB.updateRows(id, schema, table, changes));
    }
    case 'GET /api/events': { // Server-Sent Events: 파일이 바뀌면 화면이 트리/열린 탭을 갱신한다
      getIndex(root);   // 파일 감시 시작
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      let set = sseClients.get(root); if (!set) sseClients.set(root, (set = new Set()));
      set.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
      res.on('close', () => { clearInterval(hb); set.delete(res); });
      return;
    }
    case 'GET /api/git/repos': { // 작업 폴더 안의 모든 repo 와 변경된 파일
      const list = await findRepos(root), out = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(6, list.length) }, async () => {
        while (next < list.length) {
          const abs = list[next++], base = { abs, rel: path.relative(root, abs), name: path.basename(abs) };
          try { const st = await gitStatus(abs); st.files.forEach((f) => { const rp = path.relative(root, path.join(abs, f.path)); f.rp = rp.startsWith('..') || path.isAbsolute(rp) ? null : rp; });   // 작업 폴더 기준 경로 (트리 표시용)
          out.push({ ...base, ...st, hasRemote: !!(await git(abs, ['remote'])).trim() }); } catch (e) { out.push({ ...base, error: gitMsg(e), files: [] }); }
        }
      }));
      out.sort((a, b) => a.abs.localeCompare(b.abs));
      return send(res, 200, { root, repos: out });
    }
    case 'GET /api/git/diff': { // 변경 내용 (HEAD 대비). 새 파일은 전체를 추가로 표시
      const repo = await gitRepoOf(root, url.searchParams.get('repo')), f = url.searchParams.get('file') || '';
      resolveSafe(repo, f);
      let diff = '';
      try { diff = await git(repo, ['diff', 'HEAD', '--no-color', '--', f]); }
      catch { try { diff = await git(repo, ['diff', '--no-color', '--', f]); } catch {} }   // 첫 커밋 전에는 HEAD 가 없다
      if (!diff.trim()) {
        const r = spawnSync('git', ['-C', repo, 'diff', '--no-color', '--no-index', '--', '/dev/null', f], { env: GIT_VIEW_ENV, maxBuffer: 4 << 20 });   // 추적되지 않는 새 파일 (변경이 있으면 종료 코드 1)
        diff = String(r.stdout || '');
      }
      const MAX = 200000;
      return send(res, 200, { diff: diff.length > MAX ? diff.slice(0, MAX) + '\n… (이하 생략)' : diff });
    }
    case 'POST /api/git/commit': { // 선택한 파일만 커밋 (선택 사항: 이어서 push)
      const { repo: r, files, message, push } = JSON.parse(await readBody(req));
      const repo = await gitRepoOf(root, r);
      if (typeof message !== 'string' || !message.trim()) throw httpError(400, '커밋 메시지를 입력하세요');
      if (!Array.isArray(files) || !files.length || !files.every((f) => typeof f === 'string' && f)) throw httpError(400, '커밋할 파일을 선택하세요');
      for (const f of files) resolveSafe(repo, f);
      try {
        await git(repo, ['add', '-A', '--', ...files]);
        await git(repo, ['commit', '-m', message.trim(), '--', ...files]);
      } catch (e) { throw httpError(500, gitMsg(e)); }
      let pushed = false, pushErr = '';
      if (push) { try { await gitPush(repo); pushed = true; } catch (e) { pushErr = e.message; } }
      return send(res, 200, { ok: true, pushed, pushErr });
    }
    case 'POST /api/git/push': {
      const { repo: r } = JSON.parse(await readBody(req));
      await gitPush(await gitRepoOf(root, r));
      return send(res, 200, { ok: true });
    }
    case 'POST /api/git/pull': { // fast-forward 만 허용 (병합 커밋/충돌을 만들지 않는다)
      const { repo: r } = JSON.parse(await readBody(req));
      try { await git(await gitRepoOf(root, r), ['pull', '--ff-only'], { timeout: 120000 }); } catch (e) { throw httpError(500, gitMsg(e)); }
      return send(res, 200, { ok: true });
    }
    case 'POST /api/reveal': { // Finder / 파일 관리자 / 터미널 / 기본 앱으로 열기
      const { action = 'reveal' } = JSON.parse((await readBody(req)) || '{}');
      const abs = resolveSafe(root, p), st = await fsp.stat(abs), isDir = st.isDirectory();
      const run = (cmd, args) => { const c = spawn(cmd, args, { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); };
      if (action === 'open' && !isDir && (st.mode & 0o111)) throw httpError(403, 'executable files are not opened'); // 실행 파일은 열지 않는다
      if (process.platform === 'darwin') {
        if (action === 'reveal') run('open', isDir ? [abs] : ['-R', abs]);            // 폴더는 열고, 파일은 Finder 에서 선택
        else if (action === 'open') run('open', [abs]);                                // 기본 앱
        else if (action === 'terminal') run('open', ['-a', 'Terminal', isDir ? abs : path.dirname(abs)]);
        else throw httpError(400, 'bad action');
      } else {
        if (action === 'reveal') run('xdg-open', [isDir ? abs : path.dirname(abs)]);
        else if (action === 'open') run('xdg-open', [abs]);
        else throw httpError(400, 'bad action');
      }
      return send(res, 200, { ok: true });
    }
    case 'GET /api/imginfo': { // 이미지 픽셀 크기/용량 (헤더만 읽음)
      const abs = resolveSafe(root, p), st = await fsp.stat(abs);
      if (!st.isFile() || !IMG_MIME[path.extname(abs).toLowerCase()]) throw httpError(415, 'not an image');
      return send(res, 200, await imageInfo(abs, st));
    }
    case 'POST /api/update/apply': {
      if (updateJob?.state === 'running') throw httpError(409, 'update already running');
      const job = (updateJob = { state: 'running', kind: installKind().kind, log: [], error: null, manual: null });
      doUpdate(job).catch((e) => { job.state = 'error'; job.error = (e.stderr || e.message || String(e)).trim().split('\n').slice(-3).join(' / '); });
      return send(res, 200, { ok: true });
    }
    case 'GET /api/update/status':
      return send(res, 200, updateJob || { state: 'idle' });
    case 'GET /api/update':
      return send(res, 200, await checkUpdate(url.searchParams.get('force') === '1'));
    case 'GET /api/info':
      getIndex(root); // 워크스페이스를 열면 인덱싱 시작
      return send(res, 200, { app: 'shooting-star', root, name: path.basename(root) || root, home: HOME, last: readLast() || defaultWorkspace(), memoDir: ensureMemoDir(), version: VERSION, build: BUILD, dir: __dirname, pid: process.pid, platform: process.platform });
    case 'GET /api/browse': { // 폴더 선택기: 절대경로의 하위 폴더 목록
      const dir = fs.realpathSync(path.resolve((p || defaultWorkspace()).replace(/^~(?=$|\/)/, HOME)));
      const ents = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => url.searchParams.get('dot') === '1' || !e.name.startsWith('.'));   // 숨김 항목은 '.' 로 시작하는 이름을 치고 있을 때만
      const isD = (e) => e.isDirectory() || (e.isSymbolicLink() && isDirSafe(path.join(dir, e.name)));
      const byName = (a, b) => a.localeCompare(b);
      const list = ents.filter(isD).map((e) => e.name).sort(byName);
      const files = url.searchParams.get('files') === '1' ? ents.filter((e) => !isD(e)).map((e) => e.name).sort(byName) : undefined;   // 파일 열기(⌘O)용
      return send(res, 200, { path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, dirs: list, files });
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
      const dirRel = (url.searchParams.get('dir') || '').replace(/^\/+|\/+$/g, ''); // 폴더 안에서만 검색
      if (dirRel) { const st = await fsp.stat(resolveSafe(root, dirRel)).catch(() => null); if (!st?.isDirectory()) throw httpError(400, 'no such folder'); }
      return send(res, 200, await searchFiles(root, { dir: dirRel, q, cs: flag('case'), word: flag('word'), regex: flag('regex'), glob: url.searchParams.get('glob') || '', exts }, ac.signal));
    }
    case 'GET /api/files': {
      const ix = getIndex(root);
      if (!ix.ready) await ix.building;
      else if (!ix.watcher && Date.now() - ix.ts > 10000) rebuild(root, ix); // 감시 불가 시 TTL
      return send(res, 200, indexFiles(ix));
    }
    case 'GET /api/memos': { // 메모 목록 (최근 수정 순). q 가 있으면 제목+본문 검색
      const q = (url.searchParams.get('q') || '').toLowerCase(), out = [];
      for (const name of await fsp.readdir(ensureMemoDir())) {
        if (!name.endsWith('.md')) continue;
        const abs = path.join(MEMO_DIR, name);
        let st, text;
        try { st = await fsp.stat(abs); text = (await fsp.readFile(abs, 'utf8')).slice(0, 200000); } catch { continue; }
        if (q && !(name + '\n' + text).toLowerCase().includes(q)) continue;
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const plain = (t) => t.replace(/^#+\s*/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();   // 이미지/링크 문법 제외
        out.push({ name, mtime: st.mtimeMs, title: plain(lines[0] || '') || (lines[0] ? '(이미지)' : '제목 없음'), snippet: plain(lines[1] || '').slice(0, 90) });
      }
      return send(res, 200, out.sort((a, b) => b.mtime - a.mtime));
    }
    case 'GET /api/matchdirs': { // 지정한 확장자의 파일이 (하위 포함) 존재하는 폴더들. 비우면 파일이 있는 모든 폴더.
      const ix = getIndex(root); if (!ix.ready) await ix.building;
      const exts = new Set((url.searchParams.get('exts') || '').split(',').map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean));
      const dirs = new Set();
      for (const f of indexFiles(ix)) {
        if (exts.size && !exts.has(path.extname(f).slice(1).toLowerCase())) continue;
        for (let d = f.lastIndexOf('/'); d > 0; d = f.lastIndexOf('/', d - 1)) { const dir = f.slice(0, d); if (dirs.has(dir)) break; dirs.add(dir); }
      }
      return send(res, 200, [...dirs]);
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
    case 'POST /api/upload': { // 마크다운에 붙여넣은/끌어놓은 이미지를 <문서 폴더>/images/ 에 저장
      const rel = String(p).split('/').filter(Boolean);
      if (rel.length < 2 || rel.at(-2) !== 'images') throw httpError(400, 'images 폴더에만 저장할 수 있습니다');
      let name = rel.at(-1).normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+/, '').slice(-100);
      const ext = path.extname(name).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp'].includes(ext)) throw httpError(415, '지원하지 않는 이미지 형식');
      const buf = await readRaw(req, 30 * 1048576);
      if (!buf.length || !sniffImage(buf, ext)) throw httpError(415, '이미지 파일이 아닙니다');
      const dirRel = rel.slice(0, -1).join('/'), dir = resolveSafe(root, dirRel);
      await fsp.mkdir(dir, { recursive: true });
      const stem = name.slice(0, name.length - ext.length) || 'image', sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
      for (let i = 0; i < 1000; i++) {
        const cand = i ? `${stem}-${i}${ext}` : `${stem}${ext}`, abs = path.join(dir, cand);
        try { await fsp.writeFile(abs, buf, { flag: 'wx' }); return send(res, 200, { path: `${dirRel}/${cand}`, name: cand, reused: false }); }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          if (sha(await fsp.readFile(abs)) === sha(buf)) return send(res, 200, { path: `${dirRel}/${cand}`, name: cand, reused: true });   // 같은 이미지를 다시 붙여넣으면 재사용
        }
      }
      throw httpError(409, 'too many files with the same name');
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
  } catch {
    send(res, 404, `shooting-star: 파일을 찾을 수 없습니다: ${pathname}\n\n서버 설치 위치: ${__dirname}\npublic 폴더: ${PUBLIC} (${fs.existsSync(path.join(PUBLIC, 'index.html')) ? 'index.html 있음' : 'index.html 없음 — 설치 폴더가 삭제/이동되었을 수 있습니다'})\n서버 버전: v${VERSION}\n\n해결: 터미널에서 \`ss --stop\` 후 앱을 다시 여세요. 진단: \`ss --doctor\``, 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (process.env.SS_LOG) fs.appendFileSync(process.env.SS_LOG, `${req.method} ${req.url.slice(0, 80)} | ${req.headers['user-agent']}\n`);
    // DNS rebinding / 타 사이트에서의 요청 방지
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]', HOST].includes(host)) throw httpError(403, 'bad host');
    if (url.pathname === '/raw' || url.pathname === '/thumb') { // 이미지: 원본 / 화면용 축소본
      const abs = resolveSafe(rootOf(req, url), url.searchParams.get('path') || '');
      const ext = path.extname(abs).toLowerCase(), type = IMG_MIME[ext];
      if (!type) throw httpError(415, 'unsupported');
      const st = await fsp.stat(abs); if (!st.isFile()) throw httpError(404, 'not a file');
      const csp = { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };   // SVG 를 직접 열어도 스크립트가 실행되지 않게
      if (url.pathname === '/thumb') {
        const w = Math.min(4096, Math.max(256, Number(url.searchParams.get('w')) || 2048));
        const t = await thumbFor(abs, st, w);
        if (t) return sendFile(req, res, t.file, t.type, await fsp.stat(t.file));
      }
      return sendFile(req, res, abs, type, st, csp);
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers['x-ss'] !== '1') throw httpError(403, 'missing header');
      return await api(req, res, url, rootOf(req, url));
    }
    await serveStatic(res, decodeURIComponent(url.pathname));
  } catch (e) {
    const status = e.status || (e.code === 'ENOENT' ? 404 : 500);
    send(res, status, { error: e.message, ...(typeof e.code === 'string' && /^(NO_DRIVER|READ_ONLY)$/.test(e.code) ? { code: e.code } : {}) });
  }
});

// ───────── 실행 / 창 열기 ─────────
// 실제 포트는 실행 시점에 정해진다: 선호 포트(기본 4000)가 다른 프로그램에 쓰이면 다음 빈 포트를 쓰고, ~/.shooting-star/server.json 에 기록한다.
const STATE_FILE = path.join(HOME, '.shooting-star', 'server.json');
const LOG_FILE = path.join(HOME, '.shooting-star', 'server.log');
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } };
const writeState = () => { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify({ port: ACTIVE_PORT, pid: process.pid, root: DEFAULT_ROOT, version: VERSION }) + '\n'); };
let ACTIVE_PORT = PORT;
const baseOf = (port) => `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`;
const appUrl = () => {
  const last = LAST && (readLast() || defaultWorkspace()); // --last: 마지막으로 연 폴더, 없으면 기본 프로젝트 위치
  return `${baseOf(ACTIVE_PORT)}/?root=${encodeURIComponent(last || DEFAULT_ROOT)}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function infoAt(port) { // 그 포트에 '우리' 서버가 있으면 /api/info, 아니면(다른 프로그램/없음) null
  try { const j = await (await fetch(`${baseOf(port)}/api/info`, { signal: AbortSignal.timeout(1500) })).json(); return j.app === 'shooting-star' ? j : null; } catch { return null; }
}
const runningAt = async (port) => !!(await infoAt(port));
async function findServer() { // { port, info } | null
  const st = readState();
  for (const p of [...new Set([st?.port, PORT].filter(Boolean))]) { const info = await infoAt(p); if (info) return { port: p, info }; }
  return null;
}
async function quitAt(port) {
  try { await fetch(`${baseOf(port)}/api/quit`, { method: 'POST', headers: { 'X-SS': '1' }, signal: AbortSignal.timeout(2000) }); } catch {}
  for (let i = 0; i < 30 && (await runningAt(port)); i++) await sleep(100);
}
// Chromium 계열이 있으면 주소창 없는 독립 창(--app)으로, 없으면 기본 브라우저로 연다
function nativeApp() { // install.sh 가 만든 네이티브 macOS 앱 (shooting-star.app)
  if (process.platform !== 'darwin' || process.env.SS_NATIVE === '0') return null;
  for (const d of [path.join(HOME, 'Applications'), '/Applications']) {
    const p = path.join(d, 'shooting-star.app');
    if (fs.existsSync(path.join(p, 'Contents/Resources/config.json'))) return p;
  }
  return null;
}
function openWindow(url) {
  const sh = (c) => exec(c, () => {});
  const native = nativeApp();
  if (native) return sh(`open -a "${native}" "shooting-star://open?url=${encodeURIComponent(url)}"`);
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

function listenAuto(port, left = 20) { // 사용 중인 포트는 건너뛰고 다음 포트를 시도
  const onError = async (e) => {
    server.removeListener('error', onError);
    if (e.code === 'EADDRINUSE' && left > 0) {
      if (await runningAt(port)) { console.log('이미 실행 중'); process.exit(0); }   // 이미 우리 서버가 떠 있음
      return listenAuto(port + 1, left - 1);
    }
    console.error(e.message); process.exit(1);
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.removeListener('error', onError);
    ACTIVE_PORT = port; writeState(); setTimeout(pruneThumbs, 8000).unref();
    if (port !== PORT) console.log(`포트 ${PORT} 은(는) 다른 프로그램이 사용 중이라 ${port} 를 사용합니다`);
    console.log(`shooting-star → ${appUrl()}`);
    if (!NO_OPEN) openWindow(appUrl());
  });
}
process.on('exit', () => { const st = readState(); if (st && st.pid === process.pid) try { fs.unlinkSync(STATE_FILE); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

function doctor() { // 설치/실행 상태 진단 (문제 신고 시 이 출력을 붙여 주세요)
  const line = (k, v) => console.log(k.padEnd(18) + v);
  console.log(`shooting-star doctor  (${new Date().toISOString()})`);
  line('버전', `v${VERSION}`); line('node', `${process.version}  ${process.execPath}`);
  line('플랫폼', `${process.platform} ${process.arch} ${os.release()}`);
  line('서버 위치', __dirname);
  line('public/index.html', fs.existsSync(path.join(PUBLIC, 'index.html')) ? '있음' : '없음  ← 설치 폴더가 삭제/이동되었을 수 있음');
  line('상태 파일', fs.existsSync(STATE_FILE) ? JSON.stringify(readState()) : '없음');
  return (async () => {
    for (let p = PORT; p <= PORT + 5; p++) {
      const info = await infoAt(p); let who = '';
      if (!info) { const r = spawnSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN']); who = (r.stdout || '').toString().trim().split('\n')[1] || ''; }
      line(`포트 ${p}`, info ? `shooting-star v${info.version ?? '?'} (pid ${info.pid ?? '?'}, 위치 ${info.dir ?? '알 수 없음(구버전)'})` : who ? `다른 프로그램: ${who.replace(/\s+/g, ' ').slice(0, 70)}` : '비어 있음');
    }
    try { const t = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-8).join('\n'); if (t) console.log(`\n--- 최근 로그 (${LOG_FILE})\n${t}`); } catch {}
  })();
}

async function main() {
  if (DOCTOR) return doctor();
  if (STOP || STATUS) {
    const found = await findServer();
    if (STATUS) {
      if (!found) { console.log('실행 중이 아닙니다'); const l = (() => { try { return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch { return ''; } })(); if (l) console.log('--- 최근 로그 (' + LOG_FILE + ')\n' + l); return; }
      console.log(`실행 중: ${baseOf(found.port)}  (pid ${found.info.pid ?? '?'}, v${found.info.version ?? '?'}, 위치 ${found.info.dir ?? '알 수 없음'})`); return;
    }
    if (!found) return console.log('실행 중이 아닙니다');
    await quitAt(found.port); console.log('stopped');
    return;
  }
  if (FG) return listenAuto(PORT);   // 포그라운드 서버
  // 기본: 백그라운드로 띄우고(이미 있으면 재사용) 이 폴더를 창으로 연다 — `code .` 처럼
  let found = await findServer();
  if (found && (found.info.dir !== __dirname || found.info.version !== VERSION || found.info.build !== BUILD)) {
    // 다른 설치 위치/버전의 서버가 떠 있으면(업데이트 후 남은 프로세스, 지워진 폴더 등) 재사용하지 않고 재시작한다
    console.log(`다른 ${found.info.dir !== __dirname ? '위치' : found.info.version !== VERSION ? '버전' : '코드'}의 서버(v${found.info.version ?? '?'}, ${found.info.dir ?? '위치 불명'})가 실행 중이라 재시작합니다`);
    await quitAt(found.port); found = null;
  }
  let port = found?.port ?? null;
  if (!port) {
    const before = readState()?.pid;
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const log = fs.openSync(LOG_FILE, 'a');   // 서버의 오류 출력은 로그 파일로 (시작 실패 원인 확인용)
    spawn(process.execPath, [__filename, '--fg', '--no-open', '--port', String(PORT), '--host', HOST, DEFAULT_ROOT],
      { detached: true, stdio: ['ignore', log, log], cwd: DEFAULT_ROOT }).unref();
    for (let i = 0; i < 80 && !port; i++) {
      await sleep(100);
      const st = readState();
      if (st && st.pid !== before && (await runningAt(st.port))) port = st.port;
    }
    if (!port) { console.error(`서버를 시작하지 못했습니다. 로그: ${LOG_FILE}  /  진단: ss --doctor`); process.exit(1); }
  }
  ACTIVE_PORT = port;
  if (!NO_OPEN) openWindow(appUrl());
  console.log(`shooting-star → ${DEFAULT_ROOT}  (${baseOf(port)})`);
}
main();
