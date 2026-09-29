// The one canonical form an email address is stored, compared and rate-limited in.
//
// Trim + lowercase only. Deliberately NOT provider-specific rewriting such as dropping dots or
// "+tags" for Gmail: those rules are true for gmail.com and false for most other domains, and
// applying them everywhere would merge addresses that belong to different people.
//
// Lowercasing the whole address is a pragmatic industry choice, not an RFC guarantee — the
// local part is technically case-sensitive, but virtually no real mail server treats it so,
// and treating "Anas@x.com" and "anas@x.com" as different accounts causes far more harm
// (duplicate accounts, failed logins, invitations that never match) than it prevents.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
