import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const correctnessRules = {
  "no-constant-binary-expression": "error",
  "no-debugger": "error",
  "no-dupe-args": "error",
  "no-duplicate-case": "error",
  "no-ex-assign": "error",
  "no-func-assign": "error",
  "no-import-assign": "error",
  "no-new-native-nonconstructor": "error",
  "no-obj-calls": "error",
  "no-self-assign": "error",
  "no-setter-return": "error",
  "no-sparse-arrays": "error",
  "no-unreachable": "error",
  "no-unreachable-loop": "error",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "no-with": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.cache/**",
      "**/.vercel/**",
      "**/attached_assets/**",
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: correctnessRules,
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
    },
    rules: correctnessRules,
  },
];
