/**
 * Shared constants for E2E tests — avoids the same magic string / magic number
 * being copy-pasted across Linux and Windows test files.
 */

export const MOCK_SERVER_DEFAULT_PORT = 3000
export const MOCK_SERVER_MULTI_TURN_PORT = 3001

export const MOCK_API_URL_DEFAULT = `http://localhost:${MOCK_SERVER_DEFAULT_PORT}/graphql`
export const MOCK_API_URL_MULTI_TURN = `http://localhost:${MOCK_SERVER_MULTI_TURN_PORT}/graphql`
export const MOCK_MOBB_API_URL_DEFAULT = `http://localhost:${MOCK_SERVER_DEFAULT_PORT}`
export const MOCK_WEB_APP_URL = 'http://localhost:5173'

/** Test-mobb-api placeholder token used by the extension when talking to the
 * mock server. Intentionally fake — never accepted by prod. */
export const TEST_MOBB_API_TOKEN = 'test-token'

/** Polling + timing constants used by the Playwright tests.
 * Named so the values are greppable and so we don't have to guess what an
 * unlabelled 500 / 2000 / 60000 means next time. */
export const CONTEXT_POLL_INTERVAL_MS = 1000
export const EXTENSION_ACTIVATION_POLL_INTERVAL_MS = 500
export const WORKBENCH_READY_TIMEOUT_MS = 15000
export const CLEANUP_SETTLE_MS = 2000
export const MODAL_POLL_INTERVAL_MS = 2000

export const RECORD_ID_LOG_PREFIX_LEN = 12
export const MAX_RECORDS_TO_LOG = 3
