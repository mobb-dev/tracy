# Debugging

## Setup

The extension debugging is configured in `.vscode/launch.json` at the workspace root. The configuration includes:

- **Launch configuration**: "Run Extension" - launches extension in a new Extension Development Host window
- **Pre-launch task**: Automatically compiles TypeScript before launching
- **Source maps**: Enabled for debugging TypeScript source files

## How to Debug

1. **Set breakpoints** in your TypeScript source files (e.g., `src/extension.ts`)
2. **Press F5** or go to Run and Debug view (Cmd+Shift+D / Ctrl+Shift+D)
3. **Select "Run Extension"** from the dropdown
4. **Click the green play button** or press F5

This will:
- Compile the extension (`npm run build`)
- Launch a new VS Code window (Extension Development Host) with your extension loaded
- Attach the debugger so breakpoints will hit

## Entry Point

The extension entry point is `src/extension.ts`. The `activate()` function is called when the extension loads. Set a breakpoint at the start of `activate()` to catch extension activation:

```typescript
export async function activate(context: vscode.ExtensionContext) {
  // Set breakpoint here
}
```

## Common Debug Points

- **Extension activation**: `src/extension.ts` - search for `export async function activate`
- **Monitor initialization**: `src/extension.ts` - search for `new MonitorManager`
- **Cursor monitoring**: `src/cursor/CursorMonitor.ts` - Cursor-specific monitoring logic
- **Copilot monitoring**: `src/copilot/CopilotMonitor.ts` - Copilot event tracking

## Troubleshooting

- **Extension not loading**: Check that compilation succeeded (check Output panel for TypeScript errors)
- **Breakpoints not hitting**: Ensure source maps are enabled (already configured in launch.json)
- **Task keeps reverting**: The task uses shell type to prevent VS Code auto-detection from modifying it
