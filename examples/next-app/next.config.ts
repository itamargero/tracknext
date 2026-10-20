import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Keep the example build's tracing local to this library workspace.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
};

export default config;
