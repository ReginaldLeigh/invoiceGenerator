# Plan: Version 3.1: emails, defaults, logging, metrics, layout polish

## Context
Version 3 is built and tested (see `docs/plan.md` for that plan). This round:
- tightens delivery: English emails, a "no reply" sender look, new defaults;
- adds operational visibility: logs, error emails to the developer, and run metrics for BigQuery;
- polishes the invoice: spacing, long text, units total, page number top-right, footer pinned to the bottom of the last page;
- simplifies company and bank settings, so both languages share the same values;
- improves the form (a pinned preview) and adds samples with different column layouts to test presets.

## Decisions (confirmed)
1. **All emails are in English.** That covers the result email (even for French invoices) and the error emails.
2. **Default PDF output: one PDF per invoice** (plus a ZIP when there's more than one). **Default language: English** (unchanged).
3. **Sender:** Apps Script can't send as `noreply@gmail.com`, an address the company doesn't own. Emails still go out from the user's own account, but with a **no-reply look**:
   - the sender name is **"Invoice PDF Generator (no reply)"**;
   - the email body ends with "This is an automated message. Please don't reply."
4. **Errors:** every error is logged. **Unexpected errors only** are emailed to `DEV_EMAIL` (reggie.leigh@gmail.com): Drive or PDF failures, timeouts, bugs. User mistakes (e.g. "Line type is required") are logged but not emailed.
5. **BigQuery data: one row per client per run.**
6. **Same company and bank details in both languages.** Only the labels change (Bank ID → N° d'institution, etc.). The remittance line and disclosure are sentences, so they stay translated.

## Assumptions (change any of these)
- **Reply-To (confirmed): none.** Replies go to the user who generated the invoices. `EMAIL_REPLY_TO` is not added to `Config.gs`.
- **Metrics hook (confirmed): a placeholder.** `sendRunMetrics_(rows)` has one clearly marked commented line where the developer calls their library (e.g. `// MyBqLib.send(rows);`). Until then the rows are only logged.
- **Metrics come from Generate only (confirmed).** Rebuilds don't produce rows.
- **Run time in whole milliseconds (confirmed)**, measured from the start of the Generate call to just before the result is returned (after the email).
- **BigQuery rows (confirmed):** `[run id, user, client id, invoices for that client, run time]`, one row per client per run. **No timestamp**, because the existing library adds it automatically. **The app only builds the array.** Sending it is done by the developer's existing library. A blank client # is recorded as `''`.
- **Error email flood protection:** the same error from the same user is emailed at most once per 10 minutes.
- **Preview pinning:** the preview is pinned **by default on wide screens and off on phones**, with a toggle that's remembered per browser.
- **Page number position:** the page number is **always top-right**, and the `PAGE_NUMBER_POSITION` setting is removed.

## Changes

### 1. Emails (`Code.gs`: `sendResultEmail_`, new `sendDevErrorEmail_`)
- Always use `I18N.en.email`, whatever the invoice language.
- `MailApp.sendEmail({ name: CONFIG.EMAIL_SENDER_NAME, ... })` with no Reply-To, and the automated-message line added to the HTML and plain text.
- **Error email** to `CONFIG.DEV_EMAIL`:
  - Subject: `[Invoice PDF Generator] Error in generateInvoices (run 3f9a…)`.
  - Body: run id, user, timestamp, function, the last progress stage reached, the file name and size (never the file contents), the message and the stack trace.
  - It's sent from the user's account, so it uses their email quota. If it can't be sent, that's logged, and the user still sees their error.

### 2. Defaults
- `Index.html`: the "One PDF per invoice (plus a ZIP)" radio is checked; English stays checked.
- `normalizeLayoutOptions_`, `sanitizeFormState_` and the sheet's Settings tab fall back to `separate` instead of `combined`.
- Existing presets keep whatever output mode they saved.

### 3. Logging, progress and errors (`Code.gs`)
- **New `log_(run, stage, data)`** writes one JSON line with `console.log`: `{ app, runId, user, timestamp, function, stage, …data }`. It goes to Apps Script's Executions and Cloud Logging as structured data.
- **Access log:** `getConfig()` (page open) logs `page_open` with the user. Every other server call (preview, presets, tax rates, generate, rebuild) logs `start` and `done` with its duration.
- **Progress breakpoints:**
  - **generate:** `start` (file name, size, language, output mode) → `file_read` (rows, hidden rows) → `parsed` (invoices, skipped, notes) → `folder_created` → `original_saved` → `sheet_created` → `pdfs_written` (count, ms) → `email_sent` → `done` (total ms).
  - **rebuild:** `start` → `claimed` → `pdfs_written` → `done`.
- **Run id:** generate uses the existing job id, so logs, the folder name, the results page and the email all show the same reference. Other calls get a fresh 10-character id.
- **Error wrapper:** a new `withRun_(fnName, fn)` wraps every function the page calls.
  - **User errors** are thrown with a new `userError_(message)` (validation, missing columns, no access to a spreadsheet, not an admin). They're logged at `warn` level and not emailed.
  - **Anything else** is logged with its stack at `error` level and emailed to DEV_EMAIL. The user sees "Something went wrong (reference 3f9a…). The developer has been notified." plus the original message.

### 4. Run metrics for BigQuery
- At the end of each **Generate** (not Rebuild): `rows = clients.map(c => [runId, user, c.clientNumber, c.invoiceCount, runTimeMs])`. No timestamp; the library adds it.
- The rows are logged once as `{ stage: 'run_metrics', rows }` and passed to `sendRunMetrics_(rows)`, a placeholder with a marked line for the developer's library call. README "Developer setup → Run metrics" explains where to add it, and that a library must be added under *Libraries (+)* in the editor.
- No BigQuery code is written in this app, and no `CONFIG.BIGQUERY` setting is added.
- A metrics failure is logged but never fails the run.

### 5. Multiple users at once
The design already isolates jobs: one job id and folder per run, per-user properties, no shared variables between calls, and locks only around the shared root-folder creation, tax-rate writes and rebuild claims. This round:
- reviews every new piece (logging, error emails, metrics) to make sure it keeps no state between calls. The error-flood guard uses `CacheService.getUserCache()`, so it's per user;
- **adds a test** interleaving two users: separate folders, sheets, presets, emails, logs and metrics; shared tax rates visible to both; a second rebuild of the same sheet refused while the first holds the claim.

### 6. Same company and bank details for both languages (`Config.gs` restructure)
```js
COMPANY: { address: ['ABC Store', '123 Front Street', 'Orlando, FL 30029'], phone: '725-555-6458' },
GOVERNMENT_NUMBERS: { gstHst, qst, quebecPermit },          // unchanged
BANK: { address: ['JP Morgan Trust', '1234 Alexander Street', 'Saint-Laurent QC H4R 1Y8'],
        bankId: '007', transit: '12345', account: '12312312323' },
FOOTER_TEXT: { en: { remittance, disclosure }, fr: { remittance, disclosure } },
EMAIL_SENDER_NAME: 'Invoice PDF Generator (no reply)',
DEV_EMAIL: 'reggie.leigh@gmail.com',
FOOTER_AT_PAGE_BOTTOM: true, ACCENT_COLOR, LOGO_DRIVE_FILE_ID, TAX_ADMINS   // as before
```
- **Labels move to `I18N`:** EFT Payment / Paiement par TEF · Bank ID / N° d'institution · Bank Transit / N° de transit · Account # / N° de compte · the phone prefix "T. ".
- The French bank address ("1234, rue Alexander…") goes away. Both languages print the same address.
- README "Developer setup" is updated to match.

### 7. Invoice layout (`wrapHtml_`, `invoicePages_`, `summaryTotalsHtml_`, `footerHtml_`, `paginateInvoice_`)
- **More vertical space between the parts:**
  - header → body 24pt (was 10);
  - body → units summary 28pt (was 14);
  - units summary → footer at least 30pt (was 16).
  - The height estimates update to match.
- **Units total:** a **Total** row (bold, thin line above) at the bottom of the units summary, the same word in French.
- **Page number top-right:** a small "Page X of Y" / "Page X de Y" row at the very top of each page, right-aligned, above the invoice details. The bottom option is removed.
- **Footer pinned to the bottom of the last page:**
  - The last page's fixed-height table gets three rows: the page number, then the content (`height:100%`, which absorbs the spare space), then the footer at the bottom.
  - **If a converter ignores fixed table heights, the footer simply follows the totals**, which is the previous setup, so nothing breaks.
  - `CONFIG.FOOTER_AT_PAGE_BOTTOM: false` forces the previous setup explicitly.
  - **Tested in Chrome** (see Verification). If it doesn't hold there, I revert to the previous setup and tell you. Google's converter is checked on the first deployment.
- **Long text never overflows:**
  - New `softBreaks_(text)` adds break points (`<wbr>`) inside long unbroken tokens, every 12 characters and after `- / _ . @`. It applies to every table cell, the header values, the client and company blocks and the footer values.
  - The CSS adds `overflow-wrap:anywhere; word-break:break-word`.
  - Column widths are rebalanced so large amounts fit: Candidate 21 · Work Order 11 · Purchase Order 11 · Period 14 · Type 10 · Unit(s) 8 · Rate 11 · Amount 14 (%).
  - The height estimator already counts wrapped lines, and is re-checked against long-string measurements.

### 8. Form: pinned CSV preview (`Index.html`)
- The preview moves into a **sticky dock** just above step 2. It stays at the top of the screen while the user scrolls through step 2 and step 3.
- It shows the column letters and the first few rows, scrolls sideways, and has a maximum height of about 180px (120px on phones).
- Clicking a column letter in the dock fills the focused box, as now.
- A **"Pin preview"** toggle (default on for wide screens, off on phones) is remembered per browser with `localStorage`, wrapped in try/catch. When unpinned, the preview scrolls with the page.

### 9. Samples in different column layouts (presets testing)
New files with the same records as samples 1 and 3, in other column orders, so each layout needs its own preset:
- `sample-8-layout-b.csv`: columns shuffled (e.g. client and address first, invoice # in column F, rate before units), with two unused columns, `Notes` and `Internal ID`, mixed in.
- `sample-9-layout-c.csv`: French-style headers (`N° facture`, `Client`, `Taux`…), `;` separator, a different order again, and the project column for grouping.
- `sample-10-long-strings.csv`: very long candidate names, unbroken work orders and purchase orders (30+ characters), long line types and extra details, a 60-character client name and address line, a long invoice number, and amounts in the millions.
- README: a mapping table for each layout.
- Tests:
  - the layout A preset warns on layout B, listing the changed headers;
  - a preset per layout gives identical totals across A, B and C.

### 10. Tests (`tests/run.js`, `tests/gas-stubs.js`)
Stubs for `console` capture, `CacheService` and `MailApp` options. New tests cover:
- English-only emails, including for a French job;
- the sender name and the automated-message line;
- separate PDFs by default;
- log lines for page open and every stage, with run id, user and timestamp;
- a forced Drive failure → error logged, dev email sent once (deduplicated), user sees the reference;
- a validation error → logged, no dev email;
- metrics: Generate gives exactly `[runId, user, clientId, invoiceCount, runTimeMs]` per client (no timestamp; whole ms; a blank client # is `''`); Rebuild gives none; `sendRunMetrics_` receives the array, and a failure inside it doesn't fail the run;
- the two-user interleaving test;
- the shared bank and company values with French labels;
- the units Total row;
- the page number before the header on every page;
- the long-strings sample (soft breaks present; pagination still fits);
- the layout B/C presets.

## Verification
1. `node tests/run.js`: all tests pass.
2. Chrome render (Playwright, print backgrounds), measured with the same script used for v3:
   - On every sample, the page count equals "Page X of Y".
   - The page number sits in the top-right corner of every page.
   - **On the last page, the footer's bottom edge is within ~20pt of the page block's bottom.** If not, revert to the previous footer setup.
   - The gaps between header/body, body/summary and summary/footer are at least the target sizes.
   - On the long-strings sample, no cell's content is wider than its cell (`scrollWidth <= clientWidth`) and nothing overflows the page.
3. Browser test of the form:
   - the dock stays visible while scrolling to the bottom of step 3 and column clicks still fill boxes;
   - the pin toggle works and is remembered;
   - "One PDF per invoice" is the default;
   - no horizontal scroll at 375px and no page errors.
4. After deploying (developer):
   - generate each sample and check the footer position and page numbers in Google's PDFs. If the footer doesn't sit at the bottom, set `FOOTER_AT_PAGE_BOTTOM: false`;
   - trigger an error (e.g. an unreadable logo ID isn't an error, so use a deleted job folder on Rebuild) and confirm the dev email arrives;
   - check logs in Apps Script → Executions.
