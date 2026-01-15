#!/bin/bash
# Focus Copilot chat input using X11 tools (xdotool)
# This works in VNC/X11 environments by simulating actual hardware events

set -e

echo "🎯 Attempting to focus Copilot chat input using xdotool..."

# Find VS Code window
echo "🔍 Finding VS Code window..."
VSCODE_WINDOW=$(xdotool search --name "Visual Studio Code" | head -1)

if [ -z "$VSCODE_WINDOW" ]; then
  echo "❌ VS Code window not found"
  exit 1
fi

echo "✅ Found VS Code window: $VSCODE_WINDOW"

# Activate the window
echo "🔄 Activating VS Code window..."
xdotool windowactivate --sync "$VSCODE_WINDOW"
sleep 0.5

# Get window dimensions
WIN_INFO=$(xdotool getwindowgeometry "$VSCODE_WINDOW")
echo "📏 Window info: $WIN_INFO"

# Strategy 1: Click on right side of window where chat input typically is
# VS Code chat panel is usually on the right side, input at bottom
echo "🖱️  Strategy 1: Clicking on chat input area (right side, bottom)..."

# Get window position and size
WIN_X=$(echo "$WIN_INFO" | grep "Position:" | awk '{print $2}' | cut -d',' -f1)
WIN_Y=$(echo "$WIN_INFO" | grep "Position:" | awk '{print $2}' | cut -d',' -f2)
WIN_WIDTH=$(echo "$WIN_INFO" | grep "Geometry:" | awk '{print $2}' | cut -d'x' -f1)
WIN_HEIGHT=$(echo "$WIN_INFO" | grep "Geometry:" | awk '{print $2}' | cut -d'x' -f2)

echo "   Window position: ${WIN_X}x${WIN_Y}"
echo "   Window size: ${WIN_WIDTH}x${WIN_HEIGHT}"

# Calculate click coordinates
# Right panel: 75% from left
# Bottom area: 90% from top (where input is)
CLICK_X=$((WIN_X + WIN_WIDTH * 3 / 4))
CLICK_Y=$((WIN_Y + WIN_HEIGHT * 9 / 10))

echo "   Clicking at: ${CLICK_X}x${CLICK_Y}"
xdotool mousemove --sync "$CLICK_X" "$CLICK_Y"
sleep 0.2
xdotool click 1
sleep 0.5

# Take screenshot to verify
if command -v import &> /dev/null; then
  import -window root /tmp/after-click-1.png
  echo "📸 Screenshot saved: /tmp/after-click-1.png"
fi

# Check if focus worked by checking active window
ACTIVE_WINDOW=$(xdotool getactivewindow)
if [ "$ACTIVE_WINDOW" = "$VSCODE_WINDOW" ]; then
  echo "✅ VS Code window is active"
else
  echo "⚠️  Active window changed to: $ACTIVE_WINDOW"
fi

# Strategy 2: Try Tab key to navigate to input
echo "🖱️  Strategy 2: Using Tab key to navigate..."
xdotool key Tab
sleep 0.3
xdotool key Tab
sleep 0.3

# Strategy 3: Try clicking multiple positions in the chat panel
echo "🖱️  Strategy 3: Trying alternative click positions..."

# Position 1: More centered in right panel
CLICK_X2=$((WIN_X + WIN_WIDTH * 7 / 8))
CLICK_Y2=$((WIN_Y + WIN_HEIGHT * 85 / 100))
echo "   Trying position: ${CLICK_X2}x${CLICK_Y2}"
xdotool mousemove --sync "$CLICK_X2" "$CLICK_Y2"
sleep 0.2
xdotool click 1
sleep 0.5

# Position 2: Lower in the panel
CLICK_X3=$((WIN_X + WIN_WIDTH * 3 / 4))
CLICK_Y3=$((WIN_Y + WIN_HEIGHT * 95 / 100))
echo "   Trying position: ${CLICK_X3}x${CLICK_Y3}"
xdotool mousemove --sync "$CLICK_X3" "$CLICK_Y3"
sleep 0.2
xdotool click 1
sleep 0.5

# Strategy 4: Type directly and see if anything appears
echo "⌨️  Strategy 4: Attempting to type test text..."
xdotool type --delay 100 "TEST"
sleep 0.5

# Take final screenshot
if command -v import &> /dev/null; then
  import -window root /tmp/after-all-attempts.png
  echo "📸 Final screenshot saved: /tmp/after-all-attempts.png"
fi

echo "✅ Focus attempts complete"
echo "   Check screenshots in /tmp/"
echo "   If 'TEST' appears in chat input, focus was successful"
