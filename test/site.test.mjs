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

test("Leaderboard is the consistent public page name", async () => {
    const index = await source("index.html");
    const evaluation = await source("evaluation.html");
    const chrome = await source("assets/site-chrome.html");

    assert.match(evaluation, /<title>Leaderboard — RoCo-Spring<\/title>/u);
    assert.match(evaluation, /<div class="eyebrow">Leaderboard<\/div>/u);
    assert.match(chrome, /<a href="evaluation\.html">Leaderboard<\/a>/u);
    assert.match(index, /class="button secondary" href="evaluation\.html">Leaderboard<\/a>/u);
    assert.doesNotMatch(chrome, />Evaluation<\/a>/u);
    assert.doesNotMatch(index, /href="evaluation\.html">Evaluation<\/a>/u);
});

test("published leaderboard snapshot contains the exact public team roster", async () => {
    const snapshot = JSON.parse(await source("assets/leaderboard-data.json"));
    const expectedTeams = new Map([
        ["RoCo-8", ["JTS@UW", ["optical-flow", "exploration"]]],
        ["RoCo-9", ["Nitansh Jain", ["optical-flow", "stereo-matching"]]],
        ["RoCo-10", ["iktsuarpok", ["optical-flow"]]],
        ["RoCo-11", ["MLDA@EEE", ["scene-flow"]]],
        ["RoCo-12", ["aneev", ["optical-flow", "stereo-matching", "scene-flow"]]],
        ["RoCo-13", ["Abdulrahman M.Saadeldin", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]],
        ["RoCo-14", ["ZXUv2.0", ["optical-flow"]]],
        ["RoCo-15", ["Drivers", ["optical-flow", "stereo-matching"]]],
        ["RoCo-16", ["Swarm", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]],
        ["RoCo-17", ["BuildDiff", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]],
        ["RoCo-18", ["KOGUMA Lab", ["optical-flow", "stereo-matching", "scene-flow"]]],
        ["RoCo-19", ["KoreaU_DLmath", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]],
        ["RoCo-20", ["DDEVS", ["stereo-matching"]]],
        ["RoCo-21", ["mau5", ["optical-flow", "exploration"]]],
        ["RoCo-22", ["cactus8603", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]],
        ["RoCo-23", ["PlayStation", ["optical-flow"]]],
        ["RoCo-24", ["E-lab", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]],
        ["RoCo-25", ["HexWarrior", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]],
        ["RoCo-26", ["Batman", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]],
        ["RoCo-27", ["Mysterious Power of the East", ["optical-flow", "exploration"]]],
        ["RoCo-28", ["Norisk", ["scene-flow"]]],
        ["RoCo-29", ["VSAI", ["optical-flow"]]],
        ["RoCo-30", ["acvlab", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]],
        ["RoCo-31", ["e-motion AI", ["scene-flow", "exploration"]]],
        ["RoCo-32", ["XLR8", ["optical-flow", "stereo-matching", "scene-flow", "exploration"]]]
    ]);

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.teams.length, expectedTeams.size);
    assert.equal(new Set(snapshot.teams.map((team) => team.teamId)).size, expectedTeams.size);
    for (const team of snapshot.teams) {
        const expected = expectedTeams.get(team.teamId);
        assert.ok(expected, team.teamId);
        assert.equal(team.teamName, expected[0], team.teamId);
        assert.deepEqual(team.registeredTracks, expected[1], team.teamId);
        assert.equal(team.rankChange, 0, team.teamId);
        assert.equal(team.score, null, team.teamId);
        assert.equal(team.springMetric, null, team.teamId);
        assert.equal(team.robustSpringMetric, null, team.teamId);
        assert.equal(team.submittedAt, null, team.teamId);
        assert.deepEqual(Object.keys(team).sort(), [
            "rankChange",
            "registeredTracks",
            "robustSpringMetric",
            "score",
            "springMetric",
            "submittedAt",
            "teamId",
            "teamName"
        ]);
    }

    const crossTaskTeams = snapshot.teams.filter((team) =>
        ["optical-flow", "stereo-matching", "scene-flow"]
            .every((track) => team.registeredTracks.includes(track))
    );
    assert.equal(crossTaskTeams.length, 12);
});

test("leaderboard UI is data-driven, transparent about refresh, and wired on both pages", async () => {
    const index = await source("index.html");
    const evaluation = await source("evaluation.html");
    const script = await source("assets/leaderboard.js");

    assert.ok(evaluation.indexOf('id="leaderboards"') < evaluation.indexOf('<div class="eyebrow">Metric</div>'));
    assert.match(evaluation, /data-leaderboard-root data-mode="full"/u);
    assert.match(evaluation, /data-leaderboard-refresh/u);
    assert.match(evaluation, /Last updated:/u);
    assert.match(evaluation, /does not query Spring[\s\S]{0,80}trigger a benchmark sync/u);
    assert.match(evaluation, /No current public benchmark entry exposes a validated[\s\S]{0,80}team ID/u);
    assert.match(evaluation, /clean-to-corrupted prediction deltas instead/u);
    assert.match(evaluation, /those quantities are not interchangeable/u);
    assert.match(index, /<h2 id="leaderboard-preview-heading">Top Three by Track<\/h2>/u);
    assert.match(index, /data-leaderboard-root data-mode="preview"/u);
    assert.match(index, /Open full leaderboard/u);
    assert.match(index, /assets\/leaderboard\.js/u);
    assert.match(evaluation, /assets\/leaderboard\.js/u);

    for (const label of ["Optical Flow", "Stereo Matching", "Scene Flow", "Cross-Task"]) {
        assert.ok(script.includes(`label: "${label}"`), label);
    }
    for (const column of ["Rank", "Change", "Team", "RbS-Score", "Submission Time"]) {
        assert.ok(script.includes(`"${column}"`), column);
    }
    assert.match(script, /node\.textContent = "— 0"/u);
    assert.match(script, /return "—"/u);
    assert.match(script, /isFiniteNumber\(row\.rank\) \? String\(row\.rank\) : "—"/u);
    assert.match(script, /Swipe or scroll horizontally to see every column\./u);
    assert.match(script, /window\.RoCoLeaderboard = Object\.freeze/u);
    assert.match(script, /setDataSource\(loader\)/u);
    assert.match(script, /left\.teamId\.localeCompare\(right\.teamId/u);
    assert.match(evaluation, /B<sub>R<\/sub> constants and RbS-Scores remain pending/u);
    assert.match(evaluation, /For the proposed RoCo-Spring score/u);
    assert.match(evaluation, /Once the baselines are fixed/u);
});

test("site headings and named resources use consistent capitalization", async () => {
    const pages = await Promise.all(HTML_FILES.map(source));
    const html = pages.join("\n");

    for (const required of [
        "Four Challenge Tracks",
        "Competition Schedule",
        "Confirmed Keynote Speakers",
        "Sponsors &amp; Acknowledgements",
        "Step-by-Step Participation",
        "Task-Specific Error Metrics",
        "Frequently Asked Questions",
        "Register or Manage Your Team",
    ]) {
        assert.ok(html.includes(required), required);
    }

    assert.doesNotMatch(html, /starting kit/u);
    assert.doesNotMatch(html, /Starter kit/u);
    assert.match(html, /GitHub Starter Kit/u);
});

test("homepage and Participate registration placeholders link to the live page", async () => {
    const index = await source("index.html");
    const participate = await source("participate.html");
    assert.match(index, /href="team-registration\.html"[\s\S]{0,180}Register or manage your team/u);
    assert.match(participate, /href="team-registration\.html"[\s\S]{0,120}Register/u);
});

test("the devkit is the published GitHub resource and support destinations are active", async () => {
    const index = await source("index.html");
    const participate = await source("participate.html");
    const faq = await source("rules-faq.html");

    assert.match(index, /class="button starter-kit"[\s\S]{0,180}https:\/\/github\.com\/hmorimitsu\/roco-spring-devkit/u);
    assert.match(index, /<span>GitHub Starter Kit<\/span>/u);
    assert.match(index, /GitHub Starter Kit:[\s\S]{0,180}hmorimitsu\/roco-spring-devkit/u);
    assert.doesNotMatch(index, /roco-spring\/roco-spring\.github\.io/u);
    assert.match(participate, /https:\/\/github\.com\/hmorimitsu\/roco-spring-devkit/u);
    const stepFour = participate.match(
        /<li class="step-card">[\s\S]*?<div class="step-number" aria-hidden="true">4<\/div>[\s\S]*?<\/li>/u
    )?.[0] ?? "";
    assert.match(stepFour, /<h3>Install the Starter Kit<\/h3>/u);
    assert.match(
        stepFour,
        /class="button starter-kit" href="https:\/\/github\.com\/hmorimitsu\/roco-spring-devkit"[\s\S]*?target="_blank" rel="noopener noreferrer"/u
    );
    assert.match(stepFour, /class="button-icon"[\s\S]*?<span>GitHub Starter Kit<\/span>/u);
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

test("homepage includes the requested sponsor and project-specific acknowledgements", async () => {
    const index = await source("index.html");
    const chrome = await source("assets/site-chrome.html");
    const normalized = index
        .replace(/<[^>]+>/gu, " ")
        .replace(/\s+/gu, " ")
        .replace(/\s+([.,])/gu, "$1")
        .trim();

    assert.match(index, /<section class="section support-section" id="sponsors">/u);
    assert.match(chrome, /href="index\.html#sponsors">Sponsors<\/a>/u);
    assert.ok(normalized.includes(
        "This event is supported by the SFB-TRR 161 Quantitative Methods for Visual Computing."
    ));
    assert.ok(normalized.includes(
        "Shashank Agnihotri and Margret Keuper acknowledge funding by the DFG Research Unit 5336 – Learning to Sense (L2S)."
    ));
    assert.ok(normalized.includes(
        "Margret Keuper acknowledges funding by BMFTR project TrackOpt (01IS24074A-D)."
    ));
    assert.ok(normalized.includes(
        "Andres Bruhn and Victor Oei acknowledge funding by the Deutsche Forschungsgemeinschaft (DFG, German Research Foundation) – Project-ID 251654672 – TRR 161: Quantitative Methods for Visual Computing (B04, A07)."
    ));
    assert.ok(normalized.includes(
        "Katrin Bauer and Andres Bruhn acknowledge funding by the Deutsche Forschungsgemeinschaft (DFG, German Research Foundation) – Project-ID 533085500 – Robust Optical Flow."
    ));
    assert.ok(normalized.includes(
        "Katrin Bauer and Victor Oei acknowledge support from the International Max Planck Research School for Intelligent Systems (IMPRS-IS)."
    ));

    for (const asset of [
        "img/logos/dfg.png",
        "img/logos/l2s.svg",
        "img/logos/sfb-trr161.png",
        "img/logos/imprs-is.png"
    ]) {
        assert.ok(index.includes(`src="${asset}"`), asset);
        await assert.doesNotReject(access(path.join(ROOT, asset)), asset);
    }
    assert.match(index, /href="https:\/\/www\.sfbtrr161\.de\/"[\s\S]{0,220}SFB-TRR 161/u);
});

test("keynote speaker names and portraits link to their verified homepages", async () => {
    const index = await source("index.html");

    for (const speaker of [
        {
            name: "Jia Deng",
            homepage: "https://www.cs.princeton.edu/~jiadeng/",
            portrait: "img/speakers/jia-deng.webp"
        },
        {
            name: "Fatih Porikli",
            homepage: "https://www.porikli.com/",
            portrait: "img/speakers/fatih-porikli.webp"
        }
    ]) {
        assert.ok(index.includes(`href="${speaker.homepage}"`), speaker.name);
        assert.ok(index.includes(`src="${speaker.portrait}"`), speaker.name);
        assert.match(
            index,
            new RegExp(
                `<a href="${speaker.homepage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>${speaker.name}<\\/a>`,
                "u"
            ),
            speaker.name
        );
        await assert.doesNotReject(access(path.join(ROOT, speaker.portrait)), speaker.portrait);
    }
});

test("generic primary and secondary buttons have polished interaction states", async () => {
    const style = await source("assets/style.css");

    assert.match(style, /\.button:focus-visible\s*\{[\s\S]*?outline: 3px solid/u);
    assert.match(
        style,
        /\.button:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)\s*\{[\s\S]*?transform: translateY\(-3px\) scale\(1\.025\);/u
    );
    assert.match(style, /\.button\.primary\s*\{[\s\S]*?box-shadow:/u);
    assert.match(style, /\.button\.primary:hover[\s\S]*?box-shadow:/u);
    assert.match(style, /\.button\.secondary\s*\{[\s\S]*?box-shadow:/u);
    assert.match(style, /\.button\.secondary:hover[\s\S]*?box-shadow:/u);
    assert.match(style, /\.button\.compact\s*\{[\s\S]*?min-height: 40px;/u);
});

test("participation calls to action have a rainbow invitation ring and navigation tabs animate", async () => {
    const index = await source("index.html");
    const participate = await source("participate.html");
    const registration = await source("team-registration.html");
    const chrome = await source("assets/site-chrome.html");
    const style = await source("assets/style.css");

    assert.match(index, /class="button primary participate-cta" href="participate\.html"/u);
    assert.match(participate, /class="button primary compact participate-cta"/u);
    assert.match(registration, /class="button primary form-submit participate-cta"/u);
    assert.match(chrome, /<nav id="site-nav" class="nav"/u);
    assert.match(style, /\.button\.participate-cta::before\s*\{[\s\S]*?linear-gradient/u);
    assert.match(style, /\.button\.participate-cta:hover[\s\S]*?::before[\s\S]*?participate-ring-flow/u);
    assert.match(style, /@keyframes participate-ring-flow/u);
    assert.match(style, /\.nav a::after\s*\{[\s\S]*?transform: scaleX\(0\.2\);/u);
    assert.match(style, /\.nav a:hover::after[\s\S]*?transform: scaleX\(1\);/u);
});

test("OpenReview submission calls to action are branded, safe, and present at all paper entry points", async () => {
    const openReviewUrl = "https://openreview.net/group?id=NeurIPS.cc/2026/Workshop/RoCo-Spring";
    const index = await source("index.html");
    const participate = await source("participate.html");
    const evaluation = await source("evaluation.html");
    const style = await source("assets/style.css");

    const homeActions = index.match(/<div class="hero-actions">[\s\S]*?<\/div>/u)?.[0] ?? "";
    const stepNine = participate.match(
        /<li class="step-card">[\s\S]*?<div class="step-number" aria-hidden="true">9<\/div>[\s\S]*?<\/li>/u
    )?.[0] ?? "";
    const callForPapers = evaluation.match(
        /<section class="section" id="call-for-papers">[\s\S]*?<\/section>/u
    )?.[0] ?? "";

    for (const [location, html] of [
        ["home hero", homeActions],
        ["Participate Step 9", stepNine],
        ["Call for Papers", callForPapers]
    ]) {
        assert.match(html, /class="button openreview"/u, location);
        assert.ok(html.includes(`href="${openReviewUrl}"`), location);
        assert.match(html, /target="_blank" rel="noopener noreferrer"/u, location);
        assert.match(
            html,
            /<span class="openreview-wordmark">OpenReview<\/span>\s*<span>Submission<\/span>/u,
            location
        );
    }

    assert.match(evaluation, /<div class="eyebrow">Call for Papers<\/div>/u);
    assert.match(evaluation, /<h3 id="reproducibility">Reproducibility Package<\/h3>/u);
    assert.match(style, /\.button\.openreview\s*\{[\s\S]*?background: #8c1b13;/u);
    assert.match(style, /\.button\.openreview:hover[^{]*\{[\s\S]*?background: #7d1803;/u);
    assert.match(style, /\.openreview-wordmark\s*\{[\s\S]*?font-family: "Noto Sans", sans-serif;/u);
    await assert.doesNotReject(access(path.join(ROOT, "assets/fonts/noto-sans-latin.woff2")));
});

test("registration page includes the exact introduction and required controls", async () => {
    const html = (await source("team-registration.html")).replace(/\s+/gu, " ");
    assert.ok(html.includes("Register a team for the RoCo-Spring challenge. The person completing this registration must be one of the team members listed below. At least one competition track and one team member are required."));
    assert.match(html, /Register a new team/u);
    assert.match(html, /Sign in to an existing team/u);
    assert.match(html, /id="add-registration-member"/u);
    assert.match(html, /id="add-edit-member"/u);
    assert.match(html, /No fixed<\/strong> member limit/u);
    assert.doesNotMatch(html, /10 (?:members maximum|max)|up to 10 members|teammates up to 10/u);
    assert.match(html, /I confirm that the person submitting this registration is one of the team members listed above, and I understand that the team name, team ID, and selected tracks will appear on the public leaderboard\./u);
    assert.match(html, /Member names and contact details remain private\./u);
});

test("registration page includes a concise regional Google-services access notice", async () => {
    const html = (await source("team-registration.html")).replace(/\s+/gu, " ");
    assert.match(
        html,
        /class="portal-region-notice" role="note">\s*<strong>Regional access notice:<\/strong> If Google services are blocked or unavailable in your region, registration and sign-in may not work\. Where permitted, we recommend using a trusted VPN; this has worked smoothly in our testing\.\s*<\/p>/u
    );
    assert.ok(
        html.indexOf("Team Registration and Account")
        < html.indexOf("Regional access notice:")
    );
});

test("registration success includes an initially hidden spam-folder reminder", async () => {
    const html = (await source("team-registration.html")).replace(/\s+/gu, " ");
    assert.match(
        html,
        /id="registration-spam-notice" role="note" hidden><strong>Check your spam or junk folder\.<\/strong> The team-registration email contains your temporary password and sign-in instructions\./u
    );
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

test("frontend contains no direct account creation, direct Firestore, or persistent local storage", async () => {
    const javascript = `${await source("assets/firebase-config.js")}\n${await source("assets/team-registration.js")}`;
    assert.doesNotMatch(javascript, /createUserWithEmailAndPassword/u);
    assert.doesNotMatch(javascript, /firebase-firestore|from\s+["'][^"']*firestore/u);
    assert.doesNotMatch(javascript, /\blocalStorage\b/u);
    assert.match(javascript, /crypto\.subtle\.digest\("SHA-256"/u);
    assert.match(javascript, /timeout:\s*REGISTER_TEAM_TIMEOUT_MS/u);
    assert.match(javascript, /REGISTER_TEAM_TIMEOUT_MS\s*=\s*75000/u);
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
    assert.match(identityConfig, /"x-goog-user-project":\s*PROJECT_ID/u);
    assert.match(packageConfig.scripts["deploy:production"], /identity:configure/u);
    assert.match(packageConfig.scripts["deploy:production"], /deploy:firebase/u);
    assert.match(packageConfig.scripts["deploy:production"], /function-secrets:configure/u);
    assert.match(packageConfig.scripts["deploy:production"], /release:source/u);
    assert.match(packageConfig.scripts["deploy:production"], /release:push/u);
    assert.match(packageConfig.scripts["deploy:production"], /release:publication/u);
    assert.match(packageConfig.scripts["deploy:production"], /backend:smoke/u);
    assert.match(packageConfig.scripts["deploy:production"], /backend:appcheck-ci-smoke/u);
    assert.equal(
        packageConfig.scripts["backend:appcheck-smoke"],
        "node scripts/verify-live-app-check.mjs"
    );
});

test("every production callable declares the required region, CORS allowlist, and App Check", async () => {
    const functionsIndex = await source("functions/src/index.ts");
    const functionsConfig = await source("functions/src/config.ts");
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
        if (name === "registerTeam") {
            assert.match(declaration, /timeoutSeconds:\s*60/u, name);
        }
        if (name === "updateMyTeam") {
            assert.match(declaration, /timeoutSeconds:\s*60/u, name);
        }
    }
    assert.match(
        functionsConfig,
        /REGISTRATION_LEASE_MS\s*=\s*2\s*\*\s*60\s*\*\s*1_000/u
    );
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
    const flowBench = String.raw`@article{
agnihotri2025flowbench,
title={FlowBench: Benchmarking Optical Flow Estimation Methods for Reliability and Generalization},
author={Shashank Agnihotri and Julian Yuya Caspary and Luca Schwarz and Xinyan Gao and Jenny Schmalfuss and Andres Bruhn and Margret Keuper},
journal={Transactions on Machine Learning Research},
issn={2835-8856},
year={2025},
url={https://openreview.net/forum?id=Kh4bj6YDNm},
note={}
}`;
    assert.ok(participate.includes(ptlflow));
    assert.ok(tasks.includes(spring));
    assert.ok(tasks.includes(robustSpring));
    assert.ok(tasks.includes(flowBench));
    assert.match(tasks, /57[\s\S]{0,80}model checkpoints/u);
    assert.match(tasks, /23[\s\S]{0,80}common corruptions/u);
    assert.match(tasks, /data-copy-target="citation-flowbench"/u);
    assert.match(tasks, /https:\/\/openreview\.net\/forum\?id=Kh4bj6YDNm/u);
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
    assert.match(bootstrap, /hasRateLimitSecret\s*=\s*firebaseSecretExists/u);
    assert.match(bootstrap, /if\s*\(!hasRateLimitSecret\)/u);
    assert.match(bootstrap, /Preserving the independent rate-limit HMAC secret/u);
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
    const firebaseConfig = JSON.parse(await source("firebase.json"));
    assert.match(firebaseSafe, /firebaseArgs\[0\]\s*===\s*["']deploy["']/u);
    assert.match(
        firebaseSafe,
        /environment\.FUNCTIONS_DISCOVERY_TIMEOUT\s*=\s*["']30["']/u
    );
    assert.match(firebaseSafe, /\[firebase,\s*\.\.\.firebaseArgs\]/u);
    assert.deepEqual(firebaseConfig.functions.predeploy, [
        "node \"$RESOURCE_DIR/node_modules/typescript/bin/tsc\" -p \"$RESOURCE_DIR/tsconfig.json\""
    ]);
});
