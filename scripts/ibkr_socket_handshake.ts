/**
 * Non-destructive IB Gateway socket handshake probe.
 * Connects to 127.0.0.1:4002 (then 7497), prints managed account + server time, disconnects.
 * Does not place orders, does not open a browser, does not mutate Argus trading state.
 *
 * Usage: npx tsx scripts/ibkr_socket_handshake.ts
 */
import { IbkrSocketSession } from '../src/brokers/IbkrSocketSession';
import { loadIbkrConnection } from '../src/server/config/ibkrConnection';

async function main() {
  const cfg = loadIbkrConnection();
  console.log(JSON.stringify({ mode: cfg.mode, host: cfg.host, paperPorts: [cfg.paperGatewayPort, cfg.paperTwsPort] }, null, 2));

  const session = new IbkrSocketSession(cfg);
  const ok = await session.connect(false);
  const info = session.getConnectionInfo();
  console.log(JSON.stringify({ ok, ...info, tags: session.getAccountTags(), positions: session.getPositionsSnapshot().length }, null, 2));
  await session.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
