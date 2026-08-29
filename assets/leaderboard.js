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
            robustLabel: "RobustSpring EPE"
        },
        {
            key: "stereo-matching",
            label: "Stereo Matching",
            springLabel: "Spring Abs",
            robustLabel: "RobustSpring Abs"
        },
        {
            key: "scene-flow",
            label: "Scene Flow",
            springLabel: "Spring Metric",
            robustLabel: "RobustSpring Metric"
        },
        {
            key: "cross-task",
            label: "Cross-Task",
            springLabel: "Spring Aggregate",
            robustLabel: "RobustSpring Aggregate"
        }
    ];

    let currentSnapshot = null;
    let selectedTrack = tracks[0].key;
    let loadSnapshot = loadPublishedSnapshot;

    function element(tagName, className, textContent) {
        const node = document.createElement(tagName);
        if (className) node.className = className;
        if (textContent !== undefined) node.textContent = textContent;
        return node;
    }

    function isFiniteNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    function resultForTrack(team, trackKey) {
        const taskResult = team.results?.[trackKey];
        const result = taskResult && typeof taskResult === "object" ? taskResult : team;

        return {
            rankChange: isFiniteNumber(result.rankChange) ? result.rankChange : 0,
            score: isFiniteNumber(result.score) ? result.score : null,
            springMetric: result.springMetric ?? null,
            robustSpringMetric: result.robustSpringMetric ?? null,
            submittedAt: result.submittedAt ?? null
        };
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
            .map((team) => ({
                teamId: team.teamId,
                teamName: team.teamName,
                ...resultForTrack(team, trackKey)
            }));

        rows.sort((left, right) => {
            const leftScored = isFiniteNumber(left.score);
            const rightScored = isFiniteNumber(right.score);
            if (leftScored !== rightScored) return leftScored ? -1 : 1;
            if (!leftScored) return compareTeamIdentity(left, right);

            const scoreDifference = left.score - right.score;
            if (scoreDifference !== 0) return scoreDifference;

            const robustDifference = numericDifference(left.robustSpringMetric, right.robustSpringMetric);
            if (robustDifference !== 0) return robustDifference;

            const springDifference = numericDifference(left.springMetric, right.springMetric);
            if (springDifference !== 0) return springDifference;
            return compareTeamIdentity(left, right);
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
            `${track.label} standings. Lower RbS-Score is better.`
        );
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        const body = document.createElement("tbody");

        ["Rank", "Change", "Team", "RbS-Score", track.springLabel, track.robustLabel, "Submission Time"]
            .forEach((label) => {
                const cell = element("th", "", label);
                cell.scope = "col";
                headRow.append(cell);
            });

        rowsForTrack(snapshot, track.key).forEach((row) => {
            const tableRow = document.createElement("tr");
            const isPending = !isFiniteNumber(row.score);
            if (isPending) tableRow.classList.add("leaderboard-row--pending");

            const rankCell = element("td", "leaderboard-rank-cell");
            const rank = element(
                "span",
                "leaderboard-rank",
                isFiniteNumber(row.rank) ? String(row.rank) : "—"
            );
            if (!isPending && row.rank <= 3) rank.classList.add(`leaderboard-rank--${row.rank}`);
            rankCell.append(rank);

            const changeCell = element("td", "leaderboard-change-cell");
            changeCell.append(buildRankChange(row.rankChange));

            const teamCell = element("th", "leaderboard-team-cell");
            teamCell.scope = "row";
            teamCell.append(element("strong", "leaderboard-team-name", row.teamName));
            const teamMeta = element("span", "leaderboard-team-meta");
            teamMeta.append(element("span", "leaderboard-team-id", row.teamId));
            if (isPending) teamMeta.append(element("span", "leaderboard-pending-badge", "Awaiting result"));
            teamCell.append(teamMeta);

            const scoreCell = element("td", "leaderboard-score", formatNumber(row.score, 4));
            const springCell = element("td", "leaderboard-metric", formatNumber(row.springMetric, 3));
            const robustCell = element("td", "leaderboard-metric", formatNumber(row.robustSpringMetric, 3));
            const submittedCell = element("td", "leaderboard-submitted", formatDateTime(row.submittedAt));
            if (row.submittedAt) submittedCell.title = row.submittedAt;

            tableRow.append(
                rankCell,
                changeCell,
                teamCell,
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
                    : "Scored teams are ordered by RbS-Score; teams awaiting a verified result follow alphabetically."
            );
            note.id = `${panelId}-note`;
            const scrollHint = element(
                "p",
                "leaderboard-scroll-hint",
                "Swipe or scroll horizontally to see every column."
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
                const noun = allRows.length === 1 ? "team" : "teams";
                card.append(element(
                    "p",
                    "leaderboard-preview-empty",
                    `No verified results yet · ${allRows.length} registered ${noun}`
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

    async function loadPublishedSnapshot({ cacheBust = false } = {}) {
        const url = new URL(publishedSnapshotUrl);
        if (cacheBust) url.searchParams.set("updated", Date.now().toString());
        const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error(`Leaderboard snapshot request failed (${response.status}).`);
        return validateSnapshot(await response.json());
    }

    function renderSnapshot(snapshot) {
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
            node.textContent = snapshot.sourceLabel || "Organizer-published roster snapshot";
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

    async function refresh({ cacheBust = false, announce = false } = {}) {
        const buttons = [...document.querySelectorAll("[data-leaderboard-refresh]")];
        const statusNodes = [...document.querySelectorAll("[data-leaderboard-refresh-status]")];
        buttons.forEach((button) => {
            button.disabled = true;
            button.classList.add("is-refreshing");
        });
        if (announce) statusNodes.forEach((node) => { node.textContent = "Refreshing published standings…"; });

        try {
            currentSnapshot = validateSnapshot(await loadSnapshot({ cacheBust }));
            renderSnapshot(currentSnapshot);
            if (announce) statusNodes.forEach((node) => { node.textContent = "Published roster view refreshed."; });
            return currentSnapshot;
        } catch (error) {
            if (!currentSnapshot) renderUnavailable();
            if (announce) statusNodes.forEach((node) => {
                node.textContent = "Refresh failed. The previously loaded standings remain visible.";
            });
            console.warn("Leaderboard refresh failed.", error);
            throw error;
        } finally {
            buttons.forEach((button) => {
                button.disabled = false;
                button.classList.remove("is-refreshing");
            });
        }
    }

    document.querySelectorAll("[data-leaderboard-refresh]").forEach((button) => {
        button.addEventListener("click", () => {
            refresh({ cacheBust: true, announce: true }).catch(() => undefined);
        });
    });

    // A backend callable can replace the static loader without changing the rendering code.
    window.RoCoLeaderboard = Object.freeze({
        getSnapshot: () => currentSnapshot,
        refresh: (options) => refresh(options),
        setDataSource(loader) {
            if (typeof loader !== "function") throw new TypeError("Leaderboard data source must be a function.");
            loadSnapshot = loader;
            return refresh({ cacheBust: true, announce: false });
        }
    });

    refresh().catch(() => undefined);
})();
