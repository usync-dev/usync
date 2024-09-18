import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackages } from "./util";

const CHANGESET_DIR = ".changeset";
const CHANGESET_FILE = join(CHANGESET_DIR, "patch-release.md");

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const packages = await getPackages();
  console.log(`Found ${packages.length} packages to release`);

  // Create changeset file listing all packages
  const content = `---
${packages.map((pkg) => `"${pkg.name}": patch`).join("\n")}
---

Patch release for all packages.
`;
  await writeFile(CHANGESET_FILE, content);
  console.log("Created changeset file");

  try {
    // Version packages
    const versionCmd = `pnpm exec changeset version`;
    execSync(versionCmd, { stdio: "inherit" });

    // Publish packages
    const publishCmd = `pnpm exec changeset publish --no-git-tag${dryRun ? " --dry-run" : ""}`;
    execSync(publishCmd, { stdio: "inherit" });
  } catch (error) {
    console.error("Error during release:", error);
    process.exit(1);
  }

  console.log("Release completed");
}

main();
