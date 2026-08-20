import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("Codex-compatible typography contract", () => {
  test("uses the native Electron foreground and variable system-font weight", () => {
    const cssSource = readSource("./index.css");

    assert.match(cssSource, /--foreground:\s*#1a1c1f;/);
    assert.match(cssSource, /--app-fg:\s*#1a1c1f;/);
    assert.match(cssSource, /--app-font-weight:\s*445;/);
    assert.match(cssSource, /body\s*\{[\s\S]*font-weight:\s*var\(--app-font-weight\);/);
  });

  test("uses Codex-sized adjustable desktop conversation typography", () => {
    const tokenSource = readSource("./index.css");
    const proseSource = readSource("./styles.css");

    assert.match(tokenSource, /--rah-ui-font-size:\s*14px;/);
    assert.match(tokenSource, /--rah-code-font-size:\s*12px;/);
    assert.match(tokenSource, /--chat-font-weight:\s*430;/);
    assert.match(tokenSource, /--chat-font-size:\s*var\(--rah-ui-font-size\);/);
    assert.match(
      tokenSource,
      /--chat-line-height:\s*calc\(var\(--chat-font-size\) \+ 8px\);/,
    );
    assert.match(
      proseSource,
      /\.chat-body-text,[\s\S]*\.prose-chat-final\s*\{[\s\S]*line-height:\s*var\(--chat-line-height\);/,
    );
    assert.match(
      proseSource,
      /\[data-chat-density="desktop"\]\s*\{[\s\S]*?--chat-font-size:\s*var\(--rah-ui-font-size\);[\s\S]*?--chat-line-height:\s*calc\(var\(--chat-font-size\) \+ 8px\);/,
    );
    assert.match(
      proseSource,
      /\.prose-chat-final\s*\{[\s\S]*?font-weight:\s*var\(--chat-font-weight\);/,
    );
  });

  test("uses readable copy and compact turn geometry in the iOS PWA", () => {
    const proseSource = readSource("./styles.css");
    const threadSource = readSource("./components/chat/ChatThread.tsx");
    const userMessageSource = readSource("./components/chat/UserMessage.tsx");
    const assistantMessageSource = readSource("./components/chat/AssistantMessage.tsx");

    assert.match(
      threadSource,
      /data-chat-density=\{isPwaDisplayMode \? "mobile" : "desktop"\}/,
    );
    assert.match(threadSource, /const DESKTOP_CHAT_DISPLAY_ROW_GAP_PX = 14;/);
    assert.match(threadSource, /const PWA_CHAT_DISPLAY_ROW_GAP_PX = 12;/);
    assert.match(
      proseSource,
      /\.chat-thread-shell\[data-chat-density="mobile"\]\s*\{[\s\S]*?--chat-font-size:\s*var\(--rah-ui-font-size\);[\s\S]*?--chat-line-height:\s*calc\(var\(--chat-font-size\) \+ 8px\);/,
    );
    assert.match(userMessageSource, /className="chat-user-message-content /);
    assert.match(userMessageSource, /className="chat-user-message-actions /);
    assert.match(
      proseSource,
      /\[data-chat-density="mobile"\] \.chat-user-message-content\s*\{\s*max-width:\s*75%;/,
    );
    assert.match(
      proseSource,
      /\[data-chat-density="mobile"\] \.chat-user-message-actions\s*\{\s*display:\s*none;/,
    );
    assert.match(
      proseSource,
      /\.assistant-process-message\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?padding:\s*0;/,
    );
    assert.doesNotMatch(
      assistantMessageSource,
      /prose-chat-process[^"\n]*text-\[14px\]/,
    );
  });

  test("limits live Appearance changes to 12–20px conversation text", () => {
    const preferenceSource = readSource("./hooks/useAppearancePreferences.ts");
    const settingsSource = readSource("./components/SettingsPane.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");

    assert.match(preferenceSource, /UI_FONT_SIZE_MIN = 12;/);
    assert.match(preferenceSource, /UI_FONT_SIZE_MAX = 20;/);
    assert.match(preferenceSource, /UI_FONT_SIZE_DEFAULT = 14;/);
    assert.match(preferenceSource, /CODE_FONT_SIZE_DEFAULT = 12;/);
    assert.match(preferenceSource, /codeFontSizeForConversation/);
    assert.match(preferenceSource, /Math\.max\(11, Math\.min\(16, normalized - 2\)\)/);
    assert.match(preferenceSource, /rah-ui-font-size/);
    assert.match(preferenceSource, /rah-code-font-size/);
    assert.match(settingsSource, /label="Conversation text size"/);
    assert.match(settingsSource, /12–20px/);
    assert.match(settingsSource, /type="range"/);
    assert.match(settingsSource, /Changes Session and Council conversation text only, immediately/);
    assert.doesNotMatch(settingsSource, /label="Code font size"/);
    assert.match(settingsSource, /props\.onChange\(Math\.round\(parsed\)\)/);
    assert.match(councilSource, /rah-conversation-text/);
  });

  test("uses bounded wrapping image thumbnails instead of full-width stacked media", () => {
    const proseSource = readSource("./styles.css");
    const imageSource = readSource("./components/chat/LocalImageResource.tsx");
    const markdownSource = readSource("./components/chat/MarkdownRenderer.tsx");

    assert.match(
      proseSource,
      /\.prose-chat-media-grid\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?gap:\s*12px;/,
    );
    assert.match(
      proseSource,
      /\.prose-chat-image-thumbnail-local\s*\{[\s\S]*?max-height:\s*10rem;/,
    );
    assert.match(
      proseSource,
      /\.prose-chat-image-thumbnail-remote\s*\{[\s\S]*?max-height:\s*12\.5rem;/,
    );
    assert.doesNotMatch(imageSource, /max-h-\[min\(22rem,58vh\)\]/);
    assert.match(markdownSource, /coalesceMarkdownImageBlocks/);
  });

  test("separates primary Markdown sections without slicing every subsection", () => {
    const proseSource = readSource("./styles.css");
    const processSource = readSource("./assistant-process-styles.css");

    assert.match(
      processSource,
      /\.prose-chat-final > :first-child > h1:first-child,[\s\S]*\.prose-chat-final > :first-child > h4:first-child\s*\{\s*margin-top:\s*0;/,
    );
    assert.match(proseSource, /\.prose-chat h1:not\(:first-child\),/);
    assert.match(proseSource, /\.prose-chat h2:not\(:first-child\),/);
    assert.doesNotMatch(proseSource, /\.prose-chat h3:not\(:first-child\),/);
    assert.doesNotMatch(
      proseSource,
      /\.prose-chat-block:not\(:first-child\) > h3:first-child/,
    );
  });

  test("removes permanent desktop user-action whitespace while keeping copy reachable", () => {
    const proseSource = readSource("./styles.css");

    assert.match(
      proseSource,
      /\[data-chat-density="desktop"\] \.chat-user-message-actions\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/,
    );
    assert.match(
      proseSource,
      /\.chat-user-message-content:focus-within \.chat-user-message-actions\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/,
    );
  });

  test("keeps interactive local-file labels selectable without disabling file opening", () => {
    const proseSource = readSource("./styles.css");
    const markdownSource = readSource("./components/chat/MarkdownRenderer.tsx");
    const selectionSource = readSource("./components/chat/useConversationTextSelection.ts");

    assert.match(
      proseSource,
      /\.prose-chat-local-file-link,[\s\S]*?\.prose-chat-local-file-code\s*\{[\s\S]*?-webkit-user-select:\s*text;[\s\S]*?user-select:\s*text;/,
    );
    assert.match(
      proseSource,
      /\.prose-chat-local-file-content > \.file-resource-icon\s*\{[\s\S]*?transform:\s*translateY\(0\.06em\);/,
    );
    assert.match(
      proseSource,
      /\.prose-chat-local-file-content[\s\S]*?> \.file-resource-icon\[data-file-icon-name="table"\]\s*\{[\s\S]*?transform:\s*translateY\(0\.14em\);/,
    );
    assert.match(markdownSource, /data-selectable-conversation-text="true"/);
    assert.match(markdownSource, /selectionIntersectsNode\(window\.getSelection\(\), event\.currentTarget\)/);
    assert.match(
      selectionSource,
      /interactiveTarget && !target\?\.closest\("\[data-selectable-conversation-text='true'\]"\)/,
    );
  });

  test("uses the Codex Desktop light diff palette and separate gutter tones", () => {
    const tokenSource = readSource("./index.css");
    const previewSource = readSource("./inspector/InspectorPreviewDisplays.tsx");

    assert.match(tokenSource, /--diff-add-bg:\s*#e7f4e7;/);
    assert.match(tokenSource, /--diff-add-gutter-bg:\s*#edf7ed;/);
    assert.match(tokenSource, /--diff-add-gutter:\s*#00a241;/);
    assert.match(tokenSource, /--diff-remove-bg:\s*#fce7e2;/);
    assert.match(tokenSource, /--diff-remove-gutter-bg:\s*#fdece9;/);
    assert.match(tokenSource, /--diff-remove-gutter:\s*#ba2722;/);
    assert.match(tokenSource, /--diff-header-bg:\s*#f4f4f4;/);
    assert.match(tokenSource, /--diff-border:\s*#e8e8e8;/);
    assert.match(previewSource, /bg-\[var\(--diff-add-gutter-bg\)\]/);
    assert.match(previewSource, /bg-\[var\(--diff-remove-gutter-bg\)\]/);
  });
});
