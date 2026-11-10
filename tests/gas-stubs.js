/**
 * In-memory stand-ins for the Apps Script services used by Code.gs and Config.gs,
 * so a whole job (upload → spreadsheet → PDF HTML → email → edit → rebuild) can run
 * in Node. "PDFs" are blobs holding the HTML that Google would convert.
 *
 *   const { loadCode, fileArg } = require('./gas-stubs');
 *   const gas = loadCode({ email: 'a@example.com' });
 *   gas.generateInvoices({ file: fileArg('sample-1-basic-en.csv'), mapping, options });
 *
 * Not simulated: Google's HTML-to-PDF rendering, real Drive sharing, Gmail delivery.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

/** RFC 4180 CSV parser (quotes, doubled quotes, newlines inside quotes), like Utilities.parseCsv. */
function parseCsv(text, delimiter) {
  const d = delimiter || ',';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === d) { row.push(field); field = ''; }
    else if (ch === '\r') { /* handled with \n */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

let idCounter = 0;
const newId = prefix => prefix + '_' + (++idCounter).toString().padStart(24, '0');

function makeBlob(buf, contentType, name) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf == null ? '' : buf);
  const blob = {
    _buf: buf,
    getBytes: () => Array.from(buf),
    getDataAsString: charset => /1252/.test(charset || '') ? new TextDecoder('windows-1252').decode(buf) : new TextDecoder('utf-8').decode(buf),
    getName: () => name,
    setName: n => { name = n; return blob; },
    getContentType: () => contentType,
    // HTML → "PDF": keep the HTML so tests can inspect what Google would render.
    getAs: type => makeBlob(buf, type, name),
  };
  return blob;
}

/** Shared state across loadCode() calls in one process (like one Google account set). */
const world = {
  userProps: {},       // email → { key: value }
  scriptProps: {},
  files: {},           // id → file
  folders: {},         // id → folder
  sheets: {},          // spreadsheet id → fake spreadsheet
  emails: [],
};

function propStore(data) {
  return {
    getProperty: k => (k in data ? data[k] : null),
    setProperty: (k, v) => { data[k] = String(v); return this; },
    deleteProperty: k => { delete data[k]; },
    getProperties: () => Object.assign({}, data),
    getKeys: () => Object.keys(data),
  };
}

function makeFile(blob, parent) {
  const id = newId('file');
  const f = {
    id, blob, parent, trashed: false, versions: 1,
    getId: () => id,
    getUrl: () => 'https://drive.google.com/file/d/' + id + '/view',
    getName: () => f.blob.getName(),
    getBlob: () => f.blob,
    isTrashed: () => f.trashed,
    setTrashed: t => { f.trashed = !!t; return f; },
    moveTo: folder => { f.parent = folder; return f; },
  };
  world.files[id] = f;
  return f;
}

function makeFolder(name, parent) {
  const id = newId('folder');
  const folder = {
    id, name, parent, trashed: false, viewers: [],
    getId: () => id,
    getName: () => name,
    getUrl: () => 'https://drive.google.com/drive/folders/' + id,
    isTrashed: () => folder.trashed,
    setTrashed: t => { folder.trashed = !!t; return folder; },
    createFile: blob => makeFile(blob, folder),
    createFolder: n => makeFolder(n, folder),
    addViewer: e => { folder.viewers.push(e); return folder; },
    files: () => Object.values(world.files).filter(f => f.parent === folder),
  };
  world.folders[id] = folder;
  return folder;
}

// ---- Fake Google Sheets ----------------------------------------------------

function colToIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

function makeSheet(ss, name) {
  const grid = [];
  const sheetId = ++idCounter;
  const sh = {
    grid, name, hidden: false, validations: {}, formulas: {},
    getName: () => sh.name,
    setName: n => { sh.name = n; return sh; },
    getSheetId: () => sheetId,
    setFrozenRows: () => sh,
    setColumnWidth: () => sh,
    hideColumns: () => sh,
    hideSheet: () => { sh.hidden = true; return sh; },
    protect: () => ({ setWarningOnly: () => {} }),
    clearContents: () => { grid.length = 0; return sh; },
    getRange: (a, b, c, d) => {
      let r0, c0, nr, nc;
      if (typeof a === 'string') {
        const m = a.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/);
        r0 = +m[2] - 1; c0 = colToIndex(m[1]);
        nr = m[3] ? (m[4] ? +m[4] - r0 : 1000) : 1;
        nc = m[3] ? colToIndex(m[3]) - c0 + 1 : 1;
      } else { r0 = a - 1; c0 = b - 1; nr = c || 1; nc = d || 1; }
      return makeRange(sh, r0, c0, nr, nc);
    },
    getDataRange: () => {
      const h = grid.length, w = grid.reduce((m, r) => Math.max(m, r ? r.length : 0), 0);
      return makeRange(sh, 0, 0, Math.max(h, 1), Math.max(w, 1));
    },
    // test helpers
    set: (r, c, v) => { (grid[r] = grid[r] || [])[c] = v; },
    get: (r, c) => (grid[r] || [])[c],
  };
  return sh;
}

function makeRange(sh, r0, c0, nr, nc) {
  const range = {
    setValues: vals => { vals.forEach((row, i) => row.forEach((v, j) => sh.set(r0 + i, c0 + j, v))); return range; },
    setValue: v => { sh.set(r0, c0, v); return range; },
    setFormula: f => { sh.formulas[r0 + ',' + c0] = f; sh.set(r0, c0, f); return range; },
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
      const v = sh.get(r0 + i, c0 + j); return v == null ? '' : v;
    })),
    getDisplayValues: () => range.getValues().map(r => r.map(v => String(v))),
    setNumberFormat: () => range, setFontWeight: () => range, setBackground: () => range,
    setFontColor: () => range, setNote: () => range, setWrap: () => range,
    setDataValidation: dv => { sh.validations[r0 + ',' + c0] = dv; return range; },
  };
  return range;
}

function makeSpreadsheet(name, firstSheetRows) {
  const id = newId('ss');
  const sheets = [];
  const ss = {
    id, name, locale: 'en_US',
    getId: () => id,
    getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
    getName: () => name,
    getSheets: () => sheets.slice(),
    getSheetByName: n => sheets.filter(s => s.getName() === n)[0] || null,
    insertSheet: n => { const s = makeSheet(ss, n); sheets.push(s); return s; },
    setSpreadsheetLocale: l => { ss.locale = l; },
    getSpreadsheetTimeZone: () => 'Etc/UTC',
  };
  const first = makeSheet(ss, 'Sheet1');
  sheets.push(first);
  if (firstSheetRows) firstSheetRows.forEach((r, i) => r.forEach((v, j) => first.set(i, j, v)));
  world.sheets[id] = ss;
  const file = makeFile(makeBlob('', 'application/vnd.google-apps.spreadsheet', name), null);
  // Make DriveApp.getFileById(ss id) work (moveTo / setTrashed).
  delete world.files[file.id];
  file.getId = () => id;
  world.files[id] = file;
  return ss;
}

function validationBuilder() {
  const b = { list: null, allowInvalid: true };
  const chain = {
    requireValueInList: (l) => { b.list = l; return chain; },
    setAllowInvalid: v => { b.allowInvalid = v; return chain; },
    build: () => b,
  };
  return chain;
}

// ---- Loader ------------------------------------------------------------------

function loadCode(opts) {
  const state = { email: (opts && opts.email) || 'tester@example.com' };
  let rootFolder = null;
  const ctx = {
    console,
    Utilities: {
      base64Decode: s => Array.from(Buffer.from(s, 'base64')),
      base64Encode: bytes => Buffer.from(bytes).toString('base64'),
      newBlob: (data, type, name) => makeBlob(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data || []), type, name),
      parseCsv,
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => fmt === 'yyyy-MM-dd'
        ? d.toISOString().slice(0, 10)
        : d.toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-'),
      zip: (blobs, name) => makeBlob(Buffer.from(blobs.map(b => b.getName()).join('\n')), 'application/zip', name),
    },
    PropertiesService: {
      getUserProperties: () => propStore(world.userProps[state.email] = world.userProps[state.email] || {}),
      getScriptProperties: () => propStore(world.scriptProps),
    },
    Session: { getActiveUser: () => ({ getEmail: () => state.email }), getScriptTimeZone: () => 'Etc/UTC' },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MimeType: { HTML: 'text/html', PDF: 'application/pdf', CSV: 'text/csv', GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet',
                MICROSOFT_EXCEL: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                MICROSOFT_EXCEL_LEGACY: 'application/vnd.ms-excel' },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
    HtmlService: {},
    DriveApp: {
      getFileById: id => {
        if (ctx.__driveError && ctx.__driveError[id]) throw new Error(ctx.__driveError[id]);
        const f = world.files[id]; if (!f) throw new Error('File not found: ' + id); return f;
      },
      getFolderById: id => { const f = world.folders[id]; if (!f) throw new Error('Folder not found'); return f; },
      getFoldersByName: () => ({ hasNext: () => !!rootFolder, next: () => rootFolder }),
      createFolder: n => (rootFolder = makeFolder(n, null)),
    },
    Drive: {
      Files: {
        create: (meta, blob) => {
          // Excel → temporary Google Sheet: rows come from ctx.__xlsxRows (set by the test).
          const ss = makeSpreadsheet(meta.name, ctx.__xlsxRows || []);
          return { id: ss.getId() };
        },
        update: (meta, id, blob) => { const f = world.files[id]; f.blob = blob.setName(meta.name); f.versions++; return f; },
      },
    },
    Sheets: {
      Spreadsheets: {
        get: () => {
          if (ctx.__sheetsError) throw new Error(ctx.__sheetsError);
          return { sheets: [{ data: [{ startRow: 0, rowMetadata: ctx.__rowMetadata || [] }] }] };
        },
      },
    },
    SpreadsheetApp: {
      create: name => makeSpreadsheet(name),
      openById: id => { const ss = world.sheets[id]; if (!ss) throw new Error('not found'); return ss; },
      flush: () => {},
      newDataValidation: validationBuilder,
    },
    MailApp: {
      getRemainingDailyQuota: () => (ctx.__mailQuota == null ? 100 : ctx.__mailQuota),
      sendEmail: msg => { world.emails.push(msg); },
    },
  };
  vm.createContext(ctx);
  const root = path.join(__dirname, '..');
  // Same order as Apps Script: every file shares one global scope.
  vm.runInContext(fs.readFileSync(path.join(root, 'Config.gs'), 'utf8'), ctx, { filename: 'Config.gs' });
  vm.runInContext(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  // Top-level consts aren't properties of the context; expose the ones tests need.
  vm.runInContext('this.T = { I18N, CONFIG, PAGE, DEFAULT_TAX_RATES, SHEET_MAP, FIELDS };', ctx);
  ctx.__setUser = email => { state.email = email; };
  ctx.__world = world;
  return ctx;
}

function fileArg(file) {
  const p = path.join(__dirname, '..', file);
  return { name: path.basename(p), base64: fs.readFileSync(p).toString('base64') };
}

module.exports = { loadCode, parseCsv, fileArg, world };
