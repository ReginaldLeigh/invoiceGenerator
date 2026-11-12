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
  taxCode: 'V', details: [{ col: 'X', label: 'Location' }, { col: 'Y', label: 'Shift' }], groupBy: { col: '' },
};
// Labels as the form sends them: filled in from the header, unless the user changed or cleared them.
const withGroup = (label) => Object.assign({}, MAP, { groupBy: { col: 'W', label: label === undefined ? 'Project Number' : label } });
const OPTS = { hasHeader: true };

function parse(file, mapping, options) {
  return gas.parseUpload_({ file: fileArg(file), mapping: mapping || MAP, options: Object.assign({}, OPTS, options) }, 'test');
}
const inv = (res, n) => res.grouped.invoices.filter(i => i.number === n)[0];
/** Invoice HTML; break points (<wbr>) are removed so text can be searched as printed. rawHtml keeps them. */
const rawHtml = (res, n) => {
  const L = I18N[res.opts.language];
  return gas.invoicesHtml_(n ? [inv(res, n)] : res.grouped.invoices, res.opts, L, gas.loadBranding_(res.opts.language));
};
const html = (res, n) => rawHtml(res, n).replace(/<wbr>/g, '');
function generate(file, mapping, options) {
  world.emails.length = 0;
  return gas.generateInvoices({ file: fileArg(file), mapping: mapping || MAP, options: Object.assign({}, OPTS, options) });
}
function folderOf(res) { return Object.values(world.folders).filter(f => f.getUrl() === res.folderUrl)[0]; }
function pdfHtml(res) {
  return folderOf(res).files().filter(f => !f.trashed && /\.pdf$/.test(f.getName())).map(f => f.blob.getDataAsString().replace(/<wbr>/g, ''));
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
   'Permis QC 000000', 'Paiement par TEF', 'N° d&#39;institution:', 'N° de transit:', 'N° de compte:',
   '1234 Alexander Street', 'Saint-Laurent QC H4R 1Y8', 'ABC Store', 'Page 1 de 1'].forEach(s => has(h, s));
  ['PRIVATE', 'HST/GST', 'Invoice Date', '1 050,00', '9,975', 'rue Alexander', 'Bank ID'].forEach(s => hasNot(h, s));
});

console.log('Sample 3 — grouping by Project Number');

test('groups in first-appearance order, ungrouped lines first without a heading', () => {
  const res = parse('sample-3-projects.csv', withGroup(), { combineEmployees: true });
  const m = inv(res, 'INV-3001');
  assert.strictEqual(m.groupLabel, 'Project Number', 'label as sent by the form');
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
  has(h, 'Payment Due Date</td><td class="val" style="max-width:150pt"></td>', 'blank due date keeps the label');
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
    const room = P.HEIGHT - P.NUMBER_ROW - P.GAP_HEADER_BODY - P.COL_HEADER - P.SAFETY - (p === 0 ? gas.fullHeaderHeight_(g, b) : P.CONDENSED_HEADER);
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
  const ht = html(res, 'TAL-501');
  assert.ok(ht.indexOf('class="pn"') < ht.indexOf('class="page-content"'), 'page number row comes first (top-right)');
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

test('switching to a combined PDF trashes the per-invoice one but keeps the original', () => {
  const { ss, res } = ws;
  assert.strictEqual(ss.getSheets()[1].grid[2][2], 'separate', 'separate is the default');
  ss.getSheets()[1].grid[2][2] = 'combined';
  gas.rebuildFromSpreadsheet({ sheet: res.sheetUrl });
  const live = folderOf(res).files().filter(f => !f.trashed).map(f => f.getName());
  assert.ok(live.some(n => n.indexOf('Original data - ') === 0));
  const pdfs = live.filter(n => /\.pdf$/.test(n));
  assert.deepStrictEqual(pdfs, ['INV-3001 - Maple Productions.pdf'], 'one combined PDF, the per-invoice one trashed: ' + live.join(' | '));
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

test('same company and bank details in both languages; only labels change; French text falls back', () => {
  const C = gas.T.CONFIG;
  const en = gas.loadBranding_('en'), fr = gas.loadBranding_('fr');
  assert.deepStrictEqual(plain(en.company), plain(Object.assign({}, fr.company, { gov: en.company.gov })));
  assert.deepStrictEqual(plain(en.company.gov), ['HST/GST # 000000000 RT0001', 'QST # 0000000000 TQ0001']);
  assert.deepStrictEqual(plain(fr.company.gov), ['TVH/TPS # 000000000 RT0001', 'TVQ # 0000000000 TQ0001', 'Permis QC 000000']);
  assert.deepStrictEqual(plain(en.footer.bankAddress), plain(fr.footer.bankAddress));
  assert.deepStrictEqual(plain(en.footer.bankDetails), [['Bank ID', '007'], ['Bank Transit', '12345'], ['Account #', '12312312323']]);
  assert.deepStrictEqual(plain(fr.footer.bankDetails), [["N° d'institution", '007'], ['N° de transit', '12345'], ['N° de compte', '12312312323']]);
  assert.strictEqual(fr.footer.paymentTitle, 'Paiement par TEF');
  const savedFr = JSON.stringify(C.FOOTER_TEXT.fr);
  C.FOOTER_TEXT.fr.remittance = '';
  assert.strictEqual(gas.loadBranding_('fr').footer.remittance, C.FOOTER_TEXT.en.remittance);
  C.FOOTER_TEXT.fr = JSON.parse(savedFr);
  C.GOVERNMENT_NUMBERS.qst = '';
  assert.deepStrictEqual(plain(gas.loadBranding_('fr').company.gov), ['TVH/TPS # 000000000 RT0001', 'Permis QC 000000']);
  C.GOVERNMENT_NUMBERS.qst = '0000000000 TQ0001';
  C.BANK.transit = '';
  assert.deepStrictEqual(plain(gas.loadBranding_('en').footer.bankDetails.map(p => p[0])), ['Bank ID', 'Account #'], 'blank value hides its line');
  C.BANK.transit = '12345';
  assert.strictEqual(gas.footerHtml_({ paymentTitle: '', bankAddress: [], bankDetails: [], remittance: '', disclosure: '' }), '');
  has(gas.footerHtml_(Object.assign({}, en.footer, { disclosure: '<b>x</b>' })), '&lt;b&gt;x&lt;/b&gt;', 'escaped');
});

console.log('Version 3.1 — emails, defaults, logs, metrics, layout');

const logsFor = runId => world.logs.filter(l => l.entry.runId === runId).map(l => l.entry);
const LAYOUT_B = { invoiceNumber: 'F', clientNumber: 'L', invoiceDate: 'N', dueDate: 'O', customerName: 'A', attention: 'B',
  address1: 'C', address2: 'D', address3: 'E', address4: 'G', city: 'H', province: 'I', postalCode: 'J', country: 'K',
  candidate: 'P', unitPrice: 'Q', units: 'R', lineType: 'S', workOrder: 'T', purchaseOrder: 'U', workDate: 'V', taxCode: 'X',
  groupBy: { col: 'Y', label: 'Project' }, details: [{ col: 'Z', label: 'Location' }, { col: 'AA', label: 'Shift' }] };
const LAYOUT_C = { invoiceNumber: 'A', invoiceDate: 'B', dueDate: 'C', clientNumber: 'D', lineType: 'E', customerName: 'F',
  candidate: 'G', units: 'H', unitPrice: 'I', taxCode: 'J', attention: 'K', address1: 'L', address2: 'M', address3: 'N',
  address4: 'O', city: 'P', province: 'Q', postalCode: 'R', country: 'S', workOrder: 'T', purchaseOrder: 'U', workDate: 'V',
  groupBy: { col: 'W', label: 'Projet' }, details: [{ col: 'X', label: 'Location' }, { col: 'Y', label: 'Shift' }] };

test('defaults: one PDF per invoice and English', () => {
  assert.strictEqual(gas.normalizeLayoutOptions_({}).outputMode, 'separate');
  assert.strictEqual(gas.normalizeLayoutOptions_({ outputMode: 'combined' }).outputMode, 'combined');
  assert.strictEqual(gas.sanitizeFormState_({}, {}).options.outputMode, 'separate');
  assert.strictEqual(gas.sanitizeFormState_({}, {}).options.language, 'en');
  const res = generate('sample-1-basic-en.csv');
  assert.strictEqual(res.invoices.length, 2);
  assert.ok(res.zipUrl, 'ZIP for more than one PDF');
  assert.strictEqual(pdfHtml(res).length, 2, 'one PDF per invoice');
});

test('emails are English even for French invoices; no-reply sender name and line; no Reply-To', () => {
  generate('sample-2-quebec-fr.csv', MAP, { language: 'fr' });
  const m = world.emails[0];
  assert.strictEqual(m.name, 'Morph - Invoice PDF Generator (no reply)');
  assert.strictEqual(m.replyTo, undefined);
  has(m.subject, 'Your 2 invoice PDFs are ready');
  has(m.htmlBody, 'invoices were created from');
  has(m.htmlBody, 'This is an automated message. Please don&#39;t reply.');
  has(m.body, 'This is an automated message.');
  hasNot(m.htmlBody, 'Votre');
  hasNot(m.htmlBody, 'factures');
});

test('logs: page open and every generate stage, each with run id, user and timestamp', () => {
  world.logs.length = 0;
  gas.getConfig();
  const open = world.logs.find(l => l.entry.stage === 'page_open').entry;
  assert.strictEqual(open.user, OWNER);
  assert.ok(open.runId && /^\d{4}-\d{2}-\d{2}T/.test(open.timestamp));
  const res = generate('sample-1-basic-en.csv');
  const stages = logsFor(res.jobId).map(e => e.stage);
  ['start', 'request', 'file_read', 'parsed', 'folder_created', 'original_saved', 'sheet_created', 'pdfs_written',
   'email_sent', 'run_metrics', 'done'].forEach(st => assert.ok(stages.indexOf(st) !== -1, 'stage ' + st + ' in ' + stages.join(',')));
  assert.ok(stages.indexOf('file_read') < stages.indexOf('pdfs_written') && stages.indexOf('pdfs_written') < stages.indexOf('done'));
  logsFor(res.jobId).forEach(e => { assert.strictEqual(e.user, OWNER); assert.strictEqual(e.app, 'invoice-pdf-generator'); assert.ok(e.timestamp); });
  assert.ok(res.folderName.indexOf(res.jobId) !== -1, 'run id = job id = folder reference');
  gas.listPresets();
  assert.ok(world.logs.some(l => l.entry.function === 'listPresets' && l.entry.stage === 'done'));
});

test('unexpected error: logged with stack, emailed to DEV_EMAIL once per 10 minutes per user, user sees the reference', () => {
  world.emails.length = 0; world.logs.length = 0; world.caches = {};
  world.failCreateFile = 'Drive is down';
  const run = () => gas.generateInvoices({ file: fileArg('sample-1-basic-en.csv'), mapping: MAP, options: OPTS });
  let err1, err2;
  try {
  try { run(); } catch (e) { err1 = e; }
  assert.ok(err1 && /Something went wrong \(reference \w+\)\. The developer has been notified\. Details: Drive is down/.test(err1.message), err1 && err1.message);
  const errLog = world.logs.find(l => l.entry.stage === 'error');
  assert.strictEqual(errLog.level, 'error');
  has(errLog.entry.stack, 'Drive is down');
  assert.strictEqual(errLog.entry.stageReached, 'folder_created');
  let dev = world.emails.filter(m => m.to === 'reggie.leigh@gmail.com');
  assert.strictEqual(dev.length, 1);
  has(dev[0].subject, '[Morph - Invoice PDF Generator] Error in generateInvoices (run ');
  ['Run id:', 'User:          ' + OWNER, 'Stage reached: folder_created', 'sample-1-basic-en.csv', 'Error: Drive is down']
    .forEach(t => has(dev[0].body, t));
  hasNot(dev[0].body, 'Northwind', 'file contents never included');
  try { run(); } catch (e) { err2 = e; }
  assert.ok(err2);
  assert.strictEqual(world.emails.filter(m => m.to === 'reggie.leigh@gmail.com').length, 1, 'same error not emailed twice');
  assert.ok(world.logs.some(l => l.entry.stage === 'dev_email_skipped'));
  gas.__setUser('ben@example.com');
  try { run(); } catch (e) { /* expected */ }
  assert.strictEqual(world.emails.filter(m => m.to === 'reggie.leigh@gmail.com').length, 2, 'another user: emailed');
  } finally {
    gas.__setUser(OWNER);
    world.failCreateFile = null;
  }
});

test('user mistakes are logged as warnings and not emailed', () => {
  world.emails.length = 0; world.logs.length = 0;
  assert.throws(() => generate('sample-1-basic-en.csv', Object.assign({}, MAP, { lineType: '' })), /^Error: Line type is required/);
  const w = world.logs.find(l => l.entry.stage === 'user_error');
  assert.strictEqual(w.level, 'warn');
  has(w.entry.message, 'Line type is required');
  assert.strictEqual(world.emails.length, 0);
  gas.__setUser('not.an.admin@example.com');
  assert.throws(() => gas.saveTaxRates({}), /only be changed by an admin/);
  gas.__setUser(OWNER);
  assert.strictEqual(world.emails.length, 0);
});

test('run metrics: one row per client per Generate, [runId, user, clientId, invoices, runTimeMs]; none on Rebuild', () => {
  const sent = [];
  gas.sendRunMetrics_ = rows => sent.push(rows);
  const res = generate('sample-4-tax-codes.csv');
  assert.strictEqual(sent.length, 1);
  const rows = sent[0];
  assert.strictEqual(rows.length, 12, 'one row per client');
  rows.forEach(r => {
    assert.strictEqual(r.length, 5);
    assert.strictEqual(r[0], res.jobId);
    assert.strictEqual(r[1], OWNER);
    assert.strictEqual(r[3], 1);
    assert.ok(Number.isInteger(r[4]) && r[4] >= 0, 'whole ms');
  });
  assert.strictEqual(rows[0][2], 'C-401');
  const res1 = generate('sample-1-basic-en.csv');
  assert.deepStrictEqual(plain(sent[1].map(r => [r[2], r[3]])), [['C-1001', 1], ['C-1002', 1]]);
  const logged = logsFor(res1.jobId).find(e => e.stage === 'run_metrics');
  assert.deepStrictEqual(plain(logged.rows), plain(sent[1]));
  gas.rebuildFromSpreadsheet({ sheet: res1.sheetUrl });
  assert.strictEqual(sent.length, 2, 'rebuild produces no rows');
  gas.sendRunMetrics_ = () => { throw new Error('library down'); };
  const res2 = generate('sample-1-basic-en.csv');
  assert.strictEqual(res2.invoices.length, 2, 'metrics failure never fails the run');
  assert.ok(logsFor(res2.jobId).some(e => e.stage === 'metrics_failed'));
  // blank client # → ''
  const g = gas.buildRunMetrics_({ id: 'r1', user: 'u', started: Date.now() }, [{ clientNumber: '' }, { clientNumber: '' }, { clientNumber: 'X' }]);
  assert.deepStrictEqual(plain(g.map(r => [r[2], r[3]])), [['', 2], ['X', 1]]);
  gas.sendRunMetrics_ = () => {};
});

test('two users at once: separate folders, sheets, presets, emails, logs and metrics; shared tax rates', () => {
  world.emails.length = 0;
  const A = 'ana@example.com', B = 'ben@example.com';
  gas.__setUser(A); const pa = gas.parseUpload_({ file: fileArg('sample-1-basic-en.csv'), mapping: MAP, options: OPTS }, 'a');
  gas.__setUser(B); const rb = generate('sample-3-projects.csv', withGroup()); const mailB = world.emails.map(m => m.to);
  gas.__setUser(A); const ra = generate('sample-1-basic-en.csv'); const mailA = world.emails.map(m => m.to);
  assert.strictEqual(pa.grouped.invoices.length, 2);
  assert.notStrictEqual(ra.folderUrl, rb.folderUrl);
  assert.notStrictEqual(ra.sheetUrl, rb.sheetUrl);
  assert.notStrictEqual(ra.jobId, rb.jobId);
  assert.deepStrictEqual([mailB, mailA], [[B], [A]], 'each result email goes only to its own user');
  assert.ok(logsFor(ra.jobId).every(e => e.user === A) && logsFor(rb.jobId).every(e => e.user === B));
  gas.__setUser(A); gas.savePreset({ name: 'Mine', mapping: MAP, options: {} });
  gas.__setUser(B); assert.strictEqual(gas.listPresets().presets.filter(p => p.name === 'Mine').length, 0, 'presets private');
  assert.strictEqual(gas.getConfig().tax.rates.ONHST, gas.T.DEFAULT_TAX_RATES.ONHST, 'shared tax rates');
  // A rebuild in progress blocks a second rebuild of the same sheet, from anyone.
  const ss = world.sheets[ra.sheetUrl.match(/d\/([^/]+)/)[1]];
  gas.claimSpreadsheet_(ss);
  assert.throws(() => gas.rebuildFromSpreadsheet({ sheet: ra.sheetUrl }), /already being rebuilt/);
  gas.releaseSpreadsheet_(ss);
  gas.__setUser(A); gas.deletePreset('Mine');
  gas.__setUser(OWNER);
});

test('invoice: units total, page number first on every page, spacing, footer row at the bottom', () => {
  const res = parse('sample-1-basic-en.csv', MAP, { combineEmployees: true });
  const h = html(res, 'TAL-501');
  has(h, '<tr class="total"><td>Total</td><td class="num">44.5</td></tr>');
  has(h, '.items{margin-top:24pt;');
  has(h, 'class="summary" style="margin-top:28pt"');
  has(h, '.footer{margin-top:30pt;');
  assert.ok(h.indexOf('<td class="pn"') < h.indexOf('Invoice #'), 'page number before the header');
  assert.ok(h.indexOf('<td class="page-footer">') > h.indexOf('Total (CAD)'), 'footer in its own bottom row');
  has(h, '<td class="page-content" style="height:100%">');
  const fr = html(parse('sample-2-quebec-fr.csv', MAP, { language: 'fr' }), 'FAC-2001');
  has(fr, '<tr class="total"><td>Total</td><td class="num">32</td></tr>');
  gas.T.CONFIG.FOOTER_AT_PAGE_BOTTOM = false;
  const h2 = html(res, 'TAL-501');
  hasNot(h2, 'class="page-footer"');
  assert.ok(h2.indexOf('EFT Payment') > h2.indexOf('Total (CAD)'), 'footer follows the totals');
  gas.T.CONFIG.FOOTER_AT_PAGE_BOTTOM = true;
  const long = html(parse('sample-6-long.csv', withGroup()), 'L-601');
  const pages = long.split('<table class="page"').slice(1);
  pages.forEach((p, i) => assert.ok(p.indexOf('class="pn"') < p.indexOf('class="page-content"'), 'page ' + (i + 1)));
  assert.strictEqual((long.match(/class="page-footer"/g) || []).length, 1, 'footer only on the last page');
});

test('long strings: soft break points, nothing unbreakable over 14 characters, pagination fits', () => {
  const res = parse('sample-10-long-strings.csv', withGroup());
  const raw = rawHtml(res);
  has(raw, 'Maximiliana Alexandrovna Konstantinop<wbr>');
  has(raw, 'WO-<wbr>2026-<wbr>');
  has(raw, 'AnUnbrokenCa<wbr>');
  has(raw, '$1,250,000.00');
  has(raw, '$3,749,999.63');
  // Every word in visible text is ≤ 14 characters or contains break points.
  const text = raw.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<img[^>]*>/g, '').replace(/<(?!wbr)[^>]+>/g, ' ');
  text.split(/\s+/).forEach(w => {
    if (w.replace(/<wbr>/g, '').length > 14) assert.ok(w.indexOf('<wbr>') !== -1, 'unbreakable: ' + w);
  });
  const i = inv(res, 'INV-2026-11-LONG-INVOICE-NUMBER-0000123456');
  const b = gas.loadBranding_('en');
  const pages = gas.paginateInvoice_(i, b);
  const P = gas.T.PAGE;
  pages.forEach((rows, p) => {
    const used = rows.reduce((n, r) => n + r.h, 0) + (p === pages.length - 1 ? gas.tailHeight_(i, b) : 0);
    const room = P.HEIGHT - P.NUMBER_ROW - P.GAP_HEADER_BODY - P.COL_HEADER - P.SAFETY - (p === 0 ? gas.fullHeaderHeight_(i, b) : P.CONDENSED_HEADER);
    assert.ok(used <= room, 'page ' + (p + 1) + ' fits');
  });
});

test('different column layouts (samples 8 and 9) give the same invoices as the standard layout', () => {
  const a = parse('sample-1-basic-en.csv', withGroup()).grouped.invoices.concat(parse('sample-3-projects.csv', withGroup()).grouped.invoices);
  const b = parse('sample-8-layout-b.csv', LAYOUT_B).grouped.invoices;
  const c = parse('sample-9-layout-c.csv', LAYOUT_C, { numberFormat: 'comma' }).grouped.invoices;
  const sum = list => plain(list.map(i => [i.number, i.clientNumber, i.invoiceDate, i.customerName, i.subtotal, i.total,
    i.unitsSummary, gas.formatClientAddress_(i.address), i.groups.map(g => g.value)]));
  assert.deepStrictEqual(sum(b), sum(a));
  assert.deepStrictEqual(sum(c), sum(a));
  assert.strictEqual(parse('sample-8-layout-b.csv', LAYOUT_B).grouped.invoices[0].groupLabel, 'Project');
  assert.strictEqual(parse('sample-9-layout-c.csv', LAYOUT_C).grouped.invoices[0].groupLabel, 'Projet');
});

console.log('Version 3.2 — preview width');

test('preview shows every column up to ZZ and the whole header row', () => {
  const wide = (n, rows) => {
    const cols = Array.from({ length: n }, (_, i) => 'Col' + (i + 1));
    const lines = [cols.join(',')].concat(Array.from({ length: rows }, (_, r) => cols.map((_, i) => 'r' + r + 'c' + i).join(',')));
    return { name: 'wide.csv', base64: Buffer.from(lines.join('\n')).toString('base64') };
  };
  const p60 = gas.previewFile(wide(60, 10));
  assert.strictEqual(p60.columns.length, 60, 'all 60 columns shown');
  assert.strictEqual(p60.columns[59], 'BH');
  assert.strictEqual(p60.totalColumns, 60);
  assert.strictEqual(p60.rows.length, 6);
  assert.strictEqual(p60.rows[0][59], 'Col60');
  assert.strictEqual(p60.header.length, 60);
  assert.strictEqual(p60.header[59], 'Col60', 'header of column BH');
  // Past the ZZ safety cap: the preview stops at ZZ, but the header row is complete.
  const p750 = gas.previewFile(wide(750, 2));
  assert.strictEqual(p750.columns.length, 702);
  assert.strictEqual(p750.columns[701], 'ZZ');
  assert.strictEqual(p750.rows[0].length, 702);
  assert.strictEqual(p750.totalColumns, 750);
  assert.strictEqual(p750.header.length, 750);
  assert.strictEqual(p750.header[749], 'Col750', 'header of column ABV');
  assert.strictEqual(p60.totalRows, 11);
  const p25 = gas.previewFile(wide(25, 3));
  assert.strictEqual(p25.columns.length, 25);
  assert.strictEqual(p25.columns[24], 'Y');
  assert.strictEqual(p25.totalColumns, 25);
  // Columns after BB can still be mapped and read.
  const t = gas.normalizeMapping_(Object.assign({}, MAP, { details: [{ col: 'BH' }] }));
  assert.strictEqual(t.details[0].index, 59);
});

console.log('Version 3.3 — blank labels');

const BLANK = Object.assign({}, MAP, {
  details: [{ col: 'X', label: '' }, { col: 'Y', label: 'Shift' }],
  groupBy: { col: 'W', label: '' },
});

test('blank labels are kept blank (no header or "Detail n" fallback); typed labels used as typed', () => {
  const res = parse('sample-3-projects.csv', BLANK, { combineEmployees: true });
  const m = inv(res, 'INV-3001');
  assert.deepStrictEqual(plain(m.detailLabels), ['', 'Shift']);
  assert.strictEqual(m.groupLabel, '');
  const typed = inv(parse('sample-3-projects.csv', Object.assign({}, MAP, {
    details: [{ col: 'X', label: 'Site' }], groupBy: { col: 'W', label: 'Job' } })), 'INV-3001');
  assert.deepStrictEqual(plain(typed.detailLabels), ['Site']);
  assert.strictEqual(typed.groupLabel, 'Job');
  assert.strictEqual(I18N.en.detailDefault, undefined, 'no default label text left');
});

test('invoice: a blank label prints only the value; other labels unchanged', () => {
  const res = parse('sample-3-projects.csv', BLANK, { combineEmployees: true });
  const h = html(res, 'INV-3001');
  has(h, '<tr class="grp"><td colspan="8">P-1001</td></tr>', 'group heading is just the value');
  hasNot(h, 'Project Number');
  hasNot(h, 'Location');
  hasNot(h, 'Detail 1');
  hasNot(h, 'Group:');
  assert.ok(/<div class="detail">Stage \d/.test(h), 'detail is just the value');
  has(h, '<div class="detail">Shift: ');
  hasNot(h, '<div class="detail">: ', 'no stray colon');
  hasNot(h, '<td colspan="8">: ', 'no stray colon in the heading');
});

test('blank group label keeps "(continued)" on later pages (French: "(suite)")', () => {
  const en = html(parse('sample-6-long.csv', Object.assign({}, BLANK, { details: [] })));
  assert.ok(/<td colspan="8">[^<:]+ \(continued\)<\/td>/.test(en), 'value + (continued), no label');
  const fr = html(parse('sample-6-long.csv', Object.assign({}, BLANK, { details: [] }), { language: 'fr' }));
  assert.ok(/<td colspan="8">[^<:]+ \(suite\)<\/td>/.test(fr));
});

test('sheet: blank labels are written as "(no label)"; rebuild keeps them blank; renaming adds the label', () => {
  const res = generate('sample-3-projects.csv', BLANK);
  const ss = world.sheets[res.sheetUrl.match(/d\/([^/]+)/)[1]];
  const sh = ss.getSheets()[0];
  assert.strictEqual(sh.grid[0][23], '(no label)', 'X header');
  assert.strictEqual(sh.grid[0][24], '(no label)', 'Y header');
  assert.strictEqual(sh.grid[0][25], 'Shift');
  assert.ok(sh.grid.slice(1).some(r => r[23] === 'P-1001'), 'group values still written');
  hasNot(pdfHtml(res).join(''), 'Project Number');
  gas.rebuildFromSpreadsheet({ sheet: res.sheetUrl });
  let pdf = pdfHtml(res).join('');
  has(pdf, '<td colspan="8">P-1001</td>', 'rebuild: still value only');
  hasNot(pdf, '(no label)');
  sh.grid[0][23] = 'Projet';
  sh.grid[0][24] = '(NO LABEL)'; // any case
  gas.rebuildFromSpreadsheet({ sheet: res.sheetUrl });
  pdf = pdfHtml(res).join('');
  has(pdf, 'Projet: P-1001', 'renamed marker = label appears');
  hasNot(pdf, 'NO LABEL');
  assert.ok(/<div class="detail">Stage \d/.test(pdf));
  sh.grid[0][23] = '';
  gas.rebuildFromSpreadsheet({ sheet: res.sheetUrl });
  hasNot(pdfHtml(res).join(''), 'P-1001</td></tr>', 'empty X header still turns grouping off');
});

console.log('Version 3.4 — English outside the invoice, Morph naming, file names');

test('French job: the spreadsheet is English (tax dropdown stays French); the invoice is French', () => {
  const res = generate('sample-3-projects.csv', BLANK, { language: 'fr' });
  const ss = world.sheets[res.sheetUrl.match(/d\/([^/]+)/)[1]];
  const [items, settings] = ss.getSheets();
  assert.strictEqual(ss.getName(), 'Invoices - sample-3-projects (editable)');
  assert.strictEqual(items.getName(), 'Invoices');
  assert.strictEqual(settings.getName(), 'Settings');
  assert.strictEqual(ss.locale, 'en_US', 'no fr_CA locale');
  assert.deepStrictEqual(plain(items.grid[0].slice(0, 4)), ['Invoice #', 'Client #', 'Invoice date', 'Payment due date']);
  assert.strictEqual(items.grid[0][23], '(no label)');
  assert.strictEqual(items.grid[0][24], '(no label)');
  has(items.notes['0,0'] || '', 'One row per record');
  assert.deepStrictEqual(plain(settings.grid[0].slice(1)), ['Setting', 'Value', 'Help']);
  assert.strictEqual(settings.grid[1][1], 'Invoice language');
  assert.strictEqual(settings.grid[1][2], 'fr', 'language setting still fr');
  const all = JSON.stringify(items.grid) + JSON.stringify(settings.grid) + ss.getName();
  ['Factures', 'Paramètres', 'Régénérer', 'sans étiquette', 'N° de facture', 'Dossier'].forEach(w => hasNot(all, w));
  const dv = items.validations['1,22'];
  assert.deepStrictEqual(plain(dv.list), ['EXEMPT', 'TPS', 'TVH', 'NETVH', 'ONTVH', 'IPE', 'QST'], 'French tax dropdown kept');
  const pdf = pdfHtml(res)[0];
  has(pdf, 'N° de facture'); has(pdf, 'Sous-total'); has(pdf, 'PRIVÉ ET CONFIDENTIEL');
  const names = folderOf(res).files().filter(f => !f.trashed).map(f => f.getName());
  assert.ok(names.indexOf('INV-3001 - Maple Productions.pdf') !== -1, names.join(' | '));
  hasNot(names.join('|'), 'Facture');
});

test('Rebuild reads numbers typed as text the English way, also for French jobs', () => {
  const res = generate('sample-1-basic-en.csv', MAP, { language: 'fr', outputMode: 'combined' });
  const sh = world.sheets[res.sheetUrl.match(/d\/([^/]+)/)[1]].getSheets()[0];
  sh.grid[1][19] = '1,234';  // units typed as text
  sh.grid[1][20] = '2.5';    // rate typed as text
  gas.rebuildFromSpreadsheet({ sheet: res.sheetUrl });
  has(pdfHtml(res)[0], '1,234');
  has(pdfHtml(res)[0], '$3,085.00', '1234 × 2.50');
});

test('names: root folder "Morph - Invoice PDFs", page title, email footer', () => {
  const res = generate('sample-1-basic-en.csv');
  const job = folderOf(res);
  assert.strictEqual(job.parent.getName(), 'Morph - Invoice PDFs');
  assert.strictEqual(gas.T.ROOT_FOLDER_NAME, 'Morph - Invoice PDFs');
  has(world.emails[0].htmlBody, 'Sent by Morph - Invoice PDF Generator.');
  const page = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
  has(page, '<h1>Morph - Invoice PDF Generator</h1>');
  has(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ".setTitle('Morph - Invoice PDF Generator')");
});

test('file names: "<invoice #> - <client>.pdf"; ZIP named after the client only when there is one', () => {
  const live = res => folderOf(res).files().filter(f => !f.trashed).map(f => f.getName()).sort();
  // Sample 1: two invoices, two different clients.
  const two = generate('sample-1-basic-en.csv');
  const n2 = live(two);
  assert.ok(n2.indexOf('All invoices.zip') !== -1, 'several clients → All invoices.zip: ' + n2.join(' | '));
  assert.ok(n2.filter(n => /\.pdf$/.test(n)).every(n => /^[A-Z]+-\d+ - .+\.pdf$/.test(n)), n2.join(' | '));
  hasNot(n2.join('|'), 'Invoice TAL');
  // Combined with several invoices keeps the uploaded file's name.
  const comb = generate('sample-1-basic-en.csv', MAP, { outputMode: 'combined' });
  assert.ok(live(comb).indexOf('All invoices - sample-1-basic-en.pdf') !== -1, live(comb).join(' | '));
  // Unit level: one client across invoices (any case/spacing), blank client names ignored, no client name.
  const inv = (number, customerName) => ({ number, customerName });
  assert.strictEqual(gas.zipName_([inv('A-1', 'Maple Productions'), inv('A-2', ' maple   productions '), inv('A-3', '')]),
    'All invoices - Maple Productions.zip');
  assert.strictEqual(gas.zipName_([inv('A-1', 'Maple'), inv('A-2', 'Birch')]), 'All invoices.zip');
  assert.strictEqual(gas.zipName_([inv('A-1', ''), inv('A-2', '')]), 'All invoices.zip');
  assert.strictEqual(gas.pdfBaseName_(inv('INV/7', 'Maple: West')), 'INV-7 - Maple- West');
  assert.strictEqual(gas.pdfBaseName_(inv('INV-8', '')), 'INV-8');
});

console.log('Version 3.4 — JSDoc');

test('every function has a JSDoc comment with matching @param and @return tags', () => {
  const docs = require('../tools/build-docs');
  const ts = docs.loadTypeScript();
  if (!ts) { console.log('    (skipped: the typescript package is not installed)'); return; }
  const data = docs.collect(ts);
  const fns = data.entries.filter(e => e.kind === 'function');
  assert.ok(fns.length > 150, 'found ' + fns.length + ' functions');
  ['generateInvoices', 'parseUpload_', 'zipName_', 'sendRunMetrics_', 'fillLabels', 'cleanText_'].forEach(n =>
    assert.ok(fns.some(f => f.name === n), n + ' found'));
  assert.deepStrictEqual(docs.check(data.entries), [], 'documentation problems');
  assert.ok(data.typedefs.some(t => t.name === 'Invoice') && data.typedefs.some(t => t.name === 'FormState'));
  // The checker itself catches mistakes.
  const fake = [
    { kind: 'function', name: 'a', file: 'x', line: 1, params: ['p'], returns: true, doc: docs.parseDoc('/** Does a.\n * @param {string} q Wrong name. */') },
    { kind: 'function', name: 'b', file: 'x', line: 2, params: [], returns: false, doc: null },
  ];
  const problems = docs.check(fake);
  ['missing @param p', '@param q is not a parameter', 'no @return', 'b: no JSDoc comment'].forEach(m =>
    assert.ok(problems.some(p => p.indexOf(m) !== -1), m + ' in ' + problems.join(' | ')));
  const d = docs.parseDoc('/**\n * Sum.\n * @param {Array<{a: number}>} [list] Items.\n * @return {number} Total.\n * @example\n * sum([{a: 1}]) // 1\n */');
  assert.deepStrictEqual(plain(d.tags.map(t => [t.tag, t.type, t.name, t.optional])),
    [['param', 'Array<{a: number}>', 'list', true], ['return', 'number', '', false], ['example', '', '', false]]);
  assert.strictEqual(d.tags[2].text, 'sum([{a: 1}]) // 1');
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
   ['6-long-fr', 'sample-6-long.csv', withGroup(), { language: 'fr' }],
   ['10-long-strings', 'sample-10-long-strings.csv', withGroup(), {}],
   ['3-blank-labels', 'sample-3-projects.csv', BLANK, { combineEmployees: true }]].forEach(([name, file, map, o]) => {
    fs.writeFileSync(path.join(out, name + '.html'), html(parse(file, map, o)));
  });
  console.log('Wrote invoice HTML to tests/out/');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
