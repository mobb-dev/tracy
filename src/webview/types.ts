import type { AIBlameAttribution } from '../ui/AIBlameCache'

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
  blameInfoState: 'IDLE' | 'LOADING' | 'SUCCESS' | 'ERROR'
  blameInfoError?: string
}
