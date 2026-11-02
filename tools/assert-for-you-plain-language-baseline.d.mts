export declare const EXPECTED_BOUNDARY_ASSERTIONS: readonly string[];
export declare const EXPECTED_FACE_ASSERTIONS: readonly string[];
export declare const LEGS: Readonly<Record<'boundary' | 'face', readonly string[]>>;
export declare function assertForYouPlainLanguageBaseline(leg: string, report: unknown): string;
