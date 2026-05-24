import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp();
await app.listen({ port, host });

let isShuttingDown = false;

async function shutdown(signal: string) {
	if (isShuttingDown) return;
	isShuttingDown = true;
	app.log.info({ signal }, "Shutting down server");
	try {
		await app.close();
		process.exit(0);
	} catch (error) {
		app.log.error({ error, signal }, "Server shutdown failed");
		process.exit(1);
	}
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void shutdown(signal);
	});
}
