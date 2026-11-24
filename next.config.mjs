// Static export for GitHub Pages.
// For a project site (https://USER.github.io/REPO) set NEXT_PUBLIC_BASE_PATH=/REPO
// (the GitHub Action does this automatically). Leave empty for USER.github.io repos.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath,
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
