---
name: node24-test-reporter-is-spec
description: Node 24's test runner prints the spec reporter even when stdout is a pipe, so a checklist grepping "# pass" from pnpm run test:unit finds nothing and is unsatisfiable
metadata:
  type: project
---

`pnpm run test:unit` runs `node --test` with NO `--test-reporter`. On Node 24
the default is `spec` **whether or not stdout is a terminal**, so the summary
line is `ℹ pass 573`, never `# pass 573`.

**Why:** a verification command of the shape
`pnpm run test:unit 2>&1 | grep -E '^# (pass|fail)'` therefore prints NOTHING.
It is unsatisfiable rather than failing, which reads as a broken build.

**How to apply:** ask for the reporter explicitly whenever a check greps tap
output: `node --import tsx --experimental-test-module-mocks --no-warnings
--test --test-reporter=tap 'tests/unit/**/*.test.ts'`. Repair the CHECK, never
the code. Same class as [[project_node_test_summary_never_in_tail_5]].
