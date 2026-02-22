#!/usr/bin/env node
/**
 * WhatsApp Call Watcher Daemon
 *
 * A persistent background process that:
 *   1. Connects to Chrome (web.whatsapp.com must be open & authenticated)
 *   2. Polls for incoming voice/video calls
 *   3. Checks caller against allow/block list
 *   4. Auto-answers allowed calls
 *   5. Records audio via PulseAudio virtual sink
 *   6. Detects call end → stops recording → transcribes → generates metadata
 *   7. Returns to idle, ready for the next call
 *
 * Lifecycle:
 *   IDLE → RINGING → ANSWERING → IN_CALL → RECORDING → CALL_ENDED → PROCESSING → IDLE
 *
 * Usage:
 *   node whatsapp-watcher.js                    # Start daemon
 *   node whatsapp-watcher.js --status            # Check if running
 *   node whatsapp-watcher.js --setup             # Open WhatsApp Web for QR auth
 */

const puppeteer = require("puppeteer-core");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const WhatsAppPlatform = require("./platforms/whatsapp");
const { loadConfig, getSkillDir } = require("./lib/config");

const SKILL_DIR = getSkillDir();
const globalConfig = loadConfig();
const CONFIG_PATH = path.join(SKILL_DIR, "whatsapp-config.json");
const WHATSAPP_URL = "https://web.whatsapp.com";

// ── State Machine ─────────────────────────────────────────
const STATE = {
    STARTING: "starting",
    WAITING_AUTH: "waiting_auth",
    IDLE: "idle",
    RINGING: "ringing",
    ANSWERING: "answering",
    IN_CALL: "in_call",
    CALL_ENDED: "call_ended",
    PROCESSING: "processing",
    ERROR: "error",
};

class WhatsAppWatcher {
    constructor() {
        this.browser = null;
        this.page = null;
        this.adapter = null;
        this.config = null;
        this.state = STATE.STARTING;
        this.running = false;

        // Current call state
        this.currentCall = null;
        this.recordingPath = null;
        this.callStartedAt = null;
        this.callCount = 0;

        // Stats
        this.startedAt = new Date().toISOString();
        this.lastPollAt = null;
        this.errors = [];
    }

    // ── Logging ──────────────────────────────────────────────

    log(msg) {
        const ts = new Date().toLocaleTimeString();
        const stateTag = "[" + this.state + "]";
        console.log("[" + ts + "] " + stateTag + " " + msg);
    }

    logError(msg, err) {
        this.log("ERROR: " + msg + (err ? " — " + err.message : ""));
        this.errors.push({
            time: new Date().toISOString(),
            message: msg,
            error: err?.message,
        });
        // Keep only last 50 errors
        if (this.errors.length > 50) this.errors.shift();
    }

    // ── Config ───────────────────────────────────────────────

    loadConfig() {
        try {
            const raw = fs.readFileSync(CONFIG_PATH, "utf8");
            this.config = JSON.parse(raw);
            this.log("Config loaded: " + this.config.allowList.length + " allow patterns, " +
                     this.config.blockList.length + " block patterns");
            return true;
        } catch (e) {
            this.logError("Failed to load config from " + CONFIG_PATH, e);
            // Defaults
            this.config = {
                allowList: globalConfig.whatsapp.allowList || ["*"],
                blockList: globalConfig.whatsapp.blockList || [],
                autoAnswer: true,
                autoAnswerDelaySec: globalConfig.whatsapp.autoAnswerDelaySec || 3,
                maxCallDurationMin: globalConfig.whatsapp.maxCallDurationMin || 120,
                recording: { enabled: true, transcribe: true, generateMetadata: true },
                watcher: {
                    pollIntervalMs: 2000,
                    reconnectIntervalMs: 30000,
                    logFile: "/tmp/whatsapp-watcher.log",
                    pidFile: "/tmp/whatsapp-watcher.pid",
                },
                notifications: { onCallAnswered: true, onCallEnded: true, onTranscriptionReady: true },
            };
            return true;
        }
    }

    reloadConfig() {
        this.loadConfig();
    }

    // ── Helpers ──────────────────────────────────────────────

    execAsync(cmd, timeout = 300000) {
        return new Promise((resolve, reject) => {
            exec(cmd, { timeout }, (err, stdout, stderr) => {
                if (err) reject(err);
                else resolve(stdout);
            });
        });
    }

    wait(ms) {
        return new Promise(r => setTimeout(r, ms));
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

    // ── Browser ─────────────────────────────────────────────

    async connectBrowser() {
        this.log("Connecting to Chrome...");

        this.browser = await puppeteer.connect({
            browserURL: "http://localhost:" + globalConfig.chrome.debuggingPort,
            defaultViewport: null,
        });

        const pages = await this.browser.pages();
        this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
        this.adapter = new WhatsAppPlatform(this.page, this.log.bind(this));

        this.log("Connected to Chrome");
    }

    async ensureWhatsAppOpen() {
        try {
            const currentUrl = this.page.url();
            if (currentUrl.includes("web.whatsapp.com")) {
                this.log("WhatsApp Web already open");
                return true;
            }

            this.log("Navigating to WhatsApp Web...");
            await this.page.goto(WHATSAPP_URL, { waitUntil: "networkidle2", timeout: 60000 });
            await this.wait(5000);
            return true;
        } catch (e) {
            this.logError("Failed to open WhatsApp Web", e);
            return false;
        }
    }

    // ── Audio ────────────────────────────────────────────────

    async setupAudio() {
        this.log("Setting up audio capture...");
        try {
            await this.execAsync("bash " + SKILL_DIR + "/scripts/setup/create-virtual-sink.sh");
        } catch (e) {
            // Sink might already exist, that's fine
        }
    }

    async startRecording(callName) {
        this.log("Starting recording for: " + callName);
        try {
            const output = await this.execAsync(
                "bash " + SKILL_DIR + "/scripts/recording/start-recording.sh \"" + callName + "\""
            );
            console.log(output);
            const match = output.match(/Output: (.+\.wav)/);
            if (match) {
                this.recordingPath = match[1];
                this.log("Recording to: " + this.recordingPath);
            }
        } catch (e) {
            this.logError("Recording start error", e);
        }
    }

    async routeAudio() {
        this.log("Routing browser audio to recorder...");
        try {
            await this.execAsync("pactl set-default-sink meeting_recorder");
        } catch (e) {}

        for (let i = 0; i < 30; i++) {
            await this.wait(1000);
            try {
                const result = await this.execAsync(
                    "pactl list short sink-inputs 2>/dev/null | awk '{print \}'"
                );
                const streamIds = result.trim().split("\n").filter(Boolean);
                if (streamIds.length > 0) {
                    for (const id of streamIds) {
                        try {
                            await this.execAsync("pactl move-sink-input " + id + " meeting_recorder");
                        } catch (e) {}
                    }
                    this.log("Audio routed (" + streamIds.length + " streams)");
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
            const output = await this.execAsync(
                "bash " + SKILL_DIR + "/scripts/recording/stop-recording.sh"
            );
            console.log(output);
        } catch (e) {
            this.logError("Stop recording error", e);
        }
    }

    // ── Transcription ───────────────────────────────────────

    async transcribe() {
        if (!this.recordingPath) {
            this.log("No recording path, skipping transcription");
            return null;
        }

        this.log("Transcribing...");
        try {
            const output = await this.execAsync(
                "bash " + SKILL_DIR + "/scripts/transcription/transcribe.sh \"" + this.recordingPath + "\""
            );
            console.log(output);
            this.log("Transcription complete");

            const txtPath = this.recordingPath.replace(".wav", ".txt");
            if (fs.existsSync(txtPath)) {
                return fs.readFileSync(txtPath, "utf8");
            }
        } catch (e) {
            this.logError("Transcription error", e);
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
            this.logError("Metadata generation error", e);
            return null;
        }
    }

    // ── Call Lifecycle ───────────────────────────────────────

    async handleIncomingCall(callInfo) {
        const caller = callInfo.caller || "Unknown";
        const callType = callInfo.isVideo ? "video" : "voice";
        this.log("Incoming " + callType + " call from: " + caller);

        this.currentCall = {
            caller: caller,
            isVideo: callInfo.isVideo,
            detectedAt: new Date().toISOString(),
            answered: false,
            declined: false,
        };

        // ── Check allow/block list ──
        if (!this.adapter.isCallerAllowed(caller, this.config.allowList, this.config.blockList)) {
            this.log("Caller '" + caller + "' NOT on allow list — declining");
            await this.adapter.declineCall();
            this.currentCall.declined = true;
            this.currentCall = null;
            this.state = STATE.IDLE;
            return;
        }

        this.log("Caller '" + caller + "' allowed");

        // ── Auto-answer delay ──
        if (this.config.autoAnswerDelaySec > 0) {
            this.log("Waiting " + this.config.autoAnswerDelaySec + "s before answering...");
            await this.wait(this.config.autoAnswerDelaySec * 1000);

            // Re-check if call is still ringing (might have been cancelled)
            const stillRinging = await this.adapter.detectIncomingCall();
            if (!stillRinging.detected) {
                this.log("Call was cancelled before we answered");
                this.currentCall = null;
                this.state = STATE.IDLE;
                return;
            }
        }

        // ── Answer ──
        this.state = STATE.ANSWERING;
        const answered = await this.adapter.answerCall();
        if (!answered) {
            this.logError("Failed to answer call from " + caller);
            this.currentCall = null;
            this.state = STATE.IDLE;
            return;
        }

        this.currentCall.answered = true;
        this.currentCall.answeredAt = new Date().toISOString();
        this.callStartedAt = new Date();
        this.callCount++;

        this.log("Call answered (#" + this.callCount + ")");

        // ── Mute our mic ──
        await this.wait(2000);
        await this.adapter.muteMedia();

        // ── Start recording ──
        this.state = STATE.IN_CALL;
        if (this.config.recording.enabled) {
            const callName = "whatsapp-" + caller.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 30) +
                             "-" + new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
            await this.setupAudio();
            await this.startRecording(callName);
            await this.routeAudio();
        }

        // ── Monitor call until it ends ──
        await this.monitorCall();
    }

    async monitorCall() {
        this.log("Monitoring call...");
        await this.wait(5000); // Give 5s before first end-check

        const maxDurationMs = this.config.maxCallDurationMin * 60 * 1000;
        let hasConfirmedInCall = false;

        while (this.state === STATE.IN_CALL && this.running) {
            await this.wait(this.config.watcher.pollIntervalMs);

            // ── Verify we're still in call ──
            const inCall = await this.adapter.verifyInMeeting();
            if (inCall) hasConfirmedInCall = true;

            // ── Check if call ended ──
            const ended = await this.adapter.checkCallEnded(hasConfirmedInCall);
            if (ended) {
                this.state = STATE.CALL_ENDED;
                this.log("Call ended");
                break;
            }

            // ── Max duration safeguard ──
            if (this.callStartedAt) {
                const elapsed = Date.now() - this.callStartedAt.getTime();
                if (elapsed > maxDurationMs) {
                    this.log("Max call duration reached (" + this.config.maxCallDurationMin + " min), ending call");
                    await this.adapter.endCall();
                    this.state = STATE.CALL_ENDED;
                    break;
                }
            }
        }

        // ── Post-call processing ──
        await this.processCallEnd();
    }

    async processCallEnd() {
        this.state = STATE.PROCESSING;
        const endedAt = new Date().toISOString();
        const caller = this.currentCall?.caller || "Unknown";

        this.log("Processing call end for: " + caller);

        // Stop recording
        if (this.config.recording.enabled) {
            await this.stopRecording();
        }

        // Calculate duration
        let duration = null;
        if (this.callStartedAt) {
            const durationMs = new Date(endedAt) - this.callStartedAt;
            duration = this.formatDuration(durationMs);
            this.log("Call duration: " + duration);
        }

        // Transcribe
        let transcript = null;
        if (this.config.recording.enabled && this.config.recording.transcribe) {
            transcript = await this.transcribe();
        }

        // Generate AI metadata
        let aiMetadata = null;
        const transcriptPath = this.recordingPath ? this.recordingPath.replace(".wav", ".txt") : null;
        if (this.config.recording.generateMetadata && transcriptPath && fs.existsSync(transcriptPath)) {
            aiMetadata = await this.generateMetadata(transcriptPath);
        }

        // Build session info
        const sessionInfo = {
            meta: {
                title: aiMetadata?.title || "WhatsApp Call — " + caller,
                platform: "whatsapp",
                type: this.currentCall?.isVideo ? "video_call" : "voice_call",
                caller: caller,
                startedAt: this.currentCall?.answeredAt || this.callStartedAt?.toISOString(),
                endedAt: endedAt,
                duration: duration,
                language: aiMetadata?.language || null,
                participants: aiMetadata?.participants || [caller],
                callNumber: this.callCount,
            },
            content: {
                summary: aiMetadata?.summary || null,
                keyPoints: aiMetadata?.keyPoints || [],
                actionItems: aiMetadata?.actionItems || [],
                topics: aiMetadata?.topics || [],
            },
            files: {
                audio: this.recordingPath ? "audio.wav" : null,
                rawTranscript: transcriptPath ? path.basename(transcriptPath) : null,
            },
            raw: {
                transcript: transcript,
            },
        };

        // Save session file
        const sessionFile = this.recordingPath
            ? this.recordingPath.replace("audio.wav", "session.json")
            : "/tmp/last-whatsapp-call-session.json";

        fs.writeFileSync(sessionFile, JSON.stringify(sessionInfo, null, 2));
        this.log("Session saved: " + sessionFile);

        if (aiMetadata?.summary) {
            this.log("Summary: " + aiMetadata.summary);
        }
        if (transcript) {
            this.log("Transcript preview: " + transcript.substring(0, 200) + "...");
        }

        // ── Reset for next call ──
        this.currentCall = null;
        this.recordingPath = null;
        this.callStartedAt = null;
        this.state = STATE.IDLE;

        this.log("Ready for next call (total calls handled: " + this.callCount + ")");
    }

    // ── Main Loop ────────────────────────────────────────────

    async run() {
        this.log("=== WhatsApp Call Watcher Starting ===");
        this.running = true;

        // Load config
        this.loadConfig();

        // Write PID file
        fs.writeFileSync(this.config.watcher.pidFile, String(process.pid));
        this.log("PID: " + process.pid + " (written to " + this.config.watcher.pidFile + ")");

        // Connect to browser
        try {
            await this.connectBrowser();
        } catch (e) {
            this.logError("Cannot connect to Chrome. Is it running with --remote-debugging-port?" , e);
            process.exit(1);
        }

        // Ensure WhatsApp Web is open
        if (!(await this.ensureWhatsAppOpen())) {
            this.logError("Cannot open WhatsApp Web");
            process.exit(1);
        }

        // Wait for authentication
        this.state = STATE.WAITING_AUTH;
        const authed = await this.adapter.waitForAuth(180000); // 3 minute timeout
        if (!authed) {
            this.log("WhatsApp Web not authenticated. Please scan QR code and restart.");
            this.log("Run: node whatsapp-watcher.js --setup");
            process.exit(1);
        }

        // Dismiss any initial popups
        await this.adapter.dismissPopups();

        // Setup audio infrastructure
        await this.setupAudio();

        // Enter main polling loop
        this.state = STATE.IDLE;
        this.log("=== Watcher active — listening for incoming calls ===");
        this.log("Allow list: " + JSON.stringify(this.config.allowList));

        while (this.running) {
            try {
                this.lastPollAt = new Date().toISOString();

                // Only poll when idle
                if (this.state !== STATE.IDLE) {
                    await this.wait(1000);
                    continue;
                }

                // Poll for incoming call
                const callInfo = await this.adapter.detectIncomingCall();

                if (callInfo.detected) {
                    this.state = STATE.RINGING;
                    await this.handleIncomingCall(callInfo);
                    // After handleIncomingCall completes, we're back to IDLE
                    continue;
                }

                // Check if WhatsApp Web is still alive
                try {
                    const authState = await this.adapter.checkAuthState();
                    if (authState === "qr_code") {
                        this.logError("WhatsApp Web logged out! QR code showing.");
                        this.state = STATE.ERROR;
                        // Wait and retry
                        await this.wait(this.config.watcher.reconnectIntervalMs);
                        const reauthed = await this.adapter.waitForAuth(60000);
                        if (reauthed) {
                            this.state = STATE.IDLE;
                            this.log("Re-authenticated, resuming...");
                        }
                        continue;
                    }
                } catch (e) {
                    // Page might be navigated during call, ignore
                }

                await this.wait(this.config.watcher.pollIntervalMs);

            } catch (e) {
                this.logError("Poll loop error", e);
                await this.wait(5000);

                // Try to recover
                try {
                    await this.connectBrowser();
                    await this.ensureWhatsAppOpen();
                    this.state = STATE.IDLE;
                } catch (reconnectErr) {
                    this.logError("Reconnect failed", reconnectErr);
                    await this.wait(this.config.watcher.reconnectIntervalMs);
                }
            }
        }

        this.log("Watcher stopped");
        this.cleanupPid();
    }

    // ── Setup Mode (QR Auth) ─────────────────────────────────

    async runSetup() {
        this.log("=== WhatsApp Web Setup ===");

        try {
            await this.connectBrowser();
        } catch (e) {
            this.logError("Cannot connect to Chrome", e);
            console.log("");
            console.log("Make sure Chrome is running:");
            console.log("  " + SKILL_DIR + "/scripts/setup/start-chrome.sh");
            process.exit(1);
        }

        this.log("Opening WhatsApp Web...");
        await this.page.goto(WHATSAPP_URL, { waitUntil: "networkidle2", timeout: 60000 });
        await this.wait(5000);

        this.adapter = new WhatsAppPlatform(this.page, this.log.bind(this));
        const state = await this.adapter.checkAuthState();

        if (state === "logged_in") {
            this.log("Already authenticated! No QR scan needed.");
            this.log("You can start the watcher now:");
            this.log("  " + SKILL_DIR + "/start-whatsapp-watcher");
            process.exit(0);
        }

        if (state === "qr_code") {
            await this.adapter._screenshot("whatsapp-qr-code");
            this.log("QR code is showing. Please scan it with your WhatsApp mobile app:");
            this.log("  1. Open WhatsApp on your phone");
            this.log("  2. Tap ⋮ (or Settings) > Linked Devices");
            this.log("  3. Tap 'Link a Device'");
            this.log("  4. Scan the QR code on screen");
            this.log("");
            this.log("Screenshot saved: /tmp/meeting-debug-whatsapp-qr-code.png");
            this.log("Waiting for authentication...");

            const authed = await this.adapter.waitForAuth(300000); // 5 minutes
            if (authed) {
                this.log("Authenticated successfully!");
                this.log("You can start the watcher now:");
                this.log("  " + SKILL_DIR + "/start-whatsapp-watcher");
            } else {
                this.log("Authentication timed out. Try again.");
            }
        } else {
            this.log("Unexpected state: " + state);
            await this.adapter._screenshot("whatsapp-setup-unknown");
        }

        process.exit(0);
    }

    // ── Status Check ─────────────────────────────────────────

    printStatus() {
        const pidFile = "/tmp/whatsapp-watcher.pid";
        if (!fs.existsSync(pidFile)) {
            console.log("WhatsApp Watcher: NOT RUNNING");
            return;
        }

        const pid = fs.readFileSync(pidFile, "utf8").trim();
        try {
            // Check if process is alive
            process.kill(Number(pid), 0);
            console.log("WhatsApp Watcher: RUNNING (PID " + pid + ")");
            console.log("Log: /tmp/whatsapp-watcher.log");
        } catch (e) {
            console.log("WhatsApp Watcher: STALE (PID " + pid + " not running)");
            fs.unlinkSync(pidFile);
        }
    }

    // ── Cleanup ──────────────────────────────────────────────

    cleanupPid() {
        try {
            const pidFile = this.config?.watcher?.pidFile || "/tmp/whatsapp-watcher.pid";
            if (fs.existsSync(pidFile)) {
                fs.unlinkSync(pidFile);
            }
        } catch (e) {}
    }

    async shutdown() {
        this.log("Shutting down...");
        this.running = false;

        // If in a call, end it gracefully
        if (this.state === STATE.IN_CALL && this.currentCall) {
            this.log("Ending active call before shutdown...");
            await this.adapter.endCall();
            await this.processCallEnd();
        }

        this.cleanupPid();
        process.exit(0);
    }
}

// ── CLI Entry Point ─────────────────────────────────────────

const args = process.argv.slice(2);
const watcher = new WhatsAppWatcher();

// Signal handlers
process.on("SIGINT", async () => {
    console.log("\nSIGINT received");
    await watcher.shutdown();
});

process.on("SIGTERM", async () => {
    console.log("\nSIGTERM received");
    await watcher.shutdown();
});

if (args.includes("--status")) {
    watcher.printStatus();
    process.exit(0);
} else if (args.includes("--setup")) {
    watcher.runSetup();
} else {
    watcher.run();
}
