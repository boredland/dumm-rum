import { chromium } from "playwright";

(async () => {
	const browser = await chromium.launch();
	const context = await browser.newContext();
	const page = await context.newPage();

	try {
		console.log("Navigating to http://localhost:5173/de...");
		await page.goto("http://localhost:5173/de", { waitUntil: "networkidle" });

		// Find the day filters container
		const todayButton = await page.locator('a[href="/de"]').first();
		const text = await todayButton.innerText();
		const box = await todayButton.boundingBox();
		const style = await todayButton.evaluate((el) => {
			const s = window.getComputedStyle(el);
			return {
				color: s.color,
				backgroundColor: s.backgroundColor,
				opacity: s.opacity,
				display: s.display,
				visibility: s.visibility,
				width: s.width,
				height: s.height,
				fontSize: s.fontSize,
				textContent: el.textContent,
			};
		});

		console.log("Today button stats:", {
			text,
			box,
			style,
		});

		await page.screenshot({ path: "today-button-debug.png" });
	} catch (error) {
		console.error("Error during debug:", error);
	} finally {
		await browser.close();
	}
})();
