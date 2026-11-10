# Plan: Canadian tax codes, admin-editable rates, new invoice layout + units summary

## Context
The app is being adapted to how the business actually invoices Canadian clients:
1. **Tax codes.** A mapped tax code column picks fixed Canadian taxes, with English or French labels. This replaces the free-form tax rate and tax name.
2. **Editable rates.** Rates change with legislation, so admins (added later by the developer) can change them for every user's future invoices.
3. **New invoice layout.** A header with logo, invoice and client numbers, client block, internal address and "PRIVATE & CONFIDENTIAL". An 8-column body. A **units summary per line type** next to the totals, and an **invoice footer** with bank (EFT) details, a remittance contact and a disclosure statement.

All three change the same functions (`FIELDS`, `groupInvoices_`, `invoiceBodyHtml_`, the editable sheet layout), so they ship together as **sheet version 3**.

## Confirmed decisions

**Tax codes**
- Tax codes accepted in the data: EXEMPT 0 · GST 5% · HST 15% · NSHST 14% · ONHST 13% · PEI 15% · QST.
- French: EXEMPT · TPS (=GST) · TVH (=HST) · NETVH (=NSHST) · ONTVH (=ONHST) · IPE (=PEI) · QST.
- **QST is the only code that prints two lines** under the subtotal. English: **GST 5% + PST 9.975%**. French: **TPS 5% + TVQ 9.975%** (numbers in English style on both versions).
- **PST is not a tax code.** It exists only as the second line of a QST invoice. `PST` (or `TVQ`) in the data's tax code column is treated like any other unrecognised code (→ EXEMPT, with a note).
- Tax is calculated on the invoice subtotal. Blank or unrecognised code → EXEMPT. If an invoice's rows have different codes, the first code applies to the whole invoice.

**Rates**
- Editable as percentages. **The rate editor has six fields, labelled GST, HST, NSHST, ONHST, PEI and PST.** Each change also applies to the matching French label (TPS, TVH, NETVH, ONTVH, IPE, TVQ).
- **There is no QST field.** QST is the code that appears in user data, and it's always calculated as the GST rate + the PST rate (French: TPS + TVQ). Changing either field changes QST invoices. The editor shows one line of help text under the fields: "QST invoices use GST + PST."
- PST is a rate field only. It is still **not** a tax code in the data, so `PST` in the tax code column is unrecognised → EXEMPT, with a note.
- One shared set for all users; only admins can edit. **Admins are added later by the developer in `CONFIG.TAX_ADMINS` in `Config.gs`** (see "Developer setup"). Until then, everyone sees the rates read-only.
- Jobs keep the rates they were made with, so Rebuild doesn't use rates changed later.

**Layout**
- **Header:** logo (PNG, added later by the developer) top-left. Top-right: Invoice #, Client #, Invoice Date, Payment Due Date. Under the logo: client name, `ATTN:` line (mapped column, hidden when blank), then the client's address. It is built from separate mapped columns (see "Client address" below). To the right of the client block: the **company block**, in the invoice language: internal address, then phone, then the government registration lines (2 in English, 3 in French). Stand-in values are used until the developer replaces them in `Config.gs`. Under the client block, the confidentiality phrase follows the invoice language: English invoices show **PRIVATE & CONFIDENTIAL**; French invoices show **PRIVÉ ET CONFIDENTIEL**, and only French invoices do. No invoice shows both.
- **Client address (confirmed):** the data has the address in separate columns, and the form gets a field for each: **Address 1, Address 2, Address 3, Address 4, City, State / Province, Postal code, Country** (all optional).
  - The backend combines them into a printed block:
    ```
    Address 1
    Address 2          (each of lines 1–4 only if not blank)
    Address 3
    Address 4
    City, ST  Postal   e.g. "Toronto, ON  M5V 1L9" or "Orlando, FL  30029"
    Country            (only if not blank)
    ```
    - **City line format (confirmed):** "City, ST  Postal". It leaves out whatever is blank, with no stray commas (e.g. "Toronto, ON" or "M5V 1L9" alone).
    - Postal codes print as given, trimmed and upper-cased (`m5v 1l9` → `M5V 1L9`).
    - **Country is always shown when present, including "Canada" (confirmed).**
  - **Client block order (confirmed):** client name (**bold, in the accent colour (confirmed)**, matching the company's business name) → `ATTN:` line (only if mapped and filled) → Address 1 → Address 2 → Address 3 → Address 4 (each on its own line, stacked) → city line → country.
  - **The first instance per invoice is used (confirmed):** the whole address is taken from the **first row of that invoice that has any address column filled in**. All eight parts come from that one row, never mixed across rows, so an address can't end up half from one record and half from another.
- **Payment due date is a mapped column, per invoice.** Each invoice uses the first non-blank due date among its rows, so rows left blank under the first one are fine. If none of its rows has one, the value is left **blank** (the "Payment Due Date" label still shows, with no date). Client # and Invoice Date work the same way, so all four labels always appear.
- **Body:** 8 columns: Candidate | Work Order | Purchase Order | Period | Type | Unit(s) | Rate | Amount. On French invoices: Candidat | Référence | Bon de commande | Période | Type | Unité(s) | Taux | Montant.
- **Below the body:** units summary on the left, subtotal / taxes / total on the right.
- **Invoice footer** (on every invoice, after the totals), fully translated on French invoices:
  1. **Bank information**, as a 2-column block:
     - Left: **EFT Payment**, then the bank address (JP Morgan Trust / 1234 Alexander Street / Saint-Laurent QC H4R 1Y8).
     - Right: Bank ID: 007 · Bank Transit: 12345 · Account #: 12312312323.
  2. Under it, the remittance line: "Please send your remittance information to: remit_info@gmail.com".
  3. Then the disclosure statement (full text under Developer setup).
  - These values are stand-ins. Like the company block, they live in `Config.gs` (`CONFIG.FOOTER.en` / `.fr`) so the developer can replace them.
  - The **Footer text box is removed** from the form and from the sheet's Settings tab.
- **Units summary** covers that invoice only: units per line type, no total row.
- **Page numbers** at the **bottom of each page**, restarting for every invoice, including inside the combined PDF: "Page 1 of 2" / "Page 1 de 2".
- **Multi-page invoices:**
  - Page 1 has the full **Invoice Header**; later pages have a **condensed header** (small logo, the 4 invoice fields, client name). The **body's column headings** repeat on **every** page.
  - The **units summary, totals and Invoice Footer** appear **only on the last page**.
- **All dates from the data print as MM/DD/YYYY** on the invoice, in **both** English and French: invoice date, payment due date and the Period column. A combined line's range prints as `11/03/2026 – 11/05/2026`, and a single day as `11/03/2026`.
- **Units replaces Hours.**
- **Data comes from a database as single-line records (confirmed):** every row carries all of its own invoice details (invoice #, client, dates, tax code, etc.). Every non-empty row with an invoice number becomes one line item. There are no details-only rows.
- **Invalid Units or Rate become 0 (confirmed):** a Units or Rate value that isn't a valid number (e.g. `abc`, `8 hrs`), **or is blank**, is invoiced as **0**. The results page notes it, e.g. *"Row 14 (INV-1002): Units "8 hrs" is not a number. 0 was used."* No row is dropped for this.
- **Hidden Excel rows are ignored (confirmed):** rows hidden by an Excel filter **or hidden by hand** aren't invoiced, and the results page says how many were left out. Anything not visible in Excel isn't billed.
- **QST is calculated separately, not compounded (confirmed).** Example on a $1,556.00 subtotal: GST 5% = $77.80, PST 9.975% = $155.21, Total (CAD) = $1,789.01.
- **The Notes field is removed (confirmed).** It's a different thing from Extra Details: Notes was one free-text message per invoice under the totals, while Extra Details are small lines under each line item. Extra Details stay.
- **Line Type is a separate, required field (confirmed)** on every invoice, and it feeds the Type column and the units summary.
- **Candidate and Role / description are merged into one field (confirmed): "Candidate / Role"**, **optional (confirmed)**. The first column is always headed **Candidate** / **Candidat**, and is empty for rows without a value.
- **Blank cells are still invoiced (confirmed).** A row is never dropped just because optional cells (or Line Type) are empty.
- **Copy of the original file (confirmed):** every job folder also gets an untouched copy of the uploaded file, named "**Original data - <file name>**", in its original format (CSV or Excel), for later checking.
  - It's saved before any processing.
  - Rebuild never changes it.
  - Its link appears on the results page and in the email ("Original data file" / "Fichier de données d'origine").
- **Units and Rate use the English number format on both languages (confirmed):** `24.5`, `$45.00`.
- **Extra details are kept**, printed as small lines under the first column's text.
- **Line-item groups (new, optional):** on the form, the user gives a **column letter** whose value groups the line items (e.g. Project Number), plus an optional **heading label**.
  - Within each invoice, lines are gathered under one **group heading row** per distinct value, e.g. "**Project Number: P-1001**", with that group's line items beneath it.
  - **Line items, the units summary and the totals are unchanged.** Grouping only orders the lines and adds headings, with no group subtotals.
  - Each group heading is set off with the **accent colour**: a full-width row with a light dark-blue tint, a solid dark-blue bar on the left and bold dark-blue text. This keeps it distinct from the solid column-heading bar.
  - If the column is left blank on the form, there is no grouping, the same as today.
- **Business name, address and email fields are removed** from the form.
- **Tax rate and Tax name fields are removed.**
- **The "Email the link to" field is removed.** Files and the email always go to **the signed-in person who submits the form**, so a submission can't send invoices or Drive access to anyone else:
  - The page no longer has a recipient box. It shows a read-only line instead: "The link will be emailed to **you@company.com** (your Google account)."
  - The server ignores any recipient sent from the page and uses `Session.getActiveUser().getEmail()`. If that can't be read, the job stops with "We couldn't confirm your Google account. Reload the page and sign in again."
  - **Sharing the job folder with another person is removed** (`shareWithRecipient_` goes), so nobody else is given Drive access automatically. Users can still share files themselves in Drive.
  - Presets no longer store a recipient. Older presets that have one simply ignore it.
  - Rebuild's "Email me the updated links" already goes only to the person rebuilding; that stays.

## Assumptions (change any of these)
1. **No title (confirmed):** the "INVOICE" / "FACTURE" heading is removed. Top-right shows only the four fields.
2. **Units summary:** line types are grouped ignoring case and extra spaces, shown in order of first appearance. **It lists only each line type and its units, with no Total row (confirmed).** Line Type is required on the form, but a row whose line-type cell is **empty** is still invoiced. It's summarised as "Other" / "Autre", and the results page notes which rows had no line type. The summary uses each invoice's rows before combining, so it's the same with Combine on or off.
3. **Combine rows:** rows merge only when the group value, Candidate / Role, line type, work order, purchase order and rate all match. So the same employee in two projects stays one line in each project. A different type or rate (e.g. overtime) stays a separate line.
4. **Required on the form:** Invoice number, Client name, Line type and Rate. Candidate / Role is optional.
5. **Blank invoice number (assumption):** since every record should carry its own invoice number, a row with a blank invoice number is **skipped and listed** ("Row 9: no invoice number, so it can't be placed on an invoice"). The old "join the invoice above" rule is removed, so a row can't land on the wrong client's invoice. **Blank Units** now means **0** (per the rule above), replacing the old "blank = 1".
6. **Client email is removed** from the form because the new header doesn't print it. **Notes** is removed (confirmed). With the accent colour gone too, **step 3 (Business details) is removed from the form entirely**.
   - **Currency (confirmed):** amounts look the same on English and French invoices: **`$1,234.50`** (dollar sign first, comma thousands, point decimals). The **Currency symbol field is removed** from the form and the sheet's Settings tab.
     - Units and rates are also English-style on French invoices (confirmed), and so are the units summary totals. Tax percentages are English-style on French invoices too (confirmed): `TVQ (9.975%)`. Every number on the invoice looks the same; only the words are French.
   - **Final total label (confirmed):** "**Total (CAD)**" on both English and French invoices. Subtotal and tax lines don't get "(CAD)".
   - **Accent colour (confirmed):** **removed from the form**, so every invoice looks the same. It stays **dark blue `#1f4e79`**, set once by the developer as `CONFIG.ACCENT_COLOR` in `Config.gs`. It also leaves the sheet's Settings tab and presets. Older presets or sheets that carry a colour simply ignore it.
7. **Two small typo fixes in the disclosure:** "Any **required** adjustments" (was "require") and "If you have any **questions**" (was "question"). Easy to revert if the original wording is intended.
8. **Footer position:** the footer follows the totals with clear spacing. Google's HTML-to-PDF converter can't reliably pin content to the very bottom of the page, so it isn't fixed there. On a long invoice it appears after the last line.
9. **Developer settings live in one new file, `Config.gs`**, covering the logo, the company details (address, phone, government info), the invoice footer (bank details, remittance line, disclosure), with English and French versions of each, and tax admins. The full design and the developer instructions are in the **Developer setup** section below.
10. **Older spreadsheets:** spreadsheets created before this update (versions 1 and 2) **can't be rebuilt**, because their columns don't hold the new fields. The page says "This spreadsheet was made with an older version. Generate it again from the original file." This replaces the earlier plan to keep the old rate logic, which avoids maintaining two layouts. Nothing has been deployed yet, so no real jobs are affected.
11. Tax codes **ignore capitalisation (confirmed)**; spaces or hyphens are also ignored, and the French spellings are accepted. Unrecognised or mixed codes add a non-blocking **note** (confirmed). Each tax line is rounded to the cent. **EXEMPT invoices show an "EXEMPT" tax line with $0.00 (confirmed).**
12. French labels: Candidat · **Référence** (in place of Work Order, confirmed) · Bon de commande · Période · Type · Unité(s) · Taux · Montant; N° de facture · N° de client · **Date de facturation** (Invoice Date, confirmed) · **Paiement dû au plus tard** (Payment Due Date, confirmed); **"ATTN:" is the same in both languages (confirmed)**; « Sommaire des unités » (confirmed). English summary title: "Units summary".
13. **How page numbers work:** Google's HTML-to-PDF converter has no automatic page numbering, so the app splits each invoice into pages itself:
    - Each line's height is estimated from its text length, wrapping and number of extra-detail lines.
    - **Page 1** starts with the full Invoice Header. **Later pages use a condensed header (confirmed):**
      - a smaller logo (about ½ inch) on the left;
      - Invoice #, Client #, Invoice Date and Payment Due Date on the right;
      - the client name under the logo.
      - The address, company block and confidentiality phrase are left out of later pages.
      - Every page has the column headings, then as many lines as fit.
    - The last page must have room for the units summary, totals and footer. If it doesn't, the last few lines move to a new page with them, so the totals never sit alone on a page.
    - Each page is a fixed-height block with "Page X of Y" in its bottom-right corner.
    - The page size and the estimates are named constants, so they can be tuned once real PDFs are checked.
    - A **developer switch, `CONFIG.PAGE_NUMBER_POSITION: 'bottom'`**, can be set to `'top'` if Google's converter doesn't honour the fixed page height. In that case the number moves to the top-right of each page. This gets checked on the first deployment.
14. **Dates:** MM/DD/YYYY replaces the month-name formats ("November 3, 2026", "3 nov. 2026") on invoices. Dates are still read from the file as before (auto-detecting day/month order, or the form's choice). Text that can't be read as a date is printed as written. The editable spreadsheet keeps `yyyy-mm-dd`, and emails don't show dates.
15. **Group details:**
    - Groups appear in the order their value first appears in the invoice's rows. Lines keep their original order within a group.
    - The heading label defaults to the grouping column's header (e.g. "Project Number"), like extra details. If there is no header row, it's "Group" / "Groupe".
    - Rows with a **blank** group value get **no heading (confirmed)**, just like an invoice without grouping. They're listed **first, before the first heading**, so they can't look like part of the group above them. If no row in an invoice has a value, that invoice shows no headings at all.
    - Grouping is per invoice, so different invoices can have different groups.
    - **Order:** groups appear in order of first appearance (confirmed).
    - **Across pages:** a heading is never left alone at the bottom of a page; it moves to the next page with at least one of its lines. When a group continues onto a new page, its heading repeats there with "(continued)" / "(suite)".
    - The grouping column can be any column, including one already used elsewhere (e.g. Purchase Order).
16. **Paper is always portrait (Letter) (confirmed).** There is no landscape option. The body table uses a smaller font (about 9pt) so the 8 columns fit. This will be checked by rendering the samples.

## Developer setup: logo, company details (address, phone, government info), footer, tax admins

### The code structure (`Config.gs`, a new file)
```js
/**
 * DEVELOPER SETTINGS. Edit the values below, save, then publish a new version
 * (Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy).
 * Full instructions: README → "Developer setup".
 */
const CONFIG = {
  // Logo shown top-left on every invoice. The Google Drive file ID of a PNG.
  // Leave '' for no logo. The file must be viewable by everyone who uses the app.
  LOGO_DRIVE_FILE_ID: '',

  // Company block, top-right under the invoice details, next to the client address.
  // One set per invoice language. Printed in this order: address lines, phone.
  // A blank French value uses the English one.
  // STAND-IN VALUES below: the developer replaces them later.
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
  // A number left blank hides its line. PLACEHOLDERS below: the developer replaces them.
  GOVERNMENT_NUMBERS: {
    gstHst: '000000000 RT0001',       // GST/HST registration number (= TPS/TVH)
    qst: '0000000000 TQ0001',         // Quebec QST registration number (= TVQ)
    quebecPermit: '000000',           // Quebec permit number (French invoices only)
  },

  // Invoice footer, one set per invoice language. STAND-IN VALUES: replace later.
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

  // Emails allowed to change tax rates in the web app. Example: ['ana@company.com']
  TAX_ADMINS: [],
};
```
- **Logo:** `loadBranding_()` reads the PNG once per job (`DriveApp.getFileById(id).getBlob()`) and embeds it in the PDF as a data URI, so the PDF never links back to Drive. It is shown at most ~70px (about ¾ inch) tall, keeping its proportions.
  - If the ID is blank, the logo area is left empty.
  - If the file can't be read (wrong ID, or not shared with that user), the invoices are **still generated without the logo**, and the results page shows "The logo couldn't be loaded. Ask the developer to check the logo's sharing settings."
  - If the file isn't a PNG, or is over 2 MB, the same thing happens with a matching message.
- **Tax admins:** `isTaxAdmin_()` checks the signed-in user's email against `CONFIG.TAX_ADMINS`, ignoring capitalisation and spaces.
  - It **also** accepts a script property `TAX_ADMINS` (comma-separated). This optional backup lets the developer add an admin from *Project Settings → Script properties* **without publishing a new version**.
  - Either list alone is enough. Both empty means nobody can edit, and the rates stay read-only at their defaults.
- **Company block (internal address, phone, government information):**
  - Chosen by invoice language: `COMPANY.en` for English invoices and `COMPANY.fr` for French ones.
  - Printed right-aligned, in this order: address lines, with the **business name (first line) in bold and in the accent colour (confirmed)**; then the phone line; then the government registration lines (slightly smaller, muted).
  - **Government lines differ by language (confirmed):**
    - **English:** `HST/GST # <number>`, then `QST # <number>`.
    - **French:** `TVH/TPS # <number>`, then `TVQ # <number>`, then `Permis QC <number>`.
    - The labels are fixed in the code (`I18N`). The developer enters each number once in `CONFIG.GOVERNMENT_NUMBERS`. The GST/HST number is the same as TPS/TVH, and QST is the same as TVQ, so they're shared between languages.
    - A number left blank hides its line.
    - **Assumption:** the stand-ins are obvious placeholders (`000000000 RT0001`, `0000000000 TQ0001`, `000000`), so nobody mistakes them for real numbers in test PDFs.
  - The phone prints as **"T. 725-555-6458"** on both English and French invoices (confirmed).
  - **The language chosen on the form decides every translation (confirmed).** `COMPANY.fr` and `FOOTER.fr` hold the French text, used when the user picks Français. As a safety net, a French entry left completely blank shows the English text instead of an empty spot. Blank lines are skipped, and an empty block leaves the space empty.
  - **It ships with the stand-in values above** (ABC Store, 123 Front Street, Orlando, FL 30029, phone 725-555-6458, and placeholder registration numbers), so test invoices show the full layout.
- `Config.gs` is added to `.claspignore`'s allow-list so `clasp push` includes it.

### Instructions for the developer (go in the README as "Developer setup")

**Add the logo (needs a Google Drive file)**
1. Prepare a PNG. Wide, transparent-background logos look best; about 600 px wide and under 1 MB is plenty.
2. Upload it to Google Drive, ideally into a shared drive or a folder owned by the company account, so it doesn't disappear if someone leaves.
3. Share it so **everyone who uses the app can view it**. The app runs as each signed-in user, so each user's account opens the logo:
   - Right-click the file → **Share** → under *General access*, choose **"Anyone in [your organization] with the link" → Viewer**.
   - If some users sign in with accounts outside your organization (e.g. personal Gmail), choose **"Anyone with the link" → Viewer** instead.
4. Copy the file ID. Right-click → **Share → Copy link**. The ID is the part between `/d/` and `/view`:
   `https://drive.google.com/file/d/`**`1AbC…xyz`**`/view?usp=sharing`
5. In the Apps Script editor, open **Config.gs** and paste the ID: `LOGO_DRIVE_FILE_ID: '1AbC…xyz',`
6. Save, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. Editing the existing deployment keeps the same web app URL and the Rebuild links working.
7. Check it: generate an invoice from `sample-1-basic-en.csv` and confirm the logo appears top-left. If the results page says the logo couldn't be loaded, re-check step 3.
- To **change** the logo later, either replace the file in Drive (*Manage versions → Upload new version* keeps the same ID, so no code change or redeploy is needed) or paste a new ID and repeat step 6.

**Replace the stand-in company details (no Drive item needed)**
1. In **Config.gs**, under `COMPANY.en`, replace the stand-ins:
   - `address`: one line per entry; the first line prints as the business name, in bold and in the accent colour.
   - `phone`: the number only; "T. " is added in front automatically.
2. Do the same under `COMPANY.fr`. Anything left blank there uses the English value.
3. Under `GOVERNMENT_NUMBERS`, replace the placeholders. Each is entered once and used on both versions:
   - `gstHst`: the GST/HST registration number. It prints as "HST/GST #" in English and "TVH/TPS #" in French.
   - `qst`: the QST registration number. It prints as "QST #" in English and "TVQ #" in French.
   - `quebecPermit`: the Quebec permit number. It prints as "Permis QC" on **French invoices only**.
   - Leave a value as `''` to hide that line.
4. Publish a new version (step 6 above).

**Replace the stand-in footer (no Drive item needed)**
1. In **Config.gs**, under `FOOTER.en`, edit:
   - `paymentTitle`;
   - `bankAddress`: one line per entry;
   - `bankDetails`: label and value pairs, shown on the right in this order. Add or remove pairs as needed;
   - `remittance` and `disclosure`.
2. Do the same under `FOOTER.fr` in French. Anything left blank there uses the English value.
3. Publish a new version (step 6 above).

**Add tax admins (no Drive item needed)**
- **Option A, in code:** add their emails to `TAX_ADMINS` in **Config.gs**, then publish a new version (step 6 above).
- **Option B, no redeploy:** in the Apps Script editor go to **Project Settings (⚙️) → Script properties → Add script property**, set Property `TAX_ADMINS` and Value `ana@company.com, ben@company.com`, then **Save**. This takes effect the next time the admin opens or reloads the web app.
- Admins see editable inputs on the **Tax rates** card; everyone else sees the rates read-only. To remove an admin, delete their email from the list.

**Notes**
- Existing invoices aren't changed by any of these settings. Only jobs generated (or rebuilt) afterwards show the new logo and address. Tax rate changes apply only to newly generated jobs, as decided earlier.
- None of these settings need users to approve new permissions (the app already has Drive access). The update itself adds the Sheets API (for hidden Excel rows), so each user approves permissions once after it's deployed.

## Changes

### `Code.gs`: form fields (`FIELDS`)
| Group | Fields (required ✱) |
|---|---|
| Invoice | Invoice number ✱, Client number, Invoice date, Payment due date |
| Client | Client name ✱, Attention (ATTN), Address 1, Address 2, Address 3, Address 4, City, State / Province, Postal code, Country |
| Work / line items | Candidate / Role, Work order, Purchase order, Work date (Period), Line type ✱, Units (blank or invalid = 0, with a note), Rate ✱ (blank or invalid = 0, with a note) |
| Other | Tax code (blank or unknown = EXEMPT) |

`employeeName` and `description` are merged into one key, **`candidate`** (label "Candidate / Role"). Presets saved with either old key move it to `candidate` when loaded. `customerEmail`, `customerAddress`, `quantity`, `description` and `taxRate` are removed; `normalizeMapping_`, the validation messages and `sanitizeFormState_` update with them. Presets keep working; fields that no longer exist are dropped when a preset loads.

### `Code.gs`: grouping and totals
- `groupInvoices_`: reads the new invoice-level fields from each invoice's first row that has them (as today). Each item records `workOrder`, `purchaseOrder`, `lineType` and `units`.
- **New `unitsSummary_(items, L)`** returns `[{ type, units }]`, one entry per line type, with no overall total.
- **Grouping:** `normalizeMapping_` reads `raw.groupBy = { col, label }` (optional; same validation as an extra detail). The label defaults to the column's header in `parseUpload_`, like extra details.
  - Each item stores `group`. New **`groupLines_(lines, L, label)`** returns `[{ heading, lines }]` in first-appearance order, with blank-value lines first and without a heading. When no row has a value, it returns a single group with no heading.
  - `inv.groups` is what the PDF renders. `inv.lines`, totals and the units summary are untouched.
- `buildLines_`: the combine key adds the group value, line type, work order and purchase order. When combining, differing work orders or purchase orders on otherwise identical lines are listed comma-separated, like extra details are now.
- Tax: `TAX_CODES`, `DEFAULT_TAX_RATES`, `normalizeTaxCode_`; `inv.taxes = [{ key, ratePct, amount }]`; notes go into `warnings`. This is the same design as before.

### `Code.gs`: shared tax rates (unchanged from the earlier plan)
- ScriptProperties `taxRates`, merged over the defaults. `isTaxAdmin_()` checks `CONFIG.TAX_ADMINS` plus the optional script property `TAX_ADMINS`, read fresh each time. `saveTaxRates()` and `resetTaxRates()` are admin-only, validated (0–100, up to 3 decimals) and run under a script lock. `getConfig()` returns the rates and admin status. Each job's rates are recorded in `_meta`.

### `Code.gs`: PDF layout (`wrapHtml_`, `invoiceBodyHtml_`)
Tables only, because Google's HTML-to-PDF converter has no flexbox or grid:
1. **Header**, a 2-column table:
   - Row 1: logo (`<img>` data URI, max height ~70px) | 4-row details table (no title).
   - Row 2: client block (name bold in the accent colour, ATTN, then the combined address from `formatClientAddress_(parts)`) | company block (right-aligned: business name bold in the accent colour, the remaining address lines, "T. " + phone, then government lines in smaller muted text).
   - Row 3: the confidentiality phrase in the invoice language (PRIVATE & CONFIDENTIAL or PRIVÉ ET CONFIDENTIEL; bold, letter-spaced).
2. **Body:** the 8-column table. When grouping is on, each group starts with a heading row: one `<td colspan="8">` with a light tint of the accent colour as background, a 4px accent-colour left border, and bold accent-colour text "Label: value". The group's lines follow. Pagination counts heading rows, keeps each heading with at least one line, and repeats it with "(continued)" on the next page. The first column (**Candidate** / **Candidat**) holds the Candidate / Role value, plus extra details (small, indented). Unit(s), Rate and Amount are right-aligned. **All numbers use the English format in both languages** (`formatQty_` and `formatMoney_` ignore the language). The column header row uses the accent colour, and alternate rows are shaded light grey, as now.
3. **Summary row**, a 2-column table: units summary table (Type | Unit(s), one row per line type, no total row) | totals table (Subtotal, one row per tax line, **Total (CAD)**). `formatMoney_` always uses the English format `$1,234.50`, whatever the language; the currency option is removed. Every accent colour comes from `CONFIG.ACCENT_COLOR`.
4. **Invoice footer** (`invoiceFooterHtml_(L, footer)`), separated from the totals by a thin accent-coloured rule:
   - A 2-column table: left is **EFT Payment** (bold) plus the bank address lines; right is the label: value rows (Bank ID, Bank Transit, Account #), right-aligned.
   - Then the remittance line, then the disclosure paragraph (small, muted, justified).
   - Everything comes from `CONFIG.FOOTER[language]`, with French blanks falling back to English. Missing pieces are skipped, and an empty footer prints nothing.
   - `page-break-inside: avoid` keeps the footer in one piece where the converter honours it.
5. **Pages and page numbers:**
   - **New `paginateInvoice_(inv, opts)`** splits `inv.lines` into pages using a points budget (`PAGE_HEIGHT_PT` and estimates for the header, each line, the summary, totals and footer).
   - `invoiceBodyHtml_` renders each page as a fixed-height table: a top-aligned content cell, plus a bottom row with "Page X of Y" right-aligned in small muted text.
   - Page 1 uses the full Invoice Header (`invoiceHeaderHtml_`). Later pages use `invoiceHeaderCondensedHtml_` (small logo, the 4 detail fields, client name). Every page repeats the column header row, and the pagination budget uses the smaller header height for pages 2 and on. The summary, totals and footer render only on the last page. Each page except an invoice's last gets `page-break-after: always`, and each invoice starts on a new page, as now.
   - With `PAGE_NUMBER_POSITION: 'top'`, the number goes in a top row instead.
6. **Dates:** `formatDate_` and `formatDateSpan_` output `MM/DD/YYYY`, with ranges joined by " – ". The language-specific month formats are removed from `I18N`.
- Wording for both languages is added to `I18N`. New `loadBranding_(language)` reads the logo once per run, wrapped in try/catch, and picks `CONFIG.COMPANY[language]`, falling back to English values.

### `Code.gs`: editable sheet version 3
- **Invoices tab:** A Invoice # · B Client # · C Invoice date · D Payment due date · E Client · F ATTN · G–J Address 1–4 · K City · L State / Province · M Postal code · N Country · O Candidate / Role · P Work order · Q Purchase order · R Work date · S Line type · T Units · U Rate · V Amount (formula treats a non-numeric or blank Units/Rate as 0: `IFERROR(VALUE(T),0)*IFERROR(VALUE(U),0)`, applied as an ARRAYFORMULA) · W Tax code (dropdown) · **X Group** (its header is the group heading label; rename it to change the label) · Y–AH extra details.
- Address parts stay in separate columns in the sheet too, so a correction is a single cell. The address is combined again on Rebuild.
- Settings tab gets no new row; the label lives in the X header, like extra-detail labels. `_meta` records `grouping: true/false`.
- `SHEET_BASE_WIDTH`, the column widths, text formats and the `I18N.*.sheet` headers and note update to match.
- **Settings tab:** language, PDF output, combine lines. The footer and accent colour come from `Config.gs`, not the sheet.
- Invoice-level columns are B–N and W (read from each invoice's first row; the address G–N as one block). If X's header is blank, grouping is off for that sheet.
- `_meta`: version 3 plus `taxRates`. Older versions get the "generate again" message.

### `Index.html`
- The mapping form follows `FIELDS` automatically (the new groups and labels).
- **Step 3 (Business details) is removed.** Everything it held is either gone (business name, address, email, tax rate, tax name) or moved to `Config.gs` (currency is now fixed, plus the accent colour and the footer). Later steps are renumbered, `OPTION_IDS` is updated, and the page's own accent stays the same dark blue.
- One **Candidate / Role** field (optional) replaces the separate Candidate and Role / description fields. **Line type** is marked required.
- **New "Group line items by" row** in the mapping step, just above Extra details:
  - Fields: a column letter box (with click-a-column-in-the-preview support, like the others) and a "Heading label (optional)" box whose placeholder shows that column's header.
  - Help text: "Optional. Lines are listed under a heading for each value in this column, e.g. Project Number: P-1001. Totals are not affected."
  - It's saved in presets as `mapping.groupBy`, and the preset header check includes it.
- Add a note under step 2 listing the accepted tax codes.
- **Recipient:** remove the "Email the link to" input and its validation. Show the read-only "The link will be emailed to …" line in step 4, filled from `getConfig().userEmail`. Drop `recipient` from `OPTION_IDS` and from `sanitizeFormState_` / `normalizeOptions_`; the server sets it from the session.
- **Tax rates card:** six rows (GST, HST, NSHST, ONHST, PEI, PST), each showing the matching French label, with the help line "QST invoices use GST + PST." Admins get number inputs, **Save tax rates** and **Restore defaults** (a second click confirms). Everyone else sees the same rows read-only, with "Tax rates can only be changed by an admin." The stored keys match the six labels (`GST`, `HST`, `NSHST`, `ONHST`, `PEI`, `PST`).

### `Code.gs`: row rules (single-line records)
- `groupInvoices_`:
  - **Blank invoice number** → row skipped and listed (no more joining the invoice above).
  - **Units or Rate blank or not a number** → 0, with a note naming the row, invoice and value.
  - Every other non-empty row becomes a line; there's no details-only row case.
  - Invoice-level fields still come from the first row of each invoice that has them. With single-line records that's simply the invoice's first row.
- **Hidden Excel rows:** `readRows_` (XLSX/XLS path), after converting to a temporary Google Sheet, reads row visibility with **one** call to the Sheets advanced service: `Sheets.Spreadsheets.get(id, { fields: 'sheets(data(rowMetadata(hiddenByFilter,hiddenByUser)))' })`.
  - Rows with `hiddenByFilter` **or** `hiddenByUser` set are dropped before mapping, and the count is returned as a note ("12 hidden rows in the Excel file were not invoiced").
  - **`appsscript.json` adds the Sheets API (v4) advanced service.** Developer impact: nothing to do, because it's in the manifest, but users approve permissions once more on first use after the update.
  - Hidden columns are still read (only rows are affected), because column letters come from the mapping.
  - CSV files have no filters, so nothing changes there.

### `Code.gs`: original data copy
- In `generateInvoices`, right after `createJobFolder_`, save the uploaded bytes unchanged with `folder.createFile(Utilities.newBlob(bytes, mimeType, 'Original data - ' + name))`, using the upload's own MIME type (CSV, XLSX or XLS).
- Record its ID in `_meta.files.originalId`, so `writePdfs_` never trashes it. Return `originalUrl` in `jobResponse_`, and add it to the results page links and to `sendResultEmail_` (HTML and plain text).
- If the job fails, the whole folder is trashed as today, including the copy.

### Files, samples, tests, docs
- **New `Config.gs`** (as above, with the stand-in values) and a `.claspignore` entry for it.
- **Samples (at least five, confirmed), all single-line database-style records** with every invoice field repeated on each row. They use one shared column layout, so one preset maps them all: Invoice #, Client #, Invoice Date, Payment Due Date, Client, ATTN, Address 1–4, City, State / Province, Postal code, Country, Candidate / Role, Work Order, PO, Work Date, Line Type, Units, Rate, Tax Code, Project Number, plus Location and Shift as extra details.
  1. `sample-1-basic-en.csv`: 2 Ontario clients (ONHST), several candidates, Regular + Overtime, MM/DD dates. The basic English run, to try with Combine on and off.
  2. `sample-2-quebec-fr.csv`: French-style export (`;` separator, decimal commas, DD/MM dates), QST clients, to try in Français.
  3. `sample-3-projects.csv`: grouped by Project Number, including the same candidate in two projects and some rows with no project.
  4. `sample-4-tax-codes.csv`: one invoice per tax code (EXEMPT, GST, HST, NSHST, ONHST, PEI, QST), plus lower-case, spaced and French spellings, a mixed-code invoice and a typo.
  5. `sample-5-edge-cases.csv`: units `8 hrs`, blank units, rate `n/a`, blank rate, a blank invoice number, a blank line type, an unreadable date and a blank Candidate / Role. Each should give the documented result and note.
  6. `sample-6-long.csv`: one invoice with about 80 rows across groups, to check pagination, condensed headers and page numbers.
  7. `sample-7-hidden-rows.xlsx`: an Excel file with some rows hidden by a filter and others hidden by hand, to check both are ignored. It's made with Python's `openpyxl` if available in the build environment; otherwise the README explains how to make one in Excel.
  - The old sample files are removed.
- **`tests/gas-stubs.js`:** add a shared ScriptProperties stub, a `DriveApp.getFileById` stub that returns a small test PNG (or throws, for the "not shared" case), and a way to set `CONFIG` values in tests.
- **`tests/run.js`:**
  - the new field mapping;
  - units summary per invoice, which is the same with Combine on and off, groups case variants, labels blank types "Other", sums each type correctly, and has no Total row;
  - the combine key keeping overtime and different work orders separate;
  - grouping:
    - off when unmapped;
    - headings in first-appearance order, with the label defaulting to the column header or overridden by the form;
    - blank-value rows listed first with no heading, and no headings at all when every value is blank;
    - the same employee in two projects combining separately within each group;
    - totals and the units summary identical with grouping on and off;
    - a heading never alone at a page bottom, and "(continued)" / "(suite)" on the next page;
    - a sheet round trip through column X, including renaming the X header to change the label;
  - client address: all 8 parts combined in order; blank parts skipped, with no stray commas or empty lines; postal code upper-cased; the address taken whole from the invoice's first row that has any address part (a later row with a different address is ignored); a Canadian and a US example (`Toronto, ON  M5V 1L9`, `Orlando, FL  30029`); address edits in the sheet showing up after Rebuild;
  - every tax code in both languages, QST's two lines (GST + PST / TPS + TVQ), `PST` in the data treated as unrecognised → EXEMPT, blank, unknown and mixed codes with notes;
  - a payment due date taken from the first non-blank row of each invoice, different due dates on different invoices, and an invoice with no due date showing the label with a blank value;
  - admin rules: nobody by default; an email in `CONFIG.TAX_ADMINS` or in the script property (either alone, any case, spaces around commas) can save; others are refused. Also rate validation, and recorded rates used on Rebuild;
  - logo: blank ID → no image; valid PNG → embedded data URI; unreadable file, wrong type or over 2 MB → invoices still built, with the logo warning;
  - version 3 sheet columns, and the version 1 and 2 "generate again" message;
  - the company block: English and French sets, stand-in values printed in order (address → "T. " phone → government lines), French blanks falling back to English, an empty block hidden;
  - government lines: English shows exactly "HST/GST # …" then "QST # …"; French shows "TVH/TPS # …", "TVQ # …", "Permis QC …"; each number is entered once and appears in both languages; a blank number hides its line; Permis QC never appears on English invoices;
  - client name in the accent colour;
  - Line type is required on the form and Candidate / Role is optional; an old preset with `employeeName` or `description` loads into Candidate / Role; an empty line-type cell is invoiced as "Other" with a note; a row with no Candidate / Role is invoiced with an empty first column;
  - original data copy: saved byte-for-byte with the "Original data - " name, linked in the results page and email, recorded in `_meta`, and untouched by Rebuild (including when switching between combined and separate PDFs);
  - English number format on French invoices for units (`24.5`), rates and amounts (`$45.00`), the units summary and tax percentages (`9.975%`);
  - the footer: English and French stand-ins in order (EFT title and bank address left, bank details right, remittance line, disclosure), French blanks falling back to English, an empty footer printing nothing, and footer text escaped;
  - pagination: a short invoice is "Page 1 of 1"; a long invoice (e.g. 60 lines with extra details) splits across pages, every page has its number, the full header on page 1, the condensed header on later pages, column headings on every page, and the summary, totals and footer only on the last page, which always has at least one line. Numbering restarts per invoice in a combined PDF, and French reads "Page 1 de 2";
  - dates: invoice date, due date, single work dates and combined ranges print as MM/DD/YYYY in English **and** French (`11/03/2026 – 11/05/2026`); day-first files (`03/11/2026` with DD/MM) still read correctly and print as `11/03/2026`; unreadable date text prints as written;
  - recipient: a request that includes `recipient: 'someone@else.com'` still emails only the signed-in user, nothing is shared, and a missing session email stops the job with the sign-in message; the French header reads "Date de facturation" and "Paiement dû au plus tard"; money shows `$1,234.50` on English **and** French invoices, even if an old preset or sheet has another currency; the final total is labelled "Total (CAD)" in both languages; the accent colour is always `CONFIG.ACCENT_COLOR`, even when an old preset or sheet has another;
  - row rules: blank invoice number skipped and listed; Units or Rate blank or non-numeric → 0 with a note naming the row and value; rows hidden by a filter **and** rows hidden by hand in the XLSX sample left out, with a count note (Sheets API stubbed); QST calculated separately (1,556.00 → 77.80 + 155.21 = 1,789.01, not compounded); no Notes field anywhere;
  - company block: business name in the accent colour, phone shown as "T. 725-555-6458" in both languages; "ATTN:" in both languages; condensed header on pages 2 and on;
  - the header showing with and without the logo; ATTN and blank address lines hidden; no title; PRIVATE & CONFIDENTIAL only on English invoices and PRIVÉ ET CONFIDENTIEL only on French ones; "Référence" as the French Work Order header.
- **README:** new field list and sample mapping, a layout description, a tax code table, "Changing tax rates", and the **Developer setup** section above, word for word.

## Verification
1. `node tests/run.js`: all tests pass. Example expectations: QST on 1,556.00 → GST/TPS 77.80 + PST/TVQ 155.21 = 1,789.01; ONHST on 1,911.00 → 248.43; the summary for TAL-501 shows exactly two rows, Regular 42.5 and Overtime 2, with no total.
2. `node tests/run.js --html`, then screenshot an English and a French invoice, with and without a test logo, with the stand-in company block. Check that the company block and client block sit side by side without crowding, that the 8 columns fit portrait width, the summary sits left of the totals, the footer's bank block lines up in two columns with the disclosure below it, long addresses and candidate names wrap cleanly, a multi-page invoice breaks between pages with "Page X of Y" at the bottom, group headings stand out in the accent colour without clashing with the column-heading bar, and all dates read MM/DD/YYYY. Chrome's rendering only approximates Google's converter, so step 4 is the real check.
3. Browser test (scratchpad): the new fields and groups show, the removed inputs are gone (the whole Business details step, including the currency and accent colour, plus the recipient box, with the read-only "emailed to you" line showing the signed-in address), presets save and apply the new fields, the tax rates card works for admins and is read-only for others, no page errors, and no horizontal scroll on a phone.
4. After deploying: generate each sample file (1–7). Open the PDFs and check that Google's converter keeps the layout, that page breaks fall between rows, and that **"Page X of Y" sits at the bottom of each page**. If it doesn't, set `PAGE_NUMBER_POSITION: 'top'` (or tune `PAGE_HEIGHT_PT`) and publish a new version. Edit a tax code and a units value in the sheet, Rebuild, and confirm the summary and totals update. Follow the Developer setup steps with a test PNG, real company details and one admin, publish a new version, then generate again and edit a tax rate as that admin.
