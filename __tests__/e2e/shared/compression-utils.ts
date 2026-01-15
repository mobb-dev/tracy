/**
 * Compression and encoding utilities for E2E tests
 * Handles base64 decoding and gzip decompression
 */

import * as zlib from 'node:zlib'

/**
 * Check if a buffer contains gzip magic bytes (0x1f 0x8b)
 */
export function isGzipped(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

/**
 * Decode a base64 string and decompress it if it's gzipped
 *
 * @param base64String - Base64-encoded string (may be gzip-compressed)
 * @param verbose - Whether to log decompression details
 * @returns Decompressed buffer
 */
export function decodeAndDecompressBase64(
  base64String: string,
  verbose = false
): Buffer {
  // Decode base64
  let buffer = Buffer.from(base64String, 'base64')

  if (verbose) {
    console.log(
      `📦 Decoded base64 to ${buffer.length} bytes (magic: ${buffer[0]?.toString(16)} ${buffer[1]?.toString(16)})`
    )
  }

  // Check if gzip compressed (magic bytes: 0x1f 0x8b)
  if (isGzipped(buffer)) {
    if (verbose) {
      console.log('📦 Detected gzip compression, decompressing...')
      const compressedSize = buffer.length
      buffer = zlib.gunzipSync(buffer)
      console.log(
        `📦 Decompressed: ${compressedSize} bytes → ${buffer.length} bytes`
      )
    } else {
      buffer = zlib.gunzipSync(buffer)
    }
  } else if (verbose) {
    console.log('📦 Data is not gzip compressed, using as-is')
  }

  return buffer
}

/**
 * Verify that a buffer contains SQLite database format
 *
 * @param buffer - Buffer to check
 * @returns True if the buffer starts with "SQLite format 3"
 */
export function verifySQLiteMagic(buffer: Buffer): boolean {
  const sqliteMagic = buffer.slice(0, 16).toString('utf8')
  return sqliteMagic.startsWith('SQLite format 3')
}

/**
 * Decode and verify a base64-encoded SQLite database
 *
 * @param base64String - Base64-encoded SQLite database (may be gzip-compressed)
 * @param verbose - Whether to log details
 * @returns Decoded and decompressed buffer
 * @throws Error if the buffer doesn't contain a valid SQLite database
 */
export function decodeSQLiteDatabase(
  base64String: string,
  verbose = false
): Buffer {
  const buffer = decodeAndDecompressBase64(base64String, verbose)

  // Verify SQLite format
  if (!verifySQLiteMagic(buffer)) {
    const magicBytes = buffer.slice(0, 16).toString('utf8')
    throw new Error(
      `Invalid SQLite database format. Got magic bytes: ${JSON.stringify(magicBytes)}`
    )
  }

  if (verbose) {
    console.log('✅ Verified SQLite database format')
  }

  return buffer
}
