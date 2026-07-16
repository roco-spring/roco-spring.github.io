import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");

async function runCitationScript({ text, writeText }) {
    const source = await readFile(path.join(ROOT, "assets/citations.js"), "utf8");
    const status = { textContent: "" };
    let clickHandler;
    const button = {
        dataset: { copyTarget: "citation-test" },
        disabled: false,
        parentElement: { querySelector: () => status },
        addEventListener(type, handler) {
            if (type === "click") clickHandler = handler;
        }
    };
    const document = {
        querySelectorAll: () => [button],
        getElementById: () => ({ textContent: text }),
        createElement: () => {
            throw new Error("secure clipboard path should not create a fallback element");
        }
    };

    vm.runInNewContext(source, {
        document,
        navigator: { clipboard: { writeText } },
        window: { isSecureContext: true },
        Error
    });
    assert.equal(typeof clickHandler, "function");
    await clickHandler();
    return { button, status };
}

test("citation copy writes the exact unmodified BibTeX text", async () => {
    const bibtex = String.raw`@misc{example,
  title = {Exact {Text}},
  howpublished = {\url{https://example.org/a_b}}
}`;
    let copied;
    const { button, status } = await runCitationScript({
        text: bibtex,
        writeText: async (value) => {
            copied = value;
        }
    });
    assert.equal(copied, bibtex);
    assert.equal(status.textContent, "BibTeX copied.");
    assert.equal(button.disabled, false);
});

test("citation copy reports failure accessibly without changing source text", async () => {
    const bibtex = "@misc{unchanged}";
    const { button, status } = await runCitationScript({
        text: bibtex,
        writeText: async () => {
            throw new Error("clipboard denied");
        }
    });
    assert.match(status.textContent, /Copy failed/u);
    assert.equal(button.disabled, false);
});

