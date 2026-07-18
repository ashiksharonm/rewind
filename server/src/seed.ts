// CLI entry point: `npm run seed` — creates demo traces regardless of existing data.
import { connectMcp } from './mcp/client.js';
import { seedDemo } from './demo.js';

await connectMcp();
await seedDemo((msg) => console.log(`[seed] ${msg}`));
console.log('[seed] done.');
process.exit(0);
