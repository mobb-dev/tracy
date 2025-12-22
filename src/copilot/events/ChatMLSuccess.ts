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
  startTime?: string // ISO
  endTime?: string // ISO
  duration?: number // ms
  usage?: ChatMLUsage
  tools?: ChatMLTool[] // tool schemas vary
}

export type ChatMLMessageContent = {
  type?: number | string
  text?: string
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

export class ChatMLSuccess {
  constructor(
    public id: string,
    public type: string,
    public name: string | undefined, // e.g. "panel/editAgent"
    public requestType: string | undefined, // metadata.requestType
    public model: string | undefined, // metadata.model
    public startTime: Date | undefined, // from metadata.startTime
    public endTime: Date | undefined, // from metadata.endTime
    public durationMs: number | undefined, // metadata.duration
    public usage: ChatMLUsage | undefined, // metadata.usage
    public toolNames: string[], // derived from metadata.tools[*].function.name
    public requestMessages: ChatMLRequestMessages | undefined, // obj.requestMessages
    public raw: unknown // original object for advanced consumers
  ) {}

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

    return new ChatMLSuccess(
      id,
      type,
      name,
      typeof metadata?.requestType === 'string'
        ? metadata.requestType
        : undefined,
      typeof metadata?.model === 'string' ? metadata.model : undefined,
      startTime,
      endTime,
      Number.isFinite(metadata?.duration as number)
        ? (metadata?.duration as number)
        : undefined,
      metadata?.usage as ChatMLUsage | undefined,
      toolNames,
      requestMessages,
      objUnknown
    )
  }

  getPromptData(): PromptItemArray {
    const result: PromptItemArray = []
    const messages = this.getMessages()

    if (!Array.isArray(messages)) {
      return []
    }

    for (const m of messages) {
      // Role 1 contains user request.
      if (m.role === 1) {
        for (const c of m.content ?? []) {
          if (c.type !== 1) {
            continue
          }

          const text = c.text ?? ''

          if (text.includes('<userRequest>')) {
            let userRequest = text.split('<userRequest>', 2)[1]

            userRequest = userRequest.split('</userRequest>', 2)[0].trim()

            result.push({
              type: 'USER_PROMPT',
              text: userRequest,
              date: new Date(),
            })
          }
        }

        // Role 2 contains AI responses.
      } else if (m.role === 2) {
        for (const c of m.content ?? []) {
          if (c.type !== 1 || !c.text) {
            continue
          }

          result.push({
            type: 'AI_RESPONSE',
            text: c.text,
            date: new Date(),
          })
        }
      }
    }

    return result
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
