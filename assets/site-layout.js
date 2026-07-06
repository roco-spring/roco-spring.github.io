(function () {
    const chromeUrl = new URL("site-chrome.html", document.currentScript.src).href;

    fetch(chromeUrl)
        .then((response) => {
            if (!response.ok) {
                throw new Error("Failed to load site chrome");
            }

            return response.text();
        })
        .then((html) => {
            const doc = new DOMParser().parseFromString(html, "text/html");
            const header = doc.querySelector("header");
            const footer = doc.querySelector("footer");
            const headerMount = document.getElementById("site-header");
            const footerMount = document.getElementById("site-footer");

            if (header && headerMount) {
                headerMount.replaceWith(header);
            }

            if (footer && footerMount) {
                footerMount.replaceWith(footer);
            }

            markCurrentNavLink();
        })
        .catch((error) => {
            console.error(error);
        });

    function markCurrentNavLink() {
        const page = location.pathname.split("/").pop() || "index.html";

        document.querySelectorAll(".site-header .nav a").forEach((link) => {
            const href = link.getAttribute("href");

            if (href === page) {
                link.setAttribute("aria-current", "page");
            }
        });
    }
})();
