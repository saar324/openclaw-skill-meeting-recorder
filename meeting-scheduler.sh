#!/bin/bash
# Cron wrapper for meeting-scheduler.js
# Sets required environment variables and runs the scheduler.
#
# Cron entry example:
#   * 7-18 * * 0-4 /path/to/meeting-recorder/meeting-scheduler.sh >> /tmp/meeting-scheduler.log 2>&1

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load environment from .env if exists
if [ -f "$SKILL_DIR/.env" ]; then
    set -a
    source "$SKILL_DIR/.env"
    set +a
fi

export DISPLAY="${DISPLAY:-:98}"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/root/go/bin:$PATH"

cd "$SKILL_DIR"
exec node meeting-scheduler.js "$@"
