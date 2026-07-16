import { DriveProviders } from "@usync/drive";
import assert from "node:assert";

const BASE_URL = process.env.WEBDAV_BASE_URL;
const USER = process.env.WEBDAV_USER!;
const PASSWORD = process.env.WEBDAV_PASSWORD;

const INITIAL_CONTENT = "hello from webdav demo";
const OVERRIDDEN_CONTENT = "overridden content";

if (!BASE_URL || !USER || !PASSWORD) {
  console.error("WEBDAV_BASE_URL, WEBDAV_USER, and WEBDAV_PASSWORD are required");
  process.exit(1);
}

async function main() {
  const drive = new DriveProviders.webdav(
    {
      authProvider: "password",
      user: USER,
      password: PASSWORD,
      serverOptions: { baseUrl: BASE_URL },
    },
    {},
  );

  const prefix = `__demo_${Date.now()}`;

  console.log("1. Uploading...");
  const file = await drive.put(
    { parent: {}, name: `${prefix}.txt` },
    new Blob([INITIAL_CONTENT]),
  );
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
  console.log("   done");

  console.log("\n✓ WebDAV demo passed");
}

main().catch((err) => {
  console.error("✗ WebDAV demo failed:", err);
  process.exit(1);
});
