import { DriveProviders } from "@usync/drive";

const ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID!;
const SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const BUCKET = process.env.S3_BUCKET;
const ENDPOINT = process.env.S3_ENDPOINT;
const REGION = process.env.S3_REGION;

if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET || !ENDPOINT) {
  console.error("S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, and S3_ENDPOINT are required");
  process.exit(1);
}

async function main() {
  const drive = new DriveProviders.s3(
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
  const file = await drive.put(
    { parent: {}, name: `${prefix}.txt` },
    new Blob(["hello from s3 demo"]),
  );
  console.log(`   id:   ${file.id}`);
  console.log(`   name: ${file.name}`);
  console.log(`   size: ${file.size}`);

  console.log("2. Downloading...");
  const blob = await drive.get({ id: file.id });
  console.log(`   content: ${await blob.text()}`);

  console.log("3. Deleting...");
  await drive.remove({ id: file.id });
  console.log("   done");

  console.log("\n✓ S3 demo passed");
}

main().catch((err) => {
  console.error("✗ S3 demo failed:", err);
  process.exit(1);
});
