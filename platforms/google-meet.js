const BasePlatform = require("./base");

/**
 * Google Meet Adapter
 *
 * Handles joining, verifying, and monitoring Google Meet calls.
 * Extracted from the original monolithic meeting-bot.js.
 */
class GoogleMeetPlatform extends BasePlatform {
    get name() {
        return "google-meet";
    }

    extractMeetingCode(url) {
        try {
            const urlObj = new URL(url);
            const parts = urlObj.pathname.split("/").filter(Boolean);
            return parts[parts.length - 1] || null;
        } catch (e) {
            return null;
        }
    }

    async enterName(botName) {
        try {
            // Primary: aria-label based (most reliable)
            const nameInput = await this.page.$('input[aria-label="Your name"]');
            if (nameInput) {
                this.log("Guest mode detected, entering name: " + botName);
                await nameInput.click({ clickCount: 3 });
                await nameInput.type(botName);
                await this._wait(500);
                return true;
            }

            // Fallback: scan all inputs for name-like placeholder
            const inputs = await this.page.$$("input");
            for (const input of inputs) {
                const placeholder = await input.evaluate(el => el.placeholder || "");
                if (placeholder.toLowerCase().includes("name")) {
                    this.log("Found name input by placeholder, entering: " + botName);
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
        try {
            const micBtn = await this.page.$('[aria-label*="Turn off microphone"]');
            if (micBtn) {
                await micBtn.click();
                this.log("Microphone muted");
            }
        } catch (e) {}

        try {
            const camBtn = await this.page.$('[aria-label*="Turn off camera"]');
            if (camBtn) {
                await camBtn.click();
                this.log("Camera turned off");
            }
        } catch (e) {}
    }

    async clickJoin() {
        // Try specific selectors first
        const joinSelectors = [
            'button[jsname="Qx7uuf"]',
            '[aria-label="Join now"]',
            '[aria-label="Ask to join"]',
        ];

        for (const sel of joinSelectors) {
            try {
                const btn = await this.page.$(sel);
                if (btn) {
                    await btn.click();
                    this.log("Clicked join button: " + sel);
                    return true;
                }
            } catch (e) {}
        }

        // Fallback: text-based search
        const btn = await this._findButtonByText("Join now", "Ask to join");
        if (btn) {
            await btn.click();
            this.log("Clicked join via text match");
            return true;
        }

        return false;
    }

    async verifyInMeeting() {
        // Check page content for in-meeting indicators
        const textMatch = await this._pageContainsAny([
            "Leave call",
            "You're the only one here",
            "participants",
        ]);
        if (textMatch) return true;

        // Check for hangup button
        const hangupBtn = await this.page.$('[aria-label*="Leave call"]');
        if (hangupBtn) return true;

        // Check URL - if we're on meet.google.com and NOT on /landing, we're in
        try {
            const currentUrl = this.page.url();
            if (currentUrl.includes("meet.google.com") && !currentUrl.includes("/landing")) {
                return true;
            }
        } catch (e) {}

        return false;
    }

    /**
     * Get participant count from Google Meet
     * Returns -1 if unable to determine, 0 if alone
     */
    async getParticipantCount() {
        try {
            // Method 1: Check for "alone" indicators
            const aloneIndicators = [
                "You are the only one here",
                "Waiting for others to join",
                "No one else is here",
            ];
            
            const isAlone = await this._pageContainsAny(aloneIndicators);
            if (isAlone) {
                return 0;
            }
            
            // Method 2: Count video tiles/participant elements
            const participantSelectors = [
                "[data-participant-id]",
                "[data-requested-participant-id]",
                "[data-self-name]",
            ];
            
            let maxCount = 0;
            for (const selector of participantSelectors) {
                try {
                    const elements = await this.page.$$(selector);
                    maxCount = Math.max(maxCount, elements.length);
                } catch (e) {}
            }
            
            if (maxCount > 0) {
                // Subtract 1 for the bot itself
                return Math.max(0, maxCount - 1);
            }
            
            return -1; // Unable to determine
        } catch (e) {
            this.log("Error getting participant count: " + e.message);
            return -1;
        }
    }


    async checkMeetingEnded(hasJoinedBefore) {
        // If we never joined, don't false-positive on the join page
        if (!hasJoinedBefore) {
            const onJoinPage = await this.page.$('[aria-label="Join now"]');
            if (onJoinPage) return false;
        }

        const endIndicators = [
            "You left the meeting",
            "Your host ended the meeting",
            "The meeting has ended",
            "Call ended",
        ];

        if (hasJoinedBefore) {
            endIndicators.push("Return to home screen");
            endIndicators.push("Returning to home screen");
        }

        const matched = await this._pageContainsAny(endIndicators);
        if (matched) {
            this.log("Meeting ended: " + matched);
            return true;
        }

        // Check for redirect away from meeting
        try {
            const currentUrl = this.page.url();
            if (hasJoinedBefore && (currentUrl.includes("/landing") || currentUrl === "about:blank")) {
                this.log("Meeting ended: redirected away");
                return true;
            }
        } catch (e) {}

        return false;
    }
}

module.exports = GoogleMeetPlatform;
