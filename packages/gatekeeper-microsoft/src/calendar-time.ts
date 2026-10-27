// Time for calendars. Graph is always asked for UTC (`Prefer: outlook.timezone="UTC"`), so every
// instant read is unambiguous, and agents see times in the user's own zone with its offset written
// out, `2026-10-18T08:00:00-07:00`, the form a model reads and writes most reliably. Mailbox
// settings name Windows zones ("Pacific Standard Time"); `Intl` knows IANA ones, so the CLDR
// mapping below (every zone Graph lists, verified against it) bridges the two.

/** Windows time zone names, as Exchange stores them, to IANA zones (CLDR's windowsZones, territory 001). */
const WINDOWS_ZONES: Record<string, string> = {
  "Dateline Standard Time": "Etc/GMT+12", "UTC-11": "Etc/GMT+11", "Samoa Standard Time": "Pacific/Apia",
  "Aleutian Standard Time": "America/Adak", "Hawaiian Standard Time": "Pacific/Honolulu", "Marquesas Standard Time": "Pacific/Marquesas",
  "Alaskan Standard Time": "America/Anchorage", "UTC-09": "Etc/GMT+9", "British Columbia Standard Time": "America/Vancouver",
  "Yukon Standard Time": "America/Whitehorse", "Pacific Standard Time (Mexico)": "America/Tijuana", "UTC-08": "Etc/GMT+8",
  "Pacific Standard Time": "America/Los_Angeles", "Alberta Standard Time": "America/Edmonton", "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time (Mexico)": "America/Mazatlan", "Mountain Standard Time": "America/Denver",
  "Eastern Standard Time (Mexico)": "America/Cancun", "Manitoba Standard Time": "America/Winnipeg",
  "Central America Standard Time": "America/Guatemala", "Central Standard Time": "America/Chicago",
  "Easter Island Standard Time": "Pacific/Easter", "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina", "SA Pacific Standard Time": "America/Bogota",
  "Eastern Standard Time": "America/New_York", "Haiti Standard Time": "America/Port-au-Prince", "Cuba Standard Time": "America/Havana",
  "US Eastern Standard Time": "America/Indiana/Indianapolis", "Turks And Caicos Standard Time": "America/Grand_Turk",
  "Venezuela Standard Time": "America/Caracas", "Magallanes Standard Time": "America/Punta_Arenas",
  "Paraguay Standard Time": "America/Asuncion", "Atlantic Standard Time": "America/Halifax",
  "Central Brazilian Standard Time": "America/Cuiaba", "SA Western Standard Time": "America/La_Paz",
  "Pacific SA Standard Time": "America/Santiago", "Newfoundland Standard Time": "America/St_Johns",
  "Tocantins Standard Time": "America/Araguaina", "E. South America Standard Time": "America/Sao_Paulo",
  "SA Eastern Standard Time": "America/Cayenne", "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "Greenland Standard Time": "America/Nuuk", "Montevideo Standard Time": "America/Montevideo",
  "Saint Pierre Standard Time": "America/Miquelon", "Bahia Standard Time": "America/Bahia", "UTC-02": "Etc/GMT+2",
  "Mid-Atlantic Standard Time": "Etc/GMT+2", "Azores Standard Time": "Atlantic/Azores", "Cape Verde Standard Time": "Atlantic/Cape_Verde",
  "UTC": "Etc/UTC", "Morocco Standard Time": "Africa/Casablanca", "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik", "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest", "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw", "W. Central Africa Standard Time": "Africa/Lagos",
  "Libya Standard Time": "Africa/Tripoli", "Namibia Standard Time": "Africa/Windhoek", "GTB Standard Time": "Europe/Bucharest",
  "Middle East Standard Time": "Asia/Beirut", "Egypt Standard Time": "Africa/Cairo", "E. Europe Standard Time": "Europe/Chisinau",
  "Syria Standard Time": "Asia/Damascus", "West Bank Standard Time": "Asia/Hebron", "South Africa Standard Time": "Africa/Johannesburg",
  "FLE Standard Time": "Europe/Kyiv", "Israel Standard Time": "Asia/Jerusalem", "South Sudan Standard Time": "Africa/Juba",
  "Kaliningrad Standard Time": "Europe/Kaliningrad", "Sudan Standard Time": "Africa/Khartoum", "Jordan Standard Time": "Asia/Amman",
  "Turkey Standard Time": "Europe/Istanbul", "Belarus Standard Time": "Europe/Minsk", "Arabic Standard Time": "Asia/Baghdad",
  "Arab Standard Time": "Asia/Riyadh", "Russian Standard Time": "Europe/Moscow", "E. Africa Standard Time": "Africa/Nairobi",
  "Volgograd Standard Time": "Europe/Volgograd", "Astrakhan Standard Time": "Europe/Astrakhan", "Russia Time Zone 3": "Europe/Samara",
  "Saratov Standard Time": "Europe/Saratov", "Iran Standard Time": "Asia/Tehran", "Arabian Standard Time": "Asia/Dubai",
  "Azerbaijan Standard Time": "Asia/Baku", "Mauritius Standard Time": "Indian/Mauritius", "Georgian Standard Time": "Asia/Tbilisi",
  "Caucasus Standard Time": "Asia/Yerevan", "Afghanistan Standard Time": "Asia/Kabul", "West Asia Standard Time": "Asia/Tashkent",
  "Qyzylorda Standard Time": "Asia/Qyzylorda", "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "Pakistan Standard Time": "Asia/Karachi", "India Standard Time": "Asia/Kolkata", "Sri Lanka Standard Time": "Asia/Colombo",
  "Nepal Standard Time": "Asia/Kathmandu", "Central Asia Standard Time": "Asia/Almaty", "Bangladesh Standard Time": "Asia/Dhaka",
  "Omsk Standard Time": "Asia/Omsk", "Altai Standard Time": "Asia/Barnaul", "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "Tomsk Standard Time": "Asia/Tomsk", "Myanmar Standard Time": "Asia/Yangon", "SE Asia Standard Time": "Asia/Bangkok",
  "W. Mongolia Standard Time": "Asia/Hovd", "North Asia Standard Time": "Asia/Krasnoyarsk", "China Standard Time": "Asia/Shanghai",
  "North Asia East Standard Time": "Asia/Irkutsk", "Singapore Standard Time": "Asia/Singapore",
  "W. Australia Standard Time": "Australia/Perth", "Taipei Standard Time": "Asia/Taipei", "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
  "Transbaikal Standard Time": "Asia/Chita", "North Korea Standard Time": "Asia/Pyongyang", "Aus Central W. Standard Time": "Australia/Eucla",
  "Tokyo Standard Time": "Asia/Tokyo", "Korea Standard Time": "Asia/Seoul", "Yakutsk Standard Time": "Asia/Yakutsk",
  "Cen. Australia Standard Time": "Australia/Adelaide", "AUS Central Standard Time": "Australia/Darwin",
  "E. Australia Standard Time": "Australia/Brisbane", "AUS Eastern Standard Time": "Australia/Sydney",
  "West Pacific Standard Time": "Pacific/Port_Moresby", "Tasmania Standard Time": "Australia/Hobart",
  "Vladivostok Standard Time": "Asia/Vladivostok", "Bougainville Standard Time": "Pacific/Bougainville",
  "Magadan Standard Time": "Asia/Magadan", "Sakhalin Standard Time": "Asia/Sakhalin", "Lord Howe Standard Time": "Australia/Lord_Howe",
  "Russia Time Zone 10": "Asia/Srednekolymsk", "Norfolk Standard Time": "Pacific/Norfolk",
  "Central Pacific Standard Time": "Pacific/Guadalcanal", "Russia Time Zone 11": "Asia/Kamchatka",
  "New Zealand Standard Time": "Pacific/Auckland", "UTC+12": "Etc/GMT-12", "Fiji Standard Time": "Pacific/Fiji",
  "Kamchatka Standard Time": "Asia/Kamchatka", "Chatham Islands Standard Time": "Pacific/Chatham", "UTC+13": "Etc/GMT-13",
  "Tonga Standard Time": "Pacific/Tongatapu", "Line Islands Standard Time": "Pacific/Kiritimati",
};

/** Whether `Intl` knows an IANA zone. */
function isIanaZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

/**
 * The IANA zone a mailbox's time zone setting names: a Windows name, or already an IANA one (Graph
 * accepts either). Null when it is neither, and the caller then says times are in UTC.
 */
export function ianaZone(setting: string | null | undefined): string | null {
  if (!setting) return null;
  const mapped = WINDOWS_ZONES[setting];
  if (mapped !== undefined) return mapped;
  return isIanaZone(setting) ? setting : null;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of an instant in a zone. */
function wallClock(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let format = formatters.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** A zone's offset from UTC at an instant, in minutes (`-420` for PDT). */
function offsetMinutes(ms: number, zone: string): number {
  const wall = wallClock(ms, zone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** An instant as ISO 8601 in a zone, offset written out: `2026-10-18T08:00:00-07:00`. */
export function isoInZone(ms: number, zone: string): string {
  const wall = wallClock(ms, zone);
  const offset = offsetMinutes(ms, zone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}` +
    (offset === 0 ? "Z" : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`);
}

/** The calendar date of an instant in a zone, `2026-10-18`. */
export function dateInZone(ms: number, zone: string): string {
  const wall = wallClock(ms, zone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** Wall-clock fields as written in local time, `2026-10-18T08:00:00`, with no offset: what Graph writes. */
export function localWallTime(ms: number, zone: string): string {
  return isoInZone(ms, zone).replace(/(Z|[+-]\d\d:\d\d)$/, "");
}

/** Midnight at the start of a date in a zone, as an instant. */
export function startOfDate(date: string, zone: string): number {
  return localToInstant(`${date}T00:00:00`, zone);
}

/**
 * A local wall-clock time in a zone as an instant. In a spring-forward gap the time is moved
 * forward by the gap, as calendars do; in a fall-back overlap the earlier instant is taken.
 */
export function localToInstant(local: string, zone: string): number {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/.exec(local);
  if (!match) throw new TimeError(`"${local}" isn't a local time like 2026-10-18T09:00.`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => (part === undefined ? 0 : Number(part))) as number[];
  const asUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  // The zone's offset half a day either side covers any transition near the time. A candidate is
  // right if it shows the asked-for wall time; both are in an overlap, neither in a gap.
  const before = asUtc - offsetMinutes(asUtc - DAY_MS / 2, zone) * MINUTE_MS;
  const after = asUtc - offsetMinutes(asUtc + DAY_MS / 2, zone) * MINUTE_MS;
  const wanted = localWallTime(asUtc, "UTC");
  const fits = [before, after].filter(candidate => localWallTime(candidate, zone) === wanted);
  return fits.length > 0 ? Math.min(...fits) : before;
}

/** A time an agent passed that can't be read. */
export class TimeError extends Error {}

const ISO_INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:?\d\d)$/i;
const ISO_LOCAL = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/;
const ISO_DATE = /^\d{4}-\d\d-\d\d$/;

/**
 * A time an agent passed, as an instant: ISO 8601 with an offset or `Z`, or a local time (no
 * offset), read in the user's zone. `what` names the field in errors.
 */
export function parseInstant(value: unknown, zone: string, what: string): number {
  if (typeof value !== "string") throw new TimeError(`${what} must be an ISO 8601 time, like 2026-10-18T09:00:00-07:00.`);
  const text = value.trim();
  if (ISO_INSTANT.test(text)) {
    const ms = Date.parse(text.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
    if (Number.isFinite(ms)) return ms;
  } else if (ISO_LOCAL.test(text)) {
    if (validDate(text.slice(0, 10))) return localToInstant(text.length === 16 ? text : text.slice(0, 19), zone);
  } else if (validDate(text)) {
    return startOfDate(text, zone);
  }
  throw new TimeError(`${what} must be an ISO 8601 time, like 2026-10-18T09:00:00-07:00 (or a local time like 2026-10-18T09:00, read in your time zone).`);
}

/** A date an agent passed for an all-day event, `2026-10-18`. */
export function parseDate(value: unknown, what: string): string {
  if (typeof value === "string" && validDate(value.trim())) return value.trim();
  throw new TimeError(`${what} must be a date like 2026-10-18 for an all-day event.`);
}

/** Whether text is a date that exists, written `2026-10-18` (not `2026-02-30`). */
export function validDate(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const back = new Date(Date.UTC(year, month - 1, day));
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day;
}

/** The date `days` after `date` (by default the next day), `2026-10-19`. */
export function nextDate(date: string, days = 1): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** A Graph `dateTimeTimeZone` read in UTC (as every request asks for) as an instant. */
export function graphInstant(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { dateTime, timeZone } = value as { dateTime?: unknown; timeZone?: unknown };
  if (typeof dateTime !== "string") return undefined;
  const trimmed = dateTime.replace(/(\.\d{3})\d+$/, "$1");
  const zoned = /Z|[+-]\d\d:\d\d$/.test(trimmed) ? trimmed : `${trimmed}Z`;
  if (timeZone !== undefined && timeZone !== "UTC" && !/Z|[+-]\d\d:\d\d$/.test(trimmed)) {
    const zone = ianaZone(typeof timeZone === "string" ? timeZone : null);
    if (zone !== null) return localToInstant(trimmed.slice(0, 19), zone);
  }
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : undefined;
}

/** "2 hours", "30 minutes", "1 day": a length of time in words. */
export function durationWords(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  if (minutes > 60) return `${plural(Math.floor(minutes / 60), "hour")} ${plural(minutes % 60, "minute")}`;
  return plural(minutes, "minute");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "Sat, Oct 18, 8:00 AM PDT": an instant the way the approver reads it, in the user's zone. */
export function humanTime(ms: number, zone: string, allDay = false): string {
  return new Intl.DateTimeFormat("en-US", allDay
    ? { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }
    : { timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  ).format(new Date(ms));
}

export { DAY_MS, MINUTE_MS };
