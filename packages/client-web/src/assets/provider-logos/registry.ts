import aionLogo from "./brand/aion.svg";
import auggieLogo from "./brand/auggie.svg";
import droidLogo from "./brand/droid.svg";
import hermesLogo from "./brand/hermes.svg";
import claudeLogo from "./ai-major/claude.svg";
import geminiLogo from "./ai-major/gemini.svg";
import mistralLogo from "./ai-major/mistral.svg";
import kimiLogo from "./ai-china/kimi.svg";
import qwenLogo from "./ai-china/qwen.svg";
import githubLogo from "./tools/github.svg";
import gooseLogo from "./tools/goose.svg";
import iflowLogo from "./tools/iflow.svg";
import nanobotLogo from "./tools/nanobot.svg";
import openclawLogo from "./tools/openclaw.svg";
import codebuddyLogo from "./tools/coding/codebuddy.svg";
import codexLogo from "./tools/coding/codex.svg";
import cursorLogo from "./tools/coding/cursor.png";
import opencodeLogo from "./tools/coding/opencode.svg";
import opencodeDarkLogo from "./tools/coding/opencode-dark.svg";
import opencodeLightLogo from "./tools/coding/opencode-light.svg";
import qoderLogo from "./tools/coding/qoder.png";

export const implementedProviderLogoRegistry = {
  codex: codexLogo,
  claude: claudeLogo,
  kimi: kimiLogo,
  gemini: geminiLogo,
  opencode: opencodeLogo,
  opencodeLight: opencodeLightLogo,
  opencodeDark: opencodeDarkLogo,
} as const;

export const reservedProviderLogoRegistry = {
  aionrs: aionLogo,
  qwen: qwenLogo,
  iflow: iflowLogo,
  codebuddy: codebuddyLogo,
  droid: droidLogo,
  goose: gooseLogo,
  hermes: hermesLogo,
  auggie: auggieLogo,
  copilot: githubLogo,
  openclaw: openclawLogo,
  "openclaw-gateway": openclawLogo,
  vibe: mistralLogo,
  nanobot: nanobotLogo,
  remote: openclawLogo,
  qoder: qoderLogo,
  cursor: cursorLogo,
} as const;

export const providerLogoRegistry = {
  ...implementedProviderLogoRegistry,
  ...reservedProviderLogoRegistry,
} as const;

export type ImplementedProviderLogoKey = keyof typeof implementedProviderLogoRegistry;
export type ReservedProviderLogoKey = keyof typeof reservedProviderLogoRegistry;
export type ProviderLogoKey = keyof typeof providerLogoRegistry;
