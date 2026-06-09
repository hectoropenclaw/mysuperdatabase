import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // API runs on port 4000 to avoid conflict with studio on 3000
}

export default nextConfig
