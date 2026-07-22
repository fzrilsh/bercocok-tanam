const axios = require("axios");

const AVAILABLE_DOMAINS = [
    "@ncaori.my.id",
    "@nca.my.id",
    "@nicoz2.ncait.it.com",
    "@kmx.ncait.it.com",
    "@nazox.ncait.it.com",
    "@storu.ncait.it.com",
    "@cinx.ncait.it.com",
    "@zxm.ncait.it.com",
    "@ij09.ncait.it.com",
    "@0okjad.ncait.it.com",
    "@mcnaz.ncait.it.com",
    "@ncaorinjcz.ncait.it.com",
    "@proror.ncait.it.com",
    "@prabowoz.ncait.it.com",
    "@jnkajnc.ncait.it.com",
    "@kmnx.ncait.it.com",
    "@39-knc.my.id",
    "@3aberkaskf-hafi.my.id",
    "@3hi-kokih.my.id",
    "@3himnih.my.id",
    "@apekah.my.id",
    "@bsigroup.biz.id",
    "@phydigile.biz.id",
    "@multho-vbe.my.id",
    "@nacima.my.id",
    "@ncaei.my.id"
];

let emailCounter = 0;

function generateRandomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function createTempEmail(accountIndex = null) {
    const usernameLength = 8 + Math.floor(Math.random() * 5);
    const username = generateRandomString(usernameLength);
    
    // Always use deterministic rotation
    const index = accountIndex !== null ? accountIndex : emailCounter++;
    const domain = AVAILABLE_DOMAINS[index % AVAILABLE_DOMAINS.length];
    
    const email = username + domain;
    return email;
}

async function waitForGitHubOTP(email, maxAttempts = 30, log = console.log) {
    log("Waiting for GitHub OTP email...");
    
    const headers = {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.7',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'priority': 'u=1, i',
        'referer': 'https://www.ncaori.my.id/',
        'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'sec-gpc': '1',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    };
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log(`Checking for GitHub OTP (attempt ${attempt}/${maxAttempts})...`);
        
        try {
            const encodedEmail = encodeURIComponent(email);
            const response = await axios.get(
                `https://www.ncaori.my.id/api/emails?recipient=${encodedEmail}`,
                { headers }
            );
            
            const data = response.data;
            
            if (data.emails && data.emails.length > 0) {
                for (const emailMsg of data.emails) {
                    if (emailMsg.sender && emailMsg.sender.includes('noreply@github.com') &&
                        emailMsg.subject && emailMsg.subject.toLowerCase().includes('launch code')) {
                        
                        const content = emailMsg.body_html || emailMsg.body_text || '';
                        
                        const otpMatch = content.match(/<span class="f00-light text-gray-dark sans-serif text-semibold"[^>]*>(\d{8})<\/span>/);
                        if (otpMatch) {
                            const otpCode = otpMatch[1];
                            log(`GitHub OTP code received: ${otpCode}`);
                            return otpCode;
                        }
                        
                        const plainOtpMatch = content.match(/(\d{8})/);
                        if (plainOtpMatch) {
                            const otpCode = plainOtpMatch[1];
                            log(`GitHub OTP code received (plain text): ${otpCode}`);
                            return otpCode;
                        }
                    }
                }
            }
        } catch (error) {
            log(`Error checking emails: ${error.message}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    throw new Error("GitHub OTP code not received within timeout");
}

module.exports = {
    createTempEmail,
    waitForGitHubOTP,
    AVAILABLE_DOMAINS
};
