/**
 * Accounts that are always Super Admin, in every environment.
 *
 * Applied automatically when the server starts (so on every deploy) and whenever one of these
 * people signs in or verifies their email. Only verified emails are promoted, so signing up
 * with one of these addresses without access to its inbox gives nothing.
 * Removing an email here does not demote anyone.
 */
export const PLATFORM_ADMIN_EMAILS: readonly string[] = ['patilshubham0514@gmail.com'];
