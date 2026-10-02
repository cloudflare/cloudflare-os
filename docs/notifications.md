# Notifications architecture

Notifications are a platform feature, not a gatekeeper. The Workshop backend can call the
install-local `notification-proxy` through the explicit `NOTIFICATION_DELIVERY` service binding,
but the proxy has no public route and is never included in `GATEKEEPER_*` discovery, connector UI,
or agent bindings.

The proxy isolates the installation signing key from Workshop core and stores only an opaque
subscription id for each Workshop user. The Cloudflare-operated notification service owns APNs
delivery and the device/subscription directory. It accepts only fixed, typed notification templates;
it does not accept arbitrary notification text or any provider OAuth credential.

## Registration

```mermaid
flowchart LR
  subgraph Phone[Native app and Apple boundary]
    APNS[APNs device token]
    App[Cloudflare OS app]
  end

  subgraph Central[Cloudflare-operated notification service]
    Device[Device registration API]
    Registry[(Device and subscription directory)]
  end

  subgraph Install[One customer CFOS installation]
    Browser[Authenticated Workshop session]
    User[User Durable Object]
    Proxy[notification-proxy]
    ProxyState[(Opaque subscription id)]
    Key[Install signing private key]
  end

  APNS -->|device token| App
  App -->|Dashboard OAuth plus device token| Device
  Device -->|store token; return one-time id| Registry
  Device -->|one-time registration id| App
  App -->|inject opaque id| Browser
  Browser -->|registerNotificationDevice| User
  User -->|account id plus one-time id| Proxy
  Key -->|sign request locally| Proxy
  Proxy -->|signed POST /v1/subscriptions| Device
  Device -->|validate install; consume one-time id| Registry
  Device -->|opaque subscription id| Proxy
  Proxy --> ProxyState
```

Data boundaries:

- The APNs device token and Dashboard OAuth bearer never enter the customer installation.
- The install signing private key never leaves `notification-proxy`.
- Workshop core stores only a random proxy account id; the proxy stores only the opaque central
  subscription id.
- A one-time device registration id is short-lived and cannot send a notification.

## Delivery

```mermaid
flowchart LR
  subgraph Install[One customer CFOS installation]
    Agent[Agent turn]
    User[User Durable Object]
    Browser[Visible browser subscriber]
    Proxy[notification-proxy]
    Key[Install signing private key]
  end

  subgraph Central[Cloudflare-operated notification service]
    Delivery[Typed delivery API]
    Registry[(Device and subscription directory)]
    Audit[(Dedupe, rate limit, audit state)]
  end

  subgraph Apple[Apple and phone boundary]
    APNS[APNs]
    App[Cloudflare OS app]
  end

  Agent -->|completed or needs permission| User
  User -->|visible client first| Browser
  Browser -->|presentation acknowledged| User
  User -->|fallback if no acknowledgement| Proxy
  Key -->|sign request locally| Proxy
  Proxy -->|typed title and same-origin path| Delivery
  Delivery -->|validate install and subscription| Registry
  Delivery --> Audit
  Delivery -->|fixed APNs template| APNS
  APNS --> App
```

Only the event id, event type, bounded chat title, opaque subscription id, and same-origin deep-link
path cross the central boundary during a send. Permission details, chat content, gatekeeper grants,
and provider credentials do not. The browser is attempted first; successful visible presentation
suppresses mobile push.

## Deployment contract

The release manifest classifies `notification-proxy` as a non-installable, preinstalled `system`
worker. The trusted deploy service must inject these values only into that worker:

- `NOTIFICATION_SERVICE_URL`
- `CFOS_INSTALL_ID`
- `CFOS_INSTALL_KEY_ID`
- `CFOS_INSTALL_PRIVATE_KEY`

Self-hosted deployments may omit them. Browser notifications continue to work, while native device
registration reports that push delivery is unavailable.
