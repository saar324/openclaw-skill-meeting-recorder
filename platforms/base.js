/**
 * Base Platform Adapter
 *
 * All meeting platform adapters extend this class.
 * Each platform implements its own selectors, join flow,
 * meeting verification, and end detection.
 *
 * The MeetingBot core handles: browser, audio, recording, transcription, cleanup.
 * The adapter handles: everything platform-specific in the browser.
 */
class BasePlatform {
    constructor(page, log) {
        if (new.target === BasePlatform) {
            throw new Error("BasePlatform is abstract - use a platform adapter");
        }
        this.page = page;
        this.log = log;
    }

    /** Platform identifier string (e.g. "google-meet", "zoom") */
    get name() {
        throw new Error("Adapter must implement get name()");
    }

    /**
     * Convert the user-provided URL to the actual URL the browser should navigate to.
     * Some platforms need URL transformation (e.g. Zoom /j/ -> /wc/join/).
     * Default: return as-is.
     */
    normalizeUrl(url) {
        return url;
    }

    /**
     * Extract a meeting code/ID from the URL for metadata.
     * @returns {string|null}
     */
    extractMeetingCode(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.pathname.split("/").filter(Boolean).pop() || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Wait time (ms) after page.goto before starting the join flow.
     * Override per platform if needed.
     */
    get initialWaitMs() {
        return 3000;
    }

    /**
     * Dismiss any popups, cookie banners, or overlays that appear before/during join.
     */
    async dismissPopups() {
        try {
            const closeButtons = await this.page.$$("button");
            for (const btn of closeButtons) {
                const text = await btn.evaluate(el =>
                    el.textContent || el.getAttribute("aria-label") || ""
                );
                if (/close|dismiss|got it|not now|accept|agree/i.test(text)) {
                    await btn.click();
                    await this._wait(300);
                }
            }
        } catch (e) {}
    }

    /**
     * Enter the bot display name if the platform asks for it.
     * @returns {boolean} true if name was entered
     */
    async enterName(botName) {
        throw new Error("Adapter must implement enterName()");
    }

    /**
     * Mute microphone and camera before joining.
     */
    async muteMedia() {
        throw new Error("Adapter must implement muteMedia()");
    }

    /**
     * Click the join/enter button to actually get into the meeting.
     * @returns {boolean} true if a join button was clicked
     */
    async clickJoin() {
        throw new Error("Adapter must implement clickJoin()");
    }

    /**
     * Verify the bot is actually inside the meeting (not still on lobby/preview).
     * @returns {boolean}
     */
    async verifyInMeeting() {
        throw new Error("Adapter must implement verifyInMeeting()");
    }

    /**
     * Check if the meeting has ended.
     * @param {boolean} hasJoinedBefore - whether we ever successfully joined
     * @returns {boolean}
     */
    /**
     * Get the number of participants in the meeting (excluding the bot)
     * Returns -1 if unable to determine
     */
    async getParticipantCount() {
        return -1; // Default: unknown
    }

    async checkMeetingEnded(hasJoinedBefore) {
        throw new Error("Adapter must implement checkMeetingEnded()");
    }

    // ── Helpers ──────────────────────────────────────────────

    async _wait(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    /**
     * Save a debug screenshot with a labeled step name.
     * Screenshots go to /tmp/meeting-debug-<step>.png
     */
    async _screenshot(step) {
        try {
            const path = "/tmp/meeting-debug-" + step + ".png";
            await this.page.screenshot({ path, fullPage: true });
            this.log("Screenshot: " + path);
        } catch (e) {}
    }

    /**
     * Dump the current page text (visible innerText) to the log for debugging.
     * Truncated to first 500 chars.
     */
    async _dumpPageText(label) {
        try {
            const text = await this.page.evaluate(() =>
                (document.body?.innerText || "").substring(0, 500)
            );
            this.log("[" + label + "] Page text: " + text.replace(/\n/g, " | "));
        } catch (e) {}
    }

    /**
     * Find a button by its text content (case-insensitive partial match).
     * @returns {ElementHandle|null}
     */
    async _findButtonByText(...texts) {
        try {
            const buttons = await this.page.$$("button");
            for (const btn of buttons) {
                const btnText = await btn.evaluate(el =>
                    (el.textContent || "").trim() + " " + (el.getAttribute("aria-label") || "")
                );
                for (const text of texts) {
                    if (btnText.toLowerCase().includes(text.toLowerCase())) {
                        return btn;
                    }
                }
            }
        } catch (e) {}
        return null;
    }

    /**
     * Try multiple CSS selectors, return the first element found.
     * @returns {ElementHandle|null}
     */
    async _findFirst(...selectors) {
        for (const sel of selectors) {
            try {
                const el = await this.page.$(sel);
                if (el) return el;
            } catch (e) {}
        }
        return null;
    }

    /**
     * Check if page content contains any of the given strings.
     * Uses full HTML source (page.content()) — matches hidden elements too.
     * @returns {string|null} the matched indicator, or null
     */
    async _pageContainsAny(indicators) {
        try {
            const content = await this.page.content();
            for (const indicator of indicators) {
                if (content.includes(indicator)) return indicator;
            }
        } catch (e) {}
        return null;
    }

    /**
     * Check if VISIBLE page text contains any of the given strings.
     * Uses document.body.innerText — only matches text the user can actually see.
     * Use this instead of _pageContainsAny when false positives from hidden
     * DOM elements are a concern (e.g. Zoom pre-renders "meeting ended" templates).
     * @returns {string|null} the matched indicator, or null
     */
    async _visibleTextContainsAny(indicators) {
        try {
            const visibleText = await this.page.evaluate(() =>
                document.body?.innerText || ""
            );
            for (const indicator of indicators) {
                if (visibleText.includes(indicator)) return indicator;
            }
        } catch (e) {}
        return null;
    }
}

module.exports = BasePlatform;
