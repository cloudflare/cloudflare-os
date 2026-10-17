import { Field as KumoField } from "@cloudflare/kumo/components/field";
import { createContext, useContext, type ReactNode } from "react";
import type { FieldProps } from "../index.ts";

const FieldLabelContext = createContext<string | null>(null);

/**
 * The label of the field a control sits in, for a control the field's `<label>` cannot name
 * because it is a group of inputs rather than one (a checkbox list), or that Kumo would otherwise
 * warn is unnamed.
 */
export const useFieldLabel = (): string | null => useContext(FieldLabelContext);

export const Field = ({ label, description, optional, children }: FieldProps) => (
  <KumoField label={label} description={description} required={optional ? false : undefined}>
    <FieldLabelContext.Provider value={label}>{children as ReactNode}</FieldLabelContext.Provider>
  </KumoField>
);
