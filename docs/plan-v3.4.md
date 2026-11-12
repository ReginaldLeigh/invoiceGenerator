# Plan v3.4: English outside the invoice, "Morph" naming, shorter file names, JSDoc

## Context
The user set four rules:
1. **Outside the invoice text itself, nothing needs a French translation.** French stays only on the invoice: headings, labels, columns, taxes, footer, "Page X de Y", "(suite)", "Autre" and so on.
2. **The app's name becomes "Morph - Invoice PDF Generator"**, and the Drive folder becomes **"Morph - Invoice PDFs"**.
3. **A PDF's file name drops the leading "Invoice":** invoice number, then client name, e.g. `INV-1001 - Maple Productions.pdf`.
4. **No invoices have been produced yet**, so nothing needs to stay compatible with older spreadsheets.

Already English only: emails, the results page, the web form, job folder names, error messages, notes, logs and developer error emails.

**Still French for French jobs (to change):**
- **The editable spreadsheet:**
  - its file name, tab names, 23 column headers and the A1 help note;
  - the Settings tab's text, and the "Régénérer le PDF" / "Dossier Drive" links;
  - the blank-label marker `(sans étiquette)`;
  - the `fr_CA` locale.
- **Drive file names:** `Facture …`, `Toutes les factures …`.

**User's earlier answers:**
- File names in English.
- The spreadsheet's Tax code dropdown **keeps the French codes** for French jobs.

## Changes

### 1. English spreadsheet for every job (`Code.gs`)
- `createInvoiceSpreadsheet_` always uses `I18N.en.sheet`: file name `Invoices - <file> (editable)`, tabs, headers, note, Settings tab and links. The French `sheet` block is deleted.
- The `fr_CA` locale line is removed, so every sheet shows numbers and dates the English way.
- **The Tax code dropdown keeps the job's own list:** French jobs keep TPS / TVH / NETVH / ONTVH / IPE / QST. Codes in either language are still accepted.
- The "language" setting stays: `fr` still means French invoices. Its help text reads "en = English, fr = French".
- **Blank-label marker:** only `(no label)`. The French `noLabel` and its recognition in `isNoLabel_` are removed, since there are no old sheets.
- **Rebuild:** numbers typed as text are always read the English way (`decimalComma = false`). The French-sheet decimal-comma rule is removed.

### 2. "Morph" naming (`Code.gs`, `Config.gs`, `Index.html`)
- **Drive folder:** `ROOT_FOLDER_NAME = 'Morph - Invoice PDFs'`.
  - The saved-folder setting gets a new key, so anyone who already ran a test gets the new folder instead of the old "Invoice PDFs" one.
  - A folder the user later renames is still reused, as today.
- **Every visible "Invoice PDF Generator" becomes "Morph - Invoice PDF Generator":**
  - the browser tab title and the page heading;
  - the email sender name, "Morph - Invoice PDF Generator (no reply)" (`EMAIL_SENDER_NAME`);
  - the email footer, "Sent by Morph - Invoice PDF Generator.";
  - the developer error email's subject and text;
  - the Rebuild error messages;
  - the spreadsheet's "rebuild manually" text and the note on the hidden `_meta` tab;
  - the file comments and the README title.
- **Unchanged:** the internal log tag `app: 'invoice-pdf-generator'`. It's a machine ID for filtering logs, not shown to users. *(Say if you want it changed too.)*
- **Developer note in the README:** the Apps Script project's own name, and the deployment's name, are set in the Apps Script editor. Rename those to "Morph - Invoice PDF Generator" there.

### 3. File names (`writePdfs_`)
- **One PDF per invoice:** `<invoice #> - <client>.pdf`, e.g. `INV-1001 - Maple Productions.pdf`.
  - Before, it was `Invoice INV-1001 - Maple Productions.pdf`.
  - An invoice with no client name is just `INV-1001.pdf`.
- **Combined PDF with one invoice:** the same, `<invoice #> - <client>.pdf`.
- **Combined PDF with several invoices:** unchanged, `All invoices - <uploaded file name>.pdf`.
- **ZIP, all invoices for one client:** `All invoices - <client>.zip`, e.g. `All invoices - Maple Productions.zip`.
- **ZIP, several clients:** unchanged, `All invoices.zip`.
- Characters Drive can't use are still replaced (`safeName_`). If two files end up with the same name, the existing `uniqueName_` adds " (2)".

### 4. JSDoc comments and a generated reference (the JavaScript version of Javadoc)
- **Every function gets a JSDoc block** in the Javadoc style:
  - covers `Code.gs` (~122 functions), `Config.gs` (`sendRunMetrics_`) and the page script in `Index.html` (~33 functions);
  - each block has a one-line summary, then details if needed;
  - `@param {Type} name description` for every parameter, including optional ones (`[name]`) and object fields (`request.file`, …);
  - `@return {Type} description`, plus `@throws {Error}` where a function stops with a user message;
  - `@private` on internal helpers (names ending in `_`), and `@example` where it helps (`colLetter`, `parseNumber_`, …);
  - file-level `@fileoverview` blocks; the Config.gs settings get `@type` / `@property` notes.
- **Shared data shapes become `@typedef`s,** so `{Mapping}` or `{Invoice}` means the same thing everywhere:
  - FormState, Mapping, Options, UploadFile, PreviewResult;
  - Invoice, Line, Group, Run, Branding, SheetMeta, JobResult, TaxState.
- **Generated reference: `docs/api/index.html`,** one self-contained page:
  - sections: Web app entry points (functions the page calls) → server internals, grouped as the code is (parsing, tax, PDF layout, spreadsheet, Drive, logging…) → developer settings (Config.gs) → web page script (Index.html) → data types;
  - each entry shows its signature, description, parameters, return value, throws and examples, with links between types;
  - there's a search box, and it works offline.
- **How it's built:**
  - The standard `jsdoc` tool can't be installed here (package installs are blocked in this session). So `tools/build-docs.js` builds the page with the TypeScript parser, which is already installed and reads JSDoc natively.
  - Run it with `node tools/build-docs.js`.
  - A `jsdoc.json` config is included, so a developer with network access can also run the standard `npx jsdoc -c jsdoc.json` (it's set to read `.gs` files).
- **The docs are checked like code:** a new test fails if any function is missing its JSDoc block, an `@param` doesn't match a real parameter (or is missing), or a function that returns a value has no `@return`.
- **Publishing:**
  - The reference is published as a private artifact page so you can open or share it.
  - It's also committed to the repo under `docs/api/`.
  - `tools/` and `docs/` aren't pushed to Apps Script (`.claspignore` only allows the four app files).
- **Comments only:** no code behaviour changes in this part.

## Tests and README
- **Update the existing tests:**
  - emails: sender name and footer;
  - developer error email subject;
  - the French-sheet test, which now expects English headers, tabs, file name, `(no label)` and no `fr_CA`, while the dropdown is still French and the invoice HTML is still French;
  - PDF names, e.g. `INV-3001 - Maple Productions.pdf`.
- **New tests:**
  - root folder named "Morph - Invoice PDFs";
  - page title and heading;
  - file names: per invoice; combined with one invoice / several; ZIP with one client → `All invoices - <client>.zip`, several clients → `All invoices.zip`; an invoice with no client name;
  - a French job's spreadsheet reads the text `"1,234"` as 1234 on Rebuild.
- **README:**
  - new names and the folder path `My Drive / Morph - Invoice PDFs / …`;
  - the spreadsheet is always English, and only the invoice text follows the language choice;
  - file name rules;
  - a note to rename the Apps Script project and the deployment in the editor.

## Assumptions
- "One client" means one client name across every invoice in the ZIP, ignoring capitalisation and extra spaces. Invoices with no client name don't count as a second client.

## Verification
- `node tests/run.js`: all tests pass.
- Browser checks `ui2`–`ui5`, with the heading updated.
- Render a French invoice in Chrome to confirm the invoice text is still French.
- JSDoc completeness test passes. Rebuild `docs/api/index.html` and open it in Chrome: every function is listed, the links work, and search works.
- The README gets a "Code documentation" section on how to rebuild the reference.
- Save the plan to the project docs and `docs/plan-v3.4.md`. Commit, push to `main`, and refresh the zip.
