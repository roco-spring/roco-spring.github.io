import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface FirestoreIndex {
  collectionGroup?: unknown;
  queryScope?: unknown;
  fields?: Array<{ fieldPath?: unknown; order?: unknown }>;
}

describe("failed-resource revival indexes", () => {
  it.each([
    [
      "teams",
      [
        "sheetSyncStatus",
        "sheetSyncSafeErrorCategory",
        "sheetSyncLastAttemptAt",
      ],
    ],
    [
      "teams",
      [
        "registrationEmailStatus",
        "registrationEmailSafeErrorCategory",
        "registrationEmailLastAttemptAt",
      ],
    ],
    [
      "registrationRequests",
      ["cleanupState", "cleanupSafeErrorCategory", "cleanupLastAttemptAt"],
    ],
  ] as const)(
    "declares the exact %s status/category/age composite index",
    async (collectionGroup, fieldPaths) => {
      const contents = await readFile(
        new URL("../../firestore.indexes.json", import.meta.url),
        "utf8",
      );
      const parsed = JSON.parse(contents) as { indexes?: FirestoreIndex[] };
      const matching = (parsed.indexes ?? []).filter(
        (index) =>
          index.collectionGroup === collectionGroup &&
          index.queryScope === "COLLECTION" &&
          JSON.stringify(index.fields?.map((field) => field.fieldPath)) ===
            JSON.stringify(fieldPaths),
      );

      expect(matching).toHaveLength(1);
      expect(matching[0]?.fields).toEqual(
        fieldPaths.map((fieldPath) => ({
          fieldPath,
          order: "ASCENDING",
        })),
      );
    },
  );
});
