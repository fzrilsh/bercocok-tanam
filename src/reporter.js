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

    console.log(colors.cyan.bold("📊 RINGKASAN KESELURUHAN"));
    console.log(colors.gray("─".repeat(80)));
    console.log(`  Total Akun Diproses  : ${colors.white.bold(totalProcessed)}`);
    console.log(`  ${colors.green("✅ Berhasil")}          : ${colors.green.bold(totalSuccess)} akun`);
    console.log(`  ${colors.red("❌ Gagal")}             : ${colors.red.bold(totalFailed)} akun`);
    console.log(`  Success Rate         : ${colors.yellow.bold(`${totalProcessed > 0 ? ((totalSuccess / totalProcessed) * 100).toFixed(1) : 0}%`)}`);
    console.log(`  Total Durasi         : ${colors.white(formatDuration(totalDuration))}`);

    if (totalProcessed > 0) {
        const avgTime = totalProcessingTime / totalProcessed;
        console.log(`  Rata-rata per Akun   : ${colors.white(formatTime(avgTime))}`);
    }

    console.log("");

    console.log(colors.cyan.bold("👷 DETAIL PER WORKER"));
    console.log(colors.gray("─".repeat(80)));

    workerStats.forEach((stats) => {
        const successCount = stats.accounts.filter((a) => a.success).length;
        const failedCount = stats.accounts.filter((a) => !a.success).length;
        const avgWorkerTime = stats.accounts.length > 0
            ? stats.accounts.reduce((sum, a) => sum + a.duration, 0) / stats.accounts.length
            : 0;

        console.log("");
        console.log(`  ${colors.yellow.bold(stats.label)}`);
        console.log(`    Processed: ${stats.accounts.length} akun | ✅ ${successCount} | ❌ ${failedCount}`);
        console.log(`    Rata-rata: ${formatTime(avgWorkerTime)}/akun`);

        if (stats.accounts.length > 0) {
            console.log(`    Akun:`);
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
        console.log(colors.red.bold("❌ DAFTAR AKUN GAGAL"));
        console.log(colors.gray("─".repeat(80)));

        allFailed.forEach((acc) => {
            console.log(`  ${colors.red("•")} ${colors.white(acc.email)}`);
            if (acc.error) {
                console.log(`    ${colors.gray(`Error: ${acc.error}`)}`);
            }
        });

        console.log("");
        console.log(colors.yellow(`  💡 Cek file errorAccounts.txt untuk detail lengkap`));
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
