# ccreq virtual documents
ccreq is a virtual URI scheme for viewing recent Copilot Chat requests in-place. No files are written to disk.
URIs are constructed and parsed by ChatRequestScheme:


```typescript
export class ChatRequestScheme {
	public static readonly chatRequestScheme = 'ccreq';

	public static buildUri(data: UriData, format: 'markdown' | 'json' | 'rawrequest' = 'markdown'): string {
		let extension: string;
		if (format === 'markdown') {
			extension = 'copilotmd';
		} else if (format === 'json') {
			extension = 'json';
		} else { // rawrequest
			extension = 'request.json';
		}
		if (data.kind === 'latest') {
			return `${ChatRequestScheme.chatRequestScheme}:latest.${extension}`;
		} else {
			return `${ChatRequestScheme.chatRequestScheme}:${data.id}.${extension}`;
		}
	}
```
From [requestLogger.ts](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/requestLogger/node/requestLogger.ts)



Scheme formats (“schemas”):
- ccreq:<id>.copilotmd — rendered markdown view of a single request or tool call
- ccreq:<id>.json — structured JSON for the same entry (via toJSON())
- ccreq:<id>.request.json — the raw outbound request body
- ccreq:latest.(copilotmd|json|request.json) — the most recent logged request

The content is served via a TextDocumentContentProvider; entries are kept in-memory (up to 100)

# ccreq:latest.* 
always points to the newest in-memory log entry. The provider raises onDidChange so an open “latest” tab auto-refreshes when new requests arrive.

```typescript
  onDidChange: Event.map(
  this.onDidChangeRequests,
  () => Uri.parse(ChatRequestScheme.buildUri({ kind: 'latest' }))
)
```
# What gets logged
Requests: 
- prompt
- model metadata
- timings
- result summary

Tool calls: 
- name
- arguments
- tool result, optional “thinking” data, 
- recorded workspace edits.

# Workspace Edit Tracing

This toggles capturing actual VS Code edits that occur during tool calls, enabling accurate replay in Chat Replay.

Command: github.copilot.chat.replay.enableWorkspaceEditTracing
Effect: starts a WorkspaceEditRecorder that hooks into workspace edits.

```typescript
public override enableWorkspaceEditTracing(): void {
  if (!this._workspaceEditRecorder) {
    this._workspaceEditRecorder =
      this._instantiationService.createInstance(WorkspaceEditRecorder);
  }
}```
