import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/gateway/:path*",
        destination: "http://localhost:18789/:path*",
      },
    ];
  },
};

export default nextConfig;
