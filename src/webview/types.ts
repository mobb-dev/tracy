import type { AIBlameAttribution, PromptSummary } from '../ui/AIBlameCache'

export type WebviewContext = {
  nonce: string
}

export type InfoPanelData = {
  fileName: string
  lineNumber: number
  attribution: AIBlameAttribution | null
  repoUrl?: string
  conversation: Array<{ type: string; text: string; date: string }>
  conversationState: 'IDLE' | 'LOADING' | 'SUCCESS' | 'ERROR'
  conversationError?: string
  conversationSummary?: PromptSummary
  conversationSummaryState: 'IDLE' | 'LOADING' | 'SUCCESS' | 'ERROR'
  conversationSummaryError?: string
  blameInfoState: 'IDLE' | 'LOADING' | 'SUCCESS' | 'ERROR'
  blameInfoError?: string
}
