const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

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

async function launchBrowser(browserArgsIndex, workerIndex, proxy, customArgs = null, persistentUserDataDir = null) {
    const config = getConfig();
    const extraArgs = ["--start-maximized"];
    let proxyAuth = null;

    if (proxy) {
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

    // Use persistent userDataDir if provided, otherwise create temp
    const userDataDir = persistentUserDataDir || createUserDataDir();
    
    // Use custom args if provided, otherwise use config's browser args sets
    const browserArgs = customArgs || config.browserArgsSets[browserArgsIndex];

    const browser = await puppeteer.launch({
        headless: config.headless,
        slowMo: config.slowMo,
        executablePath: config.chromeExecutablePath,
        defaultViewport: null,
        args: [...browserArgs, ...extraArgs],
        userDataDir,
        ignoreDefaultArgs: ["--enable-automation"],
    });

    // Only patch close() if using temp userDataDir (persistent should not be deleted)
    if (!persistentUserDataDir) {
        const originalClose = browser.close.bind(browser);
        browser.close = async () => {
            await originalClose();
            cleanupUserDataDir(userDataDir);
        };
    }

    const [page] = await browser.pages();

    if (proxyAuth) {
        await page.authenticate(proxyAuth);
    }

    await page.setUserAgent(randomUA());

    // Additional anti-detection measures for Cloudflare Turnstile
    await page.evaluateOnNewDocument(() => {
        // Remove webdriver property
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });

        // Mock plugins
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
        });

        // Mock languages
        Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
        });

        // Override permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
        );

        // Hide Chrome automation
        window.chrome = {
            runtime: {},
        };

        // Fix iframe detection
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
            get: function() {
                return window;
            }
        });

        // Mock battery API
        Object.defineProperty(navigator, 'getBattery', {
            value: () => Promise.resolve({
                charging: true,
                chargingTime: 0,
                dischargingTime: Infinity,
                level: 1.0
            })
        });
    });

    return { browser, page };
}

module.exports = {
    launchBrowser,
};
