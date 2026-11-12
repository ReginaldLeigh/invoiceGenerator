/**
 * @fileoverview Morph - Invoice PDF Generator — Google Apps Script web app (version 3), server code.
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

// ---------------------------------------------------------------------------
// Shared data types (JSDoc)
// ---------------------------------------------------------------------------

/**
 * An uploaded file as the page sends it.
 * @typedef {Object} UploadFile
 * @property {string} name File name, e.g. "export.csv" or "export.xlsx".
 * @property {string} base64 The file's bytes, base64-encoded.
 */

/**
 * One extra detail or the group heading, as the form sends it.
 * @typedef {Object} ColumnLabel
 * @property {string} col Column letter(s), e.g. "X". Blank = not used.
 * @property {string} label Label printed before the value. Blank = print only the value.
 */

/**
 * Column letters the user entered on the form, keyed by field (see {@link FIELDS}),
 * plus the extra details and the grouping column.
 * @typedef {Object} FormMapping
 * @property {string} invoiceNumber Column letter of the invoice number (required).
 * @property {ColumnLabel[]} details Up to 10 extra details.
 * @property {ColumnLabel} groupBy The "Group line items by" column and heading label.
 */

/**
 * Options from the form.
 * @typedef {Object} FormOptions
 * @property {boolean} hasHeader The first row is a header row (skipped).
 * @property {boolean} combineEmployees One line per candidate / line type / rate, with a date range.
 * @property {string} dateFormat "auto", "mdy" or "dmy": how dates in the file are written.
 * @property {string} numberFormat "auto", "dot" (1,234.56) or "comma" (1 234,56).
 * @property {string} language Invoice language: "en" or "fr".
 * @property {string} outputMode "separate" (one PDF per invoice) or "combined" (one PDF).
 */

/**
 * The whole form: what presets and last-used settings store.
 * @typedef {Object} FormState
 * @property {FormMapping} mapping Column letters, details and grouping.
 * @property {FormOptions} options File and output options.
 */

/**
 * Column letters converted to 0-based indexes and checked ({@link normalizeMapping_}).
 * Each field key holds an index, or null when the field isn't mapped.
 * @typedef {Object} Mapping
 * @property {?number} invoiceNumber Column index of the invoice number.
 * @property {Array<{index: number, label: string}>} details Extra-detail columns and their labels.
 * @property {?{index: number, label: string}} groupBy Grouping column and heading label, or null.
 */

/**
 * Cleaned options used while building invoices.
 * @typedef {Object} Options
 * @property {string} language "en" or "fr".
 * @property {string} outputMode "separate" or "combined".
 * @property {boolean} combineEmployees Combine matching rows into one line.
 * @property {boolean} [hasHeader] Skip the first row.
 * @property {string} [dateFormat] "auto", "mdy" or "dmy".
 * @property {string} [numberFormat] "auto", "dot" or "comma".
 * @property {boolean} [decimalComma] Numbers like "14,975" mean 14.975.
 * @property {Object<string, number>} [taxRates] Rates in percent, keyed by {@link TAX_RATE_KEYS}.
 */

/**
 * What the preview shows ({@link previewFile}).
 * @typedef {Object} PreviewResult
 * @property {string[]} columns Column letters shown, A up to ZZ.
 * @property {string[][]} rows The first rows, cut to the shown columns.
 * @property {string[]} header The whole first row, every column (used to fill in labels).
 * @property {number} totalRows Rows in the file (hidden Excel rows left out).
 * @property {number} totalColumns Columns in the widest row.
 */

/**
 * One source row on an invoice, before lines are combined.
 * @typedef {Object} Item
 * @property {string} candidate Candidate name or role.
 * @property {string} workOrder Work order.
 * @property {string} purchaseOrder Purchase order.
 * @property {string} workDate Work date as yyyy-mm-dd (or as written when it isn't a date).
 * @property {string} lineType Line type, e.g. "Regular".
 * @property {number} units Units (0 when blank or invalid).
 * @property {number} unitPrice Rate (0 when blank or invalid).
 * @property {(number|string)} unitsCell What goes in the spreadsheet's Units cell.
 * @property {(number|string)} rateCell What goes in the spreadsheet's Rate cell.
 * @property {number} amount units × rate, rounded to the cent.
 * @property {string[]} details Extra-detail values, in the order of the labels.
 * @property {string} group Group value (blank = no heading).
 */

/**
 * One printed line on an invoice.
 * @typedef {Object} Line
 * @property {string} candidate Candidate name or role.
 * @property {string} workOrder Work order.
 * @property {string} purchaseOrder Purchase order.
 * @property {string} lineType Line type.
 * @property {string} group Group value.
 * @property {number} quantity Units (summed when lines are combined).
 * @property {number} unitPrice Rate.
 * @property {number} amount quantity × rate, rounded to the cent.
 * @property {string[]} dates Work dates (yyyy-mm-dd).
 * @property {string[][]} details Distinct values of each extra detail.
 */

/**
 * Lines under one group heading.
 * @typedef {Object} Group
 * @property {string} value Group value; blank for lines with no group (no heading).
 * @property {Line[]} lines The lines, in order.
 */

/**
 * A tax line printed under the subtotal.
 * @typedef {Object} TaxLine
 * @property {string} key Rate key (GST, PST, HST, NSHST, ONHST, PEI) or EXEMPT.
 * @property {?number} ratePct Rate in percent; null for EXEMPT.
 * @property {number} amount Tax amount, rounded to the cent.
 */

/**
 * One invoice, built by {@link groupInvoices_}.
 * @typedef {Object} Invoice
 * @property {string} number Invoice number.
 * @property {string} clientNumber Client number.
 * @property {string} invoiceDate Invoice date (yyyy-mm-dd).
 * @property {string} dueDate Payment due date (yyyy-mm-dd).
 * @property {string} customerName Client name.
 * @property {string} attention ATTN line.
 * @property {?Object<string, string>} address Address parts keyed by {@link ADDRESS_KEYS}, or null.
 * @property {string} taxCodeRaw The tax code as written in the data.
 * @property {string} taxCode The recognised tax code (EXEMPT when blank or unknown).
 * @property {Item[]} items Source rows.
 * @property {Line[]} lines Printed lines.
 * @property {Group[]} groups Lines under their headings.
 * @property {string} groupLabel Group heading label (blank = value only).
 * @property {string[]} detailLabels Extra-detail labels (blank = value only).
 * @property {Array<{type: string, units: number}>} unitsSummary Units per line type.
 * @property {number} subtotal Sum of the line amounts.
 * @property {TaxLine[]} taxes Tax lines.
 * @property {number} tax Total tax.
 * @property {number} total Subtotal + tax.
 */

/**
 * The result of grouping rows into invoices.
 * @typedef {Object} Grouped
 * @property {Invoice[]} invoices Invoices in order of first appearance.
 * @property {Array<{row: number, reason: string}>} skipped Rows that couldn't be invoiced.
 * @property {string[]} notes Rows that were invoiced with an adjustment (e.g. a blank rate counted as 0).
 * @property {string[]} detailLabels Extra-detail labels.
 */

/**
 * One call from the page, used for logs, error emails and metrics.
 * @typedef {Object} Run
 * @property {string} id Run id (also the job id for Generate).
 * @property {string} fn Name of the function the page called.
 * @property {string} user Signed-in user's email ('' when unknown).
 * @property {number} started Start time (ms since the epoch).
 * @property {string} stage Last progress stage logged.
 * @property {Object} context Extra details for error reports, e.g. the file name and size.
 */

/**
 * Logo, company block, footer and accent colour for one invoice language ({@link loadBranding_}).
 * @typedef {Object} Branding
 * @property {string} logo PNG logo as a data URI ('' = no logo).
 * @property {string} accent Accent colour, e.g. "#1f4e79".
 * @property {{address: string[], phone: string, gov: string[]}} company Internal address, phone and government numbers.
 * @property {{paymentTitle: string, bankAddress: string[], bankDetails: string[][], remittance: string, disclosure: string}} footer Invoice footer.
 * @property {boolean} footerAtBottom Put the footer at the bottom of the last page.
 * @property {string[]} warnings Problems to show the user (e.g. the logo couldn't be loaded).
 */

/**
 * Job details stored on the editable spreadsheet's hidden "_meta" tab.
 * @typedef {Object} SheetMeta
 * @property {string} version Spreadsheet layout version ({@link SHEET_VERSION}).
 * @property {string} jobId Job (run) id.
 * @property {string} sourceName Uploaded file name.
 * @property {string} folderId Job folder id.
 * @property {string} originalId Id of the copy of the uploaded file.
 * @property {(number|string)} itemsSheetId Sheet id of the Invoices tab.
 * @property {(number|string)} settingsSheetId Sheet id of the Settings tab.
 * @property {string} created When the job was made (ISO time).
 * @property {string} lastBuilt When the PDFs were last built (ISO time).
 * @property {(number|string)} busyUntil Rebuild lock expiry (ms), '' when free.
 * @property {string} grouping "true" when the job groups line items.
 * @property {Object<string, number>} taxRates The rates the job was made with.
 * @property {{perInvoice: Object<string, string>, combinedId: string, zipId: string}} files Ids of the PDFs and ZIP.
 */

/**
 * The PDFs written by {@link writePdfs_}.
 * @typedef {Object} PdfOutput
 * @property {Array<{number: string, customer: string, total: string, url: string}>} invoices One entry per invoice.
 * @property {?string} zipUrl Link to the ZIP (separate PDFs, more than one).
 * @property {?string} combinedUrl Link to the combined PDF, or to the only PDF.
 */

/**
 * What {@link renderFromSpreadsheet_} produces.
 * @typedef {Object} Built
 * @property {PdfOutput} output The PDFs.
 * @property {Array<{row: number, reason: string}>} skipped Rows not invoiced.
 * @property {string[]} notes Adjustment notes.
 * @property {string[]} warnings Problems to show (e.g. logo).
 * @property {Options} opts Options read from the Settings tab.
 * @property {Object} L Invoice wording for the language ({@link I18N}).
 * @property {SheetMeta} meta The job's metadata.
 * @property {GoogleAppsScript.Drive.Folder} folder The job folder.
 */

/**
 * What the results page shows after Generate or Rebuild.
 * @typedef {Object} JobResult
 * @property {boolean} rebuilt True after a Rebuild.
 * @property {string} jobId Job (run) id.
 * @property {string} folderName Job folder name.
 * @property {string} folderUrl Job folder link.
 * @property {string} sheetUrl Editable spreadsheet link.
 * @property {string} rebuildUrl Web app link that rebuilds this job ('' if not deployed).
 * @property {?string} originalUrl Link to the copy of the uploaded file.
 * @property {?string} zipUrl ZIP link.
 * @property {?string} combinedUrl Combined (or only) PDF link.
 * @property {Array<{number: string, customer: string, total: string, url: string}>} invoices One entry per invoice.
 * @property {Array<{row: number, reason: string}>} skipped Rows not invoiced.
 * @property {string[]} notes Adjustment notes.
 * @property {?string} emailedTo Who the email went to, or null.
 * @property {string[]} warnings Problems to show.
 */

/**
 * What the Tax rates card shows.
 * @typedef {Object} TaxState
 * @property {Object<string, number>} rates Current rates in percent.
 * @property {Object<string, number>} defaults Starting rates.
 * @property {string} updated When the rates were last changed (ISO time, '' = never).
 * @property {string} updatedBy Who changed them last.
 * @property {boolean} isAdmin The signed-in user may edit the rates.
 * @property {Array<{key: string, en: string, fr: string}>} rows Rate key with its English and French labels.
 */

/**
 * A saved form preset.
 * @typedef {Object} Preset
 * @property {string} name Preset name.
 * @property {FormMapping} mapping Column letters, details and grouping.
 * @property {FormOptions} options Options.
 * @property {Object<string, string>} headers Header text expected in each mapped column, e.g. {A: "Invoice #"}.
 * @property {string} updated When it was saved (ISO time).
 */

/**
 * The user's presets as the preset menu lists them.
 * @typedef {Object} PresetList
 * @property {Array<{name: string, updated: string, isDefault: boolean}>} presets Presets sorted by name.
 * @property {string} defaultName Name of the default preset ('' = none).
 */

/** @const {string} Name of the user's root Drive folder; each job gets a folder inside it. */
const ROOT_FOLDER_NAME = 'Morph - Invoice PDFs';
/** @const {string} User-property key caching the root folder's id (new key with the Morph name, so earlier test folders aren't reused). */
const ROOT_FOLDER_KEY = 'morphRootFolderId';
/** @const {number} Rows shown in the file preview. */
const MAX_PREVIEW_ROWS = 6;
/** @const {number} Columns shown in the preview: A–ZZ, a safety cap (later columns can still be mapped by letter). */
const MAX_PREVIEW_COLS = 702;
/** @const {number} Invoices listed one by one in the email; the rest are counted. */
const MAX_EMAIL_LINKS = 50;
/** @const {string} Name of the hidden tab holding a job's details. */
const META_SHEET = '_meta';
/** @const {number} How long a rebuild claim lasts (ms); a run can't last longer than 6 minutes. */
const REBUILD_TIMEOUT_MS = 7 * 60 * 1000;
/** @const {number} Most extra details per job. */
const MAX_DETAILS = 10;
/** @const {number} Most presets per user. */
const MAX_PRESETS = 30;
/** @const {number} Longest preset name (characters). */
const MAX_PRESET_NAME = 60;
/** @const {number} Largest preset (bytes); a UserProperties value can hold about 9 KB. */
const MAX_PRESET_BYTES = 8500;
/** @const {number} Largest logo file (bytes). */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
/** @const {string} Accent colour when Config.gs doesn't set a valid one. */
const DEFAULT_ACCENT = '#1f4e79';
/** @const {string} Prefix of the copy of the uploaded file in the job folder. */
const ORIGINAL_PREFIX = 'Original data - ';

// ---------------------------------------------------------------------------
// Form fields and the editable sheet layout
// ---------------------------------------------------------------------------

/**
 * Fields the user maps to column letters, shown in groups on the form.
 * @const {Array<{key: string, group: string, label: string, required: (boolean|undefined), hint: (string|undefined)}>}
 */
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

/** @const {string[]} Invoice-level fields (besides the address) taken from the first row of each invoice that has them. */
const INVOICE_FIELDS = ['clientNumber', 'invoiceDate', 'dueDate', 'customerName', 'attention'];
/** @const {string[]} Address parts, always taken together from one row. */
const ADDRESS_KEYS = ['address1', 'address2', 'address3', 'address4', 'city', 'province', 'postalCode', 'country'];

/** @const {string} Layout version of the editable spreadsheet; Rebuild only accepts this version. */
const SHEET_VERSION = '3';
/** @const {Object<string, number>} Column (0-based) of each field on the editable sheet's Invoices tab. */
const SHEET_MAP = {
  invoiceNumber: 0, clientNumber: 1, invoiceDate: 2, dueDate: 3, customerName: 4, attention: 5,
  address1: 6, address2: 7, address3: 8, address4: 9, city: 10, province: 11, postalCode: 12, country: 13,
  candidate: 14, workOrder: 15, purchaseOrder: 16, workDate: 17, lineType: 18, units: 19, unitPrice: 20,
  taxCode: 22,
};
/** @const {number} Amount column (V), calculated by a formula. */
const SHEET_AMOUNT_COL = 21;
/** @const {number} Group column (X); its header is the group heading label. */
const SHEET_GROUP_COL = 23;
/** @const {number} First extra-detail column (Y); details run to AH. */
const SHEET_DETAIL_START = 24;
/** @const {number} Columns A–X, before the extra details. */
const SHEET_BASE_WIDTH = 24;

/** @const {string[]} Rows of the editable "Settings" tab, in order. */
const SETTING_KEYS = ['language', 'outputMode', 'combineEmployees'];

// ---------------------------------------------------------------------------
// Taxes
// ---------------------------------------------------------------------------

/** @const {string[]} The editable rates (percent), stored once and shared by all users. QST = GST + PST. */
const TAX_RATE_KEYS = ['GST', 'HST', 'NSHST', 'ONHST', 'PEI', 'PST'];
/** @const {Object<string, number>} Starting rates in percent. */
const DEFAULT_TAX_RATES = { GST: 5, HST: 15, NSHST: 14, ONHST: 13, PEI: 15, PST: 9.975 };
/** @const {string} Script-property key of the shared rates. */
const TAX_RATES_PROP = 'taxRates';

/**
 * Tax codes accepted in the data. `parts` are the tax lines printed under the
 * subtotal (each one a key of the rates above); `aliases` are the English and
 * French spellings accepted. PST is a rate, not a code.
 * @const {Object<string, {parts: string[], aliases: string[]}>}
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
/** @const {string[]} Order in which tax codes are matched and listed. */
const TAX_CODE_ORDER = ['EXEMPT', 'GST', 'HST', 'NSHST', 'ONHST', 'PEI', 'QST'];

// ---------------------------------------------------------------------------
// Page layout (points, Letter portrait). Estimates used to split invoices into
// pages; tune after checking real PDFs from Google's converter.
// ---------------------------------------------------------------------------
// Calibrated against Chrome's rendering of the samples (measured: plain line 17.4pt,
// line with 2 details 37.7pt, column headings 19pt, group heading 17.5pt, condensed
// header 54pt, footer ~96pt), plus a safety margin for Google's converter.
/**
 * Page layout estimates in points (Letter portrait), used to split invoices into pages.
 * @const {Object<string, number>}
 */
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

/**
 * Invoice wording in English and French: headings, labels, columns, taxes, footer
 * labels, "Page X of Y". The `en` entry also holds the email text and the editable
 * spreadsheet text, which are English for every job.
 * @const {{en: Object, fr: Object}}
 */
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
      footer: 'Sent by Morph - Invoice PDF Generator.',
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
      rebuildManual: 'Open the Morph - Invoice PDF Generator web app and paste this spreadsheet\'s link to rebuild the PDF.',
      noLabel: '(no label)',
      folder: 'Drive folder',
      folderLabel: 'Open folder',
    },
  },
  fr: {
    locale: 'fr',
    headerLabels: ['N° de facture', 'N° de client', 'Date de facturation', 'Paiement dû au plus tard'],
    attn: 'ATTN:',
    confidential: 'PRIVÉE & CONFIDENTIELLE', // agrees with « facture » (feminine)
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
    footerLabels: { paymentTitle: 'Paiement par TEF', bankId: 'N° d\'institution bancaire', transit: 'N° succursale bancaire', account: 'N° de compte' },
    unitsTotal: 'Total',
    continued: '(suite)',
    page: (n, of) => 'Page ' + n + ' de ' + of,
  },
};

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/**
 * Serves the web form. Called by Apps Script when someone opens the web app.
 * A `?rebuild=<spreadsheetId>` parameter opens the page in rebuild mode.
 * @param {GoogleAppsScript.Events.DoGet} e The request; `e.parameter.rebuild` is an optional spreadsheet id.
 * @return {GoogleAppsScript.HTML.HtmlOutput} The page.
 */
function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  const id = String((e && e.parameter && e.parameter.rebuild) || '');
  t.rebuildId = /^[A-Za-z0-9_-]{20,100}$/.test(id) ? id : '';
  return t.evaluate()
    .setTitle('Morph - Invoice PDF Generator')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Everything the page needs when it opens: the field list, the user's email,
 * last-used settings, presets (and the full default preset), and the tax rates.
 * Called by the page with google.script.run. Logs a "page_open" line.
 * @return {{fields: Object[], userEmail: string, saved: ?FormState, presets: Object[], defaultName: string, defaultPreset: ?Preset, tax: TaxState, taxCodes: {en: string[], fr: string[]}}} The page set-up.
 * @throws {Error} Any unexpected error, with a reference the user can quote.
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

/**
 * Reads an uploaded file for the preview: the first rows of every column up to ZZ,
 * plus the whole header row so labels can be filled in for any column.
 * Rows hidden in Excel are left out. Called by the page.
 * @param {UploadFile} file The uploaded file.
 * @return {PreviewResult} What the preview shows.
 * @throws {Error} When the file can't be read or isn't a CSV or Excel file.
 */
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
 * Main action: builds the invoices from an upload. Creates the job folder, saves the
 * original file, writes the editable spreadsheet, builds the PDFs from it, emails the
 * links to the signed-in user and records the run metrics. Called by the page.
 * Files and the email always go to the signed-in user; any recipient in the request is ignored.
 * The run id is also the job id (folder name, results page, email, logs).
 * @param {Object} request What the form sends.
 * @param {UploadFile} request.file The uploaded file.
 * @param {FormMapping} request.mapping Column letters, extra details and grouping.
 * @param {FormOptions} request.options File and output options.
 * @return {JobResult} What the results page shows.
 * @throws {Error} A user message (e.g. a missing column letter), or an unexpected error with a reference.
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
 * Validates the request and reads the uploaded file into invoices. Creates no Drive files.
 * Labels are used exactly as typed: a blank label stays blank, so the invoice prints only the value.
 * @private
 * @param {{file: UploadFile, mapping: FormMapping, options: FormOptions}} request What the form sends.
 * @param {string} jobId Job id (names the temporary file used to read Excel files).
 * @param {Run} [run] The run, for progress logs.
 * @return {{mapping: Mapping, opts: Options, grouped: Grouped, notes: string[]}} The parsed upload.
 * @throws {Error} A user message when nothing can be invoiced or the mapping is invalid.
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
 * Existing PDFs are overwritten in place, so links that were already shared keep
 * working. Rebuilds don't produce run metrics. Called by the page.
 * @param {Object} request What the rebuild card sends.
 * @param {string} request.sheet The spreadsheet's link or id.
 * @param {boolean} [request.notify] Email the updated links to the signed-in user.
 * @return {JobResult} What the results page shows.
 * @throws {Error} When the spreadsheet can't be opened, wasn't made by this app, or is already being rebuilt.
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
    if (!meta) throw userError_('That spreadsheet was not created by Morph - Invoice PDF Generator, so it cannot be rebuilt.');
    if (String(meta.version) !== SHEET_VERSION) {
      throw userError_('This spreadsheet was made with an older version of Morph - Invoice PDF Generator, so it can\'t be rebuilt. ' +
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

/**
 * Builds the results-page data for a finished Generate or Rebuild.
 * @private
 * @param {Built} built The rendered job.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The editable spreadsheet.
 * @param {Array<{row: number, reason: string}>} skipped Rows not invoiced.
 * @param {string[]} notes Adjustment notes.
 * @param {?string} emailedTo Who the email went to, or null.
 * @param {string[]} warnings Problems to show.
 * @param {boolean} rebuilt True after a Rebuild.
 * @return {JobResult} What the results page shows.
 */
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

/**
 * Saves the uploaded file, byte for byte, in the job folder as "Original data - <name>".
 * @private
 * @param {GoogleAppsScript.Drive.Folder} folder The job folder.
 * @param {UploadFile} file The uploaded file.
 * @return {GoogleAppsScript.Drive.File} The saved copy.
 */
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

/**
 * The user's presets and the default preset's name.
 * @private
 * @return {PresetList} The preset list.
 */
function listPresetsImpl_() {
  return presetState_(PropertiesService.getUserProperties());
}

/**
 * Reads one preset, upgraded to the current form layout.
 * @private
 * @param {string} name Preset name (any capitalisation).
 * @return {Preset} The preset.
 * @throws {Error} When the preset doesn't exist.
 */
function getPresetImpl_(name) {
  const preset = readPreset_(PropertiesService.getUserProperties(), name);
  if (!preset) throw userError_('The preset "' + String(name || '') + '" no longer exists.');
  const form = sanitizeFormState_(preset.mapping, preset.options); // upgrades presets saved by older versions
  return Object.assign({}, preset, form);
}

/**
 * Saves the form as a preset. Saving under an existing name (any capitalisation)
 * replaces that preset. Without a file loaded, an update keeps the headers the preset remembered.
 * @private
 * @param {Object} request What the page sends.
 * @param {string} request.name Preset name (up to 60 characters).
 * @param {FormMapping} request.mapping Column letters, details and grouping.
 * @param {FormOptions} request.options Options.
 * @param {Object<string, string>} [request.headers] Header text of each mapped column in the loaded file.
 * @param {boolean} [request.makeDefault] Also make it the default preset.
 * @return {PresetList} The updated list, plus `saved` (the preset) and `replaced` (true if it existed).
 * @throws {Error} When the name is blank or too long, the user has 30 presets, or the preset is too large.
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

/**
 * Deletes a preset, and clears the default if it was the default.
 * @private
 * @param {string} name Preset name.
 * @return {PresetList} The updated list.
 */
function deletePresetImpl_(name) {
  const props = PropertiesService.getUserProperties();
  const key = presetKey_(cleanPresetName_(name));
  props.deleteProperty(key);
  if (props.getProperty(presetDefaultKey_()) === key) props.deleteProperty(presetDefaultKey_());
  return presetState_(props);
}

/**
 * Makes a preset the default (it fills in the form when the page opens). A blank name clears the default.
 * @private
 * @param {string} name Preset name, or '' to clear.
 * @return {PresetList} The updated list.
 * @throws {Error} When the preset doesn't exist.
 */
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
/**
 * Lists the signed-in user's presets. Called by the page.
 * @return {PresetList} The preset list.
 */
function listPresets() { return withRun_('listPresets', () => listPresetsImpl_()); }

/**
 * Reads one preset. Called by the page when a preset is chosen.
 * @param {string} name Preset name.
 * @return {Preset} The preset.
 * @throws {Error} When the preset doesn't exist.
 */
function getPreset(name) { return withRun_('getPreset', () => getPresetImpl_(name)); }

/**
 * Saves the form as a preset. Called by the page. See {@link savePresetImpl_}.
 * @param {Object} request Name, mapping, options, headers and makeDefault.
 * @return {PresetList} The updated list, with `saved` and `replaced`.
 * @throws {Error} When the preset can't be saved.
 */
function savePreset(request) { return withRun_('savePreset', () => savePresetImpl_(request)); }

/**
 * Deletes a preset. Called by the page.
 * @param {string} name Preset name.
 * @return {PresetList} The updated list.
 */
function deletePreset(name) { return withRun_('deletePreset', () => deletePresetImpl_(name)); }

/**
 * Sets or clears the default preset. Called by the page.
 * @param {string} name Preset name, or '' to clear.
 * @return {PresetList} The updated list.
 * @throws {Error} When the preset doesn't exist.
 */
function setDefaultPreset(name) { return withRun_('setDefaultPreset', () => setDefaultPresetImpl_(name)); }

/**
 * Saves new tax rates for everyone (admins only). Called by the page.
 * @param {Object<string, string>} rates Percentages keyed by GST, HST, NSHST, ONHST, PEI, PST.
 * @return {TaxState} The updated rates.
 * @throws {Error} When the user isn't an admin or a rate is invalid.
 */
function saveTaxRates(rates) { return withRun_('saveTaxRates', () => saveTaxRatesImpl_(rates)); }

/**
 * Restores the starting tax rates (admins only). Called by the page.
 * @return {TaxState} The updated rates.
 * @throws {Error} When the user isn't an admin.
 */
function resetTaxRates() { return withRun_('resetTaxRates', () => resetTaxRatesImpl_()); }

/**
 * Property-key prefix of the signed-in user's presets.
 * @private
 * @return {string} e.g. "preset:user@example.com:".
 */
function presetPrefix_() {
  return 'preset:' + currentUserEmail_().toLowerCase() + ':';
}
/**
 * Property key of one preset. Names match ignoring capitalisation.
 * @private
 * @param {string} name Preset name.
 * @return {string} The property key.
 */
function presetKey_(name) {
  return presetPrefix_() + encodeURIComponent(String(name).trim().toLowerCase());
}
/**
 * Property key that holds the default preset's key.
 * @private
 * @return {string} The property key.
 */
function presetDefaultKey_() {
  return 'presetDefault:' + currentUserEmail_().toLowerCase();
}

/**
 * Trims a preset name and collapses its spaces.
 * @private
 * @param {*} name The name as typed.
 * @return {string} The clean name.
 * @throws {Error} When the name is blank or over 60 characters.
 */
function cleanPresetName_(name) {
  const s = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!s) throw userError_('Please give the preset a name.');
  if (s.length > MAX_PRESET_NAME) throw userError_('Preset names can be up to ' + MAX_PRESET_NAME + ' characters.');
  return s;
}

/**
 * Reads one preset from user properties, upgraded to the current form layout.
 * @private
 * @param {GoogleAppsScript.Properties.Properties} props The user's properties.
 * @param {string} name Preset name.
 * @return {?Preset} The preset, or null if it doesn't exist or can't be read.
 */
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

/**
 * All of the user's presets, sorted by name, plus the default preset's name.
 * @private
 * @param {GoogleAppsScript.Properties.Properties} props The user's properties.
 * @return {PresetList} The preset list.
 */
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
 * Keeps only the known form fields, with length limits, in the shape the page sends
 * to {@link generateInvoices}. Used for presets and last-used settings. Values saved by
 * older versions are upgraded (e.g. Employee name → Candidate / Role); removed fields are dropped.
 * @private
 * @param {Object} rawMapping Column letters as stored or sent.
 * @param {Object} rawOptions Options as stored or sent.
 * @return {FormState} The clean form state.
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
 * The header text a preset expects in each mapped column, e.g. `{A: 'Invoice #'}`.
 * The page compares it with each new upload to catch a file in a different layout.
 * Columns that aren't mapped are dropped.
 * @private
 * @param {Object<string, string>} raw Header text by column letter.
 * @param {FormMapping} mapping The preset's column letters.
 * @return {Object<string, string>} Header text of the mapped columns only.
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

/**
 * Current tax rates: the stored rates merged over the defaults, plus who changed them last.
 * @private
 * @return {{rates: Object<string, number>, updated: string, updatedBy: string}} The rates.
 */
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

/**
 * What the Tax rates card shows.
 * @private
 * @return {TaxState} Rates, defaults, last change and whether the user is an admin.
 */
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

/**
 * Tax admin emails: CONFIG.TAX_ADMINS (Config.gs) plus the optional script property TAX_ADMINS.
 * @private
 * @return {string[]} Lower-case email addresses.
 */
function taxAdmins_() {
  const fromConfig = (cfg_().TAX_ADMINS || []).map(String);
  let fromProp = '';
  try { fromProp = PropertiesService.getScriptProperties().getProperty('TAX_ADMINS') || ''; } catch (e) { fromProp = ''; }
  return fromConfig.concat(fromProp.split(/[,;\s]+/))
    .map(s => s.trim().toLowerCase()).filter(s => s.indexOf('@') > 0);
}

/**
 * Whether the signed-in user may change the tax rates.
 * @private
 * @return {boolean} True for a tax admin.
 */
function isTaxAdmin_() {
  const me = currentUserEmail_().toLowerCase();
  return !!me && taxAdmins_().indexOf(me) !== -1;
}

/**
 * Stops unless the signed-in user is a tax admin.
 * @private
 * @throws {Error} When the user isn't a tax admin.
 */
function requireTaxAdmin_() {
  if (!isTaxAdmin_()) throw userError_('Tax rates can only be changed by an admin.');
}

/**
 * Validates and saves new tax rates (admins only).
 * @private
 * @param {Object<string, string>} rates Percentages, e.g. {GST: '5', HST: '15'}: 0–100 with up to 3 decimals.
 * @return {TaxState} The updated rates.
 * @throws {Error} When the user isn't an admin or a rate is invalid.
 */
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

/**
 * Restores the starting tax rates (admins only).
 * @private
 * @return {TaxState} The updated rates.
 * @throws {Error} When the user isn't an admin.
 */
function resetTaxRatesImpl_() {
  requireTaxAdmin_();
  writeTaxRates_(Object.assign({}, DEFAULT_TAX_RATES));
  return taxState_();
}

/**
 * Stores the shared tax rates with who changed them and when, under the script lock.
 * @private
 * @param {Object<string, number>} rates Rates in percent.
 */
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

/**
 * Recognises a tax code in English or French, any capitalisation, ignoring spaces and hyphens.
 * @private
 * @param {*} raw The tax code as written.
 * @return {?string} The code key (EXEMPT, GST, HST, NSHST, ONHST, PEI or QST), or null.
 * @example
 * normalizeTaxCode_('tvh')    // 'HST'
 * normalizeTaxCode_('ON-HST') // 'ONHST'
 * normalizeTaxCode_('HTS')    // null
 */
function normalizeTaxCode_(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[\s\-_.]/g, '');
  if (!s) return null;
  for (let i = 0; i < TAX_CODE_ORDER.length; i++) {
    if (TAX_CODES[TAX_CODE_ORDER[i]].aliases.indexOf(s) !== -1) return TAX_CODE_ORDER[i];
  }
  return null;
}

/**
 * Tax lines for an invoice. QST gives two lines (GST and PST); EXEMPT gives one $0.00 line.
 * @private
 * @param {string} code Recognised tax code.
 * @param {number} subtotal Invoice subtotal.
 * @param {Object<string, number>} rates Rates in percent.
 * @return {TaxLine[]} The tax lines.
 */
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

/** @const {string} App tag on every log line (an internal id for filtering logs). */
const APP_NAME = 'invoice-pdf-generator';
/** @const {number} The same error from the same user is emailed at most every 10 minutes. */
const DEV_EMAIL_REPEAT_SECONDS = 600;

/**
 * Starts a run: a new id, the function name, the signed-in user and the start time.
 * @private
 * @param {string} fnName Name of the function the page called.
 * @param {string} [runId] Id to use instead of a new one.
 * @return {Run} The run.
 */
function newRun_(fnName, runId) {
  return { id: runId || newJobId_(), fn: fnName, user: currentUserEmail_(), started: Date.now(), stage: 'start', context: {} };
}

/**
 * Writes one structured JSON log line (Apps Script → Executions / Cloud Logging):
 * `{app, runId, user, timestamp, function, stage, ...data}`. Logging never breaks a run.
 * @private
 * @param {Run} run The run.
 * @param {string} stage Progress stage, e.g. "file_read" or "pdfs_written".
 * @param {Object} [data] Extra fields for the line.
 * @param {string} [level] "warn" or "error"; anything else logs as info.
 * @return {Object} The logged entry.
 */
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

/**
 * An error caused by the user's input or permissions. It's shown to the user and
 * logged as a warning, but not emailed to the developer.
 * @private
 * @param {string} message What the user sees.
 * @return {Error} The error, marked `userFacing`.
 */
function userError_(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

/**
 * Runs a page call with "start" and "done" logs. User errors are logged and passed
 * on; unexpected errors are logged with the stack, emailed to DEV_EMAIL and replaced
 * by a message with a reference.
 * @private
 * @param {string} fnName Name of the function the page called.
 * @param {function(Run): *} fn The work to do.
 * @return {*} Whatever `fn` returns.
 * @throws {Error} The user error, or a message with the run's reference.
 */
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

/**
 * Logs an error and re-throws it in the form the page shows. Unexpected errors are
 * emailed to the developer and replaced by "Something went wrong (reference …)".
 * @private
 * @param {Run} run The run.
 * @param {Error} e The error.
 * @throws {Error} Always.
 */
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

/**
 * File name and approximate size for logs (never the contents).
 * @private
 * @param {?UploadFile} file The uploaded file.
 * @return {?{name: string, sizeBytes: number}} Name and size, or null.
 */
function fileInfo_(file) {
  if (!file) return null;
  return { name: String(file.name || ''), sizeBytes: Math.floor(String(file.base64 || '').length * 3 / 4) };
}

/**
 * Emails an unexpected error to CONFIG.DEV_EMAIL (in English, from the user's account),
 * at most once per 10 minutes for the same error from the same user. Failures are only logged.
 * @private
 * @param {Run} run The run.
 * @param {Error} e The error.
 */
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
      'An unexpected error happened in Morph - Invoice PDF Generator.',
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
      subject: '[Morph - Invoice PDF Generator] Error in ' + run.fn + ' (run ' + run.id + ')',
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
 * Run metrics for BigQuery: one row per client per Generate run. No timestamp
 * (the developer's library adds it).
 * @private
 * @param {Run} run The run.
 * @param {Invoice[]} invoices The invoices made.
 * @return {Array<Array<(string|number)>>} Rows of [runId, user, clientId, invoiceCount, runTimeMs].
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

/**
 * Logs the run metrics and hands them to sendRunMetrics_ (Config.gs). Never fails the run.
 * @private
 * @param {Run} run The run.
 * @param {Invoice[]} invoices The invoices made.
 * @return {Array<Array<(string|number)>>} The rows sent ([] on failure).
 */
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

/**
 * Sender name for emails (CONFIG.EMAIL_SENDER_NAME).
 * @private
 * @return {string} e.g. "Morph - Invoice PDF Generator (no reply)".
 */
function senderName_() {
  return cleanText_(cfg_().EMAIL_SENDER_NAME) || 'Morph - Invoice PDF Generator (no reply)';
}

/**
 * Small, stable string hash for cache keys.
 * @private
 * @param {string} s Any text.
 * @return {string} A short base-36 hash.
 */
function hash_(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Branding from Config.gs: logo, company block, footer, accent colour
// ---------------------------------------------------------------------------

/**
 * The developer settings from Config.gs.
 * @private
 * @return {Object} CONFIG, or {} when it's missing.
 */
function cfg_() {
  return typeof CONFIG !== 'undefined' && CONFIG ? CONFIG : {};
}

/**
 * The accent colour from Config.gs, or the default dark blue.
 * @private
 * @return {string} A "#rrggbb" colour.
 */
function accent_() {
  const c = String(cfg_().ACCENT_COLOR || '').trim();
  return /^#[0-9a-f]{6}$/i.test(c) ? c : DEFAULT_ACCENT;
}

/**
 * Mixes a colour with white, e.g. for group heading backgrounds.
 * @private
 * @param {string} hex A "#rrggbb" colour.
 * @param {number} amount How much white, 0 (none) to 1 (white).
 * @return {string} The tinted "#rrggbb" colour.
 */
function tint_(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = c => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return '#' + [r, g, b].map(v => ('0' + v.toString(16)).slice(-2)).join('');
}

/**
 * Text with surrounding spaces removed; null and undefined become ''.
 * @private
 * @param {*} v Any value.
 * @return {string} The trimmed text.
 */
const cleanText_ = v => String(v == null ? '' : v).trim();
/**
 * Trimmed, non-blank strings from an array.
 * @private
 * @param {*} a An array (anything else gives []).
 * @return {string[]} The clean list.
 */
const cleanList_ = a => (Array.isArray(a) ? a : []).map(cleanText_).filter(Boolean);
/**
 * A French value, or the English one when the French one is blank.
 * @private
 * @param {*} fr French text.
 * @param {*} en English text.
 * @return {string} The text to use.
 */
const pickText_ = (fr, en) => cleanText_(fr) || cleanText_(en);

/**
 * Logo, company block, footer and accent colour for one invoice language. The company
 * and bank details are the same in both languages; only the labels (and the two
 * footer sentences) follow the language.
 * @private
 * @param {string} lang "en" or "fr".
 * @return {Branding} The branding.
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

/**
 * Reads the PNG logo (CONFIG.LOGO_DRIVE_FILE_ID) from Drive as a data URI.
 * A missing, non-PNG, too-large (over 2 MB) or unreadable logo gives a warning instead.
 * @private
 * @return {{dataUri: string, warning: string}} The logo, or '' and a warning.
 */
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
 * Creates the editable Google Sheet (Invoices + Settings tabs) in the job folder.
 * The sheet is always in English; only the Tax code dropdown follows the invoice language.
 * The Invoices tab keeps one row per source record; invoice-level details are written
 * on each invoice's first row only, so one cell fixes the whole invoice. A blank label
 * is written as "(no label)".
 * @private
 * @param {GoogleAppsScript.Drive.Folder} folder The job folder.
 * @param {{mapping: Mapping, opts: Options, grouped: Grouped}} parsed The parsed upload.
 * @param {string} jobId Job id.
 * @param {string} sourceName Uploaded file name.
 * @param {string} [originalId] Id of the copy of the uploaded file.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet} The new spreadsheet.
 */
function createInvoiceSpreadsheet_(folder, parsed, jobId, sourceName, originalId) {
  const opts = parsed.opts, grouped = parsed.grouped;
  const L = I18N[opts.language];
  const S = I18N.en.sheet; // the spreadsheet is always in English; only the invoice text follows the language
  const labels = grouped.detailLabels || [];
  const grouping = !!parsed.mapping.groupBy;
  // An empty header means "no column" in the sheet, so a blank label is written as a marker instead.
  const sheetLabel = label => label ? cellText_(label) : S.noLabel;
  const groupHeader = grouping ? sheetLabel(parsed.mapping.groupBy.label) : '';
  const width = SHEET_BASE_WIDTH + labels.length;
  const accent = accent_();
  const ss = SpreadsheetApp.create(S.fileName(safeName_(sourceName.replace(/\.[^.]+$/, ''))));
  DriveApp.getFileById(ss.getId()).moveTo(folder);

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

/**
 * Reads the editable spreadsheet and (re)builds the PDFs in the job folder. Labels come
 * from the headers of columns X–AH; "(no label)" keeps a column but prints only its value.
 * Numbers typed as text are read the English way. The job's own tax rates are used.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The editable spreadsheet.
 * @param {Run} [run] The run, for progress logs.
 * @return {Built} The PDFs and what the results page needs.
 * @throws {Error} When a tab or the folder is missing, or no invoices are found.
 */
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
  opts.decimalComma = false;                  // the sheet is English: numbers typed as text use 1,234.56
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

/**
 * Whether a spreadsheet header is the "blank label" marker, "(no label)" (any capitalisation).
 * @private
 * @param {*} s Header text.
 * @return {boolean} True for the marker.
 */
function isNoLabel_(s) {
  const t = String(s || '').trim().toLowerCase();
  return t === I18N.en.sheet.noLabel.toLowerCase();
}

/**
 * "Label: value", or just "value" when the label is blank.
 * @private
 * @param {string} label Label (may be blank).
 * @param {string} value Value.
 * @return {string} The text as printed.
 */
function labelled_(label, value) {
  return label ? label + ': ' + value : value;
}

/**
 * Checks a stored set of tax rates.
 * @private
 * @param {*} r Rates keyed by {@link TAX_RATE_KEYS}.
 * @return {?Object<string, number>} The rates as numbers, or null if any is missing or invalid.
 */
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
 * Builds the PDFs, one per invoice (plus a ZIP when there are several) or one combined PDF.
 * Files recorded in `meta.files` from an earlier build are overwritten in place (same file,
 * same link; Drive keeps the old version). Files no longer needed (a deleted invoice, a
 * switched output mode) are trashed. The original data file is never touched.
 * Updates `meta.files`.
 * @private
 * @param {Invoice[]} invoices The invoices.
 * @param {Options} opts Output options.
 * @param {Object} L Invoice wording for the language ({@link I18N}).
 * @param {GoogleAppsScript.Drive.Folder} folder The job folder.
 * @param {SheetMeta} meta The job's metadata.
 * @param {Branding} branding Logo, company block and footer.
 * @return {PdfOutput} Links to the PDFs.
 */
function writePdfs_(invoices, opts, L, folder, meta, branding) {
  const prev = meta.files || {};
  const prevPer = prev.perInvoice || {};
  const next = { perInvoice: {} };
  let output;

  if (opts.outputMode === 'combined') {
    const name = (invoices.length === 1
      ? pdfBaseName_(invoices[0])
      : I18N.en.fileAll + ' - ' + safeName_(String(meta.sourceName || 'invoices').replace(/\.[^.]+$/, ''))) + '.pdf';
    const file = putFile_(folder, prev.combinedId, htmlToPdf_(invoicesHtml_(invoices, opts, L, branding), name));
    next.combinedId = file.getId();
    const url = file.getUrl();
    output = { invoices: invoices.map(inv => invoiceSummary_(inv, url)), zipUrl: null, combinedUrl: url };
    Object.keys(prevPer).forEach(k => trashFile_(prevPer[k]));
    trashFile_(prev.zipId);
  } else {
    const blobs = [];
    const results = invoices.map(inv => {
      const base = pdfBaseName_(inv);
      const pdf = htmlToPdf_(invoicesHtml_([inv], opts, L, branding), uniqueName_(base, blobs) + '.pdf');
      const file = putFile_(folder, prevPer[inv.number], pdf);
      next.perInvoice[inv.number] = file.getId();
      blobs.push(pdf);
      return invoiceSummary_(inv, file.getUrl());
    });
    Object.keys(prevPer).forEach(k => { if (!(k in next.perInvoice)) trashFile_(prevPer[k]); });
    let zipUrl = null;
    if (blobs.length > 1) {
      const zip = putFile_(folder, prev.zipId, Utilities.zip(blobs, zipName_(invoices)));
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

/**
 * File name (without ".pdf") of one invoice's PDF: the invoice number and the client name.
 * File names are always English.
 * @private
 * @param {Invoice} inv The invoice.
 * @return {string} e.g. "INV-1001 - Maple Productions", or "INV-1001" with no client name.
 * @example
 * pdfBaseName_({number: 'INV/7', customerName: 'Maple: West'}) // 'INV-7 - Maple- West' 
 */
function pdfBaseName_(inv) {
  return safeName_(inv.number) + (inv.customerName ? ' - ' + safeName_(inv.customerName) : '');
}

/**
 * ZIP file name: "All invoices - <client>.zip" when every invoice is for one client
 * (ignoring capitalisation and extra spaces; blank client names don't count),
 * otherwise "All invoices.zip".
 * @private
 * @param {Invoice[]} invoices The invoices in the ZIP.
 * @return {string} The ZIP file name.
 */
function zipName_(invoices) {
  const key = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const clients = {};
  let first = '';
  invoices.forEach(inv => {
    const k = key(inv.customerName);
    if (!k) return; // an invoice with no client name doesn't count as another client
    if (!first) first = inv.customerName;
    clients[k] = true;
  });
  const one = Object.keys(clients).length === 1;
  return I18N.en.fileAll + (one ? ' - ' + safeName_(String(first).replace(/\s+/g, ' ').trim()) : '') + '.zip';
}

/**
 * Overwrites an existing Drive file in place (same id and link) or creates a new one.
 * @private
 * @param {GoogleAppsScript.Drive.Folder} folder Where to create a new file.
 * @param {?string} existingId Id of the file to overwrite, if any.
 * @param {GoogleAppsScript.Base.Blob} blob The new contents and name.
 * @return {GoogleAppsScript.Drive.File} The file.
 */
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

/**
 * Moves a file to the trash. Missing files are ignored.
 * @private
 * @param {?string} id File id.
 */
function trashFile_(id) {
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* already gone */ }
}

/**
 * Converts invoice HTML to a PDF with Google's converter.
 * @private
 * @param {string} html The page HTML.
 * @param {string} name PDF file name.
 * @return {GoogleAppsScript.Base.Blob} The PDF.
 */
function htmlToPdf_(html, name) {
  return Utilities.newBlob(html, MimeType.HTML, 'invoice.html').getAs(MimeType.PDF).setName(name);
}

/**
 * One row of the results page and email list.
 * @private
 * @param {Invoice} inv The invoice.
 * @param {string} url Link to its PDF.
 * @return {{number: string, customer: string, total: string, url: string}} The row.
 */
function invoiceSummary_(inv, url) {
  return { number: inv.number, customer: inv.customerName, total: formatMoney_(inv.total), url: url };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Emails the links (PDFs, ZIP, spreadsheet, folder, original file, rebuild page) to the
 * user. Always in English, from the user's own account, with the no-reply sender name.
 * @private
 * @param {string} to Recipient (the signed-in user).
 * @param {Built} built The rendered job.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The editable spreadsheet.
 * @param {boolean} updated True after a Rebuild ("Updated:" subject).
 * @throws {Error} When the daily email quota is used up.
 */
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
 * Reads an uploaded CSV or Excel file. CSVs are decoded (UTF-8 or Windows-1252) and split
 * on the detected delimiter. Excel files are converted through a temporary Google Sheet,
 * and rows hidden in Excel (by a filter or by hand) are left out.
 * @private
 * @param {UploadFile} file The uploaded file.
 * @param {string} jobId Job id (names the temporary Google Sheet).
 * @return {{rows: Array<Array<*>>, rowNumbers: number[], decimalComma: boolean, notes: string[], hiddenRows: number}}
 *   Cell values, the file's own row numbers, whether numbers seem to use a decimal comma,
 *   notes, and how many hidden rows were left out.
 * @throws {Error} When no file is given or the type isn't supported.
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
 * Rows hidden by a filter or by hand, from one Sheets API call.
 * @private
 * @param {string} spreadsheetId The temporary Google Sheet.
 * @param {string} sheetName The tab to check.
 * @return {Object<number, boolean>} 0-based indexes of hidden rows, e.g. {3: true, 7: true}.
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
 * Cell values of a Google Sheet range. Dates become yyyy-MM-dd; numbers stay numbers
 * (so the sheet's locale can't confuse parsing), except percentages, which keep their "%".
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Range} range The range to read.
 * @param {string} tz The spreadsheet's time zone.
 * @return {Array<Array<*>>} The values.
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

/**
 * Decodes CSV bytes as UTF-8, falling back to Windows-1252 (common for CSVs saved by Excel
 * with accents). A byte-order mark is removed.
 * @private
 * @param {number[]} bytes The file's bytes.
 * @return {string} The text.
 */
function decodeText_(bytes) {
  let text = Utilities.newBlob(bytes).getDataAsString('UTF-8');
  if (text.indexOf('�') !== -1) text = Utilities.newBlob(bytes).getDataAsString('windows-1252');
  return text.replace(/^﻿/, '');
}

/**
 * Picks the CSV delimiter (",", ";" or tab) from the first line. French Excel saves CSVs with ";".
 * @private
 * @param {string} text The CSV text.
 * @return {string} The delimiter.
 */
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
 * Checks the column letters and converts them to 0-based indexes. Keys saved by older
 * versions (employeeName, description, quantity, customerAddress) are still accepted.
 * @private
 * @param {FormMapping} raw Column letters as sent by the form.
 * @return {Mapping} Column indexes, details and grouping.
 * @throws {Error} When a required field is missing or a letter is invalid.
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

/**
 * Cleans up the form options and fills in defaults. Never trusts the page.
 * @private
 * @param {Object} o Options as sent.
 * @return {Options} The clean options.
 */
function normalizeOptions_(o) {
  return Object.assign(normalizeLayoutOptions_(o), {
    hasHeader: !!o.hasHeader,
    numberFormat: ['dot', 'comma'].indexOf(o.numberFormat) !== -1 ? o.numberFormat : 'auto',
    dateFormat: ['dmy', 'mdy'].indexOf(o.dateFormat) !== -1 ? o.dateFormat : 'auto',
  });
}

/**
 * Options that control how invoices look. Shared by the web form and the spreadsheet's Settings tab.
 * @private
 * @param {Object} o Raw options (language, outputMode, combineEmployees).
 * @return {Options} Language, output mode and combine setting.
 */
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
 * Groups rows (single-line records) into invoices and computes their lines, groups,
 * units summary, subtotal, taxes and total.
 *
 * Rules:
 * - a fully blank row is ignored; a row with no invoice number is skipped and listed;
 * - Units or Rate that are blank or not numbers count as 0, with a note;
 * - invoice details come from the first row of the invoice that has them; the address
 *   comes whole from the first row that has any address part;
 * - the first tax code found applies to the whole invoice; unknown → EXEMPT, with a note.
 * @private
 * @param {Array<Array<*>>} rows The data rows (no header).
 * @param {Mapping} m Column indexes, details and grouping.
 * @param {Options} opts Options, including decimalComma and taxRates.
 * @param {number[]} [rowNums] The file's own row numbers, for messages.
 * @return {Grouped} Invoices, skipped rows, notes and detail labels.
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
 * Turns an invoice's items into printed lines. When combining, items with the same group,
 * candidate/role, line type, work order, purchase order and rate become one line: units
 * are added up, the work dates become a range, and differing detail values are listed.
 * @private
 * @param {Item[]} items The invoice's items.
 * @param {boolean} combine Combine matching items.
 * @return {Line[]} The lines.
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
 * Puts lines under group headings, in order of first appearance. Lines with no group
 * value come first, with no heading (value ''). With no group values at all, there is
 * a single headingless group.
 * @private
 * @param {Line[]} lines The lines.
 * @return {Group[]} The groups.
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

/**
 * Units per line type for one invoice. Types match ignoring case and extra spaces;
 * a blank type is listed as "Other" / "Autre".
 * @private
 * @param {Item[]} items The invoice's items.
 * @param {Object} L Invoice wording ({@link I18N}).
 * @return {Array<{type: string, units: number}>} Units per type, in order of first appearance.
 */
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

/**
 * Combines the address parts into printed lines: address 1–4, "City, ST  Postal", Country.
 * @private
 * @param {?Object<string, string>} p Address parts keyed by {@link ADDRESS_KEYS}.
 * @return {string[]} The address lines.
 * @example
 * formatClientAddress_({address1: '1 Main St', city: 'Toronto', province: 'ON', postalCode: 'm5v 1a1', country: 'Canada'})
 * // ['1 Main St', 'Toronto, ON  M5V 1A1', 'Canada']
 */
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
 * Day/month order for dates like 03/11/2026. With "auto", the first value that settles
 * it wins (a first number above 12 means day-first); if none does, it guesses day-first
 * for French-style files and month-first otherwise.
 * @private
 * @param {Array<Array<*>>} rows The data rows.
 * @param {Mapping} m Column indexes (invoice, due and work dates are checked).
 * @param {Options} opts Options (dateFormat, decimalComma, language).
 * @return {string} "mdy" or "dmy".
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

/**
 * Converts a date to yyyy-mm-dd. Anything that isn't a valid date is returned unchanged.
 * @private
 * @param {*} value The date as written, e.g. "2026-11-03", "03/11/2026" or "11-3-26".
 * @param {string} order "mdy" or "dmy", for dates like 03/11/2026.
 * @return {string} yyyy-mm-dd, the original text, or ''.
 * @example
 * normalizeDate_('03/11/2026', 'dmy') // '2026-11-03'
 * normalizeDate_('11-3-26', 'mdy')    // '2026-11-03' 
 */
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

/**
 * Formats a yyyy-mm-dd date as MM/DD/YYYY (both languages). Anything else is shown as written.
 * @private
 * @param {*} value The date.
 * @return {string} The printed date.
 */
function formatDate_(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (!m) return s;
  return ('0' + m[2]).slice(-2) + '/' + ('0' + m[3]).slice(-2) + '/' + m[1];
}

/**
 * The printed date or date range of a line.
 * @private
 * @param {string[]} dates The line's work dates.
 * @return {string} e.g. "11/03/2026" or "11/03/2026 – 11/05/2026".
 */
function formatDateSpan_(dates) {
  const isoDates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!isoDates.length) return dates.filter((d, i) => dates.indexOf(d) === i).join(', ');
  const a = isoDates[0], b = isoDates[isoDates.length - 1];
  return a === b ? formatDate_(a) : formatDate_(a) + ' – ' + formatDate_(b);
}

// ---------------------------------------------------------------------------
// PDF HTML: pages, header, body, summary, totals, footer
// ---------------------------------------------------------------------------

/**
 * The whole PDF page HTML for one or more invoices; each invoice starts on a new page.
 * Each page has the page number at the top right; the footer row (last page only) sits at the bottom.
 * @private
 * @param {Invoice[]} invoices The invoices.
 * @param {Options} opts Options.
 * @param {Object} L Invoice wording ({@link I18N}).
 * @param {Branding} branding Logo, company block and footer.
 * @return {string} A complete HTML document.
 */
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

/**
 * Wraps the pages in an HTML document with the invoice styles.
 * @private
 * @param {string[]} pages HTML of each page.
 * @param {string} accent Accent colour.
 * @return {string} A complete HTML document.
 */
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
 * The pages of one invoice. The full header is on page 1 and a condensed one after.
 * The units summary and totals are on the last page, and so is the footer: in its own
 * bottom row when FOOTER_AT_PAGE_BOTTOM is on, otherwise right after the totals.
 * @private
 * @param {Invoice} inv The invoice.
 * @param {Options} opts Options.
 * @param {Object} L Invoice wording ({@link I18N}).
 * @param {Branding} branding Logo, company block and footer.
 * @return {Array<{content: string, footer: string, number: string}>} Page HTML, footer HTML and "Page X of Y".
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

/**
 * Estimated number of printed lines for a text at a given number of characters per line.
 * @private
 * @param {*} s The text.
 * @param {number} per Characters per line.
 * @return {number} At least 1.
 */
const textLines_ = (s, per) => Math.max(1, Math.ceil(String(s || '').length / per));

/**
 * Estimated height of one line row. The first column stacks the name and the extra-detail
 * lines; the other columns sit beside it, so the row is as tall as the tallest column.
 * @private
 * @param {Line} ln The line.
 * @param {string[]} labels Extra-detail labels.
 * @return {number} Height in points.
 */
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

/**
 * Estimated height of the full header on page 1.
 * @private
 * @param {Invoice} inv The invoice.
 * @param {Branding} branding Company block.
 * @return {number} Height in points.
 */
function fullHeaderHeight_(inv, branding) {
  const block = lines => lines.reduce((n, s) => n + textLines_(s, 44), 0);
  const clientLines = textLines_(inv.customerName, 38) + (inv.attention ? textLines_('ATTN: ' + inv.attention, 44) : 0) +
    block(formatClientAddress_(inv.address));
  const companyLines = block(branding.company.address) + (branding.company.phone ? 1 : 0) + branding.company.gov.length;
  const details = [inv.number, inv.clientNumber].reduce((n, v) => n + textLines_(v, 22), 0) + 2;
  return Math.max(62, details * 13 + 10) + 10 + Math.max(clientLines, companyLines) * 12 + 24;
}

/**
 * Estimated height of the units summary, totals and footer on the last page.
 * @private
 * @param {Invoice} inv The invoice.
 * @param {Branding} branding Footer.
 * @return {number} Height in points.
 */
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
 * Splits an invoice's rows into pages using the height estimates in {@link PAGE}.
 * Each page gets the page number, a header (full on page 1, condensed after), the column
 * headings and as many rows as fit; the last page must also fit the summary, totals and
 * footer. Group headings stay with their next line and repeat with "(continued)".
 * @private
 * @param {Invoice} inv The invoice.
 * @param {Branding} branding Company block and footer (for the height estimates).
 * @return {Array<Array<{type: string, group: Group, line: Line, continued: boolean, h: number}>>}
 *   Rows of each page; a row is a group heading (`type: 'group'`) or a line (`type: 'line'`).
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

/**
 * Estimated height of a group heading row.
 * @private
 * @param {Invoice} inv The invoice (for its group label).
 * @param {Group} g The group.
 * @return {number} Height in points.
 */
function groupRowHeight_(inv, g) {
  return PAGE.GROUP_ROW + (textLines_(labelled_(inv.groupLabel, g.value) + ' (continued)', 100) - 1) * PAGE.TEXT_LINE;
}

/**
 * Escapes text for HTML and adds invisible break points (<wbr>) inside long unbroken words,
 * so long codes and names wrap inside their cell instead of overflowing. Words of 14
 * characters or fewer are untouched.
 * @private
 * @param {*} s The text.
 * @return {string} Safe HTML.
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

/**
 * The invoice details at the top right: Invoice #, Client #, Invoice Date, Payment Due Date.
 * @private
 * @param {Invoice} inv The invoice.
 * @param {Object} L Invoice wording ({@link I18N}).
 * @return {string} HTML table.
 */
function headerDetailsHtml_(inv, L) {
  const vals = [inv.number, inv.clientNumber, formatDate_(inv.invoiceDate), formatDate_(inv.dueDate)];
  return '<table class="hdr-details" style="width:auto;margin-left:auto">' +
    L.headerLabels.map((label, i) =>
      '<tr><td class="lbl">' + esc_(label) + '</td><td class="val" style="max-width:150pt">' + softText_(vals[i] || '') + '</td></tr>').join('') +
    '</table>';
}

/**
 * The logo image, or '' when there is no logo.
 * @private
 * @param {Branding} branding Branding with the logo data URI.
 * @param {number} heightPt Logo height in points.
 * @return {string} HTML.
 */
function logoHtml_(branding, heightPt) {
  return branding.logo ? '<img src="' + branding.logo + '" style="height:' + heightPt + 'pt" alt="">' : '';
}

/**
 * Full header (page 1): logo and invoice details, the client block and the company block,
 * then the confidentiality phrase.
 * @private
 * @param {Invoice} inv The invoice.
 * @param {Object} L Invoice wording ({@link I18N}).
 * @param {Branding} branding Logo and company block.
 * @return {string} HTML.
 */
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

/**
 * Condensed header (pages 2+): small logo, client name and invoice details.
 * @private
 * @param {Invoice} inv The invoice.
 * @param {Object} L Invoice wording ({@link I18N}).
 * @param {Branding} branding Logo.
 * @return {string} HTML.
 */
function condensedHeaderHtml_(inv, L, branding) {
  return '<table class="hdr">' +
    '<tr><td class="block" style="width:50%">' + logoHtml_(branding, 32) +
      '<div class="name" style="margin-top:4pt">' + softText_(inv.customerName || '') + '</div></td>' +
      '<td style="width:50%">' + headerDetailsHtml_(inv, L) + '</td></tr>' +
    '</table>';
}

/** @const {number[]} Width (%) of each of the 8 body columns. */
const COLUMN_WIDTHS = [21, 11, 11, 14, 10, 8, 11, 14];
/**
 * The 8-column body table for one page's rows. A blank group or detail label prints only the value.
 * @private
 * @param {Array<Object>} rows The page's rows from {@link paginateInvoice_}.
 * @param {Invoice} inv The invoice.
 * @param {Object} L Invoice wording ({@link I18N}).
 * @return {string} HTML table.
 */
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

/**
 * Units summary with its total (left) and subtotal, taxes and total (right).
 * @private
 * @param {Invoice} inv The invoice.
 * @param {Object} L Invoice wording ({@link I18N}).
 * @return {string} HTML.
 */
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

/**
 * Invoice footer: bank block, remittance line and disclosure. Empty settings print nothing.
 * @private
 * @param {Object} f The footer part of {@link Branding}.
 * @return {string} HTML, or '' when there's nothing to print.
 */
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
 * The user's root "Morph - Invoice PDFs" folder, created on first use. Its id is cached in
 * user properties; the lock stops two first-time submissions creating two folders.
 * @private
 * @return {GoogleAppsScript.Drive.Folder} The root folder.
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

/**
 * A new folder for one submission: "<date time> - <file name> (<job id>)".
 * The job id makes the name unique even within the same second.
 * @private
 * @param {string} sourceName Uploaded file name.
 * @param {string} jobId Job id.
 * @return {GoogleAppsScript.Drive.Folder} The job folder.
 */
function createJobFolder_(sourceName, jobId) {
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH-mm-ss');
  return getRootFolder_().createFolder(
    stamp + ' - ' + safeName_(String(sourceName || 'upload').replace(/\.[^.]+$/, '')) + ' (' + jobId + ')');
}

/**
 * Remembers the form as the user's last-used settings.
 * @private
 * @param {FormMapping} mapping Column letters.
 * @param {FormOptions} options Options.
 */
function saveSettings_(mapping, options) {
  PropertiesService.getUserProperties()
    .setProperty(settingsKey_(), JSON.stringify(sanitizeFormState_(mapping, options)));
}

/**
 * Property key of the user's last-used settings.
 * @private
 * @return {string} "settings:<email>".
 */
function settingsKey_() {
  const email = currentUserEmail_().toLowerCase();
  return email ? 'settings:' + email : 'settings';
}

/**
 * The signed-in user's email.
 * @private
 * @return {string} The email, or '' when it isn't available.
 */
function currentUserEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

// ---- Spreadsheet metadata (hidden "_meta" tab) and rebuild locking ----

/** @const {string[]} _meta keys stored as JSON. */
const META_JSON_KEYS = ['files', 'taxRates'];

/**
 * Reads the job details from the spreadsheet's hidden "_meta" tab.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The editable spreadsheet.
 * @return {?SheetMeta} The details, or null when the spreadsheet wasn't made by this app.
 */
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

/**
 * Writes the job details to the hidden, protected "_meta" tab (creating it the first time).
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The editable spreadsheet.
 * @param {SheetMeta} meta The details.
 */
function writeMeta_(ss, meta) {
  let sh = ss.getSheetByName(META_SHEET);
  if (!sh) {
    sh = ss.insertSheet(META_SHEET);
    sh.getRange('A1').setNote('Used by Morph - Invoice PDF Generator to find this job\'s files. Please do not edit.');
    sh.protect().setWarningOnly(true);
    sh.hideSheet();
  }
  const rows = Object.keys(meta).map(k =>
    [k, META_JSON_KEYS.indexOf(k) !== -1 ? JSON.stringify(meta[k] || (k === 'files' ? {} : null)) : String(meta[k] == null ? '' : meta[k])]);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, 2).setNumberFormat('@').setValues(rows);
}

/**
 * Marks the spreadsheet as being rebuilt, so two people (or tabs) can't rebuild it at once.
 * The script lock is held only for this quick check-and-set.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The editable spreadsheet.
 * @throws {Error} When it's already being rebuilt.
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

/**
 * Clears the "being rebuilt" mark. If this fails, the mark expires on its own.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The editable spreadsheet.
 */
function releaseSpreadsheet_(ss) {
  try {
    const meta = readMeta_(ss);
    meta.busyUntil = '';
    writeMeta_(ss, meta);
    SpreadsheetApp.flush();
  } catch (e) { /* the marker expires on its own */ }
}

/**
 * Finds a tab by its sheet id.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss The spreadsheet.
 * @param {(number|string)} id Sheet id.
 * @return {?GoogleAppsScript.Spreadsheet.Sheet} The tab, or null.
 */
function sheetById_(ss, id) {
  if (id === '' || id == null) return null;
  return ss.getSheets().filter(sh => String(sh.getSheetId()) === String(id))[0] || null;
}

/**
 * The spreadsheet id from a Google Sheets link or a bare id.
 * @private
 * @param {*} input A link or id.
 * @return {string} The id, or ''.
 */
function extractSpreadsheetId_(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/d\/([A-Za-z0-9_-]{20,})/) || s.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : '';
}

/**
 * Web app link that opens the page in rebuild mode for a spreadsheet.
 * @private
 * @param {string} spreadsheetId The spreadsheet id.
 * @return {string} The link, or '' when the web app isn't deployed.
 */
function rebuildUrl_(spreadsheetId) {
  let base = '';
  try { base = ScriptApp.getService().getUrl() || ''; } catch (e) { base = ''; }
  return base ? base + '?rebuild=' + encodeURIComponent(spreadsheetId) : '';
}

/**
 * A spreadsheet HYPERLINK formula with quotes escaped.
 * @private
 * @param {string} url Link.
 * @param {string} label Text shown.
 * @return {string} The formula.
 */
function hyperlink_(url, label) {
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  return '=HYPERLINK(' + q(url) + ',' + q(label) + ')';
}

/**
 * Text for a spreadsheet cell. A leading ' stops values like "=..." or "+1 call" being read as formulas.
 * @private
 * @param {*} v The value.
 * @return {string} Safe cell text.
 */
function cellText_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/**
 * A new 10-character job (run) id.
 * @private
 * @return {string} The id.
 */
function newJobId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Column letters to a 0-based index.
 * @private
 * @param {string} letters Upper-case letters.
 * @return {number} The index.
 * @example
 * colToIndex_('A')  // 0
 * colToIndex_('AA') // 26
 */
function colToIndex_(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/**
 * A 0-based index to column letters.
 * @private
 * @param {number} i The index.
 * @return {string} The letters.
 * @example
 * indexToCol_(0)   // 'A'
 * indexToCol_(701) // 'ZZ' 
 */
function indexToCol_(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  }
  return s;
}

/**
 * Parses English and French number styles. When a value has both "," and ".", whichever
 * comes last is the decimal separator. With only one kind, `decimalComma` decides: true
 * reads "14,975" as 14.975 (French), false reads it as 14975 (English). Currency symbols,
 * spaces and % are ignored; text with letters (e.g. "8 hrs") is invalid.
 * @private
 * @param {*} v The value.
 * @param {boolean} decimalComma Single commas are decimal separators.
 * @return {number} The number, or NaN when empty or invalid.
 * @example
 * parseNumber_('$1,234.50', false) // 1234.5
 * parseNumber_('1 234,50 $', true) // 1234.5
 * parseNumber_('(5.00)', false)    // -5
 * parseNumber_('8 hrs', false)     // NaN
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

/**
 * Rounds to the cent.
 * @private
 * @param {number} n The amount.
 * @return {number} The rounded amount.
 */
function round2_(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/**
 * Money, the same in both languages.
 * @private
 * @param {number} n The amount.
 * @return {string} e.g. "$1,234.50" or "-$50.00".
 */
function formatMoney_(n) {
  const sign = n < 0 ? '-' : '';
  const parts = Math.abs(round2_(n)).toFixed(2).split('.');
  return sign + '$' + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + parts[1];
}

/**
 * Units and percentages, the same in both languages: thousands separators, up to 3 decimals.
 * @private
 * @param {(number|string)} n The value.
 * @return {string} e.g. "24.5", "1,250" or "9.975".
 */
function formatQty_(n) {
  const r = Math.round(Number(n) * 1000) / 1000;
  const parts = String(Math.abs(r)).split('.');
  return (r < 0 ? '-' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (parts[1] ? '.' + parts[1] : '');
}

/**
 * Escapes text for HTML.
 * @private
 * @param {*} s The text.
 * @return {string} Safe HTML text.
 */
function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A Drive-safe file name: characters Drive can't use become "-", up to 80 characters.
 * @private
 * @param {*} s The name.
 * @return {string} The safe name ("untitled" when empty).
 */
function safeName_(s) {
  return String(s).replace(/[\\/:*?"<>|#]+/g, '-').trim().slice(0, 80) || 'untitled';
}

/**
 * Avoids duplicate PDF names inside one job by adding " (2)", " (3)"…
 * @private
 * @param {string} base File name without ".pdf".
 * @param {GoogleAppsScript.Base.Blob[]} existingBlobs PDFs already named.
 * @return {string} A unique name without ".pdf".
 */
function uniqueName_(base, existingBlobs) {
  const taken = {};
  existingBlobs.forEach(b => { taken[b.getName()] = true; });
  let name = base, i = 2;
  while (taken[name + '.pdf']) name = base + ' (' + i++ + ')';
  return name;
}
