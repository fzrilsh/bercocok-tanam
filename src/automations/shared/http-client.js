const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { sleep } = require("../../utils");

function buildStealthHeaders() {
    return {
        "accept": "application/json",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
}

function createAxiosInstance(proxy, log) {
    const config = {
        timeout: 30000,
        headers: buildStealthHeaders(),
        validateStatus: () => true,
    };

    if (proxy) {
        let proxyUrl = proxy;
        if (!proxy.startsWith("http://") && !proxy.startsWith("https://")) {
            proxyUrl = `http://${proxy}`;
        }

        try {
            const httpsAgent = new HttpsProxyAgent(proxyUrl);
            config.httpsAgent = httpsAgent;
            config.proxy = false;

            const proxyDisplay = proxyUrl.includes("@")
                ? proxyUrl.split("@")[1].replace(/^https?:\/\//, "")
                : proxyUrl.replace(/^https?:\/\//, "");

            log(`Using proxy: ${proxyDisplay}`);
        } catch (err) {
            log(`Proxy configuration error: ${err.message} - proceeding without proxy`);
        }
    }

    return axios.create(config);
}

async function axiosRequestWithRetry(axiosInstance, method, url, options, log, maxRetries = 100) {
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            const response = await axiosInstance.request({
                method,
                url,
                ...options,
            });

            if (response.status === 429) {
                attempt++;
                if (attempt < maxRetries) {
                    log(`Got HTTP 429, retry ${attempt}/${maxRetries} after 100ms...`);
                    await sleep(100);
                    continue;
                }
                throw new Error(`HTTP 429 persisted after ${maxRetries} retries`);
            }

            if (response.status >= 500 && response.status < 600) {
                attempt++;
                if (attempt < maxRetries) {
                    log(`Got ${response.status}, retry ${attempt}/${maxRetries} after 2s...`);
                    await sleep(2000);
                    continue;
                }
                throw new Error(`HTTP ${response.status} persisted after ${maxRetries} retries`);
            }

            return response;
        } catch (err) {
            if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || err.message.includes("timeout")) {
                attempt++;
                if (attempt < maxRetries) {
                    log(`Network timeout, retry ${attempt}/${maxRetries} after 2s...`);
                    await sleep(2000);
                    continue;
                }
            }

            throw err;
        }
    }

    throw new Error(`Max retries (${maxRetries}) exceeded`);
}

module.exports = {
    buildStealthHeaders,
    createAxiosInstance,
    axiosRequestWithRetry,
};
