const puppeteer = require('puppeteer-core');
const { existsSync } = require('fs');

function findChrome() {
    const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Volumes/StorageTeamGroup/Browser/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    throw new Error('Chrome not found. Install Google Chrome or set CHROME_PATH in .env');
}

async function launchChrome(opts) {
    const executablePath = opts.chromePath || findChrome();
    const args = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,1024',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-features=IsolateOrigins,site-per-process,DisableLoadExtensionCommandLineSwitch',
    ];
    
    if (opts.extPath) {
        args.push(`--load-extension=${opts.extPath}`);
        args.push(`--disable-extensions-except=${opts.extPath}`);
    }
    
    if (opts.proxy) {
        args.push(`--proxy-server=${opts.proxy}`);
    }
    
    const browser = await puppeteer.launch({
        executablePath,
        headless: opts.headless || false,
        userDataDir: opts.profile,
        defaultViewport: { width: 1280, height: 1024 },
        args,
        ignoreDefaultArgs: ['--enable-automation'],
    });
    
    return browser;
}

async function hardenPage(page) {
    await page.setUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'accept-language': 'en-US,en;q=0.9',
    });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = window.chrome || { runtime: {} };
    });
}

async function clearBrowserCookies(browser) {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    const client = await page.createCDPSession();
    await client.send('Network.clearBrowserCookies');
}

async function getAllCookies(page) {
    const client = await page.createCDPSession();
    const { cookies } = await client.send('Network.getAllCookies');
    return cookies || [];
}

async function fillInput(page, sel, value, timeout = 15000, delay = 100) {
    await page.waitForSelector(sel, { timeout, visible: true });
    await page.focus(sel);
    await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (el) {
            el.focus();
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
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
    let lastErr = '';
    for (const sel of sels) {
        try {
            await page.locator(sel).setTimeout(timeout).click({ delay: 30 });
            return;
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
        }
    }
    let snippet = '';
    try {
        snippet = await page.evaluate(
            `(() => { const t = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim(); return t.slice(0, 180); })()`
        );
    } catch {
    }
    throw new Error(`clickText timeout: "${text}"${lastErr ? ` (${lastErr.slice(0, 120)})` : ''}${snippet ? ` | page: ${snippet}` : ''}`);
}

async function tryClickText(page, text, timeout = 3000) {
    try {
        await clickText(page, text, timeout);
        return true;
    } catch {
        return false;
    }
}

async function pageLooksBlocked(page) {
    try {
        const info = await page.evaluate(() => {
            const title = document.title || '';
            const body = (document.body?.innerText || '').slice(0, 500);
            return { title, body, url: location.href };
        });
        const blob = `${info.title}\n${info.body}\n${info.url}`.toLowerCase();
        if (blob.includes('attention required') || blob.includes('cf-error') || blob.includes('sorry, you have been blocked')) {
            return `cloudflare block: ${info.title || info.url}`;
        }
        if (blob.includes('just a moment') || blob.includes('checking your browser')) {
            return `cloudflare challenge: ${info.title || info.url}`;
        }
        return null;
    } catch {
        return null;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    findChrome,
    launchChrome,
    hardenPage,
    clearBrowserCookies,
    getAllCookies,
    fillInput,
    clickText,
    tryClickText,
    pageLooksBlocked,
    sleep,
};
