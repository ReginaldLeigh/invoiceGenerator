/**
 * DEVELOPER SETTINGS for Invoice PDF Generator.
 *
 * Edit the values below, save, then publish a new version so users get them:
 *   Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy
 * (Editing the existing deployment keeps the same web app URL and Rebuild links.)
 *
 * Full step-by-step instructions: README.md → "Developer setup".
 * The values marked STAND-IN / PLACEHOLDER are temporary and must be replaced.
 */
const CONFIG = {
  // Logo shown top-left on every invoice: the Google Drive file ID of a PNG.
  // Leave '' for no logo. The file must be viewable by everyone who uses the app
  // (see README → "Add the logo").
  LOGO_DRIVE_FILE_ID: '',

  // Company block, top-right under the invoice details, next to the client address.
  // One set per invoice language. Printed in this order: address lines (the first
  // line is the business name, shown bold in the accent colour), then "T. " + phone.
  // A French value left blank uses the English one.
  // STAND-IN VALUES: replace them.
  COMPANY: {
    en: {
      address: ['ABC Store', '123 Front Street', 'Orlando, FL 30029'],
      phone: '725-555-6458',
    },
    fr: {
      address: ['ABC Store', '123 Front Street', 'Orlando, FL 30029'],
      phone: '725-555-6458',
    },
  },

  // Government registration numbers, printed under the phone. Enter each number
  // ONCE; the labels and which lines appear depend on the invoice language:
  //   English: "HST/GST # <gstHst>", then "QST # <qst>"
  //   French:  "TVH/TPS # <gstHst>", then "TVQ # <qst>", then "Permis QC <quebecPermit>"
  // A number left blank ('') hides its line.
  // PLACEHOLDERS: replace them.
  GOVERNMENT_NUMBERS: {
    gstHst: '000000000 RT0001',   // GST/HST registration number (= TPS/TVH)
    qst: '0000000000 TQ0001',     // Quebec QST registration number (= TVQ)
    quebecPermit: '000000',       // Quebec permit number (French invoices only)
  },

  // Invoice footer, one set per invoice language. Printed on the last page of
  // each invoice: payment title + bank address (left), bank details (right),
  // then the remittance line and the disclosure paragraph.
  // A French value left blank uses the English one.
  // STAND-IN VALUES: replace them.
  FOOTER: {
    en: {
      paymentTitle: 'EFT Payment',
      bankAddress: ['JP Morgan Trust', '1234 Alexander Street', 'Saint-Laurent QC H4R 1Y8'],
      bankDetails: [
        ['Bank ID', '007'],
        ['Bank Transit', '12345'],
        ['Account #', '12312312323'],
      ],
      remittance: 'Please send your remittance information to: remit_info@gmail.com',
      disclosure: 'This is the only invoice you will receive. Please forward to your accounts payable ' +
        'department. Any required adjustments will be carried out subsequent to payment. If you have ' +
        'any questions regarding this invoice, please contact help_me@gmail.com. Thank you for using ' +
        'FrontStreet. We appreciate your business.',
    },
    fr: {
      paymentTitle: 'Paiement par TEF',
      bankAddress: ['JP Morgan Trust', '1234, rue Alexander', 'Saint-Laurent (Québec) H4R 1Y8'],
      bankDetails: [
        ["N° d'institution", '007'],
        ['N° de transit', '12345'],
        ['N° de compte', '12312312323'],
      ],
      remittance: 'Veuillez envoyer vos renseignements de versement à : remit_info@gmail.com',
      disclosure: 'Ceci est la seule facture que vous recevrez. Veuillez la transmettre à votre service ' +
        'des comptes fournisseurs. Tout ajustement requis sera effectué après le paiement. Pour toute ' +
        'question concernant cette facture, veuillez communiquer avec help_me@gmail.com. Merci ' +
        "d'utiliser FrontStreet. Nous vous remercions de votre confiance.",
    },
  },

  // Accent colour used on every invoice, spreadsheet header and email button.
  ACCENT_COLOR: '#1f4e79', // dark blue

  // Where "Page X of Y" goes: 'bottom' (default) or 'top'. Switch to 'top' only if
  // page numbers don't land at the bottom of the page in the generated PDFs.
  PAGE_NUMBER_POSITION: 'bottom',

  // Emails allowed to change tax rates in the web app, e.g. ['ana@company.com'].
  // Admins can also be added WITHOUT publishing a new version: Project Settings →
  // Script properties → property TAX_ADMINS, value "ana@company.com, ben@company.com".
  TAX_ADMINS: [],
};
