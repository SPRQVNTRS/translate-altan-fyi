#!/bin/bash
# Hook: Detect schema.ts changes and remind about CLI sync
#
# This hook runs after Write/Edit operations and checks if
# drizzle/schema.ts was modified. If so, it outputs a reminder.

# Read JSON input from stdin
INPUT=$(cat)

# Extract the file path from the tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Check if the modified file is schema.ts
if [[ "$FILE_PATH" == *"drizzle/schema.ts"* ]]; then
  # Output a reminder message
  echo '{"continue": true, "systemMessage": "Schema changed! Remember to check if CLI needs updates. Run /sync-cli to analyze."}'
  exit 0
fi

# For other files, just continue silently
echo '{"continue": true}'
exit 0
