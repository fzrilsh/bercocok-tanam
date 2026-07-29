/* global URLSearchParams, URL */
const crypto = require("crypto");
const { getConfig } = require("../../config");
const {
    sleep,
    readAccounts,
    chunkAccounts,
    createFileLogger,
    formatDuration,
} = require("../../utils");
const { completeGoogleLogin } = require("../../providers/google/login");
const { createAxiosInstance, axiosRequestWithRetry } = require("../shared/http-client");
const oauth = require("../shared/oauth");
const { STEPS, createProgressManager } = require("../../cli/progress");
const { printReport } = require("../../cli/reporter");
const { TokenGoWorker, ProxyRateLimitError } = require("./TokenGoWorker");

const QUEUE_RETRY_DELAY_MS = 500;
const TOKENGO_DASHBOARD = "https://dashboard.tokengo.com";
const TOKENGO_API = `${TOKENGO_DASHBOARD}/api`;
const GOOGLE_OAUTH_CLIENT_ID = "179756334592-01g164h5sapm5iaj7rvvd0vg864rfpte.apps.googleusercontent.com";
const GITHUB_OAUTH_CLIENT_ID = "Ov23limywUEd7JK16Ekv";

async function executeGoogleOAuthAndIntercept(page, account, oauthUrl, oauthState, log) {
    log("Phase 1: Starting Google OAuth flow...");

    let interceptedCode = null;
    let interceptedState = null;
    let intercepted = false; // Flag to prevent double-intercept

    await page.setRequestInterception(true);

    page.on("request", (request) => {
        const url = request.url();

        // If already intercepted, just continue all other requests
        if (intercepted) {
            request.continue();
            return;
        }

        try {
            const urlObj = new URL(url);

            // CRITICAL FIX: Check EXACT hostname + pathname (not .includes()!)
            // Prevents false matches from Google internal URLs with redirect_uri in query params
            if (urlObj.hostname === "dashboard.tokengo.com" && urlObj.pathname.startsWith("/oauth/google")) {
                intercepted = true; // Set flag immediately to prevent race condition

                interceptedCode = urlObj.searchParams.get("code");
                interceptedState = urlObj.searchParams.get("state");

                log(`🎯 JACKPOT! Intercepted REAL callback: ${url.substring(0, 80)}...`);
                log(`Extracted code: ${interceptedCode?.substring(0, 20)}...`);
                log(`Extracted state: ${interceptedState}`);

                // Validate state matches original
                if (interceptedState !== oauthState) {
                    log(`⚠️  WARNING: State mismatch! Expected ${oauthState}, got ${interceptedState}`);
                }

                // ABORT before reaching TokenGo server!
                request.abort();
            } else {
                request.continue();
            }
        } catch (err) {
            // If URL parsing fails, let browser continue naturally
            log(`URL parse warning: ${err.message}`);
            request.continue();
        }
    });

    log("Navigating to Google OAuth URL...");
    await page.goto(oauthUrl, { waitUntil: "networkidle2" });

    log("Completing Google login...");
    await completeGoogleLogin(page, account, log);

    log("Calling handlePostLogin...");
    await handlePostLogin(page, log);

    log("Waiting for redirect interception...");
    const maxWait = 30000;
    const startTime = Date.now();

    while (!interceptedCode && (Date.now() - startTime) < maxWait) {
        await sleep(500);
    }

    if (!interceptedCode || !interceptedState) {
        throw new Error("Failed to intercept OAuth callback code/state");
    }

    log("OAuth callback intercepted successfully!");

    return { code: interceptedCode, state: interceptedState };
}

async function handlePostLogin(page, log) {
    const config = getConfig();
    const SHARED_SELECTORS = require("../../config").SHARED_SELECTORS;
    const { clickSelector, clickFirstVisibleSelector } = require("../../browser/helpers");

    try {
        log("Clicking I Understand...");
        await clickSelector(page, SHARED_SELECTORS.iUnderstand, {
            timeout: config.timeouts.short,
            delayBeforeClick: config.delays.beforeNextClick,
        });
    } catch (_) {
        log("No I Understand button found");
    }

    try {
        log("Clicking Login/Allow/Continue...");
        await page.keyboard.press("End");

        await clickFirstVisibleSelector(
            page,
            SHARED_SELECTORS.loginOptions,
            config.timeouts.short,
        );
    } catch (_) {
        log("No Login button found");
    }
}

async function executeGitHubOAuthAndIntercept(page, account, oauthUrl, oauthState, log) {
    log("Phase 1: Starting GitHub OAuth flow...");

    let interceptedCode = null;
    let interceptedState = null;
    let intercepted = false;

    await page.setRequestInterception(true);

    page.on("request", (request) => {
        const url = request.url();

        if (intercepted) {
            request.continue();
            return;
        }

        try {
            const urlObj = new URL(url);

            if (urlObj.hostname === "dashboard.tokengo.com" && urlObj.pathname.startsWith("/oauth/github")) {
                intercepted = true;

                interceptedCode = urlObj.searchParams.get("code");
                interceptedState = urlObj.searchParams.get("state");

                log(`🎯 Intercepted GitHub callback: code=${interceptedCode?.substring(0, 20)}...`);
                request.abort();
            } else {
                request.continue();
            }
        } catch (err) {
            request.continue();
        }
    });

    log("Navigating to GitHub OAuth URL...");
    await page.goto(oauthUrl, { waitUntil: "networkidle2" });

    log("Filling GitHub login form...");
    const emailInput = await page.waitForSelector("input#login_field", { timeout: 15000, visible: true });
    await emailInput.click({ clickCount: 3 });
    await page.keyboard.type(account.email, { delay: 50 });

    const passwordInput = await page.waitForSelector("input#password", { timeout: 5000, visible: true });
    await passwordInput.click({ clickCount: 3 });
    await page.keyboard.type(account.password, { delay: 50 });

    await sleep(500);
    await page.keyboard.press("Enter");

    log("Waiting for redirect interception...");
    const maxWait = 30000;
    const startTime = Date.now();

    while (!interceptedCode && (Date.now() - startTime) < maxWait) {
        await sleep(500);
    }

    if (!interceptedCode || !interceptedState) {
        throw new Error("Failed to intercept GitHub OAuth callback code/state");
    }

    log("GitHub OAuth callback intercepted successfully!");
    return { code: interceptedCode, state: interceptedState };
}

function buildAuthHeaders(sessionCookie, userId) {
    return {
        "cookie": `session=${sessionCookie}; thorbase_do_not_sell_or_share=true;`,
        "llmapi-user": String(userId),
        "origin": TOKENGO_DASHBOARD,
        "referer": `${TOKENGO_DASHBOARD}/api-keys`,
        "content-type": "application/json",
    };
}

async function createToken(axiosInstance, sessionCookie, userId, log) {
    log("Phase 3.1: Creating new token entry...");

    const randomName = crypto.randomBytes(6).toString("hex");

    const payload = {
        name: randomName,
        expired_time: -1,
        remain_quota: 0,
        unlimited_quota: true,
        group: "default",
    };

    const response = await axiosRequestWithRetry(
        axiosInstance,
        "POST",
        `${TOKENGO_API}/token/`,
        {
            headers: buildAuthHeaders(sessionCookie, userId),
            data: payload,
        },
        log,
    );

    if (response.status !== 200) {
        throw new Error(`Token creation failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
    }

    const data = response.data;

    if (!data.success) {
        throw new Error(`Token creation failed: ${JSON.stringify(data)}`);
    }

    log("Token entry created successfully");
}

async function getTokenId(axiosInstance, sessionCookie, userId, log) {
    log("Phase 3.2: Fetching token list to get token ID...");

    const headers = buildAuthHeaders(sessionCookie, userId);
    delete headers["content-type"];

    const response = await axiosRequestWithRetry(
        axiosInstance,
        "GET",
        `${TOKENGO_API}/token/?p=0&size=5`,
        { headers },
        log,
    );

    if (response.status !== 200) {
        throw new Error(`Token list failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
    }

    const data = response.data;

    if (!data.success || !data.data?.items?.length) {
        throw new Error(`Token list failed or empty: ${JSON.stringify(data)}`);
    }

    const tokenId = data.data.items[0].id;
    log(`Token ID: ${tokenId}`);

    return tokenId;
}

async function revealApiKey(axiosInstance, tokenId, sessionCookie, userId, log) {
    log("Phase 3.4: Revealing API key...");

    const headers = buildAuthHeaders(sessionCookie, userId);
    headers["content-length"] = "0";

    const response = await axiosRequestWithRetry(
        axiosInstance,
        "POST",
        `${TOKENGO_API}/token/${tokenId}/key`,
        {
            headers,
            data: "",
        },
        log,
    );

    if (response.status !== 200) {
        throw new Error(`Key reveal failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
    }

    const data = response.data;

    if (!data.success) {
        throw new Error(`Key reveal failed: ${JSON.stringify(data)}`);
    }

    const apiKey = data.data?.key || data.data;

    if (!apiKey || typeof apiKey !== "string") {
        throw new Error(`Invalid API key format: ${JSON.stringify(data)}`);
    }

    log(`API Key harvested: ${apiKey.substring(0, 20)}...`);

    return apiKey;
}






async function runTokenGoAutomation(sharedProgress = null, useProxy = true, options = {}) {
    const config = getConfig();
    const logger = createFileLogger();
    const authMode = options.authMode || "google";

    let accounts;

    if (options.mode === "create") {
        const { runGitHubSignupAutomation } = require("../../github-signup-python");
        const createCount = options.createCount || 1;
        const tempEmailProvider = options.tempEmailProvider || null;

        logger.log(`Creating ${createCount} GitHub account(s) for TokenGo...`);
        const githubResult = await runGitHubSignupAutomation(createCount, sharedProgress, useProxy, tempEmailProvider);
        if (!githubResult || githubResult.successCount === 0) {
            logger.log("No GitHub accounts created, aborting TokenGo");
            logger.close();
            return null;
        }
    }

    if (authMode === "github") {
        const path = require("path");
        const fs = require("fs");
        const GITHUB_KEYS_FILE = path.join(require("../../config").ROOT_DIR, "github_keys.txt");

        if (!fs.existsSync(GITHUB_KEYS_FILE)) {
            if (!sharedProgress) {
                console.log("No github_keys.txt found. Create GitHub accounts first or use existing accounts.");
            }
            logger.close();
            return null;
        }

        const lines = fs.readFileSync(GITHUB_KEYS_FILE, "utf-8")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));

        accounts = lines.map((rawLine) => {
            const parts = rawLine.includes(":") ? rawLine.split(":") : rawLine.split("|");
            const email = parts[0]?.trim() || "";
            const password = parts[1]?.trim() || "";
            return { email, password, username: parts[2]?.trim() || email.split("@")[0], proxy: null, rawLine };
        }).filter((a) => a.email && a.password);

        if (accounts.length === 0) {
            if (!sharedProgress) {
                console.log("No GitHub accounts found in github_keys.txt");
            }
            logger.close();
            return null;
        }
    } else {
        accounts = readAccounts();
    }

    if (accounts.length === 0) {
        if (!sharedProgress) {
            console.log("No accounts found. Format: email|password or email|password|proxy");
        }
        logger.close();
        return null;
    }

    if (!sharedProgress) {
        console.log("");
        console.log(`🎫 TokenGo automation (${authMode} OAuth) — ${accounts.length} accounts`);
        console.log("");
    }

    const startedAt = Date.now();
    const chunks = chunkAccounts(accounts, config.browserCount);

    const progress =
        sharedProgress ||
        createProgressManager(
            `🔑 TokenGo (${authMode}) — ${accounts.length} accounts, ${chunks.length} workers`,
        );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`tokengo-${i}`, chunk.length, `TokenGo W${i + 1}`);
    });

    const worker = new TokenGoWorker(
        executeGoogleOAuthAndIntercept,
        executeGitHubOAuthAndIntercept,
        createToken,
        getTokenId,
        revealApiKey,
        authMode,
    );

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;

            return worker.run(
                chunk,
                `tokengo-${i}`,
                browserArgsIndex,
                i,
                accounts.length,
                progress,
                logger.log,
                useProxy,
            );
        }),
    );

    if (!sharedProgress) {
        progress.stop();
    }

    const successCount = results.reduce((sum, r) => sum + r.successCount, 0);
    const failedCount = results.reduce((sum, r) => sum + r.failedCount, 0);
    const totalDuration = Date.now() - startedAt;

    if (!sharedProgress) {
        printReport("🔑 TOKENGO AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `TokenGo finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();

    return { successCount, failedCount, results };
}

module.exports = {
    runTokenGoAutomation,
};
