import { MockCoreBank } from '@p2p/core-adapter';
import { buildMockCore } from './server.js';
import { seedDemo } from './demo-data.js';

const port = Number(process.env.PORT ?? 4100);
const bank = new MockCoreBank();
if (process.env.SEED_DEMO !== '0') seedDemo(bank);

const app = buildMockCore(bank, { logger: true });
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
