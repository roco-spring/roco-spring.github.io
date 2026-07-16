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
            initMobileNav();
        })
        .catch((error) => {
            console.error(error);
        });

    function initMobileNav() {
        const header = document.querySelector(".site-header");
        const toggle = header?.querySelector(".nav-toggle");
        const nav = header?.querySelector(".nav");

        if (!header || !toggle || !nav) {
            return;
        }

        function setNavOpen(open) {
            header.classList.toggle("is-nav-open", open);
            toggle.setAttribute("aria-expanded", String(open));
            toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
        }

        toggle.addEventListener("click", () => {
            setNavOpen(!header.classList.contains("is-nav-open"));
        });

        nav.querySelectorAll("a").forEach((link) => {
            link.addEventListener("click", () => setNavOpen(false));
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                setNavOpen(false);
            }
        });
    }

    function markCurrentNavLink() {
        const page = location.pathname.split("/").pop() || "index.html";
        const activePage = page === "team-registration.html" ? "participate.html" : page;

        document.querySelectorAll(".site-header .nav a").forEach((link) => {
            const href = link.getAttribute("href");

            if (href === activePage) {
                link.setAttribute("aria-current", "page");
            }
        });
    }
})();
