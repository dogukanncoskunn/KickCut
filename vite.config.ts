import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5184,
    strictPort: true,
    // Vite dies with EBUSY if it watches the .exe cargo is currently linking.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "esnext" },
});
