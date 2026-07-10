const { getConfig, reloadConfig, updateEnvValue } = require("./config");
const { readAccounts } = require("./utils");

async function openSettings() {
    const inquirer = (await import("inquirer")).default;
    let running = true;

    while (running) {
        const config = getConfig();
        const accounts = readAccounts();

        console.log("");
        console.log("⚙️  Settings");
        console.log("─".repeat(50));
        console.log(`  1. Router URL       : ${config.routerUrl}`);
        console.log(
            `  2. PW Headless      : ${config.headless ? "true (1)" : "false (0)"}`,
        );
        console.log(`  3. Chrome Executable: ${config.chromeExecutablePath}`);
        console.log(
            `  4. Account File     : ${config.accountFile} (${accounts.length} accounts)`,
        );
        console.log(`  5. Browser Count    : ${config.browserCount}`);
        console.log("  6. ← Back");
        console.log("─".repeat(50));

        const { choice } = await inquirer.prompt([
            {
                type: "list",
                name: "choice",
                message: "Choose setting to modify:",
                choices: [
                    { name: "1. Router URL", value: "router_url" },
                    { name: "2. PW Headless", value: "pw_headless" },
                    { name: "3. Chrome Executable", value: "chrome_path" },
                    { name: "4. Account File", value: "account_file" },
                    { name: "5. Browser Count", value: "browser_count" },
                    { name: "6. ← Back", value: "back" },
                ],
            },
        ]);

        if (choice === "back") {
            running = false;
            break;
        }

        switch (choice) {
            case "router_url": {
                const { value } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "value",
                        message: "Enter new Router URL:",
                        default: config.routerUrl,
                        validate: (input) => {
                            try {
                                new URL(input);
                                return true;
                            } catch {
                                return "Invalid URL. Example: http://100.112.135.61:5000/";
                            }
                        },
                    },
                ]);

                updateEnvValue("ROUTER_URL", value);
                reloadConfig();
                console.log("✅ Router URL updated!");
                break;
            }

            case "pw_headless": {
                const { value } = await inquirer.prompt([
                    {
                        type: "list",
                        name: "value",
                        message: "PW Headless mode:",
                        choices: [
                            { name: "true (headless)", value: "1" },
                            { name: "false (visible browser)", value: "0" },
                        ],
                        default: config.headless ? "1" : "0",
                    },
                ]);

                updateEnvValue("PW_HEADLESS", value);
                reloadConfig();
                console.log("✅ PW Headless updated!");
                break;
            }

            case "chrome_path": {
                const { value } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "value",
                        message: "Enter Chrome executable path:",
                        default: config.chromeExecutablePath,
                    },
                ]);

                updateEnvValue("CHROME_EXECUTABLE_PATH", value);
                reloadConfig();
                console.log("✅ Chrome path updated!");
                break;
            }

            case "account_file": {
                const { value } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "value",
                        message: "Enter account file name:",
                        default: "accounts.txt",
                    },
                ]);

                updateEnvValue("ACCOUNT_FILE", value);
                reloadConfig();
                console.log("✅ Account file updated!");
                break;
            }

            case "browser_count": {
                const { value } = await inquirer.prompt([
                    {
                        type: "number",
                        name: "value",
                        message: "Enter browser count:",
                        default: config.browserCount,
                        validate: (input) => {
                            const num = Number(input);
                            if (!Number.isFinite(num) || num < 1) {
                                return "Must be a number >= 1";
                            }
                            return true;
                        },
                    },
                ]);

                updateEnvValue("BROWSER_COUNT", String(value));
                reloadConfig();
                console.log("✅ Browser count updated!");
                break;
            }
        }
    }
}

module.exports = {
    openSettings,
};
