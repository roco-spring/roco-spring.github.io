import { describe, expect, it, vi } from "vitest";
import {
  buildLeaderboardUpdate,
  type LeaderboardRosterTeam,
  type QuantitativeTrack,
} from "../src/leaderboard.js";

const NOW = new Date("2026-09-07T10:00:00.000Z");
const OLD_URL = "https://spring-benchmark.org/474/";

function detail(): string {
  return "<h3>Benchmark method</h3><p>Sept. 3, 2026, 6:56 p.m. &mdash; Public</p>" +
    "<h4>Disparity 1</h4><table><tr><th>Abs<br>total</th></tr><tr><td>1</td></tr></table>" +
    "<h4>Disparity 2</h4><table><tr><th>Abs<br>total</th></tr><tr><td>1</td></tr></table>" +
    "<h4>Optical Flow</h4><table><tr><th>EPE<br>total</th></tr><tr><td>1</td></tr></table>";
}

function pages(track: QuantitativeTrack, entries: readonly { id: number; team: number }[]) {
  const rows = (metricCount: number): string => entries.map(({ id, team }) =>
    `<tr><td>1</td><td><a href="/${id}/">RoCo-${team} Method ${id}</a></td>` +
    "<td>1.000</td>".repeat(metricCount) + "</tr>",
  ).join("");
  return {
    opticalFlowAccuracy: track === "optical-flow" ? rows(15) : "",
    opticalFlowRobustness: track === "optical-flow" ? rows(3) : "",
    stereoAccuracy: track === "stereo-matching" ? rows(12) : "",
    stereoRobustness: track === "stereo-matching" ? rows(3) : "",
    sceneFlowAccuracy: track === "scene-flow" ? rows(16) : "",
    sceneFlowRobustness: track === "scene-flow" ? rows(9) : "",
  };
}

function roster(track: QuantitativeTrack): LeaderboardRosterTeam[] {
  return [
    { teamId: "RoCo-29", teamName: "VSAI", registeredTracks: [track] },
    { teamId: "RoCo-30", teamName: "Other Group", registeredTracks: [track] },
  ];
}

describe("leaderboard history when the detail-fetch budget is full", () => {
  it.each(["optical-flow", "stereo-matching", "scene-flow"] as const)(
    "retains verified %s history skipped only because 192 newer details occupy the budget",
    async (track) => {
      const teams = roster(track);
      const first = await buildLeaderboardUpdate(teams, pages(track, [{ id: 474, team: 29 }]),
        () => Promise.resolve(detail()), null, NOW);
      const previous = first.snapshot.teams.find((team) => team.teamId === "RoCo-29")!
        .submissionHistory[track]![0]!;
      const detailLoader = vi.fn(() => Promise.resolve(detail()));
      // One current result for each team is reserved. The other team's many
      // recent methods fill every remaining slot before the older result 474.
      const entries = [{ id: 474, team: 29 }, { id: 500, team: 29 },
        ...Array.from({ length: 193 }, (_value, index) => ({ id: 2_000 + index, team: 30 }))];
      const second = await buildLeaderboardUpdate(teams, pages(track, entries), detailLoader,
        first.snapshot, NOW, first.methodAssignments);
      const history = second.snapshot.teams.find((team) => team.teamId === "RoCo-29")!
        .submissionHistory[track]!;

      expect(detailLoader).toHaveBeenCalledTimes(192);
      expect(detailLoader).not.toHaveBeenCalledWith("474");
      expect(history).toHaveLength(2);
      expect(history.find((result) => result.benchmarkUrl === OLD_URL)).toMatchObject({
        score: previous.score,
        springMetric: previous.springMetric,
        robustSpringMetric: previous.robustSpringMetric,
        benchmarkMethod: previous.benchmarkMethod,
        submittedAt: previous.submittedAt,
      });
    },
  );

  it("does not preserve an old owner when a skipped detail now belongs to another team", async () => {
    const track = "optical-flow";
    const teams = roster(track);
    const first = await buildLeaderboardUpdate(teams, pages(track, [{ id: 474, team: 29 }]),
      () => Promise.resolve(detail()), null, NOW);
    const detailLoader = vi.fn(() => Promise.resolve(detail()));
    const entries = [{ id: 474, team: 30 }, { id: 500, team: 29 },
      ...Array.from({ length: 193 }, (_value, index) => ({ id: 2_000 + index, team: 30 }))];
    const second = await buildLeaderboardUpdate(teams, pages(track, entries), detailLoader,
      first.snapshot, NOW, first.methodAssignments);

    expect(detailLoader).not.toHaveBeenCalledWith("474");
    expect(second.snapshot.teams.find((team) => team.teamId === "RoCo-29")!
      .submissionHistory[track]?.some((result) => result.benchmarkUrl === OLD_URL)).toBe(false);
  });
});
