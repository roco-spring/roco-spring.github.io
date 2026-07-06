const lightbox = document.getElementById("image-lightbox");

if (lightbox) {
    const lightboxImage = lightbox.querySelector("img");
    const closeButton = lightbox.querySelector(".image-lightbox-close");
    let savedScrollY = 0;
    let lastActiveElement = null;

    function lockScrollPosition() {
        window.scrollTo(0, savedScrollY);
    }

    function closeLightbox() {
        lightbox.close();
        lightboxImage.removeAttribute("src");
        lightboxImage.alt = "";
        lockScrollPosition();
        lastActiveElement?.focus({ preventScroll: true });
    }

    document.querySelectorAll("[data-lightbox-src]").forEach((trigger) => {
        trigger.addEventListener("click", (event) => {
            event.preventDefault();
            lastActiveElement = document.activeElement;
            savedScrollY = window.scrollY;
            lightboxImage.src = trigger.dataset.lightboxSrc;
            lightboxImage.alt = trigger.dataset.lightboxAlt || "";
            lightbox.showModal();
            lockScrollPosition();
            requestAnimationFrame(lockScrollPosition);
        });
    });

    closeButton.addEventListener("click", closeLightbox);

    lightbox.addEventListener("click", (event) => {
        if (event.target === lightbox) {
            closeLightbox();
        }
    });

    lightbox.addEventListener("cancel", () => {
        lightboxImage.removeAttribute("src");
        lightboxImage.alt = "";
        lockScrollPosition();
        lastActiveElement?.focus({ preventScroll: true });
    });
}
