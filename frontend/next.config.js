/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // In production Nginx proxies /api/* straight to the backend, so this
    // rewrite never fires there -- it's a same-host fallback (and what
    // `next dev` uses locally). BACKEND_INTERNAL_URL lets it be pointed
    // anywhere without editing code; defaults to the backend's own default
    // host/port since both processes run on the same VM.
    const backendUrl = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:4000';
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
