/* global URLSearchParams, URL, document, window, localStorage */
const path = require("path");
const { getConfig, ROOT_DIR } = require("../../config");
const { sleep, createFileLogger, formatDuration, readAccounts, chunkAccounts } = require("../../utils");
const { STEPS, createProgressManager } = require("../../cli/progress");
const { printReport } = require("../../cli/reporter");
const { createAxiosInstance, axiosRequestWithRetry } = require("../shared/http-client");
const oauth = require("../shared/oauth");
const LivRouterWorker = require("./LivRouterWorker");

const BASE_URL = "https://livrouter.com";
const GITHUB_CLIENT_ID = "Ov23lizY0ILAlo5BAEBa";
const RESULT_FILE = path.join(ROOT_DIR, "livrouter_keys.txt");

async function executeGitHubOAuthAndIntercept(page, account, oauthUrl, oauthState, log) {
    log("Phase 1: Starting GitHub OAuth flow (browser will complete callback)...");

    log("Navigating to GitHub OAuth URL...");
    await page.goto(oauthUrl, { waitUntil: "networkidle2" });

    log("Filling GitHub login form...");
    const emailInput = await page.waitForSelector("input#login_field", { timeout: 15000, visible: true });
    await emailInput.click();
    await sleep(300);
    await emailInput.evaluate((el) => el.value = "");
    await emailInput.type(account.email, { delay: 80 });

    const passwordInput = await page.waitForSelector("input#password", { timeout: 5000, visible: true });
    await passwordInput.click();
    await sleep(300);
    await passwordInput.evaluate((el) => el.value = "");
    await passwordInput.type(account.password, { delay: 80 });

    await sleep(500);
    log("Submitting login form...");
    await page.keyboard.press("Enter");

    log("Waiting for navigation to authorization page...");
    try {
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 });
    } catch (navErr) {
        log("Navigation wait timeout (continuing anyway)");
    }

    log("Waiting for authorization page...");

    // Try to find authorization button (OPTIONAL - might already be authorized)
    log("Checking for Authorize button...");
    const buttonFound = await page.waitForSelector('button[name="authorize"][value="1"]', {
        timeout: 15000,
        visible: true,
    }).then(() => true).catch(() => false);

    if (buttonFound) {
        log("Authorization button found, clicking and waiting for OAuth callback...");
        await sleep(2000);

        // Click and wait for navigation to callback URL (browser will load callback page)
        try {
            await Promise.all([
                page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }),
                page.click('button[name="authorize"][value="1"]', { delay: 100 }),
            ]);
            log("✅ Authorization completed, navigated to callback");
        } catch (err) {
            log(`Click with navigation failed: ${err.message}, trying JavaScript click...`);

            // Try JavaScript click as fallback
            try {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }),
                    page.evaluate(() => {
                        const btn = document.querySelector('button[name="authorize"][value="1"]');
                        if (btn) {btn.click();}
                    }),
                ]);
                log("✅ Authorization completed via JavaScript click");
            } catch (err2) {
                log(`⚠️  All click methods failed: ${err2.message}`);
                throw new Error("Failed to complete authorization");
            }
        }
    } else {
        log("No authorization button found - assuming already authorized");
        log("Waiting for automatic redirect to callback...");

        // Wait for navigation to callback (should happen automatically if already authorized)
        try {
            await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
            log("✅ Automatic redirect to callback completed");
        } catch (err) {
            log(`⚠️  No automatic redirect detected: ${err.message}`);
        }
    }

    // At this point, browser should have loaded the callback page
    // Wait for page to fully process the OAuth exchange
    log("Waiting for callback page to complete OAuth exchange...");
    await sleep(3000);

    const finalUrl = page.url();
    log(`Final URL after OAuth: ${finalUrl}`);

    // Check if we ended up on an error page
    if (finalUrl.includes("/error") || finalUrl.includes("mismatch")) {
        const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
        log("❌ OAuth flow ended on error page");
        log(`Error page content: ${pageText.substring(0, 300)}`);
        throw new Error(`OAuth flow failed: ${pageText.substring(0, 100)}`);
    }

    // Extract all cookies from browser (includes new session cookie from OAuth)
    const cookies = await page.cookies();
    log(`Extracted ${cookies.length} cookie(s) from browser after OAuth`);

    // Convert cookies to cookie string for axios
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    if (!cookieString) {
        throw new Error("No cookies found in browser after OAuth flow");
    }

    log("✅ GitHub OAuth flow completed successfully!");
    log(`Session cookies: ${cookieString.substring(0, 60)}...`);
    return { cookies: cookieString };
}

async function getUserInfo(axiosInstance, sessionCookie, userId, log) {
    log("Phase 2: Getting user info from session...");

    const headers = {
        "accept": "*/*",
        "cookie": sessionCookie,
        "referer": `${BASE_URL}/dashboard`,
        "content-type": "application/json",
        "cache-control": "no-cache",
        "pragma": "no-cache",
    };

    // Add New-Api-User header if userId is provided
    if (userId) {
        headers["new-api-user"] = String(userId);
        log(`Including New-Api-User header: ${userId}`);
    } else {
        log("⚠️  No userId provided, making request WITHOUT New-Api-User header");
    }

    // Log exact request details for debugging
    log(`Request URL: ${BASE_URL}/api/gateway/user/self`);
    log(`Cookie header: ${sessionCookie.substring(0, 100)}...`);
    log(`All headers: ${JSON.stringify(headers, null, 2)}`);

    const response = await axiosRequestWithRetry(
        axiosInstance,
        "GET",
        `${BASE_URL}/api/gateway/user/self`,
        { headers },
        log,
    );

    log(`Response status: ${response.status}`);
    log(`Response data: ${JSON.stringify(response.data)}`);

    if (response.status !== 200) {
        throw new Error(`Failed to get user info: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
    }

    const data = response.data;

    if (!data.success || !data.data?.id) {
        throw new Error(`Invalid user info response: ${JSON.stringify(data)}`);
    }

    const returnedUserId = data.data.id;
    const affCode = data.data.aff_code || null;

    log(`User ID from API: ${returnedUserId}`);
    if (affCode) {
        log(`Affiliate code: ${affCode}`);
    }

    return { userId: returnedUserId, affCode };
}



async function createToken(axiosInstance, accessToken, sessionId, userId, log) {
    log("Phase 3.1: Creating new token entry...");

    const randomName = `api_${Date.now()}`;

    const payload = {
        name: randomName,
        group: "default",
        expired_time: -1,
        model_limits_enabled: false,
        model_limits: "",
        allow_ips: "",
        cross_group_retry: false,
        unlimited_quota: true,
        remain_quota: -1,
    };

    const response = await axiosRequestWithRetry(
        axiosInstance,
        "POST",
        `${BASE_URL}/api/gateway/token/`,
        {
            headers: buildAuthHeaders(accessToken, sessionId, userId),
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

    log("Token created successfully (fetching ID...)");
}

async function getTokenId(axiosInstance, accessToken, sessionId, userId, log) {
    log("Phase 3.2: Fetching token list to get token ID...");

    const headers = buildAuthHeaders(accessToken, sessionId, userId);

    const response = await axiosRequestWithRetry(
        axiosInstance,
        "GET",
        `${BASE_URL}/api/gateway/token/?p=1&page_size=10`,
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

async function revealApiKey(axiosInstance, tokenId, accessToken, sessionId, userId, log) {
    log("Phase 3.3: Revealing API key...");

    const headers = buildAuthHeaders(accessToken, sessionId, userId);
    headers["content-length"] = "0";

    const response = await axiosRequestWithRetry(
        axiosInstance,
        "POST",
        `${BASE_URL}/api/gateway/token/${tokenId}/key`,
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



async function refreshAccessToken(axiosInstance, sessionId, log) {
    log("Refreshing access token...");

    const headers = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.6",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "pragma": "no-cache",
        "priority": "u=1, i",
        "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "sec-gpc": "1",
        "x-auth-session": sessionId,
        "referer": `${BASE_URL}/dashboard/keys`,
    };

    const response = await axiosRequestWithRetry(
        axiosInstance,
        "POST",
        `${BASE_URL}/api/gateway/user/auth/refresh`,
        { headers },
        log,
    );

    if (response.status !== 200) {
        throw new Error(`Token refresh failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
    }

    const data = response.data;

    if (!data.success || !data.data?.access_token) {
        throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
    }

    const newAccessToken = data.data.access_token;
    const newExpiresAt = data.data.access_expires_at;

    log(`✅ Access token refreshed, expires at: ${newExpiresAt}`);

    return {
        accessToken: newAccessToken,
        accessExpiresAt: newExpiresAt,
    };
}

async function transferAffiliateReward(axiosInstance, accessToken, sessionId, userId, quota, log) {
    log(`Transferring affiliate reward (quota: ${quota})...`);

    const headers = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.6",
        "authorization": `Bearer ${accessToken}`,
        "x-auth-session": sessionId,
        "new-api-user": String(userId),
        "cache-control": "no-cache",
        "content-type": "application/json",
        "pragma": "no-cache",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "referer": `${BASE_URL}/dashboard/profile`,
    };

    const payload = { quota };

    const response = await axiosRequestWithRetry(
        axiosInstance,
        "POST",
        `${BASE_URL}/api/gateway/user/aff_transfer`,
        {
            headers,
            data: payload,
        },
        log,
    );

    if (response.status !== 200) {
        throw new Error(`Affiliate transfer failed: HTTP ${response.status} - ${JSON.stringify(response.data)}`);
    }

    const data = response.data;

    if (!data.success) {
        throw new Error(`Affiliate transfer failed: ${JSON.stringify(data)}`);
    }

    log(`✅ Affiliate reward transferred: ${quota} quota`);
    return true;
}





async function runLivRouterAutomation(sharedProgress = null, useProxy = true, options = {}) {
    const config = getConfig();
    const logger = createFileLogger();

    let accounts;

    if (options.mode === "create") {
        const { runGitHubSignupAutomation } = require("../github");
        const createCount = options.createCount || 1;
        const tempEmailProvider = options.tempEmailProvider || null;

        logger.log(`Creating ${createCount} GitHub account(s) for LivRouter...`);
        const githubResult = await runGitHubSignupAutomation(createCount, sharedProgress, useProxy, tempEmailProvider);
        if (!githubResult || githubResult.successCount === 0) {
            logger.log("No GitHub accounts created, aborting LivRouter");
            logger.close();
            return null;
        }
    }

    const GITHUB_KEYS_FILE = path.join(ROOT_DIR, "github_keys.txt");

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

    if (!sharedProgress) {
        console.log("");
        console.log(`🔑 LivRouter automation (GitHub OAuth) — ${accounts.length} accounts`);
        console.log("");
    }

    const startedAt = Date.now();
    const chunks = accounts.length > config.browserCount
        ? Array.from({ length: config.browserCount }, (_, i) =>
            accounts.filter((_, idx) => idx % config.browserCount === i))
        : [accounts];

    const progress = sharedProgress || createProgressManager(
        `🔑 LivRouter (GitHub) — ${accounts.length} accounts, ${chunks.length} workers`,
    );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`livrouter-${i}`, chunk.length, `LivRouter W${i + 1}`);
    });

    const worker = new LivRouterWorker(
        executeGitHubOAuthAndIntercept,
        getUserInfo,
        createToken,
        getTokenId,
        revealApiKey,
        refreshAccessToken,
    );

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;

            return worker.run(
                chunk,
                `livrouter-${i}`,
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
        printReport("🔑 LIVROUTER AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `LivRouter finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();

    return { successCount, failedCount, results };
}

async function runLivRouterCreateAndImport(
    createCount = 1,
    sharedProgress = null,
    useProxy = true,
    tempEmailProvider = null,
) {
    const config = getConfig();
    const logger = createFileLogger();
    const { createGitHubAccountViaPython } = require("../github");

    if (createCount <= 0) {
        if (!sharedProgress) {console.log("Create count must be > 0");}
        logger.close();
        return null;
    }

    if (!sharedProgress) {
        console.log("");
        console.log("LivRouter Pipeline: Create GitHub → LivRouter OAuth");
        console.log(`   Count: ${createCount}`);
        console.log("   Each success GitHub account immediately logs into LivRouter.");
        console.log("");
    }

    const startedAt = Date.now();
    const progress = sharedProgress || createProgressManager(
        `LivRouter Create+Import — ${createCount} accounts`,
    );

    const workerId = "livrouter-pipeline-0";
    progress.addWorker(workerId, createCount, "LivRouter Pipeline");

    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;
    let previousUserCredentials = null;
    const accountStats = [];

    for (let i = 0; i < createCount; i++) {
        const updateProgress = (payload) => {
            progress.updateWorker(workerId, {
                ...payload,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        };

        const startTime = Date.now();
        let accountEmail = `account-${i + 1}`;
        let accountSuccess = false;
        let accountError = null;
        let rawLine = `failed-${i + 1}`;

        try {
            updateProgress({
                step: STEPS.LAUNCHING,
                email: `Creating GitHub ${i + 1}/${createCount}...`,
            });
            logger.log(`[Pipeline] Creating GitHub account ${i + 1}/${createCount}...`);

            const createResult = await createGitHubAccountViaPython(
                i,
                useProxy,
                logger.log,
                updateProgress,
                tempEmailProvider,
            );

            if (!createResult?.success || !createResult.account) {
                throw new Error("GitHub account creation failed");
            }

            const account = {
                email: createResult.account.email,
                password: createResult.account.password,
                username: createResult.account.username,
                proxy: null,
                rawLine: `${createResult.account.email}:${createResult.account.password}:${createResult.account.username}`,
            };
            accountEmail = account.email;
            rawLine = account.rawLine;

            logger.log(`[Pipeline] GitHub created: ${account.email} — starting LivRouter OAuth...`);

            updateProgress({
                step: STEPS.NAVIGATING,
                email: `LivRouter login: ${account.email}`,
            });

            const userCredentials = await processLivRouterAccount(
                account,
                i % config.browserArgsSets.length,
                0,
                logger.log,
                updateProgress,
                useProxy,
                previousUserCredentials,
            );

            if (userCredentials && userCredentials.affCode) {
                previousUserCredentials = userCredentials;
                logger.log(`[Pipeline] Credentials stored for affiliate chaining: ${userCredentials.affCode}`);
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

            logger.log(`[Pipeline] SUCCESS: ${account.email} GitHub + LivRouter`);
        } catch (error) {
            accountSuccess = false;
            accountError = error.message;
            failedCount += 1;
            processedCount += 1;

            logger.log(`[Pipeline] FAILED: ${accountEmail} — ${error.message}`);

            progress.updateWorker(workerId, {
                step: STEPS.ERROR,
                email: accountEmail,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } finally {
            accountStats.push({
                email: accountEmail,
                rawLine,
                success: accountSuccess,
                duration: Date.now() - startTime,
                error: accountError,
            });
        }

        if (i < createCount - 1) {
            progress.updateWorker(workerId, { step: STEPS.WAITING });
            await sleep(config.delays.betweenAccounts || 10000);
        }
    }

    progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: "Done",
        success: successCount,
        failed: failedCount,
        current: createCount,
    });

    if (!sharedProgress) {
        progress.stop();
    }

    const results = [
        {
            successCount,
            failedCount,
            accounts: accountStats,
            label: "LivRouter Pipeline",
        },
    ];
    const totalDuration = Date.now() - startedAt;

    if (!sharedProgress) {
        printReport("LIVROUTER CREATE+IMPORT REPORT", results, totalDuration);
        console.log(`Log: ${logger.logFile}`);
        console.log("");
    } else {
        logger.log(
            `LivRouter pipeline finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${formatDuration(totalDuration)}`,
        );
    }

    logger.close();

    return { successCount, failedCount, results };
}

module.exports = {
    runLivRouterAutomation,
    runLivRouterCreateAndImport,
};
