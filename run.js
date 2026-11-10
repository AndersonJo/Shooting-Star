'use strict';
// shooting-star Run: 스크립트 등록/실행 코어. CLI(`ss run …`), 서버 API(UI), Claude(skill/hook)가 모두 이걸 쓴다.
// 등록 위치: ~/.shooting-star/run/<name>.yaml (매니페스트, 구버전 .json 도 읽음) + scripts/<파일> (스크립트 사본)
// 이식: `ss run export` 는 스크립트 본문(code)까지 담은 YAML 을 내보내고, 다른 컴퓨터에서 `ss run add <그 파일 | ->` 로 그대로 등록한다.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const YAML = require('./public/vendor/js-yaml.umd.min.js');   // UI 와 같은 사본 (외부 의존성 없음)
const SECRET = require('./secret');

const HOME = os.homedir();
const DIR = path.join(HOME, '.shooting-star', 'run');
const SCRIPTS = path.join(DIR, 'scripts');
const LOGS = path.join(DIR, 'logs');
const HISTORY = path.join(DIR, 'history.jsonl');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TYPES = ['string', 'number', 'bool', 'choice', 'file'];
const LANG_EXT = { bash: '.sh', sh: '.sh', zsh: '.zsh', python: '.py', py: '.py', node: '.js', js: '.js', javascript: '.js', ts: '.ts', typescript: '.ts', ruby: '.rb', perl: '.pl', php: '.php' };
const MANIFEST_EXT = ['.yaml', '.yml', '.json'];
const INTERP = { '.py': ['python3'], '.sh': ['bash'], '.bash': ['bash'], '.zsh': ['zsh'], '.js': ['node'], '.mjs': ['node'], '.rb': ['ruby'], '.pl': ['perl'], '.php': ['php'], '.ts': ['npx', 'tsx'] };
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ───────── 레지스트리 ─────────
function normalizeParam(p) {
  if (!p || typeof p !== 'object' || !NAME_RE.test(p.name || '')) throw err(`잘못된 파라미터 이름: ${p && p.name}`);
  const type = p.type || 'string';
  if (!TYPES.includes(type)) throw err(`파라미터 ${p.name}: type 은 ${TYPES.join('/')} 중 하나`);
  if (type === 'choice' && !(Array.isArray(p.choices) && p.choices.length)) throw err(`파라미터 ${p.name}: choice 는 choices 가 필요`);
  const as = p.as || 'flag';
  if (!['flag', 'env', 'positional'].includes(as)) throw err(`파라미터 ${p.name}: as 는 flag/env/positional`);
  const out = { name: p.name, type, as };
  if (p.description) out.description = String(p.description);
  if (p.default !== undefined) out.default = p.default;
  if (p.required) out.required = true;
  if (type === 'choice') out.choices = p.choices.map(String);
  if (p.flag) out.flag = String(p.flag);   // 기본은 --<name>
  return out;
}
function normalizeManifest(m) {
  if (!m || !NAME_RE.test(m.name || '')) throw err('name 은 영문/숫자/._- (최대 64자)');
  if (!m.script || typeof m.script !== 'string') throw err('script 가 필요');
  const out = { name: m.name, description: String(m.description || ''), script: m.script };
  if (m.interpreter) out.interpreter = Array.isArray(m.interpreter) ? m.interpreter.map(String) : String(m.interpreter).split(/\s+/).filter(Boolean);
  if (m.cwd) out.cwd = String(m.cwd);
  if (m.danger) out.danger = true;
  if (m.color === false) out.color = false;   // 색 강제(FORCE_COLOR 등) 끄기
  if (m.pty === false) out.pty = false;       // UI 실행을 가상 터미널 대신 파이프로
  out.params = (m.params || []).map(normalizeParam);
  const secrets = SECRET.normalize(m.secrets);   // 세션키/토큰: env SS_SECRET_<NAME> 로 주입
  if (secrets.length) out.secrets = secrets;
  const seen = new Set();
  for (const p of out.params) { if (seen.has(p.name)) throw err(`파라미터 이름 중복: ${p.name}`); seen.add(p.name); }
  if (m.presets != null) {   // 자주 쓰는 옵션 조합: { 이름: { 파라미터: 값 } } → `ss run <name> @이름`
    if (typeof m.presets !== 'object' || Array.isArray(m.presets)) throw err('presets 는 { 이름: { 파라미터: 값 } } 형태');
    out.presets = {};
    for (const [pn, pv] of Object.entries(m.presets)) {
      if (!NAME_RE.test(pn)) throw err(`잘못된 프리셋 이름: ${pn}`);
      if (!pv || typeof pv !== 'object' || Array.isArray(pv)) throw err(`프리셋 ${pn}: { 파라미터: 값 } 형태여야 합니다`);
      out.presets[pn] = {};
      for (const [k, v] of Object.entries(pv)) {
        const p = out.params.find((x) => x.name === k);
        if (!p) throw err(`프리셋 ${pn}: 알 수 없는 파라미터 ${k}`);
        out.presets[pn][k] = coerce(p, v);
      }
    }
    if (!Object.keys(out.presets).length) delete out.presets;
  }
  return out;
}
const scriptPath = (m) => (path.isAbsolute(m.script) ? m.script : path.join(SCRIPTS, m.script));
const manifestFile = (name) => MANIFEST_EXT.map((e) => path.join(DIR, name + e)).find((f) => fs.existsSync(f));
const parseManifest = (f) => { const t = fs.readFileSync(f, 'utf8'); return f.endsWith('.json') ? JSON.parse(t) : YAML.load(t); };
function list() {
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => MANIFEST_EXT.includes(path.extname(f))); } catch {}
  const out = [], seen = new Set();
  for (const f of files.sort((a, b) => a.localeCompare(b))) {
    const name = f.slice(0, -path.extname(f).length); if (seen.has(name)) continue; seen.add(name);
    const mf = manifestFile(name);   // 같은 이름이 둘이면 .yaml 우선
    try { const m = normalizeManifest(parseManifest(mf)); m.missing = !fs.existsSync(scriptPath(m)); m.scriptPath = scriptPath(m); m.manifest = mf; out.push(m); } catch (e) { out.push({ name, broken: e.message, params: [], manifest: mf }); }
  }
  return out;
}
function get(name) {
  if (!NAME_RE.test(name || '')) throw err(`잘못된 이름: ${name}`);
  const f = manifestFile(name);
  if (!f) throw err(`등록되지 않은 스크립트: ${name}  (ss run list)`, 404);
  const m = normalizeManifest(parseManifest(f));
  m.scriptPath = scriptPath(m); m.manifest = f;
  if (!fs.existsSync(m.scriptPath)) throw err(`스크립트 파일이 없습니다: ${m.scriptPath}`, 404);
  return m;
}
function toYaml(m, extra) {   // 사람이 읽고 고치기 좋은 순서로
  const o = {};
  for (const k of ['name', 'description', 'script', 'interpreter', 'cwd', 'danger', 'secrets', 'params', 'presets']) if (m[k] !== undefined && !(k === 'params' && !m[k].length)) o[k] = m[k];
  if (o.params) o.params = o.params.map(({ as, ...p }) => (as === 'flag' ? p : { ...p, as }));   // 기본값은 생략
  Object.assign(o, extra);
  return YAML.dump(o, { lineWidth: -1, noRefs: true });
}
// 등록. 스크립트 출처는 셋 중 하나: file(경로; link 면 원본을 그대로 참조) / manifest.code(본문 인라인) / manifest.script(이미 scripts/ 에 있거나 절대경로)
function add(manifest, file, { link = false, force = false } = {}) {
  const { code, lang, ...m0 } = manifest || {};
  if (code != null && file) throw err('code(인라인 스크립트)와 스크립트 파일을 동시에 줄 수 없습니다');
  let src = null;
  if (file) {
    src = path.resolve(file);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw err(`파일이 없습니다: ${file}`);
    m0.name = m0.name || path.basename(src).replace(/\.[^.]*$/, '');
    m0.script = link ? src : path.basename(src);
  } else if (code != null) {
    if (typeof code !== 'string') throw err('code 는 문자열(스크립트 본문)이어야 합니다');
    const ext = lang ? LANG_EXT[String(lang).toLowerCase()] : null;
    if (lang && !ext) throw err(`lang 은 ${Object.keys(LANG_EXT).join('/')} 중 하나`);
    m0.script = path.basename(m0.script || (m0.name || 'script') + (ext || '.sh'));
  }
  const m = normalizeManifest(m0);   // 디스크를 건드리기 전에 검증
  const existing = manifestFile(m.name);
  if (existing && !force) throw err(`이미 등록된 이름입니다: ${m.name} (--force 로 덮어쓰기)`);
  if (src && !link || code != null) {
    fs.mkdirSync(SCRIPTS, { recursive: true });
    const dst = path.join(SCRIPTS, m.script);
    if (fs.existsSync(dst) && dst !== src && !force) throw err(`scripts/${m.script} 가 이미 있습니다 (다른 script 이름을 쓰거나 --force)`);
    if (code != null) fs.writeFileSync(dst, code.endsWith('\n') ? code : code + '\n');
    else if (dst !== src) fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  } else if (!fs.existsSync(scriptPath(m))) throw err(`스크립트 파일이 없습니다: ${scriptPath(m)} (code: 로 본문을 넣거나 파일을 지정하세요)`);
  fs.mkdirSync(DIR, { recursive: true });
  for (const e of MANIFEST_EXT) { const f = path.join(DIR, m.name + e); if (e !== '.yaml' && fs.existsSync(f)) fs.unlinkSync(f); }
  fs.writeFileSync(path.join(DIR, m.name + '.yaml'), toYaml(m));
  m.scriptPath = scriptPath(m); m.manifest = path.join(DIR, m.name + '.yaml');
  return m;
}
// YAML/JSON 텍스트(여러 문서 `---` 가능)로 등록. script: 상대경로는 baseDir 기준. over: CLI 플래그로 덮어쓸 값
function addFromText(text, { baseDir = process.cwd(), link = false, force = false, over = {} } = {}) {
  let docs; try { docs = YAML.loadAll(text).filter((d) => d != null); } catch (e) { throw err(`YAML 파싱 실패: ${e.message}`); }
  if (!docs.length) throw err('등록할 내용이 없습니다');
  if (docs.length > 1 && over.name) throw err('여러 문서를 등록할 때는 --name 을 쓸 수 없습니다');
  const out = [];
  for (const d0 of docs) {
    if (typeof d0 !== 'object' || Array.isArray(d0)) throw err('각 문서는 name/script/params… 를 가진 매핑이어야 합니다');
    const d = { ...d0, ...over }; if (over.params) d.params = [...(d0.params || []), ...over.params];
    let file = null;
    if (d.code == null && d.script && !(path.isAbsolute(d.script) && link)) {
      const f = path.resolve(baseDir, String(d.script).replace(/^~(?=$|\/)/, HOME));
      if (fs.existsSync(f)) { file = f; delete d.script; }
    }
    out.push(add(d, file, { link, force }));
  }
  return out;
}
// 다른 컴퓨터로 옮기기 위한 자급식 YAML: 스크립트 본문을 code 에 넣는다
function exportYaml(names) {
  return names.map((n) => { const m = get(n); const { cwd: _c, ...rest } = m; return toYaml({ ...rest, script: path.basename(m.script), ...(m.cwd ? { cwd: m.cwd } : {}) }, { code: fs.readFileSync(m.scriptPath, 'utf8') }); }).join('---\n');
}
function remove(name) {
  const m = get(name);
  fs.unlinkSync(m.manifest);
  if (!path.isAbsolute(m.script)) { try { fs.unlinkSync(m.scriptPath); } catch {} }
}
const TEMPLATE = (lang = 'bash') => {
  const code = {
    python: `#!/usr/bin/env python3\nimport argparse\n\nap = argparse.ArgumentParser()\nap.add_argument('--env', default='dev')\nap.add_argument('--keep', type=int, default=7)\nap.add_argument('--verbose', action='store_true')\na = ap.parse_args()\nprint(f"env={a.env} keep={a.keep} verbose={a.verbose}")\n`,
    node: `#!/usr/bin/env node\n// 파라미터는 env SS_PARAM_<NAME> 로도 들어온다\nconst { SS_PARAM_ENV: env, SS_PARAM_KEEP: keep, SS_PARAM_VERBOSE: verbose } = process.env;\nconsole.log({ env, keep, verbose: verbose === '1' });\n`,
    bash: `#!/usr/bin/env bash\nset -euo pipefail\n# 파라미터는 env SS_PARAM_<NAME> 로도 들어온다 (bool 은 1/0)\necho "env=$SS_PARAM_ENV keep=$SS_PARAM_KEEP verbose=\${SS_PARAM_VERBOSE:-0}"\n`,
  }[lang] || TEMPLATE('bash');
  return `# ss run 등록용 YAML — 수정 후: ss run add <이 파일>   (또는 ss run add - <<'EOF' … EOF)
name: my-task                  # 영문/숫자/._- (최대 64자)
description: 한 줄 설명 (Claude 가 세션 시작 때 보는 문장)
lang: ${LANG_EXT[lang] ? lang : 'bash'}                    # code 를 쓸 때 확장자 결정: bash/python/node/ts/ruby/…
# script: ./my-task.sh         # code 대신 기존 파일 (이 YAML 기준 상대경로). 파일명만 정하려면 code 와 함께 써도 됨
# danger: true                 # 실행 전에 확인 (CLI 는 --yes 필요)
# color: false                 # 색 강제(FORCE_COLOR/CLICOLOR_FORCE/TERM…) 끄기 — 출력을 파싱하는 스크립트용
# pty: false                   # UI 실행을 가상 터미널(진행 막대 표시) 대신 파이프로
# cwd: ~/work                  # 작업 폴더 (기본: 실행한 곳)
# interpreter: python3 -u      # 기본은 확장자로 추론
params:
  - name: env
    type: choice               # string | number | bool | choice | file
    choices: [dev, prod]
    default: dev
    description: 대상 환경
  - name: keep
    type: number
    default: 7
  - name: verbose
    type: bool                 # flag: 켜면 --verbose 만 붙음
  # as: flag(기본, --name 값) | env(환경변수 name=값) | positional(순서대로) · flag: '-k' 처럼 플래그 문자열 지정
presets:                       # ss run my-task @prod-weekly [--keep 10 처럼 덮어쓰기 가능]
  prod-weekly: { env: prod, keep: 30 }
code: |
${code.replace(/^/gm, '  ').replace(/^ +$/gm, '')}`;
};

// ───────── 파라미터 → 실행 인자 ─────────
function coerce(p, raw) {
  if (p.type === 'bool') { if (typeof raw === 'boolean') return raw; return /^(1|true|yes|y|on)$/i.test(String(raw)); }
  if (p.type === 'number') { const n = Number(raw); if (raw === '' || !Number.isFinite(n)) throw err(`${p.name}: 숫자가 아닙니다 (${raw})`); return n; }
  if (p.type === 'choice') { if (!p.choices.includes(String(raw))) throw err(`${p.name}: ${p.choices.join(' | ')} 중 하나여야 합니다 (${raw})`); return String(raw); }
  return String(raw);
}
function resolveParams(m, given, preset) {
  if (preset) {
    const pv = (m.presets || {})[preset];
    if (!pv) throw err(`프리셋이 없습니다: @${preset}  (사용 가능: ${Object.keys(m.presets || {}).map((k) => '@' + k).join(' ') || '없음'})`);
    given = { ...pv, ...given };
  }
  const vals = {};
  for (const p of m.params) {
    let v = given[p.name];
    if (v === undefined || v === '') v = p.default;
    if (v === undefined || v === '' || (p.type === 'bool' && v === undefined)) {
      if (p.type === 'bool') v = false;
      else if (p.required) throw err(`필수 파라미터가 없습니다: ${p.name}`);
      else continue;
    }
    vals[p.name] = coerce(p, v);
  }
  const unknown = Object.keys(given).filter((k) => !m.params.some((p) => p.name === k));
  if (unknown.length) throw err(`알 수 없는 파라미터: ${unknown.join(', ')}  (사용 가능: ${m.params.map((p) => p.name).join(', ') || '없음'})`);
  return vals;
}
function buildCommand(m, vals) {
  const sp = m.scriptPath || scriptPath(m);
  const interp = m.interpreter || INTERP[path.extname(sp).toLowerCase()];
  const argv = interp ? [...interp, sp] : [sp];
  const env = {}, pos = [];
  for (const p of m.params) {
    const v = vals[p.name]; if (v === undefined) continue;
    env['SS_PARAM_' + p.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    if (p.as === 'env') { env[p.name] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v); continue; }
    if (p.as === 'positional') { pos.push(typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)); continue; }
    const flag = p.flag || '--' + p.name;
    if (p.type === 'bool') { if (v) argv.push(flag); } else argv.push(flag, String(v));
  }
  argv.push(...pos);
  return { cmd: argv[0], args: argv.slice(1), env };
}

// ───────── 로그인 셸 환경 (UI 실행용) ─────────
// 앱(launchd)으로 뜬 서버는 PATH=/usr/bin:/bin… 뿐이라 ~/.bash_profile·~/.bashrc 의 PATH/변수가 없다.
// 로그인+인터랙티브 셸을 한 번 띄워 그 환경을 캐시하고, rc 파일의 mtime/크기/inode 가 바뀌면 다음 실행 때 다시 읽는다.
const RC_FILES = ['.bash_profile', '.bash_login', '.profile', '.bashrc', '.zshenv', '.zprofile', '.zshrc', '.zlogin'].map((f) => path.join(HOME, f));
const ENV_DROP = ['PWD', 'OLDPWD', 'SHLVL', '_', 'PS1', 'PS2', 'PROMPT_COMMAND', 'TERM_SESSION_ID'];
const shellEnvCache = { sig: null, env: null, err: null, at: 0, ms: 0, shell: '' };
const rcSig = () => RC_FILES.map((f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return '-'; } }).join('|');
function loginEnv({ force = false } = {}) {
  const sig = rcSig();
  if (!force && shellEnvCache.sig === sig && (shellEnvCache.env || shellEnvCache.err)) return shellEnvCache;
  let shell = process.env.SHELL; try { shell = shell || os.userInfo().shell; } catch {}
  shell = shell || '/bin/bash';
  const mark = '__SS_ENV_' + crypto.randomBytes(4).toString('hex') + '__';   // rc 가 stdout 에 뭘 찍어도 구분되게
  const code = `process.stdout.write(${JSON.stringify(mark)} + JSON.stringify(process.env))`;
  const t0 = Date.now();
  const r = spawnSync(shell, ['-ilc', `exec ${JSON.stringify(process.execPath)} -e '${code}'`], { cwd: HOME, env: { ...process.env, SS_SHELL_ENV: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  Object.assign(shellEnvCache, { sig, at: Date.now(), ms: Date.now() - t0, shell, err: null });
  try {
    if (r.error) throw r.error;
    const i = (r.stdout || '').lastIndexOf(mark); if (i < 0) throw new Error(`exit ${r.status}${r.signal ? ' ' + r.signal : ''} ${(r.stderr || '').trim().slice(-300)}`);
    const env = JSON.parse(r.stdout.slice(i + mark.length));
    for (const k of ENV_DROP) delete env[k]; delete env.SS_SHELL_ENV;
    shellEnvCache.env = env;
  } catch (e) { shellEnvCache.err = `로그인 셸(${shell}) 환경을 읽지 못했습니다: ${e.message}`; }   // 이전에 읽은 env 는 그대로 쓴다
  return shellEnvCache;
}
const envInfo = () => ({ shell: shellEnvCache.shell, at: shellEnvCache.at, ms: shellEnvCache.ms, err: shellEnvCache.err, vars: shellEnvCache.env ? Object.keys(shellEnvCache.env).length : 0, rcFiles: RC_FILES.filter((f) => fs.existsSync(f)) });

// ───────── 실행 ─────────
const jobs = new Map();   // id → job (서버 프로세스 안에서 UI 가 시작한 것)
const MAX_BUF = 256 * 1024;
// 실행 위치의 git 상태 (브랜치/커밋/변경 여부). git 저장소가 아니면 null
function gitInfo(dir) {
  try {
    const r = spawnSync('git', ['-C', dir, 'status', '--porcelain=v2', '--branch', '-uno'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (r.status !== 0 || !r.stdout) return null;
    const g = {}; let dirty = 0;
    for (const l of r.stdout.split('\n')) {
      if (l.startsWith('# branch.head ')) g.branch = l.slice(14); else if (l.startsWith('# branch.oid ') && !l.startsWith('# branch.oid (')) g.commit = l.slice(13, 20);   // (initial) = 커밋 없음
      else if (l && !l.startsWith('#')) dirty++;
    }
    if (g.branch === '(detached)') { g.detached = true; g.branch = null; }
    if (dirty) g.dirty = dirty;
    const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (top.status === 0) g.repo = top.stdout.trim();
    return g;
  } catch { return null; }
}
const gitText = (g) => (g ? `${g.branch || 'detached'}${g.commit ? ' @' + g.commit : ''}${g.dirty ? ' · 변경 ' + g.dirty + '개' : ''}` : '');
const workdirOf = (m, cwd) => (m.cwd ? m.cwd.replace(/^~(?=$|\/)/, HOME) : (cwd || process.cwd()));
// 파이프로 연결되면 대부분의 도구가 색을 끈다 → 보여줄 곳이 터미널(UI 렌더러 포함)이면 색을 켜도록 알려준다
const COLOR_ENV = { FORCE_COLOR: '1', CLICOLOR_FORCE: '1', CLICOLOR: '1', PY_COLORS: '1', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
// UI 실행은 가상 터미널(pty)에서: 파이프면 tqdm·rich·pip·wget·docker 등이 진행 막대를 끄거나 줄여 버린다.
// node 네이티브 모듈 없이 macOS 기본 /usr/bin/script 로 pty 를 만든다. 크기는 UI 터미널 폭, \n→\r\n 변환은 끈다.
// stdin 은 /dev/null 그대로 (입력을 읽는 스크립트는 즉시 EOF) — script 가 EOF 를 ^D 로 넘기며 생기는 "^D\b\b" 메아리는 지운다.
const PTY_OK = process.platform === 'darwin' && fs.existsSync('/usr/bin/script');
const PTY_ECHO = '^D\b\b';
const ptySize = (p) => { const n = (v, d, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d); return { cols: n(p && p.cols, 120, 20, 1000), rows: n(p && p.rows, 40, 5, 500) }; };
function start(m, given, { cwd, source = 'cli', stdio, preset, shellEnv = false, color = false, pty = null } = {}) {
  const vals = resolveParams(m, given || {}, preset || null);
  const { cmd, args, env } = buildCommand(m, vals);
  Object.assign(env, SECRET.injectEnv(m.secrets));   // 저장된 세션키를 env 로 주입 (required 인데 없으면 여기서 에러)
  const id = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const workdir = workdirOf(m, cwd), git = gitInfo(workdir);
  const job = Object.assign(new EventEmitter(), { id, name: m.name, params: vals, preset: preset || undefined, source, startedAt: Date.now(), endedAt: 0, code: null, signal: null, buf: '', cwd: workdir, git, cmdline: [cmd, ...args].join(' ') });
  fs.mkdirSync(LOGS, { recursive: true });
  const logf = path.join(LOGS, id + '.log'); const log = fs.createWriteStream(logf);
  let base = process.env, envNote = '';   // CLI 는 터미널 환경 그대로, UI 는 로그인 셸 환경 (rc 파일 반영)
  if (shellEnv) { const le = loginEnv(); if (le.env) base = { ...process.env, ...le.env }; if (le.err) envNote = `[ss] ${le.err}${le.env ? ' — 이전에 읽은 환경으로 실행' : ' — 서버 환경으로 실행'}\n`; }
  if (color && m.color !== false && !('NO_COLOR' in base)) { const c = {}; for (const [k, v] of Object.entries(COLOR_ENV)) if (k === 'TERM' ? !base.TERM || base.TERM === 'dumb' : !(k in base)) c[k] = v; base = { ...base, ...c }; }
  let [exe, argv] = [cmd, args];
  const usePty = !!pty && !stdio && PTY_OK && m.pty !== false;
  if (usePty) { const { cols, rows } = ptySize(pty); exe = '/usr/bin/script'; argv = ['-q', '/dev/null', '/bin/sh', '-c', `stty -onlcr -echo cols ${cols} rows ${rows} 2>/dev/null; exec "$0" "$@"`, cmd, ...args]; }
  const child = spawn(exe, argv, { cwd: workdir, env: { ...base, ...env, SS_RUN_ID: id, SS_RUN_NAME: m.name }, stdio: stdio ? ['inherit', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  job.child = child;
  const chunk = (d) => {
    const s = d.toString(); log.write(d);
    job.buf = (job.buf + s).slice(-MAX_BUF); job.emit('data', s);
  };
  if (envNote) chunk(envNote);
  let head = usePty ? '' : null;   // pty: 맨 앞 "^D\b\b" 메아리를 걸러낼 때까지 잠깐 모은다
  const out = (d) => {
    if (head === null) return chunk(d);
    head += d.toString();
    if (head.length < PTY_ECHO.length && PTY_ECHO.startsWith(head)) return;
    const s = head.startsWith(PTY_ECHO) ? head.slice(PTY_ECHO.length) : head; head = null;
    if (s) chunk(s);
  };
  child.stdout.on('data', out); child.stderr.on('data', out);
  child.on('error', (e) => { chunk(`\n[실행 실패] ${e.message}\n`); finish(null, null); });
  let done = false;
  const finish = (code, signal) => {
    if (done) return; done = true;
    if (head) { chunk(head); head = null; }
    job.code = code; job.signal = signal; job.endedAt = Date.now(); log.end();
    try { fs.appendFileSync(HISTORY, JSON.stringify({ id, name: m.name, params: vals, ...(preset ? { preset } : {}), source, startedAt: job.startedAt, endedAt: job.endedAt, code, signal, cwd: workdir, ...(git ? { git } : {}) }) + '\n'); } catch {}
    job.emit('end', { code, signal });
  };
  child.on('close', finish);
  jobs.set(id, job);
  return job;
}
function kill(id) {
  const j = jobs.get(id); if (!j || j.endedAt) return false;
  try { process.kill(-j.child.pid, 'SIGTERM'); } catch { try { j.child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { if (!j.endedAt) try { process.kill(-j.child.pid, 'SIGKILL'); } catch {} }, 3000).unref();
  return true;
}
function history(limit = 50) {
  try { return fs.readFileSync(HISTORY, 'utf8').trim().split('\n').slice(-limit).reverse().map((l) => JSON.parse(l)); } catch { return []; }
}
const ID_RE = /^[a-z0-9]+$/;
const logPath = (id) => { if (!ID_RE.test(id || '')) throw err('bad id'); return path.join(LOGS, id + '.log'); };
function readLog(id) { try { return fs.readFileSync(logPath(id), 'utf8').slice(-MAX_BUF); } catch (e) { if (e.status) throw e; return ''; } }
// 디버깅용: 이름(그 스크립트의 마지막 실행) / 실행 id / 생략(가장 최근 실행) → 실행 정보 + 로그 경로
function findRun(q) {
  const hs = history(1000);
  let h = q ? hs.find((x) => x.name === q) || hs.find((x) => x.id === q) : null;
  if (!q) {   // 가장 최근 로그 파일 (아직 끝나지 않은 실행은 history 에 없다)
    let best = null;
    try { for (const f of fs.readdirSync(LOGS)) { if (!f.endsWith('.log')) continue; const t = fs.statSync(path.join(LOGS, f)).mtimeMs; if (!best || t > best.t) best = { id: f.slice(0, -4), t }; } } catch {}
    h = best ? hs.find((x) => x.id === best.id) || { id: best.id, running: true } : hs[0];
  } else if (!h && ID_RE.test(q) && fs.existsSync(logPath(q))) h = { id: q, running: true };
  if (!h) throw err(q ? `'${q}' 의 실행 기록이 없습니다` : '실행 기록이 없습니다', 404);
  let m = null; try { if (h.name) m = get(h.name); } catch {}
  return { ...h, log: logPath(h.id), script: m?.scriptPath, manifest: m?.manifest };
}
const plainText = (s) => s.replace(/\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[@-Z\\-_])/g, '').split('\n').map((l) => { const p = l.replace(/\r+$/, '').split('\r'); return p[p.length - 1]; }).join('\n');
function runInfoText(r) {
  const at = r.startedAt ? new Date(r.startedAt).toLocaleString() : '';
  const st = r.running ? '실행 중 (또는 기록 전)' : r.signal ? 'killed ' + r.signal : 'exit ' + r.code;
  return [`# run       ${r.id}${r.name ? ' · ' + r.name : ''} · ${st}${at ? ' · ' + at : ''}${r.endedAt ? ' · ' + ((r.endedAt - r.startedAt) / 1000).toFixed(1) + 's' : ''}${r.source ? ' · ' + r.source : ''}`,
    r.params ? `# params    ${JSON.stringify(r.params)}${r.preset ? ' (@' + r.preset + ')' : ''}` : '',
    r.cwd ? `# cwd       ${r.cwd}` : '', r.git ? `# git       ${gitText(r.git)}${r.git.repo && r.git.repo !== r.cwd ? '  (repo ' + r.git.repo + ')' : ''}` : '', r.script ? `# script    ${r.script}` : '', r.manifest ? `# manifest  ${r.manifest}` : '',
    `# log       ${r.log}`].filter(Boolean).join('\n');
}

// ───────── Claude 연동: 컨텍스트 요약 / skill / hook ─────────
function usageLine(m) {
  const ps = m.params.map((p) => `--${p.name}${p.type === 'bool' ? '' : ' <' + (p.type === 'choice' ? p.choices.join('|') : p.type) + '>'}${p.required ? '*' : ''}`).join(' ');
  const pr = Object.keys(m.presets || {});
  const sec = (m.secrets || []).map((x) => x.name);
  return `ss run ${m.name}${sec.length ? ' {secret: ' + sec.join(', ') + '}' : ''}${pr.length ? ' [' + pr.map((k) => '@' + k).join('|') + ']' : ''}${ps ? ' ' + ps : ''}`;
}
function contextText() {
  const ms = list().filter((m) => !m.broken);
  const lines = ['[shooting-star] 등록된 실행 스크립트 (ss run). 사용자가 실행을 요청하면 직접 짜지 말고 아래를 먼저 `ss run <name>` 으로 실행한다. 등록/상세는 ss-run skill 참고.'];
  if (!ms.length) lines.push('(아직 등록된 스크립트 없음 — 반복 작업은 `ss run add` 로 등록할 수 있다)');
  for (const m of ms) lines.push(`- ${usageLine(m)}${m.danger ? '  [danger: --yes 필요]' : ''}${m.description ? ' — ' + m.description : ''}`);
  if (ms.length) lines.push('- 실행 결과/실패 디버깅: `ss run log <name|run-id>` (실행 정보 + 스크립트/로그 경로 + 출력, UI 에서 실행한 것도 포함)');
  try {
    const ss = SECRET.list();
    lines.push('[shooting-star] 세션키 저장소: `ss secret set <이름>`(값은 가려서 입력) · 스크립트는 secrets: [이름] 으로 선언하면 env SS_SECRET_<이름> 로 받음. 값은 chat 에 붙여넣게 하지 말 것.');
    if (ss.length) lines.push('- 저장된 키: ' + ss.map((x) => x.name).join(', '));
  } catch {}
  try {
    const dbs = require('./db').listConnections();
    if (dbs.length) { lines.push('[shooting-star] DB 연결: `ss db query <이름> "<SQL>" [--json]` / `ss db schema <이름> [스키마 [테이블]]` (비밀번호는 ss 가 관리, 읽기 전용 연결은 SELECT 류만)'); for (const d of dbs) lines.push(`- ${d.name} [${d.kind}${d.readOnly ? ', 읽기 전용' : ''}]`); }
  } catch {}
  return lines.join('\n');
}
// 모델 무관 연동: 등록된 스크립트를 function-calling 도구 정의(JSON Schema)로 내보낸다 (OpenAI / Anthropic / 기타)
function toolDefs(format) {
  return list().filter((m) => !m.broken && !m.missing).map((m) => {
    const props = {}, req = [];
    for (const p of m.params) {
      const t = p.type === 'number' ? { type: 'number' } : p.type === 'bool' ? { type: 'boolean' } : p.type === 'choice' ? { type: 'string', enum: p.choices } : { type: 'string' };
      if (p.description) t.description = p.description; if (p.default !== undefined) t.default = p.default;
      props[p.name] = t; if (p.required) req.push(p.name);
    }
    const schema = { type: 'object', properties: props, ...(req.length ? { required: req } : {}), additionalProperties: false };
    const pr = Object.entries(m.presets || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    const name = 'ss_run_' + m.name.replace(/[^A-Za-z0-9_-]/g, '_'), description = (m.description || m.name) + (m.danger ? ' [danger]' : '') + (pr.length ? ` (presets: ${pr.join('; ')})` : '');
    return format === 'anthropic' ? { name, description, input_schema: schema } : { type: 'function', function: { name, description, parameters: schema } };
  });
}
const SKILL_MD = `---
name: ss-run
description: Run, register and manage reusable scripts (python/bash/node...) through shooting-star's \`ss run\` registry. Use when the user asks to run a registered script/task, to save a script so it can be reused, or to see what scripts are available.
---

# ss run — shooting-star script registry

Scripts registered here are shared by the CLI, the shooting-star UI (Run menu) and Claude. A SessionStart hook lists them at the start of every session.

## Run
\`\`\`bash
ss run list [--json]                 # names, descriptions, parameter schema, presets
ss run show <name>                   # one script in detail (YAML)
ss run <name> --param value ...      # run; stdout/stderr stream through, exit code is the script's
ss run <name> @preset [--k v ...]    # run with a saved option set; flags given after it override it
\`\`\`
- When the user asks to run something that is registered, run it right away with \`ss run <name> ...\` — no extra confirmation.
- Scripts marked \`danger\` need \`--yes\`; pass it only when the user explicitly asked for that run.
- Bool params are flags (\`--verbose\`); omit params that have a default unless the user specified a value.
- \`@preset\` must come right after the name. Unknown params / presets / bad values are rejected with the valid list.

## Debug a run (UI or CLI)
\`\`\`bash
ss run log [<name>|<run-id>]         # run info (params, exit, cwd, script/manifest/log paths) + last 200 lines; no arg = most recent run
ss run log <name> --all | --tail N   # more output;  --path prints only the log file path
ss run history [n]                   # recent runs with their ids
\`\`\`
- Every run (UI or CLI) is logged to \`~/.shooting-star/run/logs/<id>.log\`. When the user says a run failed or "check the log", start with \`ss run log <name>\`, then read the script file it names.
- To fix a script, edit the \`script\` file in place (the UI picks it up), or re-register with \`ss run add ... --force\` to change params.

## Register (one YAML, no other files needed)
Prefer registering when the user will likely repeat the task. Pipe a self-contained YAML (script body in \`code:\`) into \`ss run add -\`:
\`\`\`bash
ss run add - <<'YAML'
name: backup-db
description: Dump the DB to ~/backups      # one line; this is what future sessions see
lang: bash                                  # bash | python | node | ts | ruby | ... (picks the file extension)
danger: false                               # true → confirmation / --yes required
params:
  - name: env
    type: choice                            # string | number | bool | choice | file
    choices: [dev, prod]
    default: dev
    description: target env
  - name: keep
    type: number
    default: 7
  - name: verbose
    type: bool
presets:
  prod-weekly: { env: prod, keep: 30 }
code: |
  #!/usr/bin/env bash
  set -euo pipefail
  echo "env=$SS_PARAM_ENV keep=$SS_PARAM_KEEP verbose=\${SS_PARAM_VERBOSE:-0}"
YAML
\`\`\`
- \`ss run template [bash|python|node]\` prints a fully commented template — use it if unsure of a field.
- Instead of \`code:\`, \`script: ./path/file.py\` registers an existing file (path relative to the YAML, or cwd for stdin); \`--link\` references it in place instead of copying.
- Other param fields: \`required: true\`, \`as: flag\` (default → \`--name value\`) | \`env\` | \`positional\`, \`flag: "-k"\` (custom flag text).
- Every param is also exported as env \`SS_PARAM_<NAME>\` (bool → 1/0), so scripts may read env instead of parsing argv.
- Optional: \`cwd: ~/dir\`, \`interpreter: python3 -u\` (default: inferred from extension; otherwise the file must be executable).
- Runs shown in a terminal or the UI get FORCE_COLOR/CLICOLOR_FORCE/TERM=xterm-256color so tools keep their colors (the UI renders ANSI). Set \`color: false\` if the script parses command output that colors would break.
- UI runs (macOS) execute in a pseudo-terminal sized to the output pane, so progress bars (tqdm, rich, pip, wget, docker…) render live, just like in Terminal. stdin is still empty (EOF). \`pty: false\` runs it on plain pipes instead.
- Re-registering the same name needs \`--force\` (that is also how you update a script). \`ss run rm <name>\` removes one.
- Several scripts can go in one YAML separated by \`---\`.
- Legacy one-liner still works: \`ss run add ./x.sh --name n --desc d --param '{"name":"env","type":"choice","choices":["dev","prod"]}'\`.

## Move scripts between computers
\`\`\`bash
ss run export <name> [<name>...] > scripts.yaml   # or: ss run export --all
ss run add scripts.yaml --force                    # on the other machine (code is embedded, nothing else to copy)
\`\`\`
If the user pastes such a YAML into the chat, pipe it to \`ss run add -\` (or save it to a temp file) and register it.
If \`ss\` itself is missing on a machine, shooting-star must be installed first (\`./install.sh\` in its repo); \`ss run install\` sets up this skill and the hook.

## Session keys / tokens (ss secret)
Short-lived secrets (session cookies, bearer tokens) are stored once and injected into scripts as env, never written into the manifest, logs, argv or git.
\`\`\`bash
ss secret set <name>     # paste the value when prompted (hidden); or: ss secret set <name> <value>
ss secret list           # names only, never values
ss secret rm <name>
\`\`\`
- Declare what a script needs in its manifest: \`secrets: [airflow]\` (or \`[{name: airflow, env: AIRFLOW_TOKEN}]\`). At run time each saved value is injected as \`SS_SECRET_<NAME>\` (bool-cap uppercase; custom \`env:\` overrides). A declared-but-missing secret stops the run with \`ss secret set <name>\`.
- Never ask the user to paste a secret into the chat and never put one in a manifest or script file. Tell them to run \`ss secret set <name>\` (it reads hidden). The user grabs the value themselves (e.g. from their browser DevTools) — do not try to extract it.
- The value survives until overwritten; when a session key expires the user just runs \`ss secret set <name>\` again.

## DB connections (same registry, same CLI)
\`\`\`bash
ss db list                              # connections (passwords are managed by ss, never ask for them)
ss db schema <conn> [<schema> [<table>]]
ss db query <conn> "SELECT ..." [--limit 1000] [--json|--csv]
\`\`\`
- Connections marked read-only accept SELECT/WITH/SHOW/DESCRIBE/EXPLAIN only. Never try to work around this; ask the user to change the connection instead.
- Prefer \`--json\` when you will process the result, and add a LIMIT to exploratory queries.
`;
const HOOK_CMD = 'ss run context';
const claudeDir = () => path.join(HOME, '.claude');
// ss 를 업데이트하면 다음 Claude 세션 시작(hook)에서 skill 문서도 최신으로 맞춘다 (설치된 경우에만)
function refreshSkill() {
  const f = path.join(claudeDir(), 'skills', 'ss-run', 'SKILL.md');
  try { if (fs.readFileSync(f, 'utf8') !== SKILL_MD) fs.writeFileSync(f, SKILL_MD); } catch {}
}
function install() {
  const skillDir = path.join(claudeDir(), 'skills', 'ss-run');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_MD);
  const sf = path.join(claudeDir(), 'settings.json'); let s = {};
  try { s = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw err(`${sf} 를 읽을 수 없습니다: ${e.message}`); }
  s.hooks = s.hooks || {}; const ss = (s.hooks.SessionStart = s.hooks.SessionStart || []);
  let hook = false;
  if (!ss.some((g) => (g.hooks || []).some((h) => h.command === HOOK_CMD))) { ss.push({ hooks: [{ type: 'command', command: HOOK_CMD }] }); hook = true; }
  s.permissions = s.permissions || {}; const allow = (s.permissions.allow = s.permissions.allow || []);
  const rules = ['Bash(ss run:*)', 'Bash(ss secret:*)']; const addedRules = rules.filter((r) => !allow.includes(r)); allow.push(...addedRules);
  if (hook || addedRules.length) { if (fs.existsSync(sf)) fs.copyFileSync(sf, sf + '.bak-ss'); fs.writeFileSync(sf, JSON.stringify(s, null, 2) + '\n'); }
  return { skill: path.join(skillDir, 'SKILL.md'), settings: sf, hookAdded: hook, rulesAdded: addedRules };
}

// ───────── CLI ─────────
function parseFlags(argv) {   // --k v / --k=v / 단독 --flag(→ true); 반복 가능한 --param 은 배열
  const o = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { rest.push(a); continue; }
    let k = a.slice(2), v;
    const eq = k.indexOf('='); if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) v = argv[++i]; else v = true;
    if (k in o) o[k] = [].concat(o[k], v); else o[k] = v;
  }
  return { o, rest };
}
const HELP = `ss run — 스크립트 등록/실행 (UI 의 Run 메뉴, Claude 와 공유)

  ss run list [--json]            등록된 스크립트
  ss run show <name>              상세 (YAML)
  ss run <name> [@프리셋] [--파라미터 값…]   실행  (danger 스크립트는 --yes)
  ss run add <x.yaml | ->         YAML 로 등록 (code: 에 본문 인라인 또는 script: 경로, --- 로 여러 개)
  ss run add <file> [--config x.yaml] [--name n] [--desc d] [--param '{json}']… [--danger] [--cwd dir]
                    [--interpreter "python3 -u"] [--link] [--force]
  ss run template [bash|python|node]   주석 달린 YAML 템플릿
  ss run export <name…> | --all   본문까지 담은 YAML (다른 컴퓨터에서 ss run add 로 등록)
  ss run rm <name>                등록 해제
  ss run history [n]              최근 실행 기록 (id 포함)
  ss run log [name|id] [--tail N|--all] [--path] [--raw]   실행 정보(스크립트/설정/로그 경로) + 출력. 생략하면 가장 최근 실행 (터미널이 아니면 색 코드 제거, --raw 로 원본)
  ss run context                  에이전트용 텍스트 요약 (Claude SessionStart hook 이 호출. AGENTS.md 등에 붙여도 됨)
  ss run tools [--format openai|anthropic]   function-calling 도구 정의(JSON). 호출은 'ss run <name> --k v' 로 실행
  ss run install                  Claude 에 skill(ss-run) + SessionStart hook + 실행 권한 설치
`;
async function cli(argv) {
  const [sub, ...rest] = argv;
  try {
    if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { process.stdout.write(HELP); return 0; }
    if (sub === 'list') {
      const { o } = parseFlags(rest); const ms = list();
      if (o.json) { process.stdout.write(JSON.stringify(ms.map(({ scriptPath: _s, ...m }) => m), null, 2) + '\n'); return 0; }
      if (!ms.length) { console.log('등록된 스크립트가 없습니다. (ss run add <file>)'); return 0; }
      for (const m of ms) console.log(m.broken ? `${m.name}  ⚠ ${m.broken}` : `${usageLine(m)}${m.missing ? '  ⚠ 파일 없음' : ''}${m.description ? '\n    ' + m.description : ''}`);
      return 0;
    }
    if (sub === 'show') { const m = get(rest[0]); process.stdout.write(toYaml(m)); console.log('\n# script:   ' + m.scriptPath + '\n# manifest: ' + m.manifest + '\n# usage:    ' + usageLine(m)); return 0; }
    if (sub === 'template') { process.stdout.write(TEMPLATE(rest[0] || 'bash')); return 0; }
    if (sub === 'export') {
      const { o, rest: names } = parseFlags(rest);
      const all = o.all ? list().filter((m) => !m.broken && !m.missing).map((m) => m.name) : names;
      if (!all.length) throw err('내보낼 이름을 주거나 --all');
      process.stdout.write(exportYaml(all)); return 0;
    }
    if (sub === 'context') { refreshSkill(); console.log(contextText()); return 0; }
    if (sub === 'tools') { const { o } = parseFlags(rest); console.log(JSON.stringify(toolDefs(o.format === 'anthropic' ? 'anthropic' : 'openai'), null, 2)); return 0; }
    if (sub === 'install') {
      const r = install();
      console.log(`✓ skill: ${r.skill}\n✓ ${r.settings}: ${r.hookAdded ? 'SessionStart hook 추가' : 'hook 이미 있음'}${r.rulesAdded.length ? ', 권한 ' + r.rulesAdded.join(', ') + ' 추가 (백업 settings.json.bak-ss)' : ''}\n새 Claude 세션부터 적용됩니다.`);
      return 0;
    }
    if (sub === 'log') {
      const { o, rest: pos } = parseFlags(rest); const r = findRun(pos[0]);
      if (o.path) { console.log(r.log); return 0; }
      let text = ''; try { text = fs.readFileSync(r.log, 'utf8'); } catch {}
      if (!process.stdout.isTTY && !o.raw) text = plainText(text);   // Claude 등 비터미널: 색 코드 제거 + \r 덮어쓰기 반영
      const n = o.all ? Infinity : Number(o.tail) || 200, lines = text.replace(/\n$/, '').split('\n');
      console.log(runInfoText(r)); if (lines.length > n) console.log(`# (마지막 ${n}줄 / 전체 ${lines.length}줄 — --all 로 전체)`);
      console.log('─'.repeat(60)); if (text) console.log(lines.slice(-n).join('\n'));
      return 0;
    }
    if (sub === 'history') { for (const h of history(Number(rest[0]) || 20)) console.log(`${h.id}  ${new Date(h.startedAt).toLocaleString()}  ${h.name}${h.git ? '  [' + gitText(h.git) + ']' : ''}  exit=${h.code ?? h.signal}  ${((h.endedAt - h.startedAt) / 1000).toFixed(1)}s  [${h.source}]  ${JSON.stringify(h.params)}`); return 0; }
    if (sub === 'rm') { remove(rest[0]); console.log('removed ' + rest[0]); return 0; }
    if (sub === 'add') {
      const { o, rest: pos } = parseFlags(rest);
      const params = [].concat(o.param || []).map((s) => { try { return JSON.parse(s); } catch { throw err(`--param 은 JSON 이어야 합니다: ${s}`); } });
      const over = {};
      if (typeof o.name === 'string') over.name = o.name;
      const desc = o.desc ?? o.description; if (typeof desc === 'string') over.description = desc;
      if (params.length) over.params = params;
      if (o.danger) over.danger = true;
      if (typeof o.cwd === 'string') over.cwd = o.cwd;
      if (typeof o.interpreter === 'string') over.interpreter = o.interpreter;
      const opts = { link: !!o.link, force: !!o.force };
      const f = pos[0];
      if (!f) throw err('ss run add <x.yaml | - | 스크립트 파일>');
      let ms;
      if (f === '-' || MANIFEST_EXT.includes(path.extname(f).toLowerCase())) {   // YAML/JSON 매니페스트 (stdin 또는 파일)
        const text = f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(f), 'utf8');
        ms = addFromText(text, { ...opts, baseDir: f === '-' ? process.cwd() : path.dirname(path.resolve(f)), over });
      } else if (o.config) {   // 스크립트 파일 + 설정 YAML
        let cfg; try { cfg = YAML.load(fs.readFileSync(path.resolve(String(o.config)), 'utf8')) || {}; } catch (e) { throw err(`--config 를 읽을 수 없습니다: ${e.message}`); }
        delete cfg.script; delete cfg.code; delete cfg.lang;
        const d = { ...cfg, ...over }; if (over.params) d.params = [...(cfg.params || []), ...over.params];
        ms = [add(d, f, opts)];
      } else ms = [add({ description: '', ...over }, f, opts)];
      for (const m of ms) console.log(`registered: ${usageLine(m)}`);
      return 0;
    }
    // ss run <name> …
    const m = get(sub);
    const preset = rest[0] && rest[0].startsWith('@') ? rest.shift().slice(1) : null;
    const { o } = parseFlags(rest);
    const yes = !!o.yes; delete o.yes;
    if (m.danger && !yes) {
      if (!process.stdin.isTTY) throw err(`'${m.name}' 은(는) danger 스크립트입니다. 실행하려면 --yes 를 붙이세요.`);
      const ans = await new Promise((r) => { process.stderr.write(`'${m.name}' 은(는) danger 스크립트입니다. 실행할까요? [y/N] `); process.stdin.once('data', (d) => r(String(d).trim())); });
      process.stdin.pause(); if (!/^y(es)?$/i.test(ans)) return 1;
    }
    const given = {}; for (const [k, v] of Object.entries(o)) given[k] = Array.isArray(v) ? v[v.length - 1] : v;
    const job = start(m, given, { cwd: process.cwd(), source: 'cli', preset, color: !!process.stdout.isTTY });
    job.on('data', (s) => process.stdout.write(s));
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => kill(job.id));
    return await new Promise((r) => job.on('end', ({ code, signal }) => r(code ?? (signal ? 130 : 1))));
  } catch (e) { console.error(e.message); return e.status === 404 ? 127 : 2; }
}

module.exports = { DIR, loginEnv, envInfo, gitInfo, workdirOf, list, get, add, addFromText, exportYaml, remove, start, kill, jobs, history, readLog, logPath, findRun, runInfoText, normalizeManifest, contextText, install, cli, scriptPath, err };
