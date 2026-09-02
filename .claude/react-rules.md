# React Rules

## Usage of `useEffect`

`useEffect` is an escape hatch from the React paradigm. Avoid it for logic that can be handled during rendering or in event handlers.

### When NOT to Use `useEffect`

1. **Transforming Data for Rendering:** Calculate derived data directly during render
```jsx
// Bad: Redundant state and Effect
const [filteredList, setFilteredList] = useState([]);
useEffect(() => {
  setFilteredList(list.filter(item => item.isActive));
}, [list]);

// Good: Calculate during render
const filteredList = list.filter(item => item.isActive);
```

2. **Caching Expensive Calculations:** Use `useMemo`
```jsx
// Bad: Effect for caching
const [expensiveValue, setExpensiveValue] = useState(null);
useEffect(() => {
  setExpensiveValue(computeExpensiveValue(a, b));
}, [a, b]);

// Good: useMemo for caching
const expensiveValue = useMemo(() => computeExpensiveValue(a, b), [a, b]);
```

3. **Resetting State on Prop Change:**
   - **Full Reset:** Pass a unique `key` prop to the component
   - **Partial Reset:** Set state directly during render if a prop changes

4. **Handling User Events:** Place event-specific logic directly in event handlers

5. **Application Initialization:** Run setup code outside components

6. **Notifying Parent Components:** Use callback props

### When `useEffect` IS Appropriate

1. **Synchronizing with External Systems:**
   - Setting `document.title`
   - Browser APIs like timers (`setInterval`, `setTimeout`) - remember cleanup!
   - Third-party non-React libraries (maps, charts)
   - Manual DOM manipulation (use sparingly, prefer refs)
   - Browser events (`window.addEventListener`) - remember cleanup!

2. **Data Fetching:**
```jsx
useEffect(() => {
  let ignore = false;
  fetchData(query).then(result => {
    if (!ignore) {
      setData(result);
    }
  });
  return () => { ignore = true; }; // Cleanup to prevent race conditions
}, [query]);
```

3. **Subscribing to External Stores:** Remember to unsubscribe in cleanup

**Key Principle:** If the logic doesn't involve synchronizing with an *external system*, you likely don't need `useEffect`.

## Conditional Rendering

Use clear conditional rendering patterns instead of nested ternary operators for better readability.

### Preferred Pattern
Use logical AND (`&&`) for simple conditional rendering:

```jsx
// Good: Clear and readable
{isLoading && <Spinner />}
{hasError && <ErrorMessage />}
{!isLoading && data && <DataDisplay data={data} />}
{!isLoading && !data && <EmptyState />}
```

### Avoid Nested Ternaries
Avoid complex nested ternary operators in JSX:

```jsx
// Bad: Hard to read and maintain
{isLoading ? 
  <Spinner /> 
: data ? 
  <DataDisplay data={data} /> 
: hasError ? 
  <ErrorMessage />
: <EmptyState />}

// Good: Multiple clear conditionals
{isLoading && <Spinner />}
{!isLoading && data && <DataDisplay data={data} />}
{!isLoading && !data && hasError && <ErrorMessage />}
{!isLoading && !data && !hasError && <EmptyState />}
```

### Guidelines
- Use `condition &&` for simple show/hide logic
- Use early returns for complex conditional logic in function components
- Each conditional should have a clear, self-documenting boolean expression
- Avoid deeply nested ternary operators in JSX

## Early Returns in useEffect and Functions

Use early returns to avoid nested if/else clauses and improve readability.

### In useEffect Hooks
Prefer early returns over nested conditionals:

```jsx
// Bad: Nested if/else in useEffect
useEffect(() => {
  if (isOpen) {
    if (!searchQuery) {
      setDefaultQuery();
    }
    fetchData();
  } else {
    cleanup();
  }
}, [isOpen, searchQuery]);

// Good: Early returns
useEffect(() => {
  if (!isOpen) {
    cleanup();
    return;
  }

  if (!searchQuery) {
    setDefaultQuery();
  }

  fetchData();
}, [isOpen, searchQuery]);
```

### In Event Handlers and Functions
Use early returns for guard clauses:

```jsx
// Bad: Nested if/else chains
const handleSubmit = () => {
  if (selectedType === 'licensed') {
    if (selectedImageId) {
      const image = findImage(selectedImageId);
      if (image) {
        submitImage(image);
      }
    }
  } else if (selectedType === 'fallback') {
    if (fallbackImage) {
      submitFallback(fallbackImage);
    }
  }
};

// Good: Early returns with clear guard clauses
const handleSubmit = () => {
  if (selectedType === 'licensed') {
    if (!selectedImageId) return;
    
    const image = findImage(selectedImageId);
    if (!image) return;
    
    submitImage(image);
    return;
  }

  if (selectedType === 'fallback') {
    if (!fallbackImage) return;
    
    submitFallback(fallbackImage);
    return;
  }
};
```

### Benefits
- Reduces cognitive load by eliminating nesting
- Makes error conditions and edge cases explicit
- Easier to debug and maintain
- Each condition is self-contained and clear

## Form State Persistence

Persist user input in sessionStorage for **create/entry forms** to prevent data loss on accidental refresh.

### Rules

- **Persist** create forms (new article, new user, invite) — not edit forms (server data is authoritative)
- **Never persist** passwords, tokens, or secrets
- **Clear on success** — call `useClearForm(formId)` when the form action redirects
- **Scope by org** for tenant forms — use `create-article:{orgSlug}` format

### Quick Reference

```typescript
import { useFormField } from '#app/hooks/use-form-field';
import { useClearForm } from '#app/utils/form-storage';

const [value, setValue] = useFormField('form-id', 'field', '');
const clearForm = useClearForm('form-id');
```

See [.claude/skills/form-persistence/SKILL.md](skills/form-persistence/SKILL.md) for full patterns (Pattern A for uncontrolled forms, Pattern B for Conform forms).

## Modal State Management with Search Params

Use descriptive search parameters and the `open` parameter pattern for modal state management.

### Search Parameter Naming
Use clear, descriptive names instead of generic abbreviations:

```jsx
// Bad: Generic, unclear parameter names
const query = searchParams.get('q') || '';
const type = searchParams.get('type') || '';

// Good: Descriptive, contextual parameter names
const imageSearch = searchParams.get('imageSearch') || '';
const selectedImageType = searchParams.get('selectedImageType') || '';
```

### Multiple Modal State Management
Use the `open` parameter to track multiple open modals:

```jsx
// Reading modal state
const openModals = searchParams.get('open')?.split(',') || [];
const isEditImageModalOpen = openModals.includes('editImageModal');
const isDeleteModalOpen = openModals.includes('deleteModal');

// Opening a modal
const handleOpenModal = (modalName: string) => {
  setSearchParams(prev => {
    const newParams = new URLSearchParams(prev);
    const currentOpen = newParams.get('open')?.split(',').filter(Boolean) || [];
    if (!currentOpen.includes(modalName)) {
      currentOpen.push(modalName);
      newParams.set('open', currentOpen.join(','));
    }
    return newParams;
  });
};

// Closing a modal
const handleCloseModal = (modalName: string) => {
  setSearchParams(prev => {
    const newParams = new URLSearchParams(prev);
    const currentOpen = newParams.get('open')?.split(',').filter(Boolean) || [];
    const updatedOpen = currentOpen.filter(modal => modal !== modalName);
    
    if (updatedOpen.length > 0) {
      newParams.set('open', updatedOpen.join(','));
    } else {
      newParams.delete('open');
    }
    
    // Clean up modal-specific params
    newParams.delete('imageSearch');
    newParams.delete('selectedImageType');
    
    return newParams;
  });
};
```

### Modal Component Pattern
Modal components should manage their own state through search params:

```jsx
// Modal component reads its open state from search params
export function MyModal({ ...props }: ModalProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  
  const openModals = searchParams.get('open')?.split(',') || [];
  const isOpen = openModals.includes('myModal');
  
  const onClose = () => {
    // Handle closing logic with search params
  };
  
  return <Dialog open={isOpen} onOpenChange={onClose}>...</Dialog>;
}
```

### Benefits
- **URL Shareable**: Modal states persist in URL
- **Browser Navigation**: Back button closes modals naturally
- **Multiple Modals**: Clean handling of multiple open modals
- **Clear Parameters**: Descriptive names make debugging easier
- **State Persistence**: Modal state survives page refreshes

