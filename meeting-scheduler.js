#!/usr/bin/env node
/**
 * Meeting Scheduler — Heartbeat Helper
 *
 * Called by the system during heartbeats / morning briefing to:
 *   1. Scan Google Calendar for meetings with conference links
 *   2. Compare against known state (detect new, changed, cancelled)
 *   3. Output actionable items to schedule join triggers
 *
 * Usage:
 *   node meeting-scheduler.js --scan              # Scan calendar, output actions (default)
 *   node meeting-scheduler.js --scan --days 7     # Scan next 7 days
 *   node meeting-scheduler.js --status            # Show today's meeting schedule
 *   node meeting-scheduler.js --mark-scheduled <eventId> <cronJobId>  # Mark meeting as scheduled
 *   node meeting-scheduler.js --mark-joined <eventId>                 # Mark meeting as joined
 *   node meeting-scheduler.js --mark-done <eventId>                   # Mark meeting as done
 */

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { loadConfig, getCalendarEnv, getSkillDir } = require("./lib/config");

const SKILL_DIR = getSkillDir();
const config = loadConfig();
const STATE_FILE = "/tmp/meeting-schedule-state.json";
const CHANGES_LOG = "/tmp/meeting-schedule-changes.log";

// Google Calendar env from .env file
const GOG_ENV = getCalendarEnv();

// How many minutes before meeting start to join
const JOIN_BEFORE_MIN = config.calendar.joinBeforeMinutes || 2;

// ── Helpers ──────────────────────────────────────────────

function log(msg) {
    const ts = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Jerusalem" });
    console.log("[" + ts + "] " + msg);
}

function logChange(msg) {
    const ts = new Date().toLocaleString("en-GB", {
        timeZone: "Asia/Jerusalem",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
    });
    const line = "[" + ts + "] " + msg + "\n";
    try {
        fs.appendFileSync(CHANGES_LOG, line);
    } catch (e) {}
}

function execAsync(cmd, env = {}) {
    return new Promise((resolve, reject) => {
        const mergedEnv = { ...process.env, ...env };
        exec(cmd, { timeout: 30000, env: mergedEnv }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
}

function todayStr() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jerusalem" });
}

function formatTime(isoStr) {
    try {
        return new Date(isoStr).toLocaleTimeString("en-GB", {
            timeZone: "Asia/Jerusalem",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch (e) {
        return isoStr;
    }
}

function formatDate(isoStr) {
    try {
        return new Date(isoStr).toLocaleDateString("en-GB", {
            timeZone: "Asia/Jerusalem",
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
        });
    } catch (e) {
        return isoStr;
    }
}

// ── State Management ─────────────────────────────────────

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, "utf8");
            return JSON.parse(raw);
        }
    } catch (e) {}
    return { meetings: {} };
}

function saveState(state) {
    state.lastCheck = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Calendar Query ───────────────────────────────────────

async function fetchMeetings(days) {
    // Check if calendar is configured
    if (!GOG_ENV.GOG_ACCOUNT) {
        log("Warning: GOG_ACCOUNT not set in .env - calendar integration disabled");
        return [];
    }

    try {
        const flag = days === 1 ? "--today" : ("--days " + days);
        const output = await execAsync(
            "gog calendar events " + flag + " --all --json",
            GOG_ENV
        );
        const data = JSON.parse(output);
        const events = data.events || [];

        const meetings = [];
        const seenIds = new Set(); // deduplicate across calendars

        for (const event of events) {
            if (!event.start?.dateTime) continue;
            if (event.status === "cancelled") continue;

            // Deduplicate (--all returns same event from multiple calendars)
            const baseId = event.recurringEventId
                ? event.id  // recurring instance ID is unique
                : event.iCalUID || event.id;
            if (seenIds.has(baseId)) continue;
            seenIds.add(baseId);

            // Must have conference data
            const entryPoints = event.conferenceData?.entryPoints || [];
            const videoEntry = entryPoints.find(ep =>
                ep.entryPointType === "video" && ep.uri
            );
            if (!videoEntry) continue;

            const url = videoEntry.uri;
            if (!url.includes("meet.google.com") && !url.includes("zoom.us")) continue;

            // Must be attendee (or own calendar event)
            const isAttendee = (event.attendees || []).some(a =>
                a.self === true || a.email === GOG_ENV.GOG_ACCOUNT
            );
            const noAttendees = !event.attendees || event.attendees.length === 0;
            if (!isAttendee && !noAttendees) continue;

            // Skip if user explicitly declined
            const selfAttendee = (event.attendees || []).find(a => a.self === true);
            if (selfAttendee && selfAttendee.responseStatus === "declined") continue;

            meetings.push({
                eventId: event.id,
                summary: event.summary || "Untitled Meeting",
                start: event.start.dateTime,
                end: event.end?.dateTime || null,
                meetingUrl: url,
                platform: url.includes("zoom.us") ? "zoom" : "google-meet",
            });
        }

        return meetings;
    } catch (e) {
        log("Calendar query failed: " + e.message);
        return null;
    }
}

// ── Scan & Diff ──────────────────────────────────────────

async function runScan(days) {
    const state = loadState();
    const meetings = await fetchMeetings(days);

    if (meetings === null) {
        console.log(JSON.stringify({ error: "Calendar query failed", actions: [] }));
        return;
    }

    const actions = [];
    const currentIds = new Set();
    const now = new Date();

    for (const meeting of meetings) {
        const key = meeting.eventId;
        currentIds.add(key);
        const existing = state.meetings[key];

        const startTime = new Date(meeting.start);
        const minutesUntilStart = (startTime - now) / 1000 / 60;
        const joinAtISO = new Date(startTime.getTime() - JOIN_BEFORE_MIN * 60 * 1000).toISOString();

        // Skip meetings already passed
        if (minutesUntilStart < -5) continue;

        if (!existing) {
            // New meeting
            state.meetings[key] = {
                ...meeting,
                status: "pending",
                cronJobId: null,
                detectedAt: now.toISOString(),
            };
            logChange('NEW: "' + meeting.summary + '" at ' + formatDate(meeting.start) + " " + formatTime(meeting.start));

            actions.push({
                action: "schedule",
                eventId: key,
                summary: meeting.summary,
                start: meeting.start,
                joinAt: joinAtISO,
                meetingUrl: meeting.meetingUrl,
                platform: meeting.platform,
                minutesUntilStart: Math.round(minutesUntilStart),
            });

        } else if (existing.status === "pending" || existing.status === "scheduled") {
            // Check for time change
            if (existing.start !== meeting.start) {
                logChange('CHANGED: "' + meeting.summary + '" moved from ' +
                    formatTime(existing.start) + " to " + formatTime(meeting.start));

                existing.start = meeting.start;
                existing.end = meeting.end;
                existing.meetingUrl = meeting.meetingUrl;

                actions.push({
                    action: "reschedule",
                    eventId: key,
                    summary: meeting.summary,
                    start: meeting.start,
                    joinAt: joinAtISO,
                    meetingUrl: meeting.meetingUrl,
                    platform: meeting.platform,
                    previousCronJobId: existing.cronJobId,
                    minutesUntilStart: Math.round(minutesUntilStart),
                });

                existing.status = "pending";
                existing.cronJobId = null;
            }

            // Check URL change
            if (existing.meetingUrl !== meeting.meetingUrl) {
                existing.meetingUrl = meeting.meetingUrl;
                existing.platform = meeting.platform;
            }
            existing.summary = meeting.summary;
        }
    }

    // Check for cancellations
    for (const key of Object.keys(state.meetings)) {
        if (!currentIds.has(key)) {
            const meeting = state.meetings[key];
            const startTime = new Date(meeting.start);
            if (startTime > now && (meeting.status === "pending" || meeting.status === "scheduled")) {
                logChange('CANCELLED: "' + meeting.summary + '" (was at ' + formatTime(meeting.start) + ")");

                actions.push({
                    action: "cancel",
                    eventId: key,
                    summary: meeting.summary,
                    start: meeting.start,
                    previousCronJobId: meeting.cronJobId,
                });

                meeting.status = "cancelled";
            }
        }
    }

    // Clean up old entries (>2 days old)
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    for (const key of Object.keys(state.meetings)) {
        const m = state.meetings[key];
        if (new Date(m.start) < twoDaysAgo) {
            delete state.meetings[key];
        }
    }

    saveState(state);

    // Output for automation
    const output = {
        scannedDays: days,
        totalMeetings: meetings.length,
        actions: actions,
        summary: [],
    };

    if (actions.length === 0) {
        output.summary.push("No new meeting actions needed.");
    } else {
        for (const a of actions) {
            if (a.action === "schedule") {
                output.summary.push(
                    'SCHEDULE: "' + a.summary + '" on ' + formatDate(a.start) + " at " +
                    formatTime(a.start) + " (" + a.platform + ") — join at " + formatTime(a.joinAt) +
                    " — URL: " + a.meetingUrl
                );
            } else if (a.action === "reschedule") {
                output.summary.push(
                    'RESCHEDULE: "' + a.summary + '" moved to ' + formatTime(a.start) +
                    " — cancel old cron " + (a.previousCronJobId || "none") +
                    " and schedule new join at " + formatTime(a.joinAt)
                );
            } else if (a.action === "cancel") {
                output.summary.push(
                    'CANCEL: "' + a.summary + '" was removed — cancel cron ' +
                    (a.previousCronJobId || "none")
                );
            }
        }
    }

    console.log(JSON.stringify(output, null, 2));
}

// ── State Updates (called after scheduling) ───────

function markScheduled(eventId, cronJobId) {
    const state = loadState();
    if (state.meetings[eventId]) {
        state.meetings[eventId].status = "scheduled";
        state.meetings[eventId].cronJobId = cronJobId;
        saveState(state);
        console.log("OK: " + eventId + " marked as scheduled (cron: " + cronJobId + ")");
    } else {
        console.log("NOT FOUND: " + eventId);
    }
}

function markJoined(eventId) {
    const state = loadState();
    if (state.meetings[eventId]) {
        state.meetings[eventId].status = "joined";
        state.meetings[eventId].joinedAt = new Date().toISOString();
        saveState(state);
        console.log("OK: " + eventId + " marked as joined");
    } else {
        console.log("NOT FOUND: " + eventId);
    }
}

function markDone(eventId) {
    const state = loadState();
    if (state.meetings[eventId]) {
        state.meetings[eventId].status = "done";
        state.meetings[eventId].completedAt = new Date().toISOString();
        logChange('DONE: "' + state.meetings[eventId].summary + '" — recording complete');
        saveState(state);
        console.log("OK: " + eventId + " marked as done");
    } else {
        console.log("NOT FOUND: " + eventId);
    }
}

// ── Status Display ───────────────────────────────────────

async function showStatus() {
    const state = loadState();
    const keys = Object.keys(state.meetings);

    console.log("=== Meeting Schedule ===");
    console.log("Last check: " + (state.lastCheck || "never"));
    console.log("");

    if (keys.length === 0) {
        console.log("No tracked meetings. Run --scan to check calendar.");
        return;
    }

    const sorted = keys
        .map(k => ({ key: k, ...state.meetings[k] }))
        .sort((a, b) => new Date(a.start) - new Date(b.start));

    const icons = {
        pending: "⏳", scheduled: "🕐", joining: "🔄", joined: "🎙️",
        done: "✅", cancelled: "❌", skipped: "⏭️", missed: "⚠️", join_failed: "💥",
    };

    for (const m of sorted) {
        const icon = icons[m.status] || "❓";
        console.log("  " + icon + " " + formatDate(m.start) + " " + formatTime(m.start) + " — " + m.summary);
        console.log("    " + m.platform + " | " + m.status + (m.cronJobId ? " | cron: " + m.cronJobId : ""));
        console.log("    " + m.meetingUrl);
        console.log("");
    }
}

// ── CLI ──────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--status")) {
    showStatus();
} else if (args.includes("--mark-scheduled")) {
    const idx = args.indexOf("--mark-scheduled");
    markScheduled(args[idx + 1], args[idx + 2]);
} else if (args.includes("--mark-joined")) {
    const idx = args.indexOf("--mark-joined");
    markJoined(args[idx + 1]);
} else if (args.includes("--mark-done")) {
    const idx = args.indexOf("--mark-done");
    markDone(args[idx + 1]);
} else {
    // Default: --scan
    const daysIdx = args.indexOf("--days");
    const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) || 3 : 3;
    runScan(days).catch(e => {
        console.error("Error: " + e.message);
        process.exit(1);
    });
}
