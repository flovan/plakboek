/**
 * Time constants shared by `config.ts` and the modules it installs. They sit
 * in their own module so that `credentials.ts` and the password-link plugin
 * can read them without importing `config.ts`, which installs the plugin: a
 * dependency in that direction would be an import cycle.
 */

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

/** AUTH-03: set-password and reset-password links are valid for 48 hours. */
export const SET_PASSWORD_TOKEN_TTL_SECONDS = 48 * SECONDS_PER_HOUR;
