import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
    parseReleaseSourceMode,
    verifyReleaseSource
} from "../scripts/verify-release-source.mjs";

function gitStub({
    status = "",
    commit = "a".repeat(40),
    branch = "main",
    upstream = "origin/main",
    originUrl = "git@github.com:roco-spring/roco-spring.github.io.git",
    originCommit = null,
    ancestor = true,
    error = null
} = {}) {
    return (_command, argumentsList) => {
        if (error) throw error;
        if (argumentsList[0] === "status") return `${status}\n`;
        if (argumentsList[0] === "symbolic-ref") return `${branch}\n`;
        if (argumentsList[0] === "remote") return `${originUrl}\n`;
        if (argumentsList[0] === "merge-base") {
            if (!ancestor) throw new Error("not an ancestor");
            return "";
        }
        if (argumentsList[0] === "rev-parse") {
            if (argumentsList.includes("@{upstream}")) return `${upstream}\n`;
            if (argumentsList.at(-1) === "origin/main") {
                return `${originCommit ?? commit}\n`;
            }
            return `${commit}\n`;
        }
        throw new Error("Unexpected git operation.");
    };
}

test("release source gate returns the exact SHA for a clean committed tree", () => {
    assert.equal(verifyReleaseSource(gitStub()), "a".repeat(40));
    assert.deepEqual(parseReleaseSourceMode([]), { allowLocalAhead: false });
    assert.deepEqual(
        parseReleaseSourceMode(["--allow-local-ahead"]),
        { allowLocalAhead: true }
    );
    assert.throws(() => parseReleaseSourceMode(["--unsafe"]), /invalid arguments/u);
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

test("release source gate requires exact main, upstream, and GitHub origin", () => {
    assert.throws(
        () => verifyReleaseSource(gitStub({ branch: "feature" })),
        /branch to be main/u
    );
    assert.throws(
        () => verifyReleaseSource(gitStub({ upstream: "fork/main" })),
        /track origin\/main/u
    );
    assert.throws(
        () => verifyReleaseSource(gitStub({ originUrl: "https://example.test/fork.git" })),
        /reviewed RoCo-Spring GitHub origin/u
    );
});

test("release source gate rejects missing, stale, or diverged origin/main", () => {
    assert.throws(
        () => verifyReleaseSource(gitStub({ originCommit: "not-a-sha" })),
        /fetched origin\/main commit/u
    );
    assert.throws(
        () => verifyReleaseSource(gitStub({ ancestor: false })),
        /stale or diverged/u
    );
    assert.throws(
        () => verifyReleaseSource(gitStub({ originCommit: "b".repeat(40) })),
        /HEAD to equal freshly fetched origin\/main/u
    );
    assert.equal(
        verifyReleaseSource(
            gitStub({ originCommit: "b".repeat(40) }),
            { allowLocalAhead: true }
        ),
        "a".repeat(40)
    );
});

test("production wiring tests, publishes non-force, and proves same-SHA Pages before mutation", async () => {
    const packageConfig = JSON.parse(await readFile(
        path.join(import.meta.dirname, "..", "package.json"),
        "utf8"
    ));
    assert.equal(
        packageConfig.scripts["release:fetch"],
        "git fetch --quiet --no-tags origin +refs/heads/main:refs/remotes/origin/main"
    );
    assert.equal(
        packageConfig.scripts["release:push"],
        "git push --porcelain origin HEAD:refs/heads/main"
    );
    assert.doesNotMatch(packageConfig.scripts["release:push"], /(?:--force|-f\b)/u);

    const commands = packageConfig.scripts["deploy:production"]
        .split(" && ")
        .map((command) => command.replace(/^npm run /u, ""));
    const prepushIndices = commands.flatMap((command, index) => (
        command === "release:source:prepush" ? [index] : []
    ));
    assert.equal(prepushIndices.length, 2);
    for (const prepushIndex of prepushIndices) {
        assert.equal(commands[prepushIndex - 1], "release:fetch");
    }

    const firstCloudMutation = commands.indexOf("identity:configure");
    const secrets = commands.indexOf("secrets:verify");
    const health = commands.indexOf("google:health:latest");
    const push = commands.indexOf("release:push");
    assert.ok(firstCloudMutation >= 0 && secrets >= 0 && health >= 0 && push >= 0);
    assert.ok(prepushIndices[1] < secrets && secrets < health && health < push);
    assert.deepEqual(commands.slice(push, push + 7), [
        "release:push",
        "release:fetch",
        "release:source",
        "release:publication",
        "release:fetch",
        "release:source",
        "identity:configure"
    ]);
    const deploy = commands.indexOf("deploy:firebase");
    assert.ok(deploy > firstCloudMutation);
    assert.equal(commands[deploy - 2], "release:fetch");
    assert.equal(commands[deploy - 1], "release:source");
});
