import type { NextConfig } from "next";

const backendOrigin = process.env.BACKEND_ORIGIN || process.env.NEXT_PUBLIC_BACKEND_ORIGIN || "http://localhost:3001";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/gateway/:path*",
        destination: "http://127.0.0.1:18789/:path*",
      },
      {
        source: "/api/backend/:path*",
        destination: `${backendOrigin}/api/:path*`,
      },
      {
        source: "/backend-storage/:path*",
        destination: `${backendOrigin}/storage/:path*`,
      },
    ];
  },
};

export default nextConfig;
