# BSL staff apps (app.innsonic.com)

Keep all files in the SAME folder on the server.

| File | App | Data prefix |
|---|---|---|
| `index.html` | Launcher page linking every app | — |
| `rajendrapur-rooms.html` | Front Desk, BCDM Rajendrapur | `raj_` |
| `savar-rooms.html` | Front Desk, BCDM Savar (room setup screen on first open) | `svr_` |
| `bci-rooms.html` | Front Desk, BRAC Centre Inn | `bci_` |
| `savar-sales.html` | Sales Control Chart, BCDM Savar: tentative/confirmed/blocked/out-of-order holds on rooms and venues, pipeline, rep & team performance | `svr_` (`salesHolds`, `salesTeam`) |
| `conference-banqueting.html` | Conference & Banqueting + Restaurant (all 3 properties) | `venues_` |
| `firebase-config.js` | The ONE file you edit to go live (shared by all apps) | — |
| `shared/` | Code shared by the apps: `bsl-storage.js` (test/Firebase storage + sign-in), `front-desk.js`/`.css` (all three front desks), `conference-banqueting.js`/`.css` | — |
| `vendor/firebase/` | Firebase JS SDK 10.12.2, hosted here so no other domain is needed to load the apps | — |
| `shared/fonts*` | Self-hosted fonts (IBM Plex Sans, Fraunces; SIL Open Font License) | — |
| `index_raj.html` | Redirect from the old BRAC Centre Inn URL to `bci-rooms.html` | — |

## Sales holds and the other apps
Sales holds are stored in the property's own data area (`svr_salesHolds` for Savar). They only
reserve inventory: the Sales app never writes rooms, bookings or reservations, so it cannot
check anyone in or change a room's status.
- Front Desk listens to the same collection: it shows today's holds and tomorrow's group
  arrivals (a housekeeping forecast), the number of rooms held for sales, lets staff link a
  check-in to a hold, and warns before selling the last unheld room of a type.
- The C&B venue board shows venue holds on each shift, includes them in the clash warning,
  and can turn a hold into an event booking (the hold is then marked Converted).

## Changing a property
Each front-desk page only holds its property settings (`BSL_PROPERTY`: name, floor list,
default room blocks for first-time setup). Fixes to front-desk behaviour go in
`shared/front-desk.js` once and apply to all three properties.

## Live mode (current state)
`firebase-config.js` is linked to the Firebase project **InnSonicHMS** (`innsonichms`), so
every app runs in live mode: staff sign in with email/password and data is shared through
Firestore. If the config ever goes back to `YOUR_...` placeholders, the apps fall back to
TEST MODE (orange bar; data saved in that browser only).

## Firebase project setup (InnSonicHMS)
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
