'use strict';
// shooting-star Run: 스크립트 등록/실행 코어. CLI(`ss run …`), 서버 API(UI), Claude(skill/hook)가 모두 이걸 쓴다.
// 등록 위치: ~/.shooting-star/run/<name>.json (매니페스트) + scripts/<파일> (스크립트 사본)
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const HOME = os.homedir();
const DIR = path.join(HOME, '.shooting-star', 'run');
const SCRIPTS = path.join(DIR, 'scripts');
const LOGS = path.join(DIR, 'logs');
const HISTORY = path.join(DIR, 'history.jsonl');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TYPES = ['string', 'number', 'bool', 'choice', 'file'];
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
  out.params = (m.params || []).map(normalizeParam);
  const seen = new Set();
  for (const p of out.params) { if (seen.has(p.name)) throw err(`파라미터 이름 중복: ${p.name}`); seen.add(p.name); }
  return out;
}
const scriptPath = (m) => (path.isAbsolute(m.script) ? m.script : path.join(SCRIPTS, m.script));
function list() {
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch {}
  const out = [];
  for (const f of files.sort()) {
    try { const m = normalizeManifest(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))); m.missing = !fs.existsSync(scriptPath(m)); m.scriptPath = scriptPath(m); out.push(m); } catch (e) { out.push({ name: f.replace(/\.json$/, ''), broken: e.message, params: [] }); }
  }
  return out;
}
function get(name) {
  if (!NAME_RE.test(name || '')) throw err(`잘못된 이름: ${name}`);
  const f = path.join(DIR, name + '.json');
  if (!fs.existsSync(f)) throw err(`등록되지 않은 스크립트: ${name}  (ss run list)`, 404);
  const m = normalizeManifest(JSON.parse(fs.readFileSync(f, 'utf8')));
  m.scriptPath = scriptPath(m);
  if (!fs.existsSync(m.scriptPath)) throw err(`스크립트 파일이 없습니다: ${m.scriptPath}`, 404);
  return m;
}
// 등록: file 이 있으면 scripts/ 로 복사(link 면 원본 경로를 그대로 참조). manifest 는 이름/설명/파라미터 등.
function add(manifest, file, { link = false, force = false } = {}) {
  const m0 = { ...manifest };
  if (file) {
    const src = path.resolve(file);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw err(`파일이 없습니다: ${file}`);
    m0.name = m0.name || path.basename(src).replace(/\.[^.]*$/, '');
    m0.script = link ? src : path.basename(src);
    if (!link) {
      fs.mkdirSync(SCRIPTS, { recursive: true });
      const dst = path.join(SCRIPTS, m0.script);
      if (fs.existsSync(dst) && path.resolve(dst) !== src && !force && !fs.existsSync(path.join(DIR, m0.name + '.json'))) throw err(`scripts/${m0.script} 가 이미 있습니다 (--force 로 덮어쓰기)`);
      if (path.resolve(dst) !== src) fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
    }
  }
  const m = normalizeManifest(m0);
  fs.mkdirSync(DIR, { recursive: true });
  const f = path.join(DIR, m.name + '.json');
  if (fs.existsSync(f) && !force) throw err(`이미 등록된 이름입니다: ${m.name} (--force 로 덮어쓰기)`);
  fs.writeFileSync(f, JSON.stringify(m, null, 2) + '\n');
  return m;
}
function remove(name) {
  const m = get(name);
  fs.unlinkSync(path.join(DIR, name + '.json'));
  if (!path.isAbsolute(m.script)) { try { fs.unlinkSync(m.scriptPath); } catch {} }
}

// ───────── 파라미터 → 실행 인자 ─────────
function coerce(p, raw) {
  if (p.type === 'bool') { if (typeof raw === 'boolean') return raw; return /^(1|true|yes|y|on)$/i.test(String(raw)); }
  if (p.type === 'number') { const n = Number(raw); if (raw === '' || !Number.isFinite(n)) throw err(`${p.name}: 숫자가 아닙니다 (${raw})`); return n; }
  if (p.type === 'choice') { if (!p.choices.includes(String(raw))) throw err(`${p.name}: ${p.choices.join(' | ')} 중 하나여야 합니다 (${raw})`); return String(raw); }
  return String(raw);
}
function resolveParams(m, given) {
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

// ───────── 실행 ─────────
const jobs = new Map();   // id → job (서버 프로세스 안에서 UI 가 시작한 것)
const MAX_BUF = 256 * 1024;
function start(m, given, { cwd, source = 'cli', stdio } = {}) {
  const vals = resolveParams(m, given || {});
  const { cmd, args, env } = buildCommand(m, vals);
  const id = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const workdir = m.cwd ? m.cwd.replace(/^~(?=$|\/)/, HOME) : (cwd || process.cwd());
  const job = Object.assign(new EventEmitter(), { id, name: m.name, params: vals, source, startedAt: Date.now(), endedAt: 0, code: null, signal: null, buf: '', cwd: workdir, cmdline: [cmd, ...args].join(' ') });
  fs.mkdirSync(LOGS, { recursive: true });
  const logf = path.join(LOGS, id + '.log'); const log = fs.createWriteStream(logf);
  const child = spawn(cmd, args, { cwd: workdir, env: { ...process.env, ...env, SS_RUN_ID: id, SS_RUN_NAME: m.name }, stdio: stdio ? ['inherit', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  job.child = child;
  const chunk = (d) => {
    const s = d.toString(); log.write(d);
    job.buf = (job.buf + s).slice(-MAX_BUF); job.emit('data', s);
  };
  child.stdout.on('data', chunk); child.stderr.on('data', chunk);
  child.on('error', (e) => { chunk(`\n[실행 실패] ${e.message}\n`); finish(null, null); });
  let done = false;
  const finish = (code, signal) => {
    if (done) return; done = true;
    job.code = code; job.signal = signal; job.endedAt = Date.now(); log.end();
    try { fs.appendFileSync(HISTORY, JSON.stringify({ id, name: m.name, params: vals, source, startedAt: job.startedAt, endedAt: job.endedAt, code, signal, cwd: workdir }) + '\n'); } catch {}
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
function readLog(id) { if (!/^[a-z0-9]+$/.test(id)) throw err('bad id'); try { return fs.readFileSync(path.join(LOGS, id + '.log'), 'utf8').slice(-MAX_BUF); } catch { return ''; } }

// ───────── Claude 연동: 컨텍스트 요약 / skill / hook ─────────
function usageLine(m) {
  const ps = m.params.map((p) => `--${p.name}${p.type === 'bool' ? '' : ' <' + (p.type === 'choice' ? p.choices.join('|') : p.type) + '>'}${p.required ? '*' : ''}`).join(' ');
  return `ss run ${m.name}${ps ? ' ' + ps : ''}`;
}
function contextText() {
  const ms = list().filter((m) => !m.broken);
  const lines = ['[shooting-star] 등록된 실행 스크립트 (ss run). 사용자가 실행을 요청하면 직접 짜지 말고 아래를 먼저 `ss run <name>` 으로 실행한다. 등록/상세는 ss-run skill 참고.'];
  if (!ms.length) lines.push('(아직 등록된 스크립트 없음 — 반복 작업은 `ss run add` 로 등록할 수 있다)');
  for (const m of ms) lines.push(`- ${usageLine(m)}${m.danger ? '  [danger: --yes 필요]' : ''}${m.description ? ' — ' + m.description : ''}`);
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
    const name = 'ss_run_' + m.name.replace(/[^A-Za-z0-9_-]/g, '_'), description = (m.description || m.name) + (m.danger ? ' [danger]' : '');
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
ss run list [--json]                 # names, descriptions, parameter schema
ss run show <name>                   # one script in detail
ss run <name> --param value ...      # run; stdout/stderr stream through, exit code is the script's
\`\`\`
- When the user asks to run something that is registered, run it right away with \`ss run <name> ...\` — no extra confirmation.
- Scripts marked \`danger\` need \`--yes\`; pass it only when the user explicitly asked for that run.
- Bool params are flags (\`--verbose\`); omit params that have a default unless the user specified a value.
- Unknown params / bad values are rejected with the list of valid ones.

## Register
Prefer registering a script when the user will likely repeat it. Write the script file first, then:
\`\`\`bash
ss run add ./backup.sh --name backup-db --desc "Dump the DB to ~/backups" \\
  --param '{"name":"env","type":"choice","choices":["dev","prod"],"default":"dev","description":"target env"}' \\
  --param '{"name":"keep","type":"number","default":7}' [--danger] [--cwd <dir>] [--interpreter "python3 -u"] [--link] [--force]
\`\`\`
- Param JSON: \`name\` (required), \`type\` string|number|bool|choice|file, \`default\`, \`required\`, \`choices\`, \`description\`, \`as\` flag(default → \`--name value\`)|env|positional, \`flag\` (custom flag text).
- Every param is also exported as env \`SS_PARAM_<NAME>\`, so scripts may read env instead of parsing argv.
- Interpreter is inferred from the extension (.py python3, .sh bash, .js node, .ts npx tsx); otherwise the file must be executable.
- \`--link\` references the file in place instead of copying it into ~/.shooting-star/run/scripts/.
- \`ss run rm <name>\` removes a registration. Give every script a one-line \`--desc\` — it is what future sessions see.

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
  const rules = ['Bash(ss run:*)']; const addedRules = rules.filter((r) => !allow.includes(r)); allow.push(...addedRules);
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
  ss run show <name>              상세 (파라미터 스키마)
  ss run <name> [--파라미터 값…]   실행  (danger 스크립트는 --yes)
  ss run add <file> [--name n] [--desc d] [--param '{json}']… [--danger] [--cwd dir]
                    [--interpreter "python3 -u"] [--link] [--force]
  ss run rm <name>                등록 해제
  ss run history [n]              최근 실행 기록
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
    if (sub === 'show') { const m = get(rest[0]); const { scriptPath: sp, ...pub } = m; console.log(JSON.stringify(pub, null, 2)); console.log('\nscript: ' + sp); console.log('usage:  ' + usageLine(m)); return 0; }
    if (sub === 'context') { console.log(contextText()); return 0; }
    if (sub === 'tools') { const { o } = parseFlags(rest); console.log(JSON.stringify(toolDefs(o.format === 'anthropic' ? 'anthropic' : 'openai'), null, 2)); return 0; }
    if (sub === 'install') {
      const r = install();
      console.log(`✓ skill: ${r.skill}\n✓ ${r.settings}: ${r.hookAdded ? 'SessionStart hook 추가' : 'hook 이미 있음'}${r.rulesAdded.length ? ', 권한 ' + r.rulesAdded.join(', ') + ' 추가 (백업 settings.json.bak-ss)' : ''}\n새 Claude 세션부터 적용됩니다.`);
      return 0;
    }
    if (sub === 'history') { for (const h of history(Number(rest[0]) || 20)) console.log(`${new Date(h.startedAt).toLocaleString()}  ${h.name}  exit=${h.code ?? h.signal}  ${((h.endedAt - h.startedAt) / 1000).toFixed(1)}s  [${h.source}]  ${JSON.stringify(h.params)}`); return 0; }
    if (sub === 'rm') { remove(rest[0]); console.log('removed ' + rest[0]); return 0; }
    if (sub === 'add') {
      const { o, rest: pos } = parseFlags(rest);
      const params = [].concat(o.param || []).map((s) => { try { return JSON.parse(s); } catch { throw err(`--param 은 JSON 이어야 합니다: ${s}`); } });
      const m = add({ name: o.name, description: o.desc || o.description || '', params, danger: !!o.danger, cwd: o.cwd, interpreter: o.interpreter }, pos[0], { link: !!o.link, force: !!o.force });
      console.log(`registered: ${usageLine(m)}`); return 0;
    }
    // ss run <name> …
    const m = get(sub);
    const { o } = parseFlags(rest);
    const yes = !!o.yes; delete o.yes;
    if (m.danger && !yes) {
      if (!process.stdin.isTTY) throw err(`'${m.name}' 은(는) danger 스크립트입니다. 실행하려면 --yes 를 붙이세요.`);
      const ans = await new Promise((r) => { process.stderr.write(`'${m.name}' 은(는) danger 스크립트입니다. 실행할까요? [y/N] `); process.stdin.once('data', (d) => r(String(d).trim())); });
      process.stdin.pause(); if (!/^y(es)?$/i.test(ans)) return 1;
    }
    const given = {}; for (const [k, v] of Object.entries(o)) given[k] = Array.isArray(v) ? v[v.length - 1] : v;
    const job = start(m, given, { cwd: process.cwd(), source: 'cli' });
    job.on('data', (s) => process.stdout.write(s));
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => kill(job.id));
    return await new Promise((r) => job.on('end', ({ code, signal }) => r(code ?? (signal ? 130 : 1))));
  } catch (e) { console.error(e.message); return e.status === 404 ? 127 : 2; }
}

module.exports = { DIR, list, get, add, remove, start, kill, jobs, history, readLog, normalizeManifest, contextText, install, cli, scriptPath, err };
