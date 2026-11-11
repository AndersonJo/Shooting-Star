'use strict';
const $ = (s, r = document) => r.querySelector(s);
const EMPTY = document.getElementById('empty');
// 검색/경로 입력창에서 macOS 의 자동 수정 말풍선(예: 'Odi ×')이 방향키를 가로채지 않도록 자동 수정·맞춤법·자동 대문자를 끈다
const plainInput = (e) => { e.setAttribute('autocorrect', 'off'); e.setAttribute('autocapitalize', 'off'); e.setAttribute('autocomplete', 'off'); e.spellcheck = false; return e; };
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  if (tag === 'input' && (!e.type || e.type === 'text' || e.type === 'search')) plainInput(e);
  for (const k of kids) e.append(k);
  return e;
};
document.querySelectorAll('input:not([type]), input[type=text]').forEach(plainInput);   // index.html 의 정적 입력창
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('ss.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ss.' + k, JSON.stringify(v)); } catch {} },
};

const ROOT_Q = new URLSearchParams(location.search).get('root');
async function api(method, route, { pass, ...params } = {}, body, signal) {
  let rootDir = ROOT_Q;
  const pw = pass ?? (isEnc(params.path) ? tabOf(params.path)?.pass : null);   // 암호는 탭별로 들고 다닌다 (문서마다 암호가 달라도 다른 암호로 덮어쓰지 않도록)
  if (typeof params.path === 'string' && params.path.startsWith('@memo/')) { // 메모는 ~/.shooting-star/memos 를 루트로 접근
    rootDir = state.memoDir; params = { ...params, path: params.path.slice(6) };
    if (body && typeof body.to === 'string') body = { ...body, to: body.to.replace(/^@memo\//, '') };
  }
  if (typeof params.path === 'string' && isExt(params.path)) { // 워크스페이스 밖 파일(⌘O)은 / 를 루트로 접근
    rootDir = '/'; params = { ...params, path: params.path.slice(5) };
    if (body && typeof body.to === 'string') body = { ...body, to: body.to.replace(/^@ext\//, '') };
  }
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/${route}${qs ? '?' + qs : ''}`, {
    method,
    headers: { 'X-SS': '1', ...(rootDir ? { 'X-SS-Root': encodeURIComponent(rootDir) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(pw ? { 'X-SS-Pass': encodeURIComponent(pw) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

// 경로 종류: '@memo/x' = 메모 폴더, '@ext/Users/a/b.md' = 워크스페이스 밖의 파일(절대경로), '@gal/Users/a' = 이미지 갤러리, 그 외 = 워크스페이스 기준 상대경로
function isExt(p) { return typeof p === 'string' && p.startsWith('@ext/'); }
function isGal(p) { return typeof p === 'string' && p.startsWith('@gal/'); }   // '@gal/abs/dir' = 폴더 이미지 갤러리 탭
function isDrop(p) { return typeof p === 'string' && p.startsWith('@drop/'); }   // '@drop/<n>/이름' = 경로를 모르는 채 끌어놓은 이미지 (메모리/웹 주소로 보여 줌, 저장 안 함)
function isEnc(p) { return typeof p === 'string' && p.endsWith('.enc'); }   // 암호화 문서: <원래 이름>.enc
function rootRel(p) { return isMemo(p) ? { root: state.memoDir, rel: p.slice(6) } : isExt(p) ? { root: '/', rel: p.slice(5) } : { root: state.root, rel: p }; }
const absOf = (p) => (isExt(p) || isGal(p) ? p.slice(4) || '/' : isMemo(p) ? state.memoDir + '/' + p.slice(6) : state.root + '/' + p);

let toastTimer;
function toast(msg, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
async function copy(text, label = '복사됨') {
  try { await navigator.clipboard.writeText(text); }
  catch { // http 비-localhost 등 fallback
    const ta = el('textarea', { value: text }); document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(`${label} (${text.length.toLocaleString()}자)`);
  clipCheck();   // 글자를 복사했으니 파일 복사 표시는 지운다 (macOS)
}
const setStatus = (msg, cls = '') => { const s = $('#st-msg'); s.textContent = msg || ''; s.className = cls; };

// ───────── 파일 종류 ─────────
const extOf = (p) => (p.match(/\.([^./]+)$/)?.[1] || '').toLowerCase();
const IMG_EXT = new Set('png jpg jpeg gif webp avif svg bmp ico tif tiff heic heif'.split(' '));
function kindOf(p) {
  if (isDrop(p)) return 'image';
  const e = extOf(isEnc(p) ? p.slice(0, -4) : p);
  if (IMG_EXT.has(e)) return 'image';
  if (['md', 'markdown', 'mdx'].includes(e)) return 'md';
  if (e === 'json' || e === 'jsonc' || e === 'geojson') return 'json';
  if (e === 'jsonl' || e === 'ndjson') return 'jsonl';
  if (['yml', 'yaml'].includes(e)) return 'yaml';
  if (['csv', 'tsv'].includes(e)) return 'csv';
  return 'text';
}
const ICON = { md: 'M↓', json: '{}', jsonl: '{}', yaml: 'Y', csv: '▦', text: '≡', image: '▣' };
const iconOf = (p) => (isEnc(p) ? '🔒' : ICON[kindOf(p)]);
const MODES = {
  md: [['view', '보기'], ['split', '분할'], ['edit', '편집'], ['smart', '스마트 편집']],
  json: [['edit', '편집'], ['tree', '트리']],
  yaml: [['edit', '편집'], ['tree', '트리']],
  csv: [['table', '테이블'], ['edit', '편집']],
  jsonl: [['edit', '편집']],
  text: [['edit', '편집']],
  image: [['view', '보기']],
  diff: [['unified', '통합'], ['split', '나란히']],
};
const DEFAULT_MODE = { image: 'view', md: 'view', json: 'edit', yaml: 'edit', csv: 'table', jsonl: 'edit', text: 'edit' };

// ───────── CSV ─────────
function detectDelim(text, path) {
  if (extOf(path) === 'tsv') return '\t';
  const head = text.slice(0, 2000).split('\n')[0] || '';
  const c = (ch) => head.split(ch).length;
  return [',', ';', '\t', '|'].reduce((a, b) => (c(b) > c(a) ? b : a));
}
function parseCSV(text, d) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === d) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const stringifyCSV = (rows, d) => rows.map((r) => r.map((c) =>
  (c.includes(d) || /["\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(d)).join('\n') + '\n';

// ───────── prettify ─────────
const PRETTIFY = {
  json(t) { return JSON.stringify(JSON.parse(stripJsonc(t)), null, 2) + '\n'; },
  jsonl(t) { return t.split('\n').filter((l) => l.trim()).map((l) => JSON.stringify(JSON.parse(l))).join('\n') + '\n'; },
  yaml(t) { return jsyaml.dump(jsyaml.load(t), { indent: 2, lineWidth: 120, noRefs: true }); },
  csv(t, p) { // 컬럼 정렬 (공백 패딩 없이 구조만 정규화: 따옴표 규칙 통일, 후행 공백 제거)
    const d = detectDelim(t, p); return stringifyCSV(parseCSV(t, d).filter((r) => r.length > 1 || r[0] !== ''), d);
  },
  md(t) { return t.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'); },
  text(t) { return t.replace(/[ \t]+$/gm, '').replace(/\s*$/, '\n'); },
};
function stripJsonc(t) { // // 와 /* */ 주석 제거 (문자열 내부 보존)
  return t.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ''));
}

// ───────── 상태 ─────────
const state = {
  tabs: [],            // {path, content, orig, mtime, mode, kind}
  active: null,
  expanded: new Set(),
  root: '',
  view: store.get('view', 'files'),   // 사이드바 보기: files | memo | git
  memoDir: '',
  filter: store.get('treeFilter', false),   // 트리 필터 on/off
  filterDirs: null,
  selected: '',
  wrap: store.get('wrap', false),
};
const tabOf = (p) => state.tabs.find((t) => t.path === p);
const cur = () => tabOf(state.active);
const dirty = (t) => t.content !== t.orig;
// ───────── 트리 필터 (설정의 '검색 대상 파일 형식' 기준) ─────────
const fileMatchesFilter = (name) => {
  const e = searchExts(); if (!e) return true;
  return e.split(',').includes((name.match(/\.([^./]+)$/)?.[1] || '').toLowerCase());
};
async function fetchFilterDirs() {
  try { state.filterDirs = new Set(await api('GET', 'matchdirs', { exts: searchExts() })); } catch { state.filterDirs = null; }
}
async function refreshFilter() { // 필터가 켜져 있으면 폴더 목록을 다시 계산해 트리를 갱신
  drawFilterBtn();
  if (!state.filter) return renderTree();   // 끌 때도 트리를 다시 그려야 전체 목록으로 돌아온다
  await fetchFilterDirs(); renderTree();
}
function drawFilterBtn() {
  $('#btn-filter').classList.toggle('on', !!state.filter);
  const info = $('#filter-info');
  info.textContent = state.filter ? scopeLabel() + ' 파일이 있는 폴더만' : '';
  info.title = '클릭: 대상 파일 형식 설정';
}
$('#btn-filter').onclick = async () => { state.filter = !state.filter; store.set('treeFilter', state.filter); await refreshFilter(); };
$('#filter-info').onclick = () => openSettings();
const wsKey = (k) => `ws:${state.root}:${k}`; // 폴더(워크스페이스)별 탭/펼침 상태
const persistTabs = () => {
  if (!state.root) return;
  store.set(wsKey('tabs'), state.tabs.filter((t) => t.kind !== 'diff' && t.kind !== 'history' && t.kind !== 'run' && t.kind !== 'sql' && !isDrop(t.path)).map((t) => ({ path: t.path, mode: t.mode, ...(t.preview ? { preview: true } : {}) })));
  store.set(wsKey('active'), state.active);
  store.set(wsKey('expanded'), [...state.expanded]);
};

// ───────── 트리 ─────────
const childrenCache = new Map();
async function loadDir(p) {
  const list = await api('GET', 'tree', { path: p });
  childrenCache.set(p, list); return list;
}
let treeSeq = 0;
// 트리 필터가 켜져 있어도 지금 보고 있는 것은 보인다: 활성 탭의 파일 / 갤러리로 보는 폴더와 그 이미지 (워크스페이스 안일 때)
function treePins() {
  const t = cur(); if (!t) return null;
  if (t.kind === 'gallery') { const d = t.dir; return d === state.root ? { dir: '' } : d.startsWith(state.root + '/') ? { dir: d.slice(state.root.length + 1) } : null; }
  if (['diff', 'history', 'run', 'sql'].includes(t.kind) || isMemo(t.path) || isExt(t.path) || isDrop(t.path)) return null;
  return { file: t.path };
}
async function renderTree() {
  const seq = ++treeSeq;   // 연달아 호출되면 마지막 호출의 결과만 화면에 반영한다
  const root = $('#tree'); const scroll = root.scrollTop;
  const frag = document.createDocumentFragment(), pins = state.filter ? treePins() : null;
  async function walk(dir, depth) {
    let list = childrenCache.get(dir);
    if (!list) { try { list = await loadDir(dir); } catch { return; } }
    for (const e of list) {
      const p = dir ? dir + '/' + e.name : e.name;
      if (state.filter && state.filterDirs) { // 필터: 설정된 형식의 파일이 있는 폴더 / 그 형식의 파일만 (지금 보고 있는 것은 예외)
        const pinned = e.dir ? (pins?.dir != null && (pins.dir === p || pins.dir.startsWith(p + '/'))) || !!pins?.file?.startsWith(p + '/')
          : p === pins?.file || (pins?.dir === dir && IMG_EXT.has(extOf(e.name)));
        if (!pinned && (e.dir ? !state.filterDirs.has(p) : !fileMatchesFilter(e.name))) continue;
      }
      const open = e.dir && state.expanded.has(p);
      const tab = !e.dir && tabOf(p);
      const gm = e.dir ? gitMarks.dirs.get(p) : gitMarks.files.get(p);   // git 변경 표시 (M 수정 / A 새 파일 / U 충돌)
      const row = el('div', { className: 'row' + (state.selected === p ? ' sel' : '') + (tab && dirty(tab) ? ' dirty' : '') + (gm ? ' g-' + gm + (e.dir ? ' g-dir' : '') : '') },
        el('span', { className: 'arrow', textContent: e.dir ? (open ? '▼' : '▶') : '' }),
        e.dir ? el('span', { className: 'ico dir' }) : el('span', { className: 'ico k-' + kindOf(e.name), textContent: iconOf(e.name) }),
        el('span', { className: 'nm', textContent: e.name }));
      row.style.paddingLeft = 6 + depth * 14 + 'px';
      row.dataset.path = p; row.dataset.dir = e.dir ? '1' : '';
      if (gm) row.dataset.g = e.dir ? '●' : gm === 'A' ? 'N' : gm;
      row.title = p + (gm ? (e.dir ? '\n(안에 git 변경 있음)' : gm === 'A' ? '\ngit: 새 파일' : gm === 'U' ? '\ngit: 충돌' : '\ngit: 수정됨') : '');
      frag.append(row);
      if (open) await walk(p, depth + 1);
    }
  }
  await walk('', 0);
  if (state.filter && state.filterDirs && !frag.childNodes.length) frag.append(el('div', { className: 'tree-empty', textContent: '설정된 파일 형식이 있는 폴더가 없습니다' }));
  if (seq !== treeSeq) return;
  root.replaceChildren(frag); root.scrollTop = scroll;
  paintTreeHits();
}
async function refreshDir(p) { // 변경 후 해당 폴더 재로딩
  const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  try { await loadDir(parent); } catch { childrenCache.delete(parent); }
  await renderTree();
}
function toggleDir(p) { state.expanded.has(p) ? state.expanded.delete(p) : state.expanded.add(p); persistTabs(); return renderTree(); }
// 폴더: 클릭 = 선택 + 메인 화면에 이미지 갤러리 / 더블클릭 = 펼치기·접기 (화살표 클릭도), 파일: 클릭 = 열기
// 더블클릭은 클릭 간격(0.4초)으로 직접 판정한다 (첫 클릭에 트리를 다시 그려도 두 번째 클릭을 놓치지 않는다)
let lastDirClick = { p: '', t: 0 };
$('#tree').addEventListener('click', async (ev) => {
  const row = ev.target.closest('.row'); if (!row) return;
  const p = row.dataset.path; state.selected = p;
  if (!row.dataset.dir) { await openFile(p); return; }
  if (ev.target.closest('.arrow')) return toggleDir(p);
  const now = Date.now(), dbl = lastDirClick.p === p && now - lastDirClick.t < 400;
  lastDirClick = { p, t: dbl ? 0 : now };
  if (dbl) return toggleDir(p);   // 더블클릭: 펼치기·접기
  document.querySelectorAll('#tree .row.sel').forEach((r) => r.classList.remove('sel')); row.classList.add('sel');
  dirGallery(p);
});
// 트리에서 연 갤러리는 '미리보기 탭' 하나를 계속 쓴다 (다른 폴더를 누르면 그 탭에서 폴더만 바뀜, 탭 이름은 기울임).
// 따로 연 갤러리 탭(우클릭 → 갤러리로 보기, ⌘O, 끌어놓기 등)은 건드리지 않는다. 그 폴더가 이미 탭으로 열려 있으면 그 탭으로 간다.
function dirGallery(p) {
  const abs = state.root + '/' + p, open = tabOf('@gal' + abs);
  flushAll();
  if (open) { state.active = open.path; state.selected = p; persistTabs(); renderAll(); return; }
  const pv = state.tabs.find((x) => x.kind === 'gallery' && x.preview);
  if (pv) galGo(pv, abs); else openGallery(abs, p, true);
}
$('#tree').addEventListener('keydown', (ev) => { // 키보드: ↑↓ 이동, → 펼치기, ← 접기, Enter 폴더 접기·펼치기/파일 열기, 글자 입력 = 이름 검색
  if (!ev.metaKey && !ev.ctrlKey && !ev.altKey && ((ev.key.length === 1 && ev.key !== ' ') || ev.key === 'Process')) { startTreeSearch(ev); return; }   // 한글(IME)은 'Process' 로 들어온다
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
  const rows = [...document.querySelectorAll('#tree .row')]; if (!rows.length) return;
  let i = rows.findIndex((r) => r.dataset.path === state.selected); const row = rows[i], isDir = !!row?.dataset.dir, p = row?.dataset.path;
  const select = (k) => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]; state.selected = r.dataset.path; rows.forEach((x) => x.classList.toggle('sel', x === r)); r.scrollIntoView({ block: 'nearest' }); };
  if (ev.key === 'ArrowDown') { ev.preventDefault(); select(i + 1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); select(i < 0 ? 0 : i - 1); }
  else if (ev.key === 'ArrowRight' && isDir && !state.expanded.has(p)) { ev.preventDefault(); toggleDir(p); }
  else if (ev.key === 'ArrowLeft' && isDir && state.expanded.has(p)) { ev.preventDefault(); toggleDir(p); }
  else if (ev.key === 'Enter' && row) { ev.preventDefault(); isDir ? toggleDir(p) : openFile(p); }
});
$('#btn-collapse').onclick = () => { state.expanded.clear(); persistTabs(); renderTree(); };

// ───────── 트리 이름 검색 (speed search) ─────────
// 트리에서 글자를 치면, 선택한 위치(폴더면 그 폴더, 파일이면 그 파일이 있는 폴더) 안의 하위 전체에서 이름이 일치하는 곳을
// 트리 위에 하이라이트한다. ↓/↑(Ctrl+N/P) 로 다음/이전 일치로 이동(접힌 폴더는 자동으로 펼침), Enter 열기, Esc 취소.
const ts = { on: false, scope: '', anchor: '', files: [], hits: [], map: new Map(), idx: -1 };
const dirOfSel = () => { const s = state.selected || ''; if (!s || isMemo(s) || isExt(s) || isGal(s)) return ''; const row = [...document.querySelectorAll('#tree .row')].find((r) => r.dataset.path === s); return row?.dataset.dir ? s : dirOf(s); };
const treeCmp = (a, b) => {   // 트리에 보이는 순서 (같은 폴더 안에서는 폴더가 먼저)
  const x = a.split('/'), y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const xd = i < x.length - 1, yd = i < y.length - 1;
    return xd !== yd ? (xd ? -1 : 1) : x[i].localeCompare(y[i]);
  }
  return x.length - y.length;
};
async function startTreeSearch(ev) {
  if (ts.on) return;
  const inp = $('#ts-input'), bar = $('#tsearch');
  ts.on = true; ts.scope = dirOfSel(); ts.anchor = state.selected || ''; ts.hits = []; ts.map = new Map(); ts.idx = -1;
  $('.ts-scope', bar).replaceChildren(el('bdi', { textContent: (ts.scope ? ts.scope + '/' : '전체') + ' ›' })); $('.ts-scope', bar).title = '검색 범위: ' + (ts.scope || '작업 폴더 전체') + ' (하위 폴더 포함)';
  bar.hidden = false; inp.value = ''; inp.classList.remove('none'); $('.ts-count', bar).textContent = '';
  inp.focus();
  if (ev.key.length === 1) { ev.preventDefault(); inp.value = ev.key; }   // 한글은 입력창으로 포커스가 옮겨진 뒤 IME 가 이어서 입력한다
  try { ts.files = await api('GET', 'files'); } catch { ts.files = []; }
  runTreeSearch(inp.value);
}
function runTreeSearch(q) {
  if (!ts.on) return;
  q = q.trim(); const prefix = ts.scope ? ts.scope + '/' : '', cand = new Set(), hits = [];
  if (q) {
    const dirs = new Set();
    for (const f of ts.files) {
      if (prefix && !f.startsWith(prefix)) continue;
      cand.add(f);
      for (let i = f.indexOf('/', prefix.length); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));   // 폴더 이름도 검색 대상 (범위 폴더 자신은 제외)
    }
    for (const d of dirs) cand.add(d + '/');
    for (const c of cand) {
      const isDir = c.endsWith('/'), path = isDir ? c.slice(0, -1) : c, m = matchFile(q, path);
      if (!m || m.tier > 3) continue;   // 이름에서 일치한 것만 (경로 일치는 제외)
      const b0 = path.lastIndexOf('/') + 1;
      hits.push({ p: path, dir: isDir, pos: m.pos.map((k) => k - b0) });
    }
    hits.sort((a, b) => treeCmp(a.p, b.p));
  }
  ts.hits = hits; ts.map = new Map(hits.map((h) => [h.p, h]));
  const first = hits.findIndex((h) => treeCmp(h.p, ts.anchor) >= 0);   // 시작한 위치 이후의 첫 일치부터
  tsGo(hits.length ? (first < 0 ? 0 : first) : -1);
}
async function tsGo(i) {
  const n = ts.hits.length, inp = $('#ts-input'), cnt = $('#tsearch .ts-count');
  inp.classList.toggle('none', !n && !!inp.value.trim());
  if (!n) { ts.idx = -1; cnt.textContent = inp.value.trim() ? '일치 없음' : ''; stripTreeHits(); return; }
  ts.idx = (i + n) % n; const h = ts.hits[ts.idx];
  cnt.textContent = `${ts.idx + 1}/${n}`;
  let changed = false;
  for (let k = h.p.indexOf('/'); k > 0; k = h.p.indexOf('/', k + 1)) { const d = h.p.slice(0, k); if (!state.expanded.has(d)) { state.expanded.add(d); changed = true; } }   // 가려진 일치는 상위 폴더를 펼쳐 보여 준다
  state.selected = h.p;
  if (changed) { persistTabs(); await renderTree(); } else { document.querySelectorAll('#tree .row').forEach((r) => r.classList.toggle('sel', r.dataset.path === h.p)); paintTreeHits(); }
  [...document.querySelectorAll('#tree .row')].find((r) => r.dataset.path === h.p)?.scrollIntoView({ block: 'nearest' });
}
function stripTreeHits() {
  for (const r of document.querySelectorAll('#tree .row.hit')) { r.classList.remove('hit', 'cur'); const nm = r.querySelector('.nm'); if (nm) nm.textContent = r.dataset.path.split('/').pop(); }
}
function paintTreeHits() {   // 일치한 글자에 <mark>, 현재 일치 행은 강조
  if (!ts.on) return; stripTreeHits();
  const cur = ts.hits[ts.idx]?.p;
  for (const r of document.querySelectorAll('#tree .row')) {
    const h = ts.map.get(r.dataset.path); if (!h) continue;
    const nm = r.querySelector('.nm'), name = r.dataset.path.split('/').pop(), on = new Set(h.pos), f = document.createDocumentFragment(); let run = '', mark = false;
    const flush = () => { if (run) f.append(mark ? el('mark', { textContent: run }) : run); run = ''; };
    [...name].forEach((ch, k) => { const m = on.has(k); if (m !== mark) { flush(); mark = m; } run += ch; }); flush();
    nm.replaceChildren(f); r.classList.add('hit'); r.classList.toggle('cur', r.dataset.path === cur);
  }
}
function endTreeSearch(focusTree) {
  if (!ts.on) return; ts.on = false; $('#tsearch').hidden = true; stripTreeHits(); ts.hits = []; ts.map = new Map(); ts.files = [];
  if (focusTree) $('#tree').focus();
}
$('#ts-input').oninput = (e) => runTreeSearch(e.target.value);
$('#ts-input').onblur = () => endTreeSearch(false);
$('#ts-input').onkeydown = (e) => {
  if (e.isComposing) return;   // 한글 조합 중에는 키를 가로채지 않는다
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') { e.preventDefault(); endTreeSearch(true); }
  else if (e.key === 'ArrowDown' || (e.ctrlKey && k === 'n')) { e.preventDefault(); tsGo(ts.idx + 1); }
  else if (e.key === 'ArrowUp' || (e.ctrlKey && k === 'p')) { e.preventDefault(); tsGo(ts.idx - 1); }
  else if (e.key === 'Enter') {
    e.preventDefault(); const h = ts.hits[ts.idx]; endTreeSearch(true);
    if (h) { state.selected = h.p; if (h.dir) { state.expanded.add(h.p); persistTabs(); renderTree(); } else openFile(h.p); }
  } else if (e.key === 'Backspace' && !e.target.value) { e.preventDefault(); endTreeSearch(true); }
};


// ───────── 파일 열기/저장 ─────────
async function openFile(p, mode, at) {
  flushAll();   // 다른 파일로 넘어가기 전에 마지막 편집까지 저장
  let t = tabOf(p);
  if (!t && kindOf(p) === 'image') { t = { path: p, content: '', orig: '', mtime: 0, kind: 'image', mode: 'view' }; state.tabs.push(t); }   // 이미지는 뷰어가 직접 불러온다
  if (!t) {
    try {
      const f = isEnc(p) ? await readEnc(p) : await api('GET', 'file', { path: p });
      if (!f) return;   // 암호 입력을 취소함
      const kind = kindOf(p);
      t = { path: p, content: f.content, orig: f.content, mtime: f.mtime, kind, mode: mode || DEFAULT_MODE[kind], pass: f.pass };
      state.tabs.push(t);
    } catch (e) { toast(`열 수 없음: ${e.message}`); return; }
  }
  state.active = p; state.selected = p;
  if (!isMemo(p) && !isExt(p)) rememberOpen(p);
  if (at && MODES[t.kind].some((m) => m[0] === 'edit')) t.mode = 'edit'; // 줄로 이동하려면 편집기가 필요
  persistTabs(); renderAll();
  if (at) requestAnimationFrame(() => revealAt(at));
}
function revealAt({ line, col = 0, len = 0 }) { // 해당 줄/열을 선택하고 화면 가운데쯤으로 스크롤
  const ta = $('textarea.editor'); if (!ta) return;
  const lines = ta.value.split('\n'); let off = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
  ta.focus(); ta.setSelectionRange(off + col, off + col + len);
  taScrollTo(ta, lines, line, col);
}
function taScrollTo(ta, lines, line, col) { // 해당 줄/열이 화면 가운데쯤 오도록 스크롤 (선택/포커스는 건드리지 않는다)
  ta.scrollTop = Math.max(0, (line - 1) * parseFloat(getComputedStyle(ta).lineHeight) - ta.clientHeight / 3);
  if (!ta.classList.contains('wrap')) { // 줄바꿈이 없으면 일치 위치가 보이도록 가로 스크롤도 맞춘다 (글자 폭은 실제로 측정)
    const m = el('span', { textContent: (lines[line - 1] || '').slice(0, col) });
    m.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + getComputedStyle(ta).font;
    document.body.append(m); const x = m.getBoundingClientRect().width; m.remove();
    ta.scrollLeft = x > ta.clientWidth - 120 ? x - ta.clientWidth / 3 : 0;
  }
}
async function save(t = cur(), silent = false, auto = false) {
  if (!t || !dirty(t)) return;
  try {
    const sent = t.content; t._savedAt = Date.now();
    const r = await api('PUT', 'file', { path: t.path }, { content: sent, mtime: t.mtime });
    t.orig = sent; t.mtime = r.mtime; t.conflict = false; t.missing = false; t._savedAt = Date.now(); if (!silent) toast('저장됨'); renderChrome(); if (auto && !isMemo(t.path)) showSaved();
  } catch (e) {
    if (e.status === 409 && auto) { // 자동 저장은 외부에서 바뀐 파일을 덮어쓰지 않는다
      if (!t.conflict) toast('⚠ 외부에서도 수정되어 자동 저장을 건너뜁니다 (⌘S 로 저장하면 덮어쓰기 확인)');
      t.conflict = true; renderTabs(); return;
    }
    if (e.status === 409 && confirm('디스크에서 파일이 변경되었습니다. 덮어쓸까요?')) {
      t._savedAt = Date.now();
      const r = await api('PUT', 'file', { path: t.path }, { content: t.content });
      t.orig = t.content; t.mtime = r.mtime; t.conflict = false; t.missing = false; t._savedAt = Date.now(); toast('덮어씀'); renderChrome();
    } else if (e.status !== 409) toast('저장 실패: ' + e.message);
  }
}
// ───────── 자동 저장 ─────────
// 입력을 멈추면 저장 (메모는 항상 0.8초, 그 외 파일은 설정). 창/탭을 벗어나거나 탭을 닫거나 앱을 닫을 때도 마지막 편집까지 저장한다.
// 외부에서 먼저 수정된 파일은 덮어쓰지 않는다 (충돌 표시만). 문법 오류 중인 JSON/YAML 은 입력 중에는 건너뛰고, 창/탭을 벗어날 때 저장한다.
const autoSaveSecs = (t) => (isMemo(t.path) ? 0.8 : settings.autoSave === 'off' ? 0 : Number(settings.autoSave) || 1);
const syntaxOk = (t) => {
  try {
    if (t.kind === 'json') JSON.parse(stripJsonc(t.content)); else if (t.kind === 'yaml') jsyaml.loadAll(t.content);
    else if (t.kind === 'jsonl') t.content.split('\n').forEach((l) => l.trim() && JSON.parse(l));
    return true;
  } catch { return false; }
};
function autosave(t) {
  const secs = t && t.kind !== 'image' ? autoSaveSecs(t) : 0; if (!secs) return;
  clearTimeout(t._as);
  t._as = setTimeout(() => { if (dirty(t) && !t.conflict && !t.missing && syntaxOk(t)) save(t, true, true).then(refreshMemos); }, secs * 1000);
}
function flushAll() { // 지금 바로 저장 (대기 중인 타이머는 취소). 모든 저장이 끝나면 resolve
  const jobs = [];
  for (const t of state.tabs) {
    if (t.kind === 'image' || !dirty(t) || t.conflict || t.missing || !autoSaveSecs(t)) continue;
    clearTimeout(t._as); jobs.push(save(t, true, true));
  }
  return Promise.allSettled(jobs);
}
let savedFlash;
function showSaved() {
  const z = $('#st-save'), d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  z.textContent = `✓ 자동 저장 ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; z.hidden = false;
  clearTimeout(savedFlash); savedFlash = setTimeout(() => { z.hidden = true; }, 3500);
}
function beaconSave(t) { // 페이지를 닫는 중에도 전달되도록 keepalive 로 저장 (용량이 작은 파일만)
  const { root, rel: p } = rootRel(t.path);
  fetch('/api/file?path=' + encodeURIComponent(p), { method: 'PUT', keepalive: true, headers: { 'X-SS': '1', 'X-SS-Root': encodeURIComponent(root), 'Content-Type': 'application/json', ...(t.pass ? { 'X-SS-Pass': encodeURIComponent(t.pass) } : {}) }, body: JSON.stringify({ content: t.content, mtime: t.mtime }) }).catch(() => {});
}
window.addEventListener('blur', flushAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });
window.addEventListener('beforeunload', (e) => {
  const d = state.tabs.filter(dirty); if (!d.length) return;
  let unsafe = false;
  for (const t of d) { if (t.kind === 'image' || t.conflict || t.missing || !autoSaveSecs(t) || t.content.length > 40000) unsafe = true; else beaconSave(t); }
  if (unsafe) e.preventDefault();   // 자동으로 저장하지 못하는 변경이 남아 있을 때만 확인창
});

async function closeTab(p, saved) { // 닫았으면 true, 취소(저장 안 한 변경을 유지)하면 false
  const t = tabOf(p); if (!t) return true;
  if (dirty(t) && !saved && t.kind !== 'image' && !t.conflict && !t.missing && autoSaveSecs(t)) { clearTimeout(t._as); await save(t, true, true); return closeTab(p, true); }   // 자동 저장이 켜져 있으면 저장하고 닫는다
  if (dirty(t) && !confirm(`${p}\n저장하지 않은 변경이 있습니다. 닫을까요?`)) return false;
  const i = state.tabs.indexOf(t); state.tabs.splice(i, 1);
  if (t.kind === 'gallery') galDispose(t);
  if (isMemo(p) && !t.content.replace(/#/g, '').trim()) api('DELETE', 'file', { path: p }).then(refreshMemos).catch(() => {}); // 비어 있는 메모는 닫을 때 삭제
  if (state.active === p) { state.active = (state.tabs[i] || state.tabs[i - 1])?.path || null; nav.replaceNext = true; }   // 닫아서 옆 탭으로 가는 것은 뒤로/앞으로 기록을 늘리지 않는다
  persistTabs(); renderAll(); return true;
}
async function closeTabs(paths) { // 여러 탭을 순서대로 닫는다. 저장 안 한 탭에서 취소하면 거기서 멈춘다
  for (const p of paths) if (!(await closeTab(p))) return;
}
async function reload(t = cur()) {
  if (!t) return;
  if (t.kind === 'image') { imgv.ver.set(t.path, Date.now()); return renderContent(); }
  if (dirty(t) && !confirm('저장하지 않은 변경을 버리고 다시 불러올까요?')) return;
  const f = await api('GET', 'file', { path: t.path });
  Object.assign(t, { content: f.content, orig: f.content, mtime: f.mtime }); renderAll();
}
// 창 포커스 시 외부 변경 감지

// ───────── 외부 변경 동기화 ─────────
// 다른 에디터/터미널/git 이 파일을 바꾸면 서버가 감시(fs.watch)해서 SSE 로 알려 준다.
//  · 트리: 바뀐 폴더만 다시 읽기   · 열린 탭: 저장 안 한 변경이 없으면 자동 반영, 있으면 ⚠ 충돌 표시(저장 시 덮어쓰기 확인)
let pendingPvScroll = null;
async function syncTab(t) {
  if (!t || t.kind === 'image' || t.kind === 'diff' || t.kind === 'history' || t.kind === 'run' || t.kind === 'sql' || t.kind === 'gallery' || (isMemo(t.path) || isExt(t.path)) && t.path !== state.active) return;
  if (Date.now() - (t._savedAt || 0) < 1500) return;   // 방금 우리가 저장한 파일의 변경 이벤트는 무시
  try {
    const f = await api('GET', 'file', { path: t.path });
    t.missing = false;
    if (f.mtime === t.mtime) { if (t.conflict && !dirty(t)) t.conflict = false; return renderTabs(); }
    if (f.content === t.content) { Object.assign(t, { orig: f.content, mtime: f.mtime, conflict: false }); return renderChrome(); }   // 내용은 같고 시간만 바뀜
    if (!dirty(t)) {
      const active = t.path === state.active, ta = active ? $('textarea.editor') : null, pv = active ? $('#preview') : null;
      const keep = ta && { top: ta.scrollTop, left: ta.scrollLeft, a: ta.selectionStart, b: ta.selectionEnd };
      if (pv) pendingPvScroll = pv.scrollTop;
      Object.assign(t, { content: f.content, orig: f.content, mtime: f.mtime, conflict: false });
      if (active) {
        renderAll();
        const n = $('textarea.editor');
        if (n && keep) { n.scrollTop = keep.top; n.scrollLeft = keep.left; try { n.setSelectionRange(keep.a, keep.b); } catch {} }
      } else renderChrome();
      toast(`외부 변경 반영됨: ${isMemo(t.path) ? '메모' : t.path.split('/').pop()}`);
    } else {
      t.conflict = true; renderTabs();
      toast('⚠ 외부에서도 수정되었습니다 — 저장하면 덮어쓰기 확인');
      if (t.path === state.active) setStatus('⚠ 디스크의 파일이 변경됨 (저장 시 덮어쓰기 확인)', 'err');
    }
  } catch (e) {
    if (e.status === 404) { t.missing = true; renderTabs(); if (t.path === state.active) setStatus('⚠ 파일이 삭제되었거나 이동되었습니다', 'err'); }
  }
}
function imgReload(t) { imgv.ver.set(t.path, Date.now()); t._sig = null; if (t.path === state.active) renderContent(); }
async function imgCheck(t) { // 크기·수정 시각이 달라졌을 때만 다시 불러온다 (매번 다시 그리면 깜빡이고 전체화면도 풀린다)
  if (isDrop(t.path)) return;
  const p = t.path; let sig;
  try { const i = await api('GET', 'imginfo', { path: p }); sig = `${p}|${i.size}|${i.mtime}`; } catch { return; }
  const prev = t._sig; t._sig = sig;
  if (prev && prev.startsWith(p + '|') && prev !== sig && t.path === p) imgReload(t);
}
let fsTimer;
function onFsEvent(d) { // d: { paths, all }
  clearTimeout(fsTimer);
  fsTimer = setTimeout(async () => {
    if (d.all) childrenCache.clear(); else for (const p of d.paths) { childrenCache.delete(dirOf(p)); childrenCache.delete(p); }
    if (state.filter) await fetchFilterDirs();
    renderTree();
    const set = d.all ? null : new Set(d.paths);
    for (const t of state.tabs) {
      if (t.kind === 'run' || t.kind === 'sql' || t.kind === 'history') continue;
      if (t.kind === 'gallery') { if (d.all && t.path === state.active) galRefresh(t); continue; }   // 갤러리는 따로 감시한다 (창으로 돌아오면 다시 읽기)
      if (t.kind === 'diff') { t.stale = true; if (t.path === state.active) renderContent(); continue; }   // 열려 있는 diff 는 다시 계산
      if (t.kind === 'image') { if (set) { if (set.has(t.path)) imgReload(t); } else imgCheck(t); continue; }   // 이미지가 바뀌면 다시 불러온다 (창으로 돌아올 때는 정말 바뀌었을 때만)
      if (!isMemo(t.path) && !isExt(t.path) && (!set || set.has(t.path))) syncTab(t);
    }
    if (isMemo(state.active) || isExt(state.active)) syncTab(cur());
    refreshMemos(); refreshGit();
  }, 150);
}
function connectEvents() {
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/events?root=' + encodeURIComponent(state.root)); let first = true;
  es.onmessage = (e) => { try { onFsEvent(JSON.parse(e.data)); } catch {} };
  es.onopen = () => { if (!first) onFsEvent({ all: true, paths: [] }); first = false; };   // 서버가 재시작되어 다시 연결되면 전체 동기화
}
// 다른 앱을 쓰다 돌아오면 파일을 다시 읽는다 (감시가 놓친 변경 대비). 여러 신호가 한꺼번에 와도 한 번만 실행.
let lastActivate = 0;
function onActivate() {
  if (document.hidden || Date.now() - lastActivate < 400) return;
  lastActivate = Date.now(); onFsEvent({ all: true, paths: [] }); refreshGit(); clipCheck();   // 다른 앱에서 복사했으면 복사 표시를 지운다
  if (runUi.dir) loadRun();   // Run 폴더 감시가 놓친 변경 대비
}
window.addEventListener('focus', onActivate);
document.addEventListener('visibilitychange', onActivate);
window.addEventListener('pageshow', onActivate);
window.onNativeActivate = onActivate;   // macOS 앱 껍데기에서 호출

// ───────── 렌더링 ─────────
function renderAll() { renderTabs(); renderToolbar(); renderContent(); renderTree(); validate(); drawConsoles(); }
function renderChrome() { renderTabs(); renderToolbar(); renderTree(); validate(); drawConsoles(); }

function renderTabs() {
  const box = $('#tabs');
  box.replaceChildren(...state.tabs.map((t) => {
    const x = el('span', { className: 'x', title: '닫기 (⌘W)' });
    x.onclick = (e) => { e.stopPropagation(); closeTab(t.path); };
    const tab = el('div', { className: 'tab' + (t.path === state.active ? ' active' : '') + (dirty(t) ? ' dirty' : '') + (t.conflict ? ' conflict' : '') + (t.missing ? ' missing' : '') + (t.preview ? ' preview' : ''), title: (t.kind === 'gallery' ? `이미지: ${t.dir}` + (t.preview ? '\n트리에서 연 미리보기 탭 — 트리에서 다른 폴더를 누르면 이 탭에서 바뀝니다' : '') : t.kind === 'diff' ? `${t.repoName}: ${t.file} — 변경 내용` : t.kind === 'history' ? histTitle(t) : t.kind === 'run' ? `Run: ${t.name}` : t.kind === 'sql' ? `SQL: ${t.connName}` : t.path) + (t.conflict ? '  — 외부에서도 수정됨' : '') + (t.missing ? '  — 삭제/이동됨' : '') },
      el('span', { textContent: t.kind === 'gallery' ? '🖼 ' + (t.dir.split('/').pop() || '/') : isMemo(t.path) ? (memoTitle(t.content) || '새 메모') : t.kind === 'diff' ? t.file.split('/').pop() + ' (diff)' : t.kind === 'history' ? histLabel(t) : t.kind === 'run' ? '▶ ' + t.name : t.kind === 'sql' ? '🗄 ' + t.connName + (t.n > 1 ? ' #' + t.n : '') : t.path.split('/').pop() }), x);
    tab.onclick = () => { flushAll(); state.active = t.path; state.selected = t.kind === 'gallery' ? '' : t.path; persistTabs(); renderAll(); };
    tab.onauxclick = (e) => e.button === 1 && closeTab(t.path);
    tab.oncontextmenu = (e) => { // 탭 우클릭: 닫기 / 다른 탭 모두 닫기 / 오른쪽 탭 모두 닫기 / 모두 닫기
      e.preventDefault();
      const idx = state.tabs.indexOf(t), others = state.tabs.filter((x) => x !== t).map((x) => x.path), right = state.tabs.slice(idx + 1).map((x) => x.path);
      const FM = state.platform === 'darwin' ? 'Finder' : '파일 관리자';
      showMenu(e.clientX, e.clientY, [
        ['닫기', () => closeTab(t.path)],
        ['다른 탭 모두 닫기', () => closeTabs(others), others.length ? '' : 'disabled'],
        ['오른쪽 탭 모두 닫기', () => closeTabs(right), right.length ? '' : 'disabled'],
        ['모두 닫기', () => closeTabs(state.tabs.map((x) => x.path))],
        '-',
        ...(isDrop(t.path) ? [] : [['경로 복사', () => copy(absOf(t.path), '전체 경로 복사됨')]]),
        ...(isMemo(t.path) || isExt(t.path) || isDrop(t.path) ? [] : isGal(t.path) ? [[`${FM}에서 열기`, () => revealPath('@ext' + t.dir, 'reveal')]] : [[`${FM}에서 보기`, () => revealPath(t.path, 'reveal')]]),
        ...(gitable(t) ? ['-', ['Git', null, '', gitMenu({ path: t.path, isDir: false })]] : t.kind === 'history' ? ['-', ['Git 히스토리 새로고침', () => histReload(t)]] : []),
      ].map((it) => (it === '-' ? ['-'] : it)));
    };
    return tab;
  }));
  box.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  navSync();   // 뒤로/앞으로 기록
  document.title = (cur() ? (cur().kind === 'history' ? histLabel(cur()) : cur().kind === 'diff' ? cur().file.split('/').pop() + ' (diff)' : cur().path.split('/').pop()) + (dirty(cur()) ? ' ●' : '') + ' — ' : '') + 'shooting-star';
}

function btn(label, title, onclick, cls = '') {
  return el('button', { textContent: label, title, onclick, className: cls });
}
function renderToolbar() {
  const bar = $('#toolbar'); const t = cur();
  drawPath(t);   // 전체 경로는 하단 상태바에 표시
  if (!t) { bar.replaceChildren(); return; }
  if (t.kind === 'run' || t.kind === 'sql') { bar.replaceChildren(el('span', { className: 'path' })); return; }
  if (t.kind === 'gallery') {
    const d = t.g?.data, FM = state.platform === 'darwin' ? 'Finder' : '파일 관리자', sort = store.get('galSort', 'name'), names = store.get('galNames', true);
    const up = btn('↑ 상위', '상위 폴더 (Backspace)', () => d?.parent && galGo(t, d.parent)); up.disabled = !d?.parent;
    const size = el('input', { type: 'range', min: 100, max: 480, step: 10, value: store.get('galH', 220), title: '썸네일 크기', className: 'gal-size' });
    size.oninput = () => { store.set('galH', +size.value); galRelayout(t); };
    bar.replaceChildren(el('span', { className: 'path' }), up,
      el('span', { className: 'seg' }, ...[['name', '이름', '이름순'], ['new', '최신', '수정 시각 최신순']].map(([m, label, tip]) => btn(label, tip, () => { store.set('galSort', m); galBuild(t); renderToolbar(); }, sort === m ? 'on' : ''))),
      el('span', { className: 'sep' }), size,
      btn('파일 이름', '파일 이름 표시', () => { store.set('galNames', !names); t.g?.dom.classList.toggle('nonames', names); renderToolbar(); }, names ? 'on' : ''),
      el('span', { className: 'sep' }),
      btn('경로', '폴더 경로 복사', () => copy(t.dir, '전체 경로 복사됨')),
      btn(FM, `${FM}에서 열기`, () => revealPath('@ext' + t.dir, 'reveal')),
      btn('↻', '다시 불러오기', () => galLoad(t)));
    return;
  }
  if (t.kind === 'history') return histToolbar(t, bar);
  if (t.kind === 'diff') {
    const seg = el('span', { className: 'seg' }, ...MODES.diff.map(([m, label]) => btn(label, '', () => { t.mode = m; store.set('diffMode', m); renderToolbar(); renderContent(); }, t.mode === m ? 'on' : '')));
    bar.replaceChildren(el('span', { className: 'path' }), seg, el('span', { className: 'sep' }),
      ...(t.rel && !t.gone ? [btn('파일 열기', '이 파일을 편집기로 열기', () => openFile(t.rel))] : []),
      btn('새로고침', '변경 내용 다시 계산', () => loadDiff(t)));
    return;
  }
  if (t.kind === 'image') {
    bar.replaceChildren(el('span', { className: 'path' }),
      ...(isDrop(t.path) ? [] : [btn('경로', '경로 복사 (Shift: 절대경로)', (e) => copy(isExt(t.path) || e.shiftKey ? absOf(t.path) : t.path, '경로 복사됨'))]),
      btn('맞춤', '화면에 맞춤 (0)', () => imgCmd('fit')), btn('100%', '원본 크기 (1)', () => imgCmd('actual')), btn('전체화면', '전체화면 (F)', () => imgCmd('fs')));
    return;
  }
  const items = [el('span', { className: 'path' })];
  const modes = MODES[t.kind];
  if (modes.length > 1) {
    const seg = el('span', { className: 'seg' }, ...modes.map(([m, label]) =>
      btn(label, '', () => { t.mode = m; t.blame = null; persistTabs(); renderToolbar(); renderContent(); }, t.mode === m && !t.blame ? 'on' : '')));
    items.push(seg, el('span', { className: 'sep' }));
  }
  if (t.blame) items.push(btn('Blame ✕', 'Blame 끄기 (Esc) — 줄마다 마지막으로 바꾼 커밋', () => toggleBlame(t.path), 'on'), el('span', { className: 'sep' }));
  items.push(
    btn('복사', '전체 내용 복사', () => copy(t.content, '전체 복사됨')),
    btn('경로', '경로 복사 (Shift: 절대경로)', (e) => copy(isMemo(t.path) || isExt(t.path) || e.shiftKey ? absOf(t.path) : t.path, '경로 복사됨')),
    ...(t.kind === 'md' && (t.mode === 'edit' || t.mode === 'split' || t.mode === 'smart') ? [btn('🖼 이미지', '이미지 첨부 — 붙여넣기·끌어놓기도 됩니다 (문서 폴더의 images/ 에 저장)', pickImages)] : []),
    btn('✨ Prettify', '정리/포맷 (⌘⌥L)', prettify),
  );
  if (t.kind === 'json') items.push(btn('Minify', 'JSON 압축', minify));
  items.push(
    el('span', { className: 'sep' }),
    btn('줄바꿈', '자동 줄바꿈', () => { state.wrap = !state.wrap; store.set('wrap', state.wrap); renderToolbar(); renderContent(); }, state.wrap ? 'on' : ''),
    btn('↻', '다시 불러오기', () => reload()),
    btn(dirty(t) ? '저장 ●' : '저장', '저장 (⌘S)', () => save(), dirty(t) ? 'on' : ''),
  );
  bar.replaceChildren(...items);
}

// textarea 내용을 undo 가능하게 교체
function replaceEditor(text) {
  const ta = $('textarea.editor'); const t = cur();
  if (ta) {
    ta.focus(); ta.select();
    if (!document.execCommand('insertText', false, text)) { ta.value = text; ta.dispatchEvent(new Event('input')); }
    t.content = ta.value;
  } else t.content = text;
}
function prettify() {
  const t = cur(); if (!t || !PRETTIFY[t.kind]) return;
  try {
    const out = PRETTIFY[t.kind](t.content, t.path);
    if (out === t.content) return toast('이미 정리됨');
    replaceEditor(out);
    if (t.kind === 'yaml') toast('정리됨 (YAML 주석은 제거될 수 있음, ⌘Z로 되돌리기)');
    else toast('정리됨');
    renderChrome(); if (t.mode !== 'edit' && t.mode !== 'split') renderContent();
  } catch (e) { setStatus('Prettify 실패: ' + e.message, 'err'); toast('Prettify 실패'); }
}
function minify() {
  const t = cur();
  try { replaceEditor(JSON.stringify(JSON.parse(stripJsonc(t.content))) + '\n'); renderChrome(); toast('압축됨'); }
  catch (e) { setStatus('Minify 실패: ' + e.message, 'err'); }
}

function validate() {
  const t = cur(); const pos = $('#st-pos'); pos.textContent = '';
  if (t && (t.kind === 'run' || t.kind === 'sql')) return setStatus('');
  if (t && t.kind === 'gallery') {
    const d = t.g?.data, s = t.g?.tileList[t.g.sel]?._it, many = t.g?.picked.size > 1 ? galPicked(t) : null;
    const selTxt = many ? `${many.length}장 선택 · ${fmtSize(many.reduce((a, x) => a + x._it.size, 0))}` : s && t.g.picked.has(s.name) ? `${s.name}${s.w ? `  ${s.w}×${s.h}` : ''}  ${fmtSize(s.size)}` : '';
    return setStatus(d ? [`이미지 ${d.total.toLocaleString()}장`, d.dirs.length ? `폴더 ${d.dirs.length}` : '', d.others ? `기타 파일 ${d.others}` : '', selTxt].filter(Boolean).join(' · ') : '');
  }
  if (t && t.kind === 'diff') return setStatus(t.stat || '');
  if (t && t.kind === 'history') return setStatus(histStatus(t));
  if (!t || t.kind === 'image') return setStatus('');
  let msg = '', cls = 'ok';
  try {
    if (t.kind === 'json') { JSON.parse(stripJsonc(t.content)); msg = '✓ valid JSON'; }
    else if (t.kind === 'yaml') { jsyaml.loadAll(t.content); msg = '✓ valid YAML'; }
    else if (t.kind === 'jsonl') {
      t.content.split('\n').forEach((l, i) => { if (l.trim()) try { JSON.parse(l); } catch (e) { throw new Error(`line ${i + 1}: ${e.message}`); } });
      msg = '✓ valid JSONL';
    } else if (t.kind === 'csv') {
      const rows = parseCSV(t.content, detectDelim(t.content, t.path)); msg = `${rows.length.toLocaleString()} rows × ${rows[0]?.length || 0} cols`; cls = '';
    } else { msg = ''; cls = ''; }   // 일반 텍스트/마크다운은 줄 수 표시 안 함 (경로를 하단에 표시)
  } catch (e) { msg = '✗ ' + e.message.split('\n')[0]; cls = 'err'; }
  setStatus(msg, cls);
  pos.textContent = `${(new Blob([t.content]).size / 1024).toFixed(1)} KB`;
}

function renderContent() {
  const box = $('#content'); const t = cur();
  if (t?.kind !== 'gallery') galUnwatch();   // 갤러리 폴더 감시는 보이는 동안만
  if (!t) { box.replaceChildren(EMPTY); return; }
  if (t.kind === 'gallery') { const v = galleryView(t); if (box.firstChild !== v || box.childNodes.length !== 1) box.replaceChildren(v); validate(); return; }   // 같은 화면이면 다시 붙이지 않는다 (스크롤 유지)
  if (t.kind === 'image') { box.replaceChildren(imageViewer(t)); validate(); return; }
  if (t.kind === 'run') { const fresh = !t.dom; box.replaceChildren(runView(t)); if (!fresh) t.refreshWhere?.(); validate(); if (fb.open) { placeFindBar(); runFileFind(true); } return; }
  if (t.kind === 'sql') { box.replaceChildren(sqlView(t)); validate(); return; }
  if (t.kind === 'history') { const v = historyView(t); if (box.firstChild !== v || box.childNodes.length !== 1) { box.replaceChildren(v); histRestoreScroll(t); } validate(); if (fb.open) { placeFindBar(); runFileFind(true); } return; }
  if (t.blame) { box.replaceChildren(blameView(t)); validate(); if (fb.open) { placeFindBar(); runFileFind(true); } return; }
  if (t.kind === 'diff') { box.replaceChildren(diffView(t)); validate(); if (fb.open) { placeFindBar(); runFileFind(true); } return; }
  const panes = [];
  const editor = () => {
    const lang = langOf(t.path);
    const wrapCls = state.wrap ? ' wrap' : '';
    const ta = el('textarea', { className: 'editor' + wrapCls, value: t.content, spellcheck: false });
    const pre = el('pre', { className: 'hl' + wrapCls, ariaHidden: 'true' });
    const fm = el('pre', { className: 'fm' + wrapCls, ariaHidden: 'true' });   // 문서 안 찾기 표시 레이어
    let raf = 0;
    const paint = () => { // 색칠은 프레임당 한 번, 너무 큰 파일은 생략
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const on = lang && ta.value.length < 300000;
        ta.classList.toggle('hlon', !!on);
        pre.innerHTML = on ? highlight(lang, ta.value) + '\n' : '';
        pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft;
      });
    };
    ta.onscroll = () => { pre.scrollTop = fm.scrollTop = ta.scrollTop; pre.scrollLeft = fm.scrollLeft = ta.scrollLeft; };
    ta.oninput = () => {
      t.content = ta.value;
      renderTabs(); renderToolbarDirtyOnly(); validate(); updatePreview(); paint();
      if (fb.open) { clearTimeout(fb.timer); fb.timer = setTimeout(() => runFileFind(false), 120); }
      autosave(t);   // 입력을 멈추면 자동 저장 (설정)
    };
    paint();
    ta.onkeydown = (e) => {
      if (t.kind === 'md' && listEnter(e, ta)) return;
      if (indentKey(e, ta, t.kind === 'md')) return;
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault(); document.execCommand('insertText', false, '  ');
      } else if (e.key === 'Escape' && fb.open) { e.preventDefault(); closeFileFind(); }
    };
    const upd = () => {
      const before = ta.value.slice(0, ta.selectionStart).split('\n');
      $('#st-pos').textContent = `Ln ${before.length}, Col ${before.at(-1).length + 1}`;
    };
    ta.onkeyup = ta.onclick = upd;
    if (t.kind === 'md') { // 이미지 붙여넣기 / 끌어놓기
      ta.addEventListener('paste', (e) => {
        if (pasteLink(e, ta)) return;
        const cd = e.clipboardData, files = [...(cd?.files || [])].filter((f) => f.type.startsWith('image/'));
        if (!files.length || cd.getData('text/plain')) return;   // 텍스트가 같이 있으면(엑셀 등) 평소대로 붙여넣기
        e.preventDefault(); attachImages(files);
      });
      ta.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
      ta.addEventListener('drop', (e) => {
        const all = [...(e.dataTransfer?.files || [])]; if (!all.length) return;   // 선택한 텍스트를 끌어놓는 경우는 기본 동작
        e.preventDefault(); const imgs = all.filter((f) => f.type.startsWith('image/'));
        imgs.length ? attachImages(imgs) : toast('이미지 파일만 첨부할 수 있습니다');
      });
    }
    return el('div', { className: 'pane' }, el('div', { className: 'ed' }, fm, pre, ta));
  };
  if (t.mode === 'edit') panes.push(editor());
  else if (t.mode === 'smart' && t.kind === 'md') panes.push(smartEditor(t));
  else if (t.mode === 'split') panes.push(editor(), el('div', { className: 'pane', id: 'preview' }));
  else panes.push(el('div', { className: 'pane', id: 'preview' }));
  box.replaceChildren(...panes);
  const ed = $('textarea.editor'); if (ed) { ed.parentElement.style.overflow = 'hidden'; }
  if (t.mode === 'split' && t.kind === 'md' && ed) splitSync(ed, $('#preview'));
  updatePreview();
  validate();
  if (fb.open) { placeFindBar(); runFileFind(true); }   // 탭/모드가 바뀌어도 검색 유지
}
const renderToolbarDirtyOnly = () => renderToolbar();

// ───────── 마크다운 분할 보기: 스크롤 동기화 + 편집 중인 곳 따라가기 ─────────
// 미리보기의 최상위 요소 ↔ 원문 줄 번호. 토큰 수와 요소 수가 맞지 않으면(원시 HTML 등) null → 비율로 동기화
function mdAnchors(pv, text) {
  const root = pv.firstElementChild; if (!root) return null;
  let line = 0; const starts = [];
  for (const tk of marked.lexer(text)) { if (tk.type !== 'space') starts.push(line); line += tk.raw.split('\n').length - 1; }
  const kids = [...root.children]; if (kids.length !== starts.length) return null;
  return kids.map((e, i) => ({ e, line: starts[i] }));
}
function splitSync(ta, pv) {
  if (!pv) return;
  const nLines = () => ta.value.split('\n').length + 1;
  const lh = () => { const v = parseFloat(getComputedStyle(ta).lineHeight); return !state.wrap && v > 0 ? v : 0; };
  const padTop = () => parseFloat(getComputedStyle(ta).paddingTop) || 0;
  const maxScroll = (n) => Math.max(1, n.scrollHeight - n.clientHeight);
  const yOf = (a) => a.e.getBoundingClientRect().top - pv.getBoundingClientRect().top + pv.scrollTop;
  const lineToY = (L) => {   // 원문 줄(소수 가능) → 미리보기 y
    const an = pv._anchors; if (!an?.length) return null;
    const ys = an.map(yOf); ys[0] = 0; let i = an.length - 1; while (i > 0 && an[i].line > L) i--;   // 첫 요소 = 스크롤 0 (위쪽 여백 포함)
    const l0 = an[i].line, l1 = i + 1 < an.length ? an[i + 1].line : nLines(), y0 = ys[i], y1 = i + 1 < an.length ? ys[i + 1] : pv.scrollHeight;
    return y0 + Math.min(1, Math.max(0, (L - l0) / Math.max(1, l1 - l0))) * (y1 - y0);
  };
  const yToLine = (y) => {
    const an = pv._anchors; if (!an?.length) return null;
    const ys = an.map(yOf); ys[0] = 0; let i = an.length - 1; while (i > 0 && ys[i] > y) i--;
    const l0 = an[i].line, l1 = i + 1 < an.length ? an[i + 1].line : nLines(), y0 = ys[i], y1 = i + 1 < an.length ? ys[i + 1] : pv.scrollHeight;
    return l0 + Math.min(1, Math.max(0, (y - y0) / Math.max(1, y1 - y0))) * (l1 - l0);
  };
  const taLine = () => { const h = lh(); return h ? Math.max(0, (ta.scrollTop - padTop()) / h) : (ta.scrollTop / maxScroll(ta)) * nLines(); };
  const mute = new Map();   // 프로그램이 스크롤을 바꾼 직후, 그쪽에서 생기는 scroll 이벤트는 무시 (되먹임 방지)
  const put = (node, v) => { v = Math.max(0, v); if (Math.abs(node.scrollTop - v) < 1) return; mute.set(node, performance.now() + 90); node.scrollTop = v; };
  const muted = (node) => performance.now() < (mute.get(node) || 0);
  ta.addEventListener('scroll', () => {
    if (muted(ta)) return;
    const y = lineToY(taLine());
    put(pv, ta.scrollTop >= maxScroll(ta) - 1 ? maxScroll(pv) : y != null ? y : (ta.scrollTop / maxScroll(ta)) * maxScroll(pv));
  });
  pv.addEventListener('scroll', () => {
    if (muted(pv)) return;
    const L = pv.scrollTop >= maxScroll(pv) - 1 ? null : yToLine(pv.scrollTop), h = lh();
    if (L == null) return put(ta, (pv.scrollTop / maxScroll(pv)) * maxScroll(ta));
    put(ta, h ? L * h + padTop() : (L / nLines()) * maxScroll(ta));
  });
  // 커서가 있는 줄이 미리보기에서 안 보이면 그 위치로 스크롤
  const follow = () => {
    if (document.activeElement !== ta) return;
    const L = ta.value.slice(0, ta.selectionStart).split('\n').length - 1, y = lineToY(L); if (y == null) return;
    const m = 40; if (y < pv.scrollTop + m || y > pv.scrollTop + pv.clientHeight - m) put(pv, y - pv.clientHeight / 3);
  };
  pv._sync = { follow };
  ta.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') follow(); });
  ta.addEventListener('click', follow);
}
let previewTimer;
function updatePreview() {
  const t = cur(); const pv = $('#preview'); if (!t || !pv) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    try {
      if (t.mode === 'table') pv.replaceChildren(renderCSV(t));
      else if (t.kind === 'md') pv.replaceChildren(renderMarkdown(t));
      else if (t.mode === 'tree') pv.replaceChildren(renderObjTree(t));
    } catch (e) { pv.replaceChildren(el('pre', { className: 'tree', textContent: e.message, style: 'color:var(--err)' })); }
    if (t.mode === 'split' && t.kind === 'md') { pv._anchors = mdAnchors(pv, t.content); }
    if (pendingPvScroll != null) { pv.scrollTop = pendingPvScroll; pendingPvScroll = null; }   // 외부 변경으로 다시 그려도 보던 위치 유지
    else if (t.mode === 'split' && t.kind === 'md' && pv._sync) pv._sync.follow();           // 편집 중인 곳이 미리보기에서 보이게
    if (fb.open) runFileFind(false);   // 미리보기가 다시 그려지면 표시도 다시
  }, t.mode === 'split' ? 120 : 0);
}

// ───────── Markdown 뷰 ─────────
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function resolveRel(base, href) {
  const parts = (base ? base.split('/') : []);
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
const MD_ID = 'user-content-';
function renderMarkdown(t, htmlOverride) { // htmlOverride: 이미 변환/정화된 HTML 조각(스마트 편집의 블록)
  marked.setOptions({ gfm: true, breaks: false });
  const html = htmlOverride ?? DOMPurify.sanitize(marked.parse(t.content), { USE_PROFILES: { html: true } });
  const doc = el('div', { className: 'md' }); doc.innerHTML = html;
  const base = dirOf(t.path);
  doc.querySelectorAll('img').forEach((img) => {
    const s = img.getAttribute('src');
    if (s && !/^([a-z]+:|\/\/|data:)/i.test(s)) {
      const rp = resolveRel(base, decodeURI(s));
      const rr = rootRel(rp.startsWith('@') ? rp : (isMemo(t.path) ? '@memo/' : '') + rp); img.src = '/raw?root=' + encodeURIComponent(rr.root) + '&path=' + encodeURIComponent(rr.rel);   // 메모는 ~/.shooting-star/memos 기준
    }
  });
  doc.querySelectorAll('a').forEach((a) => {
    const h = a.getAttribute('href') || '';
    if (/^[a-z]+:|^\/\//i.test(h)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    else if (h.startsWith('#')) { a.onclick = (e) => { e.preventDefault(); let id = h.slice(1); try { id = decodeURIComponent(id); } catch {} doc.querySelector('[id="' + CSS.escape(MD_ID + id) + '"]')?.scrollIntoView(); }; }
    else { // 상대 링크 → 앱에서 열기
      a.onclick = (e) => { e.preventDefault(); openFile(resolveRel(base, decodeURI(h.split('#')[0]))); };
    }
  });
  doc.querySelectorAll('pre > code[class*=language-]').forEach((code) => {
    const lang = langByName(code.className.match(/language-([\w+-]+)/)?.[1]);
    if (lang && code.textContent.length < 100000) code.innerHTML = highlight(lang, code.textContent);
  });
  doc.querySelectorAll('pre').forEach((pre) => {
    const b = el('button', { className: 'cp', textContent: '복사' });
    b.onclick = () => copy(pre.querySelector('code')?.textContent ?? pre.textContent, '코드 복사됨');
    // 가로 스크롤해도 버튼이 따라 움직이지 않도록 스크롤 안 되는 래퍼에 붙인다
    const w = el('div', { className: 'pre-wrap' }); pre.replaceWith(w); w.append(pre, b);
  });
  // heading id (anchor 링크용). 문서 안의 모든 id 에 접두어를 붙인다 — '## status' 가 id="status" 가 되면
  // 앱의 #status(상태바)·#menu·#toast 등과 겹쳐 그 CSS 가 제목에 먹고, $('#menu') 같은 조회가 제목을 집어 버린다 (GitHub 의 user-content- 와 같은 방식)
  doc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    h.id ||= h.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
  });
  doc.querySelectorAll('[id]').forEach((n) => { if (!n.id.startsWith(MD_ID)) n.id = MD_ID + n.id; });
  doc.querySelectorAll('input[type=checkbox]').forEach((c) => { c.disabled = true; });
  return doc;
}

// ───────── CSV 테이블 ─────────
function renderCSV(t) {
  const rows = parseCSV(t.content, detectDelim(t.content, t.path));
  const LIMIT = 3000; const head = rows[0] || [];
  const table = el('table', { className: 'csv' });
  const thead = el('tr', {}, el('th', { className: 'n' }), ...head.map((h) => el('th', { textContent: h, title: h })));
  table.append(el('thead', {}, thead));
  const tb = el('tbody');
  rows.slice(1, LIMIT + 1).forEach((r, i) => {
    tb.append(el('tr', {}, el('td', { className: 'n', textContent: i + 1 }), ...head.map((_, c) => el('td', { textContent: r[c] ?? '', title: r[c] ?? '' }))));
  });
  table.append(tb);
  table.onclick = (e) => { const td = e.target.closest('td:not(.n)'); if (td) copy(td.textContent, '셀 복사됨'); };
  const wrap = el('div', {}, table);
  if (rows.length > LIMIT + 1) wrap.append(el('p', { className: 'meta', style: 'padding:8px', textContent: `… ${LIMIT.toLocaleString()}행까지만 표시 (전체 ${(rows.length - 1).toLocaleString()}행)` }));
  return wrap;
}

// ───────── JSON/YAML 트리 ─────────
function renderObjTree(t) {
  const data = t.kind === 'json' ? JSON.parse(stripJsonc(t.content)) : jsyaml.load(t.content);
  const root = el('div', { className: 'tree' });
  const isObj = (v) => v && typeof v === 'object';
  const valNode = (v) => {
    const cls = v === null || v === undefined ? 'z' : typeof v === 'string' ? 's' : typeof v === 'number' ? 'n' : 'b';
    const txt = typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'null' : String(v);
    const n = el('span', { className: 'v ' + cls, textContent: txt.length > 300 ? txt.slice(0, 300) + '…' : txt, title: '클릭: 값 복사' });
    n.onclick = () => copy(typeof v === 'string' ? v : txt, '값 복사됨');
    return n;
  };
  const build = (key, v, path, depth) => {
    const label = key === null ? [] : [el('span', { className: 'k', textContent: String(key), title: '클릭: 경로 복사' }), ': '];
    if (label[0]) label[0].onclick = (e) => { e.stopPropagation(); e.preventDefault(); copy(path || '.', '경로 복사됨'); };
    if (!isObj(v)) return el('div', { className: 'leaf' }, ...label, valNode(v));
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
    const d = el('details', { open: depth < 2 });
    d.append(el('summary', {}, ...label, el('span', { className: 'meta', textContent: Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}` })));
    let filled = false;
    const fill = () => { // 큰 트리는 펼칠 때 lazy 생성
      if (filled) return; filled = true;
      for (const [k, x] of entries) d.append(build(k, x, path + (Array.isArray(v) ? `[${k}]` : /^[A-Za-z_]\w*$/.test(k) ? '.' + k : `["${k}"]`), depth + 1));
    };
    if (d.open) fill(); else d.addEventListener('toggle', fill, { once: true });
    return d;
  };
  const top = build(null, data, '', 0);
  top.style.marginLeft = '0'; root.append(top);
  return root;
}

// ───────── 컨텍스트 메뉴 / CRUD ─────────
// items: [label, fn, cls, sub] — sub(배열)가 있으면 '▸' 하위 메뉴. '-' 는 구분선
const subMenu = el('div', { id: 'menu-sub', hidden: true }); document.body.append(subMenu);
const closeMenus = () => { $('#menu').hidden = true; subMenu.hidden = true; };
function fillMenu(m, items, isSub) {
  m.replaceChildren(...items.map(([label, fn, cls, sub]) => {
    if (label === '-') return el('hr');   // 구분선
    const [txt, key] = label.split('\t');   // '이름\t⌘C' → 오른쪽에 단축키
    const d = el('div', { className: (cls || '') + (sub ? ' has-sub' : '') + (key ? ' has-key' : '') }, txt, ...(key ? [el('span', { className: 'mk', textContent: key })] : []));
    if (sub) { const open = () => showSubMenu(d, sub); d.onmouseenter = open; d.onclick = (e) => { e.stopPropagation(); open(); }; }
    else { if (!isSub) d.onmouseenter = () => { subMenu.hidden = true; $('#menu').querySelector('.sub-open')?.classList.remove('sub-open'); }; d.onclick = () => { closeMenus(); fn(); }; }
    return d;
  }));
}
function showSubMenu(item, items) {
  $('#menu').querySelector('.sub-open')?.classList.remove('sub-open'); item.classList.add('sub-open');
  fillMenu(subMenu, items, true); subMenu.hidden = false;
  const r = item.getBoundingClientRect(), w = subMenu.offsetWidth, h = subMenu.offsetHeight;
  subMenu.style.left = (r.right + w + 4 > innerWidth ? Math.max(4, r.left - w + 2) : r.right - 2) + 'px';
  subMenu.style.top = Math.max(4, Math.min(r.top - 5, innerHeight - h - 4)) + 'px';
}
function showMenu(x, y, items) {
  const m = $('#menu'); subMenu.hidden = true;
  fillMenu(m, items, false);
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 4) + 'px';
  m.style.top = Math.min(y, innerHeight - m.offsetHeight - 4) + 'px';
}
document.addEventListener('click', closeMenus);
for (const m of [$('#menu'), subMenu]) m.addEventListener('mousedown', (e) => e.preventDefault());   // 메뉴를 눌러도 편집기의 포커스·선택이 그대로 남게
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#menu').hidden) { e.preventDefault(); e.stopPropagation(); closeMenus(); } }, true);
window.addEventListener('blur', closeMenus);
$('#tree').addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const row = ev.target.closest('.row');
  const p = row?.dataset.path ?? ''; const isDir = row ? !!row.dataset.dir : true;
  const baseDir = isDir ? p : dirOf(p);
  const FM = state.platform === 'darwin' ? 'Finder' : '파일 관리자';
  const items = [
    ['새 파일…', () => createEntry(baseDir, false)],
    ['새 폴더…', () => createEntry(baseDir, true)],
    ...(clip || state.platform === 'darwin' ? (() => { const dest = baseDir ? state.root + '/' + baseDir : state.root, M = modKey(); return [['붙여넣기\t' + M + 'V', () => clipPaste(dest)], ['여기로 이동\t' + M + '⌥V', () => clipPaste(dest, true)]]; })() : []),
    ...(row ? [[favs.includes(favKey(p, isDir)) ? '즐겨찾기에서 제거' : '★ 즐겨찾기에 추가', () => toggleFavDir(favKey(p, isDir))]] : []),
    [isDir ? `${FM}에서 열기` : `${FM}에서 보기`, () => revealPath(p, 'reveal')],
    ...(isDir ? [['🖼 이미지 갤러리로 보기', () => openGallery(p ? state.root + '/' + p : state.root)]] : []),
  ];
  if (!isDir) items.push(['기본 앱으로 열기', () => revealPath(p, 'open')]);
  if (state.platform === 'darwin') items.push(['터미널에서 열기', () => revealPath(p, 'terminal')]);
  if (row && !isDir && isEnc(p)) items.push(['🔓 암호 해제 (평문으로 되돌리기)…', () => decryptEntry(p)], ['지금 잠그기', lockAll]);
  else if (row && !isDir && kindOf(p) !== 'image') items.push(['🔒 암호화…', () => encryptEntry(p)]);
  items.push(['Git', null, '', gitMenu({ path: p, isDir })]);
  if (row) items.push(
    ['이름 변경…', () => renameEntry(p)],
    ['경로 복사', () => copy(p, '경로 복사됨')],
    ['절대경로 복사', () => copy(state.root + '/' + p, '절대경로 복사됨')],
    ['삭제', () => deleteEntry(p, isDir), 'danger']);
  showMenu(ev.clientX, ev.clientY, items);
});
// ───────── 암호화 문서 ─────────
// 암호는 이 페이지의 메모리에만 둔다 (디스크/localStorage 에 저장하지 않음). 앱을 닫거나 새로고침하면, 또는 한동안 쓰지 않으면 잊는다.
const VAULT_IDLE_MS = 30 * 60 * 1000, PASS_MIN = 5;
const vault = { pass: null, used: Date.now() };
for (const ev of ['keydown', 'mousedown']) document.addEventListener(ev, () => { vault.used = Date.now(); }, true);
function askPassword(title, { confirm: twice = false, note = '' } = {}) { // 입력한 암호, 취소하면 null
  const box = $('#pw'), a = $('#pw-1'), b = $('#pw-2'), msg = $('#pw-msg');
  $('#pw-title').textContent = title; a.value = b.value = ''; b.hidden = !twice; msg.textContent = note; box.hidden = false; a.focus();
  return new Promise((resolve) => {
    const done = (v) => { a.value = b.value = ''; box.hidden = true; $('#pw-form').onsubmit = box.onkeydown = $('#pw-cancel').onclick = null; resolve(v); };
    $('#pw-form').onsubmit = (e) => {
      e.preventDefault();
      if (!a.value) return;
      if (twice && a.value.length < PASS_MIN) { msg.textContent = `암호는 ${PASS_MIN}자 이상으로 정하세요`; return; }
      if (twice && a.value !== b.value) { msg.textContent = '두 암호가 다릅니다'; return; }
      done(a.value);
    };
    box.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') done(null); };
    $('#pw-cancel').onclick = () => done(null);
  });
}
async function readEnc(p) { // 기억한 암호로 먼저 열어 보고, 안 되면 묻는다. 취소하면 null
  const name = p.split('/').pop(); let pw = vault.pass;
  for (;;) {
    try {
      const f = await api('GET', 'file', { path: p, pass: pw });
      if (!f.size && !pw) { pw = await askPassword(`${name} 의 새 암호`, { confirm: true }); if (pw === null) return null; }   // 새로 만든 빈 문서
      vault.pass = pw; return { ...f, pass: pw };
    } catch (e) {
      if (e.status !== 401 && e.status !== 423) throw e;
      pw = await askPassword(`${name} 암호`, { note: e.status === 401 ? '암호가 맞지 않습니다' : '' });
      if (pw === null) return null;
    }
  }
}
async function settleTab(t) { // 저장이 끝나지 않은 탭이면 false
  if (t && dirty(t)) await save(t, true, true);
  return !t || !dirty(t);
}
function retargetTab(t, from, r, pass) { // 경로가 바뀐 문서를 탭/트리에 반영
  if (t) { t.path = r.path; t.mtime = r.mtime; t.pass = pass; t._savedAt = Date.now(); if (state.active === from) state.active = r.path; }
  if (state.selected === from) state.selected = r.path;
  childrenCache.clear(); persistTabs(); renderAll();
}
async function encryptEntry(p) {
  const t = tabOf(p); if (!await settleTab(t)) return toast('저장되지 않은 변경이 있어 암호화하지 않았습니다');
  const pass = await askPassword(`${p.split('/').pop()} 암호화`, { confirm: true, note: '암호를 잊으면 복구할 수 없습니다' }); if (pass === null) return;
  try {
    retargetTab(t, p, await api('POST', 'crypt/lock', { path: p, pass }), pass); vault.pass = pass;
    toast('암호화됨 — 이미 커밋된 평문은 git 기록에 그대로 남습니다');
  } catch (e) { toast('암호화 실패: ' + e.message); }
}
async function decryptEntry(p) {
  if (!confirm(`평문으로 되돌릴까요?\n${p}\n커밋하면 내용이 git 에 그대로 올라갑니다.`)) return;
  const t = tabOf(p); if (!await settleTab(t)) return toast('저장되지 않은 변경이 있어 해제하지 않았습니다');
  const pass = t?.pass ?? (await readEnc(p))?.pass; if (!pass) return;
  try { retargetTab(t, p, await api('POST', 'crypt/unlock', { path: p, pass }), undefined); toast('암호 해제됨'); }
  catch (e) { toast('암호 해제 실패: ' + e.message); }
}
async function lockAll() { // 암호를 잊고 열린 암호화 문서를 닫는다
  vault.pass = null;
  for (const t of state.tabs.filter((x) => x.pass)) { await settleTab(t); await closeTab(t.path); }
  toast('🔒 잠금');
}
setInterval(() => { if ((vault.pass || state.tabs.some((t) => t.pass)) && Date.now() - vault.used > VAULT_IDLE_MS) lockAll(); }, 60000);

async function revealPath(rel, action) { // Finder / 파일 관리자 / 터미널 / 기본 앱
  try { await api('POST', 'reveal', { path: rel }, { action }); } catch (e) { toast('열 수 없음: ' + e.message); }
}
async function createEntry(dir, isDir) {
  const name = prompt(isDir ? '새 폴더 이름' : '새 파일 이름 (예: notes/todo.md)', '');
  if (!name) return;
  const p = dir ? dir + '/' + name : name;
  try {
    await api('POST', 'create', { path: p }, { dir: isDir });
    for (let d = dirOf(p); d; d = dirOf(d)) state.expanded.add(d);
    if (dir) state.expanded.add(dir);
    childrenCache.clear();
    if (!isDir) await openFile(p); else await renderTree();
  } catch (e) { toast(e.message); }
}
async function renameEntry(p) {
  const to = prompt('새 경로', p); if (!to || to === p) return;
  try {
    await api('POST', 'rename', { path: p }, { to });
    state.tabs.forEach((t) => { // 열린 탭 경로 갱신
      if (t.path === p || t.path.startsWith(p + '/')) {
        if (state.active === t.path) state.active = to + t.path.slice(p.length);
        t.path = to + t.path.slice(p.length); t.kind = kindOf(t.path);
      }
    });
    childrenCache.clear(); persistTabs(); renderAll();
  } catch (e) { toast(e.message); }
}
async function deleteEntry(p, isDir) {
  if (!confirm(`삭제할까요? (되돌릴 수 없음)\n${p}${isDir ? '/ (하위 전체)' : ''}`)) return;
  try {
    await api('DELETE', 'file', { path: p });
    state.tabs.filter((t) => t.path === p || t.path.startsWith(p + '/')).forEach((t) => { t.content = t.orig; closeTab(t.path); });
    childrenCache.clear(); renderAll();
  } catch (e) { toast(e.message); }
}
$('#btn-new-file').onclick = () => createEntry(state.selected && !tabOf(state.selected) && state.expanded.has(state.selected) ? state.selected : dirOf(state.selected || ''), false);
$('#btn-new-dir').onclick = () => createEntry(dirOf(state.selected || ''), true);

// ───────── 빠른 열기 (⌘P) ─────────
const pal = { files: null, ts: 0, loading: null, items: [], sel: 0, dir: '', inDir: false };
function openPalette() {
  $('#palette').hidden = false; const inp = $('#pal-input'); inp.value = ''; inp.focus();
  pal.dir = dirOfSel(); setPalScope(store.get('palInDir', false));
  loadPalFiles();
}
// 받아 둔 파일 목록으로 바로 보여 주고, 서버 인덱스가 바뀌었을 때만 뒤에서 다시 받는다 (감시 불가면 항상: /api/files 가 재스캔을 일으킴)
function loadPalFiles() {
  return pal.loading ||= (async () => {
    const s = await api('GET', 'index');
    if (pal.files && s.ts === pal.ts && s.watching) return;
    pal.files = await api('GET', 'files'); pal.ts = s.ts;
    if (!$('#palette').hidden) filterPalette($('#pal-input').value, true);
  })().catch(() => {}).finally(() => { pal.loading = null; });
}
// 최근에 연 파일 (최신순, 폴더별 저장). 검색 순위에 쓴다
const PAL_HISTORY_MAX = 100;
const palHistory = () => store.get(wsKey('palHistory'), []);
const rememberOpen = (p) => store.set(wsKey('palHistory'), [p, ...palHistory().filter((x) => x !== p)].slice(0, PAL_HISTORY_MAX));
// 가까운 순위 (작을수록 위): 최근 연 파일 / 열린 탭 > 선택한 폴더 안 > 최근 연 파일의 폴더 > 트리에서 펼친 폴더 > 나머지
const PAL_HERE = 1e3, PAL_DIR = 2e3, PAL_EXPANDED = 3e3, PAL_OTHER = 4e3;
function palRanker(recent) {
  const files = new Map(recent.map((p, i) => [p, i])), dirs = new Map(), here = pal.dir && !pal.inDir ? pal.dir + '/' : '';
  recent.forEach((p, i) => { const d = dirOf(p); if (!dirs.has(d)) dirs.set(d, i); });
  return (f) => {
    const i = files.get(f); if (i !== undefined) return i;
    if (here && f.startsWith(here)) return PAL_HERE;
    const d = dirOf(f), k = dirs.get(d);
    return k !== undefined ? PAL_DIR + k : state.expanded.has(d) ? PAL_EXPANDED : PAL_OTHER;
  };
}
// 검색 범위: 전체 | 트리에서 선택한 폴더 (폴더가 없으면 전체). 내용 검색의 범위 버튼과 같은 동작
function setPalScope(inDir) {
  pal.inDir = inDir && !!pal.dir;
  $('#pal-all').classList.toggle('on', !pal.inDir); $('#pal-dir').classList.toggle('on', pal.inDir);
  $('#pal-dir').textContent = '📁 ' + (pal.dir ? pal.dir.split('/').pop() : '선택한 폴더'); $('#pal-dir').title = pal.dir || '트리에서 폴더를 선택하세요';
  $('#pal-dir').disabled = !pal.dir; $('#pal-input').placeholder = pal.inDir ? pal.dir + ' 안에서 파일 이름 검색…' : '파일 이름 검색…';
  filterPalette($('#pal-input').value);
}
const pickPalScope = (inDir) => { store.set('palInDir', inDir); setPalScope(inDir); $('#pal-input').focus(); };
$('#pal-all').onclick = () => pickPalScope(false); $('#pal-dir').onclick = () => pickPalScope(true);
// 파일 이름 중심 검색 (PyCharm 의 Search Everywhere 와 비슷):
// 이름 접두 > 이름 내 부분일치(단어 경계 우선) > 이름 내 글자 순서 일치 > 경로 부분일치. 경로 전체에 흩뿌린 매칭은 제외.
function matchFile(q, f) {
  const ql = q.toLowerCase(), fl = f.toLowerCase(), b0 = f.lastIndexOf('/') + 1, bl = fl.slice(b0);
  const range = (s, n) => Array.from({ length: n }, (_, k) => s + k);
  if (!ql.includes('/')) {
    const i = bl.indexOf(ql);
    if (i === 0) return { tier: 0, pos: range(b0, ql.length) };
    if (i > 0) return { tier: /[._\-\s]/.test(bl[i - 1]) ? 1 : 2, pos: range(b0 + i, ql.length) };
    if (ql.length >= 2) { // 단어 시작 글자 약어 매칭: uc → user_content, UC → UserContent (글자를 흩뿌려 맞추지 않음)
      const hump = (k) => k === 0 || /[._\-\s]/.test(b[k - 1]) || (/[A-Z]/.test(b[k]) && /[a-z0-9]/.test(b[k - 1]));
      const b = f.slice(b0), pos = []; let p = 0;
      for (const ch of ql) {
        let k = p;
        while (k < b.length && !(bl[k] === ch && (hump(k) || (pos.length && k === pos.at(-1) - b0 + 1)))) k++;
        if (k >= b.length) { pos.length = 0; break; }
        pos.push(b0 + k); p = k + 1;
      }
      if (pos.length === ql.length) return { tier: 3, pos };
    }
  }
  const k = fl.indexOf(ql);
  return k >= 0 ? { tier: 4, pos: range(k, ql.length) } : null;
}
function filterPalette(q, keepSel) {
  const pre = pal.inDir ? pal.dir + '/' : '', inScope = (f) => f.startsWith(pre);
  const tabs = state.tabs.map((t) => t.path).filter((p) => !isMemo(p) && inScope(p));
  const rank = palRanker([...new Set([...palHistory(), ...tabs])]);
  const files = (pal.files || []).filter(inScope);
  const match = (f) => { // 범위 폴더 이름 자체가 경로 일치로 잡히지 않도록 범위 아래 경로로만 비교
    const m = matchFile(q, f.slice(pre.length));
    return m && { ...m, pos: m.pos.map((p) => p + pre.length) };
  };
  const byName = (a, b) => a.f.length - b.f.length || (a.f < b.f ? -1 : 1);
  let res;
  if (q) { // 단어 시작에 맞은 이름(tier 0·1)끼리는 가까운 파일을 먼저, 그보다 약한 일치는 tier 를 앞세운다
    const group = (t) => (t <= 1 ? 0 : t);
    res = files.map((f) => ({ f, m: match(f) })).filter((x) => x.m).map((x) => ({ ...x, r: rank(x.f) }))
      .sort((a, b) => group(a.m.tier) - group(b.m.tier) || a.r - b.r || a.m.tier - b.m.tier || byName(a, b)).slice(0, 80);
  } else { // 검색어가 없으면 가까운 파일부터, 남는 자리는 나머지 파일로
    const near = [...new Set([...tabs, ...files.filter((f) => rank(f) < PAL_OTHER)])].map((f) => ({ f, r: rank(f), m: { pos: [] } }))
      .sort((a, b) => a.r - b.r || byName(a, b)).slice(0, 80);
    const seen = new Set(near.map((x) => x.f));
    res = [...near, ...files.filter((f) => !seen.has(f)).slice(0, 80 - near.length).map((f) => ({ f, m: { pos: [] } }))];
  }
  const cur = keepSel && pal.items[pal.sel]?.f;   // 목록이 뒤에서 갱신돼도 고르던 파일은 유지
  pal.items = res; pal.sel = cur ? Math.max(0, res.findIndex((x) => x.f === cur)) : 0; drawPalette();
}
function drawPalette() {
  $('#pal-list').replaceChildren(...pal.items.map(({ f, m }, i) => {
    const b0 = f.lastIndexOf('/') + 1, hl = new Set(m.pos);
    const part = (s, off) => { // 일치한 글자를 하이라이트
      const span = document.createDocumentFragment(); let run = '', on = false;
      const flush = () => { if (run) span.append(on ? el('mark', { textContent: run }) : run); run = ''; };
      [...s].forEach((ch, k) => { const h = hl.has(off + k); if (h !== on) { flush(); on = h; } run += ch; });
      flush(); return span;
    };
    const kind = kindOf(f);
    const li = el('li', { className: i === pal.sel ? 'sel' : '', title: f },
      el('span', { className: 'ico k-' + kind, textContent: iconOf(f) }),
      el('span', { className: 'pn' }, part(f.slice(b0), b0)),
      el('span', { className: 'pd' }, part(f.slice(0, b0 - 1), 0)));
    li.onclick = () => { closePalette(); openFile(f); };
    return li;
  }));
  $('#pal-list .sel')?.scrollIntoView({ block: 'nearest' });
}
const closePalette = () => { $('#palette').hidden = true; };
$('#pal-input').oninput = (e) => {
  if (looksAbsPath(e.target.value)) { const v = e.target.value; closePalette(); openPicker('file', v, e.inputType === 'insertFromPaste'); return; }   // 절대경로·file:// → 경로로 열기 (폴더를 붙여넣었으면 갤러리)
  filterPalette(e.target.value);
};
$('#pal-input').onkeydown = (e) => {
  if (e.key === 'Escape') closePalette();
  else if (e.key === 'Tab') { e.preventDefault(); if (pal.dir) pickPalScope(!pal.inDir); }
  else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) { e.preventDefault(); pal.sel = Math.min(pal.sel + 1, pal.items.length - 1); drawPalette(); }
  else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) { e.preventDefault(); pal.sel = Math.max(pal.sel - 1, 0); drawPalette(); }
  else if (e.key === 'PageDown') { e.preventDefault(); pal.sel = Math.min(pal.sel + 8, pal.items.length - 1); drawPalette(); }
  else if (e.key === 'PageUp') { e.preventDefault(); pal.sel = Math.max(pal.sel - 8, 0); drawPalette(); }
  else if (e.key === 'Enter' && pal.items[pal.sel]) { const f = pal.items[pal.sel].f; closePalette(); openFile(f); }
};
document.addEventListener('mousedown', (e) => { if (!$('#palette').hidden && !e.target.closest('#palette')) closePalette(); });

// 마크다운 서식 단축키 (편집기에서): ⌘/Ctrl+B 굵게, +I 기울임, +Shift+X 취소선, +Shift+C 인라인 코드, +K 링크. 같은 단축키를 다시 누르면 해제
function wrapSel(ta, mk) {
  const v = ta.value; let a = ta.selectionStart, b = ta.selectionEnd; const n = mk.length;
  let out, na, nb;
  if (mk[0] === '*') {   // 별표는 굵게(**)+기울임(*)이 겹칠 수 있어 바깥의 별표 개수로 판단: 홀수면 기울임, 2 이상이면 굵게
    while (b - a >= 2 && v[a] === '*' && v[b - 1] === '*') { a++; b--; }   // 마커까지 선택된 경우 안쪽만 대상으로
    let L = 0, R = 0; while (v[a - 1 - L] === '*') L++; while (v[b + R] === '*') R++;
    const m = Math.min(L, R), has = n === 1 ? m % 2 === 1 : m >= 2;
    if (has) { a -= n; b += n; out = v.slice(a + n, b - n); na = a; nb = a + out.length; }
    else { out = mk + v.slice(a, b) + mk; na = a + n; nb = na + (b - a); }
  } else {
    const sel = v.slice(a, b);
    if (sel.length >= 2 * n && sel.startsWith(mk) && sel.endsWith(mk)) { out = sel.slice(n, -n); na = a; nb = a + out.length; }   // 마커까지 선택됨
    else if (a >= n && v.slice(a - n, a) === mk && v.slice(b, b + n) === mk) { a -= n; b += n; out = sel; na = a; nb = a + sel.length; }   // 마커 바로 안쪽 선택
    else { out = mk + sel + mk; na = a + n; nb = na + sel.length; }
  }
  ta.setSelectionRange(a, b); document.execCommand('insertText', false, out); ta.setSelectionRange(na, nb);
}
function linkSel(ta) {
  const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b);
  const isUrl = /^(https?:\/\/|mailto:)\S+$/i.test(sel.trim());
  const text = isUrl ? '' : sel, url = isUrl ? sel.trim() : 'url';
  document.execCommand('insertText', false, `[${text}](${url})`);
  if (isUrl || !sel) ta.setSelectionRange(a + 1, a + 1 + text.length);                       // 글자를 쓰게 [] 안에 커서
  else ta.setSelectionRange(a + text.length + 3, a + text.length + 3 + url.length);          // 'url' 을 바로 덮어쓰게 선택
}
document.addEventListener('keydown', (e) => {
  const ta = e.target; if (ta?.tagName !== 'TEXTAREA' || !(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
  if (!(ta.classList.contains('sb-ta') || (ta.classList.contains('editor') && cur()?.kind === 'md'))) return;
  const k = e.key.toLowerCase(); let fn = null;
  if (!e.shiftKey && k === 'b') fn = () => wrapSel(ta, '**');
  else if (!e.shiftKey && k === 'i') fn = () => wrapSel(ta, '*');
  else if (e.shiftKey && k === 'x') fn = () => wrapSel(ta, '~~');
  else if (e.shiftKey && k === 'c') fn = () => wrapSel(ta, '`');
  else if (!e.shiftKey && k === 'k') fn = () => linkSel(ta);
  if (!fn) return;
  e.preventDefault(); e.stopImmediatePropagation(); fn();   // ⌘B(사이드바 토글) 등 전역 단축키보다 우선
}, true);
// Home / End: 페이지 처음·끝이 아니라 현재 줄의 처음·끝으로 (macOS 기본 동작 대체 — 편집기·SQL·커밋 메시지 같은 textarea 와
// 필터·검색·폼 같은 한 줄 입력칸 모두. ⌘/Ctrl 조합은 기본 동작 유지)
const LINE_INPUT = /^(text|search|url|tel|email|password|)$/;
document.addEventListener('keydown', (e) => {
  const ta = e.target;
  if ((e.key !== 'Home' && e.key !== 'End') || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (ta?.tagName !== 'TEXTAREA' && !(ta?.tagName === 'INPUT' && LINE_INPUT.test(ta.getAttribute('type') || ''))) return;
  e.preventDefault();
  const v = ta.value, from = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;   // 움직이는 쪽 끝
  const anchor = ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart;
  const pos = e.key === 'Home' ? v.lastIndexOf('\n', from - 1) + 1 : (v.indexOf('\n', from) < 0 ? v.length : v.indexOf('\n', from));
  if (e.shiftKey) ta.setSelectionRange(Math.min(anchor, pos), Math.max(anchor, pos), pos < anchor ? 'backward' : 'forward');
  else ta.setSelectionRange(pos, pos);
  ta.blur(); ta.focus();   // 긴 줄에서 커서가 보이도록 가로 스크롤 (선택은 유지됨)
}, true);
// ───────── 트리에서 ⌘/Ctrl+C → 선택한 파일/폴더의 전체 경로 복사 (Shift 를 같이 누르면 프로젝트 기준 상대 경로) ─────────
function selectedPath(relative) {
  const sel = state.selected || '';
  if (isMemo(sel) || isExt(sel) || isGal(sel)) return absOf(sel);
  return relative ? (sel || '.') : (sel ? state.root + '/' + sel : state.root);
}
const inTree = () => !!document.activeElement?.closest('#tree');
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'c' || !inTree()) return;
  e.preventDefault(); copy(selectedPath(e.shiftKey), e.shiftKey ? '상대 경로 복사됨' : '전체 경로 복사됨');
}, true);
document.addEventListener('copy', (e) => { // 메뉴(네이티브 앱의 편집 > 복사하기)로 들어온 복사 요청
  if (!inTree() || String(getSelection())) return;
  e.preventDefault(); e.clipboardData.setData('text/plain', selectedPath(false)); toast('전체 경로 복사됨');
});

// ───────── 단축키 ─────────
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey; if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); save(); }
  else if (k === 'p' && !e.shiftKey) { e.preventDefault(); openPalette(); }
  else if (k === 'o' && !e.altKey) { e.preventDefault(); openPicker(e.shiftKey ? 'dir' : 'file'); }   // ⌘/Ctrl+O: 파일 열기, +Shift: 폴더(워크스페이스) 전환
  else if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && !e.shiftKey && !e.altKey) { e.preventDefault(); navStep(e.code === 'BracketLeft' ? -1 : 1); }   // ⌘[ 뒤로 / ⌘] 앞으로
  else if (k === 'b') { e.preventDefault(); document.body.classList.toggle('no-side'); store.set('noSide', document.body.classList.contains('no-side')); }
  else if (k === 'w' && cur()) { e.preventDefault(); closeTab(state.active); }
  else if (e.code === 'KeyN' && e.altKey) { e.preventDefault(); newMemo(); }
  else if (k === ',') { e.preventDefault(); $('#settings') && !$('#settings').hidden ? ($('#settings').hidden = true) : openSettings(); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); openFind(); }
  else if (k === 'f' && !e.shiftKey && !e.altKey) { e.preventDefault(); openFileFind(); }
  else if (k === 'g' && fb.open) { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  else if (e.code === 'KeyL' && e.altKey) { e.preventDefault(); prettify(); }
  else if (k === 'e' && cur() && MODES[cur().kind]) { // 보기 ↔ 편집
    e.preventDefault(); const t = cur(); const ms = MODES[t.kind].map((m) => m[0]);
    if (t.blame) { t.blame = null; renderToolbar(); renderContent(); return; }   // Blame 화면 → 원래 보기로
    t.mode = ms[(ms.indexOf(t.mode) + 1) % ms.length]; persistTabs(); renderToolbar(); renderContent();
  }
});

// ───────── 뒤로/앞으로 (트랙패드 두 손가락 좌우 스와이프 · ⌘[ ⌘] · 마우스 뒤로/앞으로 버튼) ─────────
// 보던 탭(파일·갤러리 폴더·이미지 등)을 기록한다. 이미지 뷰어에서 ←/→ 로 넘기는 것과 탭을 닫아 옆 탭으로 가는 것은 기록을 늘리지 않고 지금 항목만 바꾼다.
// 기록 맨 앞에서 더 뒤로 가면, 다른 워크스페이스에서 넘어온 경우(go) 그 화면으로 돌아간다 (브라우저 기록 사용, 앞으로도 마찬가지).
const nav = { stack: [], i: -1, ready: false, restoring: false, replaceNext: false, from: null, fwd: null };
const NAV_MAX = 100;
function navSave() { try { sessionStorage.setItem('ss:nav:' + state.root, JSON.stringify({ s: nav.stack, i: nav.i, from: nav.from, fwd: nav.fwd })); } catch {} }
function navLoad() { // 워크스페이스별로 이 창(세션)에 기록을 둔다
  try {
    const r = JSON.parse(sessionStorage.getItem('ss:nav:' + state.root) || 'null');
    if (r && Array.isArray(r.s)) Object.assign(nav, { stack: r.s.filter((x) => typeof x === 'string'), i: Math.min(r.i, r.s.length - 1), from: r.from || null, fwd: r.fwd || null });
    const from = sessionStorage.getItem('ss:navFrom'), fwd = sessionStorage.getItem('ss:navFwd');
    sessionStorage.removeItem('ss:navFrom'); sessionStorage.removeItem('ss:navFwd');
    if (from && from !== state.root) { nav.from = from; nav.fwd = null; nav.i = nav.stack.length - 1; }   // 다른 워크스페이스에서 넘어옴 (새 기록은 끝에 이어 붙인다)
    if (fwd && fwd !== state.root) nav.fwd = fwd;   // 뒤로 가기로 돌아옴 → 기록 끝에서 앞으로 가면 그 워크스페이스
  } catch {}
  nav.ready = true;
}
function navSync() { // 화면을 그릴 때마다: 활성 탭이 바뀌었으면 기록
  const p = state.active; if (!nav.ready || nav.restoring || !p) return;
  const prev = nav.stack[nav.i]; if (p === prev) return;
  const step = prev && !isGal(prev) && !tabOf(prev) && kindOf(prev) === 'image' && tabOf(p)?.kind === 'image';   // 이미지 뷰어에서 넘김 (같은 탭의 경로가 바뀜)
  if ((nav.replaceNext || step) && nav.i >= 0) {
    nav.stack[nav.i] = p;
    if (nav.i > 0 && nav.stack[nav.i - 1] === p) { nav.stack.splice(nav.i, 1); nav.i--; }
  } else {
    nav.stack = nav.stack.slice(0, nav.i + 1); nav.stack.push(p);
    if (nav.stack.length > NAV_MAX) nav.stack.shift();
    nav.i = nav.stack.length - 1; nav.fwd = null;
  }
  nav.replaceNext = false; navSave();
}
const navCan = (d) => (d < 0 ? nav.i > 0 || !!nav.from || !!cur()?.h?.back?.length : nav.i < nav.stack.length - 1 || !!nav.fwd);
async function navOpen(p) { // 기록의 항목을 다시 보여 준다 (닫힌 탭이면 다시 연다). 못 열면 false
  if (tabOf(p)) { flushAll(); state.active = p; state.selected = tabOf(p).kind === 'gallery' ? '' : p; persistTabs(); renderAll(); return true; }
  if (isGal(p)) { const t = cur(), abs = p.slice(4) || '/'; if (t?.kind === 'gallery') galGo(t, abs); else openGallery(abs); return true; }   // 갤러리는 같은 탭에서 폴더를 옮긴다
  if (isDrop(p)) { if (!dropped.has(p)) return false; openImageList([p]); return true; }
  if (p.startsWith('@hist/')) { // 닫은 히스토리 탭은 다시 연다 (줄 범위 히스토리는 그때의 줄 위치라 제외)
    const [abs, scope, rel, range] = p.slice(6).split('|'); if (range) return false;
    const a = abs + (rel ? '/' + rel : ''), src = a === state.root ? '' : a.startsWith(state.root + '/') ? a.slice(state.root.length + 1) : '@ext' + a;
    await openHistory({ path: src, scope }); return state.active === p;
  }
  if (/^@(run|sql|diff)\//.test(p)) return false;   // 닫은 실행/SQL/diff 탭은 다시 열 수 없다
  await openFile(p); return state.active === p;
}
let navBusy = false;
async function navStep(d) { // d: -1 뒤로, +1 앞으로
  if (navBusy) return; navBusy = true;
  try {
    if (d < 0 && cur()?.kind === 'history' && histBack(cur())) return;   // 커밋 전체 diff 등 → 파일 히스토리로
    for (;;) {
      const j = nav.i + d; if (j < 0 || j >= nav.stack.length) break;
      nav.restoring = true; let ok = false;
      try { ok = await navOpen(nav.stack[j]); } catch {} finally { nav.restoring = false; }
      if (ok) { nav.i = j; if (state.active) nav.stack[j] = state.active; navSave(); return; }
      nav.stack.splice(j, 1); if (d < 0) nav.i--;   // 지워진 파일 등 열 수 없는 항목은 빼고 계속
      navSave();
    }
    if (d < 0 && nav.from) { try { sessionStorage.setItem('ss:navFwd', state.root); } catch {} history.back(); }   // 기록 맨 앞: 넘어오기 전 워크스페이스로
    else if (d > 0 && nav.fwd) history.forward();
  } finally { navBusy = false; }
}
// 트랙패드: 두 손가락을 오른쪽으로 쓸면 뒤로, 왼쪽으로 쓸면 앞으로 (Safari/Chrome 과 같은 방향).
// 휠 이벤트의 가로 이동을 모아 일정 거리를 넘으면 한 번만 넘긴다. 가로로 스크롤할 수 있는 곳(넓은 표·코드)에서 시작한 제스처와
// 이미 처리된 휠(이미지 뷰어의 좌우 스와이프 = 이전/다음 이미지, 핀치 확대)은 건드리지 않는다.
const SWIPE_DIST = 150;
const swipe = { dx: 0, dy: 0, t: 0, lock: null, done: false, hideT: 0 };
const swipeHint = el('div', { id: 'swipe-hint', hidden: true });
document.body.append(swipeHint);
function canScrollX(node, dir) {
  for (let n = node; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth <= n.clientWidth + 1) continue;
    const ox = getComputedStyle(n).overflowX; if (ox !== 'auto' && ox !== 'scroll' && n.tagName !== 'TEXTAREA') continue;
    if (dir > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0) return true;
  }
  return false;
}
function drawSwipe(d, k) {
  swipeHint.hidden = false; swipeHint.className = (d < 0 ? 'l' : 'r') + (k >= 1 ? ' go' : '');
  swipeHint.textContent = d < 0 ? '←' : '→';
  swipeHint.style.opacity = String(0.2 + k * 0.8);
  swipeHint.style.transform = `translateX(${d * (1 - k) * 48}px)`;
  clearTimeout(swipe.hideT); swipe.hideT = setTimeout(() => { swipeHint.hidden = true; }, k >= 1 ? 380 : 220);
}
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.defaultPrevented) return;
  const now = performance.now();
  if (now - swipe.t > 250) Object.assign(swipe, { dx: 0, dy: 0, lock: null, done: false });   // 잠깐 끊기면 새 제스처
  swipe.t = now;
  if (swipe.done || swipe.lock === 'no') return;   // 이미 넘긴 제스처의 관성 이벤트 / 세로 스크롤
  swipe.dx += e.deltaX; swipe.dy += e.deltaY;
  if (!swipe.lock) {
    if (Math.abs(swipe.dx) + Math.abs(swipe.dy) < 10) return;
    swipe.lock = Math.abs(swipe.dx) > Math.abs(swipe.dy) * 2 && !canScrollX(e.target, Math.sign(swipe.dx)) ? 'x' : 'no';
    if (swipe.lock === 'no') return;
  }
  const d = swipe.dx < 0 ? -1 : 1;
  if (!navCan(d)) { swipeHint.hidden = true; return; }
  const k = Math.min(1, Math.abs(swipe.dx) / SWIPE_DIST);
  drawSwipe(d, k);
  if (k >= 1) { swipe.done = true; navStep(d); }
}, { passive: true });
window.addEventListener('mouseup', (e) => { // 마우스 옆 버튼 (뒤로 3 / 앞으로 4)
  if (e.button === 3 || e.button === 4) { e.preventDefault(); navStep(e.button === 3 ? -1 : 1); }
});

// ───────── 파일 인덱스 상태 (서버가 백그라운드로 인덱싱) ─────────
async function watchIndex() {
  const box = $('#st-idx'); let lastTs = 0;
  for (let i = 0; i < 600; i++) {
    try {
      const s = await api('GET', 'index');
      if (s.ts !== lastTs) { lastTs = s.ts; if (state.filter && s.ready) fetchFilterDirs().then(renderTree); } // 파일이 생기거나 사라지면 필터 갱신
      if (s.ready && !pal.files) loadPalFiles();   // 첫 검색도 기다리지 않도록 미리 받아 둔다
      box.textContent = s.ready && !s.building ? `⚡ ${s.count.toLocaleString()} files indexed${s.truncated ? '+' : ''}` : `⏳ indexing… ${s.count ? s.count.toLocaleString() : ''}`;
      box.title = s.watching ? '파일 변경을 실시간으로 감시 중' : '변경 감시 불가: 10초 간격으로 갱신';
    } catch { return; }
    await new Promise((r) => setTimeout(r, s_wait(i)));
  }
}
const s_wait = (i) => (i < 20 ? 700 : 5000); // 초반엔 빠르게, 이후엔 느리게 상태 갱신

// ───────── 설정 (서버의 ~/.config/shooting-star/settings.json) ─────────
// 내용 검색(Find in Files)에서 훑을 파일 형식. 기본은 YAML / JSON / Python / Markdown / Java.
const SEARCH_CATS = [
  { id: 'yaml', label: 'YAML', exts: 'yml,yaml' },
  { id: 'json', label: 'JSON', exts: 'json,jsonc,jsonl,ndjson,geojson' },
  { id: 'python', label: 'Python', exts: 'py,pyi' },
  { id: 'java', label: 'Java', exts: 'java' },
  { id: 'markdown', label: 'Markdown', exts: 'md,markdown,mdx' },
  { id: 'csv', label: 'CSV / TSV', exts: 'csv,tsv' },
  { id: 'js', label: 'JavaScript / TypeScript', exts: 'js,mjs,cjs,jsx,ts,tsx' },
  { id: 'sh', label: 'Shell', exts: 'sh,bash,zsh' },
  { id: 'sql', label: 'SQL', exts: 'sql' },
  { id: 'toml', label: 'TOML / INI', exts: 'toml,ini,cfg,conf' },
  { id: 'web', label: 'HTML / CSS / XML', exts: 'html,htm,css,scss,xml,svg' },
  { id: 'text', label: '텍스트 / 로그', exts: 'txt,log,rst' },
];
// ───────── 테마 ─────────
// colors: [배경, 사이드바, 강조, 글자] — 설정 화면의 미리보기 카드용. system 은 다크/라이트 반반.
const THEMES = [
  { id: 'system', label: '시스템 설정 따르기', colors: ["#14161a", "#ffffff", "#7aa2ff", "#0969da"] },
  { id: 'dark', label: '다크', colors: ["#14161a", "#1a1d22", "#7aa2ff", "#d4d8de"] },
  { id: 'midnight', label: '미드나잇', colors: ["#000000", "#0a0a0c", "#6ea0ff", "#d8dbe0"] },
  { id: 'nord', label: 'Nord', colors: ["#2e3440", "#292e39", "#88c0d0", "#d8dee9"] },
  { id: 'solarized', label: 'Solarized Dark', colors: ["#002b36", "#00232c", "#268bd2", "#93a1a1"] },
  { id: 'dracula', label: 'Dracula', colors: ["#282a36", "#21222c", "#bd93f9", "#f8f8f2"] },
  { id: 'light', label: '라이트', colors: ["#ffffff", "#f6f8fa", "#0969da", "#1f2328"] },
  { id: 'solarized-light', label: 'Solarized Light', colors: ["#fdf6e3", "#eee8d5", "#1a6aa0", "#34464c"] },
  { id: 'gruvbox-light', label: 'Gruvbox Light', colors: ["#fbf1c7", "#f2e5bc", "#076678", "#3c3836"] },
  { id: 'paper', label: '페이퍼 (세피아)', colors: ["#f4ecd8", "#ebe2cb", "#94531a", "#433422"] },
  { id: 'snow', label: 'Snow', colors: ["#eceff4", "#e5e9f0", "#436793", "#2e3440"] },
  { id: 'rose', label: 'Rosé', colors: ["#fdf6f6", "#f7ebeb", "#b83a5f", "#3d2f33"] },
];
const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));
const lightMQ = matchMedia('(prefers-color-scheme: light)');
function applyTheme(name) {
  if (!THEME_BY_ID[name]) name = 'dark';
  const resolved = name === 'system' ? (lightMQ.matches ? 'light' : 'dark') : name;
  document.documentElement.dataset.theme = resolved;
  store.set('theme', name);
  const cs = getComputedStyle(document.documentElement);
  // 네이티브 앱(WKWebView)에는 창 모양(밝기/배경)을 알려 준다
  try { window.webkit?.messageHandlers?.theme?.postMessage(`${cs.colorScheme.includes('light') ? 'light' : 'dark'},${cs.getPropertyValue('--bg').trim()}`); } catch {}
}
lightMQ.addEventListener?.('change', () => { if (store.get('theme', 'dark') === 'system') applyTheme('system'); });

const SETTINGS_DEFAULT = { searchTypes: ['yaml', 'json', 'python', 'markdown', 'java'], searchAll: false, customExts: '', theme: 'dark', checkUpdates: true, gitMarks: true, imageFit: 'fill', autoSave: '1' };

// ───────── 업데이트 확인 (서버가 GitHub Releases 의 최신 버전과 비교) ─────────
let updateInfo = null;
async function checkUpdates(force) {
  try { updateInfo = await api('GET', 'update', force ? { force: 1 } : {}); } catch { return null; }
  const z = $('#st-update'); z.hidden = !updateInfo.available;
  if (updateInfo.available) {
    z.textContent = updateInfo.kind === 'git' ? `⬆ 업데이트 ${updateInfo.behind}` : `⬆ v${updateInfo.latest}`;
    z.title = updateInfo.kind === 'git' ? `main 에 새 커밋 ${updateInfo.behind}개 — 클릭해서 업데이트` : `새 버전 v${updateInfo.latest} 사용 가능 (현재 v${updateInfo.current}) — 클릭해서 업데이트`;
  }
  return updateInfo;
}
$('#st-update').onclick = () => openSettings();
const UPD_LABEL = { git: 'git pull', brew: 'Homebrew', app: '릴리스 zip 으로 앱 교체', deb: '.deb 수동 설치', unknown: '수동 설치' };
async function applyUpdate(msg) { // 서버가 설치 방식에 맞게 업데이트하고(git pull / brew / zip 교체), 끝나면 앱을 다시 시작한다
  const u = updateInfo; if (!u?.available) return;
  if (state.tabs.some(dirty)) { alert('저장하지 않은 변경이 있는 탭이 있습니다. 저장한 뒤 다시 시도하세요.'); return; }
  const target = u.kind === 'git' ? `main 의 새 커밋 ${u.behind}개` : `v${u.latest}`;
  if (!confirm(`업데이트합니다 (${UPD_LABEL[u.kind] || u.kind}).\n현재 v${u.current} → ${target}\n\n완료되면 앱이 다시 시작됩니다. 계속할까요?`)) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const oldBuild = (await api('GET', 'info').catch(() => ({}))).build;
  try { await api('POST', 'update/apply', {}, {}); } catch (e) { msg.textContent = '시작하지 못했습니다: ' + e.message; return; }
  for (;;) { // 진행 상황
    await sleep(800);
    let j; try { j = await api('GET', 'update/status'); } catch { break; }   // 서버가 내려갔다 = 재시작 중
    msg.textContent = j.log?.at(-1) || '진행 중…';
    if (j.state === 'error') { msg.textContent = '실패: ' + j.error; return; }
    if (j.state === 'manual') { msg.textContent = '이 설치 방식은 자동 업데이트를 지원하지 않습니다: ' + j.manual; return; }
    if (j.state === 'done' || j.state === 'idle') { msg.textContent = '완료 — 다시 시작하는 중…'; break; }   // idle = 서버가 이미 새 코드로 교체되어 작업 기록이 사라짐
  }
  for (let i = 0; i < 90; i++) { // 새 서버가 뜰 때까지 기다렸다가 새로고침 (앱 교체/brew 는 앱 자체가 다시 열린다)
    await sleep(1000);
    try { const d = await api('GET', 'info'); if (d.build !== oldBuild || (u.kind === 'git' && i >= 3)) { location.reload(); return; } } catch {}
  }
  msg.textContent = '완료 — 앱을 한 번 종료했다가 다시 열어 주세요.';
}
let settings = { ...SETTINGS_DEFAULT };
async function loadSettings() {
  try { settings = { ...SETTINGS_DEFAULT, ...(await api('GET', 'settings')) }; } catch {}
  applyTheme(settings.theme); updateScope();
  if (settings.checkUpdates !== false) checkUpdates(false);
}
const saveSettings = () => api('PUT', 'settings', {}, { settings }).catch(() => toast('설정 저장 실패'));
function searchExts() { // 서버로 보낼 확장자 목록 (빈 문자열 = 제한 없음)
  if (settings.searchAll) return '';
  const fromCats = SEARCH_CATS.filter((c) => settings.searchTypes.includes(c.id)).flatMap((c) => c.exts.split(','));
  const custom = settings.customExts.split(/[\s,]+/).map((e) => e.replace(/^[.*]+/, '')).filter(Boolean);
  return [...new Set([...fromCats, ...custom])].join(',');
}
function scopeLabel() {
  if (settings.searchAll) return '모든 파일';
  const names = SEARCH_CATS.filter((c) => settings.searchTypes.includes(c.id)).map((c) => c.label.split(' ')[0]);
  const extra = settings.customExts.split(/[\s,]+/).filter(Boolean).map((e) => '.' + e.replace(/^[.*]+/, ''));
  const all = [...names, ...extra];
  return all.length ? all.join(' · ') : '모든 파일';
}
function updateScope() {
  const b = $('#ff-scope'); if (!b) return;
  b.textContent = '대상: ' + scopeLabel() + ' ⚙';
  b.title = ($('#ff-glob').value ? '파일 마스크가 입력되어 있어 마스크가 우선 적용됩니다. ' : '') + '검색 대상 파일 형식 설정';
}
function openSettings() {
  let box = $('#settings');
  if (!box) { box = el('div', { id: 'settings' }); document.body.append(box); }
  const row = (checked, label, sub, onchange) => {
    const cb = el('input', { type: 'checkbox', checked }); cb.onchange = () => onchange(cb.checked);
    return el('label', { className: 'st-row' }, cb, el('span', { className: 'st-l', textContent: label }), el('span', { className: 'st-s', textContent: sub || '' }));
  };
  const mk0 = (txt, fn) => { const b = el('button', { textContent: txt }); b.onclick = fn; return b; };
  const verBox = () => { // 현재 버전 + 수동 확인 + 업데이트
    const msg = el('span', { className: 'st-vmsg' });
    const upd = mk0('지금 업데이트', () => applyUpdate(msg)); upd.classList.add('st-upd'); upd.hidden = true;
    const show = (u) => {
      upd.hidden = !u?.available;
      if (!u || (u.latest == null && u.behind == null)) msg.textContent = '확인하지 못했습니다 (네트워크?)';
      else if (u.available) msg.textContent = (u.kind === 'git' ? `main 에 새 커밋 ${u.behind}개` : `새 버전 v${u.latest}`) + ` — 업데이트 방식: ${UPD_LABEL[u.kind] || u.kind}` + (u.dirty ? ' (로컬 변경이 있어 자동 업데이트 불가)' : '');
      else msg.textContent = '최신 버전입니다';
    };
    if (updateInfo) show(updateInfo);
    const chk = el('button', { textContent: '업데이트 확인' }); chk.onclick = async () => { msg.textContent = '확인 중…'; show(await checkUpdates(true)); };
    const rel = el('button', { textContent: '릴리스 페이지' }); rel.onclick = () => window.open(updateInfo?.url || 'https://github.com/AndersonJo/Shooting-Star/releases', '_blank');
    return el('div', { className: 'st-ver' }, el('span', { textContent: `shooting-star v${state.version || '?'}` }), chk, rel, upd, msg);
  };
  const apply = () => { saveSettings(); updateScope(); refreshFilter(); if (ff.built && !$('#find').hidden) runFind(); };
  const draw = () => {
    const all = row(settings.searchAll, '모든 파일', '아래 선택을 무시하고 전체 텍스트 파일 검색', (v) => { settings.searchAll = v; apply(); draw(); });
    const cats = SEARCH_CATS.map((c) => {
      const r = row(settings.searchTypes.includes(c.id), c.label, '.' + c.exts.split(',').join(' .'), (v) => {
        settings.searchTypes = v ? [...new Set([...settings.searchTypes, c.id])] : settings.searchTypes.filter((x) => x !== c.id); apply();
      });
      if (settings.searchAll) r.classList.add('off'); return r;
    });
    const themeGrid = el('div', { className: 'st-themes' }, ...THEMES.map((t) => {
      const [bg, bg2, ac, fg] = t.colors;
      const sw = el('div', { className: 'th-sw' }, el('i'), el('i'), el('i'), el('i'));
      const dots = sw.children;
      if (t.id === 'system') { dots[0].style.background = `linear-gradient(90deg, ${THEME_BY_ID.dark.colors[0]} 50%, ${THEME_BY_ID.light.colors[0]} 50%)`; dots[1].style.background = `linear-gradient(90deg, ${THEME_BY_ID.dark.colors[1]} 50%, ${THEME_BY_ID.light.colors[1]} 50%)`; dots[2].style.background = ac; dots[3].style.background = `linear-gradient(90deg, ${THEME_BY_ID.dark.colors[3]} 50%, ${THEME_BY_ID.light.colors[3]} 50%)`; }
      else { dots[0].style.background = bg; dots[1].style.background = bg2; dots[2].style.background = ac; dots[3].style.background = fg; }
      const card = el('button', { className: 'th-card' + ((settings.theme || 'dark') === t.id ? ' on' : ''), title: t.label }, sw, el('span', { textContent: t.label }));
      card.onclick = () => { settings.theme = t.id; applyTheme(t.id); saveSettings(); draw(); };
      return card;
    }));
    const imgFit = el('div', { className: 'st-radios' }, ...[
      ['fill', '화면에 꽉 채우기 (기본)', '작은 이미지도 창 크기에 맞춰 확대해서 보여줍니다'],
      ['actual', '원본 크기 우선', '이미지가 작으면 그대로, 창보다 크면 줄여서 보여줍니다'],
    ].map(([id, label, sub]) => {
      const r = el('input', { type: 'radio', name: 'imgfit', checked: (settings.imageFit || 'fill') === id });
      r.onchange = () => { settings.imageFit = id; saveSettings(); imgv.cur?.refit(); };   // 열려 있는 이미지에도 바로 적용
      return el('label', { className: 'st-row' }, r, el('span', { className: 'st-l', textContent: label }), el('span', { className: 'st-s', textContent: sub }));
    }));
    const autoOpts = el('div', { className: 'st-radios' }, ...[
      ['1', '입력 멈추고 1초 뒤 저장 (기본)', '창이나 탭을 벗어날 때, 탭을 닫을 때도 저장합니다'],
      ['3', '입력 멈추고 3초 뒤 저장', '조금 더 느긋하게 (파일 변경 감시 도구가 자주 반응하는 경우)'],
      ['off', '끄기', '⌘/Ctrl+S 로만 저장합니다'],
    ].map(([id, label, sub]) => {
      const r = el('input', { type: 'radio', name: 'autosave', checked: (settings.autoSave || '1') === id });
      r.onchange = () => { settings.autoSave = id; saveSettings(); if (id !== 'off') flushAll(); };
      return el('label', { className: 'st-row' }, r, el('span', { className: 'st-l', textContent: label }), el('span', { className: 'st-s', textContent: sub }));
    }));
    const root = el('input', { className: 'st-custom', placeholder: '~/projects', value: settings.defaultRoot || '', spellcheck: false });
    root.oninput = () => { settings.defaultRoot = root.value.trim(); clearTimeout(root._t); root._t = setTimeout(saveSettings, 400); };
    const custom = el('input', { className: 'st-custom', placeholder: '추가 확장자 (예: env, proto, tf)', value: settings.customExts, spellcheck: false });
    custom.oninput = () => { settings.customExts = custom.value; clearTimeout(custom._t); custom._t = setTimeout(apply, 300); };
    const close = el('button', { textContent: '닫기', className: 'st-close' }); close.onclick = () => { box.hidden = true; };
    const reset = el('button', { textContent: '기본값 (' + SEARCH_CATS.filter((c) => SETTINGS_DEFAULT.searchTypes.includes(c.id)).map((c) => c.label.split(' ')[0]).join(' · ') + ')', className: 'st-reset' });
    reset.onclick = () => { settings = { ...settings, ...SETTINGS_DEFAULT }; apply(); draw(); };
    box.replaceChildren(
      el('div', { className: 'st-h', textContent: '설정' }),
      el('div', { className: 'st-sec', textContent: '테마' }), themeGrid,
      el('div', { className: 'st-sec', textContent: '이미지 보기 (⌘/Ctrl +/- 는 이미지 확대/축소)' }), imgFit,
      el('div', { className: 'st-sec', textContent: '자동 저장 (외부에서 수정된 파일은 덮어쓰지 않습니다 · 메모는 항상 자동 저장)' }), autoOpts,
      el('div', { className: 'st-sec', textContent: '기본 프로젝트 위치 (마지막으로 연 폴더가 없을 때 여기서 시작, 비우면 ~/projects)' }), root,
      el('div', { className: 'st-sec', textContent: '내용 검색 (⌘/Ctrl+Shift+F) 대상 파일 형식' }),
      all, el('div', { className: 'st-grid' }, ...cats), custom,
      el('div', { className: 'st-note', textContent: '파일 마스크를 직접 입력하면 마스크가 우선합니다. 파일 이름 검색(Shift×2)은 항상 모든 파일을 대상으로 합니다.' }),
      el('div', { className: 'st-sec', textContent: '버전 / 업데이트' }), verBox(),
      el('div', { className: 'st-sec', textContent: 'Git' }),
      row(settings.gitMarks !== false, '트리에 git 변경 표시', '변경된 파일/폴더에 색과 표시 (끄면 git 상태를 미리 읽지 않음)', (v) => { settings.gitMarks = v; saveSettings(); if (v) loadGit(); else computeGitMarks(); }),
      row(settings.checkUpdates !== false, '시작할 때 업데이트 자동 확인', 'GitHub 에 최신 버전 조회 요청 1건 (끄면 요청 없음)', (v) => { settings.checkUpdates = v; saveSettings(); if (!v) $('#st-update').hidden = true; }),
      el('div', { className: 'st-foot' }, reset, close));
  };
  draw(); box.hidden = false;
}
document.addEventListener('mousedown', (e) => { const s = $('#settings'); if (s && !s.hidden && !e.target.closest('#settings') && !e.target.closest('#btn-settings') && !e.target.closest('#ff-scope')) s.hidden = true; });
$('#btn-settings').onclick = () => { const s = $('#settings'); s && !s.hidden ? (s.hidden = true) : openSettings(); };

// ───────── Find in Files (⌘/Ctrl+Shift+F) ─────────
const ff = { items: [], sel: -1, ctl: null, timer: 0, built: false, opts: store.get('ffopts', { case: false, word: false, regex: false }), cache: { path: '', text: '' } };
function buildFind() {
  if (ff.built) return; ff.built = true;
  const tg = (key, label, title) => { // 옵션 토글 버튼
    const b = el('button', { textContent: label, title, className: 'tg' + (ff.opts[key] ? ' on' : '') });
    b.onclick = () => { ff.opts[key] = !ff.opts[key]; b.classList.toggle('on', ff.opts[key]); store.set('ffopts', ff.opts); runFind(); $('#ff-q').focus(); };
    return b;
  };
  const close = el('button', { textContent: '✕', title: '닫기 (Esc)', className: 'ff-x' }); close.onclick = closeFind;
  const panel = el('div', { id: 'find', hidden: true },
    el('div', { className: 'ff-head' },
      el('input', { id: 'ff-q', placeholder: '전체 파일에서 찾기…', autocomplete: 'off', spellcheck: false }),
      tg('case', 'Cc', '대소문자 구분'), tg('word', 'W', '단어 단위'), tg('regex', '.*', '정규식'),
      el('input', { id: 'ff-glob', placeholder: '파일 마스크 (*.py, *.md)', autocomplete: 'off', spellcheck: false }),
      el('button', { id: 'ff-scope', onclick: openSettings }),
      el('div', { id: 'ff-where', title: '검색 범위: 전체 | 트리에서 선택한 폴더' },
        el('button', { id: 'ff-all', textContent: '전체' }), el('button', { id: 'ff-dir' })), close),
    el('div', { id: 'ff-sum' }),
    el('div', { className: 'ff-body' }, el('div', { id: 'ff-list' }), el('div', { id: 'ff-prev' })));
  document.body.append(panel);
  const q = $('#ff-q'), g = $('#ff-glob');
  g.value = store.get('ffglob', ''); updateScope();
  q.oninput = () => { clearTimeout(ff.timer); ff.timer = setTimeout(runFind, 200); };
  g.oninput = () => { store.set('ffglob', g.value); updateScope(); clearTimeout(ff.timer); ff.timer = setTimeout(runFind, 300); };
  const keys = (e) => {
    if (e.key === 'Escape') closeFind();
    else if (e.key === 'ArrowDown') { e.preventDefault(); selectHit(Math.min(ff.sel + 1, ff.items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectHit(Math.max(ff.sel - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (ff.sel >= 0) openHit(ff.sel); else { clearTimeout(ff.timer); runFind(); } }
  };
  q.onkeydown = g.onkeydown = keys;
  $('#ff-all').onclick = () => { store.set('ffInDir', false); setFindScope(false); }; $('#ff-dir').onclick = () => { store.set('ffInDir', true); setFindScope(true); };
  document.addEventListener('mousedown', (e) => { if (!panel.hidden && !e.target.closest('#find') && !e.target.closest('#settings')) closeFind(); });
}
// 검색 범위: 전체 | 선택한 폴더 (폴더가 없으면 전체)
function setFindScope(inDir, run = true) {
  ff.inDir = inDir && !!ff.dir;
  $('#ff-all').classList.toggle('on', !ff.inDir); $('#ff-dir').classList.toggle('on', ff.inDir);
  $('#ff-dir').textContent = '📁 ' + (ff.dir ? ff.dir.split('/').pop() : '선택한 폴더'); $('#ff-dir').title = ff.dir || '트리에서 폴더를 선택하세요';
  $('#ff-dir').disabled = !ff.dir; $('#ff-q').placeholder = ff.inDir ? ff.dir + ' 안에서 찾기…' : '전체 파일에서 찾기…';
  if (run) { runFind(); $('#ff-q').focus(); }
}
function openFind() {
  buildFind();
  ff.dir = dirOfSel(); setFindScope(store.get('ffInDir', false), false);
  const ta = $('textarea.editor'); let sel = '';
  if (ta && ta.selectionEnd > ta.selectionStart) sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  else sel = String(getSelection());
  const q = $('#ff-q');
  if (sel && !sel.includes('\n') && sel.length < 200) q.value = sel; else if (!q.value) q.value = store.get('ffq', '');
  $('#find').hidden = false; q.focus(); q.select();
  if (q.value) runFind();
}
const closeFind = () => { if (ff.built) { $('#find').hidden = true; ff.ctl?.abort(); } };
async function runFind() {
  const q = $('#ff-q').value; store.set('ffq', q);
  ff.ctl?.abort(); const ctl = (ff.ctl = new AbortController());
  const sum = $('#ff-sum');
  if (!q) { $('#ff-list').replaceChildren(); $('#ff-prev').replaceChildren(); ff.items = []; ff.sel = -1; sum.textContent = ''; return; }
  sum.className = ''; sum.textContent = '검색 중…'; const t0 = performance.now();
  try {
    const r = await api('GET', 'search', { q, dir: ff.inDir ? ff.dir : '', glob: $('#ff-glob').value, exts: searchExts(), case: +ff.opts.case, word: +ff.opts.word, regex: +ff.opts.regex }, null, ctl.signal);
    renderFind(r, performance.now() - t0);
  } catch (e) {
    if (e.name === 'AbortError') return;
    ff.items = []; $('#ff-list').replaceChildren(); sum.className = 'err'; sum.textContent = e.message;
  }
}
function marked_(text, ranges, shift = 0) { // 일치 구간을 <mark> 로 감싼 DocumentFragment
  const f = document.createDocumentFragment(); let p = 0;
  for (const [s0, e0] of ranges) {
    const s = Math.max(s0 - shift, p), e = e0 - shift; if (e <= s) continue;
    f.append(text.slice(p, s), el('mark', { textContent: text.slice(s, e) })); p = e;
  }
  f.append(text.slice(p)); return f;
}
function renderFind(r, ms) {
  ff.items = []; ff.sel = -1; const list = $('#ff-list'); const frag = document.createDocumentFragment();
  for (const file of r.results) {
    const b0 = file.path.lastIndexOf('/') + 1, kind = kindOf(file.path);
    frag.append(el('div', { className: 'ff-file' },
      el('span', { className: 'ico k-' + kind, textContent: ICON[kind] }),
      el('span', { className: 'pn', textContent: file.path.slice(b0) }),
      el('span', { className: 'pd', textContent: file.path.slice(0, Math.max(b0 - 1, 0)) }),
      el('span', { className: 'cnt', textContent: file.matches.length })));
    for (const h of file.matches) {
      if (!h.ranges.length) continue;
      const idx = ff.items.push({ path: file.path, line: h.line, col: h.ranges[0][0] + (h.off || 0), len: h.ranges[0][1] - h.ranges[0][0] }) - 1;
      const lead = h.text.length - h.text.trimStart().length; // 앞 공백 제거해서 보여줌
      const row = el('div', { className: 'ff-hit' }, el('span', { className: 'ln', textContent: h.line }),
        el('span', { className: 'tx' }, marked_(h.text.slice(lead), h.ranges, lead)));
      row.dataset.i = idx; row.onclick = () => selectHit(idx); row.ondblclick = () => openHit(idx);
      frag.append(row);
    }
  }
  list.replaceChildren(frag);
  const sum = $('#ff-sum'); sum.className = '';
  sum.textContent = r.matches ? `${r.matches.toLocaleString()}개 일치 · ${r.files.toLocaleString()}개 파일${r.truncated ? ' (처음 일부만 표시 — 검색어를 좁혀 보세요)' : ''} · ${Math.round(ms)}ms` : '결과 없음';
  $('#ff-prev').replaceChildren();
  if (ff.items.length) selectHit(0);
}
// 색칠된 HTML 을 줄 단위로 나눈다. 여러 줄에 걸친 <span>(문자열 등)은 줄마다 닫고 다시 열어 짝을 맞춘다.
function splitHtmlLines(html) {
  const out = []; let cur = ''; const open = [];
  for (const m of html.match(/<span class="[^"]*">|<\/span>|\n|[^<\n]+/g) || []) {
    if (m === '\n') { out.push(cur + '</span>'.repeat(open.length)); cur = open.join(''); }
    else if (m.startsWith('<span')) { open.push(m); cur += m; }
    else if (m === '</span>') { open.pop(); cur += m; }
    else cur += m;
  }
  out.push(cur + '</span>'.repeat(open.length));
  return out;
}
async function selectHit(i) {
  if (i < 0 || !ff.items[i]) return; ff.sel = i; const it = ff.items[i];
  document.querySelectorAll('#ff-list .ff-hit.sel').forEach((n) => n.classList.remove('sel'));
  const row = $(`#ff-list .ff-hit[data-i="${i}"]`); row?.classList.add('sel'); row?.scrollIntoView({ block: 'nearest' });
  // 미리보기: 일치 줄 주변 ±N줄
  try {
    if (ff.cache.path !== it.path) ff.cache = { path: it.path, text: (await api('GET', 'file', { path: it.path })).content };
    if (ff.sel !== i) return;
    const lines = ff.cache.text.split('\n'), from = Math.max(0, it.line - 1 - 10), to = Math.min(lines.length, it.line - 1 + 16);
    const slice = lines.slice(from, to).join('\n'), lang = langOf(it.path);
    const html = lang ? highlight(lang, slice) : slice.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const pv = el('div', { className: 'ff-pv' });
    splitHtmlLines(html).forEach((h, k) => { // 한 줄 = (번호 + 줄바꿈되는 내용): 긴 줄도 잘리지 않고 번호/강조가 어긋나지 않는다
      const n = from + k + 1, text = el('span', { className: 'pt' }); text.innerHTML = h || ' ';
      pv.append(el('div', { className: 'pl' + (n === it.line ? ' cur' : '') }, el('span', { className: 'pnum', textContent: n }), text));
    });
    $('#ff-prev').replaceChildren(el('div', { className: 'ff-pv-h', textContent: it.path }), pv);
    pv.querySelector('.cur')?.scrollIntoView({ block: 'center' });
  } catch { $('#ff-prev').replaceChildren(el('div', { className: 'ff-pv-h', textContent: '미리보기를 불러올 수 없습니다' })); }
}
function openHit(i) {
  const it = ff.items[i]; if (!it) return;
  closeFind(); openFile(it.path, undefined, { line: it.line, col: it.col, len: it.len });
}

// ───────── 메모 (~/.shooting-star/memos/*.md) ─────────
const isMemo = (p) => typeof p === 'string' && p.startsWith('@memo/');
const mdPlain = (t) => t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();   // 이미지/링크 문법은 제목에서 제외
const memoTitle = (text) => mdPlain(((text || '').split('\n').map((l) => l.trim()).find(Boolean) || '').replace(/^#+\s*/, ''));
const pad2 = (n) => String(n).padStart(2, '0');
let memoTimer;
const refreshMemos = () => { if (state.view !== 'memo') return; clearTimeout(memoTimer); memoTimer = setTimeout(loadMemos, 150); };
async function loadMemos() {
  const q = $('#memo-q').value.trim(); let list = [];
  try { list = await api('GET', 'memos', { q }); } catch {}
  const box = $('#memo-list');
  if (!list.length) { box.replaceChildren(el('div', { className: 'memo-empty', textContent: q ? '일치하는 메모가 없습니다' : '＋ 를 눌러 첫 메모를 만드세요' })); return; }
  box.replaceChildren(...list.map((m) => {
    const p = '@memo/' + m.name, open = tabOf(p), d = new Date(m.mtime);
    const x = el('span', { className: 'mx', textContent: '✕', title: '메모 삭제' });
    x.onclick = (e) => { e.stopPropagation(); deleteMemo(m.name, open ? memoTitle(open.content) : m.title); };
    const when = `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const row = el('div', { className: 'memo' + (state.active === p ? ' sel' : ''), title: m.name },
      el('div', { className: 'mt', textContent: (open ? memoTitle(open.content) : m.title) || '제목 없음' }),   // 열려 있으면 저장 전 제목도 반영
      el('div', { className: 'mm', textContent: when + (m.snippet ? ' · ' + m.snippet : '') }), x);
    row.onclick = () => openFile(p);
    return row;
  }));
}
async function newMemo() {
  setView('memo', true);
  const d = new Date(), name = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.md`, p = '@memo/' + name;
  try {
    await api('POST', 'create', { path: p }, { dir: false });
    await api('PUT', 'file', { path: p }, { content: '# \n\n' });
    await openFile(p, 'edit', { line: 1, col: 2, len: 0 });   // 제목 줄 끝에 커서
    loadMemos();
  } catch (e) { toast('메모 생성 실패: ' + e.message); }
}
async function deleteMemo(name, title) {
  if (!confirm(`메모를 삭제할까요? (되돌릴 수 없음)\n${title || name}`)) return;
  const p = '@memo/' + name;
  try {
    await api('DELETE', 'file', { path: p });
    const t = tabOf(p); if (t) { t.content = t.orig; closeTab(p); }
    loadMemos();
  } catch (e) { toast(e.message); }
}
$('#btn-memo-new').onclick = newMemo;
$('#memo-q').oninput = refreshMemos;


// ───────── Git: 작업 폴더 안의 repo 별 변경 파일 → 커밋 / 푸시 ─────────
const gitUi = { repos: [], expanded: new Set(), off: new Map(), msg: new Map(), busy: new Set(), err: new Map(), loaded: false };   // off: repo → 체크 해제한 파일들
let gitTimer, gitSeq = 0;
const gitWanted = () => state.view === 'git' || settings.gitMarks !== false;   // 트리 색 표시가 켜져 있으면 git 보기가 아니어도 상태를 읽는다
const refreshGit = () => { if (!gitWanted()) return; clearTimeout(gitTimer); gitTimer = setTimeout(loadGit, 600); };
// 트리 표시용: 변경된 파일(경로 → M/A/U) 과 변경이 들어 있는 폴더
let gitMarks = { files: new Map(), dirs: new Map(), sig: '' };
function computeGitMarks() {
  const files = new Map(), dirs = new Map();
  if (settings.gitMarks !== false) for (const r of gitUi.repos) for (const f of r.files) {
    if (!f.rp) continue;
    const k = gitKind(f); if (k === 'D') continue;   // 삭제된 파일은 트리에 없다
    files.set(f.rp, k === 'U' ? 'U' : k === '?' || k === 'A' ? 'A' : 'M');
    for (let i = f.rp.indexOf('/'); i > 0; i = f.rp.indexOf('/', i + 1)) { const d = f.rp.slice(0, i); const cur = dirs.get(d); dirs.set(d, cur === 'U' || files.get(f.rp) === 'U' ? 'U' : 'M'); }
  }
  const sig = JSON.stringify([...files, ...dirs]);
  if (sig === gitMarks.sig) return;
  gitMarks = { files, dirs, sig }; renderTree();
}
async function loadGit() {
  const seq = ++gitSeq; let r;
  try { r = await api('GET', 'git/repos'); } catch (e) { if (seq === gitSeq && state.view === 'git') $('#git-list').replaceChildren(el('div', { className: 'git-empty', textContent: 'Git 정보를 읽지 못했습니다: ' + e.message })); return; }
  if (seq !== gitSeq) return;
  gitUi.repos = r.repos; gitUi.loaded = true; if (state.view === 'git') drawGit(); computeGitMarks();
}
const GIT_LABEL = { M: '수정', A: '추가', D: '삭제', R: '이름 변경', '?': '새 파일', U: '충돌' };
function gitKind(f) {   // 한 글자로 요약: M A D R ? U
  if (f.x === '?' ) return '?';
  if (f.x === 'U' || f.y === 'U' || (f.x === 'A' && f.y === 'A') || (f.x === 'D' && f.y === 'D')) return 'U';
  if (f.x === 'R' || f.x === 'C') return 'R';
  if (f.x === 'D' || f.y === 'D') return 'D';
  if (f.x === 'A') return 'A';
  return 'M';
}
function drawGit() {
  const box = $('#git-list'), repos = gitUi.repos;
  if (!repos.length) { box.replaceChildren(el('div', { className: 'git-empty', textContent: '이 작업 폴더 안에서 git repo 를 찾지 못했습니다.' })); return; }
  const keep = box.scrollTop, focusId = document.activeElement?.dataset?.repo;
  box.replaceChildren(...repos.map(gitRepoView));
  box.scrollTop = keep;
  if (focusId) box.querySelector(`textarea[data-repo="${CSS.escape(focusId)}"]`)?.focus();
}
function gitRepoView(r) {
  const n = r.files.length, key = r.abs, open = gitUi.expanded.has(key) && (n > 0 || r.ahead > 0 || r.behind > 0 || r.error);   // 처음에는 모두 접힌 상태
  const head = el('div', { className: 'gr-head', title: r.abs },
    el('span', { className: 'gr-arrow', textContent: n > 0 || r.ahead > 0 || r.behind > 0 || r.error ? (open ? '▾' : '▸') : '' }),
    el('span', { className: 'gr-name', textContent: r.rel === '' ? r.name + ' (작업 폴더)' : r.rel.startsWith('..') ? r.name : r.rel }),
    el('span', { className: 'gr-br', textContent: r.branch || '' }),
    el('span', { className: 'gr-sp' }),
    r.ahead || r.behind ? el('span', { className: 'gr-sync', title: `원격보다 ${r.ahead} 앞섬 / ${r.behind} 뒤처짐`, textContent: (r.ahead ? '↑' + r.ahead : '') + (r.behind ? ' ↓' + r.behind : '') }) : '',
    n ? el('span', { className: 'gr-badge', textContent: String(n) }) : '');
  head.onclick = () => { if (gitUi.expanded.has(key)) gitUi.expanded.delete(key); else gitUi.expanded.add(key); drawGit(); };
  const wrap = el('div', { className: 'gr' + (n ? '' : ' clean') }, head);
  if (!open) return wrap;
  const body = el('div', { className: 'gr-body' }); wrap.append(body);
  const busy = gitUi.busy.has(key), off = gitUi.off.get(key) || new Set(); gitUi.off.set(key, off);
  if (r.error) body.append(el('div', { className: 'gr-err', textContent: r.error }));
  const liveOff = new Set([...off].filter((p) => r.files.some((f) => f.path === p))), picked = r.files.filter((f) => !liveOff.has(f.path));
  if (n) {
    body.append(el('div', { className: 'gr-sel' },
      Object.assign(el('a', { textContent: '모두 선택' }), { onclick: () => { off.clear(); drawGit(); } }),
      Object.assign(el('a', { textContent: '모두 해제' }), { onclick: () => { r.files.forEach((f) => off.add(f.path)); drawGit(); } }),
      el('span', { textContent: `${picked.length}/${n} 선택` })));
    for (const f of r.files) {
      const k = gitKind(f), cb = el('input', { type: 'checkbox', checked: !off.has(f.path) });
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => { if (cb.checked) off.delete(f.path); else off.add(f.path); drawGit(); };
      const row = el('div', { className: 'gf s-' + k, title: `${GIT_LABEL[k]} — ${f.path}${f.from ? ` (← ${f.from})` : ''}\n클릭: 변경 내용 보기` },
        cb, el('span', { className: 'gf-s', textContent: k }), el('span', { className: 'gf-n' }, el('bdi', { textContent: f.path })));
      row.onclick = () => showGitDiff(r, f);
      body.append(row);
    }
    const ta = el('textarea', { className: 'gr-msg', placeholder: '커밋 메시지  (⌘/Ctrl+Enter: 커밋 & 푸시)', value: gitUi.msg.get(key) || '', spellcheck: false });
    ta.dataset.repo = key; plainInput(ta);
    ta.oninput = () => { gitUi.msg.set(key, ta.value); updBtns(); };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) { e.preventDefault(); gitCommit(r, true); } };
    const mk = (txt, fn, cls = '') => Object.assign(el('button', { textContent: txt, className: cls }), { onclick: fn });
    const bCommit = mk('커밋', () => gitCommit(r, false)), bBoth = mk('커밋 & 푸시', () => gitCommit(r, true), 'pri');
    const updBtns = () => { const ok = !busy && picked.length > 0 && ta.value.trim().length > 0; bCommit.disabled = bBoth.disabled = !ok; };
    updBtns();
    body.append(ta, el('div', { className: 'gr-btns' }, bCommit, bBoth));
  }
  if (!n && (r.ahead > 0 || (!r.upstream && r.hasRemote && !r.error))) {   // 커밋은 끝났고 푸시만 남은 경우
    body.append(el('div', { className: 'gr-note', textContent: r.ahead ? `푸시하지 않은 커밋 ${r.ahead}개` : '원격(upstream)이 아직 없는 브랜치' }),
      el('div', { className: 'gr-btns', style: 'margin-top:6px' }, Object.assign(el('button', { textContent: busy ? '푸시 중…' : '푸시', className: 'pri', disabled: busy }), { onclick: () => gitRun(r, 'push') })));
  }
  if (r.behind > 0) body.append(el('div', { className: 'gr-btns', style: 'margin-top:6px' }, Object.assign(el('button', { textContent: `풀 (↓${r.behind}, fast-forward)`, disabled: busy }), { onclick: () => gitRun(r, 'pull') })));
  if (gitUi.err.get(key)) body.append(el('div', { className: 'gr-err', textContent: gitUi.err.get(key) }));
  return wrap;
}
async function gitRun(r, what) {   // push | pull
  const key = r.abs; gitUi.busy.add(key); gitUi.err.delete(key); drawGit(); setStatus(`${r.name}: ${what === 'push' ? '푸시' : '풀'} 중…`);
  try { await api('POST', 'git/' + what, {}, { repo: r.abs }); toast(`${r.name}: ${what === 'push' ? '푸시 완료' : '풀 완료'}`); setStatus(''); }
  catch (e) { gitUi.err.set(key, e.message); setStatus(`${r.name}: ${what} 실패`, 'err'); }
  gitUi.busy.delete(key); await loadGit();
}
async function gitCommit(r, push) {
  const key = r.abs, off = gitUi.off.get(key) || new Set(), files = r.files.filter((f) => !off.has(f.path)).map((f) => f.path), message = (gitUi.msg.get(key) || '').trim();
  if (!files.length || !message) return;
  if (r.files.some((f) => gitKind(f) === 'U')) { if (!confirm('충돌 상태의 파일이 있습니다. 그래도 커밋할까요?')) return; }
  await flushAll();   // 편집 중인 내용이 먼저 디스크에 저장되도록
  gitUi.busy.add(key); gitUi.err.delete(key); drawGit(); setStatus(`${r.name}: ${push ? '커밋 & 푸시' : '커밋'} 중…`);
  try {
    const res = await api('POST', 'git/commit', {}, { repo: r.abs, files, message, push });
    gitUi.msg.delete(key); gitUi.off.delete(key); setStatus('');
    if (push && !res.pushed) { gitUi.err.set(key, '커밋은 완료, 푸시 실패:\n' + res.pushErr); setStatus(`${r.name}: 푸시 실패`, 'err'); }
    else toast(push ? `${r.name}: 커밋 & 푸시 완료` : `${r.name}: 커밋 완료`);
  } catch (e) { gitUi.err.set(key, e.message); setStatus(`${r.name}: 커밋 실패`, 'err'); }
  gitUi.busy.delete(key); await loadGit();
}
async function showGitDiff(r, f) {   // 본문 영역에 diff 탭으로 연다 (팝업 아님)
  const p = `@diff/${r.abs}/${f.path}`; let t = tabOf(p);
  if (!t) {
    const rel = r.rel.startsWith('..') ? null : (r.rel ? r.rel + '/' : '') + f.path;   // 작업 폴더 기준 경로 (밖이면 null)
    t = { path: p, kind: 'diff', content: '', orig: '', mtime: 0, mode: store.get('diffMode', 'unified'), repo: r.abs, repoName: r.name, file: f.path, rel, diff: null, gone: gitKind(f) === 'D' };
    state.tabs.push(t);
  }
  state.active = p; renderAll();
}
async function loadDiff(t) {
  if (t.loading) return; t.loading = true; t.stale = false;
  try { t.diff = (await api('GET', 'git/diff', { repo: t.repo, file: t.file })).diff; t.err = ''; } catch (e) { t.err = e.message; t.diff = t.diff ?? ''; }
  t.loading = false;
  if (state.tabs.includes(t) && state.active === t.path) { renderToolbar(); renderContent(); }
}
function parseDiff(text) {
  const hunks = []; let h = null, o = 0, n = 0, bin = false, add = 0, del = 0;
  for (const l of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l);
    if (m) { h = { head: l, rows: [] }; hunks.push(h); o = +m[1]; n = +m[2]; continue; }
    if (!h) { if (/^(Binary files|GIT binary patch)/.test(l)) bin = true; continue; }
    if (l[0] === '+') { h.rows.push({ k: 'add', n: n++, s: l.slice(1) }); add++; }
    else if (l[0] === '-') { h.rows.push({ k: 'del', o: o++, s: l.slice(1) }); del++; }
    else if (l[0] === ' ') h.rows.push({ k: 'ctx', o: o++, n: n++, s: l.slice(1) });   // '\ No newline…' 줄은 무시
  }
  return { hunks, bin, add, del };
}
function diffView(t) {
  const box = el('div', { className: 'dvbox' });
  if (t.diff === null || t.stale) { loadDiff(t); if (t.diff === null) { box.append(el('div', { className: 'dv-msg', textContent: '불러오는 중…' })); return box; } }
  if (t.err) { box.append(el('div', { className: 'dv-msg err', textContent: t.err })); return box; }
  const d = parseDiff(t.diff); t.stat = d.add || d.del ? `+${d.add} −${d.del}` : '';
  if (!d.hunks.length) { box.append(el('div', { className: 'dv-msg', textContent: d.bin ? '바이너리 파일이라 변경 내용을 표시할 수 없습니다.' : '변경 내용이 없습니다. (이미 커밋되었거나 되돌려졌을 수 있습니다)' })); return box; }
  box.append(diffTable(d, t.mode)); return box;
}
function diffTable(d, mode) {   // parseDiff 결과 → 표 (통합 / 나란히)
  const split = mode === 'split', td = (cls, text) => el('td', { className: cls, textContent: text ?? '' });
  const tbl = el('table', { className: 'dv ' + (split ? 'sp' : 'un') });
  tbl.append(el('colgroup', {}, ...(split ? ['ln', 'cd', 'ln', 'cd'] : ['ln', 'ln', 'sg', 'cd']).map((c) => el('col', { className: c }))));
  for (const h of d.hunks) {
    tbl.append(el('tr', { className: 'hh' }, Object.assign(td('', h.head), { colSpan: 4 })));
    if (!split) {
      for (const r of h.rows) tbl.append(el('tr', { className: r.k }, td('ln', r.o), td('ln', r.n), td('sg', r.k === 'add' ? '+' : r.k === 'del' ? '−' : ''), td('cd', r.s || ' ')));
      continue;
    }
    for (let i = 0; i < h.rows.length;) {   // 나란히: 연속된 삭제/추가 묶음을 같은 줄에 짝지어 놓는다
      const r = h.rows[i];
      if (r.k === 'ctx') { tbl.append(el('tr', { className: 'ctx' }, td('ln', r.o), td('cd', r.s || ' '), td('ln', r.n), td('cd', r.s || ' '))); i++; continue; }
      const dels = [], adds = [];
      while (h.rows[i]?.k === 'del') dels.push(h.rows[i++]);
      while (h.rows[i]?.k === 'add') adds.push(h.rows[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const a = dels[k], b = adds[k];
        tbl.append(el('tr', {}, td('ln' + (a ? ' del' : ' none'), a?.o), td('cd' + (a ? ' del' : ' none'), a ? a.s || ' ' : ''), td('ln' + (b ? ' add' : ' none'), b?.n), td('cd' + (b ? ' add' : ' none'), b ? b.s || ' ' : '')));
      }
    }
  }
  return tbl;
}
$('#btn-git-refresh').onclick = loadGit;

// ───────── Git 히스토리 · Blame · 원격(GitHub) 링크 ─────────
// 우클릭 → Git ▸ : 저장소 전체 / 이 파일·폴더 / 선택한 줄 히스토리, Blame, GitHub 에서 열기·링크 복사
const HIST_PAGE = 100;
const TEXT_KINDS = ['md', 'json', 'yaml', 'csv', 'jsonl', 'text'];
const gitable = (t) => !!t && (TEXT_KINDS.includes(t.kind) || t.kind === 'image') && !isMemo(t.path) && !isDrop(t.path) && !isGal(t.path);
const webByRepo = new Map();   // repo 절대경로 → 원격 웹 정보 (메뉴에 GitHub/GitLab 이름 표시용)
const rememberWeb = (repo) => { if (repo?.abs) webByRepo.set(repo.abs, repo.web || null); };
function webOfPath(p) {
  const abs = p ? absOf(p) : state.root; let best = null, len = -1;
  for (const [r, w] of webByRepo) if ((abs === r || abs.startsWith(r + '/')) && r.length > len) { best = w; len = r.length; }
  return best;
}
const webName = (w) => ({ gitlab: 'GitLab', bitbucket: 'Bitbucket' })[w?.kind] || 'GitHub';
function webUrl(w, what, o = {}) { // 원격 웹 주소 (GitHub 기본, GitLab · Bitbucket)
  if (!w) return '';
  const b = w.base, gl = w.kind === 'gitlab', bb = w.kind === 'bitbucket', enc = (s) => String(s).split('/').map(encodeURIComponent).join('/');
  const ref = o.ref ? enc(o.ref) : '';
  switch (what) {
    case 'commit': return gl ? `${b}/-/commit/${o.sha}` : bb ? `${b}/commits/${o.sha}` : `${b}/commit/${o.sha}`;
    case 'pr': return gl ? `${b}/-/merge_requests/${o.n}` : bb ? `${b}/pull-requests/${o.n}` : `${b}/pull/${o.n}`;
    case 'branch': return gl ? `${b}/-/tree/${enc(o.name)}` : bb ? `${b}/branch/${enc(o.name)}` : `${b}/tree/${enc(o.name)}`;
    case 'tag': return gl ? `${b}/-/tags/${enc(o.name)}` : bb ? `${b}/src/${enc(o.name)}` : `${b}/releases/tag/${enc(o.name)}`;
    case 'history': return gl ? `${b}/-/commits/${ref}${o.path ? '/' + enc(o.path) : ''}` : bb ? `${b}/commits/branch/${ref}` : `${b}/commits/${ref}${o.path ? '/' + enc(o.path) : ''}`;
    case 'tree': return (gl ? `${b}/-/tree/${ref}` : bb ? `${b}/src/${ref}` : `${b}/tree/${ref}`) + (o.path ? '/' + enc(o.path) : '');
    case 'blob': {
      let u = (gl ? `${b}/-/blob/${ref}/` : bb ? `${b}/src/${ref}/` : `${b}/blob/${ref}/`) + enc(o.path);
      if (o.a) {
        const two = o.b && o.b !== o.a;
        if (!bb && /\.(md|markdown|mdx|rst|adoc|org|ipynb|csv|tsv|svg|geojson)$/i.test(o.path)) u += '?plain=1';   // 렌더링되는 파일은 원문 보기여야 줄 위치로 간다
        u += gl ? `#L${o.a}${two ? '-' + o.b : ''}` : bb ? `#lines-${o.a}${two ? ':' + o.b : ''}` : `#L${o.a}${two ? '-L' + o.b : ''}`;
      }
      return u;
    }
  }
  return b;
}
const openUrl = (url) => api('POST', 'open-url', {}, { url }).catch(() => window.open(url, '_blank'));   // 응답을 기다린 뒤 여는 경우 (팝업 차단을 피해 서버가 기본 브라우저로 연다)
const aLink = (label, url, cls = '') => el('a', { className: 'hv-a ' + cls, href: url, target: '_blank', rel: 'noopener noreferrer', textContent: label, title: url });
const chipBtn = (label, title, fn, cls = '') => Object.assign(el('button', { className: 'hv-chip ' + cls, textContent: label, title }), { onclick: fn });
async function copyLater(job, label) { // 클릭 직후 클립보드 쓰기를 예약한다 (Safari/WKWebView 는 await 뒤의 복사를 막는다)
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': job.then((s) => new Blob([s], { type: 'text/plain' })) })]);
      toast(label); return;
    }
  } catch {}
  try { copy(await job, label); } catch (e) { toast(e.message); }
}
function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return '방금'; if (d < 3600) return `${Math.floor(d / 60)}분 전`; if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  if (d < 172800) return '어제'; if (d < 86400 * 30) return `${Math.floor(d / 86400)}일 전`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)}달 전`; return `${Math.floor(d / 86400 / 365)}년 전`;
}
const fmtDate = (sec) => new Date(sec * 1000).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

// ── 우클릭 메뉴 ──
function gitMenu({ path: p, isDir, range: r }) {
  const file = !isDir, w = webName(webOfPath(p)), t = tabOf(p), text = file && kindOf(p) !== 'image' && !isEnc(p);
  if (!text) r = null;
  const lr = r && (r.a === r.b ? `${r.a}줄` : `${r.a}–${r.b}줄`);
  const items = [
    ['저장소 전체 히스토리', () => openHistory({ path: p, scope: 'repo' })],
    file ? ['이 파일 히스토리', () => openHistory({ path: p, scope: 'file' })] : p ? ['이 폴더 히스토리', () => openHistory({ path: p, scope: 'dir' })] : null,
    r ? [`${r.sel ? '선택한 부분' : r.a === r.b ? '이 줄' : '이 블록'} 히스토리 (${lr})`, () => openHistory({ path: p, scope: 'lines', a: r.a, b: r.b })] : null,
  ];
  if (text) items.push('-', [t?.blame ? 'Blame 끄기' : 'Blame 보기 (줄마다 마지막 커밋)', () => toggleBlame(p)]);
  items.push('-', [`${w}에서 ${file ? '파일' : '폴더'} 열기`, () => openRemote(p, { isDir })]);
  if (r) items.push([`${w}에서 이 줄 열기 (${lr})`, () => openRemote(p, { a: r.a, b: r.b })]);
  items.push([`${w} 링크 복사${r ? ` (${lr})` : ''}`, () => openRemote(p, { isDir, a: r?.a, b: r?.b, copy: true })]);
  return items.filter(Boolean).map((x) => (x === '-' ? ['-'] : x));
}
async function openRemote(p, { isDir, a, b, copy: cp } = {}) { // 원격 웹에서 파일/폴더/줄 열기 (HEAD 가 올라가 있으면 커밋 고정 주소)
  const t = tabOf(p), content = a && t && TEXT_KINDS.includes(t.kind) ? t.content : undefined;
  const job = api('POST', 'git/permalink', { path: p }, { a, b, content })
    .then((r) => ({ url: webUrl(r.web, r.isDir ? 'tree' : 'blob', { ref: r.ref, path: r.rel, a: r.a, b: r.b }), note: r.note }));
  if (cp) return copyLater(job.then((x) => { if (x.note) setTimeout(() => toast(x.note), 1600); return x.url; }), '링크 복사됨');
  try { const x = await job; openUrl(x.url); toast(x.note || `${webName(webOfPath(p))} 에서 엽니다`); } catch (e) { toast(e.message); }
}
// 편집기에서 실행할 잘라내기/복사/붙여넣기/전체 선택 (앱에서는 네이티브 편집 명령으로)
function editCmd(ta, cmd) {
  ta.focus();
  const native = window.webkit?.messageHandlers?.edit;
  if (cmd === 'selectAll') { ta.select(); return; }
  if (cmd === 'paste') {
    if (native) { native.postMessage('paste'); return; }
    navigator.clipboard?.readText?.().then((s) => { if (s) { ta.focus(); document.execCommand('insertText', false, s); } }, () => toast('붙여넣기는 ⌘/Ctrl+V 를 쓰세요 (클립보드 읽기가 막혀 있음)'));
    return;
  }
  if (!document.execCommand(cmd) && native) native.postMessage(cmd);
}
// 줄 범위 (1부터): 편집기 선택 / 마크다운 보기의 블록·선택 / 스마트 편집 블록 / Blame 화면
function taRange(ta) {
  const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd, line = (i) => v.slice(0, i).split('\n').length;
  const la = line(a); let lb = line(b);
  if (b > a && v[b - 1] === '\n') lb--;   // 줄 전체를 선택하면 다음 줄 첫 칸까지 잡힌다
  return { a: la, b: Math.max(la, lb), sel: b > a && v.slice(a, b).includes('\n') };
}
function mdBlockLines(text) { // 마크다운 최상위 블록(공백 제외) → 원문 줄 범위. 미리보기의 최상위 요소와 순서가 같다
  let line = 1; const out = [];
  for (const tk of marked.lexer(text.replace(/\r\n/g, '\n'))) {
    if (tk.type !== 'space') out.push({ a: line, b: line + tk.raw.replace(/\s+$/, '').split('\n').length - 1 });
    line += tk.raw.split('\n').length - 1;
  }
  return out;
}
const selNodes = (root, target) => { const s = getSelection(); return s.rangeCount && !s.isCollapsed && root.contains(s.anchorNode) && root.contains(s.focusNode) ? { nodes: [s.anchorNode, s.focusNode], sel: true } : { nodes: [target], sel: false }; };
function previewRange(pv, t, target) {
  const root = pv.querySelector(':scope > .md'); if (!root || t.kind !== 'md') return null;
  const blocks = mdBlockLines(t.content), kids = [...root.children]; if (blocks.length !== kids.length) return null;   // 원시 HTML 등으로 블록과 요소가 맞지 않음
  const { nodes, sel } = selNodes(root, target);
  const ix = nodes.map((n) => { while (n && n.parentNode !== root) n = n.parentNode; return kids.indexOf(n); }).filter((i) => i >= 0);
  if (!ix.length) return null;
  const a = blocks[Math.min(...ix)].a, b = blocks[Math.max(...ix)].b;
  return { a, b, sel };
}
function smartRange(doc, target) {
  const L = doc?._blockLines?.(); if (!L) return null;
  const ta = target.closest?.('.sb-ta');
  if (ta) { const base = L[+ta.closest('.sb')?.dataset.i]; if (!base) return null; const r = taRange(ta); return { a: base.a + r.a - 1, b: base.a + r.b - 1, sel: r.sel }; }
  const { nodes, sel } = selNodes(doc, target);
  const ix = nodes.map((n) => (n.nodeType === 1 ? n : n.parentElement)?.closest('.sb')).filter(Boolean).map((e) => +e.dataset.i).filter((i) => L[i]);
  if (!ix.length) return null;
  return { a: L[Math.min(...ix)].a, b: L[Math.max(...ix)].b, sel };
}
function preLine(pre, node, off) { const r = document.createRange(); r.setStart(pre, 0); r.setEnd(node, off); return r.toString().split('\n').length; }
function blameRange(box, e) {
  const pre = box.querySelector('.bl-code'); if (!pre) return null;
  const s = getSelection();
  if (s.rangeCount && !s.isCollapsed && pre.contains(s.anchorNode) && pre.contains(s.focusNode)) {
    const x = preLine(pre, s.anchorNode, s.anchorOffset), y = preLine(pre, s.focusNode, s.focusOffset);
    return { a: Math.min(x, y), b: Math.max(x, y), sel: x !== y };
  }
  const L = blameLineAt(pre, e.clientY); return L ? { a: L, b: L, sel: false } : null;
}
$('#content').addEventListener('contextmenu', (e) => {
  const t = cur(); if (!t || !TEXT_KINDS.includes(t.kind)) return;   // 이미지·diff·히스토리·갤러리·실행·SQL 은 각자 처리
  const g = (range) => (gitable(t) ? [['-'], ['Git', null, '', gitMenu({ path: t.path, isDir: false, range })]] : []);
  const ta = e.target.closest('textarea');
  if (ta) {
    e.preventDefault();
    const has = ta.selectionEnd > ta.selectionStart, r = ta.classList.contains('sb-ta') ? smartRange(ta.closest('.smart-doc'), e.target) : taRange(ta);
    showMenu(e.clientX, e.clientY, [
      ['잘라내기', () => editCmd(ta, 'cut'), has ? '' : 'disabled'],
      ['복사', () => editCmd(ta, 'copy'), has ? '' : 'disabled'],
      ['붙여넣기', () => editCmd(ta, 'paste')],
      ['전체 선택', () => editCmd(ta, 'selectAll')],
      ...g(r),
    ]);
    return;
  }
  if (e.target.closest('.bl-gut')) return;   // Blame 줄 정보는 따로
  const blv = e.target.closest('.blv'), smart = e.target.closest('.smart-doc'), pv = e.target.closest('#preview');
  if (!blv && !smart && !pv) return;
  e.preventDefault();
  const r = blv ? blameRange(blv, e) : smart ? smartRange(smart, e.target) : previewRange(pv, t, e.target);
  const sel = String(getSelection()), a = e.target.closest('a[href]');
  showMenu(e.clientX, e.clientY, [
    ...(sel ? [['복사', () => { if (!document.execCommand('copy')) copy(sel); }]] : []),
    ...(a ? [['링크 주소 복사', () => copy(a.href, '링크 복사됨')]] : []),
    ['경로 복사', () => copy(isMemo(t.path) || isExt(t.path) ? absOf(t.path) : t.path, '경로 복사됨')],
    ...(blv ? [['Blame 끄기', () => toggleBlame(t.path)]] : []),
    ...g(r),
  ]);
});

// ── 히스토리 탭 ──
const scopeDesc = (t) => (t.scope === 'repo' ? '저장소 전체' : t.scope === 'dir' ? (t.rel || '.') + '/' : t.scope === 'lines' ? `${t.rel}:${t.range.a}–${t.range.b}` : t.rel);
const histTitle = (t) => `${t.repo.name}: ${scopeDesc(t)} — Git 히스토리`;
const histLabel = (t) => '⏱ ' + (t.scope === 'repo' ? t.repo.name : t.scope === 'dir' ? (t.rel.split('/').pop() || t.repo.name) + '/' : t.rel.split('/').pop() + (t.scope === 'lines' ? `:${t.range.a}–${t.range.b}` : ''));
const histStatus = (t) => `${t.h.q ? `검색 결과 ${t.h.commits.length}개` : `커밋 ${t.h.commits.length}${t.h.more ? '+' : ''}개`} · ${scopeDesc(t)}${t.range && (t.range.ha !== t.range.a || t.range.hb !== t.range.b) ? ` (HEAD 기준 ${t.range.ha}–${t.range.hb}줄)` : ''}`;
async function openHistory(o) { // o: { path, scope: repo|file|dir|lines, a, b, focus }
  const src = tabOf(o.path), content = o.scope === 'lines' && src && TEXT_KINDS.includes(src.kind) ? src.content : undefined;
  setStatus('Git 히스토리 불러오는 중…');
  let r;
  try { r = await api('POST', 'git/log', { path: o.path }, { scope: o.scope, a: o.a, b: o.b, content, n: HIST_PAGE }); }
  catch (e) { setStatus(''); toast(e.message); return; }
  rememberWeb(r.repo);
  const key = `@hist/${r.repo.abs}|${r.scope}|${r.rel}` + (r.range ? `|${r.range.ha}-${r.range.hb}@${r.range.head.slice(0, 12)}` : '');
  let t = tabOf(key);
  if (!t) {
    t = { path: key, kind: 'history', content: '', orig: '', mtime: 0, mode: store.get('diffMode', 'unified'), src: o.path, scope: r.scope, repo: r.repo, rel: r.rel, range: r.range || null,
      h: { commits: r.commits, more: r.more, note: r.note || '', sel: null, q: '', filter: '', base: null, full: false, details: new Map() } };
    state.tabs.push(t);
  } else Object.assign(t.h, { commits: r.commits, more: r.more, q: '', base: null, details: new Map() });
  t.h.sel = o.focus || r.commits[0]?.h || null;
  flushAll(); state.active = key; persistTabs(); renderAll(); setStatus(histStatus(t));
  if (o.focus && !t.h.commits.some((c) => c.h === o.focus)) {   // blame 에서 고른 커밋이 첫 쪽에 없으면 몇 쪽 더 읽어 목록에서도 보이게
    for (let i = 0; i < 8 && t.h.more && !t.h.commits.some((c) => c.h === o.focus); i++) await histMore(t);
    histSelect(t, o.focus);
  }
}
async function histReload(t) {
  const H = t.h, src = tabOf(t.src);
  try {
    const r = await api('POST', 'git/log', { path: t.src }, { scope: t.scope, n: HIST_PAGE, ...(t.range ? { a: t.range.a, b: t.range.b, content: src && TEXT_KINDS.includes(src.kind) ? src.content : undefined } : {}) });
    t.repo = r.repo; rememberWeb(r.repo); if (r.range) t.range = r.range;
    Object.assign(H, { commits: r.commits, more: r.more, q: '', base: null, details: new Map() });
    for (const k of [...refsMemo.keys()]) if (k.startsWith(t.repo.abs + ':')) refsMemo.delete(k);
    if (!H.commits.some((c) => c.h === H.sel)) H.sel = H.commits[0]?.h || null;
    toast('다시 불러옴');
  } catch (e) { toast(e.message); }
  if (H.filterEl) H.filterEl.value = H.filter;
  drawHistList(t); drawHistDetail(t); if (state.active === t.path) { renderTabs(); renderToolbar(); validate(); }
}
async function histMore(t) {
  const H = t.h; if (H.loading || !H.more || H.q) return; H.loading = true; drawHistInfo(t);
  try {
    const r = await api('POST', 'git/log', { path: t.src }, { scope: t.scope, skip: H.commits.length, n: HIST_PAGE, ...(t.range ? { a: t.range.a, b: t.range.b, ha: t.range.ha, hb: t.range.hb, head: t.range.head } : {}) });
    const seen = new Set(H.commits.map((c) => c.h)); H.commits.push(...r.commits.filter((c) => !seen.has(c.h))); H.more = r.more;
  } catch (e) { toast(e.message); H.more = false; }
  H.loading = false; drawHistList(t); if (state.active === t.path) validate();
}
async function histSearch(t, q) { // 전체 기록에서 메시지·작성자·해시로 찾기
  const H = t.h; q = q.trim();
  if (!q) { if (H.q) { Object.assign(H, { commits: H.base.commits, more: H.base.more, q: '', base: null }); drawHistList(t); validate(); } return; }
  H.info.textContent = `"${q}" 찾는 중…`;
  try {
    const r = await api('POST', 'git/log', { path: t.src }, { scope: t.scope === 'lines' ? 'file' : t.scope, q });
    if (!H.q) H.base = { commits: H.commits, more: H.more };
    Object.assign(H, { commits: r.commits, more: false, q });
    if (r.commits[0] && !r.commits.some((c) => c.h === H.sel)) { H.sel = r.commits[0].h; drawHistDetail(t); }
  } catch (e) { toast(e.message); }
  drawHistList(t); validate();
}
function historyView(t) {
  const H = t.h; if (H.dom) return H.dom;
  const filter = el('input', { className: 'hv-filter', placeholder: '필터 · Enter: 전체 기록에서 메시지/작성자/해시 찾기', value: H.filter });
  const info = el('div', { className: 'hv-info' }), list = el('div', { className: 'hv-items', tabIndex: 0 });
  const left = el('div', { className: 'hv-list' }, filter, info, list), detail = el('div', { className: 'hv-detail' });
  const split = el('div', { className: 'hv-split', title: '끌어서 높이 조절' });
  left.style.height = store.get('histH', 260) + 'px';
  Object.assign(H, { dom: el('div', { className: 'hv' }, left, split, detail), list, detail, info, filterEl: filter });
  filter.oninput = () => { H.filter = filter.value; if (H.q) histSearch(t, ''); else drawHistList(t); };
  filter.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); histSearch(t, filter.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (filter.value || H.q) { filter.value = H.filter = ''; histSearch(t, ''); drawHistList(t); } else list.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list.focus(); }
  };
  list.onkeydown = (e) => {
    const k = e.key, d = k === 'ArrowDown' || k === 'j' ? 1 : k === 'ArrowUp' || k === 'k' ? -1 : k === 'PageDown' ? 10 : k === 'PageUp' ? -10 : 0; if (!d) return;
    e.preventDefault(); e.stopPropagation();
    const i = H.vis.findIndex((c) => c.h === H.sel), j = Math.max(0, Math.min(H.vis.length - 1, i < 0 ? 0 : i + d));
    if (H.vis[j]) histSelect(t, H.vis[j].h);
  };
  list.onscroll = () => { H.scroll = list.scrollTop; if (list.scrollTop + list.clientHeight > list.scrollHeight - 200 && H.more && !H.q && !H.filter.trim()) histMore(t); };
  detail.onscroll = () => { H.dscroll = detail.scrollTop; };
  split.onpointerdown = (e) => {
    e.preventDefault(); split.setPointerCapture(e.pointerId); const y0 = e.clientY, h0 = left.offsetHeight;
    split.onpointermove = (m) => { left.style.height = Math.max(110, Math.min(H.dom.clientHeight - 140, h0 + m.clientY - y0)) + 'px'; };
    split.onpointerup = () => { split.onpointermove = split.onpointerup = null; store.set('histH', left.offsetHeight); };
  };
  drawHistList(t); drawHistDetail(t);
  return H.dom;
}
function histRestoreScroll(t) { const H = t.h; requestAnimationFrame(() => { if (H.list) H.list.scrollTop = H.scroll || 0; if (H.detail) H.detail.scrollTop = H.dscroll || 0; }); }
function drawHistInfo(t) {
  const H = t.h; if (!H.info) return; const f = !H.q && H.filter.trim();
  H.info.textContent = H.q ? `"${H.q}" 검색 결과 ${H.commits.length}개${H.commits.length >= 300 ? '+' : ''}  ·  Esc: 해제`
    : `${f ? `${H.vis.length} / ` : ''}커밋 ${H.commits.length}${H.more ? '+' : ''}개${H.loading ? ' · 불러오는 중…' : ''}${t.scope === 'file' ? ' · 이름 변경 포함' : ''}`;
}
function refChips(refs) { // %D 장식 → 칩 (HEAD, 브랜치, 태그)
  const out = [];
  for (let r of (refs || '').split(', ').filter(Boolean)) {
    if (/\/HEAD$/.test(r)) continue;
    if (r === 'HEAD' || r.startsWith('HEAD -> ')) { out.push(el('span', { className: 'ref head', textContent: 'HEAD' })); if (r === 'HEAD') continue; r = r.slice(8); }
    const tag = r.startsWith('tag: '); if (tag) r = r.slice(5);
    out.push(el('span', { className: 'ref ' + (tag ? 'tag' : 'br'), textContent: (tag ? '🏷 ' : '') + r }));
  }
  return out;
}
function drawHistList(t) {
  const H = t.h, list = H.list; if (!list) return;
  const f = !H.q && H.filter.trim().toLowerCase(), st = list.scrollTop;
  H.vis = f ? H.commits.filter((c) => `${c.subj}\n${c.an}\n${c.ae}\n${c.h}\n${c.refs}\n${c.path || ''}`.toLowerCase().includes(f)) : H.commits;
  const rows = H.vis.map((c) => {
    const meta = el('div', { className: 'hv-meta' }, el('span', { className: 'hv-sha', textContent: c.s || c.h.slice(0, 7) }), el('span', { className: 'hv-an', textContent: c.an }), el('span', { textContent: ago(c.at) }), ...refChips(c.refs));
    if (t.scope === 'file' && c.path && c.path !== t.rel) meta.append(el('span', { className: 'hv-ren', textContent: (c.st === 'R' ? '↳ ' : '') + c.path, title: '이 커밋에서의 경로 (이름 변경 전)' }));
    const row = el('div', { className: 'hv-row' + (c.h === H.sel ? ' on' : '') + (c.p.length > 1 ? ' merge' : ''), title: `${c.subj}\n${c.an} · ${fmtDate(c.at)}` }, el('div', { className: 'hv-subj', textContent: c.subj || '(메시지 없음)' }), meta);
    row.dataset.h = c.h;
    row.onclick = () => { histSelect(t, c.h); list.focus({ preventScroll: true }); };
    row.oncontextmenu = (e) => { e.preventDefault(); histSelect(t, c.h); showMenu(e.clientX, e.clientY, commitMenu(t, c)); };
    return row;
  });
  if (!H.vis.length) rows.push(el('div', { className: 'hv-empty', textContent: H.commits.length ? '일치하는 커밋이 없습니다 — Enter 로 전체 기록에서 찾기' : H.q ? '찾은 커밋이 없습니다' : H.note || '커밋이 없습니다' }));
  if (H.more && !H.q) rows.push(Object.assign(el('button', { className: 'hv-more', textContent: H.loading ? '불러오는 중…' : '더 불러오기' }), { onclick: () => histMore(t) }));
  list.replaceChildren(...rows); list.scrollTop = st;
  drawHistInfo(t);
}
// 히스토리 탭 안의 '뒤로': 커밋 전체 diff 로 넓혔거나 부모/병합 커밋으로 건너뛴 것을 되돌린다
function histPush(t) { const H = t.h; H.back = [...(H.back || []), { sel: H.sel, full: H.full }].slice(-50); }
function histBack(t) {
  const H = t.h, s = H.back?.pop(); if (!s) return false;
  H.full = s.full; H.dscroll = 0; histSelect(t, s.sel); return true;
}
function histSelect(t, sha) {
  const H = t.h; if (!sha) return;
  H.sel = sha;
  H.list?.querySelectorAll('.hv-row.on').forEach((r) => r.classList.remove('on'));
  const row = H.list?.querySelector(`.hv-row[data-h="${sha}"]`); if (row) { row.classList.add('on'); row.scrollIntoView({ block: 'nearest' }); }
  drawHistDetail(t);
}
function commitMenu(t, c) {
  const w = t.repo.web, r = refsMemo.get(t.repo.abs + ':' + c.h), n = webName(w), pth = c.path || t.rel;
  return [
    ['커밋 해시 복사', () => copy(c.h, '커밋 해시 복사됨')],
    ['짧은 해시 복사', () => copy(c.s || c.h.slice(0, 7), '복사됨')],
    ['메시지 복사', () => copy(c.subj, '메시지 복사됨')],
    ...(w ? [['-'], [`${n}에서 커밋 열기`, () => window.open(webUrl(w, 'commit', { sha: c.h }), '_blank')],
      ...(r?.pr?.length ? [[`${n}에서 PR #${r.pr[0].n} 열기`, () => window.open(r.pr[0].url || webUrl(w, 'pr', { n: r.pr[0].n }), '_blank')]] : []),
      ...(t.scope !== 'repo' && pth ? [[`이 시점의 ${t.scope === 'dir' ? '폴더' : '파일'} ${n}에서 보기`, () => window.open(webUrl(w, t.scope === 'dir' ? 'tree' : 'blob', { ref: c.h, path: pth }), '_blank')]] : [])] : []),
  ];
}
function repoFileOpen(t, file, line) { // repo 기준 경로 → 워크스페이스에서 열기 (밖이면 외부 파일로)
  const abs = t.repo.abs + '/' + file;
  openFile(abs.startsWith(state.root + '/') ? abs.slice(state.root.length + 1) : '@ext' + abs, undefined, line ? { line } : undefined);
}
async function drawHistDetail(t) {
  const H = t.h, box = H.detail, sha = H.sel; if (!box) return;
  if (!sha) { box.replaceChildren(el('div', { className: 'dv-msg', textContent: H.commits.length ? '왼쪽에서 커밋을 고르세요' : '' })); return; }
  const c = H.commits.find((x) => x.h === sha) || (H.base?.commits || []).find((x) => x.h === sha) || { h: sha, p: [] }, full = H.full, key = sha + (full ? ':full' : '');
  let d = H.details.get(key);
  if (!d) {
    box.replaceChildren(el('div', { className: 'dv-msg', textContent: '불러오는 중…' }));
    const body = { sha };
    if (!full) {
      if (t.scope === 'file') { body.only = c.path || t.rel; if (c.from) body.old = c.from; }
      else if (t.scope === 'dir' && t.rel) body.only = t.rel;
      else if (t.scope === 'lines') { if (c.patch != null) body.nodiff = true; else body.only = t.rel; }
    }
    try { d = await api('POST', 'git/show', { path: t.src }, body); } catch (e) { d = { err: e.message }; }
    H.details.set(key, d);
    if (H.sel !== sha || H.full !== full || !state.tabs.includes(t)) return;   // 그 사이에 다른 커밋을 골랐다
  }
  renderHistDetail(t, c, d);
}
function parseDiffFiles(text) { // 여러 파일의 diff → 파일별 { path, from, hunks, add, del, bin }
  const out = [];
  for (const chunk of (text || '').split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const hd = /^diff --git a\/(.*) b\/(.*)$/m.exec(chunk), from = /^rename from (.*)$/m.exec(chunk)?.[1], to = /^rename to (.*)$/m.exec(chunk)?.[1];
    const plus = /^\+\+\+ b\/(.*)$/m.exec(chunk)?.[1], minus = /^--- a\/(.*)$/m.exec(chunk)?.[1];
    out.push({ path: to || plus || hd?.[2] || minus || '?', from: from || null, isNew: /^new file mode/m.test(chunk), isDel: /^deleted file mode/m.test(chunk), ...parseDiff(chunk) });
  }
  return out;
}
const ST_LABEL = { A: '추가', M: '수정', D: '삭제', R: '이름 변경', C: '복사', T: '형식 변경' };
function renderHistDetail(t, c, d) {
  const H = t.h, box = H.detail, w = t.repo.web, n = webName(w);
  if (d.err) { box.replaceChildren(el('div', { className: 'dv-msg err', textContent: d.err })); return; }
  const m = d.commit, pth = c.path || t.rel;
  const head = el('div', { className: 'hv-head' }, el('div', { className: 'hv-title', textContent: m.subj || '(메시지 없음)' }));
  if (m.body) head.append(el('div', { className: 'hv-body', textContent: m.body }));
  const meta = el('div', { className: 'hv-m' },
    chipBtn(m.h.slice(0, 10), '눌러서 전체 해시 복사\n' + m.h, () => copy(m.h, '커밋 해시 복사됨'), 'sha'),
    el('span', { className: 'hv-an', textContent: m.an, title: m.ae }),
    el('span', { textContent: `${fmtDate(m.at)} · ${ago(m.at)}` }),
    ...(m.cn && m.cn !== m.an ? [el('span', { className: 'dim', textContent: `커밋한 사람 ${m.cn}` })] : []));
  if (m.p.length) meta.append(el('span', { className: 'dim', textContent: m.p.length > 1 ? '병합 · 부모' : '부모' }), ...m.p.map((x) => chipBtn(x.slice(0, 7), '이 커밋 보기 (뒤로: 돌아오기)', () => { histPush(t); histSelect(t, x); }, 'sha')));
  const open = store.get('histMeta', false), partialScope = t.scope !== 'repo';
  meta.append(chipBtn(open ? '상세 ▾' : '상세 ▸', 'PR · 브랜치 · 커밋 메시지 본문 · 바뀐 파일 목록', () => { store.set('histMeta', !open); drawHistDetail(t); }));
  if (partialScope) meta.append(chipBtn(H.full ? '← ' + (t.scope === 'lines' ? '선택한 줄만' : t.scope === 'dir' ? '이 폴더만' : '이 파일만') : '커밋 전체 diff', H.full ? '뒤로 (⌘[ · 스와이프)' : '이 커밋에서 바뀐 모든 파일', () => {
    if (H.full) { if (!histBack(t)) { H.full = false; H.dscroll = 0; drawHistDetail(t); } } else { histPush(t); H.full = true; H.dscroll = 0; drawHistDetail(t); }
  }));
  head.append(meta);
  box.classList.toggle('compact', !open);
  // 이 커밋 범위(-L)에서 이 시점의 줄 위치
  let la = 0, lb = 0;
  if (t.scope === 'lines' && c.patch) { const hk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/m.exec(c.patch); if (hk) { la = +hk[1]; lb = la + Math.max(1, hk[2] == null ? 1 : +hk[2]) - 1; } }
  const links = el('div', { className: 'hv-links' });
  if (w) {
    links.append(aLink(`↗ ${n}에서 커밋 보기`, webUrl(w, 'commit', { sha: m.h })));
    if (t.scope !== 'repo' && pth && !(c.st === 'D')) links.append(aLink(t.scope === 'dir' ? '↗ 이 시점의 폴더' : la ? `↗ 이 시점의 ${la}–${lb}줄` : '↗ 이 시점의 파일', webUrl(w, t.scope === 'dir' ? 'tree' : 'blob', { ref: m.h, path: pth, a: la, b: lb })));
  }
  links.append(chipBtn('메시지 복사', '', () => copy(m.subj + (m.body ? '\n\n' + m.body : ''), '메시지 복사됨')));
  head.append(links);
  const refBox = el('div', { className: 'hv-refs' }, el('div', { className: 'hv-ref-row' }, el('span', { className: 'k', textContent: 'PR' }), el('span', { className: 'dim', textContent: 'PR · 브랜치 찾는 중…' })));
  head.append(refBox);
  // 바뀐 파일
  const parts = [head], partial = !H.full && t.scope !== 'repo';
  const fileRows = d.files.map((f) => {
    const row = el('div', { className: 'hv-f' + (f.path === pth && t.scope !== 'repo' ? ' cur' : ''), title: (ST_LABEL[f.st] || f.st) + (f.from ? `: ${f.from} → ${f.path}` : '') },
      el('span', { className: 'hv-st hs-' + f.st, textContent: f.st }), el('span', { className: 'p', textContent: f.from ? `${f.from} → ${f.path}` : f.path }),
      el('span', { className: 'n', textContent: f.add == null ? 'bin' : `+${f.add} −${f.del}` }));
    row.onclick = () => { const s = box.querySelector(`.hv-fd[data-p="${CSS.escape(f.path)}"]`); if (s) s.scrollIntoView({ block: 'start' }); else { histPush(t); H.full = true; H.jump = f.path; drawHistDetail(t); } };
    return row;
  });
  if (fileRows.length) {
    const fl = el('div', { className: 'hv-files' }, el('div', { className: 'hv-sec' }, el('span', { textContent: `바뀐 파일 ${d.nfiles}개` })));
    if (!open && partialScope && !H.full) fl.hidden = true;   // 접힌 상태: 파일 하나의 diff 만 바로 보이게
    const LIM = 15; fl.append(...fileRows.slice(0, LIM));
    if (fileRows.length > LIM) fl.append(chipBtn(`나머지 ${fileRows.length - LIM}개 보기`, '', (e) => { e.target.replaceWith(...fileRows.slice(LIM)); }));
    parts.push(fl);
  }
  // diff
  const text = t.scope === 'lines' && !H.full && c.patch != null ? c.patch : d.diff || '';
  const files = parseDiffFiles(text), dv = el('div', { className: 'hv-diffs' });
  if (!files.length) dv.append(el('div', { className: 'dv-msg', textContent: partial ? '이 범위에는 바뀐 내용이 없습니다 (병합 커밋일 수 있습니다)' : '바뀐 내용이 없습니다' }));
  for (const f of files) {
    const hdr = el('div', { className: 'hv-fh' }, el('span', { className: 'p', textContent: f.from ? `${f.from} → ${f.path}` : f.path }), el('span', { className: 'n', textContent: f.bin ? '바이너리' : `+${f.add} −${f.del}` }));
    if (!f.isDel) hdr.append(chipBtn('파일 열기', '지금 버전을 편집기로 열기', () => repoFileOpen(t, f.path, f.hunks[0]?.rows.find((r) => r.n)?.n)));
    if (w && !f.isDel) hdr.append(aLink('↗ 이 시점', webUrl(w, 'blob', { ref: m.h, path: f.path }), 'small'));
    const sec = el('div', { className: 'hv-fd' }, hdr);
    sec.dataset.p = f.path;
    sec.append(f.hunks.length ? diffTable(f, t.mode) : el('div', { className: 'dv-msg', textContent: f.bin ? '바이너리 파일' : f.isNew ? '빈 파일 추가' : f.isDel ? '파일 삭제' : f.from ? '내용 변경 없이 이름만 바뀜' : '내용 변경 없음 (모드 변경 등)' }));
    dv.append(sec);
  }
  if (d.truncated && (H.full || t.scope === 'repo' || t.scope === 'dir')) dv.append(el('div', { className: 'dv-msg', textContent: '변경이 너무 커서 일부만 표시합니다 — 전체는 원격 웹이나 git show 로 보세요' }));
  parts.push(dv);
  box.replaceChildren(...parts); loadRefs(t, m.h, refBox);   // 화면에 붙인 뒤에 (이미 받아 둔 정보면 바로 채운다)
  if (H.jump) { const s = box.querySelector(`.hv-fd[data-p="${CSS.escape(H.jump)}"]`); H.jump = null; if (s) requestAnimationFrame(() => s.scrollIntoView({ block: 'start' })); }
  else box.scrollTop = 0;
}
const refsMemo = new Map();   // repo:sha → PR/브랜치/태그
async function loadRefs(t, sha, box) {
  const key = t.repo.abs + ':' + sha; let r = refsMemo.get(key);
  if (!r) {
    try { r = await api('GET', 'git/refs', { path: t.src, sha }); refsMemo.set(key, r); }
    catch (e) { box.replaceChildren(el('div', { className: 'hv-ref-row' }, el('span', { className: 'dim', textContent: 'PR/브랜치 정보를 읽지 못했습니다: ' + e.message }))); return; }
  }
  if (!box.isConnected || t.h.sel !== sha) return;   // 그 사이에 다른 커밋을 골랐다
  const w = r.web || t.repo.web, rows = [], row = (k, ...kids) => el('div', { className: 'hv-ref-row' }, el('span', { className: 'k', textContent: k }), ...kids);
  const brChip = (name, remote, extra = '') => (remote && w ? aLink('⎇ ' + name, webUrl(w, 'branch', { name }), 'br ' + extra) : el('span', { className: 'hv-a br local ' + extra, textContent: '⎇ ' + name, title: name.includes('/') ? '다른 원격의 브랜치' : '로컬 브랜치 (원격에 없음)' }));
  if (r.pr.length) {
    for (const p of r.pr.slice(0, 3)) {
      const kids = [aLink(`#${p.n}${p.title ? ' ' + p.title : ''}`, p.url || webUrl(w, 'pr', { n: p.n }), 'pr')];
      if (p.state) kids.push(el('span', { className: 'pr-st ' + p.state, textContent: { merged: '병합됨', open: '열림', closed: '닫힘', draft: '초안' }[p.state] || p.state }));
      if (p.head) kids.push(brChip(p.head, true), ...(p.base ? [el('span', { className: 'dim', textContent: '→' }), brChip(p.base, true)] : []));
      if (p.by) kids.push(el('span', { className: 'dim', textContent: '@' + p.by }));
      if (p.guess) kids.push(el('span', { className: 'dim', textContent: '(커밋 메시지로 추정)', title: 'gh CLI 로 GitHub 에 물어보지 못해서 병합/squash 커밋 메시지에서 찾았습니다' }));
      rows.push(row('PR', ...kids));
    }
  } else rows.push(row('PR', el('span', { className: 'dim', textContent: r.prSource === 'gh' ? '연결된 PR 없음' : r.ghFailed ? 'PR 을 찾지 못했습니다 (gh 조회 실패 — 아직 push 하지 않은 커밋일 수 있습니다)' : w?.kind === 'github' ? 'PR 을 찾지 못했습니다 (gh CLI 를 설치하고 로그인하면 정확히 찾습니다)' : 'PR 을 찾지 못했습니다' })));
  if (r.merge) rows.push(row('병합', chipBtn(r.merge.h.slice(0, 7), '이 병합 커밋 보기 (뒤로: 돌아오기)', () => { histPush(t); histSelect(t, r.merge.h); }, 'sha'), el('span', { className: 'dim ell', textContent: r.merge.subj })));
  const brs = r.branches.map((b) => brChip(b.name, b.remote));
  rows.push(row('브랜치', ...(brs.length ? brs.slice(0, 8) : [el('span', { className: 'dim', textContent: '이 커밋을 포함한 브랜치가 없습니다' })]),
    ...(r.nbranches > 8 ? [chipBtn(`외 ${r.nbranches - 8}개`, r.branches.slice(8).map((b) => b.name).join('\n'), (e) => e.target.replaceWith(...brs.slice(8)))] : [])));
  if (r.tags.length) rows.push(row('태그', ...r.tags.map((x) => (w ? aLink('🏷 ' + x, webUrl(w, 'tag', { name: x }), 'tag') : el('span', { className: 'hv-a tag', textContent: '🏷 ' + x }))), el('span', { className: 'dim', textContent: '처음 포함된 태그부터' })));
  box.replaceChildren(...rows);
}
function histToolbar(t, bar) {
  const w = t.repo.web, ref = t.repo.branch && t.repo.branch !== 'HEAD' ? t.repo.branch : t.repo.head;
  const seg = el('span', { className: 'seg' }, ...MODES.diff.map(([m, label]) => btn(label, '', () => { t.mode = m; store.set('diffMode', m); renderToolbar(); drawHistDetail(t); }, t.mode === m ? 'on' : '')));
  const items = [el('span', { className: 'path' }), seg, el('span', { className: 'sep' })];
  if (t.scope === 'file' || t.scope === 'lines') items.push(btn('파일 열기', '이 파일을 편집기로 열기', () => openFile(t.src, undefined, t.range ? { line: t.range.a } : undefined)));
  if (w && ref) items.push(btn(`↗ ${webName(w)}`, `${webName(w)}의 커밋 기록 페이지 열기`, () => window.open(webUrl(w, 'history', { ref, path: t.scope === 'repo' ? '' : t.rel }), '_blank')));
  items.push(btn('↻', '다시 불러오기', () => histReload(t)));
  bar.replaceChildren(...items);
}

// ── Blame: 줄마다 마지막으로 바꾼 커밋 (읽기 전용 화면, 편집 중인 내용 그대로 계산) ──
function toggleBlame(p) {
  const go = () => {
    const t = tabOf(p); if (!t || !TEXT_KINDS.includes(t.kind)) return;
    if (t.blame) { t.blame = null; renderToolbar(); renderContent(); return; }
    const ta = $('textarea.editor');
    t.blame = { data: null, src: null, err: '', line: ta ? ta.value.slice(0, ta.selectionStart).split('\n').length : 1 };
    renderToolbar(); renderContent();
  };
  if (state.active !== p) openFile(p).then(go); else go();
}
async function loadBlame(t) {
  const B = t.blame; if (!B || B.loading) return;
  B.loading = true; const src = t.content;
  try { const r = await api('POST', 'git/blame', { path: t.path }, { content: src }); Object.assign(B, { data: r, err: '' }); rememberWeb(r.repo); }
  catch (e) { Object.assign(B, { data: null, err: e.message }); }
  Object.assign(B, { src, at: Date.now(), loading: false });
  if (state.active === t.path && t.blame === B) renderContent();
}
function blameLineAt(pre, y) { const r = pre.getBoundingClientRect(), lh = parseFloat(getComputedStyle(pre).lineHeight) || 20; const L = Math.floor((y - r.top) / lh) + 1; return L >= 1 ? L : null; }
function blameView(t) {
  const B = t.blame, box = el('div', { className: 'blv', tabIndex: 0 });
  box.onkeydown = (e) => { if (e.key === 'Escape' && !fb.open) { e.preventDefault(); toggleBlame(t.path); } };
  if (!B.loading && (B.src !== t.content || Date.now() - (B.at || 0) > 60000)) loadBlame(t);
  if (!B.data) { box.append(el('div', { className: 'dv-msg' + (B.err ? ' err' : ''), textContent: B.err ? 'Blame: ' + B.err : 'Blame 계산 중…' })); return box; }
  const { commits, lines } = B.data, n = lines.length, src = B.src.replace(/\r\n/g, '\n').split('\n').slice(0, n);
  const ats = commits.filter((c) => !c.wip).map((c) => c.at), lo = Math.min(...ats), hi = Math.max(...ats);
  const gut = el('div', { className: 'bl-gut' }), bands = el('div', { className: 'bl-bands' });
  for (let i = 0, g = 0; i < n; i++) {
    const ci = lines[i], c = commits[ci], start = i === 0 || lines[i - 1] !== ci;
    if (start) { g++; let j = i; while (j + 1 < n && lines[j + 1] === ci) j++; const band = el('div', { className: 'bl-band' + (g % 2 ? '' : ' alt') }); band.style.cssText = `top:calc(var(--blh) * ${i});height:calc(var(--blh) * ${j - i + 1})`; bands.append(band); }
    const row = el('div', { className: 'bl-row' + (start ? ' gs' : '') + (g % 2 ? '' : ' alt') + (c.wip ? ' wip' : '') });
    row.dataset.c = ci; row.style.setProperty('--age', c.wip ? 1 : hi > lo ? ((c.at - lo) / (hi - lo)).toFixed(2) : 1);
    if (start) row.append(el('span', { className: 'bl-sha', textContent: c.wip ? '•••••••' : c.h.slice(0, 7) }), el('span', { className: 'bl-an', textContent: c.wip ? '커밋 안 됨' : c.an }), el('span', { className: 'bl-ago', textContent: c.wip ? '' : ago(c.at) }), el('span', { className: 'bl-subj', textContent: c.wip ? '' : c.subj }));
    else row.append(el('span', { className: 'bl-fill' }));
    row.append(el('span', { className: 'bl-ln', textContent: i + 1 }));
    gut.append(row);
  }
  let hl = -1;
  gut.onmouseover = (e) => {
    const r = e.target.closest('.bl-row'); if (!r) return; const ci = +r.dataset.c, c = commits[ci];
    if (!r.title) r.title = c.wip ? '아직 커밋하지 않은 줄' : `${c.h}\n${c.an} · ${fmtDate(c.at)} (${ago(c.at)})\n\n${c.subj}\n\n클릭: 이 커밋을 히스토리에서 보기`;
    if (ci === hl) return; gut.querySelectorAll('.bl-row.hl').forEach((x) => x.classList.remove('hl')); hl = ci; gut.querySelectorAll(`.bl-row[data-c="${ci}"]`).forEach((x) => x.classList.add('hl'));
  };
  gut.onmouseleave = () => { hl = -1; gut.querySelectorAll('.bl-row.hl').forEach((x) => x.classList.remove('hl')); };
  gut.onclick = (e) => { const r = e.target.closest('.bl-row'); if (!r) return; const c = commits[+r.dataset.c]; if (c.wip) return toast('아직 커밋하지 않은 줄입니다'); openHistory({ path: t.path, scope: 'file', focus: c.h }); };
  gut.oncontextmenu = (e) => {
    const r = e.target.closest('.bl-row'); if (!r) return; e.preventDefault(); e.stopPropagation();
    const c = commits[+r.dataset.c], L = +r.querySelector('.bl-ln').textContent, w = B.data.repo?.web;
    showMenu(e.clientX, e.clientY, [
      ...(c.wip ? [] : [['이 커밋을 히스토리에서 보기', () => openHistory({ path: t.path, scope: 'file', focus: c.h })], ['커밋 해시 복사', () => copy(c.h, '커밋 해시 복사됨')],
        ...(w ? [[`${webName(w)}에서 커밋 열기`, () => window.open(webUrl(w, 'commit', { sha: c.h }), '_blank')]] : [])]),
      [`이 줄 히스토리 (${L}줄)`, () => openHistory({ path: t.path, scope: 'lines', a: L, b: L })],
      ['-'], ['Blame 끄기', () => toggleBlame(t.path)],
    ]);
  };
  const lang = langOf(t.path), body = src.join('\n'), code = el('pre', { className: 'bl-code' });
  if (lang && body.length < 300000) code.innerHTML = highlight(lang, body) + '\n'; else code.textContent = body + '\n';
  code.ondblclick = (e) => { const L = blameLineAt(code, e.clientY); t.blame = null; openFile(t.path, undefined, L ? { line: L } : undefined); };
  code.title = '더블클릭: 이 줄로 편집기 열기';
  box.append(el('div', { className: 'bl-wrap' }, gut, el('div', { className: 'bl-cw' }, bands, code)));
  box.onscroll = () => { B.st = box.scrollTop; };
  requestAnimationFrame(() => {
    if (B.st != null) box.scrollTop = B.st;
    else { const lh = parseFloat(getComputedStyle(code).lineHeight) || 20; box.scrollTop = Math.max(0, (B.line - 1) * lh - box.clientHeight / 3); B.st = box.scrollTop; }
    if (!document.activeElement?.closest('input, textarea, #fbar')) box.focus({ preventScroll: true });
  });
  return box;
}


// ───────── Run: ~/.shooting-star/run 에 등록된 스크립트 (CLI `ss run`, Claude 와 공유) ─────────
const runUi = { scripts: [], history: [], dir: '', running: new Set(), secrets: new Set() };
// ───────── 실행 출력: 작은 터미널 렌더러 (ANSI 색/스타일, \r 덮어쓰기, 줄 지우기, 커서 위/아래) ─────────
const TERM_16 = ['#1e1f22', '#f14c4c', '#23d18b', '#e5c07b', '#3b8eea', '#d670d6', '#29b8db', '#cccccc',
  '#666666', '#ff6e6e', '#5af78e', '#f4f99d', '#6cb6ff', '#ff92df', '#9aedfe', '#ffffff'];
function term256(n) {
  if (n < 16) return TERM_16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16; const c = (v) => (v ? 55 + v * 40 : 0);
  return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
}
const TERM_MAX_LINES = 5000;
// 실행 출력 칸에 들어가는 글자 수 → 서버가 가상 터미널(pty) 크기로 쓴다 (진행 막대 폭 등)
function termSize(pre) {
  const probe = document.createElement('span'); probe.textContent = 'M'.repeat(50); probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  pre.append(probe); const cw = probe.getBoundingClientRect().width / 50; probe.remove();
  const cs = getComputedStyle(pre), ch = parseFloat(cs.lineHeight), w = pre.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), h = pre.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (!(cw > 0) || !(w > 0)) return {};
  return { cols: Math.max(20, Math.floor(w / cw) - 1), rows: Math.max(5, Math.floor(h / (ch || 16))) };
}
class Term {
  constructor(pre) { this.pre = pre; this.reset(); }
  reset() { this.lines = [[]]; this.nodes = []; this.y = 0; this.x = 0; this.st = {}; this.sk = ''; this.pend = ''; this.dirty = new Set(); this.pre.replaceChildren(); }
  setStyle(st) { this.st = st; this.sk = JSON.stringify(st); }
  sgr(ps) {
    const st = { ...this.st }; const a = ps.length ? ps : [0];
    for (let i = 0; i < a.length; i++) {
      const p = a[i];
      if (p === 0) { for (const k in st) delete st[k]; }
      else if (p === 1) st.b = 1; else if (p === 2) st.d = 1; else if (p === 3) st.i = 1; else if (p === 4) st.u = 1; else if (p === 7) st.r = 1; else if (p === 9) st.s = 1;
      else if (p === 22) { delete st.b; delete st.d; } else if (p === 23) delete st.i; else if (p === 24) delete st.u; else if (p === 27) delete st.r; else if (p === 29) delete st.s;
      else if (p >= 30 && p <= 37) st.fg = TERM_16[p - 30]; else if (p >= 90 && p <= 97) st.fg = TERM_16[p - 82];
      else if (p >= 40 && p <= 47) st.bg = TERM_16[p - 40]; else if (p >= 100 && p <= 107) st.bg = TERM_16[p - 92];
      else if (p === 39) delete st.fg; else if (p === 49) delete st.bg;
      else if (p === 38 || p === 48) {
        const k = p === 38 ? 'fg' : 'bg';
        if (a[i + 1] === 5 && a[i + 2] !== undefined) { st[k] = term256(a[i + 2]); i += 2; }
        else if (a[i + 1] === 2 && a[i + 4] !== undefined) { st[k] = `rgb(${a[i + 2]},${a[i + 3]},${a[i + 4]})`; i += 4; }
      }
    }
    this.setStyle(st);
  }
  line(y) { while (this.lines.length <= y) this.lines.push([]); return this.lines[y]; }
  put(ch) { const L = this.line(this.y); while (L.length < this.x) L.push([' ', '']); L[this.x++] = [ch, this.sk]; this.dirty.add(this.y); }
  csi(params, fin) {
    const ps = params.replace(/^\?/, '').split(';').map((v) => (v === '' ? NaN : Number(v))), n = Number.isNaN(ps[0]) ? 1 : Math.max(1, ps[0]);
    const L = () => this.line(this.y);
    switch (fin) {
      case 'm': if (!params.startsWith('?')) this.sgr(params === '' ? [] : ps.map((v) => (Number.isNaN(v) ? 0 : v))); break;
      case 'K': { const m = Number.isNaN(ps[0]) ? 0 : ps[0], l = L(); if (m === 0) l.length = Math.min(l.length, this.x); else if (m === 1) for (let i = 0; i <= this.x && i < l.length; i++) l[i] = [' ', '']; else l.length = 0; this.dirty.add(this.y); break; }
      case 'A': this.y = Math.max(0, this.y - n); break;
      case 'B': this.y += n; this.line(this.y); break;
      case 'C': this.x += n; break;
      case 'D': this.x = Math.max(0, this.x - n); break;
      case 'G': this.x = n - 1; break;
      case 'E': this.y += n; this.x = 0; this.line(this.y); break;
      case 'F': this.y = Math.max(0, this.y - n); this.x = 0; break;
      case 'J': if (ps[0] === 2 || ps[0] === 3) { const st = this.st; this.reset(); this.setStyle(st); } break;   // clear (화면 지우기)
      default: break;   // 위치 지정(H) 등 화면 단위 제어는 무시 (로그 용도)
    }
  }
  write(s) {
    s = this.pend + s; this.pend = '';
    const re = /\x1b(?:\[([0-9;?]*)[ -\/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[@-Z\\-_])/y;
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (c === '\x1b') {
        re.lastIndex = i; const m = re.exec(s);
        if (!m) { if (s.length - i < 64 && !/[\x07\n]/.test(s.slice(i))) { this.pend = s.slice(i); break; } i++; continue; }   // 다음 조각에서 이어지는 escape
        if (m[2]) this.csi(m[1], m[2]);
        i = re.lastIndex; continue;
      }
      if (c === '\n') { this.y++; this.x = 0; this.line(this.y); this.dirty.add(this.y); }
      else if (c === '\r') this.x = 0;
      else if (c === '\b') this.x = Math.max(0, this.x - 1);
      else if (c === '\t') { const to = (Math.floor(this.x / 8) + 1) * 8; while (this.x < to) this.put(' '); }
      else if (c >= ' ' || c > '\x7f') this.put(c);
      i++;
    }
    if (this.lines.length > TERM_MAX_LINES) {   // 오래된 줄은 버린다
      const cut = this.lines.length - TERM_MAX_LINES;
      this.lines.splice(0, cut); for (const nd of this.nodes.splice(0, cut)) nd?.remove();
      this.y = Math.max(0, this.y - cut); this.dirty = new Set([...this.dirty].map((y) => y - cut).filter((y) => y >= 0));
    }
    this.render();
  }
  render() {
    for (const y of [...this.dirty].sort((a, b) => a - b)) {
      let nd = this.nodes[y];
      if (!nd) { for (let k = this.nodes.length; k <= y; k++) { const d = document.createElement('div'); d.className = 'tl'; this.pre.append(d); this.nodes[k] = d; this.paint(d, this.lines[k] || []); } continue; }
      this.paint(nd, this.lines[y] || []);
    }
    this.dirty.clear();
  }
  paint(d, L) {
    const kids = []; let txt = '', key = null;
    const flush = () => {
      if (!txt) return;
      if (!key) { kids.push(txt); txt = ''; return; }
      const st = JSON.parse(key), sp = document.createElement('span');
      let fg = st.fg, bg = st.bg; if (st.r) { [fg, bg] = [bg || 'var(--term-bg)', fg || 'var(--term-fg)']; }
      if (fg) sp.style.color = fg; if (bg) sp.style.background = bg;
      if (st.b) sp.style.fontWeight = '700'; if (st.d) sp.style.opacity = '.6'; if (st.i) sp.style.fontStyle = 'italic';
      if (st.u || st.s) sp.style.textDecoration = (st.u ? 'underline ' : '') + (st.s ? 'line-through' : '');
      sp.textContent = txt; kids.push(sp); txt = '';
    };
    for (const [ch, k] of L) { const kk = k && k !== '{}' ? k : null; if (kk !== key) { flush(); key = kk; } txt += ch; }
    flush(); d.replaceChildren(...kids);
  }
  text() { return this.lines.map((L) => L.map((c) => c[0]).join('').replace(/\s+$/, '')).join('\n').replace(/\n+$/, '\n'); }
}
async function loadRun() {
  const box = $('#run-list');
  try { const r = await api('GET', 'run/list'); runUi.scripts = r.scripts; runUi.history = r.history; runUi.dir = r.dir; runUi.running = new Set(r.running.map((j) => j.name)); runUi.secrets = new Set(r.secrets || []); }
  catch (e) { box.replaceChildren(el('div', { className: 'git-empty', textContent: 'Run 목록을 읽지 못했습니다: ' + e.message })); return; }
  runSyncTabs(); drawRun(); runWatchDir();
}
// 열려 있는 실행 탭에 바뀐 매니페스트(설명/파라미터/프리셋/기본값)를 반영한다. 실행 중이면 끝난 뒤(loadRun) 반영.
function runSyncTabs() {
  for (const t of state.tabs) {
    if (t.kind !== 'run' || t.job) continue;
    const m = runUi.scripts.find((x) => x.name === t.name);
    if (!m || m.broken || JSON.stringify(m) === JSON.stringify(t.m)) continue;
    const old = t.m; t.m = m; t.scriptPath = m.scriptPath;
    for (const k of Object.keys(t.vals)) {   // 사용자가 직접 바꾼 값만 남긴다 (예전 기본값 그대로면 새 기본값을 쓰도록)
      const op = old?.params.find((p) => p.name === k), np = m.params.find((p) => p.name === k);
      if (!np || !op || np.type !== op.type) { delete t.vals[k]; continue; }
      const ob = old && runBase({ ...t, m: old }, op);
      if (String(t.vals[k]) === String(ob ?? (op.type === 'bool' ? false : ''))) delete t.vals[k];
    }
    if (t.preset && !m.presets?.[t.preset]) t.preset = '';
    t.dom = null; if (t.path === state.active) renderContent();
  }
}
// ~/.shooting-star/run 은 프로젝트 밖이라 파일 감시에 안 걸린다 → 폴더를 따로 감시 (Claude/CLI 가 등록·수정하면 바로 갱신)
let runWatch = null, runWatchT = 0;
function runWatchDir() {
  if (!runUi.dir || runWatch?.dir === runUi.dir || typeof EventSource === 'undefined') return;
  runWatch?.es.close();
  const es = new EventSource('/api/dirwatch?root=%2F&path=' + encodeURIComponent(runUi.dir.slice(1))); let first = true;
  const again = () => { clearTimeout(runWatchT); runWatchT = setTimeout(loadRun, 150); };
  es.onmessage = again;
  es.onopen = () => { if (!first) again(); first = false; };
  es.onerror = () => { if (es.readyState === 2 && runWatch?.es === es) runWatch = null; };   // 영구 실패면 다음 loadRun 때 다시 시도
  runWatch = { dir: runUi.dir, es };
}
function drawRun() {
  const box = $('#run-list'), kids = [];
  if (!runUi.scripts.length) kids.push(el('div', { className: 'git-empty', textContent: '등록된 스크립트가 없습니다. ＋ 로 만들거나, Claude 에게 “이 스크립트를 ss run 으로 등록해줘” 라고 하세요. 터미널: ss run add <파일>' }));
  for (const m of runUi.scripts) {
    const row = el('div', { className: 'rn' + (m.broken || m.missing ? ' bad' : '') + (state.active === '@run/' + m.name ? ' sel' : ''), title: m.broken || (m.missing ? '스크립트 파일 없음' : m.scriptPath) },
      el('div', { className: 'rt', textContent: m.name }), el('div', { className: 'rd', textContent: m.broken || m.description || (m.params.length ? m.params.map((p) => p.name).join(', ') : '파라미터 없음') }));
    if (runUi.running.has(m.name)) row.append(el('span', { className: 'rp', textContent: '● 실행 중' }));
    row.onclick = () => { if (!m.broken) openRunTab(m, true); };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        ...(m.broken ? [] : [['실행 화면 열기', () => openRunTab(m)], ['스크립트 편집', () => openExternal(m.scriptPath)]]),
        ['설정(' + (m.manifest || '').split('.').pop() + ') 편집', () => openExternal(m.manifest)],
        ['`ss run ' + m.name + '` 복사', () => copy('ss run ' + m.name, '명령 복사됨')],
        ...(m.broken ? [] : [['내보내기 YAML 복사 (다른 컴퓨터용)', async () => { try { copy((await api('GET', 'run/export', { name: m.name })).yaml, 'YAML 복사됨 — 다른 컴퓨터에서 ss run add - 로 붙여넣기'); } catch (er) { toast(er.message); } }]]),
        ['등록 해제…', async () => { if (!confirm(`'${m.name}' 등록을 해제할까요? (실행 기록은 유지)`)) return; try { await api('DELETE', 'run/script', { name: m.name }); closeTab('@run/' + m.name).catch?.(() => {}); } catch (er) { toast(er.message); } loadRun(); }],
      ]);
    };
    kids.push(row);
  }
  if (runUi.history.length) {
    kids.push(el('div', { className: 'rn-sec', textContent: '최근 실행' }));
    for (const h of runUi.history.slice(0, 15)) {
      const ok = h.code === 0, m = runUi.scripts.find((x) => x.name === h.name);
      const r = el('div', { className: 'rh', title: `${new Date(h.startedAt).toLocaleString()} · ${h.source}${h.cwd ? '\n📁 ' + h.cwd.replace(state.home || '\u0000', '~') : ''}${h.git ? '\n⎇ ' + gitLabel(h.git) : ''}\n${JSON.stringify(h.params)}\n클릭: 이 실행의 출력 보기` },
        el('span', { className: 'rc ' + (ok ? 'ok' : 'fail'), textContent: ok ? '✓' : '✗' + (h.code ?? '') }), el('span', { className: 'rn2', textContent: h.name }),
        h.git?.branch ? el('span', { className: 'rbr', textContent: '⎇ ' + h.git.branch }) : '',
        el('span', { className: 'rw', textContent: h.source === 'cli' ? 'CLI' : new Date(h.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }));
      r.onclick = async () => {
        if (!m) return toast('등록 해제된 스크립트입니다');
        const t = openRunTab(m, false);                 // 같은 탭을 재사용하되 '지난 결과 보기' 모드
        t.vals = { ...(h.params || {}) }; t.preset = h.preset || '';   // 그때 쓴 파라미터로 폼을 채움
        t.viewing = h.id; t.runId = h.id; t.fold = true; t.where = { cwd: h.cwd, git: h.git || null, at: h.startedAt };   // 지난 출력을 넓게
        try { t.out = (await api('GET', 'run/log', { id: h.id })).log; } catch { t.out = ''; }
        t.status = { cls: ok ? 'ok' : 'fail', text: `이전 실행 결과 · ${new Date(h.startedAt).toLocaleString()} · exit ${h.code ?? h.signal}` };
        t.dom = null; renderContent();
      };
      kids.push(r);
    }
  }
  box.replaceChildren(...kids);
  const envLink = Object.assign(el('a', { textContent: '환경 다시 읽기', href: '#', title: 'UI 실행은 로그인 셸(~/.bash_profile, ~/.bashrc …) 환경을 씁니다. rc 파일이 바뀌면 자동으로 다시 읽고, rc 가 source 하는 다른 파일을 바꿨을 때는 이걸 누르세요.' }), { onclick: async (e) => { e.preventDefault(); try { const r = await api('POST', 'run/env-reload'); toast(r.err || `환경 다시 읽음 — ${r.shell} · 변수 ${r.vars}개 · ${r.ms}ms`); } catch (er) { toast(er.message); } } });
  $('#run-foot').replaceChildren(el('span', { textContent: runUi.dir.replace(state.home || '\u0000', '~') }), ' · ', envLink, ' · ', Object.assign(el('a', { textContent: 'Claude 연동 설치', href: '#', title: '~/.claude 에 ss-run skill + SessionStart hook + `ss run` 실행 권한 추가' }), { onclick: async (e) => { e.preventDefault(); try { const r = await api('POST', 'run/install'); toast(r.hookAdded || r.rulesAdded.length ? 'Claude 연동 설치됨 (새 세션부터)' : '이미 설치되어 있습니다'); } catch (er) { toast(er.message); } } }));
}
function openRunTab(m, fresh = true) {
  const p = '@run/' + m.name; let t = tabOf(p);
  if (!t) { t = { path: p, kind: 'run', name: m.name, content: '', orig: '', mtime: 0, mode: 'view', vals: {}, out: '', status: null, job: null }; state.tabs.push(t); }
  t.m = m; t.scriptPath = m.scriptPath;
  if (fresh && !t.job) { t.out = ''; t.status = null; t.viewing = null; t.vals = {}; t.preset = ''; t.fold = false; t.where = null; t.dom = null; }   // 실행기: 기본값 폼 + 빈 출력 (실행 중이면 건드리지 않음)
  state.active = p; state.selected = p; renderAll(); drawRun(); return t;
}
// Claude 에 붙여넣을 디버깅 안내: 실행 id → `ss run log <id>` 로 실행 정보 + 출력, 그리고 파일 경로들
function runDebugText(t) {
  const id = t.runId, st = t.status?.text;
  return [id ? `ss run '${t.name}' 실행 결과를 확인하고, 문제가 있으면 원인을 찾아 고쳐줘.${st ? ' (' + st + ')' : ''}` : `ss run '${t.name}' 스크립트를 확인해줘.`,
    `- 명령: ${id && t.viewing ? '(지난 실행) ' : ''}${runCmdline(t)}`,
    id ? `- 실행 정보 + 출력: \`ss run log ${id}\`` : '',
    id ? `- 로그 파일: ${runUi.dir}/logs/${id}.log` : '',
    t.where ? `- 실행 위치: ${t.where.cwd}${t.where.git ? ' (git ' + gitLabel(t.where.git) + ')' : ''}` : '',
    `- 스크립트: ${t.m.scriptPath}`, `- 설정: ${t.m.manifest}`].filter(Boolean).join('\n');
}
const gitLabel = (g) => `${g.branch || 'detached'}${g.commit ? ' @' + g.commit : ''}${g.dirty ? ' · 변경 ' + g.dirty : ''}`;
const runBase = (t, p) => { const pv = t.preset && t.m.presets?.[t.preset]; return pv && pv[p.name] !== undefined ? pv[p.name] : p.default; };
const runCmdline = (t) => {
  const parts = ['ss run', t.name]; if (t.preset) parts.push('@' + t.preset);
  for (const p of t.m.params) { const v = t.vals[p.name], base = runBase(t, p); if (v === undefined || v === '' || (v === false && !base) || (base !== undefined && String(v) === String(base))) continue; parts.push(p.type === 'bool' ? '--' + p.name : `--${p.name} ${/[\s"'$]/.test(String(v)) ? JSON.stringify(String(v)) : v}`); }
  return parts.join(' ');
};
function runView(t) {
  if (t.dom) return t.dom;   // 실행 중에도 입력/출력 상태가 유지되도록 한 번 만든 DOM 을 재사용
  const m = t.m, form = el('div', { className: 'rv-form' });
  if (t.preset && !m.presets?.[t.preset]) t.preset = '';
  for (const p of m.params) if (t.vals[p.name] === undefined) { const b = runBase(t, p); t.vals[p.name] = b !== undefined ? b : p.type === 'bool' ? false : ''; }
  const cmd = el('div', { className: 'rv-cmd' }), upd = () => { cmd.textContent = runCmdline(t); };
  const where = el('div', { className: 'rv-where' });
  const drawWhere = () => {   // 어디서(작업 폴더) 어떤 브랜치로 — 실행 전엔 지금 상태, 실행/지난 결과는 그때 상태
    const w = t.where; if (!w) { where.replaceChildren(); return; }
    const lab = t.viewing ? '그때 위치' : w.run ? '실행한 위치' : '실행할 위치';
    where.replaceChildren(el('span', { className: 'wl', textContent: lab }), el('span', { className: 'wd', textContent: '📁 ' + (w.cwd || '').replace(state.home || '\u0000', '~'), title: w.cwd + (w.git?.repo && w.git.repo !== w.cwd ? '\nrepo: ' + w.git.repo : '') }),
      w.git ? el('span', { className: 'wg' + (w.git.dirty ? ' dirty' : ''), textContent: '⎇ ' + gitLabel(w.git), title: w.git.dirty ? '커밋되지 않은 변경 ' + w.git.dirty + '개 (추적 중인 파일)' : '깨끗함' }) : el('span', { className: 'wn', textContent: 'git 저장소 아님' }));
  };
  t.refreshWhere = async () => {   // 실행 전 미리보기 (브랜치를 바꾸고 돌아와도 맞게)
    if (t.job || t.viewing || t.where?.run) return;
    try { const r = await api('GET', 'run/where', { name: t.name }); if (t.job || t.viewing || t.where?.run) return; t.where = r; drawWhere(); } catch {}
  };
  const presets = Object.keys(m.presets || {});
  if (presets.length) {   // 프리셋을 고르면 그 값으로 폼을 채운다 (이후 개별 수정 가능)
    const sel = el('select', { id: 'rp-@preset', onchange() { t.preset = this.value; t.vals = {}; t.dom = null; renderContent(); } }, el('option', { value: '', textContent: '(기본값)' }), ...presets.map((k) => el('option', { value: k, textContent: '@' + k + '  ' + Object.entries(m.presets[k]).map(([a, b]) => a + '=' + b).join(' ') })));
    sel.value = t.preset || '';
    form.append(el('label', { htmlFor: sel.id, textContent: '프리셋' }), sel);
  }
  for (const sdef of m.secrets || []) {   // 세션키: 저장돼 있으면 재사용, 새로 붙여넣으면 갱신. 값은 서버에만 저장됨
    const saved = runUi.secrets.has(sdef.name);
    const inp = el('input', { type: 'password', autocomplete: 'off', placeholder: saved ? '저장됨 — 바꾸려면 붙여넣기' : '세션키 붙여넣기' });
    const save = el('button', { textContent: '저장', title: '이 세션키를 저장 (다음부터 재사용)', async onclick() {
      const v = inp.value.trim(); if (!v) return toast('값을 붙여넣으세요');
      try { await api('PUT', 'secret', {}, { name: sdef.name, value: v }); } catch (e) { return toast(e.message); }
      runUi.secrets.add(sdef.name); inp.value = ''; toast(sdef.name + ' 세션키 저장됨'); t.dom = null; renderContent();
    } });
    const wrap = el('div', { className: 'rv-secret' }, inp, save, el('span', { className: 'ss-badge ' + (saved ? 'on' : 'off'), textContent: saved ? '● 저장됨' : '미저장' }));
    form.append(el('label', { htmlFor: '', title: 'SS_SECRET_' + sdef.name.toUpperCase().replace(/[^A-Z0-9]/g, '_') }, '🔑 ' + sdef.name), wrap);
    if (sdef.description) form.append(el('div', { className: 'pd', textContent: sdef.description }));
  }
  for (const p of m.params) {
    let inp;
    if (p.type === 'bool') inp = el('input', { type: 'checkbox', checked: !!t.vals[p.name], onchange() { t.vals[p.name] = this.checked; upd(); } });
    else if (p.type === 'choice') { inp = el('select', { onchange() { t.vals[p.name] = this.value; upd(); } }, ...p.choices.map((c) => el('option', { value: c, textContent: c }))); inp.value = String(t.vals[p.name]); }
    else inp = el('input', { type: p.type === 'number' ? 'number' : 'text', value: t.vals[p.name], placeholder: p.type === 'file' ? '/경로/파일' : '', oninput() { t.vals[p.name] = this.value; upd(); } });
    inp.id = `rp-${p.name}`;
    form.append(el('label', { htmlFor: inp.id, title: p.as === 'flag' ? (p.flag || '--' + p.name) : p.as }, p.name, p.required ? el('i', { textContent: ' *' }) : ''), inp);
    if (p.description) form.append(el('div', { className: 'pd', textContent: p.description }));
  }
  if (!m.params.length) form.append(el('div', { className: 'pd', style: 'grid-column:1/-1', textContent: '파라미터가 없습니다.' }));
  upd();
  const out = el('pre', { className: 'rv-out' }), st = el('span', { className: 'rv-st' }), term = new Term(out); t.term = term;
  if (t.out) term.write(t.out);
  const go = el('button', { className: 'go', textContent: t.viewing ? '▶ 다시 실행' : '▶ 실행', title: '실행 (⌘/Ctrl+Enter)' }), stop = el('button', { textContent: '■ 중지', hidden: true });
  const paint = () => { const s = t.status; st.className = 'rv-st ' + (s?.cls || ''); st.textContent = s?.text || ''; go.disabled = !!t.job; stop.hidden = !t.job;
    const idle = !t.job && !t.viewing && !t.out; out.hidden = idle; top.classList.toggle('idle', idle); clear.hidden = cp.hidden = idle; };   // 실행 전엔 터미널을 숨기고, 실행하면 보여준다
  const refind = () => { if (fb.open && t.path === state.active) { clearTimeout(t.findT); t.findT = setTimeout(() => runFileFind(false), 200); } };   // 출력이 늘어나도 찾기 결과 유지
  const append = (s) => { const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40; t.out = (t.out + s).slice(-400000); term.write(s); if (stick) out.scrollTop = out.scrollHeight; refind(); };
  const run = async () => {
    if (t.job) return;
    const missing = m.params.find((p) => p.required && (t.vals[p.name] === '' || t.vals[p.name] === undefined));
    if (missing) { toast(`필수: ${missing.name}`); document.getElementById(`rp-${missing.name}`)?.focus(); return; }
    const needSecret = (m.secrets || []).find((x) => x.required !== false && !runUi.secrets.has(x.name));
    if (needSecret) { toast(`세션키를 먼저 저장하세요: ${needSecret.name}`); return; }
    if (m.danger && !confirm(`'${m.name}' 은(는) danger 스크립트입니다. 실행할까요?\n\n${runCmdline(t)}`)) return;
    t.out = ''; term.reset(); refind(); t.viewing = null; go.textContent = '▶ 실행'; t.status = { cls: 'run', text: '시작 중…' }; t.job = { id: null }; setFold(true); paint();
    const params = {}; for (const p of m.params) { const v = t.vals[p.name]; if (v !== '' && v !== undefined) params[p.name] = v; }
    let r; try { r = await api('POST', 'run/exec', {}, { name: m.name, params, preset: t.preset || undefined, ...termSize(out) }); } catch (e) { t.job = null; t.status = { cls: 'fail', text: e.message }; paint(); return; }
    t.job = { id: r.id }; t.runId = r.id; t.where = { cwd: r.cwd, git: r.git || null, at: r.startedAt, run: true }; drawWhere(); t.status = { cls: 'run', text: '실행 중…' }; paint(); runUi.running.add(m.name); drawRun();
    append(`$ ${r.cmdline}\n`);
    const es = new EventSource(`/api/run/stream?id=${r.id}&root=${encodeURIComponent(state.root)}`); t.es = es;
    es.addEventListener('data', (e) => append(JSON.parse(e.data)));
    es.addEventListener('end', (e) => {
      es.close(); const d = JSON.parse(e.data); t.job = null; t.es = null;
      t.status = d.code === 0 ? { cls: 'ok', text: `✓ 완료 · ${(d.ms / 1000).toFixed(1)}s` } : { cls: 'fail', text: `✗ ${d.signal ? '중단됨 (' + d.signal + ')' : 'exit ' + d.code} · ${(d.ms / 1000).toFixed(1)}s` };
      paint(); runUi.running.delete(m.name); loadRun();
    });
    es.onerror = () => { if (t.job && es.readyState === 2) { t.job = null; t.status = { cls: 'fail', text: '연결이 끊겼습니다' }; paint(); } };
  };
  go.onclick = run;
  stop.onclick = async () => { if (t.job?.id) { try { await api('POST', 'run/kill', {}, { id: t.job.id }); } catch {} } };
  const clear = el('button', { textContent: '지우기', onclick: () => { t.out = ''; term.reset(); refind(); paint(); } });
  const cp = el('button', { textContent: '출력 복사', onclick: () => copy(term.text(), '출력 복사됨') });
  const ask = el('button', { textContent: 'Claude 에게', title: '로그/스크립트/설정 경로를 복사 — Claude 에 붙여넣으면 바로 로그를 읽고 디버깅합니다', onclick: () => copy(runDebugText(t), 'Claude 용 디버깅 정보 복사됨 — 붙여넣기 하세요') });
  const nOpt = m.params.length + (m.secrets || []).length + (presets.length ? 1 : 0);
  const fold = el('button', { className: 'rv-fold', title: '옵션 접기/펼치기 (실행하면 자동으로 접힘)', onclick: () => setFold(!t.fold) });
  const top = el('div', { className: 'rv-top' },
    el('div', { className: 'rv-title' }, m.name, m.danger ? el('span', { className: 'danger', textContent: 'danger' }) : ''),
    el('div', { className: 'rv-desc', textContent: m.description || '(설명 없음)' }), fold, form, cmd, where,
    el('div', { className: 'rv-act' }, go, stop, clear, cp, ask, st));
  function setFold(v) { t.fold = !!v; top.classList.toggle('fold', t.fold); fold.textContent = (t.fold ? '▸ 옵션' : '▾ 옵션') + (nOpt ? ` (${nOpt})` : ''); }
  setFold(t.fold); drawWhere(); t.refreshWhere();
  const box = el('div', { className: 'rv' }, top, out);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } });
  paint(); t.dom = box; return box;
}
$('#btn-run-refresh').onclick = loadRun;
$('#btn-run-new').onclick = async () => {
  const name = (prompt('새 스크립트 이름 (영문/숫자/._-)') || '').trim(); if (!name) return;
  const lang = (prompt('언어: bash / python / node', 'bash') || 'bash').trim();
  try { const r = await api('POST', 'run/new', {}, { name, lang }); await loadRun(); openExternal(r.script); toast('스크립트를 만들었습니다 — 설명/파라미터/프리셋은 ' + name + '.yaml 에서 편집'); }
  catch (e) { toast(e.message); }
};


// ───────── DB: 연결 / 스키마 트리 / SQL 콘솔 ─────────
const dbUi = { conns: [], kinds: {}, open: new Set(), kids: new Map(), at: new Map(), names: new Map(), q: '', sel: '', n: 0 };   // at: 연결 → 캐시한 시각, names: 연결 → 검색용 테이블 목록
const KIND_ICON = { postgres: '🐘', mysql: '🐬', mariadb: '🦭', sqlite: '🪶', duckdb: '🦆', trino: '🔺' };
async function loadDb() {
  try { const r = await api('GET', 'db/connections'); dbUi.conns = r.connections; dbUi.kinds = r.kinds; }
  catch (e) { $('#db-list').replaceChildren(el('div', { className: 'dbr msg err', textContent: 'DB 목록을 읽지 못했습니다: ' + e.message })); return; }
  drawDb(); drawConsoles();
}
async function dbLoadKids(key, id, schema, table) {
  dbUi.kids.set(key, 'loading'); drawDb();
  try { const r = await api('GET', 'db/children', { id, ...(schema ? { schema } : {}), ...(table ? { table } : {}) }); dbUi.kids.set(key, r.items); if (!schema) dbUi.at.set(id, r.at); }
  catch (e) { dbUi.kids.set(key, { error: e.message, code: e.code }); }
  drawDb();
}
function dbToggle(key, load) {
  if (dbUi.open.has(key)) dbUi.open.delete(key); else { dbUi.open.add(key); if (!dbUi.kids.has(key) || dbUi.kids.get(key)?.error) load(); }
  drawDb();
}
function dbRow(depth, cls, arrow, icon, label, extra) {
  const r = el('div', { className: 'dbr ' + cls, style: `padding-left:${10 + depth * 14}px` }, el('span', { className: 'ar', textContent: arrow }), icon ? el('span', { textContent: icon }) : '', el('span', { className: 'nm', textContent: label, title: label }));
  if (extra) r.append(extra); return r;
}
function dbKidRows(key, depth, render) {
  const k = dbUi.kids.get(key); if (!dbUi.open.has(key)) return [];
  if (k === 'loading' || !k) return [dbRow(depth, 'msg', '', '', '불러오는 중…')];
  if (k.error) {
    const rows = [dbRow(depth, 'msg err', '', '', k.error)];
    if (k.code === 'NO_DRIVER') { const c = dbUi.conns.find((x) => key.split(':')[1] === x.id); if (c) rows.push(driverBtnRow(depth, c, () => dbLoadKids(key, ...key.split(':').slice(1).map((x, i) => (i === 0 ? c.id : x))))); }
    return rows;
  }
  if (!k.length) return [dbRow(depth, 'msg', '', '', '(비어 있음)')];
  return k.flatMap((i) => render(i));
}
function driverBtnRow(depth, c, after) {
  const b = el('button', { className: 'ib', textContent: '드라이버 설치' });
  b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; b.textContent = '설치 중… (최대 1~2분)'; try { await api('POST', 'db/driver', {}, { kind: c.kind }); toast(`${dbUi.kinds[c.kind]?.label} 드라이버 설치됨`); await loadDb(); after && after(); } catch (er) { b.disabled = false; b.textContent = '드라이버 설치'; toast(er.message); } };
  return el('div', { className: 'dbr msg', style: `padding-left:${10 + depth * 14}px` }, b);
}
function dbConnMenu(e, c) {   // 연결 우클릭 메뉴 (트리·검색 결과 공용)
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    ['새 SQL 콘솔', () => openSql(c)], ['연결 편집…', () => dbDialog(c)],
    ['새로고침 (DB 에서 다시 가져오기)', () => dbRefresh(c.id)],
    ...(dbUi.kinds[c.kind]?.pkg ? [[c.driver === 'missing' ? '드라이버 설치' : `드라이버 업데이트${c.driverVersion ? ` (현재 ${c.driverVersion})` : ''}`, async () => { try { toast('설치 중…'); const r = await api('POST', 'db/driver', {}, { kind: c.kind }); toast(`${dbUi.kinds[c.kind].pkg}${r.version ? '@' + r.version : ''} 설치됨${c.driver === 'missing' ? '' : ' · 앱을 다시 시작하면 적용'}`); loadDb(); } catch (er) { toast(er.message); } }]] : []),
    ['삭제…', async () => { if (!confirm(`연결 '${c.name}' 을(를) 삭제할까요? (저장된 비밀번호도 삭제)`)) return; try { await api('DELETE', 'db/connection', { id: c.id }); } catch (er) { toast(er.message); } loadDb(); }],
  ]);
}
function drawDb() {
  if (dbUi.q) return drawDbSearch();
  const box = $('#db-list'), rows = [];
  if (!dbUi.conns.length) rows.push(el('div', { className: 'git-empty', textContent: '연결이 없습니다. ＋ 로 PostgreSQL / MySQL / MariaDB / SQLite / DuckDB / Trino 연결을 추가하세요. 터미널: ss db add …' }));
  for (const c of dbUi.conns) {
    const ck = 'c:' + c.id, open = dbUi.open.has(ck);
    const row = dbRow(0, 'conn' + (dbUi.sel === ck ? ' sel' : ''), open ? '▼' : '▶', KIND_ICON[c.kind], c.name, el('span', { className: 'tg', textContent: (c.readOnly ? '🔒 ' : '') + (dbUi.kinds[c.kind]?.label || c.kind) }));
    row.title = (c.file || `${c.host}:${c.port}/${c.database || ''}`) + (dbUi.at.get(c.id) ? `\n목록 캐시: ${new Date(dbUi.at.get(c.id)).toLocaleString()} (우클릭 → 새로고침으로 다시 가져오기)` : '');
    row.onclick = () => { dbUi.sel = ck; dbToggle(ck, () => dbLoadKids(ck, c.id)); };
    row.ondblclick = () => openSql(c);
    row.oncontextmenu = (e) => dbConnMenu(e, c);
    rows.push(row);
    rows.push(...dbKidRows(ck, 1, (sc) => {
      const sk = `s:${c.id}:${sc.name}`;
      const sr = dbRow(1, dbUi.sel === sk ? 'sel' : '', dbUi.open.has(sk) ? '▼' : '▶', '📂', sc.name); sr.onclick = () => { dbUi.sel = sk; dbToggle(sk, () => dbLoadKids(sk, c.id, sc.name)); };
      return [sr, ...dbKidRows(sk, 2, (t) => {
        const tk = `t:${c.id}:${sc.name}:${t.name}`;
        const tr = dbRow(2, dbUi.sel === tk ? 'sel' : '', dbUi.open.has(tk) ? '▼' : '▶', t.type === 'view' ? '👁' : '▦', t.name);
        tr.onclick = () => { dbUi.sel = tk; dbToggle(tk, () => dbLoadKids(tk, c.id, sc.name, t.name)); };
        tr.ondblclick = async (e) => { e.preventDefault(); try { const q = (await api('GET', 'db/selectsql', { id: c.id, schema: sc.name, table: t.name })).sql; openSql(c, q, true, { schema: sc.name, table: t.name, sql: q }); } catch (er) { toast(er.message); } };
        tr.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, [['데이터 보기 (SELECT *)', () => tr.ondblclick(e)], ['이름 복사', () => copy(t.name, '복사됨')]]); };
        return [tr, ...dbKidRows(tk, 3, (col) => {
          const cr = dbRow(3, 'col', '', col.pk ? '🔑' : '·', col.name, el('span', { className: 'tp', textContent: ' ' + (col.dataType || '') + (col.nullable === false ? ' •' : '') }));
          cr.title = `${col.name}: ${col.dataType}${col.nullable === false ? ' NOT NULL' : ''}${col.pk ? ' (PK)' : ''}`; cr.ondblclick = () => copy(col.name, '컬럼 이름 복사됨'); return [cr];
        })];
      })];
    }));
  }
  box.replaceChildren(...rows);
}
// 새로고침: 서버의 메타데이터 캐시를 버리고, 열려 있는 노드만 DB 에서 다시 가져온다 (id 없으면 모든 연결)
async function dbRefresh(id) {
  try { await api('POST', 'db/cache/clear', {}, { id }); } catch (e) { return toast(e.message); }
  const mine = (k) => !id || k.split(':')[1] === id;
  for (const k of [...dbUi.kids.keys()]) if (mine(k)) dbUi.kids.delete(k);
  for (const x of [...dbUi.names.keys(), ...dbMeta.names.keys()]) if (!id || x === id) { dbUi.names.delete(x); dbMeta.names.delete(x); }
  for (const k of [...dbMeta.cols.keys()]) if (!id || k.startsWith(id + ':')) dbMeta.cols.delete(k);
  await loadDb();
  for (const k of [...dbUi.open].filter(mine)) { const [t, cid, sc, tb] = k.split(':'); dbLoadKids(k, cid, t !== 'c' ? sc : undefined, t === 't' ? tb : undefined); }
  if (dbUi.q) dbSearchLoad();
}
$('#btn-db-refresh').onclick = () => dbRefresh();

// ───────── DB 검색: 스키마 이름(불러온 것) + 테이블 이름(연결마다 한 번 가져와 캐시)에서 찾는다 ─────────
function dbSearchLoad() {
  for (const c of dbUi.conns) {
    if (dbUi.names.has(c.id)) continue;
    dbUi.names.set(c.id, 'loading');
    api('GET', 'db/names', { id: c.id }).then((r) => { dbUi.names.set(c.id, r.items); dbMeta.names.set(c.id, r.items); }, (e) => dbUi.names.set(c.id, { error: e.message })).then(() => dbUi.q && drawDb());
  }
}
function hlName(text, q) {   // 일치 부분을 <mark> 로
  const i = text.toLowerCase().indexOf(q); if (i < 0) return [text];
  return [text.slice(0, i), el('mark', { textContent: text.slice(i, i + q.length) }), text.slice(i + q.length)];
}
function drawDbSearch() {
  const box = $('#db-list'), rows = [], q = dbUi.q.toLowerCase(), MAX = 300;
  let first = null;
  for (const c of dbUi.conns) {
    const ns = dbUi.names.get(c.id), kids = dbUi.kids.get('c:' + c.id), hits = [];
    const schemas = new Set([...(Array.isArray(kids) ? kids.map((x) => x.name) : []), ...(Array.isArray(ns) ? ns.map((x) => x.schema) : [])]);
    for (const sc of schemas) if (String(sc).toLowerCase().includes(q)) hits.push({ schema: sc });
    if (Array.isArray(ns)) for (const t of ns) if (t.name.toLowerCase().includes(q) || `${t.schema}.${t.name}`.toLowerCase().includes(q)) hits.push(t);
    if (!hits.length && Array.isArray(ns) && !c.name.toLowerCase().includes(q)) continue;   // 연결 이름이 맞으면 결과가 없어도 보여 준다
    const cr = dbRow(0, 'conn', '', KIND_ICON[c.kind], c.name, el('span', { className: 'tg', textContent: Array.isArray(ns) ? `${hits.length.toLocaleString()}개` : '' }));
    cr.oncontextmenu = (e) => dbConnMenu(e, c); cr.ondblclick = () => openSql(c); rows.push(cr);
    if (ns === 'loading') rows.push(dbRow(1, 'msg', '', '', '테이블 목록 불러오는 중… (처음 한 번, 이후 캐시)'));
    else if (ns?.error) rows.push(dbRow(1, 'msg err', '', '', ns.error));
    for (const h of hits.slice(0, MAX)) {
      const r = h.name
        ? dbRow(1, '', '', h.type === 'view' ? '👁' : '▦', '')
        : dbRow(1, '', '', '📂', '');
      r.querySelector('.nm').replaceChildren(...(h.name ? [el('span', { className: 'sc', textContent: h.schema + '.' }), ...hlName(h.name, q)] : hlName(String(h.schema), q)));
      r.title = h.name ? `${h.schema}.${h.name}
클릭: 트리에서 보기 · 더블클릭: 데이터 보기` : `${h.schema}
클릭: 트리에서 보기`;
      r.onclick = () => dbReveal(c, h.schema, h.name);
      if (h.name) r.ondblclick = async () => { try { const sql = (await api('GET', 'db/selectsql', { id: c.id, schema: h.schema, table: h.name })).sql; openSql(c, sql, true, { schema: h.schema, table: h.name, sql }); } catch (er) { toast(er.message); } };
      r.oncontextmenu = (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, [['트리에서 보기', () => r.onclick()], ...(h.name ? [['데이터 보기 (SELECT *)', () => r.ondblclick()], ['이름 복사', () => copy(h.name, '복사됨')], ['스키마.테이블 복사', () => copy(`${h.schema}.${h.name}`, '복사됨')]] : [['이름 복사', () => copy(String(h.schema), '복사됨')]])]); };
      first ||= r; rows.push(r);
    }
    if (hits.length > MAX) rows.push(dbRow(1, 'msg', '', '', `… ${(hits.length - MAX).toLocaleString()}개 더 (검색어를 더 구체적으로)`));
  }
  if (!rows.length) rows.push(el('div', { className: 'git-empty', textContent: '일치하는 스키마/테이블이 없습니다' }));
  dbUi.first = first; box.replaceChildren(...rows);
}
async function dbReveal(c, schema, table) {   // 검색 결과 → 검색을 닫고 트리에서 펼쳐 선택
  const ck = 'c:' + c.id, sk = `s:${c.id}:${schema}`;
  dbUi.q = ''; $('#db-q').value = ''; dbUi.open.add(ck); dbUi.open.add(sk); dbUi.sel = table ? `t:${c.id}:${schema}:${table}` : sk;
  if (!Array.isArray(dbUi.kids.get(ck))) await dbLoadKids(ck, c.id);
  if (!Array.isArray(dbUi.kids.get(sk))) await dbLoadKids(sk, c.id, schema); else drawDb();
  $('#db-list .dbr.sel')?.scrollIntoView({ block: 'center' });
}
{
  let timer = 0; const inp = $('#db-q');
  inp.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { dbUi.q = inp.value.trim(); if (dbUi.q) dbSearchLoad(); drawDb(); }, 120); };
  inp.onkeydown = (e) => {
    if (e.key === 'Escape') { inp.value = ''; dbUi.q = ''; drawDb(); }
    else if (e.key === 'Enter' && dbUi.q) { e.preventDefault(); dbUi.first?.onclick(); }
  };
}
$('#btn-db-new').onclick = () => dbDialog(null);

// 연결 추가/편집 대화상자
function dbDialog(c) {
  const edit = !!c, v = { kind: 'postgres', readOnly: true, https: false, ssl: false, ...(c || {}) };
  const f = {};   // 입력 요소
  const mk = (name, label, input, hint) => { f[name] = input; const lab = el('label', { textContent: label }); const rows = [lab, input]; if (hint) rows.push(el('div', { className: 'hint', textContent: hint })); f[name + '_rows'] = rows; return rows; };
  const kind = el('select', {}, ...Object.entries(dbUi.kinds).map(([k, d]) => el('option', { value: k, textContent: d.label })));
  kind.value = v.kind; if (edit) kind.disabled = true;
  const txt = (val, ph, type = 'text') => el('input', { type, value: val ?? '', placeholder: ph || '' });
  const fr = el('div', { className: 'fr' });
  const add = (...a) => fr.append(...mk(...a));
  add('kind', '종류', kind);
  add('name', '이름', txt(v.name, '예: 운영 DB (읽기)'));
  add('host', 'Host', txt(v.host, 'localhost'));
  add('port', 'Port', txt(v.port, ''));
  add('user', '사용자', txt(v.user));
  add('password', '비밀번호', txt('', edit && c.hasPassword ? '(변경하지 않으려면 비워 두세요)' : '', 'password'), '~/.shooting-star/db/secrets.json (권한 0600)에 저장됩니다');
  add('database', 'Database', txt(v.database, 'Trino: schema, Catalog 를 비우면 catalog 또는 catalog/schema'));
  add('catalog', 'Catalog', txt(v.catalog, '선택 — 비우면 Database 칸(catalog[/schema]) 또는 모든 catalog'));
  add('schemas', '표시할 스키마', txt(v.schemas, '비우면 전부 · 예: sales, mart_*, !*_tmp'), '왼쪽 트리와 자동완성에 보일 스키마. 쉼표로 구분, * = 아무 글자, ! = 제외. SQL 실행에는 영향 없음');
  add('file', '파일', txt(v.file, '/경로/파일.db  (DuckDB 는 비우면 메모리)'));
  const chk = (val) => el('input', { type: 'checkbox', checked: !!val });
  add('ssl', 'SSL', chk(v.ssl)); add('https', 'HTTPS', chk(v.https));
  add('readOnly', '읽기 전용', chk(v.readOnly), '켜 두면 SELECT 류만 실행됩니다 (DB 엔진 수준에서도 차단). Claude/ss db 도 동일하게 적용');
  const res = el('div', { className: 'res' }), bg = el('div', { className: 'dlg-bg' });
  const sync = () => {
    const k = dbUi.kinds[kind.value] || {}, file = !!k.file, trino = kind.value === 'trino';
    const show = { host: !file, port: !file, user: !file, password: !file, database: !file, catalog: trino, schemas: kind.value !== 'sqlite', file, ssl: !file && !trino, https: trino };
    for (const n of Object.keys(show)) for (const e of f[n + '_rows']) e.hidden = !show[n];
    if (!file && !f.port.value) f.port.placeholder = k.port || '';
  };
  kind.onchange = sync; sync();
  const read = () => ({ id: c?.id, kind: kind.value, name: f.name.value.trim(), host: f.host.value.trim(), port: f.port.value.trim(), user: f.user.value, database: f.database.value.trim(), catalog: f.catalog.value.trim(), schemas: f.schemas.value.trim(), file: f.file.value.trim(), ssl: f.ssl.checked, https: f.https.checked, readOnly: f.readOnly.checked });
  const say = (cls, t) => { res.className = 'res ' + cls; res.textContent = t; };
  const test = el('button', { textContent: '연결 테스트' }), save = el('button', { className: 'go', textContent: '저장', style: 'background:var(--accent);color:var(--bg);border-color:var(--accent)' }), cancel = el('button', { textContent: '취소' });
  const withDriver = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (e.code !== 'NO_DRIVER') throw e;
      say('', `${dbUi.kinds[kind.value].label} 드라이버를 설치하는 중… (처음 한 번, 최대 1~2분)`);
      await api('POST', 'db/driver', {}, { kind: kind.value }); return await fn();
    }
  };
  test.onclick = async () => { test.disabled = true; say('', dbUi.kinds[kind.value]?.driver === 'missing' ? `${dbUi.kinds[kind.value].label} 드라이버를 자동 설치한 뒤 연결합니다… (처음 한 번, 최대 1~2분)` : '연결 중…'); try { const r = await withDriver(() => api('POST', 'db/test', {}, { conn: read(), password: f.password.value })); say('ok', `✓ 연결 성공 (${r.ms}ms)`); } catch (e) { say('err', e.message); } test.disabled = false; };
  save.onclick = async () => {
    try {
      const n = await api('PUT', 'db/connection', {}, { conn: read(), password: f.password.value }); bg.remove();
      for (const k of [...dbUi.kids.keys()]) if (k.split(':')[1] === n.id) dbUi.kids.delete(k);   // 설정(스키마 필터 등)이 바뀌었으니 트리·자동완성 캐시를 버린다
      dbMeta.names.delete(n.id); await loadDb(); if (dbUi.open.has('c:' + n.id)) dbLoadKids('c:' + n.id, n.id);
    } catch (e) { say('err', e.message); }
  };
  cancel.onclick = () => bg.remove();
  bg.onmousedown = (e) => { if (e.target === bg) bg.remove(); };
  bg.onkeydown = (e) => { if (e.key === 'Escape') bg.remove(); else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') save.onclick(); };
  bg.append(el('div', { className: 'dlg' }, el('h3', { textContent: edit ? '연결 편집' : '새 DB 연결' }), fr, res, el('div', { className: 'btns' }, test, el('span', { className: 'sp' }), cancel, save)));
  document.body.append(bg); (f.name.value ? f.host : f.name).focus();
}

// SQL 콘솔 탭
const READ_SQL = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(select|with|show|describe|desc|explain|pragma|values|table|from)\b/i;
const SQL_KW = ('SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET JOIN LEFT RIGHT INNER OUTER FULL CROSS ON AS AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS CASE WHEN THEN ELSE END DISTINCT UNION ALL INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW INDEX DROP ALTER ADD COLUMN PRIMARY KEY FOREIGN REFERENCES DEFAULT WITH EXPLAIN DESCRIBE SHOW COUNT SUM AVG MIN MAX COALESCE CAST ASC DESC TRUE FALSE USING OVER PARTITION').split(' ');
// ───────── SQL 콘솔 목록 (DB 패널 아래): 탭을 닫아도 SQL 과 함께 남아서 다시 열 수 있다. 목록에서 삭제해야 사라진다
var sqlCons, consReady = false;   // renderTabs 가 이 코드보다 먼저 불릴 수 있어 var + 지연 초기화
const CONS_MAX = 200;
const consList = () => (sqlCons ||= store.get('sqlConsoles', []));
let consTimer = 0;
const consSave = () => { clearTimeout(consTimer); consTimer = setTimeout(() => store.set('sqlConsoles', consList()), 300); };
function consPut(t) {   // 열린 콘솔 탭 → 목록에 반영 (없으면 맨 위에 추가)
  const L = consList(); let e = L.find((x) => x.path === t.path);
  if (!e) { e = { path: t.path, connId: t.connId, n: t.n }; L.unshift(e); }
  Object.assign(e, { sql: t.sql, meta: t.meta || null, at: Date.now() });
  while (L.length > CONS_MAX) { const i = L.findLastIndex((x) => !tabOf(x.path)); if (i < 0) break; L.splice(i, 1); }   // 넘치면 오래된 닫힌 콘솔부터 정리
  consSave();
}
async function consRemove(paths) {
  for (const p of paths) if (tabOf(p) && !(await closeTab(p))) return;
  sqlCons = consList().filter((x) => !paths.includes(x.path)); consSave(); drawConsoles();
}
function consOpen(e) {
  const c = dbUi.conns.find((x) => x.id === e.connId); if (!c) return toast('연결이 삭제되었습니다. SQL 복사 후 다른 연결에서 쓰세요');
  openSql(c, undefined, false, null, e.n);
}
function drawConsoles() {
  const box = $('#db-cons'); if (!box || !consReady) return;
  const L = consList(), open = L.filter((x) => tabOf(x.path)).length;
  $('#db-cons-head span').textContent = ['콘솔', open && `열림 ${open}`, L.length - open && `닫힘 ${L.length - open}`].filter(Boolean).join(' · ');
  if (box.hidden) return;
  if (!L.length) { box.replaceChildren(el('div', { className: 'dbr msg', textContent: '콘솔이 없습니다. 연결을 더블클릭하면 SQL 콘솔이 열립니다' })); return; }
  box.replaceChildren(...L.map((e) => {
    const c = dbUi.conns.find((x) => x.id === e.connId), isOpen = !!tabOf(e.path);
    const first = (e.sql || '').split('\n').map((l) => l.trim()).find(Boolean) || '(비어 있음)';
    const r = dbRow(0, 'cons' + (state.active === e.path ? ' sel' : '') + (isOpen ? ' open' : ''), '', isOpen ? '●' : '○', (c?.name || '(삭제된 연결)') + (e.n > 1 ? ' #' + e.n : ''), el('span', { className: 'pv', textContent: first }));
    r.title = `${isOpen ? '열림' : '닫힘'} · ${new Date(e.at || 0).toLocaleString()}\n\n${(e.sql || '').slice(0, 600)}\n\n클릭: ${isOpen ? '탭으로 이동' : '다시 열기'} · 우클릭: 닫기/삭제`;
    r.onclick = () => consOpen(e);
    r.oncontextmenu = (ev) => {
      ev.preventDefault();
      showMenu(ev.clientX, ev.clientY, [
        [isOpen ? '탭으로 이동' : '다시 열기', () => consOpen(e)],
        ...(isOpen ? [['탭 닫기 (목록에는 남김)', () => closeTab(e.path)]] : []),
        ['SQL 복사', () => copy(e.sql || '', 'SQL 복사됨')],
        ['삭제', () => consRemove([e.path])],
      ]);
    };
    return r;
  }));
}
$('#db-cons-head').onclick = (e) => { if (e.target.closest('button')) return; const b = $('#db-cons'); b.hidden = !b.hidden; store.set('consHidden', b.hidden); $('#db-cons-head').classList.toggle('folded', b.hidden); drawConsoles(); };
$('#btn-cons-clean').onclick = () => { const closed = consList().filter((x) => !tabOf(x.path)).map((x) => x.path); if (!closed.length) return toast('닫힌 콘솔이 없습니다'); if (confirm(`닫힌 콘솔 ${closed.length}개를 목록에서 삭제할까요?`)) consRemove(closed); };
if (store.get('consHidden', false)) { $('#db-cons').hidden = true; $('#db-cons-head').classList.add('folded'); }
consReady = true; drawConsoles();

const dbMeta = { names: new Map(), cols: new Map() };   // 자동완성 캐시: 연결 → 테이블 이름들 / '연결:스키마.테이블' → 컬럼들
function dbNamesOf(id, again) {
  if (!dbMeta.names.has(id)) { dbMeta.names.set(id, []); api('GET', 'db/names', { id }).then((r) => { dbMeta.names.set(id, r.items); again && again(); }).catch(() => {}); }
  return dbMeta.names.get(id);
}
function dbColsOf(id, schema, table, again) {
  const k = `${id}:${schema}.${table}`;
  if (!dbMeta.cols.has(k)) { dbMeta.cols.set(k, []); api('GET', 'db/children', { id, schema, table }).then((r) => { dbMeta.cols.set(k, r.items); again && again(); }).catch(() => {}); }
  return dbMeta.cols.get(k);
}
function sqlRefs(text, names) {   // FROM / JOIN / UPDATE / INTO 뒤의 테이블 (별칭 포함)
  const refs = [], re = /\b(?:from|join|update|into)\s+([\w."`]+)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi; let m;
  while ((m = re.exec(text))) {
    const parts = m[1].replace(/["`]/g, '').split('.'), table = parts.pop(), schema = parts.pop();
    const hit = names.find((n) => n.name.toLowerCase() === table.toLowerCase() && (!schema || n.schema.toLowerCase() === schema.toLowerCase() || n.schema.toLowerCase().endsWith('.' + schema.toLowerCase())));
    if (hit) refs.push({ schema: hit.schema, table: hit.name, alias: m[2] && !SQL_KW.includes(m[2].toUpperCase()) ? m[2] : null });
  }
  return refs;
}
function sqlCandidates(t, text, caret, manual, again) {
  const m = /(?:([\w$"`]+)\.)?([\w$]*)$/.exec(text.slice(0, caret)), qual = m[1]?.replace(/["`]/g, ''), frag = m[2] || '';
  if (!manual && !qual && !frag) return { items: [], frag };
  const names = dbNamesOf(t.connId, again), refs = sqlRefs(text, names), f = frag.toLowerCase(), out = [];
  const ok = (s) => !f || s.toLowerCase().startsWith(f);
  const colsOf = (r) => dbColsOf(t.connId, r.schema, r.table, again).map((c) => ({ label: c.name, insert: c.name, kind: 'col', detail: `${r.alias || r.table} · ${c.dataType || ''}` }));
  if (qual) {
    const ql = qual.toLowerCase(), hit = refs.filter((r) => (r.alias || '').toLowerCase() === ql || r.table.toLowerCase() === ql);
    if (hit.length) out.push(...hit.flatMap(colsOf));
    else { const tabs = names.filter((n) => n.schema.toLowerCase() === ql); out.push(...tabs.map((n) => ({ label: n.name, insert: n.name, kind: n.type === 'view' ? 'view' : 'tbl', detail: n.schema }))); const tn = names.find((n) => n.name.toLowerCase() === ql); if (tn) out.push(...colsOf({ schema: tn.schema, table: tn.name })); }
  } else {
    out.push(...refs.flatMap(colsOf));
    out.push(...names.map((n) => ({ label: n.name, insert: n.name, kind: n.type === 'view' ? 'view' : 'tbl', detail: n.schema })));
    out.push(...SQL_KW.map((k) => ({ label: k, insert: /[a-z]/.test(frag) && frag === frag.toLowerCase() ? k.toLowerCase() : k, kind: 'kw', detail: '' })));
  }
  const seen = new Set(), items = [];
  for (const c of out) { const key = c.kind + c.label; if (seen.has(key) || !ok(c.label) || (c.label.toLowerCase() === f && c.kind !== 'col')) continue; seen.add(key); items.push(c); if (items.length >= 14) break; }
  return { items, frag };
}
function caretXY(ta, pos) {   // textarea 안의 커서 위치(픽셀)를 거울 요소로 계산
  const d = document.createElement('div'), cs = getComputedStyle(ta);
  for (const p of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'whiteSpace', 'boxSizing']) d.style[p] = cs[p];
  Object.assign(d.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', width: ta.clientWidth + 'px' });
  d.textContent = ta.value.slice(0, pos); const sp = document.createElement('span'); sp.textContent = '​'; d.append(sp); document.body.append(d);
  const r = { x: sp.offsetLeft - ta.scrollLeft, y: sp.offsetTop - ta.scrollTop, h: parseFloat(cs.lineHeight) || 18 }; d.remove(); return r;
}
function openSql(c, sql, run, meta, n) {   // n: 콘솔 번호를 지정해 다시 열기 (콘솔 목록에서)
  const pathOf = (k) => `@sql/${c.id}/${k}`;
  if (n === undefined) { n = 1; if (sql !== undefined) while (tabOf(pathOf(n)) || consList().some((x) => x.path === pathOf(n))) n++; }   // 같은 연결의 콘솔 1 은 재사용하고, 쿼리를 들고 열면 새 콘솔
  const p = pathOf(n), saved = consList().find((x) => x.path === p); let t = tabOf(p);
  if (!t) { t = { path: p, kind: 'sql', connId: c.id, connName: c.name, readOnly: c.readOnly, n, content: '', orig: '', mtime: 0, mode: 'view', sql: sql ?? saved?.sql ?? store.get('sql:' + c.id, ''), res: null, limit: store.get('sqlLimit', 1000), running: false, meta: meta || saved?.meta || null, pend: new Map() }; state.tabs.push(t); }
  else if (sql !== undefined) { t.sql = sql; if (meta) t.meta = meta; }
  consPut(t);
  state.active = p; state.selected = p; renderAll();
  if (t.dom) { const ta = t.dom.querySelector('textarea'); ta.value = t.sql; ta.dispatchEvent(new Event('input')); }
  if (run && t.run) t.run();
}
function sqlView(t) {
  if (t.dom) return t.dom;
  const ta = el('textarea', { className: 'editor hlon', value: t.sql, spellcheck: false, placeholder: 'SELECT …   (⌘/Ctrl+Enter: 실행 · 선택한 부분만 실행 · Ctrl+Space: 자동완성)' });
  const pre = el('pre', { className: 'hl', ariaHidden: 'true' });
  const paint = () => { pre.innerHTML = highlight('sql', ta.value) + '\n'; pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; };
  ta.onscroll = () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; closeAc(); };
  const edwrap = el('div', { className: 'sq-edwrap' }, el('div', { className: 'ed' }, pre, ta));
  const out = el('div', { className: 'sq-res' }), st = el('span', { className: 'st' });
  const go = el('button', { className: 'go', textContent: '▶ 실행', title: '실행 (⌘/Ctrl+Enter)' }), stop = el('button', { textContent: '■ 취소', hidden: true });
  const lim = el('select', { title: '한 쪽에 가져올 행 수 (SELECT 에 자동으로 LIMIT/OFFSET 적용)' }, ...[50, 100, 500, 1000, 5000, 20000].map((n) => el('option', { value: n, textContent: n.toLocaleString() + '행/쪽' }))); lim.value = String(t.limit); lim.onchange = () => { t.limit = Number(lim.value); store.set('sqlLimit', t.limit); };

  // ── 자동완성
  let ac = null;   // { box, items, sel, frag }
  const closeAc = () => { if (ac) { ac.box.remove(); ac = null; } };
  const acApply = (c) => {
    const frag = ac.frag; closeAc(); ta.focus();
    ta.setSelectionRange(ta.selectionStart - frag.length, ta.selectionStart); document.execCommand('insertText', false, c.insert);
  };
  const acShow = (manual) => {
    if (ta.selectionStart !== ta.selectionEnd) return closeAc();
    const again = () => { if (document.activeElement === ta) acShow(manual); };
    const { items, frag } = sqlCandidates(t, ta.value, ta.selectionStart, manual, again);
    if (!items.length) return closeAc();
    const prevSel = ac && ac.items.length === items.length ? ac.sel : 0; closeAc();
    const box = el('div', { className: 'ac' }); ac = { box, items, sel: prevSel, frag };
    items.forEach((c, i) => { const r = el('div', { className: 'it' + (i === ac.sel ? ' sel' : '') }, el('span', { className: 'k k-' + c.kind, textContent: { col: '▪', tbl: '▦', view: '👁', kw: 'k' }[c.kind] }), el('span', { className: 'l', textContent: c.label }), el('span', { className: 'd', textContent: c.detail })); r.onmousedown = (e) => { e.preventDefault(); acApply(c); }; box.append(r); });
    document.body.append(box);
    const r = ta.getBoundingClientRect(), p = caretXY(ta, ta.selectionStart - frag.length);
    box.style.left = Math.max(4, Math.min(window.innerWidth - box.offsetWidth - 8, r.left + p.x)) + 'px';
    const below = r.top + p.y + p.h + 2; box.style.top = (below + box.offsetHeight > window.innerHeight - 8 ? Math.max(4, r.top + p.y - box.offsetHeight - 2) : below) + 'px';
  };
  const acMove = (d) => { ac.sel = (ac.sel + d + ac.items.length) % ac.items.length; [...ac.box.children].forEach((e, i) => e.classList.toggle('sel', i === ac.sel)); ac.box.children[ac.sel].scrollIntoView({ block: 'nearest' }); };

  // ── 결과 그리드 (+ 셀 편집)
  const editable = () => !!t.meta && !t.readOnly && t.lastSql === t.meta.sql && t.pk && t.pk.length && t.res && t.pk.every((k) => t.res.columns.includes(k));
  const pend = () => t.pend;
  const apply = el('button', { textContent: '변경 적용', hidden: true }), revert = el('button', { textContent: '되돌리기', hidden: true }), hint = el('span', { className: 'st', hidden: true });
  const prev = el('button', { textContent: '◀', title: '이전 쪽' }), next = el('button', { textContent: '▶', title: '다음 쪽' }), total = el('button', { textContent: '총 행 수', title: '전체 행 수 세기 (count(*))' }), pager = el('span', { className: 'pg', hidden: true }, prev, next, total);
  const paintPager = () => {
    const r = t.res, on = !!r && r.columns.length && (r.paged || r.offset > 0); pager.hidden = !on; if (!on) return;
    prev.disabled = t.running || !r.offset; next.disabled = t.running || !r.hasMore;
    total.textContent = t.total != null ? `총 ${t.total.toLocaleString()}행 · ${Math.max(1, Math.ceil(t.total / t.limit)).toLocaleString()}쪽` : '총 행 수'; total.disabled = t.total != null;
  };
  prev.onclick = () => t.run((t.page || 0) - 1); next.onclick = () => t.run((t.page || 0) + 1);
  total.onclick = async () => { total.disabled = true; total.textContent = '세는 중…'; try { t.total = (await api('POST', 'db/count', {}, { id: t.connId, sql: t.lastSql })).count; } catch (e) { toast(e.message); } paintPager(); };
  const paintEdits = () => { paintPager(); const n = pend().size; apply.hidden = revert.hidden = !n; apply.textContent = `변경 ${n}건 적용`; hint.hidden = !editable() || !!n; hint.textContent = '✎ 셀을 더블클릭해 수정'; };
  const cell = (v, ri, ci) => {
    const key = ri + ':' + ci, ch = pend().get(key), val = ch ? ch.value : v, td = el('td');
    if (val === null) { td.className = 'nl'; td.textContent = 'NULL'; } else { const x = String(val); td.textContent = x.length > 300 ? x.slice(0, 300) + '…' : x; if (x.length > 60) td.title = x.slice(0, 2000); if (typeof val === 'number') td.className = 'nu'; }
    if (ch) td.classList.add('dirty');
    td.dataset.r = ri; td.dataset.c = ci; return td;
  };
  const setCell = (ri, ci, value) => {
    const orig = t.res.rows[ri][ci], key = ri + ':' + ci;
    if (value === (orig === null ? null : orig) || (value !== null && orig !== null && String(orig) === value) || (orig === null && value === '')) pend().delete(key); else pend().set(key, { row: ri, col: ci, value });
    drawGrid();
  };
  const editCell = (td) => {
    if (!editable()) return; const ri = +td.dataset.r, ci = +td.dataset.c, ch = pend().get(ri + ':' + ci), cur = ch ? ch.value : t.res.rows[ri][ci];
    const inp = el('input', { type: 'text', value: cur === null ? '' : String(cur), placeholder: 'NULL' }); td.className = 'ed'; td.replaceChildren(inp); inp.focus(); inp.select();
    let done = false; const fin = (ok) => { if (done) return; done = true; if (ok) setCell(ri, ci, inp.value); else drawGrid(); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); fin(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fin(false); } e.stopPropagation(); };
    inp.onblur = () => fin(true);
  };
  const drawGrid = () => {
    const r = t.res; paintEdits(); if (!r) return;
    if (!r.columns.length) { out.replaceChildren(el('div', { className: 'msg', textContent: `✓ 실행 완료${r.affected != null ? ` — ${r.affected}행 영향` : ''}` })); return; }
    const tbl = el('table', { className: 'grid' + (editable() ? ' editable' : '') }, el('thead', {}, el('tr', {}, el('th', { textContent: '#' }), ...r.columns.map((c) => el('th', { textContent: c, title: t.pk?.includes(c) ? 'PK' : '' })))));
    const body = el('tbody'); r.rows.forEach((row, ri) => body.append(el('tr', {}, el('td', { className: 'rn', textContent: (r.offset || 0) + ri + 1 }), ...row.map((v, ci) => cell(v, ri, ci))))); tbl.append(body);
    tbl.ondblclick = (e) => { const td = e.target.closest('td[data-c]'); if (td) editCell(td); };
    tbl.oncontextmenu = (e) => {
      const td = e.target.closest('td[data-c]'); if (!td) return; e.preventDefault();
      const ri = +td.dataset.r, ci = +td.dataset.c, v = pend().get(ri + ':' + ci)?.value ?? r.rows[ri][ci];
      showMenu(e.clientX, e.clientY, [['값 복사', () => copy(v === null ? '' : String(v), '값 복사됨')], ['행을 JSON 으로 복사', () => copy(JSON.stringify(Object.fromEntries(r.columns.map((c, i) => [c, r.rows[ri][i]])), null, 2), 'JSON 복사됨')],
        ...(editable() ? [['셀 편집', () => editCell(td)], ['NULL 로 설정', () => setCell(ri, ci, null)]] : [])]);
    };
    out.replaceChildren(r.rows.length ? tbl : el('div', { className: 'msg', textContent: `결과 없음 (${r.columns.join(', ')})` }));
  };
  const show = (r) => { t.res = r; t.pend = new Map(); drawGrid(); };
  const paintBtns = () => { go.disabled = t.running; stop.hidden = !t.running; paintPager(); };
  t.run = async (page) => {   // page 가 없으면 새 실행(편집기의 SQL, 1쪽), 있으면 같은 SQL 의 그 쪽
    if (t.running) return; closeAc();
    if (pend().size && !confirm('적용하지 않은 셀 변경이 있습니다. 버리고 계속할까요?')) return;
    let sql;
    if (page === undefined) {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd); sql = (sel.trim() ? sel : ta.value).trim(); page = 0;
      t.sql = ta.value; consPut(t);
      if (!sql) return;
      if (!t.readOnly && !READ_SQL.test(sql) && !confirm('데이터를 변경할 수 있는 쿼리입니다. 실행할까요?\n\n' + sql.slice(0, 300))) return;
      t.total = null;
    } else sql = t.lastSql;
    t.running = true; t.lastSql = sql; paintBtns(); st.className = 'st'; st.textContent = '실행 중…';
    try {
      if (t.meta && !t.pk && !t.readOnly) { try { t.pk = (await api('GET', 'db/keys', { id: t.connId, schema: t.meta.schema, table: t.meta.table })).pk; } catch { t.pk = []; } }
      const r = await api('POST', 'db/query', {}, { id: t.connId, sql, limit: t.limit, offset: page * t.limit }); t.page = page; show(r);
      st.className = 'st ok'; st.textContent = r.columns.length ? `${r.rows.length ? `${(r.offset + 1).toLocaleString()}–${(r.offset + r.rows.length).toLocaleString()}행` : '0행'}${r.hasMore && !r.paged ? ' (잘림 · 페이징 불가)' : ''} · ${r.ms}ms` : `완료 · ${r.ms}ms`;
      if (t.meta && !t.readOnly && t.pk && !t.pk.length) { hint.hidden = false; hint.textContent = 'PK 가 없어 편집할 수 없습니다'; }
    } catch (e) {
      st.className = 'st err'; st.textContent = '오류'; out.replaceChildren(el('div', { className: 'msg err', textContent: e.message })); t.res = null; paintEdits();
      if (e.code === 'NO_DRIVER') { const c = dbUi.conns.find((x) => x.id === t.connId); if (c) { const b = el('button', { textContent: '드라이버 설치 후 다시 실행' }); b.onclick = async () => { b.disabled = true; b.textContent = '설치 중…'; try { await api('POST', 'db/driver', {}, { kind: c.kind }); loadDb(); t.running = false; t.run(); } catch (er) { toast(er.message); b.disabled = false; } }; out.append(b); } }
    }
    t.running = false; paintBtns();
  };
  go.onclick = () => t.run();
  stop.onclick = async () => { try { const r = await api('POST', 'db/cancel', {}, { id: t.connId }); if (!r.ok) toast(r.note || '취소할 쿼리가 없습니다'); } catch (e) { toast(e.message); } };
  revert.onclick = () => { t.pend = new Map(); drawGrid(); };
  apply.onclick = async () => {
    if (!editable() || !pend().size) return;
    const rows = new Map(); for (const ch of pend().values()) { if (!rows.has(ch.row)) rows.set(ch.row, { pk: Object.fromEntries(t.pk.map((k) => [k, t.res.rows[ch.row][t.res.columns.indexOf(k)]])), set: {} }); rows.get(ch.row).set[t.res.columns[ch.col]] = ch.value; }
    if (!confirm(`${t.connName}.${t.meta.table}: ${pend().size}개 셀(${rows.size}행)을 UPDATE 합니다. 한 트랜잭션으로 적용되고, 한 행이라도 1행이 아니면 전부 취소됩니다.`)) return;
    apply.disabled = true;
    try { const r = await api('POST', 'db/update', {}, { id: t.connId, schema: t.meta.schema, table: t.meta.table, changes: [...rows.values()] }); toast(`${r.applied}행 수정됨`); t.pend = new Map(); await t.run(t.page || 0); }
    catch (e) { st.className = 'st err'; st.textContent = e.message.slice(0, 120); toast(e.message); }
    apply.disabled = false;
  };

  // ── 기록
  const histBtn = el('button', { textContent: '기록', title: '이 연결에서 실행한 쿼리 (최근 순)' });
  let hist = null;
  const closeHist = () => { if (hist) { hist.remove(); hist = null; } };
  const loadHist = async (q) => {
    let items = []; try { items = (await api('GET', 'db/history', { id: t.connId, limit: 100, ...(q ? { q } : {}) })).items; } catch (e) { toast(e.message); }
    const list = hist.querySelector('.hl-list'); if (!list) return;
    list.replaceChildren(...(items.length ? items.map((h) => {
      const row = el('div', { className: 'hi' + (h.ok ? '' : ' bad'), title: h.sql.slice(0, 1500) + (h.err ? '\n\n⚠ ' + h.err : '') }, el('div', { className: 'hs', textContent: h.sql.replace(/\s+/g, ' ').trim().slice(0, 200) }), el('div', { className: 'hm', textContent: `${h.ok ? '✓' : '✗'} ${new Date(h.t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${h.ms}ms${h.rows != null ? ' · ' + h.rows + '행' : ''}${h.src && h.src !== 'ui' ? ' · ' + h.src : ''}` }));
      row.onclick = () => { ta.value = h.sql; ta.dispatchEvent(new Event('input')); closeHist(); ta.focus(); };
      row.ondblclick = () => { closeHist(); t.run(); };
      return row;
    }) : [el('div', { className: 'hi', textContent: '기록이 없습니다' })]));
  };
  histBtn.onclick = (e) => {
    e.stopPropagation(); if (hist) return closeHist();
    const q = el('input', { type: 'text', placeholder: '검색…' }); q.oninput = () => loadHist(q.value.trim());
    hist = el('div', { className: 'sq-hist' }, q, el('div', { className: 'hl-list' }), el('div', { className: 'hn', textContent: '클릭: 편집기에 넣기 · 더블클릭: 바로 실행 · 읽기 전용 연결에서 쓰기 쿼리는 실행되지 않습니다' }));
    hist.onclick = (ev) => ev.stopPropagation(); box.append(hist); q.focus(); loadHist('');
  };

  ta.addEventListener('input', () => { t.sql = ta.value; consPut(t); paint(); if (document.activeElement === ta) acShow(false); });
  ta.addEventListener('blur', () => setTimeout(closeAc, 120));
  ta.addEventListener('click', closeAc);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); t.run(); return; }
    if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); acShow(true); return; }
    if (ac) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return acMove(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return acMove(-1); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return acApply(ac.items[ac.sel]); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeAc(); }
    }
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  const csvBtn = el('button', { textContent: 'CSV 복사', onclick: () => { if (!t.res?.columns.length) return; const q = (v) => (v === null ? '' : /[",\n\t]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)); copy([t.res.columns, ...t.res.rows].map((r) => r.map(q).join(',')).join('\n'), 'CSV 복사됨'); } });
  const bar = el('div', { className: 'sq-bar' }, go, stop, lim, pager, csvBtn, histBtn, st, hint, apply, revert, el('span', { className: 'sp' }), el('span', { className: 'st', textContent: (t.readOnly ? '🔒 읽기 전용 · ' : '') + t.connName }));
  const box = el('div', { className: 'sq' }, edwrap, bar, out);
  box.addEventListener('click', closeHist);
  // 실행 버튼 줄을 위아래로 끌어 편집기/결과 높이를 조절 (버튼·입력 위가 아닌 빈 곳에서). 높이는 기억해 두고 다른 콘솔에도 적용
  const edH = store.get('sqlEdH', 0); if (edH) edwrap.style.height = edH + 'px';
  bar.title = '빈 곳을 위아래로 끌면 편집기/결과 높이 조절 · 더블클릭: 기본 높이';
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button, select, input, a, .pg')) return;
    e.preventDefault();
    const y0 = e.clientY, h0 = edwrap.offsetHeight, max = box.clientHeight - bar.offsetHeight - 60;
    document.body.classList.add('row-resizing');
    const move = (ev) => { edwrap.style.height = Math.max(70, Math.min(max, h0 + ev.clientY - y0)) + 'px'; };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('row-resizing'); store.set('sqlEdH', edwrap.offsetHeight); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  bar.addEventListener('dblclick', (e) => { if (e.target.closest('button, select, input, a, .pg')) return; edwrap.style.height = ''; store.set('sqlEdH', 0); });
  if (t.res) show(t.res); else paintEdits();
  t.dom = box; paintBtns(); paint();
  setTimeout(() => ta.focus(), 0);
  return box;
}

// ───────── 아이콘 바: 파일 / 메모 ─────────
function setView(v, forceShow) {
  state.view = v; store.set('view', v);
  $('#sidebar').classList.toggle('memo', v === 'memo');
  $('#sidebar').classList.toggle('git', v === 'git');
  $('#sidebar').classList.toggle('run', v === 'run');
  $('#sidebar').classList.toggle('db', v === 'db');
  $('#db-view').hidden = v !== 'db';
  $('#run-view').hidden = v !== 'run';
  $('#memo-view').hidden = v !== 'memo';
  $('#git-view').hidden = v !== 'git';
  document.querySelectorAll('#activity .act').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  if (forceShow) document.body.classList.remove('no-side');
  if (v === 'git') loadGit();
  if (v === 'run') loadRun();
  if (v === 'db') loadDb();
  if (v === 'memo') { $('#memo-path').textContent = (state.memoDir || '').replace(state.home || '\u0000', '~'); loadMemos(); }
}
document.querySelectorAll('#activity .act').forEach((b) => {
  b.onclick = () => { // 활성 아이콘을 다시 누르면 사이드바 접기/펼치기 (VS Code 와 동일)
    if (state.view === b.dataset.view) { document.body.classList.toggle('no-side'); store.set('noSide', document.body.classList.contains('no-side')); }
    else { setView(b.dataset.view, true); store.set('noSide', false); }
  };
});

// ───────── 문서 안에서 찾기 (⌘/Ctrl+F) ─────────
// 편집기: 원문에서 찾아 입력창 뒤의 표시 레이어(pre.fm)에 모든 일치를 칠한다. 보기 모드(마크다운/CSV/트리): 화면 텍스트에서 직접 찾아 <mark> 로 감싼다.
const fb = { open: false, q: '', matches: [], idx: -1, dom: false, built: false, timer: 0, opts: store.get('fbopts', { case: false, word: false, regex: false }) };
const FIND_ROOTS = '#preview, .smart-doc, .dvbox, .hv-detail, .blv, .rv-out';   // 보기 모드에서 화면 텍스트를 찾는 영역 (diff 포함)
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function fbRegex() {
  if (!fb.q) return null;
  let src = fb.opts.regex ? fb.q : fb.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (fb.opts.word) src = `\\b(?:${src})\\b`;
  try { return new RegExp(src, fb.opts.case ? 'g' : 'gi'); } catch { return 'bad'; }
}
function buildFileFind() {
  if (fb.built) return; fb.built = true;
  const bar = $('#fbar');
  const q = el('input', { id: 'fb-q', placeholder: '파일에서 찾기…', autocomplete: 'off', spellcheck: false });
  const btn = (txt, title, fn) => { const b = el('button', { textContent: txt, title }); b.onclick = fn; return b; };
  const tg = (key, label, title) => {
    const b = el('button', { textContent: label, title, className: 'tg' + (fb.opts[key] ? ' on' : '') });
    b.onclick = () => { fb.opts[key] = !fb.opts[key]; b.classList.toggle('on', fb.opts[key]); store.set('fbopts', fb.opts); runFileFind(true); q.focus(); };
    return b;
  };
  bar.append(q, el('span', { id: 'fb-count' }), btn('↑', '이전 (Shift+Enter)', () => stepFind(-1)), btn('↓', '다음 (Enter)', () => stepFind(1)),
    tg('case', 'Cc', '대소문자 구분'), tg('word', 'W', '단어 단위'), tg('regex', '.*', '정규식'), btn('✕', '닫기 (Esc)', closeFileFind));
  q.oninput = () => { fb.q = q.value; clearTimeout(fb.timer); fb.timer = setTimeout(() => runFileFind(true), 100); };
  q.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFileFind(); }
  };
}
const placeFindBar = () => { $('#fbar').style.top = ($('#content').offsetTop + 8) + 'px'; };
function openFileFind() {
  if (!cur() || cur().kind === 'image') return;
  buildFileFind();
  const ta = $('textarea.editor'); let sel = '';
  if (ta && ta.selectionEnd > ta.selectionStart) sel = ta.value.slice(ta.selectionStart, ta.selectionEnd); else sel = String(getSelection());
  const q = $('#fb-q');
  if (sel && !sel.includes('\n') && sel.length < 200) q.value = sel; else if (!q.value) q.value = store.get('fbq', '');
  fb.q = q.value; fb.open = true; $('#fbar').hidden = false; placeFindBar(); q.focus(); q.select();
  runFileFind(true);
}
function closeFileFind() {
  if (!fb.open) return;
  const m = fb.matches[fb.idx], ta = $('textarea.editor'), wasDom = fb.dom;
  fb.open = false; $('#fbar').hidden = true; clearFindMarks(); fb.matches = []; fb.idx = -1;
  if (ta) { ta.focus(); if (m && !wasDom) ta.setSelectionRange(m.s, m.e); }   // 닫으면 현재 일치를 선택한 채 편집기로 돌아간다
}
function clearFindMarks() {
  const fm = $('pre.fm'); if (fm) fm.textContent = '';
  document.querySelectorAll(FIND_ROOTS.replace(/,|$/g, ' mark.fmd$&')).forEach((m) => m.replaceWith(m.textContent));
  $(FIND_ROOTS)?.normalize();
}
// 화면(DOM) 텍스트에서 찾아 <mark> 로 감싼다. 반환: mark 요소 배열
function markDom(root, re0, limit = 5000) {
  const re = new RegExp(re0.source, re0.flags), marks = [], nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('button, script, style, .dv td.ln') || !n.data.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);   // 순회 중에 DOM 을 바꾸지 않도록 먼저 수집
  for (const n of nodes) {
    if (marks.length >= limit) break;
    re.lastIndex = 0; const text = n.data; let m, p = 0, frag = null;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      frag ||= document.createDocumentFragment();
      const mk = el('mark', { className: 'fmd', textContent: m[0] });
      frag.append(text.slice(p, m.index), mk); marks.push(mk); p = m.index + m[0].length;
    }
    if (frag) { frag.append(text.slice(p)); n.replaceWith(frag); }
  }
  return marks;
}
function runFileFind(fresh) { // fresh=false: 내용이 바뀌어 표시만 다시 (입력 중엔 일치 위치로 스크롤하지 않는다)
  if (!fb.open) return;
  store.set('fbq', fb.q);
  const ta = $('textarea.editor'), pv = $(FIND_ROOTS), re = fbRegex();
  clearFindMarks(); fb.matches = [];
  if (!re || re === 'bad') { fb.idx = -1; return drawFindCount(re); }
  if (ta) { // 편집기(편집/분할): 원문 기준
    fb.dom = false; const r = new RegExp(re.source, re.flags), text = ta.value; let m;
    while ((m = r.exec(text)) && fb.matches.length < 10000) { if (!m[0]) { r.lastIndex++; continue; } fb.matches.push({ s: m.index, e: m.index + m[0].length }); }
    const at = fresh ? ta.selectionStart : 0, first = fb.matches.findIndex((x) => x.e > at);
    fb.idx = fresh ? (first < 0 ? 0 : first) : Math.min(fb.idx, fb.matches.length - 1);
    if (pv) markDom(pv, re);   // 분할 모드: 미리보기에도 같이 표시 (이동은 편집기 기준)
  } else if (pv) { // 보기 모드: 화면 텍스트 기준
    fb.dom = true; fb.matches = markDom(pv, re);
    fb.idx = fresh || fb.idx < 0 ? 0 : Math.min(fb.idx, fb.matches.length - 1);
  }
  if (!fb.matches.length) fb.idx = -1; else if (fb.idx < 0) fb.idx = 0;
  gotoFind(fb.idx, fresh);
}
function drawFindCount(re) {
  const c = $('#fb-count'); const n = fb.matches.length;
  c.classList.toggle('none', (!!fb.q && !n) || re === 'bad');
  c.textContent = re === 'bad' ? '정규식 오류' : !fb.q ? '' : n ? `${fb.idx + 1}/${n}${n >= 10000 ? '+' : ''}` : '결과 없음';
}
function gotoFind(i, scroll = true) {
  const n = fb.matches.length; fb.idx = n ? ((i % n) + n) % n : -1; drawFindCount();
  const m = fb.matches[fb.idx]; if (!m) { renderFM(); return; }
  if (fb.dom) {
    document.querySelectorAll(FIND_ROOTS.replace(/,|$/g, ' mark.fmd.cur$&')).forEach((x) => x.classList.remove('cur'));
    m.classList.add('cur'); if (scroll) m.scrollIntoView({ block: 'center', inline: 'nearest' });
  } else {
    renderFM(); if (!scroll) return;
    const ta = $('textarea.editor'), lines = ta.value.slice(0, m.s).split('\n');
    taScrollTo(ta, ta.value.split('\n'), lines.length, lines.at(-1).length);
  }
}
const stepFind = (d) => { if (fb.matches.length) gotoFind(fb.idx + d); };
function renderFM() { // 입력창 뒤 레이어: 모든 일치(+현재 일치)를 칠한다
  const fm = $('pre.fm'), ta = $('textarea.editor'); if (!fm || !ta) return;
  if (!fb.open || fb.dom || !fb.matches.length) { fm.textContent = ''; return; }
  const text = ta.value; let out = '', p = 0;
  fb.matches.forEach((m, i) => { out += escHtml(text.slice(p, m.s)) + `<mark class="fm${i === fb.idx ? ' cur' : ''}">` + escHtml(text.slice(m.s, m.e)) + '</mark>'; p = m.e; });
  fm.innerHTML = out + escHtml(text.slice(p)) + '\n';
  fm.scrollTop = ta.scrollTop; fm.scrollLeft = ta.scrollLeft;
}

// ───────── 이미지 뷰어 ─────────
// · 화면에 맞춤이 기본(축소본으로 빠르게), 확대하면 원본을 불러와 교체  · ←/→ 이동, 앞뒤 이미지는 미리 디코딩해 둬서 깜빡임 없음
// · 전체화면: 네이티브 앱은 창 전체화면, 브라우저는 Fullscreen API
const imgv = { cache: new Map(), info: new Map(), ver: new Map(), cur: null };
const dropped = new Map();   // '@drop/…' → { url: blob:/http(s):/data: 주소, size }
const IMG_CACHE_MAX = 14;
const imgKey = (p, full) => `${full ? 'F' : 'T'}|${p}|${imgv.ver.get(p) || 0}`;
const fitW = () => Math.min(3840, Math.max(1024, Math.ceil((screen.width * (devicePixelRatio || 1)) / 256) * 256));
const imgUrl = (p, full) => { if (dropped.has(p)) return dropped.get(p).url; const rr = rootRel(p); return `/${full ? 'raw' : 'thumb'}?root=${encodeURIComponent(rr.root)}&path=${encodeURIComponent(rr.rel)}${full ? '' : '&w=' + fitW()}&v=${imgv.ver.get(p) || 0}`; };   // 워크스페이스 밖(@ext)·메모 이미지도 각자의 루트로
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
function imgInfo(p) {
  if (dropped.has(p)) return Promise.resolve({ w: null, h: null, size: dropped.get(p).size });
  const k = p + '|' + (imgv.ver.get(p) || 0);
  if (!imgv.info.has(k)) imgv.info.set(k, api('GET', 'imginfo', { path: p }).catch(() => ({ w: null, h: null, size: 0 })));
  return imgv.info.get(k);
}
function loadImg(p, full) { // 디코딩까지 끝난 <img> 를 캐시한다. 같은 요청은 한 번만.
  const key = imgKey(p, full); let e = imgv.cache.get(key);
  if (e) { imgv.cache.delete(key); imgv.cache.set(key, e); return e; }
  e = { done: false, ok: false, img: null, info: null };
  e.promise = (async () => {
    const img = new Image(); img.decoding = 'async'; img.draggable = false; img.alt = '';
    img.src = imgUrl(p, full);
    const [info] = await Promise.all([imgInfo(p), img.decode().catch(() => new Promise((r) => { if (img.complete) r(); else img.onload = img.onerror = r; }))]);
    Object.assign(e, { img, info, ok: img.naturalWidth > 0, done: true }); return e;
  })();
  imgv.cache.set(key, e);
  while (imgv.cache.size > IMG_CACHE_MAX) imgv.cache.delete(imgv.cache.keys().next().value);
  return e;
}
const imgCmd = (name) => imgv.cur?.cmd(name);

// o (갤러리에서 열 때): { list, idx, onShow(p, i), onClose() } — 처음부터 전체화면(검정 배경)으로 열고, 전체화면을 끝내면 onClose
function imageViewer(t, o = {}) {
  const box = el('div', { className: 'imgv active' }), stage = el('div', { className: 'iv-stage' });
  const name = el('span', { className: 'iv-name' }), count = el('span', { className: 'iv-count' }), meta = el('span', { className: 'iv-meta' }), zoomL = el('span', { className: 'iv-zoom' });
  const mk = (txt, title, fn, cls = '') => { const b = el('button', { textContent: txt, title, className: 'iv-btn ' + cls }); b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
  const spin = el('div', { className: 'iv-spin' }); spin.hidden = true;
  box.append(stage, mk('‹', '이전 (←)', () => go(-1), 'iv-nav l'), mk('›', '다음 (→)', () => go(1), 'iv-nav r'),
    el('div', { className: 'iv-hud' }, name, count, meta, zoomL),
    el('div', { className: 'iv-tools' }, mk('－', '축소 (- 또는 Ctrl -)', () => zoomBy(0.8)), mk('＋', '확대 (+ 또는 Ctrl +)', () => zoomBy(1.25)), mk('맞춤', '화면에 맞춤 (0)', () => cmd('fit')), mk('100%', '원본 크기 (1)', () => cmd('actual')), mk('⛶', '전체화면 (F)', () => cmd('fs'))), spin);
  const tl = !o.list && t.list?.includes(t.path) ? t.list : null;   // 여러 장을 끌어놓은 탭: 그 사이에서만 ←/→
  const v = { path: o.list ? o.list[o.idx || 0] : t.path, list: o.list || tl || [t.path], idx: o.list ? o.idx || 0 : tl ? tl.indexOf(t.path) : 0, el: null, iw: 1, ih: 1, s: 1, tx: 0, ty: 0, fitMode: true, thumbMode: false, tok: 0, dir: 1, fs: false, info: null, noUpscale: true };
  const cw = () => stage.clientWidth || 1, ch = () => stage.clientHeight || 1;
  const fitScale = () => Math.min(cw() / v.iw, ch() / v.ih, settings.imageFit === 'actual' ? 1 : Infinity);   // fill: 작은 이미지도 창에 맞춰 확대 / actual: 작으면 원본 크기 그대로
  function clampPan() { const w = v.iw * v.s, h = v.ih * v.s; v.tx = w <= cw() ? (cw() - w) / 2 : Math.min(0, Math.max(cw() - w, v.tx)); v.ty = h <= ch() ? (ch() - h) / 2 : Math.min(0, Math.max(ch() - h, v.ty)); }
  function apply() { if (v.el) { v.el.style.transform = `translate(${v.tx}px,${v.ty}px) scale(${v.s})`; v.el.style.imageRendering = v.s > 3 ? 'pixelated' : 'auto'; /* 3배 넘게 확대하면 픽셀이 보이게 */ } zoomL.textContent = Math.round(v.s * 100) + '%'; stage.classList.toggle('pannable', !v.fitMode); }
  function setFit() { v.fitMode = true; v.s = fitScale(); v.tx = v.ty = 0; clampPan(); apply(); }
  function zoomAt(ns, cx, cy) {
    if (!v.el) return; const fs = fitScale();
    ns = Math.min(32, Math.max(ns, Math.min(fs, 1))); const r = ns / v.s;   // 하한: 맞춤 또는 100% 중 작은 값 (확대 맞춤 상태에서도 100% 로 내려갈 수 있다)
    v.tx = cx - (cx - v.tx) * r; v.ty = cy - (cy - v.ty) * r; v.s = ns; v.fitMode = Math.abs(ns - fs) < 1e-3;
    clampPan(); apply(); ensureFull();
  }
  const zoomBy = (f) => zoomAt(v.s * f, cw() / 2, ch() / 2);
  function place(img) { // 화면에 놓을 <img>: 논리 크기는 항상 원본 픽셀 기준(축소본이어도 같은 크기로 보인다)
    img.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;max-width:none;width:${v.iw}px;height:${v.ih}px;user-select:none;-webkit-user-drag:none`;
    stage.replaceChildren(img); v.el = img;
  }
  async function ensureFull() { // 확대해서 축소본 해상도가 모자라면 원본을 불러와 교체 (그동안 축소본이 계속 보인다)
    if (!v.thumbMode || !v.el) return;
    const need = v.iw * v.s * (devicePixelRatio || 1);
    if (need <= v.el.naturalWidth * 1.05) return;
    const tok = v.tok, p = v.path; spin.hidden = false;
    const e = await loadImg(p, true).promise;
    if (tok !== v.tok) return; spin.hidden = true;
    if (e.ok) { place(e.img); v.thumbMode = false; apply(); }
  }
  function hud(e) {
    name.textContent = v.path.split('/').pop(); count.textContent = v.list.length > 1 ? `${v.idx + 1} / ${v.list.length}` : '';
    const i = e?.info || {}; meta.textContent = [i.w && i.h ? `${v.iw}×${v.ih}` : v.el ? `${v.el.naturalWidth}×${v.el.naturalHeight}` : '', i.size ? fmtSize(i.size) : ''].filter(Boolean).join(' · ');   // 화면에 보이는 방향(EXIF 회전 반영)의 원본 크기
  }
  async function show(i) {
    const tok = ++v.tok, p = v.list[i]; v.idx = i; v.path = p;
    const e = loadImg(p, false); let timer;
    if (!e.done) timer = setTimeout(() => { if (tok === v.tok) spin.hidden = false; }, 150);   // 바로 안 뜨면 그때만 로딩 표시 (이전 그림은 그대로 유지)
    await e.promise; clearTimeout(timer);
    if (tok !== v.tok) return; spin.hidden = true;
    if (!e.ok) { // 실패 원인을 같이 보여 준다 (오래된 서버면 404)
      const box = el('div', { className: 'iv-err' }, el('div', { textContent: '이미지를 열 수 없습니다: ' + p }));
      stage.replaceChildren(box); v.el = null; hud(e);
      fetch(imgUrl(p, false)).then((r) => { if (!r.ok) box.append(el('div', { className: 'iv-err-sub', textContent: `서버 응답 ${r.status}` + (r.status === 404 ? ' — 서버가 이전 버전으로 실행 중일 수 있습니다. 터미널에서 `ss --stop` 후 앱을 다시 여세요.' : '') })); }).catch(() => box.append(el('div', { className: 'iv-err-sub', textContent: '서버에 연결할 수 없습니다.' })));
      return;
    }
    const info = e.info || {}, L = Math.max(info.w || 0, info.h || 0), tl = Math.max(e.img.naturalWidth, e.img.naturalHeight);
    const k = L && tl ? L / tl : 1;   // 축소본 → 원본 픽셀 배율 (긴 변 기준이라 EXIF 회전과 무관)
    v.iw = Math.max(1, Math.round(e.img.naturalWidth * k)); v.ih = Math.max(1, Math.round(e.img.naturalHeight * k));
    v.thumbMode = k > 1.02; v.info = info;
    if (!o.list && info.mtime != null) t._sig = `${p}|${info.size}|${info.mtime}`;   // 창으로 돌아왔을 때 바뀌었는지 비교할 기준
    place(e.img); setFit(); hud(e);
    if (o.onShow) o.onShow(p, i);
    else if (t.path !== p) { const wasActive = state.active === t.path; t.path = p; if (wasActive) state.active = p; state.selected = p; persistTabs(); renderChrome(); }   // 탭 이름/활성 탭/트리 선택도 따라간다
    preload(i);
  }
  let preTok = 0;
  async function preload(i) { // 진행 방향 우선으로 앞뒤 이미지를 미리 디코딩
    const mine = ++preTok, order = v.dir >= 0 ? [1, 2, -1, 3, -2] : [-1, -2, 1, -3, 2];
    for (const d of order) { const j = i + d; if (j < 0 || j >= v.list.length) continue; await loadImg(v.list[j], false).promise; if (mine !== preTok) return; }
  }
  const go = (d) => { const j = v.idx + d; if (j < 0 || j >= v.list.length) return; v.dir = d; show(j); };
  function setFs(on) { const was = v.fs; v.fs = on; box.classList.toggle('fs', on); if (was && !on && o.onClose) o.onClose(); }   // 갤러리: 전체화면이 끝나면 목록으로
  // 전체화면: 먼저 창 전체를 검정으로 덮고(바로 보임) 화면에 꽉 맞춘 뒤, 진짜 전체화면을 요청한다
  //  · 네이티브 앱: 창 전체화면 (창이 이미 전체화면이면 그대로 — 토글하면 오히려 꺼진다)  · 브라우저: Fullscreen API (사용자 동작 안에서만 됨, 안 되면 창 안을 덮은 채로)
  function enterFs() {
    v.fitMode = true; setFs(true); if (v.el) setFit();
    const native = window.webkit?.messageHandlers?.fullscreen;
    if (native) { if (!(innerWidth >= screen.width && innerHeight >= screen.height)) { v.ownFs = true; native.postMessage('toggle'); } }
    else if (!document.fullscreenElement) box.requestFullscreen?.().catch(() => {});
  }
  function exitFs() { // 우리가 켠 전체화면만 끈다
    const native = window.webkit?.messageHandlers?.fullscreen;
    if (native && v.ownFs) native.postMessage('toggle'); else if (!native && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    v.ownFs = false; setFs(false); if (v.el && v.fitMode) setFit();
  }
  function cmd(c) {
    if (c === 'fit') setFit();
    else if (c === 'actual') zoomAt(1, cw() / 2, ch() / 2);
    else if (c === 'fs') (v.fs ? exitFs : enterFs)();
  }
  // 입력: 휠(확대/가로 스와이프=이동), 드래그(이동), 더블클릭(전체화면), 핀치, 키보드
  box.addEventListener('wheel', (e) => {
    e.preventDefault(); if (!v.el) return;
    if (v.fitMode && !e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) { const now = performance.now(); if (Math.abs(e.deltaX) > 24 && now - (v.swipeT || 0) > 450) { v.swipeT = now; go(e.deltaX > 0 ? 1 : -1); } return; }
    const r = stage.getBoundingClientRect(); zoomAt(v.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let drag = null;
  stage.addEventListener('pointerdown', (e) => { if (e.button !== 0 || v.fitMode) return; drag = { x: e.clientX, y: e.clientY, tx: v.tx, ty: v.ty }; stage.setPointerCapture(e.pointerId); stage.classList.add('grab'); });
  stage.addEventListener('pointermove', (e) => { if (!drag) return; v.tx = drag.tx + e.clientX - drag.x; v.ty = drag.ty + e.clientY - drag.y; clampPan(); apply(); });
  const endDrag = () => { drag = null; stage.classList.remove('grab'); };
  stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', () => cmd('fs'));   // 더블클릭: 전체화면(화면에 꽉 맞춤, 나머지는 검정) ↔ 원래대로. 확대는 휠/핀치/+−/1
  let gs = 1; // Safari/WKWebView 핀치
  stage.addEventListener('gesturestart', (e) => { e.preventDefault(); gs = v.s; });
  stage.addEventListener('gesturechange', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoomAt(gs * e.scale, (e.clientX ?? r.width / 2 + r.left) - r.left, (e.clientY ?? r.height / 2 + r.top) - r.top); });
  let hideT; const poke = () => { box.classList.add('active'); clearTimeout(hideT); hideT = setTimeout(() => box.classList.remove('active'), 2500); };
  box.addEventListener('mousemove', poke); poke();
  new ResizeObserver(() => { if (!v.el) return; if (v.fitMode) setFit(); else { clampPan(); apply(); } }).observe(stage);
  const onKey = (e) => {
    if (!box.isConnected) { document.removeEventListener('keydown', onKey, true); document.removeEventListener('fullscreenchange', onFsChange); return; }
    if (e.target.closest?.('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key; let used = true;
    if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) go(1);
    else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) go(-1);
    else if (k === 'Home') { v.dir = -1; show(0); } else if (k === 'End') { v.dir = 1; show(v.list.length - 1); }
    else if (k === 'f' || k === 'F') cmd('fs');
    else if (k === '0') cmd('fit'); else if (k === '1') cmd('actual');
    else if (k === '+' || k === '=') zoomBy(1.25); else if (k === '-' || k === '_') zoomBy(0.8);
    else if (k === 'Escape' && v.fs) cmd('fs');
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
  };
  const onFsChange = () => setFs(document.fullscreenElement === box);
  document.addEventListener('keydown', onKey, true); document.addEventListener('fullscreenchange', onFsChange);
  window.onNativeFullscreen = (on) => { if (box.isConnected) setFs(!!on); };
  imgv.cur = { cmd, zoomBy, refit: () => { if (v.el) setFit(); } };
  if (o.list) { // 갤러리: 목록은 이미 있다. 곧바로 전체화면(검정 배경으로 화면 전체)으로
    v.fs = true; box.classList.add('fs');
    box.enterFs = enterFs;   // 문서에 붙인 직후(더블클릭 처리 안)에 부른다 — 브라우저 Fullscreen API 는 사용자 동작 안에서만 된다
    show(v.idx); return box;
  }
  if (tl || isDrop(t.path)) { show(v.idx); return box; }
  (async () => { // 같은 폴더의 이미지 목록 (트리와 같은 정렬)
    show(0);
    const dir = dirOf(t.path); let ls = childrenCache.get(dir); if (!ls) { try { ls = await loadDir(dir); } catch { ls = []; } }
    const list = ls.filter((x) => !x.dir && IMG_EXT.has(extOf(x.name))).map((x) => (dir ? dir + '/' + x.name : x.name));
    if (list.includes(t.path)) { v.list = list; v.idx = list.indexOf(t.path); hud(null); hud(v.info ? { info: v.info } : null); preload(v.idx); }
  })();
  return box;
}

// ───────── 이미지 갤러리 ─────────
// 폴더를 열면(트리에서 이미지 폴더 클릭, ⌘O / Shift 두 번에 폴더 경로 붙여넣기, 트리 우클릭) 메인 화면에 이미지를 원래 비율 그대로 행 단위로 채워 보여 준다.
// · 썸네일은 서버 축소본(/thumb, 캐시)을 화면 근처에 왔을 때만, 동시에 3개씩 요청 (보이는 것부터)  · 하위 폴더는 맨 앞 폴더 타일
// · 클릭=선택, 더블클릭/Enter=전체화면 보기(검정 배경, ←/→·‹ ›, 앞뒤 미리 디코딩, Esc 로 목록)  · 보고 있는 폴더가 바뀌면 자동 반영
// · 여러 장 선택: ⌘/Ctrl+클릭 하나씩, Shift+클릭(Shift+방향키) 범위, ⌘A 전체, Esc 해제 → ⌘C 복사 / ⌘X 잘라내기 → 트리 폴더·갤러리에서 ⌘V (아래 '파일 클립보드')
const galJoin = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
const galThumb = (abs, w, ver) => `/thumb?root=%2F&path=${encodeURIComponent(abs.slice(1))}&w=${w}&v=${ver || 0}`;
const GAL_GAP = 6;
let galWatch = null;   // { dir, es } : 지금 보이는 갤러리 폴더만 감시 (호스트당 연결 수 한도 때문에 탭마다 열어 두지 않는다)
const galQ = { run: 0, list: [] };

function openGallery(abs, sel = '', preview = false) { // sel: 트리에서 선택해 둘 항목, preview: 트리에서 연 미리보기 탭
  flushAll();
  abs = abs.replace(/\/+$/, '') || '/';
  const p = '@gal' + abs; let t = tabOf(p);
  if (!t) { t = { path: p, kind: 'gallery', dir: abs, content: '', orig: '', mtime: 0, mode: 'view', preview }; state.tabs.push(t); }
  state.active = p; state.selected = sel; persistTabs(); renderAll();
}
function galGo(t, abs) { // 같은 탭에서 다른 폴더로 (하위 폴더 타일, 상위 폴더, 하단 경로)
  abs = abs.replace(/\/+$/, '') || '/';
  const p = '@gal' + abs, other = tabOf(p);
  if (other && other !== t) { state.active = p; persistTabs(); renderAll(); return; }
  galDispose(t); t.path = p; t.dir = abs; state.active = p; persistTabs(); renderAll();
}
function galDispose(t) {
  const g = t.g; if (!g) return;
  g.io?.disconnect(); g.ro?.disconnect(); cancelAnimationFrame(g.raf); clearTimeout(g.refreshT);
  if (g.viewer) g.viewer.remove();
  if (galWatch?.dir === t.dir) galUnwatch();
  t.g = null;
}
function galUnwatch() { galWatch?.es.close(); galWatch = null; }
function galWatchDir(t) {
  if (galWatch?.dir === t.dir || typeof EventSource === 'undefined') return;
  galUnwatch();
  const es = new EventSource('/api/dirwatch?root=%2F&path=' + encodeURIComponent(t.dir.slice(1))); let first = true;
  es.onmessage = () => galRefresh(t);
  es.onopen = () => { if (!first) galRefresh(t); first = false; };   // 서버 재시작 후 다시 연결되면 전체 갱신
  galWatch = { dir: t.dir, es };
}
function galRefresh(t) { const g = t.g; if (!g) return; clearTimeout(g.refreshT); g.refreshT = setTimeout(() => galLoad(t), 120); }
async function galLoad(t) {
  const g = t.g; if (!g) return; const seq = ++g.seq;
  try { const d = await api('GET', 'gallery', { path: '@ext' + t.dir }); if (seq !== g.seq || t.g !== g) return; g.data = d; g.err = null; }
  catch (e) { if (seq !== g.seq || t.g !== g) return; g.err = e.message; g.data = null; }
  galBuild(t);
  if (t.path === state.active) { renderToolbar(); validate(); }
}
function galItems(t) {
  const imgs = t.g.data?.images || [];
  return store.get('galSort', 'name') === 'new' ? [...imgs].sort((a, b) => b.mtime - a.mtime) : imgs;   // 서버는 이름(자연) 정렬
}

function galleryView(t) {
  let g = t.g;
  if (g?.dom) { // 탭을 다시 열었을 때: 그대로 붙이고, 떨어져 있던 동안의 변경을 다시 읽는다
    galWatchDir(t);
    if (!g.dom.isConnected) { requestAnimationFrame(() => { g.scroller.scrollTop = g.scroll; }); galRefresh(t); }
    galPaint(t); galRelayout(t); return g.dom;
  }
  g = t.g = { seq: 0, data: null, err: null, tiles: new Map(), dirTiles: new Map(), tileList: [], sel: -1, picked: new Set(), anchor: null, pendingPick: null, scroll: 0, viewer: null };   // sel=커서(번호), picked=고른 이름들, anchor=Shift 범위의 기준
  const root = el('div', { className: 'gal' + (store.get('galNames', true) ? '' : ' nonames'), tabIndex: -1 });
  const sc = el('div', { className: 'gal-scroll' }), grid = el('div', { className: 'gal-grid' });
  root.append(sc); Object.assign(g, { dom: root, scroller: sc, grid });
  sc.onscroll = () => { g.scroll = sc.scrollTop; };
  g.ro = new ResizeObserver(() => galRelayout(t)); g.ro.observe(sc);
  g.io = new IntersectionObserver((ents) => { for (const e of ents) { e.target._vis = e.isIntersecting; if (e.isIntersecting) galWant(e.target); } }, { root: sc, rootMargin: '900px 0px' });
  root.addEventListener('keydown', (e) => galKey(t, e));
  sc.replaceChildren(el('div', { className: 'gal-empty', textContent: '불러오는 중…' }));
  galWatchDir(t); galLoad(t);
  requestAnimationFrame(() => { if (root.isConnected && (!document.activeElement || document.activeElement === document.body)) root.focus({ preventScroll: true }); });
  return root;
}
function galTile(t, it) {
  const abs = galJoin(t.dir, it.name), img = el('img', { alt: '', draggable: false, decoding: 'async' });
  const tile = el('div', { className: 'gal-tile', title: it.name }, img, el('span', { className: 'gal-name', textContent: it.name }), el('span', { className: 'gal-chk' }), el('span', { className: 'gal-clip' }));
  Object.assign(tile, { _it: it, _abs: abs, _a: it.w && it.h ? it.w / it.h : 1, _w: 0, _need: 0, _vis: false });
  img.addEventListener('load', () => { // 헤더로 크기를 몰랐거나 EXIF 회전이 있으면 실제 비율로 다시 배치
    tile.classList.add('ok'); const a = img.naturalWidth / img.naturalHeight;
    if (a && Math.abs(a - tile._a) / tile._a > 0.02) { tile._a = a; galRelayout(t); }
  });
  img.addEventListener('error', () => tile.classList.add('bad'));
  const macCtrl = (e) => state.platform === 'darwin' && e.ctrlKey && !e.metaKey;   // macOS 의 Ctrl+클릭은 원래 우클릭 → ⌘+클릭과 같게 쓴다
  tile.onclick = (e) => { if (!macCtrl(e)) galSelect(t, tile._i, true, galHow(e)); };
  const dragArm = window.webkit?.messageHandlers?.dragArm;
  tile.onmousedown = (e) => {
    if (macCtrl(e) && e.button !== 1) { tile._ctrlAt = Date.now(); galSelect(t, tile._i, true, e.shiftKey ? 'add' : 'toggle'); return; }   // 이어서 오는 contextmenu 는 무시 (브라우저마다 button 이 0 또는 2)
    if (e.button !== 0) return;
    loadImg('@ext' + abs, false);   // 더블클릭보다 먼저 전체화면용 이미지를 디코딩해 둔다
    if (dragArm && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { // 앱(macOS): 이대로 끌면 실제 파일로 나간다 → Chrome 업로드 칸·Finder·메신저 등 (복사만). 고른 것 중 하나를 끌면 고른 것 전부
      const g = t.g, many = g.picked.size > 1 && g.picked.has(it.name);
      dragArm.postMessage(many ? galPicked(t).map((x) => x._abs) : [tile._abs]);
    }
  };
  tile.ondblclick = (e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) galView(t, tile._i); };
  tile.oncontextmenu = (e) => {
    e.preventDefault();
    if (Date.now() - (tile._ctrlAt || 0) < 1500) { tile._ctrlAt = 0; return; }
    galSelect(t, tile._i, false, 'cursor');   // 고른 것 위에서 열면 선택을 그대로 둔다 (Finder 처럼)
    const sel = galPicked(t), n = sel.length, M = modKey(), FM = state.platform === 'darwin' ? 'Finder' : '파일 관리자';
    showMenu(e.clientX, e.clientY, [
      ...(n > 1 ? [] : [['전체화면으로 보기', () => galView(t, tile._i)], ['탭으로 열기', () => openExternal(abs)], ['기본 앱으로 열기', () => revealPath('@ext' + abs, 'open')]]),
      [`${FM}에서 보기`, () => revealPath('@ext' + abs, 'reveal')],
      ['-'],
      [`복사${n > 1 ? ` (${n}장)` : ''}\t${M}C`, () => galClip(t, 'copy')],
      [`잘라내기${n > 1 ? ` (${n}장)` : ''}\t${M}X`, () => galClip(t, 'cut')],
      ...(clip || state.platform === 'darwin' ? [['이 폴더에 붙여넣기\t' + M + 'V', () => clipPaste(t.dir)]] : []),
      ['-'],
      [`경로 복사${n > 1 ? ` (${n}개)` : ''}\t${M}⇧C`, () => galCopyPaths(t)],
      [`이름 복사${n > 1 ? ` (${n}개)` : ''}`, () => copy(sel.map((x) => x._it.name).join('\n'), '이름 복사됨')],
    ]);
  };
  return tile;
}
function galDirTile(t, sd) {
  const abs = galJoin(t.dir, sd.name);
  const cover = sd.cover ? el('img', { alt: '', draggable: false, loading: 'lazy', decoding: 'async', src: galThumb(galJoin(abs, sd.cover), 256, 0) }) : el('span', { className: 'gal-dir-ic', textContent: '📁' });
  const tile = el('div', { className: 'gal-dir', title: abs + (sd.images ? `  (이미지 ${sd.images}장)` : '') },
    el('div', { className: 'gal-dir-cover' }, cover),
    el('div', { className: 'gal-dir-meta' }, el('span', { className: 'gal-dir-name', textContent: sd.name }), el('span', { className: 'gal-dir-n', textContent: sd.images ? sd.images + '장' : '' })));
  tile.onclick = () => galGo(t, abs);
  tile.oncontextmenu = (e) => {
    e.preventDefault(); const M = modKey();
    showMenu(e.clientX, e.clientY, [
      ['열기', () => galGo(t, abs)],
      ['-'],
      ['여기에 붙여넣기\t' + M + 'V', () => clipPaste(abs)],
      ['여기로 이동\t' + M + '⌥V', () => clipPaste(abs, true)],
      ...(galPicked(t).length ? [['-'], [`고른 ${galPicked(t).length}장을 여기로 이동`, () => galMoveTo(t, abs)]] : []),
    ]);
  };
  return tile;
}
function galBuild(t) {
  const g = t.g, sc = g?.scroller; if (!sc) return;
  if (g.err || !g.data) { g.tileList = []; g.sel = -1; sc.replaceChildren(el('div', { className: 'gal-empty', textContent: g.err ? '폴더를 열 수 없습니다: ' + g.err : '불러오는 중…' })); return; }
  const d = g.data, curName = g.tileList[g.sel]?._it.name, tiles = new Map(), dirTiles = new Map();
  g.tileList = galItems(t).map((it, i) => { // 바뀌지 않은 타일은 그대로 써서 다시 불러오지 않는다 (자동 갱신 때 깜빡임 없음)
    let tile = g.tiles.get(it.name);
    if (!tile || tile._it.mtime !== it.mtime || tile._it.size !== it.size) { if (tile) g.io.unobserve(tile); tile = galTile(t, it); g.io.observe(tile); }
    imgv.ver.set('@ext' + tile._abs, it.mtime);   // 전체화면 보기도 바뀐 파일은 새로 불러온다
    tile._i = i; tiles.set(it.name, tile); return tile;
  });
  for (const [n, x] of g.tiles) if (!tiles.has(n)) g.io.unobserve(x);
  g.tiles = tiles;
  const dirs = d.dirs.map((sd) => { const k = `${sd.name}|${sd.images}|${sd.cover}`; const x = g.dirTiles.get(k) || galDirTile(t, sd); dirTiles.set(k, x); return x; });
  g.dirTiles = dirTiles;
  const pp = g.pendingPick, first = pp && Date.now() - pp.at < 5000 ? g.tileList.find((x) => pp.names.has(x._it.name)) : null;
  if (first) { g.pendingPick = null; g.picked = new Set([...pp.names].filter((n) => tiles.has(n))); g.sel = first._i; g.anchor = first._it.name; requestAnimationFrame(() => first.scrollIntoView({ block: 'nearest' })); }   // 방금 붙여넣은 것들을 골라 둔다
  else {
    g.sel = curName != null ? g.tileList.findIndex((x) => x._it.name === curName) : -1;
    for (const n of g.picked) if (!tiles.has(n)) g.picked.delete(n);   // 사라진(옮겨진) 것은 선택에서 뺀다
  }
  galPaint(t);
  const parts = [];
  if (dirs.length) parts.push(el('div', { className: 'gal-dirs' }, ...dirs));
  parts.push(g.grid);
  if (!d.images.length && !d.dirs.length) parts.push(el('div', { className: 'gal-empty', textContent: '이미지가 없습니다' + (d.others ? ` (다른 파일 ${d.others}개)` : '') }));
  if (d.truncated) parts.push(el('div', { className: 'gal-empty', textContent: `이미지가 많아 처음 ${d.images.length.toLocaleString()}장만 표시합니다 (전체 ${d.total.toLocaleString()}장)` }));
  sc.replaceChildren(...parts);
  galLayout(t);
}
function galRelayout(t) { const g = t.g; if (!g || g.raf) return; g.raf = requestAnimationFrame(() => { g.raf = 0; galLayout(t); }); }
function galLayout(t) { // 행마다 높이를 맞추고 원래 비율 그대로 폭을 채운다 (마지막 행은 늘리지 않음)
  const g = t.g; if (!g?.grid.isConnected) return;
  const W = g.grid.clientWidth - 0.5; if (W <= 0) return;
  const H = store.get('galH', 220), rows = []; let row = [], sum = 0;
  const flush = (last) => {
    if (!row.length) return;
    const fit = (W - GAL_GAP * (row.length - 1)) / sum;
    rows.push({ row, h: Math.max(24, last ? Math.min(H, fit) : fit) }); row = []; sum = 0;
  };
  for (const tile of g.tileList) { row.push(tile); sum += tile._a; if (sum * H + GAL_GAP * (row.length - 1) >= W) flush(false); }
  flush(true);
  const dpr = devicePixelRatio || 1;
  g.grid.replaceChildren(...rows.map(({ row: r, h }) => {
    const div = el('div', { className: 'gal-row' }); div.style.height = h + 'px';
    for (const tile of r) {
      tile.style.width = tile._a * h + 'px'; tile.style.height = h + 'px'; div.append(tile);
      tile._need = Math.min(2048, Math.max(256, Math.ceil((h * dpr * Math.max(tile._a, 1)) / 256) * 256));   // 축소본 긴 변 (256 단위라 캐시가 잘 맞는다)
      galWant(tile);
    }
    return div;
  }));
}
function galWant(tile) { // 화면 근처에 있고 지금 해상도가 모자라면 큐에 넣는다
  if (!tile._vis || !tile._need || tile._w >= tile._need || tile._q) return;
  tile._q = true; galQ.list.push(tile); galPump();
}
function galPump() { // 동시에 3개까지 (서버 변환도 3개씩이고, 연결 하나는 다른 요청용으로 남긴다). 보이는 것부터, 지나간 것은 버린다
  while (galQ.run < 3 && galQ.list.length) {
    const i = galQ.list.findIndex((x) => x._vis && x.isConnected);
    if (i < 0) { for (const x of galQ.list) x._q = false; galQ.list = []; return; }
    const tile = galQ.list.splice(i, 1)[0]; tile._q = false;
    if (tile._w >= tile._need) continue;
    tile._w = tile._need; galQ.run++;
    const img = tile.firstChild; let done = false;
    const fin = () => { if (done) return; done = true; galQ.run--; galPump(); };
    img.addEventListener('load', fin, { once: true }); img.addEventListener('error', fin, { once: true });
    img.src = galThumb(tile._abs, tile._w, tile._it.mtime);
  }
}
// how: '' 하나만 · 'toggle' ⌘/Ctrl+클릭 · 'range' Shift+클릭 (기준점부터 여기까지만) · 'add' ⌘/Ctrl+Shift+클릭 (범위를 더함) · 'cursor' 고른 것 안이면 선택은 그대로 두고 커서만
const galHow = (e) => (e.shiftKey ? (e.metaKey || e.ctrlKey ? 'add' : 'range') : e.metaKey || e.ctrlKey ? 'toggle' : '');
function galSelect(t, i, scroll = true, how = '') {
  const g = t.g; if (!g || i < 0 || i >= g.tileList.length) return;
  const name = g.tileList[i]._it.name;
  if (how === 'toggle') { if (!g.picked.delete(name)) g.picked.add(name); g.anchor = name; }
  else if (how === 'range' || how === 'add') {
    let a = g.tileList.findIndex((x) => x._it.name === g.anchor);
    if (a < 0) { a = g.sel >= 0 ? g.sel : i; g.anchor = g.tileList[a]._it.name; }
    if (how === 'range') g.picked = new Set();
    for (let k = Math.min(a, i); k <= Math.max(a, i); k++) g.picked.add(g.tileList[k]._it.name);
  } else if (how !== 'cursor' || !g.picked.has(name)) { g.picked = new Set([name]); g.anchor = name; }
  g.sel = i; galPaint(t);
  if (scroll) g.tileList[i].scrollIntoView({ block: 'nearest' });
  if (t.path === state.active) validate();
}
function galSelectAll(t) {
  const g = t.g; if (!g?.tileList.length) return;
  g.picked = new Set(g.tileList.map((x) => x._it.name)); if (g.sel < 0) g.sel = 0;
  galPaint(t); if (t.path === state.active) validate();
}
function galPaint(t) { // 선택(.sel) · 여러 장일 때 커서(.cur)와 체크 표시 · 복사(.clip)/잘라내기(.cut) 표시
  const g = t.g; if (!g?.dom) return; const multi = g.picked.size > 1;
  g.dom.classList.toggle('multi', multi);
  g.tileList.forEach((x, i) => {
    x.classList.toggle('sel', g.picked.has(x._it.name)); x.classList.toggle('cur', multi && i === g.sel);
    const c = !!clip?.paths.has(x._abs); x.classList.toggle('clip', c); x.classList.toggle('cut', c && clip.mode === 'cut');
  });
}
const galPicked = (t) => (t.g ? t.g.tileList.filter((x) => t.g.picked.has(x._it.name)) : []);
function galVert(g, i, d) { // 위/아래 행에서 가로 위치가 가장 가까운 타일
  const curT = g.tileList[i]; if (!curT) return 0;
  const next = d > 0 ? curT.parentElement.nextElementSibling : curT.parentElement.previousElementSibling;
  if (!next) return i;
  const cx = curT.offsetLeft + curT.offsetWidth / 2; let best = null, bd = Infinity;
  for (const c of next.children) { const dd = Math.abs(c.offsetLeft + c.offsetWidth / 2 - cx); if (dd < bd) { bd = dd; best = c; } }
  return best ? best._i : i;
}
function galCopyPaths(t) { // 고른 이미지들의 전체 경로 (줄마다 하나)
  const ps = galPicked(t).map((x) => x._abs); if (!ps.length) return;
  copy(ps.join('\n'), ps.length > 1 ? `경로 ${ps.length}개 복사됨` : '전체 경로 복사됨');
}
function galClip(t, mode) { // 고른 이미지들을 파일로 복사/잘라내기
  const ps = galPicked(t).map((x) => x._abs);
  if (!ps.length) return toast('먼저 이미지를 고르세요');
  clipSet(ps, mode);
}
async function galMoveTo(t, dest) { const ps = galPicked(t).map((x) => x._abs); if (ps.length) await transfer(ps, dest, true); }
const galFocused = () => cur()?.kind === 'gallery' && !!document.activeElement?.closest?.('.gal') && !cur().g?.viewer;
for (const kind of ['copy', 'cut']) document.addEventListener(kind, (e) => { // 메뉴(네이티브 앱의 편집 > 복사하기/오려두기)로 들어온 요청: 갤러리에서는 고른 이미지를 파일로
  if (!galFocused() || String(getSelection())) return;
  e.preventDefault(); galClip(cur(), kind);
});
document.addEventListener('paste', (e) => { // 편집 > 붙여넣기 메뉴로 들어온 경우 (단축키는 keydown 에서 이미 처리)
  if (e.target.closest?.('input, textarea, [contenteditable]') || Date.now() - clipKeyAt < 600) return;
  if (galFocused()) { e.preventDefault(); clipPaste(cur().dir); }
  else if (inTree()) { e.preventDefault(); treePaste(false); }
});
function galKey(t, e) {
  const g = t.g; if (!g || e.target.closest?.('input, textarea, [contenteditable]')) return;
  const mod = (e.metaKey || e.ctrlKey) && !String(getSelection()), code = e.code, n = g.tileList.length, k = e.key;
  if (mod && code === 'KeyC') { e.preventDefault(); e.shiftKey ? galCopyPaths(t) : !e.altKey && galClip(t, 'copy'); return; }   // ⌘C 파일로 복사 · ⌘⇧C 경로 복사
  if (mod && code === 'KeyX' && !e.shiftKey && !e.altKey) { e.preventDefault(); galClip(t, 'cut'); return; }
  if (mod && code === 'KeyV' && !e.shiftKey) { e.preventDefault(); clipKeyAt = Date.now(); clipPaste(t.dir, e.altKey); return; }   // ⌘V 붙여넣기 · ⌘⌥V 이동
  if (mod && code === 'KeyA' && !e.shiftKey && !e.altKey) { e.preventDefault(); galSelectAll(t); return; }
  if (g.viewer || e.metaKey || e.ctrlKey || e.altKey) return;
  let i = g.sel; const how = e.shiftKey ? 'range' : '';   // Shift+방향키: 기준점부터 범위 선택
  if (k === 'Enter' || k === ' ') { if (i >= 0) galView(t, i); }
  else if (k === 'Backspace') { if (g.data?.parent) galGo(t, g.data.parent); }
  else if (k === 'Escape' && g.picked.size) { g.picked = new Set(); g.anchor = null; galPaint(t); validate(); }   // 선택 해제 (커서 위치는 기억해 방향키는 이어서)
  else if (!n) return;
  else if (k === 'ArrowRight') galSelect(t, Math.min(n - 1, i + 1), true, how);
  else if (k === 'ArrowLeft') galSelect(t, Math.max(0, i - 1), true, how);
  else if (k === 'ArrowDown' || k === 'ArrowUp') galSelect(t, i < 0 ? 0 : galVert(g, i, k === 'ArrowDown' ? 1 : -1), true, how);
  else if (k === 'Home') galSelect(t, 0, true, how);
  else if (k === 'End') galSelect(t, n - 1, true, how);
  else return;
  e.preventDefault();
}
function galView(t, i) { // 전체화면 보기: 목록은 갤러리 순서 그대로, 끝내면(Esc/F/⛶) 보던 이미지가 선택된 목록으로
  const g = t.g; if (!g || g.viewer || !g.tileList[i]) return;
  const list = g.tileList.map((x) => '@ext' + x._abs);
  const box = imageViewer({ path: list[i] }, {
    list, idx: i,
    onShow: (_p, j) => galSelect(t, j, false, 'cursor'),
    onClose: () => {
      box.remove(); g.viewer = null; imgv.cur = null;
      const tile = g.tileList[g.sel]; if (tile) requestAnimationFrame(() => tile.scrollIntoView({ block: 'nearest' }));
      g.dom.focus({ preventScroll: true });
    },
  });
  g.viewer = box; g.dom.append(box); box.enterFs();
}

// ───────── 파일 클립보드: 갤러리에서 복사/잘라내기 → 트리 폴더·갤러리에 붙여넣기 ─────────
// 갤러리에서 ⌘C(복사)·⌘X(잘라내기) → 왼쪽 트리에서 폴더를 고르고(파일을 고르면 그 파일의 폴더) ⌘V, 또는 갤러리 화면에서 ⌘V(지금 폴더).
// 이동: ⌘X 후 ⌘V, 또는 Finder 처럼 ⌘C 후 ⌘⌥V. 하위 폴더 타일 우클릭 → 여기에 붙여넣기/이동. 이름이 겹치면 덮어쓰지 않고 '이름 2.jpg'.
// macOS 는 시스템 클립보드에 '파일'로 올린다 → Finder·메신저에도 붙여넣을 수 있고, Finder 에서 ⌘C 한 파일도 여기로 붙여넣을 수 있다.
// 표시: 복사한 타일은 점선 테두리 + '📋 복사됨' (잘라내기는 흐리게 + '✂ 잘라냄'), 하단 상태바에 개수 (클릭하면 취소). 그 사이 다른 것을 복사하면 표시가 사라진다.
const modKey = () => (state.platform === 'darwin' ? '⌘' : 'Ctrl+');
const ROOT_ALL = '@ext/';   // api(): 경로를 / 기준(절대경로)으로 다룬다
let clip = null, clipKeyAt = 0, clipBusy = false, clipPending = null;   // clip: { mode: 'copy'|'cut', paths: Set(절대경로), cc: macOS 클립보드 changeCount (다른 OS·실패 시 null) }
function clipSet(paths, mode) { return (clipPending = clipSetNow(paths, mode).finally(() => { clipPending = null; })); }   // 바로 이어서 ⌘V 를 눌러도 올린 뒤에 붙여넣는다
async function clipSetNow(paths, mode) {
  let cc = null;
  try { cc = (await api('POST', 'clip/write', { path: ROOT_ALL }, { paths })).cc; }
  catch (e) { toast('시스템 클립보드에 올리지 못했습니다 (이 앱 안에서는 붙여넣을 수 있음): ' + e.message, 3500); }
  clip = { mode, paths: new Set(paths), cc }; clipShow(true);
  toast(`${paths.length}장 ${mode === 'cut' ? '잘라냄' : '복사됨'} — 트리에서 폴더를 고르고 ${modKey()}V`, 2600);
}
function clipClear() { if (!clip) return; clip = null; clipShow(); }
function clipShow(flash) { // 상태바 + 보이는 갤러리의 타일 표시
  const chip = $('#st-clip'), M = modKey(); chip.hidden = !clip;
  if (clip) {
    const cut = clip.mode === 'cut';
    chip.className = cut ? 'cut' : '';
    chip.replaceChildren(el('span', { textContent: `${cut ? '✂' : '📋'} ${clip.paths.size}개 ${cut ? '잘라냄' : '복사됨'}` }), el('span', { className: 'x', textContent: '✕' }));
    chip.title = `${M}V: ${cut ? '옮기기' : '붙여넣기'} — 왼쪽 트리에서 고른 폴더 / 갤러리 화면이면 지금 폴더 / 하위 폴더 타일은 우클릭${cut ? '' : `\n${M}⌥V: 옮기기`}\n클릭: 취소`;
  }
  const t = cur(); if (t?.kind !== 'gallery' || !t.g) return;
  galPaint(t);
  if (flash && clip) for (const x of t.g.tileList) if (clip.paths.has(x._abs)) { x.classList.remove('flash'); void x.offsetWidth; x.classList.add('flash'); }
}
$('#st-clip').onclick = clipClear;
async function clipCheck() { // macOS: 그 사이 다른 것을 복사했으면(changeCount 가 바뀜) 표시를 지운다
  if (clip?.cc == null) return;
  const sys = await api('POST', 'clip/read', { path: ROOT_ALL }).catch(() => null);
  if (clip && sys?.cc != null && sys.cc !== clip.cc) clipClear();
}
for (const kind of ['copy', 'cut']) document.addEventListener(kind, (e) => setTimeout(() => { if (!e.defaultPrevented) clipCheck(); }, 100));   // 글자 복사 등
async function clipPaste(dest, forceMove) { // dest: 절대경로 폴더. forceMove(⌘⌥V): 복사한 것도 옮긴다
  if (clipBusy) return; clipBusy = true;
  try {
    await clipPending;
    let paths = clip ? [...clip.paths] : [], move = clip?.mode === 'cut';
    const sys = await api('POST', 'clip/read', { path: ROOT_ALL }).catch(() => null);
    const viaSys = sys?.cc != null && (!clip || clip.cc != null);   // 시스템 클립보드에 올리지 못한 경우는 앱 안의 것만
    if (viaSys && sys.cc !== clip?.cc) { clipClear(); paths = sys.paths || []; move = false; }   // 다른 곳(Finder 등)에서 복사한 파일 → 시스템 클립보드를 따른다
    if (!paths.length) return toast(`붙여넣을 파일이 없습니다 — 갤러리에서 이미지를 고르고 ${modKey()}C`, 2600);
    const r = await transfer(paths, dest, move || !!forceMove);
    if (r?.move && r.done.length) { // 옮긴 뒤에는 클립보드를 비운다 (옛 위치를 다시 붙여넣지 않게)
      clip = null; clipShow();
      if (viaSys) api('POST', 'clip/write', { path: ROOT_ALL }, { paths: [] }).catch(() => {});
    }
  } finally { clipBusy = false; }
}
async function transfer(paths, dest, move) { // 복사/이동 + 결과 알림 + 화면 갱신
  let r; try { r = await api('POST', 'fs/transfer', { path: ROOT_ALL }, { paths, dest, move }); }
  catch (e) { toast((move ? '옮기기' : '붙여넣기') + ' 실패: ' + e.message, 3500); return null; }
  const n = r.done.length, ren = r.done.filter((x) => x.renamed).length;
  const msg = [n ? `${n}개 ${move ? '옮김' : '붙여넣음'} → ${r.dest.split('/').pop() || '/'}` : '', ren ? `이름이 겹친 ${ren}개는 번호를 붙임` : '',
    r.skipped.length ? `이미 그 폴더에 있는 ${r.skipped.length}개는 그대로` : '', r.errors.length ? `실패 ${r.errors.length}개 — ${r.errors[0]}` : ''].filter(Boolean).join(' · ');
  toast(msg || '바뀐 것이 없습니다', r.errors.length || ren ? 4500 : 2200);
  if (move && clip && r.done.some((x) => clip.paths.has(x.from))) clipClear();   // 클립보드에 있던 것을 다른 방법(타일 우클릭)으로 옮김
  if (n && (r.dest === state.root || r.dest.startsWith(state.root + '/'))) { for (let d = r.dest.slice(state.root.length + 1); d; d = dirOf(d)) state.expanded.add(d); persistTabs(); }   // 붙여넣은 폴더를 트리에서 펼친다
  childrenCache.clear(); renderTree();
  const names = new Set(r.done.map((x) => x.to.split('/').pop()));
  for (const t of state.tabs) if (t.kind === 'gallery' && t.g) {
    if ((t.g.data?.path || t.dir) === r.dest && n) { t.g.pendingPick = { names, at: Date.now() }; galLoad(t); }   // 붙여넣은 것들을 골라 둔다
    else if (move) galRefresh(t);
  }
  return { ...r, move };
}
function treePaste(forceMove) { const d = dirOfSel(); clipPaste(d ? state.root + '/' + d : state.root, forceMove); }   // 고른 폴더 (파일이면 그 파일의 폴더)
document.addEventListener('keydown', (e) => { // 트리: ⌘V 붙여넣기 · ⌘⌥V 옮기기
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.code !== 'KeyV' || !inTree() || e.target.closest?.('input, textarea')) return;
  e.preventDefault(); clipKeyAt = Date.now(); treePaste(e.altKey);
}, true);

// ───────── 끌어다 놓기: 창 어디에든 이미지·폴더·파일을 놓으면 바로 연다 ─────────
// · 앱(macOS): 네이티브 셸이 끌고 온 파일의 실제 경로를 window.ssDragPaths 로 알려 준다 → 경로로 연다
//   이미지 = 이미지 탭(한 장이면 같은 폴더 ←/→, 여러 장이면 놓은 것들 사이), 폴더 = 이미지 갤러리, 그 밖의 파일 = 탭 (⌘O 와 같은 방식)
// · 브라우저: 끌어놓은 파일의 경로를 알 수 없다 → 이미지는 메모리(blob)로 바로 보여 준다. 웹 페이지의 이미지를 끌어오면 그 주소로 보여 준다
// · 마크다운 편집기 위에 놓으면 지금처럼 문서에 첨부 (편집기 처리기가 먼저 받아 preventDefault 한다)
const dropHint = el('div', { id: 'drop-hint', hidden: true }, el('div', { className: 'dh-box', textContent: '놓으면 바로 보기' }));
document.body.append(dropHint);
let dropHintT, dropSeq = 0;
function showDropHint(on) { // dragover 는 멈춰 있어도 계속 오므로, 끊기면(창 밖으로 나감) 잠시 뒤 숨긴다
  dropHint.hidden = !on; clearTimeout(dropHintT);
  if (on) dropHintT = setTimeout(() => { dropHint.hidden = true; }, 800);
}
const dragKind = (e) => { const ty = [...(e.dataTransfer?.types || [])]; return ty.includes('Files') ? 'files' : ty.includes('text/uri-list') ? 'url' : null; };
const textTarget = (e) => !!e.target.closest?.('input, textarea, [contenteditable]');
document.addEventListener('dragover', (e) => {
  const k = dragKind(e); if (!k) return;
  if (e.defaultPrevented || (k === 'url' && textTarget(e))) { showDropHint(false); return; }   // 편집기(첨부)·입력창(글자 넣기)이 받는 곳
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; showDropHint(true);   // 그냥 두면 창이 그 파일/링크로 이동해 버린다
});
document.addEventListener('dragend', () => showDropHint(false));
document.addEventListener('drop', (e) => {
  showDropHint(false);
  const k = dragKind(e), paths = window.ssDragPaths; window.ssDragPaths = null;
  if (!k || e.defaultPrevented || (k === 'url' && textTarget(e))) return;
  e.preventDefault();
  if (k === 'files') openDropped([...e.dataTransfer.files], paths, [...(e.dataTransfer.items || [])].map((it) => it.webkitGetAsEntry?.() || null));   // 항목 정보는 drop 처리 중에만 읽을 수 있다
  else openDroppedUrl(e.dataTransfer.getData('text/uri-list'), e.dataTransfer.getData('text/html'));
});
const pathKey = (abs) => (abs.startsWith(state.root + '/') ? abs.slice(state.root.length + 1) : '@ext' + abs);   // 워크스페이스 안이면 일반 경로
function openImageList(keys) { // 첫 장을 탭으로. 여러 장이면 ←/→ 는 그 사이에서만
  if (keys.length === 1 && !isDrop(keys[0])) { const t0 = tabOf(keys[0]); if (t0) t0.list = null; return openFile(keys[0]); }   // 한 장: 같은 폴더의 이미지들 사이로 ←/→
  flushAll();
  let t = tabOf(keys[0]);
  if (!t) { t = { path: keys[0], content: '', orig: '', mtime: 0, kind: 'image', mode: 'view' }; state.tabs.push(t); }
  t.list = keys.length > 1 ? keys : null; state.active = t.path; state.selected = ''; persistTabs(); renderAll();
}
async function openPaths(paths) { // 실제 경로들: 그 밖의 파일 → 폴더(갤러리) → 이미지 순으로 열어 이미지가 보이게
  const imgs = [], dirs = [], others = [];
  for (const p of paths) {
    if (IMG_EXT.has(extOf(p))) { imgs.push(p); continue; }
    const isDir = await api('GET', 'browse', { path: p, dot: '1' }).then(() => true, () => false);
    (isDir ? dirs : others).push(p);
  }
  for (const p of others) openExternal(p);
  for (const d of dirs) openGallery(d);
  if (imgs.length) openImageList(imgs.map(pathKey));
}
function openDropped(files, paths, entries) {
  const pathOK = paths?.length && files.every((f) => paths.some((p) => p.split('/').pop() === f.name));   // 이번에 끌어온 파일의 경로인지 확인
  if (pathOK) return openPaths(paths);
  const imgs = files.filter((f, i) => !entries[i]?.isDirectory && (f.type.startsWith('image/') || IMG_EXT.has(extOf(f.name))));
  const skipped = files.length - imgs.length;
  if (skipped) toast(entries.some((x) => x?.isDirectory) ? '폴더는 경로를 ⌘O 에 붙여넣어 여세요 (브라우저에서는 끌어놓은 폴더의 경로를 알 수 없음)' : `이미지가 아닌 파일 ${skipped}개는 열지 않았습니다 (브라우저에서는 경로를 알 수 없음)`);
  if (!imgs.length) return;
  const n = ++dropSeq;
  openImageList(imgs.map((f, i) => { const k = `@drop/${n}.${i}/${f.name}`; dropped.set(k, { url: URL.createObjectURL(f), size: f.size }); return k; }));
}
function openDroppedUrl(uris, html) { // 웹 페이지의 이미지/이미지 링크
  const src = /<img[^>]+src=["']([^"']+)["']/i.exec(html || '')?.[1]?.replace(/&amp;/g, '&');   // 이미지를 끌면 링크(a)보다 이미지 주소가 정확하다
  let u = src && /^(https?:|data:image\/)/i.test(src) ? src : (uris || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  if (!u) return;
  if (/^file:\/\//i.test(u)) return openPaths([cleanPath(u)]);
  if (!/^(https?:|data:image\/)/i.test(u)) return;
  const base = u.startsWith('data:') ? 'image' : decodeURIComponent(u.split(/[?#]/)[0].split('/').pop() || '') || 'image';
  if (u === src || u.startsWith('data:') || IMG_EXT.has(extOf(base))) {
    const k = `@drop/${++dropSeq}.0/${base}`; dropped.set(k, { url: u, size: 0 }); openImageList([k]);
  } else toast('이미지 주소가 아닙니다: ' + u.slice(0, 120));
}

// ───────── 마크다운 이미지 첨부 ─────────
// 편집기에 이미지를 붙여넣거나 끌어놓으면 <문서 폴더>/images/ 에 저장하고, 커서 위치에 ![이름](images/파일) 을 넣는다.
async function uploadImage(destRel, file) {
  const { root, rel: p } = rootRel(destRel);   // 메모는 ~/.shooting-star/memos/images/
  const r = await fetch('/api/upload?path=' + encodeURIComponent(p), { method: 'POST', headers: { 'X-SS': '1', 'X-SS-Root': encodeURIComponent(root), 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const imgStamp = () => { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; };
async function uploadImages(t, files) { // 이미지들을 <문서 폴더>/images/ 에 올리고 마크다운 링크 목록을 돌려준다
  const dir = dirOf(t.path), parts = []; let reused = 0;
  toast(`이미지 업로드 중… (${files.length}개)`);
  for (const f of files) {
    const ext = ((f.name.match(/\.([A-Za-z0-9]+)$/) || [])[1] || (f.type.split('/')[1] || 'png').replace('svg+xml', 'svg')).toLowerCase();
    const stem = !f.name || /^image\.\w+$/i.test(f.name) ? `image-${imgStamp()}` : f.name.replace(/\.[^.]+$/, '');   // 붙여넣은 스크린샷은 시각으로 이름을 붙인다
    try {
      const j = await uploadImage(`${dir ? dir + '/' : ''}images/${stem}.${ext}`, f);
      if (j.reused) reused++;
      parts.push(`![${j.name.replace(/\.[^.]+$/, '')}](images/${j.name})`);
    } catch (e) { toast('이미지 첨부 실패: ' + e.message); }
  }
  if (parts.length) toast(`이미지 ${parts.length}개 첨부됨 → ${dir ? dir + '/' : ''}images/` + (reused ? ` (같은 이미지 ${reused}개는 재사용)` : ''));
  return { parts, reused };
}
// 텍스트를 선택한 채 URL 을 붙여넣으면 [선택한 글](URL) 로 바꿈 (처리했으면 true)
function pasteLink(e, ta) {
  const url = (e.clipboardData?.getData('text/plain') || '').trim();
  if (!/^(https?:\/\/|mailto:)\S+$/i.test(url)) return false;
  const a = ta.selectionStart, b = ta.selectionEnd, sel = ta.value.slice(a, b);
  if (a === b || /\n/.test(sel) || /^\[.*\]\(.*\)$/.test(sel)) return false;
  e.preventDefault();
  const out = `[${sel}](${url})`;
  if (!document.execCommand('insertText', false, out)) { // 실행취소를 유지하려 execCommand 우선
    ta.setRangeText(out, a, b, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}
// Enter: 목록 줄이면 같은 들여쓰기·기호(번호는 +1, 체크박스는 빈 칸)로 다음 항목을 만든다. 빈 항목에서 Enter 면 기호를 지운다. 처리했으면 true
function listEnter(e, ta) {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || e.isComposing || e.keyCode === 229) return false;
  const v = ta.value, s = ta.selectionStart;
  const ls = v.lastIndexOf('\n', s - 1) + 1, nl = v.indexOf('\n', s), le = nl < 0 ? v.length : nl;
  const m = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(v.slice(ls, le));
  if (!m || s < ls + m[1].length + m[2].length + m[3].length) return false;   // 기호 앞/안에서는 평소 Enter
  e.preventDefault();
  if (!m[5].trim() && s >= le) { // 빈 항목에서 Enter: 기호를 지우고 빈 줄로 (목록 끝내기)
    // 빈 문자열 insertText 는 WebKit 에서 줄 전체를 지우며 앞 줄과 합쳐 버린다 → 앞 줄바꿈까지 골라 '\n' 으로 바꾼다
    if (ls > 0) { ta.setSelectionRange(ls - 1, le); document.execCommand('insertText', false, '\n'); }
    else { ta.setSelectionRange(0, le); document.execCommand('delete'); }
    return true;
  }
  const marker = /^\d+/.test(m[2]) ? `${parseInt(m[2], 10) + 1}${m[2].slice(-1)}` : m[2];
  document.execCommand('insertText', false, '\n' + m[1] + marker + m[3] + (m[4] ? '[ ] ' : ''));
  return true;
}
// Tab / Shift+Tab: 선택한 줄 전체(선택이 없으면 현재 줄)의 들여쓰기를 2칸씩 조절. 처리했으면 true
function indentKey(e, ta, md) {
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return false;
  const v = ta.value, a = ta.selectionStart, ranged = a !== ta.selectionEnd; let b = ta.selectionEnd;
  const ls0 = v.lastIndexOf('\n', a - 1) + 1, lineEnd = v.indexOf('\n', a) < 0 ? v.length : v.indexOf('\n', a);
  if (!e.shiftKey && !ranged && !(md && /^\s*([-*+]|\d+[.)])\s/.test(v.slice(ls0, lineEnd)))) return false;   // 평소 Tab: 커서 위치에 공백 2칸
  e.preventDefault();
  if (ranged && v[b - 1] === '\n') b--;                  // 다음 줄 맨 앞까지 선택된 경우 그 줄은 제외
  const le = v.indexOf('\n', b), end = le < 0 ? v.length : le;
  let firstDelta = 0;
  const out = v.slice(ls0, end).split('\n').map((l, i) => {
    const cut = e.shiftKey ? (l.match(/^( {1,2}|\t)/)?.[0].length || 0) : 0;
    if (i === 0) firstDelta = e.shiftKey ? -cut : 2;
    return e.shiftKey ? l.slice(cut) : '  ' + l;
  }).join('\n');
  ta.setSelectionRange(ls0, end);
  document.execCommand('insertText', false, out);
  if (ranged) ta.setSelectionRange(ls0, ls0 + out.length); else { const c = Math.max(ls0, a + firstDelta); ta.setSelectionRange(c, c); }
  return true;
}
async function attachImages(files, taOverride) {
  const t = cur(); if (!t || t.kind !== 'md') return;
  if (t.mode === 'smart' && !taOverride) return smartCtx?.attach(files);   // 스마트 편집: 편집 중이 아니면 이미지 블록으로 추가
  const ta = taOverride || $('textarea.editor'); if (!ta) return;
  const { parts } = await uploadImages(t, files); if (!parts.length) return;
  ta.focus(); document.execCommand('insertText', false, parts.join('\n'));   // 커서 위치에 삽입 (⌘Z 로 되돌릴 수 있다)
}
function pickImages() {
  const inp = el('input', { type: 'file', accept: 'image/*', multiple: true });
  inp.onchange = () => attachImages([...inp.files]);
  inp.click();
}

// ───────── 스마트 편집 (블록 단위 라이브 편집) ─────────
// 문서를 마크다운 블록(문단/제목/목록/코드/표…)으로 나눠 보기처럼 렌더링하고, 블록을 클릭하면 그 자리에서 원문을 편집한다.
// 수정한 블록의 원문만 바뀌므로 나머지 마크다운은 한 글자도 변하지 않는다. (marked.lexer 토큰의 raw 를 이어 붙이면 원문과 같다)
let smartCtx = null;
function smartEditor(t) {
  const pane = el('div', { className: 'pane smart' }), doc = el('div', { className: 'md smart-doc' });
  pane.append(doc);
  const eol = t.content.includes('\r\n') ? '\r\n' : '\n';
  const lexFrag = (raw) => marked.lexer(raw).map((tok) => ({ type: tok.type, raw: tok.raw, tok }));
  let blocks = lexFrag(t.content.replace(/\r\n/g, '\n')), editIdx = -1, lastIdx = -1;
  doc._blockLines = () => { let line = 1; return blocks.map((b) => { const a = line, n = b.raw.replace(/\s+$/, '').split('\n').length; line += b.raw.split('\n').length - 1; return { a, b: a + n - 1 }; }); };   // 블록 i → 원문 줄 범위 (Git 히스토리용)
  const src = () => blocks.map((b) => b.raw).join('');
  const toContent = (s) => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);
  const hist = [src()]; let hpos = 0;
  const tailOf = (raw) => raw.slice(raw.trimEnd().length);
  const rawFor = (i, value) => { // 편집한 텍스트 → 블록의 새 raw (끝 공백 정리, 원래의 줄바꿈 꼬리 유지)
    const body = value.replace(/\s+$/, ''); if (!body.trim()) return '';
    const tail = tailOf(blocks[i].raw), next = blocks[i + 1];
    return body + tail + (!tail && next && next.type !== 'space' ? '\n\n' : '');
  };
  const afterChange = () => { renderTabs(); renderToolbarDirtyOnly(); validate(); autosave(t); };
  function changed(push = true) {
    t.content = toContent(src());
    if (push) { const s = src(); if (hist[hpos] !== s) { hist.length = hpos + 1; hist.push(s); hpos++; if (hist.length > 200) { hist.shift(); hpos--; } } }
    afterChange();
  }
  function live() { // 입력하는 동안에도 내용/저장 상태를 맞춘다 (⌘S, 메모 자동 저장이 바로 반영)
    const ta = doc.querySelector('.sb-ta'); if (!ta || editIdx < 0) return;
    t.content = toContent(blocks.map((b, i) => (i === editIdx ? rawFor(i, ta.value) : b.raw)).join('')); afterChange();
  }
  function commitEdit() { // 편집 중인 블록을 확정. 반환: { shift: 뒤쪽 블록 인덱스 이동량, last: 확정된 영역의 마지막 블록 인덱스 }
    if (editIdx < 0) return { shift: 0, last: -1 };
    const i = editIdx, ta = doc.querySelector('.sb-ta'); editIdx = -1; if (!ta) return { shift: 0, last: i };
    const raw = rawFor(i, ta.value), old = blocks[i];
    if (raw === old.raw) return { shift: 0, last: i };
    if (!raw && old.fresh) { // 비어 있는 채로 만든 새 블록을 버리면 같이 추가했던 빈 줄도 정리
      const lo = blocks[i - 1]?.added ? 1 : 0, hi = blocks[i + 1]?.added ? 1 : 0;
      blocks.splice(i - lo, 1 + lo + hi); changed(); return { shift: -(1 + lo + hi), last: i - lo - 1 };
    }
    const repl = raw ? lexFrag(raw) : [];
    blocks.splice(i, 1, ...repl); changed(); return { shift: repl.length - 1, last: i + repl.length - 1 };
  }
  function insertBlockAfter(i, body) { // 블록 i 뒤에 새 블록(들)을 넣고 첫 새 블록의 인덱스를 반환
    const ins = [], newBlocks = body ? lexFrag(body) : [{ type: 'paragraph', raw: '', tok: null, fresh: true }];
    let at = i < 0 ? 0 : i + 1;
    if (i >= 0) { if (blocks[at]?.type === 'space') at++; else ins.push({ type: 'space', raw: '\n\n', tok: null, added: !body }); }
    ins.push(...newBlocks);
    if (blocks[at] && blocks[at].type !== 'space') ins.push({ type: 'space', raw: '\n\n', tok: null, added: !body });
    blocks.splice(at, 0, ...ins);
    return at + (ins[0].type === 'space' ? 1 : 0);
  }
  const lvl = (v) => /^(#{1,6})\s/.exec(v)?.[1].length || 0;
  function fit(ta) { // 높이 자동 + 입력 중 즉시 서식 (## → 제목 크기)
    ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
    ta.className = 'sb-ta' + (lvl(ta.value) ? ' h' + lvl(ta.value) : '') + (/^\s*(```|~~~)/.test(ta.value) ? ' code' : '') + (/^>/.test(ta.value) ? ' quote' : '');
  }
  const imgFiles = (e) => { const cd = e.clipboardData; const f = [...(cd?.files || [])].filter((x) => x.type.startsWith('image/')); return !f.length || cd.getData('text/plain') ? [] : f; };
  function makeEditor(b) {
    const ta = el('textarea', { className: 'sb-ta', value: b.raw.replace(/\s+$/, ''), spellcheck: false, rows: 1 });
    ta.oninput = () => { fit(ta); live(); };
    ta.onkeydown = (e) => onKey(e, ta);
    ta.onblur = () => setTimeout(() => { if (editIdx >= 0 && !doc.contains(document.activeElement)) { commitEdit(); render(); } }, 0);
    ta.addEventListener('paste', (e) => { if (pasteLink(e, ta)) return; const f = imgFiles(e); if (f.length) { e.preventDefault(); attachImages(f, ta); } });
    ta.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    ta.addEventListener('drop', (e) => { const all = [...(e.dataTransfer?.files || [])]; if (!all.length) return; e.preventDefault(); const im = all.filter((f) => f.type.startsWith('image/')); im.length ? attachImages(im, ta) : toast('이미지 파일만 첨부할 수 있습니다'); });
    return ta;
  }
  function blockEl(b, i) {
    const d = el('div', { className: 'sb' + (i === editIdx ? ' editing' : '') }); d.dataset.i = i;
    if (i === editIdx) { d.append(makeEditor(b)); return d; }
    try { d.append(...renderMarkdown(t, DOMPurify.sanitize(marked.parser([b.tok]), { USE_PROFILES: { html: true } })).childNodes); } catch { d.textContent = b.raw; }
    d.querySelectorAll('input[type=checkbox]').forEach((c, k) => { c.disabled = false; c.onchange = () => toggleTask(i, k); });
    return d;
  }
  function render() {
    const st = pane.scrollTop, els = [];
    blocks.forEach((b, i) => {
      if (b.type === 'space') return;
      els.push(blockEl(b, i));
      const nl = (s) => (s.match(/\n/g) || []).length, extra = nl(tailOf(b.raw)) + (blocks[i + 1]?.type === 'space' ? nl(blocks[i + 1].raw) : 0) - 2;
      if (extra > 0 && i < blocks.length - 1) { // 문단 사이의 추가 빈 줄은 줄 수만큼 간격으로 보여준다
        const sp = el('div', { className: 'sb-gap' }); sp.style.height = extra * 1.65 + 'em'; sp.onmousedown = (e) => { e.preventDefault(); startEdit(i, 'end'); }; els.push(sp);
      }
    });
    const has = blocks.some((b) => b.type !== 'space');
    const tail = el('div', { className: 'sb-tail', textContent: has ? '＋ 여기를 눌러 문단 추가' : '클릭해서 입력을 시작하세요…  (## 제목 · - 목록 · 이미지는 붙여넣기)' });
    tail.onmousedown = (e) => { e.preventDefault(); startEdit(insertBlockAfter(blocks.length - 1, ''), 0); };
    doc.replaceChildren(...els, tail); pane.scrollTop = st;
    const ta = doc.querySelector('.sb-ta'); if (ta) fit(ta);
  }
  function startEdit(i, where = 'end') {
    const prev = editIdx, r = commitEdit(); if (prev >= 0 && i > prev) i += r.shift;
    while (i < blocks.length && blocks[i].type === 'space') i++;
    if (i >= blocks.length) i = insertBlockAfter(blocks.length - 1, '');
    editIdx = i; lastIdx = i; render();
    const ta = doc.querySelector('.sb-ta'); ta.focus();
    const p = where === 'end' ? ta.value.length : where === 'start' ? 0 : where; ta.setSelectionRange(p, p);
    ta.scrollIntoView({ block: 'nearest' });
  }
  const finish = () => { commitEdit(); render(); };
  function newBlockAfterCurrent(body) { // 현재 블록을 확정하고 그 아래에 새 문단을 만들어 편집 (현재 블록이 비면 삭제됨)
    const r = commitEdit(); startEdit(insertBlockAfter(r.last, body), 0);
  }
  function mergePrev(ta) { // 블록 맨 앞에서 Backspace: 앞 블록과 합치기 (빈 블록이면 삭제)
    const i = editIdx; let j = i - 1; while (j >= 0 && blocks[j].type === 'space') j--; if (j < 0) return false;
    const prevBody = blocks[j].raw.replace(/\s+$/, ''), tail = tailOf(blocks[j].raw), cur = ta.value;
    editIdx = -1; blocks.splice(i, 1);
    blocks.splice(j, 1, ...lexFrag(prevBody + cur + tail)); changed(); startEdit(j, prevBody.length); return true;
  }
  function neighbor(dir) {
    let j = editIdx + dir; while (j >= 0 && j < blocks.length && blocks[j].type === 'space') j += dir;
    if (j >= 0 && j < blocks.length) startEdit(j, dir < 0 ? 'end' : 'start');
  }
  function toggleTask(i, k) {
    let n = -1; const raw = blocks[i].raw.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/gm, (m, pre, c) => (++n === k ? `${pre}[${c === ' ' ? 'x' : ' '}]` : m));
    blocks.splice(i, 1, ...lexFrag(raw)); changed(); render();
  }
  function onKey(e, ta) {
    if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 중에는 건드리지 않는다
    const v = ta.value, s = ta.selectionStart, sel = ta.selectionEnd !== s;
    const ls = v.lastIndexOf('\n', s - 1) + 1, nl = v.indexOf('\n', s), le = nl < 0 ? v.length : nl, line = v.slice(ls, le), first = v.split('\n', 1)[0];
    const isCode = /^\s*(```|~~~)/.test(v), isTable = /^\s*\|/.test(first);
    const oneLine = ta.scrollHeight < 2 * (parseFloat(getComputedStyle(ta).lineHeight) || 24);
    if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); newBlockAfterCurrent(''); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !isCode && !isTable) {
      e.preventDefault();
      const lm = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line), qm = /^(\s*>+\s?)(.*)$/.exec(line);
      if (lm) { // 목록: 다음 항목 자동 생성, 빈 항목에서 Enter 면 목록 종료
        if (!lm[5].trim() && s >= le) { ta.value = v.slice(0, ls).replace(/\n$/, ''); newBlockAfterCurrent(''); return; }
        const marker = /^\d+/.test(lm[2]) ? `${parseInt(lm[2], 10) + 1}${lm[2].slice(-1)}` : lm[2];
        document.execCommand('insertText', false, '\n' + lm[1] + marker + lm[3] + (lm[4] ? '[ ] ' : '')); return;
      }
      if (qm) { if (!qm[2].trim() && s >= le) { ta.value = v.slice(0, ls).replace(/\n$/, ''); newBlockAfterCurrent(''); return; } document.execCommand('insertText', false, '\n' + qm[1]); return; }
      const a = v.slice(0, s), b = v.slice(ta.selectionEnd).replace(/^\s+/, ''); ta.value = a; newBlockAfterCurrent(b); return;   // 문단/제목: 커서에서 둘로 나눈다
    }
    if (e.key === 'Backspace' && !sel && s === 0 && !e.metaKey && !e.ctrlKey && !e.altKey) { if (mergePrev(ta)) e.preventDefault(); return; }
    if (e.key === 'ArrowUp' && !sel && !e.shiftKey && (s === 0 || (ls === 0 && oneLine))) { e.preventDefault(); neighbor(-1); return; }
    if (e.key === 'ArrowDown' && !sel && !e.shiftKey && (s === v.length || (nl < 0 && oneLine))) { e.preventDefault(); neighbor(1); return; }
    if (indentKey(e, ta, true)) return;
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (/^\s*([-*+]|\d+[.)])\s/.test(line)) { ta.setSelectionRange(ls, ls); document.execCommand('insertText', false, e.shiftKey ? '' : '  '); ta.setSelectionRange(s + 2, s + 2); } else document.execCommand('insertText', false, '  '); }
  }
  async function attach(files) { // 편집 중이면 커서 위치에, 아니면 마지막으로 만진 블록 뒤(없으면 문서 끝)에 이미지 블록으로 추가
    const ta = doc.querySelector('.sb-ta'); if (ta) return attachImages(files, ta);
    const { parts } = await uploadImages(t, files); if (!parts.length) return;
    lastIdx = insertBlockAfter(lastIdx >= 0 && lastIdx < blocks.length ? lastIdx : blocks.length - 1, parts.join('\n\n')); changed(); render();
  }
  // 입력: 블록 클릭=편집 (링크 클릭=이동, Alt+클릭=편집), 체크박스 토글, 이미지 붙여넣기/끌어놓기, 문서 단위 되돌리기
  doc.addEventListener('mousedown', (e) => {
    const sb = e.target.closest('.sb'); if (!sb || sb.classList.contains('editing')) return;
    if (e.target.closest('.cp, input[type=checkbox]')) return;
    if (e.target.closest('a') && !e.altKey) return;   // 링크 클릭 = 이동 (Alt+클릭 = 그 블록 편집)
    e.preventDefault(); startEdit(+sb.dataset.i, 'end');   // mousedown 을 막아 두면 편집 중이던 입력창이 먼저 blur 되며 화면이 바뀌는 일이 없다
  });
  doc.addEventListener('click', (e) => { if (e.target.closest('a') && e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  pane.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  pane.addEventListener('drop', (e) => { if (e.target.closest('textarea')) return; const im = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/')); if (im.length) { e.preventDefault(); attach(im); } });
  const ctx = { attach };
  const onPaste = (e) => { if (!doc.isConnected) { document.removeEventListener('paste', onPaste, true); return; } if (e.target.closest?.('textarea, input')) return; const f = imgFiles(e); if (f.length) { e.preventDefault(); attach(f); } };
  const onDocKey = (e) => {
    if (!doc.isConnected) { document.removeEventListener('keydown', onDocKey, true); if (smartCtx === ctx) smartCtx = null; return; }
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z' || e.target.closest?.('textarea, input')) return;
    const to = hpos + (e.shiftKey ? 1 : -1); if (to < 0 || to >= hist.length) return;
    e.preventDefault(); hpos = to; blocks = lexFrag(hist[hpos]); editIdx = -1; changed(false); render();
  };
  document.addEventListener('paste', onPaste, true); document.addEventListener('keydown', onDocKey, true);
  smartCtx = ctx; render();
  return pane;
}

// ───────── 하단 상태바의 전체 경로 (조각을 클릭하면 왼쪽 트리에서 그 위치로 이동) ─────────
// 갤러리 하단 경로 클릭: 갤러리를 그 폴더로 옮기고 왼쪽 트리에서 펼쳐 선택한다.
// 워크스페이스 밖 폴더면 (파일 경로와 마찬가지로) 그 폴더를 워크스페이스로 열고, 새 화면에서 갤러리를 이어서 연다.
function galPathClick(t, abs) {
  const inside = abs === state.root || abs.startsWith(state.root + '/');
  if (!inside) { try { sessionStorage.setItem('ss:gallery', abs); } catch {} return go(abs); }
  if (abs !== t.dir) galGo(t, abs);
  revealDirInTree(abs);
}
function revealDirInTree(abs) {
  const rel = abs === state.root ? '' : abs.slice(state.root.length + 1);
  if (rel) return revealInTree(rel, true);
  if (document.body.classList.contains('no-side') || ['memo', 'git', 'run', 'db'].includes(state.view)) setView('files', true);
  state.selected = ''; renderTree().then(() => { $('#tree').scrollTop = 0; });
}
async function revealInTree(rel, isDir) { // 해당 항목까지 폴더를 펼치고 선택한 뒤 화면 가운데로 스크롤
  if (document.body.classList.contains('no-side') || ['memo', 'git', 'run', 'db'].includes(state.view)) setView('files', true);
  const parts = rel ? rel.split('/') : []; let acc = '';
  for (let i = 0; i < parts.length - (isDir ? 0 : 1); i++) { acc = acc ? acc + '/' + parts[i] : parts[i]; state.expanded.add(acc); }
  state.selected = rel; persistTabs(); await renderTree();
  const row = [...document.querySelectorAll('#tree .row')].find((r) => r.dataset.path === rel);
  if (row) row.scrollIntoView({ block: 'center' }); else $('#tree').scrollTop = 0;
}
function drawPath(t) {
  const box = $('#st-path'); box.replaceChildren(); if (!t) return;
  const inner = el('span', { className: 'pth' }); box.append(inner);
  if (t.kind === 'sql') { inner.textContent = t.connName; inner.title = 'SQL 콘솔'; return; }
  if (isDrop(t.path)) { const d = dropped.get(t.path); inner.textContent = /^https?:/.test(d?.url || '') ? d.url : t.path.split('/').pop() + '  — 끌어놓은 이미지'; inner.title = '경로를 알 수 없는 이미지 (탭을 닫으면 사라짐)'; return; }
  if (t.kind === 'gallery') {
    const segs = [{ label: '/', abs: '/' }]; let acc = '';
    for (const p of t.dir.split('/').filter(Boolean)) { acc += '/' + p; segs.push({ label: p, abs: acc }); }
    const hi = state.home ? segs.findIndex((s) => s.abs === state.home) : -1;
    const view = hi >= 0 ? [{ label: '~', abs: state.home }, ...segs.slice(hi + 1)] : segs;
    view.forEach((s, i) => {
      const inside = s.abs === state.root || s.abs.startsWith(state.root + '/');
      const seg = el('span', { className: 'seg', textContent: s.label, title: inside ? '트리에서 이 폴더 보기' + (s.abs === t.dir ? '' : ' (갤러리도 이동)') : '이 폴더를 워크스페이스로 열어 트리에 보기' });
      seg.onclick = () => galPathClick(t, s.abs);
      inner.append(seg); if (i < view.length - 1 && s.label !== '/') inner.append(el('span', { className: 'sep', textContent: '/' }));
    });
    return;
  }
  if (t.kind === 'run') { inner.textContent = (t.scriptPath || t.name).replace(state.home || '\u0000', '~'); inner.title = '등록된 스크립트'; return; }
  if (t.kind === 'history') { inner.textContent = (t.repo.abs + (t.rel ? '/' + t.rel : '')).replace(state.home || '\u0000', '~') + (t.range ? `  ${t.range.a}–${t.range.b}줄` : ''); inner.title = 'Git 히스토리'; return; }
  if (t.kind === 'diff') { inner.textContent = (t.repo + '/' + t.file).replace(state.home || '\u0000', '~'); inner.title = '변경 내용 (diff)'; return; }
  if (isMemo(t.path)) { inner.textContent = ((state.memoDir || '') + '/' + t.path.slice(6)).replace(state.home || '\u0000', '~'); inner.title = '메모 파일 위치'; return; }
  if (isExt(t.path)) { inner.textContent = absOf(t.path).replace(state.home || '\u0000', '~'); inner.title = '워크스페이스 밖의 파일'; return; }
  const full = state.root + (t.path ? '/' + t.path : ''), segs = []; let acc = '';
  for (const p of full.split('/').filter(Boolean)) { acc += '/' + p; segs.push({ label: p, abs: acc }); }
  const hi = state.home ? segs.findIndex((s) => s.abs === state.home) : -1;   // 홈 아래면 홈까지를 ~ 하나로
  const view = hi >= 0 ? [{ label: '~', abs: state.home }, ...segs.slice(hi + 1)] : segs;
  if (hi < 0) inner.append(el('span', { className: 'sep', textContent: '/' }));
  view.forEach((s, i) => {
    const inside = s.abs.length > state.root.length, isRoot = s.abs === state.root, last = s.abs === full;
    const seg = el('span', { className: 'seg', textContent: s.label, title: inside ? (last ? '트리에서 파일 위치 보기' : '트리에서 이 폴더 보기') : isRoot ? '프로젝트 루트 (트리 맨 위로)' : '이 폴더를 워크스페이스로 열기' });
    seg.onclick = () => {
      if (inside) revealInTree(s.abs.slice(state.root.length + 1), !last);   // 프로젝트 안: 트리에서 펼치고 선택
      else if (isRoot) { if (document.body.classList.contains('no-side') || ['memo', 'git', 'run', 'db'].includes(state.view)) setView('files', true); state.selected = ''; renderTree().then(() => { $('#tree').scrollTop = 0; }); }
      else go(s.abs);   // 프로젝트 루트보다 위: 그 폴더를 워크스페이스로 연다
    };
    inner.append(seg); if (i < view.length - 1) inner.append(el('span', { className: 'sep', textContent: '/' }));
  });
}

// ───────── 폴더 열기 (⌘⇧O) / 파일 열기 (⌘O) ─────────
const recents = () => store.get('recent', []);
function addRecent(p) { store.set('recent', [p, ...recents().filter((x) => x !== p)].slice(0, 12)); }
const pk = { items: [], sel: 0, dir: '', mode: 'dir' };
// 즐겨찾기 폴더 (서버의 ~/.config/shooting-star/favorites.json 에 저장)
// 파일은 'f:' + 절대경로, 폴더는 절대경로 그대로 저장한다
let favs = [];
const favKey = (rel, isDir) => (isDir ? '' : 'f:') + state.root + '/' + rel;
const loadFavs = async () => { try { favs = await api('GET', 'favorites'); } catch { favs = []; } drawFavBtn(); };
const saveFavs = async () => { await api('PUT', 'favorites', {}, { list: favs }); drawFavBtn(); };
function drawFavBtn() {
  const on = favs.includes(state.root), b = $('#btn-fav');
  b.textContent = on ? '★' : '☆'; b.style.color = on ? 'var(--star)' : '';
  b.title = on ? '즐겨찾기에서 제거' : '이 폴더를 즐겨찾기에 추가';
  drawFavList();
}
// 사이드바 상단의 즐겨찾기 폴더 목록
function drawFavList() {
  const box = $('#favs');
  const head = el('div', { className: 'fav-head', textContent: '★ 즐겨찾기' });
  if (!favs.length) {
    box.replaceChildren(head, el('div', { className: 'fav-empty', textContent: '위의 ☆ 로 현재 폴더 추가 · 파일/폴더 우클릭으로도 추가' }));
    return;
  }
  const rows = favs.map((key) => {
    const isFile = key.startsWith('f:'), f = isFile ? key.slice(2) : key;
    const x = el('span', { className: 'fx', textContent: '✕', title: '즐겨찾기에서 제거' });
    x.onclick = async (e) => { e.stopPropagation(); favs = favs.filter((y) => y !== key); await saveFavs(); };
    const segs = f.split('/').filter(Boolean), inside = f.startsWith(state.root + '/');
    const row = el('div', { className: 'fav' + (f === state.root && !isFile ? ' cur' : ''), title: f + (isFile ? '\n클릭: 파일 열기' : f === state.root ? '' : inside ? '\n클릭: 트리에서 이 폴더로 이동' : '\n클릭: 이 폴더를 워크스페이스로 열기') },
      el('span', { className: 'fn', textContent: (isFile ? '📄 ' : '') + (segs.at(-1) || '/') }), segs.length > 1 ? el('span', { className: 'fp', textContent: segs.at(-2) }) : '', x);   // 같은 이름이 여러 개여도 구분되도록 상위 폴더 이름을 흐리게 덧붙인다
    row.onclick = () => {
      if (isFile) openExternal(f);   // 파일: 바로 열기 (워크스페이스 안이면 일반 탭)
      else if (f === state.root) revealInTree('', true);   // 현재 폴더면 트리 맨 위로
      else if (f.startsWith(state.root + '/')) revealInTree(f.slice(state.root.length + 1), true);   // 현재 폴더 안이면 트리에서 바로 그 폴더로 이동 (펼치고 선택)
      else go(f);   // 밖이면 그 폴더를 워크스페이스로 연다
    };
    return row;
  });
  box.replaceChildren(head, ...rows);
}
async function toggleFavDir(abs) {
  const had = favs.includes(abs);
  favs = had ? favs.filter((f) => f !== abs) : [abs, ...favs];
  await saveFavs(); toast(had ? '즐겨찾기에서 제거됨' : '즐겨찾기에 추가됨');
}
$('#btn-fav').onclick = () => toggleFavDir(state.root);
const go = (p) => { addRecent(p); try { sessionStorage.setItem('ss:navFrom', state.root); } catch {} location.href = '/?root=' + encodeURIComponent(p); };   // navFrom: 거기서 끝까지 뒤로 가면 여기로
async function pruneRecents() { // 삭제되었거나 이동된 폴더는 최근 목록에서 제거
  const alive = new Set();
  await Promise.all(recents().map(async (r) => { try { await api('GET', 'browse', { path: r }); alive.add(r); } catch {} }));
  store.set('recent', recents().filter((r) => alive.has(r)));
}
// 붙여넣은 경로 정리: file:///a%20b/c.md → /a b/c.md, 앞뒤 따옴표·공백 제거
function cleanPath(v) {
  v = String(v || '').trim().replace(/^(['"`])(.*)\1$/, '$2');
  if (/^file:\/\//i.test(v)) { v = v.replace(/^file:\/\/(localhost)?/i, ''); try { v = decodeURIComponent(v); } catch {} }
  return v;
}
// 빠른 열기(Shift 두 번)에 절대경로/file:// 를 붙여넣었는지 — 그러면 경로 열기(⌘O)로 넘긴다
const looksAbsPath = (v) => /^\s*['"`]?(file:\/\/|~\/|\/(Users|private|tmp|var|Volumes|home|opt|etc|Applications|Library|root|mnt|srv)\/)/i.test(v);
// 붙여넣은 경로가 폴더면 이미지 갤러리로 연다 (열었으면 true)
async function tryGallery(v) {
  v = cleanPath(v); if (!/^[/~]/.test(v)) return false;
  try { const r = await api('GET', 'browse', { path: v.replace(/(.)\/+$/, '$1'), dot: '1' }); closePicker(); openGallery(r.path); return true; } catch { return false; }
}
async function openPicker(mode = 'dir', initial, pasted) {
  if (mode === 'file' && pasted && initial != null && await tryGallery(initial)) return;
  pk.mode = mode; $('#picker').hidden = false; const inp = $('#pk-input');
  inp.placeholder = mode === 'file' ? '열 파일의 경로 (/path/to/file.md 또는 file:///…)' : '/path/to/folder';
  inp.value = initial != null ? cleanPath(initial) : (mode === 'file' && state.active && isExt(state.active) ? dirOf(absOf(state.active)) : state.root) + '/'; inp.focus(); await pruneRecents(); await pkLoad();
}
const closePicker = () => { $('#picker').hidden = true; };
// 워크스페이스 밖의 파일을 탭으로 연다 (워크스페이스는 그대로). 워크스페이스 안의 파일이면 일반 탭으로 연다.
function openExternal(abs) {
  const inside = abs.startsWith(state.root + '/');
  openFile(inside ? abs.slice(state.root.length + 1) : '@ext' + abs);
}
async function pkLoad(pasted) {
  const inp = $('#pk-input'), raw = inp.value, cleaned = cleanPath(raw);
  if (pasted && pk.mode === 'file' && await tryGallery(cleaned)) return;   // 폴더 경로를 붙여넣음 → 이미지 갤러리
  if (cleaned !== raw) inp.value = cleaned;   // file:// URL·따옴표 붙은 경로를 붙여넣으면 경로로 바꿔 보여 준다
  let v = cleaned;
  if (v && !/^[/~]/.test(v)) v = state.root + '/' + v;   // 상대 경로 (.claude/skills/x/SKILL.md) 는 워크스페이스 기준
  const slash = v.lastIndexOf('/'); const dir = v.slice(0, slash + 1) || '/'; const part = v.slice(slash + 1).toLowerCase();
  let items = [];
  try {
    const file = pk.mode === 'file';
    const dot = part.startsWith('.') ? { dot: '1' } : {};   // '.claude' 같은 숨김 폴더/파일은 점으로 시작해 칠 때 보인다
    const r = await api('GET', 'browse', file ? { path: dir, files: '1', ...dot } : { path: dir, ...dot });
    pk.dir = r.path;
    const base = r.path.replace(/\/$/, '');
    if (file) {
      const hit = (r.files || []).filter((f) => f.toLowerCase().startsWith(part)).sort((a, b) => (b.toLowerCase() === part) - (a.toLowerCase() === part));   // 경로를 통째로 붙여넣으면 그 파일이 맨 앞
      for (const f of hit) items.push({ label: '📄 ' + f, act: () => { closePicker(); openExternal(base + '/' + f); } });
      const nImg = (r.files || []).filter((f) => IMG_EXT.has(extOf(f))).length;   // 이미지가 있는 폴더: 갤러리 항목 (경로가 / 로 끝나면 맨 위)
      if (nImg) items[part ? 'push' : 'unshift']({ label: `🖼 이 폴더 이미지 보기 (${nImg}장)  ${state.platform === 'darwin' ? '⌘↵' : 'Ctrl+↵'}`, act: () => { closePicker(); openGallery(r.path); } });
    } else items.push({ label: '▶ 이 폴더 열기: ' + r.path, openPath: r.path, act: () => go(r.path) });
    if (r.parent) items.push({ label: '..', act: () => { $('#pk-input').value = r.parent.replace(/\/?$/, '/'); pkLoad(); } });
    for (const d of r.dirs) if (d.toLowerCase().startsWith(part))
      items.push({ label: '📁 ' + d, act: () => { $('#pk-input').value = base + '/' + d + '/'; pkLoad(); } });
  } catch { items.push({ label: '(존재하지 않는 경로)', act: () => {} }); }
  if (!part && pk.mode === 'dir') {
    const favItems = favs.filter((f) => !f.startsWith('f:')).map((f) => ({ label: '★ ' + f, act: () => go(f), remove: f }));
    items = [items[0], ...favItems, ...items.slice(1)];
    for (const r of recents()) if (r !== state.root && !favs.includes(r)) items.push({ label: '🕘 ' + r, act: () => go(r) });
  }
  pk.items = items; pk.sel = Math.min(pk.sel, items.length - 1); pk.sel = 0; drawPicker();
}
function drawPicker() {
  $('#pk-list').replaceChildren(...pk.items.map((it, i) => {
    const li = el('li', { className: i === pk.sel ? 'sel' : '' }); li.onclick = it.act;
    if (it.openPath) { // 경로의 각 폴더 이름을 눌러 바로 그 폴더로 열기 (예: /Users/me/projects/x 에서 'projects' 클릭)
      li.append('▶ 이 폴더 열기: ');
      let acc = '';
      const root = el('span', { className: 'pseg', textContent: '/', title: '/ 열기' }); root.onclick = (e) => { e.stopPropagation(); go('/'); };
      li.append(root);
      it.openPath.split('/').filter(Boolean).forEach((seg, k, arr) => {
        acc += '/' + seg; const target = acc;
        const s = el('span', { className: 'pseg', textContent: seg, title: target + ' 열기' });
        s.onclick = (e) => { e.stopPropagation(); go(target); };
        li.append(s); if (k < arr.length - 1) li.append('/');
      });
    } else li.textContent = it.label;
    if (it.remove) { // 즐겨찾기 항목 제거 버튼
      const x = el('span', { textContent: '✕', title: '즐겨찾기에서 제거', style: 'float:right;opacity:.6' });
      x.onclick = async (e) => { e.stopPropagation(); favs = favs.filter((f) => f !== it.remove); await saveFavs(); pkLoad(); };
      li.append(x);
    }
    return li;
  }));
  $('#pk-list .sel')?.scrollIntoView({ block: 'nearest' });
}
$('#pk-input').oninput = (e) => pkLoad(e.inputType === 'insertFromPaste');
$('#pk-input').onkeydown = (e) => {
  if (e.key === 'Escape') closePicker();
  else if (e.key === 'ArrowDown') { e.preventDefault(); pk.sel = Math.min(pk.sel + 1, pk.items.length - 1); drawPicker(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pk.sel = Math.max(pk.sel - 1, 0); drawPicker(); }
  else if (e.key === 'Enter') { e.preventDefault(); (e.metaKey || e.ctrlKey ? () => (pk.mode === 'dir' ? go(pk.dir) : (closePicker(), openGallery(pk.dir))) : pk.items[pk.sel]?.act)?.(); }   // 파일 열기에서 ⌘↵: 지금 폴더를 이미지 갤러리로
};
document.addEventListener('mousedown', (e) => { if (!$('#picker').hidden && !e.target.closest('#picker')) closePicker(); });
$('#root-name').onclick = () => openPicker('dir'); $('#root-name').style.cursor = 'pointer';

// Shift 두 번 → 파일 찾기 (IntelliJ 의 Search Everywhere 처럼)
(() => {
  let last = 0, clean = true; // clean: Shift 누른 동안 다른 키/마우스 입력이 없었는지
  document.addEventListener('keydown', (e) => { if (e.key !== 'Shift') { last = 0; clean = false; } else if (!e.repeat) clean = true; });
  document.addEventListener('mousedown', () => { clean = false; last = 0; });
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Shift' || !clean) return;
    const now = Date.now();
    if (now - last < 450) { last = 0; $('#palette').hidden ? openPalette() : closePalette(); } else last = now;
  });
})();

// ───────── 본문 글자 크기: ⌘/Ctrl + / - / 0 (UI 는 고정, 편집기·마크다운·CSV·트리뷰 글자만 변경) ─────────
let contentScale = Math.min(3, Math.max(0.6, Number(store.get('contentScale', 1)) || 1));
const applyScale = () => document.documentElement.style.setProperty('--cz', contentScale);
let zoomFlash;
function drawZoom(flash) { // 상태바에 배율 표시: 100% 가 아니면 계속, 100% 일 땐 조절 직후에만 잠깐
  const z = $('#st-zoom'), pct = Math.round(contentScale * 100);
  z.textContent = `🔍 ${pct}%`;
  z.classList.toggle('flash', !!flash);
  clearTimeout(zoomFlash);
  z.hidden = pct === 100 && !flash;
  if (flash) zoomFlash = setTimeout(() => { z.classList.remove('flash'); z.hidden = Math.round(contentScale * 100) === 100; }, 1800);
}
$('#st-zoom').onclick = () => setScale(1);
function setScale(v) {
  contentScale = Math.min(3, Math.max(0.6, Math.round(v * 10) / 10));
  store.set('contentScale', contentScale); applyScale(); drawZoom(true);
}
applyScale(); drawZoom(false);
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  if (cur()?.kind === 'image') { // 이미지 탭: ⌘/Ctrl +/-/0 은 이미지 확대/축소/맞춤 (텍스트 글자 크기는 바뀌지 않는다)
    const f = e.key === '+' || e.key === '=' ? 1.25 : e.key === '-' || e.key === '_' ? 0.8 : e.key === '0' ? 0 : null;
    if (f !== null) { e.preventDefault(); e.stopPropagation(); f ? imgv.cur?.zoomBy(f) : imgv.cur?.cmd('fit'); }
    return;
  }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); setScale(contentScale + 0.1); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); setScale(contentScale - 0.1); }
  else if (e.key === '0') { e.preventDefault(); setScale(1); }
}, true);
document.addEventListener('wheel', (e) => { // ⌘/Ctrl + 휠, 트랙패드 핀치 (브라우저는 ctrlKey 로 전달)
  if (!(e.ctrlKey || e.metaKey) || cur()?.kind === 'image') return;   // 이미지 탭에서는 뷰어가 처리
  e.preventDefault(); setScale(contentScale + (e.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

// ───────── 사이드바 리사이즈 ─────────
(() => {
  const side = $('#sidebar'); side.style.width = store.get('sideW', 280) + 'px';
  if (store.get('noSide', false)) document.body.classList.add('no-side');
  $('#resizer').onmousedown = (e) => {
    e.preventDefault();
    const move = (ev) => { side.style.width = Math.max(140, Math.min(ev.clientX, innerWidth - 200)) + 'px'; };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); store.set('sideW', side.offsetWidth); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  };
})();

// ───────── 시작 ─────────
(async function init() {
  let info = await api('GET', 'info');
  if (!ROOT_Q) { // 폴더 지정 없이 열림(앱 아이콘 등): 마지막으로 열었던 폴더 복원
    const last = info.last || recents()[0];
    if (last && last !== info.root) return location.replace('/?root=' + encodeURIComponent(last));
  }
  state.root = info.root; state.version = info.version; state.platform = info.platform; state.memoDir = info.memoDir; state.home = info.home;
  api('PUT', 'last', {}, { root: info.root }).catch(() => {}); state.home = info.home;
  history.replaceState(null, '', '/?root=' + encodeURIComponent(info.root));
  $('#root-name').textContent = info.name; $('#root-name').title = info.root + '  (클릭 / ⌘⇧O: 폴더 열기)';
  addRecent(info.root); await loadFavs(); await loadSettings(); refreshGit(); if (state.filter) await fetchFilterDirs(); drawFilterBtn(); watchIndex();
  state.expanded = new Set(store.get(wsKey('expanded'), []));
  for (const s of store.get(wsKey('tabs'), [])) {
    if (isEnc(s.path)) continue;   // 암호화 문서는 다시 열 때 암호를 묻는다
    if (isGal(s.path)) { state.tabs.push({ path: s.path, kind: 'gallery', dir: s.path.slice(4) || '/', content: '', orig: '', mtime: 0, mode: 'view', preview: !!s.preview }); continue; }   // 이미지 갤러리
    if (kindOf(s.path) === 'image') { state.tabs.push({ path: s.path, content: '', orig: '', mtime: 0, kind: 'image', mode: 'view' }); continue; }
    try {
      const f = await api('GET', 'file', { path: s.path }); const kind = kindOf(s.path);
      state.tabs.push({ path: s.path, content: f.content, orig: f.content, mtime: f.mtime, kind, mode: MODES[kind].some((m) => m[0] === s.mode) ? s.mode : DEFAULT_MODE[kind] });
    } catch {}
  }
  const a = store.get(wsKey('active'), null);
  state.active = tabOf(a) ? a : state.tabs[0]?.path || null; state.selected = state.active || '';
  navLoad();   // 뒤로/앞으로 기록 (이 창의 세션)
  renderAll(); setView(state.view);
  connectEvents();   // 파일 변경 실시간 동기화
  let pendGal = null; try { pendGal = sessionStorage.getItem('ss:gallery'); sessionStorage.removeItem('ss:gallery'); } catch {}
  if (pendGal) { openGallery(pendGal); revealDirInTree(pendGal.replace(/\/+$/, '') || '/'); }   // 갤러리 하단 경로로 워크스페이스를 바꾼 경우: 갤러리를 이어서 열고 트리에 표시
})();
