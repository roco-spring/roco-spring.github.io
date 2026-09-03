import type { Firestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
}));

vi.mock("firebase-functions", () => ({
  logger: { error: mocks.loggerError },
}));

import {
  LEADERBOARD_BASELINE_METADATA,
  LEADERBOARD_BASELINES,
  benchmarkPageHasExpectedSchema,
  buildLeaderboardSnapshot,
  matchBenchmarkTeam,
  normalizeLeaderboardIdentity,
  parseBenchmarkRows,
  parseLeaderboardRefreshInput,
  parseSceneFlowCleanMetrics,
  parseSubmissionTimestamp,
  publicRosterTeamFromDocument,
  reconstructPublicLeaderboardSnapshot,
  refreshLeaderboardOperation,
  type LeaderboardRosterTeam,
} from "../src/leaderboard.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

function listRow(
  submissionId: number,
  methodName: string,
  metrics: readonly number[],
  suffix = "",
): string {
  return `
    <tr>
      <td>1</td>
      <td><div class="namebox"><span><a href="/${submissionId}/">${methodName}</a>${suffix}</span></div></td>
      ${metrics.map((metric) => `<td class="num2">${metric.toFixed(3)}</td>`).join("")}
    </tr>`;
}

function benchmarkTable(metricSortKeys: readonly string[], row: string): string {
  const headers = metricSortKeys.map((key) =>
    `<th><a href="/benchmark${key ? `?display=test&amp;s=${key}` : ""}">metric</a></th>`,
  ).join("");
  return `<table><tr><th></th><th>Name</th>${headers}</tr>${row}</table>`;
}

function detailPage(
  d1: number,
  d2: number,
  flow: number,
  date = "Aug. 29, 2026, 6:30 p.m.",
): string {
  return `
    <h3>Turbo RoCo-12</h3>
    <p>${date} &nbsp;&mdash;&nbsp; Public</p>
    <h4>Disparity 1</h4><table>
      <tr><th>Abs<br>total</th><th>Abs low</th></tr><tr><td>${d1}</td><td>0</td></tr>
      <tr><th>D1<br>total</th><th>D1 low</th></tr><tr><td>91</td><td>0</td></tr>
    </table>
    <h4>Disparity 2</h4><table>
      <tr><th>Abs<br>total</th><th>Abs low</th></tr><tr><td>${d2}</td><td>0</td></tr>
      <tr><th>D2<br>total</th><th>D2 low</th></tr><tr><td>92</td><td>0</td></tr>
    </table>
    <h4>Optical Flow</h4><table>
      <tr><th>EPE<br>total</th><th>EPE low</th></tr><tr><td>${flow}</td><td>0</td></tr>
    </table>`;
}

const roster: LeaderboardRosterTeam[] = [
  {
    teamId: "RoCo-12",
    teamName: "aneev",
    registeredTracks: ["optical-flow", "stereo-matching", "scene-flow"],
  },
  {
    teamId: "RoCo-16",
    teamName: "Swarm",
    registeredTracks: ["optical-flow", "stereo-matching", "scene-flow", "exploration"],
  },
];

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("public leaderboard parser and matching", () => {
  it("parses only benchmark result rows and recognizes scene-flow task projections", () => {
    const rows = parseBenchmarkRows(`
      <table><tr><th>Name</th></tr>
      ${listRow(41, "M-FUSE &amp; Friends", [1, 2], " [SF]")}
      <tr><td class="citation"></td><td>submitted by spring team</td></tr></table>`);
    expect(rows).toEqual([{
      submissionId: "41",
      methodName: "M-FUSE & Friends",
      metrics: [1, 2],
      taskProjection: true,
    }]);
  });

  it("matches an exact RoCo ID before a normalized team name", () => {
    expect(matchBenchmarkTeam("FastFlow — RoCo_12", roster)).toMatchObject({
      team: { teamId: "RoCo-12" },
      basis: "team-id",
    });
    expect(matchBenchmarkTeam("ANE-EV++", roster)).toMatchObject({
      team: { teamId: "RoCo-12" },
      basis: "team-name",
    });
    expect(normalizeLeaderboardIdentity("E-motion AI")) .toBe("emotionai");
  });

  it("rejects ambiguous or partial identifier matches", () => {
    expect(matchBenchmarkTeam("RoCo-123 method", roster)).toBeNull();
    expect(matchBenchmarkTeam("RoCo-12abc method", roster)).toBeNull();
    expect(matchBenchmarkTeam("unrelated method", roster)).toBeNull();
    expect(matchBenchmarkTeam("Swarm aneev fusion", roster)).toBeNull();
  });

  it("parses scene-flow clean components and the benchmark's Berlin timestamp", () => {
    const html = detailPage(5, 8, 3);
    expect(parseSceneFlowCleanMetrics(html)).toEqual({ d1: 5, d2: 8, flow: 3 });
    expect(parseSubmissionTimestamp(html)).toBe("2026-08-29T16:30:00.000Z");
    expect(parseSubmissionTimestamp(detailPage(5, 8, 3, "Aug. 29, 2026, noon")))
      .toBe("2026-08-29T10:00:00.000Z");
    expect(parseSubmissionTimestamp(detailPage(5, 8, 3, "Aug. 29, 2026, midnight")))
      .toBe("2026-08-28T22:00:00.000Z");
    expect(parseSubmissionTimestamp(detailPage(5, 8, 3, "Mar. 29, 2026, midnight")))
      .toBe("2026-03-28T23:00:00.000Z");
  });

  it("fails closed when benchmark metric columns are reordered or incomplete", () => {
    const expected = ["robust_EPE_Fl_total", "robust_Fl_total", "robust_1px_Fl_total"];
    const valid = benchmarkTable(expected, listRow(41, "RoCo-12", [1, 2, 3]));
    expect(benchmarkPageHasExpectedSchema("opticalFlowRobustness", valid)).toBe(true);
    expect(benchmarkPageHasExpectedSchema(
      "opticalFlowRobustness",
      benchmarkTable([expected[1]!, expected[0]!, expected[2]!], listRow(41, "RoCo-12", [1, 2, 3])),
    )).toBe(false);
    expect(benchmarkPageHasExpectedSchema(
      "opticalFlowRobustness",
      benchmarkTable(expected, listRow(41, "RoCo-12", [1, 2])),
    )).toBe(false);
  });
});

describe("leaderboard scoring", () => {
  it("uses the fixed strict-paper-intersection baselines", () => {
    expect(LEADERBOARD_BASELINES).toEqual({
      "optical-flow": { spring: 0.9925, robustProxy: 6.03 },
      "stereo-matching": { spring: 3.4545, robustProxy: 18.4505 },
      "scene-flow": {
        spring: { d1: 7.466, d2: 7.5935, flow: 2.527 },
        robustProxy: { d1: 24.471, d2: 7.8085, flow: 6.737 },
      },
    });
  });

  it("adds clean error to disagreement, scores all tracks, and builds cross-task", async () => {
    const opticalClean = Array.from({ length: 13 }, () => 0);
    opticalClean[12] = 2;
    const stereoClean = Array.from({ length: 11 }, () => 0);
    stereoClean[10] = 4;
    const sceneRobust = [0, 2, 0, 0, 1, 0, 4];
    const pages = {
      opticalFlowAccuracy: listRow(101, "Turbo RoCo-12", opticalClean),
      opticalFlowRobustness: listRow(101, "Turbo RoCo-12", [3]),
      stereoAccuracy: listRow(102, "Turbo RoCo-12", stereoClean),
      stereoRobustness: listRow(102, "Turbo RoCo-12", [0, 6]),
      sceneFlowAccuracy: listRow(103, "Turbo RoCo-12", [1]),
      sceneFlowRobustness: listRow(103, "Turbo RoCo-12", sceneRobust),
    };
    const details = new Map([
      ["101", detailPage(0, 0, 0)],
      ["102", detailPage(0, 0, 0)],
      ["103", detailPage(5, 8, 3)],
    ]);
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      pages,
      (submissionId) => Promise.resolve(details.get(submissionId) ?? ""),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    const result = snapshot.teams.find((team) => team.teamId === "RoCo-12")?.results;
    expect(snapshot.scoringConvention).toBe("organizer-approved-additive-proxy");
    expect(snapshot.baselines).toBe(LEADERBOARD_BASELINE_METADATA);
    expect(result?.["optical-flow"]).toMatchObject({
      springMetric: 2,
      robustSpringMetric: 5,
      submittedAt: "2026-08-29T16:30:00.000Z",
      matchBasis: "team-id",
    });
    expect(result?.["optical-flow"]?.score).toBeCloseTo(
      0.5 * (2 / 0.9925) + 0.5 * (5 / 6.03),
      6,
    );
    expect(result?.["stereo-matching"]).toMatchObject({
      springMetric: 4,
      robustSpringMetric: 10,
    });
    expect(result?.["scene-flow"]).toMatchObject({
      springComponents: { d1: 5, d2: 8, flow: 3 },
      robustSpringComponents: { d1: 7, d2: 9, flow: 7 },
      springMetric: expect.any(Number),
      robustSpringMetric: expect.any(Number),
    });
    expect(result?.["scene-flow"]?.springMetric).toBe(result?.["scene-flow"]?.springTerm);
    expect(result?.["scene-flow"]?.robustSpringMetric)
      .toBe(result?.["scene-flow"]?.robustSpringTerm);
    expect(result?.["cross-task"]?.score).toBeCloseTo(
      ((result?.["optical-flow"]?.score ?? 0) +
        (result?.["stereo-matching"]?.score ?? 0) +
        (result?.["scene-flow"]?.score ?? 0)) / 3,
      6,
    );
    expect(snapshot.teams.find((team) => team.teamId === "RoCo-12")
      ?.submissionHistory["optical-flow"]).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toMatch(/email|member/iu);
  });

  it("displays the latest submission even when it regresses and retains prior history", async () => {
    const first = Array.from({ length: 13 }, () => 0);
    first[12] = 1;
    const regressed = Array.from({ length: 13 }, () => 0);
    regressed[12] = 3;
    const pages = {
      opticalFlowAccuracy:
        listRow(301, "aneev first", first) + listRow(302, "aneev regressed", regressed),
      opticalFlowRobustness:
        listRow(301, "aneev first", [2]) + listRow(302, "aneev regressed", [4]),
      stereoAccuracy: "",
      stereoRobustness: "",
      sceneFlowAccuracy: "",
      sceneFlowRobustness: "",
    };
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      pages,
      (submissionId) => Promise.resolve(detailPage(
        0,
        0,
        0,
        submissionId === "301"
          ? "Aug. 28, 2026, 6:30 p.m."
          : "Aug. 29, 2026, 6:30 p.m.",
      )),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    const team = snapshot.teams.find((candidate) => candidate.teamId === "RoCo-12");
    expect(team?.results["optical-flow"]).toMatchObject({
      benchmarkMethod: "aneev regressed",
      springMetric: 3,
      robustSpringMetric: 7,
    });
    // A first refresh records every eligible matched submission within the
    // global fetch bound, while the current table uses the latest one.
    expect(team?.submissionHistory["optical-flow"]).toHaveLength(2);
    expect(team?.submissionHistory["optical-flow"]?.map((result) => result.benchmarkMethod))
      .toEqual(["aneev first", "aneev regressed"]);
  });

  it("excludes scene-flow projection rows from scalar task matching", async () => {
    const projected = Array.from({ length: 13 }, () => 0);
    projected[12] = 0.1;
    const real = Array.from({ length: 13 }, () => 0);
    real[12] = 2;
    const pages = {
      opticalFlowAccuracy:
        listRow(200, "aneev projected", projected, " [SF]") +
        listRow(201, "aneev scalar", real),
      opticalFlowRobustness:
        listRow(200, "aneev projected", [0.1], " [SF]") +
        listRow(201, "aneev scalar", [3]),
      stereoAccuracy: "",
      stereoRobustness: "",
      sceneFlowAccuracy: "",
      sceneFlowRobustness: "",
    };
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      pages,
      () => Promise.resolve(detailPage(0, 0, 0)),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    expect(snapshot.teams.find((team) => team.teamId === "RoCo-12")?.results["optical-flow"])
      .toMatchObject({ benchmarkMethod: "aneev scalar", springMetric: 2 });
  });

  it("rejects an explicit ID registered for another track before trying a team name", async () => {
    const clean = Array.from({ length: 11 }, () => 0);
    clean[10] = 1;
    const trackRoster: LeaderboardRosterTeam[] = [
      { teamId: "RoCo-12", teamName: "aneev", registeredTracks: ["optical-flow"] },
      { teamId: "RoCo-16", teamName: "Swarm", registeredTracks: ["stereo-matching"] },
    ];
    const snapshot = await buildLeaderboardSnapshot(
      trackRoster,
      {
        opticalFlowAccuracy: "",
        opticalFlowRobustness: "",
        stereoAccuracy: listRow(390, "RoCo-12 Swarm", clean),
        stereoRobustness: listRow(390, "RoCo-12 Swarm", [0, 2]),
        sceneFlowAccuracy: "",
        sceneFlowRobustness: "",
      },
      () => Promise.resolve(detailPage(0, 0, 0)),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    expect(snapshot.teams.every(
      (team) => team.results["stereo-matching"] === undefined,
    )).toBe(true);
  });

  it("accepts a valid pre-launch timestamp only for an exact RoCo ID", async () => {
    const clean = Array.from({ length: 13 }, () => 0);
    clean[12] = 1;
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      {
        opticalFlowAccuracy:
          listRow(391, "RoCo-12 explicit", clean) + listRow(392, "Swarm heuristic", clean),
        opticalFlowRobustness:
          listRow(391, "RoCo-12 explicit", [2]) + listRow(392, "Swarm heuristic", [2]),
        stereoAccuracy: "",
        stereoRobustness: "",
        sceneFlowAccuracy: "",
        sceneFlowRobustness: "",
      },
      () => Promise.resolve(detailPage(0, 0, 0, "June 24, 2026, 11 a.m.")),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    expect(snapshot.teams.find((team) => team.teamId === "RoCo-12")
      ?.results["optical-flow"]).toMatchObject({
        matchBasis: "team-id",
        submittedAt: "2026-06-24T09:00:00.000Z",
      });
    expect(snapshot.teams.find((team) => team.teamId === "RoCo-16")
      ?.results["optical-flow"]).toBeUndefined();
  });

  it("still requires a parseable timestamp for an exact RoCo ID", async () => {
    const clean = Array.from({ length: 13 }, () => 0);
    clean[12] = 1;
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      {
        opticalFlowAccuracy: listRow(393, "RoCo-12 explicit", clean),
        opticalFlowRobustness: listRow(393, "RoCo-12 explicit", [2]),
        stereoAccuracy: "",
        stereoRobustness: "",
        sceneFlowAccuracy: "",
        sceneFlowRobustness: "",
      },
      () => Promise.resolve("<h3>RoCo-12</h3><p>unknown — Public</p>"),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    expect(snapshot.teams.find((team) => team.teamId === "RoCo-12")
      ?.results["optical-flow"]).toBeUndefined();
  });

  it("bounds detail requests while retaining the newest result and ten history rows", async () => {
    const clean = Array.from({ length: 13 }, () => 0);
    clean[12] = 1;
    const ids = Array.from({ length: 240 }, (_value, index) => 600 + index);
    const pages = {
      opticalFlowAccuracy: ids.map((id) => listRow(id, `RoCo-12 run ${id}`, clean)).join(""),
      opticalFlowRobustness: ids.map((id) => listRow(id, `RoCo-12 run ${id}`, [2])).join(""),
      stereoAccuracy: "",
      stereoRobustness: "",
      sceneFlowAccuracy: "",
      sceneFlowRobustness: "",
    };
    const loaded: string[] = [];
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      pages,
      (submissionId) => {
        loaded.push(submissionId);
        return Promise.resolve(detailPage(0, 0, 0));
      },
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    const team = snapshot.teams.find((candidate) => candidate.teamId === "RoCo-12");
    expect(loaded).toHaveLength(192);
    expect(loaded).toContain("839");
    expect(team?.results["optical-flow"]?.benchmarkUrl).toBe("https://spring-benchmark.org/839/");
    expect(team?.submissionHistory["optical-flow"]).toHaveLength(10);
  });

  it("reserves a detail slot for every newest group before loading history", async () => {
    const fullRoster: LeaderboardRosterTeam[] = Array.from({ length: 25 }, (_value, index) => ({
      teamId: `RoCo-${index + 8}`,
      teamName: `Team ${index + 8}`,
      registeredTracks: ["optical-flow", "stereo-matching", "scene-flow"],
    }));
    const opticalClean = Array.from({ length: 13 }, () => 0);
    opticalClean[12] = 1;
    const stereoClean = Array.from({ length: 11 }, () => 0);
    stereoClean[10] = 1;
    const sceneRobust = [0, 1, 0, 0, 1, 0, 1];
    const pageRows = {
      opticalFlowAccuracy: [] as string[],
      opticalFlowRobustness: [] as string[],
      stereoAccuracy: [] as string[],
      stereoRobustness: [] as string[],
      sceneFlowAccuracy: [] as string[],
      sceneFlowRobustness: [] as string[],
    };
    const newestIds: string[] = [];
    let nextId = 1_000;
    for (const team of fullRoster) {
      for (const track of ["optical-flow", "stereo-matching", "scene-flow"] as const) {
        const oldId = nextId++;
        const newId = nextId++;
        newestIds.push(String(newId));
        const method = `${team.teamId} ${track}`;
        if (track === "optical-flow") {
          pageRows.opticalFlowAccuracy.push(
            listRow(oldId, method, opticalClean), listRow(newId, method, opticalClean),
          );
          pageRows.opticalFlowRobustness.push(
            listRow(oldId, method, [1]), listRow(newId, method, [1]),
          );
        } else if (track === "stereo-matching") {
          pageRows.stereoAccuracy.push(
            listRow(oldId, method, stereoClean), listRow(newId, method, stereoClean),
          );
          pageRows.stereoRobustness.push(
            listRow(oldId, method, [0, 1]), listRow(newId, method, [0, 1]),
          );
        } else {
          pageRows.sceneFlowAccuracy.push(
            listRow(oldId, method, [1]), listRow(newId, method, [1]),
          );
          pageRows.sceneFlowRobustness.push(
            listRow(oldId, method, sceneRobust), listRow(newId, method, sceneRobust),
          );
        }
      }
    }
    const loaded: string[] = [];
    const snapshot = await buildLeaderboardSnapshot(
      fullRoster,
      Object.fromEntries(Object.entries(pageRows).map(([key, rows]) => [key, rows.join("")])) as {
        [Key in keyof typeof pageRows]: string;
      },
      (submissionId) => {
        loaded.push(submissionId);
        return Promise.resolve(detailPage(1, 1, 1));
      },
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    expect(loaded).toHaveLength(150);
    expect(newestIds.every((submissionId) => loaded.includes(submissionId))).toBe(true);
    expect(snapshot.teams.every((team) =>
      ["optical-flow", "stereo-matching", "scene-flow"].every((track) =>
        team.results[track as "optical-flow"]?.submittedAt === "2026-08-29T16:30:00.000Z",
      ),
    )).toBe(true);
  });

  it("rejects pre-launch and unparseable benchmark timestamps", async () => {
    const clean = Array.from({ length: 13 }, () => 0);
    clean[12] = 1;
    const pages = {
      opticalFlowAccuracy:
        listRow(401, "aneev historical", clean) + listRow(402, "Swarm unknown", clean),
      opticalFlowRobustness:
        listRow(401, "aneev historical", [2]) + listRow(402, "Swarm unknown", [2]),
      stereoAccuracy: "",
      stereoRobustness: "",
      sceneFlowAccuracy: "",
      sceneFlowRobustness: "",
    };
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      pages,
      (submissionId) => Promise.resolve(submissionId === "401"
        ? detailPage(0, 0, 0, "June 24, 2026, 11 a.m.")
        : "<h3>Unknown</h3><p>not a timestamp — Public</p>"),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    expect(snapshot.teams.every((team) => team.results["optical-flow"] === undefined)).toBe(true);
    expect(snapshot.teams.every(
      (team) => team.submissionHistory["optical-flow"] === undefined,
    )).toBe(true);
  });

  it("does not let a newer unparseable row suppress an older eligible submission", async () => {
    const clean = Array.from({ length: 13 }, () => 0);
    clean[12] = 1;
    const pages = {
      opticalFlowAccuracy:
        listRow(411, "aneev valid", clean) + listRow(412, "aneev unknown", clean),
      opticalFlowRobustness:
        listRow(411, "aneev valid", [2]) + listRow(412, "aneev unknown", [1]),
      stereoAccuracy: "",
      stereoRobustness: "",
      sceneFlowAccuracy: "",
      sceneFlowRobustness: "",
    };
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      pages,
      (submissionId) => Promise.resolve(submissionId === "411"
        ? detailPage(0, 0, 0, "Aug. 28, 2026, 6:30 p.m.")
        : "<h3>Unknown</h3><p>not a timestamp — Public</p>"),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    const team = snapshot.teams.find((candidate) => candidate.teamId === "RoCo-12");
    expect(team?.results["optical-flow"]?.benchmarkMethod).toBe("aneev valid");
    expect(team?.submissionHistory["optical-flow"]).toHaveLength(1);
  });

  it("computes rank movement against the prior published snapshot", async () => {
    const clean = (value: number): number[] => {
      const metrics = Array.from({ length: 13 }, () => 0);
      metrics[12] = value;
      return metrics;
    };
    const empty = {
      stereoAccuracy: "",
      stereoRobustness: "",
      sceneFlowAccuracy: "",
      sceneFlowRobustness: "",
    };
    const first = await buildLeaderboardSnapshot(
      roster,
      {
        ...empty,
        opticalFlowAccuracy:
          listRow(501, "aneev entry", clean(1)) + listRow(502, "Swarm entry", clean(2)),
        opticalFlowRobustness:
          listRow(501, "aneev entry", [1]) + listRow(502, "Swarm entry", [2]),
      },
      () => Promise.resolve(detailPage(0, 0, 0, "Aug. 28, 2026, 6:30 p.m.")),
      null,
      new Date("2026-08-28T18:00:00.000Z"),
    );
    const second = await buildLeaderboardSnapshot(
      roster,
      {
        ...empty,
        opticalFlowAccuracy:
          listRow(501, "aneev entry", clean(5)) + listRow(502, "Swarm entry", clean(1)),
        opticalFlowRobustness:
          listRow(501, "aneev entry", [5]) + listRow(502, "Swarm entry", [1]),
      },
      () => Promise.resolve(detailPage(0, 0, 0)),
      first,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    expect(second.teams.find((team) => team.teamId === "RoCo-12")
      ?.results["optical-flow"]?.rankChange).toBe(-1);
    expect(second.teams.find((team) => team.teamId === "RoCo-16")
      ?.results["optical-flow"]?.rankChange).toBe(1);
  });

  it("ranks every named method and tracks movement by its stable benchmark URL", async () => {
    const clean = (value: number): number[] => {
      const metrics = Array.from({ length: 13 }, () => 0);
      metrics[12] = value;
      return metrics;
    };
    const empty = {
      stereoAccuracy: "",
      stereoRobustness: "",
      sceneFlowAccuracy: "",
      sceneFlowRobustness: "",
    };
    const first = await buildLeaderboardSnapshot(
      roster,
      {
        ...empty,
        opticalFlowAccuracy:
          listRow(531, "RoCo-12 Method A", clean(1)) +
          listRow(532, "RoCo-12 Method B", clean(4)) +
          listRow(533, "RoCo-16 Method C", clean(2)),
        opticalFlowRobustness:
          listRow(531, "RoCo-12 Method A", [1]) +
          listRow(532, "RoCo-12 Method B", [4]) +
          listRow(533, "RoCo-16 Method C", [2]),
      },
      () => Promise.resolve(detailPage(0, 0, 0)),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    const second = await buildLeaderboardSnapshot(
      roster,
      {
        ...empty,
        opticalFlowAccuracy:
          listRow(531, "RoCo-12 Method A", clean(1)) +
          listRow(532, "RoCo-12 Method B", clean(4)) +
          listRow(533, "RoCo-16 Method C", clean(2)) +
          listRow(534, "RoCo-16 Method D", clean(0.5)),
        opticalFlowRobustness:
          listRow(531, "RoCo-12 Method A", [1]) +
          listRow(532, "RoCo-12 Method B", [4]) +
          listRow(533, "RoCo-16 Method C", [2]) +
          listRow(534, "RoCo-16 Method D", [0.5]),
      },
      () => Promise.resolve(detailPage(0, 0, 0)),
      first,
      new Date("2026-08-29T18:05:00.000Z"),
    );

    const aneev = second.teams.find((team) => team.teamId === "RoCo-12");
    const swarm = second.teams.find((team) => team.teamId === "RoCo-16");
    expect(aneev?.submissionHistory["optical-flow"]?.map((result) => [
      result.benchmarkMethod,
      result.rankChange,
    ])).toEqual([
      ["RoCo-12 Method A", -1],
      ["RoCo-12 Method B", -1],
    ]);
    expect(swarm?.submissionHistory["optical-flow"]?.map((result) => [
      result.benchmarkMethod,
      result.rankChange,
    ])).toEqual([
      ["RoCo-16 Method C", -1],
      ["RoCo-16 Method D", 0],
    ]);
    expect(aneev?.results["optical-flow"]?.benchmarkMethod).toBe("RoCo-12 Method B");
    expect(aneev?.results["optical-flow"]?.rankChange).toBe(-1);
    expect(swarm?.results["optical-flow"]?.benchmarkMethod).toBe("RoCo-16 Method D");
    expect(swarm?.results["optical-flow"]?.rankChange).toBe(0);
  });

  it("drops cached results and history when a team unregisters a track", async () => {
    const clean = Array.from({ length: 13 }, () => 0);
    clean[12] = 1;
    const previous = await buildLeaderboardSnapshot(
      roster,
      {
        opticalFlowAccuracy: listRow(520, "RoCo-12", clean),
        opticalFlowRobustness: listRow(520, "RoCo-12", [1]),
        stereoAccuracy: "",
        stereoRobustness: "",
        sceneFlowAccuracy: "",
        sceneFlowRobustness: "",
      },
      () => Promise.resolve(detailPage(0, 0, 0)),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    const changedRoster: LeaderboardRosterTeam[] = [{
      teamId: "RoCo-12",
      teamName: "aneev",
      registeredTracks: ["stereo-matching"],
    }];
    const current = await buildLeaderboardSnapshot(
      changedRoster,
      {
        opticalFlowAccuracy: "",
        opticalFlowRobustness: "",
        stereoAccuracy: "",
        stereoRobustness: "",
        sceneFlowAccuracy: "",
        sceneFlowRobustness: "",
      },
      () => Promise.resolve(""),
      previous,
      new Date("2026-08-29T18:05:00.000Z"),
    );
    expect(current.teams[0]?.results["optical-flow"]).toBeUndefined();
    expect(current.teams[0]?.submissionHistory["optical-flow"]).toBeUndefined();
    expect(reconstructPublicLeaderboardSnapshot(current)).not.toBeNull();
  });
});

describe("leaderboard callable input", () => {
  it("accepts only an optional force boolean", () => {
    expect(parseLeaderboardRefreshInput(undefined)).toEqual({ force: false });
    expect(parseLeaderboardRefreshInput({})).toEqual({ force: false });
    expect(parseLeaderboardRefreshInput({ force: true })).toEqual({ force: true });
    expect(() => parseLeaderboardRefreshInput({ force: "true" })).toThrow();
    expect(() => parseLeaderboardRefreshInput({ force: true, teamId: "RoCo-12" })).toThrow();
  });

  it("deeply reconstructs cached public fields and rejects malformed results", async () => {
    const opticalClean = Array.from({ length: 13 }, () => 0);
    opticalClean[12] = 1;
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      {
        opticalFlowAccuracy: listRow(800, "RoCo-12", opticalClean),
        opticalFlowRobustness: listRow(800, "RoCo-12", [2]),
        stereoAccuracy: "",
        stereoRobustness: "",
        sceneFlowAccuracy: "",
        sceneFlowRobustness: "",
      },
      () => Promise.resolve(detailPage(0, 0, 0)),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    const injected = structuredClone(snapshot) as unknown as Record<string, unknown>;
    injected.primaryContactEmail = "private@example.org";
    injected.sourceLabel = "attacker-controlled";
    const injectedTeams = injected.teams as Array<Record<string, unknown>>;
    injectedTeams[0]!.members = [{ email: "private@example.org" }];
    const injectedResults = injectedTeams[0]!.results as Record<string, Record<string, unknown>>;
    injectedResults["optical-flow"]!.privateNested = "nested-secret";
    const injectedHistory = injectedTeams[0]!.submissionHistory as Record<string, unknown[]>;
    (injectedHistory["optical-flow"]![0] as Record<string, unknown>).secret = "history-secret";
    const reconstructed = reconstructPublicLeaderboardSnapshot(injected);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.sourceLabel).toBe(
      "Live Spring and RobustSpring public benchmark snapshot",
    );
    expect(JSON.stringify(reconstructed)).not.toMatch(
      /private@example|members|nested-secret|history-secret/iu,
    );

    const malformed = structuredClone(snapshot);
    malformed.teams[0]!.results["optical-flow"] = {
      rankChange: 0,
      score: Number.POSITIVE_INFINITY,
      springMetric: 1,
      robustSpringMetric: 2,
      springTerm: 1,
      robustSpringTerm: 2,
      submittedAt: "2026-08-29T16:30:00.000Z",
      benchmarkMethod: "Bad cache",
      benchmarkUrl: "https://evil.example/1/",
      matchBasis: "team-id",
    };
    expect(reconstructPublicLeaderboardSnapshot(malformed)).toBeNull();
  });

  it("reports healthy cache hits and stale fallback separately", async () => {
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      {
        opticalFlowAccuracy: "",
        opticalFlowRobustness: "",
        stereoAccuracy: "",
        stereoRobustness: "",
        sceneFlowAccuracy: "",
        sceneFlowRobustness: "",
      },
      () => Promise.resolve(""),
      null,
      new Date("2026-08-29T18:00:00.000Z"),
    );
    const fake = new FakeFirestore();
    fake.seed("publicLeaderboard/current-v1", {
      snapshot: { ...snapshot, privateEmail: "must-not-escape@example.org" },
    });
    const db = {
      collection(name: string) {
        if (name === "teams") {
          return {
            where: () => ({ get: () => Promise.resolve({ docs: [] }) }),
          };
        }
        return fake.collection(name);
      },
      runTransaction: fake.runTransaction.bind(fake),
    } as unknown as Firestore;
    const healthy = await refreshLeaderboardOperation(
      db,
      false,
      new Date("2026-08-29T18:00:30.000Z"),
    );
    expect(healthy.syncStatus).toBe("cache-hit");
    expect(mocks.loggerError).not.toHaveBeenCalled();

    const fetchMock = vi.fn().mockRejectedValue(new Error("benchmark offline"));
    vi.stubGlobal("fetch", fetchMock);
    const stale = await refreshLeaderboardOperation(
      db,
      true,
      new Date("2026-08-29T20:00:00.000Z"),
    );
    expect(stale.syncStatus).toBe("stale-cache");
    expect(stale.updatedAt).toBe(snapshot.updatedAt);
    expect(JSON.stringify(stale)).not.toContain("must-not-escape@example.org");
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Leaderboard refresh failed; serving stale cache",
      {
        operation: "leaderboardRefresh",
        status: "failed",
        errorCategory: "transient",
      },
    );
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toMatch(
      /spring-benchmark|benchmark offline|RoCo-|must-not-escape|https?:\/\//iu,
    );
    const callsAfterFailure = fetchMock.mock.calls.length;
    const cooledDown = await refreshLeaderboardOperation(
      db,
      true,
      new Date("2026-08-29T20:00:30.000Z"),
    );
    expect(cooledDown.syncStatus).toBe("stale-cache");
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFailure);
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });

  it("publishes only canonical active participant records from RoCo-8 onward", () => {
    const valid = {
      status: "active",
      teamId: "RoCo-8",
      teamNumber: 8,
      teamName: "Public Team",
      tracks: ["optical-flow", "optical-flow", "exploration"],
      primaryContactEmail: "private@example.org",
      members: [{ email: "private@example.org" }],
    };
    expect(publicRosterTeamFromDocument("RoCo-8", valid)).toEqual({
      teamId: "RoCo-8",
      teamName: "Public Team",
      registeredTracks: ["optical-flow", "exploration"],
    });
    for (const [documentId, patch] of [
      ["RoCo-7", { teamId: "RoCo-7", teamNumber: 7 }],
      ["different-id", {}],
      ["RoCo-8", { teamNumber: 9 }],
      ["RoCo-8", { status: "disabled" }],
    ] as const) {
      expect(publicRosterTeamFromDocument(documentId, { ...valid, ...patch })).toBeNull();
    }
  });
});
