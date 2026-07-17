import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML_FILES = [
    "index.html",
    "participate.html",
    "tasks-data.html",
    "evaluation.html",
    "rules-faq.html",
    "team-registration.html"
];

async function source(relative) {
    return readFile(path.join(ROOT, relative), "utf8");
}

test("every site page preserves the shared shell and flow background", async () => {
    for (const file of HTML_FILES) {
        const html = await source(file);
        assert.match(html, /<canvas id="flow-canvas"/u, file);
        assert.match(html, /<header id="site-header"><\/header>/u, file);
        assert.match(html, /<footer id="site-footer"><\/footer>/u, file);
        assert.match(html, /assets\/style\.css/u, file);
        assert.match(html, /assets\/site-layout\.js/u, file);
        assert.match(html, /assets\/flow\.js/u, file);
    }
});

test("all local page, script, stylesheet, and image references resolve", async () => {
    for (const file of HTML_FILES) {
        const html = await source(file);
        const references = [...html.matchAll(/\b(?:href|src)="([^"]+)"/gu)].map((match) => match[1]);
        for (const reference of references) {
            if (/^(?:https?:|mailto:|#|data:)/u.test(reference) || reference === "") {
                continue;
            }
            const [withoutFragment] = reference.split("#");
            const [withoutQuery] = withoutFragment.split("?");
            await assert.doesNotReject(
                access(path.resolve(ROOT, path.dirname(file), withoutQuery)),
                `${file}: ${reference}`
            );
        }
    }
});

test("every local HTML fragment reference has a matching target", async () => {
    for (const file of HTML_FILES) {
        const html = await source(file);
        const references = [...html.matchAll(/href="([^"#]+\.html)?#([^"?]+)"/gu)];
        for (const [, linkedFile, fragment] of references) {
            const targetFile = linkedFile || file;
            const target = await source(targetFile);
            assert.match(target, new RegExp(`\\bid=["']${fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "u"), `${file}: #${fragment}`);
        }
    }
});

test("homepage and Participate registration placeholders link to the live page", async () => {
    const index = await source("index.html");
    const participate = await source("participate.html");
    assert.match(index, /href="team-registration\.html"[\s\S]{0,180}Register or manage your team/u);
    assert.match(participate, /href="team-registration\.html"[\s\S]{0,120}Register/u);
});

test("published repository, starting-kit framework, and support destinations replace active placeholders", async () => {
    const index = await source("index.html");
    const participate = await source("participate.html");
    const faq = await source("rules-faq.html");

    assert.match(index, /https:\/\/github\.com\/roco-spring\/roco-spring\.github\.io/u);
    assert.match(participate, /https:\/\/github\.com\/hmorimitsu\/roco-spring-devkit/u);
    for (const html of [participate, faq]) {
        assert.match(html, /https:\/\/github\.com\/roco-spring\/roco-spring\.github\.io\/issues/u);
        assert.match(html, /https:\/\/github\.com\/roco-spring\/roco-spring\.github\.io\/issues\/new\/choose/u);
    }

    const activeParticipate = participate.replace(/<!--[\s\S]*?-->/gu, "");
    const activeFaq = faq.replace(/<!--[\s\S]*?-->/gu, "");
    assert.doesNotMatch(activeParticipate, /GitHub repository:[\s\S]{0,120}Coming soon/u);
    assert.doesNotMatch(activeParticipate, /GitHub issues:[\s\S]{0,120}Coming soon/u);
    assert.doesNotMatch(activeParticipate, /Discussion forum:[\s\S]{0,120}Coming soon/u);
    assert.doesNotMatch(activeFaq, /GitHub issues:[\s\S]{0,120}Coming soon/u);
    assert.doesNotMatch(activeFaq, /Discussion forum:[\s\S]{0,120}Coming soon/u);
});

test("registration page includes the exact introduction and required controls", async () => {
    const html = (await source("team-registration.html")).replace(/\s+/gu, " ");
    assert.ok(html.includes("Register a team for the RoCo-Spring challenge. The person completing this registration must be one of the team members listed below. At least one competition track and one team member are required."));
    assert.match(html, /Register a new team/u);
    assert.match(html, /Sign in to an existing team/u);
    assert.match(html, /id="add-registration-member"/u);
    assert.match(html, /id="add-edit-member"/u);
    assert.match(html, /I confirm that the person submitting this registration is one of the team members listed below\.|I confirm that the person submitting this registration is one of the team members listed above\./u);
});

test("public Firebase configuration and regional App Check setup are exact", async () => {
    const config = await source("assets/firebase-config.js");
    for (const expected of [
        "AIzaSyA4Qrg-9o6jA8chu-s3PDks4yfnH_A3mcE",
        "roco-spring-registration-2026.firebaseapp.com",
        "roco-spring-registration-2026",
        "roco-spring-registration-2026.firebasestorage.app",
        "149052181991",
        "1:149052181991:web:291a3915eb3b5bbd6fc142",
        "6LfSN1UtAAAAAOCXmwtsu_brRvLWPnwlHixppEZz",
        "europe-west3",
        "ReCaptchaEnterpriseProvider",
        "isTokenAutoRefreshEnabled: true",
        "browserSessionPersistence"
    ]) {
        assert.ok(config.includes(expected), expected);
    }
});

test("frontend contains no direct account creation, direct Firestore, or manual data storage", async () => {
    const javascript = `${await source("assets/firebase-config.js")}\n${await source("assets/team-registration.js")}`;
    assert.doesNotMatch(javascript, /createUserWithEmailAndPassword/u);
    assert.doesNotMatch(javascript, /firebase-firestore|from\s+["'][^"']*firestore/u);
    assert.doesNotMatch(javascript, /\b(?:localStorage|sessionStorage)\b/u);
});

test("production deployment disables public Auth signup/deletion and verifies email/password login", async () => {
    const identityConfig = await source("scripts/configure-identity-platform.mjs");
    const packageConfig = JSON.parse(await source("package.json"));

    assert.match(identityConfig, /client\.permissions\.disabledUserSignup/u);
    assert.match(identityConfig, /disabledUserSignup:\s*true/u);
    assert.match(identityConfig, /client\.permissions\.disabledUserDeletion/u);
    assert.match(identityConfig, /disabledUserDeletion:\s*true/u);
    assert.match(identityConfig, /emailPrivacyConfig\.enableImprovedEmailPrivacy/u);
    assert.match(identityConfig, /enableImprovedEmailPrivacy:\s*true/u);
    assert.match(identityConfig, /signIn\.email\.enabled/u);
    assert.match(identityConfig, /signIn\.email\.passwordRequired/u);
    assert.match(identityConfig, /roco-spring-registration-2026/u);
    assert.match(packageConfig.scripts["deploy:production"], /identity:configure/u);
    assert.match(packageConfig.scripts["deploy:production"], /deploy:firebase/u);
    assert.match(packageConfig.scripts["deploy:production"], /release:source/u);
    assert.match(packageConfig.scripts["deploy:production"], /backend:smoke/u);
    assert.match(packageConfig.scripts["deploy:production"], /backend:appcheck-smoke/u);
});

test("every production callable declares the required region, CORS allowlist, and App Check", async () => {
    const functionsIndex = await source("functions/src/index.ts");
    for (const name of [
        "registerTeam",
        "getMyTeam",
        "updateMyTeam",
        "completeInitialPasswordChange"
    ]) {
        const declaration = functionsIndex.match(
            new RegExp(`export const ${name} = onCall\\(([\\s\\S]*?)\\n\\);`, "u")
        )?.[1] ?? "";
        assert.match(declaration, /region:\s*REGION/u, name);
        assert.match(declaration, /cors:\s*callableCors/u, name);
        assert.match(declaration, /enforceAppCheck:\s*true/u, name);
    }
});

test("citation BibTeX appears verbatim in its required context", async () => {
    const participate = await source("participate.html");
    const tasks = await source("tasks-data.html");
    const ptlflow = String.raw`@misc{morimitsu2021ptlflow,
  author = {Henrique Morimitsu},
  title = {PyTorch Lightning Optical Flow},
  year = {2021},
  publisher = {GitHub},
  journal = {GitHub repository},
  howpublished = {\url{https://github.com/hmorimitsu/ptlflow}}
}`;
    const spring = String.raw`@inproceedings{mehl2023spring,
    title={Spring: A High-Resolution High-Detail Dataset and Benchmark for Scene Flow, Optical Flow and Stereo},
    author={Mehl, Lukas and Schmalfuss, Jenny and Jahedi, Azin and Nalivayko, Yaroslava and Bruhn, Andr{\'e}s},
    booktitle={Proc. IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)},
    pages={4981--4991},
    year={2023}
}`;
    const robustSpring = String.raw`@inproceedings{oei2026robustspring,
    title={RobustSpring: Benchmarking Robustness to Image Corruptions for Optical Flow, Scene Flow and Stereo},
    author={Oei, Victor and Schmalfuss, Jenny and Mehl, Lukas and Bartsch, Madlen and Agnihotri, Shashank and Keuper, Margret and Bulling, Andreas and Bruhn, Andres},
    booktitle={Proc. International Conference on Learning Representations (ICLR)},
    year={2026}
}`;
    assert.ok(participate.includes(ptlflow));
    assert.ok(tasks.includes(spring));
    assert.ok(tasks.includes(robustSpring));
});

test("citation blocks use semantic code and accessible native copy buttons", async () => {
    for (const file of ["participate.html", "tasks-data.html"]) {
        const html = await source(file);
        assert.match(html, /<pre[^>]*>\s*<code/u, file);
        assert.match(html, /<button[^>]*(?:data-copy-citation|data-copy-target)/u, file);
        assert.match(html, /aria-live="polite"/u, file);
        assert.match(html, /assets\/citations\.js/u, file);
    }
});

test("private Firestore data is denied to every client", async () => {
    const rules = await source("firestore.rules");
    assert.match(rules, /match \/\{document=\*\*\}/u);
    assert.match(rules, /allow read, write: if false;/u);
    assert.doesNotMatch(rules, /if true/u);
});

test("OAuth bootstrap requests only the required narrow scopes", async () => {
    const bootstrap = await source("scripts/bootstrap-google-oauth.mjs");
    const scopes = [...bootstrap.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/gu)].map((match) => match[0]);
    assert.deepEqual([...new Set(scopes)].sort(), [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/gmail.send"
    ]);
    assert.doesNotMatch(bootstrap, /auth\/drive(?:["'`\s,])/u);
});

test("deployment scripts invoke the pinned Firebase CLI through Node", async () => {
    for (const file of [
        "scripts/firebase-safe.mjs",
        "scripts/bootstrap-google-oauth.mjs",
        "scripts/verify-secret-metadata.mjs"
    ]) {
        const script = await source(file);
        assert.match(script, /firebase-tools/u, file);
        assert.match(script, /firebase\.js/u, file);
        assert.match(script, /spawnSync\(\s*process\.execPath/u, file);
        assert.doesNotMatch(script, /"\.bin"/u, file);
    }
});

test("Firebase deploys use a bounded backend-discovery timeout", async () => {
    const firebaseSafe = await source("scripts/firebase-safe.mjs");
    assert.match(firebaseSafe, /firebaseArgs\[0\]\s*===\s*["']deploy["']/u);
    assert.match(
        firebaseSafe,
        /environment\.FUNCTIONS_DISCOVERY_TIMEOUT\s*=\s*["']30["']/u
    );
    assert.match(firebaseSafe, /\[firebase,\s*\.\.\.firebaseArgs\]/u);
});
