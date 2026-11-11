# Plan: Wider column preview (up to BB), a correct preview note, and a Clear form button

## Context
The file preview shows at most 40 columns (A–AN). When a file has more than 26 columns, the note under it wrongly says "(first 26 columns)", a leftover from an older limit. The user wants the preview to go up to column **BB** and the note to be correct. Mapping and reading are unchanged: any column up to ZZZ can still be typed in, and every column is still read.

## Changes
1. **`Code.gs`:**
   - `MAX_PREVIEW_COLS = 54` (A–BB). It was 40.
   - `previewFile()` also returns `totalColumns`, the widest row in the file, so the page knows when columns were left out.
2. **`Index.html`, `renderPreview()`:** the note is built from what was actually shown.
   - All columns fit: "Showing 6 of 15 rows · columns A–Y." The last letter comes from `p.columns`.
   - More columns than shown: "Showing 6 of 15 rows · columns A–BB of 60. Columns after BB aren't shown here, but you can still type their letters (e.g. BC) in the boxes below."
   - The hard-coded "(first 26 columns)" text is removed.
3. **`README.md`:** the upload step says the preview shows up to column BB, and that later columns can still be mapped by typing their letter.

4. **New "Clear form" button (`Index.html`)**, a secondary-style button at the **top of the form (confirmed)**: just above step 1, under the Presets card, right-aligned, with the hint "Clears the column boxes and options. Your file and saved presets stay."
   - **Two clicks to confirm (confirmed)**, like Delete: the first click changes it to "Click again to clear" for 4 seconds. There are no pop-up dialogs.
   - **What it clears:**
     - **not the uploaded file (confirmed):** the file stays loaded and the preview dock stays visible, so the user can map it again straight away. The column-header check disappears, because no preset is selected any more;
     - every column box (including Group line items by and the 10 extra details) and every label;
     - the file settings and output options, back to the blank-form defaults: header row ticked, dates and numbers detected automatically, English, one PDF per invoice, Combine unticked;
     - the preset list, back to "— No preset —";
     - status messages and the results panel.
   - It reuses the existing `applyFormState(FORM_DEFAULTS)`. The file (`fileData`) and the preview are left alone. After clearing, the page shows "Form cleared. Your file is still loaded." and scrolls to step 2.
   - **What it doesn't touch (confirmed):** saved presets, the default preset, the tax rates and the pin-preview setting. When the page next opens, the default preset (or the last-used settings) fill in the form as usual. It's disabled while a job is running.
   - README: one line in "How it works".

No test run, as you asked. The change is two constants and a text string, and the Node tests stay valid.

## Files
`Code.gs` (`MAX_PREVIEW_COLS`, `previewFile`), `Index.html` (`renderPreview` note), `README.md`. Then save the files to the project, commit and push to `ReginaldLeigh/invoiceGenerator` (`main`), and update the zip.
