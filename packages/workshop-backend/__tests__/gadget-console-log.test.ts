import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH, MAX_GADGET_CONSOLE_LOGS_PER_CALL,
  MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH, droppedGadgetConsoleLogsText,
  type ConsoleLogEvent, type ReportedGadgetConsoleLog,
} from "@gadgets/workshop-shared/api";
import {
  GADGET_CONSOLE_LOG_BYTES_PER_REQUEST, GADGET_CONSOLE_LOGS_PER_MINUTE, GadgetConsoleLogLimiter,
  clientGadgetConsoleLogEntry, gadgetConsoleLogText, isGadgetConsoleLogRecordingEnabled,
  redactGadgetConsoleLogText, serverGadgetConsoleLogEntry, writeClientGadgetConsoleLogs,
  writeServerGadgetConsoleLogs,
} from "../src/gadget-console-log.js";

// Filler of `n` characters in which no run of token characters is long.
const words = (n: number) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);

// A fixture in a credential's format is joined from pieces when the test runs, so that this file holds none whole:
// a secret scanner reads the source, not the value.
const assemble = (...fragments: string[]) => fragments.join("");
const pemEdge = (edge: "BEGIN" | "END", label = "PRIVATE KEY") => assemble("-----", edge, " ", label, "-----");

const credential = "AbCdEf0123456789AbCdEf";
const bearer = "Bearer " + credential;
const basicCredential = "dXNlcjpwYXNzd29yZDEyMzQ=";
const sk = assemble("sk", "-proj-", "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz");
const jwtHeader = "eyJhbGciOiJIUzI1NiJ9";
const jwt = assemble(
  jwtHeader, ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".",
  "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
// A directly encrypted token: its header, an empty key segment, then the IV, the ciphertext and
// the tag.
const directJwe = assemble(
  "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0", "..", "IvIvIvIvIvIvIvIv", ".", "Ct0_".repeat(12), ".",
  "TagTagTagTagTagTagTagA");
const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";

// A PEM block: its BEGIN line, a body and its END line, separated by `newline`.
const pemBlock = (label = "PRIVATE KEY", body = pemBody, newline = "\n") =>
  pemEdge("BEGIN", label) + newline + body + newline + pemEdge("END", label);
// What redaction leaves of a PEM block: its two lines around the placeholder.
const redactedPemBlock = (label = "PRIVATE KEY") =>
  pemEdge("BEGIN", label) + "[redacted]" + pemEdge("END", label);

// A private key of 1,847 characters, each of its 26 lines marked "Zq" and two digits.
const longPemLine = (i: number) => "Zq" + String(i).padStart(2, "0") + pemBody + "VJTUt9Us8cKj";
const longPem = (newline = "\n") =>
  pemBlock("PRIVATE KEY", Array.from({ length: 26 }, (_, i) => longPemLine(i)).join(newline),
      newline);

// A text and what redaction makes of it.
type Case = readonly [text: string, redacted: string];

// What the backstop replaces, by shape.
const CAUGHT: Record<string, Case[]> = {
  "bearer and basic credentials": [
    [assemble("Authorization: Bearer ", "abcDEF123456_-.~+/=xyz7890"),
      "Authorization: Bearer [redacted]"],
    [assemble("authorization: bearer   ", "abcdef0123456789abcdef"),
      "authorization: bearer   [redacted]"],
    ['{"h":"' + bearer + '"}', '{"h":"Bearer [redacted]"}'],
    ["Authorization: Basic " + basicCredential, "Authorization: Basic [redacted]"],
    // The shortest credential that is taken: 16 characters. One fewer is not caught (below).
    ["Bearer " + credential.slice(0, 16), "Bearer [redacted]"],
  ],

  "JSON Web Tokens": [
    [jwt, "[redacted]"],
    // Two segments, the second cut short.
    [jwtHeader + ".eyJzdWIi", "[redacted]"],
    ["value=" + jwt, "value=[redacted]"],
    ["id_" + jwtHeader + ".eyJzdWIi", "id_[redacted]"],
    ['"' + jwt + '"', '"[redacted]"'],
    ["a." + jwtHeader + " b", "a.[redacted] b"],
    ["Bearer%20" + jwtHeader + ".eyJzdWIi", "Bearer%20[redacted]"],
    ["https://app.example/cb?next=%2Fdone%3Fjwt%3D" + jwtHeader + ".eyJzdWIiOiIxIn0.abc&x=1",
      "https://app.example/cb?next=%2Fdone%3Fjwt%3D[redacted]&x=1"],
    // The shortest run that is taken: 8 characters after "eyJ". One fewer is left alone (below).
    [jwtHeader.slice(0, 11), "[redacted]"],
    // Five segments at most are one token, as an encrypted one has: a sixth is left.
    [jwtHeader + ".a.b.c.d.e", "[redacted].e"],
    // A segment may be empty: the key of a directly encrypted token, the payload of a signature
    // that is detached from it.
    ["session cookie " + directJwe, "session cookie [redacted]"],
    ["Set-Cookie: session-token=" + directJwe + "; Path=/",
      "Set-Cookie: session-token=[redacted]; Path=/"],
    ['{"session":"' + directJwe + '"}', '{"session":"[redacted]"}'],
    [jwtHeader + ".." + jwt.slice(-43), "[redacted]"],
  ],

  "keys under an sk prefix": [
    [sk, "[redacted]"],
    ["key " + sk + " used", "key [redacted] used"],
    [assemble("sk", "-ant-api03-", "AbCdEf0123456789AbCdEf_xyz"), "[redacted]"],
    [assemble("sk", "_live_", "51AbCdEf0123456789AbCdEf"), "[redacted]"],
    // The shortest key that is taken: 16 characters after "sk-". One fewer is left alone (below).
    ["sk-" + credential.slice(0, 16), "[redacted]"],
  ],

  // The three patterns for a token known by its shape share one rule for where it may start.
  "a token at the start the token patterns share, after an underscore or an escape": [
    ["x_" + sk, "x_[redacted]"],
    ["auth_" + bearer, "auth_Bearer [redacted]"],
    ["key%3D" + sk, "key%3D[redacted]"],
    ["note%0A" + sk, "note%0A[redacted]"],
    ["Authorization%3A%20" + bearer, "Authorization%3A%20Bearer [redacted]"],
    // JSON text: each escape below is its characters, not the character it stands for.
    [String.raw`{"env":"# keys\n` + sk + '"}', String.raw`{"env":"# keys\n[redacted]"}`],
    [String.raw`{"tsv":"name\t` + sk + '"}', String.raw`{"tsv":"name\t[redacted]"}`],
    [String.raw`{"raw":"A=1\u0000` + sk + '"}', String.raw`{"raw":"A=1\u0000[redacted]"}`],
    [assemble(String.raw`{"page":"p1\fBasic `, basicCredential, '"}'),
      String.raw`{"page":"p1\fBasic [redacted]"}`],
    // The whole token, not only what follows its first dot.
    [String.raw`{"body":"Your token is:\r\n` + jwt + '"}',
      String.raw`{"body":"Your token is:\r\n[redacted]"}`],
  ],

  "the password in a URL": [
    ["https://user:hunter2secret@db.example.com/path",
      "https://user:[redacted]@db.example.com/path"],
    [assemble("postgres://app", ":S3cr3tPassw0rd", "@db.internal:5432/app?sslmode=require"),
      "postgres://app:[redacted]@db.internal:5432/app?sslmode=require"],
    [assemble("redis://", ":p4ss", "@cache:6379"), "redis://:[redacted]@cache:6379"],
    // A password that holds "@" is taken to the last one.
    [assemble("postgres://app", ":p@ssw0rd!", "@db.internal:5432/app"),
      "postgres://app:[redacted]@db.internal:5432/app"],
    ["ftp://anonymous:me@example.com@ftp.example.com/pub",
      "ftp://anonymous:[redacted]@ftp.example.com/pub"],
    [assemble("mongodb://admin", ":Tr0ub4dor&3", "@cluster0.example.net/db"),
      "mongodb://admin:[redacted]@cluster0.example.net/db"],
    [assemble("mongodb+srv://u", ":p%40ss", "@cluster0.x.mongodb.net/db"),
      "mongodb+srv://u:[redacted]@cluster0.x.mongodb.net/db"],
    ["https://token:x-oauth-basic@github.com/o/r.git",
      "https://token:[redacted]@github.com/o/r.git"],
    // A user name that holds "@": an address, or the user@server form of some databases.
    [assemble("smtp://ada@example.com", ":Hunter2Secret9", "@smtp.example.com:587"),
      "smtp://ada@example.com:[redacted]@smtp.example.com:587"],
    [assemble("imaps://ada@example.com", ":p@ss!", "@imap.example.com/INBOX"),
      "imaps://ada@example.com:[redacted]@imap.example.com/INBOX"],
    [assemble('{"url":"postgres://app@myserver', ":Hunter2Secret9", '@myserver.example:5432/db"}'),
      '{"url":"postgres://app@myserver:[redacted]@myserver.example:5432/db"}'],
    // Inside compact JSON the password ends with its string.
    [assemble('{"dsn":"postgres://app', ":pw", '@db","other":"x@y"}'),
      '{"dsn":"postgres://app:[redacted]@db","other":"x@y"}'],
    [assemble('{"dsn":"postgres://app', ":p@ss", '@db.internal:5432","n":1}'),
      '{"dsn":"postgres://app:[redacted]@db.internal:5432","n":1}'],
  ],

  "PEM private keys": [
    [pemBlock("RSA PRIVATE KEY"), redactedPemBlock("RSA PRIVATE KEY")],
    ["x " + pemBlock() + "\n y", "x " + redactedPemBlock() + "\n y"],
    [pemBlock("PGP PRIVATE KEY BLOCK", "\nlQOYBF"), redactedPemBlock("PGP PRIVATE KEY BLOCK")],
    // A label that holds a digit.
    [pemBlock("ED25519 PRIVATE KEY", "AAAAC3NzaC1lZDI1NTE5"),
      redactedPemBlock("ED25519 PRIVATE KEY")],
    // CRLF line endings.
    [pemBlock("ENCRYPTED PRIVATE KEY", "MIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQww", "\r\n") +
        "\r\n",
      redactedPemBlock("ENCRYPTED PRIVATE KEY") + "\r\n"],
    // No END line: replaced to the end of the text.
    ["key: " + pemEdge("BEGIN", "OPENSSH PRIVATE KEY") + "\nb3BlbnNzaC1rZXktdjEAAAAA and more",
      "key: " + pemEdge("BEGIN", "OPENSSH PRIVATE KEY") + "[redacted]"],
    [pemBlock("EC PRIVATE KEY") + " between " + pemBlock() + " z",
      redactedPemBlock("EC PRIVATE KEY") + " between " + redactedPemBlock() + " z"],
    // Newlines as JSON escapes: two characters each.
    ['{"pem":"' + pemBlock("PRIVATE KEY", pemBody, String.raw`\n`) + String.raw`\n"}`,
      '{"pem":"' + redactedPemBlock() + String.raw`\n"}`],
    ['{"type":"service_account","private_key_id":"abc123","private_key":"' +
        pemBlock("PRIVATE KEY", pemBody, String.raw`\n`) + String.raw`\n","client_email":"a@b"}`,
      '{"type":"service_account","private_key_id":"abc123","private_key":"[redacted]",' +
        '"client_email":"a@b"}'],
  ],

  "URL parameters named like a secret": [
    ["https://app.example/cb?code=4/0AbCdEf&state=xyz",
      "https://app.example/cb?code=[redacted]&state=xyz"],
    ["https://api.example/v1?access_token=abc123&x=1",
      "https://api.example/v1?access_token=[redacted]&x=1"],
    ["https://api.example/token?grant=a&client_secret=s3cr3t&x=1",
      "https://api.example/token?grant=a&client_secret=[redacted]&x=1"],
    ["https://app.example/#id_token=abc.def&state=xyz",
      "https://app.example/#id_token=[redacted]&state=xyz"],
    ["/v1?apiKey=k1&api_key=k2&x=1", "/v1?apiKey=[redacted]&api_key=[redacted]&x=1"],
    ["https://bucket.example/o?X-Amz-Signature=abcdef&X-Amz-Credential=id%2F20260101&x=1",
      "https://bucket.example/o?X-Amz-Signature=[redacted]&X-Amz-Credential=[redacted]&x=1"],
    ["https://blob.example/c?sig=abc%3D&sv=2020&x=1",
      "https://blob.example/c?sig=[redacted]&sv=2020&x=1"],
    ['<a href="/cb?a=1&amp;token=abc&amp;x=1">', '<a href="/cb?a=1&amp;token=[redacted]&amp;x=1">'],
    ["/login?password=hunter2&x=1", "/login?password=[redacted]&x=1"],
    ["/v1?a=1&subscription-key=abc&sessionid=s1&x=1",
      "/v1?a=1&subscription-key=[redacted]&sessionid=[redacted]&x=1"],
    ["/v1?secretKey=a&privateKey=b&accessKey=c&x=1",
      "/v1?secretKey=[redacted]&privateKey=[redacted]&accessKey=[redacted]&x=1"],
    // The other short names that carry a secret, and a password's short spelling.
    ["/cb?auth=abc&jwt=def&pwd=ghi&passwd=jkl&x=1",
      "/cb?auth=[redacted]&jwt=[redacted]&pwd=[redacted]&passwd=[redacted]&x=1"],
    // A value that holds an apostrophe, which encodeURIComponent() leaves as it is.
    ["https://api.example.com/login?user=ada&password=" + encodeURIComponent("it's-My-Pa55word") +
        "&remember=1",
      "https://api.example.com/login?user=ada&password=[redacted]&remember=1"],
    ["/cb?access_token=AbC'dEf0123456789", "/cb?access_token=[redacted]"],
  ],

  // The value ends before an "&", a "#", a double quote, an angle bracket or a space, so that
  // what follows the URL is kept. Were it to run through a double quote, a URL in a JSON string
  // would take the members after it.
  "no more than a URL parameter's value": [
    ["/cb?code=abc#frag", "/cb?code=[redacted]#frag"],
    ['{"url":"https://x.example/cb?code=abc","n":1}',
      '{"url":"https://x.example/cb?code=[redacted]","n":1}'],
    ["<td>/cb?code=abc</td>", "<td>/cb?code=[redacted]</td>"],
    ["see <https://x.example/cb?code=abc> and <b>x</b>",
      "see <https://x.example/cb?code=[redacted]> and <b>x</b>"],
    ["GET /cb?code=abc failed", "GET /cb?code=[redacted] failed"],
  ],

  "JSON members named like a secret": [
    ['{"access_token":"ya29.a0AfH6SMB","expires_in":3599,"refresh_token":"1//0gabc"}',
      '{"access_token":"[redacted]","expires_in":3599,"refresh_token":"[redacted]"}'],
    ['{"apiKey": "abc123", "password":"hunter2","clientSecret":"s"}',
      '{"apiKey": "[redacted]", "password":"[redacted]","clientSecret":"[redacted]"}'],
    ['{"Authorization":"Token abc"}', '{"Authorization":"[redacted]"}'],
    ['{"set-cookie":"sid=AbCdEf0123456789; Path=/"}', '{"set-cookie":"[redacted]"}'],
    [assemble('{"Proxy-Authorization":"Basic ', basicCredential, '"}'),
      '{"Proxy-Authorization":"[redacted]"}'],
    ['{"cookie":"a=1","Cookie":"b=2"}', '{"cookie":"[redacted]","Cookie":"[redacted]"}'],
    ['{"AccessKeyId":"example-key-id","SecretAccessKey":"example-secret-access-key",' +
        '"SessionToken":"example-session-token"}',
      '{"AccessKeyId":"example-key-id","SecretAccessKey":"[redacted]",' +
        '"SessionToken":"[redacted]"}'],
    ['{"secret_key":"s","privateKey":"p","private_key_id":"id1","api-key":"k",' +
        '"aws_secret_access_key":"w"}',
      '{"secret_key":"[redacted]","privateKey":"[redacted]","private_key_id":"id1",' +
        '"api-key":"[redacted]","aws_secret_access_key":"[redacted]"}'],
  ],

  // The value is taken through its escapes, to its closing quote.
  "a JSON member's value that holds escapes": [
    [String.raw`{"password":"ab\"cd-secret-tail","n":1}`, '{"password":"[redacted]","n":1}'],
    [String.raw`{"password":"p\\ath-secret-tail","n":1}`, '{"password":"[redacted]","n":1}'],
    [String.raw`{"password":"secret-tail\\","n":1}`, '{"password":"[redacted]","n":1}'],
    [String.raw`{"token":"{\"a\":1}","n":2}`, '{"token":"[redacted]","n":2}'],
  ],

  "JSON inside a JSON string": [
    [String.raw`{"body":"{\"access_token\":\"ya29.abc\",\"n\":1}"}`,
      String.raw`{"body":"{\"access_token\":\"[redacted]\",\"n\":1}"}`],
    [String.raw`{"body":"{\"set-cookie\":\"sid=abc; Path=/\",\"n\":1}"}`,
      String.raw`{"body":"{\"set-cookie\":\"[redacted]\",\"n\":1}"}`],
    // One level deeper: three backslashes before each inner quote.
    [String.raw`{"a":"{\"b\":\"{\\\"api_key\\\":\\\"k-123\\\",\\\"n\\\":1}\"}"}`,
      String.raw`{"a":"{\"b\":\"{\\\"api_key\\\":\\\"[redacted]\\\",\\\"n\\\":1}\"}"}`],
    // A value that holds a quote, starts with one, or starts or ends with a backslash, is taken
    // through its escapes to its closing quote, which follows one backslash as its opening one
    // does.
    [String.raw`{"body":"{\"password\":\"first\\\"second-secret-tail\",\"n\":1}"}`,
      String.raw`{"body":"{\"password\":\"[redacted]\",\"n\":1}"}`],
    [String.raw`{"body":"{\"password\":\"\\\"whole-secret\",\"n\":1}"}`,
      String.raw`{"body":"{\"password\":\"[redacted]\",\"n\":1}"}`],
    [String.raw`{"body":"{\"password\":\"\\\\whole-secret\",\"n\":1}"}`,
      String.raw`{"body":"{\"password\":\"[redacted]\",\"n\":1}"}`],
    [String.raw`{"body":"{\"password\":\"secret-tail\\\\\",\"n\":1}"}`,
      String.raw`{"body":"{\"password\":\"[redacted]\",\"n\":1}"}`],
  ],

  "several shapes in one text": [
    [String.raw`fetch https://svc:Tr0ub4dor@api.example.com/v1?api_key=K9&x=1 failed: ` +
        String.raw`{"error":"bad","refresh_token":"1//0g\"x"}`,
      "fetch https://svc:[redacted]@api.example.com/v1?api_key=[redacted]&x=1 failed: " +
        '{"error":"bad","refresh_token":"[redacted]"}'],
    // A token at the very start and at the very end.
    [sk + " middle " + jwt, "[redacted] middle [redacted]"],
  ],
};

// Text that only resembles a credential, and comes back as it went in.
const LEFT_ALONE: string[] = [
  "the bearer of bad news",
  "the bearer responsibilities are many",
  "send it as a Bearer token",
  "uses Bearer authentication",
  "Basic troubleshooting-guidelines",
  "a basic understanding-of-things",
  "risk-based task-force sk-short",
  "sk_buff_head_init_function",
  "sk-learn-contrib-imbalanced-ensemble",
  "task-force sk_test_fixture_value_one",
  "task-force-Committee2024",
  "desk-lamp-Model2024-edition-x",
  "?keyword=cats&page=2&design=dark&zipcode=90210&monkey=1",
  "x;code=obj.code;auth=true",
  "eyJ",
  "a=b?c&d",
  '{"tokens":5,"max_tokens":100,"tokenType":"Bearer","key":"row-1","code":"E42"}',
  "https://example.com:8080/a@b",
  "http://localhost:3000 or mail me@x.y",
  "ssh://git@github.com/o/r.git",
  "ssh://git@github.com:o/r.git",
  "ssh://git@github.com:22/o/r.git",
  "http://[::1]:8080/@",
  "see https://host:8080/path and x@y.z",
  "time is 12:30 @home",
  "https://a.b/c?d=e@f",
  // One character short of the shortest key and of the shortest base64 run that are taken.
  "sk-" + credential.slice(0, 15),
  jwtHeader.slice(0, 10),
  // Compact JSON in which a URL is followed by an address, the first once more with every quote
  // escaped, as JSON inside a JSON string.
  '{"url":"https://example.com","email":"ada@example.com"}',
  '{"url":"http://localhost:8787","email":"a@b.c"}',
  '{"apiBase":"https://api.example.com:8443","contact":"ops@example.com"}',
  '{"apiBase":"https://ada@api.example.com:8443","contact":"ops@example.com"}',
  String.raw`{\"url\":\"https://example.com\",\"email\":\"ada@example.com\"}`,
  // Identifiers that merely contain "eyJ".
  "keyJoinColumns",
  "surveyJsonResponse failed",
  "const moneyJarBalance = 5",
  "hockeyJerseyNumber",
  "obj.keyJsonSchemaValidator()",
  "100%25keyJoinColumns",
  "%20keyJoinColumns",
  // The same kinds of word after an escape that is not directly before them. In the last, a
  // backslash and a "t" are followed by "ask".
  String.raw`a\nkeyJoinColumns`,
  String.raw`first line\nbasic understanding-of-things`,
  String.raw`\networks\task-force-Committee2024`,
  // JSON members whose names only resemble a secret's.
  '{"cookie_banner":"shown","tokenizer":"gpt","secretary":"Ann","password_hint":"pet"}',
  '{"signature_algorithm":"RS256","credentials_included":"same-origin"}',
  '{"key":"row-1","sort_key":"name","keyboard":"us","monkey":"1","private_key_id":"id1",' +
      '"AccessKeyId":"example-key-id"}',
  // PEM that is no private key.
  pemBlock("CERTIFICATE", "MIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBa"),
  pemBlock("PUBLIC KEY", "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"),
  "a private key is expected here",
  // A private key's BEGIN line with no dashes after it.
  assemble("-----", "BEGIN PRIVATE KEY"),
];

// The backstop errs towards redacting: none of these is a credential, and each is replaced all
// the same, which is accepted. The docs describe each kind.
const ACCEPTED: Case[] = [
  // URL parameters named, or ending after a separator in, key, code, sig, auth, pwd or session.
  ["status?code=200", "status?code=[redacted]"],
  ["?promo_code=SAVE10", "?promo_code=[redacted]"],
  ["GET /search?zip_code=90210&country_code=US&sort_key=name&error_code=404",
    "GET /search?zip_code=[redacted]&country_code=[redacted]&sort_key=[redacted]" +
      "&error_code=[redacted]"],
  ["?primary_key=5&cache_key=v2", "?primary_key=[redacted]&cache_key=[redacted]"],
  ["#section-code=intro", "#section-code=[redacted]"],
  ["x?session=abc&author=me&design=1", "x?session=[redacted]&author=me&design=1"],
  ["/run?auth=none&pwd=/srv/app", "/run?auth=[redacted]&pwd=[redacted]"],
  // A word of 16 or more characters holding a capital or a digit, after "basic" or "bearer" or
  // glued to "sk-".
  [assemble("Basic ", "JavaScriptFundamentals"), "Basic [redacted]"],
  [assemble("bearer ", "TokenAuthenticationFilter rejected"), "bearer [redacted] rejected"],
  ["sk-learn-contrib-Imbalanced", "[redacted]"],
  // The same after an underscore or an escape: in the path, a backslash and an "n" read as the
  // escape of a line break.
  [assemble("http_basic ", "JavaScriptFundamentals"), "http_basic [redacted]"],
  [String.raw`C:\tools\nsk-toolkit-V2-installer-x64`, String.raw`C:\tools\n[redacted]`],
  // A port, or a colon after a URL, followed by an "@" with no space, slash or double quote
  // between.
  ["https://cdn.example.com:443;foo@bar", "https://cdn.example.com:[redacted]@bar"],
  ["http://h:80,x@y", "http://h:[redacted]@y"],
  ["http://ada@h:80,x@y", "http://ada@h:[redacted]@y"],
  ["see https://example.com,then:mail@x.y", "see https://example.com,then:[redacted]@x.y"],
  // The apostrophe that closes a URL ending in such a parameter, and what is glued to it.
  ["<a href='/cb?code=abc'>x</a>", "<a href='/cb?code=[redacted]>x</a>"],
  ["fetch('/cb?code=abc').catch(report) failed", "fetch('/cb?code=[redacted] failed"],
  // The full stop after a JSON Web Token, read as an empty segment of it.
  ["got " + jwt + ". Retrying", "got [redacted] Retrying"],
  // JSON members whose names end like a secret's.
  ['{"nextPageToken":"CAESBQ"}', '{"nextPageToken":"[redacted]"}'],
  ['{"accessKey":"example-access-key"}', '{"accessKey":"[redacted]"}'],
  // A base64 JSON object that is no JSON Web Token.
  ["eyJhIjoxLCJiIjoyfQ", "[redacted]"],
  // Whatever follows a private key's BEGIN line that no END line follows.
  ["expected " + pemEdge("BEGIN") + " and then the rest of the line",
    "expected " + pemEdge("BEGIN") + "[redacted]"],
];

// What the backstop misses. The docs list each kind here, and a change that starts catching one
// updates both. A string comes back unchanged; a pair gives what is left of its text.
const NOT_CAUGHT: (string | Case)[] = [
  // A name and a value outside a URL query and outside JSON.
  "api_key=AbCdEf0123456789",
  "token: " + credential,
  "password=correcthorsebatterystaple",
  "curl -u admin:Sup3rS3cret https://api.example.com",
  // Header lines.
  "X-Api-Key: " + credential,
  "Set-Cookie: sid=AbCdEf0123456789; Path=/",
  // A bearer or basic credential under 16 characters, the first by one, or all lower-case
  // letters, or whose space is encoded, as "%20" or as the "+" of a submitted form.
  "Bearer " + credential.slice(0, 15),
  "Bearer abc123XYZ789",
  assemble("Authorization: Basic ", "dXNlcjpwYXNz"),
  assemble("Authorization: bearer ", "abcdefghijklmnopqrstuvwxyz"),
  "Bearer%20" + credential,
  "Authorization=Bearer+" + credential,
  // A token directly after a letter or a digit.
  "Token" + jwtHeader + ".eyJzdWIi",
  "v2" + jwtHeader + ".eyJzdWIi",
  "task" + sk,
  "v2" + sk,
  "X" + bearer,
  // A key after an ANSI colour code, which ends in a letter.
  "\u001b[31m" + sk + "\u001b[0m",
  // After a separator that was percent-encoded twice, a token follows the letters and digits of
  // the inner escape and not an escape.
  "key%253D" + sk,
  "Authorization%253A%2520Bearer%2520" + credential,
  // A token broken across lines, of which only the part before the break is replaced: a wrapped
  // JSON Web Token keeps the rest of its payload and its whole signature.
  [jwt.slice(0, 30) + "\n" + jwt.slice(30), "[redacted]\n" + jwt.slice(30)],
  [sk.slice(0, 26) + "\n" + sk.slice(26), "[redacted]\n" + sk.slice(26)],
  // A URL password holding a raw "/", "#", "?" or double quote.
  "https://user:pa/ss@host.example/x",
  assemble("amqp://guest", ":gu#est", "@mq:5672"),
  assemble("redis://default", ":Sup3r?Secret", "@cache:6379"),
  assemble("postgres://app", ':pa"ss', "@db/x"),
  // A URL parameter's value that holds a raw double quote or angle bracket, of which only the
  // part before it is replaced. A URL that was encoded holds neither.
  ['/login?password=ab"cd-secret-tail&x=1', '/login?password=[redacted]"cd-secret-tail&x=1'],
  ["/login?password=ab<cd>secret-tail&x=1", "/login?password=[redacted]<cd>secret-tail&x=1"],
  // A token as a URL's user name with no password.
  "https://ghp0AbCdEf0123456789@github.com/o/r.git",
  // Tokens under a provider's prefix, on their own.
  assemble("ghp", "_AbCdEf0123456789AbCdEf0123456789AbCd"),
  assemble("AKIA", "IOSFODNN7EXAMPLE"),
  assemble("xoxb", "-123456789012-1234567890123-", "AbCdEfGhIjKlMnOpQrStUvWx"),
  // A parameter named like a secret inside a percent-encoded nested URL.
  "https://app.example/cb?next=https%3A%2F%2Fx.example%2F%3Ftoken%3DAbCdEf0123456789",
  // A secret in a URL's path.
  "https://hooks.example.com/services/T0AbCdEf0/B0AbCdEf0/AbCdEf0123456789AbCdEf01",
  // JSON text from a serializer that escapes more than JavaScript's does: each "&" of the URL
  // written as the six characters of its escape, and a backslash before each "/".
  String.raw`{"url":"https://x.example/cb?a=1\u0026access_token=Zq9Xw8Vu7Ts6Rp5On4Ml\u0026x=1"}`,
  assemble(String.raw`{"dsn":"postgres:\/\/app`, ":S3cr3tPassw0rd",
      String.raw`@db.internal:5432\/app"}`),
  // A URL in HTML whose "&" is a numeric entity. The named entity is caught (see the URL
  // parameters above).
  "https://x.example/cb?a=1&#38;access_token=Zq9Xw8Vu7Ts6Rp5On4Ml&#38;x=1",
  // A JSON member under a name the patterns do not know, or whose value is not a string, or
  // inside JSON held in a string three times over: seven backslashes before each inner quote.
  '{"key":"' + credential + '"}',
  '{"token":12345678901234567890}',
  JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({ password: "hunter2-tail" })))),
  // A private key's body without its BEGIN line.
  pemBody,
];

// `unit` repeated after `head`, to `length` characters in all.
const flood = (head: string, unit: string, length = 200_000) =>
  (head + unit.repeat(Math.ceil(length / unit.length))).slice(0, length);

// Inputs on which a pattern that backtracks would take time quadratic in their length. Escapes
// are written as their characters.
const ADVERSARIAL: string[] = [
  flood("?", "a"), flood("Bearer ", " "), flood("", "Bearer "), flood("", "Basic "),
  flood("Bearer ", "a"), flood("eyJaaaaaaaa", "."), flood("", "&"), flood("?", "a-."),
  flood("", "&key"), flood("", "sk-"), flood("", "sk_a"), flood("?", "token"), flood("", '"'),
  flood("", "\\"), flood('"token"', " "), flood('"', "a"), flood("", '"token":"'),
  flood('"', "token"), flood("", "://"), flood("", "://a:"), flood("://", "a"),
  flood("://a:", "b"), flood("://", ":"), flood("", "a."), flood("", "://u:p@"),
  flood('"token":"', "\\"), flood('"token":"', '\\"'), flood('"token":"', "a\\"),
  flood("", '"set-cookie'), flood("", '"proxy-'), flood("", '"token\\":\\"'),
  // The escapes of a member's value in JSON held in a string, and empty segments of a token.
  flood('"token\\":\\"', "\\"), flood('"token\\":\\"', "a\\\\"),
  flood('"token\\":\\"', '\\\\\\"'), flood("", '"token\\":\\"\\\\'),
  flood('"token\\\\\\":\\\\\\"', "\\"), flood("", "eyJaaaaaaaa...."),
  flood("eyJaaaaaaaa", "..a"), flood("?token=", "'"), flood("", "?key='"),
  // The private-key, password, token and name patterns.
  flood("-----BEGIN ", "A"), flood("-----BEGIN ", "PRIVATE KEY"), flood("", pemEdge("BEGIN")),
  flood(pemEdge("BEGIN"), "-----END "), flood(pemEdge("BEGIN"), "-----END PRIVATE KE"),
  flood("", pemEdge("END")), flood("", "-"), flood("://a:", "b@"), flood("://a:", "@"),
  flood("", "://a:b@c"), flood("", "xeyJ"), flood("", "eyJ"), flood("", "%aaeyJ"),
  flood("", '"secret'), flood("", '"access_key'), flood("", "?secretkey"),
  flood('"', "private_"),
  // The start the token patterns share.
  flood("", "\\n"), flood("", "\\nsk-"), flood("", "\\nBearer "), flood("", "%20sk-"),
  flood("", "%20Bearer "), flood("", "_Bearer "), flood("", "\\u"), flood("", "\\u00"),
  flood("", "\\u000ask-"), flood("", "\\u000aeyJ"), flood("", "\\bsk-"), flood("", "%"),
  flood("", "%2"), flood("\\nsk-", "a"), flood("\\nBearer", " "),
];

// Two of them at five times the length, where a quadratic pattern takes twenty-five times as
// long. At 200,000 characters the form the module's comments warn of for each (a lookahead after
// "sk-", a second run of label characters after "PRIVATE KEY") returns within the test's timeout,
// or too little outside it to count on.
const LONGER_ADVERSARIAL: string[] = [
  flood("", "sk-", 1_000_000), flood("-----BEGIN ", "PRIVATE KEY", 1_000_000),
];

describe("redactGadgetConsoleLogText", () => {
  for (let [shape, cases] of Object.entries(CAUGHT)) {
    it(`redacts ${shape}`, () => {
      for (let [text, redacted] of cases) {
        expect(redactGadgetConsoleLogText(text), text).toBe(redacted);
      }
    });
  }

  it("leaves alone text that only resembles a credential", () => {
    for (let text of LEFT_ALONE) expect(redactGadgetConsoleLogText(text)).toBe(text);
  });

  it("redacts some text that is no credential", () => {
    for (let [text, redacted] of ACCEPTED) {
      expect(redactGadgetConsoleLogText(text), text).toBe(redacted);
    }
  });

  it("does not catch a credential in a shape it has no pattern for", () => {
    for (let entry of NOT_CAUGHT) {
      let [text, left] = typeof entry === "string" ? [entry, entry] : entry;
      expect(redactGadgetConsoleLogText(text), text).toBe(left);
    }
  });

  it("does not catch a name and its value printed as a pair of array elements", () => {
    // What spreading a Headers object, a Map or URLSearchParams gives.
    expect(gadgetConsoleLogText(
        ["req", [["content-type", "application/json"], ["x-api-key", credential]]]))
        .toBe('req [["content-type","application/json"],["x-api-key","' + credential + '"]]');

    // Caught, for the difference: the same header as an object's member, and a pair whose value
    // has a shape of its own.
    expect(gadgetConsoleLogText(["req", { "x-api-key": credential }]))
        .toBe('req {"x-api-key":"[redacted]"}');
    expect(gadgetConsoleLogText(["req", [["authorization", bearer]]]))
        .toBe('req [["authorization","Bearer [redacted]"]]');
  });

  it("does not catch a credential that an escape separates from its scheme word", () => {
    // What printing an object makes of a real line break or tab: the two characters of its
    // escape, which are no space.
    expect(gadgetConsoleLogText(["req", { header: "Authorization: Bearer\n" + credential }]))
        .toBe(String.raw`req {"header":"Authorization: Bearer\n` + credential + '"}');
    expect(gadgetConsoleLogText(["req", { header: "Basic\t" + credential }]))
        .toBe(String.raw`req {"header":"Basic\t` + credential + '"}');

    // Caught, for the difference: the same strings as parts of their own, which keep their real
    // line break and tab.
    expect(gadgetConsoleLogText(["Authorization: Bearer\n" + credential]))
        .toBe("Authorization: Bearer\n[redacted]");
    expect(gadgetConsoleLogText(["Basic\t" + credential])).toBe("Basic\t[redacted]");
  });

  it("does not catch a token split over two console arguments", () => {
    // Neither part is long enough to be known. Two calls are two entries, which nothing joins.
    expect(gadgetConsoleLogText([sk.slice(0, 14), sk.slice(14)]))
        .toBe(sk.slice(0, 14) + " " + sk.slice(14));
  });

  it("changes nothing when it runs again", () => {
    let texts = [
      ...Object.values(CAUGHT).flat().map(([text]) => text),
      ...LEFT_ALONE,
      ...ACCEPTED.map(([text]) => text),
      ...NOT_CAUGHT.map(entry => typeof entry === "string" ? entry : entry[0]),
    ];
    for (let text of texts) {
      let redacted = redactGadgetConsoleLogText(text);
      expect(redactGadgetConsoleLogText(redacted), text).toBe(redacted);
    }
  });

  it("returns for adversarial texts of 200,000 characters", () => {
    // No timing is asserted: a pattern that backtracked over one of these would not return
    // within the test's timeout.
    for (let text of ADVERSARIAL) {
      expect(text.length).toBe(200_000);
      expect(redactGadgetConsoleLogText(text)).toBeTypeOf("string");
      expect(gadgetConsoleLogText([text]).length)
          .toBeLessThanOrEqual(MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH);
    }
  });

  it("returns for adversarial texts of 1,000,000 characters", () => {
    // No timing is asserted here either.
    for (let text of LONGER_ADVERSARIAL) {
      expect(text.length).toBe(1_000_000);
      expect(redactGadgetConsoleLogText(text)).toBeTypeOf("string");
      expect(gadgetConsoleLogText([text]).length)
          .toBeLessThanOrEqual(MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH);
    }
  });
});

describe("gadgetConsoleLogText", () => {
  it("joins the arguments with spaces, strings as they are and other values as JSON", () => {
    expect(gadgetConsoleLogText(["a", { b: 1 }, 2, null, undefined]))
        .toBe('a {"b":1} 2 null undefined');

    let stack = "Error: boom\n    at run (server.js:3:9)\n    at fetch (server.js:9:5)";
    expect(gadgetConsoleLogText([stack])).toBe(stack);
  });

  it("redacts a string inside a printed object through its escapes", () => {
    // The inputs hold real line breaks and tabs. In the outputs each is the two characters JSON
    // writes for it.
    expect(gadgetConsoleLogText(["loaded", { env: "# keys\n" + sk }]))
        .toBe(String.raw`loaded {"env":"# keys\n[redacted]"}`);
    expect(gadgetConsoleLogText(["req", { dump: "Authorization:\n" + bearer }]))
        .toBe(String.raw`req {"dump":"Authorization:\nBearer [redacted]"}`);
    expect(gadgetConsoleLogText(["row", { tsv: "name\t" + sk }]))
        .toBe(String.raw`row {"tsv":"name\t[redacted]"}`);
    expect(gadgetConsoleLogText(["resp", { body: "Your token is:\r\n" + jwt }]))
        .toBe(String.raw`resp {"body":"Your token is:\r\n[redacted]"}`);

    // What a frame posts for an object is JSON text already, one string part.
    let posted = JSON.stringify({ body: "Your token is:\n" + jwt, keys: "a\n" + sk });
    expect(gadgetConsoleLogText([posted]))
        .toBe(String.raw`{"body":"Your token is:\n[redacted]","keys":"a\n[redacted]"}`);

    // JSON inside JSON.
    let twice = JSON.stringify({ body: JSON.stringify({ env: "k\n" + sk }) });
    expect(gadgetConsoleLogText([twice])).toBe(twice.replace(sk, "[redacted]"));

    // The same strings as parts of their own keep their real line breaks.
    expect(gadgetConsoleLogText(["# keys\n" + sk, "Your token is:\n" + jwt]))
        .toBe("# keys\n[redacted] Your token is:\n[redacted]");
  });

  it("redacts a secret member of a body a gadget serialized, whatever its value holds", () => {
    // A quote, a backslash and a line break, each inside the value and at either end of it, and
    // a value that is JSON itself.
    let values = [
      'first"second-secret-tail', '"whole-secret', 'whole-secret"', "\\whole-secret",
      "whole-secret\\", 'a\\"b\\\\c-secret-tail', "line\nsecret-tail", "\twhole-secret\r\n",
      '{"inner":"secret-tail"}', '""',
    ];
    let kept = JSON.stringify({ password: "[redacted]", n: 1 });

    for (let value of values) {
      // The member is in a string of the printed object, and then in a string of a string.
      let body = JSON.stringify({ password: value, n: 1 });
      expect(gadgetConsoleLogText(["POST", { body }]), value)
          .toBe("POST " + JSON.stringify({ body: kept }));
      expect(gadgetConsoleLogText(["POST", { request: JSON.stringify({ body }) }]), value)
          .toBe("POST " + JSON.stringify({ request: JSON.stringify({ body: kept }) }));
    }
  });

  // The start the token patterns share reads an escape as the character it stands for. So
  // printing a string inside an object never hides a token that is caught in the string itself,
  // and a key or a JSON Web Token that follows an encoded character in a URL is caught as it is
  // after the character. A start that knew fewer escapes than JSON writes would fail this for
  // the characters JSON escapes with a letter or a hex digit.
  it("catches a token whatever escaping the text around it went through", () => {
    let secret = "Zq9Xw8Vu7Ts6Rp5On4Ml3Kj2Ih1Gf0Ed";
    // Percent-encoding changes a bearer or basic credential itself, its space first, which the
    // not-caught cases cover. The other shapes hold nothing it changes.
    let shapes = [
      { shape: "Bearer " + secret, percentEncodable: false },
      { shape: "Basic " + secret + "==", percentEncodable: false },
      { shape: jwt, percentEncodable: true },
      { shape: assemble("sk", "-proj-", secret), percentEncodable: true },
      { shape: assemble("sk", "_live_", secret), percentEncodable: true },
    ];
    // A space, a line feed, a carriage return, a tab, a backspace, a form feed, U+0000, U+001B,
    // a double quote, a backslash, an underscore, a lone surrogate and U+2028.
    let before = [
      " ", "\n", "\r", "\t", "\b", "\f", "\u0000", "\u001b", '"', "\\", "_", "\ud800", "\u2028",
    ];

    for (let { shape, percentEncodable } of shapes) {
      for (let character of before) {
        let text = "x" + character + shape + " tail";
        let forms = [
          text, JSON.stringify(text), JSON.stringify(JSON.stringify(text)),
          JSON.stringify({ a: [text] }),
        ];
        // encodeURIComponent() throws on a lone surrogate.
        if (percentEncodable && character !== "\ud800") {
          forms.push("x" + encodeURIComponent(character) + shape + "&tail");
        }

        // Compared and named as well-formed text, which a failure can be reported in.
        for (let form of forms) {
          let redacted = redactGadgetConsoleLogText(form).toWellFormed();
          expect(redacted, JSON.stringify(form)).not.toContain("Zq9Xw8Vu7Ts6");
          expect(redacted, JSON.stringify(form)).not.toContain(jwtHeader);
        }
      }
    }
  });

  it("keeps a text whole up to the kept length, and cuts and marks a longer one", () => {
    expect(MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH).toBe(2000);
    expect(gadgetConsoleLogText([words(2000)])).toBe(words(2000));
    expect(gadgetConsoleLogText([words(2500)])).toBe(words(1999) + "…");
  });

  it("redacts a token that straddles the cut before cutting", () => {
    let text = gadgetConsoleLogText(["x".repeat(1990) + " Bearer " + "A1".repeat(20)]);
    expect(text).toHaveLength(2000);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain("A1A1");
  });

  it("redacts a token that straddles the cut in a reported text", () => {
    let key = assemble("sk", "-proj-", "AbCdEf0123456789xyzABCDEFGH");
    // The key starts 6 characters before the cut.
    let head = words(1993) + " ";
    let reported: ReportedGadgetConsoleLog = {
      time: new Date(0), level: "log", text: (head + key + " " + words(4000)).slice(0, 4000),
    };
    expect(clientGadgetConsoleLogEntry(1, null, "ada", reported, new Date(0)).text)
        .toBe((head + "[redacted] " + words(4000)).slice(0, 1999) + "…");
  });

  describe("at the read bound", () => {
    // More than the kept length, all of which redaction removes: what follows it in the text
    // read would otherwise be kept.
    const pre = "start eyJ" + "A".repeat(2200) + " ";
    // Filler that puts the bound `inside` characters into whatever follows it.
    const fillTo = (inside: number) => words(4000 - inside - pre.length - 1) + " ";

    it("is 4,000 characters, twice the kept length", () => {
      expect(MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH).toBe(4000);
      expect(MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH)
          .toBe(2 * MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH);
    });

    it("keeps nothing of a key the bound cuts", () => {
      let fill = fillTo(14);
      let text = pre + fill + sk + " tail";
      // Nothing of the key, and the mark though the result is shorter than the kept length.
      expect(gadgetConsoleLogText([text])).toBe("start [redacted] " + fill + "…");
      // As a browser would send it.
      expect(gadgetConsoleLogText([text.slice(0, 4000)])).toBe("start [redacted] " + fill + "…");
    });

    it("keeps nothing of a bearer credential the bound cuts", () => {
      // Cut after 20 characters of the credential, all of them lower case.
      let text = pre + fillTo(27) +
          assemble("Bearer ", "abcdefghijklmnopqrstUVWX0123456789") + " tail";
      let kept = gadgetConsoleLogText([text]);
      expect(kept).not.toContain("abcdefgh");
      expect(kept.endsWith("Bearer …")).toBe(true);
    });

    it("keeps nothing of a basic credential the bound cuts, punctuation and all", () => {
      // Cut after 21 characters of the credential, which hold every kind of token character and
      // neither a capital nor a digit, so that no pattern would take what a shorter run left of
      // them.
      let fill = fillTo(27);
      let text = pre + fill +
          assemble("Basic ", "ab/cd+ef.gh~ij=kl-mn_UVWX0123456789") + " tail";
      expect(gadgetConsoleLogText([text])).toBe("start [redacted] " + fill + "Basic …");
    });

    it("keeps nothing of a URL password the bound cuts", () => {
      // The bound falls 11 characters into each password.
      let fill = fillTo(26);
      let url = assemble("postgres://app", ":Pa!ss$w0rd%21xyzzy", "@db.internal:5432/app");
      expect(gadgetConsoleLogText([pre + fill + url + " tail"]))
          .toBe("start [redacted] " + fill + "postgres://app:…");

      // A password that holds "@": a cleanup that stopped at the "@" would keep what follows it.
      let withAt = assemble("postgres://app", ":p@ssw0rd!Zz9", "@db.internal:5432/app");
      let kept = gadgetConsoleLogText([pre + fill + withAt + " tail"]);
      expect(kept).toBe("start [redacted] " + fill + "postgres://app:…");
      expect(kept).not.toContain("ssw0rd");

      // A user name that holds "@", the bound again 11 characters into the password.
      let longerFill = fillTo(34);
      let withAddress =
          assemble("smtp://ada@example.com", ":Pa!ss$w0rd%21xyzzy", "@smtp.example.com:587");
      expect(gadgetConsoleLogText([pre + longerFill + withAddress + " tail"]))
          .toBe("start [redacted] " + longerFill + "smtp://ada@example.com:…");
    });

    it("replaces a private key the bound cuts", () => {
      let fill = words(3000 - pre.length - 1) + " ";
      let expected = "start [redacted] " + fill + pemEdge("BEGIN") + "[redacted]…";
      let text = pre + fill + longPem() + " tail";
      // The same with the key's newlines as JSON escapes.
      let escaped = pre + fill + longPem(String.raw`\n`) + " tail";
      expect(longPem()).toHaveLength(1847);

      // The middle one is the text as a browser would send it.
      for (let read of [text, text.slice(0, 4000), escaped]) {
        let kept = gadgetConsoleLogText([read]);
        expect(kept).toBe(expected);
        expect(kept).not.toMatch(/Zq\d\d/);
      }
    });

    it("replaces a private key that the cut would split before cutting", () => {
      // Whole and unmarked.
      let kept = gadgetConsoleLogText([words(1900) + " " + longPem()]);
      expect(kept).toBe(words(1900) + " " + redactedPemBlock());
      expect(kept).toHaveLength(1963);

      // A server call's parts are covered the same way.
      expect(gadgetConsoleLogText(["loaded", longPem(), "ok"]))
          .toBe("loaded " + redactedPemBlock() + " ok");
      expect(gadgetConsoleLogText(["key", { private_key: longPem(), n: 1 }]))
          .toBe('key {"private_key":"[redacted]","n":1}');
    });

    it("marks a bounded text that redaction leaves short", () => {
      expect(gadgetConsoleLogText(["x eyJ" + "A".repeat(3000) + " " + words(1200)]))
          .toBe("x [redacted] " + "word ".repeat(198) + "…");
    });

    it("drops the last run of token characters of ordinary text", () => {
      expect(gadgetConsoleLogText([words(3999)])).toBe(words(1999) + "…");
      expect(gadgetConsoleLogText([words(4000)])).toBe(words(1999) + "…");
      expect(gadgetConsoleLogText(["a".repeat(5000)])).toBe("…");
      expect(gadgetConsoleLogText(["data:image/png;base64," + "iVBOR".repeat(1000)]))
          .toBe("data:image/png;base64,…");

      let parts = Array.from({ length: 3000 }, (_, i) => `p${i}`);
      let kept = gadgetConsoleLogText(parts);
      expect(kept).toHaveLength(2000);
      expect(kept.endsWith("…")).toBe(true);
      expect(kept.startsWith("p0 p1 p2 ")).toBe(true);
    });
  });

  it("returns well-formed text", () => {
    // An emoji straddling the cut.
    let cut = gadgetConsoleLogText(["x".repeat(1998) + "😀tail"]);
    expect(cut.isWellFormed()).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(2000);
    expect(cut).toBe("x".repeat(1998) + "…");

    // A lone surrogate elsewhere in the text.
    let replaced = gadgetConsoleLogText(["a\ud800b"]);
    expect(replaced.isWellFormed()).toBe(true);
    expect(replaced).toBe("a\ufffdb");
  });

  it("never throws, whatever it is given", () => {
    let cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let bare = Object.create(null);
    bare.self = bare;

    expect(gadgetConsoleLogText([cyclic])).toBe("[object Object]");
    expect(gadgetConsoleLogText([10n])).toBe("10");
    expect(gadgetConsoleLogText([Symbol("s")])).toBe("Symbol(s)");
    expect(gadgetConsoleLogText([bare])).toBe("[unprintable]");

    // Not an array: one part.
    let notArrays: [parts: unknown, text: string][] =
        [[5, "5"], ["text", "text"], [undefined, "undefined"]];
    for (let [parts, text] of notArrays) {
      expect(gadgetConsoleLogText(parts as unknown[])).toBe(text);
    }
  });
});

describe("serverGadgetConsoleLogEntry", () => {
  const at = new Date("2026-01-02T03:04:05.678Z");
  const event = (message: unknown[], level: ConsoleLogEvent["level"] = "log"): ConsoleLogEvent =>
    ({ timestamp: at, level, message });

  it("shapes a console call of a gadget's server", () => {
    let entry = serverGadgetConsoleLogEntry(7, 3, event(["saved", { rows: 2 }], "warn"));
    expect(entry).toStrictEqual({
      time: at, gadgetId: 7, chatId: 3, source: "server", level: "warn", text: 'saved {"rows":2}',
    });
    expect("userId" in entry).toBe(false);
  });

  it("passes the chat through as given", () => {
    expect(serverGadgetConsoleLogEntry(7, null, event(["x"])).chatId).toBeNull();
    // A workspace's first chat.
    expect(serverGadgetConsoleLogEntry(7, 0, event(["x"])).chatId).toBe(0);
  });

  it("gives the entry a valid time when the call's timestamp is not one", () => {
    let before = Date.now();
    let { time } = serverGadgetConsoleLogEntry(
        7, null, { timestamp: new Date(NaN), level: "error", message: ["boom"] });
    expect(time.getTime()).toBeGreaterThanOrEqual(before);
    expect(time.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("cuts the text", () => {
    let { text } = serverGadgetConsoleLogEntry(7, null, event([words(2500)]));
    expect(text).toBe(words(1999) + "…");
    expect(text).toHaveLength(2000);

    expect(serverGadgetConsoleLogEntry(7, null, event(["head", words(2500)])).text)
        .toBe(("head " + words(2500)).slice(0, 1999) + "…");
  });

  it("redacts the text", () => {
    expect(serverGadgetConsoleLogEntry(7, null, event(["calling", bearer])).text)
        .toBe("calling Bearer [redacted]");
  });
});

describe("clientGadgetConsoleLogEntry", () => {
  const at = new Date("2026-01-02T03:04:05.678Z");
  const receivedAt = new Date("2026-01-02T03:04:09.000Z");

  it("shapes a console call a browser reported", () => {
    let reported: ReportedGadgetConsoleLog = { time: at, level: "info", text: "clicked save" };
    expect(clientGadgetConsoleLogEntry(7, 3, "ada@example.com", reported, receivedAt))
        .toStrictEqual({
          time: at, gadgetId: 7, chatId: 3, source: "client", userId: "ada@example.com",
          level: "info", text: "clicked save",
        });
  });

  it("passes the chat through as given", () => {
    let reported: ReportedGadgetConsoleLog = { time: at, level: "log", text: "x" };
    expect(clientGadgetConsoleLogEntry(7, null, "ada", reported, receivedAt).chatId).toBeNull();
    expect(clientGadgetConsoleLogEntry(7, 0, "ada", reported, receivedAt).chatId).toBe(0);
  });

  it("takes the time the report was received when the reported time is not a valid date", () => {
    let reported: ReportedGadgetConsoleLog = { time: new Date(NaN), level: "log", text: "x" };
    expect(clientGadgetConsoleLogEntry(7, null, "ada", reported, receivedAt).time)
        .toBe(receivedAt);
  });

  it("redacts the text", () => {
    let reported: ReportedGadgetConsoleLog = { time: at, level: "log", text: "loaded " + sk };
    expect(clientGadgetConsoleLogEntry(7, null, "ada", reported, receivedAt).text)
        .toBe("loaded [redacted]");
  });

  it("carries no member of a reported object but its declared fields", () => {
    // Validation lets members it does not know through, so a browser can send these: four under
    // names an entry has, which a spread placed last would carry, and one under a name it has
    // not, which any spread would.
    let reported = {
      time: at, level: "log", text: "hello",
      userId: "mallory", source: "server", gadgetId: 999, chatId: 77, note: "x",
    } as ReportedGadgetConsoleLog;
    let entry = clientGadgetConsoleLogEntry(7, null, "ada", reported, receivedAt);
    expect(entry).toStrictEqual({
      time: at, gadgetId: 7, chatId: null, source: "client", userId: "ada", level: "log",
      text: "hello",
    });
    expect(Object.keys(entry)).toHaveLength(7);
  });
});

describe("droppedGadgetConsoleLogsText", () => {
  it("says how many entries were dropped", () => {
    expect(droppedGadgetConsoleLogsText(1)).toBe("1 entry dropped");
    expect(droppedGadgetConsoleLogsText(0)).toBe("0 entries dropped");
    expect(droppedGadgetConsoleLogsText(37)).toBe("37 entries dropped");
  });
});

describe("GadgetConsoleLogLimiter", () => {
  const t = 1_000_000;

  it("admits a gadget's entries up to the limit and tells the first call that drops", () => {
    let limiter = new GadgetConsoleLogLimiter(5);
    expect(limiter.admit(1, 3, t)).toEqual({ admitted: 3, dropped: 0 });
    // Two are left of the minute, and the call is told its own three drops.
    expect(limiter.admit(1, 5, t + 1_000)).toEqual({ admitted: 2, dropped: 3 });
    // Later drops in the same minute wait.
    expect(limiter.admit(1, 4, t + 2_000)).toEqual({ admitted: 0, dropped: 0 });
  });

  it("starts the next minute at the first call after one ends, and marks what waited", () => {
    let limiter = new GadgetConsoleLogLimiter(5);
    expect(limiter.admit(1, 8, t)).toEqual({ admitted: 5, dropped: 3 });
    expect(limiter.admit(1, 4, t + 30_000)).toEqual({ admitted: 0, dropped: 0 });
    // Still the minute that started at `t`.
    expect(limiter.admit(1, 2, t + 59_999)).toEqual({ admitted: 0, dropped: 0 });

    // The next one: the call is told the six drops that waited.
    expect(limiter.admit(1, 2, t + 60_000)).toEqual({ admitted: 2, dropped: 6 });
    // A second mark in it is withheld.
    expect(limiter.admit(1, 9, t + 61_000)).toEqual({ admitted: 3, dropped: 0 });
    expect(limiter.admit(1, 1, t + 119_999)).toEqual({ admitted: 0, dropped: 0 });
    expect(limiter.admit(1, 1, t + 120_000)).toEqual({ admitted: 1, dropped: 7 });
  });

  it("holds a call to its cap, within the gadget's minute", () => {
    expect(GADGET_CONSOLE_LOGS_PER_MINUTE).toBe(300);
    expect(MAX_GADGET_CONSOLE_LOGS_PER_CALL).toBe(50);

    // The default limit.
    let limiter = new GadgetConsoleLogLimiter();
    expect(limiter.admit(1, 60, t, 50)).toEqual({ admitted: 50, dropped: 10 });
    for (let call = 0; call < 5; call++) {
      expect(limiter.admit(1, 50, t, 50)).toEqual({ admitted: 50, dropped: 0 });
    }
    expect(limiter.admit(1, 50, t, 50)).toEqual({ admitted: 0, dropped: 0 });

    // Without a cap a call may take the whole minute.
    expect(new GadgetConsoleLogLimiter().admit(1, 400, t)).toEqual({ admitted: 300, dropped: 100 });
  });

  it("keeps a budget and a count of drops for each gadget", () => {
    let limiter = new GadgetConsoleLogLimiter(2);
    expect(limiter.admit(1, 3, t)).toEqual({ admitted: 2, dropped: 1 });
    expect(limiter.admit(2, 2, t)).toEqual({ admitted: 2, dropped: 0 });
    expect(limiter.admit(2, 1, t)).toEqual({ admitted: 0, dropped: 1 });
  });

  it("changes nothing for a call that offers no entries", () => {
    let limiter = new GadgetConsoleLogLimiter(2);
    // It starts no minute: the gadget's first starts with its first entry, 50 seconds later, so
    // a call 10 seconds after that is still in it.
    expect(limiter.admit(1, 0, t)).toEqual({ admitted: 0, dropped: 0 });
    expect(limiter.admit(1, 3, t + 50_000)).toEqual({ admitted: 2, dropped: 1 });
    expect(limiter.admit(1, 1, t + 60_000)).toEqual({ admitted: 0, dropped: 0 });

    // Nor does it mark the drop that waits for the gadget's next minute.
    expect(limiter.admit(1, 0, t + 110_000)).toEqual({ admitted: 0, dropped: 0 });
    expect(limiter.admit(1, 1, t + 110_000)).toEqual({ admitted: 1, dropped: 1 });
  });

  it("counts a marker that was not written with the gadget's next", () => {
    let limiter = new GadgetConsoleLogLimiter(5);
    expect(limiter.admit(1, 8, t)).toEqual({ admitted: 5, dropped: 3 });
    limiter.unmark(1, 3);
    // The gadget is not marked a second time in the minute, and gets none of its budget back.
    expect(limiter.admit(1, 2, t + 1_000)).toEqual({ admitted: 0, dropped: 0 });
    // Its next marker counts the three with the two dropped since.
    expect(limiter.admit(1, 1, t + 60_000)).toEqual({ admitted: 1, dropped: 5 });

    // A minute that began while the marker was being written holds the count too.
    expect(limiter.admit(1, 9, t + 120_000)).toEqual({ admitted: 5, dropped: 4 });
    expect(limiter.admit(1, 1, t + 180_000)).toEqual({ admitted: 1, dropped: 0 });
    limiter.unmark(1, 4);
    expect(limiter.admit(1, 1, t + 181_000)).toEqual({ admitted: 1, dropped: 4 });

    // Another gadget's count is its own.
    expect(limiter.admit(2, 6, t)).toEqual({ admitted: 5, dropped: 1 });
  });
});

// Silences one console method and reads what a logger wrote through it: the one object of each
// call, in order.
function spyOnConsole(level: "info" | "warn" | "error") {
  let spy = vi.spyOn(console, level).mockImplementation(() => {});
  return { spy, lines: () => spy.mock.calls.map(([line]) => line as Record<string, unknown>) };
}

// The deployment variable holding `value`, whatever a deployment's configuration put there.
const variable = (value: unknown) => ({ RECORD_GADGET_CONSOLE_LOGS: value as string });

describe("isGadgetConsoleLogRecordingEnabled", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is on only for "true"', () => {
    expect(isGadgetConsoleLogRecordingEnabled(variable("true"))).toBe(true);
  });

  it.each([
    ["unset", {}],
    ["empty", variable("")],
    ["blank", variable("   ")],
    ['"false"', variable("false")],
  ])("is off while the variable is %s, and reports nothing", (_name, vars) => {
    let { spy } = spyOnConsole("error");
    expect(isGadgetConsoleLogRecordingEnabled(vars)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  // One test for every invalid value: each is reported once per isolate, so a value tried in two
  // tests would be reported in whichever ran first.
  it("is off for any other value, and reports each once without repeating it", () => {
    let { spy, lines } = spyOnConsole("error");
    expect(isGadgetConsoleLogRecordingEnabled(variable("TRUE"))).toBe(false);
    expect(isGadgetConsoleLogRecordingEnabled(variable("TRUE"))).toBe(false);
    expect(lines()).toStrictEqual([{
      component: "gadget.console", event: "gadget.console.config.invalid",
      message: expect.stringContaining("RECORD_GADGET_CONSOLE_LOGS"),
    }]);
    expect(JSON.stringify(lines())).not.toContain("TRUE");

    // A JSON `true` among them: only the string turns recording on.
    for (let [index, value] of ["True", " true", "1", "yes", true].entries()) {
      expect(isGadgetConsoleLogRecordingEnabled(variable(value))).toBe(false);
      expect(spy).toHaveBeenCalledTimes(index + 2);
    }
  });

  it("is off for a JSON object, whatever it holds, and reports it once", () => {
    let { spy } = spyOnConsole("error");
    // The last three have no string form: String() of each throws.
    let objects = ["{}", "[]", '{"toString":"true"}', '{"toString":null}', '[{"toString":1}]']
        .map(json => JSON.parse(json) as unknown);
    for (let [index, value] of objects.entries()) {
      expect(isGadgetConsoleLogRecordingEnabled(variable(value))).toBe(false);
      expect(isGadgetConsoleLogRecordingEnabled(variable(value))).toBe(false);
      expect(spy).toHaveBeenCalledTimes(index + 1);
    }
  });
});

// The marker written for `droppedCount` calls of the server of gadget 7 in workspace "ws".
const marker = (droppedCount: number) => ({
  component: "gadget.console", event: "gadget.console.dropped",
  message: "gadget console entries dropped", gadgetId: "ws", workpieceId: 7,
  consoleSource: "server", droppedCount, time: expect.any(String),
  text: droppedGadgetConsoleLogsText(droppedCount),
});

// The bytes of `lines` as JSON, which is how the runtime records a line.
const jsonBytes = (lines: unknown[]) =>
  new TextEncoder().encode(lines.map(each => JSON.stringify(each)).join("")).length;

describe("writeServerGadgetConsoleLogs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const at = new Date("2026-01-02T03:04:05.678Z");
  const event = (message: unknown[], level: ConsoleLogEvent["level"] = "log"): ConsoleLogEvent =>
    ({ timestamp: at, level, message });
  // `count` console calls of one request: "flood 0", "flood 1", and so on.
  const calls = (count: number) => Array.from({ length: count }, (_, i) => event(["flood", i]));
  // The line written for a call that gadget 7 of workspace "ws" made at `at`.
  const line = (consoleLevel: ConsoleLogEvent["level"], text: string) => ({
    component: "gadget.console", event: "gadget.console.entry", message: "gadget console entry",
    gadgetId: "ws", workpieceId: 7, consoleSource: "server", consoleLevel,
    time: at.toISOString(), text,
  });

  it("writes one line for each console call, oldest first", () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    writeServerGadgetConsoleLogs(
        "ws", 7, null, [event(["saved", { rows: 2 }], "warn"), event(["done"])]);

    expect(info.lines()).toStrictEqual([line("warn", 'saved {"rows":2}'), line("log", "done")]);
    expect(warn.spy).not.toHaveBeenCalled();
    // The mainline's lines name no chat and a server's no user, and the entry's level and source
    // go by the names a line has for them.
    for (let written of info.lines()) {
      for (let key of ["chatId", "userId", "source", "level"]) expect(key in written).toBe(false);
    }
  });

  it("names the chat on each line of a draft's output", () => {
    let info = spyOnConsole("info");
    writeServerGadgetConsoleLogs("ws", 7, 5, [event(["a"]), event(["b"])]);
    // A workspace's first chat is chat 0.
    writeServerGadgetConsoleLogs("ws", 7, 0, [event(["c"])]);

    expect(info.lines()).toStrictEqual([
      { ...line("log", "a"), chatId: 5 }, { ...line("log", "b"), chatId: 5 },
      { ...line("log", "c"), chatId: 0 },
    ]);
  });

  it("redacts and cuts the text it writes", () => {
    let info = spyOnConsole("info");
    writeServerGadgetConsoleLogs("ws", 7, null, [event(["calling", bearer]), event([words(2500)])]);

    let [redacted, cut] = info.lines();
    expect(redacted.text).toBe("calling Bearer [redacted]");
    expect(cut.text).toBe(words(1999) + "…");
    expect(cut.text).toHaveLength(MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH);
  });

  it("writes hostile events, and never throws", () => {
    let info = spyOnConsole("info");
    let cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let before = Date.now();
    writeServerGadgetConsoleLogs("ws", 7, null, [
      event([cyclic]),
      event([10n]),
      { timestamp: at, level: "log", message: "not an array" as unknown as unknown[] },
      { timestamp: new Date(NaN), level: "error", message: ["boom"] },
    ]);

    let lines = info.lines();
    expect(lines.map(written => written.text))
        .toStrictEqual(["[object Object]", "10", "not an array", "boom"]);
    // A call whose timestamp is no date is written with the time it was shaped at.
    let time = Date.parse(lines[3].time as string);
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Date.now());
  });

  it("keeps the newest lines that fit a request's bytes, after a marker that counts the rest",
      () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    writeServerGadgetConsoleLogs("ws", 7, null, calls(1500));

    let kept = info.lines();
    let dropped = 1500 - kept.length;
    expect(dropped).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);
    expect(warn.lines()).toStrictEqual([marker(dropped)]);
    // The marker comes first.
    expect(warn.spy.mock.invocationCallOrder[0])
        .toBeLessThan(Math.min(...info.spy.mock.invocationCallOrder));

    // The newest calls, in the order they were made: "flood 0" went, "flood 1499" is last.
    expect(kept.map(written => written.text))
        .toStrictEqual(Array.from({ length: kept.length }, (_, i) => `flood ${dropped + i}`));
    expect(jsonBytes(kept)).toBeLessThanOrEqual(GADGET_CONSOLE_LOG_BYTES_PER_REQUEST);
  });

  it("keeps the error that ends a flood", () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    writeServerGadgetConsoleLogs("ws", 7, null, [...calls(1500), event(["boom"], "error")]);

    expect(warn.spy).toHaveBeenCalledTimes(1);
    expect(info.lines().at(-1)).toStrictEqual(line("error", "boom"));
  });

  it("counts a line's bytes as it is written, not its characters", () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    writeServerGadgetConsoleLogs(
        "ws", 7, null, Array.from({ length: 50 }, () => event([words(2000)])));
    expect(info.spy).toHaveBeenCalledTimes(50);
    expect(warn.spy).not.toHaveBeenCalled();

    // A control character is one character of text and six bytes of a line.
    info.spy.mockClear();
    writeServerGadgetConsoleLogs(
        "ws", 7, null, Array.from({ length: 50 }, () => event(["\u0001".repeat(2000)])));
    let kept = info.lines();
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(50);
    expect(warn.lines()).toStrictEqual([marker(50 - kept.length)]);
    expect(jsonBytes(kept)).toBeLessThanOrEqual(GADGET_CONSOLE_LOG_BYTES_PER_REQUEST);
  });

  it("writes nothing for a request that logged nothing", () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    writeServerGadgetConsoleLogs("ws", 7, null, []);
    expect(info.spy).not.toHaveBeenCalled();
    expect(warn.spy).not.toHaveBeenCalled();
  });
});

// The marker written with a report of ada's browser for `droppedCount` dropped calls of gadget 7
// in workspace "ws".
const clientMarker = (droppedCount: number) =>
  ({ ...marker(droppedCount), consoleSource: "client", userId: "ada" });

describe("writeClientGadgetConsoleLogs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const at = new Date("2026-01-02T03:04:05.678Z");
  const reported =
      (text: string, level: ConsoleLogEvent["level"] = "log"): ReportedGadgetConsoleLog =>
        ({ time: at, level, text });
  // The line written for a call at `at` that ada's browser reported for gadget 7 of workspace
  // "ws".
  const line = (consoleLevel: ConsoleLogEvent["level"], text: string) => ({
    component: "gadget.console", event: "gadget.console.entry", message: "gadget console entry",
    gadgetId: "ws", workpieceId: 7, consoleSource: "client", userId: "ada", consoleLevel,
    time: at.toISOString(), text,
  });
  it("writes one line for a reported call, under the user whose browser reported it", () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    writeClientGadgetConsoleLogs("ws", 7, null, "ada", [reported("boom", "error")], 0);

    expect(info.lines()).toStrictEqual([line("error", "boom")]);
    // The mainline's line names no chat, and the entry's level and source go by the names a line
    // has for them.
    for (let key of ["chatId", "source", "level"]) expect(key in info.lines()[0]).toBe(false);
    expect(warn.spy).not.toHaveBeenCalled();
  });

  it("names the chat on a line reported under a draft", () => {
    let info = spyOnConsole("info");
    writeClientGadgetConsoleLogs("ws", 7, 5, "ada", [reported("a")], 0);
    // A workspace's first chat is chat 0.
    writeClientGadgetConsoleLogs("ws", 7, 0, "ada", [reported("b")], 0);

    expect(info.lines()).toStrictEqual(
        [{ ...line("log", "a"), chatId: 5 }, { ...line("log", "b"), chatId: 0 }]);
  });

  it("redacts the text it writes", () => {
    let info = spyOnConsole("info");
    writeClientGadgetConsoleLogs("ws", 7, null, "ada", [reported("loaded " + sk)], 0);

    expect(info.lines()).toStrictEqual([line("log", "loaded [redacted]")]);
  });

  it("writes a marker for what its caller dropped, ahead of the entries", () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    writeClientGadgetConsoleLogs("ws", 7, null, "ada", [reported("a"), reported("b")], 5);

    expect(warn.lines()).toStrictEqual([clientMarker(5)]);
    expect(warn.lines()[0].text).toBe("5 entries dropped");
    expect(info.lines()).toStrictEqual([line("log", "a"), line("log", "b")]);
    expect(warn.spy.mock.invocationCallOrder[0])
        .toBeLessThan(Math.min(...info.spy.mock.invocationCallOrder));
  });

  it("names the chat on a marker as on the entries it comes with", () => {
    let warn = spyOnConsole("warn");
    spyOnConsole("info");
    writeClientGadgetConsoleLogs("ws", 7, 0, "ada", [reported("a")], 2);

    expect(warn.lines()).toStrictEqual([{ ...clientMarker(2), chatId: 0 }]);
  });

  it("writes the marker alone when it is handed no entry", () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    writeClientGadgetConsoleLogs("ws", 7, null, "ada", [], 3);

    expect(warn.lines()).toStrictEqual([clientMarker(3)]);
    expect(info.spy).not.toHaveBeenCalled();
  });

  it("writes nothing when it is handed no entry and nothing was dropped", () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    writeClientGadgetConsoleLogs("ws", 7, null, "ada", [], 0);

    expect(info.spy).not.toHaveBeenCalled();
    expect(warn.spy).not.toHaveBeenCalled();
  });

  it("counts the entries that do not fit a request's bytes with its caller's drops", () => {
    let info = spyOnConsole("info"), warn = spyOnConsole("warn");
    // A control character is one character of text and six bytes of a line.
    writeClientGadgetConsoleLogs("ws", 7, null, "ada",
        Array.from({ length: 50 }, () => reported("\u0001".repeat(2000))), 4);

    let kept = info.lines();
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(50);
    expect(warn.lines()).toStrictEqual([clientMarker(4 + 50 - kept.length)]);
    expect(jsonBytes(kept)).toBeLessThanOrEqual(GADGET_CONSOLE_LOG_BYTES_PER_REQUEST);
  });

  it("writes a valid time for a reported time that is not one", () => {
    let info = spyOnConsole("info");
    let before = Date.now();
    writeClientGadgetConsoleLogs(
        "ws", 7, null, "ada", [{ time: new Date(NaN), level: "log", text: "a" }], 0);

    let [written] = info.lines();
    expect(written.time).toBe(new Date(Date.parse(written.time as string)).toISOString());
    expect(Date.parse(written.time as string)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(written.time as string)).toBeLessThanOrEqual(Date.now());
  });
});
