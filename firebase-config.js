/* BSL apps — Firebase settings (shared by every app in this folder).
 *
 * While apiKey still starts with "YOUR_", every app runs in TEST MODE:
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
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
