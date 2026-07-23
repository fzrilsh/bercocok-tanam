const colors = require("ansi-colors");

function formatTime(ms) {
    const seconds = (ms / 1000).toFixed(1);
    return `${seconds}s`;
}

function printReport(title, workerStats, totalDuration) {
    console.log("");
    console.log(colors.green.bold("═".repeat(80)));
    console.log(colors.green.bold(`  ${title}`));
    console.log(colors.green.bold("═".repeat(80)));
    console.log("");

    const allSuccessful = [];
    const allFailed = [];
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalProcessingTime = 0;

    workerStats.forEach((stats) => {
        totalProcessed += stats.accounts.length;
        allSuccessful.push(...stats.accounts.filter((a) => a.success));
        allFailed.push(...stats.accounts.filter((a) => !a.success));
        totalSuccess += stats.accounts.filter((a) => a.success).length;
        totalFailed += stats.accounts.filter((a) => !a.success).length;
        totalProcessingTime += stats.accounts.reduce((sum, a) => sum + a.duration, 0);
    });

    console.log(colors.cyan.bold("📊 OVERALL SUMMARY"));
    console.log(colors.gray("─".repeat(80)));
    console.log(`  Total Accounts       : ${colors.white.bold(totalProcessed)}`);
    console.log(`  ${colors.green("✅ Success")}          : ${colors.green.bold(totalSuccess)} accounts`);
    console.log(`  ${colors.red("❌ Failed")}           : ${colors.red.bold(totalFailed)} accounts`);
    console.log(`  Success Rate         : ${colors.yellow.bold(`${totalProcessed > 0 ? ((totalSuccess / totalProcessed) * 100).toFixed(1) : 0}%`)}`);
    console.log(`  Total Duration       : ${colors.white(formatDuration(totalDuration))}`);

    if (totalProcessed > 0) {
        const avgTime = totalProcessingTime / totalProcessed;
        console.log(`  Average per Account  : ${colors.white(formatTime(avgTime))}`);
    }

    console.log("");

    console.log(colors.cyan.bold("👷 WORKER DETAILS"));
    console.log(colors.gray("─".repeat(80)));

    workerStats.forEach((stats) => {
        const successCount = stats.accounts.filter((a) => a.success).length;
        const failedCount = stats.accounts.filter((a) => !a.success).length;
        const avgWorkerTime = stats.accounts.length > 0
            ? stats.accounts.reduce((sum, a) => sum + a.duration, 0) / stats.accounts.length
            : 0;

        console.log("");
        console.log(`  ${colors.yellow.bold(stats.label)}`);
        console.log(`    Processed: ${stats.accounts.length} accounts | ✅ ${successCount} | ❌ ${failedCount}`);
        console.log(`    Average: ${formatTime(avgWorkerTime)}/account`);

        if (stats.accounts.length > 0) {
            console.log("    Accounts:");
            stats.accounts.forEach((acc) => {
                const statusIcon = acc.success ? colors.green("✅") : colors.red("❌");
                const timeStr = colors.gray(formatTime(acc.duration));
                const emailStr = acc.success
                    ? colors.white(acc.email)
                    : colors.red(acc.email);
                console.log(`      ${statusIcon} ${emailStr} ${timeStr}`);
            });
        }
    });

    if (allFailed.length > 0) {
        console.log("");
        console.log(colors.red.bold("❌ FAILED ACCOUNTS"));
        console.log(colors.gray("─".repeat(80)));

        allFailed.forEach((acc) => {
            console.log(`  ${colors.red("•")} ${colors.white(acc.email)}`);
            if (acc.error) {
                console.log(`    ${colors.gray(`Error: ${acc.error}`)}`);
            }
        });

        console.log("");
        console.log(colors.yellow("  💡 Check errorAccounts.txt for complete details"));
    }

    console.log("");
    console.log(colors.green.bold("═".repeat(80)));
    console.log("");
}

function formatDuration(milliseconds) {
    const totalSeconds = Math.round(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
}

module.exports = {
    printReport,
    formatTime,
    formatDuration,
};
