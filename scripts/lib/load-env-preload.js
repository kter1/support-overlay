/**
 * @file scripts/lib/load-env-preload.js
 * @description Preload hook that loads `.env` before a script runs.
 *
 * Used via `ts-node -r ./scripts/lib/load-env-preload.js`. Unlike the startup
 * bootstrap this never *creates* the file — `npm run doctor` reporting missing
 * configuration is a true and useful answer, and a diagnostic command that
 * silently fixes what it is diagnosing is worse than one that reports.
 */
require("./local-env").loadEnvFile();
