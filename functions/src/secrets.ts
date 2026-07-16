import { defineSecret } from "firebase-functions/params";

export const googleOAuthClientSecret = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
export const googleOAuthRefreshToken = defineSecret("GOOGLE_OAUTH_REFRESH_TOKEN");
export const rateLimitHmacSecret = defineSecret("RATE_LIMIT_HMAC_SECRET");
