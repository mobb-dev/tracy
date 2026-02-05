import * as os from 'os'

import { PromptItemArray } from '../../mobbdev_src/args/commands/upload_ai_blame'

// Minimal JSON types to represent arbitrary JSON values (no `any` usage)
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray
export type JsonObject = {
  [key: string]: JsonValue
}
export type JsonArray = JsonValue[]

export type ChatMLTokensDetails = {
  cached_tokens?: number
  accepted_prediction_tokens?: number
  rejected_prediction_tokens?: number
}

export type ChatMLUsage = {
  completion_tokens?: number
  prompt_tokens?: number
  total_tokens?: number
  completion_tokens_details?: ChatMLTokensDetails
  prompt_tokens_details?: ChatMLTokensDetails
}

export type ChatMLMetadata = {
  requestType?: string
  model?: string
  requestId?: string // identifies generation cycle
  startTime?: string // ISO
  endTime?: string // ISO
  duration?: number // ms
  usage?: ChatMLUsage
  tools?: ChatMLTool[] // tool schemas vary
}

export type ChatMLThinkingValue = {
  type: 'thinking'
  thinking: {
    id?: string
    text?: string
    encrypted?: string
  }
}

export type ChatMLMessageContent = {
  type?: number | string
  text?: string
  value?: ChatMLThinkingValue // For type=2 (thinking) content
}
export type ChatMLToolCall = {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

export type ChatMLMessage = {
  role?: number | string
  content?: ChatMLMessageContent[]
  toolCalls?: ChatMLToolCall[]
  toolCallId?: string // For role 3 (tool) messages - links result to call (camelCase!)
}

export type ChatMLRequestMessages = {
  messages: ChatMLMessage[]
}

// Based on example_json/chatMlCompletion.json → metadata.tools entries
export type ChatMLToolFunctionDef = {
  name: string
  description?: string
  parameters?: JsonObject // JSON Schema-like object; we keep it generic
}

export type ChatMLTool = {
  function: ChatMLToolFunctionDef
  type?: string // usually "function"
}

/**
 * Options for constructing a ChatMLSuccess instance.
 */
export type ChatMLSuccessOptions = {
  id: string
  type: string
  name?: string // e.g. "panel/editAgent"
  requestType?: string // metadata.requestType
  model?: string // metadata.model
  requestId?: string // metadata.requestId - identifies generation cycle
  startTime?: Date // from metadata.startTime
  endTime?: Date // from metadata.endTime
  durationMs?: number // metadata.duration
  usage?: ChatMLUsage // metadata.usage
  toolNames: string[] // derived from metadata.tools[*].function.name
  requestMessages?: ChatMLRequestMessages // obj.requestMessages
  raw: unknown // original object for advanced consumers
}

export class ChatMLSuccess {
  public readonly id: string
  public readonly type: string
  public readonly name: string | undefined
  public readonly requestType: string | undefined
  public readonly model: string | undefined
  public readonly requestId: string | undefined
  public readonly startTime: Date | undefined
  public readonly endTime: Date | undefined
  public readonly durationMs: number | undefined
  public readonly usage: ChatMLUsage | undefined
  public readonly toolNames: string[]
  public readonly requestMessages: ChatMLRequestMessages | undefined
  public readonly raw: unknown

  constructor(opts: ChatMLSuccessOptions) {
    this.id = opts.id
    this.type = opts.type
    this.name = opts.name
    this.requestType = opts.requestType
    this.model = opts.model
    this.requestId = opts.requestId
    this.startTime = opts.startTime
    this.endTime = opts.endTime
    this.durationMs = opts.durationMs
    this.usage = opts.usage
    this.toolNames = opts.toolNames
    this.requestMessages = opts.requestMessages
    this.raw = opts.raw
  }

  /**
   * Returns an array of attachment objects for snapshot ingestion.
   * Each object includes a unique id (hash of filePath+content), filePath, content, and timestamp.
   * Only the first occurrence of each unique attachment is returned.
   */
  getAttachments(): Array<{
    id: string
    filePath: string
    content: string
    timestamp: string | undefined
  }> {
    const attachments: Array<{
      id: string
      filePath: string
      content: string
      timestamp: string | undefined
    }> = []
    const messages = this.getMessages()
    if (!Array.isArray(messages)) {
      return attachments
    }

    const timestamp = this.startTime ? this.startTime.toISOString() : undefined

    // Regex to extract <attachments>...</attachments> block(s)
    const attachmentsBlockRegex = /<attachments>([\s\S]*?)<\/attachments>/
    const eachAttachmentRegex = /<attachment\b([^>]*)>([\s\S]*?)<\/attachment>/g

    for (const m of messages) {
      const contents = (m?.content ?? []) as ChatMLMessageContent[]
      for (const c of contents) {
        const t = typeof c?.text === 'string' ? c.text : undefined
        if (!t) {
          continue
        }
        const blockMatch = attachmentsBlockRegex.exec(t)
        if (blockMatch) {
          const inner = blockMatch[1]
          let m
          while ((m = eachAttachmentRegex.exec(inner)) !== null) {
            const attrs = m[1]
            const body = m[2]
            const filePathMatch = /filePath="([^"]*)"/.exec(attrs)
            const filePath = filePathMatch ? filePathMatch[1] : ''
            const content = body.trim()
            if (filePath && content) {
              const uniqueId = this._hashAttachmentKey(filePath, body)
              attachments.push({
                id: uniqueId,
                filePath,
                content: content.trim(),
                timestamp,
              })
            }
          }
        }
      }
    }
    return attachments
  }

  /** Helper to create a unique hash for an attachment based on filePath and content */
  private _hashAttachmentKey(filePath: string, content: string): string {
    // FNV-1a hash for deterministic, fast, and simple hashing
    let hash = 2166136261
    const str = `${filePath}|${content}`
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i)
      hash +=
        (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
    }
    return `attch_${(hash >>> 0).toString(16)}`
  }

  static fromJson(raw: string | unknown): ChatMLSuccess {
    const objUnknown: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw

    const isObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null

    let metaUnknown: unknown
    if (isObject(objUnknown)) {
      const { metadata: m } = objUnknown as Record<string, unknown>
      metaUnknown = m
    }
    const metadata: ChatMLMetadata = (
      isObject(metaUnknown) ? metaUnknown : {}
    ) as ChatMLMetadata

    // Extract tool names if present
    const toolNames: string[] = []
    if (Array.isArray(metadata?.tools)) {
      for (const t of metadata.tools) {
        const name = getToolFunctionName(t)
        if (typeof name === 'string' && name.length > 0) {
          toolNames.push(name)
        }
      }
    }

    const startTime = metadata?.startTime
      ? new Date(metadata.startTime)
      : undefined
    const endTime = metadata?.endTime ? new Date(metadata.endTime) : undefined

    let id: string = ''
    let type: string = ''
    let name: string | undefined
    if (typeof objUnknown === 'object' && objUnknown !== null) {
      const o = objUnknown as { id?: unknown; name?: unknown; type?: unknown }
      if (typeof o.id === 'string') {
        id = o.id
      }
      if (typeof o.name === 'string') {
        name = o.name
      }
      if (typeof o.type === 'string') {
        type = o.type
      }
    }

    const msgs = extractMessagesFromRaw(objUnknown)
    const requestMessages = Array.isArray(msgs)
      ? { messages: msgs as ChatMLMessage[] }
      : undefined

    return new ChatMLSuccess({
      id,
      type,
      name,
      requestType:
        typeof metadata?.requestType === 'string'
          ? metadata.requestType
          : undefined,
      model: typeof metadata?.model === 'string' ? metadata.model : undefined,
      requestId:
        typeof metadata?.requestId === 'string'
          ? metadata.requestId
          : undefined,
      startTime,
      endTime,
      durationMs: Number.isFinite(metadata?.duration as number)
        ? (metadata?.duration as number)
        : undefined,
      usage: metadata?.usage as ChatMLUsage | undefined,
      toolNames,
      requestMessages,
      raw: objUnknown,
    })
  }

  getPromptData(): PromptItemArray {
    const messages = this.getMessages()
    if (!Array.isArray(messages)) {
      return []
    }

    const context = {
      toolResults: this.collectToolResults(messages),
      tokens: this.getTokenCounts(),
      attachedFiles: this.collectAttachedFiles(messages),
      result: [] as PromptItemArray,
    }

    for (const message of messages) {
      this.processMessageByRole(message, context)
    }

    return context.result
  }

  /**
   * Process a message based on its role.
   * Role 1 = User, Role 2 = AI Assistant, Role 3 = Tool (handled in collectToolResults)
   */
  private processMessageByRole(
    message: ChatMLMessage,
    context: {
      toolResults: Map<string, string>
      tokens: { inputCount: number; outputCount: number } | undefined
      attachedFiles: Array<{ relativePath: string; startLine?: number }>
      result: PromptItemArray
    }
  ): void {
    switch (message.role) {
      case 1:
        this.processUserMessage(message, context)
        break
      case 2:
        this.processAssistantMessage(message, context)
        break
      // Role 3 (tool results) already processed in collectToolResults
    }
  }

  /**
   * Collect tool results from role 3 (tool response) messages.
   * Maps toolCallId -> result text for later lookup.
   */
  private collectToolResults(messages: ChatMLMessage[]): Map<string, string> {
    const toolResults = new Map<string, string>()
    for (const m of messages) {
      if (m.role === 3 && m.toolCallId) {
        const resultText = (m.content ?? [])
          .map((c) => c.text ?? '')
          .filter((t) => t.length > 0)
          .join('\n')
        if (resultText) {
          toolResults.set(m.toolCallId, resultText)
        }
      }
    }
    return toolResults
  }

  /**
   * Get token counts from usage metadata.
   */
  private getTokenCounts():
    | { inputCount: number; outputCount: number }
    | undefined {
    if (!this.usage) {
      return undefined
    }
    return {
      inputCount: this.usage.prompt_tokens ?? 0,
      outputCount: this.usage.completion_tokens ?? 0,
    }
  }

  /**
   * Collect attached file paths from message content.
   * Converts absolute paths to relative using home directory.
   */
  private collectAttachedFiles(
    messages: ChatMLMessage[]
  ): Array<{ relativePath: string; startLine?: number }> {
    const attachedFiles: Array<{ relativePath: string; startLine?: number }> =
      []
    const attachmentRegex = /<attachment[^>]*filePath="([^"]*)"[^>]*>/g
    const homeDir = os.homedir()

    for (const m of messages) {
      for (const c of m.content ?? []) {
        const text = c.text ?? ''
        // Use matchAll to avoid stateful regex issues with global flag
        for (const match of text.matchAll(attachmentRegex)) {
          const filePath = match[1]
          if (filePath) {
            let relativePath = filePath
            if (homeDir && filePath.startsWith(homeDir)) {
              relativePath = `~${filePath.slice(homeDir.length)}`
            }
            attachedFiles.push({ relativePath })
          }
        }
      }
    }
    return attachedFiles
  }

  /**
   * Process user message (role 1).
   * Extracts user prompts, adds tokens and attached files to the first prompt.
   */
  private processUserMessage(
    message: ChatMLMessage,
    context: {
      tokens: { inputCount: number; outputCount: number } | undefined
      attachedFiles: Array<{ relativePath: string; startLine?: number }>
      result: PromptItemArray
    }
  ): void {
    const { tokens, attachedFiles, result } = context
    for (const c of message.content ?? []) {
      if (c.type !== 1) {
        continue
      }

      const text = c.text ?? ''
      if (!text.includes('<userRequest>')) {
        continue
      }

      const userRequest = text
        .split('<userRequest>', 2)[1]
        .split('</userRequest>', 2)[0]
        .trim()

      result.push({
        type: 'USER_PROMPT',
        text: userRequest,
        date: new Date(),
        tokens: result.length === 0 ? tokens : undefined,
        attachedFiles:
          result.length === 0 && attachedFiles.length > 0
            ? attachedFiles
            : undefined,
      })
    }
  }

  /**
   * Process assistant message (role 2).
   * Extracts AI thinking, responses, and tool calls.
   */
  private processAssistantMessage(
    message: ChatMLMessage,
    context: {
      toolResults: Map<string, string>
      result: PromptItemArray
    }
  ): void {
    const { toolResults, result } = context
    // Extract AI_THINKING from content type 2
    for (const c of message.content ?? []) {
      if (c.type === 2 && c.value?.type === 'thinking') {
        const thinkingText = c.value.thinking?.text
        if (thinkingText?.trim()) {
          result.push({
            type: 'AI_THINKING',
            text: thinkingText,
            date: new Date(),
          })
        }
      }
    }

    // Extract AI_RESPONSE from content type 1
    for (const c of message.content ?? []) {
      if (c.type === 1 && c.text) {
        result.push({
          type: 'AI_RESPONSE',
          text: c.text,
          date: new Date(),
        })
      }
    }

    // Extract tool calls
    const toolCalls = message.toolCalls as ChatMLToolCall[] | undefined
    if (!Array.isArray(toolCalls)) {
      return
    }

    for (const tc of toolCalls) {
      if (!tc.id || !tc.function?.name) {
        continue
      }

      result.push({
        type: 'TOOL_EXECUTION',
        date: new Date(),
        tool: {
          name: tc.function.name,
          parameters: tc.function.arguments || '{}',
          result: toolResults.get(tc.id) ?? '',
          rawArguments: tc.function.arguments,
          accepted: true,
        },
      })
    }
  }

  /** Returns all tool calls found in the messages (for debugging) */
  getAllToolCalls(): Array<{ id: string; name: string }> {
    const out: Array<{ id: string; name: string }> = []
    const messages = this.getMessages()
    if (!Array.isArray(messages)) {
      return out
    }
    for (const m of messages) {
      const tcs = m?.toolCalls as ChatMLToolCall[] | undefined
      if (!Array.isArray(tcs)) {
        continue
      }
      for (const tc of tcs) {
        const fname = tc?.function?.name
        const id = tc?.id
        if (typeof fname === 'string' && typeof id === 'string' && id) {
          out.push({ id, name: fname })
        }
      }
    }
    return out
  }

  /**
   * Returns all tool call IDs from the messages (both from tool calls and tool results).
   * Used for correlating with session files to find the real sessionId.
   */
  getAllToolCallIds(): string[] {
    const ids: string[] = []
    const messages = this.getMessages()
    if (!Array.isArray(messages)) {
      return ids
    }

    for (const m of messages) {
      // Tool calls from assistant (role 2)
      const tcs = m?.toolCalls as ChatMLToolCall[] | undefined
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          if (typeof tc?.id === 'string' && tc.id) {
            ids.push(tc.id)
          }
        }
      }

      // Tool results (role 3) - also have toolCallId
      const toolCallId = (m as { toolCallId?: unknown })?.toolCallId
      if (typeof toolCallId === 'string' && toolCallId) {
        ids.push(toolCallId)
      }
    }

    // Return unique IDs
    return [...new Set(ids)]
  }

  /** Returns all tool call ids whose function.name is in names (order preserved) */
  getToolCallIds(names: string[]): string[] {
    const out: string[] = []
    const messages = this.getMessages()
    if (!Array.isArray(messages)) {
      return out
    }
    for (const m of messages) {
      const tcs = m?.toolCalls as ChatMLToolCall[] | undefined
      if (!Array.isArray(tcs)) {
        continue
      }
      for (const tc of tcs) {
        const fname = tc?.function?.name
        const id = tc?.id
        if (
          typeof fname === 'string' &&
          names.includes(fname) &&
          typeof id === 'string' &&
          id
        ) {
          out.push(id)
        }
      }
    }
    return out
  }

  private getMessages(): ChatMLMessage[] | undefined {
    if (Array.isArray(this.requestMessages?.messages)) {
      return this.requestMessages?.messages
    }
    if (isRecord(this.raw)) {
      const { requestMessages } = this.raw as Record<string, unknown>
      if (isRecord(requestMessages)) {
        const { messages } = requestMessages as Record<string, unknown>
        if (Array.isArray(messages)) {
          return messages as ChatMLMessage[]
        }
      }
    }
    return undefined
  }
}

function getToolFunctionName(tool: unknown): string | undefined {
  const t = tool as Partial<ChatMLTool> | undefined
  const name = t?.function?.name
  return typeof name === 'string' ? name : undefined
}

function extractMessagesFromRaw(raw: unknown): unknown[] | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const { requestMessages } = raw as Record<string, unknown>
  if (typeof requestMessages !== 'object' || requestMessages === null) {
    return undefined
  }
  const { messages } = requestMessages as Record<string, unknown>
  return Array.isArray(messages) ? messages : undefined
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
