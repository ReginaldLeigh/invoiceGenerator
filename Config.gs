/**
 * DEVELOPER SETTINGS for Invoice PDF Generator.
 *
 * Edit the values below, save, then publish a new version so users get them:
 *   Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy
 * (Editing the existing deployment keeps the same web app URL and Rebuild links.)
 *
 * Full step-by-step instructions: README.md → "Developer setup".
 * The values marked STAND-IN / PLACEHOLDER are temporary and must be replaced.
 *
 * English and French invoices use the SAME company and bank details; only the
 * labels around them change with the invoice language.
 */
const CONFIG = {
  // Logo shown top-left on every invoice: the Google Drive file ID of a PNG.
  // Leave '' for no logo. The file must be viewable by everyone who uses the app
  // (see README → "Add the logo").
  LOGO_DRIVE_FILE_ID: '',

  // Company block, top-right next to the client address. Printed in this order:
  // address lines (the first line is the business name, bold in the accent
  // colour), then "T. " + phone. STAND-IN VALUES: replace them.
  COMPANY: {
    address: ['ABC Store', '123 Front Street', 'Orlando, FL 30029'],
    phone: '725-555-6458',
  },

  // Government registration numbers, printed under the phone. Enter each number
  // ONCE; the labels and which lines appear depend on the invoice language:
  //   English: "HST/GST # <gstHst>", then "QST # <qst>"
  //   French:  "TVH/TPS # <gstHst>", then "TVQ # <qst>", then "Permis QC <quebecPermit>"
  // A number left blank ('') hides its line. PLACEHOLDERS: replace them.
  GOVERNMENT_NUMBERS: {
    gstHst: '000000000 RT0001',   // GST/HST registration number (= TPS/TVH)
    qst: '0000000000 TQ0001',     // Quebec QST registration number (= TVQ)
    quebecPermit: '000000',       // Quebec permit number (French invoices only)
  },

  // Bank details in the invoice footer (last page). The labels ("EFT Payment",
  // "Bank ID", "Bank Transit", "Account #" / French equivalents) are added
  // automatically. A value left blank hides its line. STAND-IN VALUES: replace them.
  BANK: {
    address: ['JP Morgan Trust', '1234 Alexander Street', 'Saint-Laurent QC H4R 1Y8'],
    bankId: '007',
    transit: '12345',
    account: '12312312323',
  },

  // The two sentences in the footer, one version per invoice language.
  // A French value left blank uses the English one. STAND-IN VALUES: replace them.
  FOOTER_TEXT: {
    en: {
      remittance: 'Please send your remittance information to: remit_info@gmail.com',
      disclosure: 'This is the only invoice you will receive. Please forward to your accounts payable ' +
        'department. Any required adjustments will be carried out subsequent to payment. If you have ' +
        'any questions regarding this invoice, please contact help_me@gmail.com. Thank you for using ' +
        'FrontStreet. We appreciate your business.',
    },
    fr: {
      remittance: 'Veuillez envoyer vos renseignements de versement à : remit_info@gmail.com',
      disclosure: 'Ceci est la seule facture que vous recevrez. Veuillez la transmettre à votre service ' +
        'des comptes fournisseurs. Tout ajustement requis sera effectué après le paiement. Pour toute ' +
        'question concernant cette facture, veuillez communiquer avec help_me@gmail.com. Merci ' +
        "d'utiliser FrontStreet. Nous vous remercions de votre confiance.",
    },
  },

  // true: the bank details, remittance line and disclosure sit at the bottom of
  // the last page. false: they follow straight after the totals.
  FOOTER_AT_PAGE_BOTTOM: true,

  // Accent colour used on every invoice, spreadsheet header and email button.
  ACCENT_COLOR: '#1f4e79', // dark blue

  // Emails are sent from the signed-in user's own Google account (Apps Script
  // can't send from another address). This is the sender name people see.
  EMAIL_SENDER_NAME: 'Invoice PDF Generator (no reply)',

  // Unexpected errors (not user mistakes) are emailed here, at most once per
  // 10 minutes for the same error and user.
  DEV_EMAIL: 'reggie.leigh@gmail.com',

  // Emails allowed to change tax rates in the web app, e.g. ['ana@company.com'].
  // Admins can also be added WITHOUT publishing a new version: Project Settings →
  // Script properties → property TAX_ADMINS, value "ana@company.com, ben@company.com".
  TAX_ADMINS: [],
};

/**
 * Run metrics hand-off (one row per client per Generate run):
 *   rows = [[runId, user, clientId, invoiceCount, runTimeMs], ...]
 * The rows are always written to the logs. To send them to BigQuery through
 * your existing library, add the library (Editor → Libraries +) and replace the
 * marked line below with its call. Errors here never fail a run.
 */
function sendRunMetrics_(rows) {
  if (!rows || !rows.length) return;
  // >>> DEVELOPER: call your BigQuery library here, e.g.
  // MyBqLib.send(rows);
}
