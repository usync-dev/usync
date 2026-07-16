import { connectDrive, type IOAuth2TokenState } from "@usync/drive";
import { DropboxAuthorizer, type TokenData } from "@usync/oauth2";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const CLIENT_ID = process.env.DROPBOX_CLIENT_ID!;
const REDIRECT_URL = "http://localhost:5678/callback";

if (!CLIENT_ID) {
  console.error("DROPBOX_CLIENT_ID is required");
  process.exit(1);
}

async function main() {
  const tokenPath = path.resolve(".tokens", "dropbox.json");

  let tokens: IOAuth2TokenState = {};
  try {
    tokens = JSON.parse(await fs.promises.readFile(tokenPath, "utf-8"));
  } catch {}

  if (!tokens.refreshToken?.token) {
    let accessTokenData: TokenData | null = null;
    let refreshTokenData: TokenData | null = null;

    const authorizer = new DropboxAuthorizer({
      clientId: CLIENT_ID,
      redirectUrl: REDIRECT_URL,
      onSetAccessToken: (value) => { accessTokenData = value; },
      onSetRefreshToken: (value) => { refreshTokenData = value; },
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
      driveProvider: "dropbox",
      auth: {
        authProvider: "dropbox",
        user: "demo",
        serverOptions: { clientId: CLIENT_ID, redirectUrl: REDIRECT_URL },
      },
    },
    { initialData: tokens },
  );

  const prefix = `__demo_${Date.now()}`;

  console.log("1. Uploading...");
  const file = await drive.put(
    { parent: {}, name: `${prefix}.txt` },
    new Blob(["hello from dropbox demo"]),
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

  console.log("\n✓ Dropbox demo passed");
}

main().catch((err) => {
  console.error("✗ Dropbox demo failed:", err);
  process.exit(1);
});
