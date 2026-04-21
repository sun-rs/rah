import { Moon, Sun } from "lucide-react";
import { useAppearance, useTheme } from "../hooks/useTheme";

export function ThemeToggle() {
  const { appearance, setAppearance } = useAppearance();
  const { colorScheme } = useTheme();

  const isLight =
    appearance === "light" || (appearance === "system" && colorScheme === "light");

  return (
    <div className="flex w-full items-center rounded-lg bg-[var(--app-subtle-bg)] p-0.5">
      <button
        type="button"
        aria-label="Light"
        title="Light"
        onClick={() => setAppearance("light")}
        className={`flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium transition-all ${
          isLight
            ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
            : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
        }`}
      >
        <Sun size={13} />
        <span>Light</span>
      </button>
      <button
        type="button"
        aria-label="Dark"
        title="Dark"
        onClick={() => setAppearance("dark")}
        className={`flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium transition-all ${
          !isLight
            ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
            : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
        }`}
      >
        <Moon size={13} />
        <span>Dark</span>
      </button>
    </div>
  );
}
