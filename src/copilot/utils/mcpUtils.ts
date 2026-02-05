/**
 * MCP (Model Context Protocol) tool detection utilities.
 *
 * MCP tools in VS Code Copilot are identified by their tool name prefix.
 * Built-in tools have names like: read_file, create_file, replace_string_in_file
 * MCP tools have names like: mcp_serverName_toolName
 *
 * Examples:
 * - mcp_datadog_list_metrics -> server: "datadog"
 * - mcp_mobb-mcp_scan_and_fix_vulnerabilities -> server: "mobb-mcp"
 */

/**
 * Check if a tool name indicates an MCP tool.
 * MCP tools are prefixed with "mcp_".
 *
 * @param toolName - The tool name from ccreq event
 * @returns true if the tool is an MCP tool
 */
export function isMcpTool(toolName: string | undefined | null): boolean {
  if (!toolName) {
    return false
  }
  return toolName.startsWith('mcp_')
}

/**
 * Extract MCP server name from tool name.
 *
 * Format: mcp_serverName_toolName
 * The server name is the portion between "mcp_" and the next underscore.
 *
 * Examples:
 * - "mcp_datadog_list_metrics" -> "datadog"
 * - "mcp_mobb-mcp_scan_and_fix_vulnerabilities" -> "mobb-mcp"
 * - "mcp_server" -> "server" (no tool name part)
 * - "read_file" -> undefined (not an MCP tool)
 *
 * @param toolName - The tool name from ccreq event
 * @returns The MCP server name, or undefined if not an MCP tool
 */
export function getMcpServerName(
  toolName: string | undefined | null
): string | undefined {
  if (!isMcpTool(toolName)) {
    return undefined
  }

  // Remove "mcp_" prefix (4 characters)
  const withoutPrefix = toolName!.slice(4)

  // Find the first underscore after the server name
  const firstUnderscore = withoutPrefix.indexOf('_')

  if (firstUnderscore === -1) {
    // No underscore after server name - entire remainder is server name
    return withoutPrefix || undefined
  }

  const serverName = withoutPrefix.slice(0, firstUnderscore)
  return serverName || undefined
}

/**
 * Extract MCP tool name (without server prefix) from full tool name.
 *
 * Format: mcp_serverName_toolName
 * The tool name is the portion after the server name.
 *
 * Examples:
 * - "mcp_datadog_list_metrics" -> "list_metrics"
 * - "mcp_mobb-mcp_scan_and_fix_vulnerabilities" -> "scan_and_fix_vulnerabilities"
 * - "mcp_server" -> undefined (no tool name part)
 * - "read_file" -> undefined (not an MCP tool)
 *
 * @param toolName - The full tool name from ccreq event
 * @returns The MCP tool name without prefix, or undefined if not an MCP tool
 */
export function getMcpToolName(
  toolName: string | undefined | null
): string | undefined {
  if (!isMcpTool(toolName)) {
    return undefined
  }

  // Remove "mcp_" prefix (4 characters)
  const withoutPrefix = toolName!.slice(4)

  // Find the first underscore after the server name
  const firstUnderscore = withoutPrefix.indexOf('_')

  if (firstUnderscore === -1) {
    // No underscore after server name - no tool name part
    return undefined
  }

  const mcpToolName = withoutPrefix.slice(firstUnderscore + 1)
  return mcpToolName || undefined
}
