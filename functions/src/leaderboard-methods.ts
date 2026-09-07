// Benchmark titles are participant-written. Keep ownership, display names,
// and automatically assigned names separate so a title edit never changes
// the immutable benchmark submission that a leaderboard row represents.
export interface BenchmarkRosterIdentity {
  teamId: string;
  teamName: string;
}

export interface UnnamedMethodSource {
  submissionId: string;
  // null (or empty text) means that stripping the team identity left no name.
  methodName: string | null;
}

const MAX_UNNAMED_METHODS_PER_TEAM = 10_000;
const MAX_METHOD_NUMBER = 1_000_000_000;
const SUBMISSION_ID = /^[1-9]\d{0,8}$/u;
const TEAM_ID = /^RoCo-([1-9]\d*)$/iu;
const TEAM_SEPARATORS = "[\\s_\\p{Dash_Punctuation}\\u2212]*";

function normalizedIdentity(value: string): string {
  return value.normalize("NFKD").replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "");
}

function escapedRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function teamTokens(value: string): Array<{ text: string; number: number | null }> {
  // Read every explicit identifier before consulting the roster. This prevents
  // an unknown ID followed by another team's name from claiming that team.
  // A letter suffix marks a malformed identifier, not a partial numeric match.
  const pattern = new RegExp(
    `(?<![\\p{Letter}\\p{Number}])roco${TEAM_SEPARATORS}(\\d+)([\\p{Letter}\\p{Number}]*)`,
    "giu",
  );
  return [...value.normalize("NFKC").matchAll(pattern)].map((match) => {
    const number = Number(match[1]);
    return {
      text: match[0],
      number: !match[2] && Number.isSafeInteger(number) && number > 0 ? number : null,
    };
  });
}

export function matchBenchmarkTeam<T extends BenchmarkRosterIdentity>(
  sourceName: string,
  teams: readonly T[],
): { team: T; basis: "team-id" | "team-name" } | null {
  const tokens = teamTokens(sourceName);
  if (tokens.length > 0) {
    const numbers = new Set(tokens.map((token) => token.number));
    if (numbers.has(null) || numbers.size !== 1) return null;
    const number = tokens[0]!.number;
    const matches = teams.filter((team) => Number(TEAM_ID.exec(team.teamId)?.[1]) === number);
    return matches.length === 1 ? { team: matches[0]!, basis: "team-id" } : null;
  }

  // Preserve the existing normalized-name match for older submissions that
  // lack an organizer-issued ID. Ambiguous and very short names stay unmatched.
  const normalized = normalizedIdentity(sourceName);
  const matches = teams.filter((team) => {
    const name = normalizedIdentity(team.teamName);
    return name.length >= 4 && normalized.includes(name);
  });
  return matches.length === 1 ? { team: matches[0]!, basis: "team-name" } : null;
}

function trimIdentitySeparators(value: string): string {
  return value
    // Remove wrappers emptied by stripping a team identity, but keep brackets
    // that belong to a real method name such as WAFT(large) or Flow[v2].
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/gu, " ")
    .replace(/^[\s_\p{Dash_Punctuation}\u2212|:;,]+|[\s_\p{Dash_Punctuation}\u2212|:;,]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function extractBenchmarkMethodName(
  sourceName: string,
  team: BenchmarkRosterIdentity,
): string | null {
  let method = sourceName.normalize("NFKC");
  const number = Number(TEAM_ID.exec(team.teamId)?.[1]);
  const identifier = new RegExp(
    `(?<![\\p{Letter}\\p{Number}])roco${TEAM_SEPARATORS}(\\d+)(?![\\p{Letter}\\p{Number}])`,
    "giu",
  );
  method = method.replace(identifier, (text: string, digits: string) =>
    Number(digits) === number ? " " : text,
  );
  method = trimIdentitySeparators(method);

  // Strip an exact standalone registered name, never an internal substring:
  // a team called CAR must not turn CAR-WAFT into WAFT, and WAFT+ must keep +.
  const teamName = team.teamName.normalize("NFKC").trim();
  if (teamName) {
    const escapedName = escapedRegularExpression(teamName).replace(/\s+/gu, "\\s+");
    // Closing brackets can end a wrapper around the team name. An attached
    // opening bracket is a method suffix: WAFT(large) and Flow[v2] stay whole.
    const name = new RegExp(
      `(?<![^\\s|:;,()[\\]{}])${escapedName}(?=$|[\\s|:;,)\\]}])`,
      "giu",
    );
    method = trimIdentitySeparators(method.replace(name, " "));
  }
  return method || null;
}

export function reconstructUnnamedMethodAssignments(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_UNNAMED_METHODS_PER_TEAM) return null;
  const usedNumbers = new Set<number>();
  const assignments: Record<string, number> = {};
  for (const [submissionId, number] of entries) {
    if (!SUBMISSION_ID.test(submissionId) || typeof number !== "number" ||
        !Number.isSafeInteger(number) || number < 1 || number > MAX_METHOD_NUMBER ||
        usedNumbers.has(number)) return null;
    assignments[submissionId] = number;
    usedNumbers.add(number);
  }
  return assignments;
}

export function planUnnamedMethodAssignments(
  previous: Readonly<Record<string, number>>,
  sources: readonly UnnamedMethodSource[],
): Record<string, number> {
  const assignments = reconstructUnnamedMethodAssignments(previous);
  if (!assignments) throw new Error("Invalid persisted unnamed-method assignments.");
  let assignmentCount = Object.keys(assignments).length;
  let nextNumber = Math.max(0, ...Object.values(assignments)) + 1;
  const unnamedIds = new Set<string>();
  for (const source of sources) {
    if (!SUBMISSION_ID.test(source.submissionId)) {
      throw new Error("Invalid benchmark submission ID for unnamed-method assignment.");
    }
    if (!source.methodName?.trim()) unnamedIds.add(source.submissionId);
  }
  // Sorting by immutable numeric IDs makes the initial allocation independent
  // of benchmark rank, source table order, or which task is visited first.
  for (const submissionId of [...unnamedIds].sort((left, right) => Number(left) - Number(right))) {
    if (Object.hasOwn(assignments, submissionId)) continue;
    if (assignmentCount >= MAX_UNNAMED_METHODS_PER_TEAM || nextNumber > MAX_METHOD_NUMBER) {
      throw new Error("Unnamed-method assignment capacity exceeded.");
    }
    assignments[submissionId] = nextNumber++;
    assignmentCount += 1;
  }
  // Historic assignments survive removal, method renaming, and metric-history
  // pruning. Returning a copy also keeps failed refreshes from mutating state.
  return assignments;
}
