const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

puppeteer.use(StealthPlugin());

const { getConfig } = require("./config");
const { randomUA } = require("./utils");

const createUserDataDir = () =>
    path.join(os.tmpdir(), `puppeteer_bt_${crypto.randomUUID()}`);

function cleanupUserDataDir(dirPath) {
    try {
        if (dirPath && dirPath.includes("puppeteer_bt_") && fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
        }
    } catch {
        // Best-effort cleanup, ignore errors
    }
}

function parseProxyForPuppeteer(proxy) {
    if (!proxy) {return null;}

    const result = { server: proxy };

    if (proxy.includes("@")) {
        const [prefix, rest] = proxy.split("://", 2);
        const atIdx = rest.lastIndexOf("@");

        result.server = `${prefix}://${rest.slice(atIdx + 1)}`;

        const userPass = rest.slice(0, atIdx);
        const colonIdx = userPass.indexOf(":");

        if (colonIdx !== -1) {
            result.username = userPass.slice(0, colonIdx);
            result.password = userPass.slice(colonIdx + 1);
        }
    }

    return result;
}

const activeBrowsers = new Set();

async function launchBrowser(browserArgsIndex, workerIndex, proxy, options = {}) {
    const config = getConfig();
    const extraArgs = ["--start-maximized"];
    let proxyAuth = null;
    const { conditionalProxy = false } = options;

    if (proxy && !conditionalProxy) {
        const parsed = parseProxyForPuppeteer(proxy);

        if (parsed) {
            extraArgs.push(`--proxy-server=${parsed.server}`);

            if (parsed.username && parsed.password) {
                proxyAuth = {
                    username: parsed.username,
                    password: parsed.password
                };
            }
        }
    }

    const userDataDir = createUserDataDir();

    const browser = await puppeteer.launch({
        headless: config.headless,
        slowMo: config.slowMo,
        executablePath: config.chromeExecutablePath,
        defaultViewport: null,
        args: [...config.browserArgsSets[browserArgsIndex], ...extraArgs],
        userDataDir,
        ignoreDefaultArgs: ["--enable-automation"],
    });

    activeBrowsers.add(browser);

    // Patch browser.close to auto-cleanup the userDataDir after closing
    const originalClose = browser.close.bind(browser);
    browser.close = async () => {
        activeBrowsers.delete(browser);
        await originalClose();
        cleanupUserDataDir(userDataDir);
    };

    const [page] = await browser.pages();

    if (proxyAuth) {
        await page.authenticate(proxyAuth);
    }

    await page.setUserAgent(randomUA());

    return { browser, page, proxy: conditionalProxy ? proxy : null, proxyAuth };
}

const GOOGLE_DOMAINS = [
    'accounts.google.com',
    'gstatic.com',
    'googleapis.com',
    'google.com',
    'googleusercontent.com',
    'gvt1.com'
];

function isGoogleDomain(url) {
    try {
        const urlObj = new URL(url);
        return GOOGLE_DOMAINS.some(domain => 
            urlObj.hostname === domain || urlObj.hostname.endsWith('.' + domain)
        );
    } catch {
        return false;
    }
}

async function setupConditionalProxyInterception(page, proxy, log) {
    if (!proxy) {
        return;
    }

    log(`[Proxy] Setting up conditional proxy interception (bypass Google domains)`);

    const proxyAgent = new HttpsProxyAgent(proxy);

    await page.setRequestInterception(true);

    page.on('request', async (request) => {
        const url = request.url();
        
        if (isGoogleDomain(url)) {
            log(`[Proxy] Bypassing proxy for Google domain: ${new URL(url).hostname}`);
            request.continue();
            return;
        }

        try {
            const headers = { ...request.headers() };
            
            delete headers['host'];
            delete headers['content-length'];
            delete headers[':authority'];
            delete headers[':method'];
            delete headers[':path'];
            delete headers[':scheme'];

            const response = await axios({
                url: url,
                method: request.method(),
                headers: headers,
                data: request.postData(),
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent,
                maxRedirects: 0,
                validateStatus: () => true,
                responseType: 'arraybuffer',
                timeout: 30000
            });

            request.respond({
                status: response.status,
                headers: response.headers,
                body: response.data
            });
        } catch (error) {
            log(`[Proxy] Error routing through proxy for ${new URL(url).hostname}: ${error.message}`);
            request.abort('failed');
        }
    });
}

async function closeAllActiveBrowsers() {
    const browsers = Array.from(activeBrowsers);
    await Promise.allSettled(browsers.map(b => b.close().catch(() => {})));
    activeBrowsers.clear();
}

module.exports = {
    launchBrowser,
    setupConditionalProxyInterception,
    closeAllActiveBrowsers,
};
