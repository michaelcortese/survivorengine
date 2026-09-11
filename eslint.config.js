// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "*.bin"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Type-aware linting: the engine's correctness guarantees lean on the
        // type system, so rules that need type info are worth the slower run.
        //
        // `allowDefaultProject` exists for THIS file. No tsconfig covers
        // `eslint.config.js` — `tsconfig.test.json` includes `*.config.ts`, not `.js` —
        // so `npm run check` (which runs `eslint .`, not `eslint src`) died on a
        // parsing error before linting anything else. A gate that fails for a reason
        // unrelated to the code is a gate people learn to ignore.
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The engine must never fire and forget: a dropped promise in a command
      // handler silently loses a player's action.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // This rule — NOT `noFallthroughCasesInSwitch`, which only catches a case falling into
      // the next one — is what makes a missing CardKind/ActionKind/CouncilPhase a build
      // failure (audit #74: 13 of 47 deck cards had no implementation and nothing noticed).
      //
      // `considerDefaultExhaustiveForUnions: false` is the option that matters, and it is NOT
      // `allowDefaultCaseForExhaustiveSwitch`: this is the one that decides whether adding a
      // `default` lets a switch stop being checked. It must stay false so a missing union
      // member is still an error even when a default is present.
      // `allowDefaultCaseForExhaustiveSwitch` must stay TRUE, because the house style is
      // `default: return assertNever(x, "ctx")` from engine/types.ts — a runtime guard for
      // values that arrive from outside the type system (a restored snapshot, a Discord
      // custom_id). Setting it false would ban exactly that pattern.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          allowDefaultCaseForExhaustiveSwitch: true,
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    // The engine dependency rule, enforced rather than documented. ARCHITECTURE.md §1 said it
    // "is checkable in CI with a one-line grep and should be" — and then nothing checked it.
    // Today the rule holds only because every engine import of ../config.js happens to be an
    // `import type`; the instant someone writes `import { engineConfig } from "../config.js"`
    // the engine acquires a runtime dependency on process.env with zero test failures.
    files: ["src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["discord.js", "discord.js/*", "node:*", "**/discord/**"],
              message:
                "src/engine must stay pure: no discord.js, no node builtins, no platform code.",
            },
          ],
          paths: [
            {
              name: "../config.js",
              importNames: ["config", "engineConfig", "loadConfig", "validateConfig"],
              message:
                "The engine receives EngineConfig as a parameter. Importing the live config binds it to process.env.",
            },
          ],
        },
      ],
      // `Date.now()`/`setTimeout` would defeat determinism; `process` would defeat purity.
      "no-restricted-globals": [
        "error",
        { name: "process", message: "The engine has no environment." },
        { name: "setTimeout", message: "The engine has no clock. Use tick(nowMs)." },
        { name: "setInterval", message: "The engine has no clock. Use tick(nowMs)." },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Date",
          property: "now",
          message: "The engine has no clock: every entry point takes nowMs.",
        },
        {
          object: "Math",
          property: "random",
          message: "Use the seeded Rng so games are reproducible (audit #17/#58).",
        },
      ],
    },
  },
  {
    // `tsconfig.json` builds the shipped bundle, so it has `rootDir: "./src"` and excludes
    // `tests/`. The project service only ever looks for a `tsconfig.json`, so with nothing
    // else said every test file lints as "not found by the project service" — which is a
    // PARSING error, i.e. the test suite is not linted at all rather than linted leniently.
    // `tsconfig.test.json` is the config that already covers `tests/` and the root
    // `*.config.ts`, so type-aware linting is pointed at it for exactly those files.
    files: ["tests/**/*.ts", "*.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { "no-console": "off" },
  },
  prettier,
);
