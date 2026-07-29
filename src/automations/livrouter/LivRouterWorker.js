const fs = require("fs");
const path = require("path");
const { getConfig, ROOT_DIR } = require("../../config");
const { createRouter } = require("../../providers/router");
const { sleep, ensureFileExists } = require("../../utils");
const { launchBrowser } = require("../../browser");
const { STEPS } = require("../../cli/progress");
const BaseWorker = require("../base/BaseWorker");
const { createAxiosInstance, axiosRequestWithRetry } = require("../shared/http-client");
const oauth = require("../shared/oauth");

const BASE_URL = "https://livrouter.com";
const GITHUB_CLIENT_ID = "Ov23lizY0ILAlo5BAEBa";
const RESULT_FILE = path.join(ROOT_DIR, "livrouter_keys.txt");

class LivRouterWorker extends BaseWorker {
    constructor(executeGitHubOAuthAndIntercept, getUserInfo, createToken, getTokenId, revealApiKey, refreshAccessToken) {
        super({
            automationName: "LivRouter",
            workerLabel: "LivRouter W",
            removeAccountOnSuccess: true,
            appendErrorOnFailure: true,
            rotateBrowserArgsOnError: true,
            useProxyPool: true,
        });

        this.executeGitHubOAuthAndIntercept = executeGitHubOAuthAndIntercept;
        this.getUserInfo = getUserInfo;
        this.createToken = createToken;
        this.getTokenId = getTokenId;
        this.revealApiKey = revealApiKey;
        this.refreshAccessToken = refreshAccessToken;
        this.lastAffiliateCode = null;
    }

    buildAuthHeaders(accessToken, sessionId, userId) {
        return {
            "authorization": `Bearer ${accessToken}`,
            "x-auth-session": sessionId,
            "new-api-user": String(userId),
            "origin": BASE_URL,
            "referer": `${BASE_URL}/api-keys`,
            "content-type": "application/json",
            "accept": "*/*",
            "cache-control": "no-cache",
            "pragma": "no-cache",
        };
    }

    saveApiKey(email, userId, apiKey, log) {
        ensureFileExists(RESULT_FILE);
        fs.appendFileSync(RESULT_FILE, `${email}|${userId}|${apiKey}\n`);
        log(`API key saved to ${RESULT_FILE}`);
    }

    async registerToRouter(userId, apiKey, affCode, log) {
        const { ok, router, error } = await createRouter(null, log);
        if (!ok) {
            throw new Error(`Router ${error}`);
        }

        log("Phase 4.1: Checking LivRouter provider node...");
        const providerNodeId = await router.ensureProviderNode(
            "LivRouter",
            "livrouter",
            "chat",
            "https://livrouter.com/api/v1",
            "openai-compatible",
        );
        log(`LivRouter provider node: ${providerNodeId}`);

        log("Phase 4.2: Registering API key to 9router...");
        await router.importProvider(
            providerNodeId,
            `LivRouter ${userId}`,
            apiKey,
            { defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
        );

        log(`✅ LivRouter key for account ${userId} successfully integrated into 9router!`);

        if (affCode) {
            log(`Affiliate code for next account: ${affCode}`);
        }
    }

    async extractAuthFromLocalStorage(page, log) {
        log("Phase 2: Extracting auth data from localStorage...");

        const storageData = await page.evaluate(() => {
            try {
                const stored = localStorage.getItem("livrouter_user");
                if (!stored) {return null;}
                const parsed = JSON.parse(stored);
                return {
                    accessToken: parsed.accessToken || null,
                    userId: parsed.id || null,
                    sessionId: parsed.sessionId || null,
                };
            } catch (e) {
                return { error: e.message };
            }
        });

        if (!storageData || storageData.error) {
            throw new Error(`Failed to extract localStorage: ${storageData?.error || "No data found"}`);
        }

        if (!storageData.accessToken || !storageData.sessionId) {
            throw new Error(`Incomplete localStorage data: ${JSON.stringify(storageData)}`);
        }

        log(`✅ Access token: ${storageData.accessToken.substring(0, 20)}...`);
        log(`✅ Session ID: ${storageData.sessionId.substring(0, 20)}...`);
        log(`✅ User ID: ${storageData.userId || "null"}`);

        return storageData;
    }

    async processAccountOnce(account, browserArgsIndex, workerIndex, log, updateProgress, proxy, poolProxy, affCode) {
        const config = getConfig();
        let browser = null;
        let apiKey = null;
        let returnedAffCode = null;

        const axiosInstance = createAxiosInstance(proxy, log);

        try {
            updateProgress({ step: STEPS.LAUNCHING, email: account.email });
            log(`Launching browser for ${account.email}`);

            const browserResult = await launchBrowser(browserArgsIndex, workerIndex, null);
            browser = browserResult.browser;
            const page = browserResult.page;

            try {
                updateProgress({ step: STEPS.NAVIGATING });
                const oauthUrl = oauth.buildGitHubOAuthUrl(
                    GITHUB_CLIENT_ID,
                    `${BASE_URL}/oauth/github`,
                    null,
                    { affCode }
                );

                updateProgress({ step: STEPS.GOOGLE_LOGIN });
                const { cookies } = await this.executeGitHubOAuthAndIntercept(
                    page,
                    account,
                    oauthUrl,
                    null,
                    log,
                );

                updateProgress({ step: STEPS.WAITING });
                const localStorageData = await this.extractAuthFromLocalStorage(page, log);

                let accessToken = localStorageData.accessToken;
                const sessionId = localStorageData.sessionId;
                let userId = localStorageData.userId;

                updateProgress({ step: STEPS.HARVESTING });

                if (!userId) {
                    const userInfo = await this.getUserInfo(axiosInstance, cookies, null, log);
                    userId = userInfo.userId;
                    returnedAffCode = userInfo.affCode;
                } else {
                    log(`Using userId from localStorage: ${userId}`);
                }

                if (!accessToken) {
                    const refreshResult = await this.refreshAccessToken(axiosInstance, sessionId, log);
                    accessToken = refreshResult.accessToken;
                }

                await this.createToken(axiosInstance, accessToken, sessionId, userId, log);
                const tokenId = await this.getTokenId(axiosInstance, accessToken, sessionId, userId, log);

                updateProgress({ step: STEPS.GETTING_TOKEN });
                apiKey = await this.revealApiKey(axiosInstance, tokenId, accessToken, sessionId, userId, log);
                this.saveApiKey(account.email, userId, apiKey, log);

                updateProgress({ step: STEPS.IMPORTING });
                try {
                    await this.registerToRouter(userId, apiKey, returnedAffCode, log);
                } catch (importErr) {
                    log(`Router import failed (continuing): ${importErr.message}`);
                }

                await sleep(config.delays.beforeBrowserClose);
            } finally {
                if (browser) {
                    await browser.close().catch(() => {});
                }
            }
        } finally {
            // Cleanup handled by wrapper
        }

        return returnedAffCode;
    }

    async processAccount(account, browserArgsIndex, workerIndex, log, updateProgress, useProxy) {
        const config = getConfig();

        const { proxy, poolProxy } = await this.acquireProxyForAccount(
            account,
            log,
            updateProgress,
            useProxy,
        );

        try {
            const newAffCode = await this.processAccountOnce(
                account,
                browserArgsIndex,
                workerIndex,
                log,
                updateProgress,
                proxy,
                poolProxy,
                this.lastAffiliateCode,
            );

            this.releaseProxyForAccount(poolProxy, log);

            if (newAffCode) {
                this.lastAffiliateCode = newAffCode;
                log(`Affiliate code updated for next account: ${newAffCode}`);
            }
        } catch (error) {
            this.releaseProxyForAccount(poolProxy, log);
            throw error;
        }
    }
}

module.exports = LivRouterWorker;
