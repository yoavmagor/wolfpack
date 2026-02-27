// Session triage classification — shared between server and tests

export type TriageStatus = "running" | "needs-input" | "idle";

export const INPUT_PATTERNS = [
  /\? ?\(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[yes\/no\]/i,
  /Do you want to (?:continue|proceed|install|update|overwrite|replace|delete|remove|retry|upgrade|deploy)/i,
  /Press (?:Enter|ENTER|any key)/i,
  /(?:grant|request|need).*permission/i,
  /(?:approve|confirm) (?:this|the)/i,
  /waiting for (?:input|response|confirmation|approval)/i,
  /\(yes\/no(?:\/\w+)?\)/i,
  /\?\s*\[.*\]\s*$/,
  /(?:Enter|type) (?:a |your )?(?:password|passphrase|token|username)/i,
  /are you sure/i,
  /\[y\]/i,
];

/** Patterns matching decorative/UI lines to filter from card preview. */
export const JUNK_LINE_PATTERNS = [
  /^[─━═│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╭╮╯╰║╒╓╘╙╕╖╛╜\s]+$/, // all box-drawing chars
  /⏵⏵\s*accept edits/,                               // Claude Code hint bar
  /esc to interrupt/,                                  // Claude Code hint bar
  /^\s*[$%#>❯›»]\s*$/,                                // bare shell/agent prompt
  /^\s*$/,                                             // whitespace-only
];

/** True if the line is decorative/UI junk that should be filtered from card preview. */
export function isJunkLine(line: string): boolean {
  return JUNK_LINE_PATTERNS.some((p) => p.test(line));
}

/** True if the line matches an input/confirmation prompt pattern. */
export function isInputPrompt(line: string): boolean {
  return INPUT_PATTERNS.some((p) => p.test(line));
}
