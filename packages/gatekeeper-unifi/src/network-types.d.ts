// UniFi Network: one site on a UniFi console, with its gateway, switches, access points, WiFi
// networks, and connected clients. Depending on what the user granted, this binding is one of:
//
//   - `UnifiNetworkSite`: the whole site.
//   - `UnifiNetworkDevice`: one gateway, switch, or access point on the site, and optionally the
//     clients connected through it.
//   - `UnifiWifiNetwork`: one WiFi network (SSID) on the site.
//   - `UnifiHotspot`: the site's guest hotspot: vouchers and guest access, nothing else.
//
// IDs are opaque strings. Take them from list results and `describe()` rather than constructing
// them. To give a gadget less than a whole site, request a connection to one device, WiFi network,
// or the hotspot, using the `consoleId` and `siteId` from `UnifiNetworkSite.describe()` and the
// item's `id`; call listConnectableResources for the URL patterns.
//
// A console answers a limited number of requests per minute, shared by everything that uses it, so
// don't poll more often than every 10 seconds. A call made over the limit throws an error that
// mentions the rate limit; retry after a short wait. Reported states can trail reality by a few
// seconds.

// ---------------------------------------------------------------------------
// Site

/** The site a binding belongs to. */
export type UnifiSiteInfo = {
  /** Identifies the UniFi console that hosts the site. */
  consoleId: string;
  /** The console's name, e.g. "Dream Machine Pro". */
  consoleName: string;
  /** Site ID. */
  siteId: string;
  /** Site name, e.g. "Default". */
  name: string;
  /** Version of the UniFi Network application on the console, e.g. "10.6.106". */
  networkVersion: string;
};

// ---------------------------------------------------------------------------
// Devices

/** What a UniFi device does on the network. */
export type UnifiDeviceRole = "gateway" | "switch" | "accessPoint";

/**
 * A device's overall state:
 *
 * - `online`: connected to the console and working.
 * - `offline`: not connected to the console.
 * - `starting`: booting, restarting, or applying configuration.
 * - `updating`: installing firmware.
 * - `adopting`: being adopted, or waiting to be.
 * - `disconnected`: running, but its link to the console is interrupted or it is isolated.
 * - `unknown`: any other state.
 */
export type UnifiDeviceState =
  | "online" | "offline" | "starting" | "updating" | "adopting" | "disconnected" | "unknown";

/** A gateway, switch, or access point adopted on the site. */
export type UnifiDevice = {
  /** Device ID. */
  id: string;
  /** Name shown in UniFi Network. */
  name: string;
  /** Model code, e.g. "UHDIW" for an In-Wall HD access point. */
  model: string;
  /** What the device does. A gateway with built-in WiFi or switch ports lists several roles. */
  roles: UnifiDeviceRole[];
  /** Overall state. */
  state: UnifiDeviceState;
  /** MAC address, lowercase and colon-separated. */
  macAddress: string;
  /** The device's own IP address, if known. */
  ipAddress: string | null;
  /** Installed firmware version, if known. */
  firmwareVersion: string | null;
  /** True when newer firmware is available for this device. */
  firmwareUpdateAvailable: boolean;
};

/** PoE power on a switch port. */
export type UnifiPortPoe = {
  /** Whether PoE output is enabled on the port. */
  enabled: boolean;
  /**
   * Whether the port is powering a device right now. `"limited"` means it supplies less power
   * than the device asked for; `null` means unknown.
   */
  supplying: boolean | "limited" | null;
  /** PoE standard: "802.3af", "802.3at", or "802.3bt". */
  standard: string;
};

/** One physical port on a switch or gateway. */
export type UnifiDevicePort = {
  /** Port number as labelled on the device, starting at 1. Pass this to `powerCyclePort()`. */
  index: number;
  /** Link state. */
  state: "up" | "down" | "unknown";
  /** Negotiated link speed in Mbps, or `null` when the link is down. */
  speedMbps: number | null;
  /** Fastest speed the port supports, in Mbps. */
  maxSpeedMbps: number;
  /** Connector type, e.g. "RJ45" or "SFPPLUS". */
  connector: string;
  /** PoE details, or `null` for a port without PoE. */
  poe: UnifiPortPoe | null;
};

/** One WiFi radio on an access point. */
export type UnifiDeviceRadio = {
  /** Band in GHz: 2.4, 5, 6, or 60. */
  frequencyGHz: number;
  /** Current channel, if known. */
  channel: number | null;
  /** Channel width in MHz. */
  channelWidthMHz: number;
  /** WiFi standard, e.g. "802.11ax". */
  standard: string;
};

/** Full details of one device. */
export type UnifiDeviceDetails = UnifiDevice & {
  /** When the device was adopted, if known. */
  adoptedAt: Date | null;
  /** ID of the device this one connects to upstream, or `null` for the gateway. */
  uplinkDeviceId: string | null;
  /** Physical ports; empty for a device without any. */
  ports: UnifiDevicePort[];
  /** WiFi radios; empty for a device without WiFi. */
  radios: UnifiDeviceRadio[];
};

/** A device's latest performance figures. A figure the device doesn't report is `null`. */
export type UnifiDeviceStatistics = {
  /** Time since the device last started, in seconds. */
  uptimeSeconds: number | null;
  /** CPU utilization, 0 to 100. */
  cpuPercent: number | null;
  /** Memory utilization, 0 to 100. */
  memoryPercent: number | null;
  /** Current receive rate on the device's uplink, in bits per second. */
  uplinkRxBitsPerSecond: number | null;
  /** Current transmit rate on the device's uplink, in bits per second. */
  uplinkTxBitsPerSecond: number | null;
  /** Share of WiFi transmissions that had to be retried, per radio. */
  radios: { frequencyGHz: number; txRetriesPercent: number | null }[];
  /** When the console last heard from the device. */
  lastSeenAt: Date | null;
};

// ---------------------------------------------------------------------------
// Clients

/** How a client is connected. `"teleport"` is UniFi's built-in remote-access VPN. */
export type UnifiClientType = "wired" | "wireless" | "vpn" | "teleport";

/** A guest client's access, as reported in client lists. */
export type UnifiGuestStatus = {
  /** Whether the guest may use the network right now. */
  authorized: boolean;
};

/** A client connected to the site right now: a phone, laptop, TV, VPN connection, and so on. */
export type UnifiClient = {
  /** Client ID. */
  id: string;
  /** Name shown in UniFi Network. */
  name: string;
  /** How it is connected. */
  type: UnifiClientType;
  /** IP address, if known. */
  ipAddress: string | null;
  /** MAC address, lowercase and colon-separated; `null` for VPN clients. */
  macAddress: string | null;
  /** When it connected, if known. */
  connectedAt: Date | null;
  /** ID of the access point or switch it connects through, if known. */
  uplinkDeviceId: string | null;
  /**
   * For a client on a guest network with a guest portal, its access; `null` for other clients.
   * `getClient()` and `UnifiHotspot.getGuest()` return the access in full.
   */
  guest: UnifiGuestStatus | null;
};

/** A guest client's network access, in full. */
export type UnifiGuestAuthorization = UnifiGuestStatus & {
  /** How access was granted, if it was. */
  method: "voucher" | "api" | "other" | null;
  /** When access was granted. */
  authorizedAt: Date | null;
  /** When access ends. */
  expiresAt: Date | null;
  /** Data allowance in megabytes, or `null` for no limit. */
  dataLimitMB: number | null;
  /** Download speed limit in kilobits per second, or `null` for no limit. */
  downloadLimitKbps: number | null;
  /** Upload speed limit in kilobits per second, or `null` for no limit. */
  uploadLimitKbps: number | null;
  /** Bytes transferred since access was granted, if known. */
  bytesUsed: number | null;
};

/** One connected client, with a guest's access in full. */
export type UnifiClientDetails = Omit<UnifiClient, "guest"> & {
  /** For a guest client, its access in full; `null` for other clients. */
  guest: UnifiGuestAuthorization | null;
};

/**
 * Limits for `authorizeGuest()`. Without `durationMinutes` the site's default guest duration
 * applies; an omitted data or speed limit means no limit.
 */
export type UnifiGuestLimits = {
  /** How long the guest may use the network, in minutes. */
  durationMinutes?: number;
  /** Data allowance in megabytes, from 1 to 1048576. */
  dataLimitMB?: number;
  /** Download speed limit in kilobits per second, from 2 to 100000. */
  downloadLimitKbps?: number;
  /** Upload speed limit in kilobits per second, from 2 to 100000. */
  uploadLimitKbps?: number;
};

// ---------------------------------------------------------------------------
// Networks and WiFi

/** A network (VLAN) defined on the site. */
export type UnifiLanNetwork = {
  /** Network ID. */
  id: string;
  /** Network name. */
  name: string;
  /** VLAN ID; 1 for the default network. */
  vlanId: number;
  /** Whether the network is enabled. */
  enabled: boolean;
  /** True for the site's default network. */
  isDefault: boolean;
  /** What routes the network: the gateway, a layer-3 switch, or neither. */
  managedBy: "gateway" | "switch" | "unmanaged";
};

/** How a WiFi network authenticates devices. The enterprise types sign in each user via RADIUS. */
export type UnifiWifiSecurity =
  | "open"
  | "wpa2"
  | "wpa3"
  | "wpa2/wpa3"
  | "wpa2-enterprise"
  | "wpa3-enterprise"
  | "wpa2/wpa3-enterprise";

/** A WiFi network (SSID) on the site, as listed. */
export type UnifiWifiNetworkSummary = {
  /** WiFi network ID. */
  id: string;
  /** The network name (SSID) that devices see. */
  name: string;
  /** Whether the network is being broadcast. */
  enabled: boolean;
  /** How devices authenticate. */
  security: UnifiWifiSecurity;
  /** Bands it is broadcast on, in GHz. */
  frequenciesGHz: number[];
  /** ID of the network (VLAN) its clients join, or `null` for the default network. */
  networkId: string | null;
  /** True for a guest network whose clients sign in through a guest portal. */
  guestPortal: boolean;
  /** `"iot"` for a network tuned for smart-home devices. */
  kind: "standard" | "iot";
};

/** A WiFi network's settings. */
export type UnifiWifiNetworkInfo = UnifiWifiNetworkSummary & {
  /** Whether the name is hidden from WiFi scans. */
  hidden: boolean;
  /** Whether clients on this network are blocked from reaching each other. */
  clientIsolation: boolean;
};

/** Changes for `UnifiWifiNetwork.update()`. Omitted fields are left as they are. */
export type UnifiWifiNetworkChanges = {
  /** New network name (SSID). Devices treat a renamed network as a new one and must rejoin it. */
  name?: string;
  /** Turn broadcasting on or off. */
  enabled?: boolean;
  /** Hide the name from WiFi scans, or show it. */
  hidden?: boolean;
  /**
   * New password, 8 to 63 characters. Only for networks whose security is `wpa2`, `wpa3`, or
   * `wpa2/wpa3`. Devices that saved the old password can't reconnect until given the new one.
   */
  passphrase?: string;
};

// ---------------------------------------------------------------------------
// Hotspot vouchers

/** A hotspot voucher: a code a guest enters in the guest portal to get online. */
export type UnifiVoucher = {
  /** Voucher ID. */
  id: string;
  /** The code a guest enters, or `null` until the console has issued it. */
  code: string | null;
  /** The note given when the voucher was created; vouchers created together share it. */
  note: string;
  /** When the voucher was created. */
  createdAt: Date;
  /** When a guest first used it, or `null` if unused. */
  activatedAt: Date | null;
  /** When it stops working, if that time is known. */
  expiresAt: Date | null;
  /** True once it can no longer be used. */
  expired: boolean;
  /** How long it grants access, in minutes, counted from first use. */
  durationMinutes: number;
  /** How many different guests may use it, or `null` for no limit. */
  guestLimit: number | null;
  /** How many guests have used it. */
  guestCount: number;
  /** Data allowance per guest in megabytes, or `null` for no limit. */
  dataLimitMB: number | null;
  /** Download speed limit in kilobits per second, or `null` for no limit. */
  downloadLimitKbps: number | null;
  /** Upload speed limit in kilobits per second, or `null` for no limit. */
  uploadLimitKbps: number | null;
};

/** Options for `createVouchers()`. Omitted data and speed limits mean no limit. */
export type UnifiVoucherOptions = {
  /** How many vouchers to create, from 1 to 100. Defaults to 1. */
  count?: number;
  /** A note attached to every voucher created, e.g. "Saturday party". */
  note: string;
  /** How long each voucher grants access once first used, in minutes. */
  durationMinutes: number;
  /** How many different guests may use each voucher. Defaults to 1; `null` allows any number. */
  guestLimit?: number | null;
  /** Data allowance per guest in megabytes, from 1 to 1048576. */
  dataLimitMB?: number;
  /** Download speed limit in kilobits per second, from 2 to 100000. */
  downloadLimitKbps?: number;
  /** Upload speed limit in kilobits per second, from 2 to 100000. */
  uploadLimitKbps?: number;
};

// ---------------------------------------------------------------------------
// Capabilities

/** One site on a UniFi console. */
export interface UnifiNetworkSite {
  /** Returns the site's name and IDs, and the console that hosts it. */
  describe(): Promise<UnifiSiteInfo>;

  /** Lists the site's adopted devices, up to 1,000. */
  listDevices(): Promise<UnifiDevice[]>;

  /** Returns a capability for one device on the site. Fetches nothing until used. */
  getDevice(deviceId: string): UnifiNetworkDevice;

  /** Lists the clients connected to the site right now, up to 1,000. */
  listClients(): Promise<UnifiClient[]>;

  /** Returns one connected client, with its guest access. Throws if it isn't connected. */
  getClient(clientId: string): Promise<UnifiClientDetails>;

  /** Lists the site's networks (VLANs). */
  listNetworks(): Promise<UnifiLanNetwork[]>;

  /**
   * Lists the site's WiFi networks. Their passwords and full settings are not included; see
   * `getWifiNetwork()`.
   */
  listWifiNetworks(): Promise<UnifiWifiNetworkSummary[]>;

  /** Returns a capability for one WiFi network on the site. Fetches nothing until used. */
  getWifiNetwork(wifiNetworkId: string): UnifiWifiNetwork;

  /** Returns the site's guest hotspot: vouchers and guest access. Fetches nothing until used. */
  getHotspot(): UnifiHotspot;
}

/** One gateway, switch, or access point. */
export interface UnifiNetworkDevice {
  /** Returns the device's details, including its ports and radios. */
  describe(): Promise<UnifiDeviceDetails>;

  /** Returns the device's latest uptime, CPU, memory, and traffic figures. */
  getStatistics(): Promise<UnifiDeviceStatistics>;

  /**
   * Lists the clients connected through this device right now. A connection to just this device
   * includes its clients only if the user allowed that when connecting it; otherwise this throws.
   */
  listClients(): Promise<UnifiClient[]>;

  /**
   * Restarts the device. It is offline for a minute or two while it restarts; restarting the
   * gateway takes the whole network and its internet connection down meanwhile.
   */
  restart(): Promise<void>;

  /**
   * Turns PoE power on one port off and back on, restarting whatever the port powers (a camera,
   * an access point, and so on). Throws if the port has no PoE or PoE is turned off on it.
   */
  powerCyclePort(portIndex: number): Promise<void>;
}

/** One WiFi network (SSID). */
export interface UnifiWifiNetwork {
  /** Returns the network's settings, without its password. */
  describe(): Promise<UnifiWifiNetworkInfo>;

  /**
   * Returns the WiFi password, or `null` for a network without a shared password (open or
   * enterprise security).
   */
  getPassphrase(): Promise<string | null>;

  /**
   * Changes the network's name, password, visibility, or whether it is broadcast.
   *
   * @example
   * await env.GUEST_WIFI.update({ passphrase: "correct-horse-battery" });
   */
  update(changes: UnifiWifiNetworkChanges): Promise<void>;
}

/**
 * A site's guest hotspot: the vouchers guests use to sign in to the guest portal, and the access
 * of guest clients. It reveals nothing about the site's other clients or its devices.
 */
export interface UnifiHotspot {
  /** Lists the guest clients connected right now, up to 1,000. */
  listGuests(): Promise<UnifiClient[]>;

  /**
   * Returns one connected guest client, with its access in full: when it expires, its limits, and
   * its usage. Throws if the client isn't connected or isn't a guest.
   */
  getGuest(clientId: string): Promise<UnifiClientDetails>;

  /**
   * Lets a guest client use the network, replacing any access it already has and resetting its
   * usage. Throws if the client is not a guest.
   */
  authorizeGuest(clientId: string, limits?: UnifiGuestLimits): Promise<void>;

  /** Ends a guest client's access to the network. Throws if the client is not a guest. */
  revokeGuest(clientId: string): Promise<void>;

  /** Lists the vouchers, newest first, up to 1,000, including expired ones. */
  listVouchers(): Promise<UnifiVoucher[]>;

  /**
   * Creates vouchers. They are listed by `listVouchers()` right away; each one's `code` is `null`
   * until the console issues it.
   *
   * @example
   * await env.GUEST_HOTSPOT.createVouchers({ note: "Grandma's visit", durationMinutes: 3 * 24 * 60 });
   */
  createVouchers(options: UnifiVoucherOptions): Promise<void>;

  /** Deletes a voucher so it can no longer be used. */
  deleteVoucher(voucherId: string): Promise<void>;
}
