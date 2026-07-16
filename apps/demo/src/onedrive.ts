import { connectDrive, type IOAuth2TokenState } from "@usync/drive";
import { MicrosoftAuthorizer, type TokenData } from "@usync/oauth2";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const CLIENT_ID = process.env.ONEDRIVE_CLIENT_ID!;
const CLIENT_SECRET = process.env.ONEDRIVE_CLIENT_SECRET!;
const REDIRECT_URL = "http://localhost:5678/callback";

const INITIAL_CONTENT = "hello from onedrive demo";
const OVERRIDDEN_CONTENT = "overridden content";

if (!CLIENT_ID) {
  console.error("ONEDRIVE_CLIENT_ID is required");
  process.exit(1);
}

async function main() {
  const tokenPath = path.resolve(".tokens", "onedrive.json");

  let tokens: IOAuth2TokenState = {};
  try {
    tokens = JSON.parse(await fs.promises.readFile(tokenPath, "utf-8"));
  } catch {}

  if (!tokens.refreshToken?.token) {
    let accessTokenData: TokenData | null = null;
    let refreshTokenData: TokenData | null = null;

    const authorizer = new MicrosoftAuthorizer({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUrl: REDIRECT_URL,
      scope: "openid profile Files.ReadWrite.AppFolder offline_access",
      provider: {
        microsoft: {
          accountType: "consumers",
        },
      },
      onSetAccessToken: (value) => {
        accessTokenData = value;
      },
      onSetRefreshToken: (value) => {
        refreshTokenData = value;
      },
    });

    const url = await authorizer.buildAuthUrl();
    console.log("\nOpen this URL in your browser and authorize:\n");
    console.log(url);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const cb = await new Promise<string>((resolve) => {
      rl.question("\nPaste the callback URL: ", (a) => {
        rl.close();
        resolve(a.trim());
      });
    });

    await authorizer.finishAuth(new URL(cb));

    tokens = {
      accessToken: accessTokenData ?? undefined,
      refreshToken: refreshTokenData ?? undefined,
    };
    await fs.promises.writeFile(tokenPath, JSON.stringify(tokens, null, 2));
    console.log("Tokens saved.\n");
  }

  const drive = await connectDrive(
    {
      driveProvider: "onedrive",
      auth: {
        authProvider: "microsoft",
        user: "demo",
        serverOptions: {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          redirectUrl: REDIRECT_URL,
          scope: "openid profile Files.ReadWrite.AppFolder offline_access",
        },
      },
    },
    { initialData: tokens },
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

  console.log("\n✓ OneDrive demo passed");
}

main().catch((err) => {
  console.error("✗ OneDrive demo failed:", err);
  process.exit(1);
});
