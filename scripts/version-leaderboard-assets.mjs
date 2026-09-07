#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
export const LEADERBOARD_PAGES = Object.freeze(["index.html", "evaluation.html"]);
export const LEADERBOARD_ASSETS = Object.freeze([
    "assets/leaderboard.js",
    "assets/leaderboard-live.js",
    "assets/style.css"
]);

export function fingerprintAsset(bytes) {
    return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

export function versionLeaderboardHtml(html, versions) {
    const found = new Set();
    // Only these three src/href values change. Registration, other resources,
    // page content, and existing HTML formatting retain their exact bytes.
    const versioned = html.replace(
        /(\b(?:href|src)\s*=\s*)(["'])(assets\/(?:leaderboard(?:-live)?\.js|style\.css))(?:\?[^"'#]*)?(#[^"']*)?\2/gu,
        (_match, attribute, quote, asset, fragment = "") => {
            const version = versions[asset];
            if (!/^[a-f0-9]{12}$/u.test(version ?? "")) {
                throw new Error(`Missing or invalid content fingerprint for ${asset}.`);
            }
            found.add(asset);
            return `${attribute}${quote}${asset}?v=${version}${fragment}${quote}`;
        }
    );
    for (const asset of LEADERBOARD_ASSETS) {
        if (!found.has(asset)) throw new Error(`Missing leaderboard asset reference: ${asset}.`);
    }
    return versioned;
}

export async function planLeaderboardAssetVersions(root = ROOT) {
    const versions = Object.fromEntries(await Promise.all(
        LEADERBOARD_ASSETS.map(async (asset) => [
            asset,
            fingerprintAsset(await readFile(path.join(root, asset)))
        ])
    ));
    return await Promise.all(LEADERBOARD_PAGES.map(async (page) => {
        const original = await readFile(path.join(root, page), "utf8");
        return { page, original, versioned: versionLeaderboardHtml(original, versions) };
    }));
}

async function main() {
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== "--check")) {
        throw new Error("Usage: node scripts/version-leaderboard-assets.mjs [--check]");
    }
    const changes = (await planLeaderboardAssetVersions())
        .filter(({ original, versioned }) => original !== versioned);
    if (args.includes("--check")) {
        if (changes.length > 0) {
            throw new Error(`Stale leaderboard asset fingerprints in ${changes.map(({ page }) => page).join(", ")}. Run npm run assets:version.`);
        }
        process.stdout.write("Leaderboard asset fingerprints are current.\n");
        return;
    }
    // This is a bounded mechanical rewrite of two known HTML files. Changed
    // asset bytes receive new URLs as soon as a browser obtains the new HTML;
    // fingerprints cannot invalidate an already cached HTML document itself.
    for (const { page, versioned } of changes) {
        await writeFile(path.join(ROOT, page), versioned, "utf8");
    }
    process.stdout.write(`Updated leaderboard asset fingerprints in ${changes.length} page(s).\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    await main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
