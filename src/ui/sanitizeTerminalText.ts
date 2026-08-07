/**
 * Removes terminal control sequences from untrusted text while preserving
 * printable Unicode, tabs and newlines. Styling owned by the UI is applied only
 * after this function runs.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    // OSC sequences, including clipboard operations such as OSC 52.
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
    // DCS, SOS, PM and APC strings terminated by ST.
    .replace(/\x1B[P^_X][\s\S]*?\x1B\\/g, "")
    // CSI and other two-byte escape sequences.
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}
