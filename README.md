# Invoice PDF Generator (Google Apps Script)

A web app that turns a database export (CSV or Excel, one record per row) into Canadian client invoice PDFs in **English or French**. Each job gets its own Google Drive folder containing:

- **the final PDF**: a single PDF with every invoice, or one PDF per invoice plus a ZIP;
- **an editable Google Sheet** of the same invoices, so small fixes can be made and the PDF rebuilt **without re-submitting the file**;
- **an untouched copy of the uploaded file** (`Original data - <file name>`), for later checking.

A link is emailed to the person who submitted the form.

## How it works

1. **Presets (optional).** Pick a saved preset to fill in the whole form. Your *default* preset fills it in as soon as the page opens, so for a fixed export format the routine is: **open the page → upload the file → Generate**.
2. **Upload** a `.csv` or `.xlsx` file. A preview shows the first rows with column letters. Rows hidden in Excel (by a filter or by hand) are left out.
3. **Match columns.** Type a column letter for each field, or click a box and then a column letter in the preview. ✱ = required.
   - **Invoice:** Invoice number ✱, Client number, Invoice date, Payment due date
   - **Client (bill to):** Client name ✱, Attention (ATTN), Address 1, Address 2, Address 3, Address 4, City, State / Province, Postal code, Country
   - **Work / line items:** Candidate / Role, Work order, Purchase order, Work date (Period), Line type ✱, Units, Rate ✱
   - **Other:** Tax code
   - **Group line items by** (optional): a column letter and a heading label (defaults to the column's header), e.g. `Project Number: P-1001`.
   - **Extra details** (optional, up to 10): a column letter and a label for each, printed as small lines under the line item, e.g. `Location: Studio A`.
   - **File settings:** "The first row is a header row", the date order (auto / MM/DD / DD/MM) and the number style (auto / `1,234.56` / `1 234,56`).
4. **Output and delivery.**
   - **Language:** English or Français. Every word on the invoice follows this choice.
   - **Combine each candidate's rows into one line item:** adds up the units and shows the date range (`11/03/2026 – 11/05/2026`). Rows with a different line type, rate, work order, purchase order or group stay separate.
   - **PDF output:** a single PDF with every invoice (default), or one PDF per invoice plus a ZIP.
   - **Delivery:** always the signed-in Google account. There's no recipient box, and nothing is shared with anyone else.
5. **Generate.** Files go to `My Drive / Invoice PDFs / <timestamp> - <file name> (<job id>)/`. The results page and the email (in the invoice language) link to the PDF, the spreadsheet, the folder, the original data file and the rebuild page. Skipped rows and notes are listed on the results page.

## The invoice

Portrait (Letter). Every page shows "Page X of Y" at the bottom (French: "Page X de Y"), restarting for each invoice.

- **Page 1 header:**
  - Logo top-left, with Invoice #, Client #, Invoice Date and Payment Due Date top-right.
  - Under the logo: the client name (bold, accent colour), `ATTN:` line, Address 1–4, "City, ST  Postal" and Country.
  - To the right: the company block (business name in the accent colour, address, `T. ` phone, government registration numbers).
  - Then **PRIVATE & CONFIDENTIAL** (French: **PRIVÉ ET CONFIDENTIEL**).
- **Later pages:** a condensed header (small logo, the four invoice fields, client name).
- **Body:** Candidate | Work Order | Purchase Order | Period | Type | Unit(s) | Rate | Amount (French: Candidat | Référence | Bon de commande | Période | Type | Unité(s) | Taux | Montant). The column headings repeat on every page. Group headings are tinted in the accent colour and repeat with "(continued)" / "(suite)" when a group runs onto the next page.
- **Last page only:**
  - The **units summary** (units per line type) on the left; Subtotal, the tax line(s) and **Total (CAD)** on the right.
  - Then the **invoice footer**: EFT payment details and the bank address, the bank ID / transit / account, the remittance line and the disclosure.
- **Formats:** dates print as **MM/DD/YYYY** and numbers in English style (`$1,234.50`, `24.5`, `9.975%`) on both languages.

### Tax codes

The tax code column can use the English or French code, in any capitalisation (spaces and hyphens are ignored). Tax is calculated on the invoice subtotal and each line is rounded to the cent.

| Code (English) | French | Rate | Printed under the subtotal |
|---|---|---|---|
| EXEMPT | EXEMPT | 0% | `EXEMPT  $0.00` |
| GST | TPS | 5% | GST (5%) / TPS (5%) |
| HST | TVH | 15% | HST (15%) / TVH (15%) |
| NSHST | NETVH | 14% | NSHST (14%) / NETVH (14%) |
| ONHST | ONTVH | 13% | ONHST (13%) / ONTVH (13%) |
| PEI | IPE | 15% | PEI (15%) / IPE (15%) |
| QST | QST | GST + PST = 14.975% | two lines: GST (5%) + PST (9.975%) / TPS (5%) + TVQ (9.975%) |

- Example (QST, not compounded): subtotal $1,556.00 → GST $77.80 + PST $155.21 → Total (CAD) $1,789.01.
- **One code per invoice.** If an invoice's rows have different codes, the first one applies to the whole invoice, with a note.
- A **blank** code means EXEMPT. An **unrecognised** code (e.g. `HTS`, or `PST`, which is a rate and not a code) is invoiced as EXEMPT, with a note.

### Changing tax rates

The **Tax rates** card at the bottom of the page shows the current rates to everyone: GST, HST, NSHST, ONHST, PEI and PST, each with its French label. QST always uses GST + PST.

- **Admins** (see Developer setup) can type new percentages (0–100, up to 3 decimals) and click **Save tax rates**. **Restore defaults** (click twice) goes back to the starting rates.
- Changes apply to the English and French invoices of **every user**, for **new** jobs only. Each job's spreadsheet records the rates it was made with, so **Rebuild keeps the original rates**.

### When a row is not invoiced

The results page lists every skipped row with its reason, and every note.

| Situation | What happens |
|---|---|
| Completely empty row | Ignored |
| Header row (with "The first row is a header row" ticked) | Skipped (it's the header) |
| No invoice number | **Skipped and listed**, because it can't be placed on an invoice |
| Row hidden in Excel (by a filter or by hand) | **Not invoiced**; the results page gives the count |
| Data on other sheets of an Excel file | Not read (only the first sheet is used) |
| Units or Rate blank or not a number (`8 hrs`, `n/a`) | Invoiced with **0**, with a note |
| Line type blank | Invoiced; listed as "Other" / "Autre" in the units summary, with a note |
| Other blank cells (candidate, dates, PO...) | Invoiced as they are |
| Date that can't be read | Invoiced; printed as written |

Invoice details (client #, dates, client, ATTN, tax code) come from the first row of each invoice that has them. The address comes **whole** from the first row that has any address part, never mixed across rows.

## Presets

A preset saves the whole form: column letters, grouping, extra details and their labels, the file settings, the language, line-item and PDF options. The uploaded file isn't part of it.

- **Save:** fill in the form (ideally after uploading a sample file), click **Save as new preset…**, give it a name, and optionally tick **Use as my default**.
- **Use:** pick a preset from the list. Every field is set from the preset.
- **Default:** fills in the form when the page opens. Use **Make default** / **Remove as default** to change it.
- **Update:** change the form, then click **Update preset**.
- **Delete:** click **Delete**, then again within 4 seconds.
- **Column check:** if a file was loaded when the preset was saved, the preset remembers each mapped column's header and warns when a later file's headers differ.
- Presets are private to each user (up to 30). Presets saved by older versions load into the new fields automatically.

## Editing an invoice after it's generated

The job folder contains `Invoices - <file> (editable)` (`Factures - <file> (modifiable)` in French):

| Tab | What's in it |
|---|---|
| **Invoices** / **Factures** | One row per record: A invoice #, B client #, C invoice date, D payment due date, E client, F ATTN, G–J address 1–4, K city, L state/province, M postal code, N country, O candidate/role, P work order, Q purchase order, R work date, S line type, T units, U rate, V *amount (calculated)*, W tax code (dropdown), **X group** (the header is the group heading label; blank = no groups), **Y–AH extra details** (the header is the label). Invoice details and the address are read from the **first row** of each invoice. Dates are stored as `yyyy-mm-dd`. |
| **Settings** / **Paramètres** | Language (`en`/`fr`), PDF output (`combined`/`separate`), combine lines (`yes`/`no`), and the **Rebuild PDF** link. |
| `_meta` (hidden) | Records the job's files and tax rates. Don't edit it. |

**To apply your edits:** click **Rebuild PDF** (on the Settings tab, in the email, or on the results page), then **Rebuild PDF** again in the web app.

- The PDFs are **updated in place**: same file and link, and Drive keeps old versions. The original data file is never changed.
- Spreadsheets made before version 3 can't be rebuilt; generate them again from the original file.
- Rebuilding needs **edit** access to the spreadsheet and folder.

## Multiple users

- **Deploy as "Execute as: User accessing the web app"** (the manifest sets this). Each person's files go to their own Drive and emails come from their own account. Presets, settings and quotas are per person.
- Each submission gets a unique job ID and its own folder, spreadsheet and PDFs, so simultaneous jobs never mix.
- The only shared data is the tax rates (admin-only writes, under a lock) and the root-folder creation (under a lock).
- Rebuilds of the same spreadsheet can't overlap; the second is refused with "try again in a minute".

## Setup

1. Go to <https://script.google.com> and create a **New project**.
2. Replace `Code.gs` with this repo's `Code.gs`.
3. **File → New → Script**, name it `Config`, and paste in `Config.gs`.
4. **File → New → HTML**, name it `Index`, and paste in `Index.html`.
5. **Project Settings → "Show appsscript.json manifest file in editor"**, then replace `appsscript.json` with this repo's version. It turns on the **Drive API** (to read `.xlsx` files) and **Sheets API** (to find hidden Excel rows) advanced services.
6. **Deploy → New deployment → Web app**
   - *Execute as:* **User accessing the web app**
   - *Who has access:* **Anyone with a Google account** (or your organization)
7. Open the web app URL and approve the permissions (Drive, Sheets, send email) the first time.
8. Follow **Developer setup** below to replace the stand-in company details and add the logo and tax admins.

Update deployments in place (*Manage deployments → Edit → New version*) so the URL, and the Rebuild links in existing spreadsheets, keep working.

With [clasp](https://github.com/google/clasp): `clasp create --type webapp`, then `clasp push`. The `.claspignore` pushes only `Code.gs`, `Config.gs`, `Index.html` and `appsscript.json`.

## Developer setup: logo, company details, footer, tax admins

All developer settings are in **Config.gs** (`CONFIG`). It ships with **stand-in values**, so test invoices show the full layout:

- ABC Store, 123 Front Street, Orlando, FL 30029, phone 725-555-6458;
- placeholder registration numbers;
- the JP Morgan Trust bank details and the FrontStreet disclosure;
- accent colour dark blue `#1f4e79`;
- page numbers at the bottom;
- no logo and no tax admins.

### Add the logo (needs a Google Drive file)
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
- If the logo can't be read (wrong ID, not shared, not a PNG, over 2 MB), invoices are still generated without it, and the results page says what to check.

### Replace the stand-in company details (no Drive item needed)
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

### Replace the stand-in footer (no Drive item needed)
1. In **Config.gs**, under `FOOTER.en`, edit:
   - `paymentTitle`;
   - `bankAddress`: one line per entry;
   - `bankDetails`: label and value pairs, shown on the right in this order. Add or remove pairs as needed;
   - `remittance` and `disclosure`.
2. Do the same under `FOOTER.fr` in French. Anything left blank there uses the English value.
3. Publish a new version (step 6 above).

### Add tax admins (no Drive item needed)
- **Option A, in code:** add their emails to `TAX_ADMINS` in **Config.gs**, then publish a new version (step 6 above).
- **Option B, no redeploy:** in the Apps Script editor go to **Project Settings (⚙️) → Script properties → Add script property**, set Property `TAX_ADMINS` and Value `ana@company.com, ben@company.com`, then **Save**. This takes effect the next time the admin opens or reloads the web app.
- Admins see editable inputs on the **Tax rates** card; everyone else sees the rates read-only. To remove an admin, delete their email from the list.

### Other settings
- `ACCENT_COLOR`: the colour of headings, the column-heading bar, group headings, spreadsheet headers and email buttons.
- `PAGE_NUMBER_POSITION`: `'bottom'` (default) or `'top'`. Switch to `'top'` only if page numbers don't land at the bottom of the page in real PDFs. If page breaks come out wrong, the page-size estimates are the `PAGE` constants near the top of `Code.gs`.

### Notes
- Existing invoices aren't changed by any of these settings. Only jobs generated (or rebuilt) afterwards show the new logo and details. Tax rate changes apply only to newly generated jobs.
- These settings don't need new permissions. This version adds the Sheets API (for hidden Excel rows), so each user approves permissions once after it's deployed.

## Sample files

All seven samples are single-line database-style records sharing **one column layout**, so one preset maps them all:

| A | B | C | D | E | F | G–J | K | L | M | N | O | P | Q | R | S | T | U | V | W | X | Y |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Invoice # | Client # | Invoice date | Payment due date | Client | ATTN | Address 1–4 | City | State/Prov. | Postal code | Country | Candidate / Role | Work order | PO | Work date | Line type | Units | Rate | Tax code | *Group by* (Project Number) | *Extra detail* (Location) | *Extra detail* (Shift) |

1. `sample-1-basic-en.csv`: two Ontario clients (ONHST), Regular + Overtime. Try with Combine on and off.
2. `sample-2-quebec-fr.csv`: a French-style export (`;` separator, decimal commas, DD/MM dates) with QST clients. Choose Français.
3. `sample-3-projects.csv`: grouped by Project Number (map W under "Group line items by"), with the same candidate in two projects and one ungrouped line.
4. `sample-4-tax-codes.csv`: one invoice per tax code, lower-case, spaced and French spellings, a mixed-code invoice, a typo, `PST` and a blank code.
5. `sample-5-edge-cases.csv`: units `8 hrs`, blank units, rate `n/a`, blank rate, a blank line type, an unreadable date, a blank Candidate / Role, a missing invoice number and a credit line.
6. `sample-6-long.csv`: one invoice with 70 rows in four projects, to check page breaks, the condensed header and page numbers.
7. `sample-7-hidden-rows.xlsx`: an Excel file with two rows hidden by a filter and one hidden by hand. Only the four visible rows should be invoiced.

## Testing

`node tests/run.js` (Node 18+, no packages to install) runs `Code.gs` and `Config.gs` against in-memory stand-ins for Drive, Sheets, Gmail and properties (`tests/gas-stubs.js`). Whole jobs run end to end: upload → spreadsheet → PDF HTML → email → edit → rebuild. It covers:

- all seven samples;
- every tax code in both languages, rates and admins;
- grouping, the units summary and the address block;
- pagination, presets and branding fallbacks;
- the original data copy and rebuilding with the job's own rates.

`node tests/run.js --html` also writes each sample's invoice HTML to `tests/out/` to open in a browser.

Google's HTML-to-PDF rendering itself can only be checked in a real deployment. After deploying, generate each sample and check that page breaks fall between rows and that "Page X of Y" sits at the bottom of each page.

## Limits
- Apps Script stops a run after **6 minutes**. Each PDF takes about a second, so one run handles roughly 250–300 invoices. Split larger files.
- Email: about 100 recipients/day on free Gmail accounts, 1,500 on Workspace. If the quota runs out, the files are still created and the page shows the links.
- The upload limit is 20 MB (set in `Index.html`). For Excel files, only the first sheet is read.
- Google's HTML-to-PDF converter supports tables and basic CSS but not flexbox or grid; the layout is in the `*Html_` functions in `Code.gs`, and all wording is in `I18N`.
