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
            `  4. Account File     : ${config.accountFile} (${accounts.length} akun)`,
        );
        console.log(`  5. Browser Count    : ${config.browserCount}`);
        console.log("  6. ← Back");
        console.log("─".repeat(50));

        const { choice } = await inquirer.prompt([
            {
                type: "list",
                name: "choice",
                message: "Pilih setting yang ingin diubah:",
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
                        message: "Masukkan Router URL baru:",
                        default: config.routerUrl,
                        validate: (input) => {
                            try {
                                new URL(input);
                                return true;
                            } catch {
                                return "URL tidak valid. Contoh: http://100.112.135.61:5000/";
                            }
                        },
                    },
                ]);

                updateEnvValue("ROUTER_URL", value);
                reloadConfig();
                console.log("✅ Router URL diperbarui!");
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
                console.log("✅ PW Headless diperbarui!");
                break;
            }

            case "chrome_path": {
                const { value } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "value",
                        message: "Masukkan path Chrome executable:",
                        default: config.chromeExecutablePath,
                    },
                ]);

                updateEnvValue("CHROME_EXECUTABLE_PATH", value);
                reloadConfig();
                console.log("✅ Chrome path diperbarui!");
                break;
            }

            case "account_file": {
                const { value } = await inquirer.prompt([
                    {
                        type: "input",
                        name: "value",
                        message: "Masukkan nama file account:",
                        default: "accounts.txt",
                    },
                ]);

                updateEnvValue("ACCOUNT_FILE", value);
                reloadConfig();
                console.log("✅ Account file diperbarui!");
                break;
            }

            case "browser_count": {
                const { value } = await inquirer.prompt([
                    {
                        type: "number",
                        name: "value",
                        message: "Masukkan jumlah browser:",
                        default: config.browserCount,
                        validate: (input) => {
                            const num = Number(input);
                            if (!Number.isFinite(num) || num < 1) {
                                return "Harus angka >= 1";
                            }
                            return true;
                        },
                    },
                ]);

                updateEnvValue("BROWSER_COUNT", String(value));
                reloadConfig();
                console.log("✅ Browser count diperbarui!");
                break;
            }
        }
    }
}

module.exports = {
    openSettings,
};
