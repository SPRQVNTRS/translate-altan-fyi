---
description: Review changes and create semantic commits following project conventions
allowed-tools: Bash(git status*), Bash(git add*), Bash(git commit*)
---

# Instructions

Review all uncommitted changes with `git status --short` and create well-structured commits following these guidelines:

## Commit Message Format

Follow the Conventional Commits specification:

```
<type>: <subject>

<body>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Altan Sarisin <altansarisin@gmail.com>
```

### Types

- **feat**: New feature or functionality
- **refactor**: Code restructuring without changing behavior
- **fix**: Bug fixes
- **chore**: Maintenance tasks (dependencies, configs, version bumps)
- **docs**: Documentation changes
- **test**: Adding or updating tests
- **perf**: Performance improvements
- **style**: Code style changes (formatting, no logic changes)

## Committing Strategy

### 1. Review Changes

```bash
git status --short
```

### 2. Group Related Changes

Group changes by:

- **Feature area** (new package, migrations, tests)
- **Logical unit** (all files affected by the same change)
- **Impact scope** (infrastructure vs business logic)

### 3. Stage and Commit in Logical Groups

**Example Pattern:**

```bash
# 1. New infrastructure
git add packages/new-package/
git commit -m "feat: create new package with core functionality"

# 2. App integration
git add apps/*/app/services/integration.ts apps/*/package.json
git commit -m "feat: integrate new package into apps"

# 3. Refactor existing code
git add apps/*/app/models/ apps/*/app/services/
git commit -m "refactor: migrate to new interface across codebase"

# 4. Update operations/workflows
git add apps/*/app/workflows.server/
git commit -m "refactor: update workflow operations to use new interface"

# 5. Test updates
git add apps/*/tests/
git commit -m "refactor: update test files for new interface"

# 6. Maintenance
git add apps/*/app/version.ts
git commit -m "chore: bump app versions"
```

## Commit Message Best Practices

### Subject Line

- Keep under 72 characters
- Use imperative mood ("add" not "added" or "adds")
- Don't end with a period
- Be specific but concise

### Body

- Use bullet points for multiple changes
- Explain **what** and **why**, not **how**
- Reference related issues or PRs when applicable
- Use markdown formatting

### Examples

#### Good Commits

```bash
feat: create unified interface for feature

- Add core functionality with interface
- Implement generic helper functions
- Package provides infrastructure, not business logic
```

```bash
refactor: migrate to unified interface

- Replace old interface with new unified approach
- Remove deprecated files
- Update variable naming to be more generic
- Changes in: models, scheduled tasks, services, and scripts
```

#### Bad Commits

```bash
# Too vague
fix: update files

# Too detailed/implementation-focused
refactor: change line 45 in user.ts to use forEach instead of for loop

# Multiple unrelated changes
feat: add new feature and fix bug and update docs
```

## Using HEREDOC for Multi-line Messages

Always use HEREDOC syntax for commit messages to preserve formatting:

```bash
git commit -m "$(cat <<'EOF'
feat: add new feature

- First change
- Second change
- Third change

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Commit Grouping Principles

### DO: Group by Logical Unit

✅ All files related to creating a new package
✅ All files migrating to a new interface
✅ All workflow operations using the same pattern
✅ All test files for the same feature

### DON'T: Group by Location

❌ All files in `app/services/`
❌ All TypeScript files
❌ Everything modified today

### DO: Keep Commits Focused

✅ One commit per major change/feature
✅ Separate infrastructure from business logic
✅ Separate creation from migration

### DON'T: Mix Unrelated Changes

❌ New feature + bug fix + refactor in one commit
❌ Multiple features in one commit
❌ Code changes + version bumps together (unless version bump is part of release)

## Special Cases

### Version Bumps

Commit separately unless part of a release:

```bash
git add apps/*/app/version.ts
git commit -m "chore: bump app versions"
```

### Dependency Updates

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add dependency"
```

### Breaking Changes

Use `BREAKING CHANGE:` in body:

```bash
feat: replace old interface with unified approach

BREAKING CHANGE: Old methods have been removed. Use new unified interface instead.

- Migration guide: Replace oldMethod() with newMethod()
- All existing usage keys remain the same
```

## Review Before Committing

Before committing, verify:

- [ ] Files are logically grouped
- [ ] Commit message is clear and descriptive
- [ ] No unrelated changes included
- [ ] Tests are included if applicable
- [ ] Documentation is updated if needed
- [ ] Breaking changes are clearly marked

## Commit Attribution

All commits should include the Claude Code attribution footer:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```
