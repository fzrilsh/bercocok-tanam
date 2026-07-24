const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { getConfig, getResultFile } = require("./config");
const {
    sleep,
    readAccounts,
    removeAccount,
    appendErrorAccount,
    chunkAccounts,
    createFileLogger,
    formatDuration,
    acquireAccountLock,
    releaseAccountLock,
    tryAcquireAccountLock,
    ensureFileExists,
    acquireProxy,
    releaseProxy,
} = require("./utils");
const { launchBrowser } = require("./browser");
const { completeGoogleLogin } = require("./google-login");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");
const { createRouter } = require("./9router-helper");

const QUEUE_RETRY_DELAY_MS = 500;
const TOKENGO_DASHBOARD = "https://dashboard.tokengo.com";
const TOKENGO_API = `${TOKENGO_DASHBOARD}/api`;
const GOOGLE_OAUTH_CLIENT_ID = "179756334592-01g164h5sapm5iaj7rvvd0vg864rfpte.apps.googleusercontent.com";
const GITHUB_OAUTH_CLIENT_ID = "Ov23limywUEd7JK16Ekv";
const MAX_PROXY_ROTATION_ATTEMPTS = 5;

// Custom error class to signal proxy rate limit (429 after max retries)
class ProxyRateLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProxyRateLimitError";
    }
}

function buildStealthHeaders() {
    return {
        "accept": "application/json",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
}

function createAxiosInstance(proxy, log) {
    const config = {
        timeout: 30000,
        headers: buildStealthHeaders(),
        validateStatus: () => true, // Don't throw on any status
    };
    
    if (proxy) {
        // Parse proxy format: http://user:pass@host:port or http://host:port
        let proxyUrl = proxy;
        if (!proxy.startsWith("http://") && !proxy.startsWith("https://")) {
            proxyUrl = `http://${proxy}`;
        }
        
        try {
            const httpsAgent = new HttpsProxyAgent(proxyUrl);
            config.httpsAgent = httpsAgent;
            config.proxy = false; // Disable axios default proxy handling
            
            // Extract clean IP:port for logging (hide credentials)
            const proxyDisplay = proxyUrl.includes('@') 
                ? proxyUrl.split('@')[1].replace(/^https?:\/\//, '')
                : proxyUrl.replace(/^https?:\/\//, '');
            
            log(`Using proxy: ${proxyDisplay}`);
        } catch (err) {
            log(`Proxy configuration error: ${err.message} - proceeding without proxy`);
        }
    }
    
    return axios.create(config);
}

async function axiosRequestWithRetry(axiosInstance, method, url, options, log, maxRetries = 100) {
    let attempt = 0;
    
    while (attempt < maxRetries) {
        try {
            const response = await axiosInstance.request({
                method,
                url,
                ...options,
            });
            
            // Retry on 429 with 100ms delay (tested safe by user)
            if (response.status === 429) {
                attempt++;
                if (attempt < maxRetries) {
                    log(`Got HTTP 429, retry ${attempt}/${maxRetries} after 100ms...`);
                    await sleep(100);
                    continue;
                }
                // Max retries reached on 429 - signal proxy rotation needed
                log(`Max retries (${maxRetries}) reached on 429 - proxy may be rate limited`);
                throw new ProxyRateLimitError(`HTTP 429 persisted after ${maxRetries} retries`);
            }
            
            // Retry on server errors (5xx) with 100ms delay
            if (response.status >= 500 && response.status < 600) {
                attempt++;
                if (attempt < maxRetries) {
                    log(`Got ${response.status}, retry ${attempt}/${maxRetries} after 100ms...`);
                    await sleep(100);
                    continue;
                }
                // Max retries reached, return last response
                return response;
            }
            
            // Success or client error (4xx except 429) - return immediately
            return response;
            
        } catch (err) {
            // If it's ProxyRateLimitError, rethrow immediately (don't wrap it!)
            if (err instanceof ProxyRateLimitError) {
                throw err;
            }
            
            // Network errors only (connection refused, timeout, DNS issues, etc.)
            attempt++;
            if (attempt >= maxRetries) {
                throw new Error(`Network error after ${maxRetries} attempts: ${err.message}`);
            }
            
            log(`Network error: ${err.message}, retry ${attempt}/${maxRetries} after 100ms...`);
            await sleep(100);
        }
    }
    
    throw new Error(`Failed after ${maxRetries} retries`);
}

async function harvestOAuthState(axiosInstance, log, affCode = null) {
    log("Phase 0: Harvesting OAuth state...");
    
    let url = `${TOKENGO_API}/oauth/state`;
    if (affCode) {
        url += `?aff=${affCode}`;
        log(`Using affiliate code: ${affCode}`);
    }
    
    const response = await axiosRequestWithRetry(
        axiosInstance,
        "GET",
        url,
        {},
        log
    );
    
    if (response.status !== 200) {
        throw new Error(`OAuth state failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
    }
    
    const data = response.data;
    
    if (!data.success || !data.data) {
        throw new Error(`OAuth state failed: ${JSON.stringify(data)}`);
    }
    
    const oauthState = data.data;
    log(`OAuth state harvested: ${oauthState}`);
    
    // CRITICAL: Extract cookies from Phase 0 to use in Phase 2
    // Server sets CSRF/state validation cookies that MUST be present in Phase 2
    const setCookieHeader = response.headers["set-cookie"];
    let stateCookies = "";
    
    if (setCookieHeader) {
        const cookieArray = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
        // Extract only the cookie name=value pairs (ignore Path, Domain, etc.)
        stateCookies = cookieArray
            .map(cookie => cookie.split(';')[0].trim())
            .join('; ');
        
        if (stateCookies) {
            log(`Phase 0 cookies captured: ${stateCookies.substring(0, 60)}...`);
        }
    }
    
    return { state: oauthState, cookies: stateCookies };
}

function buildGoogleOAuthUrl(oauthState) {
    const params = new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: `${TOKENGO_DASHBOARD}/oauth/google`,
        response_type: "code",
        scope: "openid profile email",
        state: oauthState,
    });
    
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

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
    
    log(`Navigating to Google OAuth URL...`);
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
    const SHARED_SELECTORS = require("./config").SHARED_SELECTORS;
    const { clickSelector, clickFirstVisibleSelector } = require("./google-login");
    
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

async function exchangeOAuthCallback(axiosInstance, code, state, originalState, stateCookies, log) {
    log("Phase 2: Exchanging OAuth callback for session...");
    
    // CRITICAL VALIDATION: State must match original
    if (state !== originalState) {
        throw new Error(`State mismatch! Expected "${originalState}" but got "${state}"`);
    }
    
    log(`State validated: ${state}`);
    
    const url = `${TOKENGO_API}/oauth/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    
    // CRITICAL FIX: Include cookies from Phase 0 (CSRF/state validation)
    // Without these cookies, server treats the state as "orphaned" → 403/State mismatch
    const headers = {
        "referer": "https://dashboard.tokengo.com/sign-in",
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache",
        "pragma": "no-cache",
    };
    
    // Add Phase 0 cookies if present
    if (stateCookies) {
        headers["cookie"] = stateCookies;
        log(`Using Phase 0 cookies in Phase 2: ${stateCookies.substring(0, 60)}...`);
    }
    
    const response = await axiosRequestWithRetry(
        axiosInstance,
        "GET",
        url,
        { headers },
        log
    );
    
    if (response.status !== 200) {
        throw new Error(`OAuth callback failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
    }
    
    const setCookieHeader = response.headers["set-cookie"];
    if (!setCookieHeader) {
        throw new Error("No set-cookie header in OAuth callback response");
    }
    
    const setCookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join("; ") : setCookieHeader;
    const sessionMatch = setCookieStr.match(/session=([^;]+)/);
    if (!sessionMatch) {
        throw new Error("No session cookie found in set-cookie header");
    }
    
    const sessionCookie = sessionMatch[1].trim();
    log(`Session cookie (first 30): ${sessionCookie.substring(0, 30)}...`);
    log(`Session cookie (FULL): ${sessionCookie}`);
    
    const data = response.data;
    
    log(`OAuth callback response (FULL JSON): ${JSON.stringify(data, null, 2)}`);
    
    if (!data.success || !data.data?.id) {
        throw new Error(`OAuth callback failed: ${JSON.stringify(data)}`);
    }
    
    const userId = data.data.id;
    log(`User ID: ${userId}`);
    
    return { sessionCookie, userId };
}

function buildGitHubOAuthUrl(oauthState) {
    const params = new URLSearchParams({
        client_id: GITHUB_OAUTH_CLIENT_ID,
        redirect_uri: `${TOKENGO_DASHBOARD}/oauth/github`,
        scope: "user:email",
        state: oauthState,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
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

    log(`Navigating to GitHub OAuth URL...`);
    await page.goto(oauthUrl, { waitUntil: "networkidle2" });

    log("Filling GitHub login form...");
    const emailInput = await page.waitForSelector('input#login_field', { timeout: 15000, visible: true });
    await emailInput.click({ clickCount: 3 });
    await page.keyboard.type(account.email, { delay: 50 });

    const passwordInput = await page.waitForSelector('input#password', { timeout: 5000, visible: true });
    await passwordInput.click({ clickCount: 3 });
    await page.keyboard.type(account.password, { delay: 50 });

    await sleep(500);
    await page.keyboard.press('Enter');

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

async function exchangeGitHubOAuthCallback(axiosInstance, code, state, originalState, stateCookies, log) {
    log("Phase 2: Exchanging GitHub OAuth callback for session...");

    if (state !== originalState) {
        throw new Error(`State mismatch! Expected "${originalState}" but got "${state}"`);
    }

    const url = `${TOKENGO_API}/oauth/github?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

    const headers = {
        "referer": "https://dashboard.tokengo.com/sign-in",
        "accept": "application/json, text/plain, */*",
        "cache-control": "no-cache",
        "pragma": "no-cache",
    };

    if (stateCookies) {
        headers["cookie"] = stateCookies;
        log(`Using Phase 0 cookies: ${stateCookies.substring(0, 60)}...`);
    }

    const response = await axiosRequestWithRetry(axiosInstance, "GET", url, { headers }, log);

    if (response.status !== 200) {
        throw new Error(`GitHub OAuth callback failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
    }

    const setCookieHeader = response.headers["set-cookie"];
    if (!setCookieHeader) {
        throw new Error("No set-cookie header in GitHub OAuth callback response");
    }

    const setCookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join("; ") : setCookieHeader;
    const sessionMatch = setCookieStr.match(/session=([^;]+)/);
    if (!sessionMatch) {
        throw new Error("No session cookie found in GitHub OAuth callback response");
    }

    const sessionCookie = sessionMatch[1].trim();
    log(`Session cookie (first 30): ${sessionCookie.substring(0, 30)}...`);

    const data = response.data;
    if (!data.success || !data.data?.id) {
        throw new Error(`GitHub OAuth callback failed: ${JSON.stringify(data)}`);
    }

    const userId = data.data.id;
    log(`User ID: ${userId}`);

    return { sessionCookie, userId };
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
    
    const randomName = crypto.randomBytes(6).toString('hex');
    
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
        log
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
        log
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
        log
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

function saveApiKey(email, userId, apiKey, log) {
    const resultFile = getResultFile("tokengo");
    
    ensureFileExists(resultFile);
    
    fs.appendFileSync(
        resultFile,
        `${email}|${userId}|${apiKey}\n`,
    );
    
    log(`API key saved to ${resultFile}`);
}

async function getAffiliateCode(axiosInstance, sessionCookie, userId, log) {
    log("Fetching affiliate code...");
    
    const headers = {
        "accept": "application/json, text/plain, */*",
        "cookie": `session=${sessionCookie}; thorbase_do_not_sell_or_share=true;`,
        "llmapi-user": String(userId),
        "referer": `${TOKENGO_DASHBOARD}/billing`,
        "cache-control": "no-cache",
        "pragma": "no-cache",
    };
    
    const response = await axiosRequestWithRetry(
        axiosInstance,
        "GET",
        `${TOKENGO_API}/user/self`,
        { headers },
        log
    );
    
    if (response.status !== 200) {
        log(`Failed to fetch affiliate code: HTTP ${response.status}`);
        return null;
    }
    
    const data = response.data;
    
    if (!data.success || !data.data?.aff_code) {
        log(`No referral code found in response: ${JSON.stringify(data)}`);
        return null;
    }
    
    const affCode = data.data.aff_code;
    log(`Affiliate code harvested: ${affCode}`);
    
    return affCode;
}

async function registerToRouter(userId, apiKey, log) {
    const { ok, router, error } = await createRouter(null, log);
    if (!ok) throw new Error(`Router ${error}`);

    log("Phase 4.1: Checking TokenGo provider node...");
    const providerNodeId = await router.ensureProviderNode(
        "TokenGO",
        "tokengo",
        "chat",
        "https://api.tokengo.com/v1",
        "openai-compatible",
    );
    log(`TokenGo provider node: ${providerNodeId}`);

    log("Phase 4.2: Registering API key to 9router...");
    await router.importProvider(
        providerNodeId,
        `Account ${userId}`,
        apiKey,
        { defaultModel: "z-ai/glm-5.2" },
    );

    log(`✅ TokenGo key for account ${userId} successfully integrated into 9router!`);
}

async function processTokenGoAccountOnce(
    account,
    browserArgsIndex,
    workerIndex,
    log,
    updateProgress,
    proxy,
    poolProxy,
    affCode = null,
    authMode = "google",
) {
    const config = getConfig();
    let oauthState = null;
    let stateCookies = null; // Cookies from Phase 0
    let sessionCookie = null;
    let userId = null;
    let apiKey = null;
    let browser = null;
    let newAffCode = null; // New affiliate code to pass to next account
    
    // Create axios instance with proxy support for all TokenGo API calls
    const axiosInstance = createAxiosInstance(proxy, log);
    
    try {
        // Phase 0: Harvest OAuth state (HTTP only, with proxy, with affiliate code)
        updateProgress({ step: "Harvesting state" });
        const phase0Result = await harvestOAuthState(axiosInstance, log, affCode);
        oauthState = phase0Result.state;
        stateCookies = phase0Result.cookies;
        
        // Phase 1: OAuth with Puppeteer (NO PROXY - login works better direct)
        updateProgress({ step: STEPS.LAUNCHING, email: account.email });
        log(`Launching browser for ${account.email} (${authMode} OAuth)`);
        
        const browserResult = await launchBrowser(
            browserArgsIndex,
            workerIndex,
            null,
        );
        browser = browserResult.browser;
        const page = browserResult.page;
        
        try {
            updateProgress({ step: STEPS.GOOGLE_LOGIN });
            
            let code, state;
            if (authMode === "github") {
                const oauthUrl = buildGitHubOAuthUrl(oauthState);
                const result = await executeGitHubOAuthAndIntercept(
                    page, account, oauthUrl, oauthState, log,
                );
                code = result.code;
                state = result.state;
            } else {
                const oauthUrl = buildGoogleOAuthUrl(oauthState);
                const result = await executeGoogleOAuthAndIntercept(
                    page, account, oauthUrl, oauthState, log,
                );
                code = result.code;
                state = result.state;
            }
            
            await sleep(config.delays.beforeBrowserClose);
            await browser.close();
            browser = null;
            log("Browser closed (OAuth complete)");
            
            // Phase 2: Exchange for session (HTTP only, with proxy)
            updateProgress({ step: "Exchanging session" });
            const sessionData = authMode === "github"
                ? await exchangeGitHubOAuthCallback(axiosInstance, code, state, oauthState, stateCookies, log)
                : await exchangeOAuthCallback(axiosInstance, code, state, oauthState, stateCookies, log);
            sessionCookie = sessionData.sessionCookie;
            userId = sessionData.userId;
            
            // Phase 3: Token creation and reveal (HTTP only, with proxy)
            updateProgress({ step: STEPS.HARVESTING });
            
            await createToken(axiosInstance, sessionCookie, userId, log);
            const tokenId = await getTokenId(axiosInstance, sessionCookie, userId, log);
            
            // Phase 3.3: Anti-429 cooldown
            // With proxy rotation, each account uses different IP = separate rate limit buckets
            // Short cooldown (30-90s) is sufficient when using proxy pool
            // Without proxy: WAF will rate limit on local IP - need longer cooldown (5-10 min)
            const cooldownMs = proxy 
                ? 30000 + Math.random() * 60000  // WITH proxy: 30-90 seconds
                : 300000 + Math.random() * 300000; // WITHOUT proxy: 5-10 minutes
            
            const cooldownSec = Math.round(cooldownMs / 1000);
            log(`Phase 3.3: Cooldown for ${cooldownSec}s (${proxy ? 'with proxy rotation' : 'NO PROXY - long cooldown required'})...`);
            updateProgress({ step: `Cooldown ${cooldownSec}s` });
            await sleep(cooldownMs);
            
            apiKey = await revealApiKey(axiosInstance, tokenId, sessionCookie, userId, log);
            saveApiKey(account.email, userId, apiKey, log);
            
            // Phase 3.5: Harvest affiliate code for next account
            updateProgress({ step: "Harvesting aff code" });
            try {
                newAffCode = await getAffiliateCode(axiosInstance, sessionCookie, userId, log);
            } catch (affErr) {
                log(`Affiliate code harvest failed (continuing): ${affErr.message}`);
            }
            
            // Phase 4: Register to 9router (localhost, no proxy)
            updateProgress({ step: STEPS.IMPORTING });
            try {
                await registerToRouter(userId, apiKey, log);
            } catch (importErr) {
                log(`Router import failed (continuing): ${importErr.message}`);
            }
            
            removeAccount(account.rawLine);
            log(`Account harvest successful! Removed from accounts file: ${account.email}`);
        } finally {
            if (browser) {
                await browser.close().catch(() => {});
            }
        }
    } finally {
        // Cleanup is now handled by wrapper function
    }
    
    return newAffCode; // Return affiliate code for next account
}

async function processTokenGoAccount(
    account,
    browserArgsIndex,
    workerIndex,
    log,
    updateProgress,
    useProxy = true,
    affCode = null,
    authMode = "google",
) {
    const config = getConfig();
    const usedProxies = new Set(); // Track proxies we've already tried
    
    for (let attempt = 1; attempt <= MAX_PROXY_ROTATION_ATTEMPTS; attempt++) {
        let poolProxy = null;
        let proxy = account.proxy || null;
        
        // Acquire proxy (skip already tried ones)
        if (!proxy && config.proxyPoolFile && useProxy) {
            let attempts = 0;
            while (attempts < 10) { // Try up to 10 times to get a fresh proxy
                poolProxy = await acquireProxy(log, updateProgress);
                if (!usedProxies.has(poolProxy)) {
                    proxy = poolProxy;
                    usedProxies.add(poolProxy);
                    break;
                }
                // Already used this proxy, release and try another
                releaseProxy(poolProxy);
                attempts++;
            }
            
            if (!proxy) {
                throw new Error(`Could not acquire fresh proxy after ${attempts} attempts`);
            }
        }
        
        try {
            const newAffCode = await processTokenGoAccountOnce(
                account,
                browserArgsIndex,
                workerIndex,
                log,
                updateProgress,
                proxy,
                poolProxy,
                affCode,
                authMode,
            );
            
            // Success! Clean up and return
            if (poolProxy) {
                releaseProxy(poolProxy);
                log(`[Proxy] Released: ${poolProxy.split(':')[0]}`);
            }
            return newAffCode; // Return new affiliate code for next account
            
        } catch (error) {
            // Release proxy before retrying
            if (poolProxy) {
                releaseProxy(poolProxy);
                log(`[Proxy] Released: ${poolProxy.split(':')[0]}`);
            }
            
            // If it's a ProxyRateLimitError and we have attempts left, rotate proxy
            if (error instanceof ProxyRateLimitError && attempt < MAX_PROXY_ROTATION_ATTEMPTS) {
                log(`🔄 Proxy rate limit detected. Rotating to new proxy (attempt ${attempt + 1}/${MAX_PROXY_ROTATION_ATTEMPTS})...`);
                updateProgress({ step: `Proxy rotation ${attempt + 1}/${MAX_PROXY_ROTATION_ATTEMPTS}` });
                await sleep(2000); // Brief pause before rotating
                continue; // Try again with new proxy
            }
            
            // Either not a ProxyRateLimitError, or we've exhausted retries
            throw error;
        }
    }
    
    throw new Error(`Failed after ${MAX_PROXY_ROTATION_ATTEMPTS} proxy rotation attempts`);
}

async function runTokenGoWorker(
    workerAccounts,
    workerId,
    browserArgsIndex,
    workerIndex,
    total,
    progress,
    log,
    useProxy = true,
    authMode = "google",
) {
    const config = getConfig();
    
    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    let lastAffiliateCode = null; // Track affiliate code chain
    
    const accountStats = [];
    const queue = [...workerAccounts];
    
    while (queue.length > 0) {
        const account = queue[0];
        let hasLock = false;
        
        if (queue.length > 1) {
            if (!tryAcquireAccountLock(account.email)) {
                log(
                    `[${workerId}] ${account.email} is locked, moving to back of queue.`,
                );
                queue.push(queue.shift());
                await sleep(QUEUE_RETRY_DELAY_MS);
                continue;
            }
            
            hasLock = true;
        }
        
        const updateProgress = (payload) => {
            progress.updateWorker(workerId, {
                ...payload,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        };
        
        const startTime = Date.now();
        let accountSuccess = false;
        let accountError = null;
        
        try {
            if (!hasLock) {
                await acquireAccountLock(account.email, log, updateProgress);
                hasLock = true;
            }
            
            queue.shift();
            
            const newAffCode = await processTokenGoAccount(
                account,
                browserArgsIndex,
                workerIndex,
                log,
                updateProgress,
                useProxy,
                lastAffiliateCode,
                authMode,
            );
            
            // Update affiliate code for next account
            if (newAffCode) {
                lastAffiliateCode = newAffCode;
                log(`Affiliate code updated for next account: ${newAffCode}`);
            }
            
            accountSuccess = true;
            successCount += 1;
            processedCount += 1;
            
            progress.updateWorker(workerId, {
                step: STEPS.DONE,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } catch (error) {
            accountSuccess = false;
            accountError = error.message;
            failedCount += 1;
            processedCount += 1;
            
            appendErrorAccount(account, error.message, "TokenGo");
            browserArgsIndex = (browserArgsIndex + 1) % config.browserArgsSets.length;
            
            log(`[${workerId}] Error: ${error.message}`);
            
            progress.updateWorker(workerId, {
                step: STEPS.ERROR,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } finally {
            const duration = Date.now() - startTime;
            
            accountStats.push({
                email: account.email,
                rawLine: account.rawLine,
                success: accountSuccess,
                duration,
                error: accountError,
            });
            
            if (hasLock) {
                releaseAccountLock(account.email);
            }
        }
        
        if (queue.length > 0) {
            progress.updateWorker(workerId, { step: STEPS.WAITING });
            await sleep(config.delays.betweenAccounts);
        }
    }
    
    progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: "Done",
        success: successCount,
        failed: failedCount,
        current: workerAccounts.length,
    });
    
    return {
        successCount,
        failedCount,
        accounts: accountStats,
        label: `TokenGo W${workerIndex + 1}`,
    };
}

async function runTokenGoAutomation(sharedProgress = null, useProxy = true, options = {}) {
    const config = getConfig();
    const logger = createFileLogger();
    const authMode = options.authMode || "google";

    let accounts;

    if (options.mode === "create") {
        const { runGitHubSignupAutomation } = require("./github-signup-python");
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
        const GITHUB_KEYS_FILE = path.join(require("./config").ROOT_DIR, "github_keys.txt");

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

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;

            return runTokenGoWorker(
                chunk,
                `tokengo-${i}`,
                browserArgsIndex,
                i,
                accounts.length,
                progress,
                logger.log,
                useProxy,
                authMode,
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
