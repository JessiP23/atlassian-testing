import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The ticket-to-PR agent is vendored here as tooling, not as product code: it is plain Node
    // ESM, it has its own conventions, and eslint-config-next reads its Playwright fixture
    // (`await use(page)`) as a misused React hook — one ERROR that failed `npm run lint`, and with
    // it the agent's own gate, on every ticket.
    "agent/**",
  ]),
]);

export default eslintConfig;
