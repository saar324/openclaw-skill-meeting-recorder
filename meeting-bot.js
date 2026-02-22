const puppeteer = require("puppeteer-core");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { resolvePlatform } = require("./platforms");
const { loadConfig, getSkillDir } = require("./lib/config");

const SKILL_DIR = getSkillDir();
const config = loadConfig();
const BOT_NAME = config.botName;

class MeetingBot {
    constructor() {
        this.browser = null;
        this.page = null;
        this.adapter = null;          // Platform adapter (google-meet, zoom, etc.)
        this.recordingPath = null;
        this.meetingName = null;
        this.isInMeeting = false;
        this.hasJoinedMeeting = false;
        // Metadata
        this.startedAt = null;
        this.platform = null;
        this.meetingCode = null;
        this.meetingUrl = null;
    }

    formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) {
            return hours + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
        }
        return minutes + ":" + String(seconds).padStart(2, "0");
    }

    log(msg) {
        const timestamp = new Date().toLocaleTimeString();
        console.log("[" + timestamp + "] " + msg);
    }

    execAsync(cmd) {
        return new Promise((resolve, reject) => {
            exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });
    }

    // ── Browser ─────────────────────────────────────────────

    async init() {
        this.log("Connecting to Chrome...");

        this.browser = await puppeteer.connect({
            browserURL: "http://localhost:" + config.chrome.debuggingPort,
            defaultViewport: null,
        });

        const pages = await this.browser.pages();
        this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

        this.log("Connected to Chrome");
    }

    // ── Audio ───────────────────────────────────────────────

    async setupAudio() {
        this.log("Setting up audio capture...");
        try {
            await this.execAsync("bash " + SKILL_DIR + "/scripts/setup/create-virtual-sink.sh");
        } catch (e) {
            // Sink might already exist
        }
    }

    async startRecording(meetingName) {
        this.meetingName = meetingName;
        this.log("Starting recording for: " + meetingName);

        try {
            const output = await this.execAsync("bash " + SKILL_DIR + "/scripts/recording/start-recording.sh \"" + meetingName + "\"");
            console.log(output);
            const match = output.match(/Output: (.+\.wav)/);
            if (match) {
                this.recordingPath = match[1];
                this.log("Recording to: " + this.recordingPath);
            }
        } catch (e) {
            this.log("Recording error: " + e.message);
        }
    }

    async routeAudio() {
        this.log("Routing browser audio to recorder...");

        try {
            await this.execAsync("pactl set-default-sink meeting_recorder");
        } catch (e) {}

        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));

            try {
                const result = await this.execAsync("pactl list short sink-inputs 2>/dev/null | awk '{print \}'");
                const streamIds = result.trim().split('\n').filter(Boolean);

                if (streamIds.length > 0) {
                    for (const streamId of streamIds) {
                        try {
                            await this.execAsync("pactl move-sink-input " + streamId + " meeting_recorder");
                        } catch (e) {}
                    }
                    this.log("Audio routed (" + streamIds.length + " stream(s))");
                    return true;
                }
            } catch (e) {}
        }
        this.log("Warning: Could not find audio streams to route");
        return false;
    }

    async stopRecording() {
        this.log("Stopping recording...");
        try {
            const output = await this.execAsync("bash " + SKILL_DIR + "/scripts/recording/stop-recording.sh");
            console.log(output);
        } catch (e) {
            this.log("Stop recording error: " + e.message);
        }
    }

    // ── Transcription ───────────────────────────────────────

    async transcribe() {
        if (!this.recordingPath) {
            this.log("No recording path, skipping transcription");
            return null;
        }

        this.log("Transcribing (this may take a few minutes)...");
        try {
            const output = await this.execAsync("bash " + SKILL_DIR + "/scripts/transcription/transcribe.sh \"" + this.recordingPath + "\"");
            console.log(output);
            this.log("Transcription complete");

            const txtPath = this.recordingPath.replace(".wav", ".txt");
            if (fs.existsSync(txtPath)) {
                return fs.readFileSync(txtPath, "utf8");
            }
        } catch (e) {
            this.log("Transcription error: " + e.message);
        }
        return null;
    }

    async generateMetadata(transcriptPath) {
        this.log("Generating AI metadata...");
        try {
            const output = await this.execAsync(
                "python3 " + SKILL_DIR + "/scripts/processing/generate-metadata.py \"" + transcriptPath + "\""
            );
            return JSON.parse(output);
        } catch (e) {
            this.log("Metadata generation error: " + e.message);
            return null;
        }
    }

    // ── Join Flow (delegates to adapter) ────────────────────

    async joinMeeting(url) {
        this.log("Joining meeting: " + url);

        // Resolve the right platform adapter based on URL
        this.adapter = resolvePlatform(url, this.page, this.log.bind(this));

        // Capture metadata
        this.meetingUrl = url;
        this.startedAt = new Date().toISOString();
        this.platform = this.adapter.name;
        this.meetingCode = this.adapter.extractMeetingCode(url);

        this.log("Platform: " + this.platform + ", Code: " + this.meetingCode);

        // Let the adapter transform the URL if needed (e.g. Zoom /j/ -> /wc/join/)
        const navigateUrl = this.adapter.normalizeUrl(url);
        if (navigateUrl !== url) {
            this.log("Normalized URL: " + navigateUrl);
        }

        await this.page.goto(navigateUrl, { waitUntil: "networkidle2", timeout: 60000 });
        await new Promise(r => setTimeout(r, this.adapter.initialWaitMs));

        // Adapter handles all platform-specific steps
        await this.adapter.dismissPopups();
        await this.adapter.enterName(BOT_NAME);
        await this.adapter.muteMedia();

        await new Promise(r => setTimeout(r, 1000));
        await this.adapter.dismissPopups();

        await this.adapter.clickJoin();

        await new Promise(r => setTimeout(r, 5000));
        await this.adapter.dismissPopups();

        // Check if we landed in a waiting room (Zoom-specific)
        // If so, actively wait for the host to admit us instead of
        // falsely claiming we joined the meeting
        if (typeof this.adapter.waitForAdmission === "function") {
            const admissionResult = await this.adapter.waitForAdmission();

            if (admissionResult === "admitted") {
                this.hasJoinedMeeting = true;
                this.isInMeeting = true;
                this.log("Successfully joined meeting (after waiting room)");
                await this.routeAudio();
                return;
            } else if (admissionResult === "ended") {
                this.log("Meeting ended while in waiting room — never got in");
                this.isInMeeting = false;
                this.hasJoinedMeeting = false;
                await this.cleanup();
                return;
            } else if (admissionResult === "timeout") {
                this.log("Timed out in waiting room — host never admitted us");
                this.isInMeeting = false;
                this.hasJoinedMeeting = false;
                await this.cleanup();
                return;
            }
            // "not_waiting" — fall through to normal verification below
        }

        const inMeeting = await this.adapter.verifyInMeeting();
        if (inMeeting) {
            this.hasJoinedMeeting = true;
            this.isInMeeting = true;
            this.log("Successfully joined meeting");
        } else {
            this.log("Warning: May not have joined meeting properly");
            this.isInMeeting = true;
        }

        await this.routeAudio();
    }

    // ── Monitor ─────────────────────────────────────────────

    async monitorMeeting() {
        this.log("Monitoring meeting...");
        await new Promise(r => setTimeout(r, 10000));

        while (this.isInMeeting) {
            await new Promise(r => setTimeout(r, 5000));

            if (await this.adapter.checkMeetingEnded(this.hasJoinedMeeting)) {
                this.isInMeeting = false;
                this.log("Meeting ended, starting cleanup...");
                await this.cleanup();
                break;
            }
        }
    }

    // ── Cleanup ─────────────────────────────────────────────

    async cleanup() {
        this.log("=== Cleaning up ===");

        await this.stopRecording();

        const endedAt = new Date().toISOString();
        const transcript = await this.transcribe();

        // Close the meeting tab (free memory), but keep at least one tab open for Chrome
        try {
            const allPages = await this.browser.pages();
            if (allPages.length > 1) {
                await this.page.close();
                this.log("Meeting tab closed");
            } else {
                await this.page.goto("about:blank");
                this.log("Meeting tab cleared (only tab, kept open)");
            }
        } catch (e) {}

        // Calculate duration
        let duration = null;
        if (this.startedAt) {
            const durationMs = new Date(endedAt) - new Date(this.startedAt);
            duration = this.formatDuration(durationMs);
        }

        // Generate AI metadata if transcript exists
        let aiMetadata = null;
        const transcriptPath = this.recordingPath ? this.recordingPath.replace(".wav", ".txt") : null;
        if (transcriptPath && fs.existsSync(transcriptPath)) {
            aiMetadata = await this.generateMetadata(transcriptPath);
        }

        // Build enhanced session info
        const sessionInfo = {
            meta: {
                title: aiMetadata?.title || this.meetingName,
                platform: this.platform,
                meetingCode: this.meetingCode,
                startedAt: this.startedAt,
                endedAt: endedAt,
                duration: duration,
                language: aiMetadata?.language || null,
                participants: aiMetadata?.participants || [],
            },
            content: {
                summary: aiMetadata?.summary || null,
                keyPoints: aiMetadata?.keyPoints || [],
                actionItems: aiMetadata?.actionItems || [],
                topics: aiMetadata?.topics || [],
            },
            files: {
                audio: this.recordingPath ? "audio.wav" : null,
                rawTranscript: transcriptPath ? "transcript.txt" : null,
            },
            raw: {
                transcript: transcript,
            },
        };

        const sessionFile = this.recordingPath ?
            this.recordingPath.replace("audio.wav", "session.json") :
            "/tmp/last-meeting-session.json";

        fs.writeFileSync(sessionFile, JSON.stringify(sessionInfo, null, 2));

        this.log("=== Session complete ===");
        this.log("Duration: " + (duration || "unknown"));
        if (aiMetadata?.summary) {
            this.log("Summary: " + aiMetadata.summary);
        }
        if (transcript) {
            this.log("Transcript preview: " + transcript.substring(0, 200) + "...");
        }

        process.exit(0);
    }

    // ── Main ────────────────────────────────────────────────

    async run(url, meetingName) {
        try {
            await this.init();
            await this.setupAudio();
            await this.startRecording(meetingName);
            await this.joinMeeting(url);

            this.log("Bot is in meeting, will auto-cleanup when meeting ends");
            await this.monitorMeeting();

        } catch (err) {
            this.log("Error: " + err.message);
            await this.cleanup();
        }
    }
}

// Main
const url = process.argv[2];
const name = process.argv[3] || "meeting";

if (!url) {
    console.log("Usage: node meeting-bot.js <meeting-url> [meeting-name]");
    console.log("");
    console.log("Supported platforms:");
    console.log("  Google Meet: https://meet.google.com/xxx-yyyy-zzz");
    console.log("  Zoom:        https://zoom.us/j/123456789?pwd=...");
    console.log("");
    console.log("Example: node meeting-bot.js https://meet.google.com/abc-defg-hij standup");
    console.log("Example: node meeting-bot.js https://zoom.us/j/123456789 weekly-sync");
    process.exit(1);
}

const bot = new MeetingBot();

process.on("SIGINT", async () => {
    console.log("\nSIGINT received, cleaning up...");
    bot.isInMeeting = false;
    await bot.cleanup();
});

process.on("SIGTERM", async () => {
    console.log("\nSIGTERM received, cleaning up...");
    bot.isInMeeting = false;
    await bot.cleanup();
});

bot.run(url, name);
