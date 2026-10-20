import type { NextConfig } from 'next';

const config: NextConfig = {
  // Keep the example build's tracing local to this library workspace.
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
};

export default config;
