import { execFile } from "node:child_process";

export async function getPackages() {
  const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile("pnpm", ["m", "ls", "--depth=-1", "--json"], (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
  const allPackages = JSON.parse(stdout) as Array<{
    name: string;
    version: string;
    path: string;
    private: boolean;
  }>;
  const packages = allPackages.filter((pkg) => !pkg.private);
  return packages;
}
