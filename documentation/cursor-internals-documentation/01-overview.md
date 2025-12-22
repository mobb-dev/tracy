# Cursor Database Documentation

## Overview

This directory contains documentation for understanding the internal structure of Cursor's SQLite database. This knowledge is essential for the VSCode extension, which collects and processes data directly from the Cursor database.

## Purpose

The primary goals of this documentation are to:

1. **Document Key-Value Structure**: Describe the keys and JSON value structures stored in the `cursorDiskKV` table
2. **Map Object Relationships**: Explain the relationships between different JSON objects and how they reference each other
3. **Guide Development**: Provide a reference for developers working on the extension to understand how to query and extract data
4. **Maintain Compatibility**: Track changes in the key-value schema across different Cursor versions

## Background

Cursor uses an internal SQLite database as a key-value store in the `cursorDiskKV` table. Each entry consists of:

- **key**: A text identifier
- **value**: A JSON object containing the actual data

The database stores various types of data, including:

- Chat conversations and message history
- AI interactions and completions
- User preferences and settings
- Workspace-specific data
- Usage metrics and telemetry

This extension accesses the `cursorDiskKV` table directly to collect and process relevant JSON objects for analysis and monitoring purposes.

## Structure

This documentation should cover:

- **Keys**: List and descriptions of important keys in the `cursorDiskKV` table
- **JSON Schemas**: Structure and data types of the JSON values for each key
- **Object Relationships**: How JSON objects reference or relate to each other through IDs or nested structures
- **Queries**: Common query patterns for extracting specific keys and parsing their JSON values
- **Version Changes**: Notes on how the key-value schema evolves across Cursor versions

## Contributing

When updating this documentation:

- Verify information against the actual `cursorDiskKV` table contents
- Include example JSON structures where helpful
- Document how JSON objects reference each other
- Note which Cursor version the documentation applies to
- Update relevant sections when the extension's data collection needs change
