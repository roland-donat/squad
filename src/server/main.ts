import { startSquadServer } from "./server";

const port = process.env.SQUAD_PORT ? Number(process.env.SQUAD_PORT) : undefined;
const server = await startSquadServer({ port });

console.log(`squad is listening on ${server.url}`);
console.log(`state directory: ${server.dataDir}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
