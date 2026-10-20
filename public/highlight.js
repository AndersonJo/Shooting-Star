'use strict';
// 의존성 없는 경량 구문 강조. highlight(lang, text) → HTML 문자열 (클래스 tk-*)
(() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const span = (c, t) => `<span class="tk-${c}">${esc(t)}</span>`;
  const words = (s) => '\\b(?:' + s.trim().split(/\s+/).join('|') + ')\\b';

  // rules: [class, regexSource(non-capturing only), optional formatter]. 앞선 규칙이 우선.
  function compile(rules) {
    return { re: new RegExp(rules.map((r) => '(' + r[1] + ')').join('|'), 'gm'), rules };
  }
  function lex(text, { re, rules }) {
    let out = '', last = 0, m; re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      const r = rules[m.findIndex((x, i) => i > 0 && x !== undefined) - 1];
      out += esc(text.slice(last, m.index)) + (r[2] ? r[2](m[0]) : span(r[0], m[0]));
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }

  const NUM = String.raw`(?<![\w.])[-+]?(?:0[xX][\da-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][-+]?\d+)?)(?![\w.])`;

  // ── JSON / JSONC / JSONL
  const json = compile([
    ['c', String.raw`//[^\n]*|/\*[\s\S]*?\*/`],
    ['k', String.raw`"(?:\\.|[^"\\\n])*"(?=\s*:)`],
    ['s', String.raw`"(?:\\.|[^"\\\n])*"`],
    ['n', String.raw`-?\d+\.?\d*(?:[eE][+-]?\d+)?`],
    ['b', String.raw`\b(?:true|false|null)\b`],
    ['p', String.raw`[\[\]{},:]`],
  ]);

  // ── YAML: 줄 단위 (키 / 값 / 블록 스칼라)
  const yamlVal = compile([
    ['c', String.raw`(?<!\S)#[^\n]*`],
    ['s', String.raw`"(?:\\.|[^"\\\n])*"|'(?:[^'\n]|'')*'`],
    ['a', String.raw`(?<![\w])[&*][\w-]+|![\w!<>:./-]*`],
    ['b', String.raw`(?<![\w.-])(?:true|false|True|False|TRUE|FALSE|yes|no|Yes|No|on|off|null|Null|NULL|~)(?![\w.-])`],
    ['n', NUM],
    ['p', String.raw`[\[\]{},]|(?<=^|\s)[|>][+-]?\d*(?=\s*$)`],
  ]);
  const KEY_LINE = /^(\s*(?:-\s+)*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\[\]{},&*!|>%@`:-][^#]*?|-[^\s#][^#]*?)(\s*:)(?=\s|$)(.*)$/;
  function yaml(text) {
    const lines = text.split('\n'); let block = -1; const out = [];
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      if (block >= 0) {
        if (!line.trim() || indent > block) { out.push(span('s', line)); continue; }
        block = -1;
      }
      if (/^(---|\.\.\.)(\s|$)/.test(line)) { out.push(span('p', line.slice(0, 3)) + lex(line.slice(3), yamlVal)); continue; }
      const m = KEY_LINE.exec(line);
      if (m) {
        out.push(esc(m[1]).replace(/-/g, '<span class="tk-p">-</span>') + span('k', m[2]) + span('p', m[3]) + lex(m[4], yamlVal));
        if (/^\s*[|>][+-]?\d*\s*(#.*)?$/.test(m[4])) block = m[1].length;
      } else {
        const li = /^(\s*)-(\s+)(.*)$/.exec(line);
        if (li) {
          out.push(esc(li[1]) + span('p', '-') + esc(li[2]) + lex(li[3], yamlVal));
          if (/^[|>][+-]?\d*\s*$/.test(li[3])) block = li[1].length;
        } else out.push(lex(line, yamlVal));
      }
    }
    return out.join('\n');
  }

  // ── Python
  const PY_KW = words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case');
  const PY_BI = words('print len range int str float bool list dict set tuple type isinstance issubclass enumerate zip map filter sorted reversed sum min max abs any all open super property staticmethod classmethod getattr setattr hasattr repr id iter next input format round bytes object Exception ValueError TypeError KeyError RuntimeError');
  const python = compile([
    ['c', String.raw`#[^\n]*`],
    ['s', String.raw`[rRbBuUfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?''')`],
    ['s', String.raw`[rRbBuUfF]{0,2}(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`],
    ['d', String.raw`(?<=^\s*)@[\w.]+`],
    ['fn', String.raw`\b(?:def|class)\s+[A-Za-z_]\w*`, (t) => { const i = t.search(/\s/); const name = t.trim().split(/\s+/)[1]; return span('kw', t.slice(0, i)) + esc(t.slice(i, t.length - name.length)) + span('fn', name); }],
    ['b', String.raw`\b(?:True|False|None|self|cls)\b`],
    ['kw', PY_KW],
    ['bi', PY_BI],
    ['n', NUM],
  ]);

  // ── JS / TS
  const js = compile([
    ['c', String.raw`//[^\n]*|/\*[\s\S]*?\*/`],
    ['s', String.raw`` + '`(?:\\\\.|[^`\\\\])*`' + String.raw`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`],
    ['fn', String.raw`\b(?:function|class)\s+[A-Za-z_$][\w$]*`, (t) => { const n = t.trim().split(/\s+/); return span('kw', n[0]) + ' ' + span('fn', n[1]); }],
    ['b', String.raw`\b(?:true|false|null|undefined|this|NaN)\b`],
    ['kw', words('const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends super import export from default as async await yield try catch finally throw interface type enum implements public private protected readonly static void')],
    ['n', NUM],
  ]);

  // ── Shell
  const sh = compile([
    ['c', String.raw`(?<![\w$])#[^\n]*`],
    ['s', String.raw`"(?:\\.|[^"\\])*"|'[^']*'`],
    ['a', String.raw`\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@#?$!*-])`],
    ['kw', words('if then else elif fi for while until do done case esac in function select return exit break continue local export readonly source alias unset set shift trap')],
    ['bi', words('echo cd ls cat grep sed awk find mkdir rm cp mv chmod chown curl wget git docker npm node python pip sudo test read printf')],
    ['n', NUM],
  ]);

  // ── SQL
  const sql = compile([
    ['c', String.raw`--[^\n]*|/\*[\s\S]*?\*/`],
    ['s', String.raw`'(?:[^']|'')*'`],
    ['kw', '(?i:' + words('select from where and or not in is null as join left right inner outer full cross on group by order having limit offset insert into values update set delete create alter drop table index view database primary key foreign references unique default constraint distinct union all case when then else end exists between like ilike asc desc returning with begin commit rollback') + ')'],
    ['bi', '(?i:' + words('count sum avg min max coalesce now cast varchar integer int bigint text boolean timestamp date numeric serial jsonb json uuid') + ')'],
    ['n', NUM],
  ]);

  // ── TOML / INI
  const toml = compile([
    ['c', String.raw`(?<![\w"'])[#;][^\n]*`],
    ['p', String.raw`^\s*\[\[?[^\]\n]+\]\]?`],
    ['k', String.raw`^[ \t]*[\w.\-"']+(?=\s*=)`],
    ['s', String.raw`"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'[^'\n]*'`],
    ['b', String.raw`\b(?:true|false)\b`],
    ['n', NUM],
  ]);

  // ── Markdown (편집기용)
  const mdInline = compile([
    ['s', String.raw`` + '`[^`\\n]+`'],
    ['kw', String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__`],
    ['fn', String.raw`!?\[[^\]\n]*\]\([^)\n]*\)`],
    ['a', String.raw`<[^>\n]+>`],
  ]);
  function markdown(text) {
    let fence = false; const out = [];
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push(span('c', line)); continue; }
      if (fence) { out.push(span('s', line)); continue; }
      let m;
      if (/^#{1,6}\s/.test(line)) out.push(span('h', line));
      else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) out.push(span('p', line));
      else if ((m = /^(\s*>+\s?)(.*)$/.exec(line))) out.push(span('p', m[1]) + lex(m[2], mdInline));
      else if ((m = /^(\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?)(.*)$/.exec(line))) out.push(span('p', m[1]) + lex(m[2], mdInline));
      else out.push(lex(line, mdInline));
    }
    return out.join('\n');
  }

  const LANGS = { json: (t) => lex(t, json), yaml, python: (t) => lex(t, python), js: (t) => lex(t, js), sh: (t) => lex(t, sh), sql: (t) => lex(t, sql), toml: (t) => lex(t, toml), markdown };
  const EXT = { json: 'json', jsonc: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json', yml: 'yaml', yaml: 'yaml', py: 'python', pyi: 'python',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', sh: 'sh', bash: 'sh', zsh: 'sh', sql: 'sql', toml: 'toml', ini: 'toml', cfg: 'toml', conf: 'toml',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown' };
  const ALIAS = { py: 'python', python3: 'python', yml: 'yaml', jsonc: 'json', javascript: 'js', typescript: 'js', ts: 'js', jsx: 'js', tsx: 'js', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', md: 'markdown', ini: 'toml' };

  window.langOf = (path) => EXT[(path.match(/\.([^./]+)$/)?.[1] || '').toLowerCase()] || null;
  window.langByName = (name) => { const n = (name || '').toLowerCase(); return LANGS[n] ? n : ALIAS[n] || null; };
  window.highlight = (lang, text) => (LANGS[lang] ? LANGS[lang](text) : esc(text));
})();
