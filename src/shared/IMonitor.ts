export enum AppType {
  CURSOR = 'cursor',
  VSCODE = 'vscode',
  UNKNOWN = 'unknown',
}

export type IMonitor = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  readonly name: string
}

export abstract class BaseMonitor implements IMonitor {
  constructor(protected appType: AppType) {}
  protected _isRunning = false

  abstract readonly name: string

  isRunning(): boolean {
    return this._isRunning
  }

  abstract start(): Promise<void>
  abstract stop(): Promise<void>
}
