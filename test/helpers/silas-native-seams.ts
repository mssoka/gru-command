/** Native directive-executor seams the production assembly supplies to the
 * autopilot ops (issue #243): inert incident notifications and an empty
 * supervised-producer fence, for tests that do not exercise either. */
export const nativeSeams = {
  notifications: { postIncident: (): undefined => undefined },
  pendingProducerBlockers: (): readonly string[] => [],
};
