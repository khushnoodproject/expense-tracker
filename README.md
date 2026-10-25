# Expense Tracker Lite

Personal expense tracker PWA for Khushnood khan. 100% free stack:
- **Frontend:** static files on GitHub Pages (this folder, except `backend/`)
- **Backend:** Google Apps Script (`backend/Code.gs`)
- **Database:** a Google Sheet in your Drive

```
expense-tracker-lite/
├── index.html  style.css  app.js  sw.js  manifest.json
├── icons/            (made from your photo: app icon, maskable icon, favicon, logo)
└── backend/Code.gs   (paste into Apps Script, do NOT need to upload to GitHub)
```

## Setup (about 10 minutes)

### 1. Backend (Google)
1. Go to sheets.new and name the sheet **Expense Tracker DB**.
2. Menu **Extensions > Apps Script**. Delete the sample code and paste all of `backend/Code.gs`.
3. At the top, replace `CHANGE_ME_TO_A_LONG_RANDOM_SECRET` with your own random secret (20+ letters/numbers). Keep a copy; you will type it into the app once.
4. Select the function **setup** in the toolbar and click **Run**. Approve the permissions (Advanced > Go to project > Allow). This creates the Transactions, Categories and Settings tabs.
5. **Deploy > New deployment > type: Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy and copy the **Web app URL** (ends in `/exec`).

### 2. Frontend (GitHub Pages)
1. Create a new GitHub repository (for example `expense-tracker`), public.
2. Upload `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json` and the `icons` folder to the repo root (do not upload your secret key anywhere).
3. Repo **Settings > Pages > Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder = `/ (root)`. Save.
4. After a minute your app is live at `https://YOUR-USERNAME.github.io/expense-tracker/`.

### 3. First launch
1. Open the URL on your phone. Create a PIN.
2. Paste the **Web App URL** and your **secret key**, then tap **Test & save**.
3. Install: Android Chrome menu > **Install app**; iPhone Safari Share > **Add to Home Screen**.

## How it works
- Add, edit and delete work offline; changes queue on your phone and sync automatically when you are online.
- The secret key and URL live only in your phone's storage, never in the GitHub repo. Every request to the backend must carry the key.
- The PIN only locks the app on that device. The secret key is what protects your data.
- Settings > **Backup all to Google Drive** saves a CSV in the folder *ExpenseTrackerLite Backups*. You can also add a monthly time trigger for `backupNow` in Apps Script.

## Troubleshooting
- **"Bad response" / CORS error:** the deployment must be *Execute as: Me* and *Access: Anyone*. Re-deploy and use the new `/exec` URL.
- **Code change not showing:** Apps Script needs **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**. The URL stays the same.
- **App looks old after an update:** change `VERSION` in `sw.js` (for example `etl-v2`), upload, then close and reopen the app.
- **"Unauthorized":** the key in the app differs from the key you ran `setup()` with. Run `setup()` again after editing the key, or fix it in Settings > Server connection.
- **Dates look odd in the sheet:** leave the Date column (B) as plain text; the app expects `YYYY-MM-DD`.
