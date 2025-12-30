# Mobb Tracy

VS Code/Cursor extension that monitors and tracks AI-assisted coding activities.

## Documentation

For detailed information and setup instructions, visit: [Mobb Tracy Documentation](https://docs.mobb.ai/mobb-user-docs/getting-started/mobb-tracy)

## What it does

- **Cursor**: Polls the Cursor database to capture AI conversations, tool calls, and code changes.
- **VS Code/Copilot**: Watches Copilot events, file edits, and log files to track AI-generated code.
- **Uploads**: Sends collected data (prompts, AI responses, code diffs) to Mobb backend for analysis.

## Features

- Auto-detects whether you're using Cursor or VS Code.
- Tracks AI conversations, tool executions, and code changes.
- Monitors both chat completions and inline edits.
- Uploads data securely to Mobb's backend.

## Installation

Install from VSIX package or build from source.

## Requirements

- VS Code 1.99.0+ or Cursor
- Node.js 22.x

## Debugging

See [DEBUGGING.md](./DEBUGGING.md) for debugging setup and instructions.
