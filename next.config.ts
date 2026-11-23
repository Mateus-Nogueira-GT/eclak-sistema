import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  experimental: {
    // Anexos (até 10 MB) sobem por Server Action: o padrão é 1 MB; folga para o envelope do multipart.
    serverActions: { bodySizeLimit: "11mb" },
    // O proxy (src/proxy.ts) bufferiza o corpo até 10 MB por padrão e corta o resto sem erro: o mesmo limite.
    proxyClientMaxBodySize: "11mb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
