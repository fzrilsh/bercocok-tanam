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

// Always-on isolation flags. Temp userDataDir already = private profile.
// Do NOT rely on --incognito alone with system Chrome — it still shows
// "Sign in to Chrome?" / Dice intercept bubbles that block automation.
const ISOLATION_ARGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-domain-reliability",
    "--password-store=basic",
    "--use-mock-keychain",
    "--metrics-recording-only",
    // suppress Chrome profile / Google account intercept UI
    "--disable-features=ChromeWhatsNewUI,SigninInterceptBubble,AccountConsistency,DiceWebSigninIntercept,AutofillServerCommunication,OptimizationHints",
];

async function launchBrowser(browserArgsIndex, workerIndex, proxy, options = {}) {
    const config = getConfig();
    const extraArgs = ["--start-maximized", ...ISOLATION_ARGS];
    let proxyAuth = null;
    const { conditionalProxy = false } = options;

    if (proxy && !conditionalProxy) {
        const parsed = parseProxyForPuppeteer(proxy);

        if (parsed) {
            extraArgs.push(`--proxy-server=${parsed.server}`);

            if (parsed.username && parsed.password) {
                proxyAuth = {
                    username: parsed.username,
                    password: parsed.password,
                };
            }
        }
    }

    const userDataDir = createUserDataDir();

    // Drop --incognito if present: conflicts with dedicated userDataDir and
    // system Chrome still surfaces sign-in promos under incognito.
    const rawArgs = config.browserArgsSets[browserArgsIndex] || [];
    const browserArgs = rawArgs.filter((a) => a !== "--incognito");

    const browser = await puppeteer.launch({
        headless: config.headless,
        slowMo: config.slowMo,
        executablePath: config.chromeExecutablePath,
        defaultViewport: null,
        args: [...browserArgs, ...extraArgs],
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
    "accounts.google.com",
    "gstatic.com",
    "googleapis.com",
    "google.com",
    "googleusercontent.com",
    "gvt1.com",
];

function isGoogleDomain(url) {
    try {
        const urlObj = new URL(url);
        return GOOGLE_DOMAINS.some((domain) =>
            urlObj.hostname === domain || urlObj.hostname.endsWith(`.${domain}`),
        );
    } catch {
        return false;
    }
}

async function setupConditionalProxyInterception(page, proxy, log) {
    if (!proxy) {
        return;
    }

    log("[Proxy] Setting up conditional proxy interception (bypass Google domains)");

    const proxyAgent = new HttpsProxyAgent(proxy);

    await page.setRequestInterception(true);

    page.on("request", async (request) => {
        const url = request.url();

        if (isGoogleDomain(url)) {
            log(`[Proxy] Bypassing proxy for Google domain: ${new URL(url).hostname}`);
            request.continue();
            return;
        }

        try {
            const headers = { ...request.headers() };

            delete headers.host;
            delete headers["content-length"];
            delete headers[":authority"];
            delete headers[":method"];
            delete headers[":path"];
            delete headers[":scheme"];

            const response = await axios({
                url: url,
                method: request.method(),
                headers: headers,
                data: request.postData(),
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent,
                maxRedirects: 0,
                validateStatus: () => true,
                responseType: "arraybuffer",
                timeout: 30000,
            });

            request.respond({
                status: response.status,
                headers: response.headers,
                body: response.data,
            });
        } catch (error) {
            log(`[Proxy] Error routing through proxy for ${new URL(url).hostname}: ${error.message}`);
            request.abort("failed");
        }
    });
}

async function closeAllActiveBrowsers() {
    const browsers = Array.from(activeBrowsers);
    await Promise.allSettled(browsers.map((b) => b.close().catch(() => {})));
    activeBrowsers.clear();
}

async function openWorkerPage(browser, proxyAuth) {
    const page = await browser.newPage();
    if (proxyAuth) {
        await page.authenticate(proxyAuth);
    }
    await page.setUserAgent(randomUA());
    return page;
}

async function closePageSafe(page) {
    if (!page) {return;}
    try {
        if (!page.isClosed()) {await page.close();}
    } catch {
        // ignore
    }
}

async function closeExtraPages(browser, keepPages = []) {
    if (!browser) {return;}
    const keep = new Set(keepPages.filter(Boolean));
    let pages;
    try {
        pages = await browser.pages();
    } catch {
        return;
    }
    await Promise.allSettled(
        pages
            .filter((p) => !keep.has(p))
            .map((p) => closePageSafe(p)),
    );
}

/**
 * Wait for a new page/tab opened after actionFn (popup).
 * Falls back to any page not in before-set.
 */
async function waitForNewPage(browser, actionFn, timeout = 30000) {
    const before = new Set(await browser.pages());

    const pagePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            browser.off("targetcreated", onTarget);
            reject(new Error(`Popup tab did not open within ${timeout}ms`));
        }, timeout);

        async function onTarget(target) {
            if (target.type() !== "page") {return;}
            try {
                const p = await target.page();
                if (!p || before.has(p)) {return;}
                clearTimeout(timer);
                browser.off("targetcreated", onTarget);
                resolve(p);
            } catch {
                // ignore transient target errors
            }
        }

        browser.on("targetcreated", onTarget);
    });

    await actionFn();

    // also poll in case event was missed / already opened
    const started = Date.now();
    while (Date.now() - started < 1500) {
        const pages = await browser.pages();
        const fresh = pages.find((p) => !before.has(p));
        if (fresh) {return fresh;}
        await new Promise((r) => setTimeout(r, 100));
    }

    return pagePromise;
}

module.exports = {
    launchBrowser,
    setupConditionalProxyInterception,
    closeAllActiveBrowsers,
    openWorkerPage,
    closePageSafe,
    closeExtraPages,
    waitForNewPage,
};
