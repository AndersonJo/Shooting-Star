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
async function api(method, route, params = {}, body, signal) {
  let rootDir = ROOT_Q;
  if (typeof params.path === 'string' && params.path.startsWith('@memo/')) { // 메모는 ~/.shooting-star/memos 를 루트로 접근
    rootDir = state.memoDir; params = { ...params, path: params.path.slice(6) };
    if (body && typeof body.to === 'string') body = { ...body, to: body.to.replace(/^@memo\//, '') };
  }
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/${route}${qs ? '?' + qs : ''}`, {
    method,
    headers: { 'X-SS': '1', ...(rootDir ? { 'X-SS-Root': encodeURIComponent(rootDir) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 1800);
}
async function copy(text, label = '복사됨') {
  try { await navigator.clipboard.writeText(text); }
  catch { // http 비-localhost 등 fallback
    const ta = el('textarea', { value: text }); document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(`${label} (${text.length.toLocaleString()}자)`);
}
const setStatus = (msg, cls = '') => { const s = $('#st-msg'); s.textContent = msg || ''; s.className = cls; };

// ───────── 파일 종류 ─────────
const extOf = (p) => (p.match(/\.([^./]+)$/)?.[1] || '').toLowerCase();
const IMG_EXT = new Set('png jpg jpeg gif webp avif svg bmp ico tif tiff heic heif'.split(' '));
function kindOf(p) {
  const e = extOf(p);
  if (IMG_EXT.has(e)) return 'image';
  if (['md', 'markdown', 'mdx'].includes(e)) return 'md';
  if (e === 'json' || e === 'jsonc' || e === 'geojson') return 'json';
  if (e === 'jsonl' || e === 'ndjson') return 'jsonl';
  if (['yml', 'yaml'].includes(e)) return 'yaml';
  if (['csv', 'tsv'].includes(e)) return 'csv';
  return 'text';
}
const ICON = { md: 'M↓', json: '{}', jsonl: '{}', yaml: 'Y', csv: '▦', text: '≡', image: '▣' };
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
  store.set(wsKey('tabs'), state.tabs.filter((t) => t.kind !== 'diff').map((t) => ({ path: t.path, mode: t.mode })));
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
async function renderTree() {
  const seq = ++treeSeq;   // 연달아 호출되면 마지막 호출의 결과만 화면에 반영한다
  const root = $('#tree'); const scroll = root.scrollTop;
  const frag = document.createDocumentFragment();
  async function walk(dir, depth) {
    let list = childrenCache.get(dir);
    if (!list) { try { list = await loadDir(dir); } catch { return; } }
    for (const e of list) {
      const p = dir ? dir + '/' + e.name : e.name;
      if (state.filter && state.filterDirs) { // 필터: 설정된 형식의 파일이 있는 폴더 / 그 형식의 파일만
        if (e.dir ? !state.filterDirs.has(p) : !fileMatchesFilter(e.name)) continue;
      }
      const open = e.dir && state.expanded.has(p);
      const tab = !e.dir && tabOf(p);
      const gm = e.dir ? gitMarks.dirs.get(p) : gitMarks.files.get(p);   // git 변경 표시 (M 수정 / A 새 파일 / U 충돌)
      const row = el('div', { className: 'row' + (state.selected === p ? ' sel' : '') + (tab && dirty(tab) ? ' dirty' : '') + (gm ? ' g-' + gm + (e.dir ? ' g-dir' : '') : '') },
        el('span', { className: 'arrow', textContent: e.dir ? (open ? '▼' : '▶') : '' }),
        e.dir ? el('span', { className: 'ico dir' }) : el('span', { className: 'ico k-' + kindOf(e.name), textContent: ICON[kindOf(e.name)] }),
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
// 폴더: 닫혀 있으면 클릭 = 펼치고 선택 / 이미 열려 있으면 클릭 = 선택만 / 더블클릭 = 닫기 (화살표 클릭도 접기·펼치기), 파일: 클릭 = 열기
// 더블클릭은 클릭 간격(0.4초)으로 직접 판정한다 (첫 클릭에 트리를 다시 그려도 두 번째 클릭을 놓치지 않는다)
let lastDirClick = { p: '', t: 0 };
$('#tree').addEventListener('click', async (ev) => {
  const row = ev.target.closest('.row'); if (!row) return;
  const p = row.dataset.path; state.selected = p;
  if (!row.dataset.dir) { await openFile(p); return; }
  if (ev.target.closest('.arrow')) return toggleDir(p);
  const now = Date.now(), dbl = lastDirClick.p === p && now - lastDirClick.t < 400;
  lastDirClick = { p, t: dbl ? 0 : now };
  if (dbl) return toggleDir(p);                       // 더블클릭: 닫기
  if (!state.expanded.has(p)) return toggleDir(p);    // 닫혀 있으면 펼치고 선택
  document.querySelectorAll('#tree .row.sel').forEach((r) => r.classList.remove('sel')); row.classList.add('sel');   // 이미 열려 있으면 선택만
});
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
const dirOfSel = () => { const s = state.selected || ''; if (!s || isMemo(s)) return ''; const row = [...document.querySelectorAll('#tree .row')].find((r) => r.dataset.path === s); return row?.dataset.dir ? s : dirOf(s); };
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
      const f = await api('GET', 'file', { path: p });
      const kind = kindOf(p);
      t = { path: p, content: f.content, orig: f.content, mtime: f.mtime, kind, mode: mode || DEFAULT_MODE[kind] };
      state.tabs.push(t);
    } catch (e) { toast(`열 수 없음: ${e.message}`); return; }
  }
  state.active = p; state.selected = p;
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
  let root = state.root, p = t.path; if (isMemo(p)) { root = state.memoDir; p = p.slice(6); }
  fetch('/api/file?path=' + encodeURIComponent(p), { method: 'PUT', keepalive: true, headers: { 'X-SS': '1', 'X-SS-Root': encodeURIComponent(root), 'Content-Type': 'application/json' }, body: JSON.stringify({ content: t.content, mtime: t.mtime }) }).catch(() => {});
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
  if (isMemo(p) && !t.content.replace(/#/g, '').trim()) api('DELETE', 'file', { path: p }).then(refreshMemos).catch(() => {}); // 비어 있는 메모는 닫을 때 삭제
  if (state.active === p) state.active = (state.tabs[i] || state.tabs[i - 1])?.path || null;
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
  if (!t || t.kind === 'image' || t.kind === 'diff' || isMemo(t.path) && t.path !== state.active) return;
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
let fsTimer;
function onFsEvent(d) { // d: { paths, all }
  clearTimeout(fsTimer);
  fsTimer = setTimeout(async () => {
    if (d.all) childrenCache.clear(); else for (const p of d.paths) { childrenCache.delete(dirOf(p)); childrenCache.delete(p); }
    if (state.filter) await fetchFilterDirs();
    renderTree();
    const set = d.all ? null : new Set(d.paths);
    for (const t of state.tabs) {
      if (t.kind === 'diff') { t.stale = true; if (t.path === state.active) renderContent(); continue; }   // 열려 있는 diff 는 다시 계산
      if (t.kind === 'image') { if (!set || set.has(t.path)) { imgv.ver.set(t.path, Date.now()); if (t.path === state.active) renderContent(); } continue; }   // 이미지가 바뀌면 다시 불러온다
      if (!isMemo(t.path) && (!set || set.has(t.path))) syncTab(t);
    }
    if (isMemo(state.active)) syncTab(cur());
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
  lastActivate = Date.now(); onFsEvent({ all: true, paths: [] }); refreshGit();
}
window.addEventListener('focus', onActivate);
document.addEventListener('visibilitychange', onActivate);
window.addEventListener('pageshow', onActivate);
window.onNativeActivate = onActivate;   // macOS 앱 껍데기에서 호출

// ───────── 렌더링 ─────────
function renderAll() { renderTabs(); renderToolbar(); renderContent(); renderTree(); validate(); }
function renderChrome() { renderTabs(); renderToolbar(); renderTree(); validate(); }

function renderTabs() {
  const box = $('#tabs');
  box.replaceChildren(...state.tabs.map((t) => {
    const x = el('span', { className: 'x', title: '닫기 (⌘W)' });
    x.onclick = (e) => { e.stopPropagation(); closeTab(t.path); };
    const tab = el('div', { className: 'tab' + (t.path === state.active ? ' active' : '') + (dirty(t) ? ' dirty' : '') + (t.conflict ? ' conflict' : '') + (t.missing ? ' missing' : ''), title: (t.kind === 'diff' ? `${t.repoName}: ${t.file} — 변경 내용` : t.path) + (t.conflict ? '  — 외부에서도 수정됨' : '') + (t.missing ? '  — 삭제/이동됨' : '') },
      el('span', { textContent: isMemo(t.path) ? (memoTitle(t.content) || '새 메모') : t.kind === 'diff' ? t.file.split('/').pop() + ' (diff)' : t.path.split('/').pop() }), x);
    tab.onclick = () => { flushAll(); state.active = t.path; state.selected = t.path; persistTabs(); renderAll(); };
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
        ['경로 복사', () => copy(isMemo(t.path) ? state.memoDir + '/' + t.path.slice(6) : state.root + '/' + t.path, '전체 경로 복사됨')],
        ...(isMemo(t.path) ? [] : [[`${FM}에서 보기`, () => revealPath(t.path, 'reveal')]]),
      ].map((it) => (it === '-' ? ['-'] : it)));
    };
    return tab;
  }));
  box.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  document.title = (cur() ? cur().path.split('/').pop() + (dirty(cur()) ? ' ●' : '') + ' — ' : '') + 'shooting-star';
}

function btn(label, title, onclick, cls = '') {
  return el('button', { textContent: label, title, onclick, className: cls });
}
function renderToolbar() {
  const bar = $('#toolbar'); const t = cur();
  drawPath(t);   // 전체 경로는 하단 상태바에 표시
  if (!t) { bar.replaceChildren(); return; }
  if (t.kind === 'diff') {
    const seg = el('span', { className: 'seg' }, ...MODES.diff.map(([m, label]) => btn(label, '', () => { t.mode = m; store.set('diffMode', m); renderToolbar(); renderContent(); }, t.mode === m ? 'on' : '')));
    bar.replaceChildren(el('span', { className: 'path' }), seg, el('span', { className: 'sep' }),
      ...(t.rel && !t.gone ? [btn('파일 열기', '이 파일을 편집기로 열기', () => openFile(t.rel))] : []),
      btn('새로고침', '변경 내용 다시 계산', () => loadDiff(t)));
    return;
  }
  if (t.kind === 'image') {
    bar.replaceChildren(el('span', { className: 'path' }),
      btn('경로', '경로 복사 (Shift: 절대경로)', (e) => copy(e.shiftKey ? state.root + '/' + t.path : t.path, '경로 복사됨')),
      btn('맞춤', '화면에 맞춤 (0)', () => imgCmd('fit')), btn('100%', '원본 크기 (1)', () => imgCmd('actual')), btn('전체화면', '전체화면 (F)', () => imgCmd('fs')));
    return;
  }
  const items = [el('span', { className: 'path' })];
  const modes = MODES[t.kind];
  if (modes.length > 1) {
    const seg = el('span', { className: 'seg' }, ...modes.map(([m, label]) =>
      btn(label, '', () => { t.mode = m; persistTabs(); renderToolbar(); renderContent(); }, t.mode === m ? 'on' : '')));
    items.push(seg, el('span', { className: 'sep' }));
  }
  items.push(
    btn('복사', '전체 내용 복사', () => copy(t.content, '전체 복사됨')),
    btn('경로', '경로 복사 (Shift: 절대경로)', (e) => copy(isMemo(t.path) ? state.memoDir + '/' + t.path.slice(6) : e.shiftKey ? state.root + '/' + t.path : t.path, '경로 복사됨')),
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
  if (t && t.kind === 'diff') return setStatus(t.stat || '');
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
  if (!t) { box.replaceChildren(EMPTY); return; }
  if (t.kind === 'image') { box.replaceChildren(imageViewer(t)); validate(); return; }
  if (t.kind === 'diff') { box.replaceChildren(diffView(t)); validate(); return; }
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
  updatePreview();
  validate();
  if (fb.open) { placeFindBar(); runFileFind(true); }   // 탭/모드가 바뀌어도 검색 유지
}
const renderToolbarDirtyOnly = () => renderToolbar();

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
    if (pendingPvScroll != null) { pv.scrollTop = pendingPvScroll; pendingPvScroll = null; }   // 외부 변경으로 다시 그려도 보던 위치 유지
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
function renderMarkdown(t, htmlOverride) { // htmlOverride: 이미 변환/정화된 HTML 조각(스마트 편집의 블록)
  marked.setOptions({ gfm: true, breaks: false });
  const html = htmlOverride ?? DOMPurify.sanitize(marked.parse(t.content), { USE_PROFILES: { html: true } });
  const doc = el('div', { className: 'md' }); doc.innerHTML = html;
  const base = dirOf(t.path);
  doc.querySelectorAll('img').forEach((img) => {
    const s = img.getAttribute('src');
    if (s && !/^([a-z]+:|\/\/|data:)/i.test(s)) {
      const rp = resolveRel(base, decodeURI(s));
      img.src = isMemo(t.path) ? '/raw?root=' + encodeURIComponent(state.memoDir) + '&path=' + encodeURIComponent(rp.replace(/^@memo\//, '')) : '/raw?root=' + encodeURIComponent(state.root) + '&path=' + encodeURIComponent(rp);   // 메모는 ~/.shooting-star/memos 기준
    }
  });
  doc.querySelectorAll('a').forEach((a) => {
    const h = a.getAttribute('href') || '';
    if (/^[a-z]+:|^\/\//i.test(h)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    else if (h.startsWith('#')) { a.onclick = (e) => { e.preventDefault(); doc.querySelector('[id="' + CSS.escape(h.slice(1)) + '"]')?.scrollIntoView(); }; }
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
    pre.append(b);
  });
  // heading id (anchor 링크용)
  doc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    h.id ||= h.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
  });
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
function showMenu(x, y, items) {
  const m = $('#menu');
  m.replaceChildren(...items.map(([label, fn, cls]) => {
    if (label === '-') return el('hr');   // 구분선
    const d = el('div', { textContent: label, className: cls || '' });
    d.onclick = () => { m.hidden = true; fn(); }; return d;
  }));
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 4) + 'px';
  m.style.top = Math.min(y, innerHeight - m.offsetHeight - 4) + 'px';
}
document.addEventListener('click', () => ($('#menu').hidden = true));
$('#tree').addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const row = ev.target.closest('.row');
  const p = row?.dataset.path ?? ''; const isDir = row ? !!row.dataset.dir : true;
  const baseDir = isDir ? p : dirOf(p);
  const FM = state.platform === 'darwin' ? 'Finder' : '파일 관리자';
  const items = [
    ['새 파일…', () => createEntry(baseDir, false)],
    ['새 폴더…', () => createEntry(baseDir, true)],
    ...(row && isDir ? [[favs.includes(state.root + '/' + p) ? '즐겨찾기에서 제거' : '★ 즐겨찾기에 추가', () => toggleFavDir(state.root + '/' + p)]] : []),
    [isDir ? `${FM}에서 열기` : `${FM}에서 보기`, () => revealPath(p, 'reveal')],
  ];
  if (!isDir) items.push(['기본 앱으로 열기', () => revealPath(p, 'open')]);
  if (state.platform === 'darwin') items.push(['터미널에서 열기', () => revealPath(p, 'terminal')]);
  if (row) items.push(
    ['이름 변경…', () => renameEntry(p)],
    ['경로 복사', () => copy(p, '경로 복사됨')],
    ['절대경로 복사', () => copy(state.root + '/' + p, '절대경로 복사됨')],
    ['삭제', () => deleteEntry(p, isDir), 'danger']);
  showMenu(ev.clientX, ev.clientY, items);
});
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
const pal = { files: null, items: [], sel: 0 };
async function openPalette() {
  $('#palette').hidden = false; const inp = $('#pal-input'); inp.value = ''; inp.focus();
  pal.files = await api('GET', 'files'); filterPalette('');
}
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
function filterPalette(q) {
  const recent = state.tabs.map((t) => t.path).filter((p) => !isMemo(p));
  const res = q
    ? pal.files.map((f) => ({ f, m: matchFile(q, f) })).filter((x) => x.m)
        .sort((a, b) => a.m.tier - b.m.tier || a.f.length - b.f.length || a.f.localeCompare(b.f)).slice(0, 80)
    : [...recent, ...pal.files.filter((f) => !recent.includes(f))].slice(0, 80).map((f) => ({ f, m: { pos: [] } }));
  pal.items = res; pal.sel = 0; drawPalette();
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
      el('span', { className: 'ico k-' + kind, textContent: ICON[kind] }),
      el('span', { className: 'pn' }, part(f.slice(b0), b0)),
      el('span', { className: 'pd' }, part(f.slice(0, b0 - 1), 0)));
    li.onclick = () => { closePalette(); openFile(f); };
    return li;
  }));
  $('#pal-list .sel')?.scrollIntoView({ block: 'nearest' });
}
const closePalette = () => { $('#palette').hidden = true; };
$('#pal-input').oninput = (e) => filterPalette(e.target.value);
$('#pal-input').onkeydown = (e) => {
  if (e.key === 'Escape') closePalette();
  else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) { e.preventDefault(); pal.sel = Math.min(pal.sel + 1, pal.items.length - 1); drawPalette(); }
  else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) { e.preventDefault(); pal.sel = Math.max(pal.sel - 1, 0); drawPalette(); }
  else if (e.key === 'PageDown') { e.preventDefault(); pal.sel = Math.min(pal.sel + 8, pal.items.length - 1); drawPalette(); }
  else if (e.key === 'PageUp') { e.preventDefault(); pal.sel = Math.max(pal.sel - 8, 0); drawPalette(); }
  else if (e.key === 'Enter' && pal.items[pal.sel]) { const f = pal.items[pal.sel].f; closePalette(); openFile(f); }
};
document.addEventListener('mousedown', (e) => { if (!$('#palette').hidden && !e.target.closest('#palette')) closePalette(); });

// ───────── 트리에서 ⌘/Ctrl+C → 선택한 파일/폴더의 전체 경로 복사 (Shift 를 같이 누르면 프로젝트 기준 상대 경로) ─────────
function selectedPath(relative) {
  const sel = state.selected || '';
  if (isMemo(sel)) return state.memoDir + '/' + sel.slice(6);
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
  else if (k === 'o') { e.preventDefault(); openPicker(); }
  else if (k === 'b') { e.preventDefault(); document.body.classList.toggle('no-side'); store.set('noSide', document.body.classList.contains('no-side')); }
  else if (k === 'w' && cur()) { e.preventDefault(); closeTab(state.active); }
  else if (e.code === 'KeyN' && e.altKey) { e.preventDefault(); newMemo(); }
  else if (k === ',') { e.preventDefault(); $('#settings') && !$('#settings').hidden ? ($('#settings').hidden = true) : openSettings(); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); openFind(); }
  else if (k === 'f' && !e.shiftKey && !e.altKey) { e.preventDefault(); openFileFind(); }
  else if (k === 'g' && fb.open) { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  else if (e.code === 'KeyL' && e.altKey) { e.preventDefault(); prettify(); }
  else if (k === 'e' && cur()) { // 보기 ↔ 편집
    e.preventDefault(); const t = cur(); const ms = MODES[t.kind].map((m) => m[0]);
    t.mode = ms[(ms.indexOf(t.mode) + 1) % ms.length]; persistTabs(); renderToolbar(); renderContent();
  }
});

// ───────── 파일 인덱스 상태 (서버가 백그라운드로 인덱싱) ─────────
async function watchIndex() {
  const box = $('#st-idx'); let lastTs = 0;
  for (let i = 0; i < 600; i++) {
    try {
      const s = await api('GET', 'index');
      if (s.ts !== lastTs) { lastTs = s.ts; if (state.filter && s.ready) fetchFilterDirs().then(renderTree); } // 파일이 생기거나 사라지면 필터 갱신
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
      el('button', { id: 'ff-scope', onclick: openSettings }), close),
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
  document.addEventListener('mousedown', (e) => { if (!panel.hidden && !e.target.closest('#find') && !e.target.closest('#settings')) closeFind(); });
}
function openFind() {
  buildFind();
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
    const r = await api('GET', 'search', { q, glob: $('#ff-glob').value, exts: searchExts(), case: +ff.opts.case, word: +ff.opts.word, regex: +ff.opts.regex }, null, ctl.signal);
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
  const split = t.mode === 'split', td = (cls, text) => el('td', { className: cls, textContent: text ?? '' });
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
  box.append(tbl); return box;
}
$('#btn-git-refresh').onclick = loadGit;

// ───────── 아이콘 바: 파일 / 메모 ─────────
function setView(v, forceShow) {
  state.view = v; store.set('view', v);
  $('#sidebar').classList.toggle('memo', v === 'memo');
  $('#sidebar').classList.toggle('git', v === 'git');
  $('#memo-view').hidden = v !== 'memo';
  $('#git-view').hidden = v !== 'git';
  document.querySelectorAll('#activity .act').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  if (forceShow) document.body.classList.remove('no-side');
  if (v === 'git') loadGit();
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
  if (!cur() || cur().kind === 'image' || cur().kind === 'diff') return;
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
  document.querySelectorAll('#preview mark.fmd, .smart-doc mark.fmd').forEach((m) => m.replaceWith(m.textContent));
  ($('#preview') || $('.smart-doc'))?.normalize();
}
// 화면(DOM) 텍스트에서 찾아 <mark> 로 감싼다. 반환: mark 요소 배열
function markDom(root, re0, limit = 5000) {
  const re = new RegExp(re0.source, re0.flags), marks = [], nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('button, script, style') || !n.data.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
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
function runFileFind(fresh) {
  if (!fb.open) return;
  store.set('fbq', fb.q);
  const ta = $('textarea.editor'), pv = $('#preview') || $('.smart-doc'), re = fbRegex();
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
  gotoFind(fb.idx);
}
function drawFindCount(re) {
  const c = $('#fb-count'); const n = fb.matches.length;
  c.classList.toggle('none', (!!fb.q && !n) || re === 'bad');
  c.textContent = re === 'bad' ? '정규식 오류' : !fb.q ? '' : n ? `${fb.idx + 1}/${n}${n >= 10000 ? '+' : ''}` : '결과 없음';
}
function gotoFind(i) {
  const n = fb.matches.length; fb.idx = n ? ((i % n) + n) % n : -1; drawFindCount();
  const m = fb.matches[fb.idx]; if (!m) { renderFM(); return; }
  if (fb.dom) {
    document.querySelectorAll('#preview mark.fmd.cur, .smart-doc mark.fmd.cur').forEach((x) => x.classList.remove('cur'));
    m.classList.add('cur'); m.scrollIntoView({ block: 'center', inline: 'nearest' });
  } else {
    renderFM();
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
const IMG_CACHE_MAX = 14;
const imgKey = (p, full) => `${full ? 'F' : 'T'}|${p}|${imgv.ver.get(p) || 0}`;
const fitW = () => Math.min(3840, Math.max(1024, Math.ceil((screen.width * (devicePixelRatio || 1)) / 256) * 256));
const imgUrl = (p, full) => `/${full ? 'raw' : 'thumb'}?root=${encodeURIComponent(state.root)}&path=${encodeURIComponent(p)}${full ? '' : '&w=' + fitW()}&v=${imgv.ver.get(p) || 0}`;
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
function imgInfo(p) {
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

function imageViewer(t) {
  const box = el('div', { className: 'imgv active' }), stage = el('div', { className: 'iv-stage' });
  const name = el('span', { className: 'iv-name' }), count = el('span', { className: 'iv-count' }), meta = el('span', { className: 'iv-meta' }), zoomL = el('span', { className: 'iv-zoom' });
  const mk = (txt, title, fn, cls = '') => { const b = el('button', { textContent: txt, title, className: 'iv-btn ' + cls }); b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
  const spin = el('div', { className: 'iv-spin' }); spin.hidden = true;
  box.append(stage, mk('‹', '이전 (←)', () => go(-1), 'iv-nav l'), mk('›', '다음 (→)', () => go(1), 'iv-nav r'),
    el('div', { className: 'iv-hud' }, name, count, meta, zoomL),
    el('div', { className: 'iv-tools' }, mk('－', '축소 (- 또는 Ctrl -)', () => zoomBy(0.8)), mk('＋', '확대 (+ 또는 Ctrl +)', () => zoomBy(1.25)), mk('맞춤', '화면에 맞춤 (0)', () => cmd('fit')), mk('100%', '원본 크기 (1)', () => cmd('actual')), mk('⛶', '전체화면 (F)', () => cmd('fs'))), spin);
  const v = { path: t.path, list: [t.path], idx: 0, el: null, iw: 1, ih: 1, s: 1, tx: 0, ty: 0, fitMode: true, thumbMode: false, tok: 0, dir: 1, fs: false, info: null, noUpscale: true };
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
    place(e.img); setFit(); hud(e);
    if (t.path !== p) { const wasActive = state.active === t.path; t.path = p; if (wasActive) state.active = p; state.selected = p; persistTabs(); renderChrome(); }   // 탭 이름/활성 탭/트리 선택도 따라간다
    preload(i);
  }
  let preTok = 0;
  async function preload(i) { // 진행 방향 우선으로 앞뒤 이미지를 미리 디코딩
    const mine = ++preTok, order = v.dir >= 0 ? [1, 2, -1, 3, -2] : [-1, -2, 1, -3, 2];
    for (const d of order) { const j = i + d; if (j < 0 || j >= v.list.length) continue; await loadImg(v.list[j], false).promise; if (mine !== preTok) return; }
  }
  const go = (d) => { const j = v.idx + d; if (j < 0 || j >= v.list.length) return; v.dir = d; show(j); };
  function setFs(on) { v.fs = on; box.classList.toggle('fs', on); }
  function cmd(c) {
    if (c === 'fit') setFit();
    else if (c === 'actual') zoomAt(1, cw() / 2, ch() / 2);
    else if (c === 'fs') {
      const native = window.webkit?.messageHandlers?.fullscreen;
      if (native) native.postMessage('toggle');                       // 네이티브 앱: 창 전체화면 (상태는 onNativeFullscreen 으로 돌아온다)
      else if (document.fullscreenElement) document.exitFullscreen();
      else (box.requestFullscreen ? box.requestFullscreen() : Promise.reject()).catch(() => setFs(!v.fs));   // Fullscreen API 가 안 되면 창 안에서 전체 덮기
    }
  }
  // 입력: 휠(확대/가로 스와이프=이동), 드래그(이동), 더블클릭(맞춤↔원본), 핀치, 키보드
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
  stage.addEventListener('dblclick', (e) => { const r = stage.getBoundingClientRect(); if (v.fitMode) zoomAt(Math.abs(fitScale() - 1) > 0.01 ? 1 : 2, e.clientX - r.left, e.clientY - r.top); else setFit(); });   // 맞춤 → 100% (이미 100% 면 2배), 다시 누르면 맞춤
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
  (async () => { // 같은 폴더의 이미지 목록 (트리와 같은 정렬)
    show(0);
    const dir = dirOf(t.path); let ls = childrenCache.get(dir); if (!ls) { try { ls = await loadDir(dir); } catch { ls = []; } }
    const list = ls.filter((x) => !x.dir && IMG_EXT.has(extOf(x.name))).map((x) => (dir ? dir + '/' + x.name : x.name));
    if (list.includes(t.path)) { v.list = list; v.idx = list.indexOf(t.path); hud(null); hud(v.info ? { info: v.info } : null); preload(v.idx); }
  })();
  return box;
}

// ───────── 마크다운 이미지 첨부 ─────────
// 편집기에 이미지를 붙여넣거나 끌어놓으면 <문서 폴더>/images/ 에 저장하고, 커서 위치에 ![이름](images/파일) 을 넣는다.
async function uploadImage(destRel, file) {
  let root = state.root, p = destRel;
  if (isMemo(p)) { root = state.memoDir; p = p.slice(6); }   // 메모는 ~/.shooting-star/memos/images/
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
    blocks.forEach((b, i) => { if (b.type !== 'space') els.push(blockEl(b, i)); });
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
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (/^\s*([-*+]|\d+[.)])\s/.test(line)) { ta.setSelectionRange(ls, ls); document.execCommand('insertText', false, e.shiftKey ? '' : '  '); ta.setSelectionRange(s + 2, s + 2); } else document.execCommand('insertText', false, '  '); }
  }
  async function attach(files) { // 편집 중이면 커서 위치에, 아니면 마지막으로 만진 블록 뒤(없으면 문서 끝)에 이미지 블록으로 추가
    const ta = doc.querySelector('.sb-ta'); if (ta) return attachImages(files, ta);
    const { parts } = await uploadImages(t, files); if (!parts.length) return;
    lastIdx = insertBlockAfter(lastIdx >= 0 && lastIdx < blocks.length ? lastIdx : blocks.length - 1, parts.join('\n\n')); changed(); render();
  }
  // 입력: 블록 클릭=편집 (링크는 ⌘/Ctrl+클릭으로 이동), 체크박스 토글, 이미지 붙여넣기/끌어놓기, 문서 단위 되돌리기
  doc.addEventListener('mousedown', (e) => {
    const sb = e.target.closest('.sb'); if (!sb || sb.classList.contains('editing')) return;
    if (e.target.closest('.cp, input[type=checkbox]')) return;
    if (e.target.closest('a') && (e.metaKey || e.ctrlKey)) return;
    e.preventDefault(); startEdit(+sb.dataset.i, 'end');   // mousedown 을 막아 두면 편집 중이던 입력창이 먼저 blur 되며 화면이 바뀌는 일이 없다
  });
  doc.addEventListener('click', (e) => { if (e.target.closest('a') && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
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
async function revealInTree(rel, isDir) { // 해당 항목까지 폴더를 펼치고 선택한 뒤 화면 가운데로 스크롤
  if (document.body.classList.contains('no-side') || state.view === 'memo' || state.view === 'git') setView('files', true);
  const parts = rel ? rel.split('/') : []; let acc = '';
  for (let i = 0; i < parts.length - (isDir ? 0 : 1); i++) { acc = acc ? acc + '/' + parts[i] : parts[i]; state.expanded.add(acc); }
  state.selected = rel; persistTabs(); await renderTree();
  const row = [...document.querySelectorAll('#tree .row')].find((r) => r.dataset.path === rel);
  if (row) row.scrollIntoView({ block: 'center' }); else $('#tree').scrollTop = 0;
}
function drawPath(t) {
  const box = $('#st-path'); box.replaceChildren(); if (!t) return;
  const inner = el('span', { className: 'pth' }); box.append(inner);
  if (t.kind === 'diff') { inner.textContent = (t.repo + '/' + t.file).replace(state.home || '\u0000', '~'); inner.title = '변경 내용 (diff)'; return; }
  if (isMemo(t.path)) { inner.textContent = ((state.memoDir || '') + '/' + t.path.slice(6)).replace(state.home || '\u0000', '~'); inner.title = '메모 파일 위치'; return; }
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
      else if (isRoot) { if (document.body.classList.contains('no-side') || state.view === 'memo' || state.view === 'git') setView('files', true); state.selected = ''; renderTree().then(() => { $('#tree').scrollTop = 0; }); }
      else go(s.abs);   // 프로젝트 루트보다 위: 그 폴더를 워크스페이스로 연다
    };
    inner.append(seg); if (i < view.length - 1) inner.append(el('span', { className: 'sep', textContent: '/' }));
  });
}

// ───────── 폴더 열기 (⌘O) ─────────
const recents = () => store.get('recent', []);
function addRecent(p) { store.set('recent', [p, ...recents().filter((x) => x !== p)].slice(0, 12)); }
const pk = { items: [], sel: 0, dir: '' };
// 즐겨찾기 폴더 (서버의 ~/.config/shooting-star/favorites.json 에 저장)
let favs = [];
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
    box.replaceChildren(head, el('div', { className: 'fav-empty', textContent: '위의 ☆ 로 현재 폴더 추가' }));
    return;
  }
  const rows = favs.map((f) => {
    const x = el('span', { className: 'fx', textContent: '✕', title: '즐겨찾기에서 제거' });
    x.onclick = async (e) => { e.stopPropagation(); favs = favs.filter((y) => y !== f); await saveFavs(); };
    const segs = f.split('/').filter(Boolean), inside = f.startsWith(state.root + '/');
    const row = el('div', { className: 'fav' + (f === state.root ? ' cur' : ''), title: f + (f === state.root ? '' : inside ? '\n클릭: 트리에서 이 폴더로 이동' : '\n클릭: 이 폴더를 워크스페이스로 열기') },
      el('span', { className: 'fn', textContent: segs.at(-1) || '/' }), segs.length > 1 ? el('span', { className: 'fp', textContent: segs.at(-2) }) : '', x);   // 같은 이름이 여러 개여도 구분되도록 상위 폴더 이름을 흐리게 덧붙인다
    row.onclick = () => {
      if (f === state.root) revealInTree('', true);   // 현재 폴더면 트리 맨 위로
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
const go = (p) => { addRecent(p); location.href = '/?root=' + encodeURIComponent(p); };
async function pruneRecents() { // 삭제되었거나 이동된 폴더는 최근 목록에서 제거
  const alive = new Set();
  await Promise.all(recents().map(async (r) => { try { await api('GET', 'browse', { path: r }); alive.add(r); } catch {} }));
  store.set('recent', recents().filter((r) => alive.has(r)));
}
async function openPicker() {
  $('#picker').hidden = false; const inp = $('#pk-input');
  inp.value = state.root + '/'; inp.focus(); await pruneRecents(); await pkLoad();
}
const closePicker = () => { $('#picker').hidden = true; };
async function pkLoad() {
  const v = $('#pk-input').value;
  const slash = v.lastIndexOf('/'); const dir = v.slice(0, slash + 1) || '/'; const part = v.slice(slash + 1).toLowerCase();
  let items = [];
  try {
    const r = await api('GET', 'browse', { path: dir });
    pk.dir = r.path;
    items.push({ label: '▶ 이 폴더 열기: ' + r.path, openPath: r.path, act: () => go(r.path) });
    if (r.parent) items.push({ label: '..', act: () => { $('#pk-input').value = r.parent.replace(/\/?$/, '/'); pkLoad(); } });
    for (const d of r.dirs) if (d.toLowerCase().startsWith(part))
      items.push({ label: '📁 ' + d, act: () => { $('#pk-input').value = r.path.replace(/\/$/, '') + '/' + d + '/'; pkLoad(); } });
  } catch { items.push({ label: '(존재하지 않는 경로)', act: () => {} }); }
  if (!part) {
    const favItems = favs.map((f) => ({ label: '★ ' + f, act: () => go(f), remove: f }));
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
$('#pk-input').oninput = pkLoad;
$('#pk-input').onkeydown = (e) => {
  if (e.key === 'Escape') closePicker();
  else if (e.key === 'ArrowDown') { e.preventDefault(); pk.sel = Math.min(pk.sel + 1, pk.items.length - 1); drawPicker(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pk.sel = Math.max(pk.sel - 1, 0); drawPicker(); }
  else if (e.key === 'Enter') { e.preventDefault(); (e.metaKey || e.ctrlKey ? () => go(pk.dir) : pk.items[pk.sel]?.act)?.(); }
};
document.addEventListener('mousedown', (e) => { if (!$('#picker').hidden && !e.target.closest('#picker')) closePicker(); });
$('#root-name').onclick = openPicker; $('#root-name').style.cursor = 'pointer';

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
  $('#root-name').textContent = info.name; $('#root-name').title = info.root + '  (클릭 / ⌘O: 폴더 열기)';
  addRecent(info.root); await loadFavs(); await loadSettings(); refreshGit(); if (state.filter) await fetchFilterDirs(); drawFilterBtn(); watchIndex();
  state.expanded = new Set(store.get(wsKey('expanded'), []));
  for (const s of store.get(wsKey('tabs'), [])) {
    if (kindOf(s.path) === 'image') { state.tabs.push({ path: s.path, content: '', orig: '', mtime: 0, kind: 'image', mode: 'view' }); continue; }
    try {
      const f = await api('GET', 'file', { path: s.path }); const kind = kindOf(s.path);
      state.tabs.push({ path: s.path, content: f.content, orig: f.content, mtime: f.mtime, kind, mode: MODES[kind].some((m) => m[0] === s.mode) ? s.mode : DEFAULT_MODE[kind] });
    } catch {}
  }
  const a = store.get(wsKey('active'), null);
  state.active = tabOf(a) ? a : state.tabs[0]?.path || null; state.selected = state.active || '';
  renderAll(); setView(state.view);
  connectEvents();   // 파일 변경 실시간 동기화
})();
