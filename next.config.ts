import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ['node:sqlite'],
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
};

export default config;
