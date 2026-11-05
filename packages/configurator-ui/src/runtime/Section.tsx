import type { ReactNode } from "react";
import type { SectionProps } from "../index.ts";

export const Section = ({ title, children }: SectionProps) => (
  <section className="grid gap-4">
    {title ? <h2 className="m-0 text-base font-semibold text-kumo-default">{title}</h2> : null}
    {children as ReactNode}
  </section>
);
