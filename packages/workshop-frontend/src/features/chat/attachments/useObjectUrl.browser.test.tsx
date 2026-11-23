/* eslint-disable react/react-in-jsx-scope */
// Object URLs, in Chromium: jsdom does not implement them.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { useObjectUrl } from "./useObjectUrl";

let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

const Picture = ({ bytes, type }: { bytes: Uint8Array | Blob; type: string }) => {
  const url = useObjectUrl(bytes, type);
  return url ? <img src={url} alt="" /> : null;
};

const sources = () => Array.from(host!.querySelectorAll("img"), (image) => image.getAttribute("src"));

const show = async (pictures: { bytes: Uint8Array | Blob; type: string }[]) => {
  await act(async () => root!.render(<>{pictures.map((picture, index) => <Picture key={index} {...picture} />)}</>));
  await expect.poll(() => sources().length).toBe(pictures.length);
};

it.each(['bytes', 'blob'])("shares one URL among uses of the same %s until the last lets go", async format => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const image = () => format === 'blob' ? new Blob([Uint8Array.of(137, 80, 78, 71)]) : Uint8Array.of(137, 80, 78, 71);
  const png = image();
  const other = image();

  await show([{ bytes: png, type: "image/png" }, { bytes: png, type: "image/png" }, { bytes: other, type: "image/png" }]);
  const [first, second, third] = sources();
  expect(first).toMatch(/^blob:/);
  expect(second).toBe(first);
  expect(third).not.toBe(first);

  await show([{ bytes: png, type: "image/png" }]);
  expect(sources()).toEqual([first]);
  expect((await fetch(first!)).ok).toBe(true);
});

it.each(['bytes', 'blob'])("gives SVG %s an originless data URL, whatever parameters its type carries", async format => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  await show([{ bytes: format === 'blob' ? new Blob([svg]) : svg, type: "image/svg+xml; charset=utf-8" }]);
  expect(sources()[0]).toMatch(/^data:image\/svg\+xml/);
});
