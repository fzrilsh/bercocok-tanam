/* global Event, document, location */
const { existsSync } = require("fs");
const { getConfig } = require("../config");
const { sleep } = require("../utils");

function findChrome() {
    const candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Volumes/StorageTeamGroup/Browser/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const c of candidates) {
        if (existsSync(c)) {return c;}
    }
    throw new Error("Chrome not found. Install Google Chrome or set CHROME_PATH in .env");
}

async function hardenPage(page) {
    await page.setUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({
        "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "accept-language": "en-US,en;q=0.9",
    });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        window.chrome = window.chrome || { runtime: {} };
    });
}

async function clearBrowserCookies(browser) {
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    const client = await page.createCDPSession();
    await client.send("Network.clearBrowserCookies");
}

async function getAllCookies(page) {
    const client = await page.createCDPSession();
    const { cookies } = await client.send("Network.getAllCookies");
    return cookies || [];
}

async function fillInput(page, sel, value, timeout = 15000, delay = 100) {
    await page.waitForSelector(sel, { timeout, visible: true });
    await page.focus(sel);
    await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (el) {
            el.focus();
            el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
        }
    }, sel);
    await page.type(sel, value, { delay });
}

async function clickText(page, text, timeout = 8000) {
    const sels = [
        `button::-p-text(${text})`,
        `a::-p-text(${text})`,
        `[role="button"]::-p-text(${text})`,
        `::-p-text(${text})`,
    ];
    let lastErr = "";
    for (const sel of sels) {
        try {
            await page.locator(sel).setTimeout(timeout).click({ delay: 30 });
            return;
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
        }
    }
    let snippet = "";
    try {
        snippet = await page.evaluate(
            "(() => { const t = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim(); return t.slice(0, 180); })()",
        );
    } catch {
    }
    throw new Error(`clickText timeout: "${text}"${lastErr ? ` (${lastErr.slice(0, 120)})` : ""}${snippet ? ` | page: ${snippet}` : ""}`);
}

async function tryClickText(page, text, timeout = 5000) {
    const sels = [
        `button::-p-text(${text})`,
        `a::-p-text(${text})`,
        `[role="button"]::-p-text(${text})`,
        `::-p-text(${text})`,
    ];

    for (const sel of sels) {
        try {
            await page.locator(sel).setTimeout(timeout).click({ delay: 30 });
            return true;
        } catch {
        }
    }
    return false;
}

async function pageLooksBlocked(page) {
    try {
        const info = await page.evaluate(() => {
            const title = document.title || "";
            const body = (document.body?.innerText || "").slice(0, 500);
            return { title, body, url: location.href };
        });
        const blob = `${info.title}\n${info.body}\n${info.url}`.toLowerCase();
        if (blob.includes("attention required") || blob.includes("cf-error") || blob.includes("sorry, you have been blocked")) {
            return `cloudflare block: ${info.title || info.url}`;
        }
        if (blob.includes("just a moment") || blob.includes("checking your browser")) {
            return `cloudflare challenge: ${info.title || info.url}`;
        }
        return null;
    } catch {
        return null;
    }
}

async function clickSelector(page, selector, options = {}) {
    const config = getConfig();
    const {
        timeout = config.timeouts.default,
        visible = false,
        delayBeforeClick = 0,
    } = options;

    await page.waitForSelector(selector, { timeout, visible });

    if (delayBeforeClick > 0) {
        await sleep(delayBeforeClick);
    }

    await page.click(selector);
}

async function typeIntoSelector(page, selector, value, options = {}) {
    const config = getConfig();
    const {
        timeout = config.timeouts.default,
        visible = false,
        delayBeforeType = 0,
    } = options;

    await page.waitForSelector(selector, { timeout, visible });

    if (delayBeforeType > 0) {
        await sleep(delayBeforeType);
    }

    await page.type(selector, value);
}

async function clickFirstVisibleSelector(page, selectors, timeout) {
    const config = getConfig();
    const foundSelector = await Promise.race(
        selectors.map((selector) =>
            page
                .waitForSelector(selector, { visible: true, timeout })
                .then(() => selector),
        ),
    );

    await sleep(config.delays.beforeNextClick);
    await page.click(foundSelector);
}

module.exports = {
    findChrome,
    hardenPage,
    clearBrowserCookies,
    getAllCookies,
    fillInput,
    clickText,
    tryClickText,
    pageLooksBlocked,
    clickSelector,
    typeIntoSelector,
    clickFirstVisibleSelector,
};
