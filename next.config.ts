import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/gateway/:path*",
        destination: "http://127.0.0.1:18789/:path*",
      },
    ];
  },
};

export default nextConfig;
