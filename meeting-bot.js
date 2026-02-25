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
        this.leftDueToEmptyTimeout = false;
        this.emptyMeetingSince = null;
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

    // ── Audio (WebRTC + Tab Capture) ────────────────────────

    // ── Audio (CDP Tab Audio Capture) ───────────────────────

    async setupAudio() {
        this.log("Setting up PulseAudio capture...");
        this.cdpSession = await this.page.createCDPSession();

        // Create PulseAudio null-sink and set as default BEFORE joining
        // Chrome will output meeting audio here; we record from the monitor source
        try {
            await this.execAsync("pactl list short sinks | grep -q meeting_recorder || pactl load-module module-null-sink sink_name=meeting_recorder sink_properties=device.description=Meeting_Recorder 2>/dev/null");
            await this.execAsync("pactl set-default-sink meeting_recorder");
            this.log("PulseAudio null-sink ready (set as default)");
        } catch (e) {
            this.log("PulseAudio setup note: " + e.message);
        }
    }

    async startRecording(meetingName) {
        this.meetingName = meetingName;
        this.log("Starting recording for: " + meetingName);

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");
        const hours = String(now.getHours()).padStart(2, "0");
        const mins = String(now.getMinutes()).padStart(2, "0");
        const secs = String(now.getSeconds()).padStart(2, "0");
        const safeName = (meetingName || "meeting").replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "");
        const outputDir = (process.env.HOME || "/root") + "/meeting-transcripts/" + year + "/" + month + "/" + year + "-" + month + "-" + day + "_" + hours + mins + secs + "_" + safeName;

        try {
            await this.execAsync("mkdir -p " + JSON.stringify(outputDir));
        } catch (e) {
            this.log("Failed to create output dir: " + e.message);
        }

        this.recordingPath = outputDir + "/audio.wav";
        this.recordingDir = outputDir;
        this.log("Output dir: " + outputDir);

        try {
            fs.writeFileSync(outputDir + "/metadata.json", JSON.stringify({
                meeting_name: meetingName,
                started_at: now.toISOString(),
                audio_file: "audio.wav",
                capture_method: "pulseaudio"
            }, null, 2));
        } catch (e) {}
    }

    async routeAudio() {
        this.log("Starting PulseAudio recording...");

        // Start ffmpeg recording from the PulseAudio monitor source
        // The null-sink was set as default in setupAudio(), so Chrome's audio goes there
        const wavPath = this.recordingDir + "/audio.wav";
        try {
            await this.execAsync(
                "nohup ffmpeg -y -f pulse -i meeting_recorder.monitor -ac 1 -ar 16000 -acodec pcm_s16le " +
                JSON.stringify(wavPath) +
                " -loglevel warning </dev/null >/tmp/ffmpeg-meeting.log 2>&1 &"
            );
            this.recordingPath = wavPath;
            this.log("Recording to: " + wavPath);
        } catch (e) {
            this.log("ffmpeg start error: " + e.message);
        }

        // Route Chrome's audio sink-inputs to our null-sink
        // Check periodically since Chrome may create new sink-inputs
        this._pulseRoutingInterval = setInterval(async () => {
            try {
                const result = await this.execAsync("pactl list short sink-inputs 2>/dev/null | awk '{print $1}'");
                const ids = result.trim().split("\n").filter(Boolean);
                for (const id of ids) {
                    await this.execAsync("pactl move-sink-input " + id + " meeting_recorder 2>/dev/null");
                }
                if (ids.length > 0 && !this._pulseRouted) {
                    this._pulseRouted = true;
                    this.log("PulseAudio: routed " + ids.length + " Chrome stream(s)");
                }
            } catch (e) {}
        }, 3000);

        // Wait a bit and verify we're getting data
        await new Promise(r => setTimeout(r, 10000));
        try {
            const size = fs.existsSync(wavPath) ? fs.statSync(wavPath).size : 0;
            const durSec = Math.max(0, size - 44) / (16000 * 2);
            this.log("Audio check after 10s: " + (size / 1024).toFixed(0) + "KB (~" + durSec.toFixed(0) + "s)");
            if (size < 1000) {
                this.log("Warning: No audio data yet. Chrome may not be outputting audio.");
                // Try to find and route any sink-inputs we might have missed
                try {
                    const result = await this.execAsync("pactl list short sink-inputs 2>/dev/null");
                    this.log("Current sink-inputs: " + (result.trim() || "none"));
                } catch (e) {}
            }
        } catch (e) {}

        return true;
    }

    async stopRecording() {
        this.log("Stopping recording...");

        if (this._pulseRoutingInterval) clearInterval(this._pulseRoutingInterval);

        // Stop ffmpeg recording
        try {
            await this.execAsync("pkill -f 'ffmpeg.*pulse.*meeting_recorder' 2>/dev/null");
            await new Promise(r => setTimeout(r, 1500));
        } catch (e) {}

        // Check recording result
        if (this.recordingPath && fs.existsSync(this.recordingPath)) {
            const size = fs.statSync(this.recordingPath).size;
            const durSec = Math.max(0, size - 44) / (16000 * 2);
            this.log("Recording: " + (size / 1024).toFixed(0) + "KB (~" + durSec.toFixed(0) + "s)");
            if (size < 1000) {
                this.log("Warning: Recording is too small, likely no audio captured");
                this.recordingPath = null;
            }
        } else {
            this.log("Warning: No recording file found");
            this.recordingPath = null;
        }
    }



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

            const txtPath = this.recordingPath.replace(/\.(wav|webm)$/, ".txt");
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
        
        // Skip name entry if using Google account (name comes from account)
        if (config.googleAccount?.enabled) {
            this.log("Using Google account profile (skipping manual name entry)");
        } else {
            await this.adapter.enterName(BOT_NAME);
        }
        
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
        
        const emptyTimeoutMinutes = config.meeting?.emptyTimeoutMinutes || 15;
        const emptyTimeoutMs = emptyTimeoutMinutes * 60 * 1000;
        
        while (this.isInMeeting) {
            await new Promise(r => setTimeout(r, 5000));

            // Check if meeting ended normally
            if (await this.adapter.checkMeetingEnded(this.hasJoinedMeeting)) {
                this.isInMeeting = false;
                this.log("Meeting ended, starting cleanup...");
                await this.cleanup();
                break;
            }
            
            // Check for empty meeting timeout
            try {
                const participantCount = await this.adapter.getParticipantCount();
                
                if (participantCount === 0) {
                    // Meeting is empty (only bot)
                    if (!this.emptyMeetingSince) {
                        this.emptyMeetingSince = Date.now();
                        this.log("Meeting appears empty, starting timeout timer...");
                    } else {
                        const emptyDuration = Date.now() - this.emptyMeetingSince;
                        const remainingMin = Math.ceil((emptyTimeoutMs - emptyDuration) / 60000);
                        
                        if (emptyDuration >= emptyTimeoutMs) {
                            this.log(`Meeting empty for ${emptyTimeoutMinutes} minutes, leaving...`);
                            this.isInMeeting = false;
                            this.leftDueToEmptyTimeout = true;
                            await this.cleanup();
                            break;
                        } else if (emptyDuration > 60000 && emptyDuration % 60000 < 5000) {
                            // Log every minute
                            this.log(`Meeting still empty, ${remainingMin} min until auto-leave`);
                        }
                    }
                } else if (participantCount > 0) {
                    // Someone is in the meeting, reset timer
                    if (this.emptyMeetingSince) {
                        this.log(`Participant detected (${participantCount} others), canceling empty timeout`);
                        this.emptyMeetingSince = null;
                    }
                }
                // participantCount === -1 means unknown, do nothing
            } catch (e) {
                // Ignore errors in participant count check
            }
        }
    }

    // ── Cleanup ─────────────────────────────────────────────

    async cleanup() {
        this.log("=== Cleaning up ===");

        await this.stopRecording();

        const endedAt = new Date().toISOString();
        
        // Skip transcription if we left due to empty meeting timeout
        let transcript = null;
        const skipTranscription = this.leftDueToEmptyTimeout && 
            (config.meeting?.skipTranscriptionOnEmptyLeave !== false);
        
        if (skipTranscription) {
            this.log("Skipping transcription (left due to empty meeting timeout)");
            // Delete the recording file to save space
            if (this.recordingPath && fs.existsSync(this.recordingPath)) {
                try {
                    fs.unlinkSync(this.recordingPath);
                    this.log("Deleted unused recording file");
                } catch (e) {}
            }
        } else {
            transcript = await this.transcribe();
        }

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
        const transcriptPath = this.recordingPath ? this.recordingPath.replace(/\.(wav|webm)$/, ".txt") : null;
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
            this.recordingPath.replace(/audio\.(wav|webm)$/, "session.json") :
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
