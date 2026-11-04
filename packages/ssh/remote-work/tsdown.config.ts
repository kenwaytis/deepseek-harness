import { defineConfig } from 'tsdown'
import { resolve } from 'node:path'
import { buildRemoteWorkRuntime } from '../../../scripts/build-remote-work-runtime.ts'

export default defineConfig({
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  onSuccess: async () => {
    await buildRemoteWorkRuntime(resolve(import.meta.dirname, '../../..'))
  },
})
