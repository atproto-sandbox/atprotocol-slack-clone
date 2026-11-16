/**
 * One line of the webhooks app's log for a failure, escaping control and format characters so untrusted input cannot forge
 * log lines.
 */
export function failureLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `webhooks: ${message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`)}\n`;
}
