#!/usr/bin/env node
/**
 * @fileoverview Builds the code reference (docs/api/index.html) from the JSDoc
 * comments in Code.gs, Config.gs and the page script in Index.html, and checks
 * that every function is documented.
 *
 * The TypeScript parser (which reads JavaScript and JSDoc) finds the functions,
 * their parameters and whether they return a value; the comments themselves are
 * read with a small JSDoc parser below. Standard tags are used, so `npx jsdoc -c
 * jsdoc.json` works on the same files too.
 *
 * Usage:
 *   node tools/build-docs.js            write docs/api/index.html
 *   node tools/build-docs.js --check    only check the comments (exit 1 on problems)
 *   node tools/build-docs.js --fragment <file>   also write the page without the
 *                                       <html>/<head>/<body> wrapper (for publishing)
 *
 * Needs the `typescript` package: `npm install --no-save typescript`, or a global install.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = [
  { file: 'Code.gs', label: 'Server (Code.gs)' },
  { file: 'Config.gs', label: 'Developer settings (Config.gs)' },
  { file: 'Index.html', label: 'Web page script (Index.html)', script: true },
];

/**
 * Loads the TypeScript parser from the project, or from the global npm folder.
 * @return {?Object} The `typescript` module, or null when it isn't installed.
 */
function loadTypeScript() {
  try { return require('typescript'); } catch (e) { /* try the global folder */ }
  try {
    const globalRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'typescript'));
  } catch (e) {
    return null;
  }
}

/**
 * The JavaScript to parse from one source file. For Index.html, only the inline
 * script, with the number of lines before it so line numbers match the file.
 * @param {{file: string, script: (boolean|undefined)}} src The source.
 * @return {{text: string, lineOffset: number}} The code and its line offset.
 */
function readSource(src) {
  const full = fs.readFileSync(path.join(ROOT, src.file), 'utf8');
  if (!src.script) return { text: full, lineOffset: 0 };
  const start = full.indexOf('<script>');
  const end = full.indexOf('</script>', start);
  return { text: full.slice(start + 8, end), lineOffset: full.slice(0, start).split('\n').length - 1 };
}

// ---------------------------------------------------------------------------
// JSDoc comment parser
// ---------------------------------------------------------------------------

/**
 * Reads a type in braces at the start of a string, allowing nested braces.
 * @param {string} s Text starting with "{".
 * @return {{type: string, rest: string}} The type and the text after it.
 */
function readType(s) {
  if (s[0] !== '{') return { type: '', rest: s };
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return { type: s.slice(1, i).trim(), rest: s.slice(i + 1).trim() };
  }
  return { type: s.slice(1).trim(), rest: '' };
}

/**
 * Parses one JSDoc comment into its description and tags.
 * @param {string} raw The comment, from "/**" to "*\/".
 * @return {{description: string, tags: Array<{tag: string, type: string, name: string, optional: boolean, text: string}>}}
 *   The description and the tags in order.
 */
function parseDoc(raw) {
  const lines = raw.replace(/^\/\*\*/, '').replace(/\*\/$/, '').split('\n')
    .map(l => l.replace(/^\s*\* ?/, '').replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length === 1) lines[0] = lines[0].trim();
  const desc = [];
  const tags = [];
  let cur = null;
  lines.forEach(line => {
    const m = line.trim().match(/^@(\w+)\s*([\s\S]*)$/);
    if (m && !(cur && cur.tag === 'example' && !/^@(param|return|returns|throws|private|example)\b/.test(line.trim()))) {
      cur = { tag: m[1] === 'returns' ? 'return' : m[1], body: m[2] };
      tags.push(cur);
    } else if (cur) {
      cur.body += '\n' + (cur.tag === 'example' ? line : line.trim());
    } else {
      desc.push(line);
    }
  });
  return {
    description: desc.join('\n').trim(),
    tags: tags.map(t => {
      const out = { tag: t.tag, type: '', name: '', optional: false, text: '' };
      if (t.tag === 'example') { out.text = t.body.replace(/^\n+|\s+$/g, ''); return out; }
      let rest = t.body.trim();
      if (['param', 'property', 'return', 'throws', 'const', 'type', 'typedef'].indexOf(t.tag) !== -1) {
        const r = readType(rest); out.type = r.type; rest = r.rest;
      }
      if (t.tag === 'param' || t.tag === 'property' || t.tag === 'typedef') {
        const n = rest.match(/^(\[[^\]]*\]|\S+)\s*([\s\S]*)$/) || ['', '', ''];
        let name = n[1];
        if (name[0] === '[') { out.optional = true; name = name.slice(1, -1).split('=')[0]; }
        out.name = name; rest = n[2];
      }
      out.text = rest.trim();
      return out;
    }),
  };
}

// ---------------------------------------------------------------------------
// Collecting declarations
// ---------------------------------------------------------------------------

/**
 * Whether a function body returns a value (nested functions don't count).
 * @param {Object} ts The TypeScript module.
 * @param {Object} fn A function-like node.
 * @return {boolean} True when some `return` has a value, or an arrow has an expression body.
 */
function returnsValue(ts, fn) {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return true; // arrow with an expression body
  let found = false;
  const visit = node => {
    if (found) return;
    if (ts.isReturnStatement(node) && node.expression) { found = true; return; }
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

/**
 * The JSDoc comment directly before a node, if any.
 * @param {Object} ts The TypeScript module.
 * @param {string} text The source text.
 * @param {Object} node The statement.
 * @return {string} The raw comment, or ''.
 */
function leadingDoc(ts, text, node) {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) || [];
  const last = ranges[ranges.length - 1];
  if (!last) return '';
  const c = text.slice(last.pos, last.end);
  return c.startsWith('/**') ? c : '';
}

/**
 * Section banners in a file ("// ----" / "// Title" / "// ----", or "// ---- Title ----").
 * @param {string} text The source text.
 * @return {Array<{line: number, title: string}>} Banners with their 1-based line numbers.
 */
function findSections(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((l, i) => {
    const one = l.match(/^\/\/ -{3,} (.+?) -{3,}$/);
    if (one) out.push({ line: i + 1, title: one[1] });
    else if (/^\/\/ -{10,}$/.test(l) && /^\/\/ \S/.test(lines[i + 1] || '') && /^\/\/ -{10,}$/.test(lines[i + 2] || '')) {
      out.push({ line: i + 2, title: lines[i + 1].replace(/^\/\/ /, '') });
    }
  });
  return out;
}

/**
 * Every top-level function, documented constant and typedef in the sources.
 * @param {Object} ts The TypeScript module.
 * @return {{entries: Object[], typedefs: Object[], overviews: Object<string, string>}} What was found.
 */
function collect(ts) {
  const entries = [];
  const typedefs = [];
  const overviews = {};
  SOURCES.forEach(src => {
    const { text, lineOffset } = readSource(src);
    const sf = ts.createSourceFile(src.file + '.js', text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
    const sections = findSections(text);
    const sectionAt = line => { let s = ''; sections.forEach(b => { if (b.line <= line) s = b.title; }); return s; };
    const lineOf = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    (text.match(/\/\*\*[\s\S]*?\*\//g) || []).forEach(c => {
      const doc = parseDoc(c);
      const td = doc.tags.filter(t => t.tag === 'typedef')[0];
      if (td) typedefs.push({ kind: 'type', name: td.name, type: td.type, doc: doc, file: src.file });
      const fo = doc.tags.filter(t => t.tag === 'fileoverview')[0];
      if (fo && !overviews[src.file]) overviews[src.file] = (fo.text + (doc.description ? '\n' + doc.description : '')).trim();
    });

    sf.statements.forEach(st => {
      const line = lineOf(st);
      const base = { file: src.file, source: src.label, line: line + lineOffset, section: sectionAt(line) };
      if (ts.isFunctionDeclaration(st) && st.name) {
        entries.push(Object.assign({}, base, {
          kind: 'function', name: st.name.text, params: st.parameters.map(p => p.name.getText(sf)),
          returns: returnsValue(ts, st), raw: leadingDoc(ts, text, st),
        }));
      } else if (ts.isVariableStatement(st)) {
        st.declarationList.declarations.forEach(d => {
          const init = d.initializer;
          const raw = leadingDoc(ts, text, st);
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            entries.push(Object.assign({}, base, {
              kind: 'function', name: d.name.getText(sf), params: init.parameters.map(p => p.name.getText(sf)),
              returns: returnsValue(ts, init), raw: raw,
            }));
          } else if (raw && /@const\b/.test(raw)) {
            entries.push(Object.assign({}, base, { kind: 'const', name: d.name.getText(sf), raw: raw }));
          }
        });
      }
    });
  });
  entries.forEach(e => { e.doc = e.raw ? parseDoc(e.raw) : null; });
  return { entries: entries, typedefs: typedefs, overviews: overviews };
}

/**
 * Checks that every function is documented: a JSDoc block, an @param for each
 * parameter (in order, none extra), and an @return when it returns a value.
 * @param {Object[]} entries Collected entries.
 * @return {string[]} Problems, e.g. "Code.gs:120 parseUpload_: missing @param run".
 */
function check(entries) {
  const problems = [];
  entries.filter(e => e.kind === 'function').forEach(e => {
    const at = e.file + ':' + e.line + ' ' + e.name + ': ';
    if (!e.doc) { problems.push(at + 'no JSDoc comment'); return; }
    if (!e.doc.description) problems.push(at + 'no description');
    const documented = e.doc.tags.filter(t => t.tag === 'param' && t.name.indexOf('.') === -1).map(t => t.name);
    e.params.forEach((p, i) => {
      if (documented.indexOf(p) === -1) problems.push(at + 'missing @param ' + p);
      else if (documented[i] !== p) problems.push(at + '@param ' + p + ' is out of order');
    });
    documented.forEach(p => { if (e.params.indexOf(p) === -1) problems.push(at + '@param ' + p + ' is not a parameter'); });
    const hasReturn = e.doc.tags.some(t => t.tag === 'return');
    if (e.returns && !hasReturn) problems.push(at + 'returns a value but has no @return');
  });
  return problems;
}

// ---------------------------------------------------------------------------
// HTML output
// ---------------------------------------------------------------------------

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Anchor id for an entry: letters, digits and hyphens only.
 * @param {string} kind "function", "const" or "type".
 * @param {string} name The name.
 * @return {string} e.g. "f-parseUpload-".
 */
function anchor(kind, name) {
  return ({ function: 'f-', const: 'c-', type: 't-' })[kind] + name.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Renders the reference page.
 * @param {{entries: Object[], typedefs: Object[], overviews: Object<string, string>}} data Collected docs.
 * @param {boolean} fragment Leave out the html/head/body wrapper (for publishing as an artifact).
 * @return {string} The page.
 */
function render(data, fragment) {
  const known = {};
  data.entries.forEach(e => { known[e.name] = anchor(e.kind, e.name); });
  data.typedefs.forEach(t => { known[t.name] = anchor('type', t.name); });

  const linkType = type => esc(type).replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, w =>
    known[w] && data.typedefs.some(t => t.name === w) ? '<a href="#' + known[w] + '">' + w + '</a>' : w);
  const inline = s => esc(s)
    .replace(/\{@link ([A-Za-z0-9_.]+)\}/g, (m, n) => known[n] ? '<a href="#' + known[n] + '"><code>' + n + '</code></a>' : '<code>' + n + '</code>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  // Paragraphs and "- " lists. An indented line after a list item continues it; text after a list starts a new paragraph.
  const prose = s => {
    if (!s) return '';
    const out = [];
    let para = [], items = null;
    const flush = () => {
      if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>');
      if (items) out.push('<ul>' + items.map(i => '<li>' + inline(i) + '</li>').join('') + '</ul>');
      para = []; items = null;
    };
    s.split('\n').forEach(l => {
      if (!l.trim()) { flush(); return; }
      if (/^\s*- /.test(l)) {
        if (para.length && !items) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
        (items = items || []).push(l.replace(/^\s*- /, '').trim());
      } else if (items && /^\s+\S/.test(l)) {
        items[items.length - 1] += ' ' + l.trim();
      } else {
        if (items) flush();
        para.push(l.trim());
      }
    });
    flush();
    return out.join('');
  };
  const tagsOf = (doc, tag) => (doc ? doc.tags.filter(t => t.tag === tag) : []);

  const entryHtml = e => {
    const d = e.doc || { description: '', tags: [] };
    const priv = tagsOf(d, 'private').length > 0;
    const id = anchor(e.kind, e.name);
    let sig, typeLine = '';
    if (e.kind === 'function') {
      const opt = {};
      tagsOf(d, 'param').forEach(p => { if (p.optional) opt[p.name] = true; });
      const ret = tagsOf(d, 'return')[0];
      sig = '<span class="kw">function</span> <span class="nm">' + esc(e.name) + '</span>(' +
        e.params.map(p => opt[p] ? '[' + esc(p) + ']' : esc(p)).join(', ') + ')' +
        (ret ? ' <span class="arrow">→</span> <span class="ty">' + linkType(ret.type) + '</span>' : '');
    } else {
      const c = tagsOf(d, 'const')[0] || { type: '', text: '' };
      sig = '<span class="kw">const</span> <span class="nm">' + esc(e.name) + '</span>' +
        (c.type ? ' : <span class="ty">' + linkType(c.type) + '</span>' : '');
      typeLine = c.text;
    }
    const params = tagsOf(d, 'param');
    const props = tagsOf(d, 'property');
    const table = (rows, head) => rows.length ? '<table class="params"><thead><tr><th>' + head +
      '</th><th>Type</th><th>Description</th></tr></thead><tbody>' + rows.map(p =>
        '<tr><td><code>' + esc(p.name) + '</code>' + (p.optional ? ' <span class="opt">optional</span>' : '') +
        '</td><td class="ty">' + linkType(p.type) + '</td><td>' + inline(p.text) + '</td></tr>').join('') + '</tbody></table>' : '';
    const ret = tagsOf(d, 'return')[0];
    const throws = tagsOf(d, 'throws');
    const examples = tagsOf(d, 'example');
    const search = (e.name + ' ' + d.description + ' ' + e.section).toLowerCase();
    return '<article class="entry" id="' + id + '" data-search="' + esc(search) + '">' +
      '<header class="entry-head"><h3><a class="self" href="#' + id + '">' + esc(e.name) + '</a></h3>' +
      '<span class="badges">' +
        (e.kind === 'const' ? '<span class="badge const">constant</span>' : '') +
        (priv ? '<span class="badge private">private</span>' : (e.kind === 'function' && e.file === 'Code.gs' ? '<span class="badge public">called by the page</span>' : '')) +
        '<span class="where">' + esc(e.file) + ':' + e.line + '</span></span></header>' +
      '<div class="scroll"><pre class="sig">' + sig + '</pre></div>' +
      prose(e.kind === 'const' ? [typeLine, d.description].filter(Boolean).join('\n\n') : d.description) +
      (params.length ? '<h4>Parameters</h4><div class="scroll">' + table(params, 'Name') + '</div>' : '') +
      (props.length ? '<h4>Properties</h4><div class="scroll">' + table(props, 'Name') + '</div>' : '') +
      (ret ? '<h4>Returns</h4><p><span class="ty">' + linkType(ret.type) + '</span> ' + inline(ret.text) + '</p>' : '') +
      (throws.length ? '<h4>Throws</h4>' + throws.map(t => '<p><span class="ty">' + linkType(t.type) + '</span> ' + inline(t.text) + '</p>').join('') : '') +
      examples.map(x => '<h4>Example</h4><div class="scroll"><pre class="example">' + esc(x.text) + '</pre></div>').join('') +
      '</article>';
  };

  const typeHtml = t => {
    const id = anchor('type', t.name);
    const props = t.doc.tags.filter(x => x.tag === 'property');
    return '<article class="entry" id="' + id + '" data-search="' + esc((t.name + ' ' + t.doc.description).toLowerCase()) + '">' +
      '<header class="entry-head"><h3><a class="self" href="#' + id + '">' + esc(t.name) + '</a></h3>' +
      '<span class="badges"><span class="badge type">type</span><span class="where">' + esc(t.file) + '</span></span></header>' +
      '<div class="scroll"><pre class="sig"><span class="kw">typedef</span> <span class="nm">' + esc(t.name) + '</span> : <span class="ty">' +
        linkType(t.type) + '</span></pre></div>' + prose(t.doc.description) +
      (props.length ? '<div class="scroll"><table class="params"><thead><tr><th>Property</th><th>Type</th><th>Description</th></tr></thead><tbody>' +
        props.map(p => '<tr><td><code>' + esc(p.name) + '</code>' + (p.optional ? ' <span class="opt">optional</span>' : '') +
          '</td><td class="ty">' + linkType(p.type) + '</td><td>' + inline(p.text) + '</td></tr>').join('') + '</tbody></table></div>' : '') +
      '</article>';
  };

  // Sections: entry points first, then the server's own sections, settings, the page script, constants, types.
  const groups = [];
  const add = (title, note, items, render) => { if (items.length) groups.push({ title, note, items, render }); };
  const fns = data.entries.filter(e => e.kind === 'function');
  const entry = fns.filter(e => e.file === 'Code.gs' && !/_$/.test(e.name));
  add('Web app entry points', 'Functions the web page calls with google.script.run, plus doGet, which serves the page.', entry, entryHtml);
  const serverSections = [];
  fns.filter(e => e.file === 'Code.gs' && /_$/.test(e.name)).forEach(e => {
    // Private helpers that sit next to the entry points get their own name.
    const title = e.section === 'Web app entry points' ? 'Generate and Rebuild helpers' : (e.section || 'Server');
    let g = serverSections.filter(s => s.title === title)[0];
    if (!g) { g = { title: title, items: [] }; serverSections.push(g); }
    g.items.push(e);
  });
  serverSections.forEach(s => add(s.title, 'Code.gs', s.items, entryHtml));
  add('Developer settings', 'Config.gs: the settings the developer edits, and the run-metrics hand-off.',
    data.entries.filter(e => e.file === 'Config.gs'), entryHtml);
  add('Web page script', 'Index.html: the browser side of the form.', fns.filter(e => e.file === 'Index.html'), entryHtml);
  add('Constants', 'Code.gs', data.entries.filter(e => e.kind === 'const' && e.file === 'Code.gs'), entryHtml);
  add('Data types', 'Shapes of the objects passed around the app (JSDoc @typedef).', data.typedefs, typeHtml);

  const slug = s => 's-' + s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const nav = groups.map(g => '<details class="nav-group" open><summary><a href="#' + slug(g.title) + '">' + esc(g.title) +
    '</a> <span class="count">' + g.items.length + '</span></summary><ul>' +
    g.items.map(i => '<li data-for="' + anchor(i.kind, i.name) + '"><a href="#' + anchor(i.kind, i.name) + '">' + esc(i.name) + '</a></li>').join('') +
    '</ul></details>').join('');
  const body = groups.map(g => '<section class="group" id="' + slug(g.title) + '"><h2>' + esc(g.title) + '</h2>' +
    '<p class="group-note">' + inline(g.note) + '</p>' + g.items.map(g.render).join('') + '</section>').join('');

  const counts = {
    functions: fns.length,
    entry: entry.length,
    types: data.typedefs.length,
    consts: data.entries.filter(e => e.kind === 'const').length,
  };
  const overview = data.overviews['Code.gs'] || '';
  const intro = overview.split('\n').slice(1).join('\n').trim();

  const page =
`<title>Morph Invoice PDF Generator API</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
/* Layout: sticky index on the left (stacks on top on phones), reference entries on the right. */
:root {
  --bg: #f6f8fb; --surface: #ffffff; --fg: #18212c; --muted: #5a6878; --line: #dbe2ea;
  --accent: #1f4e79; --accent-soft: #e6eef6; --code-bg: #eef2f6; --private: #7a5b14; --private-bg: #fbf1d9;
  --public: #1d6b45; --public-bg: #e1f3e9; --type: #6a3d8f; --type-bg: #f0e8f7;
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f151c; --surface: #151d26; --fg: #e3e9f0; --muted: #94a3b4; --line: #26323f;
  --accent: #7fb2e5; --accent-soft: #1b2a3a; --code-bg: #1b2530; --private: #e7c26b; --private-bg: #3a2f14;
  --public: #7fd3a5; --public-bg: #15342a; --type: #c9a3ea; --type-bg: #2c2138; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #0f151c; --surface: #151d26; --fg: #e3e9f0; --muted: #94a3b4; --line: #26323f;
  --accent: #7fb2e5; --accent-soft: #1b2a3a; --code-bg: #1b2530; --private: #e7c26b; --private-bg: #3a2f14;
  --public: #7fd3a5; --public-bg: #15342a; --type: #c9a3ea; --type-bg: #2c2138; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 var(--sans); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
code, pre { font-family: var(--mono); font-size: 0.86em; }
code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
.wrap { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 32px; max-width: 1240px; margin: 0 auto;
  padding-block: 28px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.side { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 16px); align-self: start; max-height: calc(100vh - 32px);
  overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
.brand { display: flex; flex-direction: column; gap: 2px; }
.brand .eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.brand strong { font-size: 17px; color: var(--accent); }
#q { width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
  color: var(--fg); font: 14px var(--sans); }
#hits { font-size: 12px; color: var(--muted); min-height: 1em; }
.nav-group { border-top: 1px solid var(--line); padding-top: 6px; }
.nav-group summary { cursor: pointer; font-weight: 600; font-size: 13px; display: flex; gap: 6px; align-items: baseline; list-style: none; }
.nav-group summary::-webkit-details-marker { display: none; }
.nav-group summary a { color: var(--fg); }
.count { color: var(--muted); font-weight: 400; font-size: 12px; font-variant-numeric: tabular-nums; }
.nav-group ul { list-style: none; margin: 4px 0 6px; padding: 0 0 0 10px; display: flex; flex-direction: column; gap: 1px; }
.nav-group li a { font-family: var(--mono); font-size: 12.5px; color: var(--muted); word-break: break-all; }
.nav-group li a:hover { color: var(--accent); }
main { min-width: 0; display: flex; flex-direction: column; gap: 40px; }
.hero { display: flex; flex-direction: column; gap: 10px; }
.hero h1 { margin: 0; font-size: 30px; line-height: 1.2; text-wrap: balance; }
.hero p, .intro p { margin: 0; max-width: 68ch; color: var(--muted); }
.intro { display: flex; flex-direction: column; gap: 4px; color: var(--muted); }
.intro ul { margin: 0; padding-left: 20px; max-width: 68ch; }
.stats { display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 13px; color: var(--muted); }
.stats b { color: var(--fg); font-variant-numeric: tabular-nums; }
.howto { font-size: 13px; color: var(--muted); }
.group { display: flex; flex-direction: column; gap: 14px; scroll-margin-top: 16px; }
.group h2 { margin: 0; font-size: 21px; text-wrap: balance; padding-bottom: 6px; border-bottom: 2px solid var(--accent); }
.group-note { margin: 0; color: var(--muted); font-size: 14px; }
.entry { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px;
  display: flex; flex-direction: column; gap: 8px; scroll-margin-top: 16px; min-width: 0; }
.entry:target { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.entry-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 6px 12px; }
.entry h3 { margin: 0; font-family: var(--mono); font-size: 16px; font-weight: 500; word-break: break-all; }
.entry h3 a { color: var(--fg); }
.badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.badge { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 99px; }
.badge.private { color: var(--private); background: var(--private-bg); }
.badge.public { color: var(--public); background: var(--public-bg); }
.badge.type { color: var(--type); background: var(--type-bg); }
.badge.const { color: var(--accent); background: var(--accent-soft); }
.where { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.scroll { overflow-x: auto; max-width: 100%; }
pre { margin: 0; }
.sig { background: var(--code-bg); padding: 8px 11px; border-radius: 6px; white-space: pre; }
.sig .kw { color: var(--muted); } .sig .nm { color: var(--fg); font-weight: 500; } .arrow { color: var(--muted); }
.ty { font-family: var(--mono); font-size: 12.5px; color: var(--type); }
.ty a { color: inherit; text-decoration: underline; text-decoration-color: var(--line); }
.example { background: var(--code-bg); padding: 10px 12px; border-radius: 6px; white-space: pre; }
.entry p { margin: 0; max-width: 72ch; }
.entry ul { margin: 0; padding-left: 20px; max-width: 72ch; }
.entry h4 { margin: 6px 0 0; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.params { border-collapse: collapse; width: 100%; font-size: 14px; }
.params th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); }
.params td { padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
.params td:first-child { white-space: nowrap; }
.params tr:last-child td { border-bottom: 0; }
.opt { font-size: 11px; color: var(--muted); }
[hidden] { display: none !important; }
@media (max-width: 860px) {
  .wrap { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .side { position: static; max-height: none; }
  .nav-group[open] ul { max-height: 220px; overflow: auto; }
}
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
</style>
<div class="wrap">
  <aside class="side">
    <div class="brand"><span class="eyebrow">Code reference</span><strong>Morph - Invoice PDF Generator</strong></div>
    <label for="q" class="eyebrow" style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600">Search functions and types</label>
    <input id="q" type="search" placeholder="e.g. parseNumber_, Invoice, preset" autocomplete="off">
    <div id="hits" aria-live="polite"></div>
    <nav>${nav}</nav>
  </aside>
  <main>
    <section class="hero">
      <h1>Morph - Invoice PDF Generator API</h1>
      <div class="intro">${prose(intro.split('\n\n')[0])}</div>
      <div class="stats"><span><b>${counts.functions}</b> functions</span><span><b>${counts.entry}</b> called by the page</span>
        <span><b>${counts.consts}</b> constants</span><span><b>${counts.types}</b> data types</span>
        <span>Files: <code>Code.gs</code> <code>Config.gs</code> <code>Index.html</code></span></div>
      <p class="howto">Generated from the JSDoc comments by <code>node tools/build-docs.js</code>. Functions ending in <code>_</code> are private:
        Apps Script hides them from <code>google.script.run</code>.</p>
    </section>
    ${body}
  </main>
</div>
<script>
(function () {
  var q = document.getElementById('q'), hits = document.getElementById('hits');
  var entries = Array.prototype.slice.call(document.querySelectorAll('.entry'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.group'));
  var navItems = Array.prototype.slice.call(document.querySelectorAll('.nav-group li'));
  var navGroups = Array.prototype.slice.call(document.querySelectorAll('.nav-group'));
  // On phones the index sits above the reference, so its groups start closed.
  if (window.matchMedia && window.matchMedia('(max-width: 860px)').matches) navGroups.forEach(function (g) { g.open = false; });
  q.addEventListener('input', function () {
    var term = q.value.trim().toLowerCase(), shown = {}, n = 0;
    entries.forEach(function (e) {
      var ok = !term || e.getAttribute('data-search').indexOf(term) !== -1 || e.id.toLowerCase().indexOf(term) !== -1;
      e.hidden = !ok; if (ok) { shown[e.id] = true; n++; }
    });
    groups.forEach(function (g) { g.hidden = !g.querySelector('.entry:not([hidden])'); });
    navItems.forEach(function (li) { li.hidden = !shown[li.getAttribute('data-for')]; });
    navGroups.forEach(function (g) { g.hidden = !g.querySelector('li:not([hidden])'); if (term) g.open = true; });
    hits.textContent = term ? n + (n === 1 ? ' match' : ' matches') : '';
  });
})();
</script>`;
  if (fragment) return page;
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    page.replace(/\n<div class="wrap">/, '\n</head>\n<body>\n<div class="wrap">') + '\n</body>\n</html>\n';
}

if (require.main === module) {
  const ts = loadTypeScript();
  if (!ts) {
    console.error('The "typescript" package is needed: run `npm install --no-save typescript` and try again.');
    process.exit(2);
  }
  const data = collect(ts);
  const problems = check(data.entries);
  if (problems.length) {
    console.error(problems.length + ' documentation problem(s):\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  if (process.argv.indexOf('--check') !== -1) {
    console.log('All ' + data.entries.filter(e => e.kind === 'function').length + ' functions are documented.');
    process.exit(0);
  }
  const outDir = path.join(ROOT, 'docs', 'api');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), render(data, false));
  const fi = process.argv.indexOf('--fragment');
  if (fi !== -1 && process.argv[fi + 1]) fs.writeFileSync(process.argv[fi + 1], render(data, true));
  console.log('Wrote docs/api/index.html: ' + data.entries.filter(e => e.kind === 'function').length + ' functions, ' +
    data.entries.filter(e => e.kind === 'const').length + ' constants, ' + data.typedefs.length + ' types.');
}

module.exports = { loadTypeScript, collect, check, parseDoc, render };
