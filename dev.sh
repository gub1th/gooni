#!/bin/bash
# Opens all Gooni dev processes in a new iTerm2 window with separate tabs.
# Usage: ./dev.sh

DIR="$(cd "$(dirname "$0")" && pwd)"

# Kill any existing processes on our ports
echo "Clearing ports 8000 and 5173..."
lsof -ti:8000 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

sleep 1

osascript <<EOF
tell application "iTerm2"
  create window with default profile

  -- Tab 1: Backend
  tell current window
    tell current session
      set name to "backend"
      write text "cd '$DIR' && source venv/bin/activate && uvicorn app.main:app --reload"
    end tell

    -- Tab 2: Frontend
    create tab with default profile
    tell current session
      set name to "frontend"
      write text "cd '$DIR/frontend' && npm run dev"
    end tell

    -- Tab 3: Telegram bot
    create tab with default profile
    tell current session
      set name to "telegram"
      write text "cd '$DIR' && source venv/bin/activate && PYTHONPATH='$DIR' python scripts/telegram_bot.py"
    end tell

    -- Tab 4: Datasette
    create tab with default profile
    tell current session
      set name to "datasette"
      write text "cd '$DIR' && source venv/bin/activate && datasette db/gooni.db -p 8002"
    end tell
  end tell
end tell
EOF
