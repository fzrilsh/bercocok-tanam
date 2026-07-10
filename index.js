const path = require("path");
const { getConfig } = require("./src/config");
const { readAccounts, formatDuration } = require("./src/utils");
const { runKiroAutomation } = require("./src/kiro");
const { runCloudflareAutomation } = require("./src/cloudflare");
const { openSettings } = require("./src/settings");

async function waitForEnter() {
    const inquirer = (await import("inquirer")).default;
    await inquirer.prompt([
        {
            type: "input",
            name: "continue",
            message: "Tekan Enter untuk kembali ke menu...",
        },
    ]);
}

function displayInfoPanel() {
    const config = getConfig();
    const accounts = readAccounts();

    const rows = [
        ["Router URL", config.routerUrl],
        ["PW Headless", config.headless ? "true" : "false"],
        ["Chrome Path", config.chromeExecutablePath],
        [
            "Account File",
            `${path.basename(config.accountFile)} (${accounts.length} akun)`,
        ],
        ["Browser Count", String(config.browserCount)],
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
        `✅ All-in-One Selesai! ${kiroStr} │ ${cfStr} │ Durasi: ${duration}`,
    );
    console.log("");

    await waitForEnter();
}

async function main() {
    const inquirer = (await import("inquirer")).default;
    let running = true;

    while (running) {
        displayInfoPanel();

        const { choice } = await inquirer.prompt([
            {
                type: "list",
                name: "choice",
                message: "Pilih menu:",
                choices: [
                    { name: "1. 🔑 Kiro Automation", value: "kiro" },
                    { name: "2. ☁️  Cloudflare Automation", value: "cloudflare" },
                    { name: "3. 🚀 All-in-One Automation", value: "all" },
                    { name: "4. ⚙️  Settings", value: "settings" },
                    { name: "5. 🚪 Exit", value: "exit" },
                ],
            },
        ]);

        switch (choice) {
            case "kiro":
                await runKiroAutomation();
                break;
            case "cloudflare":
                await runCloudflareAutomation();
                break;
            case "all":
                await runAllInOne();
                break;
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
