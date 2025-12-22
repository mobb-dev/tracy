# Monitor Architecture Refactoring

## Overview

The monitoring system has been refactored from function-based to class-based architecture to provide better separation of concerns, state management, and extensibility.

## Architecture

### Key Components

1. **IMonitor Interface** (`shared/IMonitor.ts`)
   - Defines the contract for all monitors
   - Provides `start()`, `stop()`, `isRunning()` methods
   - BaseMonitor abstract class provides common functionality

2. **CursorMonitor** (`cursor/CursorMonitor.ts`)
   - Monitors Cursor-specific events and database changes
   - Handles polling with proper cancellation
   - Manages its own state and resources

3. **CopilotMonitor** (`copilot/CopilotMonitor.ts`)
   - Monitors VS Code Copilot events
   - Handles file watchers and snapshot tracking
   - Manages unified diffs and context logging

4. **MonitorManager** (`shared/MonitorManager.ts`)
   - Automatically detects app type (Cursor vs VS Code)
   - Manages lifecycle of appropriate monitors
   - Provides centralized control and error handling

## Benefits

### 1. **No More Naming Conflicts**
- Each monitor is a separate class with its own namespace
- No more duplicate function names causing import issues

### 2. **Better State Management**
- Each monitor manages its own state internally
- No shared global variables between monitors
- Proper cleanup when stopping

### 3. **Proper Resource Cleanup**
- Monitors can properly clean up resources on stop
- AbortController for canceling async operations
- Clear state reset between start/stop cycles

### 4. **Type Safety**
- TypeScript interfaces ensure consistent API
- Better IntelliSense and compile-time error checking

### 5. **Extensibility**
- Easy to add new monitor types
- Common interface allows for polymorphic usage
- Manager pattern allows for complex orchestration

### 6. **Better Error Handling**
- Isolated error handling per monitor
- Manager handles failures gracefully
- Detailed logging for debugging

## Usage

### Basic Usage
The extension automatically detects the app type and starts the appropriate monitor:

```typescript
// In extension.ts
const monitorManager = new MonitorManager(context)
await monitorManager.startMonitoring()  // Starts appropriate monitor
```

### Manual Control
```typescript
// Check status
const isActive = monitorManager.isMonitoringActive()
const appType = monitorManager.getAppType()
const running = monitorManager.getRunningMonitors()

// Stop all monitors
await monitorManager.stopAllMonitors()

// Force start specific monitor (for testing)
await monitorManager.forceStartMonitor(AppType.CURSOR)
```

### Commands
Optional VS Code commands for debugging:
- `autofixer.monitor.status` - Check monitor status
- `autofixer.monitor.restart` - Restart monitoring
- `autofixer.monitor.forceStart` - Force start specific monitor

## Migration from Old Code

### Before (Function-based)
```typescript
// Had naming conflicts and shared state
import { startMonitoring as startCursor } from './cursor/monitor'
import { startMonitoring as startCopilot } from './copilot/monitor'

if (isVsCode()) {
  startCopilot()
} else {
  startCursor()
}
```

### After (Class-based)
```typescript
// Clean, type-safe, and extensible
const monitorManager = new MonitorManager(context)
await monitorManager.startMonitoring()  // Automatic detection
```

## Adding New Monitors

To add a new monitor type:

1. Create a new class extending `BaseMonitor`
2. Implement the required methods
3. Add the new app type to `AppType` enum
4. Register in `MonitorManager.initializeMonitors()`
5. Update detection logic in `MonitorManager.detectAppType()`

## Error Handling

Each monitor handles its own errors and reports them through the logging system. The manager ensures that failures in one monitor don't affect the entire system.

## Testing

The new architecture makes testing much easier:
- Mock individual monitor classes
- Test manager orchestration separately
- Better isolation for unit tests
