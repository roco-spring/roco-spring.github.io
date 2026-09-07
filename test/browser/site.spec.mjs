import { expect, test } from "@playwright/test";

const SITE_PAGES = [
  "call-for-papers.html",
  "index.html",
  "participate.html",
  "tasks-data.html",
  "evaluation.html",
  "rules-faq.html"
];

const LEADERBOARD_BASELINES = {
  "optical-flow": {
    spring: 0.9925,
    medianDisagreement: 4.16,
    robustSpringProxy: 6.03,
    methodCount: 8
  },
  "stereo-matching": {
    spring: 3.4545,
    medianDisagreement: 16.18,
    robustSpringProxy: 18.4505,
    methodCount: 4
  },
  "scene-flow": {
    methodCount: 2,
    spring: { disparity1Abs: 7.466, disparity2Abs: 7.5935, flowEpe: 2.527 },
    medianDisagreement: { disparity1Abs: 17.005, disparity2Abs: 0.215, flowEpe: 4.21 },
    robustSpringProxy: { disparity1Abs: 24.471, disparity2Abs: 7.8085, flowEpe: 6.737 }
  }
};

for (const path of SITE_PAGES) {
  test(`${path} renders shared chrome and flow canvas without page errors`, async ({ page }) => {
    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      failedRequests.push(new URL(request.url()).pathname);
    });

    const response = await page.goto(`/${path}`);
    expect(response?.ok()).toBe(true);
    await expect(page.locator("header.site-header .brand")).toHaveText("RoCo-Spring");
    await expect(page.locator("footer.site-footer")).toContainText("NeurIPS 2026");
    await expect(page.locator("#flow-canvas")).toBeVisible();

    const canvasSize = await page.locator("#flow-canvas").evaluate((canvas) => ({
      width: canvas.width,
      height: canvas.height
    }));
    expect(canvasSize.width).toBeGreaterThan(0);
    expect(canvasSize.height).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
}

test("Leaderboard tabs render the published scored and pending methods with the complete roster", async ({ page }) => {
  await page.goto("/evaluation.html");

  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(0)).toHaveText("Optical Flow");
  await expect(tabs.nth(1)).toHaveText("Stereo Matching");
  await expect(tabs.nth(2)).toHaveText("Scene Flow");
  await expect(tabs.nth(3)).toHaveText("Cross-Task");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

  const visiblePanel = page.locator('[role="tabpanel"]:not([hidden])');
  const participantRows = visiblePanel.locator("tbody tr:not(.leaderboard-row--baseline)");
  const baselineRows = visiblePanel.locator("tbody tr.leaderboard-row--baseline");
  await expect(visiblePanel.locator("thead th")).toHaveCount(8);
  await expect(visiblePanel.getByRole("columnheader", { name: "Method Name" })).toBeVisible();
  // 31 Optical Flow teams produce 33 rows: KoreaU_DLmath has three methods.
  await expect(participantRows).toHaveCount(33);
  await expect(participantRows.locator(".leaderboard-pending-badge")).toHaveCount(32);
  await expect(participantRows.locator(".leaderboard-method-placeholder")).toHaveCount(28);
  await expect(participantRows.first().locator(".leaderboard-team-name")).toHaveText("VSAI");
  await expect(participantRows.first().locator(".leaderboard-team-id")).toHaveText("RoCo-29");
  await expect(participantRows.first().locator(".leaderboard-rank")).toHaveText("1");
  await expect(participantRows.first().locator(".rank-change")).toHaveText("— 0");
  await expect(participantRows.first().locator(".leaderboard-score")).toHaveText("1.1038");
  await expect(participantRows.first().locator(".leaderboard-metric")).toHaveText(["1.411", "4.739"]);
  await expect(participantRows.first().locator(".leaderboard-method")).toHaveText("Method 1");
  await expect(participantRows.first().locator(".leaderboard-method"))
    .toHaveAttribute("href", "https://spring-benchmark.org/474/");
  await expect(participantRows.first().locator(".leaderboard-submitted"))
    .toHaveAttribute("title", "2026-09-03T16:56:00.000Z");
  const pendingRows = visiblePanel.locator("tbody tr.leaderboard-row--pending");
  await expect(pendingRows.locator(".leaderboard-rank")).toHaveText(Array(32).fill("—"));
  await expect(pendingRows.locator(".leaderboard-score")).toHaveText(Array(32).fill("—"));
  for (const [teamId, teamName, names, links, clean] of [
    ["RoCo-19", "KoreaU_DLmath", ["SEARAFT-Finetune", "WAFT", "WAFT+"], [475, 484, 488], ["2.651", "0.384", "0.364"]],
    ["RoCo-14", "ZXUv2.0", ["CAR-WAFT"], [471], ["0.298"]]
  ]) {
    const teamRows = participantRows.filter({ has: page.locator(".leaderboard-team-id", { hasText: teamId }) });
    await expect(teamRows.locator(".leaderboard-team-name")).toHaveText(Array(names.length).fill(teamName));
    await expect(teamRows.locator(".leaderboard-method")).toHaveText(names);
    await expect(teamRows.locator(".leaderboard-pending-badge"))
      .toHaveText(Array(names.length).fill("Awaiting benchmark results"));
    for (let index = 0; index < names.length; index += 1) {
      await expect(teamRows.nth(index).locator(".leaderboard-method"))
        .toHaveAttribute("href", `https://spring-benchmark.org/${links[index]}/`);
      await expect(teamRows.nth(index).locator(".leaderboard-metric")).toHaveText([clean[index], "—"]);
    }
  }
  await expect(participantRows.locator('a[href="https://spring-benchmark.org/483/"]')).toHaveCount(0);
  await expect(baselineRows).toHaveCount(12);
  await expect(baselineRows.locator(".leaderboard-baseline-badge")).toHaveCount(12);
  await expect(baselineRows.locator(".leaderboard-team-name"))
    .toHaveText(Array.from({ length: 12 }, () => "Spring Team"));
  await expect(baselineRows.locator(".leaderboard-method")).toHaveCount(12);
  await expect(baselineRows.first().locator(".leaderboard-rank")).toHaveAttribute("aria-hidden", "true");
  await expect(baselineRows.first().locator(".rank-change"))
    .toHaveAttribute("aria-label", "Rank movement does not apply to baselines");
  await expect(visiblePanel.locator(".leaderboard-panel-note"))
    .toContainText("do not affect participant standings");

  const opticalBaselineNames = (await baselineRows.locator(".leaderboard-method").allTextContents()).sort();
  expect(opticalBaselineNames).toEqual([
    "(Baseline) FlowFormer", "(Baseline) FlowNet2", "(Baseline) GMA", "(Baseline) GMFlow",
    "(Baseline) M-FUSE (K)", "(Baseline) MS-RAFT+", "(Baseline) PWCNet", "(Baseline) RAFT",
    "(Baseline) RAFT-3D (K)", "(Baseline) RoCo-Spring Team Baselines-Optical Flow",
    "(Baseline) SEA-RAFT", "(Baseline) SPyNet"
  ].sort());
  const opticalBaselineScores = (await baselineRows.locator(".leaderboard-score").allTextContents())
    .map(Number);
  expect(opticalBaselineScores).toEqual([
    0.4584, 0.6774, 0.7368, 0.8015, 0.8704, 1.1914, 1.2375, 1.3336,
    1.7631, 1.9003, 1.9435, 2.7976
  ]);
  await expect(baselineRows.filter({ hasText: "(Baseline) MS-RAFT+" }).locator(".leaderboard-submitted"))
    .toHaveAttribute("title", "2022-11-01T13:00:00Z");
  await expect(baselineRows.filter({ hasText: "(Baseline) FlowNet2" }).locator(".leaderboard-submitted"))
    .toHaveAttribute("title", "2022-05-01T09:29:00Z");
  await expect(baselineRows.filter({ hasText: "Baselines-Optical Flow" }).locator(".leaderboard-method"))
    .toHaveAttribute("title", "(Baseline) RoCo-Spring Team Baselines-Optical Flow");

  await tabs.nth(1).click();
  await expect(participantRows).toHaveCount(23);
  await expect(participantRows.locator(".leaderboard-method-placeholder")).toHaveCount(22);
  await expect(participantRows.locator(".leaderboard-rank")).toHaveText(Array(23).fill("—"));
  await expect(participantRows.locator(".leaderboard-score")).toHaveText(Array(23).fill("—"));
  const stereoPending = participantRows.filter({ has: page.locator(".leaderboard-method") });
  await expect(stereoPending.locator(".leaderboard-team-name")).toHaveText("KoreaU_DLmath");
  await expect(stereoPending.locator(".leaderboard-method")).toHaveText("RAFTStereo_Scale040_new");
  await expect(stereoPending.locator(".leaderboard-method"))
    .toHaveAttribute("href", "https://spring-benchmark.org/482/");
  await expect(stereoPending.locator(".leaderboard-metric")).toHaveText(["1.077", "—"]);
  await expect(baselineRows).toHaveCount(7);
  await expect(baselineRows.locator(".leaderboard-score"))
    .toHaveText(["0.6884", "0.9689", "1.0830", "1.1176", "1.1783", "1.2609", "1.2792"]);
  await tabs.nth(1).press("ArrowRight");
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(2)).toBeFocused();
  await expect(participantRows).toHaveCount(23);
  await expect(participantRows.locator(".leaderboard-method-placeholder")).toHaveCount(22);
  await expect(participantRows.locator(".leaderboard-rank")).toHaveText(Array(23).fill("—"));
  await expect(participantRows.locator(".leaderboard-score")).toHaveText(Array(23).fill("—"));
  const scenePending = participantRows.filter({ has: page.locator(".leaderboard-method") });
  await expect(scenePending.locator(".leaderboard-team-name")).toHaveText("KoreaU_DLmath");
  await expect(scenePending.locator(".leaderboard-method")).toHaveText("DEFOM2K-DPFlow");
  await expect(scenePending.locator(".leaderboard-method"))
    .toHaveAttribute("href", "https://spring-benchmark.org/473/");
  await expect(scenePending.locator(".leaderboard-metric")).toHaveText(["0.155", "—"]);
  await expect(baselineRows).toHaveCount(3);
  await expect(baselineRows.locator(".leaderboard-score")).toHaveText(["0.9522", "1.0478", "1.0850"]);
  await expect(baselineRows.first().locator(".leaderboard-submitted"))
    .toHaveAttribute("title", "2022-11-08T16:15:00Z");
  await expect(baselineRows.first().locator(".leaderboard-metric").nth(0))
    .toHaveAttribute("title", /Spring components: d1/u);
  await expect(baselineRows.first().locator(".leaderboard-metric").nth(1))
    .toHaveAttribute("title", /RobustSpring proxy components: d1/u);

  await tabs.nth(3).click();
  await expect(participantRows).toHaveCount(20);
  await expect(participantRows.locator(".leaderboard-method-placeholder")).toHaveCount(20);
  await expect(participantRows.locator(".leaderboard-rank")).toHaveText(Array(20).fill("—"));
  await expect(participantRows.locator(".leaderboard-score")).toHaveText(Array(20).fill("—"));
  await expect(baselineRows).toHaveCount(0);
  await expect(page.locator("[data-leaderboard-updated]")).not.toHaveText("Loading…");
  await expect(page.locator("#leaderboard-refresh-note")).toContainText("public Spring/RobustSpring results");

  await page.getByRole("button", { name: "Refresh standings" }).click();
  await expect(page.locator("[data-leaderboard-refresh-status]"))
    .toHaveText("Live sync is unavailable; the published fallback standings remain visible.");
  await expect(page.locator("[data-leaderboard-refresh-status]")).toBeVisible();
});

test("leaderboard method and baseline columns stay contained on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/evaluation.html");

  const tableWrap = page.locator('[role="tabpanel"]:not([hidden]) .leaderboard-table-wrap');
  await expect(tableWrap).toBeVisible();
  const dimensions = await tableWrap.evaluate((wrapper) => ({
    pageClientWidth: document.documentElement.clientWidth,
    pageScrollWidth: document.documentElement.scrollWidth,
    wrapperClientWidth: wrapper.clientWidth,
    wrapperScrollWidth: wrapper.scrollWidth
  }));
  expect(dimensions.pageScrollWidth).toBeLessThanOrEqual(dimensions.pageClientWidth + 1);
  expect(dimensions.wrapperScrollWidth).toBeGreaterThan(dimensions.wrapperClientWidth);
  await expect(page.locator('[role="tabpanel"]:not([hidden]) .leaderboard-scroll-hint')).toBeVisible();
});

test("live leaderboard renders scored results and only forces explicit user refreshes", async ({ page }) => {
  await page.goto("/evaluation.html");
  await page.waitForFunction(() => Boolean(window.RoCoLeaderboardLive));

  await page.evaluate(async (baselines) => {
    window.__leaderboardTestForces = [];
    window.__leaderboardTestForcedCalls = 0;
    await window.RoCoLeaderboardLive.installDataSource(async ({ force }) => {
      window.__leaderboardTestForces.push(force);
      if (force) window.__leaderboardTestForcedCalls += 1;
      const stale = window.__leaderboardTestForcedCalls === 2;
      const cacheHit = window.__leaderboardTestForcedCalls > 2;
      const turboFlow = {
        rankChange: 2,
        score: 0.4321,
        springMetric: 0.8,
        robustSpringMetric: 4.2,
        springTerm: 0.806045,
        robustSpringTerm: 0.696517,
        submittedAt: "2026-08-29T17:59:00.000Z",
        benchmarkMethod: "RoCo-99 TurboFlow",
        benchmarkUrl: "https://spring-benchmark.org/999/"
      };
      const classicFlow = {
        rankChange: -1,
        score: 1.4321,
        springMetric: 1.8,
        robustSpringMetric: 6.2,
        springTerm: 1.813602,
        robustSpringTerm: 1.028192,
        submittedAt: "2026-08-28T17:59:00.000Z",
        benchmarkMethod: "RoCo-99 ClassicFlow",
        benchmarkUrl: "https://spring-benchmark.org/998/"
      };
      return {
        snapshot: {
          schemaVersion: 2,
          updatedAt: stale ? "2026-08-29T18:00:00.000Z" : "2026-08-29T18:05:00.000Z",
          sourceLabel: "Browser-tested live snapshot",
          syncStatus: stale ? "stale-cache" : ((force && !cacheHit) ? "fresh" : "cache-hit"),
          baselines,
          teams: [{
            teamId: "RoCo-99",
            teamName: "Browser Racing",
            registeredTracks: ["optical-flow", "stereo-matching", "scene-flow"],
            results: {
              "optical-flow": turboFlow,
              "stereo-matching": {
                rankChange: 0,
                score: 0.5,
                springMetric: 2.1,
                robustSpringMetric: 10.2,
                submittedAt: "2026-08-29T17:58:00.000Z"
              },
              "scene-flow": {
                rankChange: 0,
                score: 0.6,
                springMetric: 0.7,
                robustSpringMetric: 0.8,
                submittedAt: "2026-08-29T17:57:00.000Z"
              },
              "cross-task": {
                rankChange: 0,
                score: 0.5107,
                springMetric: 0.6,
                robustSpringMetric: 0.7,
                submittedAt: "2026-08-29T17:59:00.000Z"
              }
            },
            submissionHistory: {
              "optical-flow": [classicFlow, { ...turboFlow, rankChange: 0 }]
            }
          }]
        },
        syncState: stale ? "stale" : ((force && !cacheHit) ? "synchronized" : "cached")
      };
    });
  }, LEADERBOARD_BASELINES);

  const visiblePanel = page.locator('[role="tabpanel"]:not([hidden])');
  const participantRows = visiblePanel.locator("tbody tr:not(.leaderboard-row--baseline)");
  const baselineRows = visiblePanel.locator("tbody tr.leaderboard-row--baseline");
  await expect(participantRows).toHaveCount(2);
  await expect(baselineRows).toHaveCount(12);
  await expect(participantRows.locator(".leaderboard-rank")).toHaveText(["1", "2"]);
  await expect(participantRows.locator(".rank-change")).toHaveText(["▲ 2", "▼ 1"]);
  await expect(participantRows.locator(".leaderboard-team-name"))
    .toHaveText(["Browser Racing", "Browser Racing"]);
  await expect(participantRows.locator(".leaderboard-score")).toHaveText(["0.4321", "1.4321"]);
  await expect(participantRows.locator(".leaderboard-method"))
    .toHaveText(["RoCo-99 TurboFlow", "RoCo-99 ClassicFlow"]);
  await expect(participantRows.locator(".leaderboard-method").nth(0)).toHaveAttribute(
    "href", "https://spring-benchmark.org/999/"
  );
  await expect(participantRows.locator(".leaderboard-method").nth(1)).toHaveAttribute(
    "href", "https://spring-benchmark.org/998/"
  );
  await expect.poll(() => page.evaluate(() => window.__leaderboardTestForces))
    .toEqual([false]);
  await expect(page.locator("[data-leaderboard-source]"))
    .toHaveText("Browser-tested live snapshot · live cache");

  await page.getByRole("button", { name: "Refresh standings" }).click();
  await expect(page.locator("[data-leaderboard-refresh-status]"))
    .toHaveText("Live standings refreshed.");
  await expect(page.locator("[data-leaderboard-source]"))
    .toHaveText("Browser-tested live snapshot · synchronized");
  await expect.poll(() => page.evaluate(() => window.__leaderboardTestForces))
    .toEqual([false, true]);

  await page.getByRole("button", { name: "Refresh standings" }).click();
  await expect(page.locator("[data-leaderboard-refresh-status]"))
    .toHaveText("Live refresh did not complete; stale cached standings remain visible.");
  await expect(page.locator("[data-leaderboard-source]"))
    .toHaveText("Browser-tested live snapshot · stale cache");
  await expect.poll(() => page.evaluate(() => window.__leaderboardTestForces))
    .toEqual([false, true, true]);

  await page.getByRole("button", { name: "Refresh standings" }).click();
  await expect(page.locator("[data-leaderboard-refresh-status]"))
    .toHaveText("Cached live standings loaded; no newer sync was needed.");
  await expect.poll(() => page.evaluate(() => window.__leaderboardTestForces))
    .toEqual([false, true, true, true]);
});

test("canonical method labels retain distinct results across refresh, tracks, and homepage preview", async ({ page }) => {
  const methods = ["CAR-WAFT", "WAFT+", "Method 1", "Method 2"];
  const quantitativeTracks = ["optical-flow", "stereo-matching", "scene-flow"];
  const results = methods.map((benchmarkMethod, index) => ({
    rankChange: [0, 1, -1, 2][index],
    score: (index + 1) / 10,
    springMetric: index + 1,
    robustSpringMetric: index + 2,
    springTerm: (index + 1) / 10,
    robustSpringTerm: (index + 1) / 10,
    submittedAt: `2026-09-0${index + 1}T12:00:00.000Z`,
    benchmarkMethod,
    benchmarkUrl: `https://spring-benchmark.org/${471 + index}/`
  }));
  const snapshot = {
    schemaVersion: 2,
    updatedAt: "2026-09-07T12:00:00.000Z",
    sourceLabel: "Canonical method label test",
    baselines: LEADERBOARD_BASELINES,
    teams: [{
      teamId: "RoCo-14",
      teamName: "Registered Racing",
      registeredTracks: quantitativeTracks,
      results: Object.fromEntries(quantitativeTracks.map((track) => [track, results[3]])),
      // Deliberately scramble the history and duplicate the current result.
      // Rank and identity must depend on scores and URLs, never display labels
      // or the order in which benchmark entries were fetched.
      submissionHistory: Object.fromEntries(quantitativeTracks.map((track) => [track, [
        { ...results[3], rankChange: 0 }, results[1], results[2], results[0]
      ]]))
    }]
  };
  const installSnapshot = async () => {
    await page.waitForFunction(() => Boolean(window.RoCoLeaderboardLive));
    await page.evaluate(async (fixture) => {
      await window.RoCoLeaderboardLive.installDataSource(async ({ force }) => {
        if (force) {
          for (const history of Object.values(fixture.teams[0].submissionHistory)) {
            history.reverse();
          }
        }
        return { snapshot: fixture, syncState: "synchronized" };
      });
    }, snapshot);
  };

  await page.goto("/evaluation.html");
  await installSnapshot();
  const panel = page.locator('[role="tabpanel"]:not([hidden])');
  const rows = panel.locator("tbody tr:not(.leaderboard-row--baseline)");
  const expectCanonicalRows = async () => {
    await expect(rows).toHaveCount(4);
    await expect(rows.locator(".leaderboard-team-name"))
      .toHaveText(Array(4).fill("Registered Racing"));
    await expect(rows.locator(".leaderboard-team-id")).toHaveText(Array(4).fill("RoCo-14"));
    await expect(rows.locator(".leaderboard-method")).toHaveText(methods);
    await expect(rows.locator(".leaderboard-rank")).toHaveText(["1", "2", "3", "4"]);
    await expect(rows.locator(".rank-change")).toHaveText(["— 0", "▲ 1", "▼ 1", "▲ 2"]);
    await expect(rows.locator(".leaderboard-score")).toHaveText(["0.1000", "0.2000", "0.3000", "0.4000"]);
    for (let index = 0; index < results.length; index += 1) {
      const method = rows.nth(index).locator(".leaderboard-method");
      await expect(method).toHaveAttribute("href", results[index].benchmarkUrl);
      await expect(method).toHaveAttribute("title", methods[index]);
      await expect(method).toHaveAttribute("rel", "noopener noreferrer");
      await expect(rows.nth(index).locator(".leaderboard-submitted"))
        .toHaveAttribute("title", results[index].submittedAt);
    }
  };
  for (const label of ["Optical Flow", "Stereo Matching", "Scene Flow"]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expectCanonicalRows();
  }
  await page.getByRole("button", { name: "Refresh standings" }).click();
  await expect(page.locator("[data-leaderboard-refresh-status]")).toHaveText("Live standings refreshed.");
  await expectCanonicalRows();

  await page.setViewportSize({ width: 390, height: 844 });
  const tableWrap = panel.locator(".leaderboard-table-wrap");
  const dimensions = await tableWrap.evaluate((wrapper) => ({
    page: document.documentElement.clientWidth,
    pageContent: document.documentElement.scrollWidth,
    table: wrapper.clientWidth,
    tableContent: wrapper.scrollWidth
  }));
  expect(dimensions.pageContent).toBeLessThanOrEqual(dimensions.page + 1);
  expect(dimensions.tableContent).toBeGreaterThan(dimensions.table);

  await page.goto("/index.html");
  await installSnapshot();
  for (const track of quantitativeTracks) {
    const card = page.locator(`.leaderboard-preview-card[aria-labelledby="preview-${track}"]`);
    await expect(card.locator(".leaderboard-preview-method")).toHaveText(methods.slice(0, 3));
    await expect(card.locator(".leaderboard-preview-rank")).toHaveText(["1", "2", "3"]);
    await expect(card.locator(".leaderboard-preview-team strong"))
      .toHaveText(Array(3).fill("Registered Racing"));
    await expect(card.getByRole("link", { name: "View full standings →" }))
      .toHaveAttribute("href", "evaluation.html#leaderboards");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(391);
});

test("incomplete public methods remain visible without a rank until complete metrics arrive", async ({ page }) => {
  const method = (benchmarkMethod, resultId, springMetric, score = null) => ({
    rankChange: 0,
    score,
    springMetric,
    robustSpringMetric: score === null ? null : 2,
    springTerm: score,
    robustSpringTerm: score,
    submittedAt: "2026-09-07T12:00:00.000Z",
    benchmarkMethod,
    benchmarkUrl: `https://spring-benchmark.org/${resultId}/`
  });
  const unnamed = method("Method 1", 474, 0.7, 0.2);
  const snapshot = {
    schemaVersion: 2,
    updatedAt: "2026-09-07T12:05:00.000Z",
    sourceLabel: "Incomplete public method test",
    teams: [
      {
        teamId: "RoCo-14", teamName: "Road Racing", registeredTracks: ["optical-flow"],
        results: { "optical-flow": method("CAR-WAFT v2", 499, 0.8, 0.3) },
        pendingSubmissions: { "optical-flow": [method("CAR-WAFT", 471, 0.9)] }
      },
      {
        teamId: "RoCo-19", teamName: "WAFT Team", registeredTracks: ["optical-flow", "stereo-matching"],
        pendingSubmissions: {
          "optical-flow": [method("WAFT+", 488, 1.1)],
          "stereo-matching": [method("WAFT+", 488, 1.1), method("WAFT++", 489, 1.2)]
        }
      },
      {
        teamId: "RoCo-29", teamName: "VSAI", registeredTracks: ["optical-flow"],
        results: { "optical-flow": unnamed },
        // A pending copy must never hide the complete result at the same URL.
        pendingSubmissions: { "optical-flow": [{ ...unnamed, score: null }] }
      },
      { teamId: "RoCo-30", teamName: "Alpha Pending", registeredTracks: ["optical-flow"] }
    ]
  };
  const installSnapshot = async () => {
    await page.waitForFunction(() => Boolean(window.RoCoLeaderboardLive));
    await page.evaluate(async (fixture) => {
      await window.RoCoLeaderboardLive.installDataSource(async ({ force }) => {
        if (force) {
          const pending = fixture.teams[0].pendingSubmissions["optical-flow"][0];
          fixture.teams[0].submissionHistory = {
            "optical-flow": [{ ...pending, score: 0.1, robustSpringMetric: 1.2 }]
          };
        }
        return { snapshot: fixture, syncState: "synchronized" };
      });
    }, snapshot);
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/evaluation.html");
  await installSnapshot();
  const rows = page.locator('[role="tabpanel"]:not([hidden]) tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(rows.locator(".leaderboard-team-name"))
    .toHaveText(["VSAI", "Road Racing", "Alpha Pending", "Road Racing", "WAFT Team"]);
  await expect(rows.locator(".leaderboard-rank")).toHaveText(["1", "2", "—", "—", "—"]);
  await expect(rows.locator(".leaderboard-score")).toHaveText(["0.2000", "0.3000", "—", "—", "—"]);
  await expect(rows.locator(".leaderboard-method-placeholder")).toHaveCount(1);
  for (const [name, resultId, clean] of [["CAR-WAFT", 471, "0.900"], ["WAFT+", 488, "1.100"]]) {
    const row = rows.filter({ has: page.getByRole("link", { name: `${name} benchmark result (opens in a new tab)`, exact: true }) });
    await expect(row.locator(".leaderboard-pending-badge")).toHaveText("Awaiting benchmark results");
    await expect(row.locator(".leaderboard-method"))
      .toHaveAttribute("href", `https://spring-benchmark.org/${resultId}/`);
    await expect(row.locator(".leaderboard-metric")).toHaveText([clean, "—"]);
    await expect(row.locator(".leaderboard-submitted"))
      .toHaveAttribute("title", "2026-09-07T12:00:00.000Z");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);

  await page.getByRole("button", { name: "Refresh standings" }).click();
  await expect(page.locator("[data-leaderboard-refresh-status]")).toHaveText("Live standings refreshed.");
  await expect(rows).toHaveCount(5);
  await expect(rows.first().locator(".leaderboard-method")).toHaveText("CAR-WAFT");
  await expect(rows.first().locator(".leaderboard-method"))
    .toHaveAttribute("href", "https://spring-benchmark.org/471/");
  await expect(rows.first().locator(".leaderboard-rank")).toHaveText("1");
  await expect(rows.first().locator(".leaderboard-score")).toHaveText("0.1000");
  await expect(rows.first().locator(".leaderboard-pending-badge")).toHaveCount(0);

  await page.goto("/index.html");
  await installSnapshot();
  const preview = page.locator('.leaderboard-preview-card[aria-labelledby="preview-optical-flow"]');
  await expect(preview.locator(".leaderboard-preview-method")).toHaveText(["Method 1", "CAR-WAFT v2"]);
  await expect(preview.locator(".leaderboard-preview-rank")).toHaveText(["1", "2"]);
  await expect(page.locator('.leaderboard-preview-card[aria-labelledby="preview-stereo-matching"] .leaderboard-preview-empty'))
    .toHaveText("No complete benchmark results yet · 1 registered team");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});

test("exact leaderboard ties use numeric team ID and then benchmark URL", async ({ page }) => {
  await page.goto("/evaluation.html");
  await page.waitForFunction(() => Boolean(window.RoCoLeaderboardLive));

  await page.evaluate(async () => {
    const result = (teamId, resultId) => ({
      rankChange: 0,
      score: 1,
      springMetric: 1,
      robustSpringMetric: 1,
      springTerm: 1,
      robustSpringTerm: 1,
      submittedAt: "2026-08-29T18:00:00.000Z",
      benchmarkMethod: `${teamId} method ${resultId}`,
      benchmarkUrl: `https://spring-benchmark.org/${resultId}/`
    });
    await window.RoCoLeaderboardLive.installDataSource(async () => ({
      syncState: "cached",
      snapshot: {
        schemaVersion: 2,
        updatedAt: "2026-08-29T18:05:00.000Z",
        sourceLabel: "Tie-order test snapshot",
        teams: [
          {
            teamId: "RoCo-99",
            teamName: "Alpha Team",
            registeredTracks: ["optical-flow"],
            results: { "optical-flow": result("RoCo-99", 999) }
          },
          {
            teamId: "RoCo-9",
            teamName: "Zulu Team",
            registeredTracks: ["optical-flow"],
            results: { "optical-flow": result("RoCo-9", 901) },
            submissionHistory: {
              "optical-flow": [result("RoCo-9", 901), result("RoCo-9", 900)]
            }
          }
        ]
      }
    }));
  });

  const names = page.locator('[role="tabpanel"]:not([hidden]) .leaderboard-team-name');
  await expect(names).toHaveText(["Zulu Team", "Zulu Team", "Alpha Team"]);
  await expect(page.locator('[role="tabpanel"]:not([hidden]) .leaderboard-method')).toHaveText([
    "RoCo-9 method 900", "RoCo-9 method 901", "RoCo-99 method 999"
  ]);
  await expect(page.locator('[role="tabpanel"]:not([hidden]) .leaderboard-rank'))
    .toHaveText(["1", "2", "3"]);
});

test("homepage preview does not promote alphabetically sorted pending teams", async ({ page }) => {
  await page.goto("/index.html");

  const cards = page.locator(".leaderboard-preview-card");
  await expect(cards).toHaveCount(4);
  await expect(page.locator(".leaderboard-preview-list")).toHaveCount(1);
  await expect(page.locator(".leaderboard-preview-empty")).toHaveCount(3);
  const optical = page.locator('.leaderboard-preview-card[aria-labelledby="preview-optical-flow"]');
  await expect(optical.locator(".leaderboard-preview-list li")).toHaveCount(1);
  await expect(optical.locator(".leaderboard-preview-rank")).toHaveText("1");
  await expect(optical.locator(".leaderboard-preview-team strong")).toHaveText("VSAI");
  await expect(optical.locator(".leaderboard-preview-method")).toHaveText("Method 1");
  await expect(optical.locator(".leaderboard-preview-score")).toHaveText("1.1038");
  for (const [track, count] of [["stereo-matching", 23], ["scene-flow", 23], ["cross-task", 20]]) {
    const card = page.locator(`.leaderboard-preview-card[aria-labelledby="preview-${track}"]`);
    await expect(card.locator(".leaderboard-preview-empty"))
      .toHaveText(`No complete benchmark results yet · ${count} registered teams`);
  }
});

test("registration portal starts with three slots, validates partial members, and switches tabs", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/team-registration.html");
  expect(response?.ok()).toBe(true);
  await expect(page.locator("header.site-header .brand")).toHaveText("RoCo-Spring");
  await expect(page.locator("#public-auth")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".portal-region-notice")).toBeVisible();
  await expect(page.locator(".portal-region-notice")).toHaveAttribute("role", "note");
  await expect(page.locator(".portal-region-notice")).toContainText("Regional access notice");
  await expect(page.locator(".portal-region-notice")).toContainText("www.recaptcha.net");
  await expect(page.locator(".portal-region-notice")).toContainText("trusted VPN");
  await expect(page.locator("#registration-members .member-slot")).toHaveCount(3);
  await expect(page.locator("#registration-members legend").first()).toContainText("Team member 1");
  await expect(page.locator("#registration-members legend").nth(2)).toContainText("Team member 3");
  for (const field of ["fullName", "email", "affiliation"]) {
    await expect(page.locator(`#register-member-1-${field}`)).toHaveAttribute("required", "");
    await expect(page.locator(`#register-member-2-${field}`)).not.toHaveAttribute("required", "");
    await expect(page.locator(`#register-member-3-${field}`)).not.toHaveAttribute("required", "");
  }

  await page.locator("#register-team-name").fill("Browser Validation Team");
  await page.locator("#register-primary-email").fill("member@example.org");
  await page.locator('#registration-form input[name="tracks"][value="optical-flow"]').check();
  await page.locator("#register-member-1-fullName").fill("Member One");
  await page.locator("#register-member-1-email").fill("member@example.org");
  await page.locator("#register-member-1-affiliation").fill("Example Institute");
  await page.locator("#register-member-2-fullName").fill("Partial Member");
  await page.locator("#submitter-is-member").check();
  await page.getByRole("button", { name: "Register team" }).click();

  await expect(page.locator("#register-member-2-email-error")).toContainText("required");
  await expect(page.locator("#register-member-2-affiliation-error")).toContainText("required");
  await expect(page.locator("#register-member-2-email")).toHaveAttribute("aria-invalid", "true");

  await page.getByRole("tab", { name: "Sign in to an existing team" }).click();
  await expect(page.locator("#login-tab-panel")).toBeVisible();
  await expect(page.locator("#register-tab-panel")).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test("Participate Step 4 contains the homepage-style starter-kit button", async ({ page }) => {
  await page.goto("/participate.html");
  const stepFour = page.locator(".step-card").filter({
    has: page.getByRole("heading", { name: "Install the Starter Kit", exact: true })
  });
  const starterKit = stepFour.getByRole("link", { name: "GitHub Starter Kit", exact: true });
  await expect(stepFour).toHaveCount(1);
  await expect(starterKit).toBeVisible();
  await expect(starterKit).toHaveAttribute(
    "href",
    "https://github.com/hmorimitsu/roco-spring-devkit"
  );
  await expect(starterKit).toHaveAttribute("target", "_blank");
  await expect(starterKit).toHaveAttribute("rel", "noopener noreferrer");
  await expect(starterKit.locator(".button-icon")).toHaveCount(1);
});

test("OpenReview submission buttons are consistent, accessible, and officially branded", async ({ page }) => {
  const placements = [
    { path: "/index.html", scope: ".hero-actions" },
    {
      path: "/participate.html",
      scope: ".step-card:has(.step-number:text-is('9'))"
    },
    { path: "/evaluation.html", scope: "#call-for-papers" },
    { path: "/call-for-papers.html", scope: ".page-header" }
  ];
  const expectedUrl = "https://openreview.net/group?id=NeurIPS.cc/2026/Workshop/RoCo-Spring";

  for (const placement of placements) {
    await page.goto(placement.path);
    const button = page.locator(placement.scope)
      .getByRole("link", { name: "OpenReview Submission", exact: true });
    await expect(button).toHaveCount(1);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("href", expectedUrl);
    await expect(button).toHaveAttribute("target", "_blank");
    await expect(button).toHaveAttribute("rel", "noopener noreferrer");

    const appearance = await button.evaluate((element) => {
      const buttonStyle = getComputedStyle(element);
      const wordmarkStyle = getComputedStyle(element.querySelector(".openreview-wordmark"));
      return {
        background: buttonStyle.backgroundColor,
        height: element.getBoundingClientRect().height,
        wordmarkFamily: wordmarkStyle.fontFamily,
        wordmarkWeight: wordmarkStyle.fontWeight
      };
    });
    expect(appearance.background).toBe("rgb(140, 27, 19)");
    expect(appearance.height).toBeGreaterThanOrEqual(44);
    expect(appearance.wordmarkFamily).toContain("Noto Sans");
    expect(appearance.wordmarkWeight).toBe("700");

    await button.focus();
    await expect(button).toBeFocused();
    expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  }
});

test("OpenReview submission buttons wrap without mobile overflow", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  for (const path of [
    "/index.html",
    "/participate.html",
    "/evaluation.html",
    "/call-for-papers.html"
  ]) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "OpenReview Submission", exact: true })).toBeVisible();
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  }
});

test("buttons pop, participation CTAs glow, and navigation tabs animate on hover", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator("header.site-header .brand")).toHaveText("RoCo-Spring");

  const participate = page.locator(".hero-actions .participate-cta");
  expect(await participate.evaluate((element) =>
    getComputedStyle(element, "::before").opacity
  )).toBe("0");

  await participate.hover();
  await expect.poll(() => participate.evaluate((element) =>
    getComputedStyle(element, "::before").opacity
  )).toBe("1");
  const participateHover = await participate.evaluate((element) => ({
    animationName: getComputedStyle(element, "::before").animationName,
    background: getComputedStyle(element, "::before").backgroundImage,
    transform: getComputedStyle(element).transform
  }));
  expect(participateHover.animationName).toBe("participate-ring-flow");
  expect(participateHover.background).toContain("linear-gradient");
  expect(participateHover.transform).not.toBe("none");

  const evaluation = page.getByRole("link", { name: "Leaderboard", exact: true }).last();
  const evaluationShadow = await evaluation.evaluate((element) => getComputedStyle(element).boxShadow);
  await evaluation.hover();
  await expect.poll(() => evaluation.evaluate((element) =>
    getComputedStyle(element).transform
  )).not.toBe("none");
  expect(await evaluation.evaluate((element) => getComputedStyle(element).boxShadow))
    .not.toBe(evaluationShadow);

  const tasksTab = page.locator('.nav a[href="tasks-data.html"]');
  expect(await tasksTab.evaluate((element) =>
    getComputedStyle(element, "::after").opacity
  )).toBe("0");
  await tasksTab.hover();
  await expect.poll(() => tasksTab.evaluate((element) =>
    getComputedStyle(element, "::after").opacity
  )).toBe("1");
  expect(await tasksTab.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe("none");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  const reducedParticipate = page.locator(".hero-actions .participate-cta");
  await reducedParticipate.hover();
  expect(await reducedParticipate.evaluate((element) =>
    getComputedStyle(element, "::before").animationName
  )).toBe("none");
  expect(await reducedParticipate.evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
});

test("team members can be added beyond ten without losing entered values", async ({ page }) => {
  await page.goto("/team-registration.html");
  await expect(page.locator("#public-auth")).toBeVisible({ timeout: 15_000 });

  await page.locator("#register-member-1-fullName").fill("Persistent Member");
  await page.locator("#register-member-2-email").fill("second@example.org");
  const secondMemberClearButton = page.locator("#registration-members .member-slot").nth(1)
    .locator(".member-remove-button");
  await expect(secondMemberClearButton).toBeVisible();

  await page.locator('#registration-form button[type="submit"]').click();
  await expect(page.locator("#register-team-name")).toHaveAttribute("aria-invalid", "true");
  await secondMemberClearButton.click();
  await expect(page.locator("#register-member-2-email")).toHaveValue("");
  await expect(secondMemberClearButton).toBeHidden();
  await expect(page.locator("#register-team-name")).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator('#registration-form [aria-invalid="true"]')).toHaveCount(0);
  await expect(page.locator('#registration-form [data-field-error]:not(:empty)')).toHaveCount(0);

  await page.locator("#register-member-2-email").fill("second@example.org");
  await expect(secondMemberClearButton).toBeVisible();

  for (let expectedCount = 4; expectedCount <= 12; expectedCount += 1) {
    await page.locator("#add-registration-member").click();
    await expect(page.locator("#registration-members .member-slot")).toHaveCount(expectedCount);
    await expect(page.locator(`#register-member-${expectedCount}-fullName`)).toBeFocused();
  }

  await expect(page.locator("#add-registration-member")).toBeEnabled();
  await expect(page.locator("#register-member-1-fullName")).toHaveValue("Persistent Member");
  await expect(page.locator("#register-member-2-email")).toHaveValue("second@example.org");
  await expect(page.locator("#registration-members legend").nth(11)).toContainText("Team member 12");
  await expect(page.locator("#registration-members .member-slot").nth(1)
    .locator(".member-remove-button")).toBeVisible();
  await expect(page.locator("#registration-members .member-slot").nth(2)
    .locator(".member-remove-button")).toBeHidden();
  await expect(page.locator("#registration-members .member-slot").nth(3)
    .locator(".member-remove-button")).toBeVisible();

  await page.locator("#registration-members .member-slot").nth(1)
    .locator(".member-remove-button").click();
  await expect(page.locator("#registration-members .member-slot")).toHaveCount(12);
  await expect(page.locator("#register-member-2-email")).toHaveValue("");
  await expect(page.locator("#registration-members .member-slot").nth(1)
    .locator(".member-remove-button")).toBeHidden();

  await page.locator("#register-member-5-fullName").fill("Member That Moves Up");
  await page.locator("#register-member-12-email").fill("last-member@example.org");
  await page.locator("#registration-members .member-slot").nth(3)
    .locator(".member-remove-button").click();

  await expect(page.locator("#registration-members .member-slot")).toHaveCount(11);
  await expect(page.locator("#register-member-4-fullName")).toHaveValue("Member That Moves Up");
  await expect(page.locator("#register-member-11-email")).toHaveValue("last-member@example.org");
  await expect(page.locator("#registration-members legend").nth(10)).toContainText("Team member 11");
  await expect(page.locator("#add-registration-member")).toBeEnabled();

  await page.locator("#add-registration-member").click();
  await expect(page.locator("#registration-members .member-slot")).toHaveCount(12);
  await expect(page.locator("#register-member-12-fullName")).toBeFocused();
  await expect(page.locator("#add-registration-member")).toBeEnabled();
});

test("login query mode and keyboard tab behavior are accessible", async ({ page }) => {
  await page.goto("/team-registration.html?mode=login");
  await expect(page.locator("#public-auth")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#login-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#login-tab-panel")).toBeVisible();

  await page.locator("#login-tab").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#register-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#register-tab-panel")).toBeVisible();
});

for (const { label, viewport } of [
  { label: "mobile", viewport: { width: 390, height: 844 } },
  { label: "desktop", viewport: { width: 1280, height: 900 } }
]) {
  test(`registration page remains within the ${label} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/team-registration.html");
    await expect(page.locator("#public-auth")).toBeVisible({ timeout: 15_000 });
    for (let memberIndex = 4; memberIndex <= 12; memberIndex += 1) {
      await page.locator("#add-registration-member").click();
    }
    await expect(page.locator("#registration-members .member-slot")).toHaveCount(12);
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  });
}

test("homepage portraits and funding logos stay compact at desktop and mobile sizes", async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 740 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/index.html");

    const portraits = page.locator(".keynote-photo");
    await expect(portraits).toHaveCount(2);
    for (const portrait of await portraits.all()) {
      const box = await portrait.boundingBox();
      expect(box).not.toBeNull();
      expect(box.width).toBeLessThanOrEqual(72);
      expect(box.height).toBeLessThanOrEqual(72);
      expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);
    }

    const organizerPortraits = page.locator(".organizer-photo");
    await expect(organizerPortraits).toHaveCount(9);
    await expect
      .poll(() => organizerPortraits.evaluateAll((images) =>
        images.every((image) => image.complete && image.naturalWidth > 0)
      ))
      .toBe(true);
    for (const portrait of await organizerPortraits.all()) {
      const box = await portrait.boundingBox();
      expect(box).not.toBeNull();
      expect(box.width).toBeLessThanOrEqual(52);
      expect(box.height).toBeLessThanOrEqual(52);
      expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);
    }
    const steffenLink = page.getByRole("link", { name: "Steffen Jung", exact: true });
    await expect(steffenLink).toHaveAttribute("href", "https://jung.vision/");
    await expect(page.locator('img.organizer-photo[alt="Steffen Jung"]')).toHaveJSProperty("complete", true);

    const logoImages = page.locator("#sponsors img");
    await logoImages.first().scrollIntoViewIfNeeded();
    await expect(logoImages).toHaveCount(5);
    await expect
      .poll(() => logoImages.evaluateAll((images) =>
        images.every((image) => image.complete && image.naturalWidth > 0)
      ))
      .toBe(true);

    for (const logo of await logoImages.all()) {
      const box = await logo.boundingBox();
      expect(box).not.toBeNull();
      expect(box.width).toBeLessThanOrEqual(220);
      expect(box.height).toBeLessThanOrEqual(48);
    }

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  }
});

test("Call for Papers tab is active and presents the four tracks without overflow", async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/call-for-papers.html");

    const navLink = page.locator("header.site-header").getByRole("link", {
      name: "Call for Papers",
      exact: true
    });
    if (viewport.width <= 860) {
      await page.getByRole("button", { name: "Open menu" }).click();
    }
    await expect(navLink).toBeVisible();
    await expect(navLink).toHaveAttribute("aria-current", "page");
    await expect(page.locator("header.site-header").getByRole("link", {
      name: "Sponsors",
      exact: true
    })).toBeVisible();
    await expect(page.locator("#paper-tracks .track-card")).toHaveCount(4);
    await expect(page.locator("#submission-requirements")).toContainText("4–6 pages");
    await expect(page.locator("#submission-requirements")).toContainText("single-blind");
    await expect(page.locator("#submission-requirements")).toContainText("team number");
    await expect(page.locator("#submission-requirements")).toContainText("team name");

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  }
});

test("mobile navigation toggles with an accessible state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/team-registration.html");
  const toggle = page.locator(".nav-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#site-nav")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("citation copy button copies the code block exactly", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:4173"
  });
  for (const [path, citationId] of [
    ["/participate.html", "citation-ptlflow"],
    ["/tasks-data.html", "citation-flowbench"]
  ]) {
    await page.goto(path);
    const citation = page.locator(`#${citationId}`);
    const expected = await citation.textContent();
    await page.locator(`[data-copy-target="${citationId}"]`).click();
    await expect(page.locator(`[data-copy-target="${citationId}"] + .copy-status`))
      .toHaveText("BibTeX copied.");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(expected);
  }
});

test("registration startup failure replaces the indefinite loading state", async ({ page }) => {
  await page.route("**/assets/team-registration.js", (route) => route.abort("failed"));
  await page.goto("/team-registration.html");
  await expect(page.locator("#portal-loading")).toHaveAttribute("role", "alert");
  await expect(page.locator("#portal-loading")).toContainText(
    "Secure team services could not be loaded"
  );
  await expect(page.locator("#registration-portal")).toHaveAttribute("aria-busy", "false");
});
