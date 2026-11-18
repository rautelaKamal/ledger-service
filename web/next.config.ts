import type { NextConfig } from 'next';

const config: NextConfig = {
  // A self-contained server in .next/standalone: what the Docker image runs.
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
