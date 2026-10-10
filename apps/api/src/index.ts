import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3200);
const app = createApp();

app.listen(port, () => {
  console.log(`Prompt Forge API listening on http://localhost:${port}`);
});
