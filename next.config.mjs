/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Use the existing Clerk CNAME, not a build-time *.vercel.app proxy URL.
  env: {
    CLERK_DISABLE_AUTO_PROXY: "true",
  },
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
