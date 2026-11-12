/**
 * Invoice PDF Generator — Google Apps Script web app (version 3).
 *
 * Users upload a CSV or Excel export (single-line records from a database), tell
 * the app which column letter holds each field, choose English or French, and
 * the app creates a Drive folder containing:
 *   - the invoice PDF(s),
 *   - an editable Google Sheet of the same invoices (the PDFs are always built
 *     from it, and a "Rebuild PDF" link regenerates them in place after edits),
 *   - an untouched copy of the uploaded file.
 * A link to the folder is emailed to the person who submitted the form.
 *
 * Developer settings (logo, company details, government numbers, footer, accent
 * colour, tax admins) live in Config.gs. See README → "Developer setup".
 *
 * Multi-user safety:
 *  - Deploy with "Execute as: User accessing the web app". Each user's files,
 *    emails, presets and quotas are then their own.
 *  - The server keeps no shared state per job. Every submission gets its own job
 *    ID and Drive folder, and all of its data travels in the request.
 *  - Shared state is limited to the tax rates (script properties, admin-only
 *    writes under a lock) and the root folder (created under a lock).
 */

const ROOT_FOLDER_NAME = 'Invoice PDFs';
const ROOT_FOLDER_KEY = 'rootFolderId';
const MAX_PREVIEW_ROWS = 6;
const MAX_PREVIEW_COLS = 702; // the preview shows columns A–ZZ (a safety cap; later columns can still be mapped by letter)
const MAX_EMAIL_LINKS = 50;
const META_SHEET = '_meta';
const REBUILD_TIMEOUT_MS = 7 * 60 * 1000; // a run can't last longer than 6 minutes
const MAX_DETAILS = 10;
const MAX_PRESETS = 30;
const MAX_PRESET_NAME = 60;
const MAX_PRESET_BYTES = 8500; // a UserProperties value can hold about 9 KB
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const DEFAULT_ACCENT = '#1f4e79';
const ORIGINAL_PREFIX = 'Original data - ';

// ---------------------------------------------------------------------------
// Form fields and the editable sheet layout
// ---------------------------------------------------------------------------

/** Fields the user maps to column letters, shown in groups on the form. */
const FIELDS = [
  { key: 'invoiceNumber', group: 'Invoice', label: 'Invoice number', required: true, hint: 'Rows sharing a number form one invoice' },
  { key: 'clientNumber',  group: 'Invoice', label: 'Client number' },
  { key: 'invoiceDate',   group: 'Invoice', label: 'Invoice date' },
  { key: 'dueDate',       group: 'Invoice', label: 'Payment due date' },
  { key: 'customerName',  group: 'Client',  label: 'Client name', required: true },
  { key: 'attention',     group: 'Client',  label: 'Attention (ATTN)' },
  { key: 'address1',      group: 'Client',  label: 'Address 1' },
  { key: 'address2',      group: 'Client',  label: 'Address 2' },
  { key: 'address3',      group: 'Client',  label: 'Address 3' },
  { key: 'address4',      group: 'Client',  label: 'Address 4' },
  { key: 'city',          group: 'Client',  label: 'City' },
  { key: 'province',      group: 'Client',  label: 'State / Province' },
  { key: 'postalCode',    group: 'Client',  label: 'Postal code' },
  { key: 'country',       group: 'Client',  label: 'Country' },
  { key: 'candidate',     group: 'Work',    label: 'Candidate / Role', hint: 'Shown in the first column' },
  { key: 'workOrder',     group: 'Work',    label: 'Work order' },
  { key: 'purchaseOrder', group: 'Work',    label: 'Purchase order' },
  { key: 'workDate',      group: 'Work',    label: 'Work date', hint: 'Period column' },
  { key: 'lineType',      group: 'Work',    label: 'Line type', required: true, hint: 'e.g. Regular, Overtime' },
  { key: 'units',         group: 'Work',    label: 'Units', hint: 'Blank or invalid = 0' },
  { key: 'unitPrice',     group: 'Work',    label: 'Rate', required: true, hint: 'Blank or invalid = 0' },
  { key: 'taxCode',       group: 'Other',   label: 'Tax code', hint: 'Blank or unknown = EXEMPT' },
];

/** Invoice-level fields (besides the address) taken from the first row of each invoice that has them. */
const INVOICE_FIELDS = ['clientNumber', 'invoiceDate', 'dueDate', 'customerName', 'attention'];
/** Address parts, always taken together from one row. */
const ADDRESS_KEYS = ['address1', 'address2', 'address3', 'address4', 'city', 'province', 'postalCode', 'country'];

/** Editable sheet, version 3: column (0-based) of each field on the Invoices tab. */
const SHEET_VERSION = '3';
const SHEET_MAP = {
  invoiceNumber: 0, clientNumber: 1, invoiceDate: 2, dueDate: 3, customerName: 4, attention: 5,
  address1: 6, address2: 7, address3: 8, address4: 9, city: 10, province: 11, postalCode: 12, country: 13,
  candidate: 14, workOrder: 15, purchaseOrder: 16, workDate: 17, lineType: 18, units: 19, unitPrice: 20,
  taxCode: 22,
};
const SHEET_AMOUNT_COL = 21;   // V
const SHEET_GROUP_COL = 23;    // X
const SHEET_DETAIL_START = 24; // Y
const SHEET_BASE_WIDTH = 24;   // A–X, before the extra details

/** Rows of the editable "Settings" tab, in order. */
const SETTING_KEYS = ['language', 'outputMode', 'combineEmployees'];

// ---------------------------------------------------------------------------
// Taxes
// ---------------------------------------------------------------------------

/** The editable rates (percent), stored once and shared by all users. QST = GST + PST. */
const TAX_RATE_KEYS = ['GST', 'HST', 'NSHST', 'ONHST', 'PEI', 'PST'];
const DEFAULT_TAX_RATES = { GST: 5, HST: 15, NSHST: 14, ONHST: 13, PEI: 15, PST: 9.975 };
const TAX_RATES_PROP = 'taxRates';

/**
 * Tax codes accepted in the data. `parts` are the tax lines printed under the
 * subtotal (each one a key of the rates above). PST is a rate, not a code.
 */
const TAX_CODES = {
  EXEMPT: { parts: [], aliases: ['EXEMPT'] },
  GST:    { parts: ['GST'], aliases: ['GST', 'TPS'] },
  HST:    { parts: ['HST'], aliases: ['HST', 'TVH'] },
  NSHST:  { parts: ['NSHST'], aliases: ['NSHST', 'NETVH'] },
  ONHST:  { parts: ['ONHST'], aliases: ['ONHST', 'ONTVH'] },
  PEI:    { parts: ['PEI'], aliases: ['PEI', 'IPE'] },
  QST:    { parts: ['GST', 'PST'], aliases: ['QST'] },
};
const TAX_CODE_ORDER = ['EXEMPT', 'GST', 'HST', 'NSHST', 'ONHST', 'PEI', 'QST'];

// ---------------------------------------------------------------------------
// Page layout (points, Letter portrait). Estimates used to split invoices into
// pages; tune after checking real PDFs from Google's converter.
// ---------------------------------------------------------------------------
// Calibrated against Chrome's rendering of the samples (measured: plain line 17.4pt,
// line with 2 details 37.7pt, column headings 19pt, group heading 17.5pt, condensed
// header 54pt, footer ~96pt), plus a safety margin for Google's converter.
const PAGE = {
  HEIGHT: 680,            // height of each page block (Letter is 792pt; the rest is margin)
  NUMBER_ROW: 16,         // "Page X of Y" row at the top
  COL_HEADER: 21,         // column heading row of the body table
  GROUP_ROW: 19,          // a group heading row
  LINE_PAD: 8,            // padding of a line row
  TEXT_LINE: 10.5,        // one line of 8.5pt text
  DETAIL_LINE: 10,        // one extra-detail line (7.5pt)
  CONDENSED_HEADER: 58,   // header on pages 2+
  GAP_HEADER_BODY: 24,    // space between the invoice header and the body
  GAP_BODY_SUMMARY: 28,   // space between the body and the units summary / totals
  GAP_SUMMARY_FOOTER: 30, // minimum space between the units summary / totals and the footer
  SAFETY: 14,             // spare room on every page
};

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const I18N = {
  en: {
    locale: 'en',
    headerLabels: ['Invoice #', 'Client #', 'Invoice Date', 'Payment Due Date'],
    attn: 'ATTN:',
    confidential: 'PRIVATE & CONFIDENTIAL',
    columns: ['Candidate', 'Work Order', 'Purchase Order', 'Period', 'Type', 'Unit(s)', 'Rate', 'Amount'],
    summaryTitle: 'Units summary',
    summaryCols: ['Type', 'Unit(s)'],
    other: 'Other',
    subtotal: 'Subtotal',
    total: 'Total (CAD)',
    taxes: { EXEMPT: 'EXEMPT', GST: 'GST', PST: 'PST', HST: 'HST', NSHST: 'NSHST', ONHST: 'ONHST', PEI: 'PEI' },
    taxCodes: ['EXEMPT', 'GST', 'HST', 'NSHST', 'ONHST', 'PEI', 'QST'],
    gov: [['gstHst', 'HST/GST # '], ['qst', 'QST # ']],
    phonePrefix: 'T. ',
    footerLabels: { paymentTitle: 'EFT Payment', bankId: 'Bank ID', transit: 'Bank Transit', account: 'Account #' },
    unitsTotal: 'Total',
    continued: '(continued)',
    page: (n, of) => 'Page ' + n + ' of ' + of,
    noLabel: '(no label)',
    fileInvoice: 'Invoice',
    fileAll: 'All invoices',
    email: {
      subjectOne: 'Your invoice PDF is ready',
      subjectMany: n => 'Your ' + n + ' invoice PDFs are ready',
      subjectCombined: n => 'Your invoice PDF is ready (' + n + ' invoices)',
      intro: (n, file) => n + ' invoice' + (n === 1 ? ' was' : 's were') + ' created from <strong>' + file + '</strong>.',
      openPdf: 'Open the PDF in Google Drive',
      openZip: 'Download all invoices (ZIP)',
      openFolder: 'Open the Drive folder',
      originalData: 'Original data file',
      listTitle: 'Invoices',
      more: n => '…and ' + n + ' more in the Drive folder.',
      reference: 'Reference',
      footer: 'Sent by Invoice PDF Generator.',
      editSheet: 'Edit in Google Sheets',
      rebuildHint: 'Need a small change? Edit the spreadsheet, then',
      rebuildLink: 'rebuild the PDF',
      rebuildManual: 'Need a small change? Edit the spreadsheet in the Drive folder, then paste its link into the web app to rebuild the PDF.',
      updatedPrefix: 'Updated: ',
      noReply: 'This is an automated message. Please don\'t reply.',
    },
    sheet: {
      fileName: src => 'Invoices - ' + src + ' (editable)',
      itemsTab: 'Invoices',
      settingsTab: 'Settings',
      headers: ['Invoice #', 'Client #', 'Invoice date', 'Payment due date', 'Client', 'ATTN',
                'Address 1', 'Address 2', 'Address 3', 'Address 4', 'City', 'State / Province', 'Postal code', 'Country',
                'Candidate / Role', 'Work order', 'Purchase order', 'Work date', 'Line type', 'Units', 'Rate', 'Amount', 'Tax code'],
      note: 'One row per record. Rows with the same invoice number make up one invoice.\n\n' +
        'Invoice details (client #, dates, client, ATTN, address, tax code) are read from the FIRST row of each invoice ' +
        'that has them. The address (columns G–N) is always taken from one row.\n\n' +
        'Amount is calculated automatically. Units or Rate that are blank or not numbers count as 0. Write dates as yyyy-mm-dd.\n\n' +
        'Column X groups line items under a heading: its header is the heading label (leave it blank for no groups).\n\n' +
        'Columns Y to AH are extra details printed under each line item. The header is the label: rename it to change the ' +
        'label, or type a header in an empty column (up to AH) to add a detail.\n\n' +
        'A header of "(no label)" keeps the group or detail but prints only its value, with no label.\n\n' +
        'After editing, use the "Rebuild PDF" link on the Settings tab.',
      settingHeader: ['Setting', 'Value', 'Help'],
      settings: {
        language: ['Invoice language', 'en = English, fr = French'],
        outputMode: ['PDF output', 'combined = one PDF with every invoice; separate = one PDF per invoice'],
        combineEmployees: ['Combine employee lines', 'yes = one line per candidate with the date range; no = one line per row'],
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
    headerLabels: ['N° de facture', 'N° de client', 'Date de facturation', 'Paiement dû au plus tard'],
    attn: 'ATTN:',
    confidential: 'PRIVÉ ET CONFIDENTIEL',
    columns: ['Candidat', 'Référence', 'Bon de commande', 'Période', 'Type', 'Unité(s)', 'Taux', 'Montant'],
    summaryTitle: 'Sommaire des unités',
    summaryCols: ['Type', 'Unité(s)'],
    other: 'Autre',
    subtotal: 'Sous-total',
    total: 'Total (CAD)',
    taxes: { EXEMPT: 'EXEMPT', GST: 'TPS', PST: 'TVQ', HST: 'TVH', NSHST: 'NETVH', ONHST: 'ONTVH', PEI: 'IPE' },
    taxCodes: ['EXEMPT', 'TPS', 'TVH', 'NETVH', 'ONTVH', 'IPE', 'QST'],
    gov: [['gstHst', 'TVH/TPS # '], ['qst', 'TVQ # '], ['quebecPermit', 'Permis QC ']],
    phonePrefix: 'T. ',
    footerLabels: { paymentTitle: 'Paiement par TEF', bankId: 'N° d\'institution', transit: 'N° de transit', account: 'N° de compte' },
    unitsTotal: 'Total',
    continued: '(suite)',
    page: (n, of) => 'Page ' + n + ' de ' + of,
    noLabel: '(sans étiquette)',
    fileInvoice: 'Facture',
    fileAll: 'Toutes les factures',
    sheet: {
      fileName: src => 'Factures - ' + src + ' (modifiable)',
      itemsTab: 'Factures',
      settingsTab: 'Paramètres',
      headers: ['N° de facture', 'N° de client', 'Date de facturation', 'Paiement dû au plus tard', 'Client', 'ATTN',
                'Adresse 1', 'Adresse 2', 'Adresse 3', 'Adresse 4', 'Ville', 'Province / État', 'Code postal', 'Pays',
                'Candidat / Poste', 'Référence', 'Bon de commande', 'Date de travail', 'Type de ligne', 'Unités', 'Taux', 'Montant', 'Code de taxe'],
      note: 'Une ligne par enregistrement. Les lignes ayant le même numéro de facture forment une seule facture.\n\n' +
        'Les détails de la facture (n° de client, dates, client, ATTN, adresse, code de taxe) sont lus sur la PREMIÈRE ligne ' +
        'de chaque facture qui les contient. L\'adresse (colonnes G à N) est toujours prise sur une seule ligne.\n\n' +
        'Le montant est calculé automatiquement. Des unités ou un taux vides ou non numériques comptent pour 0. ' +
        'Écrivez les dates au format aaaa-mm-jj.\n\n' +
        'La colonne X regroupe les articles sous un titre : son en-tête sert d\'étiquette (laissez-le vide pour ne pas regrouper).\n\n' +
        'Les colonnes Y à AH sont des détails supplémentaires imprimés sous chaque article. L\'en-tête sert d\'étiquette : ' +
        'renommez-le pour changer l\'étiquette, ou tapez un en-tête dans une colonne vide (jusqu\'à AH) pour ajouter un détail.\n\n' +
        'Un en-tête « (sans étiquette) » garde le groupe ou le détail, mais n\'imprime que sa valeur, sans étiquette.\n\n' +
        'Après vos modifications, utilisez le lien « Régénérer le PDF » dans l\'onglet Paramètres.',
      settingHeader: ['Paramètre', 'Valeur', 'Aide'],
      settings: {
        language: ['Langue de la facture', 'en = anglais, fr = français'],
        outputMode: ['Sortie PDF', 'combined = un seul PDF avec toutes les factures; separate = un PDF par facture'],
        combineEmployees: ['Regrouper par candidat', 'yes = une ligne par candidat avec la période; no = une ligne par rangée'],
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

/**
 * Called on page load: field definitions, the user's email, last-used settings,
 * presets (and the full default preset, which fills in the form), tax rates.
 */
function getConfig() {
  const run = newRun_('getConfig');
  log_(run, 'page_open'); // who is accessing the app
  try {
    const props = PropertiesService.getUserProperties();
    const saved = props.getProperty(settingsKey_());
    const state = presetState_(props);
    let parsed = null;
    try { parsed = saved ? sanitizeFormState_(JSON.parse(saved).mapping, JSON.parse(saved).options) : null; } catch (e) { parsed = null; }
    return {
      fields: FIELDS,
      userEmail: run.user,
      saved: parsed,
      presets: state.presets,
      defaultName: state.defaultName,
      defaultPreset: state.defaultName ? readPreset_(props, state.defaultName) : null,
      tax: taxState_(),
      taxCodes: { en: I18N.en.taxCodes, fr: I18N.fr.taxCodes },
    };
  } catch (e) {
    handleRunError_(run, e);
  }
}

/** Returns the first rows of the uploaded file (hidden Excel rows left out) so users can pick columns. */
function previewFile(file) {
  return withRun_('previewFile', run => {
    run.context.file = fileInfo_(file);
    const rows = readRows_(file, 'preview-' + run.id).rows;
    const totalColumns = rows.reduce((w, r) => Math.max(w, r.length), 0);
    const width = Math.min(MAX_PREVIEW_COLS, totalColumns);
    const columns = [];
    for (let i = 0; i < width; i++) columns.push(indexToCol_(i));
    const first = rows[0] || [];
    const header = [];
    for (let i = 0; i < totalColumns; i++) header.push(first[i] == null ? '' : String(first[i]).trim());
    return {
      columns: columns,
      rows: rows.slice(0, MAX_PREVIEW_ROWS).map(r => columns.map((_, i) => r[i] == null ? '' : String(r[i]))),
      header: header, // the whole first row, every column (used to fill in labels, even past the preview)
      totalRows: rows.length,
      totalColumns: totalColumns,
    };
  });
}

/**
 * Main action. request = { file: { name, base64 }, mapping: { invoiceNumber: 'A', ..., details, groupBy },
 *   options: { hasHeader, dateFormat, numberFormat, language, outputMode, combineEmployees } }
 * The files and the email always go to the signed-in user; any recipient in the request is ignored.
 * The run id is also the job id (folder name, results page, email, logs).
 */
function generateInvoices(request) {
  return withRun_('generateInvoices', run => {
    request = request || {};
    const recipient = run.user;
    if (!recipient) throw userError_('We couldn\'t confirm your Google account. Reload the page and sign in again.');
    const jobId = run.id;
    run.context.file = fileInfo_(request.file);
    const o = request.options || {};
    log_(run, 'request', { file: run.context.file, language: o.language === 'fr' ? 'fr' : 'en',
      outputMode: o.outputMode === 'combined' ? 'combined' : 'separate' });
    const parsed = parseUpload_(request, jobId, run);
    saveSettings_(request.mapping, request.options);

    const sourceName = String(request.file.name || 'upload');
    const folder = createJobFolder_(sourceName, jobId);
    log_(run, 'folder_created', { folderId: folder.getId() });
    let ss, built;
    try {
      const original = saveOriginal_(folder, request.file);
      log_(run, 'original_saved');
      // 1) Write the editable spreadsheet, 2) build the PDFs *from* it, so the two always match.
      ss = createInvoiceSpreadsheet_(folder, parsed, jobId, sourceName, original.getId());
      log_(run, 'sheet_created', { spreadsheetId: ss.getId() });
      built = renderFromSpreadsheet_(ss, run);
    } catch (e) {
      folder.setTrashed(true); // don't leave half-finished jobs behind
      throw e;
    }

    const warnings = built.warnings.slice();
    let emailedTo = null;
    try {
      sendResultEmail_(recipient, built, ss, false);
      emailedTo = recipient;
      log_(run, 'email_sent');
    } catch (e) {
      warnings.push('The files were created, but the email could not be sent: ' + e.message);
      log_(run, 'email_failed', { message: e.message }, 'warn');
    }
    const result = jobResponse_(built, ss, parsed.grouped.skipped, parsed.notes, emailedTo, warnings, false);
    recordRunMetrics_(run, parsed.grouped.invoices);
    return result;
  });
}

/**
 * Validates the request and reads the uploaded file into invoices.
 * Returns { mapping, opts, grouped, notes }. No Drive files are created here.
 */
function parseUpload_(request, jobId, run) {
  const mapping = normalizeMapping_(request.mapping || {});
  const opts = normalizeOptions_(request.options || {});
  if (!request.file || !request.file.base64) throw userError_('Please choose a CSV or XLSX file first.');

  const data = readRows_(request.file, jobId);
  if (run) log_(run, 'file_read', { rows: data.rows.length, hiddenRows: data.hiddenRows || 0 });
  let rows = data.rows, rowNums = data.rowNumbers;
  if (opts.hasHeader) { rows = rows.slice(1); rowNums = rowNums.slice(1); }
  opts.decimalComma = opts.numberFormat === 'auto' ? data.decimalComma : opts.numberFormat === 'comma';
  opts.taxRates = getTaxRates_().rates;
  // Labels are used exactly as typed on the form. A blank label stays blank: the invoice prints only the value.
  // (The form fills a label box with the column's header, and the user may edit or clear it.)

  const grouped = groupInvoices_(rows, mapping, opts, rowNums);
  if (run) log_(run, 'parsed', { invoices: grouped.invoices.length, skipped: grouped.skipped.length, notes: grouped.notes.length });
  if (!grouped.invoices.length) {
    throw userError_('No invoices could be built from this file. Check your column letters' +
      (grouped.skipped.length ? ' — first problem: row ' + grouped.skipped[0].row + ': ' + grouped.skipped[0].reason : '.'));
  }
  const notes = (data.notes || []).concat(grouped.notes);
  return { mapping: mapping, opts: opts, grouped: grouped, notes: notes };
}

/**
 * Rebuilds the PDFs from an edited invoice spreadsheet, without re-uploading.
 * request = { sheet: spreadsheet URL or ID, notify: true to email the updated links }
 * Existing PDFs are overwritten in place, so links that were already shared keep working.
 * Rebuilds don't produce run metrics.
 */
function rebuildFromSpreadsheet(request) {
  return withRun_('rebuildFromSpreadsheet', run => {
    request = request || {};
    const id = extractSpreadsheetId_(request.sheet);
    if (!id) throw userError_('Please paste the link to the invoice spreadsheet.');
    let ss;
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (e) {
      throw userError_('Could not open that spreadsheet. Check the link, and make sure you have edit access to it.');
    }
    const meta = readMeta_(ss);
    if (!meta) throw userError_('That spreadsheet was not created by Invoice PDF Generator, so it cannot be rebuilt.');
    if (String(meta.version) !== SHEET_VERSION) {
      throw userError_('This spreadsheet was made with an older version of Invoice PDF Generator, so it can\'t be rebuilt. ' +
        'Generate it again from the original file.');
    }
    log_(run, 'opened', { spreadsheetId: id, jobId: meta.jobId });

    claimSpreadsheet_(ss); // stops two people (or tabs) rebuilding the same spreadsheet at once
    log_(run, 'claimed');
    let built;
    try {
      built = renderFromSpreadsheet_(ss, run);
    } finally {
      releaseSpreadsheet_(ss);
    }

    const warnings = built.warnings.slice();
    let emailedTo = null;
    if (request.notify) {
      try {
        if (!run.user) throw userError_('your email address is not available');
        sendResultEmail_(run.user, built, ss, true);
        emailedTo = run.user;
        log_(run, 'email_sent');
      } catch (e) {
        warnings.push('The PDF was rebuilt, but the email could not be sent: ' + e.message);
        log_(run, 'email_failed', { message: e.message }, 'warn');
      }
    }
    return jobResponse_(built, ss, built.skipped, built.notes, emailedTo, warnings, true);
  });
}

function jobResponse_(built, ss, skipped, notes, emailedTo, warnings, rebuilt) {
  let originalUrl = null;
  if (built.meta.originalId) {
    try { originalUrl = DriveApp.getFileById(built.meta.originalId).getUrl(); } catch (e) { originalUrl = null; }
  }
  return {
    rebuilt: rebuilt,
    jobId: built.meta.jobId,
    folderName: built.folder.getName(),
    folderUrl: built.folder.getUrl(),
    sheetUrl: ss.getUrl(),
    rebuildUrl: rebuildUrl_(ss.getId()),
    originalUrl: originalUrl,
    zipUrl: built.output.zipUrl,
    combinedUrl: built.output.combinedUrl,
    invoices: built.output.invoices,
    skipped: skipped,
    notes: notes,
    emailedTo: emailedTo,
    warnings: warnings,
  };
}

/** Saves the uploaded file, byte for byte, in the job folder. */
function saveOriginal_(folder, file) {
  const name = String(file.name || 'upload');
  const lower = name.toLowerCase();
  const mime = lower.endsWith('.xlsx') ? MimeType.MICROSOFT_EXCEL
    : lower.endsWith('.xls') ? MimeType.MICROSOFT_EXCEL_LEGACY
    : MimeType.CSV;
  return folder.createFile(Utilities.newBlob(Utilities.base64Decode(file.base64), mime, ORIGINAL_PREFIX + name));
}

// ---------------------------------------------------------------------------
// Form presets
// ---------------------------------------------------------------------------
//
// A preset is a named snapshot of the form (column letters, extra details,
// grouping and options). Presets are stored in the user's own UserProperties,
// one property per preset, so they are private to each user.
// One preset can be the default: it fills in the form when the page opens.

/** Returns { presets: [{ name, updated, isDefault }], defaultName }. */
function listPresetsImpl_() {
  return presetState_(PropertiesService.getUserProperties());
}

/** Returns one preset { name, mapping, options, headers, updated }, or throws if it doesn't exist. */
function getPresetImpl_(name) {
  const preset = readPreset_(PropertiesService.getUserProperties(), name);
  if (!preset) throw userError_('The preset "' + String(name || '') + '" no longer exists.');
  const form = sanitizeFormState_(preset.mapping, preset.options); // upgrades presets saved by older versions
  return Object.assign({}, preset, form);
}

/**
 * Saves the form as a preset. Saving under an existing name (any capitalisation)
 * replaces that preset. request = { name, mapping, options, headers, makeDefault }
 */
function savePresetImpl_(request) {
  request = request || {};
  const props = PropertiesService.getUserProperties();
  const name = cleanPresetName_(request.name);
  const key = presetKey_(name);
  const existing = readPreset_(props, name);
  if (!existing && presetState_(props).presets.length >= MAX_PRESETS) {
    throw userError_('You already have ' + MAX_PRESETS + ' presets. Delete one before saving a new one.');
  }

  const form = sanitizeFormState_(request.mapping, request.options);
  let headers = sanitizeHeaders_(request.headers, form.mapping);
  // Updating a preset without a file loaded keeps the headers it remembered.
  if (!Object.keys(headers).length && existing && existing.headers) {
    headers = sanitizeHeaders_(existing.headers, form.mapping);
  }
  const preset = { name: name, mapping: form.mapping, options: form.options, headers: headers,
                   updated: new Date().toISOString() };
  const json = JSON.stringify(preset);
  if (Utilities.newBlob(json).getBytes().length > MAX_PRESET_BYTES) {
    throw userError_('This preset is too large to save. Shorten the extra-detail labels and try again.');
  }
  props.setProperty(key, json);
  if (request.makeDefault) props.setProperty(presetDefaultKey_(), key);
  return Object.assign(presetState_(props), { saved: preset, replaced: !!existing });
}

/** Deletes a preset (and clears the default if it was the default). */
function deletePresetImpl_(name) {
  const props = PropertiesService.getUserProperties();
  const key = presetKey_(cleanPresetName_(name));
  props.deleteProperty(key);
  if (props.getProperty(presetDefaultKey_()) === key) props.deleteProperty(presetDefaultKey_());
  return presetState_(props);
}

/** Makes a preset the default (fills in the form on page load). An empty name clears the default. */
function setDefaultPresetImpl_(name) {
  const props = PropertiesService.getUserProperties();
  if (!String(name || '').trim()) {
    props.deleteProperty(presetDefaultKey_());
  } else {
    const clean = cleanPresetName_(name);
    if (!readPreset_(props, clean)) throw userError_('The preset "' + clean + '" no longer exists.');
    props.setProperty(presetDefaultKey_(), presetKey_(clean));
  }
  return presetState_(props);
}

// Functions the page calls (google.script.run). Each one is logged with its own run id;
// unexpected errors are emailed to the developer (see withRun_).
function listPresets() { return withRun_('listPresets', () => listPresetsImpl_()); }
function getPreset(name) { return withRun_('getPreset', () => getPresetImpl_(name)); }
function savePreset(request) { return withRun_('savePreset', () => savePresetImpl_(request)); }
function deletePreset(name) { return withRun_('deletePreset', () => deletePresetImpl_(name)); }
function setDefaultPreset(name) { return withRun_('setDefaultPreset', () => setDefaultPresetImpl_(name)); }
function saveTaxRates(rates) { return withRun_('saveTaxRates', () => saveTaxRatesImpl_(rates)); }
function resetTaxRates() { return withRun_('resetTaxRates', () => resetTaxRatesImpl_()); }

function presetPrefix_() {
  return 'preset:' + currentUserEmail_().toLowerCase() + ':';
}
function presetKey_(name) {
  return presetPrefix_() + encodeURIComponent(String(name).trim().toLowerCase());
}
function presetDefaultKey_() {
  return 'presetDefault:' + currentUserEmail_().toLowerCase();
}

function cleanPresetName_(name) {
  const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!s) throw userError_('Please give the preset a name.');
  if (s.length > MAX_PRESET_NAME) throw userError_('Preset names can be up to ' + MAX_PRESET_NAME + ' characters.');
  return s;
}

function readPreset_(props, name) {
  let key;
  try { key = presetKey_(cleanPresetName_(name)); } catch (e) { return null; }
  const json = props.getProperty(key);
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    return Object.assign({}, p, sanitizeFormState_(p.mapping, p.options));
  } catch (e) { return null; }
}

/** All of the user's presets, sorted by name, plus the default preset's name. */
function presetState_(props) {
  const all = props.getProperties();
  const prefix = presetPrefix_();
  const defaultKey = all[presetDefaultKey_()] || '';
  let defaultName = '';
  const presets = [];
  Object.keys(all).forEach(k => {
    if (k.indexOf(prefix) !== 0) return;
    let p;
    try { p = JSON.parse(all[k]); } catch (e) { return; }
    if (!p || !p.name) return;
    const isDefault = k === defaultKey;
    if (isDefault) defaultName = p.name;
    presets.push({ name: p.name, updated: p.updated || '', isDefault: isDefault });
  });
  presets.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
  return { presets: presets, defaultName: defaultName };
}

/**
 * Keeps only the known form fields, with length limits, in the shape the page
 * sends to generateInvoices(). Used for presets and last-used settings. Values
 * saved by older versions are upgraded (e.g. Employee name → Candidate / Role);
 * removed fields (business details, currency, accent colour, recipient...) are dropped.
 */
function sanitizeFormState_(rawMapping, rawOptions) {
  const m = rawMapping || {}, o = rawOptions || {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const letter = v => { const s = str(v, 3).toUpperCase(); return /^[A-Z]{1,3}$/.test(s) ? s : ''; };
  const oneOf = (v, list, def) => list.indexOf(String(v)) !== -1 ? String(v) : def;

  const mapping = {};
  FIELDS.forEach(f => { mapping[f.key] = letter(m[f.key]); });
  if (!mapping.candidate) mapping.candidate = letter(m.employeeName) || letter(m.description);
  if (!mapping.units) mapping.units = letter(m.quantity);
  if (!mapping.address1) mapping.address1 = letter(m.customerAddress);
  mapping.details = [];
  const details = Array.isArray(m.details) ? m.details : [];
  for (let n = 0; n < MAX_DETAILS; n++) {
    const d = details[n] || {};
    mapping.details.push({ col: letter(d.col), label: str(d.label, 60) });
  }
  const g = m.groupBy || {};
  mapping.groupBy = { col: letter(g.col), label: str(g.label, 60) };

  const options = {
    hasHeader: o.hasHeader == null ? true : !!o.hasHeader,
    combineEmployees: !!o.combineEmployees,
    dateFormat: oneOf(o.dateFormat, ['auto', 'mdy', 'dmy'], 'auto'),
    numberFormat: oneOf(o.numberFormat, ['auto', 'dot', 'comma'], 'auto'),
    language: oneOf(o.language, ['en', 'fr'], 'en'),
    outputMode: oneOf(o.outputMode, ['combined', 'separate'], 'separate'),
  };
  return { mapping: mapping, options: options };
}

/**
 * The header text the preset expects in each mapped column, e.g. { A: 'Invoice #' }.
 * The page compares it with each new upload to catch a file in a different layout.
 */
function sanitizeHeaders_(raw, mapping) {
  const used = {};
  FIELDS.forEach(f => { if (mapping[f.key]) used[mapping[f.key]] = true; });
  mapping.details.forEach(d => { if (d.col) used[d.col] = true; });
  if (mapping.groupBy && mapping.groupBy.col) used[mapping.groupBy.col] = true;
  const out = {};
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach(col => {
      const c = String(col).toUpperCase();
      const text = String(raw[col] == null ? '' : raw[col]).trim().slice(0, 100);
      if (used[c] && text) out[c] = text;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tax rates (shared by all users; only admins can change them)
// ---------------------------------------------------------------------------

/** Current rates (stored rates merged over the defaults), plus who changed them last. */
function getTaxRates_() {
  let stored = null;
  try { stored = JSON.parse(PropertiesService.getScriptProperties().getProperty(TAX_RATES_PROP) || 'null'); } catch (e) { stored = null; }
  const rates = Object.assign({}, DEFAULT_TAX_RATES);
  if (stored && stored.rates) {
    TAX_RATE_KEYS.forEach(k => {
      const v = Number(stored.rates[k]);
      if (stored.rates[k] !== '' && stored.rates[k] != null && isFinite(v) && v >= 0 && v <= 100) rates[k] = v;
    });
  }
  return { rates: rates, updated: (stored && stored.updated) || '', updatedBy: (stored && stored.updatedBy) || '' };
}

/** What the Tax rates card shows. */
function taxState_() {
  const t = getTaxRates_();
  return {
    rates: t.rates,
    defaults: DEFAULT_TAX_RATES,
    updated: t.updated,
    updatedBy: t.updatedBy,
    isAdmin: isTaxAdmin_(),
    rows: TAX_RATE_KEYS.map(k => ({ key: k, en: I18N.en.taxes[k], fr: I18N.fr.taxes[k] })),
  };
}

/** Admin emails from Config.gs (CONFIG.TAX_ADMINS) plus the optional script property TAX_ADMINS. */
function taxAdmins_() {
  const fromConfig = (cfg_().TAX_ADMINS || []).map(String);
  let fromProp = '';
  try { fromProp = PropertiesService.getScriptProperties().getProperty('TAX_ADMINS') || ''; } catch (e) { fromProp = ''; }
  return fromConfig.concat(fromProp.split(/[,;\s]+/))
    .map(s => s.trim().toLowerCase()).filter(s => s.indexOf('@') > 0);
}

function isTaxAdmin_() {
  const me = currentUserEmail_().toLowerCase();
  return !!me && taxAdmins_().indexOf(me) !== -1;
}

function requireTaxAdmin_() {
  if (!isTaxAdmin_()) throw userError_('Tax rates can only be changed by an admin.');
}

/** Saves new rates (admins only). rates = { GST: '5', HST: '15', ... } as percentages. */
function saveTaxRatesImpl_(rates) {
  requireTaxAdmin_();
  const clean = {}, errors = [];
  TAX_RATE_KEYS.forEach(k => {
    const s = String(rates && rates[k] != null ? rates[k] : '').trim();
    if (!/^\d{1,3}(\.\d{1,3})?$/.test(s) || Number(s) > 100) {
      errors.push(k + ': "' + s + '" must be a number from 0 to 100 with up to 3 decimals.');
    } else {
      clean[k] = Number(s);
    }
  });
  if (errors.length) throw userError_(errors.join(' '));
  writeTaxRates_(clean);
  return taxState_();
}

/** Restores the starting rates (admins only). */
function resetTaxRatesImpl_() {
  requireTaxAdmin_();
  writeTaxRates_(Object.assign({}, DEFAULT_TAX_RATES));
  return taxState_();
}

function writeTaxRates_(rates) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    PropertiesService.getScriptProperties().setProperty(TAX_RATES_PROP, JSON.stringify({
      rates: rates, updated: new Date().toISOString(), updatedBy: currentUserEmail_(),
    }));
  } finally {
    lock.releaseLock();
  }
}

/** Accepts English or French codes, any capitalisation, spaces/hyphens ignored. Returns the code key or null. */
function normalizeTaxCode_(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[\s\-_.]/g, '');
  if (!s) return null;
  for (let i = 0; i < TAX_CODE_ORDER.length; i++) {
    if (TAX_CODES[TAX_CODE_ORDER[i]].aliases.indexOf(s) !== -1) return TAX_CODE_ORDER[i];
  }
  return null;
}

/** Tax lines for an invoice: [{ key, ratePct, amount }]. EXEMPT gives one $0.00 line. */
function computeTaxes_(code, subtotal, rates) {
  const def = TAX_CODES[code] || TAX_CODES.EXEMPT;
  if (!def.parts.length) return [{ key: 'EXEMPT', ratePct: null, amount: 0 }];
  return def.parts.map(p => ({ key: p, ratePct: rates[p], amount: round2_(subtotal * rates[p] / 100) }));
}

// ---------------------------------------------------------------------------
// Runs, logs, errors and metrics
// ---------------------------------------------------------------------------
//
// Every call from the page is a "run" with its own id. Each run writes JSON log
// lines (Apps Script → Executions / Cloud Logging): who, when, which function,
// and progress stages. Nothing is shared between runs, so users never interfere.

const APP_NAME = 'invoice-pdf-generator';
const DEV_EMAIL_REPEAT_SECONDS = 600; // the same error from the same user is emailed at most every 10 minutes

function newRun_(fnName, runId) {
  return { id: runId || newJobId_(), fn: fnName, user: currentUserEmail_(), started: Date.now(), stage: 'start', context: {} };
}

/** One structured log line: { app, runId, user, timestamp, function, stage, ...data }. */
function log_(run, stage, data, level) {
  if (stage !== 'error' && stage !== 'user_error') run.stage = stage;
  const entry = Object.assign({
    app: APP_NAME, runId: run.id, user: run.user, timestamp: new Date().toISOString(), function: run.fn, stage: stage,
  }, data || {});
  const line = JSON.stringify(entry);
  try {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } catch (e) { /* logging must never break a run */ }
  return entry;
}

/** An error caused by the user's input or permissions: shown to them, logged, not emailed to the developer. */
function userError_(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

/** Runs fn(run) with start/done logs; logs every error and emails unexpected ones to DEV_EMAIL. */
function withRun_(fnName, fn) {
  const run = newRun_(fnName);
  log_(run, 'start');
  try {
    const out = fn(run);
    log_(run, 'done', { ms: Date.now() - run.started });
    return out;
  } catch (e) {
    handleRunError_(run, e);
  }
}

function handleRunError_(run, e) {
  const message = (e && e.message) || String(e);
  if (e && e.userFacing) {
    log_(run, 'user_error', { message: message, stageReached: run.stage, ms: Date.now() - run.started }, 'warn');
    throw e;
  }
  log_(run, 'error', { message: message, stack: String((e && e.stack) || ''), stageReached: run.stage,
    file: run.context.file || null, ms: Date.now() - run.started }, 'error');
  sendDevErrorEmail_(run, e);
  throw new Error('Something went wrong (reference ' + run.id + '). The developer has been notified. Details: ' + message);
}

function fileInfo_(file) {
  if (!file) return null;
  return { name: String(file.name || ''), sizeBytes: Math.floor(String(file.base64 || '').length * 3 / 4) };
}

/** Emails an unexpected error to DEV_EMAIL (English, from the user's account), at most once per 10 minutes per error. */
function sendDevErrorEmail_(run, e) {
  const to = cleanText_(cfg_().DEV_EMAIL);
  if (!to) return;
  const message = (e && e.message) || String(e);
  try {
    const cache = CacheService.getUserCache();
    const key = 'deverr_' + hash_(run.fn + '|' + message);
    if (cache && cache.get(key)) {
      log_(run, 'dev_email_skipped', { reason: 'same error emailed in the last 10 minutes' });
      return;
    }
    const f = run.context.file;
    const body = [
      'An unexpected error happened in Invoice PDF Generator.',
      '',
      'Run id:        ' + run.id,
      'User:          ' + (run.user || '(unknown)'),
      'Time:          ' + new Date().toISOString(),
      'Function:      ' + run.fn,
      'Stage reached: ' + run.stage,
      'File:          ' + (f ? f.name + ' (' + f.sizeBytes + ' bytes)' : '(none)'),
      '',
      'Error: ' + message,
      '',
      String((e && e.stack) || '(no stack trace)'),
      '',
      'Search the logs (Apps Script → Executions) for runId "' + run.id + '" to see every step of this run.',
    ].join('\n');
    MailApp.sendEmail({
      to: to,
      subject: '[Invoice PDF Generator] Error in ' + run.fn + ' (run ' + run.id + ')',
      body: body,
      name: senderName_(),
    });
    if (cache) cache.put(key, '1', DEV_EMAIL_REPEAT_SECONDS);
    log_(run, 'dev_email_sent', { to: to });
  } catch (err) {
    log_(run, 'dev_email_failed', { message: (err && err.message) || String(err) }, 'warn');
  }
}

/**
 * Run metrics for BigQuery: one row per client per Generate run,
 * [runId, user, clientId, invoiceCount, runTimeMs]. No timestamp (the
 * developer's library adds it). Logged, then handed to sendRunMetrics_ (Config.gs).
 */
function buildRunMetrics_(run, invoices) {
  const runTimeMs = Math.round(Date.now() - run.started);
  const order = [], counts = {};
  invoices.forEach(inv => {
    const id = cleanText_(inv.clientNumber);
    if (!(id in counts)) { counts[id] = 0; order.push(id); }
    counts[id]++;
  });
  return order.map(id => [run.id, run.user, id, counts[id], runTimeMs]);
}

function recordRunMetrics_(run, invoices) {
  try {
    const rows = buildRunMetrics_(run, invoices);
    log_(run, 'run_metrics', { rows: rows });
    if (typeof sendRunMetrics_ === 'function') sendRunMetrics_(rows);
    return rows;
  } catch (e) {
    log_(run, 'metrics_failed', { message: (e && e.message) || String(e) }, 'warn');
    return [];
  }
}

function senderName_() {
  return cleanText_(cfg_().EMAIL_SENDER_NAME) || 'Invoice PDF Generator (no reply)';
}

/** Small, stable string hash for cache keys. */
function hash_(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Developer settings (Config.gs): logo, company block, footer, accent colour
// ---------------------------------------------------------------------------

function cfg_() {
  return typeof CONFIG !== 'undefined' && CONFIG ? CONFIG : {};
}

function accent_() {
  const c = String(cfg_().ACCENT_COLOR || '').trim();
  return /^#[0-9a-f]{6}$/i.test(c) ? c : DEFAULT_ACCENT;
}

/** The accent colour mixed with white, for group heading backgrounds. */
function tint_(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = c => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return '#' + [r, g, b].map(v => ('0' + v.toString(16)).slice(-2)).join('');
}

const cleanText_ = v => String(v == null ? '' : v).trim();
const cleanList_ = a => (Array.isArray(a) ? a : []).map(cleanText_).filter(Boolean);
/** A French value, or the English one when the French one is blank. */
const pickText_ = (fr, en) => cleanText_(fr) || cleanText_(en);

/**
 * Logo, company block, footer and accent colour for one invoice language.
 * The company and bank details are the same in both languages; only the labels
 * (and the two footer sentences) follow the language.
 * Returns { logo, company: { address, phone, gov }, footer, accent, warnings }.
 */
function loadBranding_(lang) {
  const c = cfg_();
  const L = I18N[lang] || I18N.en;
  const co = c.COMPANY || {};
  const nums = c.GOVERNMENT_NUMBERS || {};
  const bank = c.BANK || {};
  const textEn = (c.FOOTER_TEXT && c.FOOTER_TEXT.en) || {};
  const text = lang === 'fr' ? ((c.FOOTER_TEXT && c.FOOTER_TEXT.fr) || {}) : textEn;
  const FL = L.footerLabels;
  const logo = loadLogo_();
  const bankDetails = [['bankId', FL.bankId], ['transit', FL.transit], ['account', FL.account]]
    .map(k => [k[1], cleanText_(bank[k[0]])]).filter(p => p[1]);
  const bankAddress = cleanList_(bank.address);
  return {
    logo: logo.dataUri,
    accent: accent_(),
    company: {
      address: cleanList_(co.address),
      phone: cleanText_(co.phone),
      gov: L.gov.map(g => cleanText_(nums[g[0]]) ? g[1] + cleanText_(nums[g[0]]) : '').filter(Boolean),
    },
    footer: {
      paymentTitle: bankAddress.length || bankDetails.length ? FL.paymentTitle : '',
      bankAddress: bankAddress,
      bankDetails: bankDetails,
      remittance: lang === 'fr' ? pickText_(text.remittance, textEn.remittance) : cleanText_(textEn.remittance),
      disclosure: lang === 'fr' ? pickText_(text.disclosure, textEn.disclosure) : cleanText_(textEn.disclosure),
    },
    footerAtBottom: c.FOOTER_AT_PAGE_BOTTOM !== false,
    warnings: logo.warning ? [logo.warning] : [],
  };
}

/** Reads the PNG logo from Drive once and returns it as a data URI (or a warning). */
function loadLogo_() {
  const id = cleanText_(cfg_().LOGO_DRIVE_FILE_ID);
  if (!id) return { dataUri: '', warning: '' };
  try {
    const blob = DriveApp.getFileById(id).getBlob();
    if (String(blob.getContentType() || '').toLowerCase() !== 'image/png') {
      return { dataUri: '', warning: 'The logo file isn\'t a PNG, so the invoices were made without it. Ask the developer to check the logo file.' };
    }
    const bytes = blob.getBytes();
    if (bytes.length > MAX_LOGO_BYTES) {
      return { dataUri: '', warning: 'The logo file is over 2 MB, so the invoices were made without it. Ask the developer to use a smaller PNG.' };
    }
    return { dataUri: 'data:image/png;base64,' + Utilities.base64Encode(bytes), warning: '' };
  } catch (e) {
    return { dataUri: '', warning: 'The logo couldn\'t be loaded, so the invoices were made without it. Ask the developer to check the logo\'s sharing settings.' };
  }
}

// ---------------------------------------------------------------------------
// Editable spreadsheet
// ---------------------------------------------------------------------------

/**
 * Creates the editable Google Sheet (Invoices + Settings tabs) inside the job folder.
 * The Invoices tab keeps one row per source record; invoice-level details are
 * written on each invoice's first row only, so one cell fixes the whole invoice.
 */
function createInvoiceSpreadsheet_(folder, parsed, jobId, sourceName, originalId) {
  const opts = parsed.opts, grouped = parsed.grouped;
  const L = I18N[opts.language], S = L.sheet;
  const labels = grouped.detailLabels || [];
  const grouping = !!parsed.mapping.groupBy;
  // An empty header means "no column" in the sheet, so a blank label is written as a marker instead.
  const sheetLabel = label => label ? cellText_(label) : L.noLabel;
  const groupHeader = grouping ? sheetLabel(parsed.mapping.groupBy.label) : '';
  const width = SHEET_BASE_WIDTH + labels.length;
  const accent = accent_();
  const ss = SpreadsheetApp.create(S.fileName(safeName_(sourceName.replace(/\.[^.]+$/, ''))));
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  if (opts.language === 'fr') {
    try { ss.setSpreadsheetLocale('fr_CA'); } catch (e) { /* keep the default locale */ }
  }

  // ---- Invoices tab
  const items = ss.getSheets()[0].setName(S.itemsTab);
  const rows = [];
  grouped.invoices.forEach(inv => {
    inv.items.forEach((it, j) => {
      const first = j === 0;
      const head = k => first ? cellText_(inv[k]) : '';
      rows.push([
        cellText_(inv.number), head('clientNumber'), head('invoiceDate'), head('dueDate'), head('customerName'), head('attention'),
      ].concat(ADDRESS_KEYS.map(k => first && inv.address ? cellText_(inv.address[k]) : ''))
        .concat([
          cellText_(it.candidate), cellText_(it.workOrder), cellText_(it.purchaseOrder), cellText_(it.workDate),
          cellText_(it.lineType), it.unitsCell, it.rateCell,
          '',                                         // Amount: filled by the ARRAYFORMULA below
          first ? cellText_(inv.taxCodeRaw) : '',
          grouping ? cellText_(it.group) : '',
        ])
        .concat(it.details.map(cellText_)));
    });
  });
  // Text format keeps invoice numbers like "00123" and dates exactly as written.
  items.getRange('A2:S').setNumberFormat('@');
  items.getRange('W2:AH').setNumberFormat('@');
  items.getRange('T2:T').setNumberFormat('0.###');
  items.getRange('U2:V').setNumberFormat('#,##0.00');
  items.getRange(1, 1, 1, width).setValues([S.headers.concat([groupHeader]).concat(labels.map(sheetLabel))])
    .setFontWeight('bold').setBackground(accent).setFontColor('#ffffff');
  items.getRange(2, 1, rows.length, width).setValues(rows);
  items.getRange('V2').setFormula('=ARRAYFORMULA(IF(A2:A="","",IFERROR(VALUE(T2:T),0)*IFERROR(VALUE(U2:U),0)))');
  items.getRange('V1').setBackground('#6b7280'); // grey = calculated column, don't type here
  items.getRange('A1').setNote(S.note);
  items.setFrozenRows(1);
  items.getRange(2, SHEET_MAP.taxCode + 1, rows.length, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(L.taxCodes, true).setAllowInvalid(true).build());
  [110, 100, 110, 130, 180, 150, 170, 120, 110, 110, 120, 100, 100, 100,
   170, 110, 120, 100, 110, 70, 90, 100, 90, 140].forEach((w, i) => items.setColumnWidth(i + 1, w));
  for (let c = SHEET_BASE_WIDTH + 1; c <= SHEET_BASE_WIDTH + MAX_DETAILS; c++) items.setColumnWidth(c, 140);

  // ---- Settings tab: key (hidden column A), label, value, help.
  const settings = ss.insertSheet(S.settingsTab);
  const values = { language: opts.language, outputMode: opts.outputMode, combineEmployees: opts.combineEmployees ? 'yes' : 'no' };
  settings.getRange(2, 3, SETTING_KEYS.length, 1).setNumberFormat('@');
  settings.getRange(1, 1, SETTING_KEYS.length + 1, 4).setValues(
    [['key'].concat(S.settingHeader)].concat(SETTING_KEYS.map(k => [k, S.settings[k][0], values[k], S.settings[k][1]])));
  settings.getRange(1, 1, 1, 4).setFontWeight('bold').setBackground(accent).setFontColor('#ffffff');
  const pick = (key, list) => settings.getRange(SETTING_KEYS.indexOf(key) + 2, 3)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(false).build());
  pick('language', ['en', 'fr']);
  pick('outputMode', ['combined', 'separate']);
  pick('combineEmployees', ['yes', 'no']);
  settings.getRange(2, 3, SETTING_KEYS.length, 1).setBackground('#fffbe6');

  const linkRow = SETTING_KEYS.length + 3;
  const url = rebuildUrl_(ss.getId());
  settings.getRange(linkRow, 2, 2, 1).setValues([[S.rebuild], [S.folder]]).setFontWeight('bold');
  if (url) settings.getRange(linkRow, 3).setFormula(hyperlink_(url, S.rebuildLabel));
  else settings.getRange(linkRow, 3).setValue(S.rebuildManual);
  settings.getRange(linkRow + 1, 3).setFormula(hyperlink_(folder.getUrl(), S.folderLabel));
  settings.setColumnWidth(2, 220).setColumnWidth(3, 320).setColumnWidth(4, 420);
  settings.hideColumns(1);
  settings.setFrozenRows(1);

  writeMeta_(ss, {
    version: SHEET_VERSION,
    jobId: jobId,
    sourceName: sourceName,
    folderId: folder.getId(),
    originalId: originalId || '',
    itemsSheetId: items.getSheetId(),
    settingsSheetId: settings.getSheetId(),
    created: new Date().toISOString(),
    lastBuilt: '',
    busyUntil: '',
    grouping: grouping ? 'true' : 'false',
    taxRates: opts.taxRates,
    files: {},
  });
  SpreadsheetApp.flush();
  return ss;
}

/** Reads the spreadsheet, rebuilds the PDFs in the job folder, and records the file IDs. */
function renderFromSpreadsheet_(ss, run) {
  const meta = readMeta_(ss);
  const items = sheetById_(ss, meta.itemsSheetId) || ss.getSheets()[0];
  const settingsSheet = sheetById_(ss, meta.settingsSheetId) || ss.getSheets()[1];
  if (!items || !settingsSheet) throw userError_('The spreadsheet is missing its Invoices or Settings tab.');

  const raw = {};
  settingsSheet.getDataRange().getValues().forEach(r => {
    if (SETTING_KEYS.indexOf(String(r[0])) !== -1) raw[r[0]] = r[2];
  });
  const opts = normalizeLayoutOptions_(raw);
  opts.hasHeader = true;
  opts.decimalComma = opts.language === 'fr'; // only matters for numbers typed as text
  opts.dateFormat = 'auto';                   // the sheet stores yyyy-mm-dd; anything else is guessed
  opts.taxRates = sanitizeRates_(meta.taxRates) || getTaxRates_().rates; // the rates this job was made with
  const L = I18N[opts.language];

  const all = sheetToRows_(items.getDataRange(), ss.getSpreadsheetTimeZone());
  const header = all[0] || [];
  const text = i => String(header[i] == null ? '' : header[i]).trim();
  const label = i => isNoLabel_(text(i)) ? '' : text(i); // "(no label)" = keep the column, print no label
  const details = [];
  for (let c = SHEET_DETAIL_START; c < SHEET_DETAIL_START + MAX_DETAILS; c++) {
    if (text(c)) details.push({ index: c, label: label(c) });
  }
  const groupBy = text(SHEET_GROUP_COL) ? { index: SHEET_GROUP_COL, label: label(SHEET_GROUP_COL) } : null;
  const body = all.slice(1);
  const grouped = groupInvoices_(body, Object.assign({}, SHEET_MAP, { details: details, groupBy: groupBy }), opts,
    body.map((_, i) => i + 2));
  if (!grouped.invoices.length) {
    throw userError_('No invoices were found in the spreadsheet' +
      (grouped.skipped.length ? ' — first problem: row ' + grouped.skipped[0].row + ': ' + grouped.skipped[0].reason : '.'));
  }

  let folder;
  try {
    folder = DriveApp.getFolderById(meta.folderId);
  } catch (e) {
    throw userError_('The Drive folder for this spreadsheet no longer exists or you do not have access to it.');
  }
  const branding = loadBranding_(opts.language);
  const t0 = Date.now();
  const output = writePdfs_(grouped.invoices, opts, L, folder, meta, branding);
  if (run) log_(run, 'pdfs_written', { invoices: grouped.invoices.length, files: output.invoices.length, ms: Date.now() - t0 });
  meta.lastBuilt = new Date().toISOString();
  writeMeta_(ss, meta);
  return { output: output, skipped: grouped.skipped, notes: grouped.notes, warnings: branding.warnings,
           opts: opts, L: L, meta: meta, folder: folder };
}

/** True for the sheet's "blank label" marker, in either language (any case). */
function isNoLabel_(s) {
  const t = String(s || '').trim().toLowerCase();
  return t === I18N.en.noLabel.toLowerCase() || t === I18N.fr.noLabel.toLowerCase();
}

/** "Label: value", or just "value" when the label is blank. */
function labelled_(label, value) {
  return label ? label + ': ' + value : value;
}

function sanitizeRates_(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (let i = 0; i < TAX_RATE_KEYS.length; i++) {
    const v = Number(r[TAX_RATE_KEYS[i]]);
    if (!isFinite(v)) return null;
    out[TAX_RATE_KEYS[i]] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PDF output
// ---------------------------------------------------------------------------

/**
 * Builds the PDFs. Files recorded in meta.files from an earlier build are
 * overwritten in place (same file, same link, Drive keeps the old version);
 * files that are no longer needed (a deleted invoice, a switched output mode)
 * are moved to the trash. The original data file is never touched.
 */
function writePdfs_(invoices, opts, L, folder, meta, branding) {
  const prev = meta.files || {};
  const prevPer = prev.perInvoice || {};
  const next = { perInvoice: {} };
  let output;

  if (opts.outputMode === 'combined') {
    const name = (invoices.length === 1
      ? L.fileInvoice + ' ' + safeName_(invoices[0].number)
      : L.fileAll + ' - ' + safeName_(String(meta.sourceName || 'invoices').replace(/\.[^.]+$/, ''))) + '.pdf';
    const file = putFile_(folder, prev.combinedId, htmlToPdf_(invoicesHtml_(invoices, opts, L, branding), name));
    next.combinedId = file.getId();
    const url = file.getUrl();
    output = { invoices: invoices.map(inv => invoiceSummary_(inv, url)), zipUrl: null, combinedUrl: url };
    Object.keys(prevPer).forEach(k => trashFile_(prevPer[k]));
    trashFile_(prev.zipId);
  } else {
    const blobs = [];
    const results = invoices.map(inv => {
      const base = L.fileInvoice + ' ' + safeName_(inv.number) + (inv.customerName ? ' - ' + safeName_(inv.customerName) : '');
      const pdf = htmlToPdf_(invoicesHtml_([inv], opts, L, branding), uniqueName_(base, blobs) + '.pdf');
      const file = putFile_(folder, prevPer[inv.number], pdf);
      next.perInvoice[inv.number] = file.getId();
      blobs.push(pdf);
      return invoiceSummary_(inv, file.getUrl());
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

function invoiceSummary_(inv, url) {
  return { number: inv.number, customer: inv.customerName, total: formatMoney_(inv.total), url: url };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function sendResultEmail_(to, built, ss, updated) {
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw userError_('the daily email limit has been reached. Use the links on this page instead.');
  }
  const E = I18N.en.email; // emails are always in English, whatever the invoice language
  const output = built.output, folder = built.folder;
  const accent = accent_();
  const sourceName = String(built.meta.sourceName || '');
  const n = output.invoices.length;
  const button = (url, text) =>
    '<a href="' + esc_(url) + '" style="display:inline-block;background:' + accent +
    ';color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold;margin:4px 8px 4px 0">' +
    esc_(text) + '</a>';
  let originalUrl = '';
  if (built.meta.originalId) {
    try { originalUrl = DriveApp.getFileById(built.meta.originalId).getUrl(); } catch (e) { originalUrl = ''; }
  }

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
      (originalUrl ? '<p style="margin-top:16px">' + esc_(E.originalData) + ': <a href="' + esc_(originalUrl) + '">' +
        esc_(ORIGINAL_PREFIX + sourceName) + '</a></p>' : '') +
      '<p style="margin-top:20px">' + rebuildHtml + '</p>' +
      '<p style="color:#888;font-size:12px;margin-top:24px">' + esc_(E.reference) + ': ' + esc_(built.meta.jobId) +
        ' · ' + esc_(E.footer) + '</p>' +
      '<p style="color:#888;font-size:12px">' + esc_(E.noReply) + '</p>' +
    '</div>';

  const plainLinks = (output.combinedUrl ? [E.openPdf + ': ' + output.combinedUrl] : output.invoices.map(i => i.number + ': ' + i.url))
    .concat([E.editSheet + ': ' + ss.getUrl(), E.openFolder + ': ' + folder.getUrl()])
    .concat(originalUrl ? [E.originalData + ': ' + originalUrl] : [])
    .concat(rebuildUrl ? [E.rebuildHint + ' ' + E.rebuildLink + ': ' + rebuildUrl] : [E.rebuildManual]);

  MailApp.sendEmail({
    to: to,
    subject: subject,
    htmlBody: htmlBody,
    body: E.intro(n, sourceName).replace(/<[^>]+>/g, '') + '\n\n' + plainLinks.join('\n') +
      '\n\n' + E.reference + ': ' + built.meta.jobId + '\n' + E.noReply,
    name: senderName_(),
  });
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

/**
 * Reads an uploaded CSV or Excel file. Returns { rows, rowNumbers, decimalComma, notes }:
 * rows are the cell values, rowNumbers the file's own row numbers (for messages),
 * decimalComma a guess at whether numbers use a decimal comma (1 234,56).
 * Rows hidden in Excel (by a filter or by hand) are left out.
 */
function readRows_(file, jobId) {
  if (!file || !file.base64) throw userError_('Please choose a CSV or XLSX file first.');
  const name = String(file.name || '').toLowerCase();
  const bytes = Utilities.base64Decode(file.base64);

  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = decodeText_(bytes);
    const delimiter = detectDelimiter_(text);
    const rows = Utilities.parseCsv(text, delimiter);
    // Excel in French (and most European locales) saves ";"-separated CSVs with decimal commas.
    return { rows: rows, rowNumbers: rows.map((_, i) => i + 1), decimalComma: delimiter === ';', notes: [], hiddenRows: 0 };
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
      const sheet = ss.getSheets()[0];
      const all = sheetToRows_(sheet.getDataRange(), ss.getSpreadsheetTimeZone());
      const notes = [];
      let hidden = {};
      try {
        hidden = hiddenRowIndexes_(temp.id, sheet.getName());
      } catch (e) {
        notes.push('The Excel file couldn\'t be checked for hidden rows, so every row was read.');
      }
      const rows = [], rowNumbers = [];
      let hiddenCount = 0;
      all.forEach((r, i) => {
        if (hidden[i]) { hiddenCount++; return; }
        rows.push(r);
        rowNumbers.push(i + 1);
      });
      if (hiddenCount) {
        notes.unshift(hiddenCount + ' hidden row' + (hiddenCount === 1 ? '' : 's') +
          ' in the Excel file (hidden by a filter or by hand) ' + (hiddenCount === 1 ? 'was' : 'were') + ' not invoiced.');
      }
      return { rows: rows, rowNumbers: rowNumbers, decimalComma: false, notes: notes, hiddenRows: hiddenCount };
    } finally {
      DriveApp.getFileById(temp.id).setTrashed(true);
    }
  }

  throw userError_('Unsupported file type. Please upload a .csv or .xlsx file.');
}

/**
 * 0-based indexes of rows hidden by a filter or by hand, from one Sheets API call.
 * Returns { 3: true, 7: true, ... }.
 */
function hiddenRowIndexes_(spreadsheetId, sheetName) {
  const res = Sheets.Spreadsheets.get(spreadsheetId, {
    ranges: ["'" + String(sheetName).replace(/'/g, "''") + "'"],
    fields: 'sheets(data(startRow,rowMetadata(hiddenByFilter,hiddenByUser)))',
  });
  const out = {};
  const sheet = ((res && res.sheets) || [])[0] || {};
  (sheet.data || []).forEach(d => {
    const start = d.startRow || 0;
    (d.rowMetadata || []).forEach((m, i) => {
      if (m && (m.hiddenByFilter || m.hiddenByUser)) out[start + i] = true;
    });
  });
  return out;
}

/**
 * Cell values of a Google Sheet range. Dates become yyyy-MM-dd; numbers stay
 * numbers (so the sheet's locale can't confuse parsing), except percentages,
 * which keep their "%" text.
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
 * raw.details: up to 10 { col, label }; raw.groupBy: { col, label } (optional).
 */
function normalizeMapping_(raw) {
  const mapping = {};
  const errors = [];
  const toIndex = (letters, label) => {
    if (!/^[A-Z]{1,3}$/.test(letters)) { errors.push(label + ': "' + letters + '" is not a valid column letter.'); return null; }
    return colToIndex_(letters);
  };
  const legacy = { candidate: ['employeeName', 'description'], units: ['quantity'], address1: ['customerAddress'] };
  FIELDS.forEach(f => {
    let letters = String(raw[f.key] || '').trim().toUpperCase();
    if (!letters && legacy[f.key]) letters = legacy[f.key].map(k => String(raw[k] || '').trim().toUpperCase()).filter(Boolean)[0] || '';
    if (!letters) {
      if (f.required) errors.push(f.label + ' is required.');
      mapping[f.key] = null;
    } else {
      mapping[f.key] = toIndex(letters, f.label);
    }
  });
  mapping.details = [];
  (Array.isArray(raw.details) ? raw.details : []).slice(0, MAX_DETAILS).forEach((d, n) => {
    const letters = String((d && d.col) || '').trim().toUpperCase();
    if (!letters) return;
    const index = toIndex(letters, 'Extra detail ' + (n + 1));
    if (index != null) mapping.details.push({ index: index, label: String(d.label || '').trim().slice(0, 60) });
  });
  const g = raw.groupBy || {};
  const gLetters = String(g.col || '').trim().toUpperCase();
  mapping.groupBy = null;
  if (gLetters) {
    const index = toIndex(gLetters, 'Group line items by');
    if (index != null) mapping.groupBy = { index: index, label: String(g.label || '').trim().slice(0, 60) };
  }
  if (errors.length) throw userError_(errors.join(' '));
  return mapping;
}

/** Cleans up the options and fills in defaults. Never trusts the client. */
function normalizeOptions_(o) {
  return Object.assign(normalizeLayoutOptions_(o), {
    hasHeader: !!o.hasHeader,
    numberFormat: ['dot', 'comma'].indexOf(o.numberFormat) !== -1 ? o.numberFormat : 'auto',
    dateFormat: ['dmy', 'mdy'].indexOf(o.dateFormat) !== -1 ? o.dateFormat : 'auto',
  });
}

/** Options that control how invoices look. Shared by the web form and the spreadsheet's Settings tab. */
function normalizeLayoutOptions_(o) {
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  return {
    language: str(o.language, 5).toLowerCase() === 'fr' ? 'fr' : 'en',
    // Same default as the web form: one PDF per invoice unless "combined" is chosen.
    outputMode: str(o.outputMode, 20).toLowerCase() === 'combined' ? 'combined' : 'separate',
    combineEmployees: o.combineEmployees === true || /^(yes|oui|true|1|y|o)$/i.test(str(o.combineEmployees, 5)),
  };
}

/**
 * Groups rows (single-line records) into invoices.
 * Returns { invoices, skipped: rows not invoiced, notes: non-blocking messages, detailLabels }.
 * Rules:
 *  - a fully blank row is ignored; a row with no invoice number is skipped and listed;
 *  - Units or Rate that are blank or not numbers count as 0, with a note;
 *  - invoice details come from the first row of the invoice that has them; the
 *    address comes whole from the first row that has any address part;
 *  - the first tax code found applies to the whole invoice; unknown → EXEMPT.
 */
function groupInvoices_(rows, m, opts, rowNums) {
  const L = I18N[opts.language] || I18N.en;
  const byNumber = {};
  const order = [];
  const skipped = [];
  const notes = [];
  const details = m.details || [];
  const labels = details.map(d => d.label);
  const dateOrder = resolveDateOrder_(rows, m, opts);
  const rates = opts.taxRates || DEFAULT_TAX_RATES;

  const raw = (row, key) => { const idx = m[key]; return idx == null || row[idx] == null ? '' : row[idx]; };
  const get = (row, key) => String(raw(row, key)).trim();
  const blank = v => v == null || String(v).trim() === '';

  rows.forEach((row, i) => {
    const rowNum = rowNums ? rowNums[i] : i + 1;
    if (row.every(blank)) return; // blank line
    const number = get(row, 'invoiceNumber');
    if (!number) {
      skipped.push({ row: rowNum, reason: 'No invoice number, so the row can\'t be placed on an invoice' });
      return;
    }
    const where = 'Row ' + rowNum + ' (' + number + ')';

    let inv = byNumber[number];
    if (!inv) {
      inv = byNumber[number] = { number: number, items: [], detailLabels: labels, address: null, taxCodeRaw: '', taxSeen: [] };
      order.push(inv);
    }
    INVOICE_FIELDS.forEach(k => {
      if (!blank(inv[k])) return;
      inv[k] = (k === 'invoiceDate' || k === 'dueDate') ? normalizeDate_(get(row, k), dateOrder) : get(row, k);
    });
    if (!inv.address) {
      const parts = {};
      let any = false;
      ADDRESS_KEYS.forEach(k => { parts[k] = get(row, k); if (parts[k]) any = true; });
      if (any) inv.address = parts;
    }
    const code = get(row, 'taxCode');
    if (code) {
      if (!inv.taxCodeRaw) inv.taxCodeRaw = code;
      const key = normalizeTaxCode_(code) || code.toUpperCase();
      if (inv.taxSeen.indexOf(key) === -1) inv.taxSeen.push(key);
    }

    const num = (key, label) => {
      const text = get(row, key);
      const n = text === '' ? NaN : parseNumber_(raw(row, key), opts.decimalComma);
      if (isNaN(n)) {
        notes.push(where + ': ' + label + (text === '' ? ' is blank' : ' "' + text + '" is not a number') + ', so 0 was used.');
        return { value: 0, cell: text };
      }
      return { value: n, cell: n };
    };
    const units = num('units', 'Units');
    const rate = num('unitPrice', 'Rate');
    const lineType = get(row, 'lineType');
    if (!lineType) notes.push(where + ': no line type, so it is listed as "' + L.other + '" in the units summary.');

    inv.items.push({
      candidate: get(row, 'candidate'),
      workOrder: get(row, 'workOrder'),
      purchaseOrder: get(row, 'purchaseOrder'),
      workDate: normalizeDate_(get(row, 'workDate'), dateOrder),
      lineType: lineType,
      units: units.value,
      unitPrice: rate.value,
      unitsCell: units.cell,
      rateCell: rate.cell,
      amount: round2_(units.value * rate.value),
      details: details.map(d => String(row[d.index] == null ? '' : row[d.index]).trim()),
      group: m.groupBy ? String(row[m.groupBy.index] == null ? '' : row[m.groupBy.index]).trim() : '',
    });
  });

  const invoices = [];
  order.forEach(inv => {
    let code = 'EXEMPT';
    if (inv.taxCodeRaw) {
      const key = normalizeTaxCode_(inv.taxCodeRaw);
      if (key) code = key;
      else notes.push('Invoice ' + inv.number + ': tax code "' + inv.taxCodeRaw + '" is not recognised, so EXEMPT was used.');
    }
    if (inv.taxSeen.length > 1) {
      notes.push('Invoice ' + inv.number + ': rows had different tax codes (' + inv.taxSeen.join(', ') + '); "' +
        inv.taxCodeRaw + '" (the first) was used for the whole invoice.');
    }
    inv.taxCode = code;
    inv.lines = buildLines_(inv.items, !!opts.combineEmployees);
    inv.groups = groupLines_(inv.lines);
    inv.groupLabel = m.groupBy ? m.groupBy.label : '';
    inv.unitsSummary = unitsSummary_(inv.items, L);
    inv.subtotal = round2_(inv.lines.reduce((s, ln) => s + ln.amount, 0));
    inv.taxes = computeTaxes_(code, inv.subtotal, rates);
    inv.tax = round2_(inv.taxes.reduce((s, t) => s + t.amount, 0));
    inv.total = round2_(inv.subtotal + inv.tax);
    invoices.push(inv);
  });

  return { invoices: invoices, skipped: skipped, notes: notes, detailLabels: labels };
}

/**
 * Turns raw items into PDF line items. When combining, rows with the same group,
 * candidate/role, line type, work order, purchase order and rate become one
 * line: units are added up, the work dates become a range, and differing detail
 * values are listed. A different rate or line type (e.g. overtime) stays separate.
 */
function buildLines_(items, combine) {
  const toLine = it => ({
    candidate: it.candidate, workOrder: it.workOrder, purchaseOrder: it.purchaseOrder, lineType: it.lineType,
    group: it.group, quantity: it.units, unitPrice: it.unitPrice, amount: it.amount,
    dates: it.workDate ? [it.workDate] : [], details: it.details.map(v => v ? [v] : []),
  });
  if (!combine) return items.map(toLine);
  const byKey = {};
  const lines = [];
  items.forEach(it => {
    const key = [it.group, it.candidate, it.lineType, it.workOrder, it.purchaseOrder]
      .map(s => String(s).toLowerCase()).concat([it.unitPrice]).join('\u0001');
    let ln = byKey[key];
    if (!ln) {
      ln = byKey[key] = Object.assign(toLine(it), { quantity: 0, dates: [], details: it.details.map(() => []) });
      lines.push(ln);
    }
    ln.quantity += it.units;
    if (it.workDate) ln.dates.push(it.workDate);
    it.details.forEach((v, i) => { if (v && ln.details[i].indexOf(v) === -1) ln.details[i].push(v); });
  });
  lines.forEach(ln => {
    ln.quantity = Math.round(ln.quantity * 1000) / 1000;
    ln.amount = round2_(ln.quantity * ln.unitPrice);
  });
  return lines;
}

/**
 * Groups lines under headings: [{ value, lines }] in order of first appearance.
 * Lines with no group value come first, with no heading (value ''). With no group
 * values at all, there is a single headingless group.
 */
function groupLines_(lines) {
  const blank = lines.filter(ln => !ln.group);
  const groups = [];
  const byValue = {};
  lines.forEach(ln => {
    if (!ln.group) return;
    if (!byValue[ln.group]) { byValue[ln.group] = { value: ln.group, lines: [] }; groups.push(byValue[ln.group]); }
    byValue[ln.group].lines.push(ln);
  });
  return (blank.length ? [{ value: '', lines: blank }] : []).concat(groups);
}

/** Units per line type for one invoice (no total row). Types match ignoring case and extra spaces. */
function unitsSummary_(items, L) {
  const out = [];
  const byKey = {};
  items.forEach(it => {
    const label = String(it.lineType || '').replace(/\s+/g, ' ').trim();
    const key = label.toLowerCase();
    if (!byKey[key]) { byKey[key] = { type: label || L.other, units: 0 }; out.push(byKey[key]); }
    byKey[key].units += it.units;
  });
  out.forEach(r => { r.units = Math.round(r.units * 1000) / 1000; });
  return out;
}

/** Combines the address parts into printed lines: 1–4, "City, ST  Postal", Country. */
function formatClientAddress_(p) {
  if (!p) return [];
  const t = k => cleanText_(p[k]);
  const lines = ['address1', 'address2', 'address3', 'address4'].map(t).filter(Boolean);
  const postal = t('postalCode').toUpperCase();
  let cityLine = t('city');
  if (t('province')) cityLine = cityLine ? cityLine + ', ' + t('province') : t('province');
  if (postal) cityLine = cityLine ? cityLine + '  ' + postal : postal;
  if (cityLine) lines.push(cityLine);
  if (t('country')) lines.push(t('country'));
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

/** yyyy-mm-dd → MM/DD/YYYY (both languages). Anything else is shown as written. */
function formatDate_(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (!m) return s;
  return ('0' + m[2]).slice(-2) + '/' + ('0' + m[3]).slice(-2) + '/' + m[1];
}

/** The date or date range for a line: "11/03/2026" or "11/03/2026 – 11/05/2026". */
function formatDateSpan_(dates) {
  const isoDates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!isoDates.length) return dates.filter((d, i) => dates.indexOf(d) === i).join(', ');
  const a = isoDates[0], b = isoDates[isoDates.length - 1];
  return a === b ? formatDate_(a) : formatDate_(a) + ' – ' + formatDate_(b);
}

// ---------------------------------------------------------------------------
// PDF HTML: pages, header, body, summary, totals, footer
// ---------------------------------------------------------------------------

/** The whole PDF for one or more invoices; each invoice starts on a new page. */
function invoicesHtml_(invoices, opts, L, branding) {
  const pages = [];
  invoices.forEach(inv => { invoicePages_(inv, opts, L, branding).forEach(p => pages.push(p)); });
  const html = pages.map((p, i) => {
    const brk = i < pages.length - 1 ? 'page-break-after:always;' : '';
    // Page number top-right; content takes the spare height, so a footer row
    // (last page only) sits at the bottom. If a converter ignores the fixed
    // height, the footer simply follows the content.
    return '<table class="page" style="height:' + PAGE.HEIGHT + 'pt;' + brk + '">' +
      '<tr><td class="pn" style="height:' + PAGE.NUMBER_ROW + 'pt">' + esc_(p.number) + '</td></tr>' +
      '<tr><td class="page-content" style="height:100%">' + p.content + '</td></tr>' +
      (p.footer ? '<tr><td class="page-footer">' + p.footer + '</td></tr>' : '') +
      '</table>';
  });
  return wrapHtml_(html, branding.accent);
}

function wrapHtml_(pages, accent) {
  const a = accent || DEFAULT_ACCENT;
  const wrap = 'overflow-wrap:anywhere;word-wrap:break-word;word-break:break-word;';
  const css =
    '@page{size:letter portrait;margin:0.5in;}' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#222;font-size:9pt;margin:0;}' +
    'table{border-collapse:collapse;width:100%;}' +
    'td,th{vertical-align:top;padding:0;}' +
    '.page-content{vertical-align:top;}' +
    '.page-footer{vertical-align:bottom;}' +
    '.pn{text-align:right;vertical-align:top;font-size:8pt;color:#777;}' +
    '.hdr-details td{padding:1.5pt 0 1.5pt 12pt;font-size:9pt;}' +
    '.hdr-details td.lbl{color:#666;text-align:right;white-space:nowrap;}' +
    '.hdr-details td.val{text-align:right;font-weight:bold;' + wrap + '}' +
    '.name{font-weight:bold;color:' + a + ';font-size:10.5pt;}' +
    '.block div{line-height:12pt;' + wrap + '}' +
    '.company{text-align:right;}' +
    '.gov{font-size:8pt;color:#666;}' +
    '.confidential{font-weight:bold;letter-spacing:1pt;font-size:9pt;padding-top:10pt;}' +
    '.items{margin-top:' + PAGE.GAP_HEADER_BODY + 'pt;table-layout:fixed;}' +
    '.items th{background:' + a + ';color:#fff;padding:5pt 4pt;font-size:8pt;text-align:left;font-weight:bold;' + wrap + '}' +
    '.items th.num,.items td.num{text-align:right;}' +
    '.items td{padding:4pt;border-bottom:0.5pt solid #ddd;font-size:8.5pt;' + wrap + '}' +
    '.items td.num{white-space:nowrap;}' +
    '.items tr.alt td{background:#f5f6f8;}' +
    '.items tr.grp td{background:' + tint_(a, 0.86) + ';border-left:3pt solid ' + a + ';color:' + a +
      ';font-weight:bold;padding:4pt 6pt;font-size:8.5pt;}' +
    '.detail{font-size:7.5pt;color:#555;padding-left:8pt;line-height:10pt;}' +
    '.section{font-size:8pt;font-weight:bold;color:' + a + ';text-transform:uppercase;letter-spacing:0.6pt;margin-bottom:3pt;}' +
    '.units th{text-align:left;font-size:8pt;color:#666;font-weight:normal;border-bottom:0.5pt solid #ccc;padding:2pt 10pt 2pt 0;}' +
    '.units th.num,.units td.num{text-align:right;}' +
    '.units td{padding:2pt 10pt 2pt 0;font-size:9pt;' + wrap + '}' +
    '.units tr.total td{font-weight:bold;border-top:0.75pt solid #999;padding-top:3pt;}' +
    '.totals td{padding:3pt 0 3pt 8pt;font-size:9.5pt;}' +
    '.totals td.num{text-align:right;white-space:nowrap;}' +
    '.totals tr.grand td{font-weight:bold;font-size:11pt;border-top:1.5pt solid ' + a + ';padding-top:5pt;}' +
    '.footer{margin-top:' + PAGE.GAP_SUMMARY_FOOTER + 'pt;border-top:1pt solid ' + a + ';padding-top:8pt;font-size:8.5pt;}' +
    '.footer td{line-height:11pt;' + wrap + '}' +
    '.footer .pay{font-weight:bold;}' +
    '.footer .bank td{padding:0 0 0 8pt;}' +
    '.footer .bank td.lbl{text-align:right;color:#666;white-space:nowrap;}' +
    '.footer .bank td.val{text-align:right;}' +
    '.remit{margin-top:8pt;' + wrap + '}' +
    '.disclosure{font-size:7.5pt;color:#666;text-align:justify;margin-top:6pt;line-height:10pt;' + wrap + '}';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' +
    pages.join('') + '</body></html>';
}

/**
 * Splits one invoice into pages: [{ content, footer, number }]. The footer
 * (bank details, remittance, disclosure) is only on the last page: in its own
 * bottom row when FOOTER_AT_PAGE_BOTTOM is on, otherwise right after the totals.
 */
function invoicePages_(inv, opts, L, branding) {
  const pages = paginateInvoice_(inv, branding);
  const footer = footerHtml_(branding.footer);
  return pages.map((rows, p) => {
    const last = p === pages.length - 1;
    const content = (p === 0 ? headerHtml_(inv, L, branding) : condensedHeaderHtml_(inv, L, branding)) +
      itemsTableHtml_(rows, inv, L) +
      (last ? summaryTotalsHtml_(inv, L) + (branding.footerAtBottom ? '' : footer) : '');
    return { content: content, footer: last && branding.footerAtBottom ? footer : '', number: L.page(p + 1, pages.length) };
  });
}

const textLines_ = (s, per) => Math.max(1, Math.ceil(String(s || '').length / per));

/** Estimated height (pt) of one line row. */
function lineHeight_(ln, labels) {
  // The first column stacks the name and the extra-detail lines; the other
  // columns sit beside it, so the row is as tall as the tallest column.
  let detailLines = 0;
  labels.forEach((label, d) => {
    if (ln.details[d] && ln.details[d].length) detailLines += textLines_(labelled_(label, ln.details[d].join(', ')), 32);
  });
  const first = textLines_(ln.candidate, 23) * PAGE.TEXT_LINE + detailLines * PAGE.DETAIL_LINE;
  const others = Math.max(textLines_(ln.workOrder, 11), textLines_(ln.purchaseOrder, 11),
    textLines_(formatDateSpan_(ln.dates), 15), textLines_(ln.lineType, 9)) * PAGE.TEXT_LINE;
  return PAGE.LINE_PAD + Math.max(first, others);
}

/** Estimated height (pt) of the full header on page 1. */
function fullHeaderHeight_(inv, branding) {
  const block = lines => lines.reduce((n, s) => n + textLines_(s, 44), 0);
  const clientLines = textLines_(inv.customerName, 38) + (inv.attention ? textLines_('ATTN: ' + inv.attention, 44) : 0) +
    block(formatClientAddress_(inv.address));
  const companyLines = block(branding.company.address) + (branding.company.phone ? 1 : 0) + branding.company.gov.length;
  const details = [inv.number, inv.clientNumber].reduce((n, v) => n + textLines_(v, 22), 0) + 2;
  return Math.max(62, details * 13 + 10) + 10 + Math.max(clientLines, companyLines) * 12 + 24;
}

/** Estimated height (pt) of the units summary, totals and footer on the last page. */
function tailHeight_(inv, branding) {
  const f = branding.footer;
  const summary = PAGE.GAP_BODY_SUMMARY + Math.max(3 + inv.unitsSummary.length, 2 + inv.taxes.length) * 13 + 6;
  const hasFooter = f.paymentTitle || f.bankAddress.length || f.bankDetails.length || f.remittance || f.disclosure;
  const footer = hasFooter
    ? PAGE.GAP_SUMMARY_FOOTER + 8 + Math.max(1 + f.bankAddress.length, f.bankDetails.length) * 11 +
      (f.remittance ? 8 + textLines_(f.remittance, 120) * 11 : 0) + textLines_(f.disclosure, 130) * 10 + 6
    : 0;
  return summary + footer;
}

/**
 * Splits an invoice's rows into pages. Each page gets: page number, header (full
 * on page 1, condensed after), column headings, as many rows as fit. The last
 * page must also fit the summary, totals and footer. Group headings stay with
 * their next line, and repeat with "(continued)" on the next page.
 * Returns [[row, ...], ...] where row = { type: 'group'|'line', ... }.
 */
function paginateInvoice_(inv, branding) {
  const labels = inv.detailLabels || [];
  const rows = [];
  inv.groups.forEach(g => {
    if (g.value) rows.push({ type: 'group', group: g, continued: false, h: groupRowHeight_(inv, g) });
    g.lines.forEach(ln => rows.push({ type: 'line', line: ln, group: g, h: lineHeight_(ln, labels) }));
  });
  const fullHeader = fullHeaderHeight_(inv, branding);
  const budget = p => PAGE.HEIGHT - PAGE.NUMBER_ROW - PAGE.GAP_HEADER_BODY - PAGE.COL_HEADER - PAGE.SAFETY -
    (p === 0 ? fullHeader : PAGE.CONDENSED_HEADER);
  const tail = tailHeight_(inv, branding);
  const continued = g => ({ type: 'group', group: g, continued: true, h: groupRowHeight_(inv, g) });

  const pages = [{ rows: [], used: 0 }];
  rows.forEach((r, i) => {
    let page = pages[pages.length - 1];
    const need = r.type === 'group' && rows[i + 1] ? r.h + rows[i + 1].h : r.h; // keep a heading with its next line
    if (page.rows.length && page.used + need > budget(pages.length - 1)) {
      page = { rows: [], used: 0 };
      pages.push(page);
      if (r.type === 'line' && r.group.value) { const c = continued(r.group); page.rows.push(c); page.used += c.h; }
    }
    page.rows.push(r);
    page.used += r.h;
  });

  // The last page needs room for the summary, totals and footer: if it doesn't
  // fit, move its last line (with a heading right before it) to a new page.
  const last = pages[pages.length - 1];
  if (last.used + tail > budget(pages.length - 1) && last.rows.some(r => r.type === 'line')) {
    const moved = [];
    while (last.rows.length) {
      const r = last.rows.pop();
      last.used -= r.h;
      moved.unshift(r);
      if (r.type === 'line') {
        const prev = last.rows[last.rows.length - 1];
        if (prev && prev.type === 'group') { last.rows.pop(); last.used -= prev.h; moved.unshift(prev); }
        break;
      }
    }
    if (moved[0].type === 'line' && moved[0].group.value) moved.unshift(continued(moved[0].group));
    if (!last.rows.some(r => r.type === 'line')) pages.pop(); // nothing left there: drop the empty page
    pages.push({ rows: moved, used: 0 });
  }
  return pages.map(p => p.rows);
}

function groupRowHeight_(inv, g) {
  return PAGE.GROUP_ROW + (textLines_(labelled_(inv.groupLabel, g.value) + ' (continued)', 100) - 1) * PAGE.TEXT_LINE;
}

/**
 * Escaped text with invisible break points (<wbr>) inside long unbroken words,
 * so long codes and names wrap inside their cell instead of overflowing.
 * Words of 14 characters or fewer (dates, amounts, most codes) are untouched.
 */
function softText_(s) {
  return String(s == null ? '' : s).split(/(\s+)/).map(word => {
    if (/^\s+$/.test(word) || word.length <= 14) return esc_(word);
    let out = '', run = 0;
    for (let i = 0; i < word.length; i++) {
      const ch = word[i];
      out += esc_(ch);
      run++;
      if (i < word.length - 1 && ('-/_.@,'.indexOf(ch) !== -1 || run >= 12)) { out += '<wbr>'; run = 0; }
    }
    return out;
  }).join('');
}

function headerDetailsHtml_(inv, L) {
  const vals = [inv.number, inv.clientNumber, formatDate_(inv.invoiceDate), formatDate_(inv.dueDate)];
  return '<table class="hdr-details" style="width:auto;margin-left:auto">' +
    L.headerLabels.map((label, i) =>
      '<tr><td class="lbl">' + esc_(label) + '</td><td class="val" style="max-width:150pt">' + softText_(vals[i] || '') + '</td></tr>').join('') +
    '</table>';
}

function logoHtml_(branding, heightPt) {
  return branding.logo ? '<img src="' + branding.logo + '" style="height:' + heightPt + 'pt" alt="">' : '';
}

/** Full header (page 1): logo + invoice details, client block + company block, confidentiality phrase. */
function headerHtml_(inv, L, branding) {
  const lines = arr => arr.map(s => '<div>' + softText_(s).replace(/ {2}/g, ' &nbsp;') + '</div>').join('');
  const client = '<div class="name">' + softText_(inv.customerName || '') + '</div>' +
    (inv.attention ? '<div>' + esc_(L.attn) + ' ' + softText_(inv.attention) + '</div>' : '') +
    lines(formatClientAddress_(inv.address));
  const co = branding.company;
  const company = (co.address.length ? '<div class="name">' + softText_(co.address[0]) + '</div>' + lines(co.address.slice(1)) : '') +
    (co.phone ? '<div>' + esc_(L.phonePrefix + co.phone) + '</div>' : '') +
    co.gov.map(g => '<div class="gov">' + softText_(g) + '</div>').join('');
  return '<table class="hdr">' +
    '<tr><td style="width:50%;height:58pt">' + logoHtml_(branding, 54) + '</td>' +
      '<td style="width:50%">' + headerDetailsHtml_(inv, L) + '</td></tr>' +
    '<tr><td class="block" style="padding-top:10pt;padding-right:12pt">' + client + '</td>' +
      '<td class="block company" style="padding-top:10pt">' + company + '</td></tr>' +
    '<tr><td colspan="2" class="confidential">' + esc_(L.confidential) + '</td></tr>' +
    '</table>';
}

/** Condensed header (pages 2+): small logo + invoice details, client name. */
function condensedHeaderHtml_(inv, L, branding) {
  return '<table class="hdr">' +
    '<tr><td class="block" style="width:50%">' + logoHtml_(branding, 32) +
      '<div class="name" style="margin-top:4pt">' + softText_(inv.customerName || '') + '</div></td>' +
      '<td style="width:50%">' + headerDetailsHtml_(inv, L) + '</td></tr>' +
    '</table>';
}

/** The 8-column body table for one page's rows. */
const COLUMN_WIDTHS = [21, 11, 11, 14, 10, 8, 11, 14];
function itemsTableHtml_(rows, inv, L) {
  const num = [false, false, false, false, false, true, true, true];
  const head = '<tr>' + L.columns.map((c, i) =>
    '<th' + (num[i] ? ' class="num"' : '') + ' style="width:' + COLUMN_WIDTHS[i] + '%">' + esc_(c) + '</th>').join('') + '</tr>';
  const labels = inv.detailLabels || [];
  const multi = s => s.split(/\r?\n/).map(softText_).join('<br>');
  let stripe = 0;
  const body = rows.map(r => {
    if (r.type === 'group') {
      stripe = 0;
      return '<tr class="grp"><td colspan="8">' + (inv.groupLabel ? softText_(inv.groupLabel) + ': ' : '') + softText_(r.group.value) +
        (r.continued ? ' ' + esc_(L.continued) : '') + '</td></tr>';
    }
    const ln = r.line;
    const details = labels.map((label, d) => ln.details[d] && ln.details[d].length
      ? '<div class="detail">' + (label ? softText_(label) + ': ' : '') + multi(ln.details[d].join(', ')) + '</div>' : '').join('');
    return '<tr' + (stripe++ % 2 ? ' class="alt"' : '') + '>' +
      '<td>' + multi(ln.candidate) + details + '</td>' +
      '<td>' + softText_(ln.workOrder) + '</td>' +
      '<td>' + softText_(ln.purchaseOrder) + '</td>' +
      '<td>' + softText_(formatDateSpan_(ln.dates)) + '</td>' +
      '<td>' + softText_(ln.lineType) + '</td>' +
      '<td class="num">' + formatQty_(ln.quantity) + '</td>' +
      '<td class="num">' + esc_(formatMoney_(ln.unitPrice)) + '</td>' +
      '<td class="num">' + esc_(formatMoney_(ln.amount)) + '</td>' +
    '</tr>';
  }).join('');
  return '<table class="items">' + head + body + '</table>';
}

/** Units summary with a total (left) and subtotal / taxes / total (right). */
function summaryTotalsHtml_(inv, L) {
  const totalUnits = Math.round(inv.unitsSummary.reduce((n, r) => n + r.units, 0) * 1000) / 1000;
  const units = '<div class="section">' + esc_(L.summaryTitle) + '</div>' +
    '<table class="units" style="width:auto"><tr><th>' + esc_(L.summaryCols[0]) + '</th><th class="num">' +
    esc_(L.summaryCols[1]) + '</th></tr>' +
    inv.unitsSummary.map(r => '<tr><td>' + softText_(r.type) + '</td><td class="num">' + formatQty_(r.units) + '</td></tr>').join('') +
    '<tr class="total"><td>' + esc_(L.unitsTotal) + '</td><td class="num">' + formatQty_(totalUnits) + '</td></tr>' +
    '</table>';
  const taxRows = inv.taxes.map(t =>
    '<tr><td>' + esc_(L.taxes[t.key] + (t.ratePct == null ? '' : ' (' + formatQty_(t.ratePct) + '%)')) +
    '</td><td class="num">' + esc_(formatMoney_(t.amount)) + '</td></tr>').join('');
  const totals = '<table class="totals">' +
    '<tr><td>' + esc_(L.subtotal) + '</td><td class="num">' + esc_(formatMoney_(inv.subtotal)) + '</td></tr>' +
    taxRows +
    '<tr class="grand"><td>' + esc_(L.total) + '</td><td class="num">' + esc_(formatMoney_(inv.total)) + '</td></tr>' +
    '</table>';
  return '<table class="summary" style="margin-top:' + PAGE.GAP_BODY_SUMMARY + 'pt"><tr>' +
    '<td style="width:50%">' + units + '</td>' +
    '<td style="width:12%"></td>' +
    '<td style="width:38%">' + totals + '</td>' +
    '</tr></table>';
}

/** Invoice footer: bank block, remittance line, disclosure. Empty settings print nothing. */
function footerHtml_(f) {
  if (!f || !(f.paymentTitle || f.bankAddress.length || f.bankDetails.length || f.remittance || f.disclosure)) return '';
  const left = (f.paymentTitle ? '<div class="pay">' + esc_(f.paymentTitle) + '</div>' : '') +
    f.bankAddress.map(s => '<div>' + softText_(s) + '</div>').join('');
  const right = f.bankDetails.length
    ? '<table class="bank" style="width:auto;margin-left:auto">' + f.bankDetails.map(p =>
        '<tr><td class="lbl">' + esc_(p[0]) + (p[0] ? ':' : '') + '</td><td class="val">' + softText_(p[1]) + '</td></tr>').join('') +
      '</table>'
    : '';
  return '<div class="footer" style="page-break-inside:avoid">' +
    '<table><tr><td style="width:55%">' + left + '</td><td style="width:45%">' + right + '</td></tr></table>' +
    (f.remittance ? '<div class="remit">' + softText_(f.remittance) + '</div>' : '') +
    (f.disclosure ? '<div class="disclosure">' + softText_(f.disclosure) + '</div>' : '') +
    '</div>';
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
  PropertiesService.getUserProperties()
    .setProperty(settingsKey_(), JSON.stringify(sanitizeFormState_(mapping, options)));
}

/** Saved settings are keyed by the signed-in user's email (user properties are per user anyway). */
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

const META_JSON_KEYS = ['files', 'taxRates'];

function readMeta_(ss) {
  const sh = ss.getSheetByName(META_SHEET);
  if (!sh) return null;
  const meta = {};
  sh.getDataRange().getValues().forEach(r => { if (r[0] !== '') meta[r[0]] = r[1]; });
  if (!meta.folderId) return null;
  META_JSON_KEYS.forEach(k => {
    try { meta[k] = meta[k] ? JSON.parse(meta[k]) : (k === 'files' ? {} : null); } catch (e) { meta[k] = k === 'files' ? {} : null; }
  });
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
    [k, META_JSON_KEYS.indexOf(k) !== -1 ? JSON.stringify(meta[k] || (k === 'files' ? {} : null)) : String(meta[k] == null ? '' : meta[k])]);
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
      throw userError_('This spreadsheet is already being rebuilt (in another tab or by another person). Please try again in a minute.');
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
 * Text with letters (e.g. "8 hrs", "n/a") is invalid.
 */
function parseNumber_(v, decimalComma) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  if (/[A-Za-zÀ-ÿ]/.test(s.replace(/(CAD|USD|EUR)/gi, ''))) return NaN;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[\s  ']/g, '');     // spaces (incl. French no-break spaces) and 1'234 style
  if (/^[^\d.,]*-/.test(s)) negative = !negative; // leading minus, e.g. "-$5" or "$-5"
  s = s.replace(/[^0-9.,]/g, '');              // drop currency symbols and %
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

/** Money, the same in both languages: $1,234.50 / -$50.00 */
function formatMoney_(n) {
  const sign = n < 0 ? '-' : '';
  const parts = Math.abs(round2_(n)).toFixed(2).split('.');
  return sign + '$' + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
}

/** Units and percentages, the same in both languages: 24.5, 1,250, 9.975 */
function formatQty_(n) {
  const r = Math.round(Number(n) * 1000) / 1000;
  const parts = String(Math.abs(r)).split('.');
  return (r < 0 ? '-' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (parts[1] ? '.' + parts[1] : '');
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
