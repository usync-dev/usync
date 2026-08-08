export function delay(time: number) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

export function b64encode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
