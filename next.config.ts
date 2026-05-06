import type { NextConfig } from "next";

const backendOrigin = process.env.BACKEND_ORIGIN || process.env.NEXT_PUBLIC_BACKEND_ORIGIN || "http://localhost:3001";

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
          destination: `${backendOrigin}/api/:path*`,
        },
        {
          source: "/storage/:path*",
          destination: `${backendOrigin}/storage/:path*`,
        },
      ],
    };

  },
};

export default nextConfig;
