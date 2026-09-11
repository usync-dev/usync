import { readPackageUp } from "read-package-up";
import { defineConfig } from "vite";

const pkg = (await readPackageUp())!.packageJson;
const externals = Object.keys(pkg.dependencies || {});

export default defineConfig({
  build: {
    lib: {
      entry: { index: "src/index.ts", "providers/git/index": "src/providers/git/index.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: (id) => {
        return (
          id.startsWith("node:") ||
          externals.some((name) => id === name || id.startsWith(`${name}/`))
        );
      },
      treeshake: {
        moduleSideEffects: false,
      },
    },
  },
});
