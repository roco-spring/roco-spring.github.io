(function installRegistrationStartupFallback() {
    "use strict";

    let startupFailureShown = false;

    function showStartupFailure() {
        if (startupFailureShown || window.rocoTeamRegistrationSettled === true) return;

        startupFailureShown = true;
        const portal = document.getElementById("registration-portal");
        const loading = document.getElementById("portal-loading");

        if (!portal || !loading) return;

        portal.setAttribute("aria-busy", "false");
        loading.classList.add("form-status");
        loading.dataset.state = "error";
        loading.setAttribute("role", "alert");
        loading.setAttribute("aria-live", "assertive");
        loading.textContent = "Secure team services could not be loaded. Check the connection, refresh the page, or contact roco-spring-org@googlegroups.com.";
    }

    window.addEventListener("error", (event) => {
        if (event.target instanceof HTMLScriptElement && event.target.type === "module") {
            showStartupFailure();
        }
    }, true);

    window.setTimeout(showStartupFailure, 15000);
}());
