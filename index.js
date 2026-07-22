const path = require("path");
const ora = require("ora");
const colors = require("ansi-colors");
const { getConfig } = require("./src/config");
const { readAccounts, formatDuration, readProxyPool } = require("./src/utils");
const { runKiroAutomation } = require("./src/kiro");
const { runCloudflareAutomation } = require("./src/cloudflare");
const { runCodebuddyAutomation } = require("./src/codebuddy");
const { runTokenGoAutomation } = require("./src/tokengo");
const { runAerolinkAutomation } = require("./src/aerolink");
const { openSettings } = require("./src/settings");
const { closeAllActiveBrowsers } = require("./src/browser");
const fs = require("fs");
const retryDir = './retryAccounts';

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
            result = await runTokenGoAutomation();
        } else if (automationType === "aerolink") {
            result = await runAerolinkAutomation();
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

async function runSelectedAutomations(selectedAutomations, proxySettings) {
    const { createProgressManager } = require("./src/progress");
    
    const automationMap = {
        kiro: { name: 'Kiro', fn: runKiroAutomation },
        cloudflare: { name: 'Cloudflare', fn: runCloudflareAutomation },
        codebuddy: { name: 'Codebuddy', fn: runCodebuddyAutomation },
        tokengo: { name: 'TokenGo', fn: runTokenGoAutomation },
        aerolink: { name: 'Aerolink', fn: runAerolinkAutomation }
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
        spinner.warn(colors.yellow("NOTE: Codebuddy (BETA) requires residential proxies to avoid account restrictions."));
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
    const promises = selectedAutomations.map(type => 
        automationMap[type].fn(sharedProgress, proxySettings[type])
    );

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
                    aerolink: { name: 'Aerolink' }
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
                            },
                            { 
                                name: "Cloudflare Automation", 
                                value: "cloudflare",
                            },
                            { 
                                name: "Codebuddy Automation [BETA] (Requires Residential Proxy)", 
                                value: "codebuddy"
                            },
                            {
                                name: "TokenGo Automation (30-90s cooldown with proxy rotation)",
                                value: "tokengo",
                            },
                            {
                                name: "Aerolink Automation",
                                value: "aerolink",
                                checked: true
                            },
                        ],
                        // No validation - allow empty selection to go back
                    },
                ]);

                if (selected.length > 0) {
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

                    await runSelectedAutomations(selected, proxySettings);
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

process.on("SIGINT", async () => {
    console.log(colors.yellow("\n[SIGINT] Interrupted by user. Closing browsers and exiting..."));
    try {
        await closeAllActiveBrowsers();
    } catch (e) {
        // ignore
    }
    process.exit(0);
});
