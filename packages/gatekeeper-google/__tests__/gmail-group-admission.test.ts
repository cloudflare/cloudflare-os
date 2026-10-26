import { describe, expect, it } from "vitest";
import { admitsGroupMessage, type GmailGroupIdentity } from "../src/gmail-group-admission";
import type { GmailMessageFull } from "../src/google-api";

const GROUP: GmailGroupIdentity = { address: "team@example.com", aliases: ["team-alias@example.com"] };
const BOUNCE = "team+bncbdq6btefvucrbdu4wxlamgqexfx35cy@example.com";
const SIGNATURE = "J1MSAw4BYwbhRuTjoELVtm2BX1xZDrrrPB2pXf/tzqVnVQLZEUYxhi/ICjUWU3QOY1";

type Headers = Array<[string, string]>;

const message = (headers: Headers, labelIds = ["INBOX", "UNREAD"]): GmailMessageFull => ({
  id: "m1",
  threadId: "t1",
  labelIds,
  internalDate: "1791839761000",
  payload: { headers: headers.map(([name, value]) => ({ name, value })) },
});

/** A copy Google Groups delivered, as Gmail stores it behind an inbound gateway. */
const delivered = (change: (headers: Headers) => Headers = headers => headers): GmailMessageFull =>
  message(change([
    ["Return-Path", `<${BOUNCE}>`],
    ["Authentication-Results",
      "mx.google.com; dkim=pass header.i=@example.com header.s=google09082023 header.b=J1MSAw4B; " +
      "arc=pass (i=4 spf=pass spfdomain=example.com dkim=pass dkdomain=example.com); " +
      `spf=pass (google.com: domain of ${BOUNCE} designates 209.85.210.69 as permitted sender) ` +
      `smtp.mailfrom=${BOUNCE}; dara=neutral header.i=@example.com`],
    ["DKIM-Signature",
      "v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=google09082023; " +
      "h=list-unsubscribe:list-archive:list-help:list-post:list-id\r\n :mailing-list:precedence:to:subject:message-id:date:from; " +
      `bh=jawuQahE34SwBXH//nY+fuc/e/Nv6BrgDpKkqSxp/HA=; b=${SIGNATURE.slice(0, 30)}\r\n ${SIGNATURE.slice(30)}`],
    ["From", "Sender <sender@example.net>"],
    ["To", "team <team@example.com>"],
    ["Subject", "Launch notes"],
    ["List-ID", "<team.example.com>"],
  ]));

/** Mail sent straight to the owner, naming the group, and authenticated as `from`. */
const addressed = (to: string, auth: string, from = "Sender <sender@example.org>"): GmailMessageFull =>
  message([
    ["Return-Path", "<sender@example.org>"],
    ["Authentication-Results", auth],
    ["DKIM-Signature", `v=1; a=rsa-sha256; d=example.org; s=s1; h=from:to:subject:date; b=${SIGNATURE}`],
    ["From", from],
    ["To", to],
    ["Subject", "Re: Launch notes"],
  ]);

const DMARC_PASS = "mx.google.com; dkim=pass header.i=@example.org header.b=J1MSAw4B; " +
  "spf=pass smtp.mailfrom=sender@example.org; dmarc=pass (p=REJECT) header.from=example.org";

const replace = (name: string, value: string) => (headers: Headers): Headers =>
  headers.map(([key, current]) => key === name ? [key, value] : [key, current]);

describe("Gmail group admission: delivered through the group", () => {
  it("admits a copy the group delivered", () => {
    expect(admitsGroupMessage(GROUP, delivered())).toBe(true);
  });

  it("never admits drafts, spam or trash", () => {
    for (const label of ["DRAFT", "SPAM", "TRASH"]) {
      expect(admitsGroupMessage(GROUP, { ...delivered(), labelIds: ["INBOX", label] })).toBe(false);
    }
  });

  it("reads only the authentication results Gmail wrote on top", () => {
    const forgedBelow = delivered(headers => [
      ["Authentication-Results", "gateway.example.net; spf=pass smtp.mailfrom=sender@example.com"],
      ...headers,
    ]);
    expect(admitsGroupMessage(GROUP, forgedBelow)).toBe(false);
    const commentOnly = delivered(replace("Authentication-Results",
      `evil.test (mx.google.com); dkim=pass header.i=@example.com header.b=J1MSAw4B; spf=pass smtp.mailfrom=${BOUNCE}`));
    expect(admitsGroupMessage(GROUP, commentOnly)).toBe(false);
  });

  it("is not fooled by results hidden in comments", () => {
    const hidden = delivered(replace("Authentication-Results",
      `mx.google.com; spf=fail (; spf=pass smtp.mailfrom=${BOUNCE}; dkim=pass header.i=@example.com header.b=J1MSAw4B) ` +
      `smtp.mailfrom=${BOUNCE}`));
    expect(admitsGroupMessage(GROUP, hidden)).toBe(false);
  });

  it("needs the group's bounce address, not just any SPF pass", () => {
    for (const mailFrom of [
      "sender@example.com", "team@example.com", "team+bnc@example.com", "teamx+bncabc@example.com",
      "team+bncabc@example.com.evil.test", "team+bncabc@evil.test",
    ]) {
      const forged = delivered(headers => replace("Authentication-Results",
        `mx.google.com; dkim=pass header.i=@example.com header.b=J1MSAw4B; spf=pass smtp.mailfrom=${mailFrom}`,
      )(replace("Return-Path", `<${mailFrom}>`)(headers)));
      expect(admitsGroupMessage(GROUP, forged), mailFrom).toBe(false);
    }
  });

  it("needs SPF to pass", () => {
    expect(admitsGroupMessage(GROUP, delivered(replace("Authentication-Results",
      `mx.google.com; dkim=pass header.i=@example.com header.b=J1MSAw4B; spf=softfail smtp.mailfrom=${BOUNCE}`))))
      .toBe(false);
  });

  it("needs Return-Path to be the bounce address SPF passed", () => {
    expect(admitsGroupMessage(GROUP, delivered(replace("Return-Path", "<team+bncother@example.com>"))))
      .toBe(false);
    expect(admitsGroupMessage(GROUP, delivered(headers => headers.filter(([name]) => name !== "Return-Path"))))
      .toBe(false);
  });

  it("needs the group's own List-ID", () => {
    for (const listId of ["<team.example.com.evil.test>", "<other.example.com>", "team.example.com", ""]) {
      expect(admitsGroupMessage(GROUP, delivered(replace("List-ID", listId))), listId).toBe(false);
    }
    expect(admitsGroupMessage(GROUP, delivered(replace("List-ID", '"Team" <team.example.com>')))).toBe(true);
  });

  it("needs a passing DKIM signature from the group's domain that covers List-ID", () => {
    const withAuth = (auth: string) => delivered(replace("Authentication-Results",
      `mx.google.com; ${auth}; spf=pass smtp.mailfrom=${BOUNCE}`));
    expect(admitsGroupMessage(GROUP, withAuth("dkim=fail header.i=@example.com header.b=J1MSAw4B"))).toBe(false);
    expect(admitsGroupMessage(GROUP, withAuth("dkim=pass header.i=@evil.test header.b=J1MSAw4B"))).toBe(false);
    expect(admitsGroupMessage(GROUP, withAuth("dkim=pass header.i=@example.com"))).toBe(false);
    expect(admitsGroupMessage(GROUP, withAuth("dkim=pass header.i=@example.com header.b=Zzzzzzzz"))).toBe(false);
    expect(admitsGroupMessage(GROUP, withAuth("dkim=pass header.d=example.com header.b=J1MSAw4B"))).toBe(true);

    const uncovered = delivered(replace("DKIM-Signature",
      `v=1; d=example.com; s=google09082023; h=from:to:subject; b=${SIGNATURE}`));
    expect(admitsGroupMessage(GROUP, uncovered)).toBe(false);
    const otherSigner = delivered(replace("DKIM-Signature",
      `v=1; d=evil.test; s=s1; h=list-id:from; b=${SIGNATURE}`));
    expect(admitsGroupMessage(GROUP, otherSigner)).toBe(false);
  });
});

describe("Gmail group admission: addressed to the group", () => {
  it("admits mail naming the group whose sender DMARC authenticates", () => {
    expect(admitsGroupMessage(GROUP, addressed("team@example.com", DMARC_PASS))).toBe(true);
    expect(admitsGroupMessage(GROUP, addressed("Someone <someone@example.net>, TEAM@Example.com", DMARC_PASS)))
      .toBe(true);
    expect(admitsGroupMessage(GROUP, addressed("team-alias@example.com", DMARC_PASS))).toBe(true);
  });

  it("admits mail naming the group in Cc", () => {
    const cc = message([
      ["Authentication-Results", DMARC_PASS],
      ["From", "sender@example.org"],
      ["To", "owner@example.com"],
      ["Cc", "team@example.com"],
    ]);
    expect(admitsGroupMessage(GROUP, cc)).toBe(true);
  });

  it("matches recipient addresses exactly, never display names or look-alikes", () => {
    for (const to of [
      '"team@example.com" <attacker@evil.test>', "team@example.com.evil.test", "xteam@example.com",
      "team@example.co", "team+tag@example.com", "owner@example.com",
    ]) {
      expect(admitsGroupMessage(GROUP, addressed(to, DMARC_PASS)), to).toBe(false);
    }
  });

  it("needs the sender to be authenticated", () => {
    expect(admitsGroupMessage(GROUP, addressed("team@example.com",
      "mx.google.com; spf=pass smtp.mailfrom=sender@example.org; dmarc=fail header.from=example.org"))).toBe(false);
    expect(admitsGroupMessage(GROUP, addressed("team@example.com",
      "mx.google.com; dmarc=pass header.from=other.example"))).toBe(false);
    expect(admitsGroupMessage(GROUP, addressed("team@example.com",
      "relay.evil.test; dmarc=pass header.from=example.org"))).toBe(false);
  });

  it("accepts a DKIM signature aligned with the sender, as DMARC would", () => {
    const aligned = "mx.google.com; dkim=pass header.i=@example.org header.b=J1MSAw4B";
    expect(admitsGroupMessage(GROUP, addressed("team@example.com", aligned))).toBe(true);
    expect(admitsGroupMessage(GROUP, addressed("team@example.com", aligned, "sender@mail.example.org")))
      .toBe(true);
    expect(admitsGroupMessage(GROUP, addressed("team@example.com", aligned, "sender@example.org.evil.test")))
      .toBe(false);
    expect(admitsGroupMessage(GROUP, addressed("team@example.com", aligned, "sender@notexample.org")))
      .toBe(false);
  });

  it("ignores a Bcc on mail the owner received", () => {
    const bcc = message([
      ["Authentication-Results", DMARC_PASS],
      ["From", "sender@example.org"],
      ["To", "owner@example.com"],
      ["Bcc", "team@example.com"],
    ]);
    expect(admitsGroupMessage(GROUP, bcc)).toBe(false);
  });

  it("admits the owner's own mail to the group, Bcc included", () => {
    const sent = (header: string, value: string) =>
      message([["From", "owner@example.com"], ["To", "someone@example.net"], [header, value]], ["SENT"]);
    expect(admitsGroupMessage(GROUP, sent("Bcc", "team@example.com"))).toBe(true);
    expect(admitsGroupMessage(GROUP, sent("Cc", "team@example.com"))).toBe(true);
    expect(admitsGroupMessage(GROUP, sent("Cc", "other@example.com"))).toBe(false);
    expect(admitsGroupMessage(GROUP, { ...sent("Bcc", "team@example.com"), labelIds: ["SENT", "DRAFT"] }))
      .toBe(false);
  });
});
