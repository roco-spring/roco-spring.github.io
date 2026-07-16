import assert from "node:assert/strict";
import test from "node:test";

import { verifyReleaseSource } from "../scripts/verify-release-source.mjs";

function gitStub({ status = "", commit = "a".repeat(40), error = null } = {}) {
    return (_command, argumentsList) => {
        if (error) throw error;
        if (argumentsList[0] === "status") return `${status}\n`;
        if (argumentsList[0] === "rev-parse") return `${commit}\n`;
        throw new Error("Unexpected git operation.");
    };
}

test("release source gate returns the exact SHA for a clean committed tree", () => {
    assert.equal(verifyReleaseSource(gitStub()), "a".repeat(40));
});

test("release source gate rejects tracked or untracked working-tree changes", () => {
    assert.throws(
        () => verifyReleaseSource(gitStub({ status: " M assets/style.css" })),
        /clean committed working tree/u
    );
    assert.throws(
        () => verifyReleaseSource(gitStub({ status: "?? untracked.txt" })),
        /clean committed working tree/u
    );
});

test("release source gate rejects unreadable repositories and invalid SHAs", () => {
    assert.throws(
        () => verifyReleaseSource(gitStub({ error: new Error("missing git") })),
        /accessible Git checkout/u
    );
    assert.throws(
        () => verifyReleaseSource(gitStub({ commit: "not-a-sha" })),
        /exact commit SHA/u
    );
});
