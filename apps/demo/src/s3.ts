import { S3 } from "@usync/drive";
import assert from "node:assert";

const ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID!;
const SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const BUCKET = process.env.S3_BUCKET;
const ENDPOINT = process.env.S3_ENDPOINT;
const REGION = process.env.S3_REGION;

const INITIAL_CONTENT = "hello from s3 demo";
const OVERRIDDEN_CONTENT = "overridden content";

if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET || !ENDPOINT) {
  console.error("S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, and S3_ENDPOINT are required");
  process.exit(1);
}

async function main() {
  const drive = new S3(
    {
      authProvider: "password",
      user: ACCESS_KEY_ID,
      password: SECRET_ACCESS_KEY,
      serverOptions: { bucket: BUCKET, endpoint: ENDPOINT, region: REGION },
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
  console.log("   done");

  console.log("\n✓ S3 demo passed");
}

main().catch((err) => {
  console.error("✗ S3 demo failed:", err);
  process.exit(1);
});
