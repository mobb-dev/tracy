# Copilot Chat Input Focus Research

## HTML Structure Analysis

From the provided HTML, the Copilot chat input has this structure:

```
.interactive-input-and-side-toolbar
  └─ .chat-input-container [data-keybinding-context="16"]
      └─ .chat-editor-container
          └─ .interactive-input-editor [data-keybinding-context="17"]
              └─ .monaco-editor [role="code"]
                  └─ .native-edit-context [role="textbox", tabindex="0"]
```

## Key Elements

1. **Native Edit Context** (actual editable element):
   - Class: `.native-edit-context`
   - Role: `textbox`
   - Tabindex: `0`
   - Aria: `aria-multiline="true"`, `aria-autocomplete="both"`
   - Aria-label: "The editor is not accessible at this time..."

2. **Monaco Editor Container**:
   - Class: `.monaco-editor`
   - Role: `code`
   - Has cursor layer and content areas

3. **Chat Input Container**:
   - Class: `.chat-input-container`
   - Contains attachments toolbar and editor

## Focus Strategies (Ranked by Reliability)

### Strategy 1: Direct Focus on Native Edit Context ⭐⭐⭐⭐⭐
**Most Reliable - Direct DOM manipulation**

```typescript
await mainWindow.evaluate(() => {
  const editContext = document.querySelector('.native-edit-context[role="textbox"]');
  if (editContext) {
    (editContext as HTMLElement).focus();
  }
});
```

**Pros**:
- Bypasses Playwright's event system (no keyboard timeout issues)
- Works even in headless mode
- Directly targets the actual editable element

**Cons**:
- Skips VS Code's internal focus handlers (might miss some initialization)

---

### Strategy 2: Click on Native Edit Context ⭐⭐⭐⭐
**Second Most Reliable**

```typescript
const editContext = mainWindow.locator('.native-edit-context[role="textbox"]').first();
if (await editContext.isVisible({ timeout: 2000 })) {
  await editContext.click();
  await mainWindow.waitForTimeout(300);
}
```

**Pros**:
- Triggers VS Code's click handlers
- More realistic user interaction
- Works in headless mode

**Cons**:
- Requires element to be visible
- Slightly slower than direct focus()

---

### Strategy 3: Click Monaco Editor Container ⭐⭐⭐⭐
**Good fallback if native-edit-context not accessible**

```typescript
const monacoEditor = mainWindow.locator('.interactive-input-editor .monaco-editor[role="code"]').first();
if (await monacoEditor.isVisible({ timeout: 2000 })) {
  await monacoEditor.click();
  await mainWindow.waitForTimeout(300);
}
```

**Pros**:
- Larger click target
- Monaco has built-in focus handling
- Reliable in headless mode

**Cons**:
- May focus the editor but not the exact input area

---

### Strategy 4: Accessibility Locator ⭐⭐⭐⭐
**Best practice for accessibility**

```typescript
const chatInput = mainWindow.getByRole('textbox', { name: /editor/i });
if (await chatInput.isVisible({ timeout: 2000 })) {
  await chatInput.click();
  await mainWindow.waitForTimeout(300);
}
```

**Pros**:
- Uses semantic role
- Works across UI changes
- Best for accessibility testing

**Cons**:
- Aria-label might change across VS Code versions
- Need to handle multiple textboxes on page

---

### Strategy 5: Tab Navigation from Known Element ⭐⭐⭐
**When direct selection fails**

```typescript
// Click on a known focusable element first
const attachButton = mainWindow.locator('.chat-attachment-button').first();
if (await attachButton.isVisible({ timeout: 2000 })) {
  await attachButton.click();
  await mainWindow.waitForTimeout(200);

  // Tab to next element (the input)
  await mainWindow.keyboard.press('Tab');
  await mainWindow.waitForTimeout(200);
}
```

**Pros**:
- Mimics real user behavior
- Works when selectors are unstable

**Cons**:
- Fragile if UI layout changes
- May skip over the target element
- Can timeout in headless mode

---

### Strategy 6: Command Palette Focus Command ⭐⭐⭐
**Using VS Code commands**

```typescript
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
await mainWindow.keyboard.press(`${modifier}+Shift+KeyP`);
await mainWindow.waitForTimeout(500);
await mainWindow.keyboard.type('GitHub Copilot: Focus on Chat View');
await mainWindow.waitForTimeout(300);
await mainWindow.keyboard.press('Enter');
await mainWindow.waitForTimeout(1000);
```

**Pros**:
- Uses official VS Code command
- Guaranteed to focus correctly
- Works across UI changes

**Cons**:
- Requires keyboard events (can timeout in headless)
- Slower than direct clicks
- Command name might change

---

### Strategy 7: Click at Calculated Coordinates ⭐⭐
**Last resort for headless environments**

```typescript
const editorContainer = mainWindow.locator('.chat-editor-container').first();
const box = await editorContainer.boundingBox();
if (box) {
  // Click in the middle of the editor
  await mainWindow.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await mainWindow.waitForTimeout(300);
}
```

**Pros**:
- Works when element selectors fail
- Reliable in headless mode

**Cons**:
- Fragile if layout changes
- Doesn't work if element is covered
- Hard to debug

---

## Recommended Multi-Strategy Approach

Based on Cursor test's successful pattern, use this fallback chain:

```typescript
async function focusCopilotInput(mainWindow: Page): Promise<boolean> {
  // Strategy 1: Direct focus (fastest, most reliable)
  try {
    await mainWindow.evaluate(() => {
      const editContext = document.querySelector('.native-edit-context[role="textbox"]');
      if (editContext) {
        (editContext as HTMLElement).focus();
        return true;
      }
      return false;
    });

    // Verify focus
    const activeElement = await mainWindow.evaluate(() =>
      document.activeElement?.className
    );
    if (activeElement?.includes('native-edit-context')) {
      console.log('✅ Focus achieved via direct focus()');
      return true;
    }
  } catch (e) {
    console.log(`Strategy 1 failed: ${e}`);
  }

  // Strategy 2: Click on native-edit-context
  try {
    const editContext = mainWindow.locator('.native-edit-context[role="textbox"]').first();
    if (await editContext.isVisible({ timeout: 2000 })) {
      await editContext.click();
      await mainWindow.waitForTimeout(300);
      console.log('✅ Focus achieved via click on native-edit-context');
      return true;
    }
  } catch (e) {
    console.log(`Strategy 2 failed: ${e}`);
  }

  // Strategy 3: Click on Monaco editor
  try {
    const monacoEditor = mainWindow.locator('.interactive-input-editor .monaco-editor').first();
    if (await monacoEditor.isVisible({ timeout: 2000 })) {
      await monacoEditor.click();
      await mainWindow.waitForTimeout(300);
      console.log('✅ Focus achieved via click on Monaco editor');
      return true;
    }
  } catch (e) {
    console.log(`Strategy 3 failed: ${e}`);
  }

  // Strategy 4: Accessibility locator
  try {
    const chatInput = mainWindow.getByRole('textbox').first();
    if (await chatInput.isVisible({ timeout: 2000 })) {
      await chatInput.click();
      await mainWindow.waitForTimeout(300);
      console.log('✅ Focus achieved via accessibility locator');
      return true;
    }
  } catch (e) {
    console.log(`Strategy 4 failed: ${e}`);
  }

  // Strategy 5: Click on chat-input-container
  try {
    const container = mainWindow.locator('.chat-input-container').first();
    if (await container.isVisible({ timeout: 2000 })) {
      await container.click();
      await mainWindow.waitForTimeout(300);
      console.log('✅ Focus achieved via container click');
      return true;
    }
  } catch (e) {
    console.log(`Strategy 5 failed: ${e}`);
  }

  console.log('❌ All focus strategies failed');
  return false;
}
```

## Verification Methods

After attempting focus, verify success:

```typescript
// Method 1: Check active element
const activeClass = await mainWindow.evaluate(() =>
  document.activeElement?.className
);
const focused = activeClass?.includes('native-edit-context') ||
                activeClass?.includes('monaco');

// Method 2: Try typing test character
await mainWindow.keyboard.type('x', { delay: 50 });
await mainWindow.waitForTimeout(200);
const hasText = await mainWindow.locator('.view-lines').textContent();
const textAppeared = hasText?.includes('x');

// Method 3: Check cursor visibility
const cursorVisible = await mainWindow.locator('.cursor').isVisible();
```

## Key Selectors Summary

| Target | Selector | Notes |
|--------|----------|-------|
| Actual editable area | `.native-edit-context[role="textbox"]` | Best target |
| Monaco editor | `.interactive-input-editor .monaco-editor` | Good fallback |
| Input container | `.chat-input-container` | Larger target |
| By role | `getByRole('textbox')` | Accessibility |
| Editor content area | `.view-lines` | For verification |
| Cursor | `.cursor` | For verification |

## Special Considerations for Headless Mode

1. **Avoid keyboard shortcuts** - They timeout in Xvfb
2. **Use direct DOM manipulation** - Bypasses event system issues
3. **Click directly on elements** - More reliable than keyboard nav
4. **Wait for element visibility** - Ensure element is rendered
5. **Verify focus explicitly** - Don't assume it worked

## References

- Cursor test uses direct click on `textarea[placeholder*="Plan"]`
- VS Code uses Monaco editor (more complex than simple textarea)
- Native-edit-context is the actual editable div (contenteditable-like)
- The `.ime-text-area` is for IME input, not the main input
