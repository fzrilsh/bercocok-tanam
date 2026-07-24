const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");

const DEFAULT_CHROME_PATH =
  "/Volumes/StorageTeamGroup/Browser/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_ROUTER_URL = "http://127.0.0.1:20128/";
const DEFAULT_ACCOUNT_FILE_NAME = "accounts.txt";
const DEFAULT_RESULT_FILE_TEMPLATE = "{provider}_keys.txt";
const DEFAULT_ERROR_ACCOUNT_FILE_NAME = "errorAccounts.txt";
const DEFAULT_PROXY_POOL_FILE_NAME = "proxy_keys.txt";

const DEFAULT_BROWSER_ARGS_SETS = [
    [
        "--incognito",
        "--disable-extensions",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=BlockThirdPartyCookies",
        "--disable-site-isolation-trials",
        "--disable-web-security",
    ],
    [
        "--incognito",
        "--disable-extensions",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=BlockThirdPartyCookies",
        "--disable-site-isolation-trials",
        "--disable-web-security",
    ],
];

const SHARED_SELECTORS = {
    googleSignIn: "::-p-text(Google)",
    iUnderstand: "::-p-text(I understand)",
    loginOptions: [
        "::-p-text(Allow)",
        "::-p-text(Continue)",
        "::-p-text(Accept)",
        "::-p-text(Lanjutkan)",
        "main > div:nth-child(3) > div > div > div:nth-child(2) > div > div > button"
    ],
};

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    const env = {};
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine.startsWith("#")) {
            continue;
        }

        const separatorIndex = trimmedLine.indexOf("=");

        if (separatorIndex === -1) {
            continue;
        }

        const key = trimmedLine.slice(0, separatorIndex).trim();
        let value = trimmedLine.slice(separatorIndex + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        env[key] = value;
    }

    return env;
}

function toPositiveNumber(value, fallback) {
    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBrowserArgsSets(value) {
    if (!value) {
        return DEFAULT_BROWSER_ARGS_SETS;
    }

    try {
        const parsed = JSON.parse(value);

        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error("BROWSER_ARGS_SETS must be non-empty array");
        }

        return parsed.map((entry) => {
            if (
                !Array.isArray(entry) ||
        entry.some((arg) => typeof arg !== "string")
            ) {
                throw new Error("Each browser arg set must be array of strings");
            }

            return entry;
        });
    } catch (error) {
        throw new Error(`Invalid BROWSER_ARGS_SETS: ${error.message}`);
    }
}

function parseTempEmailProvider(value) {
    if (!value) {
        return "auto";
    }

    // Try to parse as JSON array
    if (value.startsWith("[")) {
        try {
            const parsed = JSON.parse(value);
            if (!Array.isArray(parsed) || parsed.length === 0) {
                throw new Error("TEMP_EMAIL_PROVIDER array must be non-empty");
            }
            const validProviders = ["ncaori", "1secemail", "gmail", "mailcx"];
            const invalidProviders = parsed.filter(p => !validProviders.includes(p));
            if (invalidProviders.length > 0) {
                throw new Error(`Invalid providers: ${invalidProviders.join(", ")}. Use "ncaori", "1secemail", "gmail", or "mailcx"`);
            }
            return parsed;
        } catch (error) {
            throw new Error(`Invalid TEMP_EMAIL_PROVIDER array: ${error.message}`);
        }
    }

    // Single provider string
    const validProviders = ["auto", "ncaori", "1secemail", "gmail", "mailcx"];
    if (!validProviders.includes(value)) {
        throw new Error(`Invalid TEMP_EMAIL_PROVIDER: ${value}. Use "auto", "ncaori", "1secemail", "gmail", "mailcx", or array like ["ncaori","1secemail"]`);
    }
    return value;
}

function parseMailCxDomains(value) {
    if (!value) return [];
    const raw = value.trim();
    if (raw.startsWith("[")) {
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error("must be array");
            return parsed.map((d) => String(d).trim()).filter(Boolean);
        } catch (error) {
            throw new Error(`Invalid MAIL_CX_DOMAINS: ${error.message}`);
        }
    }
    return raw.split(/[,\s]+/).map((d) => d.trim()).filter(Boolean);
}

function createConfig() {
    const env = { ...loadEnvFile(ENV_PATH), ...process.env };

    return {
        headless: (env.PW_HEADLESS || "1") !== "0",
        browserCount: Math.max(1, toPositiveNumber(env.BROWSER_COUNT, 1)),
        slowMo: toPositiveNumber(env.BROWSER_SLOW_MO, 2),
        routerUrl: env.ROUTER_URL || DEFAULT_ROUTER_URL,
        routerPassword: env.ROUTER_PASS || env.ROUTER_PASSWORD || '',
        chromeExecutablePath: env.CHROME_EXECUTABLE_PATH || DEFAULT_CHROME_PATH,
        accountFile: path.resolve(
            ROOT_DIR,
            env.ACCOUNT_FILE || DEFAULT_ACCOUNT_FILE_NAME,
        ),
        resultFileTemplate: env.RESULT_FILE || DEFAULT_RESULT_FILE_TEMPLATE,
        errorAccountFile: path.resolve(
            ROOT_DIR,
            env.ERROR_ACCOUNT_FILE || DEFAULT_ERROR_ACCOUNT_FILE_NAME,
        ),
        proxyPoolFile: env.PROXY_POOL_FILE ? path.resolve(ROOT_DIR, env.PROXY_POOL_FILE) : null,
        browserArgsSets: parseBrowserArgsSets(env.BROWSER_ARGS_SETS),
        tempEmailProvider: parseTempEmailProvider(env.TEMP_EMAIL_PROVIDER),
        password: env.PASSWORD || 'DefaultPass123!@#',
        grokPassword: env.GROK_PASSWORD || env.PASSWORD || 'DefaultPass123!@#',
        sealUnlockUrl: env.SEAL_UNLOCK_URL || '',
        sealToken: env.SEAL_TOKEN || '',
        sealKey: env.SEAL_KEY || '',
        turnstileExtPath: env.TURNSTILE_EXT_PATH || '',
        gmailCredentialsFile: env.GMAIL_CREDENTIALS_FILE || 'creedentials.json',
        gmailBaseAddress: env.GMAIL_BASE_ADDRESS || '',
        mailCxApiToken: env.MAIL_CX_API_TOKEN || env.MAILCX_API_TOKEN || '',
        mailCxDomains: parseMailCxDomains(env.MAIL_CX_DOMAINS || env.MAILCX_DOMAINS || ''),
        delays: {
            beforeNextClick: toPositiveNumber(env.DELAY_BEFORE_NEXT_CLICK_MS, 1000),
            betweenAccounts: toPositiveNumber(env.DELAY_BETWEEN_ACCOUNTS_MS, 3000),
            beforeBrowserClose: toPositiveNumber(
                env.DELAY_BEFORE_BROWSER_CLOSE_MS,
                3000,
            ),
            beforeReadingCookies: toPositiveNumber(
                env.DELAY_BEFORE_READING_COOKIES_MS,
                5000,
            ),
        },
        timeouts: {
            navigation: toPositiveNumber(env.TIMEOUT_NAVIGATION_MS, 60000),
            default: toPositiveNumber(env.TIMEOUT_DEFAULT_MS, 15000),
            short: toPositiveNumber(env.TIMEOUT_SHORT_MS, 10000),
        },
    };
}

function updateEnvValue(key, value) {
    let content = "";

    if (fs.existsSync(ENV_PATH)) {
        content = fs.readFileSync(ENV_PATH, "utf-8");
    }

    const lines = content.split(/\r?\n/);
    let found = false;

    const updatedLines = lines.map((line) => {
        const trimmed = line.trim();

        if (trimmed.startsWith("#") || !trimmed) {return line;}

        const sepIdx = trimmed.indexOf("=");

        if (sepIdx === -1) {return line;}

        const lineKey = trimmed.slice(0, sepIdx).trim();

        if (lineKey === key) {
            found = true;

            return `${key}=${value}`;
        }

        return line;
    });

    if (!found) {
        updatedLines.push(`${key}=${value}`);
    }

    fs.writeFileSync(ENV_PATH, updatedLines.join("\n"));
}

let CONFIG = createConfig();

function reloadConfig() {
    CONFIG = createConfig();

    return CONFIG;
}

function getConfig() {
    return CONFIG;
}

function getResultFile(provider) {
    const config = getConfig();
    const fileName = config.resultFileTemplate.replace(/\{provider\}/g, provider);

    return path.resolve(ROOT_DIR, fileName);
}

module.exports = {
    ROOT_DIR,
    ENV_PATH,
    getConfig,
    getResultFile,
    reloadConfig,
    createConfig,
    updateEnvValue,
    loadEnvFile,
    SHARED_SELECTORS,
};
