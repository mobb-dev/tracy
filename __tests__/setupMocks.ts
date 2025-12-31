import { vi } from 'vitest'

// Some transitive dependencies validate/initialize at import time and are not
// relevant to the unit tests in this package. Stub them to keep tests focused
// and deterministic.

vi.mock('libsodium-wrappers', () => {
  const sodium = {
    ready: Promise.resolve(),
    // Provide the minimal surface area used by the codebase.
    crypto_box_seal: vi.fn(() => new Uint8Array()),
    from_string: vi.fn(() => new Uint8Array()),
    to_base64: vi.fn(() => ''),
  }

  return {
    __esModule: true,
    default: sodium,
    ...sodium,
  }
})
