import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  SEGMENTED_CONTROL_INACTIVE_CLASS,
  SEGMENTED_CONTROL_SIZE_CLASSES,
  type SegmentedControlSize,
} from "./segmented-control-styles";

function joinClasses(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function SegmentedControl(props: {
  children: ReactNode;
  className?: string;
  role?: string;
  size?: SegmentedControlSize;
  ariaLabel?: string;
}) {
  const size = props.size ?? "panel";
  return (
    <div
      className={joinClasses(SEGMENTED_CONTROL_SIZE_CLASSES[size].root, props.className)}
      role={props.role}
      aria-label={props.ariaLabel}
    >
      {props.children}
    </div>
  );
}

export function SegmentedButton({
  children,
  className,
  selected,
  size = "panel",
  type = "button",
  ...buttonProps
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  selected: boolean;
  size?: SegmentedControlSize;
}) {
  const sizeClasses = SEGMENTED_CONTROL_SIZE_CLASSES[size];
  return (
    <button
      {...buttonProps}
      type={type}
      className={joinClasses(
        sizeClasses.button,
        selected ? sizeClasses.active : SEGMENTED_CONTROL_INACTIVE_CLASS,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SegmentedButtonLabel(props: {
  children: ReactNode;
  className?: string;
  size?: SegmentedControlSize;
}) {
  const size = props.size ?? "panel";
  return (
    <span className={joinClasses(SEGMENTED_CONTROL_SIZE_CLASSES[size].label, props.className)}>
      {props.children}
    </span>
  );
}
