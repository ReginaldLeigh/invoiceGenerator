/**
 * Invoice PDF Generator — Google Apps Script web app.
 *
 * Users upload a CSV or XLSX file, tell the app which column letter holds
 * each invoice field, choose English or French output, and the app creates a
 * Drive folder containing:
 *   - the invoice PDF(s), and
 *   - an editable Google Sheet of the same invoices.
 * The PDFs are always built from that spreadsheet. To make a small change,
 * the user edits the sheet and opens the "Rebuild PDF" link: the PDFs are
 * regenerated in place (same files, same links), with no re-upload.
 * A link to the folder is emailed to the user.
 *
 * Rows that share an invoice number become line items on the same invoice.
 * A row with a blank invoice number is treated as another line item of the
 * invoice above it.
 *
 * Multi-user safety:
 *  - Deploy with "Execute as: User accessing the web app". Each user's
 *    files, emails, settings and quotas are then their own.
 *  - The server keeps no shared state. Every submission gets its own job ID
 *    and its own Drive folder, and all of its data travels in the request.
 *  - Saved settings are keyed by the signed-in user's email address.
 *  - The one shared resource (the "Invoice PDFs" root folder) is created
 *    under a lock, so two first-time runs can't create it twice.
 */

const ROOT_FOLDER_NAME = 'Invoice PDFs';
const ROOT_FOLDER_KEY = 'rootFolderId';
const MAX_PREVIEW_ROWS = 6;
const MAX_PREVIEW_COLS = 26;
const MAX_EMAIL_LINKS = 50;
const META_SHEET = '_meta';
const REBUILD_TIMEOUT_MS = 7 * 60 * 1000; // a run can't last longer than 6 minutes

/**
 * Fixed column layouts of the editable "Invoices" tab (0-based), by spreadsheet
 * version. Version 2 adds employee + work date and up to 10 "extra detail"
 * columns (O–X) whose header text is the label printed on the PDF.
 * Version 1 sheets (no employee/detail columns) can still be rebuilt.
 */
const SHEET_LAYOUTS = {
  '1': {
    map: { invoiceNumber: 0, invoiceDate: 1, dueDate: 2, customerName: 3, customerEmail: 4,
           customerAddress: 5, description: 6, quantity: 7, unitPrice: 8, taxRate: 10, notes: 11 },
    detailStart: null,
  },
  '2': {
    map: { invoiceNumber: 0, invoiceDate: 1, dueDate: 2, customerName: 3, customerEmail: 4,
           customerAddress: 5, employeeName: 6, workDate: 7, description: 8, quantity: 9,
           unitPrice: 10, taxRate: 12, notes: 13 },
    detailStart: 14,
  },
};
const SHEET_VERSION = '2';
const SHEET_BASE_WIDTH = 14; // columns A–N, before the extra details
const MAX_DETAILS = 10;

/** Rows of the editable "Settings" tab, in order. */
const SETTING_KEYS = ['language', 'outputMode', 'combineEmployees', 'companyName', 'companyAddress', 'companyEmail',
  'currency', 'defaultTaxRate', 'taxName', 'accentColor', 'footer'];

/** Fields the user maps to column letters, shown in groups on the form. */
const FIELDS = [
  { key: 'invoiceNumber',   group: 'Invoice', label: 'Invoice number',   required: true,  hint: 'Rows sharing a number are combined' },
  { key: 'invoiceDate',     group: 'Invoice', label: 'Invoice date',     required: false },
  { key: 'dueDate',         group: 'Invoice', label: 'Due date',         required: false },
  { key: 'customerName',    group: 'Client',  label: 'Client name',      required: true },
  { key: 'customerAddress', group: 'Client',  label: 'Client address',   required: false },
  { key: 'customerEmail',   group: 'Client',  label: 'Client email',     required: false },
  { key: 'employeeName',    group: 'Work',    label: 'Employee name',    required: false, hint: 'Shown as the line item' },
  { key: 'workDate',        group: 'Work',    label: 'Work date',        required: false, hint: 'Date of each day / shift' },
  { key: 'description',     group: 'Work',    label: 'Role / description', required: false },
  { key: 'quantity',        group: 'Work',    label: 'Hours worked',     required: false, hint: 'Blank = 1' },
  { key: 'unitPrice',       group: 'Work',    label: 'Pay rate',         required: true },
  { key: 'taxRate',         group: 'Other',   label: 'Tax rate (%)',     required: false, hint: 'Overrides the default rate' },
  { key: 'notes',           group: 'Other',   label: 'Notes',            required: false },
];

/** Output text for each language. */
const I18N = {
  en: {
    locale: 'en',
    invoice: 'INVOICE',
    invoiceNo: 'Invoice #',
    date: 'Date',
    due: 'Due',
    billTo: 'Bill to',
    description: 'Description',
    qty: 'Hours',
    unitPrice: 'Rate',
    workDate: 'Date',
    period: 'Period',
    labelSep: ': ',
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    amount: 'Amount',
    subtotal: 'Subtotal',
    tax: 'Tax',
    totalDue: 'Total due',
    notes: 'Notes',
    fileInvoice: 'Invoice',
    fileAll: 'All invoices',
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July',
             'August', 'September', 'October', 'November', 'December'],
    formatDate: (y, m, d, months) => months[m - 1] + ' ' + d + ', ' + y,
    email: {
      subjectOne: 'Your invoice PDF is ready',
      subjectMany: n => 'Your ' + n + ' invoice PDFs are ready',
      subjectCombined: n => 'Your invoice PDF is ready (' + n + ' invoices)',
      intro: (n, file) => n + ' invoice' + (n === 1 ? ' was' : 's were') +
        ' created from <strong>' + file + '</strong>.',
      openPdf: 'Open the PDF in Google Drive',
      openZip: 'Download all invoices (ZIP)',
      openFolder: 'Open the Drive folder',
      listTitle: 'Invoices',
      more: n => '…and ' + n + ' more in the Drive folder.',
      reference: 'Reference',
      footer: 'Sent by Invoice PDF Generator.',
      editSheet: 'Edit in Google Sheets',
      rebuildHint: 'Need a small change? Edit the spreadsheet, then',
      rebuildLink: 'rebuild the PDF',
      rebuildManual: 'Need a small change? Edit the spreadsheet in the Drive folder, then paste its link into the web app to rebuild the PDF.',
      updatedPrefix: 'Updated: ',
    },
    sheet: {
      fileName: src => 'Invoices - ' + src + ' (editable)',
      itemsTab: 'Invoices',
      settingsTab: 'Settings',
      headers: ['Invoice #', 'Invoice date', 'Due date', 'Client', 'Client email', 'Client address',
                'Employee', 'Work date', 'Role / description', 'Hours', 'Pay rate', 'Amount', 'Tax rate (%)', 'Notes'],
      note: 'One row per day / entry. Rows with the same invoice number make up one invoice.\n\n' +
        'Invoice details (dates, client, tax rate, notes) are read from the FIRST row of each invoice.\n\n' +
        'Amount is calculated automatically. Write dates as yyyy-mm-dd.\n\n' +
        'Columns O to X are extra details printed under each line item. The header is the label: rename it to ' +
        'change the label, or type a header in an empty column (up to X) to add a detail.\n\n' +
        'After editing, use the "Rebuild PDF" link on the Settings tab.',
      settingHeader: ['Setting', 'Value', 'Help'],
      settings: {
        language: ['Invoice language', 'en = English, fr = French'],
        outputMode: ['PDF output', 'combined = one PDF with every invoice; separate = one PDF per invoice'],
        combineEmployees: ['Combine employee lines', 'yes = one line per employee with the date range; no = one line per row'],
        companyName: ['Business name', ''],
        companyAddress: ['Business address', ''],
        companyEmail: ['Business email', ''],
        currency: ['Currency symbol', 'e.g. $, €, £'],
        defaultTaxRate: ['Default tax rate (%)', 'Used for invoices with no tax rate on the Invoices tab'],
        taxName: ['Tax name', 'Optional, e.g. GST or TPS + TVQ'],
        accentColor: ['Accent color', 'Hex color, e.g. #1f4e79'],
        footer: ['Footer / payment terms', ''],
      },
      rebuild: 'Rebuild PDF after editing',
      rebuildLabel: 'Rebuild PDF',
      rebuildManual: 'Open the Invoice PDF Generator web app and paste this spreadsheet\'s link to rebuild the PDF.',
      folder: 'Drive folder',
      folderLabel: 'Open folder',
    },
  },
  fr: {
    locale: 'fr',
    invoice: 'FACTURE',
    invoiceNo: 'N° de facture',
    date: 'Date',
    due: 'Échéance',
    billTo: 'Facturer à',
    description: 'Description',
    qty: 'Heures',
    unitPrice: 'Taux',
    workDate: 'Date',
    period: 'Période',
    labelSep: '\u00A0: ',
    monthsShort: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
    amount: 'Montant',
    subtotal: 'Sous-total',
    tax: 'Taxes',
    totalDue: 'Total à payer',
    notes: 'Remarques',
    fileInvoice: 'Facture',
    fileAll: 'Toutes les factures',
    months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
             'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    formatDate: (y, m, d, months) => (d === 1 ? '1er' : d) + ' ' + months[m - 1] + ' ' + y,
    email: {
      subjectOne: 'Votre facture PDF est prête',
      subjectMany: n => 'Vos ' + n + ' factures PDF sont prêtes',
      subjectCombined: n => 'Votre PDF de factures est prêt (' + n + ' factures)',
      intro: (n, file) => n + ' facture' + (n === 1 ? ' a été créée' : 's ont été créées') +
        ' à partir de <strong>' + file + '</strong>.',
      openPdf: 'Ouvrir le PDF dans Google Drive',
      openZip: 'Télécharger toutes les factures (ZIP)',
      openFolder: 'Ouvrir le dossier Drive',
      listTitle: 'Factures',
      more: n => '…et ' + n + ' autre' + (n === 1 ? '' : 's') + ' dans le dossier Drive.',
      reference: 'Référence',
      footer: 'Envoyé par Invoice PDF Generator.',
      editSheet: 'Modifier dans Google Sheets',
      rebuildHint: 'Une petite correction ? Modifiez la feuille de calcul, puis',
      rebuildLink: 'régénérez le PDF',
      rebuildManual: 'Une petite correction ? Modifiez la feuille de calcul dans le dossier Drive, puis collez son lien dans l\'application Web pour régénérer le PDF.',
      updatedPrefix: 'Mise à jour : ',
    },
    sheet: {
      fileName: src => 'Factures - ' + src + ' (modifiable)',
      itemsTab: 'Factures',
      settingsTab: 'Paramètres',
      headers: ['N° de facture', 'Date de facture', 'Échéance', 'Client', 'Courriel du client', 'Adresse du client',
                'Employé', 'Date de travail', 'Poste / description', 'Heures', 'Taux', 'Montant', 'Taux de taxe (%)', 'Remarques'],
      note: 'Une ligne par jour / entrée. Les lignes ayant le même numéro de facture forment une seule facture.\n\n' +
        'Les détails de la facture (dates, client, taux de taxe, remarques) sont lus sur la PREMIÈRE ligne de chaque facture.\n\n' +
        'Le montant est calculé automatiquement. Écrivez les dates au format aaaa-mm-jj.\n\n' +
        'Les colonnes O à X sont des détails supplémentaires imprimés sous chaque article. L\'en-tête sert d\'étiquette : ' +
        'renommez-le pour changer l\'étiquette, ou tapez un en-tête dans une colonne vide (jusqu\'à X) pour ajouter un détail.\n\n' +
        'Après vos modifications, utilisez le lien « Régénérer le PDF » dans l\'onglet Paramètres.',
      settingHeader: ['Paramètre', 'Valeur', 'Aide'],
      settings: {
        language: ['Langue de la facture', 'en = anglais, fr = français'],
        outputMode: ['Sortie PDF', 'combined = un seul PDF avec toutes les factures; separate = un PDF par facture'],
        combineEmployees: ['Regrouper par employé', 'yes = une ligne par employé avec la période; no = une ligne par rangée'],
        companyName: ['Nom de l\'entreprise', ''],
        companyAddress: ['Adresse de l\'entreprise', ''],
        companyEmail: ['Courriel de l\'entreprise', ''],
        currency: ['Symbole monétaire', 'p. ex. $, €, £'],
        defaultTaxRate: ['Taux de taxe par défaut (%)', 'Utilisé pour les factures sans taux dans l\'onglet Factures'],
        taxName: ['Nom de la taxe', 'Facultatif, p. ex. TPS + TVQ'],
        accentColor: ['Couleur d\'accent', 'Couleur hexadécimale, p. ex. #1f4e79'],
        footer: ['Pied de page / modalités de paiement', ''],
      },
      rebuild: 'Régénérer le PDF après modification',
      rebuildLabel: 'Régénérer le PDF',
      rebuildManual: 'Ouvrez l\'application Web Invoice PDF Generator et collez le lien de cette feuille pour régénérer le PDF.',
      folder: 'Dossier Drive',
      folderLabel: 'Ouvrir le dossier',
    },
  },
};

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/** Serves the form. "?rebuild=<spreadsheetId>" opens the page in rebuild mode. */
function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  const id = String((e && e.parameter && e.parameter.rebuild) || '');
  t.rebuildId = /^[A-Za-z0-9_-]{20,100}$/.test(id) ? id : '';
  return t.evaluate()
    .setTitle('Invoice PDF Generator')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called on page load: field definitions, the user's email and last-used settings. */
function getConfig() {
  const saved = PropertiesService.getUserProperties().getProperty(settingsKey_());
  return {
    fields: FIELDS,
    userEmail: currentUserEmail_(),
    saved: saved ? JSON.parse(saved) : null,
  };
}

/** Returns the first few rows of the uploaded file so users can pick columns. */
function previewFile(file) {
  const rows = readRows_(file, 'preview-' + newJobId_()).rows;
  const width = Math.min(
    MAX_PREVIEW_COLS,
    rows.reduce((w, r) => Math.max(w, r.length), 0)
  );
  const columns = [];
  for (let i = 0; i < width; i++) columns.push(indexToCol_(i));
  return {
    columns: columns,
    rows: rows.slice(0, MAX_PREVIEW_ROWS).map(r => columns.map((_, i) => r[i] == null ? '' : String(r[i]))),
    totalRows: rows.length,
  };
}

/**
 * Main action. request = {
 *   file:    { name, base64 },
 *   mapping: { invoiceNumber: 'A', ... },
 *   options: { hasHeader, numberFormat, language, outputMode, recipient,
 *              companyName, companyAddress, companyEmail, currency,
 *              defaultTaxRate, taxName, accentColor, footer }
 * }
 * Everything the job needs is in the request, so separate submissions
 * (from different users or from the same user in two tabs) never share data.
 */
function generateInvoices(request) {
  request = request || {};
  const jobId = newJobId_();
  const mapping = normalizeMapping_(request.mapping || {});
  const opts = normalizeOptions_(request.options || {});
  const L = I18N[opts.language];
  if (!request.file || !request.file.base64) throw new Error('Please choose a CSV or XLSX file first.');
  saveSettings_(request.mapping, request.options);

  const data = readRows_(request.file, jobId);
  let rows = data.rows;
  const headerRow = opts.hasHeader ? (rows[0] || []) : [];
  if (opts.hasHeader) rows = rows.slice(1);
  opts.decimalComma = opts.numberFormat === 'auto' ? data.decimalComma : opts.numberFormat === 'comma';
  // Extra-detail labels: what the user typed, else the column's header, else "Detail n".
  mapping.details.forEach((d, n) => {
    d.label = d.label || String(headerRow[d.index] == null ? '' : headerRow[d.index]).trim() ||
      (opts.language === 'fr' ? 'Détail ' : 'Detail ') + (n + 1);
  });

  const grouped = groupInvoices_(rows, mapping, opts);
  if (!grouped.invoices.length) {
    throw new Error('No invoices could be built from this file. Check your column letters' +
      (grouped.skipped.length ? ' — first problem: row ' + grouped.skipped[0].row + ': ' + grouped.skipped[0].reason : '.'));
  }

  const sourceName = String(request.file.name || 'upload');
  const folder = createJobFolder_(sourceName, jobId);
  let ss, built;
  try {
    // 1) Write the editable spreadsheet, 2) build the PDFs *from* it, so the two always match.
    ss = createInvoiceSpreadsheet_(folder, grouped, opts, L, jobId, sourceName);
    built = renderFromSpreadsheet_(ss);
  } catch (e) {
    folder.setTrashed(true); // don't leave half-finished jobs behind
    throw e;
  }

  const warnings = [];
  shareWithRecipient_(folder, opts.recipient, warnings);
  let emailedTo = null;
  try {
    sendResultEmail_(opts.recipient, built, ss, false);
    emailedTo = opts.recipient;
  } catch (e) {
    warnings.push('The files were created, but the email could not be sent: ' + e.message);
  }
  return jobResponse_(built, ss, grouped.skipped.concat(built.skipped), emailedTo, warnings, false);
}

/**
 * Rebuilds the PDFs from an edited invoice spreadsheet, without re-uploading.
 * request = { sheet: spreadsheet URL or ID, notify: true to email the updated links }
 * Existing PDFs are overwritten in place, so links that were already shared keep working.
 */
function rebuildFromSpreadsheet(request) {
  request = request || {};
  const id = extractSpreadsheetId_(request.sheet);
  if (!id) throw new Error('Please paste the link to the invoice spreadsheet.');
  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    throw new Error('Could not open that spreadsheet. Check the link, and make sure you have edit access to it.');
  }
  if (!readMeta_(ss)) {
    throw new Error('That spreadsheet was not created by Invoice PDF Generator, so it cannot be rebuilt.');
  }

  claimSpreadsheet_(ss); // stops two people (or tabs) rebuilding the same spreadsheet at once
  let built;
  try {
    built = renderFromSpreadsheet_(ss);
  } finally {
    releaseSpreadsheet_(ss);
  }

  const warnings = [];
  let emailedTo = null;
  if (request.notify) {
    const me = currentUserEmail_();
    try {
      if (!me) throw new Error('your email address is not available');
      sendResultEmail_(me, built, ss, true);
      emailedTo = me;
    } catch (e) {
      warnings.push('The PDF was rebuilt, but the email could not be sent: ' + e.message);
    }
  }
  return jobResponse_(built, ss, built.skipped, emailedTo, warnings, true);
}

function jobResponse_(built, ss, skipped, emailedTo, warnings, rebuilt) {
  return {
    rebuilt: rebuilt,
    jobId: built.meta.jobId,
    folderName: built.folder.getName(),
    folderUrl: built.folder.getUrl(),
    sheetUrl: ss.getUrl(),
    rebuildUrl: rebuildUrl_(ss.getId()),
    zipUrl: built.output.zipUrl,
    combinedUrl: built.output.combinedUrl,
    invoices: built.output.invoices,
    skipped: skipped,
    emailedTo: emailedTo,
    warnings: warnings,
  };
}

// ---------------------------------------------------------------------------
// Editable spreadsheet
// ---------------------------------------------------------------------------

/**
 * Creates the editable Google Sheet (Invoices + Settings tabs) inside the job folder.
 * The Invoices tab keeps one row per source row (e.g. per day worked), so single
 * days can be corrected; combining by employee happens when the PDF is built.
 */
function createInvoiceSpreadsheet_(folder, grouped, opts, L, jobId, sourceName) {
  const S = L.sheet;
  const invoices = grouped.invoices;
  const labels = grouped.detailLabels || [];
  const width = SHEET_BASE_WIDTH + labels.length;
  const ss = SpreadsheetApp.create(S.fileName(safeName_(sourceName.replace(/\.[^.]+$/, ''))));
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  if (opts.language === 'fr') {
    try { ss.setSpreadsheetLocale('fr_CA'); } catch (e) { /* keep the default locale */ }
  }

  // ---- Invoices tab: one row per entry. Invoice details only on each invoice's first row.
  const items = ss.getSheets()[0].setName(S.itemsTab);
  const rows = [];
  invoices.forEach(inv => {
    const rate = parseNumber_(inv.taxRate, opts.decimalComma);
    inv.items.forEach((it, j) => {
      const first = j === 0;
      rows.push([
        cellText_(inv.number),
        first ? cellText_(inv.invoiceDate) : '',
        first ? cellText_(inv.dueDate) : '',
        first ? cellText_(inv.customerName) : '',
        first ? cellText_(inv.customerEmail) : '',
        first ? cellText_(inv.customerAddress) : '',
        cellText_(it.employee),
        cellText_(it.workDate),
        cellText_(it.description),
        it.quantity,
        it.unitPrice,
        '',                                   // Amount: filled by the ARRAYFORMULA below
        first && !isNaN(rate) ? rate : '',
        first ? cellText_(inv.notes) : '',
      ].concat(it.details.map(cellText_)));
    });
  });
  // Text format keeps invoice numbers like "00123" and dates exactly as written.
  items.getRange('A2:I').setNumberFormat('@');
  items.getRange('N2:X').setNumberFormat('@');
  items.getRange('K2:L').setNumberFormat('#,##0.00');
  items.getRange(1, 1, 1, width).setValues([S.headers.concat(labels.map(cellText_))])
    .setFontWeight('bold').setBackground(opts.accentColor).setFontColor('#ffffff');
  items.getRange(2, 1, rows.length, width).setValues(rows);
  items.getRange('L2').setFormula('=ARRAYFORMULA(IF(K2:K="","",IF(J2:J="",1,J2:J)*K2:K))');
  items.getRange('L1').setBackground('#6b7280'); // grey = calculated column, don't type here
  items.getRange('A1').setNote(S.note);
  items.setFrozenRows(1);
  [110, 110, 110, 180, 190, 220, 170, 100, 170, 70, 90, 100, 110, 200].forEach((w, i) => items.setColumnWidth(i + 1, w));
  for (let c = SHEET_BASE_WIDTH + 1; c <= SHEET_BASE_WIDTH + MAX_DETAILS; c++) items.setColumnWidth(c, 150);
  items.getRange('F2:F').setWrap(true);
  items.getRange('N2:N').setWrap(true);

  // ---- Settings tab: key (hidden column A), label, value, help.
  const settings = ss.insertSheet(S.settingsTab);
  const values = {
    language: opts.language,
    outputMode: opts.outputMode,
    combineEmployees: opts.combineEmployees ? 'yes' : 'no',
    companyName: opts.companyName,
    companyAddress: opts.companyAddress,
    companyEmail: opts.companyEmail,
    currency: opts.currency,
    defaultTaxRate: opts.defaultTaxRate,
    taxName: opts.taxName,
    accentColor: opts.accentColor,
    footer: opts.footer,
  };
  const taxRow = SETTING_KEYS.indexOf('defaultTaxRate') + 2;
  settings.getRange(2, 3, SETTING_KEYS.length, 1).setNumberFormat('@');
  settings.getRange(taxRow, 3).setNumberFormat('0.00##');
  const defaultRate = parseNumber_(opts.defaultTaxRate);
  settings.getRange(1, 1, SETTING_KEYS.length + 1, 4).setValues(
    [['key'].concat(S.settingHeader)].concat(SETTING_KEYS.map(k => [
      k, S.settings[k][0],
      k === 'defaultTaxRate' ? (isNaN(defaultRate) ? '' : defaultRate) : cellText_(values[k]),
      S.settings[k][1],
    ])));
  settings.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground(opts.accentColor).setFontColor('#ffffff');
  const pick = (key, list) => settings.getRange(SETTING_KEYS.indexOf(key) + 2, 3)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build());
  pick('language', ['en', 'fr']);
  pick('outputMode', ['combined', 'separate']);
  pick('combineEmployees', ['yes', 'no']);
  settings.getRange(2, 3, SETTING_KEYS.length, 1).setWrap(true).setBackground('#fffbe6');

  const linkRow = SETTING_KEYS.length + 3;
  const url = rebuildUrl_(ss.getId());
  settings.getRange(linkRow, 2, 2, 1).setValues([[S.rebuild], [S.folder]]).setFontWeight('bold');
  if (url) settings.getRange(linkRow, 3).setFormula(hyperlink_(url, S.rebuildLabel));
  else settings.getRange(linkRow, 3).setValue(S.rebuildManual);
  settings.getRange(linkRow + 1, 3).setFormula(hyperlink_(folder.getUrl(), S.folderLabel));
  settings.setColumnWidth(2, 220).setColumnWidth(3, 320).setColumnWidth(4, 380);
  settings.hideColumns(1);
  settings.setFrozenRows(1);

  writeMeta_(ss, {
    version: SHEET_VERSION,
    jobId: jobId,
    sourceName: sourceName,
    folderId: folder.getId(),
    itemsSheetId: items.getSheetId(),
    settingsSheetId: settings.getSheetId(),
    created: new Date().toISOString(),
    lastBuilt: '',
    busyUntil: '',
    files: {},
  });
  SpreadsheetApp.flush();
  return ss;
}

/** Reads the spreadsheet, rebuilds the PDFs in the job folder, and records the file IDs. */
function renderFromSpreadsheet_(ss) {
  const meta = readMeta_(ss);
  const items = sheetById_(ss, meta.itemsSheetId) || ss.getSheets()[0];
  const settingsSheet = sheetById_(ss, meta.settingsSheetId) || ss.getSheets()[1];
  if (!items || !settingsSheet) throw new Error('The spreadsheet is missing its Invoices or Settings tab.');

  const raw = {};
  settingsSheet.getDataRange().getValues().forEach(r => {
    if (SETTING_KEYS.indexOf(String(r[0])) !== -1) raw[r[0]] = r[2];
  });
  const opts = normalizeLayoutOptions_(raw);
  opts.hasHeader = true;
  opts.decimalComma = opts.language === 'fr'; // only matters for numbers typed as text
  const L = I18N[opts.language];

  const layout = SHEET_LAYOUTS[String(meta.version)] || SHEET_LAYOUTS['1'];
  const all = sheetToRows_(items.getDataRange(), ss.getSpreadsheetTimeZone());
  const header = all[0] || [];
  // Extra details = columns O–X that have a header; the header is the label.
  const details = [];
  if (layout.detailStart != null) {
    for (let c = layout.detailStart; c < layout.detailStart + MAX_DETAILS; c++) {
      const label = String(header[c] == null ? '' : header[c]).trim();
      if (label) details.push({ index: c, label: label });
    }
  }
  opts.dateFormat = 'auto'; // the sheet stores yyyy-mm-dd; anything typed differently is guessed
  const grouped = groupInvoices_(all.slice(1), Object.assign({}, layout.map, { details: details }), opts);
  if (!grouped.invoices.length) {
    throw new Error('No invoices were found in the spreadsheet' +
      (grouped.skipped.length ? ' — first problem: row ' + grouped.skipped[0].row + ': ' + grouped.skipped[0].reason : '.'));
  }

  let folder;
  try {
    folder = DriveApp.getFolderById(meta.folderId);
  } catch (e) {
    throw new Error('The Drive folder for this spreadsheet no longer exists or you do not have access to it.');
  }
  const output = writePdfs_(grouped.invoices, opts, L, folder, meta);
  meta.lastBuilt = new Date().toISOString();
  writeMeta_(ss, meta);
  return { output: output, skipped: grouped.skipped, opts: opts, L: L, meta: meta, folder: folder };
}

// ---------------------------------------------------------------------------
// PDF output
// ---------------------------------------------------------------------------

/**
 * Builds the PDFs. Files recorded in meta.files from an earlier build are
 * overwritten in place (same file, same link, Drive keeps the old version);
 * files that are no longer needed (a deleted invoice, a switched output mode)
 * are moved to the trash.
 */
function writePdfs_(invoices, opts, L, folder, meta) {
  const prev = meta.files || {};
  const prevPer = prev.perInvoice || {};
  const next = { perInvoice: {} };
  let output;

  if (opts.outputMode === 'combined') {
    const name = (invoices.length === 1
      ? L.fileInvoice + ' ' + safeName_(invoices[0].number)
      : L.fileAll + ' - ' + safeName_(String(meta.sourceName || 'invoices').replace(/\.[^.]+$/, ''))) + '.pdf';
    const html = wrapHtml_(invoices.map(inv => invoiceBodyHtml_(inv, opts, L)), opts);
    const file = putFile_(folder, prev.combinedId, htmlToPdf_(html, name));
    next.combinedId = file.getId();
    const url = file.getUrl();
    output = { invoices: invoices.map(inv => invoiceSummary_(inv, opts, url)), zipUrl: null, combinedUrl: url };
    Object.keys(prevPer).forEach(k => trashFile_(prevPer[k]));
    trashFile_(prev.zipId);
  } else {
    const blobs = [];
    const results = invoices.map(inv => {
      const base = L.fileInvoice + ' ' + safeName_(inv.number) +
        (inv.customerName ? ' - ' + safeName_(inv.customerName) : '');
      const pdf = htmlToPdf_(wrapHtml_([invoiceBodyHtml_(inv, opts, L)], opts), uniqueName_(base, blobs) + '.pdf');
      const file = putFile_(folder, prevPer[inv.number], pdf);
      next.perInvoice[inv.number] = file.getId();
      blobs.push(pdf);
      return invoiceSummary_(inv, opts, file.getUrl());
    });
    Object.keys(prevPer).forEach(k => { if (!(k in next.perInvoice)) trashFile_(prevPer[k]); });
    let zipUrl = null;
    if (blobs.length > 1) {
      const zip = putFile_(folder, prev.zipId, Utilities.zip(blobs, L.fileAll + '.zip'));
      next.zipId = zip.getId();
      zipUrl = zip.getUrl();
    } else {
      trashFile_(prev.zipId);
    }
    trashFile_(prev.combinedId);
    output = { invoices: results, zipUrl: zipUrl, combinedUrl: invoices.length === 1 ? results[0].url : null };
  }

  meta.files = next;
  return output;
}

/** Overwrites an existing Drive file (keeping its ID and link) or creates a new one. */
function putFile_(folder, existingId, blob) {
  if (existingId) {
    let file = null;
    try {
      file = DriveApp.getFileById(existingId);
      if (file.isTrashed()) file = null;
    } catch (e) {
      file = null; // deleted: create a new one below
    }
    if (file) {
      Drive.Files.update({ name: blob.getName(), mimeType: blob.getContentType() }, existingId, blob);
      return file;
    }
  }
  return folder.createFile(blob);
}

function trashFile_(id) {
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* already gone */ }
}

function htmlToPdf_(html, name) {
  return Utilities.newBlob(html, MimeType.HTML, 'invoice.html').getAs(MimeType.PDF).setName(name);
}

function invoiceSummary_(inv, opts, url) {
  return {
    number: inv.number,
    customer: inv.customerName,
    total: formatMoney_(inv.total, opts.currency, opts.language),
    url: url,
  };
}

// ---------------------------------------------------------------------------
// Email + sharing
// ---------------------------------------------------------------------------

function sendResultEmail_(to, built, ss, updated) {
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new Error('the daily email limit has been reached. Use the links on this page instead.');
  }
  const opts = built.opts, E = built.L.email, output = built.output, folder = built.folder;
  const sourceName = String(built.meta.sourceName || '');
  const n = output.invoices.length;
  const button = (url, text) =>
    '<a href="' + esc_(url) + '" style="display:inline-block;background:' + opts.accentColor +
    ';color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;margin:4px 8px 4px 0">' +
    esc_(text) + '</a>';

  let subject, buttons = '', list = '';
  if (output.combinedUrl) {
    subject = n === 1 ? E.subjectOne : E.subjectCombined(n);
    buttons = button(output.combinedUrl, E.openPdf);
  } else {
    subject = E.subjectMany(n);
    if (output.zipUrl) buttons = button(output.zipUrl, E.openZip);
    const shown = output.invoices.slice(0, MAX_EMAIL_LINKS);
    list = '<p style="margin:20px 0 6px;font-weight:bold">' + esc_(E.listTitle) + '</p><ul style="padding-left:18px;margin:0">' +
      shown.map(inv => '<li style="margin:3px 0"><a href="' + esc_(inv.url) + '">' + esc_(inv.number) + '</a>' +
        (inv.customer ? ' — ' + esc_(inv.customer) : '') + ' — ' + esc_(inv.total) + '</li>').join('') +
      '</ul>' +
      (n > shown.length ? '<p style="color:#666">' + esc_(E.more(n - shown.length)) + '</p>' : '');
  }
  if (updated) subject = E.updatedPrefix + subject;
  buttons += button(ss.getUrl(), E.editSheet) + button(folder.getUrl(), E.openFolder);

  const rebuildUrl = rebuildUrl_(ss.getId());
  const rebuildHtml = rebuildUrl
    ? esc_(E.rebuildHint) + ' <a href="' + esc_(rebuildUrl) + '">' + esc_(E.rebuildLink) + '</a>.'
    : esc_(E.rebuildManual);

  const htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:600px">' +
      '<p>' + E.intro(n, esc_(sourceName)) + '</p>' +
      '<p>' + buttons + '</p>' +
      list +
      '<p style="margin-top:20px">' + rebuildHtml + '</p>' +
      '<p style="color:#888;font-size:12px;margin-top:24px">' + esc_(E.reference) + ': ' + esc_(built.meta.jobId) +
        ' · ' + esc_(E.footer) + '</p>' +
    '</div>';

  const plainLinks = (output.combinedUrl ? [E.openPdf + ': ' + output.combinedUrl] : output.invoices.map(i => i.number + ': ' + i.url))
    .concat([E.editSheet + ': ' + ss.getUrl(), E.openFolder + ': ' + folder.getUrl()])
    .concat(rebuildUrl ? [E.rebuildHint + ' ' + E.rebuildLink + ': ' + rebuildUrl] : [E.rebuildManual]);

  MailApp.sendEmail({
    to: to,
    subject: subject,
    htmlBody: htmlBody,
    body: E.intro(n, sourceName).replace(/<[^>]+>/g, '') + '\n\n' + plainLinks.join('\n'),
    name: opts.companyName || 'Invoice PDF Generator',
  });
}

/** If the email goes to someone other than the signed-in user, let them open the files. */
function shareWithRecipient_(folder, recipient, warnings) {
  const me = currentUserEmail_().toLowerCase();
  if (!recipient || recipient.toLowerCase() === me) return;
  try {
    folder.addViewer(recipient);
  } catch (e) {
    warnings.push('Could not share the Drive folder with ' + recipient +
      ' (' + e.message + '). They may need to request access to open the link.');
  }
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

/**
 * Reads an uploaded CSV or XLSX file.
 * Returns { rows: 2-D array of cell text, decimalComma: best guess at whether
 * numbers in the file use a decimal comma (1 234,56) }.
 */
function readRows_(file, jobId) {
  if (!file || !file.base64) throw new Error('Please choose a CSV or XLSX file first.');
  const name = String(file.name || '').toLowerCase();
  const bytes = Utilities.base64Decode(file.base64);

  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = decodeText_(bytes);
    const delimiter = detectDelimiter_(text);
    // Excel in French (and most European locales) saves ";"-separated CSVs with decimal commas.
    return { rows: Utilities.parseCsv(text, delimiter), decimalComma: delimiter === ';' };
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const mime = name.endsWith('.xls') ? MimeType.MICROSOFT_EXCEL_LEGACY : MimeType.MICROSOFT_EXCEL;
    // Convert to a temporary Google Sheet (named with this job's ID), read it, then trash it.
    const temp = Drive.Files.create(
      { name: '[temp import ' + jobId + '] ' + file.name, mimeType: MimeType.GOOGLE_SHEETS },
      Utilities.newBlob(bytes, mime, file.name)
    );
    try {
      const ss = SpreadsheetApp.openById(temp.id);
      return { rows: sheetToRows_(ss.getSheets()[0].getDataRange(), ss.getSpreadsheetTimeZone()), decimalComma: false };
    } finally {
      DriveApp.getFileById(temp.id).setTrashed(true);
    }
  }

  throw new Error('Unsupported file type. Please upload a .csv or .xlsx file.');
}

/**
 * Cell values of a Google Sheet range. Dates become yyyy-MM-dd (so they can be
 * shown in the chosen language); numbers stay numbers (so the sheet's locale
 * can't confuse parsing), except percentages, which keep their "%" text.
 */
function sheetToRows_(range, tz) {
  const values = range.getValues();
  const display = range.getDisplayValues();
  return values.map((row, r) => row.map((v, c) => {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (typeof v === 'number') return display[r][c].indexOf('%') === -1 ? v : display[r][c];
    return v;
  }));
}

/** UTF-8, falling back to Windows-1252 (common for CSVs saved by Excel with accents). */
function decodeText_(bytes) {
  let text = Utilities.newBlob(bytes).getDataAsString('UTF-8');
  if (text.indexOf('�') !== -1) text = Utilities.newBlob(bytes).getDataAsString('windows-1252');
  return text.replace(/^﻿/, '');
}

/** Picks , ; or tab based on the first line. French Excel saves CSVs with ";". */
function detectDelimiter_(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length && i < 10000; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  return Object.keys(counts).reduce((best, d) => counts[d] > counts[best] ? d : best, ',');
}

// ---------------------------------------------------------------------------
// Validation, mapping + grouping
// ---------------------------------------------------------------------------

/**
 * Validates column letters and converts them to zero-based indexes.
 * raw.details is a list of up to 10 { col, label } extra-detail columns.
 */
function normalizeMapping_(raw) {
  const mapping = {};
  const errors = [];
  const toIndex = (letters, label) => {
    if (!/^[A-Z]{1,3}$/.test(letters)) { errors.push(label + ': "' + letters + '" is not a valid column letter.'); return null; }
    return colToIndex_(letters);
  };
  FIELDS.forEach(f => {
    const letters = String(raw[f.key] || '').trim().toUpperCase();
    if (!letters) {
      if (f.required) errors.push(f.label + ' is required.');
      mapping[f.key] = null;
    } else {
      mapping[f.key] = toIndex(letters, f.label);
    }
  });
  if (mapping.employeeName == null && mapping.description == null && !errors.length) {
    errors.push('Enter a column for Employee name or Role / description (or both).');
  }
  mapping.details = [];
  (Array.isArray(raw.details) ? raw.details : []).slice(0, MAX_DETAILS).forEach((d, n) => {
    const letters = String((d && d.col) || '').trim().toUpperCase();
    if (!letters) return;
    const index = toIndex(letters, 'Extra detail ' + (n + 1));
    if (index != null) mapping.details.push({ index: index, label: String(d.label || '').trim().slice(0, 60) });
  });
  if (errors.length) throw new Error(errors.join(' '));
  return mapping;
}

/** Cleans up the options and fills in defaults. Never trusts the client. */
function normalizeOptions_(o) {
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const recipient = str(o.recipient, 254) || currentUserEmail_();
  if (!recipient) throw new Error('Please enter the email address that should receive the link.');
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(recipient)) {
    throw new Error('"' + recipient + '" is not a valid email address.');
  }
  return Object.assign(normalizeLayoutOptions_(o), {
    hasHeader: !!o.hasHeader,
    numberFormat: ['dot', 'comma'].indexOf(o.numberFormat) !== -1 ? o.numberFormat : 'auto',
    dateFormat: ['dmy', 'mdy'].indexOf(o.dateFormat) !== -1 ? o.dateFormat : 'auto',
    recipient: recipient,
  });
}

/** Options that control how invoices look. Shared by the web form and the spreadsheet's Settings tab. */
function normalizeLayoutOptions_(o) {
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const color = str(o.accentColor, 7).replace(/^([0-9a-f]{6})$/i, '#$1');
  return {
    language: str(o.language, 5).toLowerCase() === 'fr' ? 'fr' : 'en',
    outputMode: str(o.outputMode, 20).toLowerCase() === 'combined' ? 'combined' : 'separate',
    combineEmployees: o.combineEmployees === true || /^(yes|oui|true|1|y|o)$/i.test(str(o.combineEmployees, 5)),
    companyName: str(o.companyName, 200),
    companyEmail: str(o.companyEmail, 200),
    companyAddress: str(o.companyAddress, 1000),
    currency: o.currency == null ? '$' : str(o.currency, 5),
    defaultTaxRate: str(o.defaultTaxRate, 20),
    taxName: str(o.taxName, 40),
    accentColor: /^#[0-9a-f]{6}$/i.test(color) ? color : '#1f4e79',
    footer: str(o.footer, 2000),
  };
}

/**
 * Groups rows into invoices. Each row becomes one raw item (kept as-is for the
 * editable spreadsheet); inv.lines are the line items printed on the PDF,
 * optionally combined per employee (see buildLines_).
 */
function groupInvoices_(rows, m, opts) {
  const byNumber = {};
  const order = [];
  const skipped = [];
  const headerOffset = opts.hasHeader ? 2 : 1; // for human-readable row numbers
  const details = m.details || [];
  const labels = details.map(d => d.label);
  const dateOrder = resolveDateOrder_(rows, m, opts);
  let current = null;

  const raw = (row, key) => {
    const idx = m[key];
    return idx == null || row[idx] == null ? '' : row[idx];
  };
  const get = (row, key) => String(raw(row, key)).trim();
  const blank = v => v == null || String(v).trim() === '';

  rows.forEach((row, i) => {
    const rowNum = i + headerOffset;
    if (row.every(blank)) return; // blank line

    let number = get(row, 'invoiceNumber');
    if (!number) {
      if (!current) { skipped.push({ row: rowNum, reason: 'Missing invoice number' }); return; }
      number = current.number;
    }

    let inv = byNumber[number];
    if (!inv) {
      inv = byNumber[number] = { number: number, items: [], detailLabels: labels };
      order.push(inv);
    }
    // Fill invoice-level fields from the first row that has them.
    ['invoiceDate', 'dueDate', 'customerName', 'customerEmail', 'customerAddress', 'taxRate', 'notes']
      .forEach(k => {
        if (!blank(inv[k])) return;
        if (k === 'taxRate') inv[k] = raw(row, k);
        else if (k === 'invoiceDate' || k === 'dueDate') inv[k] = normalizeDate_(get(row, k), dateOrder);
        else inv[k] = get(row, k);
      });
    current = inv;

    const employee = get(row, 'employeeName');
    const desc = get(row, 'description');
    const qtyRaw = get(row, 'quantity');
    const priceRaw = get(row, 'unitPrice');
    if (!employee && !desc && !qtyRaw && !priceRaw) return; // invoice-details-only row

    const qty = qtyRaw === '' ? 1 : parseNumber_(raw(row, 'quantity'), opts.decimalComma);
    const price = parseNumber_(raw(row, 'unitPrice'), opts.decimalComma);
    if (isNaN(qty)) { skipped.push({ row: rowNum, reason: 'Hours "' + qtyRaw + '" is not a number' }); return; }
    if (isNaN(price)) { skipped.push({ row: rowNum, reason: 'Pay rate "' + priceRaw + '" is not a number' }); return; }

    inv.items.push({
      employee: employee,
      workDate: normalizeDate_(get(row, 'workDate'), dateOrder),
      description: desc,
      quantity: qty,
      unitPrice: price,
      amount: round2_(qty * price),
      details: details.map(d => String(row[d.index] == null ? '' : row[d.index]).trim()),
    });
  });

  const defaultRate = parseNumber_(opts.defaultTaxRate); // from the form's number box: always "8.25" style
  const invoices = [];
  order.forEach(inv => {
    if (!inv.items.length) {
      skipped.push({ row: '—', reason: 'Invoice ' + inv.number + ' has no line items' });
      return;
    }
    inv.lines = buildLines_(inv.items, !!opts.combineEmployees);
    const rowRate = parseNumber_(inv.taxRate, opts.decimalComma);
    inv.taxRatePct = !isNaN(rowRate) ? rowRate : (!isNaN(defaultRate) ? defaultRate : 0);
    inv.subtotal = round2_(inv.lines.reduce((s, ln) => s + ln.amount, 0));
    inv.tax = round2_(inv.subtotal * inv.taxRatePct / 100);
    inv.total = round2_(inv.subtotal + inv.tax);
    invoices.push(inv);
  });

  return { invoices: invoices, skipped: skipped, detailLabels: labels };
}

/**
 * Turns raw items into PDF line items. When combining, rows with the same
 * employee, role/description and rate become one line: hours are added up,
 * the work dates become a range, and differing detail values are listed
 * (e.g. "Location: Studio A, Studio B"). A different rate or role for the
 * same employee (e.g. overtime) stays on its own line.
 */
function buildLines_(items, combine) {
  if (!combine) {
    return items.map(it => ({
      employee: it.employee, description: it.description, quantity: it.quantity,
      unitPrice: it.unitPrice, amount: it.amount,
      dates: it.workDate ? [it.workDate] : [],
      details: it.details.map(v => v ? [v] : []),
    }));
  }
  const byKey = {};
  const lines = [];
  items.forEach(it => {
    const key = [it.employee.toLowerCase(), it.description.toLowerCase(), it.unitPrice].join('\u0001');
    let ln = byKey[key];
    if (!ln) {
      ln = byKey[key] = { employee: it.employee, description: it.description, quantity: 0,
        unitPrice: it.unitPrice, dates: [], details: it.details.map(() => []) };
      lines.push(ln);
    }
    ln.quantity += it.quantity;
    if (it.workDate) ln.dates.push(it.workDate);
    it.details.forEach((v, i) => { if (v && ln.details[i].indexOf(v) === -1) ln.details[i].push(v); });
  });
  lines.forEach(ln => {
    ln.quantity = Math.round(ln.quantity * 1000) / 1000;
    ln.amount = round2_(ln.quantity * ln.unitPrice);
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Day/month order for dates like 03/11/2026. "auto" looks for a value that
 * settles it (a first number above 12 means day-first); if none does, it
 * guesses day-first for French-style files and month-first otherwise.
 */
function resolveDateOrder_(rows, m, opts) {
  if (opts.dateFormat === 'dmy' || opts.dateFormat === 'mdy') return opts.dateFormat;
  const cols = ['invoiceDate', 'dueDate', 'workDate'].map(k => m[k]).filter(i => i != null);
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      const v = String(rows[r][cols[c]] == null ? '' : rows[r][cols[c]]).trim();
      const x = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-]\d{2,4}$/);
      if (!x) continue;
      if (+x[1] > 12) return 'dmy';
      if (+x[2] > 12) return 'mdy';
    }
  }
  return opts.decimalComma || opts.language === 'fr' ? 'dmy' : 'mdy';
}

/** Converts 2026-11-03, 03/11/2026, 11-3-26 … to yyyy-mm-dd. Anything else is returned unchanged. */
function normalizeDate_(value, order) {
  const t = String(value == null ? '' : value).trim();
  if (!t) return '';
  const iso = (y, mo, d) => {
    if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
    return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
  };
  let x = t.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:[T ].*)?$/);
  if (x) return iso(+x[1], +x[2], +x[3]) || t;
  x = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/);
  if (x) {
    const y = x[3].length === 2 ? 2000 + +x[3] : +x[3];
    return (order === 'dmy' ? iso(y, +x[2], +x[1]) : iso(y, +x[1], +x[2])) || t;
  }
  return t;
}

/** Short date: "Nov 3, 2026" / "3 nov. 2026". */
function formatShortDate_(isoDate, L, withYear) {
  const p = isoDate.split('-').map(Number);
  const mon = L.monthsShort[p[1] - 1];
  if (L.locale === 'fr') return (p[2] === 1 ? '1er' : p[2]) + ' ' + mon + (withYear === false ? '' : ' ' + p[0]);
  return mon + ' ' + p[2] + (withYear === false ? '' : ', ' + p[0]);
}

/**
 * The date or date range for a line: "Nov 3, 2026", "Nov 3–7, 2026",
 * "Nov 28 – Dec 2, 2026" (fr: "3–7 nov. 2026"). Dates that couldn't be read
 * are listed as written.
 */
function formatDateSpan_(dates, L) {
  const isoDates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!isoDates.length) {
    return dates.filter((d, i) => dates.indexOf(d) === i).join(', ');
  }
  const a = isoDates[0], b = isoDates[isoDates.length - 1];
  if (a === b) return formatShortDate_(a, L);
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  if (ya === yb && ma === mb) {
    return L.locale === 'fr'
      ? (da === 1 ? '1er' : da) + '–' + db + ' ' + L.monthsShort[mb - 1] + ' ' + yb
      : L.monthsShort[ma - 1] + ' ' + da + '–' + db + ', ' + ya;
  }
  if (ya === yb) return formatShortDate_(a, L, false) + ' – ' + formatShortDate_(b, L);
  return formatShortDate_(a, L) + ' – ' + formatShortDate_(b, L);
}

// ---------------------------------------------------------------------------
// PDF HTML template
// ---------------------------------------------------------------------------

/** Wraps one or more invoice bodies in a document; each body starts on a new page. */
function wrapHtml_(bodies, opts) {
  const accent = opts.accentColor;
  return '<!DOCTYPE html><html lang="' + opts.language + '"><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#222;font-size:11pt;margin:0;}' +
    'table{border-collapse:collapse;width:100%;}' +
    'td,th{vertical-align:top;}' +
    '.title{font-size:28pt;font-weight:bold;color:' + accent + ';letter-spacing:1px;}' +
    '.company{font-size:13pt;font-weight:bold;}' +
    '.muted{color:#666;font-size:10pt;}' +
    '.label{color:#666;padding:2px 12px 2px 0;}' +
    '.num{text-align:right;white-space:nowrap;}' +
    '.section{font-size:9pt;font-weight:bold;color:' + accent + ';text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;}' +
    '.items th{background:' + accent + ';color:#fff;padding:8px;text-align:left;font-size:10pt;}' +
    '.items th.num{text-align:right;}' +
    '.items td{padding:8px;border-bottom:1px solid #e3e3e3;}' +
    '.items tr.alt td{background:#f7f7f7;}' +
    '.totals td{padding:5px 8px;}' +
    '.grand td{font-size:13pt;font-weight:bold;border-top:2px solid ' + accent + ';padding-top:8px;}' +
    '.detail{margin:3px 0 0 14pt;font-size:9pt;color:#555;}' +
    '.date{white-space:nowrap;font-size:10pt;}' +
    '.notes{margin-top:28px;padding:10px 12px;background:#f7f7f7;font-size:10pt;}' +
    '.footer{margin-top:36px;text-align:center;color:#666;font-size:9pt;}' +
    '</style></head><body>' +
    bodies.map((b, i) => i === 0 ? '<div>' + b + '</div>' : '<div style="page-break-before:always">' + b + '</div>').join('') +
    '</body></html>';
}

function invoiceBodyHtml_(inv, opts, L) {
  const cur = opts.currency;
  const lang = opts.language;
  const nl2br = s => esc_(s).replace(/\r?\n/g, '<br>');
  const money = n => esc_(formatMoney_(n, cur, lang));

  const lines = inv.lines || [];
  const labels = inv.detailLabels || [];
  const hasDates = lines.some(ln => ln.dates.length);
  const itemRows = lines.map((ln, i) => {
    // Employee in bold, then role/description; extra details indented underneath.
    const title = ln.employee
      ? '<strong>' + esc_(ln.employee) + '</strong>' + (ln.description ? ' — ' + nl2br(ln.description) : '')
      : nl2br(ln.description);
    const details = labels.map((label, d) => ln.details[d] && ln.details[d].length
      ? '<div class="detail">' + esc_(label) + esc_(L.labelSep) + nl2br(ln.details[d].join(', ')) + '</div>'
      : '').join('');
    return '<tr class="' + (i % 2 ? 'alt' : '') + '">' +
      '<td>' + title + details + '</td>' +
      (hasDates ? '<td class="date">' + esc_(formatDateSpan_(ln.dates, L)) + '</td>' : '') +
      '<td class="num">' + formatQty_(ln.quantity, lang) + '</td>' +
      '<td class="num">' + money(ln.unitPrice) + '</td>' +
      '<td class="num">' + money(ln.amount) + '</td>' +
    '</tr>';
  }).join('');
  const dateHeader = opts.combineEmployees ? L.period : L.workDate;

  const meta = [
    [L.invoiceNo, inv.number],
    [L.date, formatDate_(inv.invoiceDate, L)],
    [L.due, formatDate_(inv.dueDate, L)],
  ].filter(p => p[1])
    .map(p => '<tr><td class="label">' + esc_(p[0]) + '</td><td class="num">' + esc_(p[1]) + '</td></tr>')
    .join('');

  const taxName = opts.taxName || L.tax;

  return '' +
    // Header: company on the left, INVOICE/FACTURE + meta on the right
    '<table><tr>' +
      '<td style="width:55%">' +
        (opts.companyName ? '<div class="company">' + esc_(opts.companyName) + '</div>' : '') +
        (opts.companyAddress ? '<div class="muted">' + nl2br(opts.companyAddress) + '</div>' : '') +
        (opts.companyEmail ? '<div class="muted">' + esc_(opts.companyEmail) + '</div>' : '') +
      '</td>' +
      '<td style="width:45%;text-align:right">' +
        '<div class="title">' + esc_(L.invoice) + '</div>' +
        '<table style="width:auto;margin-left:auto;margin-top:6px">' + meta + '</table>' +
      '</td>' +
    '</tr></table>' +

    // Bill to
    '<div style="margin-top:28px">' +
      '<div class="section">' + esc_(L.billTo) + '</div>' +
      '<div style="font-weight:bold">' + esc_(inv.customerName || '') + '</div>' +
      (inv.customerAddress ? '<div class="muted">' + nl2br(inv.customerAddress) + '</div>' : '') +
      (inv.customerEmail ? '<div class="muted">' + esc_(inv.customerEmail) + '</div>' : '') +
    '</div>' +

    // Line items
    '<table class="items" style="margin-top:24px">' +
      '<tr><th style="width:' + (hasDates ? '44' : '55') + '%">' + esc_(L.description) + '</th>' +
      (hasDates ? '<th>' + esc_(dateHeader) + '</th>' : '') +
      '<th class="num">' + esc_(L.qty) + '</th>' +
      '<th class="num">' + esc_(L.unitPrice) + '</th><th class="num">' + esc_(L.amount) + '</th></tr>' +
      itemRows +
    '</table>' +

    // Totals
    '<table style="margin-top:12px"><tr><td style="width:55%"></td><td>' +
      '<table class="totals">' +
        '<tr><td>' + esc_(L.subtotal) + '</td><td class="num">' + money(inv.subtotal) + '</td></tr>' +
        (inv.taxRatePct ? '<tr><td>' + esc_(taxName) + ' (' + formatQty_(inv.taxRatePct, lang) +
          (lang === 'fr' ? ' %' : '%') + ')</td><td class="num">' +
          money(inv.tax) + '</td></tr>' : '') +
        '<tr class="grand"><td>' + esc_(L.totalDue) + '</td><td class="num">' + money(inv.total) + '</td></tr>' +
      '</table>' +
    '</td></tr></table>' +

    (inv.notes ? '<div class="notes"><div class="section">' + esc_(L.notes) + '</div>' + nl2br(inv.notes) + '</div>' : '') +
    (opts.footer ? '<div class="footer">' + nl2br(opts.footer) + '</div>' : '');
}

// ---------------------------------------------------------------------------
// Drive folders + per-user settings
// ---------------------------------------------------------------------------

/**
 * Root "Invoice PDFs" folder. Its ID is cached in user properties. The lock
 * stops two simultaneous first-time submissions from creating two folders.
 */
function getRootFolder_() {
  const props = PropertiesService.getUserProperties();
  const cached = () => {
    const id = props.getProperty(ROOT_FOLDER_KEY);
    if (!id) return null;
    try {
      const f = DriveApp.getFolderById(id);
      return f.isTrashed() ? null : f;
    } catch (e) {
      return null; // deleted or no longer accessible
    }
  };

  let folder = cached();
  if (folder) return folder;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    folder = cached(); // another run may have created it while we waited
    if (folder) return folder;
    const existing = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
    folder = existing.hasNext() ? existing.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
    props.setProperty(ROOT_FOLDER_KEY, folder.getId());
    return folder;
  } finally {
    lock.releaseLock();
  }
}

/** A new folder per submission. The job ID makes the name unique even within the same second. */
function createJobFolder_(sourceName, jobId) {
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm-ss');
  return getRootFolder_().createFolder(
    stamp + ' - ' + safeName_(String(sourceName || 'upload').replace(/\.[^.]+$/, '')) + ' (' + jobId + ')');
}

function saveSettings_(mapping, options) {
  const o = Object.assign({}, options || {});
  PropertiesService.getUserProperties()
    .setProperty(settingsKey_(), JSON.stringify({ mapping: mapping || {}, options: o }));
}

/**
 * Settings are keyed by the signed-in user's email. With "Execute as: user
 * accessing" user properties are already per user; the key also keeps users
 * apart if someone deploys the app as "Execute as: me".
 */
function settingsKey_() {
  const email = currentUserEmail_().toLowerCase();
  return email ? 'settings:' + email : 'settings';
}

function currentUserEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

// ---- Spreadsheet metadata (hidden "_meta" tab) and rebuild locking ----

function readMeta_(ss) {
  const sh = ss.getSheetByName(META_SHEET);
  if (!sh) return null;
  const meta = {};
  sh.getDataRange().getValues().forEach(r => { if (r[0] !== '') meta[r[0]] = r[1]; });
  if (!meta.folderId) return null;
  try { meta.files = meta.files ? JSON.parse(meta.files) : {}; } catch (e) { meta.files = {}; }
  return meta;
}

function writeMeta_(ss, meta) {
  let sh = ss.getSheetByName(META_SHEET);
  if (!sh) {
    sh = ss.insertSheet(META_SHEET);
    sh.getRange('A1').setNote('Used by Invoice PDF Generator to find this job\'s files. Please do not edit.');
    sh.protect().setWarningOnly(true);
    sh.hideSheet();
  }
  const rows = Object.keys(meta).map(k =>
    [k, k === 'files' ? JSON.stringify(meta[k] || {}) : String(meta[k] == null ? '' : meta[k])]);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, 2).setNumberFormat('@').setValues(rows);
}

/**
 * Marks the spreadsheet as "being rebuilt". The script lock is held only for
 * this quick check-and-set, so other users' jobs are never blocked by a long rebuild.
 */
function claimSpreadsheet_(ss) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const meta = readMeta_(ss);
    if (Number(meta.busyUntil) > Date.now()) {
      throw new Error('This spreadsheet is already being rebuilt (in another tab or by another person). Please try again in a minute.');
    }
    meta.busyUntil = Date.now() + REBUILD_TIMEOUT_MS;
    writeMeta_(ss, meta);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function releaseSpreadsheet_(ss) {
  try {
    const meta = readMeta_(ss);
    meta.busyUntil = '';
    writeMeta_(ss, meta);
    SpreadsheetApp.flush();
  } catch (e) { /* the marker expires on its own */ }
}

function sheetById_(ss, id) {
  if (id === '' || id == null) return null;
  return ss.getSheets().filter(sh => String(sh.getSheetId()) === String(id))[0] || null;
}

/** Accepts a Google Sheets URL or a bare spreadsheet ID. */
function extractSpreadsheetId_(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/d\/([A-Za-z0-9_-]{20,})/) || s.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : '';
}

/** Web app link that opens the page in rebuild mode for this spreadsheet. */
function rebuildUrl_(spreadsheetId) {
  let base = '';
  try { base = ScriptApp.getService().getUrl() || ''; } catch (e) { base = ''; }
  return base ? base + '?rebuild=' + encodeURIComponent(spreadsheetId) : '';
}

function hyperlink_(url, label) {
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  return '=HYPERLINK(' + q(url) + ',' + q(label) + ')';
}

/** Text for a spreadsheet cell. A leading ' stops values like "=..." or "+1 call" being read as formulas. */
function cellText_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function newJobId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "A" -> 0, "Z" -> 25, "AA" -> 26 */
function colToIndex_(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/** 0 -> "A", 26 -> "AA" */
function indexToCol_(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/**
 * Parses English and French number styles: "$1,234.50", "1 234,50 $",
 * "1.234,50 €", "12%", "(5.00)", "-5". Returns NaN when empty/invalid.
 *
 * When a value has both "," and ".", whichever comes last is the decimal
 * separator. When it has only one kind, decimalComma decides: true reads
 * "14,975" as 14.975 (French), false reads it as 14975 (English).
 */
function parseNumber_(v, decimalComma) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[\s\u00A0\u202F']/g, '');     // spaces (incl. French no-break spaces) and 1'234 style
  if (/^[^\d.,]*-/.test(s)) negative = !negative; // leading minus, e.g. "-$5" or "$-5"
  s = s.replace(/[^0-9.,]/g, '');              // drop currency symbols, %, letters
  if (!s || !/\d/.test(s)) return NaN;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimal;
  if (lastComma !== -1 && lastDot !== -1) decimal = lastComma > lastDot ? ',' : '.';
  else if (lastComma !== -1) decimal = decimalComma ? ',' : (s.split(',').length > 2 ? null : (/,\d{3}$/.test(s) ? null : ','));
  else if (lastDot !== -1) decimal = decimalComma && /\.\d{3}$/.test(s) ? null : (s.split('.').length > 2 ? null : '.');
  else decimal = null;

  // Remove thousands separators, then normalise the decimal separator to ".".
  if (decimal === ',') s = s.replace(/\./g, '').replace(',', '.');
  else if (decimal === '.') s = s.replace(/,/g, '');
  else s = s.replace(/[.,]/g, '');
  if (s.indexOf(',') !== -1 || !/^\d*\.?\d*$/.test(s) || s === '.') return NaN;
  const n = parseFloat(s);
  return negative ? -n : n;
}

function round2_(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/** en: $1,234.50   fr: 1 234,50 $ */
function formatMoney_(n, symbol, lang) {
  const sign = n < 0 ? '-' : '';
  const parts = Math.abs(round2_(n)).toFixed(2).split('.');
  const sym = symbol == null ? '$' : String(symbol);
  if (lang === 'fr') {
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return sign + intPart + ',' + parts[1] + (sym ? ' ' + sym : '');
  }
  return sign + sym + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
}

function formatQty_(n, lang) {
  const s = String(Math.round(n * 1000) / 1000);
  return lang === 'fr' ? s.replace('.', ',') : s;
}

/** Formats yyyy-mm-dd dates in the chosen language; anything else is shown as written. */
function formatDate_(value, L) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (!m) return s;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return s;
  return L.formatDate(y, mo, d, L.months);
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeName_(s) {
  return String(s).replace(/[\\/:*?"<>|#]+/g, '-').trim().slice(0, 80) || 'untitled';
}

/** Avoids duplicate file names inside the ZIP. */
function uniqueName_(base, existingBlobs) {
  const taken = {};
  existingBlobs.forEach(b => { taken[b.getName()] = true; });
  let name = base, i = 2;
  while (taken[name + '.pdf']) name = base + ' (' + i++ + ')';
  return name;
}
