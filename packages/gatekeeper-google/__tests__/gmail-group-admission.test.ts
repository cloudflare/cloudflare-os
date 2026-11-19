import { describe, expect, it } from "vitest";
import {
  admittedGroupMessages, groupStanding, type GmailGroupIdentity,
} from "../src/gmail-group-admission";
import type { GmailMessageFull } from "../src/google-api";

const GROUP: GmailGroupIdentity = {
  address: "team@example.com", aliases: ["team-alias@example.com"], createdAt: Date.parse("2020-01-01T00:00:00Z"),
};
const BOUNCE = "team+bncbdq6btefvucrbdu4wxlamgqexfx35cy@example.com";
const SIGNATURE = "J1MSAw4BYwbhRuTjoELVtm2BX1xZDrrrPB2pXf/tzqVnVQLZEUYxhi/ICjUWU3QOY1";

type Headers = Array<[string, string]>;

/** Whether a message can be the group's at all: on its own, or in a conversation that is. */
const admitsGroupMessage = (group: GmailGroupIdentity, candidate: GmailMessageFull): boolean =>
  groupStanding(group, candidate) !== "none";

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

describe("Gmail group admission: who may start a conversation", () => {
  const INSIDE_PASS = "mx.google.com; dmarc=pass (p=REJECT) header.from=example.com";
  const inside = (id: string, to = "team@example.com"): GmailMessageFull => ({
    ...message([
      ["Authentication-Results", INSIDE_PASS], ["From", "Colleague <colleague@example.com>"],
      ["To", "owner@example.com"], ["Cc", to],
    ]),
    id,
  });
  const outside = (id: string): GmailMessageFull => ({ ...addressed("team@example.com", DMARC_PASS), id });
  const side = (id: string): GmailMessageFull => ({ ...addressed("owner@example.com", DMARC_PASS), id });

  it("takes mail the group delivered, the owner's own and a colleague's as the group's on their own", () => {
    expect(groupStanding(GROUP, delivered())).toBe("own");
    expect(groupStanding(GROUP, message([["From", "owner@example.com"], ["To", "team@example.com"]], ["SENT"])))
      .toBe("own");
    expect(groupStanding(GROUP, inside("m1"))).toBe("own");
  });

  it("takes mail from outside the group's domain that only names the group as a reply at most", () => {
    expect(groupStanding(GROUP, outside("m1"))).toBe("reply");
    // A subdomain or a look-alike of the group's domain is outside it.
    for (const from of ["sender@mail.example.com", "sender@example.com.evil.test", "sender@xexample.com"]) {
      const domain = from.slice(from.indexOf("@") + 1);
      const candidate = addressed("team@example.com", `mx.google.com; dmarc=pass header.from=${domain}`, from);
      expect(groupStanding(GROUP, candidate), from).toBe("reply");
    }
  });

  it("takes outside mail that names the group as the group's own on a binding that says it takes any", () => {
    const open = { ...GROUP, outsideSenders: true };
    expect(groupStanding(open, outside("m1"))).toBe("own");
    expect(admittedGroupMessages(open, [outside("m1"), side("m2")]).map(shown => shown.id)).toEqual(["m1"]);
    // Still only authenticated mail that names the group.
    expect(groupStanding(open, side("m2"))).toBe("none");
    expect(groupStanding(open, addressed("team@example.com",
      "mx.google.com; dmarc=fail header.from=example.org"))).toBe("none");
    expect(groupStanding(open, { ...outside("m1"), labelIds: ["SPAM"] })).toBe("none");
  });

  it("never takes another list's copy for the group's, though it is authenticated as the group's domain", () => {
    // An outsider wrote to an outward-facing list on the same domain and named this group too: the
    // list resent it under its own address, signed by the domain.
    const relisted = message([
      ["Return-Path", "<feedback+bncabc@example.com>"],
      ["Authentication-Results",
        "mx.google.com; dkim=pass header.i=@example.com header.b=J1MSAw4B; " +
        "spf=pass smtp.mailfrom=feedback+bncabc@example.com; dmarc=pass header.from=example.com"],
      ["DKIM-Signature", `v=1; d=example.com; s=s1; h=list-id:from:to:subject; b=${SIGNATURE}`],
      ["From", "'Mallory' via Feedback <feedback@example.com>"],
      ["To", "feedback@example.com"], ["Cc", "team@example.com"],
      ["List-ID", "<feedback.example.com>"],
    ]);
    expect(groupStanding(GROUP, relisted)).toBe("none");
    // Not as a reply in one of the group's conversations either, nor on a binding that takes anyone's mail.
    expect(admittedGroupMessages(GROUP, [{ ...delivered(), id: "m0" }, relisted]).map(shown => shown.id))
      .toEqual(["m0"]);
    expect(groupStanding({ ...GROUP, outsideSenders: true }, relisted)).toBe("none");
    // Another organization's list, with the author's own address kept.
    const elsewhere = { ...addressed("team@example.com", DMARC_PASS) };
    elsewhere.payload = { headers: [...elsewhere.payload!.headers!, { name: "List-ID", value: "<news.example.org>" }] };
    expect(groupStanding({ ...GROUP, outsideSenders: true }, elsewhere)).toBe("none");
  });

  it("takes nothing from before the group was created, when its address was another group's", () => {
    const before = String(GROUP.createdAt - 1);
    expect(groupStanding(GROUP, { ...delivered(), internalDate: before })).toBe("none");
    expect(groupStanding(GROUP, { ...inside("m1"), internalDate: before })).toBe("none");
    expect(groupStanding(GROUP, { ...delivered(), internalDate: String(GROUP.createdAt) })).toBe("own");
    expect(groupStanding(GROUP, { ...delivered(), internalDate: "not a date" })).toBe("none");
  });

  it("counts a colleague only when the group's own domain is what was authenticated", () => {
    const spoofed = message([
      ["Authentication-Results", DMARC_PASS], ["From", "colleague@example.com"], ["To", "team@example.com"],
    ]);
    expect(groupStanding(GROUP, spoofed)).toBe("none");
  });

  it("shows nothing of a conversation that outsiders alone addressed to the group", () => {
    expect(admittedGroupMessages(GROUP, [outside("m1"), outside("m2"), side("m3")])).toEqual([]);
  });

  it("shows an outsider's reply once the conversation holds a message that is the group's", () => {
    const thread = [outside("m1"), side("m2"), { ...delivered(), id: "m3" }, outside("m4")];
    expect(admittedGroupMessages(GROUP, thread).map(shown => shown.id)).toEqual(["m1", "m3", "m4"]);
    expect(admittedGroupMessages(GROUP, [outside("m1"), inside("m2")]).map(shown => shown.id)).toEqual(["m1", "m2"]);
  });

  it("doesn't count a draft, spam or trashed message as what makes a conversation the group's", () => {
    for (const label of ["DRAFT", "SPAM", "TRASH"]) {
      const thread = [outside("m1"), { ...delivered(), id: "m2", labelIds: ["INBOX", label] }];
      expect(admittedGroupMessages(GROUP, thread), label).toEqual([]);
    }
  });
});
