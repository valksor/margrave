export function testInputsFingerprint(command: string, overrides: object, root?: string): string;
export function mutationCacheDecision(input: {
  command: string;
  overrides: object;
  stampFile: string;
  incrementalFile: string;
  root?: string;
}): { fingerprint: string; force: boolean };
export function readStamp(file: string): string | undefined;
export function isUsableReport(file: string): boolean;
