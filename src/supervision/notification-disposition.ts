import type { Supervisor } from './supervisor.js';

/** Preserve the supervisor's typed refusal through the HTTP disposition hook. */
export function bindSupervisorNotificationDisposition(
  supervisor: Pick<Supervisor, 'onNotificationDisposed'>,
): (notificationId: string) => ReturnType<Supervisor['onNotificationDisposed']> {
  return (notificationId) => supervisor.onNotificationDisposed(notificationId);
}
