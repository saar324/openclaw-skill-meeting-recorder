#!/bin/bash
# Weekly Chrome tab cleanup
# Closes ALL tabs except WhatsApp Web (and about:blank fallback)
# Scheduled via cron: every Sunday at 12:00
#
# Safety: skips cleanup if a meeting bot is currently active
#
# Cron entry example:
#   0 12 * * 0 /path/to/meeting-recorder/scripts/cleanup/weekly-tab-cleanup.sh >> /tmp/tab-cleanup.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')] [tab-cleanup]"

# Load config for Chrome port
CHROME_PORT=9222
if [ -f "$SKILL_DIR/lib/config.js" ]; then
    CHROME_PORT=$(node -e "console.log(require('$SKILL_DIR/lib/config').loadConfig().chrome?.debuggingPort || 9222)" 2>/dev/null || echo "9222")
fi

CHROME_DEBUG="http://localhost:$CHROME_PORT"

echo "$LOG_PREFIX Starting weekly tab cleanup..."

# ── Safety check: don't clean up during active meetings ──
if pgrep -f "meeting-bot.js" > /dev/null 2>&1; then
    echo "$LOG_PREFIX SKIPPED: meeting-bot.js is running (active meeting)"
    exit 0
fi

# ── Safety check: don't clean up during active recordings ──
if pgrep -f "ffmpeg.*meeting_recorder" > /dev/null 2>&1; then
    echo "$LOG_PREFIX SKIPPED: ffmpeg recording in progress"
    exit 0
fi

# ── Check Chrome is running ──
if ! curl -s "$CHROME_DEBUG/json" > /dev/null 2>&1; then
    echo "$LOG_PREFIX SKIPPED: Chrome not running or not reachable"
    exit 0
fi

# ── Get all tabs ──
TABS=$(curl -s "$CHROME_DEBUG/json")
TAB_COUNT=$(echo "$TABS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)

if [ -z "$TAB_COUNT" ] || [ "$TAB_COUNT" -eq 0 ]; then
    echo "$LOG_PREFIX No tabs found"
    exit 0
fi

echo "$LOG_PREFIX Found $TAB_COUNT tab(s)"

# ── Close tabs that are NOT WhatsApp ──
echo "$TABS" | python3 -c "
import sys, json, urllib.request

tabs = json.load(sys.stdin)
debug_url = '$CHROME_DEBUG'

# Identify tabs to keep vs close
keep_patterns = ['web.whatsapp.com', 'whatsapp.com/sw.js', 'whatsapp.com/static']
close_ids = []
keep_count = 0

for tab in tabs:
    url = tab.get('url', '')
    title = tab.get('title', '')
    tab_id = tab.get('id', '')
    tab_type = tab.get('type', 'page')

    # Skip non-page types (service workers, web workers, etc.)
    if tab_type != 'page':
        keep_count += 1
        continue

    # Keep WhatsApp tabs
    should_keep = any(p in url for p in keep_patterns)

    if should_keep:
        keep_count += 1
        print(f'KEEP: {title[:50]} ({url[:60]})')
    else:
        close_ids.append((tab_id, title, url))
        print(f'CLOSE: {title[:50]} ({url[:60]})')

# Must keep at least one tab (Chrome needs it)
if keep_count == 0 and len(close_ids) > 0:
    # Keep one tab, navigate to about:blank
    spare = close_ids.pop()
    print(f'SPARE (navigate to about:blank): {spare[1][:50]}')
    try:
        urllib.request.urlopen(f'{debug_url}/json/navigate?url=about:blank&id={spare[0]}', timeout=5)
    except: pass

# Close the rest
closed = 0
for tab_id, title, url in close_ids:
    try:
        urllib.request.urlopen(f'{debug_url}/json/close/{tab_id}', timeout=5)
        closed += 1
    except Exception as e:
        print(f'Failed to close {title[:30]}: {e}')

print(f'')
print(f'SUMMARY: closed={closed}, kept={keep_count}, total_before={len(tabs)}')
" 2>&1

echo "$LOG_PREFIX Cleanup complete"
