import type { ElectronApplication } from 'playwright'
import { _electron as electron } from 'playwright'

type ElectronLaunchOptions = Parameters<typeof electron.launch>[0]

const DEFAULT_LAUNCH_ATTEMPTS = 3

/**
 * Launch an Electron app (VS Code / Cursor) with bounded retries.
 *
 * `electron.launch` intermittently exceeds its per-attempt timeout on CI
 * runners (cold start + disk/CPU contention) — a TimeoutError there fails the
 * whole test before it runs, even though a second launch a few seconds later
 * succeeds. Relaunching is cheap (seconds) versus a full Playwright test-level
 * retry (which re-does all setup: extension install, sign-in, ...), so we
 * absorb a stuck launch here first. The caller's own `timeout` (passed through
 * `options`) is preserved as the per-attempt budget.
 */
export async function launchElectronWithRetry(
  options: ElectronLaunchOptions,
  attempts: number = DEFAULT_LAUNCH_ATTEMPTS
): Promise<ElectronApplication> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await electron.launch(options)
    } catch (error) {
      lastError = error
      console.log(
        `[launchElectronWithRetry] launch attempt ${attempt}/${attempts} failed: ${
          (error as Error).message
        }`
      )
    }
  }
  throw lastError
}
