(function () {
    document.querySelectorAll(".bibtex-copy[data-copy-target]").forEach((button) => {
        button.addEventListener("click", async () => {
            const citationId = button.dataset.copyTarget;
            const citation = citationId ? document.getElementById(citationId) : null;
            const status = button.parentElement?.querySelector(".copy-status");

            if (!citation || !status) {
                return;
            }

            button.disabled = true;
            status.textContent = "Copying…";

            try {
                await copyExactText(citation.textContent);
                status.textContent = "BibTeX copied.";
            } catch {
                status.textContent = "Copy failed. Select the BibTeX text and copy it manually.";
            } finally {
                button.disabled = false;
            }
        });
    });

    async function copyExactText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.className = "clipboard-fallback";
        document.body.append(textarea);
        textarea.select();

        try {
            if (!document.execCommand("copy")) {
                throw new Error("Copy command was rejected");
            }
        } finally {
            textarea.remove();
        }
    }
})();
