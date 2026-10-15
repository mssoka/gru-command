export interface BoardServerHarness {
  readonly token: string;
  readonly url: string;
  readonly api: {
    getNotification(id: string): { readonly shownAt: string | null } | null;
  };
  readonly notifications: {
    post(input: {
      readonly id: string;
      readonly kind: string;
      readonly routing: 'needs-owner';
      readonly severity: 'error' | 'info';
      readonly title: string;
      readonly detail: string;
      readonly decision: {
        readonly question: string;
        readonly context: string;
        readonly recommendation: string;
        readonly reservedClass: string;
        readonly whyNotDelegable: string;
        readonly options: readonly { readonly id: string; readonly label: string; readonly consequence: string }[];
        readonly discussion: boolean;
      };
    }): { readonly id: string };
  };
  close(): Promise<void>;
}

export function startBoardServerHarness(token?: string): Promise<BoardServerHarness>;
