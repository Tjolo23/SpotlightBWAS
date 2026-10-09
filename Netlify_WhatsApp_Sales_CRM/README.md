# WhatsApp Sales CRM — Netlify frontend + Google Apps Script backend

## Important
This package makes the CRM frontend usable on Netlify by forwarding API calls through a Netlify Function. The Google Apps Script backend remains responsible for Google Sheets and authentication.

## 1. Update the Apps Script backend
1. Open the Google Apps Script project connected to your spreadsheet.
2. In `Code.gs`, update `doPost(e)` to accept the JSON action payload. The provided `Code.gs` includes this patch in `doPost` (the section mentioning `Netlify frontend API requests`).
3. Keep your existing Script Properties and spreadsheet configuration. Do not paste passwords or tokens into the frontend.
4. Save, then go to **Deploy → Manage deployments → Edit** your existing web app deployment, choose a new version, and deploy. Keep the same web app URL if possible.
5. Confirm the deployment URL is the one configured in `netlify/functions/apps-script.js`.

If your live Apps Script project has changes that are not in the provided `Code.gs`, do not replace the entire backend blindly. Apply only the `doPost` JSON-action patch to your existing code instead.

## 2. Deploy to Netlify
1. Sign in at https://app.netlify.com/.
2. Choose **Add new site → Deploy manually** (wording may vary).
3. Upload the ZIP contents after extracting the ZIP, or drag the extracted `Netlify_WhatsApp_Sales_CRM` folder into the manual deploy area.
4. Wait for Netlify to publish the site. Open the generated `https://....netlify.app` URL.

The project root must contain `netlify.toml`, `public/index.html`, and `netlify/functions/`. The backend source is kept in `backend/Code.gs` and is not published as a public website file.

## 3. Test
- Sign in using the CRM account created in the Users sheet.
- Verify contacts and dashboard data load.
- Try saving a test contact before importing or editing real customer data.

## Troubleshooting
- `Apps Script returned a non-JSON response`: redeploy the web app, check the URL, and verify access settings permit the web app to execute as intended.
- `Unknown action` or permission errors: check that the current Apps Script backend has the matching CRM routes and role permissions.
- Keep `Code.gs` server-side. Never put spreadsheet IDs, admin passwords, WhatsApp access tokens, or other secrets in `index.html`.
