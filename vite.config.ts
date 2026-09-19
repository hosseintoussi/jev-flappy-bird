import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createJevHandler } from "./server/jev";

// The whole "backend" is one endpoint, mounted into Vite's own server so
// `npm run dev` is a single process. The API key stays in Node.
function jevApi(env: Record<string, string>): Plugin {
  const handler = createJevHandler(env);
  return {
    name: "jev-api",
    configureServer: (server) => void server.middlewares.use("/api/decide", handler),
    configurePreviewServer: (server) => void server.middlewares.use("/api/decide", handler),
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") } as Record<string, string>;
  return { plugins: [react(), jevApi(env)] };
});
