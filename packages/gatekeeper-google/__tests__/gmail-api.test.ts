import {afterEach, describe, expect, it, vi} from "vitest";
import {
  base64UrlDecodedByteLength, buildEncodedEmail, decodeBase64UrlToBytes,
  enumerateGmailAttachments, extractRfc822Attachments, gmailMessageIdQueryValue, GmailApi,
  GmailApiError,
  MAX_GMAIL_ATTACHMENT_BYTES,
  normalizeAggregateRecipients, parseGmailDraft, parseGmailPayloadContent, parseMimeMessage,
} from "../src/google-api";
import {containsBytes} from "./gmail-test-utils";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

function encodeRawEmail(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function stubFetch(responses: Response[]) {
  const calls: Array<{url: URL; init: RequestInit}> = [];
  const queue = [...responses];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    calls.push({url: new URL(input), init});
    const response = queue.shift();
    if (!response) throw new Error("unexpected fetch");
    return response;
  });
  return calls;
}

const api = () => new GmailApi("me@example.com", async () => "token");

afterEach(() => vi.unstubAllGlobals());

describe("Gmail recipient and MIME construction", () => {
  it("normalizes aggregate recipients and de-duplicates across To/CC/BCC", () => {
    expect(normalizeAggregateRecipients(
      ["A@example.com"], ["a@example.com", "c@example.com"],
      ["C@example.com", "b@example.com"])).toEqual({
      to: ["A@example.com"],
      cc: ["c@example.com"],
      bcc: ["b@example.com"],
    });
  });

  it("preserves display names while de-duplicating by mailbox address", async () => {
    expect(normalizeAggregateRecipients(
      ["Person <person@example.com>"], ["person@example.com"], [])).toEqual({
      to: ["\"Person\" <person@example.com>"],
      cc: [],
      bcc: [],
    });
    const message = api().buildSendRaw(
      ["Person <person@example.com>"], "Subject", "Body", {}, "<named@gadgets.invalid>");
    expect((await parseMimeMessage(message.raw)).to?.[0]).toMatchObject({
      address: "person@example.com", name: "Person",
    });
  });

  it("does not rewrite cross-field recipients in an existing draft snapshot", async () => {
    const message = api().buildOutbound({
      from: "me@example.com",
      to: ["Person <person@example.com>"],
      cc: ["person@example.com"],
      bcc: [],
      subject: "Subject",
      text: "Body",
      messageId: "<draft@gadgets.invalid>",
      attachments: [],
    });
    const parsed = await parseMimeMessage(message.raw);
    expect(parsed.to?.map(item => item.address)).toEqual(["person@example.com"]);
    expect(parsed.cc?.map(item => item.address)).toEqual(["person@example.com"]);
  });

  it("rejects recipient groups instead of flattening them into mailboxes", () => {
    expect(() => normalizeAggregateRecipients(["Friends: one@example.com;"], [], []))
      .toThrow(/exactly one recipient mailbox/);
  });

  it("builds multipart plain+HTML mail with CC and BCC", async () => {
    const message = api().buildSendRaw(
      ["to@example.com"], "Subject", "Plain", {
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        html: "<strong>HTML</strong>",
      }, "<stable@gadgets.invalid>");
    const parsed = await parseMimeMessage(message.raw);
    expect(parsed.to?.map(item => item.address)).toEqual(["to@example.com"]);
    expect(parsed.cc?.map(item => item.address)).toEqual(["cc@example.com"]);
    expect(parsed.bcc?.map(item => item.address)).toEqual(["bcc@example.com"]);
    expect(parsed.text).toContain("Plain");
    expect(parsed.html).toContain("<strong>HTML</strong>");
    expect(parsed.messageId).toBe("<stable@gadgets.invalid>");
  });

  it("builds a Gmail-style inline forward with source HTML and attachments", async () => {
    const sourceRaw = buildEncodedEmail({
      from: "Source Person <source@example.com>",
      to: ["me@example.com"],
      cc: ["copy@example.com"],
      bcc: [],
      subject: "Original subject",
      text: "Original plain text",
      html: '<p>Original <strong>HTML</strong></p>',
      messageId: "<source@gadgets.invalid>",
      attachments: [{
        filename: "source.txt",
        contentType: "text/plain",
        data: btoa("attachment"),
        disposition: "attachment",
        description: "source.txt",
      }],
    });
    const message = await api().buildForwardRaw(
      {id: "source", threadId: "thread", internalDate: "1", raw: sourceRaw},
      ["recipient@example.com"], "Intro", {html: "<p>Intro</p>"},
      "<forward@gadgets.invalid>");

    const parsed = await parseMimeMessage(message.raw);
    expect(message.attachments.map(attachment => attachment.filename)).toEqual(["source.txt"]);
    expect(parsed.attachments.map(attachment => attachment.filename)).toEqual(["source.txt"]);
    expect(parsed.text).toContain("Intro");
    expect(parsed.text).toContain("---------- Forwarded message ---------");
    expect(parsed.text).toContain("Original plain text");
    expect(parsed.html).toContain("gmail_quote");
    expect(parsed.html).toContain("Original <strong>HTML</strong>");
    expect(parsed.html).toContain("Source Person");
  });

  it("keeps a plain-text preface in HTML without deriving a plaintext source", async () => {
    const htmlSource = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "HTML source",
      text: "Source plain text",
      html: "<p>Source <strong>HTML</strong></p>",
      messageId: "<html-source@gadgets.invalid>",
      attachments: [],
    });
    const withPlainPreface = await api().buildForwardRaw(
      {id: "source", threadId: "thread", internalDate: "1", raw: htmlSource},
      ["recipient@example.com"], "Plain preface");
    const parsedWithPreface = await parseMimeMessage(withPlainPreface.raw);
    expect(parsedWithPreface.html).toContain("Plain preface");

    const htmlOnlySource = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "HTML only",
      text: "",
      html: "<p>Only HTML source</p>",
      messageId: "<html-only@gadgets.invalid>",
      attachments: [],
    });
    const forwardedHtmlOnly = await api().buildForwardRaw(
      {id: "source", threadId: "thread", internalDate: "1", raw: htmlOnlySource},
      ["recipient@example.com"]);
    const parsedHtmlOnly = await parseMimeMessage(forwardedHtmlOnly.raw);
    expect(parsedHtmlOnly.text).not.toContain("Only HTML source");
    expect(parsedHtmlOnly.html).toContain("Only HTML source");
  });

  it("rejects Message-IDs that could introduce Gmail search syntax", () => {
    expect(gmailMessageIdQueryValue("<safe-id@example.com>")).toBe("safe-id@example.com");
    expect(gmailMessageIdQueryValue("<CA+abc=def@mail.gmail.com>")).toBe("CA+abc=def@mail.gmail.com");
    expect(() => gmailMessageIdQueryValue("<x@x)OR(is:unread>")).toThrow(/safely/);
  });

  it("does not impose the compose body limit on a quoted source", async () => {
    const sourceRaw = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Large source",
      text: "x".repeat(70 * 1024),
      messageId: "<large-source@gadgets.invalid>",
      attachments: [],
    });
    const message = await api().buildForwardRaw(
      {id: "source", threadId: "thread", internalDate: "1", raw: sourceRaw},
      ["recipient@example.com"]);

    expect(message.body).toContain("x".repeat(70 * 1024));
  });

  it("treats any reply recipient field as a complete recipient override", async () => {
    const raw = buildEncodedEmail({
      from: "sender@example.com",
      to: ["me@example.com", "other@example.com"],
      cc: ["old-cc@example.com"],
      bcc: [],
      subject: "Original",
      text: "Source",
      messageId: "<source@example.com>",
      attachments: [],
    });
    const reply = await api().buildReplyRaw({
      id: "m1", threadId: "t1", raw, internalDate: "1",
    }, "Reply", true, {bcc: ["only@example.com"]}, "<reply@gadgets.invalid>");
    expect({to: reply.to, cc: reply.cc, bcc: reply.bcc})
      .toEqual({to: [], cc: [], bcc: ["only@example.com"]});
  });

  it("removes the connected mailbox from calculated Reply-To recipients", async () => {
    const raw = buildEncodedEmail({
      from: "sender@example.com",
      replyTo: ["me@example.com"],
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Original",
      text: "Source",
      messageId: "<source@example.com>",
      attachments: [],
    });
    await expect(api().buildReplyRaw({
      id: "m1", threadId: "t1", raw, internalDate: "1",
    }, "Reply", false)).rejects.toThrow(/no usable recipient/);
  });

  it("does not treat an untrusted matching From header as proof the message was sent", async () => {
    const raw = buildEncodedEmail({
      from: "me@example.com",
      to: ["victim@example.com"],
      cc: [],
      bcc: [],
      subject: "Spoofed",
      text: "Source",
      messageId: "<source@example.com>",
      attachments: [],
    });
    await expect(api().buildReplyRaw({
      id: "m1", threadId: "t1", raw, internalDate: "1", labelIds: ["INBOX"],
    }, "Reply", false)).rejects.toThrow(/no usable recipient/);
  });

  it("rejects non-Message-ID content in a References header", () => {
    expect(() => buildEncodedEmail({
      from: "me@example.com",
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      messageId: "<message@example.com>",
      references: "<parent@example.com>\r\nBcc: hidden@example.com",
      attachments: [],
    })).toThrow(/Invalid References/);
  });

  it("round-trips attachment filenames and canonicalizes Content-ID", async () => {
    const message = api().buildOutbound({
      from: "me@example.com",
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      messageId: "<message@example.com>",
      attachments: [{
        filename: "quoted \" caf\u00e9.txt",
        contentType: "text/plain",
        data: btoa("content"),
        disposition: "attachment",
        contentId: "asset-1",
        description: "attachment",
      }],
    });
    const attachment = (await parseMimeMessage(message.raw)).attachments[0];
    expect(attachment.filename).toBe("quoted \" caf\u00e9.txt");
    expect(attachment.contentId).toBe("<asset-1>");
  });

  it("preserves structured attachment Content-Type parameters", async () => {
    const contentType = 'text/plain; charset=iso-8859-1; format=flowed; x-note="semi;colon"';
    const original = api().buildOutbound({
      from: "me@example.com",
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Parameterized attachment",
      text: "Body",
      messageId: "<parameters@example.com>",
      attachments: [{
        filename: "notes.txt",
        contentType,
        data: btoa("content"),
        disposition: "attachment",
        description: "attachment",
      }],
    });
    const parsed = await parseGmailDraft({
      id: "draft", threadId: "thread", internalDate: "1", raw: original.raw,
    });
    expect(parsed.attachments[0].contentType).toBe(contentType);

    const rebuilt = api().buildOutbound({...parsed, from: parsed.from!, messageId: parsed.messageId!});
    const reparsed = await parseGmailDraft({
      id: "draft", threadId: "thread", internalDate: "1", raw: rebuilt.raw,
    });
    expect(reparsed.attachments[0].contentType).toBe(contentType);
  });

  it("correlates attachments after a headerless default text body", async () => {
    const boundary = "headerless-boundary";
    const raw = [
      "From: me@example.com",
      "To: to@example.com",
      "Subject: Headerless body",
      `Content-Type: multipart/mixed; boundary=${boundary}`,
      "",
      `--${boundary}`,
      "",
      "Default text body",
      `--${boundary}`,
      "Content-Type: application/octet-stream (source comment); x-format=opaque",
      "Content-Disposition: attachment (download); filename=data.bin",
      "Content-Transfer-Encoding: base64",
      "",
      "YQ==",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const parsed = await parseGmailDraft({
      id: "draft", threadId: "thread", internalDate: "1", raw: encodeRawEmail(raw),
    });

    expect(parsed.text).toBe("Default text body\n");
    expect(parsed.attachments[0].contentType).toBe(
      "application/octet-stream; x-format=opaque");
  });

  it("uses message/rfc822 as the default child type for multipart/digest", async () => {
    const raw = [
      "From: me@example.com",
      "To: to@example.com",
      "Subject: Digest",
      "Content-Type: multipart/digest; boundary=digest-boundary",
      "",
      "--digest-boundary",
      "",
      "From: nested@example.com",
      "To: me@example.com",
      "Subject: Nested",
      "Content-Type: multipart/mixed; boundary=nested-boundary",
      "",
      "--nested-boundary",
      "Content-Type: text/plain",
      "",
      "Nested body",
      "--nested-boundary",
      "Content-Type: application/pdf; profile=archive",
      "Content-Disposition: attachment; filename=document.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "YQ==",
      "--nested-boundary--",
      "--digest-boundary--",
      "",
    ].join("\r\n");

    const parsed = await parseGmailDraft({
      id: "draft", threadId: "thread", internalDate: "1", raw: encodeRawEmail(raw),
    });

    expect(parsed.attachments[0].contentType).toBe("application/pdf; profile=archive");
  });

  it("treats an extension-disposition message/rfc822 part as an attachment", async () => {
    const raw = [
      "From: me@example.com",
      "To: to@example.com",
      "Subject: Extension disposition",
      "Content-Type: multipart/mixed; boundary=outer-boundary",
      "",
      "--outer-boundary",
      "Content-Type: text/plain",
      "",
      "Body",
      "--outer-boundary",
      "Content-Type: message/rfc822; x-envelope=preserved",
      "Content-Disposition: preview; filename=nested.eml",
      "",
      "From: nested@example.com",
      "To: me@example.com",
      "Subject: Nested",
      "",
      "Nested body",
      "--outer-boundary--",
      "",
    ].join("\r\n");

    const parsed = await parseGmailDraft({
      id: "draft", threadId: "thread", internalDate: "1", raw: encodeRawEmail(raw),
    });

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      contentType: "message/rfc822; x-envelope=preserved",
      disposition: "attachment",
    });
  });

  it("keeps report message/rfc822 parts opaque while correlating metadata", async () => {
    const raw = [
      "From: mailer-daemon@example.com",
      "To: me@example.com",
      "Subject: Delivery report",
      "Content-Type: multipart/report; report-type=delivery-status; boundary=report-boundary",
      "",
      "--report-boundary",
      "Content-Type: text/plain",
      "",
      "Delivery failed.",
      "--report-boundary",
      "Content-Type: message/delivery-status",
      "",
      "Final-Recipient: rfc822; missing@example.com",
      "Action: failed",
      "--report-boundary",
      "Content-Type: message/rfc822; x-report=opaque",
      "",
      "This is intentionally not a parseable nested message.",
      "--report-boundary--",
      "",
    ].join("\r\n");

    const parsed = await parseGmailDraft({
      id: "draft", threadId: "thread", internalDate: "1", raw: encodeRawEmail(raw),
    });

    expect(parsed.attachments.map(attachment => attachment.contentType)).toEqual([
      "message/delivery-status",
      "message/rfc822; x-report=opaque",
    ]);
  });

  it("preserves calendar methods through draft parsing and rebuilding", async () => {
    const original = api().buildOutbound({
      from: "me@example.com",
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Invitation",
      text: "Calendar invitation attached.",
      messageId: "<calendar@example.com>",
      attachments: [{
        filename: "invite.ics",
        contentType: "text/calendar; method=REQUEST",
        data: btoa("BEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR\n"),
        disposition: "attachment",
        description: "Calendar invitation",
      }],
    });
    const parsed = await parseGmailDraft({
      id: "draft", threadId: "thread", internalDate: "1", raw: original.raw,
    });
    expect(parsed.attachments[0].contentType).toBe(
      "text/calendar; method=REQUEST; charset=utf-8");
    expect(atob(parsed.attachments[0].data)).toBe(
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n");

    const rebuilt = api().buildOutbound({
      ...parsed,
      from: parsed.from!,
      messageId: parsed.messageId!,
    });
    const reparsed = await parseGmailDraft({
      id: "draft", threadId: "thread", internalDate: "1", raw: rebuilt.raw,
    });
    expect(reparsed.attachments[0].contentType).toBe(
      "text/calendar; method=REQUEST; charset=utf-8");
  });

  it("preserves calendar methods while forwarding", async () => {
    const source = api().buildOutbound({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Invitation",
      text: "Please attend.",
      messageId: "<calendar-source@example.com>",
      attachments: [{
        filename: "invite.ics",
        contentType: "text/calendar; method=REQUEST",
        data: btoa("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n"),
        disposition: "attachment",
        description: "Calendar invitation",
      }],
    });
    const forwarded = await api().buildForwardRaw({
      id: "source", threadId: "thread", internalDate: "1", raw: source.raw,
    }, ["recipient@example.com"]);

    expect(forwarded.attachments[0].contentType).toBe(
      "text/calendar; method=REQUEST; charset=utf-8");
    const parsed = await parseGmailDraft({
      id: "forward", threadId: "thread", internalDate: "1", raw: forwarded.raw,
    });
    expect(parsed.attachments[0].contentType).toBe(
      "text/calendar; method=REQUEST; charset=utf-8");
  });

  it.each([
    "text/calendar; method=REQUE/ST",
    "text/calendar; method=REQUEST\r\nBcc: hidden@example.com",
  ])("rejects an unsafe calendar content type: %j", contentType => {
    expect(() => buildEncodedEmail({
      from: "me@example.com",
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Invitation",
      text: "Calendar invitation attached.",
      messageId: "<calendar@example.com>",
      attachments: [{
        filename: "invite.ics",
        contentType,
        data: btoa("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
        description: "Calendar invitation",
      }],
    })).toThrow(/Invalid attachment content type/);
  });

  it("attaches an RFC 5322 message as unencoded message/rfc822 bytes", async () => {
    const sourceRaw = [
      "From: source@example.com",
      "To: me@example.com",
      "Subject: Nested",
      "Message-ID: <nested@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "Exact nested body: caf\u00e9",
    ].join("\r\n");
    const sourceBytes = new TextEncoder().encode(sourceRaw);
    let binary = "";
    for (const byte of sourceBytes) binary += String.fromCharCode(byte);
    const message = api().buildOutbound({
      from: "me@example.com",
      to: ["t\u00e9st@example.com"],
      cc: [],
      bcc: [],
      subject: "Fwd: Nested",
      text: "Forwarded message attached.",
      messageId: "<forward@example.com>",
      attachments: [{
        filename: "forwarded-message.eml",
        contentType: "message/rfc822",
        data: btoa(binary),
        disposition: "attachment",
        description: "Complete original message",
      }],
    });

    const rawBytes = decodeBase64UrlToBytes(message.raw);
    const rawText = new TextDecoder().decode(rawBytes);
    expect(rawText).toMatch(/Content-Type: message\/rfc822;/);
    expect(rawText).toMatch(/Content-Transfer-Encoding: 8bit/);
    expect(rawText).not.toMatch(
      /Content-Type: message\/rfc822;[\s\S]{0,200}Content-Transfer-Encoding: base64/);
    const attachment = (await parseMimeMessage(message.raw)).attachments[0];
    expect(attachment.mimeType).toBe("message/rfc822");
    expect(containsBytes(rawBytes, sourceBytes)).toBe(true);
    expect(extractRfc822Attachments(message.raw)).toEqual([{
      bytes: sourceBytes,
      filename: "forwarded-message.eml",
      disposition: "attachment",
    }]);
  });

  it("parses base64-encoded message/rfc822 draft attachments", async () => {
    const nested = "From: nested@example.com\r\n\r\nNested body";
    const boundary = "draft-boundary";
    const raw = [
      "From: me@example.com",
      "To: to@example.com",
      "Subject: Draft",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body",
      `--${boundary}`,
      "Content-Type: message/rfc822",
      "Content-Disposition: attachment; filename=forwarded.eml",
      "Content-Transfer-Encoding: base64",
      "",
      btoa(nested),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const encoded = btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

    const parsed = await parseGmailDraft({
      id: "draft", threadId: "thread", internalDate: "1", raw: encoded,
    });

    expect(parsed.attachments).toHaveLength(1);
    expect(new TextDecoder().decode(Uint8Array.from(
      atob(parsed.attachments[0].data.replace(/\s/g, "")), char => char.charCodeAt(0))))
      .toBe(nested);
    expect(extractRfc822Attachments(encoded)).toEqual([]);
  });

  it.each(["7bit", "8bit", "binary"])(
    "extracts exact unencoded %s message/rfc822 bytes", transferEncoding => {
      const nested = `From: nested@example.com\r\n\r\nExact ${
        transferEncoding === "8bit" ? "caf\u00e9" : "body"}`;
      const boundary = "exact-boundary";
      const raw = [
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary} \t`,
        "Content-Type: message/rfc822",
        "Content-Disposition: attachment; filename=forwarded.eml",
        `Content-Transfer-Encoding: ${transferEncoding}`,
        "",
        nested,
        `--${boundary}-- \t`,
        "",
      ].join("\r\n");

      expect(extractRfc822Attachments(encodeRawEmail(raw))).toEqual([{
        bytes: new TextEncoder().encode(nested),
        filename: "forwarded.eml",
        disposition: "attachment",
      }]);
    });

  it.each(["base64", "quoted-printable"])(
    "skips %s-encoded message/rfc822 parts", transferEncoding => {
      const boundary = "encoded-boundary";
      const raw = [
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: message/rfc822",
        `Content-Transfer-Encoding: ${transferEncoding}`,
        "",
        transferEncoding === "base64"
          ? btoa("From: nested@example.com\r\n\r\nNested body")
          : "From: nested@example.com=0D=0A=0D=0ANested body",
        `--${boundary}--`,
        "",
      ].join("\r\n");

      expect(extractRfc822Attachments(encodeRawEmail(raw))).toEqual([]);
    });

  it("rejects a nested message that is not valid 7bit or 8bit MIME data", () => {
    expect(() => api().buildOutbound({
      from: "me@example.com",
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Fwd: Invalid",
      text: "Forwarded message attached.",
      messageId: "<forward@example.com>",
      attachments: [{
        filename: "forwarded-message.eml",
        contentType: "message/rfc822",
        data: btoa("From: source@example.com\r\n\r\nBody\nbad line ending"),
        disposition: "attachment",
        description: "Complete original message",
      }],
    })).toThrow(/CRLF line endings/);
  });
});

describe("Gmail draft write responses", () => {
  it.each([
    {id: 123, message: {id: "message"}},
    {id: "draft", message: {id: 123}},
    {id: "draft/other", message: {id: "message"}},
    {id: "draft", message: {id: "message/other"}},
  ])("rejects malformed create identities: %j", async result => {
    stubFetch([json(result)]);
    await expect(api().createDraft("raw")).rejects.toThrow(/invalid response/);
  });

  it("rejects a malformed update identity", async () => {
    stubFetch([json({id: "draft", message: []})]);
    await expect(api().updateDraft("draft", "raw")).rejects.toThrow(/invalid response/);
  });

  it("sanitizes malformed successful JSON responses", async () => {
    stubFetch([new Response("secret provider body", {status: 200})]);
    const result = api().createDraft("raw");
    await expect(result).rejects.toThrow(
      "Gmail accepted the draft creation but returned an invalid response.");
    await expect(result).rejects.not.toThrow(/secret provider body/);
  });
});

describe("Gmail attachment snapshots", () => {
  it.each([
    ["_w", 1],
    ["_w==", 1],
    ["__8", 2],
    ["__8=", 2],
    ["AQI=", 2],
    ["AQID", 3],
  ])("measures padded and unpadded base64url exactly: %s", (encoded, size) => {
    expect(base64UrlDecodedByteLength(encoded)).toBe(size);
    expect(decodeBase64UrlToBytes(encoded)).toHaveLength(size);
  });

  it.each(["A", "_w=", "__8==", "AQI==", "AQ=I", "AQI===", "AQI\n", "AB", "AB=="])(
    "rejects malformed base64url padding: %s",
    encoded => expect(() => base64UrlDecodedByteLength(encoded)).toThrow(/base64url/),
  );

  it("decodes message bodies without treating attached text as body content", () => {
    expect(parseGmailPayloadContent({
      mimeType: "multipart/mixed",
      parts: [{
        mimeType: "text/plain",
        headers: [{name: "Content-Type", value: "text/plain; charset=utf-8"}],
        body: {data: "aGVsbG8"},
      }, {
        mimeType: "text/html",
        headers: [{name: "Content-Disposition", value: "inline"}],
        body: {data: "PGI-aGVsbG88L2I-"},
      }, {
        mimeType: "text/plain",
        filename: "attached.txt",
        headers: [{name: "Content-Disposition", value: "attachment"}],
        body: {data: "c2VjcmV0"},
      }],
    })).toEqual({text: "hello", html: "<b>hello</b>"});
  });

  it("does not cross inline or nested attachment boundaries while reading bodies", () => {
    expect(parseGmailPayloadContent({
      mimeType: "multipart/mixed",
      parts: [{
        mimeType: "text/plain",
        headers: [
          {name: "Content-Disposition", value: "inline"},
          {name: "Content-ID", value: "<inline-text>"},
        ],
        body: {data: "c2VjcmV0"},
      }, {
        mimeType: "message/rfc822",
        filename: "attached.eml",
        headers: [{name: "Content-Disposition", value: "attachment"}],
        parts: [{mimeType: "text/plain", body: {data: "bmVzdGVkIHNlY3JldA"}}],
      }],
    })).toEqual({});
  });

  it("enumerates regular and inline MIME parts and marks oversized parts unreadable", () => {
    const snapshots = enumerateGmailAttachments("m1", {
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          headers: [{name: "Content-Disposition", value: "attachment"}],
          body: {attachmentId: "a1", size: 12},
        },
        {
          partId: "2",
          mimeType: "image/png",
          headers: [
            {name: "Content-Disposition", value: "inline"},
            {name: "Content-ID", value: "<logo>"},
          ],
          body: {attachmentId: "a2", size: MAX_GMAIL_ATTACHMENT_BYTES + 1},
        },
      ],
    });
    expect(snapshots.map(item => item.info)).toEqual([
      {
        filename: "invoice.pdf", mimeType: "application/pdf", size: 12,
        disposition: "attachment", readable: true,
      },
      {
        filename: null, mimeType: "image/png", size: MAX_GMAIL_ATTACHMENT_BYTES + 1,
        disposition: "inline", contentId: "logo", readable: false,
      },
    ]);
  });

  it("enumerates an unnamed non-body MIME leaf", () => {
    expect(enumerateGmailAttachments("m1", {
      partId: "1",
      mimeType: "application/octet-stream",
      body: {data: "AQID", size: 3},
    })[0]?.info).toEqual({
      filename: null,
      mimeType: "application/octet-stream",
      size: 3,
      disposition: null,
      readable: true,
    });
  });

  it("reads inline base64url content lazily and verifies its snapshot size", async () => {
    const snapshot = enumerateGmailAttachments("m1", {
      partId: "1",
      mimeType: "application/octet-stream",
      filename: "a.bin",
      headers: [{name: "Content-Disposition", value: "attachment"}],
      body: {data: "AQID", size: 3},
    })[0];
    expect([...new Uint8Array(await api().getAttachmentContent(snapshot))]).toEqual([1, 2, 3]);
  });

  it("fetches a detached text body instead of silently returning it empty", async () => {
    stubFetch([json({data: "aGVsbG8"})]);
    await expect(api().getMessageContent({
      id: "m1",
      threadId: "t1",
      internalDate: "1",
      payload: {
        partId: "1",
        mimeType: "text/plain",
        headers: [{name: "Content-Type", value: "text/plain; charset=utf-8"}],
        body: {attachmentId: "a1", size: 5},
      },
    })).resolves.toEqual({text: "hello"});
  });

  it("refuses oversized attachment content before making a fetch", async () => {
    await expect(api().getAttachmentContent({
      key: "1",
      messageId: "m1",
      attachmentId: "a1",
      info: {
        filename: "large.bin",
        mimeType: "application/octet-stream",
        size: MAX_GMAIL_ATTACHMENT_BYTES + 1,
        disposition: "attachment",
        readable: false,
      },
    })).rejects.toThrow(/safe limit/);
  });
});

describe("Gmail API request shapes", () => {
  it("does not reconcile duplicate, mismatched, or non-sent Message-ID results", async () => {
    stubFetch([json({messages: [{id: "m1"}, {id: "m2"}]})]);
    await expect(api().findMessageByRfcMessageId("<same@example.com>", "delivered"))
      .resolves.toBeUndefined();

    stubFetch([
      json({messages: [{id: "m1"}]}),
      json({
        id: "m1", threadId: "t1", internalDate: "1",
        payload: {headers: [{name: "Message-ID", value: "<different@example.com>"}]},
      }),
    ]);
    await expect(api().findMessageByRfcMessageId("<same@example.com>", "delivered"))
      .resolves.toBeUndefined();

    stubFetch([
      json({messages: [{id: "m1"}]}),
      json({
        id: "m1", threadId: "t1", internalDate: "1",
        payload: {headers: [{name: "Message-ID", value: "<same@example.com>"}]},
      }),
    ]);
    await expect(api().findMessageByRfcMessageId("<same@example.com>", "delivered"))
      .resolves.toBeUndefined();
  });

  it("stops draft reconciliation when the provider repeats a page token", async () => {
    stubFetch([
      json({messages: [{id: "m1"}]}),
      json({
        id: "m1", threadId: "t1", internalDate: "1",
        payload: {headers: [{name: "Message-ID", value: "<draft@example.com>"}]},
      }),
      json({drafts: [], nextPageToken: "same"}),
      json({drafts: [], nextPageToken: "same"}),
    ]);

    await expect(api().findDraftByRfcMessageId("<draft@example.com>"))
      .rejects.toThrow(/repeated page token/);
  });

  it("lists individual messages with query, label, and page token", async () => {
    const calls = stubFetch([json({messages: [], nextPageToken: "next"})]);
    await api().listMessages(20, "is:unread", "page", ["INBOX"]);
    expect(calls[0].url.pathname).toBe("/gmail/v1/users/me/messages");
    expect(calls[0].url.searchParams.get("q")).toBe("is:unread");
    expect(calls[0].url.searchParams.get("labelIds")).toBe("INBOX");
    expect(calls[0].url.searchParams.get("pageToken")).toBe("page");
  });

  it.each([
    ["in:anywhere", "true"],
    ["from:a@example.com in:spam", "true"],
    ["label:trash is:unread", "true"],
    ["(in:spam) AND (is:unread)", "true"],
    ["{in:trash is:unread}", "true"],
    ['"in:spam"', null],
    ['subject:"in:spam"', null],
    ['"quoted in:trash text"', null],
    ['i"ignored"n:trash', null],
    ["-in:spam", null],
    ["-(in:spam)", null],
    ["-{in:trash is:unread}", null],
    ["subject:(in:trash)", null],
    ["subject:in:trash", null],
    ["label:anywhere", null],
  ])("sets includeSpamTrash only for positive standalone operators in %j", async (
      query, expected) => {
    const calls = stubFetch([json({messages: []}), json({threads: []})]);
    await api().listMessages(20, query);
    await api().listThreads(20, query);
    expect(calls.map(call => call.url.searchParams.get("includeSpamTrash")))
      .toEqual([expected, expected]);
  });

  it("includes spam and trash when label scope explicitly requests them", async () => {
    const calls = stubFetch([json({messages: []}), json({threads: []})]);
    await api().listMessages(20, undefined, undefined, ["SPAM"]);
    await api().listThreads(20, undefined, undefined, ["TRASH"]);
    expect(calls.map(call => call.url.searchParams.get("includeSpamTrash")))
      .toEqual(["true", "true"]);
  });

  it("searches all non-draft mail when reconciling a delivered Message-ID", async () => {
    const calls = stubFetch([json({messages: []})]);
    await expect(api().findMessageByRfcMessageId("<sent@example.com>", "delivered"))
      .resolves.toBeUndefined();
    expect(calls[0].url.searchParams.get("q"))
      .toBe("in:anywhere -in:drafts rfc822msgid:sent@example.com");
    expect(calls[0].url.searchParams.get("includeSpamTrash")).toBe("true");
  });

  it("uses the per-message modify endpoint", async () => {
    const calls = stubFetch([new Response(null, {status: 204})]);
    await api().modifyMessage("m1", ["STARRED"], ["UNREAD"]);
    expect(calls[0].url.pathname).toBe("/gmail/v1/users/me/messages/m1/modify");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body)))
      .toEqual({addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"]});
  });

  it("creates drafts and renames labels through their resource endpoints", async () => {
    const calls = stubFetch([
      json({id: "d1", message: {id: "m1", threadId: "t1"}}),
      json({id: "Label_1", name: "Renamed", type: "user"}),
    ]);
    await api().createDraft("raw", "t1");
    await api().renameLabel("Label_1", "Renamed");
    expect(calls.map(call => [call.url.pathname, call.init.method])).toEqual([
      ["/gmail/v1/users/me/drafts", "POST"],
      ["/gmail/v1/users/me/labels/Label_1", "PATCH"],
    ]);
    expect(JSON.parse(String(calls[0].init.body)))
      .toEqual({message: {raw: "raw", threadId: "t1"}});
  });

  it("validates and normalizes created label responses", async () => {
    stubFetch([json({id: "Label_1", name: "New label"})]);
    await expect(api().createLabel("New label")).resolves.toEqual({
      id: "Label_1", name: "New label", type: "user",
    });

    stubFetch([json({id: "Label_1", name: "New label", type: "system"})]);
    await expect(api().createLabel("New label")).rejects.toThrow(/non-user label/);

    stubFetch([json({id: "Label_1"})]);
    await expect(api().createLabel("New label")).rejects.toThrow(/valid label name/);
  });

  it("validates renamed label responses", async () => {
    stubFetch([json({id: "Label_2", name: "New label", type: "user"})]);
    await expect(api().renameLabel("Label_1", "New label"))
      .rejects.toThrow(/different label ID/);
  });

  it("validates labels read for rename reconciliation", async () => {
    const calls = stubFetch([json({id: "Label_2", name: "New label", type: "user"})]);
    await expect(api().getLabel("Label_1")).rejects.toThrow(/different label ID/);
    expect(calls[0].url.pathname).toBe("/gmail/v1/users/me/labels/Label_1");
  });

  it("sends the exact approved draft MIME snapshot", async () => {
    const calls = stubFetch([json({id: "m1", threadId: "t1"})]);
    await api().sendDraft("d1", "approved-raw", "t1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      id: "d1",
      message: {raw: "approved-raw", threadId: "t1"},
    });
  });

  it("does not reflect query values from provider errors", async () => {
    stubFetch([json({error: {message: "Bad query: confidential acquisition"}}, 400)]);
    const error = await api().listMessages(20, "confidential acquisition").catch(value => value);
    expect(error.message).toBe("Gmail API messages.list failed [http=400]");
    expect(error.message).not.toContain("confidential");
  });

  it("preserves Gmail API errors when response cancellation fails", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    stubFetch([new Response(new ReadableStream({cancel}), {status: 400})]);
    const error = await api().listMessages(20).catch(value => value);
    expect(cancel).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(GmailApiError);
    expect(error.status).toBe(400);
  });
});
