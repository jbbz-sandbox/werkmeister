/** @type {import('next').NextConfig} */
// 'standalone' bundles a minimal server + only the node_modules it actually uses
// into .next/standalone, so the Docker runtime image stays small (no full node_modules copy).
module.exports = { output: 'standalone' };
