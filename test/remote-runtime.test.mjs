import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRODUCTION_HTML = [
    "index.html",
    "participate.html",
    "tasks-data.html",
    "evaluation.html",
    "rules-faq.html",
    "team-registration.html"
];

async function source(relativePath) {
    return readFile(path.join(ROOT, relativePath), "utf8");
}

test("production pages use the remote Firebase project and gate emulators to loopback", async () => {
    const firebaseConfig = await source("assets/firebase-config.js");
    const firebaseProject = JSON.parse(await source(".firebaserc"));

    assert.match(
        firebaseConfig,
        /projectId:\s*"roco-spring-registration-2026"/u
    );
    assert.match(firebaseConfig, /const functionsRegion = "europe-west3";/u);
    assert.equal(firebaseProject.projects.default, "roco-spring-registration-2026");
    assert.match(
        firebaseConfig,
        /const isLocalDevelopment = \["localhost", "127\.0\.0\.1"\]\.includes\(window\.location\.hostname\);/u
    );
    assert.match(
        firebaseConfig,
        /if \(isLocalDevelopment\) \{[\s\S]*?connectAuthEmulator\([\s\S]*?connectFunctionsEmulator\([\s\S]*?\}/u
    );
    assert.equal(
        [...firebaseConfig.matchAll(/\bconnectAuthEmulator\s*\(/gu)].length,
        1,
        "Auth emulator must have exactly one, loopback-gated call"
    );
    assert.equal(
        [...firebaseConfig.matchAll(/\bconnectFunctionsEmulator\s*\(/gu)].length,
        1,
        "Functions emulator must have exactly one, loopback-gated call"
    );

    for (const file of PRODUCTION_HTML) {
        const html = await source(file);
        assert.doesNotMatch(
            html,
            /\b(?:href|src)=["'](?:file:|https?:\/\/(?:localhost|127\.0\.0\.1)(?=[:/]))/iu,
            `${file} must not load a local production resource`
        );
    }

    const browserAssets = (await readdir(path.join(ROOT, "assets")))
        .filter((filename) => filename.endsWith(".js") && filename !== "firebase-config.js");
    for (const filename of browserAssets) {
        const javascript = await source(path.join("assets", filename));
        assert.doesNotMatch(
            javascript,
            /(?:file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1)(?=[:/])|\/(?:ceph|home|tmp)\/)/iu,
            `${filename} must not call a local service or filesystem path`
        );
        assert.doesNotMatch(javascript, /\bconnect(?:Auth|Functions)Emulator\s*\(/u, filename);
    }
});

test("Functions have no workstation service or filesystem runtime dependency", async () => {
    const sourceDirectory = path.join(ROOT, "functions/src");
    const filenames = (await readdir(sourceDirectory))
        .filter((filename) => filename.endsWith(".ts"));
    const entries = await Promise.all(filenames.map(async (filename) => ({
        filename,
        text: await readFile(path.join(sourceDirectory, filename), "utf8")
    })));
    const productionRuntime = entries
        .map(({ filename, text }) => `// ${filename}\n${text}`)
        .join("\n");

    for (const forbidden of [
        /from\s+["']node:child_process["']/u,
        /from\s+["']node:fs(?:\/promises)?["']/u,
        /from\s+["']node:(?:net|http|https)["']/u,
        /\bprocess\.cwd\s*\(/u,
        /\b(?:listen|setInterval)\s*\(/u,
        /(?:^|["'`\s])\/(?:ceph|home|tmp)\//u,
        /\bfile:\/\//u
    ]) {
        assert.doesNotMatch(productionRuntime, forbidden);
    }

    const configConsumers = entries
        .filter(({ filename }) => filename !== "config.ts")
        .map(({ text }) => text)
        .join("\n");
    assert.doesNotMatch(
        configConsumers,
        /\bGOOGLE_OAUTH_REDIRECT_URI\b/u,
        "the legacy loopback redirect constant must not be used by deployed Functions"
    );
});

test("registration recovery is a remotely scheduled Firebase function", async () => {
    const functionsIndex = await source("functions/src/index.ts");
    const firebaseConfig = JSON.parse(await source("firebase.json"));
    const declaration = functionsIndex.match(
        /export const reconcileRegistrations = onSchedule\(([\s\S]*?)\n\);/u
    )?.[1] ?? "";

    assert.match(functionsIndex, /from "firebase-functions\/v2\/scheduler"/u);
    assert.match(declaration, /region:\s*REGION/u);
    assert.match(declaration, /schedule:\s*"every 5 minutes"/u);
    assert.match(declaration, /maxInstances:\s*1/u);
    assert.match(declaration, /await reconcileRegistrationsOperation\(/u);
    assert.equal(firebaseConfig.functions.source, "functions");
    assert.equal(firebaseConfig.functions.runtime, "nodejs22");
});
