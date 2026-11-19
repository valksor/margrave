// oxlint-disable-next-line no-control-regex -- intentional: this strips control characters
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/gu;
// C0 and C1 control characters, minus tab and newline.
// oxlint-disable-next-line no-control-regex -- intentional: this strips control characters
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** One-line text for human output: strips ANSI escapes and control characters. */
export function clean(s: string): string {
  return s
    .replace(ANSI, "")
    .replace(/[\t\n]/gu, " ")
    .replace(CONTROL, "");
}

/** Multi-line text for human output: like clean(), but keeps newlines and tabs. */
export function cleanBlock(s: string): string {
  return s.replace(ANSI, "").replace(CONTROL, "");
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/.:=@%+,~-]+$/u.test(s) ? s : `'${s.replace(/'/gu, `'\\''`)}'`;
}
