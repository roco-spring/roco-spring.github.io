// This adapter keeps Firebase details out of the presentation module. The
// existing static JSON remains the initial, last-known-good view while App
// Check starts; subsequent refreshes use the bounded server-side synchronizer.
let callablePromise = null;

function getRefreshCallable() {
    if (!callablePromise) {
        callablePromise = Promise.all([
            import("https://www.gstatic.com/firebasejs/12.16.0/firebase-functions.js"),
            import("./firebase-config.js")
        ]).then(([{ httpsCallable }, { functions }]) =>
            httpsCallable(functions, "refreshLeaderboard", { timeout: 65000 }));
    }
    return callablePromise;
}

function syncStateFor(status) {
    if (status === "fresh") return "synchronized";
    if (status === "cache-hit") return "cached";
    if (status === "stale-cache") return "stale";
    throw new Error("The live leaderboard returned an invalid synchronization status.");
}

async function loadLiveSnapshot({ force = false } = {}) {
    const callRefreshLeaderboard = await getRefreshCallable();
    const response = await callRefreshLeaderboard({ force: force === true });
    if (!response.data || !Array.isArray(response.data.teams)) {
        throw new Error("The live leaderboard returned an invalid snapshot.");
    }
    return {
        snapshot: response.data,
        // The callable explicitly distinguishes a successful refresh, a valid
        // five-minute cache hit, and stale data retained after a failed sync.
        syncState: syncStateFor(response.data.syncStatus)
    };
}

function installLiveDataSource(loader = loadLiveSnapshot) {
    if (!window.RoCoLeaderboard) return null;
    if (typeof loader !== "function") throw new TypeError("Live leaderboard loader must be a function.");
    return window.RoCoLeaderboard.setDataSource(loader).catch((error) => {
        // The renderer deliberately retains the last successfully loaded
        // snapshot, so a temporary benchmark outage never blanks the page.
        console.warn("Live leaderboard synchronization is temporarily unavailable.", error);
    });
}

const isLocalStaticPreview = ["localhost", "127.0.0.1"].includes(window.location.hostname);
if (!isLocalStaticPreview && !installLiveDataSource()) {
    window.addEventListener("DOMContentLoaded", () => installLiveDataSource(), { once: true });
}

// The explicit installer is also a narrow, network-free test seam. Automatic
// installation stays disabled on localhost, so static previews never import
// Firebase or make production callable requests.
window.RoCoLeaderboardLive = Object.freeze({
    loadLiveSnapshot,
    installDataSource: installLiveDataSource
});
