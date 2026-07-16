import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
    browserSessionPersistence,
    connectAuthEmulator,
    getAuth,
    setPersistence
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
    connectFunctionsEmulator,
    getFunctions
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-functions.js";
import {
    initializeAppCheck,
    ReCaptchaEnterpriseProvider
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app-check.js";

const firebaseConfig = {
    apiKey: "AIzaSyA4Qrg-9o6jA8chu-s3PDks4yfnH_A3mcE",
    authDomain: "roco-spring-registration-2026.firebaseapp.com",
    projectId: "roco-spring-registration-2026",
    storageBucket: "roco-spring-registration-2026.firebasestorage.app",
    messagingSenderId: "149052181991",
    appId: "1:149052181991:web:291a3915eb3b5bbd6fc142"
};

const recaptchaEnterpriseSiteKey = "6LfSN1UtAAAAAOCXmwtsu_brRvLWPnwlHixppEZz";
const functionsRegion = "europe-west3";
const isLocalDevelopment = ["localhost", "127.0.0.1"].includes(window.location.hostname);

// This is Firebase's official local App Check debug mechanism. Firebase prints a
// generated debug token for local allow-listing; no token is committed here.
if (isLocalDevelopment) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

const app = initializeApp(firebaseConfig);

// App Check is initialized before this module exports any callable Functions client.
const appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(recaptchaEnterpriseSiteKey),
    isTokenAutoRefreshEnabled: true
});

const auth = getAuth(app);
const functions = getFunctions(app, functionsRegion);

if (isLocalDevelopment) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

// Firebase scopes its managed authentication state to the browser session.
// Application code never writes passwords or team records to Web Storage.
const authPersistenceReady = setPersistence(auth, browserSessionPersistence);

export {
    app,
    appCheck,
    auth,
    authPersistenceReady,
    firebaseConfig,
    functions,
    functionsRegion,
    recaptchaEnterpriseSiteKey
};
