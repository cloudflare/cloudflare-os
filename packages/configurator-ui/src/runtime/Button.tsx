import { Button as KumoButton } from "@cloudflare/kumo/components/button";
import type { ReactNode } from "react";
import type { ButtonProps } from "../index.ts";

/**
 * `aria-disabled` rather than `disabled`, which would drop focus from a Button that disables itself
 * on click (Convert, while it converts); the classes are Kumo's own for a disabled Button.
 */
export const Button = ({ children, onClick, disabled = false, variant = "primary" }: ButtonProps) => (
  <KumoButton
    variant={variant}
    aria-disabled={disabled || undefined}
    className={disabled ? "cursor-not-allowed opacity-50" : undefined}
    onClick={() => {
      if (!disabled) onClick();
    }}
  >
    {children as ReactNode}
  </KumoButton>
);
