const puppeteer = require('puppeteer-core');
const { sleep } = require('../../utils');
const { findChrome, hardenPage, clearBrowserCookies, getAllCookies, fillInput, clickText, tryClickText, pageLooksBlocked } = require('../../browser/helpers');

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

module.exports = {
    launchChrome,
};
