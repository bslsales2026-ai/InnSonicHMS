# BSL staff apps (app.innsonic.com)

Keep all files in the SAME folder on the server.

| File | App | Data prefix |
|---|---|---|
| `index.html` | Launcher page linking every app | — |
| `rajendrapur-rooms.html` | Front Desk, BCDM Rajendrapur | `raj_` |
| `savar-rooms.html` | Front Desk, BCDM Savar (room setup screen on first open) | `svr_` |
| `bci-rooms.html` | Front Desk, BRAC Centre Inn | `bci_` |
| `conference-banqueting.html` | Conference & Banqueting + Restaurant (all 3 properties) | `venues_` |
| `firebase-config.js` | The ONE file you edit to go live (shared by all apps) | — |
| `shared/` | Code shared by the apps: `bsl-storage.js` (test/Firebase storage + sign-in), `front-desk.js`/`.css` (all three front desks), `conference-banqueting.js`/`.css` | — |
| `index_raj.html` | Redirect from the old BRAC Centre Inn URL to `bci-rooms.html` | — |

## Changing a property
Each front-desk page only holds its property settings (`BSL_PROPERTY`: name, floor list,
default room blocks for first-time setup). Fixes to front-desk behaviour go in
`shared/front-desk.js` once and apply to all three properties.

## Test mode (current state)
While `firebase-config.js` still holds the `YOUR_...` placeholders, every app runs in
TEST MODE (orange bar at the bottom): data is saved in that browser only. Good for
checking screens, NOT for real staff use.

## Go live (shared between all staff, ~15 minutes, free tier)
1. console.firebase.google.com > Add project.
2. Build > Firestore Database > Create database (production mode).
3. Build > Authentication > Get started > enable Email/Password. Under Users, add one
   user (email + password) for each staff member.
4. Project settings (gear) > General > Your apps > Web (</>) > register app >
   copy the firebaseConfig values into `firebase-config.js`.
5. Firestore > Rules, paste and Publish:

       rules_version = '2';
       service cloud.firestore {
         match /databases/{db}/documents {
           match /{doc=**} { allow read, write: if request.auth != null; }
         }
       }

6. Authentication > Settings > Authorized domains: add `app.innsonic.com`.
7. Upload the updated `firebase-config.js` and reload the apps — staff sign in with
   the email/password you created.

## Notes
- All apps share one Firebase project; each keeps its own data (prefixes above).
- Data entered in test mode stays in that browser and is not copied to Firebase.
- Savar's room setup starts empty: enter its room numbers, types and rates on first
  open. Rooms can be changed later from "Edit rooms" on the dashboard.
