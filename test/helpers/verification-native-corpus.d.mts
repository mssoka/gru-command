export interface NativeCorpusRow { readonly raw: string; readonly refused: boolean; readonly subjects: readonly string[] }
export const nativeCorpus: readonly NativeCorpusRow[];
export function nativeRuleMatches(rule: string, raw: string): boolean;
export function simulatedNativeDenial(command: string, rules: readonly string[]): boolean;
