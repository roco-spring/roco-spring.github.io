import type { Firestore } from "firebase-admin/firestore";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loggerError: vi.fn() }));
vi.mock("firebase-functions", () => ({ logger: { error: mocks.loggerError } }));

import {
  LEADERBOARD_BASELINE_METADATA,
  refreshLeaderboardOperation,
  type PublicLeaderboardSnapshot,
} from "../src/leaderboard.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

const CACHE_PATH = "publicLeaderboard/current-v1";
const NAMES_PATH = "publicLeaderboardMethodNames/RoCo-29";
const FIRST_REFRESH = new Date("2026-09-07T10:00:00.000Z");

// Exercise the real HTTP document/schema parser, not a mocked snapshot builder.
// Each fixture has the public benchmark's actual ordered metric sort keys.
const SORT_KEYS = {
  "opticalflow?display=accuracy": [
    "err_1px_Fl_total", "err_1px_Fl_lowdetail", "err_1px_Fl_highdetail",
    "err_1px_Fl_matched", "err_1px_Fl_unmatched", "err_1px_Fl_rigid",
    "err_1px_Fl_nonrigid", "err_1px_Fl_notsky", "err_1px_Fl_sky",
    "err_1px_Fl_s0_10", "err_1px_Fl_s10_40", "err_1px_Fl_s40",
    "err_EPE_Fl_total", "err_Fl_total", "err_WAUC_Fl_total",
  ],
  "opticalflow?display=robustness": [
    "robust_EPE_Fl_total", "robust_Fl_total", "robust_1px_Fl_total",
  ],
  "stereo?display=accuracy": [
    "", "err_1px_D1_lowdetail", "err_1px_D1_highdetail", "err_1px_D1_matched",
    "err_1px_D1_unmatched", "err_1px_D1_notsky", "err_1px_D1_sky",
    "err_1px_D1_s0_10", "err_1px_D1_s10_40", "err_1px_D1_s40",
    "err_Abs_D1_total", "err_D1_total",
  ],
  "stereo?display=robustness": [
    "robust_1px_D1_total", "robust_Abs_D1_total", "robust_D1_total",
  ],
  "sceneflow?display=accuracy": [
    "", "err_1px_SF_lowdetail", "err_1px_SF_highdetail", "err_1px_SF_matched",
    "err_1px_SF_unmatched", "err_1px_SF_rigid", "err_1px_SF_nonrigid",
    "err_1px_SF_notsky", "err_1px_SF_sky", "err_1px_SF_s0_10",
    "err_1px_SF_s10_40", "err_1px_SF_s40", "err_SF_total",
    "err_1px_D1_total", "err_1px_D2_total", "err_1px_Fl_total",
  ],
  "sceneflow?display=robustness": [
    "robust_disp1_1px_total", "robust_disp1_Abs_total", "robust_disp1_D1_total",
    "robust_disp2_1px_total", "robust_disp2_Abs_total", "robust_disp2_D2_total",
    "robust_flow_EPE_total", "robust_flow_Fl_total", "robust_flow_1px_total",
  ],
} satisfies Record<string, string[]>;

function table(keys: readonly string[], submissionIds: readonly number[], optical: boolean): string {
  const headers = keys.map((key) =>
    `<th><a href="/?s=${key}">metric</a></th>`,
  ).join("");
  const rows = submissionIds.map((id) => {
    const metrics = keys.map((_key, index) => optical && index === 12 ? 1.411 : 3.328);
    const name = optical ? "RoCo-29" : "Unrelated benchmark";
    return `<tr><td>1</td><td><a href="/${id}/">${name}</a></td>` +
      metrics.map((metric) => `<td>${metric}</td>`).join("") + "</tr>";
  }).join("");
  return `<table><tr><th>Rank</th><th>Name</th>${headers}</tr>${rows}</table>`;
}

function mockBenchmark(submissionIds: readonly number[], beforeDetail?: () => void) {
  const pages = new Map(Object.entries(SORT_KEYS).map(([path, keys]) => [
    `/${path}`,
    table(keys, path.startsWith("opticalflow") ? submissionIds : [31], path.startsWith("opticalflow")),
  ]));
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const listing = pages.get(url.pathname + url.search);
    if (listing) {
      return Promise.resolve(new Response(listing, { headers: { "content-type": "text/html" } }));
    }
    const id = Number(/^\/(\d+)\/$/u.exec(url.pathname)?.[1]);
    if (url.origin !== "https://spring-benchmark.org" || !submissionIds.includes(id)) {
      throw new Error("Unexpected benchmark fixture URL.");
    }
    beforeDetail?.();
    const detail = "<h3>RoCo-29</h3><p>Sept. 3, 2026, 6:56 p.m. &mdash; Public</p>";
    return Promise.resolve(new Response(detail, { headers: { "content-type": "text/html" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function database(
  fake: FakeFirestore,
  { rejectCommit = false, active = true } = {},
): Firestore {
  let transactionCount = 0;
  return {
    collection(name: string) {
      if (name === "teams") {
        return {
          where: () => ({ get: () => Promise.resolve({ docs: active ? [{
            id: "RoCo-29",
            data: () => ({ status: "active", teamId: "RoCo-29", teamNumber: 29,
              teamName: "VSAI", tracks: ["optical-flow"] }),
          }] : [] }) }),
        };
      }
      return fake.collection(name);
    },
    runTransaction<T>(callback: Parameters<FakeFirestore["runTransaction"]>[0]): Promise<T> {
      transactionCount += 1;
      const thisTransaction = transactionCount;
      return fake.runTransaction(async (transaction) => {
        const result = await callback(transaction);
        // Reject after the publication callback has queued every write. The
        // fake applies writes only once the callback completes successfully.
        if (rejectCommit && thisTransaction === 2) throw new Error("Commit rejected.");
        return result as T;
      });
    },
  } as unknown as Firestore;
}

function previousSnapshot(): PublicLeaderboardSnapshot {
  return {
    schemaVersion: 2,
    updatedAt: "2026-09-07T09:00:00.000Z",
    sourceLabel: "Live Spring and RobustSpring public benchmark snapshot",
    scoringConvention: "organizer-approved-additive-proxy",
    baselines: LEADERBOARD_BASELINE_METADATA,
    syncStatus: "fresh",
    teams: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("leaderboard refresh method-name persistence", () => {
  it("commits the first unnamed method and its visible snapshot together", async () => {
    const fake = new FakeFirestore();
    const fetchMock = mockBenchmark([474]);
    const snapshot = await refreshLeaderboardOperation(database(fake), true, FIRST_REFRESH);

    expect(snapshot.syncStatus).toBe("fresh");
    expect(snapshot.teams[0]?.results["optical-flow"]).toMatchObject({
      benchmarkMethod: "Method 1",
      benchmarkUrl: "https://spring-benchmark.org/474/",
      springMetric: 1.411,
      robustSpringMetric: 4.739,
    });
    expect(fake.read(NAMES_PATH)).toEqual({ version: 1, assignments: { "474": 1 } });
    expect(fake.read(CACHE_PATH)?.snapshot).toEqual(snapshot);
    expect(fake.read(CACHE_PATH)?.refreshLeaseId).toBeUndefined();
    expect(fake.read(CACHE_PATH)?.refreshLeaseUntilMs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("preserves Method 1 across refreshes and assigns a later unnamed submission Method 2", async () => {
    const fake = new FakeFirestore();
    const db = database(fake);
    mockBenchmark([474]);
    await refreshLeaderboardOperation(db, true, FIRST_REFRESH);
    mockBenchmark([490, 474]);
    const snapshot = await refreshLeaderboardOperation(db, true, new Date("2026-09-07T10:02:00.000Z"));

    expect(fake.read(NAMES_PATH)).toEqual({ version: 1, assignments: { "474": 1, "490": 2 } });
    const names = Object.fromEntries(snapshot.teams[0]!.submissionHistory["optical-flow"]!
      .map((entry) => [entry.benchmarkUrl, entry.benchmarkMethod]));
    expect(names).toEqual({
      "https://spring-benchmark.org/474/": "Method 1",
      "https://spring-benchmark.org/490/": "Method 2",
    });
    expect(fake.read(CACHE_PATH)?.snapshot).toEqual(snapshot);
  });

  it("keeps a removed team's registry intact and continues its numbering after reactivation", async () => {
    const fake = new FakeFirestore();
    mockBenchmark([474]);
    await refreshLeaderboardOperation(database(fake), true, FIRST_REFRESH);
    const registry = fake.read(NAMES_PATH);

    // The public cache still contains this team's previous result when its
    // active roster entry disappears. Migration must not rewrite its registry.
    const removed = await refreshLeaderboardOperation(
      database(fake, { active: false }), true, new Date("2026-09-07T10:02:00.000Z"),
    );
    expect(removed.teams).toEqual([]);
    expect(fake.read(NAMES_PATH)).toEqual(registry);

    mockBenchmark([490, 474]);
    const reactivated = await refreshLeaderboardOperation(
      database(fake), true, new Date("2026-09-07T10:04:00.000Z"),
    );
    expect(fake.read(NAMES_PATH)).toEqual({ version: 1, assignments: { "474": 1, "490": 2 } });
    expect(reactivated.teams[0]?.submissionHistory["optical-flow"]?.map((result) =>
      result.benchmarkMethod,
    )).toEqual(["Method 1", "Method 2"]);
  });

  it("does not publish a snapshot or consume a method number after losing its lease", async () => {
    const fake = new FakeFirestore();
    mockBenchmark([474], () => fake.update(CACHE_PATH, {
      refreshLeaseId: "replacement-worker",
      refreshLeaseUntilMs: FIRST_REFRESH.getTime() + 180_000,
    }));

    await expect(refreshLeaderboardOperation(database(fake), true, FIRST_REFRESH))
      .rejects.toMatchObject({ code: "aborted" });
    expect(fake.read(NAMES_PATH)).toBeUndefined();
    expect(fake.read(CACHE_PATH)?.snapshot).toBeUndefined();
    // Cleanup by the superseded worker must not erase its successor's lease.
    expect(fake.read(CACHE_PATH)?.refreshLeaseId).toBe("replacement-worker");
  });

  it("keeps the old snapshot and registry when the publication transaction fails", async () => {
    const fake = new FakeFirestore();
    const previous = previousSnapshot();
    const registry = { version: 1, assignments: { "450": 1 } };
    fake.seed(CACHE_PATH, { snapshot: previous });
    fake.seed(NAMES_PATH, registry);
    mockBenchmark([474]);

    const result = await refreshLeaderboardOperation(database(fake, { rejectCommit: true }), true, FIRST_REFRESH);
    expect(result.syncStatus).toBe("stale-cache");
    expect(result.updatedAt).toBe(previous.updatedAt);
    expect(fake.read(CACHE_PATH)?.snapshot).toEqual(previous);
    expect(fake.read(NAMES_PATH)).toEqual(registry);
    expect(fake.read(CACHE_PATH)?.refreshLeaseId).toBeUndefined();
  });

  it.each([
    { version: 2, assignments: { "474": 1 } },
    { version: 1, assignments: { "474": 0 } },
    { version: 1, assignments: { "474": 1, "490": 1 } },
  ])("preserves malformed registries and serves the existing public snapshot: %j", async (registry) => {
    const fake = new FakeFirestore();
    const previous = previousSnapshot();
    fake.seed(CACHE_PATH, { snapshot: previous });
    fake.seed(NAMES_PATH, registry);
    const fetchMock = mockBenchmark([474]);

    const result = await refreshLeaderboardOperation(database(fake), true, FIRST_REFRESH);
    expect(result.syncStatus).toBe("stale-cache");
    expect(result.updatedAt).toBe(previous.updatedAt);
    expect(fake.read(CACHE_PATH)?.snapshot).toEqual(previous);
    expect(fake.read(NAMES_PATH)).toEqual(registry);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Leaderboard refresh failed; serving stale cache",
      { operation: "leaderboardRefresh", status: "failed", errorCategory: "internal" },
    );
  });

  it("refuses to reset an invalid registry when no public cache exists", async () => {
    const fake = new FakeFirestore();
    const registry = { version: 1, assignments: { "474": -1 } };
    fake.seed(NAMES_PATH, registry);
    mockBenchmark([474]);

    await expect(refreshLeaderboardOperation(database(fake), true, FIRST_REFRESH))
      .rejects.toMatchObject({ code: "internal" });
    expect(fake.read(NAMES_PATH)).toEqual(registry);
    expect(fake.read(CACHE_PATH)?.snapshot).toBeUndefined();
    expect(fake.read(CACHE_PATH)?.refreshLeaseId).toBeUndefined();
  });
});
