# Plan: Full-width preview, editable auto-filled labels, blank labels stay blank

## Context
Three problems the user reported, all confirmed in the code:
1. **Blank labels still print.** `parseUpload_` (Code.gs) fills an empty extra-detail label with the column header, or "Detail n", and an empty group label with the header, or "Group". So a label always appears on the invoice.
2. **Headers after column BB are unknown.** `previewFile` only returns the first 54 columns, so the page has no header text after BB. Label suggestions and the preset header check don't work for those columns.
3. **Labels look read-only.** The header is shown as grey *placeholder* text. It looks filled in but can't be edited, so users think the box is locked.

Requested outcome:
- the preview shows every column if possible;
- headers are known from any column;
- detected labels are real, editable text;
- **a label left blank on the form never appears on the invoice.**

## Changes

### 1. Preview shows all columns (`Code.gs` `previewFile`, `Index.html` `renderPreview`)
- **Showing every column is possible.** The preview is only 6 rows, so even a few hundred columns is a small amount of data for the page.
- `MAX_PREVIEW_COLS` goes from 54 (BB) to **702 (A–ZZ)**. That's effectively "all" for any real export. It's only a safety cap so an extreme file (Google Sheets allows 18,278 columns) can't freeze the page.
- `previewFile` also returns **`header`: the complete first row, every column, no limit**. Header lookups (label auto-fill, the preset header check) work for any column, even past the preview cap.
- Note under the preview: "Showing 6 of 15 rows · columns A–BH." Past the cap, it adds "… columns after ZZ aren't shown, but you can still type their letters."
- The dock already scrolls sideways, and its column-letter row stays visible, so wide files remain usable.

### 2. Labels are real, editable text (`Index.html`)
- When a column letter is entered (typed, or clicked in the preview), and the file has a header for that column, **the header is put into the label box as normal text**. The user can edit it, shorten it or delete it.
  - This applies to the 10 extra-detail labels and the "Group line items by" heading label.
- **Deliberate choices are never overwritten:**
  - A label box the user has typed in or cleared is marked as *set by the user*, and auto-fill never changes it again, even after a new upload.
  - Applying a preset marks every label as set, so a preset's blank labels stay blank.
  - **Clear form** resets the marks, along with the boxes.
- **Order doesn't matter:** if a column was entered before any file was uploaded, its label is filled from the header when the file arrives, unless the user already typed or cleared it.
- **Hints:** the placeholder becomes "Label (blank = no label)" and no longer shows the header, so nothing looks filled in when it isn't. The help text adds: "Leave a label empty to print only the value."

### 3. Blank labels never appear on the invoice (`Code.gs`)
- `parseUpload_` stops filling in labels: a blank label stays blank. There are no more "Detail n" / "Group" / header fallbacks.
- **Invoice output:**
  - an extra detail with a blank label prints just its value (`Studio A` instead of `Location: Studio A`);
  - a group heading with a blank label prints just the value (`P-1001` instead of `Project Number: P-1001`), with "(continued)" still added on later pages.
- **Editable spreadsheet:** a blank label needs a marker there, because the sheet uses an empty header to mean "no column" (X = grouping off, Y–AH = no detail). So a blank label is written as **`(no label)`** (French sheet: **`(sans étiquette)`**).
  - On Rebuild, either marker means "blank label": the detail or group is kept, but no label is printed.
  - The sheet note explains this. Typing a real label over the marker shows that label from then on.
- Version 1–3 spreadsheets are unaffected; they never held blank labels.

### 4. Tests (`tests/run.js`) and README
- **Server tests:**
  - `previewFile` returns all columns up to ZZ, plus the full header past the cap;
  - a blank detail label and a blank group label → no label text in the invoice HTML (value only), and the `(no label)` marker in the sheet;
  - a Rebuild with the marker → still no label; renaming the marker → the label appears;
  - typed labels are used as typed.
- **Existing tests that relied on header fallbacks** (sample 1 "labels default to headers", the group label "Project Number", layout B/C "Project"/"Projet") pass labels explicitly, or check for blank where that's now the intended behaviour.
- **Browser tests:**
  - a 60-column CSV shows every column and the right note;
  - entering column BH fills its label from the header, and the label is editable;
  - a cleared label stays empty after re-entering the column letter and after a new upload;
  - applying a preset keeps its blank labels;
  - Clear form resets labels and their marks.
- **README:** preview width, label auto-fill, and "blank label = value only".

## Assumption to confirm
- **"Any label left blank" covers both the extra-detail labels and the "Group line items by" heading label.** Those are the only label boxes on the form.

## Verification
`node tests/run.js` (all pass), the browser tests above, and a Chrome render of an invoice with blank and filled labels. Then save to the project, commit and push to `main`, and refresh the zip.
