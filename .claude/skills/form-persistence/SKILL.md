---
name: form-persistence
description: Persist form field values in sessionStorage so users don't lose work on page refresh. Use when creating new forms with user-editable content (create/entry forms, not edit forms).
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Form State Persistence

This skill ensures create/entry forms persist user input in sessionStorage, protecting against accidental data loss on refresh or navigation.

## When Claude Should Use This Skill

- Creating a new form that accepts user-generated content
- Adding fields to an existing create form
- Reviewing a form for missing persistence

## When NOT to Use

- **Edit forms** — server provides authoritative data via loader; persisting stale edits would conflict
- **Trivial operational forms** — 1-2 field forms like workflow triggers, search filters
- **Forms with only sensitive fields** — if a form only has passwords/tokens, skip entirely

## Core Utilities

### `useFormField` Hook

```typescript
import { useFormField } from '#app/hooks/use-form-field';

// Inside component:
const [value, setValue] = useFormField<string>(formId, 'fieldName', '');
```

- SSR-safe, API matches `useState`
- Key format in sessionStorage: `form:{formId}:{field}`

### `useClearForm` Hook

```typescript
import { useClearForm } from '#app/utils/form-storage';

const clearForm = useClearForm(formId);
// Call clearForm() on successful submission
```

## Form ID Conventions

| Form Type | Pattern | Example |
|-----------|---------|---------|
| Global | Simple name | `login`, `create-org`, `create-user` |
| Org-scoped | `{action}:{orgSlug}` | `create-article:acme`, `invite-user:acme` |

Org-scoped IDs prevent cross-org draft contamination.

## Pattern A — Uncontrolled `<Form>` (most forms)

Used for standard React Router `<Form>` with `useNavigation`.

```typescript
import { Form, useNavigation } from 'react-router';
import { useFormField } from '#app/hooks/use-form-field';
import { useClearForm } from '#app/utils/form-storage';
import { useEffect, useRef } from 'react';

export default function CreateThing({ loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  const [persistedName, setPersistedName] = useFormField('create-thing', 'name', '');
  const clearForm = useClearForm('create-thing');

  // Clear on successful redirect
  const prevState = useRef(navigation.state);
  useEffect(() => {
    if (navigation.state === 'loading' && navigation.formAction) {
      clearForm();
    }
    prevState.current = navigation.state;
  }, [navigation.state, navigation.formAction, clearForm]);

  return (
    <Form method="post">
      <input
        name="name"
        value={persistedName}
        onChange={(e) => setPersistedName(e.target.value)}
      />
    </Form>
  );
}
```

## Pattern B — Conform Forms

Used for forms with `useForm` from `@conform-to/react`.

```typescript
import { useFormField } from '#app/hooks/use-form-field';
import { useClearForm } from '#app/utils/form-storage';

// Persist non-sensitive fields
const [persistedName, setPersistedName] = useFormField('create-user', 'name', '');
const [persistedEmail, setPersistedEmail] = useFormField('create-user', 'email', '');
const clearForm = useClearForm('create-user');

// Pass as defaultValue
const [form, fields] = useForm({
  lastResult: fetcher.data as SubmissionResult<string[]> | undefined,
  onValidate({ formData }) {
    return parseWithZod(formData, { schema });
  },
  defaultValue: {
    name: persistedName,
    email: persistedEmail,
  },
});

// Use onChange on <Form> for event delegation (native inputs)
<fetcher.Form method="post" {...getFormProps(form)} onChange={(e) => {
  const target = e.target as HTMLInputElement;
  if (target.name === fields.name.name) setPersistedName(target.value);
  if (target.name === fields.email.name) setPersistedEmail(target.value);
}}>

// For Radix <Select> (portaled, doesn't bubble to form):
<Select onValueChange={setPersistedRole}>
```

### Conform + useFetcher Cleanup

```typescript
const prevFetcherState = useRef(fetcher.state);
useEffect(() => {
  if (fetcher.state === 'loading' && prevFetcherState.current === 'submitting') {
    clearForm();
  }
  prevFetcherState.current = fetcher.state;
}, [fetcher.state, clearForm]);
```

## Security Rules

**NEVER persist:**
- Passwords
- Tokens / API keys
- Session identifiers

**Safe to persist:**
- Names, emails, titles, slugs
- Content/body text
- Role selections, categories
- Any user-generated text content

## Cleanup Timing

| Form Style | When to Clear |
|------------|---------------|
| `useNavigation` | `navigation.state === 'loading' && navigation.formAction` |
| `useFetcher` | `fetcher.state === 'loading'` (after `submitting`) |
| Login form | Don't clear — acts as "remember email" |

## Validation Checklist

1. [ ] Using `useFormField` for each user-editable, non-sensitive field
2. [ ] Form ID follows naming convention (simple or org-scoped)
3. [ ] Passwords/tokens are NOT persisted
4. [ ] `useClearForm` called on successful submission
5. [ ] Radix Select uses `onValueChange` (not form onChange delegation)

## Reference Implementations

- **Pattern A (uncontrolled):** `app/routes/create-org.tsx`
- **Pattern B (Conform):** `app/routes/login.tsx`, `app/routes/users.new.tsx`
