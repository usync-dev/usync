import { DriveProviders } from "@usync/drive";

const BASE_URL = process.env.WEBDAV_BASE_URL;
const USER = process.env.WEBDAV_USER!;
const PASSWORD = process.env.WEBDAV_PASSWORD;

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
    new Blob(["hello from webdav demo"]),
  );
  console.log(`   id:   ${file.id}`);
  console.log(`   name: ${file.name}`);
  console.log(`   size: ${file.size}`);

  console.log("2. Downloading by path...");
  const blobByPath = await drive.get({ path: `/${prefix}.txt` });
  console.log(`   content: ${await blobByPath.text()}`);

  console.log("3. Downloading by id...");
  const blob = await drive.get({ id: file.id });
  console.log(`   content: ${await blob.text()}`);

  console.log("4. Deleting...");
  await drive.remove({ id: file.id });
  console.log("   done");

  console.log("\n✓ WebDAV demo passed");
}

main().catch((err) => {
  console.error("✗ WebDAV demo failed:", err);
  process.exit(1);
});
