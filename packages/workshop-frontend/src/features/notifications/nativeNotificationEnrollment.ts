let disconnectActiveEnrollment: (() => void) | undefined;

/** Register the authenticated native-enrollment lifecycle that logout must stop. */
export const registerNativeNotificationEnrollment = (disconnect: () => void): (() => void) => {
  disconnectActiveEnrollment = disconnect;
  return () => {
    if (disconnectActiveEnrollment === disconnect) disconnectActiveEnrollment = undefined;
  };
};

/** Stop enrollment before the authenticated view is torn down. */
export const disconnectNativeNotificationEnrollment = (): void => {
  disconnectActiveEnrollment?.();
};
