// Ensure required env vars exist for modules that validate process.env at import time.
// Keep values minimal and deterministic for unit tests.

process.env.WEB_APP_URL ??= 'https://app.mobb.ai'
process.env.API_URL ??= 'https://api.mobb.ai/v1/graphql'
process.env.HASURA_ACCESS_KEY ??= 'dummy'
process.env.LOCAL_GRAPHQL_ENDPOINT ??= 'http://localhost:8080/v1/graphql'
