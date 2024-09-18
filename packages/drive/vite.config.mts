import { readPackageUp } from "read-package-up";
import { defineConfig } from "vite";

const pkg = (await readPackageUp())!.packageJson;
const externals = Object.keys(pkg.dependencies || {});

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
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
