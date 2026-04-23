import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/api/gateway",
          destination: "http://localhost:18789",
        },
        {
          source: "/api/gateway/:path*",
          destination: "http://localhost:18789/:path*",
        },
        {
          source: "/api/:path*",
          destination: "http://localhost:3001/api/:path*",
        },
        {
          source: "/storage/:path*",
          destination: "http://localhost:3001/storage/:path*",
        },
      ],
    };
  },
};

export default nextConfig;
