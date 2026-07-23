async function run() {
    const token = "cfut_31CFU00UCH6R7TOv2o98zIrtUNwhrnBCfpb8otND72dc13a0";
    const accountId = "a207fec2c56c6e81a35bb63ddcc4f713";
    
    try {
        console.log("Mocking projectName to proxy_baru_a207fe...");
        const response = await fetch("http://127.0.0.1:20128/api/proxy-pools/cloudflare-deploy", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                accountId: accountId,
                apiToken: token,
                projectName: "proxy_baru_a207fe",
            }),
        });
        const text = await response.text();
        if (!response.ok) {
            console.error("FAILED:", response.status, text);
        } else {
            console.log("SUCCESS:", text);
        }
    } catch (e) {
        console.error("FAILED:", e.message);
    }
}
run();
