const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { getConfig } = require("./config");
const {
    sleep,
    createFileLogger,
    formatDuration,
    acquireProxy,
    releaseProxy,
} = require("./utils");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");
const { createTempEmail } = require("./temp-email-helper");

const PROJECT_ROOT = path.join(__dirname, '..');
const PYTHON_SCRIPT = path.join(PROJECT_ROOT, 'src', 'github_signup.py');
const PYTHON_VENV_PATH = path.join(PROJECT_ROOT, 'venv', 'bin', 'python3');
const GITHUB_KEYS_FILE = path.join(PROJECT_ROOT, 'github_keys.txt');

function checkPythonAvailable() {
    return new Promise((resolve) => {
        const pythonPath = PYTHON_VENV_PATH;
        const python = spawn(pythonPath, ['--version']);
        
        python.on('close', (code) => {
            resolve(code === 0);
        });
        
        python.on('error', () => {
            resolve(false);
        });
        
        setTimeout(() => {
            python.kill();
            resolve(false);
        }, 3000);
    });
}

async function createGitHubAccountViaPython(accountIndex, useProxy, log, updateProgress, tempEmailProvider = null) {
    const config = getConfig();
    
    let poolProxy = null;
    let proxyUrl = null;

    if (config.proxyPoolFile && useProxy) {
        poolProxy = await acquireProxy(log, updateProgress);
        proxyUrl = poolProxy;
    }

    updateProgress({ step: STEPS.LAUNCHING, email: "Creating temp email..." });
    log("Creating temporary email...");
    
    const provider = tempEmailProvider || config.tempEmailProvider || "auto";
    const tempEmail = await createTempEmail(accountIndex, log, provider);
    const username = tempEmail.email.split('@')[0];
    
    log(`Temporary email created: ${tempEmail.email}`);
    updateProgress({ step: STEPS.LAUNCHING, email: tempEmail.email });
    
    return new Promise((resolve, reject) => {
        const args = [
            '-u',  // Unbuffered output for real-time logs
            PYTHON_SCRIPT,
            '--email', tempEmail.email,
            '--provider', tempEmail.provider,
        ];
        
        // Only pass csrf-token and cookies for stateful providers (1secemail)
        if (tempEmail.csrfToken && tempEmail.cookies) {
            args.push('--csrf-token', tempEmail.csrfToken);
            args.push('--cookies', tempEmail.cookies);
        }
        
        if (proxyUrl) {
            args.push('--proxy', proxyUrl);
        }
        
        if (config.headless) {
            args.push('--headless');
        }
        
        const chromeBinary = config.chromeExecutablePath || 
                           '/Volumes/StorageTeamGroup/Browser/Google Chrome.app/Contents/MacOS/Google Chrome';
        args.push('--chrome-binary', chromeBinary);
        
        // Pass Node binary + gmail OTP CLI path for gmail provider (Python calls back to read OTP)
        if (tempEmail.provider === "gmail") {
            args.push('--node-binary', process.execPath);
            args.push('--gmail-otp-cli', path.join(__dirname, 'gmail-otp-cli.js'));
        }
        
        log(`Executing Python script with email: ${tempEmail.email} (provider: ${tempEmail.provider})`);
        if (proxyUrl) log(`Using proxy: ${proxyUrl.split('@')[1] || proxyUrl}`);
        
        const python = spawn(PYTHON_VENV_PATH, args);
        
        let output = '';
        let errorOutput = '';
        let lastLogTime = Date.now();
        
        python.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            
            const lines = text.split('\n').filter(line => line.trim());
            lines.forEach(line => {
                log(`[Python] ${line}`);
                
                // Parse detailed status from Python logs
                if (line.includes('Launching browser')) {
                    updateProgress({ step: STEPS.LAUNCHING, email: "Launching browser..." });
                } else if (line.includes('Setting up Chrome options')) {
                    updateProgress({ step: STEPS.LAUNCHING, email: "Setting up options..." });
                } else if (line.includes('Starting Chrome browser')) {
                    updateProgress({ step: STEPS.LAUNCHING, email: "Starting Chrome (10-30s)..." });
                } else if (line.includes('Browser launched successfully')) {
                    updateProgress({ step: STEPS.LAUNCHING, email: "Browser ready" });
                } else if (line.includes('Loading warm cookies')) {
                    updateProgress({ step: STEPS.LAUNCHING, email: "Loading cookies..." });
                } else if (line.includes('Navigating to') && line.includes('github.com/signup')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Opening GitHub..." });
                } else if (line.includes('Starting GitHub signup form')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Loading signup form..." });
                } else if (line.includes('Checking for bot detection')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Checking challenges..." });
                } else if (line.includes('[EMAIL]') && line.includes('Typing')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Typing email..." });
                } else if (line.includes('[EMAIL]') && line.includes('entered')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Email entered" });
                } else if (line.includes('[PASSWORD]') && line.includes('Typing')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Typing password..." });
                } else if (line.includes('[PASSWORD]') && line.includes('entered')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Password entered" });
                } else if (line.includes('[USERNAME]') && line.includes('Typing')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Typing username..." });
                } else if (line.includes('[USERNAME]') && line.includes('entered')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Username entered" });
                } else if (line.includes('[SUBMIT]') && line.includes('Clicking')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Submitting form..." });
                } else if (line.includes('Form submission complete')) {
                    updateProgress({ step: STEPS.NAVIGATING, email: "Form submitted" });
                } else if (line.includes('Waiting for GitHub OTP')) {
                    updateProgress({ step: STEPS.WAITING, email: "Waiting for OTP email..." });
                } else if (line.includes('Checking for GitHub OTP')) {
                    const attemptMatch = line.match(/attempt (\d+)\/(\d+)/);
                    if (attemptMatch) {
                        updateProgress({ step: STEPS.WAITING, email: `Checking OTP (${attemptMatch[1]}/${attemptMatch[2]})...` });
                    }
                } else if (line.includes('GitHub OTP code received')) {
                    const otpMatch = line.match(/received:\s*(\d+)/);
                    if (otpMatch) {
                        updateProgress({ step: STEPS.WAITING, email: `OTP received: ${otpMatch[1]}` });
                    }
                } else if (line.includes('Entering OTP code')) {
                    updateProgress({ step: STEPS.WAITING, email: "Entering OTP..." });
                } else if (line.includes('Waiting for redirect')) {
                    updateProgress({ step: STEPS.WAITING, email: "Finalizing..." });
                } else if (line.includes('GitHub account created successfully')) {
                    updateProgress({ step: STEPS.DONE, email: tempEmail.email });
                } else if (line.includes('GitHub bot detection triggered')) {
                    updateProgress({ step: STEPS.WAITING, email: "Challenge detected! Solving..." });
                } else if (line.includes('Captcha detected')) {
                    updateProgress({ step: STEPS.WAITING, email: "Captcha - solve manually" });
                }
            });
            
            lastLogTime = Date.now();
        });
        
        python.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            
            if (!text.includes('DevTools') && !text.includes('deprecated')) {
                log(`[Python Error] ${text.trim()}`);
            }
        });
        
        python.on('error', (error) => {
            log(`[Error] Failed to spawn Python: ${error.message}`);
            if (poolProxy) releaseProxy(poolProxy);
            reject(new Error(`Failed to spawn Python process: ${error.message}`));
        });
        
        python.on('close', (code) => {
            if (poolProxy) {
                releaseProxy(poolProxy);
                log(`[Proxy] Released: ${poolProxy.split(':')[0]}`);
            }
            
            if (code === 0) {
                log('Python process completed successfully');
                const accountData = parseAccountFromOutput(output);
                if (accountData) {
                    // Save to github_keys.txt
                    const accountLine = `${accountData.email}:${accountData.password}:${accountData.username}\n`;
                    try {
                        fs.appendFileSync(GITHUB_KEYS_FILE, accountLine, 'utf8');
                        log(`Account saved to ${GITHUB_KEYS_FILE}`);
                    } catch (err) {
                        log(`Warning: Could not save to file: ${err.message}`);
                    }
                    
                    resolve({
                        success: true,
                        account: accountData
                    });
                } else {
                    reject(new Error('Failed to parse account data from output'));
                }
            } else {
                log(`Python process exited with code ${code}`);
                reject(new Error(`Python exited with code ${code}: ${errorOutput || 'No error details'}`));
            }
        });
        
        const timeout = setTimeout(() => {
            log('⏰ Python process timeout (10 minutes), killing...');
            python.kill('SIGKILL');
            if (poolProxy) releaseProxy(poolProxy);
            reject(new Error('Python process timeout (10 minutes)'));
        }, 10 * 60 * 1000);
        
        python.on('close', () => {
            clearTimeout(timeout);
        });
        
        const heartbeatCheck = setInterval(() => {
            if (Date.now() - lastLogTime > 2 * 60 * 1000) {
                log('⚠️  No output from Python for 2 minutes, might be stuck');
                clearInterval(heartbeatCheck);
            }
        }, 30000);
        
        python.on('close', () => {
            clearInterval(heartbeatCheck);
        });
    });
}

function parseAccountFromOutput(output) {
    const emailMatch = output.match(/Email:\s*([^\s]+)/);
    const passwordMatch = output.match(/Password:\s*([^\s]+)/);
    const usernameMatch = output.match(/Username:\s*([^\s]+)/);
    
    if (emailMatch && passwordMatch && usernameMatch) {
        return {
            email: emailMatch[1],
            password: passwordMatch[1],
            username: usernameMatch[1]
        };
    }
    
    const accountLineMatch = output.match(/([^\s]+):([^\s]+):([^\s]+)/);
    if (accountLineMatch) {
        return {
            email: accountLineMatch[1],
            password: accountLineMatch[2],
            username: accountLineMatch[3]
        };
    }
    
    return null;
}

async function runGitHubWorker(
    accountCount,
    workerId,
    browserArgsIndex,
    workerIndex,
    total,
    progress,
    log,
    useProxy = true,
    tempEmailProvider = null,
) {
    const config = getConfig();

    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;

    const accountStats = [];

    for (let i = 0; i < accountCount; i++) {
        const updateProgress = (payload) => {
            progress.updateWorker(workerId, {
                ...payload,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        };

        const startTime = Date.now();
        let accountSuccess = false;
        let accountError = null;
        let accountEmail = "processing";
        let accountData = null;

        try {
            updateProgress({ step: STEPS.LAUNCHING, email: "Creating account..." });
            
            const result = await createGitHubAccountViaPython(
                workerIndex * accountCount + i,
                useProxy,
                log,
                updateProgress,
                tempEmailProvider,
            );

            if (result.success && result.account) {
                accountData = result.account;
                accountEmail = accountData.email;
                accountSuccess = true;
                successCount += 1;
                processedCount += 1;
                
                accountStats.push({
                    email: accountData.email,
                    rawLine: `${accountData.email}:${accountData.password}:${accountData.username}`,
                    success: true,
                    duration: Date.now() - startTime,
                    error: null,
                    accountData: accountData
                });

                progress.updateWorker(workerId, {
                    step: STEPS.DONE,
                    email: accountEmail,
                    success: successCount,
                    failed: failedCount,
                    current: processedCount,
                });
            } else {
                throw new Error('No account created');
            }
        } catch (error) {
            accountSuccess = false;
            accountError = error.message;
            failedCount += 1;
            processedCount += 1;

            log(`[${workerId}] Error: ${error.message}`);

            progress.updateWorker(workerId, {
                step: STEPS.ERROR,
                email: accountEmail,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
            
            accountStats.push({
                email: accountEmail,
                rawLine: `failed-${i+1}`,
                success: false,
                duration: Date.now() - startTime,
                error: accountError,
            });
        }

        if (i < accountCount - 1) {
            progress.updateWorker(workerId, { step: STEPS.WAITING });
            await sleep(config.delays.betweenAccounts || 10000);
        }
    }

    progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: "Done",
        success: successCount,
        failed: failedCount,
        current: accountCount,
    });

    return {
        successCount,
        failedCount,
        accounts: accountStats,
        label: `GitHub W${workerIndex + 1}`,
    };
}

async function runGitHubSignupAutomation(accountCount = 1, sharedProgress = null, useProxy = true, tempEmailProvider = null) {
    const config = getConfig();
    const logger = createFileLogger();

    const pythonAvailable = await checkPythonAvailable();
    if (!pythonAvailable) {
        const errorMsg = "❌ Python 3 not found! Please install Python 3 to use GitHub signup.";
        logger.log(errorMsg);
        if (!sharedProgress) {
            console.log("");
            console.log(errorMsg);
            console.log("   Install: brew install python3 (macOS) or apt install python3 (Linux)");
            console.log("");
        }
        logger.close();
        return null;
    }

    if (accountCount <= 0) {
        if (!sharedProgress) { console.log("Account count must be greater than 0"); }
        logger.close();
        return null;
    }

    if (!sharedProgress) {
        console.log("");
        console.log("🐙 GitHub Signup Automation (Python + undetected-chromedriver)");
        console.log(`   Creating ${accountCount} GitHub account(s)`);
        console.log("");
    }

    const startedAt = Date.now();
    const workerCount = Math.min(config.browserCount, accountCount);
    const accountsPerWorker = Math.ceil(accountCount / workerCount);

    const progress =
        sharedProgress ||
        createProgressManager(
            `🐙 GitHub Signup — ${accountCount} accounts, ${workerCount} workers (Python)`,
        );

    for (let i = 0; i < workerCount; i++) {
        const workerAccounts = Math.min(accountsPerWorker, accountCount - (i * accountsPerWorker));
        progress.addWorker(`github-${i}`, workerAccounts, `GitHub W${i + 1}`);
    }

    const results = await Promise.all(
        Array.from({ length: workerCount }, (_, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;
            const workerAccounts = Math.min(accountsPerWorker, accountCount - (i * accountsPerWorker));

            return runGitHubWorker(
                workerAccounts,
                `github-${i}`,
                browserArgsIndex,
                i,
                accountCount,
                progress,
                logger.log,
                useProxy,
                tempEmailProvider,
            );
        }),
    );

    if (!sharedProgress) {
        progress.stop();
    }

    const successCount = results.reduce((sum, r) => sum + r.successCount, 0);
    const failedCount = results.reduce((sum, r) => sum + r.failedCount, 0);
    const totalDuration = Date.now() - startedAt;

    if (!sharedProgress) {
        printReport("🐙 GITHUB SIGNUP AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `GitHub Signup finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();

    return { successCount, failedCount, results };
}

module.exports = {
    runGitHubSignupAutomation,
    createGitHubAccountViaPython,
    checkPythonAvailable,
};
