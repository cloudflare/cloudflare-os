import { describe, expect, it } from "vitest";
import { listUrl, parseListRef, parsePostRef, parseUsernameRef, parseXUrl, postUrl, profileUrl } from "../src/x-urls";

describe("parseXUrl", () => {
  it.each([
    ["https://x.com/jack/status/20", "20"],
    ["https://twitter.com/jack/status/20", "20"],
    ["https://www.x.com/jack/status/20?s=20&t=abc", "20"],
    ["https://mobile.twitter.com/jack/status/20/photo/1", "20"],
    ["https://x.com/jack/status/20/analytics", "20"],
    ["https://x.com/i/web/status/20", "20"],
    ["https://x.com/i/status/20", "20"],
    ["http://x.com/jack/status/1234567890123456789", "1234567890123456789"],
    ["  https://X.COM/jack/status/20  ", "20"],
  ])("reads %s as a post", (url, postId) => {
    expect(parseXUrl(url)).toEqual({ kind: "post", postId });
  });

  it.each([
    ["https://x.com/i/lists/1234", "1234"],
    ["https://twitter.com/i/lists/1234/members", "1234"],
    ["https://www.x.com/i/lists/1234/info?ref=share", "1234"],
  ])("reads %s as a List", (url, listId) => {
    expect(parseXUrl(url)).toEqual({ kind: "list", listId });
  });

  it.each([
    ["https://x.com/jack", "jack"],
    ["https://x.com/jack/", "jack"],
    ["https://twitter.com/Jack_Dorsey", "Jack_Dorsey"],
    ["https://mobile.x.com/jack/with_replies", "jack"],
    ["https://x.com/jack/media", "jack"],
    ["https://x.com/jack/followers?lang=en", "jack"],
    ["https://x.com/jack/verified_followers", "jack"],
  ])("reads %s as a profile", (url, username) => {
    expect(parseXUrl(url)).toEqual({ kind: "profile", username });
  });

  it("reads the account settings page as the whole account", () => {
    expect(parseXUrl("https://x.com/settings/account")).toEqual({ kind: "account" });
    expect(parseXUrl("https://twitter.com/settings/account/")).toEqual({ kind: "account" });
  });

  it.each([
    "https://x.com/",
    "https://x.com/home",
    "https://x.com/explore",
    "https://x.com/Settings",
    "https://x.com/i",
    "https://x.com/i/bookmarks",
    "https://x.com/settings/profile",
    "https://x.com/jack/likes",
    "https://x.com/jack/status/abc",
    "https://x.com/jack/status/12345678901234567890",
    "https://x.com/this_handle_is_too_long",
    "https://docs.x.com/jack",
    "https://x.com.evil.example/jack",
    "https://x.com:8443/jack",
    "https://user:secret@x.com/jack",
    "ftp://x.com/jack",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("names nothing for %j", url => {
    expect(parseXUrl(url)).toBeNull();
  });
});

describe("references", () => {
  it("reads post references", () => {
    expect(parsePostRef("20")).toBe("20");
    expect(parsePostRef(" ~3 ")).toBe("~3");
    expect(parsePostRef("https://x.com/jack/status/20")).toBe("20");
    expect(() => parsePostRef("https://x.com/i/lists/20")).toThrow(/post ID/);
    expect(() => parsePostRef("~")).toThrow();
  });

  it("reads List references", () => {
    expect(parseListRef("1234")).toBe("1234");
    expect(parseListRef("~1")).toBe("~1");
    expect(parseListRef("https://x.com/i/lists/1234")).toBe("1234");
    expect(() => parseListRef("https://x.com/jack")).toThrow(/List ID/);
  });

  it("reads usernames, refusing pages X reserves", () => {
    expect(parseUsernameRef("@jack")).toBe("jack");
    expect(parseUsernameRef("jack")).toBe("jack");
    expect(parseUsernameRef("https://x.com/jack/media")).toBe("jack");
    expect(() => parseUsernameRef("home")).toThrow(/username/);
    expect(() => parseUsernameRef("@")).toThrow();
    expect(() => parseUsernameRef("has space")).toThrow();
    expect(() => parseUsernameRef("https://x.com/jack/status/20")).toThrow();
  });
});

describe("canonical links", () => {
  it("builds links X serves", () => {
    expect(postUrl("20", "jack")).toBe("https://x.com/jack/status/20");
    expect(postUrl("20")).toBe("https://x.com/i/web/status/20");
    expect(profileUrl("jack")).toBe("https://x.com/jack");
    expect(listUrl("1234")).toBe("https://x.com/i/lists/1234");
  });
});
