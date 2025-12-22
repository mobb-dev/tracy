# current.logContext.jsonl

A newline-delimited JSON (JSONL) file written by the Copilot Chat extension. Each line is an inline edit event serialized as:

```typescript
export interface ISerializedInlineEditLogContext {
    requestId: number;
    time: number;
    filePath: string;
    version: number;
    statelessNextEditProviderId: string | undefined;
    nextEditRequest: ISerializedNextEditRequest | undefined;
    diagnosticsResultEdit: string | undefined;
    resultEdit: string | undefined;
    isCachedResult: boolean;
    prompt: string | undefined;
    error: string;
    response: string | undefined;
    responseResults: string;
    providerStartTime: number | undefined;
    providerEndTime: number | undefined;
    fetchStartTime: number | undefined;
    fetchEndTime: number | undefined;
    logs: string[];
    isAccepted: boolean | undefined;
    languageContext: SerializedContextResponse | undefined;
    diagnostics: SerializedDiagnostic[] | undefined;
}
```
From [inlineEditLogContext.ts](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/inlineEdits/common/inlineEditLogContext.ts)

## What we need
We do not deserialize the entire object. We only need either the

responseResults: a YAML string with entries like:
```yaml
- replaceRange:
    start: 1900
    endExclusive: 2016
  newText: |-
        PreparedStatement pstmt = conn.prepareStatement(sql);
        pstmt.setString(1, userId);
        ResultSet rs = pstmt.executeQuery();
```

resultEdit: a diff style string:
```diff
   54  54             
   55  55             System.out.println(\"Executing SQL: \" + sql);
-  56                 
-  57                 Statement stmt = conn.createStatement();
-  58                 ResultSet rs = stmt.executeQuery(sql);
+      56             PreparedStatement pstmt = conn.prepareStatement(sql);
+      57             pstmt.setString(1, userId);
+      58             ResultSet rs = pstmt.executeQuery();
   59  59             
   60  60             while (rs.next()) {
   61  61                 Account account = new Account();",
```

All requests are logged regardless, so we also use `isaccepted` to see if the change was committed.

We can ignore the prompt as its a standard promot that contains to context
