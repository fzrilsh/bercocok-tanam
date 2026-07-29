const { getConfig, getResultFile } = require("../../config");
const { sleep, ensureFileExists } = require("../../utils");
const { launchBrowser } = require("../../browser");
const { completeGoogleLogin } = require("../../providers/google/login");
const { createAxiosInstance, axiosRequestWithRetry } = require("../shared/http-client");
const oauth = require("../shared/oauth");
const { STEPS } = require("../../cli/progress");
const BaseWorker = require("../base/BaseWorker");
const fs = require("fs");
const { createRouter } = require("../../providers/router");

const TOKENGO_DASHBOARD = "https://dashboard.tokengo.com";
const TOKENGO_API = `${TOKENGO_DASHBOARD}/api`;
const GOOGLE_OAUTH_CLIENT_ID = "179756334592-01g164h5sapm5iaj7rvvd0vg864rfpte.apps.googleusercontent.com";
const GITHUB_OAUTH_CLIENT_ID = "Ov23limywUEd7JK16Ekv";
const MAX_PROXY_ROTATION_ATTEMPTS = 5;

class ProxyRateLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProxyRateLimitError";
    }
}

class TokenGoWorker extends BaseWorker {
    constructor(executeGoogleOAuthAndIntercept, executeGitHubOAuthAndIntercept, createToken, getTokenId, revealApiKey, authMode = "google") {
        super({
            automationName: "TokenGo",
            workerLabel: "TokenGo W",
            removeAccountOnSuccess: true,
            appendErrorOnFailure: true,
            rotateBrowserArgsOnError: true,
            useProxyPool: true,
        });

        this.executeGoogleOAuthAndIntercept = executeGoogleOAuthAndIntercept;
        this.executeGitHubOAuthAndIntercept = executeGitHubOAuthAndIntercept;
        this.createToken = createToken;
        this.getTokenId = getTokenId;
        this.revealApiKey = revealApiKey;
        this.authMode = authMode;
        this.lastAffiliateCode = null;
    }

    buildAuthHeaders(sessionCookie, userId) {
        return {
            "cookie": `session=${sessionCookie}; thorbase_do_not_sell_or_share=true;`,
            "llmapi-user": String(userId),
            "origin": TOKENGO_DASHBOARD,
            "referer": `${TOKENGO_DASHBOARD}/api-keys`,
            "content-type": "application/json",
        };
    }

    saveApiKey(email, userId, apiKey, log) {
        const resultFile = getResultFile("tokengo");
        ensureFileExists(resultFile);
        fs.appendFileSync(resultFile, `${email}|${userId}|${apiKey}\n`);
        log(`API key saved to ${resultFile}`);
    }

    async getAffiliateCode(axiosInstance, sessionCookie, userId, log) {
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
            log,
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

    async registerToRouter(userId, apiKey, log) {
        const { ok, router, error } = await createRouter(null, log);
        if (!ok) { throw new Error(`Router ${error}`); }

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

    async processAccountOnce(account, browserArgsIndex, workerIndex, log, updateProgress, proxy, poolProxy, affCode) {
        const config = getConfig();
        let oauthState = null;
        let stateCookies = null;
        let sessionCookie = null;
        let userId = null;
        let apiKey = null;
        let browser = null;
        let newAffCode = null;

        const axiosInstance = createAxiosInstance(proxy, log);

        try {
            updateProgress({ step: "Harvesting state" });
            const phase0Result = await oauth.harvestOAuthState(axiosInstance, TOKENGO_API, "/oauth/state", log, affCode);
            oauthState = phase0Result.state;
            stateCookies = phase0Result.cookies;

            updateProgress({ step: STEPS.LAUNCHING, email: account.email });
            log(`Launching browser for ${account.email} (${this.authMode} OAuth)`);

            const browserResult = await launchBrowser(browserArgsIndex, workerIndex, null);
            browser = browserResult.browser;
            const page = browserResult.page;

            try {
                updateProgress({ step: STEPS.GOOGLE_LOGIN });

                let code, state;
                if (this.authMode === "github") {
                    const oauthUrl = oauth.buildGitHubOAuthUrl(GITHUB_OAUTH_CLIENT_ID, `${TOKENGO_DASHBOARD}/oauth/github`, oauthState);
                    const result = await this.executeGitHubOAuthAndIntercept(page, account, oauthUrl, oauthState, log);
                    code = result.code;
                    state = result.state;
                } else {
                    const oauthUrl = oauth.buildGoogleOAuthUrl(GOOGLE_OAUTH_CLIENT_ID, `${TOKENGO_DASHBOARD}/oauth/google`, oauthState);
                    const result = await this.executeGoogleOAuthAndIntercept(page, account, oauthUrl, oauthState, log);
                    code = result.code;
                    state = result.state;
                }

                await sleep(config.delays.beforeBrowserClose);
                await browser.close();
                browser = null;
                log("Browser closed (OAuth complete)");

                updateProgress({ step: "Exchanging session" });
                const sessionData = this.authMode === "github"
                    ? await oauth.exchangeOAuthCallback(axiosInstance, TOKENGO_API, "/oauth/github", code, state, oauthState, stateCookies, log)
                    : await oauth.exchangeOAuthCallback(axiosInstance, TOKENGO_API, "/oauth/google", code, state, oauthState, stateCookies, log);
                sessionCookie = sessionData.sessionCookie;
                userId = sessionData.userId;

                updateProgress({ step: STEPS.HARVESTING });

                await this.createToken(axiosInstance, sessionCookie, userId, log);
                const tokenId = await this.getTokenId(axiosInstance, sessionCookie, userId, log);

                const cooldownMs = proxy
                    ? 30000 + Math.random() * 60000
                    : 300000 + Math.random() * 300000;

                const cooldownSec = Math.round(cooldownMs / 1000);
                log(`Phase 3.3: Cooldown for ${cooldownSec}s (${proxy ? "with proxy rotation" : "NO PROXY - long cooldown required"})...`);
                updateProgress({ step: `Cooldown ${cooldownSec}s` });
                await sleep(cooldownMs);

                apiKey = await this.revealApiKey(axiosInstance, tokenId, sessionCookie, userId, log);
                this.saveApiKey(account.email, userId, apiKey, log);

                updateProgress({ step: "Harvesting aff code" });
                try {
                    newAffCode = await this.getAffiliateCode(axiosInstance, sessionCookie, userId, log);
                } catch (affErr) {
                    log(`Affiliate code harvest failed (continuing): ${affErr.message}`);
                }

                updateProgress({ step: STEPS.IMPORTING });
                try {
                    await this.registerToRouter(userId, apiKey, log);
                } catch (importErr) {
                    log(`Router import failed (continuing): ${importErr.message}`);
                }
            } finally {
                if (browser) {
                    await browser.close().catch(() => {});
                }
            }
        } finally {
            // Cleanup handled by wrapper
        }

        return newAffCode;
    }

    async processAccount(account, browserArgsIndex, workerIndex, log, updateProgress, useProxy) {
        const config = getConfig();
        const usedProxies = new Set();

        for (let attempt = 1; attempt <= MAX_PROXY_ROTATION_ATTEMPTS; attempt++) {
            const { proxy, poolProxy } = await this.acquireProxyForAccount(account, log, updateProgress, useProxy);

            if (poolProxy && usedProxies.has(poolProxy)) {
                this.releaseProxyForAccount(poolProxy, log);
                continue;
            }

            if (poolProxy) {
                usedProxies.add(poolProxy);
            }

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

                return;
            } catch (error) {
                this.releaseProxyForAccount(poolProxy, log);

                if (error instanceof ProxyRateLimitError && attempt < MAX_PROXY_ROTATION_ATTEMPTS) {
                    log(`🔄 Proxy rate limit detected. Rotating to new proxy (attempt ${attempt + 1}/${MAX_PROXY_ROTATION_ATTEMPTS})...`);
                    updateProgress({ step: `Proxy rotation ${attempt + 1}/${MAX_PROXY_ROTATION_ATTEMPTS}` });
                    await sleep(2000);
                    continue;
                }

                throw error;
            }
        }

        throw new Error(`Failed after ${MAX_PROXY_ROTATION_ATTEMPTS} proxy rotation attempts`);
    }
}

module.exports = { TokenGoWorker, ProxyRateLimitError };
