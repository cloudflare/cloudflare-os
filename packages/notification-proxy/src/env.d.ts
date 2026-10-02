declare namespace Cloudflare {
  interface Env {
    /** HTTPS origin of the Cloudflare-operated notification service. */
    NOTIFICATION_SERVICE_URL?: string;
    /** Stable central identity of this Cloudflare OS installation. */
    CFOS_INSTALL_ID?: string;
    /** Active central signing-key generation for this installation. */
    CFOS_INSTALL_KEY_ID?: string;
    /** Base64 PKCS#8 P-256 private key, injected only into this platform-private Worker. */
    CFOS_INSTALL_PRIVATE_KEY?: string;
  }
}
