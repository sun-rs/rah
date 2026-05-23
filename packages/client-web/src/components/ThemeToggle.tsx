import { Moon, Sun } from "lucide-react";
import { useAppearance, useTheme } from "../hooks/useTheme";
import { SegmentedButton, SegmentedButtonLabel, SegmentedControl } from "./SegmentedControl";

export function ThemeToggle() {
  const { appearance, setAppearance } = useAppearance();
  const { colorScheme } = useTheme();

  const isLight =
    appearance === "light" || (appearance === "system" && colorScheme === "light");

  return (
    <SegmentedControl size="compact" className="flex w-full gap-1" role="group" ariaLabel="Theme">
      <SegmentedButton
        size="compact"
        selected={isLight}
        aria-label="Light"
        aria-pressed={isLight}
        title="Light"
        onClick={() => setAppearance("light")}
        className="flex-1 gap-1"
      >
        <Sun size={13} />
        <SegmentedButtonLabel size="compact">Light</SegmentedButtonLabel>
      </SegmentedButton>
      <SegmentedButton
        size="compact"
        selected={!isLight}
        aria-label="Dark"
        aria-pressed={!isLight}
        title="Dark"
        onClick={() => setAppearance("dark")}
        className="flex-1 gap-1"
      >
        <Moon size={13} />
        <SegmentedButtonLabel size="compact">Dark</SegmentedButtonLabel>
      </SegmentedButton>
    </SegmentedControl>
  );
}
