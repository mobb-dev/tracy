# Cursor Tab Autocompletion Extraction

This document describes how to extract autocompletions from Cursor Tab embedded plugin logs.

## Overview

Cursor Tab logs contain model output with code changes in a custom diff-like format. These logs can be accessed through the VS Code API by connecting to the appropriate output channel.

### Accessing the Log Manually

1. Press `Cmd+Shift+P`
2. Select "Cursor Tab" from the dropdown

### Accessing the Output Channel Programmatically

```typescript
import * as vscode from 'vscode';

// Get the Cursor Tab output channel
const outputChannel = vscode.window.createOutputChannel('cursor-tab');

// Listen to output
const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
  if (event.document.uri.scheme === 'output') {
    // Parse the log content
    const content = event.document.getText();
  }
});
```

## Log Format

The logs contain entries prefixed with `=======>Model output` followed by diff blocks showing code additions and deletions:

- Lines prefixed with `-|` indicate removed code
- Lines prefixed with `+|` indicate added code
- Each diff block begins with `@@` followed by file path and line number

## Example Log Entry

```
2025-10-31 15:20:14.308 [info] =======>Model output 
@@ src/uploader.ts:33
-|export function uploadChange(change: ProcessedChange) {
+|export function uploadChange(change: ProcessedChange) {
+|  return {
+|    blame: change.blame,
+|    prompt: change.prompt,
+|    inference: change.inference,
+|    aiResponseAt: change.createdAt.toISOString(),
+|    model: change.model,
+|    toolName: 'Cursor',
+|  }
+|}
```

## Implementation Requirements

To extract autocompletions:

1. Connect to the Cursor Tab output channel using the VS Code API
2. Parse log entries marked with `=======>Model output`
3. Extract code additions (lines prefixed with `+|`) from the diff blocks
4. Parse file paths and line numbers from the `@@` headers
