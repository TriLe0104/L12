/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  devIndicators: false,
  async rewrites() {
    const api = (process.env.API_PROXY || process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8001").replace(
      /\/$/,
      "",
    );
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/uploads/:path*", destination: `${api}/uploads/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
