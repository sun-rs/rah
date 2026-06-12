import { UsersRound } from "lucide-react";

export function CouncilLogo(props: {
  className?: string;
  tone?: "orange" | "black";
  variant?: "card" | "bare";
}) {
  const variant = props.variant ?? "card";
  const tone = props.tone ?? "orange";
  const sizeClassName = props.className ?? "h-5 w-5";
  const baseClassName =
    variant === "bare"
      ? `inline-flex shrink-0 items-center justify-center overflow-hidden ${sizeClassName}`
      : `inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] dark:bg-[#27272a] ${sizeClassName}`;
  const orangeIconClassName =
    variant === "bare"
      ? "h-full w-full text-orange-700/90 dark:text-orange-300/90"
      : "h-[68%] w-[68%] text-orange-700/90 dark:text-orange-300/90";
  const blackIconClassName =
    variant === "bare"
      ? "h-full w-full text-current"
      : "h-[68%] w-[68%] text-black/90 dark:text-zinc-100/90";

  const iconClassName = tone === "black" ? blackIconClassName : orangeIconClassName;

  return (
    <span className={baseClassName} title="Council">
      <UsersRound className={iconClassName} aria-hidden="true" />
    </span>
  );
}
