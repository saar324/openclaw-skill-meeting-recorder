/**
 * Configuration Loader
 *
 * Loads configuration from config.json with sensible defaults.
 * Also loads environment variables from .env file if present.
 */

const fs = require("fs");
const path = require("path");

const SKILL_DIR = path.dirname(__dirname);
const CONFIG_FILE = path.join(SKILL_DIR, "config.json");
const ENV_FILE = path.join(SKILL_DIR, ".env");

// Default configuration
const DEFAULTS = {
    botName: "Meeting Bot",
    language: "en",
    meeting: {
        emptyTimeoutMinutes: 15,
        skipTranscriptionOnEmptyLeave: true,
    },
    chrome: {
        debuggingPort: 9222,
        display: ":98",
        userDataDir: "/tmp/chrome-meeting",
    },
    recording: {
        outputDir: "~/meeting-transcripts",
        sampleRate: 16000,
        channels: 1,
    },
    transcription: {
        model: "small",
        language: "auto",
    },
    calendar: {
        enabled: false,
        joinBeforeMinutes: 2,
        scheduleHours: "7-18",
        scheduleDays: "0-4",
    },
    whatsapp: {
        enabled: false,
        allowList: ["*"],
        blockList: [],
        autoAnswerDelaySec: 3,
        maxCallDurationMin: 120,
    },
    metadata: {
        enabled: true,
        provider: "openrouter",
        model: "anthropic/claude-3-haiku",
    },
};

let _config = null;
let _envLoaded = false;

/**
 * Load environment variables from .env file
 */
function loadEnv() {
    if (_envLoaded) return;
    _envLoaded = true;

    if (fs.existsSync(ENV_FILE)) {
        const content = fs.readFileSync(ENV_FILE, "utf8");
        const lines = content.split("\n");

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;

            const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
            if (match) {
                let [, key, value] = match;
                // Remove surrounding quotes if present
                value = value.replace(/^["']|["']$/g, "");
                process.env[key] = value;
            }
        }
    }
}

/**
 * Deep merge two objects (source into target)
 */
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (
            source[key] &&
            typeof source[key] === "object" &&
            !Array.isArray(source[key]) &&
            target[key] &&
            typeof target[key] === "object"
        ) {
            result[key] = deepMerge(target[key], source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

/**
 * Load configuration from config.json
 * Merges with defaults and caches the result
 *
 * @param {boolean} reload - Force reload from disk
 * @returns {object} Configuration object
 */
function loadConfig(reload = false) {
    if (_config && !reload) return _config;

    // Load environment first
    loadEnv();

    let userConfig = {};

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const content = fs.readFileSync(CONFIG_FILE, "utf8");
            userConfig = JSON.parse(content);
        } catch (e) {
            console.error("Warning: Failed to parse config.json:", e.message);
        }
    }

    // Merge user config over defaults
    _config = deepMerge(DEFAULTS, userConfig);

    // Expand ~ in output directory
    if (_config.recording.outputDir.startsWith("~")) {
        _config.recording.outputDir = _config.recording.outputDir.replace(
            "~",
            process.env.HOME || "/root"
        );
    }

    return _config;
}

/**
 * Get a specific config value by path (e.g., "chrome.debuggingPort")
 */
function getConfig(path, defaultValue = undefined) {
    const config = loadConfig();
    const parts = path.split(".");
    let current = config;

    for (const part of parts) {
        if (current === undefined || current === null) {
            return defaultValue;
        }
        current = current[part];
    }

    return current !== undefined ? current : defaultValue;
}

/**
 * Get the skill directory path
 */
function getSkillDir() {
    return SKILL_DIR;
}

/**
 * Get calendar environment variables for gog CLI
 */
function getCalendarEnv() {
    loadEnv();
    return {
        GOG_ACCOUNT: process.env.GOG_ACCOUNT || "",
        GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND || "file",
        GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || "",
    };
}

module.exports = {
    loadConfig,
    getConfig,
    getSkillDir,
    getCalendarEnv,
    SKILL_DIR,
};
