import type { sheets_v4 } from "googleapis";
import { TRACK_LABELS, TRACKS } from "./config.js";
import { AppError } from "./errors.js";
import {
  GOOGLE_API_REQUEST_OPTIONS,
  withBoundedGoogleRetry,
} from "./google-retry.js";
import type { TeamDocument } from "./models.js";

export type LiteralCell = string | number | boolean;
export type LiteralRows = LiteralCell[][];

export function teamDetailsLiteralRows(team: TeamDocument): LiteralRows {
  const rows: LiteralRows = [
    ["RoCo-Spring Team Registration"],
    [],
    ["REGISTRATION METADATA"],
    ["Field", "Value"],
    ["Team ID", team.teamId],
    ["Team Name", team.teamName],
    ["Primary Contact Email", team.primaryContactEmail],
    ["Registration Date", team.createdAt.toDate().toISOString()],
    ["Last Updated", team.updatedAt.toDate().toISOString()],
    ["Revision", team.revision],
    ["Status", team.status],
    [],
    ["COMPETITION TRACKS"],
    ["Track", "Registered"],
  ];
  for (const track of TRACKS) {
    rows.push([TRACK_LABELS[track], team.tracks.includes(track) ? "Yes" : "No"]);
  }
  rows.push(
    [],
    ["TEAM MEMBERS"],
    ["Member #", "Full Name", "Email Address", "Affiliation", "Primary Contact"],
  );
  team.members.forEach((member, index) => {
    rows.push([
      index + 1,
      member.fullName,
      member.email,
      member.affiliation,
      member.email === team.primaryContactEmail ? "Yes" : "No",
    ]);
  });
  return rows;
}

async function ensureSpreadsheetStructure(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<{ detailsSheetId: number; changeLogSheetId: number }> {
  const metadata = await withBoundedGoogleRetry((requestOptions) =>
    sheets.spreadsheets.get(
      {
        spreadsheetId,
        fields: "sheets(properties(sheetId,title))",
      },
      requestOptions,
    ),
  );
  const existingSheets = metadata.data.sheets ?? [];
  const details = existingSheets.find((sheet) => sheet.properties?.title === "Team Details");
  const changeLog = existingSheets.find((sheet) => sheet.properties?.title === "Change Log");
  const requests: sheets_v4.Schema$Request[] = [];
  if (!details) {
    const firstId = existingSheets[0]?.properties?.sheetId;
    if (firstId === undefined || firstId === null) {
      throw new AppError("internal", "The spreadsheet has no grid.", "external_permanent");
    }
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: firstId, title: "Team Details" },
        fields: "title",
      },
    });
  }
  if (!changeLog) {
    requests.push({ addSheet: { properties: { title: "Change Log" } } });
  }
  if (requests.length > 0) {
    try {
      // addSheet is non-idempotent; recover an ambiguous response by reading
      // structure below instead of blindly replaying the batch.
      await sheets.spreadsheets.batchUpdate(
        {
          spreadsheetId,
          requestBody: { requests },
        },
        GOOGLE_API_REQUEST_OPTIONS,
      );
    } catch (error: unknown) {
      const recovery = await withBoundedGoogleRetry((requestOptions) =>
        sheets.spreadsheets.get(
          {
            spreadsheetId,
            fields: "sheets(properties(sheetId,title))",
          },
          requestOptions,
        ),
      );
      const titles = new Set(
        (recovery.data.sheets ?? []).map((sheet) => sheet.properties?.title),
      );
      if (!titles.has("Team Details") || !titles.has("Change Log")) throw error;
    }
  }
  const refreshed = await withBoundedGoogleRetry((requestOptions) =>
    sheets.spreadsheets.get(
      {
        spreadsheetId,
        fields: "sheets(properties(sheetId,title))",
      },
      requestOptions,
    ),
  );
  const detailsSheetId = refreshed.data.sheets?.find(
    (sheet) => sheet.properties?.title === "Team Details",
  )?.properties?.sheetId;
  const changeLogSheetId = refreshed.data.sheets?.find(
    (sheet) => sheet.properties?.title === "Change Log",
  )?.properties?.sheetId;
  if (
    detailsSheetId === undefined ||
    detailsSheetId === null ||
    changeLogSheetId === undefined ||
    changeLogSheetId === null
  ) {
    throw new AppError("internal", "Spreadsheet tabs could not be prepared.", "external_permanent");
  }
  return { detailsSheetId, changeLogSheetId };
}

function formattingRequests(
  detailsSheetId: number,
  changeLogSheetId: number,
): sheets_v4.Schema$Request[] {
  const headerFormat: sheets_v4.Schema$CellFormat = {
    backgroundColor: { red: 0.09, green: 0.2, blue: 0.33 },
    textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true },
    verticalAlignment: "MIDDLE",
    wrapStrategy: "WRAP",
  };
  const sectionFormat: sheets_v4.Schema$CellFormat = {
    backgroundColor: { red: 0.85, green: 0.91, blue: 0.96 },
    textFormat: { bold: true },
  };
  const requests: sheets_v4.Schema$Request[] = [
    {
      updateSheetProperties: {
        properties: { sheetId: detailsSheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId: changeLogSheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    {
      repeatCell: {
        range: { sheetId: detailsSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 },
        cell: { userEnteredFormat: headerFormat },
        fields: "userEnteredFormat",
      },
    },
    {
      repeatCell: {
        range: { sheetId: changeLogSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 },
        cell: { userEnteredFormat: headerFormat },
        fields: "userEnteredFormat",
      },
    },
  ];
  for (const rowIndex of [2, 12, 19]) {
    requests.push({
      repeatCell: {
        range: { sheetId: detailsSheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 5 },
        cell: { userEnteredFormat: sectionFormat },
        fields: "userEnteredFormat",
      },
    });
  }
  for (const rowIndex of [3, 13, 20]) {
    requests.push({
      repeatCell: {
        range: {
          sheetId: detailsSheetId,
          startRowIndex: rowIndex,
          endRowIndex: rowIndex + 1,
          startColumnIndex: 0,
          endColumnIndex: 5,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.94, green: 0.96, blue: 0.98 },
            textFormat: { bold: true },
            wrapStrategy: "WRAP",
          },
        },
        fields: "userEnteredFormat",
      },
    });
  }
  const widths = [110, 220, 240, 260, 140];
  widths.forEach((pixelSize, index) => {
    for (const sheetId of [detailsSheetId, changeLogSheetId]) {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
          properties: { pixelSize },
          fields: "pixelSize",
        },
      });
    }
  });
  requests.push({
    repeatCell: {
      range: { sheetId: detailsSheetId, startColumnIndex: 0, endColumnIndex: 5 },
      cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
      fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment",
    },
  });
  return requests;
}

async function appendChangeLogOnce(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  team: TeamDocument,
  changeType: "Registration" | "Team update" | "Reconciliation",
  changedBy: string,
): Promise<void> {
  const revisionResponse = await withBoundedGoogleRetry((requestOptions) =>
    sheets.spreadsheets.values.get(
      {
        spreadsheetId,
        range: "'Change Log'!B2:B",
        valueRenderOption: "UNFORMATTED_VALUE",
      },
      requestOptions,
    ),
  );
  const alreadyLogged = (revisionResponse.data.values ?? []).some(
    (row) => Number(row[0]) === team.revision,
  );
  if (alreadyLogged) return;
  const summary =
    changeType === "Registration"
      ? "Initial team registration"
      : changeType === "Reconciliation"
        ? "Synchronized authoritative Firestore revision"
        : "Team details updated";
  // Append is non-idempotent. An ambiguous response is reconciled by reading
  // the revision on the next sync instead of blindly appending a duplicate.
  await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "'Change Log'!A:E",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[team.updatedAt.toDate().toISOString(), team.revision, changeType, changedBy, summary]],
      },
    }, GOOGLE_API_REQUEST_OPTIONS);
}

export async function synchronizeTeamSpreadsheet(
  sheets: sheets_v4.Sheets,
  team: TeamDocument,
  changeType: "Registration" | "Team update" | "Reconciliation",
  changedBy = team.primaryContactEmail,
): Promise<void> {
  const spreadsheetId = team.sheetId;
  if (typeof spreadsheetId !== "string" || spreadsheetId.length === 0) {
    throw new AppError(
      "failed-precondition",
      "The team spreadsheet has not been provisioned yet.",
      "internal",
    );
  }
  const { detailsSheetId, changeLogSheetId } = await ensureSpreadsheetStructure(
    sheets,
    spreadsheetId,
  );
  await withBoundedGoogleRetry((requestOptions) =>
    sheets.spreadsheets.values.clear(
      {
        spreadsheetId,
        range: "'Team Details'!A:E",
      },
      requestOptions,
    ),
  );
  await withBoundedGoogleRetry((requestOptions) =>
    sheets.spreadsheets.values.update(
      {
        spreadsheetId,
        range: "'Team Details'!A1",
        valueInputOption: "RAW",
        requestBody: { values: teamDetailsLiteralRows(team) },
      },
      requestOptions,
    ),
  );
  await withBoundedGoogleRetry((requestOptions) =>
    sheets.spreadsheets.values.update(
      {
        spreadsheetId,
        range: "'Change Log'!A1:E1",
        valueInputOption: "RAW",
        requestBody: {
          values: [["Timestamp", "Revision", "Change Type", "Changed By", "Summary"]],
        },
      },
      requestOptions,
    ),
  );
  await appendChangeLogOnce(
    sheets,
    spreadsheetId,
    team,
    changeType,
    changedBy,
  );
  await withBoundedGoogleRetry((requestOptions) =>
    sheets.spreadsheets.batchUpdate(
      {
        spreadsheetId,
        requestBody: { requests: formattingRequests(detailsSheetId, changeLogSheetId) },
      },
      requestOptions,
    ),
  );
}
