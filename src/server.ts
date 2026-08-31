import { createApp } from "./app";
import { loadConfig } from "./domain";

const app = createApp(loadConfig());

if (require.main === module) app.listen(Number(process.env.PORT ?? 3000));

export default app;
