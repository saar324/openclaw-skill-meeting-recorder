const GoogleMeetPlatform = require("./google-meet");
const ZoomPlatform = require("./zoom");
const WhatsAppPlatform = require("./whatsapp");

/**
 * Platform registry.
 *
 * Maps URL patterns to adapter classes.
 * To add a new platform: create the adapter in platforms/, then add it here.
 *
 * Note: WhatsApp uses a persistent watcher model (whatsapp-watcher.js)
 * rather than one-shot URL joining. It's registered here for completeness
 * and so detectPlatformName() works, but it won't be used via resolvePlatform()
 * in the normal meeting-bot.js flow.
 */
const PLATFORMS = [
    { test: (url) => url.includes("meet.google.com"),   Adapter: GoogleMeetPlatform },
    { test: (url) => url.includes("zoom.us"),            Adapter: ZoomPlatform },
    { test: (url) => url.includes("web.whatsapp.com"),   Adapter: WhatsAppPlatform },
    { test: (url) => url.includes("whatsapp.com"),       Adapter: WhatsAppPlatform },
    // Future:
    // { test: (url) => url.includes("teams.microsoft.com"), Adapter: TeamsPlatform },
    // { test: (url) => url.includes("webex.com"),            Adapter: WebexPlatform },
];

/**
 * Resolve the correct platform adapter for a given meeting URL.
 *
 * @param {string} url - The meeting URL
 * @param {Page} page - Puppeteer page instance
 * @param {Function} log - Logging function
 * @returns {BasePlatform} The platform adapter instance
 * @throws {Error} If no adapter matches the URL
 */
function resolvePlatform(url, page, log) {
    for (const { test, Adapter } of PLATFORMS) {
        if (test(url)) {
            return new Adapter(page, log);
        }
    }

    const supported = ["Google Meet", "Zoom", "WhatsApp"].join(", ");

    throw new Error(
        "Unsupported meeting platform for URL: " + url + "\n" +
        "Supported platforms: " + supported
    );
}

/**
 * Check if a URL is a supported meeting platform.
 */
function isSupportedUrl(url) {
    return PLATFORMS.some(({ test }) => test(url));
}

/**
 * Get the platform name for a URL without instantiating an adapter.
 */
function detectPlatformName(url) {
    for (const { test, Adapter } of PLATFORMS) {
        if (test(url)) {
            // Quick instantiation just to read the name
            return new Adapter({ $: () => null }, () => {}).name;
        }
    }
    return "unknown";
}

module.exports = { resolvePlatform, isSupportedUrl, detectPlatformName };
