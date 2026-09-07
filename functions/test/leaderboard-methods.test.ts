import { describe, expect, it } from "vitest";
import {
  extractBenchmarkMethodName,
  matchBenchmarkTeam,
  planUnnamedMethodAssignments,
  reconstructUnnamedMethodAssignments,
} from "../src/leaderboard-methods.js";

const roster = [
  { teamId: "RoCo-14", teamName: "Car Team" },
  { teamId: "RoCo-19", teamName: "Flow Lab" },
  { teamId: "RoCo-29", teamName: "VSAI" },
];

describe("benchmark ownership and method names", () => {
  it.each([
    ["RoCo-14 CAR-WAFT", "RoCo-14", "CAR-WAFT"],
    ["RoCo-19-WAFT+", "RoCo-19", "WAFT+"],
    ["RoCo-29", "RoCo-29", null],
    ["VSAI Roco-29", "RoCo-29", null],
    ["(RoCo-29) VSAI", "RoCo-29", null],
    ["CAR-WAFT — RoCo_14", "RoCo-14", "CAR-WAFT"],
    ["RoCo–14 CAR-WAFT", "RoCo-14", "CAR-WAFT"],
    ["roco  14 CAR-WAFT", "RoCo-14", "CAR-WAFT"],
    ["RoCo−014 CAR-WAFT", "RoCo-14", "CAR-WAFT"],
    ["Car Team | RoCo-14 | CAR-WAFT", "RoCo-14", "CAR-WAFT"],
  ])("separates %s into its registered team and method", (source, teamId, method) => {
    const matched = matchBenchmarkTeam(source, roster);
    expect(matched).toMatchObject({ team: { teamId }, basis: "team-id" });
    expect(extractBenchmarkMethodName(source, matched!.team)).toBe(method);
  });

  it.each([
    "RoCo-1 VSAI", "RoCo-140 Car Team", "RoCo-999 VSAI",
    "RoCo-14 RoCo-29 CAR-WAFT", "RoCo-14 RoCo-999 CAR-WAFT",
    "RoCo-14abc VSAI", "RoCo-0 VSAI", "RoCo-99999999999999999 VSAI",
    "prefixRoCo-14 CAR-WAFT", "RoCo-14suffix CAR-WAFT",
  ])("does not attribute unknown, conflicting, or partial IDs in %s", (source) => {
    expect(matchBenchmarkTeam(source, roster)).toBeNull();
  });

  it("allows repeated references to the same ID and rejects duplicate roster ownership", () => {
    const source = "RoCo-14 CAR-WAFT (RoCo_14)";
    const matched = matchBenchmarkTeam(source, roster);
    expect(matched?.team.teamId).toBe("RoCo-14");
    expect(extractBenchmarkMethodName(source, matched!.team)).toBe("CAR-WAFT");
    expect(matchBenchmarkTeam(source, [roster[0]!, { ...roster[0]! }])).toBeNull();
  });

  it("keeps normalized legacy team-name matching without stripping method substrings", () => {
    const legacyRoster = [{ teamId: "RoCo-12", teamName: "aneev" }];
    expect(matchBenchmarkTeam("ANE-EV++", legacyRoster)?.basis).toBe("team-name");
    expect(extractBenchmarkMethodName("ANE-EV++", legacyRoster[0]!)).toBe("ANE-EV++");
    expect(extractBenchmarkMethodName("aneev FastFlow", legacyRoster[0]!)).toBe("FastFlow");
    expect(matchBenchmarkTeam("VSAI Car Team fusion", roster)).toBeNull();
  });

  it("preserves meaningful punctuation in names that resemble the registered team", () => {
    expect(extractBenchmarkMethodName("RoCo-14 CAR-WAFT", { teamId: "RoCo-14", teamName: "CAR" }))
      .toBe("CAR-WAFT");
    expect(extractBenchmarkMethodName("RoCo-19-WAFT+", { teamId: "RoCo-19", teamName: "WAFT" }))
      .toBe("WAFT+");
    expect(extractBenchmarkMethodName("RoCo-19 M(F)+", { teamId: "RoCo-19", teamName: "Flow Lab" }))
      .toBe("M(F)+");
    expect(extractBenchmarkMethodName("RoCo-19 WAFT(large)", { teamId: "RoCo-19", teamName: "Flow Lab" }))
      .toBe("WAFT(large)");
  });

  it.each([
    ["WAFT(large)", "WAFT"],
    ["Flow[v2]", "Flow"],
    ["Flow{large}", "Flow"],
  ])("preserves an attached suffix in %s when the prefix is the registered team", (method, teamName) => {
    expect(extractBenchmarkMethodName(`RoCo-19 ${method}`, { teamId: "RoCo-19", teamName }))
      .toBe(method);
  });

  it.each(["(WAFT)", "[WAFT]", "{WAFT}"])("still strips the team inside a %s wrapper", (wrappedName) => {
    expect(extractBenchmarkMethodName(`RoCo-19 ${wrappedName} CAR-WAFT`, {
      teamId: "RoCo-19", teamName: "WAFT",
    })).toBe("CAR-WAFT");
    expect(extractBenchmarkMethodName(`RoCo-19 ${wrappedName}`, {
      teamId: "RoCo-19", teamName: "WAFT",
    })).toBeNull();
  });
});

describe("durable unnamed-method assignments", () => {
  it("numbers only unnamed submissions, once per source ID and in numeric source order", () => {
    expect(planUnnamedMethodAssignments({}, [
      { submissionId: "488", methodName: "WAFT+" },
      { submissionId: "490", methodName: null },
      { submissionId: "474", methodName: null },
      { submissionId: "474", methodName: null },
    ])).toEqual({ "474": 1, "490": 2 });
  });

  it("retains numbers across pruning, disappearance, renaming, and later reappearance", () => {
    const previous = { "474": 1, "490": 2, "500": 3 };
    const second = planUnnamedMethodAssignments(previous, [
      { submissionId: "474", methodName: "Now Named" },
      { submissionId: "510", methodName: null },
    ]);
    expect(second).toEqual({ ...previous, "510": 4 });
    expect(previous).toEqual({ "474": 1, "490": 2, "500": 3 });
    expect(planUnnamedMethodAssignments(second, [
      { submissionId: "474", methodName: null },
      { submissionId: "499", methodName: null },
    ])).toEqual({ ...second, "499": 5 });
  });

  it("keeps an assignment when the same source appears in several tracks", () => {
    expect(planUnnamedMethodAssignments({ "474": 1 }, [
      { submissionId: "474", methodName: null },
      { submissionId: "474", methodName: " " },
      { submissionId: "480", methodName: null },
    ])).toEqual({ "474": 1, "480": 2 });
  });

  it.each([
    null, [], "invalid", new Date(0), new Map(), { "474": 0 }, { "474": -1 }, { "474": 1.5 },
    { "474": Number.NaN }, { "474": "1" }, { "474": 1, "490": 1 },
    { "0474": 1 }, { "not-an-id": 1 }, { "0": 1 }, { "474": 1_000_000_001 },
  ])("rejects malformed persisted state instead of reusing method numbers: %j", (value) => {
    expect(reconstructUnnamedMethodAssignments(value)).toBeNull();
  });

  it("returns a validated copy and fails on invalid source IDs", () => {
    const original = { "474": 1 };
    const copy = reconstructUnnamedMethodAssignments(original);
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(() => planUnnamedMethodAssignments({ "474": 0 }, [])).toThrow("Invalid persisted");
    expect(() => planUnnamedMethodAssignments({}, [
      { submissionId: "../474", methodName: null },
    ])).toThrow("Invalid benchmark submission ID");
  });
});
