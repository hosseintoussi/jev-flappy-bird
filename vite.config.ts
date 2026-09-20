import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createJevHandler } from "./server/jev";

// The whole "backend" is one endpoint, mounted into Vite's own server so
// `npm run dev` is a single process. The API key stays in Node.
function jevApi(env: Record<string, string>): Plugin {
  // Created only when a server starts: the handler opens a connection to the API, which a build must not do.
  const mount = (server: { middlewares: Connect.Server }) => void server.middlewares.use("/api/decide", createJevHandler(env));
  return { name: "jev-api", configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") } as Record<string, string>;
  return { plugins: [react(), jevApi(env)] };
});
