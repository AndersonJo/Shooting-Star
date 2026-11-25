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
if (process.argv[2] === 'secret') { require('./secret').cli(process.argv.slice(3)).then((c) => process.exit(c)); return; }
const RUN = require('./run');
const SECRET = require('./secret');
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
// ───────── 첨부 (이미지 / 파일) ─────────
// 새 첨부는 <기준 폴더>/.ss/assets/images/YYYYMMDD/ · .ss/assets/files/YYYYMMDD/ 에 모은다. 문서에는 문서 기준 상대 링크를 넣는다.
// 기준 폴더 = 문서가 속한 git repo 루트 (push 할 때 문서와 함께 올라가도록). 문서 폴더에서 위로 올라가며
// .ss/assets 가 이미 있거나 .git 이 있는 가장 가까운 폴더, repo 가 아니면 워크스페이스 루트. (프로젝트의 assets/ 와 섞이지 않게 .ss/ 아래)
// 메모(~/.shooting-star/memos)는 따로: memos/images/ · memos/files/ (날짜 폴더 없음)
// 기존 문서 옆 images/ 링크는 그대로 동작한다 (상대 경로라 렌더러는 바뀌지 않음). /api/assets/migrate 로 옮길 수 있다.
const ASSETS = '.ss/assets', UPLOAD_MAX = 2 * 1024 * 1048576, UPLOAD_IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp']);
const isMemoRoot = (root) => { try { return root === fs.realpathSync(MEMO_DIR); } catch { return false; } };
const dayStamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const posixRel = (from, to) => path.relative(from, to).split(path.sep).join('/');
function assetBase(root, dirAbs) { // 첨부를 모을 기준 폴더 (절대경로): 문서의 git repo 루트
  const atTop = root === path.parse(root).root;   // 워크스페이스 밖 파일(@ext, root=/)
  for (let d = dirAbs; ; d = path.dirname(d)) {
    if (isDirSafe(path.join(d, ASSETS)) || fs.existsSync(path.join(d, '.git'))) return d;   // .git 은 폴더(일반) 또는 파일(submodule·worktree)
    if ((!atTop && d === root) || path.dirname(d) === d) break;   // 워크스페이스 밖으로는 나가지 않는다 (앱이 보여 줄 수 없음)
  }
  return atTop ? dirAbs : root;
}
function assetDir(root, dirAbs, kind) { // kind: 'images' | 'files'
  if (isMemoRoot(root)) return path.join(root, kind);
  return path.join(assetBase(root, dirAbs), ASSETS, kind, dayStamp());
}
const sanitizeName = (n) => String(n).normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+/, '').replace(/-+(\.[^.]*)?$/, '$1').slice(-120) || 'file';
async function hashFile(abs) {
  const h = crypto.createHash('sha1');
  await new Promise((ok, no) => fs.createReadStream(abs).on('data', (c) => h.update(c)).on('end', ok).on('error', no));
  return h.digest('hex');
}
async function readHead(abs, n = 4096) {
  const fh = await fsp.open(abs, 'r');
  try { const b = Buffer.alloc(n); const { bytesRead } = await fh.read(b, 0, n, 0); return b.subarray(0, bytesRead); } finally { await fh.close(); }
}
// tmp 를 dir/name 으로 넣는다. 같은 이름이 있으면 내용이 같을 때 그것을 재사용, 다르면 name-1, name-2 …
// 같은 종류의 다른 날짜 폴더에 같은 이름·같은 내용이 있어도 재사용한다 (siblings: 찾아볼 폴더들)
async function placeFile(tmp, dir, name, { size, sha, siblings = [] }) {
  for (const d of siblings) {
    const cand = path.join(d, name);
    try { if ((await fsp.stat(cand)).size === size && (await hashFile(cand)) === sha) { await fsp.unlink(tmp).catch(() => {}); return { abs: cand, reused: true }; } } catch {}
  }
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length) || 'file';
  for (let i = 0; i < 1000; i++) {
    const cand = path.join(dir, i ? `${stem}-${i}${ext}` : name);
    try { await fsp.link(tmp, cand); await fsp.unlink(tmp).catch(() => {}); return { abs: cand, reused: false }; }   // link 는 있으면 EEXIST 로 실패한다 (덮어쓰지 않음)
    catch (e) {
      if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'ENOTSUP') { // 하드 링크가 안 되는 파일 시스템
        try { await fsp.copyFile(tmp, cand, fs.constants.COPYFILE_EXCL); await fsp.unlink(tmp).catch(() => {}); return { abs: cand, reused: false }; } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
      } else if (e.code !== 'EEXIST') throw e;
      try { const st = await fsp.stat(cand); if (st.size === size && (await hashFile(cand)) === sha) { await fsp.unlink(tmp).catch(() => {}); return { abs: cand, reused: true }; } } catch {}
    }
  }
  await fsp.unlink(tmp).catch(() => {});
  throw httpError(409, 'too many files with the same name');
}
async function datedSiblings(dir) { // assets/images/20261101 → assets/images/* (같은 종류의 날짜 폴더들)
  if (isMemoRoot(path.dirname(dir))) return [];
  const up = path.dirname(dir);
  try { return (await fsp.readdir(up, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => path.join(up, e.name)); } catch { return []; }
}
// 업로드 본문을 임시 파일로 받으며 크기/해시를 잰다 (큰 파일도 메모리에 올리지 않는다)
async function receiveTo(req, tmp, limit) {
  const h = crypto.createHash('sha1'); let size = 0;
  const out = fs.createWriteStream(tmp, { flags: 'wx' });
  try {
    await new Promise((ok, no) => {
      req.on('data', (c) => { size += c.length; if (size > limit) { no(httpError(413, `too large (>${Math.round(limit / 1048576)}MB)`)); req.destroy(); return; } h.update(c); if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()); } });
      req.on('end', ok); req.on('error', no); out.on('error', no);
    });
    await new Promise((ok, no) => out.end((e) => (e ? no(e) : ok())));
  } catch (e) { out.destroy(); await fsp.unlink(tmp).catch(() => {}); throw e; }
  return { size, sha: h.digest('hex') };
}
async function uploadAttachment(req, root, docRel, rawName) {
  const docAbs = resolveSafe(root, docRel), docDir = path.dirname(docAbs);
  const name = sanitizeName(rawName), ext = path.extname(name).toLowerCase();
  const stage = isMemoRoot(root) ? root : assetBase(root, docDir);
  await fsp.mkdir(path.join(stage, isMemoRoot(root) ? '' : ASSETS), { recursive: true });
  const tmp = path.join(stage, isMemoRoot(root) ? '' : ASSETS, `.ss-upload-${crypto.randomBytes(6).toString('hex')}`);
  const { size, sha } = await receiveTo(req, tmp, UPLOAD_MAX);
  if (!size) { await fsp.unlink(tmp).catch(() => {}); throw httpError(400, '빈 파일입니다'); }
  const isImg = UPLOAD_IMG_EXT.has(ext) && sniffImage(await readHead(tmp), ext);   // 확장자만 이미지인 파일은 일반 첨부로
  const dir = assetDir(root, docDir, isImg ? 'images' : 'files');
  const { abs, reused } = await placeFile(tmp, dir, name, { size, sha, siblings: (await datedSiblings(dir)).filter((d) => d !== dir) });
  return { path: posixRel(root, abs), link: posixRel(docDir, abs), name: path.basename(abs), kind: isImg ? 'image' : 'file', size, reused };
}

// ───────── 기존 문서 옆 images/ → assets/images/ 로 옮기기 ─────────
// 마크다운 문서들의 링크(![](…), [](…), [id]: …, <img src>, <a href> 등)를 모두 찾아,
// 모든 참조를 바꿀 수 있는 이미지만 옮기고 링크를 고친다. 바꿀 수 없으면(다른 종류 파일이 참조, 암호화 문서가 있는 폴더 …) 그대로 둔다.
const LINK_RES = [
  /\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/gd,             // [글](대상 "제목") / ![](대상)
  /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gmd,                                              // [id]: 대상
  /<(?:img|a|source|video|audio|embed|iframe)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/gid,   // HTML
];
function maskCode(text) { // 코드 블록·인라인 코드 안은 링크로 보지 않도록 같은 길이의 공백으로 가린다
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let out = '', fence = null, buf = '';
  for (const line of text.split(/(?<=\n)/)) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { buf += blank(line); if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) { out += buf; buf = ''; fence = null; } continue; }
    if (f) { fence = f[1]; buf = blank(line); continue; }
    out += line;
  }
  out += fence ? buf : '';
  return out.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`])\1(?!`)/g, (m) => blank(m));
}
function findLinks(text) { // → [{ start, end, target }] (start/end: 원문에서 대상 문자열 위치, <> 포함)
  const masked = maskCode(text), out = [];
  for (const re of LINK_RES) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(masked))) {
      const ix = m.indices[1] || m.indices[2]; if (!ix) continue;
      out.push({ start: ix[0], end: ix[1], target: text.slice(ix[0], ix[1]) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
function linkTarget(raw) { // → { pathPart, suffix, angle } | null (웹 주소·절대경로·앵커는 제외)
  const angle = raw.startsWith('<') && raw.endsWith('>'); let s = angle ? raw.slice(1, -1) : raw;
  if (!s || /^[a-z][a-z0-9+.-]*:|^\/\/|^\/|^#/i.test(s)) return null;
  const cut = s.search(/[?#]/), pathPart = cut < 0 ? s : s.slice(0, cut), suffix = cut < 0 ? '' : s.slice(cut);
  let dec = pathPart; try { dec = decodeURI(pathPart); } catch {}
  return { dec, suffix, angle };
}
const encLink = (p, angle) => (angle ? `<${p}>` : p.replace(/%/g, '%25').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E'));
// 옮길 대상: ① 문서 옆 images/ (예전 방식) ② 날짜 폴더 첨부 assets/(images|files)/YYYYMMDD/ · .ss/assets/… 가 문서의 repo 밖에 있는 것 (이전 버전이 워크스페이스 루트에 둔 것)
const isLegacyImg = (rel) => { const segs = rel.split('/'); if (segs.includes('.ss')) return null; const i = segs.lastIndexOf('images', segs.length - 2); return i >= 0 && segs[i - 1] !== 'assets' ? segs.slice(0, i + 1).join('/') : null; };   // 프로젝트의 assets/images/… 는 건드리지 않는다
const DATED_RE = /(?:^|\/)(\.ss\/)?assets\/(images|files)\/(\d{8})\/[^/]+$/;
const LEFTOVER_DIR = (n) => ['images', 'files', 'assets', '.ss'].includes(n) || /^\d{8}$/.test(n);
async function migrateAssets(root, scope, apply) {
  const ix = getIndex(root); if (!ix.ready) await ix.building;
  if (ix.pending.size) { clearTimeout(ix.timer); await flush(root, ix); }   // 방금 생긴 파일까지 보고 판단한다
  const files = indexFiles(ix), fileSet = new Set(files);
  const inScope = (rel) => !scope || rel === scope || rel.startsWith(scope + '/');
  const mdDocs = files.filter((f) => MD_EXT.has(path.extname(f).slice(1).toLowerCase()));
  const encDirs = new Set(files.filter((f) => f.endsWith('.enc')).map((f) => path.posix.dirname(f)));
  const refs = new Map(), docText = new Map(), baseCache = new Map();   // 파일 rel → [{ doc, start, end, suffix, angle }]
  const docBase = (doc) => { const d = path.dirname(path.join(root, doc)); if (!baseCache.has(d)) baseCache.set(d, assetBase(root, d)); return baseCache.get(d); };
  for (const doc of mdDocs) {
    let text; try { const abs = path.join(root, doc); if ((await fsp.stat(abs)).size > 4 * 1048576) continue; text = await fsp.readFile(abs, 'utf8'); } catch { continue; }
    const dir = path.posix.dirname(doc) === '.' ? '' : path.posix.dirname(doc);
    for (const l of findLinks(text)) {
      const t = linkTarget(l.target); if (!t) continue;
      const rel = path.posix.normalize((dir ? dir + '/' : '') + t.dec);
      if (rel.startsWith('..') || !fileSet.has(rel) || !(isLegacyImg(rel) || DATED_RE.test(rel))) continue;
      if (!refs.has(rel)) refs.set(rel, []);
      refs.get(rel).push({ doc, start: l.start, end: l.end, suffix: t.suffix, angle: t.angle });
      docText.set(doc, text);
    }
  }
  // 파일마다: 참조하는 문서의 repo 별로 목적지를 정한다. 이미 제자리인 참조는 그대로 (그 경우 원본도 남긴다)
  const work = [];
  for (const [rel, list] of refs) {
    if (!inScope(rel) && !list.some((r) => inScope(r.doc))) continue;
    const abs = path.join(root, rel), dm = DATED_RE.exec(rel), groups = new Map(); let keep = false;
    for (const r of list) {
      const base = docBase(r.doc), home = path.join(base, ASSETS) + path.sep;
      if (dm && (abs.startsWith(home) || (!dm[1] && abs.startsWith(base + path.sep)))) { keep = true; continue; }   // 이미 그 repo 의 .ss/assets 안, 또는 repo 안에 있는 예전 assets/ (push 에 문제 없음)
      const kind = dm ? dm[2] : 'images';
      if (!groups.has(base)) groups.set(base, { kind, list: [] });
      groups.get(base).list.push(r);
    }
    if (groups.size) work.push({ rel, abs, date: dm?.[3] || null, groups, keep });
  }
  const skipped = [], moves = [];
  // 원본을 지울 파일: 마크다운이 아닌 텍스트 파일(html 등)이 이름을 언급하면 링크를 고칠 수 없으니 옮기지 않는다
  const names = new Map(); for (const w of work) if (!w.keep) { const b = path.posix.basename(w.rel); if (!names.has(b)) names.set(b, []); names.get(b).push(w.rel); }
  const mentioned = new Map();
  if (names.size) {
    const re = new RegExp([...names.keys()].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    const others = files.filter((f) => { const e = path.extname(f).slice(1).toLowerCase(); return !MD_EXT.has(e) && !BINARY_EXT.has(e) && !IMG_MIME['.' + e] && !f.endsWith('.enc'); }).slice(0, 30000);
    await mapLimit(others, 16, async (f) => {
      try { const abs = path.join(root, f); if ((await fsp.stat(abs)).size > 1048576) return; const buf = await fsp.readFile(abs); if (buf.subarray(0, 4000).includes(0)) return;
        for (const m of buf.toString('utf8').matchAll(re)) for (const rel of names.get(m[0]) || []) if (!mentioned.has(rel)) mentioned.set(rel, f);
      } catch {}
    });
  }
  const unref = files.filter((f) => isLegacyImg(f) && inScope(f) && IMG_MIME[path.extname(f).toLowerCase()] && !refs.has(f)).length;
  for (const w of work) {
    if (!w.keep) {
      const lg = isLegacyImg(w.rel), dirs = [...(lg ? [path.posix.dirname(lg)] : []), ...[...w.groups.values()].flatMap((g) => g.list.map((r) => path.posix.dirname(r.doc)))];
      if (dirs.some((d) => encDirs.has(d))) { skipped.push({ path: w.rel, reason: '암호화 문서가 있는 폴더 (참조를 확인할 수 없음)' }); continue; }
      if (mentioned.has(w.rel)) { skipped.push({ path: w.rel, reason: `다른 파일에서 언급: ${mentioned.get(w.rel)}` }); continue; }
    }
    moves.push(w);
  }
  const bytes = (await Promise.all(moves.map((m) => fsp.stat(m.abs).then((s) => s.size, () => 0)))).reduce((a, b) => a + b, 0);
  const docCount = new Map(); for (const m of moves) for (const g of m.groups.values()) for (const r of g.list) docCount.set(r.doc, (docCount.get(r.doc) || 0) + 1);
  const repos = new Set(); for (const m of moves) for (const b of m.groups.keys()) repos.add(posixRel(root, b) || '.');
  const summary = { files: moves.length, bytes, docs: [...docCount].map(([p, n]) => ({ path: p, links: n })), repos: [...repos], skipped, unreferenced: unref };
  if (!apply) return summary;

  // 1) repo 별로 복사 (같은 내용이 이미 있으면 재사용) 2) 링크 고치기 3) 원본 지우기 (아직 쓰는 참조가 없을 때) 4) 빈 폴더 정리
  const edits = new Map(), failed = [], removed = []; let moved = 0;
  for (const m of moves) {
    try {
      const st = await fsp.stat(m.abs), sha = await hashFile(m.abs), name = sanitizeName(path.basename(m.rel)), done = [];
      for (const [base, g] of m.groups) {
        const dir = path.join(base, ASSETS, g.kind, m.date || dayStamp(st.mtime));
        await fsp.mkdir(dir, { recursive: true });
        const tmp = path.join(dir, `.ss-move-${crypto.randomBytes(6).toString('hex')}`);
        await fsp.copyFile(m.abs, tmp);
        const { abs } = await placeFile(tmp, dir, name, { size: st.size, sha, siblings: [dir, ...(await datedSiblings(dir))] });
        await fsp.utimes(abs, st.atime, st.mtime).catch(() => {});
        done.push([abs, g.list]);
      }
      for (const [abs, list] of done) for (const r of list) {
        const link = encLink(posixRel(path.dirname(path.join(root, r.doc)), abs), r.angle);
        if (!edits.has(r.doc)) edits.set(r.doc, []);
        edits.get(r.doc).push({ start: r.start, end: r.end, text: r.angle ? link.slice(0, -1) + r.suffix + '>' : link + r.suffix });
      }
      if (!m.keep && !done.some(([abs]) => abs === m.abs)) { await fsp.unlink(m.abs); removed.push(m.abs); }
      moved++;
    } catch (e) { failed.push({ path: m.rel, reason: e.message }); }
  }
  for (const [doc, list] of edits) {
    let text = docText.get(doc);
    for (const e of list.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    await fsp.writeFile(path.join(root, doc), text);
  }
  for (const d of [...new Set(removed.map((f) => path.dirname(f)))].sort((a, b) => b.length - a.length)) { // 비었으면 위로 올라가며 지운다 (images · files · assets · .ss · 날짜 폴더만)
    for (let cur = d; cur.startsWith(root + path.sep) && LEFTOVER_DIR(path.basename(cur)); cur = path.dirname(cur)) {
      try { const left = (await fsp.readdir(cur)).filter((n) => n !== '.DS_Store'); if (left.length) break; await fsp.rm(cur, { recursive: true }); } catch { break; }
    }
  }
  markDirty(root);
  return { ...summary, moved, failed };
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
// 이미지 갤러리: 폴더 하나의 이미지(픽셀 크기 포함, 이름 자연 정렬) + 하위 폴더(이미지 수, 대표 이미지). 재귀하지 않는다.
const GALLERY_MAX = 5000;
const isImgName = (n) => !!IMG_MIME[path.extname(n).toLowerCase()];
const natCmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => { while (i < arr.length) { const k = i++; out[k] = await fn(arr[k]); } }));
  return out;
}
// 메모리 캐시: 이미지 픽셀 크기(파일 크기·수정 시각이 같으면 헤더를 다시 읽지 않는다), 하위 폴더 요약(폴더 수정 시각이 같으면 다시 읽지 않는다)
const dimCache = new Map();   // 절대경로 → { size, mtime, w, h }
const subCache = new Map();   // 절대경로 → { mtime, images, cover, coverMtime }
const capMap = (m, n) => { if (m.size > n) for (const k of [...m.keys()].slice(0, m.size - n * 0.8)) m.delete(k); };
async function galleryList(dir) {
  const ents = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.') && !IGNORE.has(e.name));
  const dirs = [], imgs = []; let others = 0;
  for (const e of ents) {
    if (e.isDirectory() || (e.isSymbolicLink() && isDirSafe(path.join(dir, e.name)))) dirs.push(e.name);
    else if (isImgName(e.name)) imgs.push(e.name); else others++;
  }
  dirs.sort(natCmp); imgs.sort(natCmp);
  const images = (await mapLimit(imgs.slice(0, GALLERY_MAX), 16, async (name) => {
    try {
      const abs = path.join(dir, name), st = await fsp.stat(abs); if (!st.isFile()) return null;
      const mtime = Math.round(st.mtimeMs), c = dimCache.get(abs);
      if (c && c.size === st.size && c.mtime === mtime) return { name, w: c.w, h: c.h, size: st.size, mtime };
      let dim = imageSize(await readHead(abs, 65536));
      if (!dim && /\.jpe?g$/i.test(name)) dim = imageSize(await readHead(abs));   // EXIF 가 큰 JPEG 는 SOF 가 뒤에 있다
      dimCache.delete(abs); dimCache.set(abs, { size: st.size, mtime, w: dim?.w || null, h: dim?.h || null });
      return { name, w: dim?.w || null, h: dim?.h || null, size: st.size, mtime };
    } catch { return null; }   // 쓰는 중이거나 방금 지워진 파일
  })).filter(Boolean);
  const subs = await mapLimit(dirs.slice(0, 500), 16, async (name) => {
    const sub = path.join(dir, name);
    try {
      const mt = (await fsp.stat(sub)).mtimeMs, c = subCache.get(sub);
      let v = c && c.mtime === mt ? c : null;
      if (!v) {
        const ns = (await fsp.readdir(sub)).filter((n) => !n.startsWith('.') && isImgName(n)).sort(natCmp);
        v = { mtime: mt, images: ns.length, cover: ns[0] || null, coverMtime: 0 };
        subCache.delete(sub); subCache.set(sub, v);
      }
      if (v.cover) { try { v.coverMtime = Math.round((await fsp.stat(path.join(sub, v.cover))).mtimeMs); } catch { v.coverMtime = 0; } }   // 대표 이미지 내용이 바뀐 것은 폴더 시각에 안 나온다
      return { name, images: v.images, cover: v.cover, coverMtime: v.coverMtime };
    } catch { return { name, images: 0, cover: null, coverMtime: 0 }; }
  });
  capMap(dimCache, 200000); capMap(subCache, 20000);
  return { path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, dirs: subs, images, others, total: imgs.length, truncated: imgs.length > GALLERY_MAX };
}

// ───────── 파일 복사/붙여넣기 (갤러리 ⌘C/⌘X → 트리 폴더·갤러리 ⌘V) ─────────
// macOS 는 시스템 클립보드에 '파일'로 올린다 → Finder·메신저·업로드 칸에도 붙여넣을 수 있고, Finder 에서 ⌘C 한 파일도 여기로 붙여넣을 수 있다.
// changeCount 로 "우리가 올린 그대로인지"를 판단한다 (그 사이 다른 것을 복사했으면 클립보드 쪽을 따른다). 그 밖의 OS 는 웹 UI 안에서만.
const PB_WRITE = `ObjC.import('AppKit');function run(a){const pb=$.NSPasteboard.generalPasteboard;pb.clearContents;if(a.length)pb.writeObjects($(a.map((p)=>$.NSURL.fileURLWithPath(p))));return String(pb.changeCount)}`;
const PB_READ = `ObjC.import('AppKit');function run(){const pb=$.NSPasteboard.generalPasteboard,o=$.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true),$.NSPasteboardURLReadingFileURLsOnlyKey),r=pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL),o),out=[];if(r&&!r.isNil())for(let i=0;i<r.count;i++)out.push(ObjC.unwrap(r.objectAtIndex(i).path));return JSON.stringify({cc:Number(pb.changeCount),paths:out})}`;
async function clipWrite(paths) {
  if (process.platform !== 'darwin') return { cc: null };
  return { cc: Number((await execP('osascript', ['-l', 'JavaScript', '-e', PB_WRITE, ...paths], { timeout: 10000 })).trim()) };
}
async function clipRead() {
  if (process.platform !== 'darwin') return { cc: null, paths: null };
  return JSON.parse(await execP('osascript', ['-l', 'JavaScript', '-e', PB_READ], { timeout: 10000 }));
}
async function freeName(dir, name, isDir) { // 같은 이름이 있으면 Finder 처럼 '이름 2.jpg', '이름 3.jpg' … (폴더는 '이름 2')
  const ext = isDir ? '' : path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const cand = i === 1 ? name : `${stem} ${i}${ext}`;
    try { await fsp.lstat(path.join(dir, cand)); } catch (e) { if (e.code === 'ENOENT') return cand; throw e; }
  }
  throw httpError(409, 'too many files with the same name');
}
async function fsTransfer(srcs, dest, move) { // 덮어쓰지 않는다 (이름이 겹치면 번호를 붙임). 하나가 실패해도 나머지는 계속
  const destReal = await fsp.realpath(dest);
  if (!(await fsp.stat(destReal)).isDirectory()) throw httpError(400, 'not a directory');
  const done = [], skipped = [], errors = [];
  for (const src of srcs) {
    const name = path.basename(src);
    try {
      const st = await fsp.lstat(src);
      if (move && (await fsp.realpath(path.dirname(src))) === destReal) { skipped.push(name); continue; }   // 이미 그 폴더에 있음
      if (st.isDirectory()) { const s = await fsp.realpath(src); if (destReal === s || destReal.startsWith(s + path.sep)) { errors.push(`${name}: 폴더를 자기 안으로 넣을 수 없습니다`); continue; } }
      const to = path.join(destReal, await freeName(destReal, name, st.isDirectory()));
      const cp = () => fsp.cp(src, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
      if (!move) await cp();
      else { try { await fsp.rename(src, to); } catch (e) { if (e.code !== 'EXDEV') throw e; await cp(); await fsp.rm(src, { recursive: true }); } }   // 다른 디스크: 복사 후 원본 삭제
      done.push({ from: src, to, renamed: path.basename(to) !== name });
    } catch (e) { errors.push(`${name}: ${e.code === 'ENOENT' ? '원본이 없습니다' : e.message}`); }
  }
  return { dest: destReal, done, skipped, errors };
}
const dirWatchers = new Map(); // 절대경로 → { w, clients, names, timer } : 갤러리 화면이 보고 있는 폴더 (재귀 X)
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
const MEDIA_MIME = { '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg' };
function sendFile(req, res, abs, type, st, extra = {}) { // ETag 로 재검증(304) + 스트리밍 (큰 이미지를 통째로 메모리에 올리지 않는다). Range(206): 영상·음악 탐색
  const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
  const headers = { ETag: etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', ...extra };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2]) && st.size) {
    let a = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), b = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (a > b || a >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, ...headers }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${st.size}`, ...headers });
    return fs.createReadStream(abs, { start: a, end: b }).on('error', () => res.destroy()).pipe(res);
  }
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

// ───────── 암호화 문서 (*.enc) ─────────
// git 에 평문이 올라가지 않도록 문서 전체를 암호화해서 저장한다. 암호는 요청 헤더로만 받고 서버에 남기지 않는다.
// 형식: MAGIC | salt(16) | iv(12) | tag(16) | 암호문. scrypt 로 키를 만들고 AES-256-GCM 으로 암호화 (머리글도 인증). NUL 이 있어 git 은 바이너리로 다룬다.
const ENC_MAGIC = Buffer.from('SSENC\0\x01', 'latin1'), ENC_HEAD = ENC_MAGIC.length + 16 + 12, ENC_MIN = ENC_HEAD + 16;
const isEncPath = (p) => String(p).endsWith('.enc');
const passOf = (req) => { const v = req.headers['x-ss-pass']; if (!v) throw httpError(423, 'locked'); return decodeURIComponent(v); };
const encKey = (pass, salt) => new Promise((resolve, reject) => crypto.scrypt(pass.normalize('NFC'), salt, 32, { N: 2 ** 16, r: 8, p: 1, maxmem: 96 * 1048576 }, (e, k) => (e ? reject(e) : resolve(k))));
async function encryptDoc(text, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), head = Buffer.concat([ENC_MAGIC, salt, iv]);
  const c = crypto.createCipheriv('aes-256-gcm', await encKey(pass, salt), iv); c.setAAD(head);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([head, c.getAuthTag(), body]);
}
async function decryptDoc(buf, pass) {
  if (buf.length < ENC_MIN || !buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) throw httpError(415, 'shooting-star 암호화 파일이 아닙니다');
  const salt = buf.subarray(ENC_MAGIC.length, ENC_MAGIC.length + 16), iv = buf.subarray(ENC_MAGIC.length + 16, ENC_HEAD);
  const d = crypto.createDecipheriv('aes-256-gcm', await encKey(pass, salt), iv); d.setAAD(buf.subarray(0, ENC_HEAD)); d.setAuthTag(buf.subarray(ENC_HEAD, ENC_MIN));
  try { return Buffer.concat([d.update(buf.subarray(ENC_MIN)), d.final()]).toString('utf8'); } catch { throw httpError(401, '암호가 맞지 않습니다'); }
}
async function writeAtomic(abs, buf) { // 쓰다 끊겨도 암호문이 깨지지 않도록 (깨지면 복구할 수 없다)
  const tmp = `${abs}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { await fsp.writeFile(tmp, buf, { flag: 'wx' }); await fsp.rename(tmp, abs); } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
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
      if (rel) invalidateGitStat(path.join(root, String(name)));   // .git 안(커밋·스테이징)도 포함해 그 repo 의 git 상태 캐시를 버린다
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
    .then((r) => { ix.set = new Set(r.files); ix.arr = null; ix.mt = null; ix.truncated = r.truncated; ix.ready = true; ix.ts = Date.now(); })
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
    if (ix.mt) { ix.mt.delete(rel); const pre = rel + '/'; for (const f of ix.mt.keys()) if (f.startsWith(pre)) ix.mt.delete(f); }
    if (ix.heads) { ix.heads.delete(rel); const pre = rel + '/'; for (const f of ix.heads.keys()) if (f.startsWith(pre)) ix.heads.delete(f); }   // 제목 캐시도 다시 읽게
  }
  ix.arr = null; ix.ts = Date.now();
  broadcast(root, rels);   // 인덱스를 먼저 갱신한 뒤 알린다 (화면이 필터 폴더 목록을 다시 받을 때 최신이 되도록)
}
function markDirty(root) { // 우리 API 로 만든 변경은 감시 이벤트가 오기 전에도 반영
  const ix = indexes.get(root); if (!ix || ix.watcher) return;
  rebuild(root, ix);
}

// ───────── 마크다운 제목 인덱스 (Shift×2 검색에서 # 제목까지 찾기) ─────────
// 파일별로 mtime 과 함께 캐시한다. 감시 중이면 flush 가 바뀐 파일의 캐시를 지우고, 감시 불가면 매번 mtime 을 비교한다.
const MD_EXT = new Set(['md', 'markdown', 'mdx']), HEADS_FILE_MAX = 1024 * 1024, HEADS_FILES_MAX = 20000;
function parseHeadings(text) { // ATX 제목(# ~ ######)만. 코드 블록·앞머리(--- yaml ---) 안의 # 은 제외. → [[줄(1부터), 단계, 글]]
  const lines = text.split('\n'), out = []; let fence = null, i = 0;
  if (/^---\s*$/.test(lines[0] || '')) { for (i = 1; i < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[i]); i++); i = i < lines.length ? i + 1 : 0; }   // 닫는 --- 가 없으면 앞머리가 아니다
  for (; i < lines.length; i++) {
    const l = lines[i], f = l.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1]; else if (f[1][0] === fence[0] && f[1].length >= fence.length && !l.trim().slice(f[1].length).trim()) fence = null; continue; }
    if (fence) continue;
    const m = l.match(/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/); if (!m) continue;
    const t = m[2].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/\s+/g, ' ').trim();
    if (t) out.push([i + 1, m[1].length, t.slice(0, 300)]);
  }
  return out;
}
async function headingsOf(root, ix) {
  if (!ix.heads) ix.heads = new Map();   // rel → { m: mtimeMs, h: [[줄, 단계, 글]] }
  const files = indexFiles(ix).filter((f) => MD_EXT.has(path.extname(f).slice(1).toLowerCase())).slice(0, HEADS_FILES_MAX);
  const next = new Map(), out = [];
  for (let k = 0; k < files.length; k += 64) {
    await Promise.all(files.slice(k, k + 64).map(async (f) => {
      let e = ix.heads.get(f);
      if (!e || !ix.watcher) {
        try {
          const st = await fsp.stat(path.join(root, f));
          if (!e || e.m !== st.mtimeMs) e = { m: st.mtimeMs, h: st.size > HEADS_FILE_MAX ? [] : parseHeadings(await fsp.readFile(path.join(root, f), 'utf8')) };
        } catch { e = null; }
      }
      if (e) next.set(f, e);
    }));
  }
  ix.heads = next;
  for (const [f, e] of next) for (const h of e.h) out.push([f, ...h]);
  return out;
}

// ───────── 최근 수정한 문서 (사이드바 '최신 문서') ─────────
// 인덱스의 마크다운(.md/.markdown/.mdx, 암호화 .md.enc 포함) 파일을 수정 시각순으로. 감시 중이면 flush 가 바뀐 파일의 캐시를 지운다.
const isDocRel = (f) => { const m = f.toLowerCase().replace(/\.enc$/, '').match(/\.([^./]+)$/); return !!m && MD_EXT.has(m[1]); };
async function recentDocs(root, ix, n) {
  if (!ix.mt) ix.mt = new Map();   // rel → mtimeMs
  const files = indexFiles(ix).filter(isDocRel).slice(0, HEADS_FILES_MAX), next = new Map();
  for (let k = 0; k < files.length; k += 128) {
    await Promise.all(files.slice(k, k + 128).map(async (f) => {
      let m = ix.watcher ? ix.mt.get(f) : undefined;
      if (m == null) { try { m = (await fsp.stat(path.join(root, f))).mtimeMs; } catch { return; } }
      next.set(f, m);
    }));
  }
  ix.mt = next;
  return [...next].sort((a, b) => b[1] - a[1]).slice(0, n).map(([path, mtime]) => ({ path, mtime }));
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

// git 상태 캐시: 파일을 저장할 때마다 워크스페이스의 모든 repo 에 git status 를 돌리지 않도록, 감시 이벤트가 들어온 repo 만 다시 읽는다.
// fresh 요청(창으로 돌아올 때·git 보기·새로고침·커밋 후)은 repo 목록까지 전부 다시 읽는다.
const repoListCache = new Map();   // root → { list, at }
const gitStatCache = new Map();    // repo 절대경로 → { st, hasRemote, gen }
const gitGen = new Map();          // repo 절대경로 → 변경 세대 (status 를 읽는 도중 바뀌면 그 결과는 캐시하지 않는다)
function invalidateGitStat(abs) {
  for (const [repo, n] of gitGen) if (abs === repo || abs.startsWith(repo + path.sep)) { gitGen.set(repo, n + 1); gitStatCache.delete(repo); }
}
async function cachedRepos(root, fresh) {
  const c = repoListCache.get(root);
  if (!fresh && c && Date.now() - c.at < 120000) return c.list;
  const list = await findRepos(root); repoListCache.set(root, { list, at: Date.now() });
  return list;
}
async function cachedGitStat(repo, fresh) {
  if (!gitGen.has(repo)) gitGen.set(repo, 0);
  const gen = gitGen.get(repo), c = gitStatCache.get(repo);
  if (!fresh && c && c.gen === gen) return c;
  const st = await gitStatus(repo), hasRemote = fresh || !c ? !!(await git(repo, ['remote'])).trim() : c.hasRemote;
  const v = { st, hasRemote, gen };
  if (gitGen.get(repo) === gen) gitStatCache.set(repo, v);
  return v;
}

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

// ───────── Git 히스토리: 저장소 전체 / 파일 / 폴더 / 선택한 줄, blame, PR·브랜치, 원격 웹 주소 ─────────
// 요청 경로(워크스페이스 기준) → 그 파일이 들어 있는 repo 와 repo 기준 경로
async function gitTarget(root, p) {
  const abs0 = resolveSafe(root, p);
  let abs = abs0; try { abs = fs.realpathSync(abs0); } catch {}
  const isDir = isDirSafe(abs), dir = isDir ? abs : path.dirname(abs);
  let repo;
  try { repo = fs.realpathSync((await git(dir, ['rev-parse', '--show-toplevel'])).trim()); } catch { throw httpError(400, 'git 저장소 안의 파일이 아닙니다'); }
  const rel = path.relative(repo, abs).split(path.sep).join('/');
  return { repo, rel: rel.startsWith('..') ? '' : rel, isDir, abs };
}
// 원격 주소 → 웹 주소. git@host:o/r.git · ssh://git@host:22/o/r · https://user:tok@host/o/r.git (자격 증명은 버린다)
async function parseRemote(u) {
  u = String(u || '').trim(); let host, rest, m;
  if ((m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u))) {
    if (!/^(https?|ssh|git|git\+ssh|ssh\+git)$/i.test(m[1])) return null;
    host = m[2]; rest = m[3];
  } else if ((m = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(u))) { host = m[1]; rest = m[2]; }   // scp 형식
  else return null;
  rest = rest.replace(/\/+$/, '').replace(/\.git$/, '');
  if (!/^[^/]+\/.+/.test(rest)) return null;
  if (!host.includes('.')) {   // ~/.ssh/config 의 별칭 (예: github-work) → 실제 호스트
    try { const h = /^hostname\s+(\S+)/m.exec(await execP('ssh', ['-G', host], { timeout: 3000 })); if (h) host = h[1]; } catch {}
  }
  host = host.toLowerCase();
  const kind = host.includes('gitlab') ? 'gitlab' : host === 'bitbucket.org' ? 'bitbucket' : 'github';
  return { base: `https://${host}/${rest}`, host, path: rest, kind };
}
const webCache = new Map();   // repo → { t, web, remote }
async function gitWeb(repo) {
  const c = webCache.get(repo); if (c && Date.now() - c.t < 60000) return c;
  let remote = '', web = null;
  try {
    const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
    try { remote = (await git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim().split('/')[0]; } catch {}
    if (!remotes.includes(remote)) remote = remotes.includes('origin') ? 'origin' : remotes[0] || '';
    if (remote) web = await parseRemote(await git(repo, ['remote', 'get-url', remote]));
  } catch {}
  const v = { t: Date.now(), web, remote }; webCache.set(repo, v); return v;
}
async function gitRepoInfo(repo) {
  const out = { abs: repo, name: path.basename(repo), branch: '', head: '', web: null };
  try { out.branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch {}
  try { out.head = (await git(repo, ['rev-parse', 'HEAD'])).trim(); } catch {}
  out.web = (await gitWeb(repo)).web;
  return out;
}
// 편집 중인 내용(content)의 줄 범위 → HEAD 버전의 줄 범위. 커밋 안 된 새 줄뿐이면 null
async function mapLinesToHead(repo, rel, a, b, content) {
  let head;
  try { head = await git(repo, ['show', `HEAD:${rel}`], { maxBuffer: 64 << 20 }); } catch { return null; }   // HEAD 에 없는 파일
  if (content == null) { try { content = await fsp.readFile(path.join(repo, rel), 'utf8'); } catch { return { a, b }; } }
  if (content === head) return { a, b };
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ss-l-'));
  try {
    await fsp.writeFile(path.join(tmp, 'a'), head); await fsp.writeFile(path.join(tmp, 'b'), content);
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '-U0', '--', path.join(tmp, 'a'), path.join(tmp, 'b')], { env: GIT_VIEW_ENV, maxBuffer: 64 << 20 });
    const hunks = [];
    for (const m of String(r.stdout || '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) hunks.push({ os: +m[1], oc: m[2] == null ? 1 : +m[2], ns: +m[3], nc: m[4] == null ? 1 : +m[4] });
    const lo = [], push = (x, y) => { lo.push(x, y); };
    for (let L = a; L <= b; L++) {
      let delta = 0, inside = null;
      for (const h of hunks) {
        if (h.nc && L >= h.ns && L < h.ns + h.nc) { inside = h; break; }
        if ((h.nc ? h.ns + h.nc - 1 : h.ns) < L) delta += h.oc - h.nc; else break;
      }
      if (!inside) push(L + delta, L + delta);
      else if (inside.oc) { push(inside.os, inside.os + inside.oc - 1); L = inside.ns + inside.nc - 1; }   // 고친 줄 → 원래 있던 줄들
    }
    if (!lo.length) return null;
    return { a: Math.min(...lo), b: Math.max(...lo) };
  } finally { fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}
const LOG_FMT = '%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s';
function parseLog(out, { names, patch } = {}) {
  const list = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const nl = rec.indexOf('\n'), head = nl < 0 ? rec : rec.slice(0, nl), rest = nl < 0 ? '' : rec.slice(nl + 1);
    const [h, s, an, ae, at, p, refs, subj] = head.split('\x1f');
    const c = { h, s, an, ae, at: +at, p: p ? p.split(' ') : [], refs: refs || '', subj: subj || '' };
    if (names) {   // --name-status: 이 커밋에서의 파일 경로 (이름이 바뀌었으면 이전 경로도)
      const ln = rest.split('\n').find((l) => /^[A-Z]\d*\t/.test(l));
      if (ln) { const f = ln.split('\t'); c.st = f[0][0]; if (f.length > 2) { c.from = f[1]; c.path = f[2]; } else c.path = f[1]; }
    }
    if (patch) c.patch = rest.replace(/^\n+/, '').slice(0, 60000);
    list.push(c);
  }
  return list;
}
async function gitLog(root, p, o) {
  const { repo, rel, isDir } = await gitTarget(root, p);
  const info = await gitRepoInfo(repo);
  if (!info.head) return { repo: info, rel, commits: [], more: false, note: '아직 커밋이 없습니다' };
  const n = Math.min(Math.max(+o.n || 100, 1), 300), skip = Math.max(+o.skip || 0, 0), q = String(o.q || '').trim();
  const scope = ['repo', 'file', 'dir', 'lines'].includes(o.scope) ? o.scope : 'repo';
  const out = { repo: info, rel: scope === 'repo' ? '' : rel, scope, commits: [], more: false };
  const fmt = ['--no-color', `--format=${LOG_FMT}`];
  if (scope === 'lines') {
    if (isDir || !rel) throw httpError(400, '파일이 아닙니다');
    let { ha, hb, head } = o;
    if (!ha || !hb || !head) {
      const a = Math.max(1, +o.a | 0), b = Math.max(a, +o.b | 0);
      const m = await mapLinesToHead(repo, rel, a, b, typeof o.content === 'string' ? o.content : null);
      if (!m) throw httpError(400, '선택한 줄은 아직 커밋되지 않았습니다');
      ha = m.a; hb = m.b; head = info.head;
    }
    if (!/^[0-9a-f]{7,64}$/i.test(head)) throw httpError(400, 'bad head');
    let raw;
    try { raw = await git(repo, ['log', ...fmt, `-L${+ha},${+hb}:${rel}`, `--skip=${skip}`, `-n${n + 1}`, head], { maxBuffer: 64 << 20, timeout: 60000 }); }
    catch (e) { throw httpError(400, gitMsg(e)); }
    out.commits = parseLog(raw, { patch: true }); out.range = { a: +o.a || +ha, b: +o.b || +hb, ha: +ha, hb: +hb, head };
  } else {
    const args = ['log', ...fmt];
    if (scope === 'file') args.push('--follow', '--name-status');
    if (q) {   // 메시지 · 작성자 · 해시 앞부분으로 찾기 (작성자/메시지 조건은 git 에서 AND 라 따로 돌려 합친다)
      const lim = ['-n300', '--regexp-ignore-case', '--fixed-strings'], tail = scope === 'repo' ? [] : ['--', rel || '.'];
      const runs = [git(repo, [...args, ...lim, `--grep=${q}`, ...tail]), git(repo, [...args, ...lim, `--author=${q}`, ...tail])];
      if (/^[0-9a-f]{4,40}$/i.test(q)) runs.push(git(repo, [...args, '-n1', q, ...tail]).catch(() => ''));
      const seen = new Set();
      out.commits = (await Promise.all(runs.map((r) => r.catch(() => '')))).flatMap((x) => parseLog(x, { names: scope === 'file' }))
        .filter((c) => !seen.has(c.h) && seen.add(c.h)).sort((x, y) => y.at - x.at).slice(0, 300);
      out.q = q; return out;
    }
    args.push(`--skip=${skip}`, `-n${n + 1}`);
    if (scope !== 'repo') args.push('--', rel || '.');
    out.commits = parseLog(await git(repo, args, { maxBuffer: 64 << 20 }), { names: scope === 'file' });
  }
  if (out.commits.length > n) { out.commits.length = n; out.more = true; }
  return out;
}
// 커밋 하나: 메타 + 바뀐 파일 + diff (only: 파일/폴더로 제한, 이름이 바뀐 파일은 old 도)
async function gitShow(root, p, o) {
  const { repo } = await gitTarget(root, p);
  const sha = String(o.sha || ''); if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw httpError(400, 'bad sha');
  let meta;
  try { meta = await git(repo, ['show', '-s', '--no-color', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%P%x1f%D%x1f%s%x1f%b', sha]); } catch (e) { throw httpError(404, gitMsg(e)); }
  const [h, an, ae, at, cn, ct, ps, refs, subj, ...body] = meta.replace(/\n$/, '').split('\x1f');
  const parents = ps ? ps.split(' ') : [];
  const range = parents.length ? [`${h}^1`, h] : [h];   // 병합 커밋은 첫 부모와 비교 (병합으로 들어온 변경 전체)
  const diffArgs = parents.length ? ['diff', '--no-color', '-M', ...range] : ['show', '--no-color', '-M', '--format=', h];
  const files = new Map();
  const ns = await git(repo, [...diffArgs, '--name-status', '-z'], { maxBuffer: 32 << 20 }).catch(() => '');
  const z = ns.split('\0'); for (let i = 0; i < z.length - 1;) { const st = z[i++]; if (!st) continue; const f = { st: st[0] }; if (/^[RC]/.test(st)) { f.from = z[i++]; } f.path = z[i++]; files.set(f.path, f); }
  const num = await git(repo, [...diffArgs, '--numstat', '-z'], { maxBuffer: 32 << 20 }).catch(() => '');
  const nz = num.split('\0'); for (let i = 0; i < nz.length;) {
    const rec = nz[i++]; if (!rec) continue; const [ad, dl, pth] = rec.split('\t'); let to = pth;
    if (pth === '') { i++; to = nz[i++]; }   // 이름 바뀜: 빈 경로 뒤에 이전/새 경로
    const f = files.get(to); if (f) { f.add = ad === '-' ? null : +ad; f.del = dl === '-' ? null : +dl; }
  }
  const out = { commit: { h, an, ae, at: +at, cn, ct: +ct, p: parents, refs, subj, body: body.join('\x1f').trim() }, files: [...files.values()].slice(0, 3000), nfiles: files.size };
  if (!o.nodiff) {
    const only = [o.only, o.old].filter((x) => typeof x === 'string' && x);
    const MAX = 400000;
    let diff = await git(repo, [...diffArgs, '--no-ext-diff', ...(only.length ? ['--', ...only] : [])], { maxBuffer: 64 << 20 }).catch((e) => { throw httpError(500, gitMsg(e)); });
    if (diff.length > MAX) { diff = diff.slice(0, diff.lastIndexOf('\n', MAX)); out.truncated = true; }
    out.diff = diff;
  }
  return out;
}
// PR 찾기: gh 가 있으면 GitHub API (정확), 없거나 실패하면 커밋 메시지/병합 커밋으로 추정
const GH = (() => {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(HOME, '.local/bin')]);
  for (const d of dirs) { const p = path.join(d, 'gh'); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {} }
  return null;
})();
const refsCache = new Map();   // repo:sha → { t, v }
async function ghPulls(repo, web, sha) {
  if (!GH || !web || web.kind !== 'github') return null;
  const args = ['api', '-H', 'Accept: application/vnd.github+json', `repos/${web.path}/commits/${sha}/pulls`];
  if (web.host !== 'github.com') args.push('--hostname', web.host);
  try {
    const list = JSON.parse(await execP(GH, args, { cwd: repo, timeout: 12000, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' } }));
    if (!Array.isArray(list)) return null;
    return list.map((x) => ({ n: x.number, title: x.title, url: x.html_url, state: x.merged_at ? 'merged' : x.draft ? 'draft' : x.state, head: x.head?.ref || '', base: x.base?.ref || '', by: x.user?.login || '' }));
  } catch { return null; }
}
const PR_RE = [/^Merge pull request #(\d+) from ([^\s]+)/, /\(#(\d+)\)\s*$/, /^Merged in ([^\s]+) \(pull request #(\d+)\)/, /^Merge branch '([^']+)' into [^\s]+/];
function prFromSubject(subj, web) {
  let m;
  if ((m = PR_RE[0].exec(subj))) return { n: +m[1], head: m[2].replace(/^[^/]+\//, ''), guess: true };   // owner/branch
  if ((m = PR_RE[2].exec(subj))) return { n: +m[2], head: m[1], guess: true };
  if ((m = PR_RE[1].exec(subj))) return { n: +m[1], guess: true };
  if ((m = /See merge request [^!]*!(\d+)/.exec(subj))) return { n: +m[1], guess: true };
  return null;
}
async function gitRefs(root, p, o) {
  const { repo } = await gitTarget(root, p);
  const sha = String(o.sha || ''); if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw httpError(400, 'bad sha');
  const key = repo + ':' + sha, c = refsCache.get(key); if (c && Date.now() - c.t < 5 * 60000) return c.v;
  const { web } = await gitWeb(repo);
  const v = { branches: [], nbranches: 0, tags: [], pr: [], prSource: null, merge: null, web };
  const [br, tg] = await Promise.all([
    git(repo, ['branch', '-a', '--contains', sha, '--format=%(refname)'], { timeout: 20000 }).catch(() => ''),
    git(repo, ['tag', '--contains', sha, '--sort=creatordate'], { timeout: 20000 }).catch(() => ''),
  ]);
  // 로컬 main 과 origin/main 은 하나로: { name, local, remote(웹 주소가 있는 원격에 있음) }
  const { remote } = await gitWeb(repo), byName = new Map();
  for (const s of br.split('\n').map((x) => x.trim())) {
    let m, name, isRemote = false;
    if ((m = /^refs\/heads\/(.+)$/.exec(s))) name = m[1];
    else if ((m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(s)) && m[2] !== 'HEAD') { name = m[1] === remote ? m[2] : `${m[1]}/${m[2]}`; isRemote = m[1] === remote; }
    else continue;
    const e = byName.get(name) || { name, local: false, remote: false }; if (isRemote) e.remote = true; else if (!m[0].startsWith('refs/remotes/')) e.local = true; byName.set(name, e);
  }
  const prio = (b) => (/^(main|master|develop|trunk)$/.test(b.name) ? 0 : 1);
  const all = [...byName.values()].sort((a, b) => prio(a) - prio(b) || a.name.localeCompare(b.name));
  v.nbranches = all.length; v.branches = all.slice(0, 40);
  v.tags = tg.split('\n').filter(Boolean).slice(0, 5);   // 처음 들어간 태그부터
  const gh = await ghPulls(repo, web, sha);   // 배열(비어 있을 수 있음) = GitHub 의 답, null = gh 없음/실패
  v.prSource = gh ? 'gh' : 'git'; v.ghFailed = !gh && !!GH && web?.kind === 'github';
  if (gh) v.pr = gh;
  if (!gh || !gh.length) {
    // 이 커밋 자체가 병합/squash 커밋이거나, 이 커밋을 들여온 병합 커밋의 메시지에서 PR 번호·브랜치를 찾는다
    const subj = (await git(repo, ['show', '-s', '--format=%s', sha]).catch(() => '')).trim();
    let pr = prFromSubject(subj, web);
    if (!pr) {
      const tip = (await git(repo, ['rev-parse', '--verify', '-q', 'origin/HEAD']).catch(() => '')).trim() || 'HEAD';
      const merges = await git(repo, ['log', '--no-color', '--ancestry-path', '--merges', '--reverse', '--format=%H%x1f%s', `${sha}..${tip}`], { timeout: 20000, maxBuffer: 32 << 20 }).catch(() => '');
      for (const ln of merges.split('\n').slice(0, 400)) {
        const [mh, ms = ''] = ln.split('\x1f'); if (!mh) continue;
        const g = prFromSubject(ms, web), mb = PR_RE[3].exec(ms);
        if (g || mb) { pr = g; v.merge = { h: mh, subj: ms, branch: g?.head || mb?.[1] || '' }; break; }
      }
    }
    if (pr && !gh) v.pr = [{ n: pr.n, head: pr.head || v.merge?.branch || '', title: '', url: '', state: '', guess: true }];
  }
  refsCache.set(key, { t: Date.now(), v });
  if (refsCache.size > 500) refsCache.delete(refsCache.keys().next().value);
  return v;
}
// git blame (편집 중인 내용 그대로: --contents -). 줄마다 커밋 번호, 커밋 목록은 따로
function gitBlame(repo, rel, content) {
  return new Promise((resolve, reject) => {
    const args = ['-c', 'core.quotepath=off', '-C', repo, 'blame', '--porcelain', ...(typeof content === 'string' ? ['--contents', '-'] : []), '--', rel];
    const ch = spawn('git', args, { env: GIT_VIEW_ENV });
    let out = '', err = '';
    ch.stdout.setEncoding('utf8'); ch.stdout.on('data', (d) => { out += d; if (out.length > 128 << 20) ch.kill(); });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('error', reject);
    ch.on('close', (code) => {
      if (code !== 0) return reject(httpError(400, /no such path|no such ref|not in HEAD|fatal: no such path/i.test(err) ? 'git 에 커밋된 적이 없는 파일입니다' : err.trim().split('\n').slice(-3).join('\n') || 'blame 실패'));
      const commits = [], idx = new Map(), lines = []; let curC = null;
      for (const ln of out.split('\n')) {
        if (ln.startsWith('\t')) continue;
        const m = /^([0-9a-f]{40,64}) (\d+) (\d+)/.exec(ln);
        if (m) {
          if (!idx.has(m[1])) { idx.set(m[1], commits.length); commits.push({ h: m[1], an: '', at: 0, subj: '', fn: '' }); }
          curC = commits[idx.get(m[1])]; lines.push(idx.get(m[1])); continue;
        }
        if (!curC) continue;
        if (ln.startsWith('author ')) curC.an = ln.slice(7);
        else if (ln.startsWith('author-time ')) curC.at = +ln.slice(12);
        else if (ln.startsWith('summary ')) curC.subj = ln.slice(8);
        else if (ln.startsWith('filename ')) curC.fn = ln.slice(9);
      }
      for (const c of commits) if (/^0+$/.test(c.h)) { c.wip = true; c.an = ''; c.subj = '커밋 안 된 변경'; }
      resolve({ commits, lines });
    });
    if (typeof content === 'string') ch.stdin.end(content); else ch.stdin.end();
    ch.stdin.on('error', () => {});
  });
}
// 원격 웹에서 파일/폴더/줄을 여는 고정 주소: HEAD 가 원격에 올라가 있으면 커밋 해시, 아니면 원격 브랜치 이름
async function gitPermalink(root, p, o) {
  const { repo, rel, isDir } = await gitTarget(root, p);
  const { web, remote } = await gitWeb(repo);
  if (!web) throw httpError(400, '원격 저장소(remote) 웹 주소를 알 수 없습니다');
  const notes = [];
  let ref = '';
  const head = (await git(repo, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  if (head) {
    const remoteHas = (await git(repo, ['branch', '-r', '--contains', head], { timeout: 15000 }).catch(() => '')).trim();
    if (remoteHas) ref = head;
  }
  if (!ref) {
    let up = (await git(repo, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')).trim();
    if (!up) up = (await git(repo, ['rev-parse', '--abbrev-ref', `${remote}/HEAD`]).catch(() => '')).trim();
    ref = up ? up.slice(up.indexOf('/') + 1) : 'HEAD';
    notes.push(head ? `푸시하지 않은 커밋이 있어 원격 브랜치(${ref}) 기준으로 엽니다` : '');
  }
  let a = +o.a || 0, b = +o.b || 0;
  if (a && !isDir) {
    const m = await mapLinesToHead(repo, rel, a, Math.max(a, b), typeof o.content === 'string' ? o.content : null);
    if (!m) { notes.push('선택한 줄은 아직 커밋되지 않아 파일만 엽니다'); a = b = 0; }
    else { if (m.a !== a || m.b !== Math.max(a, b)) notes.push(`커밋되지 않은 변경이 있어 줄 번호를 ${m.a}–${m.b} 로 맞췄습니다`); a = m.a; b = m.b; }
  }
  return { web, ref, rel, isDir, a, b, note: notes.filter(Boolean).join(' · ') };
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
      fs.mkdirSync(RUN.DIR, { recursive: true });   // UI 가 이 폴더를 감시한다 (첫 등록 전에도)
      return send(res, 200, { scripts: RUN.list().map(({ scriptPath, ...m }) => ({ ...m, scriptPath })), dir: RUN.DIR, running: [...RUN.jobs.values()].filter((j) => !j.endedAt).map((j) => ({ id: j.id, name: j.name })), history: RUN.history(30), secrets: SECRET.list().map((x) => x.name) });
    case 'POST /api/run/exec': { // 등록된 이름만 실행한다 (임의 명령 실행 아님)
      const { name, params, preset, cols, rows } = JSON.parse(await readBody(req));
      const job = RUN.start(RUN.get(name), params && typeof params === 'object' ? params : {}, { cwd: root, source: 'ui', shellEnv: true, color: true, pty: { cols, rows }, preset: typeof preset === 'string' && preset ? preset : null });
      return send(res, 200, { id: job.id, cmdline: job.cmdline, cwd: job.cwd, git: job.git, startedAt: job.startedAt });
    }
    case 'GET /api/run/where': { // 실행 전 미리보기: 어디서(작업 폴더) 어떤 브랜치로 실행되는지
      const dir = RUN.workdirOf(RUN.get(url.searchParams.get('name') || ''), root);
      return send(res, 200, { cwd: dir, git: RUN.gitInfo(dir) });
    }
    case 'GET /api/run/branches': { // 실행 위치 repo 의 브랜치 (최근 커밋 순). 원격에만 있는 것은 따로
      const dir = RUN.workdirOf(RUN.get(url.searchParams.get('name') || ''), root);
      let out; try { out = await git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)\t%(HEAD)', 'refs/heads', 'refs/remotes']); } catch (e) { throw httpError(400, gitMsg(e)); }
      const local = [], remote = []; let current = null;
      for (const l of out.split('\n')) {
        const [ref, head] = l.split('\t'); if (!ref) continue;
        if (ref.startsWith('refs/heads/')) { const b = ref.slice(11); local.push(b); if (head === '*') current = b; }
        else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) { const r = ref.slice(13); remote.push({ ref: r, name: r.slice(r.indexOf('/') + 1) }); }
      }
      const seen = new Set(local);
      return send(res, 200, { current, local, remote: remote.filter((r) => !seen.has(r.name) && seen.add(r.name)) });
    }
    case 'POST /api/run/checkout': { // 실행 위치에서 브랜치 전환 (git switch: 원격 브랜치면 추적 브랜치를 만든다. 변경과 충돌하면 git 이 거절)
      const { name, branch } = JSON.parse(await readBody(req));
      if (typeof branch !== 'string' || !branch || branch.startsWith('-')) throw httpError(400, '브랜치 이름이 올바르지 않습니다');
      const dir = RUN.workdirOf(RUN.get(name || ''), root);
      if ([...RUN.jobs.values()].some((j) => !j.endedAt && j.cwd === dir)) throw httpError(409, '이 위치에서 실행 중인 스크립트가 있어 브랜치를 바꿀 수 없습니다');
      try { await git(dir, ['switch', branch]); } catch (e) { throw httpError(500, gitMsg(e)); }
      return send(res, 200, { cwd: dir, git: RUN.gitInfo(dir) });
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
      return send(res, 200, { name, script: m.scriptPath, manifest: m.manifest });
    }
    case 'GET /api/run/export': // 본문까지 담은 YAML (다른 컴퓨터에서 `ss run add -` 로 등록)
      return send(res, 200, { yaml: RUN.exportYaml([url.searchParams.get('name') || '']) });
    case 'GET /api/secret/list':   // 이름/저장여부만 (값은 절대 안 보냄)
      return send(res, 200, { secrets: SECRET.list() });
    case 'PUT /api/secret': {
      const { name, value } = JSON.parse(await readBody(req));
      return send(res, 200, SECRET.set(String(name || ''), String(value ?? '')));
    }
    case 'DELETE /api/secret':
      SECRET.remove(url.searchParams.get('name') || '');
      return send(res, 200, { ok: true });

    case 'POST /api/run/env-reload':   // rc 가 source 하는 다른 파일이 바뀌었을 때 수동으로 다시 읽기
      RUN.loginEnv({ force: true });
      return send(res, 200, RUN.envInfo());
    case 'POST /api/run/install': // Claude 연동: skill + SessionStart hook + 실행 권한 (~/.claude)
      return send(res, 200, RUN.install());
    case 'DELETE /api/run/script': {
      RUN.remove(url.searchParams.get('name') || '');
      return send(res, 200, { ok: true });
    }
    case 'GET /api/db/connections':
      return send(res, 200, { connections: DB.listConnections(), kinds: Object.fromEntries(Object.entries(DB.KINDS).map(([k, v]) => [k, { label: v.label, port: v.port || null, file: !!v.file, pkg: v.pkg || null, driver: DB.driverState(k) }])) });
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
      return send(res, 200, await DB.children(url.searchParams.get('id') || '', { schema: url.searchParams.get('schema') || undefined, table: url.searchParams.get('table') || undefined }));
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
      return send(res, 200, await DB.names(url.searchParams.get('id') || ''));
    case 'POST /api/db/cache/clear': // 메타데이터 캐시 버리기 (id 없으면 전체)
      DB.clearCache(JSON.parse(await readBody(req)).id); return send(res, 200, { ok: true });
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
      const fresh = url.searchParams.get('fresh') === '1' || !indexes.get(root)?.watcher;   // 감시가 없으면 캐시를 믿을 수 없다
      const list = await cachedRepos(root, fresh), out = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(6, list.length) }, async () => {
        while (next < list.length) {
          const abs = list[next++], base = { abs, rel: path.relative(root, abs), name: path.basename(abs) };
          try {
            const { st, hasRemote } = await cachedGitStat(abs, fresh || !(abs === root || abs.startsWith(root + path.sep)));   // 작업 폴더 위쪽 repo 의 .git 은 감시 밖 → 항상 다시
            const files = st.files.map((f) => { const rp = path.relative(root, path.join(abs, f.path)); return { ...f, rp: rp.startsWith('..') || path.isAbsolute(rp) ? null : rp }; });   // 작업 폴더 기준 경로 (트리 표시용)
            out.push({ ...base, ...st, files, hasRemote });
          } catch (e) { out.push({ ...base, error: gitMsg(e), files: [] }); }
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
    case 'POST /api/git/log': return send(res, 200, await gitLog(root, p, JSON.parse((await readBody(req)) || '{}')));
    case 'POST /api/git/show': return send(res, 200, await gitShow(root, p, JSON.parse((await readBody(req)) || '{}')));
    case 'GET /api/git/refs': return send(res, 200, await gitRefs(root, p, { sha: url.searchParams.get('sha') }));
    case 'POST /api/git/permalink': return send(res, 200, await gitPermalink(root, p, JSON.parse((await readBody(req)) || '{}')));
    case 'POST /api/git/blame': {
      const { content } = JSON.parse((await readBody(req)) || '{}');
      const { repo, rel, isDir } = await gitTarget(root, p);
      if (isDir || !rel) throw httpError(400, '파일이 아닙니다');
      const r = await gitBlame(repo, rel, content);
      return send(res, 200, { ...r, repo: await gitRepoInfo(repo), rel });
    }
    case 'POST /api/open-url': { // 기본 브라우저로 웹 주소 열기 (응답을 기다린 뒤 여는 링크는 창 열기가 막힐 수 있어 서버가 연다)
      const { url: u } = JSON.parse((await readBody(req)) || '{}');
      if (typeof u !== 'string' || !/^https?:\/\/[^\s]+$/i.test(u) || u.length > 4000) throw httpError(400, 'bad url');
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      const c = spawn(cmd, [u], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref();
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
    case 'GET /api/gallery': { // 이미지 갤러리 목록
      const dir = await fsp.realpath(resolveSafe(root, p));
      if (!isDirSafe(dir)) throw httpError(400, 'not a directory');
      return send(res, 200, await galleryList(dir));
    }
    case 'POST /api/clip/write': { // 파일들을 시스템 클립보드에 올린다 (빈 목록 = 비우기)
      const { paths = [] } = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(paths) || paths.length > 10000) throw httpError(400, 'bad paths');
      return send(res, 200, await clipWrite(paths.map((x) => resolveSafe(root, String(x)))));
    }
    case 'POST /api/clip/read':   // 클립보드의 파일 경로 (POST: 다른 사이트가 읽어 가지 못하게 X-SS 헤더를 요구)
      return send(res, 200, await clipRead());
    case 'POST /api/fs/transfer': { // 복사(또는 move=true 이동)해서 dest 폴더에 넣는다
      const { paths = [], dest, move = false } = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(paths) || !paths.length || typeof dest !== 'string') throw httpError(400, 'bad request');
      const r = await fsTransfer(paths.map((x) => resolveSafe(root, String(x))), resolveSafe(root, dest), !!move);
      markDirty(root);
      return send(res, 200, r);
    }
    case 'POST /api/fs/trash': { // 휴지통으로 옮긴다 (macOS ~/.Trash · 그 밖 ~/.local/share/Trash/files). 결과의 from/to 로 되돌릴 수 있다
      const { paths = [] } = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(paths) || !paths.length) throw httpError(400, 'bad request');
      const trash = process.platform === 'darwin' ? path.join(HOME, '.Trash') : path.join(HOME, '.local/share/Trash/files');
      await fsp.mkdir(trash, { recursive: true });
      const r = await fsTransfer(paths.map((x) => resolveSafe(root, String(x))), trash, true);
      markDirty(root);
      return send(res, 200, r);
    }
    case 'GET /api/dirwatch': { // 폴더 하나의 변경을 SSE 로 알린다 (갤러리 자동 갱신)
      const dir = await fsp.realpath(resolveSafe(root, p));
      if (!isDirSafe(dir)) throw httpError(400, 'not a directory');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      let dw = dirWatchers.get(dir);
      if (!dw) {
        dw = { w: null, clients: new Set(), names: new Set(), timer: null };
        try {
          dw.w = fs.watch(dir, (_ev, name) => {
            if (name) dw.names.add(String(name));
            clearTimeout(dw.timer);
            dw.timer = setTimeout(() => { // 쓰는 중에는 이벤트가 여러 번 온다 → 잠잠해지면 한 번만
              const data = `data: ${JSON.stringify({ names: [...dw.names].slice(0, 500) })}\n\n`; dw.names.clear();
              for (const r of dw.clients) { try { r.write(data); } catch {} }
            }, 350);
          });
          dw.w.on('error', () => {});
        } catch {}
        dirWatchers.set(dir, dw);
      }
      dw.clients.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
      res.on('close', () => {
        clearInterval(hb); dw.clients.delete(res);
        if (!dw.clients.size) { try { dw.w?.close(); } catch {} clearTimeout(dw.timer); dirWatchers.delete(dir); }
      });
      return;
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
    case 'GET /api/headings': { // 마크다운 파일들의 # 제목: [[경로, 줄, 단계, 글]]
      const ix = getIndex(root);
      if (!ix.ready) await ix.building;
      else if (!ix.watcher && Date.now() - ix.ts > 10000) await rebuild(root, ix);
      return send(res, 200, await headingsOf(root, ix));
    }
    case 'GET /api/recent-docs': {
      const ix = getIndex(root);
      if (!ix.ready) await ix.building;
      else if (!ix.watcher && Date.now() - ix.ts > 10000) await rebuild(root, ix);
      const n = Math.max(1, Math.min(50, Number(url.searchParams.get('n')) || 5));
      return send(res, 200, await recentDocs(root, ix, n));
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
      if (isEncPath(abs)) return send(res, 200, { content: st.size ? await decryptDoc(buf, passOf(req)) : '', mtime: st.mtimeMs, size: st.size });
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
      if (isEncPath(abs)) await writeAtomic(abs, await encryptDoc(content, passOf(req)));   // 암호 없이는 쓰지 않는다 (평문이 디스크에 남지 않도록)
      else await fsp.writeFile(abs, content, 'utf8');
      return send(res, 200, { mtime: (await fsp.stat(abs)).mtimeMs });
    }
    case 'POST /api/crypt/lock': { // 평문 문서 → <이름>.enc (다시 풀어 본 뒤에 원본을 지운다)
      const abs = resolveSafe(root, p), dest = abs + '.enc', pass = passOf(req);
      if (isEncPath(abs)) throw httpError(400, '이미 암호화된 파일입니다');
      const st = await fsp.stat(abs);
      if (!st.isFile()) throw httpError(400, 'not a file');
      if (st.size > MAX_SIZE) throw httpError(413, 'file too large (>5MB)');
      if (fs.existsSync(dest)) throw httpError(409, 'target exists');
      const buf = await fsp.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) throw httpError(415, 'binary file');
      const enc = await encryptDoc(buf.toString('utf8'), pass);
      if (await decryptDoc(enc, pass) !== buf.toString('utf8')) throw httpError(500, '암호화 검증 실패');
      await writeAtomic(dest, enc); await fsp.rm(abs); markDirty(root);
      return send(res, 200, { path: p + '.enc', mtime: (await fsp.stat(dest)).mtimeMs });
    }
    case 'POST /api/crypt/unlock': { // <이름>.enc → 평문 문서
      const abs = resolveSafe(root, p), dest = abs.slice(0, -4);
      if (!isEncPath(abs)) throw httpError(400, '암호화된 파일이 아닙니다');
      if (fs.existsSync(dest)) throw httpError(409, 'target exists');
      const text = await decryptDoc(await fsp.readFile(abs), passOf(req));
      await fsp.writeFile(dest, text, { flag: 'wx' }); await fsp.rm(abs); markDirty(root);
      return send(res, 200, { path: p.slice(0, -4), mtime: (await fsp.stat(dest)).mtimeMs });
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
    case 'POST /api/upload': { // 마크다운에 붙여넣은/끌어놓은 첨부: path = 문서, name = 파일 이름. 이미지는 assets/images/날짜/, 그 밖은 assets/files/날짜/
      const r = await uploadAttachment(req, root, p, url.searchParams.get('name') || 'file');
      markDirty(root);
      return send(res, 200, r);
    }
    case 'POST /api/stats': { // 여러 파일의 크기/수정 시각 (첨부 카드 표시용)
      const { paths = [] } = JSON.parse((await readBody(req)) || '{}');
      const out = {};
      await mapLimit(paths.slice(0, 500), 16, async (rel) => { try { const st = await fsp.stat(resolveSafe(root, rel)); out[rel] = { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() }; } catch { out[rel] = null; } });
      return send(res, 200, out);
    }
    case 'POST /api/assets/migrate': { // 문서 옆 images/ → assets/images/날짜/ (apply=false 면 미리보기만)
      const { dir = '', apply = false } = JSON.parse((await readBody(req)) || '{}');
      if (dir) resolveSafe(root, dir);
      return send(res, 200, await migrateAssets(root, String(dir).replace(/^\/+|\/+$/g, ''), !!apply));
    }
    case 'POST /api/rename': {
      const { to } = JSON.parse(await readBody(req));
      const from = resolveSafe(root, p), dest = resolveSafe(root, to);
      if (fs.existsSync(dest)) throw httpError(409, 'target exists');
      if (isEncPath(from) !== isEncPath(dest)) throw httpError(400, '.enc 는 이름 변경으로 붙이거나 뗄 수 없습니다 (암호화 / 암호 해제 메뉴를 쓰세요)');
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
      const ext = path.extname(abs).toLowerCase(), img = IMG_MIME[ext];
      if (!img && url.pathname === '/thumb') throw httpError(415, 'unsupported');
      const st = await fsp.stat(abs); if (!st.isFile()) throw httpError(404, 'not a file');
      const csp = { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };   // SVG 를 직접 열어도 스크립트가 실행되지 않게
      if (!img) { // 첨부 파일: PDF·영상·음악은 앱 안에서 보기, 글자 파일은 text/plain, 그 밖은 내려받기로만 (HTML 등이 이 출처에서 실행되지 않게)
        const inline = MEDIA_MIME[ext];
        if (inline) return sendFile(req, res, abs, inline, st, ext === '.pdf' ? {} : csp);
        const name = encodeURIComponent(path.basename(abs));
        return sendFile(req, res, abs, 'application/octet-stream', st, { ...csp, 'Content-Disposition': `attachment; filename*=UTF-8''${name}` });
      }
      const type = img;
      if (url.pathname === '/thumb') {
        const w = Math.min(4096, Math.max(256, Number(url.searchParams.get('w')) || 2048));
        const t = await thumbFor(abs, st, w);
        const v = url.searchParams.get('v'), keep = v && v !== '0' ? { 'Cache-Control': 'private, max-age=31536000, immutable' } : {};   // 화면이 원본 수정 시각을 붙여 요청하면 그 주소의 내용은 바뀌지 않는다 → 재확인 없이 캐시
        if (t) return sendFile(req, res, t.file, t.type, await fsp.stat(t.file), keep);
        return sendFile(req, res, abs, type, st, { ...csp, ...keep });   // 작은 이미지는 원본 그대로
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
