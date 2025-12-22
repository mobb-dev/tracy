# High-Level Cursor Database Structure

## Overview

The Cursor database uses a **key-value store** structured as a table with two columns:

- **key**: Text identifiers following specific naming patterns
- **value**: Large JSON objects containing detailed data

## Key Types & Patterns

The database uses hierarchical keys with the pattern `{type}:{composerId}:{itemId}`. Main key types identified:

### 1. **bubbleId** - Conversation Messages

Each bubble represents a message or action in the conversation (user prompts, AI responses, tool calls). Contains:

- Message text and timestamps
- Tool execution data (`toolFormerData`)
- Context (files, selections, attached code)
- Token usage statistics
- Model configuration
- Rich text formatting
- Thinking blocks (for models that support reasoning)

**Example Key Pattern**: `bubbleId:66171da1-7f67-4a15-9efe-6988bd279833:7f929100-9773-49a6-b968-113fb3c4cc17`

### 2. **composerData** - Conversation Metadata

Top-level container for entire conversations/composers. Includes:
- Full conversation headers and flow (`fullConversationHeadersOnly`)
- File states and code block tracking
- Status (completed, generating, etc.)
- Context management (attached files, selections, folders)
- Usage data and metrics
- Model configurations
- Original file states before edits
- Code block data with acceptance status

**Example Key Pattern**: `composerData:66171da1-7f67-4a15-9efe-6988bd279833`

### 3. **checkpointId** - File State Snapshots

Tracks file changes at specific points in time:
- Original and modified text diffs
- Newly created files/folders
- Active inline diffs
- Generation UUIDs
- Non-existent files

**Example Key Pattern**: `checkpointId:66171da1-7f67-4a15-9efe-6988bd279833:a9997bf9-fdf7-4f9f-a28c-e74b6848e32a`

### 4. **codeBlockDiff** - Code Changes

Detailed diff information for specific code blocks:
- Line-by-line changes
- Original vs new model diffs
- Structured diff objects with line ranges

**Example Key Pattern**: `codeBlockDiff:66171da1-7f67-4a15-9efe-6988bd279833:e6c7830f-9ef8-4d42-b0c2-818983036b8e`

### 5. **codeBlockPartialInlineDiffFates** - User Decisions

Records whether users accepted/rejected AI-suggested changes:
- Fate status (accepted/rejected/cancelled)
- Line ranges affected
- Added/removed lines
- Individual change granularity

**Example Key Pattern**: `codeBlockPartialInlineDiffFates:7b374682-ef31-4389-9d0b-b49cb58a9487:eaecad46-293a-4a53-8d1d-2dd9968a9871`

## Data Relationships

### Hierarchical Structure

- **composerId** (first UUID) groups related bubbles, checkpoints, and diffs
- A single composer contains multiple bubbles (conversation turns)
- Each bubble may have associated checkpoints and code blocks

### Cross-References

Objects reference each other via IDs:

- `bubbleId` - Links conversation messages
- `codeblockId` - Connects code blocks to bubbles
- `checkpointId` - Associates file states with actions
- `serverBubbleId` - Server-side bubble identifier
- `usageUuid` - Groups usage metrics

## Key JSON Fields

### bubbleId Fields

Fields that appear in bubbleId entries:

- **`_v`**: Version number (value: 3)
- **`type`**: Message type (1 = user message, 2 = AI response)
- **`bubbleId`**: Unique identifier for this specific message/action
- **`createdAt`**: ISO timestamp
- **`text`**: Human-readable message content (empty for tool execution bubbles)
- **`tokenCount`**: Input/output token usage (0/0 for tool execution bubbles, real values for AI text responses)
- **`modelInfo`**: Model name and configuration
- **`isAgentic`**: Whether the interaction uses agent mode
- **`serverBubbleId`**: Optional server-side identifier
- **`usageUuid`**: Usage tracking identifier
- **`thinking`**: Chain-of-thought reasoning from models that support it (e.g., claude-4.5-sonnet-thinking)
  - `text`: The reasoning text
  - `thinkingDurationMs`: Duration of thinking process in milliseconds

### composerData Fields

Fields that appear in composerData entries:

- **`_v`**: Version number (value: 10)
- **`composerId`**: Unique identifier for the composer/conversation
- **`fullConversationHeadersOnly`**: Array of objects with `bubbleId` references
- **`status`**: Conversation status (e.g., "completed", "generating")
- **`modelConfig`**: Model configuration with modelName and maxMode
- **`isAgentic`**: Whether this is an agentic conversation
- **`createdAt`**: Creation timestamp
- **`lastUpdatedAt`**: Last update timestamp
- **`codeBlockData`**: Nested object tracking code blocks by file URI

### checkpointId Fields

Checkpoint entries have a different structure without `_v`:

- **`files`**: Array of file changes with URIs and diffs
- **`nonExistentFiles`**: Files that don't exist
- **`newlyCreatedFolders`**: New folders created
- **`activeInlineDiffs`**: Currently active inline diffs
- **`inlineDiffNewlyCreatedResources`**: New resources from inline diffs
- **`generationUUID`**: Optional generation identifier

### codeBlockDiff Fields

Code block diff entries also lack `_v`:

- **`newModelDiffWrtV0`**: New model's diff relative to original
- **`originalModelDiffWrtV0`**: Original model's diff relative to V0

### Tool Execution (`toolFormerData`)

**Note**: This field only appears in bubbleId entries when the AI executes a tool. It is never present in composerData, checkpointId, or other entry types.

**Important**: This is the primary field we use to extract actual code changes. The `result` field within `toolFormerData` contains the diff information showing what code was added or modified.

When AI uses tools, the bubble contains:

- **`tool`**: Tool type ID (38 = write, 39 = list_dir, 40 = read_file, etc.)
- **`toolIndex`**: Order in the tool call sequence
- **`status`**: "completed", "failed", etc.
- **`rawArgs`**: Original tool arguments as JSON string
- **`params`**: Parsed parameters
- **`result`**: Tool execution result (includes diffs for file operations)
- **`userDecision`**: "accepted" or "rejected"
- **`additionalData`**: Extra metadata (e.g., `codeblockId`)

### Context Fields

- **`attachedCodeChunks`**: Code snippets attached to the conversation
- **`attachedFiles`**: Files referenced in context
- **`recentlyViewedFiles`**: User's recent file activity
- **`cursorRules`**: Custom rules applied
- **`projectLayouts`**: Project structure information
- **`ideEditorsState`**: Current editor state

## Database Query Patterns

Based on the key structure, common queries would be:

```sql
-- Get all bubbles for a specific composer
SELECT * FROM cursorDiskKV WHERE key LIKE 'bubbleId:composerId:%';

-- Get composer metadata
SELECT * FROM cursorDiskKV WHERE key = 'composerData:composerId';

-- Find tool executions
SELECT * FROM cursorDiskKV WHERE value LIKE '%"toolFormerData"%';
```
