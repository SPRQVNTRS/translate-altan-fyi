# Conform-to-React Rules

## Zod v4 Integration

**IMPORTANT**: This project uses Zod v4, which requires a different import path for Conform integration.

### Correct Import for Zod v4
```typescript
import { parseWithZod } from '@conform-to/zod/v4';
```

### Incorrect Import (for Zod v3)
```typescript
// ❌ DON'T USE - This is for Zod v3 only
import { parseWithZod } from '@conform-to/zod';
```

## Form Implementation Pattern

### 1. Define Schema
```typescript
import { z } from 'zod';

const FormSchema = z.object({
  name: z.string().min(1, 'Name is required').min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
});
```

### 2. Action Handler
```typescript
import type { Route } from './+types/your-route';
import { parseWithZod } from '@conform-to/zod/v4';

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: FormSchema });

  if (submission.status !== 'success') {
    return submission.reply();
  }

  // Process the validated data
  const data = submission.value;

  // ... your logic here

  return submission.reply();
}
```

### 3. Component with Form
```typescript
import { useFetcher } from 'react-router';
import { useForm, getFormProps, getInputProps } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod/v4';
import type { SubmissionResult } from '@conform-to/react';

export default function YourComponent() {
  const fetcher = useFetcher<typeof action>();

  const [form, fields] = useForm({
    lastResult: fetcher.data as SubmissionResult<string[]> | undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: FormSchema });
    },
    defaultValue: {
      name: '',
      email: '',
    },
  });

  return (
    <fetcher.Form method="post" {...getFormProps(form)}>
      <div>
        <label htmlFor={fields.name.id}>Name</label>
        <input {...getInputProps(fields.name, { type: 'text' })} />
        {fields.name.errors && (
          <p className="text-sm text-red-500">{fields.name.errors}</p>
        )}
      </div>

      <button type="submit">Submit</button>
    </fetcher.Form>
  );
}
```

## Nested Objects

For nested object schemas:

```typescript
const NestedSchema = z.object({
  fieldA: z.string().optional(),
  fieldB: z.coerce.number().optional(),
});

const FormSchema = z.object({
  mainField: z.string().min(1),
  nested: NestedSchema,
});

// In component:
const nestedFields = fields.nested.getFieldset();
```

## Form State Persistence with Conform

When building **create/entry forms** (not edit forms), persist user input in sessionStorage so it survives page refreshes.

### Setup

```typescript
import { useFormField } from '#app/hooks/use-form-field';
import { useClearForm } from '#app/utils/form-storage';

// Before useForm:
const [persistedName, setPersistedName] = useFormField('my-form', 'name', '');
const clearForm = useClearForm('my-form');

// Pass persisted values as defaultValue:
const [form, fields] = useForm({
  lastResult: fetcher.data as SubmissionResult<string[]> | undefined,
  onValidate({ formData }) {
    return parseWithZod(formData, { schema });
  },
  defaultValue: {
    name: persistedName,
  },
});
```

### Capturing Changes

Use `onChange` on the `<Form>` element for native inputs (event delegation):

```typescript
<fetcher.Form method="post" {...getFormProps(form)} onChange={(e) => {
  const target = e.target as HTMLInputElement;
  if (target.name === fields.name.name) setPersistedName(target.value);
}}>
```

For Radix `<Select>` (portaled elements don't bubble to the form's `onChange`):

```typescript
<Select onValueChange={setPersistedRole}>
```

### Security

**NEVER** persist passwords or tokens. Only persist user-generated text content (names, emails, titles, etc.).

See [.claude/skills/form-persistence/SKILL.md](skills/form-persistence/SKILL.md) for full patterns and cleanup timing.

## Key Points

- Always use `@conform-to/zod/v4` import for Zod v4 compatibility
- Use `useFetcher` for optimistic UI updates without full page reload
- Type the fetcher with `useFetcher<typeof action>()` for type safety
- Cast `lastResult` to `SubmissionResult<string[]> | undefined` for proper typing
- Use `getFormProps` and `getInputProps` for proper form attribute binding
- Check `submission.status === 'success'` before processing data in actions
