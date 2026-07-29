const { getConfig, getResultFile } = require("../../config");
const { sleep, ensureFileExists } = require("../../utils");
const { launchBrowser } = require("../../browser");
const { completeGoogleLogin } = require("../../providers/google/login");
const { STEPS } = require("../../cli/progress");
const BaseWorker = require("../base/BaseWorker");
const fs = require("fs");
const { createRouter } = require("../../providers/router");

const MODELS = '["@cf/zai-org/glm-5.2","@cf/deepseek-ai/deepseek-r1-distill-qwen-32b","@cf/meta/llama-3.3-70b-instruct-fp8-fast","@cf/qwen/qwen2.5-coder-32b-instruct","@cf/qwen/qwq-32b"]';

class CloudflareWorker extends BaseWorker {
    constructor(openCFSignIn, handlePostLogin, waitForDashboard, harvestToken) {
        super({
            automationName: "Cloudflare",
            workerLabel: "Cloudflare W",
            removeAccountOnSuccess: true,
            appendErrorOnFailure: true,
            rotateBrowserArgsOnError: true,
            useProxyPool: true,
        });

        this.openCFSignIn = openCFSignIn;
        this.handlePostLogin = handlePostLogin;
        this.waitForDashboard = waitForDashboard;
        this.harvestToken = harvestToken;
    }

    saveToken(accountId, token, log) {
        const resultFile = getResultFile("cloudflare");
        const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;

        ensureFileExists(resultFile);

        fs.appendFileSync(
            resultFile,
            `cloudflare_${accountId.slice(0, 6)}|${baseUrl}|${token}|${MODELS}\n`,
        );

        log(`Token saved to ${resultFile}`);
    }

    async validateAndImport(apiKey, accountId, log) {
        const { ok, router, error } = await createRouter(null, log);
        if (!ok) throw new Error(`Router ${error}`);

        try {
            log("Validating provider...");
            await router.validateProvider("cloudflare-ai", apiKey, { accountId });
            log("Validation OK");
        } catch (valErr) {
            log(`Validation warning (continuing): ${valErr.message}`);
        }

        const connectionName = `cloudflare_${accountId.slice(0, 6)}`;
        log(`Importing as "${connectionName}"...`);
        await router.importProvider(
            "cloudflare-ai",
            connectionName,
            apiKey,
            { providerSpecificData: { accountId } },
        );
        log("Successfully imported!");
    }

    async processAccount(account, browserArgsIndex, workerIndex, log, updateProgress, useProxy) {
        const config = getConfig();

        const { proxy, poolProxy } = await this.acquireProxyForAccount(
            account,
            log,
            updateProgress,
            useProxy,
        );

        updateProgress({ step: STEPS.LAUNCHING, email: account.email });
        log(`Launching browser for ${account.email}`);

        const { browser, page } = await launchBrowser(
            browserArgsIndex,
            workerIndex,
            proxy,
        );

        try {
            updateProgress({ step: STEPS.NAVIGATING });
            await this.openCFSignIn(page, log);

            updateProgress({ step: STEPS.GOOGLE_LOGIN });
            await completeGoogleLogin(page, account, log);
            await this.handlePostLogin(page, log);

            updateProgress({ step: STEPS.WAITING });
            await this.waitForDashboard(page, log);

            updateProgress({ step: STEPS.HARVESTING });
            const { accountId, token } = await this.harvestToken(page, log);
            this.saveToken(accountId, token, log);

            updateProgress({ step: STEPS.VALIDATING });
            try {
                await this.validateAndImport(token, accountId, log);
            } catch (importErr) {
                log(`Router import failed (continuing): ${importErr.message}`);
            }

            await sleep(config.delays.beforeBrowserClose);
        } finally {
            await browser.close();
            log("Browser closed.");
            this.releaseProxyForAccount(poolProxy, log);
        }
    }
}

module.exports = CloudflareWorker;
