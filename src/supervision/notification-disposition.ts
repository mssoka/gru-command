import type { NotificationDispositionAction, Supervisor } from './supervisor.js';

/** Preserve the supervisor's typed refusal through the HTTP disposition hook,
 * including the optional named action (#561): `close-stop` closes a jobless
 * stopped breaker's alert instead of forcing a re-arm's restart. The
 * disposition's `detail` is the route's record text, which the supervisor does
 * not consume. */
export function bindSupervisorNotificationDisposition(
  supervisor: Pick<Supervisor, 'onNotificationDisposed'>,
): (notificationId: string, _detail?: string, action?: NotificationDispositionAction) => ReturnType<Supervisor['onNotificationDisposed']> {
  return (notificationId, _detail, action) => supervisor.onNotificationDisposed(notificationId, { closeStop: action === 'close-stop' });
}
