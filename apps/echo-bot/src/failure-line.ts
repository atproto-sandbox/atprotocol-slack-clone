/**
 * One line of the bot's log for a failure. A failure's message can carry text someone else chose (a sign-in callback's query,
 * a host's error), so its control and format characters are escaped: no message can end the line and write the next one.
 */
export function failureLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `echo-bot: ${message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`)}\n`;
}
