const path = require("path");
const { getConfig } = require("./src/config");
const { readAccounts, formatDuration, readProxyPool } = require("./src/utils");
const { runKiroAutomation } = require("./src/kiro");
const { runCloudflareAutomation } = require("./src/cloudflare");
const { runProxyAutomation } = require("./src/proxy");
const { openSettings } = require("./src/settings");
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
        } else if (automationType === "proxy") {
            result = await runProxyAutomation();
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
    const titleDisplayLen = title.length + 2;
    const titlePadLeft = Math.floor((boxWidth - 2 - titleDisplayLen) / 2);
    const titlePadRight = boxWidth - titleDisplayLen - titlePadLeft;

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

async function runAllInOne() {
    const { createProgressManager } = require("./src/progress");

    console.log("");
    console.log("🌱 Starting All-in-One Automation...");
    console.log("   Kiro and Cloudflare will run in parallel.");
    console.log("   Each will use its own set of browsers.");
    console.log("");

    const startedAt = Date.now();
    const sharedProgress = createProgressManager("🚀 All-in-One Automation");

    const [kiroResult, cfResult] = await Promise.all([
        runKiroAutomation(sharedProgress),
        runCloudflareAutomation(sharedProgress),
    ]);

    sharedProgress.stop();

    const duration = formatDuration(Date.now() - startedAt);

    console.log("═".repeat(60));

    const kiroStr = kiroResult
        ? `Kiro: ${kiroResult.successCount} success, ${kiroResult.failedCount} failed`
        : "Kiro: no accounts";

    const cfStr = cfResult
        ? `CF: ${cfResult.successCount} success, ${cfResult.failedCount} failed`
        : "CF: no accounts";

    console.log(
        `✅ All-in-One Complete! ${kiroStr} │ ${cfStr} │ Duration: ${duration}`,
    );
    console.log("");

    if (kiroResult && kiroResult.failedCount > 0) {
        const failedKiro = getFailedAccounts(kiroResult.results);
        if (failedKiro.length > 0) {
            await retryFailedAccounts(failedKiro, "kiro");
        }
    }

    if (cfResult && cfResult.failedCount > 0) {
        const failedCF = getFailedAccounts(cfResult.results);
        if (failedCF.length > 0) {
            await retryFailedAccounts(failedCF, "cloudflare");
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
                message: "Choose menu:",
                choices: [
                    { name: "1. 🔑 Kiro Automation", value: "kiro" },
                    { name: "2. ☁️  Cloudflare Automation", value: "cloudflare" },
                    { name: "3. 🔐 Proxy Automation", value: "proxy" },
                    { name: "4. 🚀 All-in-One Automation", value: "all" },
                    { name: "5. ⚙️  Settings", value: "settings" },
                    { name: "6. 🚪 Exit", value: "exit" },
                ],
            },
        ]);

        switch (choice) {
            case "kiro": {
                const currentAccounts = readAccounts();
                if (currentAccounts.length !== initialCount) {
                    const shouldContinue = await confirmAccountChanges(initialCount, currentAccounts.length);
                    if (!shouldContinue) {
                        continue;
                    }
                }
                const kiroResult = await runKiroAutomation();
                if (kiroResult && kiroResult.failedCount > 0) {
                    const failedAccounts = getFailedAccounts(kiroResult.results);
                    if (failedAccounts.length > 0) {
                        await retryFailedAccounts(failedAccounts, "kiro");
                    }
                }
                await waitForEnter();
                break;
            }
            case "cloudflare": {
                const currentAccounts = readAccounts();
                if (currentAccounts.length !== initialCount) {
                    const shouldContinue = await confirmAccountChanges(initialCount, currentAccounts.length);
                    if (!shouldContinue) {
                        continue;
                    }
                }
                const cfResult = await runCloudflareAutomation();
                if (cfResult && cfResult.failedCount > 0) {
                    const failedAccounts = getFailedAccounts(cfResult.results);
                    if (failedAccounts.length > 0) {
                        await retryFailedAccounts(failedAccounts, "cloudflare");
                    }
                }
                await waitForEnter();
                break;
            }
            case "proxy": {
                const currentAccounts = readAccounts();
                if (currentAccounts.length !== initialCount) {
                    const shouldContinue = await confirmAccountChanges(initialCount, currentAccounts.length);
                    if (!shouldContinue) {
                        continue;
                    }
                }
                const proxyResult = await runProxyAutomation();
                if (proxyResult && proxyResult.failedCount > 0) {
                    const failedAccounts = getFailedAccounts(proxyResult.results);
                    if (failedAccounts.length > 0) {
                        await retryFailedAccounts(failedAccounts, "proxy");
                    }
                }
                await waitForEnter();
                break;
            }
            case "all": {
                const currentAccounts = readAccounts();
                if (currentAccounts.length !== initialCount) {
                    const shouldContinue = await confirmAccountChanges(initialCount, currentAccounts.length);
                    if (!shouldContinue) {
                        continue;
                    }
                }
                await runAllInOne();
                break;
            }
            case "settings":
                await openSettings();
                break;
            case "exit":
                running = false;
                console.log("👋 Bye!");
                break;
        }
    }
}

main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
});
