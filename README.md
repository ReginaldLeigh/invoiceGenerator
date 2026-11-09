# Invoice PDF Generator (Google Apps Script)

A web app that turns a talent company's timesheet data (CSV or Excel) into client invoice PDFs in **English or French**. Each job gets its own Google Drive folder containing:

- **the final PDF**: a single PDF with every invoice, or one PDF per invoice plus a ZIP, and
- **an editable Google Sheet** of the same invoices, so small fixes can be made **without re-submitting the file**.

A link is emailed to the user.

## How it works

1. **Upload** a `.csv` or `.xlsx` file. A preview shows the first rows with column letters.
2. **Match columns.** Type a column letter for each field, or click a box and then click a column letter in the preview. Fields are grouped on the form:
   - **Invoice:** Invoice number *(required; rows sharing a number form one invoice)*, Invoice date, Due date
   - **Client (bill to):** Client name *(required)*, Client address, Client email
   - **Work / line items:** Employee name, Work date, Role / description, Hours worked (blank = 1), Pay rate *(required)*. Employee name or Role / description is required (either or both).
   - **Other:** Tax rate %, Notes
   - **Extra details (up to 10):** a column letter and an optional label for each. Each one prints as an indented line under the line item, e.g. `PO #: PO-7781`. The label defaults to the column's header.
   - **Dates in the file look like:** *Detect automatically* works out day/month order from values like `25/11/2026`. Choose MM/DD or DD/MM if every date is ambiguous (e.g. only `03/11/2026`).
   - **Numbers in the file look like:** *Detect automatically* works for most files. Choose *1 234,56 (French)* if a comma-only value like `14,975` should mean 14.975.
3. **Business details.** Name, address, currency symbol, default tax rate, tax name (e.g. `TPS + TVQ`), accent color and footer.
4. **Output and delivery.**
   - **Combine each employee's rows into one line item:** adds up each employee's hours and shows a **date range** from the earliest to the latest work date (e.g. `Nov 3–5, 2026`, `Oct 30 – Nov 2, 2026`). Rows for the same employee with a different rate or role (e.g. overtime) stay as separate lines. Extra details that differ between days are listed together (`Location: Studio A, Studio B`). Unchecked, every row is its own line item with its date.
   - **Language:** English (`INVOICE`, `$1,234.50`, `November 9, 2026`) or French (`FACTURE`, `1 234,50 $`, `9 novembre 2026`).
   - **PDF output:** a single PDF with every invoice on its own page (default), or one PDF per invoice plus a ZIP.
   - **Email the link to:** defaults to your Google account. If you enter someone else, they're given view access to the job's Drive folder.
5. **Generate.** Files go to `My Drive / Invoice PDFs / <timestamp> - <file name> (<job id>)/`. An email in the chosen language links to the PDF, the spreadsheet, the folder and the rebuild page.

## Editing an invoice after it's generated

The job folder contains a spreadsheet named `Invoices - <file> (editable)` (`Factures - <file> (modifiable)` in French):

| Tab | What's in it |
|---|---|
| **Invoices** / **Factures** | One row per day/entry, as in the upload (not combined), so a single day can be fixed: A invoice #, B invoice date, C due date, D client, E client email, F client address, G employee, H work date, I role, J hours, K pay rate, L *amount (calculated)*, M tax rate %, N notes, **O–X extra details** (the header is the label; rename it, or add a header in an empty column to add a detail). Invoice details are read from the **first row** of each invoice. Dates are stored as `yyyy-mm-dd`. |
| **Settings** / **Paramètres** | Language (`en`/`fr`), PDF output (`combined`/`separate`), combine employee lines (`yes`/`no`), business name/address/email, currency, default tax rate, tax name, accent color, footer. Also has a **Rebuild PDF** link. |
| `_meta` (hidden) | Records which PDFs belong to this job. Don't edit it. |

**To apply your edits:** click **Rebuild PDF** (on the Settings tab, in the email, or on the results page). This opens the web app with the spreadsheet filled in; click **Rebuild PDF** again. You can also paste the spreadsheet link into the "Rebuild" box at the bottom of the web app.

- The PDFs are **updated in place**: same file, same Drive link, and Drive keeps the old version under *Manage versions*. Links you've already sent still open the corrected invoice.
- Changes on the Settings tab (switching language, business details, tax) apply on rebuild too.
- If you delete an invoice or switch between single and separate PDFs, PDFs that are no longer needed are moved to the trash.
- The PDFs are always built from the spreadsheet, including on the first run, so the sheet and the PDF never disagree.
- Rebuilding needs **edit** access to the spreadsheet and folder. Someone who only received the emailed link (view access) can't rebuild.

Your column letters and options are remembered for next time, per user.

### Data layout rules
- Each row is one entry (e.g. one employee, one day). Rows with the same invoice number go on one invoice; with **Combine** on, each employee's rows become one line.
- A row with a **blank invoice number** is added to the invoice above it.
- Invoice-level fields (customer, dates, tax rate, notes) come from the first row of each invoice that has them.
- Dates like `2026-11-03`, `11/03/2026`, `03-11-26` and real date cells in Excel files are recognised and shown in the chosen language. Other date text is printed as written.
- CSVs separated by `;` (how French Excel saves them) and Windows-1252 encoded files are handled.
- Rows that can't be read (for example `abc` as a quantity) are skipped and listed after generating.
- For Excel files, only the **first sheet** is read.

### Sample files
- `sample-talent.csv`: timesheet data, one row per employee per day. Mapping: A invoice #, B invoice date, C client, D client address, E employee, F work date, G hours, H pay rate, I role; extra details J (PO number), K (location), L (shift). Try it with **Combine** on and off.
- `sample-invoices.csv` (English) and `sample-invoices-fr.csv` (French, `;`-separated) are simple item lists. Mapping: A number, B date, C due date, D client, E email, F address, G role/description, H hours, I rate, J tax %.

## Multiple users

Each submission is isolated:
- **Deploy as "Execute as: User accessing the web app"** (the manifest sets this). Each person's PDFs go to their own Drive and emails come from their own account. Saved settings and quotas are also per person.
- The server keeps no shared state between requests. Each submission gets a unique job ID and its own Drive folder, spreadsheet and PDFs, and carries all of its data (file, mapping, options) in one request. Two users, or one user in two tabs, can run jobs at the same time without mixing results.
- The shared root folder is created under a lock, so simultaneous first runs don't create duplicates.
- Rebuilds of the **same** spreadsheet can't overlap: the second one is refused with a "try again in a minute" message. A short lock covers only that check, so it never holds up other users' jobs.
- In the page, the Generate button is locked while a job runs. Each request is a snapshot of the form, so edits made during a run don't affect it.

If you deploy as "Execute as: me" instead, it still works (settings are keyed by user email), but every file lands in *your* Drive and every email is sent from *your* account.

## Setup

1. Go to <https://script.google.com> and create a **New project**.
2. Replace `Code.gs` with this repo's `Code.gs`.
3. **File → New → HTML**, name it `Index`, and paste in `Index.html`.
4. **Project Settings → "Show appsscript.json manifest file in editor"**, then replace `appsscript.json` with this repo's version.
   It turns on the **Drive API** advanced service, which is needed to read `.xlsx` files.
   You can also add it from **Services (+) → Drive API → v3**.
5. **Deploy → New deployment → Web app**
   - *Execute as:* **User accessing the web app**
   - *Who has access:* **Anyone with a Google account** (or limit it to your organization)
6. Open the web app URL and approve the permissions (Drive, Sheets, send email) the first time.

The **Rebuild PDF** links point at the deployed web app URL. If you later create a *new* deployment (new URL), links in older spreadsheets still point at the old one; update deployments in place (*Manage deployments → Edit*) to keep them working. Pasting the spreadsheet link into the web app always works.

You can also push it with [clasp](https://github.com/google/clasp): `clasp create --type webapp`, then `clasp push`.

## Limits
- Apps Script stops a run after **6 minutes**. Each PDF takes about 1 second, so one run handles roughly 250–300 invoices. Split larger files.
- Email: about 100 recipients/day on free Gmail accounts, 1,500 on Workspace. If the quota runs out, the PDFs are still created and the page shows the links.
- The upload limit is 20 MB (set in `Index.html`).
- Each job takes a few extra seconds to create its spreadsheet.
- The PDF layout is in `invoiceBodyHtml_()` in `Code.gs`, and wording for both languages (PDF, email and spreadsheet) is in `I18N`. Google's HTML-to-PDF converter supports tables and basic CSS but not flexbox or grid.
