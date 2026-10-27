'use strict';
// shooting-star DB: 연결 관리 / 스키마 조회 / 쿼리 실행. UI(서버 API)와 CLI(`ss db …`)가 같이 쓴다.
// 드라이버는 앱에 포함하지 않고, 처음 연결할 때 ~/.shooting-star/drivers 에 npm 으로 자동 설치한다 (7일마다 최신으로 업데이트) (SQLite 는 node:sqlite 내장, Trino 는 REST).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createRequire } = require('module');

const HOME = os.homedir();
const BASE = path.join(HOME, '.shooting-star');
const DIR = path.join(BASE, 'db');
const CONN_FILE = path.join(DIR, 'connections.json');
const SECRETS_FILE = path.join(DIR, 'secrets.json');
const DRIVERS = path.join(BASE, 'drivers');
const err = (msg, status = 400, code) => Object.assign(new Error(msg), { status, code });

const KINDS = {
  postgres: { label: 'PostgreSQL', pkg: 'pg', port: 5432 },
  mysql: { label: 'MySQL', pkg: 'mysql2', port: 3306 },
  mariadb: { label: 'MariaDB', pkg: 'mysql2', port: 3306 },
  sqlite: { label: 'SQLite', file: true },
  duckdb: { label: 'DuckDB', pkg: '@duckdb/node-api', file: true },
  trino: { label: 'Trino', port: 8080 },
};

// ───────── 연결 저장소 ─────────
const readConns = () => { try { const j = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
const writeConns = (list) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CONN_FILE, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 }); };
// 비밀번호는 ~/.shooting-star/db/secrets.json (권한 0600, 연결 id → 비밀번호)에 저장한다. 키체인은 쓰지 않는다.
const fileSecrets = () => { try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { return {}; } };
const putFileSecrets = (s) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(SECRETS_FILE, JSON.stringify(s), { mode: 0o600 }); fs.chmodSync(SECRETS_FILE, 0o600); };
const setSecret = (id, pw) => putFileSecrets({ ...fileSecrets(), [id]: pw });
const getSecret = (id) => fileSecrets()[id] || '';
function delSecret(id) { const s = fileSecrets(); if (id in s) { delete s[id]; putFileSecrets(s); } }
const hasSecret = (id) => !!getSecret(id);

function normalize(c) {
  const k = KINDS[c.kind]; if (!k) throw err(`지원하지 않는 DB 종류: ${c.kind} (${Object.keys(KINDS).join(', ')})`);
  if (!c.name || !/^[^\s].{0,63}$/.test(c.name)) throw err('이름을 입력하세요 (최대 64자)');
  const out = { id: c.id || crypto.randomBytes(4).toString('hex'), name: c.name.trim(), kind: c.kind, readOnly: c.readOnly !== false };
  if (k.file) { if (!c.file && c.kind !== 'duckdb') throw err('파일 경로가 필요합니다'); out.file = String(c.file || ':memory:').replace(/^~(?=$|\/)/, HOME); }
  else {
    if (!c.host) throw err('host 가 필요합니다');
    Object.assign(out, { host: String(c.host), port: Number(c.port) || k.port, user: String(c.user || ''), database: String(c.database || '') });
    if (c.kind === 'trino') { out.catalog = String(c.catalog || ''); out.https = !!c.https; }   // catalog 는 선택: 비우면 모든 catalog 를 보여 주고 SQL 에서 catalog.schema.table 로 쓴다
    if (c.ssl) out.ssl = true;
  }
  return out;
}
function listConnections() {
  return readConns().map((c) => ({ ...c, hasPassword: !k_file(c) && hasSecret(c.id), driver: driverState(c.kind), driverVersion: driverVersion(c.kind) }));
}
const k_file = (c) => !!KINDS[c.kind]?.file;
function saveConnection(c, password) {
  const list = readConns(), old = c.id && list.find((x) => x.id === c.id);
  const n = normalize(c);
  if (list.some((x) => x.name === n.name && x.id !== n.id)) throw err(`같은 이름의 연결이 있습니다: ${n.name}`);
  if (typeof password === 'string' && password !== '' && !k_file(n)) setSecret(n.id, password);   // 비밀번호를 먼저 저장 (실패하면 연결도 만들지 않는다)
  if (old) list[list.indexOf(old)] = n; else list.push(n);
  writeConns(list);
  closeConn(n.id);
  return n;
}
function deleteConnection(id) { writeConns(readConns().filter((c) => c.id !== id)); delSecret(id); closeConn(id); }
function findConn(ref) {   // id 또는 이름
  const list = readConns(), c = list.find((x) => x.id === ref) || list.find((x) => x.name === ref);
  if (!c) throw err(`연결을 찾을 수 없습니다: ${ref}  (ss db list)`, 404);
  return c;
}

// ───────── 드라이버 (선택 설치) ─────────
function driverState(kind) {
  const k = KINDS[kind]; if (!k) return 'unknown';
  if (kind === 'sqlite') return hasNodeSqlite() ? 'builtin' : 'unsupported';
  if (!k.pkg) return 'builtin';
  return fs.existsSync(path.join(DRIVERS, 'node_modules', k.pkg)) ? 'installed' : 'missing';
}
function hasNodeSqlite() { try { require('node:sqlite'); return true; } catch { return false; } }
// 드라이버가 없으면 처음 연결할 때 자동으로 설치하고, 설치된 지 UPDATE_DAYS 가 지나면 백그라운드로 최신 버전으로 올린다 (다음 실행부터 적용)
const UPDATE_DAYS = 7, installing = new Map();   // pkg → 진행 중인 설치 Promise (mysql/mariadb 처럼 같은 패키지를 동시에 설치하지 않도록)
const stampFile = (pkg) => path.join(DRIVERS, '.updated-' + pkg.replace(/[\/@]/g, '_'));
async function loadDriver(kind) {
  const k = KINDS[kind];
  if (kind === 'sqlite') { if (driverState(kind) !== 'builtin') throw err('SQLite 는 Node 22.5 이상이 필요합니다 (brew upgrade node)', 400, 'NO_DRIVER'); return require('node:sqlite'); }
  if (driverState(kind) === 'missing') {
    try { await installDriver(kind); } catch (e) { throw err(`${k.label} 드라이버(${k.pkg}) 자동 설치 실패 — ${e.message}`, 424, 'NO_DRIVER'); }
  } else {
    let age = Infinity; try { age = Date.now() - fs.statSync(stampFile(k.pkg)).mtimeMs; } catch {}
    if (age > UPDATE_DAYS * 864e5) installDriver(kind).catch(() => {});   // 업데이트는 기다리지 않는다 (실패해도 현재 버전으로 계속)
  }
  return createRequire(path.join(DRIVERS, 'x.js'))(k.pkg);
}
function installDriver(kind) {   // 설치 = 업데이트: 항상 최신 버전(@latest)으로 설치한다
  const k = KINDS[kind]; if (!k?.pkg) return Promise.resolve({ ok: true, note: '설치가 필요 없습니다' });
  if (installing.has(k.pkg)) return installing.get(k.pkg);
  fs.mkdirSync(DRIVERS, { recursive: true });
  const pj = path.join(DRIVERS, 'package.json'); if (!fs.existsSync(pj)) fs.writeFileSync(pj, '{"name":"ss-drivers","private":true}\n');
  // 앱(Spotlight)으로 실행되면 PATH 가 없으므로 node 옆의 npm 을 쓴다
  const nodeDir = path.dirname(process.execPath), npm = fs.existsSync(path.join(nodeDir, 'npm')) ? path.join(nodeDir, 'npm') : 'npm';
  const env = { ...process.env, PATH: [nodeDir, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(path.delimiter) };
  const p = new Promise((resolve, reject) => execFile(npm, ['install', '--prefix', DRIVERS, k.pkg + '@latest', '--no-audit', '--no-fund', '--loglevel=error'], { env, timeout: 300000, maxBuffer: 4 << 20 }, (e, so, se) => {
    if (e) return reject(err(`${k.pkg} 설치 실패: ${(String(se) || e.message).trim().slice(-600)}`, 500));
    try { fs.writeFileSync(stampFile(k.pkg), ''); } catch {}
    resolve({ ok: true, version: driverVersion(kind) });
  })).finally(() => installing.delete(k.pkg));
  installing.set(k.pkg, p); return p;
}
function driverVersion(kind) {
  const k = KINDS[kind]; if (!k?.pkg) return '';
  try { return JSON.parse(fs.readFileSync(path.join(DRIVERS, 'node_modules', k.pkg, 'package.json'), 'utf8')).version; } catch { return ''; }
}

// ───────── 값 직렬화 ─────────
function ser(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'bigint') return v.toString();
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (v instanceof Date) return isNaN(v) ? String(v) : v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) { const b = Buffer.from(v); return '0x' + b.subarray(0, 32).toString('hex') + (b.length > 32 ? `… (${b.length} bytes)` : ''); }
  if (Array.isArray(v)) return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
  if (t === 'object') { try { return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)); } catch { return String(v); } }
  return String(v);
}

// ───────── 어댑터: { query(sql, {limit}) → {columns, rows, affected?}, close() } ─────────
const pwOf = (c) => getSecret(c.id);
async function openPostgres(c) {
  const { Client } = await loadDriver('postgres');
  const cfg = { host: c.host, port: c.port, user: c.user || undefined, password: pwOf(c) || undefined, database: c.database || undefined, ssl: c.ssl ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10000, statement_timeout: 120000 };
  const cl = new Client(cfg);
  await cl.connect();
  cl.on('error', () => {});
  return {
    async query(sql, { limit }) {
      let res;
      if (c.readOnly) { await cl.query('BEGIN READ ONLY'); try { res = await cl.query({ text: sql, rowMode: 'array' }); } finally { await cl.query('ROLLBACK').catch(() => {}); } }
      else res = await cl.query({ text: sql, rowMode: 'array' });
      if (Array.isArray(res)) res = res[res.length - 1];   // 여러 문장이면 마지막 결과
      if (!res.fields?.length) return { columns: [], rows: [], affected: res.rowCount ?? 0, command: res.command };
      return { columns: res.fields.map((f) => f.name), rows: res.rows.slice(0, limit + 1) };
    },
    async cancel() { const k = new Client(cfg); await k.connect(); try { await k.query('SELECT pg_cancel_backend($1)', [cl.processID]); } finally { await k.end().catch(() => {}); } },
    close: () => cl.end().catch(() => {}),
  };
}
async function openMysql(c) {
  const mysql = await loadDriver(c.kind);
  const cfg = { host: c.host, port: c.port, user: c.user || undefined, password: pwOf(c) || undefined, database: c.database || undefined, ssl: c.ssl ? { rejectUnauthorized: false } : undefined, connectTimeout: 10000, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, rowsAsArray: true };
  const cn = await mysql.createConnection(cfg);
  return {
    async query(sql, { limit }) {
      if (c.readOnly) await cn.query('SET SESSION TRANSACTION READ ONLY');
      const [rows, fields] = await cn.query({ sql, rowsAsArray: true });
      if (Array.isArray(fields) && fields.length && Array.isArray(rows)) return { columns: fields.map((f) => f.name), rows: rows.slice(0, limit + 1) };
      const last = Array.isArray(rows) && rows.length && !Array.isArray(rows[0]) ? rows[rows.length - 1] : rows;   // 여러 문장
      return { columns: [], rows: [], affected: last?.affectedRows ?? 0 };
    },
    async cancel() { const k = await mysql.createConnection(cfg); try { await k.query('KILL QUERY ' + Number(cn.threadId)); } finally { await k.end().catch(() => {}); } },
    close: () => cn.end().catch(() => {}),
  };
}
async function openSqlite(c) {
  const { DatabaseSync } = await loadDriver('sqlite');
  if (c.file !== ':memory:' && !fs.existsSync(c.file)) throw err(`파일이 없습니다: ${c.file}`, 404);
  const db = new DatabaseSync(c.file, { readOnly: !!c.readOnly });
  return {
    async query(sql, { limit }) {
      const st = db.prepare(sql);
      const cols = typeof st.columns === 'function' ? st.columns() : [];
      if (!cols.length) { const r = st.run(); return { columns: [], rows: [], affected: Number(r.changes) }; }
      if (typeof st.setReturnArrays === 'function') st.setReturnArrays(true);
      const rows = []; for (const r of st.iterate()) { rows.push(Array.isArray(r) ? r : Object.values(r)); if (rows.length > limit) break; }
      return { columns: cols.map((x) => x.name), rows };
    },
    close: () => { try { db.close(); } catch {} },
  };
}
async function openDuckdb(c) {
  const { DuckDBInstance } = await loadDriver('duckdb');
  const file = c.file === ':memory:' || !c.file ? ':memory:' : c.file;
  if (file !== ':memory:' && c.readOnly && !fs.existsSync(file)) throw err(`파일이 없습니다: ${file}`, 404);
  const inst = await DuckDBInstance.create(file, file !== ':memory:' && c.readOnly ? { access_mode: 'READ_ONLY' } : {});
  const cn = await inst.connect();
  return {
    async query(sql, { limit }) {
      const r = await cn.runAndReadAll(sql);
      const columns = r.columnNames();
      if (!columns.length) return { columns: [], rows: [], affected: 0 };
      return { columns, rows: r.getRowsJson ? r.getRowsJson().slice(0, limit + 1) : r.getRows().slice(0, limit + 1) };
    },
    async cancel() { cn.interrupt(); },
    close: () => { try { cn.closeSync?.(); inst.closeSync?.(); } catch {} },
  };
}
async function openTrino(c) {
  const base = `${c.https ? 'https' : 'http'}://${c.host}:${c.port}`;
  const pw = pwOf(c);
  const headers = { 'X-Trino-User': c.user || os.userInfo().username, ...(c.catalog ? { 'X-Trino-Catalog': c.catalog, ...(c.database ? { 'X-Trino-Schema': c.database } : {}) } : {}), 'User-Agent': 'shooting-star' };
  if (pw) headers.Authorization = 'Basic ' + Buffer.from(`${c.user}:${pw}`).toString('base64');
  let ctl = null, nextUri = null;
  const req = (url, opt) => { const t = setTimeout(() => ctl.abort(), 30000); return fetch(url, { ...opt, headers, signal: ctl.signal }).finally(() => clearTimeout(t)); };
  return {
    async query(sql, { limit }) {
      ctl = new AbortController(); nextUri = null;
      let res;
      try { res = await req(base + '/v1/statement', { method: 'POST', body: sql }); } catch (e) { throw err(ctl.signal.aborted ? '취소되었거나 시간이 초과되었습니다' : e.message, 400); }
      let columns = [], rows = [];
      for (;;) {
        const j = await res.json().catch(() => ({}));
        if (!res.ok && !j.error) throw err(`Trino HTTP ${res.status}`, 502);
        if (j.error) throw err(j.error.message || 'Trino 오류', 400);
        if (j.columns && !columns.length) columns = j.columns.map((x) => x.name);
        if (j.data) rows.push(...j.data);
        nextUri = j.nextUri || null;
        if (rows.length > limit || !j.nextUri) break;
        await new Promise((r) => setTimeout(r, j.data ? 0 : 150));
        try { res = await req(j.nextUri, {}); } catch (e) { throw err(ctl.signal.aborted ? '취소되었거나 시간이 초과되었습니다' : e.message, 400); }
      }
      if (nextUri) fetch(nextUri, { method: 'DELETE', headers }).catch(() => {});   // 남은 결과는 서버에서 정리
      return { columns, rows: rows.slice(0, limit + 1), affected: columns.length ? undefined : 0 };
    },
    async cancel() { ctl?.abort(); if (nextUri) await fetch(nextUri, { method: 'DELETE', headers }).catch(() => {}); },
    close() {},
  };
}
const OPEN = { postgres: openPostgres, mysql: openMysql, mariadb: openMysql, sqlite: openSqlite, duckdb: openDuckdb, trino: openTrino };

// 연결 캐시 (서버 프로세스 동안 유지, 오래 쓰지 않으면 닫음)
const pool = new Map();
function closeConn(id) { const p = pool.get(id); if (p) { pool.delete(id); p.then((a) => a.close()).catch(() => {}); } }
function adapter(c) {
  let p = pool.get(c.id);
  if (!p) { p = OPEN[c.kind](c); pool.set(c.id, p); p.catch(() => pool.delete(c.id)); }
  const timer = (pool.get('t:' + c.id)); if (timer) clearTimeout(timer);
  const t = setTimeout(() => closeConn(c.id), 10 * 60 * 1000); t.unref(); pool.set('t:' + c.id, t);
  return p;
}

// ───────── 쿼리 ─────────
const READ_RE = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(select|with|show|describe|desc|explain|pragma|values|table|from)\b/i;
const HIST_FILE = path.join(DIR, 'history.jsonl'), HIST_MAX = 2000;
function logHistory(c, sql, info) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(HIST_FILE, JSON.stringify({ t: Date.now(), connId: c.id, conn: c.name, sql: sql.slice(0, 20000), ...info }) + '\n', { mode: 0o600 });
    if (Math.random() < 0.02) { const lines = fs.readFileSync(HIST_FILE, 'utf8').trim().split('\n'); if (lines.length > HIST_MAX) fs.writeFileSync(HIST_FILE, lines.slice(-HIST_MAX / 2).join('\n') + '\n', { mode: 0o600 }); }
  } catch {}
}
function history({ id, q, limit = 100 } = {}) {
  let rows = []; try { rows = fs.readFileSync(HIST_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  if (id) rows = rows.filter((r) => r.connId === id);
  if (q) { const w = String(q).toLowerCase(); rows = rows.filter((r) => r.sql.toLowerCase().includes(w)); }
  return rows.reverse().slice(0, Math.min(500, Number(limit) || 100));
}
const running = new Map();   // 연결 id → 실행 중인 어댑터 (취소용)
// 페이징: SELECT 류는 서브쿼리로 감싸 LIMIT/OFFSET 을 건다 (DataGrip 처럼). 감쌀 수 없거나(여러 문장, SHOW/EXPLAIN 등) 감싼 쿼리가 실패하면 원본 그대로 실행한다.
const WRAP_RE = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(select|with|values|table|from)\b/i;
const stripTail = (sql) => sql.trim().replace(/(?:\s*;|\s*--[^\n]*|\s*\/\*[\s\S]*?\*\/)+\s*$/, '');   // 끝의 세미콜론/주석 제거
function wrapSql(c, sql) {
  const body = stripTail(sql);
  if (!WRAP_RE.test(body) || body.includes(';')) return null;
  return (n, offset) => (c.kind === 'trino' ? `SELECT * FROM (\n${body}\n) AS ss_page OFFSET ${offset} LIMIT ${n}` : `SELECT * FROM (\n${body}\n) AS ss_page LIMIT ${n} OFFSET ${offset}`);
}
async function exec(c, sql, limit) {   // 로깅 없이 실행 (취소 추적만)
  const ad = await adapter(c); running.set(c.id, ad);
  try { return await ad.query(sql, { limit }); } finally { running.delete(c.id); }
}
async function query(ref, sql, { limit = 1000, offset = 0, paginate = true, force = false, internal = false, src = 'ui' } = {}) {
  const c = typeof ref === 'object' ? ref : findConn(ref);
  if (!sql || !sql.trim()) throw err('SQL 이 비어 있습니다');
  if (c.readOnly && !force && !READ_RE.test(sql)) throw err('읽기 전용 연결입니다 (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 만 가능). 쓰려면 연결 설정에서 읽기 전용을 끄세요.', 403, 'READ_ONLY');
  limit = Math.max(1, Math.min(100000, Number(limit) || 1000)); offset = Math.max(0, Number(offset) || 0);
  const t0 = Date.now(); let r, paged = false;
  try {
    const wrap = paginate ? wrapSql(c, sql) : null;
    if (wrap) {
      try { r = await exec(c, wrap(limit + 1, offset), limit); paged = true; }
      catch (e) { if (e.code === 'NO_DRIVER' || /취소|cancel|interrupt/i.test(e.message)) throw e; if (offset > 0) throw e; r = null; }   // 감싸기 실패 → 원본으로 재시도 (1쪽일 때만)
    }
    if (!r) { if (offset > 0) throw err('이 쿼리는 페이징할 수 없습니다'); r = await exec(c, sql, limit); }
  } catch (e) {
    const out = e.status ? e : err(String(e.message || e).replace(/^error: /i, ''), 400);
    if (!e.status && e.code !== 'NO_DRIVER') closeConn(c.id);
    if (!internal && e.code !== 'NO_DRIVER') logHistory(c, sql, { ok: false, err: out.message.slice(0, 300), ms: Date.now() - t0, src });
    throw out;
  }
  const hasMore = r.rows.length > limit;
  const rows = r.rows.slice(0, limit).map((row) => row.map(ser));
  if (!internal) logHistory(c, sql, { ok: true, rows: r.columns.length ? rows.length : undefined, affected: r.affected, ms: Date.now() - t0, src, ...(offset ? { offset } : {}) });
  return { columns: r.columns, rows, truncated: hasMore, hasMore, limit, offset, paged, affected: r.affected, ms: Date.now() - t0 };
}
async function count(ref, sql) {   // 전체 행 수 (요청할 때만)
  const c = findConn(ref), wrap = wrapSql(c, sql);
  if (!wrap) throw err('이 쿼리는 행 수를 셀 수 없습니다 (SELECT/WITH 한 문장만 가능)');
  const body = stripTail(sql);
  const r = await query(c, `SELECT count(*) FROM (\n${body}\n) AS ss_cnt`, { limit: 1, paginate: false, internal: true });
  return { count: Number(r.rows[0]?.[0]), ms: r.ms };
}
async function cancel(ref) {
  const c = findConn(ref), ad = running.get(c.id);
  if (!ad) return { ok: false, note: '실행 중인 쿼리가 없습니다' };
  if (!ad.cancel) throw err('이 DB(SQLite)는 실행 중인 쿼리를 취소할 수 없습니다');
  await ad.cancel(); return { ok: true };
}
async function test(c, password) {
  const tmp = { ...normalize(c), id: 'test-' + crypto.randomBytes(3).toString('hex') };
  if (password) { setSecret(tmp.id, password); } else if (c.id) { const s = getSecret(c.id); if (s) setSecret(tmp.id, s); }
  const t0 = Date.now();
  try { await query(tmp, 'SELECT 1', { force: true, limit: 1, internal: true }); return { ok: true, ms: Date.now() - t0 }; }
  finally { closeConn(tmp.id); delSecret(tmp.id); }
}

// ───────── 스키마 탐색 (지연 로딩: 스키마 → 테이블 → 컬럼) ─────────
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const qid = (kind, s) => (kind === 'mysql' || kind === 'mariadb' ? '`' + String(s).replace(/`/g, '``') + '`' : '"' + String(s).replace(/"/g, '""') + '"');
const SYS = {
  postgres: ['pg_catalog', 'information_schema', 'pg_toast'], mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'], mariadb: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  duckdb: ['information_schema', 'pg_catalog'], trino: ['information_schema'],
};
// Trino 에서 catalog 를 비워 두면 트리의 스키마 이름이 'catalog.schema' 가 된다 → information_schema 앞에 붙일 catalog 와 실제 스키마로 나눈다
function trinoScope(c, schema) {
  if (c.kind !== 'trino') return { cat: '', schema };
  if (c.catalog) return { cat: qid('trino', c.catalog) + '.', schema };
  const i = String(schema ?? '').indexOf('.');
  return i < 0 ? { cat: '', schema } : { cat: qid('trino', schema.slice(0, i)) + '.', schema: schema.slice(i + 1) };
}
async function children(ref, { schema: s0, table } = {}) {
  const c = findConn(ref), kind = c.kind, q = (sql) => query(c, sql, { limit: 5000, force: true, internal: true }).then((r) => r.rows);
  if (kind === 'trino' && !c.catalog && !s0) return (await q("SELECT table_cat, table_schem FROM system.jdbc.schemas WHERE table_schem <> 'information_schema' ORDER BY 1, 2")).map(([ct, sc]) => ({ name: `${ct}.${sc}`, type: 'schema' }));
  const { cat, schema } = trinoScope(c, s0);
  if (kind === 'sqlite') {
    if (!schema) return [{ name: 'main', type: 'schema' }];
    if (!table) return (await q("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")).map(([name, type]) => ({ name, type }));
    return (await q(`PRAGMA table_info(${qid(kind, table)})`)).map((r) => ({ name: r[1], type: 'column', dataType: r[2], nullable: !r[3], pk: !!r[5] }));
  }
  if (!schema) {
    const where = kind === 'duckdb' ? ' WHERE catalog_name = current_database()' : '';
    const rows = await q(`SELECT schema_name FROM ${cat}information_schema.schemata${where} ORDER BY 1`);
    return rows.map((r) => r[0]).filter((s) => !(SYS[kind] || []).includes(String(s).toLowerCase())).map((name) => ({ name, type: 'schema' }));
  }
  const cw = kind === 'duckdb' ? ' AND table_catalog = current_database()' : '';
  if (!table) return (await q(`SELECT table_name, table_type FROM ${cat}information_schema.tables WHERE table_schema = ${lit(schema)}${cw} ORDER BY 1`)).map(([name, tt]) => ({ name, type: /view/i.test(tt) ? 'view' : 'table' }));
  return (await q(`SELECT column_name, data_type, is_nullable FROM ${cat}information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)}${cw} ORDER BY ordinal_position`)).map(([name, dataType, nl]) => ({ name, type: 'column', dataType, nullable: /^y/i.test(nl) }));
}
async function names(ref) {   // 자동완성용: 모든 테이블/뷰 이름
  const c = findConn(ref), kind = c.kind, q = (sql) => query(c, sql, { limit: 5000, force: true, internal: true }).then((r) => r.rows);
  if (kind === 'sqlite') return (await q("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")).map(([name, type]) => ({ schema: 'main', name, type }));
  if (kind === 'trino' && !c.catalog) return (await q("SELECT table_cat, table_schem, table_name, table_type FROM system.jdbc.tables WHERE table_schem <> 'information_schema' ORDER BY 1, 2, 3")).map(([ct, sc, name, tt]) => ({ schema: `${ct}.${sc}`, name, type: /view/i.test(tt) ? 'view' : 'table' }));
  const { cat } = trinoScope(c);
  const sys = (SYS[kind] || []).map(lit).join(','), cw = kind === 'duckdb' ? ' AND table_catalog = current_database()' : '';
  return (await q(`SELECT table_schema, table_name, table_type FROM ${cat}information_schema.tables WHERE table_schema NOT IN (${sys || "''"})${cw} ORDER BY 1, 2`)).map(([schema, name, tt]) => ({ schema, name, type: /view/i.test(tt) ? 'view' : 'table' }));
}
async function keys(ref, schema, table) {   // 기본 키 컬럼들 (순서대로)
  const c = typeof ref === 'object' ? ref : findConn(ref), kind = c.kind, q = (sql) => query(c, sql, { limit: 100, force: true, internal: true }).then((r) => r.rows);
  if (kind === 'sqlite') return (await q(`PRAGMA table_info(${qid(kind, table)})`)).filter((r) => Number(r[5]) > 0).sort((a, b) => a[5] - b[5]).map((r) => r[1]);
  if (kind === 'trino') return [];
  if (kind === 'postgres') return (await q(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indisprimary AND i.indrelid = ${lit(qid(kind, schema) + '.' + qid(kind, table))}::regclass ORDER BY array_position(i.indkey::int[], a.attnum::int)`)).map((r) => r[0]);
  if (kind === 'duckdb') return (await q(`SELECT name FROM pragma_table_info(${lit(qid(kind, schema) + '.' + qid(kind, table))}) WHERE pk ORDER BY cid`)).map((r) => r[0]);
  return (await q(`SELECT column_name FROM information_schema.key_column_usage WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)} AND constraint_name = 'PRIMARY' ORDER BY ordinal_position`)).map((r) => r[0]);
}
// 결과 그리드에서 수정한 셀을 UPDATE 로 적용 (한 트랜잭션, 각 문장이 정확히 1행만 바꿔야 함)
async function updateRows(ref, schema, table, changes) {
  const c = findConn(ref);
  if (c.readOnly) throw err('읽기 전용 연결입니다. 연결 설정에서 읽기 전용을 끄세요.', 403, 'READ_ONLY');
  if (c.kind === 'trino') throw err('Trino 는 편집을 지원하지 않습니다');
  if (!Array.isArray(changes) || !changes.length || changes.length > 500) throw err('변경 내용이 없거나 너무 많습니다 (최대 500건)');
  const pk = await keys(c, schema, table);
  if (!pk.length) throw err('기본 키(PK)가 없는 테이블은 편집할 수 없습니다');
  const L = (v) => { if (v === null) return 'NULL'; let x = String(v); if (x.includes('\0')) throw err('NUL 문자는 사용할 수 없습니다'); if (c.kind === 'mysql' || c.kind === 'mariadb') x = x.replace(/\\/g, '\\\\'); return "'" + x.replace(/'/g, "''") + "'"; };
  const tbl = (schema && c.kind !== 'sqlite' ? qid(c.kind, schema) + '.' : '') + qid(c.kind, table), stmts = [];
  for (const ch of changes) {
    if (!ch || typeof ch.set !== 'object' || typeof ch.pk !== 'object' || !Object.keys(ch.set).length) throw err('잘못된 변경 형식');
    for (const k of pk) if (!(k in ch.pk) || ch.pk[k] === null) throw err(`PK 컬럼 ${k} 값이 없습니다 (결과에 PK 컬럼이 포함되어야 편집할 수 있습니다)`);
    stmts.push(`UPDATE ${tbl} SET ${Object.entries(ch.set).map(([k, v]) => `${qid(c.kind, k)} = ${L(v)}`).join(', ')} WHERE ${pk.map((k) => `${qid(c.kind, k)} = ${L(ch.pk[k])}`).join(' AND ')}`);
  }
  const ad = await adapter(c), t0 = Date.now(), run = (sql) => ad.query(sql, { limit: 1 });
  try {
    await run(c.kind === 'mysql' || c.kind === 'mariadb' ? 'START TRANSACTION' : 'BEGIN');
    for (const st of stmts) {
      const r = await run(st), n = r.affected ?? (r.columns[0] === 'Count' ? Number(r.rows[0]?.[0]) : null);
      if (n !== 1) throw err(`수정이 ${n}행에 적용되려 했습니다 (1행이어야 함) — 모두 취소했습니다`);
    }
    await run('COMMIT');
  } catch (e) { await run('ROLLBACK').catch(() => {}); logHistory(c, stmts.join(';\n'), { ok: false, err: String(e.message).slice(0, 300), ms: Date.now() - t0, src: 'ui-edit' }); throw e.status ? e : err(String(e.message).replace(/^error: /i, ''), 400); }
  logHistory(c, stmts.join(';\n'), { ok: true, affected: stmts.length, ms: Date.now() - t0, src: 'ui-edit' });
  return { applied: stmts.length };
}
const selectAll = (ref, schema, table, limit = 100) => {
  const c = findConn(ref), k = c.kind, sc = k === 'trino' && !c.catalog ? String(schema || '').split('.').map((x) => qid(k, x)).join('.') : schema && qid(k, schema), t = (schema && k !== 'sqlite' ? sc + '.' : '') + qid(k, table);
  return `SELECT * FROM ${t} LIMIT ${limit}`;
};

// ───────── CLI: ss db … ─────────
const HELP = `ss db — DB 연결/쿼리 (UI 의 DB 메뉴, Claude/OpenAI 에이전트와 공유)

  ss db list [--json]                          등록된 연결
  ss db query <연결> "<SQL>" [--limit 1000] [--offset 0] [--json|--csv]
                                               쿼리 실행 (읽기 전용 연결은 SELECT 류만)
  ss db schema <연결> [<스키마> [<테이블>]]      스키마/테이블/컬럼 조회
  ss db add <이름> --kind postgres|mysql|mariadb|sqlite|duckdb|trino [--host h --port p --user u --database d | --file f]
            [--catalog c (Trino, 선택)] [--password-env VAR] [--write]      (비밀번호는 환경변수에서 읽어 ~/.shooting-star/db/secrets.json 에 저장; --write 가 없으면 읽기 전용)
  ss db history [연결] [n]                     최근 실행한 쿼리 (UI 와 공유)
  ss db rm <연결>
  ss db driver <종류>                          드라이버 설치·최신으로 업데이트 (postgres/mysql/mariadb/duckdb)
`;
const csv = (cols, rows) => [cols, ...rows].map((r) => r.map((v) => (v === null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v))).join(',')).join('\n');
function table(cols, rows) {
  const w = cols.map((c, i) => Math.min(60, Math.max(String(c).length, ...rows.map((r) => String(r[i] ?? 'NULL').length))));
  const line = (r) => r.map((v, i) => String(v ?? 'NULL').slice(0, 60).padEnd(w[i])).join(' │ ');
  return [line(cols), w.map((n) => '─'.repeat(n)).join('─┼─'), ...rows.map(line)].join('\n');
}
function parseFlags(argv) {
  const o = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    let k = a.slice(2), v; const eq = k.indexOf('='); if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) v = argv[++i]; else v = true;
    o[k] = v;
  }
  return { o, rest };
}
async function cli(argv) {
  const [sub, ...rest] = argv;
  try {
    if (!sub || sub === 'help' || sub === '--help') { process.stdout.write(HELP); return 0; }
    const { o, rest: pos } = parseFlags(rest);
    if (sub === 'list') {
      const ls = listConnections().map(({ driver, ...c }) => ({ ...c, driver }));
      if (o.json) { console.log(JSON.stringify(ls.map((c) => ({ name: c.name, kind: c.kind, readOnly: c.readOnly, host: c.host, database: c.database || c.file, driver: c.driver })), null, 2)); return 0; }
      if (!ls.length) console.log('등록된 연결이 없습니다. (ss db add 또는 앱의 DB 메뉴)');
      for (const c of ls) console.log(`${c.name}  [${KINDS[c.kind].label}${c.readOnly ? ', 읽기 전용' : ''}]  ${c.file || `${c.host}:${c.port}/${c.database || ''}`}${c.driver === 'missing' ? `  ⚠ 드라이버 필요: ss db driver ${c.kind}` : ''}`);
      return 0;
    }
    if (sub === 'query') {
      const r = await query(pos[0], pos.slice(1).join(' '), { limit: o.limit, offset: o.offset, src: 'cli' });
      if (o.json) console.log(JSON.stringify(r)); else if (o.csv) console.log(csv(r.columns, r.rows));
      else { console.log(r.columns.length ? table(r.columns, r.rows) : `OK${r.affected != null ? ` (${r.affected} rows affected)` : ''}`); console.error(`${r.rows.length} rows${r.offset ? ` (offset ${r.offset})` : ''}${r.hasMore ? ` — 더 있음: --offset ${r.offset + r.limit}${r.paged ? '' : ' (이 쿼리는 페이징 불가: --limit 을 늘리세요)'}` : ''} · ${r.ms}ms`); }
      return 0;
    }
    if (sub === 'schema') {
      const items = await children(pos[0], { schema: pos[1], table: pos[2] });
      for (const i of items) console.log(i.type === 'column' ? `${i.name}\t${i.dataType}${i.nullable ? '' : ' NOT NULL'}${i.pk ? ' PK' : ''}` : `${i.name}${i.type === 'view' ? ' (view)' : ''}`);
      return 0;
    }
    if (sub === 'add') {
      const pw = o['password-env'] ? process.env[o['password-env']] : undefined;
      const n = saveConnection({ name: pos[0], kind: o.kind, host: o.host, port: o.port, user: o.user, database: o.database, file: o.file, catalog: o.catalog, https: !!o.https, ssl: !!o.ssl, readOnly: !o.write }, pw);
      console.log(`added: ${n.name} [${n.kind}]${n.readOnly ? ' 읽기 전용' : ''}`); return 0;
    }
    if (sub === 'history') { const c = pos[0] && /\D/.test(pos[0]) ? findConn(pos[0]) : null; for (const h of history({ id: c?.id, limit: Number(c ? pos[1] : pos[0]) || 20 })) console.log(`${new Date(h.t).toLocaleString()}  [${h.conn}] ${h.ok ? '✓' : '✗'} ${h.ms}ms ${h.src || ''}\n  ${h.sql.replace(/\s+/g, ' ').slice(0, 200)}${h.err ? '\n  ⚠ ' + h.err : ''}`); return 0; }
    if (sub === 'rm') { deleteConnection(findConn(pos[0]).id); console.log('removed'); return 0; }
    if (sub === 'driver') { if (!KINDS[pos[0]]) throw err(`종류: ${Object.keys(KINDS).join(', ')}`); console.error('설치 중…'); const r = await installDriver(pos[0]); console.log(`✓ 설치됨${r.version ? ' (' + KINDS[pos[0]].pkg + '@' + r.version + ')' : ''}`); return 0; }
    throw err(`알 수 없는 명령: ${sub}\n` + HELP);
  } catch (e) { console.error(e.message); return e.code === 'NO_DRIVER' ? 3 : 2; }
  finally { for (const k of [...pool.keys()]) if (!k.startsWith('t:')) closeConn(k); }
}

module.exports = { count, history, cancel, names, keys, updateRows, KINDS, listConnections, saveConnection, deleteConnection, findConn, installDriver, driverState, query, test, children, selectAll, cli, err, getSecret };
