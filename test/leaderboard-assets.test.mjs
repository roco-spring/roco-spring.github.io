import assert from "node:assert/strict";
import test from "node:test";
import {
    fingerprintAsset,
    planLeaderboardAssetVersions,
    versionLeaderboardHtml
} from "../scripts/version-leaderboard-assets.mjs";

test("asset fingerprint changes with its content and is deterministic", () => {
    assert.equal(fingerprintAsset(Buffer.from("abc")), "ba7816bf8f01");
    assert.equal(fingerprintAsset("abc"), fingerprintAsset(Buffer.from("abc")));
    assert.notEqual(fingerprintAsset("abc"), fingerprintAsset("abc\n"));
});

test("asset rewriter refreshes only leaderboard resources and remains idempotent", () => {
    const input = `<link rel="stylesheet" href="assets/style.css?v=old">
<script src='assets/leaderboard.js'></script>
<script type="module" src="assets/leaderboard-live.js?v=old#module"></script>
<script src="assets/firebase-config.js"></script>
<script src="assets/team-registration.js"></script>
<a href="team-registration.html">Register</a>`;
    const versions = {
        "assets/style.css": "aaaaaaaaaaaa",
        "assets/leaderboard.js": "bbbbbbbbbbbb",
        "assets/leaderboard-live.js": "cccccccccccc"
    };
    const expected = `<link rel="stylesheet" href="assets/style.css?v=aaaaaaaaaaaa">
<script src='assets/leaderboard.js?v=bbbbbbbbbbbb'></script>
<script type="module" src="assets/leaderboard-live.js?v=cccccccccccc#module"></script>
<script src="assets/firebase-config.js"></script>
<script src="assets/team-registration.js"></script>
<a href="team-registration.html">Register</a>`;
    assert.equal(versionLeaderboardHtml(input, versions), expected);
    assert.equal(versionLeaderboardHtml(expected, versions), expected);
    assert.throws(() => versionLeaderboardHtml(input, {}), /invalid content fingerprint/u);
    assert.throws(() => versionLeaderboardHtml("<p>No resources</p>", versions), /Missing leaderboard asset reference/u);
});

test("published leaderboard pages pin the current content of all three assets", async () => {
    for (const { page, original, versioned } of await planLeaderboardAssetVersions()) {
        // A mismatch needs the repair command, not a dump of the entire page.
        assert.ok(original === versioned, `${page} has stale asset URLs; run npm run assets:version`);
    }
});
