/* BSL apps — Firebase settings (shared by every app in this folder).
 *
 * Firebase project: InnSonicHMS (innsonichms).
 * If apiKey ever starts with "YOUR_", every app runs in TEST MODE:
 * data stays in each browser only, and an orange bar says so.
 *
 * To go live: create a Firebase project (see README.md), then replace the six
 * values below with the ones from Project settings > General > Your apps > Web app.
 * Nothing else needs to change; reload the apps and staff get a sign-in screen.
 *
 * These values identify the project; they are not passwords. Access is
 * protected by Firebase Authentication plus the Firestore rules in README.md.
 */
window.BSL_FIREBASE = {
  apiKey: "AIzaSyDE5bVW02bh3jgE-BU0t5k2bo1yWi3QQ90",
  authDomain: "innsonichms.firebaseapp.com",
  projectId: "innsonichms",
  storageBucket: "innsonichms.firebasestorage.app",
  messagingSenderId: "154848302859",
  appId: "1:154848302859:web:8c60e269eea07bbfee740e",
  measurementId: "G-7C404BQ021" // Google Analytics ID; the apps do not load Analytics
};
