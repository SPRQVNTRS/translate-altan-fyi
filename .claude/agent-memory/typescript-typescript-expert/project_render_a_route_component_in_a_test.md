---
name: render-a-route-component-in-a-test
description: createRoutesStub is how a route's default export renders in a node:test; MemoryRouter throws because SearchPanes reads useNavigation
metadata:
  type: project
---

To assert DOCUMENT ORDER on a real screen, render the route's default export:

```ts
const Stub = createRoutesStub([{ path: '/', Component: () => createElement(SearchRoute, props) }]);
renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Stub, { initialEntries: ['/'] })));
```

**Why:** a bare `MemoryRouter` is not a DATA router, and `SearchPanes` calls
`useNavigation`, which throws there. The stub carries no loader, so the render
is synchronous and `renderToStaticMarkup` sees the finished tree.

**How to apply:** `Route.ComponentProps` is
`{ loaderData, actionData, params, matches }`. `matches` is a tuple of the root
and layout modules with their own loader data; pass `[] as never` with a
`// SAFETY:` comment, which anti-slop requires. Example:
`tests/integration/anonymous-front-door-doors.test.ts`.
