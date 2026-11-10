/**
 * Tests for Code.gs + Config.gs, run with Node (no Google account needed):
 *
 *   node tests/run.js            run the tests
 *   node tests/run.js --html     also write each sample's invoice HTML to tests/out/
 *
 * Uses in-memory stand-ins for Drive, Sheets, Gmail and properties (tests/gas-stubs.js),
 * so whole jobs run end to end: upload → editable sheet → PDF HTML → email → edit → rebuild.
 * Google's HTML-to-PDF rendering itself can only be checked in a real deployment.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { loadCode, fileArg, world } = require('./gas-stubs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + String(e.stack || e).split('\n').slice(0, 4).join('\n      ')); }
}
const plain = v => JSON.parse(JSON.stringify(v));
const has = (s, sub, msg) => assert.ok(String(s).indexOf(sub) !== -1, (msg || 'missing') + ': ' + JSON.stringify(sub));
const hasNot = (s, sub, msg) => assert.ok(String(s).indexOf(sub) === -1, (msg || 'unexpected') + ': ' + JSON.stringify(sub));

const OWNER = 'owner@example.com';
const gas = loadCode({ email: OWNER });
const { I18N, CONFIG } = gas.T;

/** The shared column layout of all sample files. */
const MAP = {
  invoiceNumber: 'A', clientNumber: 'B', invoiceDate: 'C', dueDate: 'D', customerName: 'E', attention: 'F',
  address1: 'G', address2: 'H', address3: 'I', address4: 'J', city: 'K', province: 'L', postalCode: 'M', country: 'N',
  candidate: 'O', workOrder: 'P', purchaseOrder: 'Q', workDate: 'R', lineType: 'S', units: 'T', unitPrice: 'U',
  taxCode: 'V', details: [{ col: 'X' }, { col: 'Y' }], groupBy: { col: '' },
};
const withGroup = (label) => Object.assign({}, MAP, { groupBy: { col: 'W', label: label || '' } });
const OPTS = { hasHeader: true };

function parse(file, mapping, options) {
  return gas.parseUpload_({ file: fileArg(file), mapping: mapping || MAP, options: Object.assign({}, OPTS, options) }, 'test');
}
const inv = (res, n) => res.grouped.invoices.filter(i => i.number === n)[0];
const html = (res, n, opts) => {
  const L = I18N[res.opts.language];
  return gas.invoicesHtml_(n ? [inv(res, n)] : res.grouped.invoices, res.opts, L, gas.loadBranding_(res.opts.language));
};
function generate(file, mapping, options) {
  world.emails.length = 0;
  return gas.generateInvoices({ file: fileArg(file), mapping: mapping || MAP, options: Object.assign({}, OPTS, options) });
}
function folderOf(res) { return Object.values(world.folders).filter(f => f.getUrl() === res.folderUrl)[0]; }
function pdfHtml(res) {
  return folderOf(res).files().filter(f => !f.trashed && /\.pdf$/.test(f.getName())).map(f => f.blob.getDataAsString());
}

console.log('Sample 1 — basic English (ONHST)');

test('combined lines, totals, ONHST 13%, units summary without a total row', () => {
  const res = parse('sample-1-basic-en.csv', MAP, { combineEmployees: true });
  assert.strictEqual(res.grouped.invoices.length, 2);
  assert.strictEqual(res.grouped.skipped.length, 0);
  const a = inv(res, 'TAL-501');
  assert.strictEqual(a.lines.length, 3, 'Ana Regular, Ben Regular, Ben Overtime');
  assert.strictEqual(a.lines[0].quantity, 24.5);
  assert.strictEqual(a.lines[0].amount, 1102.5);
  assert.strictEqual(a.subtotal, 1911);
  assert.deepStrictEqual(plain(a.taxes), [{ key: 'ONHST', ratePct: 13, amount: 248.43 }]);
  assert.strictEqual(a.total, 2159.43);
  assert.deepStrictEqual(plain(a.unitsSummary), [{ type: 'Regular', units: 42.5 }, { type: 'Overtime', units: 2 }]);
  assert.strictEqual(gas.formatDateSpan_(a.lines[0].dates), '11/03/2026 – 11/05/2026');
  assert.deepStrictEqual(plain(a.lines[0].details), [['Studio A', 'Studio B'], ['Day', 'Night']]);
  assert.deepStrictEqual(plain(a.detailLabels), ['Location', 'Shift']);
});

test('units summary and totals are the same with Combine off', () => {
  const on = inv(parse('sample-1-basic-en.csv', MAP, { combineEmployees: true }), 'TAL-501');
  const off = inv(parse('sample-1-basic-en.csv', MAP, { combineEmployees: false }), 'TAL-501');
  assert.strictEqual(off.lines.length, 6);
  assert.deepStrictEqual(plain(off.unitsSummary), plain(on.unitsSummary));
  assert.strictEqual(off.total, on.total);
});

test('invoice fields and client address block', () => {
  const a = inv(parse('sample-1-basic-en.csv'), 'TAL-501');
  assert.strictEqual(a.clientNumber, 'C-1001');
  assert.strictEqual(gas.formatDate_(a.invoiceDate), '11/14/2026');
  assert.strictEqual(gas.formatDate_(a.dueDate), '12/14/2026');
  assert.strictEqual(a.attention, 'Accounts Payable');
  assert.deepStrictEqual(plain(gas.formatClientAddress_(a.address)),
    ['500 King St W', 'Suite 1200', 'Toronto, ON  M5V 1L9', 'Canada']);
});

test('English PDF HTML: header, columns, money, totals, footer, page number', () => {
  const res = parse('sample-1-basic-en.csv', MAP, { combineEmployees: true });
  const h = html(res, 'TAL-501');
  ['Invoice #', 'Client #', 'Invoice Date', 'Payment Due Date', 'C-1001', '11/14/2026', '12/14/2026',
   'ATTN: Accounts Payable', 'Toronto, ON &nbsp;M5V 1L9', 'PRIVATE &amp; CONFIDENTIAL',
   'Candidate', 'Work Order', 'Purchase Order', 'Period', 'Unit(s)', '11/03/2026 – 11/05/2026',
   '$1,102.50', 'Units summary', 'Subtotal', 'ONHST (13%)', '$248.43', 'Total (CAD)', '$2,159.43',
   'ABC Store', 'T. 725-555-6458', 'HST/GST # 000000000 RT0001', 'QST # 0000000000 TQ0001',
   'EFT Payment', 'Bank ID:', 'Bank Transit:', 'Account #:', 'remit_info@gmail.com', 'Any required adjustments',
   'Page 1 of 1'].forEach(s => has(h, s));
  ['PRIVÉ', 'Permis QC', '>INVOICE<', 'Total due', 'Notes'].forEach(s => hasNot(h, s));
  has(h, '<div class="name">Northwind Studios</div>', 'client name in accent colour');
  has(h, '<div class="name">ABC Store</div>', 'business name in accent colour');
  has(h, '.name{font-weight:bold;color:#1f4e79', 'accent colour');
});

console.log('Sample 2 — Quebec, French export (QST)');

test('";" CSV, decimal commas, DD/MM dates, QST split into GST + PST (not compounded)', () => {
  const res = parse('sample-2-quebec-fr.csv', MAP, { language: 'fr', combineEmployees: true });
  const b = inv(res, 'FAC-2001');
  assert.strictEqual(b.invoiceDate, '2026-11-14');
  assert.strictEqual(b.subtotal, 1556);
  assert.deepStrictEqual(plain(b.taxes), [{ key: 'GST', ratePct: 5, amount: 77.8 }, { key: 'PST', ratePct: 9.975, amount: 155.21 }]);
  assert.strictEqual(b.total, 1789.01);
  assert.strictEqual(inv(res, 'FAC-2002').total, round2(712.5 * 1.14975));
  assert.deepStrictEqual(plain(gas.formatClientAddress_(b.address)).slice(-2), ['Montréal, QC  H3B 1K9', 'Canada'], 'postal code upper-cased');
});
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

test('French PDF HTML: French labels, English-style numbers, Permis QC, French footer', () => {
  const res = parse('sample-2-quebec-fr.csv', MAP, { language: 'fr', combineEmployees: true });
  const h = html(res, 'FAC-2001');
  ['N° de facture', 'N° de client', 'Date de facturation', 'Paiement dû au plus tard', '11/14/2026',
   'PRIVÉ ET CONFIDENTIEL', 'Candidat', 'Référence', 'Bon de commande', 'Période', 'Unité(s)', 'Taux', 'Montant',
   'ATTN: Comptes fournisseurs', 'Sommaire des unités', 'Sous-total', 'TPS (5%)', 'TVQ (9.975%)', '$77.80', '$155.21',
   'Total (CAD)', '$1,789.01', '$1,050.00', 'T. 725-555-6458', 'TVH/TPS # 000000000 RT0001', 'TVQ # 0000000000 TQ0001',
   'Permis QC 000000', 'Paiement par TEF', 'N° d&#39;institution:', '1234, rue Alexander', 'Page 1 de 1'].forEach(s => has(h, s));
  ['PRIVATE', 'HST/GST', 'Invoice Date', '1 050,00', '9,975'].forEach(s => hasNot(h, s));
});

console.log('Sample 3 — grouping by Project Number');

test('groups in first-appearance order, ungrouped lines first without a heading', () => {
  const res = parse('sample-3-projects.csv', withGroup(), { combineEmployees: true });
  const m = inv(res, 'INV-3001');
  assert.strictEqual(m.groupLabel, 'Project Number', 'label defaults to the column header');
  assert.deepStrictEqual(plain(m.groups.map(g => g.value)), ['', 'P-1001', 'P-1002']);
  assert.strictEqual(m.groups[0].lines[0].candidate, 'Equipment fee');
  const ana = m.lines.filter(l => l.candidate === 'Ana Silva');
  assert.strictEqual(ana.length, 2, 'same candidate in two projects stays separate');
  assert.deepStrictEqual(plain(ana.map(l => l.quantity)), [16, 6]);
  const h = html(res, 'INV-3001');
  has(h, 'Project Number: P-1001');
  has(h, 'Project Number: P-1002');
  hasNot(h, 'Project Number: <', 'no heading for the blank group');
  assert.ok(h.indexOf('Equipment fee') < h.indexOf('Project Number: P-1001'), 'ungrouped first');
});

test('grouping changes nothing in totals or the units summary; label can be overridden', () => {
  const on = inv(parse('sample-3-projects.csv', withGroup('Projet'), { combineEmployees: true }), 'INV-3001');
  const off = inv(parse('sample-3-projects.csv', MAP, { combineEmployees: true }), 'INV-3001');
  assert.strictEqual(on.total, off.total);
  assert.deepStrictEqual(plain(on.unitsSummary), plain(off.unitsSummary));
  assert.strictEqual(on.groupLabel, 'Projet');
  assert.strictEqual(off.groups.length, 1);
  assert.strictEqual(off.groups[0].value, '');
});

console.log('Sample 4 — tax codes');

test('every code, spelling and edge case', () => {
  const res = parse('sample-4-tax-codes.csv');
  const want = { 'TC-01': [['EXEMPT', null, 0]], 'TC-02': [['GST', 5, 75]], 'TC-03': [['HST', 15, 225]],
    'TC-04': [['NSHST', 14, 210]], 'TC-05': [['ONHST', 13, 195]], 'TC-06': [['PEI', 15, 225]],
    'TC-07': [['GST', 5, 75], ['PST', 9.975, 149.63]], 'TC-08': [['GST', 5, 75]], 'TC-09': [['EXEMPT', null, 0]],
    'TC-10': [['EXEMPT', null, 0]], 'TC-11': [['EXEMPT', null, 0]], 'TC-12': [['ONHST', 13, 195]] };
  Object.keys(want).forEach(n => {
    const i = inv(res, n);
    assert.strictEqual(i.subtotal, 1500, n);
    assert.deepStrictEqual(plain(i.taxes.map(t => [t.key, t.ratePct, t.amount])), want[n], n);
  });
  const notes = res.notes.join('\n');
  has(notes, 'Invoice TC-08: rows had different tax codes (GST, HST); "GST" (the first) was used');
  has(notes, 'Invoice TC-09: tax code "HTS" is not recognised, so EXEMPT was used');
  has(notes, 'Invoice TC-11: tax code "PST" is not recognised');
  hasNot(notes, 'TC-10', 'a blank code is EXEMPT without a note');
  hasNot(notes, 'TC-12');
  const h = html(res, 'TC-01');
  has(h, '<td>EXEMPT</td><td class="num">$0.00</td>', 'EXEMPT line with $0.00 and no %');
});

test('French tax labels', () => {
  const res = parse('sample-4-tax-codes.csv', MAP, { language: 'fr' });
  ['TC-02', 'TC-03', 'TC-04', 'TC-05', 'TC-06'].forEach((n, i) =>
    has(html(res, n), ['TPS (5%)', 'TVH (15%)', 'NETVH (14%)', 'ONTVH (13%)', 'IPE (15%)'][i]));
});

console.log('Sample 5 — edge cases');

test('invalid or blank Units/Rate → 0 with notes; blank invoice number skipped; other blanks invoiced', () => {
  const res = parse('sample-5-edge-cases.csv');
  assert.deepStrictEqual(plain(res.grouped.skipped), [{ row: 9, reason: 'No invoice number, so the row can\'t be placed on an invoice' }]);
  const e = inv(res, 'E-501');
  assert.strictEqual(e.items.length, 8, 'every other row is invoiced');
  const notes = res.notes.join('\n');
  has(notes, 'Row 2 (E-501): Units "8 hrs" is not a number, so 0 was used.');
  has(notes, 'Row 3 (E-501): Units is blank, so 0 was used.');
  has(notes, 'Row 4 (E-501): Rate "n/a" is not a number, so 0 was used.');
  has(notes, 'Row 5 (E-501): Rate is blank, so 0 was used.');
  has(notes, 'Row 6 (E-501): no line type, so it is listed as "Other"');
  assert.deepStrictEqual(plain(e.items.map(i => i.amount)), [0, 0, 0, 0, 120, 80, 40, -25]);
  assert.strictEqual(e.subtotal, 215);
  assert.deepStrictEqual(plain(e.unitsSummary).map(r => r.type), ['Regular', 'Other', 'Adjustment']);
  const h = html(res, 'E-501');
  has(h, 'next Tuesday', 'unreadable date printed as written');
  has(h, '-$25.00');
  has(h, 'Payment Due Date</td><td class="val"></td>', 'blank due date keeps the label');
});

console.log('Sample 6 — long invoice and pagination');

test('splits into pages: full header first, condensed after, tail only on the last page', () => {
  const res = parse('sample-6-long.csv', withGroup(), { combineEmployees: false });
  const g = inv(res, 'L-601');
  assert.strictEqual(g.items.length, 70);
  const pages = gas.paginateInvoice_(g, gas.loadBranding_('en'));
  assert.ok(pages.length >= 3, 'pages: ' + pages.length);
  pages.forEach((rows, p) => {
    assert.ok(rows.some(r => r.type === 'line'), 'page ' + (p + 1) + ' has lines');
    assert.notStrictEqual(rows[rows.length - 1].type, 'group', 'no heading alone at the bottom of page ' + (p + 1));
  });
  const lineCount = pages.reduce((n, rows) => n + rows.filter(r => r.type === 'line').length, 0);
  assert.strictEqual(lineCount, 70, 'every line printed exactly once');
  const h = html(res, 'L-601');
  for (let p = 1; p <= pages.length; p++) has(h, 'Page ' + p + ' of ' + pages.length);
  assert.strictEqual((h.match(/PRIVATE &amp; CONFIDENTIAL/g) || []).length, 1, 'full header on page 1 only');
  assert.strictEqual((h.match(/Payment Due Date/g) || []).length, pages.length, 'invoice details on every page');
  assert.strictEqual((h.match(/<th[^>]*>Candidate<\/th>/g) || []).length, pages.length, 'column headings on every page');
  assert.strictEqual((h.match(/Total \(CAD\)/g) || []).length, 1);
  assert.strictEqual((h.match(/EFT Payment/g) || []).length, 1);
  has(h, '(continued)');
  assert.ok(h.lastIndexOf('page-break-after:always') < h.lastIndexOf('Page ' + pages.length + ' of'), 'no break after the last page');
  // Page-height budget: every page's estimated height fits.
  const b = gas.loadBranding_('en');
  const P = gas.T.PAGE;
  pages.forEach((rows, p) => {
    const used = rows.reduce((n, r) => n + r.h, 0) + (p === pages.length - 1 ? gas.tailHeight_(g, b) : 0);
    const room = P.HEIGHT - P.NUMBER_ROW - P.COL_HEADER - P.SAFETY - (p === 0 ? gas.fullHeaderHeight_(g, b) : P.CONDENSED_HEADER);
    assert.ok(used <= room, 'page ' + (p + 1) + ' fits: ' + used + ' <= ' + room);
  });
});

test('numbering restarts per invoice in a combined PDF; French "Page x de y"; top position switch', () => {
  const res = parse('sample-1-basic-en.csv', MAP, { combineEmployees: true });
  const h = html(res);
  assert.strictEqual((h.match(/Page 1 of 1/g) || []).length, 2);
  const fr = parse('sample-6-long.csv', withGroup(), { language: 'fr' });
  const hf = html(fr, 'L-601');
  has(hf, 'Page 1 de ');
  has(hf, '(suite)');
  gas.T.CONFIG.PAGE_NUMBER_POSITION = 'top';
  const ht = html(res, 'TAL-501');
  assert.ok(ht.indexOf('class="pn"') < ht.indexOf('class="page-content"'), 'number row first');
  gas.T.CONFIG.PAGE_NUMBER_POSITION = 'bottom';
});

console.log('Sample 7 — Excel hidden rows');

test('rows hidden by a filter or by hand are left out, with a note', () => {
  const rows = require('./gas-stubs').parseCsv(fs.readFileSync(path.join(__dirname, '..', 'sample-1-basic-en.csv'), 'utf8'), ',');
  gas.__xlsxRows = rows;                                      // header + 8 records
  gas.__rowMetadata = [{}, {}, { hiddenByFilter: true }, {}, { hiddenByUser: true }, {}, {}, {}, {}];
  const res = gas.parseUpload_({ file: { name: 'x.xlsx', base64: 'AA==' }, mapping: MAP, options: OPTS }, 't');
  assert.strictEqual(res.grouped.invoices.reduce((n, i) => n + i.items.length, 0), 6);
  has(res.notes.join('\n'), '2 hidden rows in the Excel file (hidden by a filter or by hand) were not invoiced.');
  gas.__sheetsError = 'boom';
  const res2 = gas.parseUpload_({ file: { name: 'x.xlsx', base64: 'AA==' }, mapping: MAP, options: OPTS }, 't');
  has(res2.notes.join('\n'), 'couldn\'t be checked for hidden rows');
  assert.strictEqual(res2.grouped.invoices.reduce((n, i) => n + i.items.length, 0), 8);
  gas.__sheetsError = null; gas.__xlsxRows = null; gas.__rowMetadata = null;
});

console.log('Form fields and validation');

test('required fields: invoice number, client name, line type, rate; Candidate / Role optional', () => {
  assert.throws(() => parse('sample-1-basic-en.csv', Object.assign({}, MAP, { lineType: '' })), /Line type is required/);
  assert.throws(() => parse('sample-1-basic-en.csv', Object.assign({}, MAP, { unitPrice: '' })), /Rate is required/);
  const res = parse('sample-1-basic-en.csv', Object.assign({}, MAP, { candidate: '' }));
  assert.strictEqual(inv(res, 'TAL-501').items[0].candidate, '');
  assert.throws(() => parse('sample-1-basic-en.csv', Object.assign({}, MAP, { groupBy: { col: '1' } })), /Group line items by/);
});

test('address comes whole from the first row that has any address part', () => {
  const rows = [['N', 'Client', 'A1', 'City', 'Prov', 'Post', 'Country', 'Type', 'Rate'],
    ['1', 'X', '', '', '', '', '', 'Regular', '1'],
    ['1', 'X', '1 First St', '', 'ON', '', 'Canada', 'Regular', '1'],
    ['1', 'X', '9 Other Ave', 'Elsewhere', 'BC', 'V1V 1V1', 'Canada', 'Regular', '1']];
  const m = { invoiceNumber: 0, customerName: 1, address1: 2, city: 3, province: 4, postalCode: 5, country: 6, lineType: 7, unitPrice: 8, details: [] };
  const g = gas.groupInvoices_(rows.slice(1), m, { language: 'en', taxRates: gas.T.DEFAULT_TAX_RATES });
  assert.deepStrictEqual(plain(gas.formatClientAddress_(g.invoices[0].address)), ['1 First St', 'ON', 'Canada']);
  assert.deepStrictEqual(plain(gas.formatClientAddress_({ city: 'Orlando', province: 'FL', postalCode: '30029' })), ['Orlando, FL  30029']);
  assert.deepStrictEqual(plain(gas.formatClientAddress_({ city: 'Toronto', postalCode: 'm5v 1l9' })), ['Toronto  M5V 1L9']);
});

test('numbers: English format in both languages', () => {
  assert.strictEqual(gas.formatMoney_(1234.5), '$1,234.50');
  assert.strictEqual(gas.formatMoney_(-50), '-$50.00');
  assert.strictEqual(gas.formatQty_(24.5), '24.5');
  assert.strictEqual(gas.formatQty_(9.975), '9.975');
  assert.strictEqual(gas.formatQty_(1250), '1,250');
  assert.ok(isNaN(gas.parseNumber_('8 hrs')));
  assert.strictEqual(gas.parseNumber_('1 234,50 $', true), 1234.5);
  assert.strictEqual(gas.parseNumber_('$45.00'), 45);
});

console.log('Presets');

test('old presets load into the new fields; removed options dropped', () => {
  const s = gas.sanitizeFormState_({ employeeName: 'e', quantity: 'g', customerAddress: 'd', invoiceNumber: 'a' },
    { language: 'fr', currency: '€', accentColor: '#ff0000', recipient: 'x@y.com', companyName: 'Old' });
  assert.strictEqual(s.mapping.candidate, 'E');
  assert.strictEqual(s.mapping.units, 'G');
  assert.strictEqual(s.mapping.address1, 'D');
  assert.deepStrictEqual(plain(s.mapping.groupBy), { col: '', label: '' });
  assert.deepStrictEqual(Object.keys(s.options).sort(), ['combineEmployees', 'dateFormat', 'hasHeader', 'language', 'numberFormat', 'outputMode']);
});

test('save, load, default; group column saved and checked', () => {
  const r = gas.savePreset({ name: 'Database export', mapping: withGroup('Projet'), options: { language: 'fr' },
    headers: { A: 'Invoice #', W: 'Project Number', Z: 'not mapped' }, makeDefault: true });
  assert.strictEqual(r.defaultName, 'Database export');
  const p = gas.getPreset('database EXPORT');
  assert.deepStrictEqual(plain(p.mapping.groupBy), { col: 'W', label: 'Projet' });
  assert.deepStrictEqual(plain(p.headers), { A: 'Invoice #', W: 'Project Number' });
  assert.strictEqual(gas.getConfig().defaultPreset.name, 'Database export');
  gas.deletePreset('Database export');
});

console.log('Tax rates and admins');

test('nobody is an admin by default; rates are read-only', () => {
  const t = gas.getConfig().tax;
  assert.strictEqual(t.isAdmin, false);
  assert.deepStrictEqual(plain(t.rates), plain(gas.T.DEFAULT_TAX_RATES));
  assert.deepStrictEqual(plain(t.rows.map(r => [r.key, r.fr])), [['GST', 'TPS'], ['HST', 'TVH'], ['NSHST', 'NETVH'], ['ONHST', 'ONTVH'], ['PEI', 'IPE'], ['PST', 'TVQ']]);
  assert.throws(() => gas.saveTaxRates({ GST: '6' }), /only be changed by an admin/);
});

test('admins from Config.gs or the script property can save; others are refused', () => {
  gas.T.CONFIG.TAX_ADMINS = ['Owner@Example.com'];
  const rates = { GST: '5', HST: '15', NSHST: '14', ONHST: '14', PEI: '15', PST: '9.975' };
  assert.strictEqual(gas.saveTaxRates(rates).rates.ONHST, 14);
  gas.T.CONFIG.TAX_ADMINS = [];
  gas.__setUser('ben@example.com');
  assert.throws(() => gas.saveTaxRates(rates), /admin/);
  world.scriptProps.TAX_ADMINS = 'ana@example.com,  BEN@example.com ';
  assert.strictEqual(gas.getConfig().tax.isAdmin, true);
  assert.throws(() => gas.saveTaxRates(Object.assign({}, rates, { HST: '101' })), /HST: "101" must be a number from 0 to 100/);
  assert.throws(() => gas.saveTaxRates(Object.assign({}, rates, { PST: '9.9751' })), /up to 3 decimals/);
  assert.throws(() => gas.saveTaxRates(Object.assign({}, rates, { GST: 'abc' })), /GST/);
  const t = gas.getConfig().tax;
  assert.strictEqual(t.updatedBy, OWNER);
  gas.__setUser('carl@example.com');
  assert.throws(() => gas.resetTaxRates(), /admin/);
  gas.__setUser(OWNER);
  delete world.scriptProps.TAX_ADMINS;
});

test('new jobs use the new rate; a QST invoice follows GST + PST', () => {
  const a = inv(parse('sample-1-basic-en.csv', MAP, { combineEmployees: true }), 'TAL-501');
  assert.deepStrictEqual(plain(a.taxes), [{ key: 'ONHST', ratePct: 14, amount: 267.54 }]);
});

console.log('End to end: generate → spreadsheet → edit → rebuild');
const ws = {};

test('generate: folder, original copy, sheet v3, PDF, email to the signed-in user only', () => {
  gas.T.CONFIG.TAX_ADMINS = [OWNER];
  gas.resetTaxRates();
  const res = gas.generateInvoices({ file: fileArg('sample-3-projects.csv'), mapping: withGroup(),
    options: { hasHeader: true, combineEmployees: true, recipient: 'someone@else.com' } });
  assert.strictEqual(res.emailedTo, OWNER);
  assert.strictEqual(world.emails.length, 1);
  assert.strictEqual(world.emails[0].to, OWNER);
  has(world.emails[0].htmlBody, 'Original data file');
  const folder = folderOf(res);
  assert.deepStrictEqual(folder.viewers, [], 'nothing shared');
  const original = folder.files().filter(f => f.getName() === 'Original data - sample-3-projects.csv')[0];
  assert.ok(original, 'original copy saved');
  assert.strictEqual(original.blob.getDataAsString(), fs.readFileSync(path.join(__dirname, '..', 'sample-3-projects.csv'), 'utf8'));
  assert.ok(res.originalUrl);
  const ss = world.sheets[res.sheetUrl.match(/d\/([^/]+)/)[1]];
  const sh = ss.getSheets()[0];
  const header = sh.grid[0];
  assert.strictEqual(header[23], 'Project Number', 'X = group label');
  assert.strictEqual(header[24], 'Location');
  assert.strictEqual(header[14], 'Candidate / Role');
  assert.strictEqual(sh.grid[1][22], 'GST', 'tax code on the first row');
  assert.strictEqual(sh.grid[1][12], 'V6B 2T4');
  const html1 = pdfHtml(res)[0];
  has(html1, 'Project Number: P-1001');
  has(html1, 'GST (5%)');
  ws.sh = sh; ws.ss = ss; ws.res = res;
});

test('rebuild after edits: units, address, tax code, group label; same PDF file; original untouched', () => {
  const { sh, res } = ws;
  const before = pdfHtml(res);
  const pdfFiles = folderOf(res).files().filter(f => /\.pdf$/.test(f.getName()) && !f.trashed);
  sh.grid[2][19] = 10;               // Ana Silva P-1001 units 8 → 10
  sh.grid[1][12] = 'V6B 9Z9';        // postal code
  sh.grid[1][22] = 'QST';            // tax code
  sh.grid[0][23] = 'Projet';         // group label
  const rebuilt = gas.rebuildFromSpreadsheet({ sheet: res.sheetUrl });
  const after = pdfHtml(res);
  assert.strictEqual(after.length, before.length);
  const newPdfs = folderOf(res).files().filter(f => /\.pdf$/.test(f.getName()) && !f.trashed);
  assert.deepStrictEqual(newPdfs.map(f => f.id), pdfFiles.map(f => f.id), 'same file IDs (links keep working)');
  has(after[0], 'V6B 9Z9');
  has(after[0], 'PST (9.975%)');
  has(after[0], 'Projet: P-1001');
  assert.ok(rebuilt.invoices[0].total !== res.invoices[0].total);
  assert.ok(folderOf(res).files().some(f => f.getName().indexOf('Original data - ') === 0 && !f.trashed));
});

test('rebuild keeps the rates the job was made with', () => {
  const { res } = ws;
  gas.saveTaxRates({ GST: '7', HST: '15', NSHST: '14', ONHST: '13', PEI: '15', PST: '9.975' });
  gas.rebuildFromSpreadsheet({ sheet: res.sheetUrl });
  has(pdfHtml(res)[0], 'GST (5%)');
  hasNot(pdfHtml(res)[0], 'GST (7%)');
  gas.resetTaxRates();
});

test('switching to separate PDFs trashes the combined one but keeps the original', () => {
  const { ss, res } = ws;
  ss.getSheets()[1].grid[2][2] = 'separate';
  gas.rebuildFromSpreadsheet({ sheet: res.sheetUrl });
  const live = folderOf(res).files().filter(f => !f.trashed).map(f => f.getName());
  assert.ok(live.some(n => n.indexOf('Original data - ') === 0));
  assert.ok(live.some(n => /^Invoice INV-3001/.test(n)));
  assert.ok(!live.some(n => /^All invoices/.test(n)));
});

test('older spreadsheets get the "generate again" message', () => {
  const { ss, res } = ws;
  const metaSheet = ss.getSheetByName('_meta');
  const row = metaSheet.grid.findIndex(r => r && r[0] === 'version');
  metaSheet.grid[row][1] = '2';
  assert.throws(() => gas.rebuildFromSpreadsheet({ sheet: res.sheetUrl }), /older version.*Generate it again/);
  metaSheet.grid[row][1] = '3';
});

test('no signed-in email stops the job with the sign-in message', () => {
  gas.__setUser('');
  assert.throws(() => generate('sample-1-basic-en.csv'), /couldn't confirm your Google account/);
  gas.__setUser(OWNER);
});

console.log('Branding (Config.gs)');

test('logo: blank → none; PNG → embedded; unreadable / not PNG / too big → warning, invoices still built', () => {
  const C = gas.T.CONFIG;
  assert.strictEqual(gas.loadBranding_('en').logo, '');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const folder = Object.values(world.folders)[0];
  const f = folder.createFile(gas.Utilities.newBlob(png, 'image/png', 'logo.png'));
  C.LOGO_DRIVE_FILE_ID = f.getId();
  const b = gas.loadBranding_('en');
  assert.ok(b.logo.indexOf('data:image/png;base64,') === 0);
  has(html(parse('sample-1-basic-en.csv'), 'TAL-501'), '<img src="data:image/png;base64,');
  const jpg = folder.createFile(gas.Utilities.newBlob(png, 'image/jpeg', 'logo.jpg'));
  C.LOGO_DRIVE_FILE_ID = jpg.getId();
  has(gas.loadBranding_('en').warnings[0], 'isn\'t a PNG');
  const big = folder.createFile(gas.Utilities.newBlob(Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png', 'big.png'));
  C.LOGO_DRIVE_FILE_ID = big.getId();
  has(gas.loadBranding_('en').warnings[0], 'over 2 MB');
  C.LOGO_DRIVE_FILE_ID = 'missing-id';
  has(gas.loadBranding_('en').warnings[0], 'check the logo\'s sharing settings');
  const res = generate('sample-1-basic-en.csv');
  has(res.warnings.join(' '), 'logo couldn\'t be loaded');
  assert.strictEqual(res.invoices.length, 2);
  C.LOGO_DRIVE_FILE_ID = '';
});

test('company block, government numbers, footer: per language, French blanks fall back to English', () => {
  const C = gas.T.CONFIG;
  const en = gas.loadBranding_('en'), fr = gas.loadBranding_('fr');
  assert.deepStrictEqual(plain(en.company.gov), ['HST/GST # 000000000 RT0001', 'QST # 0000000000 TQ0001']);
  assert.deepStrictEqual(plain(fr.company.gov), ['TVH/TPS # 000000000 RT0001', 'TVQ # 0000000000 TQ0001', 'Permis QC 000000']);
  const saved = JSON.stringify(C.FOOTER.fr) + JSON.stringify(C.GOVERNMENT_NUMBERS) + JSON.stringify(C.COMPANY.fr);
  C.FOOTER.fr.remittance = ''; C.FOOTER.fr.bankDetails = []; C.COMPANY.fr.address = []; C.GOVERNMENT_NUMBERS.qst = '';
  const fr2 = gas.loadBranding_('fr');
  assert.strictEqual(fr2.footer.remittance, C.FOOTER.en.remittance);
  assert.strictEqual(fr2.footer.bankDetails[0][0], 'Bank ID');
  assert.deepStrictEqual(plain(fr2.company.address), plain(C.COMPANY.en.address));
  assert.deepStrictEqual(plain(fr2.company.gov), ['TVH/TPS # 000000000 RT0001', 'Permis QC 000000']);
  C.FOOTER.fr = JSON.parse(saved.slice(0, saved.indexOf('}{') + 1));
  C.GOVERNMENT_NUMBERS.qst = '0000000000 TQ0001';
  C.COMPANY.fr.address = ['ABC Store', '123 Front Street', 'Orlando, FL 30029'];
  assert.strictEqual(gas.footerHtml_({ paymentTitle: '', bankAddress: [], bankDetails: [], remittance: '', disclosure: '' }), '');
  has(gas.footerHtml_(Object.assign({}, en.footer, { disclosure: '<b>x</b>' })), '&lt;b&gt;x&lt;/b&gt;', 'escaped');
});

if (process.argv.includes('--html')) {
  const out = path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  [['1-basic-en', 'sample-1-basic-en.csv', MAP, { combineEmployees: true }],
   ['2-quebec-fr', 'sample-2-quebec-fr.csv', MAP, { language: 'fr', combineEmployees: true }],
   ['3-projects', 'sample-3-projects.csv', withGroup(), { combineEmployees: true }],
   ['4-tax-codes', 'sample-4-tax-codes.csv', MAP, {}],
   ['5-edge-cases', 'sample-5-edge-cases.csv', MAP, {}],
   ['6-long-en', 'sample-6-long.csv', withGroup(), {}],
   ['6-long-fr', 'sample-6-long.csv', withGroup(), { language: 'fr' }]].forEach(([name, file, map, o]) => {
    fs.writeFileSync(path.join(out, name + '.html'), html(parse(file, map, o)));
  });
  console.log('Wrote invoice HTML to tests/out/');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
