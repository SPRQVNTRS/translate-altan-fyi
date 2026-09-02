# TypeScript Rules

## TypeScript Compilation and Type Checking

### CRITICAL: Type Checking Commands
- **NEVER** run `tsc` without the `--noEmit` flag for type checking
- **ALWAYS** use `pnpm run typecheck` for type checking (this includes --noEmit)
- **NEVER** compile TypeScript to JavaScript unless explicitly building the project

### Correct Type Checking:
```bash
# ✅ CORRECT - Use the project's typecheck script
pnpm run typecheck

# ✅ CORRECT - If using tsc directly, always include --noEmit
tsc --noEmit

# ❌ WRONG - Never run tsc without --noEmit for checking
tsc                           # This creates .js files!
tsc some/file.ts             # This creates .js files!
```

### Why This Matters:
- Running `tsc` without `--noEmit` will compile TypeScript files to JavaScript
- This pollutes the source directories with unwanted `.js` files
- The project uses a build system - direct compilation breaks the build process
- Always use the provided npm/pnpm scripts for type checking

## TypeScript Path Resolution in Monorepo

### Module Resolution Strategy
This monorepo uses `moduleResolution: "Bundler"` for applications that use modern bundlers (Vite, React Router 7). This resolution mode doesn't properly inherit `paths` from extended tsconfig files due to TypeScript limitations.

### Path Mapping Requirements
**IMPORTANT**: Each application must define its own path mappings for workspace packages in its local `tsconfig.json` file. Path mappings cannot be inherited from `tsconfig.base.json` when using `moduleResolution: "Bundler"`.

### Configuration Pattern
Each app's `tsconfig.json` should include:
```json
{
  "compilerOptions": {
    "moduleResolution": "Bundler",
    "baseUrl": ".",
    "paths": {
      // App-specific paths
      "#app/*": ["./app/*"],

      // Workspace package paths (relative from app directory)
      "@org/logger": ["../../packages/logger/src/index.ts"],
      "@org/logger/http": ["../../packages/logger/src/http-middleware.ts"],
      "@org/llm": ["../../packages/llm/index.ts"],
      "@org/llm/*": ["../../packages/llm/src/*"]
    }
  }
}
```

### Package.json Exports Configuration
Workspace packages should have simplified `exports` fields pointing directly to TypeScript source files:
```json
{
  "exports": {
    ".": "./src/index.ts",
    "./http": "./src/http-middleware.ts"
  }
}
```

### Why This Approach?
- `moduleResolution: "Bundler"` is required for React Router 7 and modern bundler compatibility
- Path inheritance doesn't work with Bundler resolution - paths are resolved relative to the config file they're defined in
- This ensures proper IDE navigation (Ctrl+Click) to source files instead of node_modules
- Each app explicitly declares which workspace packages it uses, improving clarity

## Imports
- Imported types should always be at the very top of a file
- Prefer `import type` for types to avoid runtime baggage
- Use `satisfies` to enforce shape without widening when appropriate

## Basic Principles
- Use English for all code and documentation
- Always declare the type of each variable and function (parameters and return value)
- Never use `any` unless explicitly told to do so
- Create necessary types only when explicitly told to
- Use JSDoc to document public classes and methods
- Don't leave blank lines within a function
- One export per file

## Nomenclature
- Use PascalCase for classes
- Use camelCase for variables, functions, and methods
- Use kebab-case for file and directory names
- Use UPPERCASE for environment variables
- Avoid magic numbers and define constants
- Start each function with a verb
- Use verbs for boolean variables: `isLoading`, `hasError`, `canDelete`
- Use complete words instead of abbreviations and correct spelling
- Standard abbreviations allowed: API, URL, etc.
- Well-known abbreviations allowed: `i`, `j` for loops; `err` for errors; `ctx` for contexts; `req`, `res`, `next` for middleware
- Prefix internal helper functions with underscore `_` (not for class methods)

## Functions
- Write short functions with single purpose (less than 20 instructions)
- Name functions with verb + something else
- Boolean returns: use `isX`, `hasX`, `canX`
- Non-returns: use `executeX`, `saveX`
- Avoid nesting blocks with early checks and returns
- Use higher-order functions (map, filter, reduce) to avoid nesting
- Use arrow functions for simple functions (less than 3 instructions)
- Use named functions for non-simple functions
- Use default parameter values instead of checking null/undefined
- Reduce function parameters using RO-RO (Receive Object, Return Object)
- Use single level of abstraction

## If/Else and Early Returns
- Strongly prefer early returns to simplify logic and reduce nesting
- Avoid `if/else` blocks wherever possible
- Only use `if/else` when early return pattern is not feasible
- Prioritize flattening conditional logic through guard clauses
- Use guard clauses and early returns to keep type‑narrowing local and readable

## Type Safety & Inference
- Never use `any`. Prefer Zod inference (`z.infer<typeof Schema>`) and shared types
- Narrow `unknown` with runtime checks (e.g., property existence) rather than casting
- Favor discriminated unions and type guards over ad‑hoc casting
- Prefer `readonly` arrays/tuples and `as const` where it clarifies intent without hiding errors

## Comments
- Use JSDoc-style comments (`@param`, `@returns`, `@throws`) for **all** functions
- Use blocks of forward slashes (`////////////////////////////////`) to delineate logical sections

