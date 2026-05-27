import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "public/**",
    ],
  },
  {
    rules: {
      // Standard convention: leading-underscore vars/args are intentionally
      // unused (placeholder params, "captured but not consumed" locals).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Disabled: the markets/profile pages use `// label` strings as a
      // styled UI element (rendered as visible header text). These are
      // not accidental JS comments leaking into JSX.
      "react/jsx-no-comment-textnodes": "off",
      // Disabled: stylistic only — `'` and `&apos;` render identically.
      "react/no-unescaped-entities": "off",
    },
  },
];
