import type { ThemeRegistration } from "@shikijs/types";

/**
 * Provider-neutral Shiki themes derived from the semantic palette exposed by
 * Codex Desktop 26.715.61943. The Desktop bundle remains versioned evidence;
 * RAH owns this compact scope map and does not import private application code.
 */
export type CodexShikiThemeName = "codex-light" | "codex-dark";

type TokenRole =
  | "comment"
  | "string"
  | "number"
  | "regexp"
  | "keyword"
  | "variable"
  | "parameter"
  | "function"
  | "type"
  | "punctuation"
  | "invalid";

type TokenRule = {
  scope: string | string[];
  role: TokenRole;
  fontStyle?: string;
};

export const CODEX_LIGHT_TOKEN_COLORS: Readonly<Record<TokenRole, string>> = {
  comment: "#666666",
  string: "#008809",
  number: "#0071EA",
  regexp: "#001BCB",
  keyword: "#D53538",
  variable: "#BD5800",
  parameter: "#666666",
  function: "#751ED9",
  type: "#751ED9",
  punctuation: "#666666",
  invalid: "#F44747",
};

export const CODEX_DARK_TOKEN_COLORS: Readonly<Record<TokenRole, string>> = {
  comment: "#999999",
  string: "#85DF7B",
  number: "#6DCBF4",
  regexp: "#3D8DFF",
  keyword: "#F67576",
  variable: "#FA994C",
  parameter: "#999999",
  function: "#B06DFF",
  type: "#B06DFF",
  punctuation: "#999999",
  invalid: "#F44747",
};

// Keep general rules first and language-specific corrections later. TextMate
// selects the most specific matching scope; the order resolves equal matches.
const TOKEN_RULES: readonly TokenRule[] = [
  {
    scope: ["comment", "punctuation.definition.comment", "comment markup.link"],
    role: "comment",
  },
  {
    scope: [
      "string",
      "constant.other.symbol",
      "punctuation.definition.string.begin",
      "punctuation.definition.string.end",
    ],
    role: "string",
  },
  {
    scope: ["constant.numeric", "constant.language.boolean", "constant.language"],
    role: "number",
  },
  {
    scope: [
      "constant",
      "punctuation.definition.constant",
      "variable.other.constant",
      "support.constant",
    ],
    role: "variable",
  },
  {
    scope: [
      "keyword",
      "keyword.control",
      "storage",
      "storage.type",
      "storage.modifier",
      "token.storage",
    ],
    role: "keyword",
  },
  {
    scope: [
      "keyword.operator.new",
      "keyword.operator.expression.instanceof",
      "keyword.operator.expression.typeof",
      "keyword.operator.expression.void",
      "keyword.operator.expression.delete",
      "keyword.operator.expression.in",
      "keyword.operator.expression.of",
      "keyword.operator.expression.keyof",
      "keyword.operator.ternary",
      "keyword.operator.optional",
    ],
    role: "keyword",
  },
  {
    scope: [
      "variable",
      "identifier",
      "meta.definition.variable",
      "variable.other.readwrite",
      "meta.object-literal.key",
      "support.variable.property",
      "support.variable.object.process",
      "support.variable.object.node",
      "variable.language",
      "meta.property.object",
    ],
    role: "variable",
  },
  {
    scope: ["variable.parameter.function", "function.parameter", "variable.parameter"],
    role: "parameter",
  },
  {
    scope: [
      "support.function",
      "entity.name.function",
      "meta.function-call",
      "meta.require",
      "support.function.any-method",
      "variable.function",
      "keyword.other.special-method",
    ],
    role: "function",
  },
  {
    scope: [
      "support.type",
      "entity.name.type",
      "entity.name.class",
      "support.class",
      "entity.name.type.class",
      "entity.other.inherited-class",
      "support.type.primitive",
      "storage.type",
    ],
    role: "type",
  },
  {
    scope: ["entity.name.namespace", "entity.name.type.namespace"],
    role: "variable",
  },
  {
    scope: [
      "keyword.operator",
      "punctuation",
      "punctuation.separator.delimiter",
      "punctuation.separator.key-value",
      "punctuation.terminator",
      "meta.brace",
      "meta.brace.square",
      "meta.brace.round",
      "function.brace",
      "punctuation.definition.parameters",
      "punctuation.definition.typeparameters",
      "punctuation.definition.block",
      "punctuation.definition.tag",
    ],
    role: "punctuation",
  },
  {
    scope: [
      "keyword.operator.logical",
      "keyword.operator.bitwise",
      "keyword.operator.channel",
      "keyword.operator.arithmetic",
      "keyword.operator.comparison",
      "keyword.operator.relational",
      "keyword.operator.increment",
      "keyword.operator.decrement",
      "keyword.operator.assignment",
    ],
    role: "number",
  },
  { scope: "keyword.operator.assignment.compound", role: "keyword" },
  {
    scope: [
      "keyword.operator.assignment.compound.js",
      "keyword.operator.assignment.compound.ts",
    ],
    role: "number",
  },

  // JavaScript / TypeScript / JSX.
  { scope: "keyword.operator.expression.import", role: "function" },
  { scope: "keyword.operator.module", role: "keyword" },
  {
    scope: [
      "support.type.object.console",
      "support.module.node",
      "support.type.object.module",
      "entity.name.type.module",
      "support.constant.math",
      "support.constant.property.math",
      "support.constant.json",
      "support.variable.dom",
      "support.variable.property.dom",
      "support.variable.property.process",
      "variable.parameter.function.js",
    ],
    role: "variable",
  },
  { scope: "support.type.object.dom", role: "number" },
  {
    scope: [
      "keyword.other.template.begin",
      "keyword.other.template.end",
      "keyword.other.substitution.begin",
      "keyword.other.substitution.end",
    ],
    role: "string",
  },
  {
    scope: [
      "punctuation.definition.template-expression.begin",
      "punctuation.definition.template-expression.end",
      "punctuation.section.embedded.begin",
      "punctuation.section.embedded.end",
      "punctuation.quasi.element",
    ],
    role: "keyword",
  },
  {
    scope: ["punctuation.section.embedded", "variable.interpolation"],
    role: "variable",
  },
  {
    scope: [
      "support.type.primitive.ts",
      "support.type.builtin.ts",
      "support.type.primitive.tsx",
      "support.type.builtin.tsx",
      "support.type.type.flowtype",
    ],
    role: "type",
  },
  {
    scope: ["meta.tag.tsx", "meta.tag.jsx", "meta.tag.js", "meta.tag.ts"],
    role: "punctuation",
  },

  // Python.
  {
    scope: [
      "variable.parameter.function.language.python",
      "variable.parameter.function.python",
      "variable.parameter.function.language.special.self.python",
      "constant.character.format.placeholder.other.python",
    ],
    role: "variable",
  },
  {
    scope: [
      "punctuation.separator.period.python",
      "punctuation.separator.element.python",
      "punctuation.parenthesis.begin.python",
      "punctuation.parenthesis.end.python",
      "punctuation.definition.arguments.begin.python",
      "punctuation.definition.arguments.end.python",
      "punctuation.separator.arguments.python",
      "punctuation.definition.list.begin.python",
      "punctuation.definition.list.end.python",
    ],
    role: "punctuation",
  },
  { scope: "support.type.python", role: "number" },
  { scope: "keyword.operator.logical.python", role: "keyword" },
  {
    scope: ["meta.function-call.generic.python", "meta.function.decorator.python"],
    role: "function",
  },
  {
    scope: ["support.token.decorator.python", "meta.function.decorator.identifier.python"],
    role: "number",
  },

  // Rust.
  { scope: "storage.modifier.lifetime.rust", role: "punctuation" },
  { scope: "support.function.std.rust", role: "function" },
  { scope: "entity.name.lifetime.rust", role: "variable" },
  { scope: "variable.language.rust", role: "keyword" },
  { scope: "keyword.operator.misc.rust", role: "punctuation" },
  { scope: "keyword.operator.sigil.rust", role: "keyword" },
  { scope: "support.constant.core.rust", role: "variable" },

  // HTML / CSS.
  {
    scope: ["support.type.property-name.css", "support.type.vendored.property-name.css"],
    role: "number",
  },
  {
    scope: ["support.constant.property-value.css", "support.constant.property-value.scss"],
    role: "variable",
  },
  {
    scope: ["keyword.operator.css", "keyword.operator.scss", "keyword.operator.less"],
    role: "number",
  },
  { scope: "entity.other.attribute-name.class.css", role: "number" },
  { scope: "entity.other.attribute-name.id", role: "function" },
  {
    scope: ["entity.other.attribute-name.pseudo-element", "entity.other.attribute-name.pseudo-class"],
    role: "number",
  },
  { scope: ["meta.selector", "selector.sass", "entity.name.tag"], role: "keyword" },
  { scope: "entity.other.attribute-name", role: "number" },
  { scope: "constant.character.entity", role: "keyword" },
  { scope: "meta.tag", role: "punctuation" },

  // Markdown / diff.
  { scope: ["markup.heading", "entity.name.section.markdown"], role: "keyword" },
  { scope: "entity.name.section", role: "function" },
  {
    scope: [
      "markup.heading punctuation.definition.heading",
      "punctuation.definition.heading.markdown",
      "punctuation.definition.list.begin.markdown",
      "punctuation.definition.list.markdown",
      "beginning.punctuation.definition.list.markdown",
    ],
    role: "keyword",
  },
  { scope: ["markup.bold", "todo.bold", "punctuation.definition.bold"], role: "variable" },
  {
    scope: ["markup.italic", "punctuation.definition.italic", "todo.emphasis"],
    role: "keyword",
    fontStyle: "italic",
  },
  {
    scope: ["markup.underline.link.markdown", "markup.underline.link.image.markdown"],
    role: "keyword",
  },
  {
    scope: ["string.other.link.title.markdown", "string.other.link.description.markdown"],
    role: "function",
  },
  { scope: "punctuation.definition.metadata.markdown", role: "keyword" },
  { scope: ["markup.inline.raw.markdown", "markup.inline.raw.string.markdown"], role: "string" },
  {
    scope: [
      "punctuation.definition.string.begin.markdown",
      "punctuation.definition.string.end.markdown",
    ],
    role: "keyword",
  },
  { scope: "markup.quote.markdown", role: "punctuation" },
  { scope: "markup.changed.diff", role: "variable" },
  {
    scope: [
      "meta.diff.header.from-file",
      "meta.diff.header.to-file",
      "punctuation.definition.from-file.diff",
      "punctuation.definition.to-file.diff",
    ],
    role: "function",
  },
  { scope: "markup.inserted.diff", role: "string" },
  { scope: "markup.deleted.diff", role: "keyword" },

  // Regular expressions / JSON / YAML.
  { scope: "string.regexp", role: "regexp" },
  { scope: "constant.other.character-class.regexp", role: "keyword" },
  { scope: "keyword.operator.quantifier.regexp", role: "variable" },
  { scope: "constant.character.escape", role: "number" },
  {
    scope: [
      "source.json meta.structure.dictionary.json > string.quoted.json",
      "support.type.property-name.json",
      "support.type.property-name.json punctuation",
    ],
    role: "keyword",
  },
  {
    scope: [
      "source.json meta.structure.dictionary.json > value.json > string.quoted.json",
      "source.json meta.structure.array.json > value.json > string.quoted.json",
    ],
    role: "string",
  },
  {
    scope: [
      "source.json meta.structure.dictionary.json > constant.language.json",
      "source.json meta.structure.array.json > constant.language.json",
    ],
    role: "number",
  },
  {
    scope: ["punctuation.definition.block.sequence.item.yaml", "block.scope.begin", "block.scope.end"],
    role: "punctuation",
  },
  { scope: "token.info-token", role: "function" },
  { scope: "token.warn-token", role: "variable" },
  { scope: ["token.error-token", "invalid.illegal", "invalid.broken"], role: "invalid" },
];

function createCodexTheme(
  name: CodexShikiThemeName,
  type: "light" | "dark",
  foreground: string,
  background: string,
  palette: Readonly<Record<TokenRole, string>>,
): ThemeRegistration {
  return {
    name,
    displayName: type === "light" ? "Codex Light" : "Codex Dark",
    type,
    fg: foreground,
    bg: background,
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
    },
    tokenColors: TOKEN_RULES.map((rule) => ({
      scope: rule.scope,
      settings: {
        foreground: palette[rule.role],
        ...(rule.fontStyle ? { fontStyle: rule.fontStyle } : {}),
      },
    })),
    semanticTokenColors: {
      comment: palette.comment,
      string: palette.string,
      number: palette.number,
      regexp: palette.regexp,
      keyword: palette.keyword,
      variable: palette.variable,
      parameter: palette.parameter,
      property: palette.variable,
      function: palette.function,
      method: palette.function,
      type: palette.type,
      class: palette.type,
      namespace: palette.variable,
      enumMember: palette.number,
      "variable.constant": palette.variable,
      "variable.defaultLibrary": palette.variable,
    },
  };
}

export const CODEX_LIGHT_THEME = createCodexTheme(
  "codex-light",
  "light",
  "#0D0D0D",
  "#FFFFFF",
  CODEX_LIGHT_TOKEN_COLORS,
);

export const CODEX_DARK_THEME = createCodexTheme(
  "codex-dark",
  "dark",
  "#FCFCFC",
  "#111111",
  CODEX_DARK_TOKEN_COLORS,
);

export const CODEX_SHIKI_THEMES: readonly ThemeRegistration[] = [
  CODEX_LIGHT_THEME,
  CODEX_DARK_THEME,
];

export function codexShikiThemeForColorScheme(
  colorScheme: "light" | "dark",
): CodexShikiThemeName {
  return colorScheme === "dark" ? "codex-dark" : "codex-light";
}
