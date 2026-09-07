(function () {
    "use strict";

    const scriptUrl = document.currentScript?.src || location.href;
    const publishedSnapshotUrl = new URL("leaderboard-data.json", scriptUrl);
    const quantitativeTrackKeys = ["optical-flow", "stereo-matching", "scene-flow"];
    const tracks = [
        {
            key: "optical-flow",
            label: "Optical Flow",
            springLabel: "Spring EPE",
            robustLabel: "RobustSpring Proxy EPE"
        },
        {
            key: "stereo-matching",
            label: "Stereo Matching",
            springLabel: "Spring Abs",
            robustLabel: "RobustSpring Proxy Abs"
        },
        {
            key: "scene-flow",
            label: "Scene Flow",
            springLabel: "Spring Aggregate",
            robustLabel: "RobustSpring Proxy Aggregate"
        },
        {
            key: "cross-task",
            label: "Cross-Task",
            springLabel: "Spring Aggregate",
            robustLabel: "RobustSpring Proxy Aggregate"
        }
    ];

    // These are all current Spring-team entries with complete values in both
    // official Spring and RobustSpring table views. The smaller common-paper
    // subset on evaluation.html still defines the fixed denominators; every
    // reference score below is calculated against those same denominators.
    const baselineMethods = Object.freeze({
        "optical-flow": Object.freeze([
            { method: "SEA-RAFT", resultId: 291, springMetric: 0.363, disagreement: 2.960, submittedAt: "2025-11-23T10:05:00Z" },
            { method: "MS-RAFT+", resultId: 51, springMetric: 0.643, disagreement: 3.620, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "FlowFormer", resultId: 54, springMetric: 0.723, disagreement: 3.770, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "FlowNet2", resultId: 56, springMetric: 1.040, disagreement: 7.010, submittedAt: "2022-05-01T09:29:00Z" },
            { method: "RoCo-Spring Team Baselines-Optical Flow", resultId: 460, springMetric: 1.493, disagreement: 4.360, submittedAt: "2026-08-14T14:16:00Z" },
            { method: "RAFT", resultId: 52, springMetric: 1.476, disagreement: 5.640, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "GMA", resultId: 53, springMetric: 0.914, disagreement: 4.030, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "GMFlow", resultId: 58, springMetric: 0.945, disagreement: 2.980, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "RAFT-3D (K)", resultId: 71, springMetric: 2.528, disagreement: 5.030, submittedAt: "2022-11-08T16:15:00Z" },
            { method: "M-FUSE (K)", resultId: 64, springMetric: 2.526, disagreement: 3.390, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "SPyNet", resultId: 55, springMetric: 4.162, disagreement: 4.290, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "PWCNet", resultId: 57, springMetric: 2.288, disagreement: 7.250, submittedAt: "2022-11-01T13:00:00Z" }
        ]),
        "stereo-matching": Object.freeze([
            { method: "RAFT-Stereo", resultId: 66, springMetric: 3.025, disagreement: 16.570, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "ACVNet", resultId: 68, springMetric: 1.516, disagreement: 15.790, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "RoCo-Spring Team Baselines-Stereo", resultId: 458, springMetric: 3.875, disagreement: 18.908, submittedAt: "2026-08-13T00:24:00Z" },
            { method: "LEAStereo", resultId: 60, springMetric: 3.884, disagreement: 21.900, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "GANet", resultId: 59, springMetric: 4.594, disagreement: 12.110, submittedAt: "2022-11-01T13:00:00Z" },
            { method: "GANet (K)", resultId: 204, springMetric: 5.287, disagreement: 6.440, submittedAt: "2025-03-07T10:25:00Z" },
            { method: "LEAStereo (K)", resultId: 205, springMetric: 6.145, disagreement: 8.240, submittedAt: "2025-03-07T11:32:00Z" }
        ]),
        "scene-flow": Object.freeze([
            {
                method: "RoCo-Spring Team Baselines-Scene Flow",
                resultId: 462,
                springComponents: { d1: 3.875, d2: 3.802, flow: 1.250 },
                disagreementComponents: { d1: 18.908, d2: 18.590, flow: 6.813 },
                submittedAt: "2026-08-16T02:54:00Z"
            },
            {
                method: "M-FUSE (K)",
                resultId: 64,
                springComponents: { d1: 7.890, d2: 8.076, flow: 2.526 },
                disagreementComponents: { d1: 21.900, d2: 0.290, flow: 3.390 },
                submittedAt: "2022-11-01T13:00:00Z"
            },
            {
                method: "RAFT-3D (K)",
                resultId: 71,
                springComponents: { d1: 7.042, d2: 7.111, flow: 2.528 },
                disagreementComponents: { d1: 12.110, d2: 0.140, flow: 5.030 },
                submittedAt: "2022-11-08T16:15:00Z"
            }
        ])
    });

    let currentSnapshot = null;
    let selectedTrack = tracks[0].key;
    let loadSnapshot = loadPublishedSnapshot;
    let refreshGeneration = 0;
    let initialRefreshPromise;

    function element(tagName, className, textContent) {
        const node = document.createElement(tagName);
        if (className) node.className = className;
        if (textContent !== undefined) node.textContent = textContent;
        return node;
    }

    function isFiniteNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    function normalizeResult(result) {
        return {
            rankChange: isFiniteNumber(result.rankChange) ? result.rankChange : 0,
            score: isFiniteNumber(result.score) ? result.score : null,
            springMetric: result.springMetric ?? null,
            robustSpringMetric: result.robustSpringMetric ?? null,
            springTerm: result.springTerm ?? null,
            robustSpringTerm: result.robustSpringTerm ?? null,
            submittedAt: result.submittedAt ?? null,
            benchmarkMethod: typeof result.benchmarkMethod === "string" ? result.benchmarkMethod : null,
            benchmarkUrl: typeof result.benchmarkUrl === "string" ? result.benchmarkUrl : null,
            springComponents: result.springComponents ?? null,
            robustSpringComponents: result.robustSpringComponents ?? null
        };
    }

    function resultIdentity(result, index) {
        if (typeof result.benchmarkUrl === "string" && result.benchmarkUrl.trim()) {
            return `url:${result.benchmarkUrl.trim()}`;
        }
        const method = typeof result.benchmarkMethod === "string" ? result.benchmarkMethod : "";
        const submittedAt = typeof result.submittedAt === "string" ? result.submittedAt : "";
        return method || submittedAt ? `legacy:${method}\u0000${submittedAt}` : `entry:${index}`;
    }

    function resultsForTrack(team, trackKey) {
        const current = team.results?.[trackKey];
        if (trackKey === "cross-task") {
            return current && typeof current === "object" ? [normalizeResult(current)] : [];
        }

        const history = Array.isArray(team.submissionHistory?.[trackKey])
            ? team.submissionHistory[trackKey]
            : [];
        const pending = Array.isArray(team.pendingSubmissions?.[trackKey])
            ? team.pendingSubmissions[trackKey]
            : [];
        // Show public methods that still await complete benchmark metrics.
        // They cannot receive a score; a complete history/current result at
        // the same immutable URL replaces the pending copy below.
        const candidates = [
            ...pending.filter((result) => result && typeof result === "object")
                .map((result) => ({ ...result, score: null, rankChange: 0 })),
            ...history
        ];
        if (current && typeof current === "object") candidates.push(current);

        // The backend history is already unique by immutable benchmark URL.
        // Dedupe again at this untrusted display boundary and let `results`
        // replace its history copy so its current rank movement wins.
        const distinct = new Map();
        candidates.forEach((result, index) => {
            if (!result || typeof result !== "object") return;
            distinct.set(resultIdentity(result, index), normalizeResult(result));
        });

        // Preserve compatibility with the original flattened snapshot shape.
        if (distinct.size === 0 && isFiniteNumber(team.score)) {
            distinct.set("legacy:team", normalizeResult(team));
        }
        return [...distinct.values()];
    }

    function isRegisteredForTrack(team, trackKey) {
        const registeredTracks = Array.isArray(team.registeredTracks) ? team.registeredTracks : [];
        if (trackKey === "cross-task") {
            return quantitativeTrackKeys.every((key) => registeredTracks.includes(key));
        }
        return registeredTracks.includes(trackKey);
    }

    function rowsForTrack(snapshot, trackKey) {
        const rows = snapshot.teams
            .filter((team) => isRegisteredForTrack(team, trackKey))
            .flatMap((team) => {
                const results = resultsForTrack(team, trackKey);
                if (results.length === 0) {
                    return [{
                        teamId: team.teamId,
                        teamName: team.teamName,
                        ...normalizeResult({})
                    }];
                }
                return results.map((result) => ({
                    teamId: team.teamId,
                    teamName: team.teamName,
                    ...result
                }));
            });

        rows.sort((left, right) => {
            const leftScored = isFiniteNumber(left.score);
            const rightScored = isFiniteNumber(right.score);
            if (leftScored !== rightScored) return leftScored ? -1 : 1;
            if (!leftScored) {
                // Keep team order alphabetical, then use immutable result
                // URLs to order multiple pending methods from the same team.
                return compareTeamIdentity(left, right) || String(left.benchmarkUrl ?? "")
                    .localeCompare(String(right.benchmarkUrl ?? ""), undefined, { numeric: true });
            }
            return compareScoredRows(left, right);
        });

        let scoredRank = 0;
        return rows.map((row) => {
            const rank = isFiniteNumber(row.score) ? scoredRank + 1 : null;
            if (rank !== null) scoredRank = rank;
            return { ...row, rank };
        });
    }

    // Team ID is the stable final key when names compare equally.
    function compareTeamIdentity(left, right) {
        const nameDifference = left.teamName.localeCompare(
            right.teamName,
            undefined,
            { sensitivity: "base" }
        );
        return nameDifference || left.teamId.localeCompare(right.teamId, undefined, { numeric: true });
    }

    function numericDifference(left, right) {
        if (isFiniteNumber(left) && isFiniteNumber(right)) return left - right;
        if (isFiniteNumber(left)) return -1;
        if (isFiniteNumber(right)) return 1;
        return 0;
    }

    function compareScoredRows(left, right) {
        const scoreDifference = numericDifference(left.score, right.score);
        if (scoreDifference !== 0) return scoreDifference;

        const robustDifference = numericDifference(left.robustSpringTerm, right.robustSpringTerm);
        if (robustDifference !== 0) return robustDifference;

        const springDifference = numericDifference(left.springTerm, right.springTerm);
        if (springDifference !== 0) return springDifference;

        // Baselines never affect participant ranks. On an otherwise exact tie,
        // keep the participant first and then apply stable identity keys.
        if (Boolean(left.isBaseline) !== Boolean(right.isBaseline)) {
            return left.isBaseline ? 1 : -1;
        }
        const teamDifference = String(left.teamId).localeCompare(
            String(right.teamId),
            undefined,
            { numeric: true }
        );
        if (teamDifference !== 0) return teamDifference;
        return String(left.benchmarkUrl ?? "").localeCompare(
            String(right.benchmarkUrl ?? ""),
            undefined,
            { numeric: true }
        );
    }

    function roundMetric(value) {
        return Number(value.toFixed(6));
    }

    function mean(values) {
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    function isPositiveFiniteNumber(value) {
        return isFiniteNumber(value) && value > 0;
    }

    function baselineRowsForTrack(snapshot, trackKey) {
        const methods = baselineMethods[trackKey];
        const baseline = snapshot.baselines?.[trackKey];
        if (!methods || !baseline) return [];

        if (trackKey !== "scene-flow") {
            if (!isPositiveFiniteNumber(baseline.spring) ||
                !isPositiveFiniteNumber(baseline.robustSpringProxy)) return [];
            return methods.map((entry) => {
                const robustSpringMetric = entry.springMetric + entry.disagreement;
                const springTerm = entry.springMetric / baseline.spring;
                const robustSpringTerm = robustSpringMetric / baseline.robustSpringProxy;
                return {
                    isBaseline: true,
                    teamId: "Baseline",
                    teamName: "Spring Team",
                    rank: null,
                    rankChange: 0,
                    score: roundMetric(0.5 * springTerm + 0.5 * robustSpringTerm),
                    springMetric: roundMetric(entry.springMetric),
                    robustSpringMetric: roundMetric(robustSpringMetric),
                    springTerm: roundMetric(springTerm),
                    robustSpringTerm: roundMetric(robustSpringTerm),
                    submittedAt: entry.submittedAt,
                    benchmarkMethod: `(Baseline) ${entry.method}`,
                    benchmarkUrl: `https://spring-benchmark.org/${entry.resultId}/`,
                    springComponents: null,
                    robustSpringComponents: null
                };
            });
        }

        const springBaseline = {
            d1: baseline.spring?.disparity1Abs,
            d2: baseline.spring?.disparity2Abs,
            flow: baseline.spring?.flowEpe
        };
        const robustBaseline = {
            d1: baseline.robustSpringProxy?.disparity1Abs,
            d2: baseline.robustSpringProxy?.disparity2Abs,
            flow: baseline.robustSpringProxy?.flowEpe
        };
        if (![...Object.values(springBaseline), ...Object.values(robustBaseline)]
            .every(isPositiveFiniteNumber)) return [];

        return methods.map((entry) => {
            const robustSpringComponents = {
                d1: roundMetric(entry.springComponents.d1 + entry.disagreementComponents.d1),
                d2: roundMetric(entry.springComponents.d2 + entry.disagreementComponents.d2),
                flow: roundMetric(entry.springComponents.flow + entry.disagreementComponents.flow)
            };
            const springTerm = mean([
                entry.springComponents.d1 / springBaseline.d1,
                entry.springComponents.d2 / springBaseline.d2,
                entry.springComponents.flow / springBaseline.flow
            ]);
            const robustSpringTerm = mean([
                robustSpringComponents.d1 / robustBaseline.d1,
                robustSpringComponents.d2 / robustBaseline.d2,
                robustSpringComponents.flow / robustBaseline.flow
            ]);
            return {
                isBaseline: true,
                teamId: "Baseline",
                teamName: "Spring Team",
                rank: null,
                rankChange: 0,
                score: roundMetric(0.5 * springTerm + 0.5 * robustSpringTerm),
                springMetric: roundMetric(springTerm),
                robustSpringMetric: roundMetric(robustSpringTerm),
                springTerm: roundMetric(springTerm),
                robustSpringTerm: roundMetric(robustSpringTerm),
                submittedAt: entry.submittedAt,
                benchmarkMethod: `(Baseline) ${entry.method}`,
                benchmarkUrl: `https://spring-benchmark.org/${entry.resultId}/`,
                springComponents: entry.springComponents,
                robustSpringComponents
            };
        });
    }

    function displayRowsForTrack(snapshot, trackKey) {
        const participantRows = rowsForTrack(snapshot, trackKey);
        const pendingRows = participantRows.filter((row) => !isFiniteNumber(row.score));
        const scoredRows = participantRows.filter((row) => isFiniteNumber(row.score));
        scoredRows.push(...baselineRowsForTrack(snapshot, trackKey));
        scoredRows.sort(compareScoredRows);
        return [...scoredRows, ...pendingRows];
    }

    function formatNumber(value, digits) {
        if (isFiniteNumber(value)) {
            return value.toLocaleString(undefined, {
                minimumFractionDigits: digits,
                maximumFractionDigits: digits
            });
        }
        if (typeof value === "string" && value.trim()) return value;
        return "—";
    }

    function formatDateTime(value) {
        if (!value) return "—";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "—";
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short"
        }).format(date);
    }

    function safeBenchmarkUrl(value) {
        if (!value) return null;
        try {
            const url = new URL(value);
            return url.origin === "https://spring-benchmark.org" ? url.href : null;
        } catch {
            return null;
        }
    }

    function componentTitle(label, components) {
        if (!components || typeof components !== "object") return null;
        const { d1, d2, flow } = components;
        if (![d1, d2, flow].every(isFiniteNumber)) return null;
        return `${label}: d1 ${formatNumber(d1, 3)} · d2 ${formatNumber(d2, 3)} · flow ${formatNumber(flow, 3)}`;
    }

    function buildRankChange(change) {
        const node = element("span", "rank-change");
        if (change > 0) {
            node.classList.add("rank-change--up");
            node.setAttribute("aria-label", `Up ${change} ${change === 1 ? "position" : "positions"}`);
            node.textContent = `▲ ${change}`;
        } else if (change < 0) {
            const amount = Math.abs(change);
            node.classList.add("rank-change--down");
            node.setAttribute("aria-label", `Down ${amount} ${amount === 1 ? "position" : "positions"}`);
            node.textContent = `▼ ${amount}`;
        } else {
            node.classList.add("rank-change--same");
            node.setAttribute("aria-label", "No rank change");
            node.textContent = "— 0";
        }
        return node;
    }

    function buildTable(snapshot, track, panelId) {
        const wrapper = element("div", "leaderboard-table-wrap");
        const table = element("table", "leaderboard-table");
        const caption = element(
            "caption",
            "visually-hidden",
            `${track.label} standings. Lower RbS-Score is better. ` +
            (baselineMethods[track.key]
                ? "Rows labeled Baseline are unranked references and do not affect participant standings."
                : "Only participant team aggregates are ranked.")
        );
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        const body = document.createElement("tbody");

        ["Rank", "Change", "Team", "Method Name", "RbS-Score", track.springLabel, track.robustLabel, "Spring Submission Time"]
            .forEach((label) => {
                const cell = element("th", "", label);
                cell.scope = "col";
                headRow.append(cell);
            });

        displayRowsForTrack(snapshot, track.key).forEach((row) => {
            const tableRow = document.createElement("tr");
            tableRow.classList.add("leaderboard-row");
            const isPending = !isFiniteNumber(row.score);
            const isBaseline = row.isBaseline === true;
            if (isPending) tableRow.classList.add("leaderboard-row--pending");
            if (isBaseline) tableRow.classList.add("leaderboard-row--baseline");

            const rankCell = element("td", "leaderboard-rank-cell");
            const rank = element(
                "span",
                "leaderboard-rank",
                isFiniteNumber(row.rank) ? String(row.rank) : "—"
            );
            if (isBaseline) {
                rank.setAttribute("aria-hidden", "true");
                rankCell.append(element("span", "visually-hidden", "Not ranked"), rank);
            } else {
                if (!isPending && row.rank <= 3) rank.classList.add(`leaderboard-rank--${row.rank}`);
                rankCell.append(rank);
            }

            const changeCell = element("td", "leaderboard-change-cell");
            if (isBaseline) {
                const noChange = element("span", "rank-change rank-change--baseline", "—");
                noChange.setAttribute("aria-label", "Rank movement does not apply to baselines");
                changeCell.append(noChange);
            } else {
                changeCell.append(buildRankChange(row.rankChange));
            }

            const teamCell = element("th", "leaderboard-team-cell");
            teamCell.scope = "row";
            teamCell.append(element("strong", "leaderboard-team-name", row.teamName));
            const teamMeta = element("span", "leaderboard-team-meta");
            if (isBaseline) {
                teamMeta.append(
                    element("span", "leaderboard-baseline-badge", "Baseline"),
                    element("span", "leaderboard-team-id", "Unranked reference")
                );
            } else {
                teamMeta.append(element("span", "leaderboard-team-id", row.teamId));
            }
            if (isPending && !isBaseline) {
                teamMeta.append(element(
                    "span",
                    "leaderboard-pending-badge",
                    row.benchmarkMethod ? "Awaiting benchmark results" : "Awaiting result"
                ));
            }
            teamCell.append(teamMeta);

            const methodCell = element("td", "leaderboard-method-cell");
            if (row.benchmarkMethod) {
                // The backend supplies the canonical method label, including
                // stable labels for unnamed entries; never reparse it here.
                const resultUrl = safeBenchmarkUrl(row.benchmarkUrl);
                const method = element(resultUrl ? "a" : "span", "leaderboard-method", row.benchmarkMethod);
                // Long method names stay compact in the table but remain
                // available in full to pointer users and assistive technology.
                method.title = row.benchmarkMethod;
                if (resultUrl) {
                    method.href = resultUrl;
                    method.target = "_blank";
                    method.rel = "noopener noreferrer";
                    method.setAttribute("aria-label", `${row.benchmarkMethod} benchmark result (opens in a new tab)`);
                }
                methodCell.append(method);
            } else {
                const noMethod = element("span", "leaderboard-method-placeholder", "—");
                noMethod.setAttribute("aria-label", "No matched method");
                methodCell.append(noMethod);
            }

            const scoreCell = element("td", "leaderboard-score", formatNumber(row.score, 4));
            const springCell = element("td", "leaderboard-metric", formatNumber(row.springMetric, 3));
            const robustCell = element("td", "leaderboard-metric", formatNumber(row.robustSpringMetric, 3));
            const submittedCell = element("td", "leaderboard-submitted", formatDateTime(row.submittedAt));
            const springComponents = componentTitle("Spring components", row.springComponents);
            const robustComponents = componentTitle("RobustSpring proxy components", row.robustSpringComponents);
            if (springComponents) springCell.title = springComponents;
            if (robustComponents) robustCell.title = robustComponents;
            if (row.submittedAt) submittedCell.title = row.submittedAt;

            tableRow.append(
                rankCell,
                changeCell,
                teamCell,
                methodCell,
                scoreCell,
                springCell,
                robustCell,
                submittedCell
            );
            body.append(tableRow);
        });

        head.append(headRow);
        table.append(caption, head, body);
        table.setAttribute("aria-describedby", `${panelId}-note`);
        wrapper.tabIndex = 0;
        wrapper.setAttribute("role", "region");
        wrapper.setAttribute(
            "aria-label",
            `${track.label} standings table; scroll horizontally to see all columns.`
        );
        wrapper.append(table);
        return wrapper;
    }

    function renderFullLeaderboard(root, snapshot, rootIndex) {
        const shell = element("div", "leaderboard-shell");
        const tabs = element("div", "leaderboard-tabs");
        const panels = element("div", "leaderboard-panels");
        const prefix = `leaderboard-${rootIndex}`;
        tabs.setAttribute("role", "tablist");
        tabs.setAttribute("aria-label", "Choose a leaderboard");

        const selectTrack = (trackKey, moveFocus) => {
            selectedTrack = trackKey;
            tabs.querySelectorAll("[role=tab]").forEach((tab) => {
                const selected = tab.dataset.track === trackKey;
                tab.setAttribute("aria-selected", String(selected));
                tab.tabIndex = selected ? 0 : -1;
                if (selected && moveFocus) tab.focus();
            });
            panels.querySelectorAll("[role=tabpanel]").forEach((panel) => {
                panel.hidden = panel.dataset.track !== trackKey;
            });
        };

        tracks.forEach((track, trackIndex) => {
            const tabId = `${prefix}-${track.key}-tab`;
            const panelId = `${prefix}-${track.key}-panel`;
            const tab = element("button", "leaderboard-tab", track.label);
            tab.type = "button";
            tab.id = tabId;
            tab.dataset.track = track.key;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", panelId);
            tab.addEventListener("click", () => selectTrack(track.key, false));
            tab.addEventListener("keydown", (event) => {
                const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
                if (!keys.includes(event.key)) return;
                event.preventDefault();
                const currentIndex = tracks.findIndex((candidate) => candidate.key === track.key);
                let nextIndex = currentIndex;
                if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tracks.length) % tracks.length;
                if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tracks.length;
                if (event.key === "Home") nextIndex = 0;
                if (event.key === "End") nextIndex = tracks.length - 1;
                selectTrack(tracks[nextIndex].key, true);
            });

            const panel = element("section", "leaderboard-panel");
            panel.id = panelId;
            panel.dataset.track = track.key;
            panel.setAttribute("role", "tabpanel");
            panel.setAttribute("aria-labelledby", tabId);
            panel.tabIndex = 0;
            const note = element(
                "p",
                "leaderboard-panel-note",
                track.key === "cross-task"
                    ? "Cross-Task standings include teams registered for all three quantitative tracks."
                    : "Participant methods are ranked by RbS-Score; teams and methods awaiting complete benchmark results follow alphabetically by team. Rows labeled Baseline are score-sorted, unranked Spring-Team references with complete Spring and RobustSpring metrics; they do not affect participant standings."
            );
            note.id = `${panelId}-note`;
            const scrollHint = element(
                "p",
                "leaderboard-scroll-hint",
                "Scroll horizontally to see every column."
            );
            panel.append(note, scrollHint, buildTable(snapshot, track, panelId));
            tabs.append(tab);
            panels.append(panel);

            if (trackIndex === 0 && !tracks.some((candidate) => candidate.key === selectedTrack)) {
                selectedTrack = track.key;
            }
        });

        shell.append(tabs, panels);
        root.replaceChildren(shell);
        selectTrack(selectedTrack, false);
    }

    function renderPreview(root, snapshot) {
        const grid = element("div", "leaderboard-preview-grid");
        tracks.forEach((track) => {
            const allRows = rowsForTrack(snapshot, track.key);
            const rows = allRows.filter((row) => isFiniteNumber(row.score)).slice(0, 3);
            const card = element("article", "leaderboard-preview-card");
            const heading = element("h3", "", track.label);
            const list = element("ol", "leaderboard-preview-list");
            heading.id = `preview-${track.key}`;
            card.setAttribute("aria-labelledby", heading.id);

            rows.forEach((row) => {
                const item = document.createElement("li");
                item.append(element("span", "leaderboard-preview-rank", String(row.rank)));
                const identity = element("span", "leaderboard-preview-team");
                identity.append(
                    element("strong", "", row.teamName),
                    element("small", "", row.teamId)
                );
                if (row.benchmarkMethod) {
                    identity.append(element(
                        "small",
                        "leaderboard-preview-method",
                        row.benchmarkMethod
                    ));
                }
                item.append(identity);
                item.append(
                    isFiniteNumber(row.score)
                        ? element("span", "leaderboard-preview-score", formatNumber(row.score, 4))
                        : element("span", "leaderboard-preview-pending", "Pending")
                );
                list.append(item);
            });

            const link = element("a", "leaderboard-preview-link", "View full standings →");
            link.href = "evaluation.html#leaderboards";
            card.append(heading);
            if (rows.length) {
                card.append(list);
            } else {
                // Several pending methods still belong to one registered team.
                const teamCount = snapshot.teams.filter((team) => isRegisteredForTrack(team, track.key)).length;
                const noun = teamCount === 1 ? "team" : "teams";
                card.append(element(
                    "p",
                    "leaderboard-preview-empty",
                    `No complete benchmark results yet · ${teamCount} registered ${noun}`
                ));
            }
            card.append(link);
            grid.append(card);
        });
        root.replaceChildren(grid);
    }

    function validateSnapshot(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.teams)) {
            throw new Error("Leaderboard snapshot has an invalid shape.");
        }
        return snapshot;
    }

    async function loadPublishedSnapshot({ force = false } = {}) {
        const url = new URL(publishedSnapshotUrl);
        if (force) url.searchParams.set("updated", Date.now().toString());
        const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error(`Leaderboard snapshot request failed (${response.status}).`);
        return {
            snapshot: validateSnapshot(await response.json()),
            syncState: "fallback"
        };
    }

    function normalizeLoadResult(result) {
        const supportedStates = new Set(["synchronized", "cached", "stale", "fallback"]);
        if (result && typeof result === "object" && "snapshot" in result) {
            return {
                snapshot: validateSnapshot(result.snapshot),
                syncState: supportedStates.has(result.syncState) ? result.syncState : "unverified"
            };
        }
        return { snapshot: validateSnapshot(result), syncState: "unverified" };
    }

    function refreshStatus(syncState) {
        if (syncState === "synchronized") return "Live standings refreshed.";
        if (syncState === "cached") {
            return "Cached live standings loaded; no newer sync was needed.";
        }
        if (syncState === "stale") {
            return "Live refresh did not complete; stale cached standings remain visible.";
        }
        if (syncState === "fallback") {
            return "Live sync is unavailable; the published fallback standings remain visible.";
        }
        return "Standings loaded, but a completed live sync could not be confirmed.";
    }

    function visibleSourceLabel(snapshot, syncState) {
        const label = snapshot.sourceLabel || "Organizer-published leaderboard snapshot";
        if (syncState === "synchronized") return `${label} · synchronized`;
        if (syncState === "cached") return `${label} · live cache`;
        if (syncState === "stale") return `${label} · stale cache`;
        return label;
    }

    function renderSnapshot(snapshot, syncState = "unverified") {
        document.querySelectorAll("[data-leaderboard-root]").forEach((root, index) => {
            root.classList.remove("leaderboard-loading");
            if (root.dataset.mode === "preview") renderPreview(root, snapshot);
            else renderFullLeaderboard(root, snapshot, index);
        });

        document.querySelectorAll("[data-leaderboard-updated]").forEach((time) => {
            time.textContent = formatDateTime(snapshot.updatedAt);
            if (snapshot.updatedAt) time.dateTime = snapshot.updatedAt;
        });
        document.querySelectorAll("[data-leaderboard-source]").forEach((node) => {
            node.textContent = visibleSourceLabel(snapshot, syncState);
        });
    }

    function renderUnavailable() {
        document.querySelectorAll("[data-leaderboard-root]").forEach((root) => {
            root.classList.remove("leaderboard-loading");
            const notice = element(
                "p",
                "leaderboard-unavailable",
                "The published standings could not be loaded. Please refresh and try again."
            );
            notice.setAttribute("role", "alert");
            root.replaceChildren(notice);
        });
    }

    async function refresh({ force = false, announce = false } = {}) {
        const generation = ++refreshGeneration;
        const buttons = [...document.querySelectorAll("[data-leaderboard-refresh]")];
        const statusNodes = [...document.querySelectorAll("[data-leaderboard-refresh-status]")];
        buttons.forEach((button) => {
            button.disabled = true;
            button.classList.add("is-refreshing");
        });
        if (announce) statusNodes.forEach((node) => { node.textContent = "Checking live standings…"; });

        try {
            const loaded = normalizeLoadResult(await loadSnapshot({ force }));
            const { snapshot, syncState } = loaded;
            // A slower, older request must never overwrite a newer snapshot.
            if (generation !== refreshGeneration) return currentSnapshot ?? snapshot;
            currentSnapshot = snapshot;
            renderSnapshot(currentSnapshot, syncState);
            if (announce) statusNodes.forEach((node) => {
                node.textContent = refreshStatus(syncState);
            });
            return currentSnapshot;
        } catch (error) {
            if (generation === refreshGeneration && !currentSnapshot) renderUnavailable();
            if (generation === refreshGeneration && announce) statusNodes.forEach((node) => {
                node.textContent = "Refresh failed. The previously loaded standings remain visible.";
            });
            console.warn("Leaderboard refresh failed.", error);
            throw error;
        } finally {
            if (generation === refreshGeneration) {
                buttons.forEach((button) => {
                    button.disabled = false;
                    button.classList.remove("is-refreshing");
                });
            }
        }
    }

    document.querySelectorAll("[data-leaderboard-refresh]").forEach((button) => {
        button.addEventListener("click", () => {
            refresh({ force: true, announce: true }).catch(() => undefined);
        });
    });

    // A backend callable can replace the static loader without changing the rendering code.
    window.RoCoLeaderboard = Object.freeze({
        getSnapshot: () => currentSnapshot,
        refresh: (options) => refresh(options),
        setDataSource(loader) {
            if (typeof loader !== "function") throw new TypeError("Leaderboard data source must be a function.");
            // Render the bundled last-known-good snapshot first, then switch.
            // This ordering prevents the initial static request from racing and
            // overwriting a faster live response.
            return initialRefreshPromise.then(() => {
                loadSnapshot = loader;
                // The server's five-minute cache is appropriate for automatic
                // page loading. Only an explicit user refresh requests a sync.
                return refresh({ force: false, announce: false });
            });
        }
    });

    initialRefreshPromise = refresh().catch(() => undefined);
})();
