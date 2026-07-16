import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

test("security scanner detects a credential shape without echoing its value", async () => {
    const fixtureName = `.security-scan-fixture-${process.pid}.txt`;
    const fixturePath = path.join(ROOT, fixtureName);
    const syntheticSecret = ["GOC", "SPX-", "A".repeat(28)].join("");
    const syntheticAccessToken = ["ya", "29.", "B".repeat(32)].join("");

    try {
        await writeFile(
            fixturePath,
            `${syntheticSecret}\n${syntheticAccessToken}\n`,
            { mode: 0o600, flag: "wx" }
        );
        const scannerEnvironment = {
            ...process.env,
            DEBUG: "",
            FIREBASE_DEBUG: "",
            NODE_DEBUG: ""
        };
        // A nested Node process must not inherit the test runner's private
        // protocol context or its stdout/stderr will be consumed as TAP IPC.
        delete scannerEnvironment.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ["scripts/security-scan.mjs"], {
            cwd: ROOT,
            encoding: "utf8",
            env: scannerEnvironment
        });
        const output = `${result.stdout}${result.stderr}`;

        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.signal, null, `scanner terminated by ${result.signal}`);

        assert.equal(result.status, 1);
        assert.match(output, new RegExp(fixtureName.replaceAll(".", "\\."), "u"));
        assert.match(output, /Google OAuth client secret value/u);
        assert.match(output, /Google OAuth access token value/u);
        assert.equal(output.includes(syntheticSecret), false);
        assert.equal(output.includes(syntheticAccessToken), false);
    } finally {
        await rm(fixturePath, { force: true });
    }
});
