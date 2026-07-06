const timelineTable = document.querySelector(".timeline-table");

if (timelineTable) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const rows = [...timelineTable.querySelectorAll("tbody tr[data-deadline]")];

    for (const row of rows) {
        const deadline = new Date(`${row.dataset.deadline}T00:00:00`);

        if (deadline < today) {
            continue;
        }

        row.classList.add("timeline-row--next");

        const dateCell = row.querySelector("td:first-child");
        const dateText = dateCell.textContent.trim();
        dateCell.textContent = "";

        const dateLabel = document.createElement("span");
        dateLabel.className = "timeline-date-label";
        dateLabel.textContent = dateText;

        const badge = document.createElement("span");
        badge.className = "timeline-next-badge";
        badge.textContent = deadline.getTime() === today.getTime() ? "Today" : "Next up";

        dateCell.append(dateLabel, badge);

        break;
    }
}
