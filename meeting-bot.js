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

    async setupAudio() {
        this.log("Setting up audio capture via WebRTC interception...");
        this.cdpSession = await this.page.createCDPSession();
        this._audioChunksBuffer = [];
        
        // Inject WebRTC audio capture BEFORE navigating to the meeting page
        // This hooks into RTCPeerConnection to capture incoming audio streams
        await this.page.evaluateOnNewDocument(() => {
            window.__capturedStreams = [];
            window.__audioChunks = [];
            window.__audioCaptureReady = false;

            // Hook RTCPeerConnection to capture remote audio tracks
            const OrigRTC = window.RTCPeerConnection;
            window.RTCPeerConnection = function(...args) {
                const pc = new OrigRTC(...args);
                
                pc.addEventListener("track", (event) => {
                    if (event.track.kind === "audio") {
                        console.log("[AudioCapture] Captured remote audio track");
                        window.__capturedStreams.push(event.streams[0] || new MediaStream([event.track]));
                        window.__tryStartRecording();
                    }
                });
                
                return pc;
            };
            window.RTCPeerConnection.prototype = OrigRTC.prototype;
            // Copy static properties
            Object.getOwnPropertyNames(OrigRTC).forEach(prop => {
                if (prop !== 'prototype' && prop !== 'length' && prop !== 'name') {
                    try { window.RTCPeerConnection[prop] = OrigRTC[prop]; } catch(e) {}
                }
            });

            window.__tryStartRecording = function() {
                if (window.__audioCaptureReady) return;
                if (window.__capturedStreams.length === 0) return;

                try {
                    const audioCtx = new AudioContext({ sampleRate: 16000 });
                    const dest = audioCtx.createMediaStreamDestination();

                    // Connect all captured streams
                    for (const stream of window.__capturedStreams) {
                        try {
                            const source = audioCtx.createMediaStreamSource(stream);
                            source.connect(dest);
                            console.log("[AudioCapture] Connected stream to recorder");
                        } catch (e) {
                            console.log("[AudioCapture] Stream connect error:", e.message);
                        }
                    }

                    const recorder = new MediaRecorder(dest.stream, {
                        mimeType: "audio/webm;codecs=opus",
                        audioBitsPerSecond: 64000
                    });

                    recorder.ondataavailable = (e) => {
                        if (e.data.size > 0) {
                            const reader = new FileReader();
                            reader.onloadend = () => {
                                const base64 = reader.result.split(",")[1];
                                if (base64) window.__audioChunks.push(base64);
                            };
                            reader.readAsDataURL(e.data);
                        }
                    };

                    recorder.start(3000); // 3 second chunks
                    window.__audioRecorder = recorder;
                    window.__audioContext = audioCtx;
                    window.__audioCaptureReady = true;
                    console.log("[AudioCapture] MediaRecorder started");
                } catch (e) {
                    console.error("[AudioCapture] Recorder start failed:", e);
                }
            };

            // Also watch for new streams added later
            const origAddTrack = MediaStream.prototype.addTrack;
            MediaStream.prototype.addTrack = function(track) {
                if (track.kind === "audio" && !window.__capturedStreams.includes(this)) {
                    console.log("[AudioCapture] New audio track added to stream");
                    window.__capturedStreams.push(new MediaStream([track]));
                    if (window.__audioCaptureReady && window.__audioContext) {
                        try {
                            const source = window.__audioContext.createMediaStreamSource(new MediaStream([track]));
                            source.connect(window.__audioContext.createMediaStreamDestination());
                        } catch(e) {}
                    }
                }
                return origAddTrack.apply(this, arguments);
            };
        });
    }

    async startRecording(meetingName) {
        this.meetingName = meetingName;
        this.log("Starting recording for: " + meetingName);

        // Create output directory
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

        this.recordingPath = outputDir + "/audio.webm";
        this.recordingDir = outputDir;
        this.log("Recording to: " + this.recordingPath);

        // Save metadata
        try {
            fs.writeFileSync(outputDir + "/metadata.json", JSON.stringify({
                meeting_name: meetingName,
                started_at: now.toISOString(),
                audio_file: "audio.webm",
                capture_method: "webrtc_intercept"
            }, null, 2));
        } catch (e) {}
    }

    async routeAudio() {
        this.log("Waiting for WebRTC audio streams...");

        // Wait for capture to start (streams arrive after joining)
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const ready = await this.page.evaluate(() => window.__audioCaptureReady);
                if (ready) {
                    const streamCount = await this.page.evaluate(() => window.__capturedStreams.length);
                    this.log("Audio capture active (" + streamCount + " stream(s))");
                    // Start periodic flush of audio chunks to disk
                    this._audioSaveInterval = setInterval(() => this._flushAudioChunks(), 10000);
                    return true;
                }
            } catch (e) {}
        }

        this.log("Warning: No WebRTC audio streams captured after 30s");
        // Start flush interval anyway in case streams arrive later
        this._audioSaveInterval = setInterval(() => this._flushAudioChunks(), 10000);
        return false;
    }

    async _flushAudioChunks() {
        try {
            const chunks = await this.page.evaluate(() => {
                const c = window.__audioChunks || [];
                window.__audioChunks = [];
                return c;
            });
            if (chunks.length > 0 && this.recordingPath) {
                for (const base64 of chunks) {
                    const buf = Buffer.from(base64, "base64");
                    fs.appendFileSync(this.recordingPath, buf);
                }
            }
        } catch (e) {
            // Page might be navigated away, save what we have
        }
    }

    async stopRecording() {
        this.log("Stopping recording...");

        if (this._audioSaveInterval) {
            clearInterval(this._audioSaveInterval);
        }

        // Stop in-page recorder and get final chunks
        try {
            const finalChunks = await this.page.evaluate(() => {
                return new Promise((resolve) => {
                    if (!window.__audioRecorder || window.__audioRecorder.state === "inactive") {
                        resolve(window.__audioChunks || []);
                        return;
                    }
                    window.__audioRecorder.onstop = () => {
                        resolve(window.__audioChunks || []);
                    };
                    window.__audioRecorder.stop();
                });
            });

            if (finalChunks.length > 0 && this.recordingPath) {
                for (const base64 of finalChunks) {
                    const buf = Buffer.from(base64, "base64");
                    fs.appendFileSync(this.recordingPath, buf);
                }
            }
            this.log("Audio capture stopped");
        } catch (e) {
            this.log("Stop capture error (page may have closed): " + e.message);
        }

        // Check webm recording file
        if (this.recordingPath && this.recordingPath.endsWith(".webm")) {
            try {
                if (fs.existsSync(this.recordingPath)) {
                    const stat = fs.statSync(this.recordingPath);
                    if (stat.size > 0) {
                        this.log("Recording saved: " + (stat.size / 1024).toFixed(0) + "KB webm");
                    } else {
                        this.log("Warning: webm recording is empty (0 bytes)");
                        this.recordingPath = null;
                    }
                } else {
                    this.log("Warning: Recording file not found");
                    this.recordingPath = null;
                }
            } catch (e) {
                this.log("Recording check error: " + e.message);
            }
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
