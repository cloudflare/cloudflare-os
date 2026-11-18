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

const Picture = ({ bytes, type }: { bytes: Uint8Array; type: string }) => {
  const url = useObjectUrl(bytes, type);
  return url ? <img src={url} alt="" /> : null;
};

const sources = () => Array.from(host!.querySelectorAll("img"), (image) => image.getAttribute("src"));

const show = async (pictures: { bytes: Uint8Array; type: string }[]) => {
  await act(async () => root!.render(<>{pictures.map((picture, index) => <Picture key={index} {...picture} />)}</>));
  await expect.poll(() => sources().length).toBe(pictures.length);
};

it("shares one URL among the uses of the same bytes, and keeps it until the last lets go", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const png = new Uint8Array([137, 80, 78, 71]);
  const other = new Uint8Array([137, 80, 78, 71]);

  await show([{ bytes: png, type: "image/png" }, { bytes: png, type: "image/png" }, { bytes: other, type: "image/png" }]);
  const [first, second, third] = sources();
  expect(first).toMatch(/^blob:/);
  expect(second).toBe(first);
  expect(third).not.toBe(first);

  await show([{ bytes: png, type: "image/png" }]);
  expect(sources()).toEqual([first]);
  expect((await fetch(first!)).ok).toBe(true);
});

it("gives an SVG a data URL, whatever parameters its type carries", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  await show([{ bytes: svg, type: "image/svg+xml; charset=utf-8" }]);
  expect(sources()[0]).toMatch(/^data:image\/svg\+xml/);
});
