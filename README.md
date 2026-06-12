# Stroke & Turn Agent (Desktop App)

Auto-advances heats from Meet Maestro → Firebase → all judges update instantly.

---

## One-time setup (you do this, not Casey)

### 1. Install dependencies
```
npm install
```

### 2. Fill in your Firebase credentials
Open `src/main.js` and find the `FIREBASE_CONFIG` block near the top:

```js
const FIREBASE_CONFIG = {
  apiKey:            "REPLACE_WITH_YOUR_API_KEY",
  projectId:         "REPLACE_WITH_YOUR_PROJECT_ID",
  ...
};
```

Get these values from:
**Firebase Console → your project → gear icon → Project Settings → Your apps**

Replace all 4 `REPLACE_WITH_...` values. Save the file.

### 3. Test it (no Meet Maestro needed)
```
npm start
```

Create a test file anywhere on your computer:
```json
{ "currentEvent": 1, "currentHeat": 1 }
```

In the app, click "Select timing_system_configuration.json" and pick that file.
Open the Stroke & Turn app as Chief Judge (this sets the active meet).
Edit the JSON file to `currentEvent: 2` and save — the app should update instantly.

### 4. Build the installer (for Casey)
```
npm run build
```
This creates `dist/Stroke & Turn Agent Setup.exe` — send this to Casey.
Casey double-clicks it, it installs like any normal Windows app.

---

## Casey's workflow on meet day

1. Open Stroke & Turn app on his phone → Chief Judge dashboard
2. Double-click **Stroke & Turn Agent** on the Meet Maestro laptop
3. First time: click "Select timing_system_configuration.json" → find the file
4. Every time after: just double-click — it remembers the file automatically
5. Minimize the window — done

---

## What the window shows

- **Meet**: which meet it's connected to (comes from the app automatically)
- **Last pushed heat**: the most recent heat it sent to Firebase
- **Timing file**: which file it's watching (click "Change file" to switch)
- **Activity log**: live feed of everything happening

---

## Different laptop at a different pool

No problem. Casey just:
1. Double-clicks the app
2. Clicks "Select timing_system_configuration.json"  
3. Finds the file on that laptop (Meet Maestro usually puts it in `C:\MaestroData\`)
4. Done — it saves the path for that laptop

Each laptop remembers its own file path independently.

---

## Troubleshooting

**"Waiting — open Stroke & Turn as Chief Judge"**  
→ Casey needs to open the app on his phone. The agent reads the active meet from the app.

**"Firebase error"**  
→ Check internet connection on the laptop. The agent needs WiFi.

**Heat not advancing**  
→ Check that the timing file is actually changing when Meet Maestro advances. 
   Open the file in Notepad and watch `currentEvent`/`currentHeat` values.
