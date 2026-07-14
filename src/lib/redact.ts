/**
 * Browser-facing redaction, aligned with original cpa-usage-keeper helper.RedactSensitiveValue.
 * Keep first 3 + last 6 runes; short values fully masked. DB storage stays raw.
 * @see https://github.com/Willxup/cpa-usage-keeper/blob/main/internal/helper/redact.go
 */

const SENSITIVE_VALUE_MASK = "*********";

/** Mask API keys for UI responses only (not source/provider labels). */
export function redactSensitiveValue(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "unknown") return "unknown";
  // Use code points so multi-byte keys are handled like Go runes.
  const runes = Array.from(trimmed);
  if (runes.length <= 9) return SENSITIVE_VALUE_MASK;
  return runes.slice(0, 3).join("") + SENSITIVE_VALUE_MASK + runes.slice(-6).join("");
}
