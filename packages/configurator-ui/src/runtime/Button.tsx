import { Button as KumoButton } from "@cloudflare/kumo/components/button";
import type { ReactNode } from "react";
import type { ButtonProps } from "../index.ts";

/**
 * A Kumo button's props for `disabled`: `aria-disabled` rather than `disabled`, which would drop
 * focus from a button that disables itself on click (Convert, while it converts); the classes are
 * Kumo's own for a disabled button.
 */
export const disabledButtonProps = ({ onClick, disabled = false }: Pick<ButtonProps, "onClick" | "disabled">) => ({
  "aria-disabled": disabled || undefined,
  className: disabled ? "cursor-not-allowed opacity-50" : undefined,
  onClick: () => {
    if (!disabled) onClick();
  },
});

export const Button = ({ children, variant = "primary", ...props }: ButtonProps) => (
  <KumoButton variant={variant} {...disabledButtonProps(props)}>{children as ReactNode}</KumoButton>
);
