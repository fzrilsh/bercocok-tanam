const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { getConfig, ROOT_DIR } = require("./config");

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = path.join(ROOT_DIR, "gmail-token.json");

let cachedClient = null;

function getCredentialsPath() {
    const config = getConfig();
    return path.resolve(ROOT_DIR, config.gmailCredentialsFile || "creedentials.json");
}

async function getGmailClient(log = console.log) {
    if (cachedClient) return cachedClient;

    const credPath = getCredentialsPath();
    if (!fs.existsSync(credPath)) {
        throw new Error(`Gmail credentials file not found: ${credPath}. Set GMAIL_CREDENTIALS_FILE in .env`);
    }

    const raw = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    const installed = raw.installed || raw.web;
    if (!installed) {
        throw new Error("Invalid credentials format: expected 'installed' or 'web' key");
    }

    const { client_secret, client_id, redirect_uris } = installed;
    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris?.[0] || "http://localhost",
    );

    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
        oAuth2Client.setCredentials(token);
    } else {
        log("[Gmail] First-time setup: browser consent required");
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: "offline",
            scope: SCOPES,
            prompt: "consent",
        });
        log(`[Gmail] Open this URL in browser:\n${authUrl}`);

        const code = await new Promise((resolve, reject) => {
            process.stdout.write("[Gmail] Enter the authorization code: ");
            process.stdin.once("data", (data) => {
                const input = data.toString().trim();
                if (!input) reject(new Error("No code entered"));
                else resolve(input);
            });
            process.stdin.once("error", reject);
        });

        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        log(`[Gmail] Token cached to ${TOKEN_PATH}`);
    }

    cachedClient = google.gmail({ version: "v1", auth: oAuth2Client });
    return cachedClient;
}

function getBaseAddress() {
    const config = getConfig();
    return config.gmailBaseAddress || "";
}

function generatePlusAddress(accountIndex = 0, prefix = "github") {
    const base = getBaseAddress();
    if (!base) throw new Error("GMAIL_BASE_ADDRESS not configured");

    const [localPart, domain] = base.split("@");
    if (!domain) throw new Error(`Invalid GMAIL_BASE_ADDRESS: ${base}`);

    const suffix = String(accountIndex + 1).padStart(6, "0");
    return `${localPart}+${prefix}${suffix}@${domain}`;
}

function extractBaseAddress(plusAddress) {
    const [localPart, domain] = plusAddress.split("@");
    if (!localPart || !domain) return plusAddress;
    const baseLocal = localPart.split("+")[0];
    return `${baseLocal}@${domain}`;
}

async function readInbox(query, maxResults = 10, log = console.log) {
    const gmail = await getGmailClient(log);

    const listRes = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) return [];

    const results = [];
    for (const msg of messages) {
        const full = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "full",
        });

        const headers = full.data.payload?.headers || [];
        const from = headers.find((h) => h.name === "From")?.value || "";
        const subject = headers.find((h) => h.name === "Subject")?.value || "";
        const to = headers.find((h) => h.name === "To")?.value || "";

        let body = "";
        const payload = full.data.payload;
        if (payload?.body?.data) {
            body = Buffer.from(payload.body.data, "base64").toString("utf-8");
        } else if (payload?.parts) {
            for (const part of payload.parts) {
                if (part.mimeType === "text/html" && part.body?.data) {
                    body = Buffer.from(part.body.data, "base64").toString("utf-8");
                    break;
                }
                if (part.mimeType === "text/plain" && part.body?.data && !body) {
                    body = Buffer.from(part.body.data, "base64").toString("utf-8");
                }
            }
        }

        results.push({ from, subject, to, body, id: msg.id });
    }

    return results;
}

async function waitForEmail(options = {}) {
    const {
        matcher,
        query,
        maxAttempts = 30,
        pollInterval = 5000,
        log = console.log,
    } = options;

    if (!matcher || typeof matcher !== "function") {
        throw new Error("matcher function is required");
    }

    const searchQuery = query || "newer_than:1h";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log(`[Gmail] Polling inbox (attempt ${attempt}/${maxAttempts})...`);

        try {
            const messages = await readInbox(searchQuery, 10, log);
            for (const msg of messages) {
                const result = matcher(msg);
                if (result !== null && result !== undefined) {
                    return result;
                }
            }
        } catch (error) {
            log(`[Gmail] Polling error: ${error.message}`);
        }

        await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(`[Gmail] Email not received within timeout (${maxAttempts} attempts)`);
}

const GmailMatchers = {
    launchCode: (msg) => {
        if (!msg.from.includes("noreply@github.com")) return null;
        if (!msg.subject.toLowerCase().includes("launch code")) return null;

        const spanMatch = msg.body.match(
            /<span class="f00-light text-gray-dark sans-serif text-semibold"[^>]*>(\d{8})<\/span>/,
        );
        if (spanMatch) return spanMatch[1];

        const plainMatch = msg.body.match(/(\d{8})/);
        if (plainMatch) return plainMatch[1];

        return null;
    },

    deviceVerification: (msg) => {
        if (!msg.from.includes("noreply@github.com")) return null;

        const subject = msg.subject.toLowerCase();
        if (!subject.includes("verify") &&
            !subject.includes("device") &&
            !subject.includes("authentication") &&
            !subject.includes("code")) {
            return null;
        }

        const match = msg.body.match(/\b(\d{6})\b/) ||
                     msg.body.match(/[Cc]ode[:\s]+(\d{6})/);

        return match ? match[1] : null;
    },

    genericOTP: (msg) => {
        const match = msg.body.match(/\b(\d{4,8})\b/);
        return match ? match[1] : null;
    },
};

async function waitForGitHubOTP(maxAttempts = 30, log = console.log) {
    log("[Gmail] Waiting for GitHub launch code...");
    const code = await waitForEmail({
        matcher: GmailMatchers.launchCode,
        query: "from:noreply@github.com newer_than:1h",
        maxAttempts,
        pollInterval: 5000,
        log,
    });
    log(`[Gmail] GitHub OTP code received: ${code}`);
    return code;
}

async function waitForGitHubDeviceOTP(maxAttempts = 15, log = console.log) {
    log("[Gmail] Waiting for GitHub device verification code...");
    const code = await waitForEmail({
        matcher: GmailMatchers.deviceVerification,
        query: "from:noreply@github.com newer_than:1h",
        maxAttempts,
        pollInterval: 3000,
        log,
    });
    log(`[Gmail] Device OTP received: ${code}`);
    return code;
}

module.exports = {
    getGmailClient,
    generatePlusAddress,
    extractBaseAddress,
    readInbox,
    waitForEmail,
    waitForGitHubOTP,
    waitForGitHubDeviceOTP,
    GmailMatchers,
};
