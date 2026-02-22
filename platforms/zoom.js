const BasePlatform = require("./base");

/**
 * Zoom Web Client Adapter
 *
 * Handles joining Zoom meetings through the browser web client.
 *
 * Key differences from desktop Zoom:
 * - URL must be converted to /wc/join/ format for web client
 * - Web client may have limited features depending on host settings
 * - Host must have "Join from browser" enabled
 * - Waiting room / lobby handling is needed
 * - Password may be required (passed via ?pwd= query param)
 *
 * Zoom's web UI changes frequently. This adapter uses a layered approach:
 *   1. CSS selectors (fastest)
 *   2. aria-label / role-based (most stable)
 *   3. Text content search (fallback)
 *
 * Debug screenshots are saved at each step to /tmp/meeting-debug-*.png
 */
class ZoomPlatform extends BasePlatform {
    get name() {
        return "zoom";
    }

    get initialWaitMs() {
        // Zoom web client takes longer to load its React app
        return 5000;
    }

    /**
     * Convert standard Zoom URLs to web client format.
     *
     * Input formats:
     *   https://zoom.us/j/123456789?pwd=abc123
     *   https://us05web.zoom.us/j/123456789?pwd=abc123
     *   https://zoom.us/wc/join/123456789  (already web client - pass through)
     *
     * Output: https://<host>/wc/join/<id>?<query>
     */
    normalizeUrl(url) {
        try {
            // Already web client format
            if (url.includes("/wc/join/")) return url;

            const match = url.match(/(https:\/\/[^/]+)\/j\/(\d+)(.*)/);
            if (match) {
                const [, host, meetingId, rest] = match;
                const normalized = host + "/wc/join/" + meetingId + rest;
                this.log("Converted Zoom URL to web client: " + normalized);
                return normalized;
            }

            // Fallback: if it's a zoom.us URL but not /j/ format, try as-is
            return url;
        } catch (e) {
            return url;
        }
    }

    extractMeetingCode(url) {
        try {
            // Match /j/DIGITS or /wc/join/DIGITS
            const match = url.match(/\/(?:j|wc\/join)\/(\d+)/);
            return match ? match[1] : null;
        } catch (e) {
            return null;
        }
    }

    async dismissPopups() {
        // First run the generic popup dismiss
        await super.dismissPopups();

        // Zoom-specific: cookie consent (do this FIRST, it can overlay everything)
        try {
            const cookieBtn = await this._findFirst(
                "#onetrust-accept-btn-handler",
                'button[id*="cookie"]',
                'button[class*="cookie"]'
            );
            if (cookieBtn) {
                await cookieBtn.click();
                this.log("Dismissed cookie banner");
                await this._wait(500);
            }
        } catch (e) {}

        // ──────────────────────────────────────────────────────────────
        // Zoom media permissions modal:
        //   "Do you want people to see you in the meeting?"
        //   [Use microphone and camera]  (button)
        //   "Continue without microphone and camera"  (<span role="button">)
        //
        // This is a React modal (.ReactModalPortal) that blocks EVERYTHING.
        // The dismiss element is a <span> with role="button", NOT a real
        // <a> or <button>. Since we're a recording bot, click "Continue without".
        // ──────────────────────────────────────────────────────────────

        // Layer 1: Direct CSS selector (most reliable)
        try {
            const skipBtn = await this.page.$(".pepc-permission-dialog__footer-button");
            if (skipBtn) {
                await skipBtn.click();
                this.log("Dismissed media modal via .pepc-permission-dialog__footer-button");
                await this._wait(2000);
            }
        } catch (e) {}

        // Layer 2: role="button" elements with matching text
        try {
            const roleButtons = await this.page.$$('[role="button"]');
            for (const el of roleButtons) {
                const text = await el.evaluate(el => (el.textContent || "").trim().toLowerCase());
                if (text.includes("continue without")) {
                    await el.click();
                    this.log("Dismissed media modal via role=button text match");
                    await this._wait(2000);
                    break;
                }
            }
        } catch (e) {}

        // Layer 3: Nuclear option — find ANY element in the DOM with this text and click it
        try {
            const dismissed = await this.page.evaluate(() => {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
                while (walker.nextNode()) {
                    const el = walker.currentNode;
                    const text = (el.textContent || "").trim();
                    // Only match leaf-level elements (not parent containers)
                    if (el.children.length === 0 && text.toLowerCase().includes("continue without microphone")) {
                        el.click();
                        return true;
                    }
                }
                return false;
            });
            if (dismissed) {
                this.log("Dismissed media modal via DOM walker click");
                await this._wait(2000);
            }
        } catch (e) {}

        // Zoom-specific: "Join from Your Browser" link
        // When Zoom navigates to /wc/join/ it may STILL show an interstitial
        // that tries to launch the desktop app with a small "join from your browser" link
        try {
            const links = await this.page.$$("a");
            for (const link of links) {
                const text = await link.evaluate(el =>
                    (el.textContent || "").trim().toLowerCase()
                );
                if (
                    text.includes("join from your browser") ||
                    text.includes("join from browser") ||
                    text.includes("join without") ||
                    text.includes("start from your browser")
                ) {
                    await link.click();
                    this.log("Clicked 'Join from Browser' link");
                    await this._wait(4000);
                    break;
                }
            }
        } catch (e) {}

        // Also check for a "Join from Your Browser" BUTTON (some Zoom versions)
        try {
            const browserBtn = await this._findButtonByText(
                "Join from Your Browser",
                "Join from Browser",
                "Join without"
            );
            if (browserBtn) {
                await browserBtn.click();
                this.log("Clicked 'Join from Browser' button");
                await this._wait(4000);
            }
        } catch (e) {}
    }

    async enterName(botName) {
        // Layer 1: Zoom's known ID-based selector
        try {
            const nameById = await this.page.$("#inputname");
            if (nameById) {
                this.log("Found Zoom name input (#inputname), entering: " + botName);
                await nameById.click({ clickCount: 3 });
                await nameById.type(botName);
                await this._wait(500);
                return true;
            }
        } catch (e) {}

        // Layer 2: aria/placeholder based
        try {
            const inputs = await this.page.$$("input");
            for (const input of inputs) {
                const attrs = await input.evaluate(el => ({
                    placeholder: (el.placeholder || "").toLowerCase(),
                    ariaLabel: (el.getAttribute("aria-label") || "").toLowerCase(),
                    name: (el.name || "").toLowerCase(),
                    id: (el.id || "").toLowerCase(),
                    type: (el.type || "").toLowerCase(),
                }));
                if (
                    attrs.type !== "hidden" &&
                    (
                        attrs.placeholder.includes("name") ||
                        attrs.ariaLabel.includes("name") ||
                        attrs.name.includes("name") ||
                        attrs.id.includes("name")
                    )
                ) {
                    this.log("Found Zoom name input by attrs, entering: " + botName);
                    await input.click({ clickCount: 3 });
                    await input.type(botName);
                    await this._wait(500);
                    return true;
                }
            }
        } catch (e) {
            this.log("Name entry error: " + e.message);
        }

        return false;
    }

    async muteMedia() {
        // On the Zoom pre-join page, mic/camera toggles may exist.
        // We want them OFF. The toggles might show "Mute"/"Unmute" depending on state.
        // Only click if currently unmuted (active).
        try {
            const micBtn = await this._findFirst(
                '[aria-label*="mute my microphone" i]',
                '[aria-label*="Mute" i]:not([aria-label*="Unmute" i])',
            );
            if (micBtn) {
                await micBtn.click();
                this.log("Microphone muted");
            }
        } catch (e) {}

        try {
            const camBtn = await this._findFirst(
                '[aria-label*="stop my video" i]',
                '[aria-label*="Stop Video" i]',
                '[aria-label*="turn off camera" i]',
            );
            if (camBtn) {
                await camBtn.click();
                this.log("Camera turned off");
            }
        } catch (e) {}
    }

    async clickJoin() {
        await this._screenshot("zoom-before-join");
        await this._dumpPageText("before-join");

        // Phase 1: Pre-meeting join button (the main "Join" to enter the meeting)
        let clicked = false;

        const preJoinBtn = await this._findFirst(
            'button.join-btn',
            'button[class*="join-btn"]',
            '#joinBtn',
            'button.btn-join',
            'button.preview-join-button',
        );
        if (preJoinBtn) {
            await preJoinBtn.click();
            this.log("Clicked Zoom pre-join button (selector)");
            clicked = true;
        }

        if (!clicked) {
            // Text-based fallback — but be SPECIFIC to avoid matching random "Join" text
            const buttons = await this.page.$$("button");
            for (const btn of buttons) {
                const info = await btn.evaluate(el => ({
                    text: (el.textContent || "").trim(),
                    ariaLabel: el.getAttribute("aria-label") || "",
                    disabled: el.disabled,
                    visible: el.offsetParent !== null,
                }));

                if (info.disabled || !info.visible) continue;

                const combined = (info.text + " " + info.ariaLabel).toLowerCase();
                if (
                    combined === "join" ||
                    combined.includes("join meeting") ||
                    combined.includes("join ") ||       // "Join " with trailing space
                    info.text === "Join"
                ) {
                    await btn.click();
                    this.log("Clicked Zoom join button: text='" + info.text + "' aria='" + info.ariaLabel + "'");
                    clicked = true;
                    break;
                }
            }
        }

        if (!clicked) {
            this.log("Warning: Could not find any Join button");
            await this._screenshot("zoom-no-join-btn");
            await this._dumpPageText("no-join-btn");
        }

        // Wait for transition to meeting room
        await this._wait(5000);
        await this._screenshot("zoom-after-join-click");
        await this._dumpPageText("after-join-click");

        // Check if we hit another interstitial ("Join from Browser" can appear AGAIN after clicking Join)
        await this.dismissPopups();
        await this._wait(2000);

        // Phase 2: "Join Audio by Computer" dialog
        // Zoom shows this after you enter the meeting - critical for audio capture
        await this._handleAudioJoin();

        await this._screenshot("zoom-after-audio-join");

        return clicked;
    }

    async _handleAudioJoin() {
        // Wait for the audio dialog to appear
        for (let attempt = 0; attempt < 15; attempt++) {
            await this._wait(1000);

            // Try selector-based
            const audioBtn = await this._findFirst(
                'button.join-audio-by-voip',
                'button[class*="join-audio"]',
                'button.join-audio-by-voip__join-btn',
                '#voip_call_btn',
            );
            if (audioBtn) {
                await audioBtn.click();
                this.log("Clicked 'Join Audio by Computer' (selector)");
                return;
            }

            // Text-based fallback
            const textBtn = await this._findButtonByText(
                "Join Audio by Computer",
                "Join with Computer Audio",
                "Computer Audio",
                "Join Audio"
            );
            if (textBtn) {
                await textBtn.click();
                this.log("Clicked 'Join Audio' via text match");
                return;
            }

            // Check if we're already in the meeting (some configs skip the audio dialog)
            if (attempt > 5) {
                const inMeeting = await this._isInMeetingRoom();
                if (inMeeting) {
                    this.log("Already in meeting room, no audio dialog needed");
                    return;
                }
            }
        }

        this.log("Warning: Could not find 'Join Audio' button after 15 attempts");
        await this._screenshot("zoom-no-audio-btn");
        await this._dumpPageText("no-audio-btn");
    }

    /**
     * Detect whether we're in Zoom's waiting room / lobby.
     * This MUST be checked before assuming we're in the actual meeting,
     * because some meeting UI elements (containers, etc.) can be present
     * in the waiting room too.
     *
     * Known waiting room indicators:
     *   - "Please wait, the meeting host will let you in soon"
     *   - "Host has joined. We've let them know you're here."  (Hebrew variant too)
     *   - "Waiting for the host to let you in"
     *   - "waiting for the host"
     *   - "Waiting Room"  (visible label)
     */
    async _isInWaitingRoom() {
        const waitingIndicators = [
            "Please wait, the meeting host will let you in soon",
            "please wait, the meeting host will let you in soon",
            "Waiting for the host to let you in",
            "waiting for the host",
            "We've let them know you're here",
            "we've let them know you're here",
            "let them know you're here",
            "the meeting host will let you in",
            "Waiting Room",
            "waiting room",
            // Hebrew variants
            "ממתין למארח",
            "חדר המתנה",
        ];

        // Use visible text to avoid matching hidden DOM templates
        const matched = await this._visibleTextContainsAny(waitingIndicators);
        if (matched) {
            this.log("Waiting room detected: " + matched);
            return true;
        }

        // Also check for the waiting room container class (Zoom-specific)
        try {
            const wrContainer = await this._findFirst(
                '[class*="waiting-room"]',
                '[class*="waitingRoom"]',
                '[class*="WaitingRoom"]',
                '#wc-waiting',
            );
            if (wrContainer) {
                this.log("Waiting room detected via container element");
                return true;
            }
        } catch (e) {}

        return false;
    }

    /**
     * Strict check: are we actually in the Zoom meeting room?
     * This is different from verifyInMeeting() — it's used internally
     * and checks for elements that ONLY exist in the actual meeting (not pre-join).
     *
     * IMPORTANT: Also checks we're NOT in the waiting room, since some Zoom
     * UI elements (containers) can appear in waiting room too.
     */
    async _isInMeetingRoom() {
        // FIRST: if we're in the waiting room, we're definitely NOT in the meeting
        if (await this._isInWaitingRoom()) {
            return false;
        }

        // The meeting footer bar with Leave/End button is the strongest signal
        const leaveBtn = await this._findFirst(
            'button[aria-label*="Leave" i]',
            'button[aria-label*="End" i]',
            '.footer__leave-btn',
            '[class*="leave-meeting"]',
        );
        if (leaveBtn) return true;

        // Zoom meeting has a specific container
        const meetingContainer = await this._findFirst(
            '#wc-container-left',
            '.meeting-client-inner',
            '.meeting-app',
            '[class*="meeting-client"]',
        );
        if (meetingContainer) return true;

        return false;
    }

    async verifyInMeeting() {
        // FIRST: check for waiting room — this takes absolute priority
        if (await this._isInWaitingRoom()) {
            this.log("Still in waiting room — NOT in meeting yet");
            return false;
        }

        // Strongest signal: meeting room UI elements (Leave button, meeting container)
        // Note: _isInMeetingRoom() also checks for waiting room internally
        if (await this._isInMeetingRoom()) {
            this.log("Verified in meeting via meeting room UI");
            return true;
        }

        // Check for meeting toolbar text (Participants, Chat, Share Screen, Leave)
        // These are VISIBLE text in the meeting toolbar, not hidden DOM leftovers
        try {
            const hasToolbar = await this.page.evaluate(() => {
                // Look for the meeting footer bar which has visible buttons
                const buttons = document.querySelectorAll("button");
                let toolbarHits = 0;
                for (const btn of buttons) {
                    if (btn.offsetParent === null) continue; // skip hidden
                    const text = (btn.textContent || "").trim().toLowerCase();
                    if (["participants", "chat", "leave", "share screen", "audio", "video"].includes(text)) {
                        toolbarHits++;
                    }
                }
                return toolbarHits >= 3; // need at least 3 toolbar buttons visible
            });
            if (hasToolbar) {
                this.log("Verified in meeting via visible toolbar buttons");
                return true;
            }
        } catch (e) {}

        // Check for in-meeting text that is unique to the meeting room
        const textMatch = await this._pageContainsAny([
            "is the host now",
            "You are in a meeting",
            "Meeting is being recorded",
        ]);
        if (textMatch) {
            this.log("Verified in meeting via text: " + textMatch);
            return true;
        }

        // Negative check: if media modal is STILL visible, definitely not in
        const mediaModalVisible = await this._pageContainsAny([
            "Do you want people to see you in the meeting",
        ]);
        if (mediaModalVisible) {
            this.log("Media permissions modal still visible — not in meeting yet");
            return false;
        }

        return false;
    }

    /**
     * Actively wait for the host to admit us from the waiting room.
     * Polls every 3 seconds for up to `maxWaitMs` (default: 10 minutes).
     *
     * Returns:
     *   "admitted"  — we left the waiting room and are now in the meeting
     *   "ended"     — the meeting ended while we were waiting
     *   "timeout"   — waited too long, host never admitted us
     *   "not_waiting" — we're not in the waiting room (already in meeting or other state)
     */
    async waitForAdmission(maxWaitMs = 10 * 60 * 1000) {
        // First check: are we actually in the waiting room?
        if (!(await this._isInWaitingRoom())) {
            this.log("Not in waiting room, skipping admission wait");
            return "not_waiting";
        }

        this.log("In waiting room — waiting for host to admit us (max " + Math.round(maxWaitMs / 60000) + " min)...");
        await this._screenshot("zoom-waiting-room");
        await this._dumpPageText("waiting-room");

        const startTime = Date.now();
        const pollIntervalMs = 3000;
        let lastLogTime = 0;

        while (Date.now() - startTime < maxWaitMs) {
            await this._wait(pollIntervalMs);

            // Check if meeting ended while we were waiting
            // IMPORTANT: use _visibleTextContainsAny here, NOT _pageContainsAny,
            // because Zoom pre-renders "meeting ended" templates as hidden DOM
            // elements in the waiting room. Checking full HTML causes false positives.
            const endIndicators = [
                "This meeting has been ended",
                "The host has ended the meeting",
                "Meeting has ended",
                "This meeting has ended",
                "Meeting ended",
            ];
            const endMatch = await this._visibleTextContainsAny(endIndicators);
            if (endMatch) {
                this.log("Meeting ended while in waiting room (visible text): " + endMatch);
                return "ended";
            }

            // Check if we're still in the waiting room
            if (!(await this._isInWaitingRoom())) {
                // We left the waiting room! Verify we're actually in the meeting
                this.log("No longer in waiting room — checking if admitted...");
                await this._wait(2000); // Brief pause for UI transition

                // Try to handle the audio join dialog that appears after admission
                await this._handleAudioJoin();

                if (await this.verifyInMeeting()) {
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    this.log("Admitted to meeting after " + elapsed + "s in waiting room");
                    await this._screenshot("zoom-admitted");
                    return "admitted";
                }

                // Edge case: waiting room text disappeared but we're not in meeting either
                // Could be a transition state — wait and check again
                this.log("Left waiting room but not confirmed in meeting, continuing to poll...");
            }

            // Periodic log (every 30 seconds)
            const elapsed = Date.now() - startTime;
            if (elapsed - lastLogTime >= 30000) {
                lastLogTime = elapsed;
                this.log("Still in waiting room (" + Math.round(elapsed / 1000) + "s elapsed)...");
                await this._screenshot("zoom-still-waiting-" + Math.round(elapsed / 1000));
            }
        }

        this.log("Timed out waiting for host admission after " + Math.round(maxWaitMs / 60000) + " min");
        await this._screenshot("zoom-admission-timeout");
        return "timeout";
    }

    async checkMeetingEnded(hasJoinedBefore) {
        // Check for explicit end indicators
        const endIndicators = [
            "This meeting has been ended",
            "The host has ended the meeting",
            "Meeting has ended",
            "You have been removed from the meeting",
            "The meeting has ended for everyone",
            "This meeting has ended",
            "Meeting ended",
        ];

        const matched = await this._pageContainsAny(endIndicators);
        if (matched) {
            this.log("Meeting ended: " + matched);
            return true;
        }

        // Check for waiting room (host kicked us back)
        if (hasJoinedBefore) {
            const waitingRoom = await this._pageContainsAny([
                "waiting for the host",
                "Please wait, the meeting host will let you in soon",
                "Waiting Room",
            ]);
            if (waitingRoom) {
                this.log("Returned to waiting room, treating as ended");
                return true;
            }
        }

        // Check for redirect to Zoom homepage or post-meeting page
        try {
            const currentUrl = this.page.url();
            if (hasJoinedBefore) {
                if (
                    currentUrl === "https://zoom.us/" ||
                    currentUrl.includes("zoom.us/postattendee") ||
                    currentUrl.includes("zoom.us/meeting/ended") ||
                    currentUrl === "about:blank"
                ) {
                    this.log("Meeting ended: redirected to " + currentUrl);
                    return true;
                }
            }
        } catch (e) {}

        // Check if meeting UI disappeared
        if (hasJoinedBefore) {
            const stillInMeeting = await this._isInMeetingRoom();
            if (!stillInMeeting) {
                try {
                    const bodyText = await this.page.evaluate(() =>
                        document.body?.innerText?.length || 0
                    );
                    if (bodyText > 50) {
                        this.log("Meeting ended: meeting UI disappeared");
                        return true;
                    }
                } catch (e) {}
            }
        }

        return false;
    }
}

module.exports = ZoomPlatform;
