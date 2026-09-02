# ES Module Rules

## General Guidelines
- Assume ES Module environment when working on TypeScript or JS scripts
- Do not use `require()` - use ES imports instead

## Script Entry Points
```typescript
if (import.meta.url === import.meta.resolve('./some-script.ts')) {
  main();
}
```
