export const REGION = "europe-west3" as const;
export const PROJECT_ID = "roco-spring-registration-2026" as const;
export const DRIVE_FOLDER_ID = "1gZwIgAcwrtHZN2vW4XttTq5fFA-kU4Y4" as const;
export const GOOGLE_OAUTH_CLIENT_ID =
  "149052181991-dn69v7pid5o7fi89dtnusbklnbnncnho.apps.googleusercontent.com" as const;
export const EMAIL_SENDER = "shashanksagnihotri@gmail.com" as const;
export const EMAIL_REPLY_TO = "roco-spring-org@googlegroups.com" as const;
export const SIGN_IN_URL =
  "https://roco-spring.github.io/team-registration.html?mode=login" as const;

export const TRACKS = [
  "optical-flow",
  "stereo-matching",
  "scene-flow",
  "exploration",
] as const;

export type TrackId = (typeof TRACKS)[number];

export const TRACK_LABELS: Readonly<Record<TrackId, string>> = {
  "optical-flow": "Optical Flow",
  "stereo-matching": "Stereo Matching",
  "scene-flow": "Scene Flow",
  exploration: "Exploration Track",
};

export const RATE_LIMITS = {
  ip: { maxAttempts: 5, windowMs: 60 * 60 * 1_000 },
  email: { maxAttempts: 3, windowMs: 24 * 60 * 60 * 1_000 },
} as const;

// Strictly longer than the 60-second registration callable deadline so a live
// invocation cannot overlap a same-key replay, while still bounding recovery.
export const REGISTRATION_LEASE_MS = 2 * 60 * 1_000;
// Exceeds both the callable timeout and registration lease. A released or
// crashed partial saga gets a generous client-retry window before cleanup.
export const STALE_REGISTRATION_GRACE_MS = 30 * 60 * 1_000;
export const RECONCILIATION_BATCH_SIZE = 20;
export const MAX_RECONCILIATION_ATTEMPTS = 5;
export const RESOURCE_LEASE_MS = 10 * 60 * 1_000;
export const AMBIGUOUS_SHEET_CLEANUP_HORIZON_MS = 60 * 60 * 1_000;
export const AMBIGUOUS_SHEET_NO_FILE_OBSERVATIONS = 3;
export const SHEET_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const SHEET_AUDIT_BATCH_SIZE = 5;
export const FAILED_RECONCILIATION_REVIVAL_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const RECONCILIATION_JOB_LAUNCH_WINDOW_MS = 100 * 1_000;
export const RECONCILIATION_MAX_CONCURRENCY = 4;
