/**
 * "Send me this map" webhook. Appends one row per submission to the
 * active sheet: Email, Company, Source, Diagnostic ID, Timestamp.
 *
 * Setup:
 *   1. Create a new Google Sheet. Add a header row (optional, cosmetic):
 *      Email | Company | Source | Diagnostic ID | Timestamp
 *   2. Extensions > Apps Script. Delete the placeholder code, paste this file.
 *   3. Deploy > New deployment > type: Web app.
 *      Execute as: Me. Who has access: Anyone.
 *   4. Deploy, authorize when prompted, copy the web app URL.
 *   5. Put that URL in frontend/.env as VITE_SHEET_WEBHOOK_URL.
 */
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);
  sheet.appendRow([
    data.Email || "",
    data.Company || "",
    data.Source || "",
    data["Diagnostic ID"] || "",
    data.Timestamp || new Date().toISOString(),
  ]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
