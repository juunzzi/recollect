/**
 * Secret detection. Policy is REJECT, not mask: if a candidate memory contains
 * anything that looks like a credential, the whole candidate is dropped.
 */
const PATTERNS: RegExp[] = [
  /\b(?:api[_-]?key|apikey|secret|token|password|passwd)\s*[:=]\s*['"]?[\w\-./+]{16,}/i,
  /\bBearer\s+[\w\-.=]{20,}/,
  /\bghp_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bsk-[A-Za-z0-9\-_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z\-_]{35}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[\w.+-]+@[\w-]+\.[\w.]+\s*[:/]\s*\S{6,}\s*(?:password|pw|pass)/i,
];

export function hasSecret(text: string): boolean {
  const s = String(text || "");
  return PATTERNS.some((re) => re.test(s));
}
