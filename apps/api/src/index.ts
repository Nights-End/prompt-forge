import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3200);
// Loopback by default: this is a single-user local service, and the only
// other program that talks to it (the SillyTavern extension) runs on the same
// machine. Override with FORGE_HOST only when there is a reason to.
const host = process.env.FORGE_HOST ?? '127.0.0.1';
const app = createApp();

app.listen(port, host, () => {
  console.log(`Prompt Forge API listening on http://${host}:${port}`);
});
