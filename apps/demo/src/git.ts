import { Git } from "@usync/drive/git";
import assert from "node:assert";

const GIT_URL = process.env.GIT_URL;
const GIT_USER = process.env.GIT_USER!;
const GIT_PASSWORD = process.env.GIT_PASSWORD;

const INITIAL_CONTENT = "hello from git demo";
const OVERRIDDEN_CONTENT = "overridden content";

if (!GIT_URL || !GIT_USER || !GIT_PASSWORD) {
  console.error("GIT_URL, GIT_USER, and GIT_PASSWORD are required");
  process.exit(1);
}

async function main() {
  const drive = new Git(
    {
      authProvider: "password",
      user: GIT_USER,
      password: GIT_PASSWORD,
      serverOptions: { url: GIT_URL, path: "" },
    },
    {},
  );

  const prefix = `__demo_${Date.now()}`;

  console.log("1. Uploading...");
  const file = await drive.put({ parent: {}, name: `${prefix}.txt` }, new Blob([INITIAL_CONTENT]));
  console.log(`   id:   ${file.id}`);
  console.log(`   name: ${file.name}`);
  console.log(`   size: ${file.size}`);

  console.log("2. Overwriting...");
  const overwritten = await drive.put(
    { parent: {}, name: `${prefix}.txt` },
    new Blob([OVERRIDDEN_CONTENT]),
  );
  console.log(`   id:   ${overwritten.id}`);
  console.log(`   name: ${overwritten.name}`);
  console.log(`   size: ${overwritten.size}`);

  console.log("3. Downloading by path...");
  const blobByPath = await drive.get({ path: `/${prefix}.txt` });
  assert.strictEqual(await blobByPath.text(), OVERRIDDEN_CONTENT);
  console.log(`   content: ${await blobByPath.text()}`);

  console.log("4. Downloading by id...");
  const blob = await drive.get({ id: overwritten.id });
  assert.strictEqual(await blob.text(), OVERRIDDEN_CONTENT);
  console.log(`   content: ${await blob.text()}`);

  console.log("5. Deleting...");
  await drive.remove({ id: overwritten.id });

  console.log("6. Flushing...");
  await drive.flush();
  console.log("   done");

  console.log("\n✓ Git demo passed");
}

main().catch((err) => {
  console.error("✗ Git demo failed:", err);
  process.exit(1);
});
