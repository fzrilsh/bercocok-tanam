const axios = require("axios");
const { generatePlusAddress } = require("./gmail-helper");

// Provider 1: ncaori.my.id domains (stateless)
const NCAORI_DOMAINS = [
    "@ncaori.my.id",
    "@nca.my.id",
    "@nicoz2.ncait.it.com",
    "@kmx.ncait.it.com",
    "@nazox.ncait.it.com",
    "@storu.ncait.it.com",
    "@cinx.ncait.it.com",
    "@zxm.ncait.it.com",
    "@ij09.ncait.it.com",
    "@0okjad.ncait.it.com",
    "@mcnaz.ncait.it.com",
    "@ncaorinjcz.ncait.it.com",
    "@proror.ncait.it.com",
    "@prabowoz.ncait.it.com",
    "@jnkajnc.ncait.it.com",
    "@kmnx.ncait.it.com",
    "@39-knc.my.id",
    "@3aberkaskf-hafi.my.id",
    "@3hi-kokih.my.id",
    "@3himnih.my.id",
    "@apekah.my.id",
    "@bsigroup.biz.id",
    "@phydigile.biz.id",
    "@multho-vbe.my.id",
    "@nacima.my.id",
    "@ncaei.my.id",
];

// Provider 2: 1secemail.com domains (stateful)
const SECEMAIL_DOMAINS = ["gaziw.com", "sakibbd.xyz"];

let emailCounter = 0;

function generateRandomString(length) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function randomUA() {
    const uas = [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    ];
    return uas[Math.floor(Math.random() * uas.length)];
}

/**
 * Create temp email via ncaori.my.id (stateless provider)
 * @returns {{ email, provider: "ncaori", userAgent }}
 */
async function createTempEmailNcaori(accountIndex = null, log = console.log) {
    log("Creating temporary email (ncaori)...");

    const userAgent = randomUA();
    const emailNameLength = 8 + Math.floor(Math.random() * 5);
    const emailName = generateRandomString(emailNameLength);
    const index = accountIndex !== null ? accountIndex : emailCounter++;
    const domain = NCAORI_DOMAINS[index % NCAORI_DOMAINS.length];
    const email = emailName + domain;

    log(`Temporary email created: ${email}`);
    log(`Using domain ${domain} (${(index % NCAORI_DOMAINS.length) + 1}/${NCAORI_DOMAINS.length})`);

    return {
        email,
        provider: "ncaori",
        userAgent,
    };
}

/**
 * Create temp mailbox via 1secemail.com (stateful provider)
 * @returns {{ email, provider: "1secemail", csrfToken, cookies, userAgent }}
 */
async function createTempEmailSecemail(accountIndex = null, log = console.log) {
    log("Creating temporary email (1secemail)...");

    const userAgent = randomUA();
    const htmlHeaders = {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.5",
        "cache-control": "no-cache",
        pragma: "no-cache",
        referer: "https://www.google.com/",
        "user-agent": userAgent,
    };

    const htmlResponse = await axios.get("https://www.1secemail.com/", {
        headers: htmlHeaders,
    });
    const html = htmlResponse.data;
    const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)">/);
    if (!csrfMatch) {
        throw new Error("Failed to extract CSRF token from 1secemail.com");
    }
    const csrfToken = csrfMatch[1];
    log(`CSRF token extracted: ${csrfToken.substring(0, 10)}...`);

    const messageHeaders = {
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.5",
        "cache-control": "no-cache",
        "content-type": "application/json",
        origin: "https://www.1secemail.com",
        pragma: "no-cache",
        referer: "https://www.1secemail.com/",
        "user-agent": userAgent,
    };

    log("Creating email session...");
    const createResponse = await axios.post(
        "https://www.1secemail.com/get_messages",
        { _token: csrfToken },
        { headers: messageHeaders },
    );

    const setCookieHeaders = createResponse.headers["set-cookie"];
    if (!setCookieHeaders || setCookieHeaders.length === 0) {
        throw new Error("Failed to get cookies from email creation");
    }
    const cookies = setCookieHeaders.map((c) => c.split(";")[0]).join("; ");

    let xsrfTokenDecoded = "";
    const xsrfCookie = setCookieHeaders.find(c => c.startsWith("XSRF-TOKEN="));
    if (xsrfCookie) {
        const rawTokenValue = xsrfCookie.split(";")[0].split("=")[1];
        xsrfTokenDecoded = decodeURIComponent(rawTokenValue);
    }

    const emailNameLength = 8 + Math.floor(Math.random() * 5);
    const emailName = generateRandomString(emailNameLength);
    const index = accountIndex !== null ? accountIndex : emailCounter++;
    const domain = SECEMAIL_DOMAINS[index % SECEMAIL_DOMAINS.length];
    log(`Using domain ${domain} (${(index % SECEMAIL_DOMAINS.length) + 1}/${SECEMAIL_DOMAINS.length})`);

    const changeHeaders = {
        ...messageHeaders,
        cookie: cookies,
        "X-XSRF-TOKEN": xsrfTokenDecoded
    };

    log(`Changing mailbox to: ${emailName}@${domain}`);
    let changeResponse;
    try {
        changeResponse = await axios.post(
            "https://www.1secemail.com/change",
            { name: emailName, domain },
            { headers: changeHeaders }
        );
    } catch (error) {
        throw new Error(`Failed to change mailbox: ${error.response?.data?.message || error.message}`);
    }

    const data = changeResponse.data;
    if (!data.mailbox) {
        throw new Error(`Failed to create temporary email: ${JSON.stringify(data)}`);
    }

    let finalCookies = cookies;
    const changeCookies = changeResponse.headers["set-cookie"];
    if (changeCookies && changeCookies.length) {
        const map = {};
        [...cookies.split("; "), ...changeCookies.map((c) => c.split(";")[0])].forEach((pair) => {
            const [k, ...rest] = pair.trim().split("=");
            if (k) map[k] = rest.join("=");
        });
        finalCookies = Object.entries(map)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
    }

    const email = data.mailbox;
    log(`Temporary email created: ${email}`);

    return {
        email,
        provider: "1secemail",
        csrfToken,
        cookies: finalCookies,
        userAgent,
    };
}

/**
 * Create Gmail plus-address (stateless — OTP read from base Gmail inbox via API)
 * @returns {{ email, provider: "gmail", userAgent }}
 */
async function createTempEmailGmail(accountIndex = null, log = console.log) {
    log("Creating Gmail plus-address...");

    const userAgent = randomUA();
    const index = accountIndex !== null ? accountIndex : emailCounter++;
    const email = generatePlusAddress(index, "github");

    log(`Gmail plus-address created: ${email}`);

    return {
        email,
        provider: "gmail",
        userAgent,
    };
}

/**
 * Create temp email with provider selection
 * @param {number|null} accountIndex - Account index for domain rotation
 * @param {function} log - Logging function
 * @param {string|string[]} provider - "ncaori", "1secemail", "auto", or ["ncaori", "1secemail"] for random selection from array
 * @returns {Promise<{email: string, provider: string, userAgent: string, csrfToken?: string, cookies?: string}>}
 */
async function createTempEmail(accountIndex = null, log = console.log, provider = "auto") {
    const availableProviders = ["ncaori", "1secemail", "gmail"];
    let selectedProvider = provider;
    
    // Handle array input - randomly select from provided array
    if (Array.isArray(provider)) {
        if (provider.length === 0) {
            throw new Error("Provider array cannot be empty");
        }
        
        // Validate all providers in array
        const invalidProviders = provider.filter(p => !availableProviders.includes(p));
        if (invalidProviders.length > 0) {
            throw new Error(`Invalid providers in array: ${invalidProviders.join(", ")}. Use "ncaori", "1secemail", or "gmail"`);
        }
        
        selectedProvider = provider[Math.floor(Math.random() * provider.length)];
        log(`Random-selected provider from [${provider.join(", ")}]: ${selectedProvider}`);
    }
    // Handle "auto" - randomly select from all available providers
    else if (provider === "auto") {
        selectedProvider = availableProviders[Math.floor(Math.random() * availableProviders.length)];
        log(`Auto-selected provider: ${selectedProvider}`);
    }
    // Handle single provider string
    else if (typeof provider === "string") {
        if (!availableProviders.includes(provider)) {
            throw new Error(`Unknown provider: ${provider}. Use "ncaori", "1secemail", "gmail", "auto", or array like ["ncaori", "1secemail"]`);
        }
        selectedProvider = provider;
    }
    else {
        throw new Error(`Invalid provider type: ${typeof provider}. Use string or array`);
    }

    if (selectedProvider === "ncaori") {
        return await createTempEmailNcaori(accountIndex, log);
    } else if (selectedProvider === "1secemail") {
        return await createTempEmailSecemail(accountIndex, log);
    } else if (selectedProvider === "gmail") {
        return await createTempEmailGmail(accountIndex, log);
    } else {
        throw new Error(`Unknown provider after selection: ${selectedProvider}`);
    }
}

/**
 * Poll messages from the appropriate provider
 * Returns normalized message format regardless of provider
 */
async function pollMessages(session, log) {
    if (session.provider === "ncaori") {
        const headers = {
            accept: "*/*",
            "accept-language": "en-US,en;q=0.7",
            "cache-control": "no-cache",
            pragma: "no-cache",
            priority: "u=1, i",
            referer: "https://www.ncaori.my.id/",
            "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"macOS"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "sec-gpc": "1",
            "user-agent": session.userAgent,
        };

        const response = await axios.get(
            `https://www.ncaori.my.id/api/emails?recipient=${encodeURIComponent(session.email)}`,
            { headers }
        );

        const emails = response.data.emails || [];
        return emails.map(msg => ({
            from: msg.sender || "",
            subject: msg.subject || "",
            body: msg.body_html || msg.body_text || "",
        }));

    } else if (session.provider === "1secemail") {
        const headers = {
            accept: "application/json, text/plain, */*",
            "accept-language": "en-US,en;q=0.5",
            "cache-control": "no-cache",
            "content-type": "application/json",
            cookie: session.cookies,
            origin: "https://www.1secemail.com",
            pragma: "no-cache",
            referer: "https://www.1secemail.com/",
            "user-agent": session.userAgent,
        };

        const response = await axios.post(
            "https://www.1secemail.com/get_messages",
            { _token: session.csrfToken },
            { headers }
        );

        const messages = response.data.messages || [];
        return messages.map(msg => ({
            from: msg.from_email || "",
            subject: msg.subject || "",
            body: msg.content || "",
        }));
    } else if (session.provider === "gmail") {
        const { readInboxMetadata, readMessageBody } = require("./gmail-helper");
        const query = `to:${session.email} newer_than:5m`;
        const metaMsgs = await readInboxMetadata(query, 5, log);
        const results = [];
        for (const msg of metaMsgs) {
            const body = await readMessageBody(msg.id, log);
            results.push({
                from: msg.from || "",
                subject: msg.subject || "",
                body: body || "",
            });
        }
        return results;
    } else {
        throw new Error(`Unknown provider: ${session.provider}`);
    }
}

/**
 * Generic email polling with custom matcher
 * @param {string|object} sessionOrEmail - Session object or email string (for backward compat)
 * @param {object} options - Polling options
 * @param {function} options.matcher - Function that receives message and returns extracted value or null
 * @param {number} options.maxAttempts - Max polling attempts (default 30)
 * @param {number} options.pollInterval - Interval between polls in ms (default 5000)
 * @param {function} options.log - Logging function
 * @returns {Promise<any>} - Returns the value from matcher when found
 */
async function waitForEmail(sessionOrEmail, options = {}) {
    const {
        matcher,
        maxAttempts = 30,
        pollInterval = 5000,
        log = console.log,
    } = options;

    if (!matcher || typeof matcher !== "function") {
        throw new Error("matcher function is required");
    }

    let session = sessionOrEmail;
    
    // Backward compatibility: if string email passed, detect provider from domain
    if (typeof sessionOrEmail === "string") {
        const email = sessionOrEmail;
        const isNcaori = NCAORI_DOMAINS.some(domain => email.endsWith(domain));
        const isSecemail = SECEMAIL_DOMAINS.some(domain => email.includes(`@${domain}`));
        
        if (isNcaori) {
            session = {
                email,
                provider: "ncaori",
                userAgent: randomUA(),
            };
            log(`Detected ncaori provider from email domain`);
        } else if (isSecemail) {
            log(`Warning: 1secemail email without session - cannot poll (need csrfToken/cookies)`);
            throw new Error("1secemail emails require session object with csrfToken and cookies");
        } else if (email.includes("@gmail.com") || email.includes("+")) {
            session = {
                email,
                provider: "gmail",
                userAgent: randomUA(),
            };
            log(`Detected gmail provider from email address`);
        } else {
            log(`Warning: Unknown email domain, attempting ncaori...`);
            session = {
                email,
                provider: "ncaori",
                userAgent: randomUA(),
            };
        }
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log(`Polling emails (attempt ${attempt}/${maxAttempts})...`);

        try {
            const messages = await pollMessages(session, log);

            for (const msg of messages) {
                const result = matcher(msg);
                if (result !== null && result !== undefined) {
                    return result;
                }
            }
        } catch (error) {
            log(`Error polling emails: ${error.message}`);
        }

        await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(`Email not received within timeout (${maxAttempts} attempts)`);
}

// GitHub-specific matchers (for convenience)
const GitHubMatchers = {
    /**
     * Match GitHub launch code (8-digit OTP for signup)
     */
    launchCode: (msg) => {
        if (!msg.from.includes("noreply@github.com")) return null;
        if (!msg.subject.toLowerCase().includes("launch code")) return null;
        
        const spanMatch = msg.body.match(
            /<span class="f00-light text-gray-dark sans-serif text-semibold"[^>]*>(\d{8})<\/span>/
        );
        if (spanMatch) return spanMatch[1];
        
        const plainMatch = msg.body.match(/(\d{8})/);
        if (plainMatch) return plainMatch[1];
        
        return null;
    },

    /**
     * Match GitHub device verification code (6-digit OTP)
     */
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
};

/**
 * Convenience wrapper for GitHub launch code (backward compat)
 */
async function waitForGitHubOTP(session, maxAttempts = 30, log = console.log) {
    log(`Waiting for GitHub launch code (${session.provider})...`);
    const code = await waitForEmail(session, {
        matcher: GitHubMatchers.launchCode,
        maxAttempts,
        pollInterval: 5000,
        log,
    });
    log(`GitHub OTP code received: ${code}`);
    return code;
}

/**
 * Convenience wrapper for GitHub device verification (backward compat)
 */
async function waitForGitHubDeviceOTP(sessionOrEmail, maxAttempts = 15, log = console.log) {
    log(`Waiting for GitHub device verification code...`);
    const code = await waitForEmail(sessionOrEmail, {
        matcher: GitHubMatchers.deviceVerification,
        maxAttempts,
        pollInterval: 3000,
        log,
    });
    log(`Device OTP received: ${code}`);
    return code;
}

module.exports = {
    createTempEmail,
    pollMessages,
    waitForEmail,
    waitForGitHubOTP,
    waitForGitHubDeviceOTP,
    GitHubMatchers,
    NCAORI_DOMAINS,
    SECEMAIL_DOMAINS,
};
