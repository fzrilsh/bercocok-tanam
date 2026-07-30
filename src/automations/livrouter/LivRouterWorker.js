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
const { processLivRouterAccountStandalone } = require("./index");

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
        let returnedAffCode = null;

        try {
            const customRouterName = `LivRouter Worker ${workerIndex + 1} \${userId} (5 Credit)`;
            
            const userCredentials = await processLivRouterAccountStandalone(
                account,
                affCode,
                customRouterName,
                browserArgsIndex,
                proxy ? true : false,
                log,
                updateProgress
            );

            returnedAffCode = userCredentials.affCode;
            
            log(`✅ Account ${account.email} processed successfully`);
            if (returnedAffCode) {
                log(`Affiliate code for chaining: ${returnedAffCode}`);
            }

        } catch (error) {
            log(`❌ Account ${account.email} failed: ${error.message}`);
            throw error;
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
