'use strict';
// shooting-star Secret: 세션키/토큰 같은 짧게 사는 비밀을 간단히 저장/주입한다.
// 저장 위치: ~/.shooting-star/secrets.json (권한 0600). 키체인·암호화는 쓰지 않는다 — 몇 분짜리 세션키용.
// 스크립트에는 env 로만 주입된다 (SS_SECRET_<NAME>). git·로그·argv·화면 어디에도 값이 남지 않는다.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const FILE = path.join(HOME, '.shooting-star', 'secrets.json');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const envName = (name) => 'SS_SECRET_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function readAll() { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
function writeAll(s) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch {}
}
function checkName(name) { if (!NAME_RE.test(name || '')) throw err(`잘못된 이름: ${name} (영문/숫자/._- 최대 64자)`); return name; }

// 값은 절대 돌려주지 않는다 — 이름/길이/저장시각만
function list() {
  const s = readAll();
  return Object.keys(s).sort().map((name) => ({ name, env: envName(name), len: String(s[name].value ?? '').length, savedAt: s[name].savedAt || 0, note: s[name].note || '' }));
}
function has(name) { return Object.prototype.hasOwnProperty.call(readAll(), checkName(name)); }
function get(name) { const e = readAll()[checkName(name)]; return e ? String(e.value ?? '') : undefined; }
function set(name, value, { note } = {}) {
  checkName(name);
  if (typeof value !== 'string' || value === '') throw err('빈 값은 저장할 수 없습니다');
  const s = readAll();
  s[name] = { value, savedAt: Date.now(), ...(note ? { note: String(note) } : s[name] && s[name].note ? { note: s[name].note } : {}) };
  writeAll(s);
  return { name, env: envName(name), len: value.length };
}
function remove(name) { const s = readAll(); if (!Object.prototype.hasOwnProperty.call(s, checkName(name))) throw err(`저장된 세션키가 없습니다: ${name}`, 404); delete s[name]; writeAll(s); }

// 매니페스트의 secrets: 를 정규화. 문자열 'airflow' 또는 { name, env?, required? }
function normalize(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw err('secrets 는 배열이어야 합니다 (예: [airflow] 또는 [{name: airflow}])');
  return list.map((x) => {
    const o = typeof x === 'string' ? { name: x } : { ...x };
    checkName(o.name);
    const out = { name: o.name };
    if (o.env) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.env)) throw err(`secret ${o.name}: env 이름이 잘못됨`); out.env = o.env; }
    if (o.required === false) out.required = false; else out.required = true;
    if (o.description) out.description = String(o.description);
    return out;
  });
}
// 실행 env 에 주입. 선언된 secret 중 저장돼 있으면 넣고, required 인데 없으면 모아서 알려준다.
function injectEnv(secrets) {
  const env = {}, missing = [];
  for (const sdef of normalize(secrets)) {
    const v = get(sdef.name);
    if (v === undefined) { if (sdef.required) missing.push(sdef.name); continue; }
    env[sdef.env || envName(sdef.name)] = v;
  }
  if (missing.length) throw err(`세션키가 저장돼 있지 않습니다: ${missing.join(', ')}  (ss secret set ${missing[0]})`);
  return env;
}

// ───────── CLI (ss secret …) ─────────
function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
function promptHidden(q) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(readStdin().replace(/\r?\n$/, ''));
    process.stderr.write(q);
    const stdin = process.stdin, prev = stdin.isRaw;
    stdin.setRawMode && stdin.setRawMode(true); stdin.resume();
    let buf = '';
    const onData = (d) => {
      const s = d.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') { stdin.setRawMode && stdin.setRawMode(prev); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); return resolve(buf); }
        else if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        else if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
const HELP = `ss secret — 세션키/토큰 저장 (스크립트에 env SS_SECRET_<NAME> 로 주입)

  ss secret list                  저장된 이름 (값은 안 보임)
  ss secret set <name> [값]        저장. 값을 생략하면 가려서 입력받음 (파이프도 가능)
  ss secret get <name>             값 출력 (주의: 화면/로그에 남음)
  ss secret rm <name>              삭제

  스크립트에서 쓰려면 매니페스트에  secrets: [<name>]  을 선언한다.
  저장은 ~/.shooting-star/secrets.json (권한 600). 몇 분짜리 세션키는 만료되면 다시 set 하면 됨.`;
async function cli(argv) {
  const [sub, ...rest] = argv;
  try {
    if (!sub || sub === 'help' || sub === '-h' || sub === '--help') { process.stdout.write(HELP + '\n'); return 0; }
    if (sub === 'list' || sub === 'ls') {
      const ls = list();
      if (rest.includes('--json')) { process.stdout.write(JSON.stringify(ls, null, 2) + '\n'); return 0; }
      if (!ls.length) { console.log('저장된 세션키가 없습니다. (ss secret set <name>)'); return 0; }
      for (const s of ls) console.log(`${s.name}  (${s.env}, ${s.len}자, ${s.savedAt ? new Date(s.savedAt).toLocaleString() : '?'})${s.note ? '  — ' + s.note : ''}`);
      return 0;
    }
    if (sub === 'set') {
      const name = rest[0]; if (!name) throw err('ss secret set <name> [값]');
      let value = rest.slice(1).join(' ');
      if (!value) value = (await promptHidden(`${name} 값 붙여넣기 (화면에 안 보임): `)).trim();
      const r = set(name, value);
      console.log(`저장됨: ${r.name}  (${r.env}, ${r.len}자)`); return 0;
    }
    if (sub === 'get') { const v = get(rest[0] || ''); if (v === undefined) throw err(`저장된 세션키가 없습니다: ${rest[0]}`, 404); process.stdout.write(v + '\n'); return 0; }
    if (sub === 'rm' || sub === 'remove' || sub === 'delete') { remove(rest[0] || ''); console.log('removed ' + rest[0]); return 0; }
    throw err(`알 수 없는 명령: ${sub}\n${HELP}`);
  } catch (e) { console.error(e.message); return e.status === 404 ? 127 : 2; }
}

module.exports = { FILE, list, has, get, set, remove, normalize, injectEnv, envName, cli };
