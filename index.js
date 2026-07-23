const path = require("path");
const ora = require("ora");
const colors = require("ansi-colors");
const { getConfig, updateEnvValue, reloadConfig } = require("./src/config");
const { readAccounts, readProxyPool } = require("./src/utils");
const { openSettings } = require("./src/settings");
const { closeAllActiveBrowsers } = require("./src/browser");
const { runAccountCentric } = require("./src/orchestrator");
const fs = require("fs");
const retryDir = "./retryAccounts";

const PROVIDER_NAMES = {
    kiro: "Kiro",
    cloudflare: "Cloudflare",
    codebuddy: "Codebuddy",
    tokengo: "TokenGo",
    aerolink: "Aerolink",
    antigravity: "Antigravity",
    grokCLI: "GrokCLI",
};

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

async function retryFailedAccounts(failedAccountsList, selectedProviders, proxySettings) {
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

        if (!fs.existsSync(retryDir)) {
            fs.mkdirSync(retryDir, { recursive: true });
        }

        const tempAccountFile = path.join(retryDir, `retry-${Date.now()}.txt`);
        fs.writeFileSync(
            tempAccountFile,
            failedAccountsList.map((a) => a.rawLine).join("\n"),
        );

        const originalConfig = getConfig();
        updateEnvValue("ACCOUNT_FILE", tempAccountFile);
        reloadConfig();

        let result;
        try {
            result = await runAccountCentric(selectedProviders, proxySettings);
        } finally {
            updateEnvValue("ACCOUNT_FILE", originalConfig.accountFile);
            reloadConfig();
            try {
                if (fs.existsSync(tempAccountFile)) {
                    fs.unlinkSync(tempAccountFile);
                }
            } catch (e) {
                console.warn(`\n[WARNING] Failed to delete temp account file: ${tempAccountFile}. Please delete manually.`);
            }
        }

        if (!result || result.failedCount === 0) {
            console.log("✅ All accounts processed successfully!\n");
            break;
        }

        failedAccountsList = getFailedAccounts(result.results);

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
            (worker.accounts || []).filter((a) => !a.success).forEach((acc) => {
                failed.push({
                    email: acc.email,
                    rawLine: acc.rawLine,
                    error: acc.error,
                });
            });
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
    console.log("");
    const spinner = ora({
        text: colors.cyan(`Starting ${selectedAutomations.length} automation${selectedAutomations.length > 1 ? "s" : ""}...`),
        spinner: "dots",
    }).start();

    await new Promise((resolve) => setTimeout(resolve, 400));
    spinner.text = colors.cyan(
        `Shared browser: ${selectedAutomations.map((a) => PROVIDER_NAMES[a] || a).join(", ")}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    if (selectedAutomations.includes("codebuddy")) {
        console.log("");
        spinner.warn(colors.yellow("NOTE: Codebuddy (BETA) requires residential proxies to avoid account restrictions."));
    }

    if (selectedAutomations.includes("tokengo")) {
        console.log("");
        spinner.warn(colors.yellow("NOTE: TokenGo cooldown: 30-90s with proxy, 5-10min without proxy."));
    }

    spinner.succeed(colors.green("Account-centric run starting (1 account = 1 Chrome)..."));
    console.log("");

    const result = await runAccountCentric(selectedAutomations, proxySettings);

    if (result && result.failedCount > 0) {
        const failedAccounts = getFailedAccounts(result.results);
        if (failedAccounts.length > 0) {
            await retryFailedAccounts(failedAccounts, selectedAutomations, proxySettings);
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
                    kiro: { name: "Kiro" },
                    cloudflare: { name: "Cloudflare" },
                    codebuddy: { name: "Codebuddy" },
                    tokengo: { name: "TokenGo" },
                    aerolink: { name: "Aerolink" },
                    antigravity: { name: "Antigravity" },
                    grokCLI: { name: "GrokCLI" },
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
                                // checked: true,
                            },
                            {
                                name: "Codebuddy Automation [BETA] (Requires Residential Proxy)",
                                value: "codebuddy",
                            },
                            {
                                name: "TokenGo Automation (30-90s cooldown with proxy rotation)",
                                value: "tokengo",
                            },
                            {
                                name: "Aerolink Automation",
                                value: "aerolink",
                            },
                            {
                                name: "Antigravity Automation",
                                value: "antigravity",
                            },
                            {
                                name: "Grok CLI Automation",
                                value: "grokCLI",
                                checked: true,
                            },
                        ],
                        // No validation - allow empty selection to go back
                    },
                ]);

                if (selected.length > 0) {
                    const proxies = readProxyPool();
                    const proxySettings = {};

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
                                    choices: selected.map((type) => ({
                                        name: automationMap[type].name,
                                        value: type,
                                        checked: true,
                                    })),
                                },
                            ]);
                            selected.forEach((type) => {
                                proxySettings[type] = withProxy.includes(type);
                            });
                        }
                    } else {
                        selected.forEach((type) => {
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

process.on("SIGINT", () => {
    console.log(colors.yellow("\n[SIGINT] Interrupted by user. Closing browsers and exiting..."));
    closeAllActiveBrowsers().catch(() => {}).finally(() => {
        process.exit(0);
    });
});
