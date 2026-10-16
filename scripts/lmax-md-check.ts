// Market data only: logs on to LMAX's market data gateway, subscribes to top of book and prints a few quotes.
// Never touches the trading gateway. Usage: node --env-file=.env --import tsx scripts/lmax-md-check.ts [seconds]
import { FixSession, LMAX_DEMO, LMAX_INSTRUMENTS, type FixMessage } from '../packages/core-adapter/src/index.js';

const seconds = Number(process.argv[2] ?? 8);
const pairs = ['USDTRY', 'EURTRY', 'EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'XAGUSD'];
const byId = new Map(pairs.map((p) => [LMAX_INSTRUMENTS[p]!.id, p]));
const md = new FixSession({
  ...LMAX_DEMO.marketData,
  senderCompId: process.env.LMAX_FIX_USERNAME!,
  username: process.env.LMAX_FIX_USERNAME!,
  password: process.env.LMAX_FIX_PASSWORD!,
  log: { info: (_o, m) => console.log(m), warn: (o, m) => console.log(m, JSON.stringify({ ...o, err: (o as any).err?.message })) },
});
const last = new Map<string, string>();
md.on('logon', () => {
  console.log('logged on to market data; subscribing to', pairs.join(', '));
  md.send('V', [[262, 'check-1'], [263, 1], [264, 1], [265, 0], [267, 2], [269, 0], [269, 1], [146, pairs.length], ...pairs.flatMap((p) => [[48, LMAX_INSTRUMENTS[p]!.id], [22, 8]] as [number, string][])]);
});
md.on('message', (m: FixMessage) => {
  if (m.type === 'Y') return console.log('subscription rejected:', m.get(281), m.get(58));
  if (m.type !== 'W') return console.log('message', m.type, m.fields.map(([t, v]) => `${t}=${v}`).join('|'));
  const pair = byId.get(m.get(48) ?? '') ?? m.get(48);
  let side = '';
  const px: Record<string, string> = {};
  for (const [t, v] of m.fields) {
    if (t === 269) side = v;
    if (t === 270 && !px[side]) px[side] = v;
  }
  const line = `${pair}: bid ${px['0'] ?? '-'} / ask ${px['1'] ?? '-'}`;
  if (last.get(pair!) !== line) {
    last.set(pair!, line);
    console.log(line);
  }
});
md.start();
setTimeout(() => {
  console.log(md.loggedOn ? `done: ${last.size} pairs priced` : 'not logged on');
  md.stop();
  setTimeout(() => process.exit(0), 300);
}, seconds * 1000);
