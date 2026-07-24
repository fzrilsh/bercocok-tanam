const path = require("path");
const ora = require("ora");
const colors = require("ansi-colors");
const { getConfig } = require("./src/config");
const { readAccounts, formatDuration, readProxyPool } = require("./src/utils");
const { runKiroAutomation } = require("./src/kiro");
const { runCloudflareAutomation } = require("./src/cloudflare");
const { runCodebuddyAutomation, runCodebuddyCreateAndImport } = require("./src/codebuddy");
const { runTokenGoAutomation } = require("./src/tokengo");
const { runGitHubSignupAutomation, checkPythonAvailable } = require("./src/github-signup-python");
const { runGrokAutomation } = require("./src/grok");
const { openSettings } = require("./src/settings");
const fs = require("fs");
const retryDir = './retryAccounts';

function countGithubKeys() {
    const keysPath = path.join(__dirname, "github_keys.txt");
    if (!fs.existsSync(keysPath)) return 0;
    return fs
        .readFileSync(keysPath, "utf-8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes(":")).length;
}

async function waitForEnter() {
    const inquirer = (await import("inquirer")).default;
    await inquirer.prompt([
        {
            type: "input",
            name: "continue",
            message: "Press Enter to return to menu...",
        },
    ]);
}

async function retryFailedAccounts(failedAccountsList, automationType) {
    const inquirer = (await import("inquirer")).default;

    if (automationType === 'github') {
        const { retry } = await inquirer.prompt([
            {
                type: "confirm",
                name: "retry",
                message: `${failedAccountsList.length} GitHub account(s) failed to create. Retry creating ${failedAccountsList.length} more account(s)?`,
                default: true,
            },
        ]);

        if (retry) {
            console.log(`\nRetrying GitHub signup for ${failedAccountsList.length} account(s)...\n`);
            const result = await runGitHubSignupAutomation(failedAccountsList.length, null, true);
            
            if (result && result.successCount > 0) {
                console.log(`✅ Successfully created ${result.successCount} GitHub account(s)!\n`);
            }
        } else {
            console.log(`Skipped retry for ${failedAccountsList.length} failed GitHub account(s).\n`);
        }
        return;
    }

    if (automationType === 'grok') {
        const { retry } = await inquirer.prompt([
            {
                type: "confirm",
                name: "retry",
                message: `${failedAccountsList.length} Grok account(s) failed to create. Retry creating ${failedAccountsList.length} more account(s)?`,
                default: true,
            },
        ]);

        if (retry) {
            console.log(`\nRetrying Grok signup for ${failedAccountsList.length} account(s)...\n`);
            const result = await runGrokAutomation(failedAccountsList.length, null, true);
            
            if (result && result.successCount > 0) {
                console.log(`✅ Successfully created ${result.successCount} Grok account(s)!\n`);
            }
        } else {
            console.log(`Skipped retry for ${failedAccountsList.length} failed Grok account(s).\n`);
        }
        return;
    }

    while (failedAccountsList.length > 0) {
        const { retry } = await inquirer.prompt([
            {
                type: "confirm",
                name: "retry",
                message: `${failedAccountsList.length} accounts failed. Retry failed accounts?`,
                default: true,
            },
        ]);

        if (!retry) {
            console.log(`Skipped retry for ${failedAccountsList.length} failed accounts.\n`);
            break;
        }

        console.log(`\nRetrying ${failedAccountsList.length} failed accounts...\n`);
        
        // Ensure the directory exists
        if (!fs.existsSync(retryDir)) {
            fs.mkdirSync(retryDir, { recursive: true });
        }

        const tempAccountFile = require("path").join(
            retryDir,
            `retry-${Date.now()}.txt`
        );

        fs.writeFileSync(
            tempAccountFile,
            failedAccountsList.map((a) => a.rawLine).join("\n")
        );

        const originalConfig = getConfig();
        const { updateEnvValue, reloadConfig } = require("./src/config");
        updateEnvValue("ACCOUNT_FILE", tempAccountFile);
        reloadConfig();

        let result;
        if (automationType === "kiro") {
            result = await runKiroAutomation();
        } else if (automationType === "cloudflare") {
            result = await runCloudflareAutomation();
        } else if (automationType === "codebuddy") {
            result = await runCodebuddyAutomation();
        } else if (automationType === "tokengo") {
            result = await runTokenGoAutomation(null, true, tokengoOptions || {});
        }

        updateEnvValue("ACCOUNT_FILE", originalConfig.accountFile);
        reloadConfig();

        try {
            fs.unlinkSync(tempAccountFile);
        } catch (e) {
            // Ignore cleanup errors
        }

        if (!result || result.failedCount === 0) {
            console.log("✅ All accounts processed successfully!\n");
            break;
        }

        failedAccountsList = failedAccountsList.filter((acc) =>
            fs.readFileSync(originalConfig.errorAccountFile, "utf-8").includes(acc.email)
        );

        if (failedAccountsList.length === 0) {
            console.log("✅ All retries succeeded!\n");
            break;
        }
    }
}

async function confirmAccountChanges(oldCount, newCount) {
    const inquirer = (await import("inquirer")).default;
    const { confirm } = await inquirer.prompt([
        {
            type: "confirm",
            name: "confirm",
            message: `Account file changed: ${oldCount} → ${newCount} accounts. Continue with automation?`,
            default: true,
        },
    ]);
    return confirm;
}

function getFailedAccounts(results) {
    const failed = [];
    if (results && Array.isArray(results)) {
        results.forEach((worker) => {
            if (worker.accounts) {
                worker.accounts.filter(a => !a.success).forEach(acc => {
                    failed.push({
                        email: acc.email,
                        rawLine: acc.rawLine,
                        error: acc.error,
                    });
                });
            }
        });
    }
    return failed;
}

function displayInfoPanel() {
    const config = getConfig();
    const accounts = readAccounts();
    const proxies = readProxyPool();

    const rows = [
        ["Router URL", config.routerUrl],
        ["PW Headless", config.headless ? "true" : "false"],
        ["Chrome Path", config.chromeExecutablePath],
        [
            "Account File",
            `${path.basename(config.accountFile)} (${accounts.length} accounts)`,
        ],
        ["Browser Count", String(config.browserCount)],
        ["Proxy Pool", proxies.length > 0 ? `${proxies.length} proxies` : "not configured"],
    ];

    const labelWidth = 15;
    const maxValueLen = Math.max(...rows.map(([, v]) => v.length));
    const innerWidth = labelWidth + 3 + maxValueLen;
    const boxWidth = innerWidth + 4;

    const title = "🌱 Bercocok Tanam CLI 🌱";
    const titleDisplayLen = title.length;
    const titlePadLeft = Math.floor((boxWidth - 2 - titleDisplayLen) / 2);
    const titlePadRight = boxWidth - titleDisplayLen - titlePadLeft - 2;

    console.log("");
    console.log(`╔${"═".repeat(boxWidth - 2)}╗`);
    console.log(
        `║${" ".repeat(titlePadLeft)}${title}${" ".repeat(titlePadRight)}║`,
    );
    console.log(`╠${"═".repeat(boxWidth - 2)}╣`);

    for (const [label, value] of rows) {
        const line = `${label.padEnd(labelWidth)}: ${value}`;
        console.log(`║  ${line.padEnd(boxWidth - 4)}║`);
    }

    console.log(`╚${"═".repeat(boxWidth - 2)}╝`);
    console.log("");
}

async function runSelectedAutomations(
    selectedAutomations,
    proxySettings,
    githubAccountCount = 1,
    githubTempEmailProvider = null,
    grokAccountCount = 1,
    grokTempEmailProvider = null,
    codebuddyOptions = null,
    tokengoOptions = null,
) {
    const { createProgressManager } = require("./src/progress");
    
    const automationMap = {
        kiro: { name: 'Kiro', fn: runKiroAutomation },
        cloudflare: { name: 'Cloudflare', fn: runCloudflareAutomation },
        codebuddy: { name: 'Codebuddy', fn: runCodebuddyAutomation },
        tokengo: { name: 'TokenGo', fn: runTokenGoAutomation },
        github: { name: 'GitHub Signup', fn: runGitHubSignupAutomation },
        grok: { name: 'Grok Signup', fn: runGrokAutomation }
    };

    console.log("");
    const spinner = ora({
        text: colors.cyan(`Starting ${selectedAutomations.length} automation${selectedAutomations.length > 1 ? 's' : ''}...`),
        spinner: 'dots'
    }).start();

    // Show which automations are selected
    await new Promise(resolve => setTimeout(resolve, 800));
    spinner.text = colors.cyan(`Running: ${selectedAutomations.map(a => automationMap[a].name).join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 800));

    if (selectedAutomations.includes('codebuddy')) {
        console.log("");
        spinner.warn(colors.yellow("NOTE: Codebuddy uses GitHub OAuth. Residential proxy recommended."));
    }
    
    if (selectedAutomations.includes('tokengo')) {
        console.log("");
        spinner.warn(colors.yellow("NOTE: TokenGo cooldown: 30-90s with proxy rotation, 5-10min without proxy."));
    }

    spinner.succeed(colors.green("Automations starting..."));
    console.log("");

    const startedAt = Date.now();
    const sharedProgress = createProgressManager(
        selectedAutomations.length > 1 
            ? "Running Multiple Automations" 
            : `Running ${automationMap[selectedAutomations[0]].name}`
    );

    // Run selected automations in parallel
    const promises = selectedAutomations.map(type => {
        if (type === 'github') {
            return automationMap[type].fn(githubAccountCount, sharedProgress, proxySettings[type], githubTempEmailProvider);
        }
        if (type === 'grok') {
            return automationMap[type].fn(grokAccountCount, sharedProgress, proxySettings[type], grokTempEmailProvider);
        }
        if (type === 'codebuddy') {
            // Create mode: each GitHub success immediately runs Codebuddy OAuth
            if (codebuddyOptions && codebuddyOptions.mode === 'create') {
                return runCodebuddyCreateAndImport(
                    codebuddyOptions.createCount || 1,
                    sharedProgress,
                    proxySettings.codebuddy,
                    codebuddyOptions.tempEmailProvider,
                );
            }
            // Existing mode: use github_keys.txt
            return automationMap[type].fn(sharedProgress, proxySettings[type]);
        }
        if (type === 'tokengo') {
            return automationMap[type].fn(sharedProgress, proxySettings[type], tokengoOptions || {});
        }
        return automationMap[type].fn(sharedProgress, proxySettings[type]);
    });

    const results = await Promise.all(promises);
    sharedProgress.stop();

    const duration = formatDuration(Date.now() - startedAt);

    // Build results summary
    const resultParts = [];
    selectedAutomations.forEach((type, i) => {
        const result = results[i];
        if (result) {
            resultParts.push(`${automationMap[type].name}: ${colors.green(`${result.successCount} success`)} ${colors.red(`${result.failedCount} failed`)}`);
        } else {
            resultParts.push(`${automationMap[type].name}: no accounts`);
        }
    });

    console.log("═".repeat(80));
    console.log(colors.bold.green(`Automation${selectedAutomations.length > 1 ? 's' : ''} Complete`));
    console.log("");
    resultParts.forEach(part => console.log(`  ${part}`));
    console.log("");
    console.log(`  ${colors.dim(`Duration: ${duration}`)}`);
    console.log("═".repeat(80));
    console.log("");

    // Handle retries for each automation
    for (let i = 0; i < selectedAutomations.length; i++) {
        const type = selectedAutomations[i];
        const result = results[i];
        
        if (result && result.failedCount > 0) {
            const failedAccounts = getFailedAccounts(result.results);
            if (failedAccounts.length > 0) {
                await retryFailedAccounts(failedAccounts, type);
            }
        }
    }

    await waitForEnter();
}

async function main() {
    const inquirer = (await import("inquirer")).default;
    let running = true;

    while (running) {
        console.clear();

        const initialAccounts = readAccounts();
        const initialCount = initialAccounts.length;

        displayInfoPanel();

        const { choice } = await inquirer.prompt([
            {
                type: "list",
                name: "choice",
                message: "Choose action:",
                choices: [
                    { name: "Run Automations", value: "run" },
                    { name: "Settings", value: "settings" },
                    { name: "Exit", value: "exit" },
                ],
            },
        ]);

        switch (choice) {
            case "run": {
                const currentAccounts = readAccounts();
                if (currentAccounts.length !== initialCount) {
                    const shouldContinue = await confirmAccountChanges(initialCount, currentAccounts.length);
                    if (!shouldContinue) {
                        continue;
                    }
                }

                const automationMap = {
                    kiro: { name: 'Kiro' },
                    cloudflare: { name: 'Cloudflare' },
                    codebuddy: { name: 'Codebuddy' },
                    tokengo: { name: 'TokenGo' },
                    github: { name: 'GitHub Signup' },
                    grok: { name: 'Grok Signup' }
                };

                const { selected } = await inquirer.prompt([
                    {
                        type: "checkbox",
                        name: "selected",
                        message: "Select automations to run (press Enter without selecting to go back):",
                        choices: [
                            { 
                                name: "Kiro Automation", 
                                value: "kiro",
                                checked: true
                            },
                            { 
                                name: "Cloudflare Automation", 
                                value: "cloudflare",
                                checked: true
                            },
                            { 
                                name: "Codebuddy Automation", 
                                value: "codebuddy"
                            },
                            { 
                                name: "TokenGo Automation (30-90s cooldown with proxy rotation)", 
                                value: "tokengo",
                                checked: true
                            },
                            { 
                                name: "GitHub Signup (Create new GitHub accounts)", 
                                value: "github"
                            },
                            { 
                                name: "Grok Signup (Create new Grok/x.ai accounts)", 
                                value: "grok"
                            },
                        ],
                        // No validation - allow empty selection to go back
                    },
                ]);

                if (selected.length > 0) {
                    let githubAccountCount = 1;
                    let githubTempEmailProvider = null;
                    let grokAccountCount = 1;
                    let grokTempEmailProvider = null;
                    let codebuddyOptions = null;
                    let tokengoOptions = null;
                    
                    if (selected.includes('github')) {
                        const { count } = await inquirer.prompt([
                            {
                                type: "input",
                                name: "count",
                                message: "How many GitHub accounts to create?",
                                default: "1",
                                validate: (input) => {
                                    const num = parseInt(input);
                                    if (isNaN(num) || num <= 0) {
                                        return "Please enter a valid positive number";
                                    }
                                    return true;
                                }
                            }
                        ]);
                        githubAccountCount = parseInt(count);

                        const { providers } = await inquirer.prompt([
                            {
                                type: "checkbox",
                                name: "providers",
                                message: "Select temp email providers (auto = random from selected):",
                                choices: [
                                    { name: "ncaori (stateless, no cookies)", value: "ncaori", checked: true },
                                    { name: "1secemail (stateful, with cookies)", value: "1secemail", checked: true },
                                    { name: "gmail (plus-address, OTP via Gmail API)", value: "gmail", checked: false },
                                ],
                            },
                        ]);
                        githubTempEmailProvider = providers.length === 0 ? "auto" : (providers.length === 1 ? providers[0] : providers);
                    }

                    if (selected.includes('grok')) {
                        const { count } = await inquirer.prompt([
                            {
                                type: "input",
                                name: "count",
                                message: "How many Grok accounts to create?",
                                default: "1",
                                validate: (input) => {
                                    const num = parseInt(input);
                                    if (isNaN(num) || num <= 0) {
                                        return "Please enter a valid positive number";
                                    }
                                    return true;
                                }
                            }
                        ]);
                        grokAccountCount = parseInt(count);

                        const { providers } = await inquirer.prompt([
                            {
                                type: "checkbox",
                                name: "providers",
                                message: "Select temp email providers for Grok signup (auto = random from selected):",
                                choices: [
                                    { name: "ncaori (stateless, no cookies)", value: "ncaori", checked: true },
                                    { name: "1secemail (stateful, with cookies)", value: "1secemail", checked: true },
                                    { name: "gmail (plus-address, OTP via Gmail API)", value: "gmail", checked: false },
                                ],
                            },
                        ]);
                        grokTempEmailProvider = providers.length === 0 ? "auto" : (providers.length === 1 ? providers[0] : providers);
                    }

                    if (selected.includes("codebuddy")) {
                        const existingCount = countGithubKeys();
                        const choices = [
                            {
                                name: `Use existing github_keys.txt (${existingCount} account${existingCount === 1 ? "" : "s"})`,
                                value: "existing",
                                disabled: existingCount === 0 ? "file empty / not found" : false,
                            },
                            {
                                name: "Create GitHub account then immediately login Codebuddy (per account)",
                                value: "create",
                            },
                        ];

                        const { codebuddyMode } = await inquirer.prompt([
                            {
                                type: "list",
                                name: "codebuddyMode",
                                message: "Codebuddy account source:",
                                choices,
                                default: existingCount > 0 ? "existing" : "create",
                            },
                        ]);

                        if (codebuddyMode === "create") {
                            const { createCount } = await inquirer.prompt([
                                {
                                    type: "input",
                                    name: "createCount",
                                    message: "How many accounts to create + import to Codebuddy?",
                                    default: "1",
                                    validate: (input) => {
                                        const num = parseInt(input);
                                        if (isNaN(num) || num <= 0) {
                                            return "Please enter a valid positive number";
                                        }
                                        return true;
                                    },
                                },
                            ]);

                            const { providers } = await inquirer.prompt([
                                {
                                    type: "checkbox",
                                    name: "providers",
                                    message: "Select temp email providers for GitHub signup (auto = random from selected):",
                                    choices: [
                                        { name: "ncaori (stateless, no cookies)", value: "ncaori", checked: true },
                                        { name: "1secemail (stateful, with cookies)", value: "1secemail", checked: true },
                                        { name: "gmail (plus-address, OTP via Gmail API)", value: "gmail", checked: false },
                                    ],
                                },
                            ]);

                            codebuddyOptions = {
                                mode: "create",
                                createCount: parseInt(createCount),
                                tempEmailProvider: providers.length === 0 ? "auto" : (providers.length === 1 ? providers[0] : providers),
                            };
                        } else {
                            codebuddyOptions = { mode: "existing" };
                        }
                    }

                    if (selected.includes("tokengo")) {
                        const existingGithub = countGithubKeys();
                        const choices = [
                            {
                                name: `Use existing github_keys.txt (${existingGithub} account${existingGithub === 1 ? "" : "s"})`,
                                value: "existing",
                                disabled: existingGithub === 0 ? "file empty / not found" : false,
                            },
                            {
                                name: "Create GitHub account then immediately login TokenGo (per account)",
                                value: "create",
                            },
                        ];

                        const { tokengoMode } = await inquirer.prompt([
                            {
                                type: "list",
                                name: "tokengoMode",
                                message: "TokenGo account source (GitHub OAuth):",
                                choices,
                                default: existingGithub > 0 ? "existing" : "create",
                            },
                        ]);

                        if (tokengoMode === "create") {
                            const { createCount } = await inquirer.prompt([
                                {
                                    type: "input",
                                    name: "createCount",
                                    message: "How many GitHub accounts to create + login to TokenGo?",
                                    default: "1",
                                    validate: (input) => {
                                        const num = parseInt(input);
                                        if (isNaN(num) || num <= 0) return "Please enter a valid positive number";
                                        return true;
                                    },
                                },
                            ]);

                            const { providers } = await inquirer.prompt([
                                {
                                    type: "checkbox",
                                    name: "providers",
                                    message: "Select temp email providers for GitHub signup (auto = random from selected):",
                                    choices: [
                                        { name: "ncaori (stateless, no cookies)", value: "ncaori", checked: true },
                                        { name: "1secemail (stateful, with cookies)", value: "1secemail", checked: true },
                                        { name: "gmail (plus-address, OTP via Gmail API)", value: "gmail", checked: false },
                                    ],
                                },
                            ]);

                            tokengoOptions = {
                                mode: "create",
                                authMode: "github",
                                createCount: parseInt(createCount),
                                tempEmailProvider: providers.length === 0 ? "auto" : (providers.length === 1 ? providers[0] : providers),
                            };
                        } else {
                            tokengoOptions = { mode: "existing", authMode: "github" };
                        }
                    }
                    
                    const proxies = readProxyPool();
                    let proxySettings = {};

                    if (proxies.length > 0) {
                        if (selected.length === 1) {
                            const { useProxy } = await inquirer.prompt([
                                {
                                    type: "confirm",
                                    name: "useProxy",
                                    message: `Use proxy pool (${proxies.length} proxies available)?`,
                                    default: true,
                                },
                            ]);
                            proxySettings[selected[0]] = useProxy;
                        } else {
                            const { withProxy } = await inquirer.prompt([
                                {
                                    type: "checkbox",
                                    name: "withProxy",
                                    message: `Select which automations should use proxy pool (${proxies.length} proxies):`,
                                    choices: selected.map(type => ({
                                        name: automationMap[type].name,
                                        value: type,
                                        checked: true,
                                    })),
                                },
                            ]);
                            selected.forEach(type => {
                                proxySettings[type] = withProxy.includes(type);
                            });
                        }

                    } else {
                        selected.forEach(type => {
                            proxySettings[type] = false;
                        });
                    }

                    await runSelectedAutomations(
                        selected,
                        proxySettings,
                        githubAccountCount,
                        githubTempEmailProvider,
                        grokAccountCount,
                        grokTempEmailProvider,
                        codebuddyOptions,
                        tokengoOptions,
                    );
                }
                // If selection is empty, just continue loop (back to main menu)
                break;
            }
            case "settings":
                await openSettings();
                break;
            case "exit":
                running = false;
                console.log(colors.cyan("Bye!"));
                break;
        }
    }
}

main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
});
