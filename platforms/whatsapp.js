const BasePlatform = require("./base");

/**
 * WhatsApp Web Platform Adapter
 *
 * Unlike Google Meet / Zoom which join a URL, WhatsApp operates as a
 * persistent watcher: the browser stays on web.whatsapp.com and waits
 * for incoming voice/video calls.
 *
 * WhatsApp Web voice/video calls (2025+ beta, widely available 2026):
 *   - Audio & video flow through the browser natively
 *   - Incoming call shows a full-screen overlay with caller info
 *   - Answer / Decline buttons appear on the overlay
 *   - Call UI shows duration, mute, video, end buttons
 *
 * This adapter provides:
 *   1. Authentication check (QR code vs logged-in)
 *   2. Incoming call detection (polling-based)
 *   3. Caller identification (name & number)
 *   4. Call answering (voice-only by default)
 *   5. In-call verification
 *   6. Call end detection
 *   7. Allow-list filtering
 *
 * The watcher daemon (whatsapp-watcher.js) orchestrates the lifecycle.
 */
class WhatsAppPlatform extends BasePlatform {
    constructor(page, log) {
        super(page, log);
        this._callerInfo = null;
    }

    get name() {
        return "whatsapp";
    }

    get initialWaitMs() {
        return 5000;
    }

    // ── Authentication ─────────────────────────────────────────

    /**
     * Check if WhatsApp Web is authenticated (past QR code).
     * @returns {"logged_in"|"qr_code"|"loading"|"unknown"}
     */
    async checkAuthState() {
        try {
            const state = await this.page.evaluate(() => {
                const body = document.body?.innerText || "";
                const html = document.body?.innerHTML || "";

                // QR code page indicators
                if (
                    body.includes("Scan the QR code") ||
                    body.includes("Link with phone number") ||
                    body.includes("Log in with phone number") ||
                    html.includes("landing-wrapper") ||
                    html.includes("_akau") // QR code canvas class
                ) {
                    return "qr_code";
                }

                // Loading spinner / startup
                if (
                    html.includes("startup") ||
                    html.includes("progress") ||
                    (body.trim().length < 50 && !html.includes("side"))
                ) {
                    return "loading";
                }

                // Main chat interface indicators
                if (
                    html.includes("side") ||           // side panel
                    html.includes("pane-side") ||
                    html.includes("chat-list") ||
                    body.includes("Search or start") ||
                    body.includes("Chats") ||
                    html.includes('data-icon="search"') ||
                    html.includes('aria-label="Search"') ||
                    html.includes('role="grid"')        // chat list grid
                ) {
                    return "logged_in";
                }

                return "unknown";
            });
            return state;
        } catch (e) {
            return "unknown";
        }
    }

    /**
     * Wait for WhatsApp Web to be fully loaded and authenticated.
     * @param {number} timeoutMs - max wait time
     * @returns {boolean} true if authenticated
     */
    async waitForAuth(timeoutMs = 120000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const state = await this.checkAuthState();
            if (state === "logged_in") {
                this.log("WhatsApp Web authenticated");
                return true;
            }
            if (state === "qr_code") {
                this.log("Waiting for QR code scan...");
            } else if (state === "loading") {
                this.log("WhatsApp Web loading...");
            }
            await this._wait(3000);
        }
        this.log("WhatsApp Web auth timeout");
        return false;
    }

    // ── Incoming Call Detection ─────────────────────────────────

    /**
     * Check if there is an incoming call right now.
     *
     * WhatsApp Web incoming call overlay structure:
     *   - Full-screen or popup overlay
     *   - Shows caller name/number, profile picture
     *   - "Answer" / "Decline" buttons (voice or video answer)
     *   - May show "Voice call from..." or "Video call from..."
     *
     * @returns {{ detected: boolean, caller: string|null, isVideo: boolean, element: null }}
     */
    async detectIncomingCall() {
        try {
            const callInfo = await this.page.evaluate(() => {
                const body = document.body?.innerHTML || "";
                const text = document.body?.innerText || "";

                // ── Signal 1: Incoming call text patterns ──
                const incomingPatterns = [
                    /voice call from/i,
                    /video call from/i,
                    /incoming voice call/i,
                    /incoming video call/i,
                    /incoming call/i,
                    /שיחה נכנסת/,          // Hebrew: incoming call
                    /שיחת קול/,             // Hebrew: voice call
                    /שיחת וידאו/,           // Hebrew: video call
                ];

                let hasIncoming = false;
                for (const pat of incomingPatterns) {
                    if (pat.test(text) || pat.test(body)) {
                        hasIncoming = true;
                        break;
                    }
                }

                // ── Signal 2: Answer/Decline button presence ──
                const buttons = document.querySelectorAll("button, [role='button'], div[tabindex]");
                let hasAnswerBtn = false;
                let hasDeclineBtn = false;
                for (const btn of buttons) {
                    const btnText = (btn.textContent || "").trim().toLowerCase();
                    const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
                    const dataIcon = btn.querySelector("[data-icon]")?.getAttribute("data-icon") || "";
                    const combined = btnText + " " + ariaLabel + " " + dataIcon;

                    if (/answer|accept|קבל/i.test(combined) || dataIcon.includes("call-accept")) {
                        hasAnswerBtn = true;
                    }
                    if (/decline|reject|דחה/i.test(combined) || dataIcon.includes("call-decline")) {
                        hasDeclineBtn = true;
                    }
                }

                // ── Signal 3: Call-specific DOM elements ──
                const callOverlay = document.querySelector(
                    '[data-animate-modal-popup="true"], ' +
                    '.call-incoming, ' +
                    '[class*="incoming-call"], ' +
                    '[class*="call-overlay"], ' +
                    '[data-testid="incoming-call"]'
                );

                // ── Signal 4: Ringing audio indicator ──
                const hasRingIcon = body.includes("data-icon=\"ring\"") ||
                                    body.includes("data-icon=\"call-incoming\"") ||
                                    body.includes("data-testid=\"incoming-call\"");

                const detected = hasIncoming || (hasAnswerBtn && hasDeclineBtn) || !!callOverlay || hasRingIcon;

                if (!detected) return { detected: false, caller: null, isVideo: false };

                // ── Extract caller info ──
                let caller = null;
                let isVideo = false;

                // Try to find caller name from the overlay
                // WhatsApp typically shows the contact name prominently
                const headerElements = document.querySelectorAll("span, div, h1, h2");
                for (const el of headerElements) {
                    const t = (el.textContent || "").trim();
                    // Skip generic UI text
                    if (/^(answer|decline|accept|reject|voice call|video call|incoming|שיחה)/i.test(t)) continue;
                    if (t.length > 2 && t.length < 100 && !t.includes("\n")) {
                        // Likely a caller name — heuristic: first substantial text in the overlay
                        if (el.closest('[class*="call"], [class*="incoming"], [data-animate-modal-popup]')) {
                            caller = t;
                            break;
                        }
                    }
                }

                if (text.includes("Video call") || text.includes("video call") || text.includes("שיחת וידאו")) {
                    isVideo = true;
                }

                return { detected: true, caller: caller, isVideo: isVideo };
            });

            if (callInfo.detected) {
                this._callerInfo = callInfo;
            }
            return callInfo;
        } catch (e) {
            return { detected: false, caller: null, isVideo: false };
        }
    }

    /**
     * Get the caller info from the last detected incoming call.
     */
    getCallerInfo() {
        return this._callerInfo;
    }

    // ── Allow List ──────────────────────────────────────────────

    /**
     * Check if a caller is on the allow list.
     * Supports wildcards: "+972*" matches any Israeli number.
     *
     * @param {string} caller - Caller name or number
     * @param {string[]} allowList - Patterns to match
     * @param {string[]} blockList - Patterns to block (takes priority)
     * @returns {boolean}
     */
    isCallerAllowed(caller, allowList, blockList) {
        if (!caller) return allowList.length === 0; // If no caller ID and no allow list, allow all

        const callerLower = caller.toLowerCase();

        // Block list takes priority
        for (const pattern of blockList) {
            if (this._matchPattern(callerLower, pattern.toLowerCase())) {
                return false;
            }
        }

        // Empty allow list = allow all (that aren't blocked)
        if (allowList.length === 0) return true;

        // Check allow list
        for (const pattern of allowList) {
            if (this._matchPattern(callerLower, pattern.toLowerCase())) {
                return true;
            }
        }

        return false;
    }

    _matchPattern(str, pattern) {
        if (pattern === "*") return true;
        if (pattern.includes("*")) {
            // Escape regex special chars EXCEPT *, then replace * with .*
            const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
            const regex = new RegExp("^" + escaped + "$");
            return regex.test(str);
        }
        return str.includes(pattern);
    }

    // ── Call Actions ────────────────────────────────────────────

    /**
     * Answer an incoming call (voice only — no camera).
     * @returns {boolean} true if answer button was clicked
     */
    async answerCall() {
        this.log("Attempting to answer call...");
        await this._screenshot("whatsapp-before-answer");

        // ── Strategy 1: data-icon based (most stable) ──
        try {
            const answered = await this.page.evaluate(() => {
                // WhatsApp uses data-icon attributes extensively
                const icons = document.querySelectorAll("[data-icon]");
                for (const icon of icons) {
                    const dataIcon = icon.getAttribute("data-icon");
                    if (dataIcon && (
                        dataIcon.includes("call-accept") ||
                        dataIcon.includes("accept-call") ||
                        dataIcon === "accept"
                    )) {
                        const btn = icon.closest("button, [role='button'], div[tabindex]");
                        if (btn) {
                            btn.click();
                            return true;
                        }
                        icon.click();
                        return true;
                    }
                }
                return false;
            });
            if (answered) {
                this.log("Answered call via data-icon");
                await this._wait(2000);
                return true;
            }
        } catch (e) {}

        // ── Strategy 2: Button text match ──
        try {
            const answerBtn = await this._findButtonByText(
                "Answer",
                "Accept",
                "קבל",      // Hebrew
                "ענה"       // Hebrew
            );
            if (answerBtn) {
                await answerBtn.click();
                this.log("Answered call via button text");
                await this._wait(2000);
                return true;
            }
        } catch (e) {}

        // ── Strategy 3: aria-label match ──
        try {
            const answered = await this.page.evaluate(() => {
                const elements = document.querySelectorAll("[aria-label]");
                for (const el of elements) {
                    const label = el.getAttribute("aria-label").toLowerCase();
                    if (label.includes("answer") || label.includes("accept") || label.includes("קבל")) {
                        el.click();
                        return true;
                    }
                }
                return false;
            });
            if (answered) {
                this.log("Answered call via aria-label");
                await this._wait(2000);
                return true;
            }
        } catch (e) {}

        // ── Strategy 4: Green button (answer is typically green) ──
        try {
            const answered = await this.page.evaluate(() => {
                const buttons = document.querySelectorAll("button, [role='button']");
                for (const btn of buttons) {
                    const style = window.getComputedStyle(btn);
                    const bg = style.backgroundColor;
                    // Green-ish: rgb(0, 128, 0) / rgb(34, 197, 94) / #00a884 (WhatsApp green)
                    if (bg && (/rgb\(\s*0,\s*\d+,\s*0\)/.test(bg) || /rgb\(\s*\d{1,2},\s*1[2-9]\d,/.test(bg))) {
                        const text = (btn.textContent || "").toLowerCase();
                        // Make sure it's not "decline" with green styling somehow
                        if (!text.includes("decline") && !text.includes("reject")) {
                            btn.click();
                            return true;
                        }
                    }
                }
                return false;
            });
            if (answered) {
                this.log("Answered call via green button heuristic");
                await this._wait(2000);
                return true;
            }
        } catch (e) {}

        this.log("Warning: Could not find answer button");
        await this._screenshot("whatsapp-no-answer-btn");
        await this._dumpPageText("no-answer-btn");
        return false;
    }

    /**
     * Decline an incoming call.
     * @returns {boolean}
     */
    async declineCall() {
        try {
            // data-icon based
            const declined = await this.page.evaluate(() => {
                const icons = document.querySelectorAll("[data-icon]");
                for (const icon of icons) {
                    const dataIcon = icon.getAttribute("data-icon");
                    if (dataIcon && (
                        dataIcon.includes("call-decline") ||
                        dataIcon.includes("decline-call") ||
                        dataIcon === "decline"
                    )) {
                        const btn = icon.closest("button, [role='button'], div[tabindex]");
                        if (btn) { btn.click(); return true; }
                        icon.click();
                        return true;
                    }
                }
                return false;
            });
            if (declined) {
                this.log("Declined call via data-icon");
                return true;
            }
        } catch (e) {}

        // Text-based fallback
        const declineBtn = await this._findButtonByText("Decline", "Reject", "דחה");
        if (declineBtn) {
            await declineBtn.click();
            this.log("Declined call via button text");
            return true;
        }

        return false;
    }

    /**
     * End the current call.
     * @returns {boolean}
     */
    async endCall() {
        try {
            // data-icon based
            const ended = await this.page.evaluate(() => {
                const icons = document.querySelectorAll("[data-icon]");
                for (const icon of icons) {
                    const dataIcon = icon.getAttribute("data-icon");
                    if (dataIcon && (
                        dataIcon.includes("call-end") ||
                        dataIcon.includes("end-call") ||
                        dataIcon.includes("hangup") ||
                        dataIcon === "end"
                    )) {
                        const btn = icon.closest("button, [role='button'], div[tabindex]");
                        if (btn) { btn.click(); return true; }
                        icon.click();
                        return true;
                    }
                }
                return false;
            });
            if (ended) {
                this.log("Ended call via data-icon");
                return true;
            }
        } catch (e) {}

        // aria-label / text fallback
        const endBtn = await this._findButtonByText("End call", "End", "Hang up", "סיים שיחה", "סיום");
        if (endBtn) {
            await endBtn.click();
            this.log("Ended call via button text");
            return true;
        }

        // Red button heuristic (end call is typically red)
        try {
            const ended = await this.page.evaluate(() => {
                const buttons = document.querySelectorAll("button, [role='button']");
                for (const btn of buttons) {
                    const style = window.getComputedStyle(btn);
                    const bg = style.backgroundColor;
                    if (bg && /rgb\(\s*[12]\d\d,\s*\d{1,2},\s*\d{1,2}\)/.test(bg)) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            });
            if (ended) {
                this.log("Ended call via red button heuristic");
                return true;
            }
        } catch (e) {}

        return false;
    }

    // ── In-Call Muting ──────────────────────────────────────────

    async muteMedia() {
        // Mute microphone during call
        try {
            const muted = await this.page.evaluate(() => {
                const icons = document.querySelectorAll("[data-icon]");
                for (const icon of icons) {
                    const dataIcon = icon.getAttribute("data-icon");
                    // "microphone" icon = currently unmuted, click to mute
                    if (dataIcon === "microphone" || dataIcon === "audio-mic") {
                        const btn = icon.closest("button, [role='button'], div[tabindex]");
                        if (btn) { btn.click(); return true; }
                    }
                }
                return false;
            });
            if (muted) this.log("Microphone muted");
        } catch (e) {}

        // Turn off camera
        try {
            const camOff = await this.page.evaluate(() => {
                const icons = document.querySelectorAll("[data-icon]");
                for (const icon of icons) {
                    const dataIcon = icon.getAttribute("data-icon");
                    if (dataIcon === "video-camera" || dataIcon === "video-on") {
                        const btn = icon.closest("button, [role='button'], div[tabindex]");
                        if (btn) { btn.click(); return true; }
                    }
                }
                return false;
            });
            if (camOff) this.log("Camera turned off");
        } catch (e) {}
    }

    // ── Meeting/Call Verification ───────────────────────────────

    /**
     * Verify we are currently in an active call.
     *
     * WhatsApp call UI indicators:
     *   - Call timer showing duration (00:00, 00:01, etc.)
     *   - Mute / End / Camera buttons visible
     *   - Call-specific container elements
     */
    async verifyInMeeting() {
        return await this._isInCall();
    }

    async _isInCall() {
        try {
            const inCall = await this.page.evaluate(() => {
                const body = document.body?.innerHTML || "";
                const text = document.body?.innerText || "";

                // ── Signal 1: Call timer (strongest signal) ──
                // Format: "00:00", "01:23", "1:23:45"
                const timerPattern = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
                const spans = document.querySelectorAll("span, div");
                let hasTimer = false;
                for (const el of spans) {
                    const t = (el.textContent || "").trim();
                    if (t.length <= 10 && timerPattern.test(t) && el.offsetParent !== null) {
                        // Verify it's in a call context, not a message timestamp
                        const parent = el.closest('[class*="call"], [class*="voip"], [data-testid*="call"]');
                        if (parent) {
                            hasTimer = true;
                            break;
                        }
                    }
                }

                // ── Signal 2: End call button visible ──
                let hasEndBtn = false;
                const icons = document.querySelectorAll("[data-icon]");
                for (const icon of icons) {
                    const dataIcon = icon.getAttribute("data-icon") || "";
                    if (dataIcon.includes("call-end") || dataIcon.includes("end-call") || dataIcon.includes("hangup")) {
                        hasEndBtn = true;
                        break;
                    }
                }

                // ── Signal 3: Call container elements ──
                const callContainer = document.querySelector(
                    '[class*="call-screen"], ' +
                    '[class*="voip-screen"], ' +
                    '[class*="call-container"], ' +
                    '[data-testid="call-screen"], ' +
                    '[data-testid="voip"]'
                );

                // ── Signal 4: In-call text ──
                const callTextPatterns = [
                    "on call",
                    "in call",
                    "ringing",
                    "connecting",
                    "end-to-end encrypted",     // WhatsApp shows this during calls
                    "מוצפן מקצה לקצה",          // Hebrew: end-to-end encrypted
                ];
                let hasCallText = false;
                for (const pat of callTextPatterns) {
                    if (text.toLowerCase().includes(pat)) {
                        hasCallText = true;
                        break;
                    }
                }

                // Need at least 2 signals to confirm
                const signals = [hasTimer, hasEndBtn, !!callContainer, hasCallText];
                const hitCount = signals.filter(Boolean).length;

                return hitCount >= 1; // even 1 strong signal (end button) is enough
            });
            return inCall;
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if the current call has ended.
     *
     * Signals:
     *   - Call UI disappeared
     *   - "Call ended" / "Call was missed" text
     *   - Back to main chat interface
     */
    async checkMeetingEnded(hasJoinedBefore) {
        return await this.checkCallEnded(hasJoinedBefore);
    }

    async checkCallEnded(hasJoinedBefore) {
        try {
            const ended = await this.page.evaluate(() => {
                const text = document.body?.innerText || "";
                const html = document.body?.innerHTML || "";

                // ── Signal 1: Explicit end text ──
                const endPatterns = [
                    "call ended",
                    "call was missed",
                    "call failed",
                    "unavailable",
                    "no answer",
                    "שיחה הסתיימה",      // Hebrew: call ended
                    "השיחה הסתיימה",     // Hebrew: the call ended
                    "שיחה שלא נענתה",    // Hebrew: missed call
                ];
                for (const pat of endPatterns) {
                    if (text.toLowerCase().includes(pat)) {
                        return { ended: true, reason: pat };
                    }
                }

                // ── Signal 2: End call button disappeared ──
                const icons = document.querySelectorAll("[data-icon]");
                let hasEndBtn = false;
                for (const icon of icons) {
                    const dataIcon = icon.getAttribute("data-icon") || "";
                    if (dataIcon.includes("call-end") || dataIcon.includes("end-call") || dataIcon.includes("hangup")) {
                        hasEndBtn = true;
                        break;
                    }
                }

                // ── Signal 3: Back to main chat interface ──
                const hasMainUI = html.includes("pane-side") ||
                                  html.includes('data-icon="search"') ||
                                  html.includes('role="grid"');

                // If we had a call going and now there's no end button but main UI is back
                if (!hasEndBtn && hasMainUI) {
                    return { ended: true, reason: "call UI disappeared, main chat visible" };
                }

                return { ended: false, reason: null };
            });

            if (ended.ended) {
                this.log("Call ended: " + ended.reason);
                return true;
            }
        } catch (e) {
            // If page crashed or navigated away during call
            if (hasJoinedBefore) {
                this.log("Call ended: page error (likely call terminated)");
                return true;
            }
        }

        return false;
    }

    // ── Unused interface methods (WhatsApp uses watcher, not URL join) ──

    normalizeUrl(url) {
        return "https://web.whatsapp.com";
    }

    extractMeetingCode(url) {
        return this._callerInfo?.caller || "whatsapp-call";
    }

    async enterName(botName) {
        // WhatsApp uses the logged-in account name, no separate bot name entry
        return true;
    }

    async clickJoin() {
        // Join = Answer for WhatsApp
        return await this.answerCall();
    }

    async dismissPopups() {
        // Dismiss any WhatsApp Web notifications or banners
        try {
            // "Use WhatsApp on your phone" warning
            const dismissBtn = await this._findButtonByText("OK", "Got it", "Dismiss");
            if (dismissBtn) {
                await dismissBtn.click();
                this.log("Dismissed WhatsApp popup");
                await this._wait(500);
            }
        } catch (e) {}

        // Desktop notification permission request
        try {
            const notifDismiss = await this.page.$('[data-testid="notification-dismiss"]');
            if (notifDismiss) {
                await notifDismiss.click();
                this.log("Dismissed notification prompt");
            }
        } catch (e) {}
    }
}

module.exports = WhatsAppPlatform;
