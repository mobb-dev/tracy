import { describe, expect, it } from 'vitest'

import { ToolCall } from '../src/copilot/events/ToolCall'
import apply_patch from './files/tool_call_apply_patch.json'
import create_file from './files/tool_call_create_file.json'
import replace_string_in_file from './files/tool_call_replace_string_in_file.json'

describe('ToolCall getInference', () => {
  it('should extract inference from replace_string_in_file tool call', () => {
    const toolCall = ToolCall.fromJson(replace_string_in_file)
    expect(toolCall).toBeDefined()
    expect(toolCall.tool).toBe('replace_string_in_file')

    const inference = toolCall.getInference()
    expect(inference).toBe(
      '            String sql = "SELECT * FROM accounts WHERE user_id = ?";\n            PreparedStatement pstmt = conn.prepareStatement(sql);\n            pstmt.setString(1, userId);\n            ResultSet rs = pstmt.executeQuery();'
    )
  })
  it('should extract inference from apply_patch tool call', () => {
    const toolCall = ToolCall.fromJson(apply_patch)
    const inference = toolCall.getInference()
    expect(inference).toBe(
      `        try (Connection conn = dataSource.getConnection()) {
            String sql = "SELECT * FROM users WHERE username = ? AND password = ?";
            System.out.println("Executing SQL: " + sql);
            PreparedStatement pstmt = conn.prepareStatement(sql);
            pstmt.setString(1, username);
            pstmt.setString(2, password);
            ResultSet rs = pstmt.executeQuery();
            if (rs.next()) {
                User user = new User();
                user.setId(rs.getLong("id"));
                user.setUsername(rs.getString("username"));
                user.setPassword(rs.getString("password"));
                user.setFirstName(rs.getString("first_name"));
                user.setLastName(rs.getString("last_name"));
                user.setEmail(rs.getString("email"));
                return user;`
    )
  })
  it('should extract inference from create_file tool call', () => {
    const toolCall = ToolCall.fromJson(create_file)
    const inference = toolCall.getInference()
    expect(inference).toBe(
      `# Entities\n\n- \`Account\` - Bank account entity\n- \`CreditApplication\` - Credit application entity\n- \`User\` - User entity`
    )
  })
})
