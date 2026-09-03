import { randomUUID } from "node:crypto";
import {
  FieldValue,
  type Firestore,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { AppError, safeErrorCategory } from "./errors.js";
import type { TrackId } from "./config.js";

export const QUANTITATIVE_TRACKS = [
  "optical-flow",
  "stereo-matching",
  "scene-flow",
] as const;

export type QuantitativeTrack = (typeof QUANTITATIVE_TRACKS)[number];
type LeaderboardTrack = QuantitativeTrack | "cross-task";

const SPRING_ORIGIN = "https://spring-benchmark.org";
const BENCHMARK_PAGES = {
  opticalFlowAccuracy: `${SPRING_ORIGIN}/opticalflow?display=accuracy`,
  opticalFlowRobustness: `${SPRING_ORIGIN}/opticalflow?display=robustness`,
  stereoAccuracy: `${SPRING_ORIGIN}/stereo?display=accuracy`,
  stereoRobustness: `${SPRING_ORIGIN}/stereo?display=robustness`,
  sceneFlowAccuracy: `${SPRING_ORIGIN}/sceneflow?display=accuracy`,
  sceneFlowRobustness: `${SPRING_ORIGIN}/sceneflow?display=robustness`,
} as const;

// Scores are extracted positionally from the public tables. These stable sort
// keys bind every position to its intended metric so an upstream column insert
// or reorder fails closed instead of silently changing a leaderboard score.
const BENCHMARK_METRIC_SORT_KEYS = {
  opticalFlowAccuracy: [
    "err_1px_Fl_total", "err_1px_Fl_lowdetail", "err_1px_Fl_highdetail",
    "err_1px_Fl_matched", "err_1px_Fl_unmatched", "err_1px_Fl_rigid",
    "err_1px_Fl_nonrigid", "err_1px_Fl_notsky", "err_1px_Fl_sky",
    "err_1px_Fl_s0_10", "err_1px_Fl_s10_40", "err_1px_Fl_s40",
    "err_EPE_Fl_total", "err_Fl_total", "err_WAUC_Fl_total",
  ],
  opticalFlowRobustness: [
    "robust_EPE_Fl_total", "robust_Fl_total", "robust_1px_Fl_total",
  ],
  stereoAccuracy: [
    "", "err_1px_D1_lowdetail", "err_1px_D1_highdetail", "err_1px_D1_matched",
    "err_1px_D1_unmatched", "err_1px_D1_notsky", "err_1px_D1_sky",
    "err_1px_D1_s0_10", "err_1px_D1_s10_40", "err_1px_D1_s40",
    "err_Abs_D1_total", "err_D1_total",
  ],
  stereoRobustness: [
    "robust_1px_D1_total", "robust_Abs_D1_total", "robust_D1_total",
  ],
  sceneFlowAccuracy: [
    "", "err_1px_SF_lowdetail", "err_1px_SF_highdetail", "err_1px_SF_matched",
    "err_1px_SF_unmatched", "err_1px_SF_rigid", "err_1px_SF_nonrigid",
    "err_1px_SF_notsky", "err_1px_SF_sky", "err_1px_SF_s0_10",
    "err_1px_SF_s10_40", "err_1px_SF_s40", "err_SF_total",
    "err_1px_D1_total", "err_1px_D2_total", "err_1px_Fl_total",
  ],
  sceneFlowRobustness: [
    "robust_disp1_1px_total", "robust_disp1_Abs_total", "robust_disp1_D1_total",
    "robust_disp2_1px_total", "robust_disp2_Abs_total", "robust_disp2_D2_total",
    "robust_flow_EPE_total", "robust_flow_Fl_total", "robust_flow_1px_total",
  ],
} as const satisfies Record<keyof typeof BENCHMARK_PAGES, readonly string[]>;

// Fixed organizer-approved medians over the methods benchmarked in both the
// Spring and RobustSpring papers. Robust baselines use the explicitly approved
// additive proxy: clean ground-truth error + clean-to-corrupted disagreement.
export const LEADERBOARD_BASELINES = Object.freeze({
  "optical-flow": Object.freeze({ spring: 0.9925, robustProxy: 6.03 }),
  "stereo-matching": Object.freeze({ spring: 3.4545, robustProxy: 18.4505 }),
  "scene-flow": Object.freeze({
    spring: Object.freeze({ d1: 7.466, d2: 7.5935, flow: 2.527 }),
    robustProxy: Object.freeze({ d1: 24.471, d2: 7.8085, flow: 6.737 }),
  }),
});

export const LEADERBOARD_BASELINE_METADATA = Object.freeze({
  "optical-flow": Object.freeze({
    spring: 0.9925,
    medianDisagreement: 4.16,
    robustSpringProxy: 6.03,
    methodCount: 8,
  }),
  "stereo-matching": Object.freeze({
    spring: 3.4545,
    medianDisagreement: 16.18,
    robustSpringProxy: 18.4505,
    methodCount: 4,
  }),
  "scene-flow": Object.freeze({
    methodCount: 2,
    spring: Object.freeze({ disparity1Abs: 7.466, disparity2Abs: 7.5935, flowEpe: 2.527 }),
    medianDisagreement: Object.freeze({
      disparity1Abs: 17.005,
      disparity2Abs: 0.215,
      flowEpe: 4.21,
    }),
    robustSpringProxy: Object.freeze({
      disparity1Abs: 24.471,
      disparity2Abs: 7.8085,
      flowEpe: 6.737,
    }),
  }),
});

const CACHE_TTL_MS = 5 * 60 * 1_000;
const FORCED_REFRESH_FLOOR_MS = 60 * 1_000;
const REFRESH_FAILURE_COOLDOWN_MS = 60 * 1_000;
// Longer than the callable's 60-second deadline, so a legitimate first worker
// cannot lose its global lease and overlap a second upstream scrape.
const REFRESH_LEASE_MS = 90 * 1_000;
// Six listing requests run in parallel. Detail requests run in at most eight
// five-second waves, leaving ample time for Firestore work inside the callable's
// 60-second envelope even when the benchmark is slow.
const FETCH_TIMEOUT_MS = 5_000;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_DETAIL_BYTES = 512 * 1024;
// The current roster has 69 possible quantitative groups. A 192-detail budget
// supports up to 64 all-three-track teams while retaining recent history now.
const MAX_DETAIL_REQUESTS = 192;
const DETAIL_FETCH_CONCURRENCY = 24;
// Retain ten immutable method results per team and track so progress remains
// useful without allowing the shared Firestore cache document to grow forever.
const MAX_HISTORY_PER_TRACK = 10;
const CACHE_COLLECTION = "publicLeaderboard";
const CACHE_DOCUMENT = "current-v1";
const LIVE_SOURCE_LABEL = "Live Spring and RobustSpring public benchmark snapshot";
// Public challenge submissions opened at midnight on 25 June in Berlin
// (CEST, UTC+02:00). Older benchmark methods cannot belong to RoCo-Spring.
const CHALLENGE_LAUNCH_UTC_MS = Date.parse("2026-06-24T22:00:00.000Z");

export interface LeaderboardRosterTeam {
  teamId: string;
  teamName: string;
  registeredTracks: TrackId[];
}

interface ComponentMetrics {
  d1: number;
  d2: number;
  flow: number;
}

export interface PublicLeaderboardResult {
  rankChange: number;
  score: number;
  springMetric: number;
  robustSpringMetric: number;
  springTerm: number;
  robustSpringTerm: number;
  submittedAt: string | null;
  benchmarkMethod: string;
  benchmarkUrl: string;
  matchBasis: "team-id" | "team-name" | "cross-task";
  springComponents?: ComponentMetrics;
  robustSpringComponents?: ComponentMetrics;
}

export interface PublicLeaderboardTeam extends LeaderboardRosterTeam {
  results: Partial<Record<LeaderboardTrack, PublicLeaderboardResult>>;
  submissionHistory: Partial<Record<QuantitativeTrack, PublicLeaderboardResult[]>>;
}

export interface PublicLeaderboardSnapshot {
  schemaVersion: 2;
  updatedAt: string;
  sourceLabel: string;
  scoringConvention: "organizer-approved-additive-proxy";
  baselines: typeof LEADERBOARD_BASELINE_METADATA;
  syncStatus: "fresh" | "cache-hit" | "stale-cache";
  teams: PublicLeaderboardTeam[];
}

interface BenchmarkRow {
  submissionId: string;
  methodName: string;
  metrics: Array<number | null>;
  taskProjection: boolean;
}

interface BenchmarkPageSet {
  opticalFlowAccuracy: string;
  opticalFlowRobustness: string;
  stereoAccuracy: string;
  stereoRobustness: string;
  sceneFlowAccuracy: string;
  sceneFlowRobustness: string;
}

interface MatchedPair {
  team: LeaderboardRosterTeam;
  matchBasis: "team-id" | "team-name";
  submissionId: string;
  methodName: string;
  accuracy: BenchmarkRow;
  robustness: BenchmarkRow;
}

interface ScoredCandidate {
  team: LeaderboardRosterTeam;
  track: QuantitativeTrack;
  result: PublicLeaderboardResult;
}

type DetailLoader = (submissionId: string) => Promise<string>;

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
    )
    .replace(/&#(\d+);/gu, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&ndash;/giu, "–")
    .replace(/&mdash;/giu, "—")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function textFromHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function finiteMetric(value: string): number | null {
  const normalized = value.replace(/,/gu, "").trim();
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseBenchmarkRows(html: string): BenchmarkRow[] {
  const rows: BenchmarkRow[] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/giu;
  for (const rowMatch of html.matchAll(rowPattern)) {
    const rowHtml = rowMatch[1] ?? "";
    const submission = rowHtml.match(
      /<a\b[^>]*href=["']\/(\d{1,9})\/["'][^>]*>([\s\S]*?)<\/a>/iu,
    );
    if (!submission) continue;
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)];
    if (cells.length < 3) continue;
    const nameCell = cells[1]?.[1] ?? "";
    const methodName = textFromHtml(submission[2] ?? "");
    if (!methodName) continue;
    rows.push({
      submissionId: submission[1] ?? "",
      methodName,
      metrics: cells.slice(2).map((cell) => finiteMetric(textFromHtml(cell[1] ?? ""))),
      taskProjection: /\[\s*SF\s*\]/iu.test(textFromHtml(nameCell)),
    });
  }
  return rows;
}

function parseBenchmarkHeaderSortKeys(html: string): string[] | null {
  const headerRow = /<table\b[^>]*>[\s\S]*?<tr\b[^>]*>([\s\S]*?)<\/tr>/iu.exec(html);
  if (!headerRow) return null;
  const headers = [...(headerRow[1] ?? "").matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/giu)];
  if (headers.length < 3) return null;
  const keys: string[] = [];
  for (const header of headers.slice(2)) {
    const href = /<a\b[^>]*href=["']([^"']+)["']/iu.exec(header[1] ?? "");
    if (!href) return null;
    try {
      keys.push(new URL(decodeHtml(href[1] ?? ""), SPRING_ORIGIN).searchParams.get("s") ?? "");
    } catch {
      return null;
    }
  }
  return keys;
}

export function benchmarkPageHasExpectedSchema(
  key: keyof BenchmarkPageSet,
  html: string,
): boolean {
  const expected = BENCHMARK_METRIC_SORT_KEYS[key];
  const actual = parseBenchmarkHeaderSortKeys(html);
  if (!actual || actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])) return false;
  const rows = parseBenchmarkRows(html);
  return rows.length > 0 && rows.every((row) => row.metrics.length === expected.length);
}

export function normalizeLeaderboardIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "");
}

function escapedRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function methodContainsTeamId(methodName: string, teamId: string): boolean {
  const match = /^RoCo-(\d+)$/iu.exec(teamId.trim());
  if (!match) return false;
  const number = escapedRegularExpression(match[1] ?? "");
  return new RegExp(`(?:^|[^a-z0-9])roco[\\s_-]*${number}(?![a-z0-9])`, "iu").test(
    methodName,
  );
}

function explicitBenchmarkTeam(
  methodName: string,
  teams: readonly LeaderboardRosterTeam[],
): LeaderboardRosterTeam | null | "ambiguous" {
  const matches = teams.filter((team) => methodContainsTeamId(methodName, team.teamId));
  if (matches.length > 1) return "ambiguous";
  return matches[0] ?? null;
}

export function matchBenchmarkTeam(
  methodName: string,
  teams: readonly LeaderboardRosterTeam[],
): { team: LeaderboardRosterTeam; basis: "team-id" | "team-name" } | null {
  const idMatch = explicitBenchmarkTeam(methodName, teams);
  if (idMatch === "ambiguous") return null;
  if (idMatch) return { team: idMatch, basis: "team-id" };

  const normalizedMethod = normalizeLeaderboardIdentity(methodName);
  const nameMatches = teams.filter((team) => {
    const normalizedName = normalizeLeaderboardIdentity(team.teamName);
    // Very short normalized names produce unsafe substring matches.
    return normalizedName.length >= 4 && normalizedMethod.includes(normalizedName);
  });
  return nameMatches.length === 1
    ? { team: nameMatches[0]!, basis: "team-name" }
    : null;
}

function pairedRows(
  accuracyHtml: string,
  robustnessHtml: string,
  teams: readonly LeaderboardRosterTeam[],
  track: QuantitativeTrack,
  excludeTaskProjections: boolean,
): MatchedPair[] {
  const accuracyById = new Map(
    parseBenchmarkRows(accuracyHtml).map((row) => [row.submissionId, row]),
  );
  const pairs: MatchedPair[] = [];
  for (const robustness of parseBenchmarkRows(robustnessHtml)) {
    const accuracy = accuracyById.get(robustness.submissionId);
    if (!accuracy) continue;
    if (excludeTaskProjections && (accuracy.taskProjection || robustness.taskProjection)) continue;
    // Resolve an explicit RoCo identifier against the complete roster first.
    // If that team did not register this track, reject the row; never let its
    // remaining text fall through and name-match a different registered team.
    const explicitTeam = explicitBenchmarkTeam(accuracy.methodName, teams);
    if (explicitTeam === "ambiguous") continue;
    if (explicitTeam && !explicitTeam.registeredTracks.includes(track)) continue;
    const matchingTeams = teams.filter((team) => team.registeredTracks.includes(track));
    const match = explicitTeam
      ? { team: explicitTeam, basis: "team-id" as const }
      : matchBenchmarkTeam(accuracy.methodName, matchingTeams);
    if (!match) continue;
    pairs.push({
      team: match.team,
      matchBasis: match.basis,
      submissionId: accuracy.submissionId,
      methodName: accuracy.methodName,
      accuracy,
      robustness,
    });
  }
  return pairs;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function valueAt(row: BenchmarkRow, index: number): number | null {
  return row.metrics[index] ?? null;
}

function scalarCandidate(
  pair: MatchedPair,
  track: "optical-flow" | "stereo-matching",
): ScoredCandidate | null {
  const cleanIndex = track === "optical-flow" ? 12 : 10;
  const deltaIndex = track === "optical-flow" ? 0 : 1;
  const clean = valueAt(pair.accuracy, cleanIndex);
  const delta = valueAt(pair.robustness, deltaIndex);
  if (clean === null || delta === null) return null;
  const robustProxy = clean + delta;
  const baseline = LEADERBOARD_BASELINES[track];
  const springTerm = clean / baseline.spring;
  const robustSpringTerm = robustProxy / baseline.robustProxy;
  return {
    team: pair.team,
    track,
    result: {
      rankChange: 0,
      score: roundMetric(0.5 * springTerm + 0.5 * robustSpringTerm),
      springMetric: roundMetric(clean),
      robustSpringMetric: roundMetric(robustProxy),
      springTerm: roundMetric(springTerm),
      robustSpringTerm: roundMetric(robustSpringTerm),
      submittedAt: null,
      benchmarkMethod: pair.methodName,
      benchmarkUrl: `${SPRING_ORIGIN}/${pair.submissionId}/`,
      matchBasis: pair.matchBasis,
    },
  };
}

function metricFollowingHeader(html: string, label: "Abs" | "EPE"): number | null {
  const header = new RegExp(
    `<th\\b[^>]*>\\s*${label}\\s*<br\\s*\\/?>(?:\\s*)total\\s*<\\/th>`,
    "iu",
  ).exec(html);
  if (!header || header.index === undefined) return null;
  const headerRowEnd = html.indexOf("</tr>", header.index);
  if (headerRowEnd < 0) return null;
  const valueRowStart = html.indexOf("<tr", headerRowEnd + 5);
  if (valueRowStart < 0) return null;
  const valueRowEnd = html.indexOf("</tr>", valueRowStart);
  if (valueRowEnd < 0) return null;
  const valueRow = html.slice(valueRowStart, valueRowEnd);
  const firstCell = /<td\b[^>]*>([\s\S]*?)<\/td>/iu.exec(valueRow);
  return firstCell ? finiteMetric(textFromHtml(firstCell[1] ?? "")) : null;
}

function sectionFollowingHeading(html: string, heading: string): string | null {
  const headings = [...html.matchAll(/<h4\b[^>]*>([\s\S]*?)<\/h4>/giu)];
  const index = headings.findIndex((match) => textFromHtml(match[1] ?? "") === heading);
  const selected = headings[index];
  if (!selected || selected.index === undefined) return null;
  const start = selected.index + selected[0].length;
  const end = headings[index + 1]?.index ?? html.length;
  return html.slice(start, end);
}

export function parseSceneFlowCleanMetrics(html: string): ComponentMetrics | null {
  const disparity1 = sectionFollowingHeading(html, "Disparity 1");
  const disparity2 = sectionFollowingHeading(html, "Disparity 2");
  const opticalFlow = sectionFollowingHeading(html, "Optical Flow");
  if (!disparity1 || !disparity2 || !opticalFlow) return null;
  const d1 = metricFollowingHeader(disparity1, "Abs");
  const d2 = metricFollowingHeader(disparity2, "Abs");
  const flow = metricFollowingHeader(opticalFlow, "EPE");
  return d1 === null || d2 === null || flow === null ? null : { d1, d2, flow };
}

interface BerlinDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function berlinDateTimeParts(timestamp: number): BerlinDateTimeParts | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
  const result = {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function berlinOffsetAt(timestamp: number): number | null {
  const parts = berlinDateTimeParts(timestamp);
  if (!parts) return null;
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    timestamp) / 60_000;
}

function berlinLocalTimestamp(parts: BerlinDateTimeParts): number | null {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (calendar.getUTCFullYear() !== parts.year || calendar.getUTCMonth() !== parts.month - 1 ||
      calendar.getUTCDate() !== parts.day) return null;

  // Berlin uses one of at most two offsets in a year. Testing both also handles
  // midnight correctly on daylight-saving transition dates; a nonexistent
  // local clock time fails closed.
  const candidateOffsets = new Set([
    berlinOffsetAt(Date.UTC(parts.year, 0, 1, 12)),
    berlinOffsetAt(Date.UTC(parts.year, 6, 1, 12)),
    berlinOffsetAt(localAsUtc),
  ].filter((offset): offset is number => offset !== null));
  for (const offset of [...candidateOffsets].sort((left, right) => right - left)) {
    const candidate = localAsUtc - offset * 60_000;
    const observed = berlinDateTimeParts(candidate);
    if (observed && Object.keys(parts).every((key) =>
      observed[key as keyof BerlinDateTimeParts] === parts[key as keyof BerlinDateTimeParts])) {
      return candidate;
    }
  }
  return null;
}

export function parseSubmissionTimestamp(html: string): string | null {
  const dateParagraph = /<h3\b[^>]*>[\s\S]*?<\/h3>\s*<p\b[^>]*>([\s\S]*?)<\/p>/iu.exec(html);
  if (!dateParagraph) return null;
  const label = textFromHtml(dateParagraph[1] ?? "").split("—", 1)[0]?.trim() ?? "";
  const match = /^(\p{L}+\.?)[ ]+(\d{1,2}),[ ]+(\d{4}),[ ]+(?:(\d{1,2})(?::(\d{2}))?[ ]+([ap])\.?(?:m)\.?|(noon|midnight))$/iu.exec(
    label,
  );
  if (!match) return null;
  const monthName = (match[1] ?? "").replace(/\./gu, "").toLocaleLowerCase("en-US");
  const monthNames = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const month = monthNames.findIndex((candidate) => monthName.startsWith(candidate)) + 1;
  if (month === 0) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  const specialTime = (match[7] ?? "").toLocaleLowerCase("en-US");
  const minute = specialTime ? 0 : Number(match[5] ?? "0");
  const clockHour = specialTime ? 0 : Number(match[4]);
  if (!Number.isInteger(year) || !Number.isInteger(day) || !Number.isInteger(minute) ||
      day < 1 || day > 31 || minute < 0 || minute > 59 ||
      (!specialTime && (clockHour < 1 || clockHour > 12))) return null;
  let hour = specialTime === "noon" ? 12 : clockHour % 12;
  if (!specialTime && (match[6] ?? "").toLocaleLowerCase("en-US") === "p") hour += 12;
  const timestamp = berlinLocalTimestamp({ year, month, day, hour, minute });
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function sceneFlowCandidate(
  pair: MatchedPair,
  detailHtml: string,
): ScoredCandidate | null {
  const clean = parseSceneFlowCleanMetrics(detailHtml);
  const deltaD1 = valueAt(pair.robustness, 1);
  const deltaD2 = valueAt(pair.robustness, 4);
  const deltaFlow = valueAt(pair.robustness, 6);
  if (!clean || deltaD1 === null || deltaD2 === null || deltaFlow === null) return null;
  const robustProxy = {
    d1: clean.d1 + deltaD1,
    d2: clean.d2 + deltaD2,
    flow: clean.flow + deltaFlow,
  };
  const baseline = LEADERBOARD_BASELINES["scene-flow"];
  const springTerm = mean([
    clean.d1 / baseline.spring.d1,
    clean.d2 / baseline.spring.d2,
    clean.flow / baseline.spring.flow,
  ]);
  const robustSpringTerm = mean([
    robustProxy.d1 / baseline.robustProxy.d1,
    robustProxy.d2 / baseline.robustProxy.d2,
    robustProxy.flow / baseline.robustProxy.flow,
  ]);
  return {
    team: pair.team,
    track: "scene-flow",
    result: {
      rankChange: 0,
      score: roundMetric(0.5 * springTerm + 0.5 * robustSpringTerm),
      // Scene-flow components use different baselines; the public table shows
      // their normalized aggregates while retaining raw components below.
      springMetric: roundMetric(springTerm),
      robustSpringMetric: roundMetric(robustSpringTerm),
      springTerm: roundMetric(springTerm),
      robustSpringTerm: roundMetric(robustSpringTerm),
      submittedAt: parseSubmissionTimestamp(detailHtml),
      benchmarkMethod: pair.methodName,
      benchmarkUrl: `${SPRING_ORIGIN}/${pair.submissionId}/`,
      matchBasis: pair.matchBasis,
      springComponents: {
        d1: roundMetric(clean.d1),
        d2: roundMetric(clean.d2),
        flow: roundMetric(clean.flow),
      },
      robustSpringComponents: {
        d1: roundMetric(robustProxy.d1),
        d2: roundMetric(robustProxy.d2),
        flow: roundMetric(robustProxy.flow),
      },
    },
  };
}

function isChallengeSubmission(candidate: ScoredCandidate): boolean {
  // An exact participant identifier is an organizer-issued ownership signal,
  // so its valid publication timestamp need not be post-launch. Heuristic
  // team-name matches still require a post-launch timestamp to avoid claiming
  // an unrelated historical method with a coincidental name.
  if (!candidate.result.submittedAt) return false;
  const submittedAt = Date.parse(candidate.result.submittedAt);
  if (!Number.isFinite(submittedAt)) return false;
  return candidate.result.matchBasis === "team-id" || submittedAt >= CHALLENGE_LAUNCH_UTC_MS;
}

function laterCandidate(left: ScoredCandidate, right: ScoredCandidate): ScoredCandidate {
  const leftTime = Date.parse(left.result.submittedAt ?? "");
  const rightTime = Date.parse(right.result.submittedAt ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime > rightTime ? left : right;
  }
  // Submission IDs are monotonically allocated by the benchmark and are the
  // deterministic fallback when either detail page has no parseable timestamp.
  const submissionId = (candidate: ScoredCandidate): number =>
    Number(candidate.result.benchmarkUrl.match(/\/(\d+)\/$/u)?.[1] ?? "0");
  return submissionId(left) >= submissionId(right) ? left : right;
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function numericSubmissionId(submissionId: string): number {
  return /^\d{1,9}$/u.test(submissionId) ? Number(submissionId) : 0;
}

function boundedDetailIds(
  scalarCandidates: readonly ScoredCandidate[],
  scenePairs: readonly MatchedPair[],
): string[] {
  interface DetailDescriptor {
    submissionId: string;
    group: string;
    // Scene Flow needs its detail page to calculate clean component metrics.
    // A name heuristic needs the page timestamp to prove post-launch eligibility.
    priority: 0 | 1 | 2;
  }
  const descriptors: DetailDescriptor[] = [
    ...scenePairs.map((pair) => ({
      submissionId: pair.submissionId,
      group: `${pair.team.teamId}:scene-flow`,
      priority: 0 as const,
    })),
    ...scalarCandidates.flatMap((candidate) => {
      const submissionId = candidate.result.benchmarkUrl.match(/\/(\d+)\/$/u)?.[1];
      return submissionId ? [{
        submissionId,
        group: `${candidate.team.teamId}:${candidate.track}`,
        priority: candidate.result.matchBasis === "team-name" ? 1 as const : 2 as const,
      }] : [];
    }),
  ];

  // First retain the newest detail for every team/track group. Remaining slots
  // are recent history. This cap prevents a popular team or a large benchmark
  // table from making the whole refresh fail or exceed the callable deadline.
  const newestByGroup = new Map<string, DetailDescriptor>();
  for (const descriptor of descriptors) {
    const prior = newestByGroup.get(descriptor.group);
    if (!prior || numericSubmissionId(descriptor.submissionId) >
      numericSubmissionId(prior.submissionId)) {
      newestByGroup.set(descriptor.group, descriptor);
    }
  }
  const primary = [...newestByGroup.values()].sort((left, right) =>
    left.priority - right.priority ||
    numericSubmissionId(right.submissionId) - numericSubmissionId(left.submissionId),
  );
  const primaryIds = new Set(primary.map((descriptor) => descriptor.submissionId));
  if (primaryIds.size > MAX_DETAIL_REQUESTS) {
    throw new AppError(
      "resource-exhausted",
      "The benchmark has more current team-track results than one safe refresh can verify.",
      "transient",
    );
  }
  const history = descriptors
    .filter((descriptor) => !primaryIds.has(descriptor.submissionId))
    .sort((left, right) =>
      left.priority - right.priority ||
      numericSubmissionId(right.submissionId) - numericSubmissionId(left.submissionId),
    );
  return [...new Set([...primary, ...history].map((descriptor) => descriptor.submissionId))]
    .slice(0, MAX_DETAIL_REQUESTS);
}

interface RankedResult {
  key: string;
  teamId: string;
  result: PublicLeaderboardResult;
}

function resultRankKey(
  teamId: string,
  track: LeaderboardTrack,
  result: PublicLeaderboardResult,
): string {
  // A quantitative leaderboard ranks submissions, not teams. The official
  // benchmark URL is immutable and lets one team keep several named methods.
  return track === "cross-task" ? teamId : `${teamId}:${result.benchmarkUrl}`;
}

function rankedResults(
  snapshot: PublicLeaderboardSnapshot | null,
  track: LeaderboardTrack,
): RankedResult[] {
  if (!snapshot) return [];
  const rows = snapshot.teams.flatMap((team) => {
    if (track === "cross-task") {
      const result = team.results[track];
      return result ? [{ key: team.teamId, teamId: team.teamId, result }] : [];
    }

    // New snapshots retain every displayed method in submissionHistory. The
    // results fallback keeps older compatible caches and direct test callers
    // rankable without duplicating their latest entry.
    const byUrl = new Map<string, PublicLeaderboardResult>();
    for (const result of team.submissionHistory[track] ?? []) {
      byUrl.set(result.benchmarkUrl, result);
    }
    const latest = team.results[track];
    if (latest) byUrl.set(latest.benchmarkUrl, latest);
    return [...byUrl.values()].map((result) => ({
      key: resultRankKey(team.teamId, track, result),
      teamId: team.teamId,
      result,
    }));
  });
  return rows.sort((left, right) =>
    left.result.score - right.result.score ||
    left.result.robustSpringTerm - right.result.robustSpringTerm ||
    left.result.springTerm - right.result.springTerm ||
    left.teamId.localeCompare(right.teamId, undefined, { numeric: true }) ||
    left.result.benchmarkUrl.localeCompare(
      right.result.benchmarkUrl,
      undefined,
      { numeric: true },
    ),
  );
}

function rankMap(snapshot: PublicLeaderboardSnapshot | null, track: LeaderboardTrack): Map<string, number> {
  return new Map(rankedResults(snapshot, track).map((row, index) => [row.key, index + 1]));
}

function applyRankChanges(
  teams: PublicLeaderboardTeam[],
  previous: PublicLeaderboardSnapshot | null,
): void {
  for (const track of [...QUANTITATIVE_TRACKS, "cross-task"] as const) {
    const oldRanks = rankMap(previous, track);
    const newRanks = rankMap(
      {
        schemaVersion: 2,
        updatedAt: "",
        sourceLabel: "",
        scoringConvention: "organizer-approved-additive-proxy",
        baselines: LEADERBOARD_BASELINE_METADATA,
        syncStatus: "fresh",
        teams,
      },
      track,
    );
    for (const team of teams) {
      if (track === "cross-task") {
        const result = team.results[track];
        if (!result) continue;
        const newRank = newRanks.get(team.teamId);
        const oldRank = oldRanks.get(team.teamId);
        if (newRank !== undefined && oldRank !== undefined) {
          result.rankChange = oldRank - newRank;
        }
        continue;
      }

      for (const result of team.submissionHistory[track] ?? []) {
        const key = resultRankKey(team.teamId, track, result);
        const newRank = newRanks.get(key);
        const oldRank = oldRanks.get(key);
        result.rankChange = newRank !== undefined && oldRank !== undefined
          ? oldRank - newRank
          : 0;
      }

      // `results` remains the backward-compatible latest-method projection.
      // Mirror the exact history entry so both projections report one movement.
      const latest = team.results[track];
      if (latest) {
        const historyEntry = team.submissionHistory[track]?.find(
          (result) => result.benchmarkUrl === latest.benchmarkUrl,
        );
        const key = resultRankKey(team.teamId, track, latest);
        const newRank = newRanks.get(key);
        const oldRank = oldRanks.get(key);
        latest.rankChange = historyEntry?.rankChange ?? (
          newRank !== undefined && oldRank !== undefined ? oldRank - newRank : 0
        );
      }
    }
  }
}

function addCrossTaskResults(teams: PublicLeaderboardTeam[]): void {
  for (const team of teams) {
    const results = QUANTITATIVE_TRACKS.map((track) => team.results[track]);
    if (results.some((result) => result === undefined)) continue;
    const complete = results as PublicLeaderboardResult[];
    const timestamps = complete
      .flatMap((result) => result.submittedAt ? [result.submittedAt] : [])
      .sort();
    const springTerm = mean(complete.map((result) => result.springTerm));
    const robustSpringTerm = mean(complete.map((result) => result.robustSpringTerm));
    team.results["cross-task"] = {
      rankChange: 0,
      score: roundMetric(mean(complete.map((result) => result.score))),
      springMetric: roundMetric(springTerm),
      robustSpringMetric: roundMetric(robustSpringTerm),
      springTerm: roundMetric(springTerm),
      robustSpringTerm: roundMetric(robustSpringTerm),
      submittedAt: timestamps.at(-1) ?? null,
      benchmarkMethod: "Combined quantitative tracks",
      benchmarkUrl: `${SPRING_ORIGIN}/`,
      matchBasis: "cross-task",
    };
  }
}

export async function buildLeaderboardSnapshot(
  roster: readonly LeaderboardRosterTeam[],
  pages: BenchmarkPageSet,
  detailLoader: DetailLoader,
  previous: PublicLeaderboardSnapshot | null,
  now: Date,
): Promise<PublicLeaderboardSnapshot> {
  // Only reconstructed public fields from a previous cache may influence rank
  // changes or history. This also makes direct callers safe in tests/tools.
  const safePrevious = previous ? reconstructPublicLeaderboardSnapshot(previous) : null;
  const opticalPairs = pairedRows(
    pages.opticalFlowAccuracy,
    pages.opticalFlowRobustness,
    roster,
    "optical-flow",
    true,
  );
  const stereoPairs = pairedRows(
    pages.stereoAccuracy,
    pages.stereoRobustness,
    roster,
    "stereo-matching",
    true,
  );
  const scenePairs = pairedRows(
    pages.sceneFlowAccuracy,
    pages.sceneFlowRobustness,
    roster,
    "scene-flow",
    false,
  );

  const scalarCandidates: ScoredCandidate[] = [];
  for (const [pairs, track] of [
    [opticalPairs, "optical-flow"],
    [stereoPairs, "stereo-matching"],
  ] as const) {
    for (const pair of pairs) {
      const candidate = scalarCandidate(pair, track);
      if (candidate) scalarCandidates.push(candidate);
    }
  }

  const detailIds = boundedDetailIds(scalarCandidates, scenePairs);
  const detailHtml = new Map<string, string>();
  const loadedDetails = await mapWithConcurrency(
    detailIds,
    DETAIL_FETCH_CONCURRENCY,
    async (submissionId) => ({ submissionId, html: await detailLoader(submissionId) }),
  );
  for (const detail of loadedDetails) detailHtml.set(detail.submissionId, detail.html);

  for (const candidate of scalarCandidates) {
    const submissionId = candidate.result.benchmarkUrl.match(/\/(\d+)\/$/u)?.[1];
    if (submissionId) {
      candidate.result.submittedAt = parseSubmissionTimestamp(detailHtml.get(submissionId) ?? "");
    }
  }

  const allCandidates = [...scalarCandidates];
  for (const pair of scenePairs) {
    const detail = detailHtml.get(pair.submissionId);
    if (!detail) continue;
    const candidate = sceneFlowCandidate(pair, detail);
    if (candidate) allCandidates.push(candidate);
  }

  // A name coincidence with an older public method is not a challenge entry.
  // Unparseable timestamps are also rejected instead of being guessed.
  const eligibleCandidates = allCandidates.filter(isChallengeSubmission);
  const selected = new Map<string, ScoredCandidate>();
  for (const candidate of eligibleCandidates) {
    const key = `${candidate.team.teamId}:${candidate.track}`;
    const prior = selected.get(key);
    selected.set(key, prior ? laterCandidate(prior, candidate) : candidate);
  }

  const teams: PublicLeaderboardTeam[] = roster
    .map((team) => ({
      teamId: team.teamId,
      teamName: team.teamName,
      registeredTracks: [...team.registeredTracks],
      results: {},
      submissionHistory: {},
    }))
    .sort((left, right) =>
      left.teamName.localeCompare(right.teamName, undefined, { sensitivity: "base" }) ||
      left.teamId.localeCompare(right.teamId, undefined, { numeric: true }),
    );
  const publicTeamById = new Map(teams.map((team) => [team.teamId, team]));
  for (const candidate of selected.values()) {
    const team = publicTeamById.get(candidate.team.teamId);
    if (team) team.results[candidate.track] = candidate.result;
  }
  const previousTeams = new Map(safePrevious?.teams.map((team) => [team.teamId, team]) ?? []);
  for (const team of teams) {
    for (const track of QUANTITATIVE_TRACKS) {
      // A registration update may remove a track. Its old result/history must
      // not survive into a team projection that no longer registers the track.
      if (!team.registeredTracks.includes(track)) continue;
      const previousTeam = previousTeams.get(team.teamId);
      const previousResult = previousTeam?.results[track];
      const currentResult = team.results[track];
      const retained = previousTeam?.submissionHistory?.[track] ??
        (previousResult ? [previousResult] : []);
      const current = eligibleCandidates
        .filter((candidate) =>
          candidate.team.teamId === team.teamId && candidate.track === track,
        )
        .map((candidate) => candidate.result);
      if (currentResult && current.length === 0) current.push(currentResult);
      const unique = new Map(
        [...retained, ...current].map((result) => [result.benchmarkUrl, {
          ...result,
          rankChange: 0,
        }]),
      );
      const history = [...unique.values()].sort((left, right) =>
        (left.submittedAt ?? "").localeCompare(right.submittedAt ?? "") ||
        left.benchmarkUrl.localeCompare(right.benchmarkUrl),
      );
      if (history.length > 0) {
        team.submissionHistory[track] = history.slice(-MAX_HISTORY_PER_TRACK);
      }
    }
  }
  addCrossTaskResults(teams);
  applyRankChanges(teams, safePrevious);
  return {
    schemaVersion: 2,
    updatedAt: now.toISOString(),
    sourceLabel: LIVE_SOURCE_LABEL,
    scoringConvention: "organizer-approved-additive-proxy",
    baselines: LEADERBOARD_BASELINE_METADATA,
    syncStatus: "fresh",
    teams,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safePublicText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maximumLength) return null;
  return [...text].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  }) ? null : text;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safePublicMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9
    ? value
    : null;
}

function reconstructComponents(value: unknown): ComponentMetrics | null {
  const record = recordValue(value);
  if (!record) return null;
  const d1 = safePublicMetric(record.d1);
  const d2 = safePublicMetric(record.d2);
  const flow = safePublicMetric(record.flow);
  return d1 === null || d2 === null || flow === null ? null : { d1, d2, flow };
}

function reconstructResult(
  value: unknown,
  track: LeaderboardTrack,
): PublicLeaderboardResult | null {
  const record = recordValue(value);
  if (!record) return null;
  const rankChange = record.rankChange;
  const score = safePublicMetric(record.score);
  const springMetric = safePublicMetric(record.springMetric);
  const robustSpringMetric = safePublicMetric(record.robustSpringMetric);
  const springTerm = safePublicMetric(record.springTerm);
  const robustSpringTerm = safePublicMetric(record.robustSpringTerm);
  const benchmarkMethod = safePublicText(record.benchmarkMethod, 240);
  const benchmarkUrl = typeof record.benchmarkUrl === "string" ? record.benchmarkUrl : "";
  const expectedUrl = track === "cross-task"
    ? benchmarkUrl === `${SPRING_ORIGIN}/`
    : /^https:\/\/spring-benchmark\.org\/\d{1,9}\/$/u.test(benchmarkUrl);
  const matchBasis = record.matchBasis;
  const expectedBasis = track === "cross-task"
    ? matchBasis === "cross-task"
    : matchBasis === "team-id" || matchBasis === "team-name";
  const submittedAt = canonicalTimestamp(record.submittedAt);
  if (
    !Number.isSafeInteger(rankChange) || Math.abs(rankChange as number) > 10_000 ||
    score === null || springMetric === null || robustSpringMetric === null ||
    springTerm === null || robustSpringTerm === null || benchmarkMethod === null ||
    !expectedUrl || !expectedBasis || submittedAt === null
  ) {
    return null;
  }
  const result: PublicLeaderboardResult = {
    rankChange: rankChange as number,
    score,
    springMetric,
    robustSpringMetric,
    springTerm,
    robustSpringTerm,
    submittedAt,
    benchmarkMethod,
    benchmarkUrl,
    matchBasis: matchBasis as PublicLeaderboardResult["matchBasis"],
  };
  if (track === "scene-flow") {
    const springComponents = reconstructComponents(record.springComponents);
    const robustSpringComponents = reconstructComponents(record.robustSpringComponents);
    if (!springComponents || !robustSpringComponents) return null;
    result.springComponents = springComponents;
    result.robustSpringComponents = robustSpringComponents;
  }
  return result;
}

function reconstructPublicTeam(value: unknown): PublicLeaderboardTeam | null {
  const record = recordValue(value);
  if (!record) return null;
  const teamId = safePublicText(record.teamId, 32);
  const teamName = safePublicText(record.teamName, 120);
  const idMatch = teamId ? /^RoCo-([1-9]\d*)$/u.exec(teamId) : null;
  const rawTracks = Array.isArray(record.registeredTracks) ? record.registeredTracks : null;
  const allowedTracks = new Set<TrackId>([...QUANTITATIVE_TRACKS, "exploration"]);
  if (!teamId || !idMatch || Number(idMatch[1]) < 8 || !teamName || !rawTracks) return null;
  const registeredTracks = [...new Set(rawTracks.filter(
    (track): track is TrackId => typeof track === "string" && allowedTracks.has(track as TrackId),
  ))];
  if (registeredTracks.length !== rawTracks.length || registeredTracks.length === 0) return null;
  const rawResults = recordValue(record.results);
  const rawHistory = recordValue(record.submissionHistory);
  if (!rawResults || !rawHistory) return null;
  const results: PublicLeaderboardTeam["results"] = {};
  for (const track of [...QUANTITATIVE_TRACKS, "cross-task"] as const) {
    if (!Object.hasOwn(rawResults, track)) continue;
    if (track !== "cross-task" && !registeredTracks.includes(track)) return null;
    if (track === "cross-task" &&
        !QUANTITATIVE_TRACKS.every((candidate) => registeredTracks.includes(candidate))) {
      return null;
    }
    const result = reconstructResult(rawResults[track], track);
    if (!result) return null;
    results[track] = result;
  }
  const submissionHistory: PublicLeaderboardTeam["submissionHistory"] = {};
  for (const track of QUANTITATIVE_TRACKS) {
    if (!Object.hasOwn(rawHistory, track)) continue;
    if (!registeredTracks.includes(track)) return null;
    const values = rawHistory[track];
    if (!Array.isArray(values)) return null;
    const reconstructed = values.slice(-MAX_HISTORY_PER_TRACK).map((entry) =>
      reconstructResult(entry, track),
    );
    if (reconstructed.some((entry) => entry === null)) return null;
    if (reconstructed.length > 0) {
      submissionHistory[track] = reconstructed as PublicLeaderboardResult[];
    }
  }
  return { teamId, teamName, registeredTracks, results, submissionHistory };
}

export function reconstructPublicLeaderboardSnapshot(
  value: unknown,
): PublicLeaderboardSnapshot | null {
  const record = recordValue(value);
  if (!record || record.schemaVersion !== 2 ||
      record.scoringConvention !== "organizer-approved-additive-proxy") return null;
  const updatedAt = canonicalTimestamp(record.updatedAt);
  if (!updatedAt || !Array.isArray(record.teams) || record.teams.length > 500) return null;
  const teams = record.teams.map(reconstructPublicTeam);
  if (teams.some((team) => team === null)) return null;
  const publicTeams = teams as PublicLeaderboardTeam[];
  if (new Set(publicTeams.map((team) => team.teamId)).size !== publicTeams.length) return null;
  return {
    schemaVersion: 2,
    updatedAt,
    sourceLabel: LIVE_SOURCE_LABEL,
    scoringConvention: "organizer-approved-additive-proxy",
    baselines: LEADERBOARD_BASELINE_METADATA,
    // Persisted status is normalized. Callers explicitly overwrite it when a
    // valid cache is served without completing a new upstream synchronization.
    syncStatus: "fresh",
    teams: publicTeams,
  };
}

function snapshotWithSyncStatus(
  snapshot: PublicLeaderboardSnapshot,
  syncStatus: PublicLeaderboardSnapshot["syncStatus"],
): PublicLeaderboardSnapshot {
  return {
    schemaVersion: 2,
    updatedAt: snapshot.updatedAt,
    sourceLabel: LIVE_SOURCE_LABEL,
    scoringConvention: "organizer-approved-additive-proxy",
    baselines: LEADERBOARD_BASELINE_METADATA,
    syncStatus,
    teams: snapshot.teams,
  };
}

export function publicRosterTeamFromDocument(
  documentId: string,
  value: unknown,
): LeaderboardRosterTeam | null {
  if (typeof value !== "object" || value === null) return null;
  const data = value as Record<string, unknown>;
  const teamId = typeof data.teamId === "string" ? data.teamId.trim() : "";
  const teamName = typeof data.teamName === "string" ? data.teamName.trim() : "";
  const idMatch = /^RoCo-([1-9]\d*)$/u.exec(teamId);
  const teamNumber = idMatch ? Number(idMatch[1]) : Number.NaN;
  if (
    data.status !== "active" ||
    !Number.isSafeInteger(teamNumber) ||
    teamNumber < 8 ||
    data.teamNumber !== teamNumber ||
    documentId !== teamId ||
    teamId !== `RoCo-${teamNumber}` ||
    !teamName ||
    teamName.length > 120 ||
    [...teamName].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return null;
  }
  const rawTracks = Array.isArray(data.tracks) ? data.tracks : [];
  const allowedTracks = new Set<TrackId>([...QUANTITATIVE_TRACKS, "exploration"]);
  const registeredTracks = [...new Set(rawTracks.filter(
    (track): track is TrackId => typeof track === "string" && allowedTracks.has(track as TrackId),
  ))];
  return registeredTracks.length > 0 ? { teamId, teamName, registeredTracks } : null;
}

async function loadActiveRoster(db: Firestore): Promise<LeaderboardRosterTeam[]> {
  const snapshot = await db.collection("teams").where("status", "==", "active").get();
  return snapshot.docs.flatMap((document) => {
    const team = publicRosterTeamFromDocument(document.id, document.data());
    return team ? [team] : [];
  });
}

async function fetchBoundedHtml(url: string, maximumBytes: number): Promise<string> {
  const parsed = new URL(url);
  if (parsed.origin !== SPRING_ORIGIN) {
    throw new AppError("internal", "Invalid benchmark source.", "internal");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "RoCo-Spring-Leaderboard/1.0 (+https://roco-spring.github.io/)",
      },
    });
    if (!response.ok || !response.body) {
      throw new AppError(
        "unavailable",
        "The Spring benchmark is temporarily unavailable.",
        "transient",
      );
    }
    const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en-US") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new AppError("unavailable", "The benchmark returned an invalid document type.", "transient");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new AppError("unavailable", "The benchmark response exceeded its safe size.", "transient");
    }
    const decoder = new TextDecoder();
    let size = 0;
    let html = "";
    const body = response.body as unknown as AsyncIterable<unknown>;
    for await (const part of body) {
      if (!(part instanceof Uint8Array)) {
        throw new AppError("unavailable", "The benchmark response was invalid.", "transient");
      }
      size += part.byteLength;
      if (size > maximumBytes) {
        controller.abort();
        throw new AppError("unavailable", "The benchmark response exceeded its safe size.", "transient");
      }
      html += decoder.decode(part, { stream: true });
    }
    html += decoder.decode();
    return html;
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "unavailable",
      "The Spring benchmark could not be reached safely.",
      "transient",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function loadBenchmarkPages(): Promise<BenchmarkPageSet> {
  const entries = Object.entries(BENCHMARK_PAGES) as Array<
    [keyof BenchmarkPageSet, string]
  >;
  const loaded = await Promise.all(
    entries.map(async ([key, url]) => [key, await fetchBoundedHtml(url, MAX_LIST_BYTES)] as const),
  );
  if (loaded.some(([key, html]) => !benchmarkPageHasExpectedSchema(key, html))) {
    throw new AppError(
      "unavailable",
      "The Spring benchmark table format could not be verified.",
      "transient",
    );
  }
  return Object.fromEntries(loaded) as unknown as BenchmarkPageSet;
}

async function loadBenchmarkDetail(submissionId: string): Promise<string> {
  if (!/^\d{1,9}$/u.test(submissionId)) {
    throw new AppError("internal", "Invalid benchmark submission identifier.", "internal");
  }
  return await fetchBoundedHtml(`${SPRING_ORIGIN}/${submissionId}/`, MAX_DETAIL_BYTES);
}

export function parseLeaderboardRefreshInput(data: unknown): { force: boolean } {
  if (data === undefined || data === null) return { force: false };
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new AppError("invalid-argument", "Leaderboard refresh data is invalid.", "validation");
  }
  const record = data as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "force") ||
      (record.force !== undefined && typeof record.force !== "boolean")) {
    throw new AppError("invalid-argument", "Leaderboard refresh data is invalid.", "validation");
  }
  return { force: record.force === true };
}

export async function refreshLeaderboardOperation(
  db: Firestore,
  force: boolean,
  now = new Date(),
): Promise<PublicLeaderboardSnapshot> {
  const cacheReference = db.collection(CACHE_COLLECTION).doc(CACHE_DOCUMENT);
  const leaseId = randomUUID();
  const nowMs = now.getTime();
  const decision = await db.runTransaction(async (transaction) => {
    const cacheDocument = await transaction.get(cacheReference);
    const cached = reconstructPublicLeaderboardSnapshot(cacheDocument.get("snapshot"));
    const cachedAt = cached ? Date.parse(cached.updatedAt) : Number.NaN;
    const cacheAge = Number.isFinite(cachedAt) ? nowMs - cachedAt : Number.POSITIVE_INFINITY;
    const maximumAge = force ? FORCED_REFRESH_FLOOR_MS : CACHE_TTL_MS;
    if (cached && cacheAge >= 0 && cacheAge < maximumAge) {
      return { cached, refresh: false, syncStatus: "cache-hit" } as const;
    }
    const failedAtValue: unknown = cacheDocument.get("refreshFailedAt");
    const failedAt = typeof failedAtValue === "string" ? Date.parse(failedAtValue) : Number.NaN;
    const failureAge = Number.isFinite(failedAt) ? nowMs - failedAt : Number.POSITIVE_INFINITY;
    if (failureAge >= 0 && failureAge < REFRESH_FAILURE_COOLDOWN_MS) {
      if (cached) return { cached, refresh: false, syncStatus: "stale-cache" } as const;
      throw new AppError(
        "resource-exhausted",
        "The leaderboard source is cooling down after a failed refresh. Please retry shortly.",
        "rate_limit",
      );
    }
    const existingLeaseUntil: unknown = cacheDocument.get("refreshLeaseUntilMs");
    if (typeof existingLeaseUntil === "number" && existingLeaseUntil > nowMs) {
      if (cached) return { cached, refresh: false, syncStatus: "stale-cache" } as const;
      throw new AppError(
        "resource-exhausted",
        "A leaderboard refresh is already running. Please retry shortly.",
        "rate_limit",
      );
    }
    transaction.set(cacheReference, {
      refreshLeaseId: leaseId,
      refreshLeaseUntilMs: nowMs + REFRESH_LEASE_MS,
      refreshAttemptAt: now.toISOString(),
    }, { merge: true });
    return { cached, refresh: true } as const;
  });
  if (!decision.refresh) return snapshotWithSyncStatus(decision.cached, decision.syncStatus);

  try {
    const [roster, pages] = await Promise.all([loadActiveRoster(db), loadBenchmarkPages()]);
    const snapshot = await buildLeaderboardSnapshot(
      roster,
      pages,
      loadBenchmarkDetail,
      decision.cached,
      now,
    );
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(cacheReference);
      if (current.get("refreshLeaseId") !== leaseId) {
        throw new AppError("aborted", "Leaderboard refresh ownership expired.", "transient");
      }
      transaction.set(cacheReference, {
        snapshot,
        refreshLeaseId: FieldValue.delete(),
        refreshLeaseUntilMs: FieldValue.delete(),
        refreshFailedAt: FieldValue.delete(),
        refreshCompletedAt: now.toISOString(),
      }, { merge: true });
    });
    return snapshot;
  } catch (error: unknown) {
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(cacheReference);
      if (current.get("refreshLeaseId") === leaseId) {
        transaction.update(cacheReference, {
          refreshLeaseId: FieldValue.delete(),
          refreshLeaseUntilMs: FieldValue.delete(),
          refreshFailedAt: now.toISOString(),
        });
      }
    }).catch(() => undefined);
    if (decision.cached) {
      // Emit one alertable, public-data-free signal for the refresh attempt
      // that actually failed. Cache/cooldown returns above never reach here,
      // so repeated button clicks cannot create duplicate failure logs.
      logger.error("Leaderboard refresh failed; serving stale cache", {
        operation: "leaderboardRefresh",
        status: "failed",
        errorCategory: safeErrorCategory(error),
      });
      return snapshotWithSyncStatus(decision.cached, "stale-cache");
    }
    throw error;
  }
}
