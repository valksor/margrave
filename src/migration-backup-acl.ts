import { execFile } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseDirectoryPaxRecord(payload: Buffer, at: number, pax: Map<string, Buffer>): number {
  const space = payload.indexOf(32, at);
  const lengthText = payload.toString("ascii", at, space);
  if (!/^[0-9]+$/u.test(lengthText)) throw new Error("invalid pax record");
  const end = at + Number(lengthText);
  if (payload[end - 1] !== 10) throw new Error("invalid pax record");
  const record = payload.subarray(space + 1, end - 1);
  const equals = record.indexOf(61);
  if (equals < 0) throw new Error("invalid pax record");
  pax.set(record.subarray(0, equals).toString("utf8"), record.subarray(equals + 1));
  return end;
}

/** Read only the directory ACL records from a pax archive, in member order. */
async function directoryAcls(archive: string, directories: readonly string[]): Promise<unknown[]> {
  const handle = await open(archive, "r");
  const result: unknown[] = [];
  let pax = new Map<string, Buffer>();
  const read = async (length: number, position: number): Promise<Buffer> => {
    const bytes = Buffer.alloc(length);
    if ((await handle.read(bytes, 0, length, position)).bytesRead !== length) throw new Error("truncated metadata archive");
    return bytes;
  };
  const text = (bytes: Buffer): string => bytes.toString("utf8").replace(/\0.*/su, "");
  try {
    let header: Buffer;
    let size = 0;
    for (let offset = 0; !(header = await read(512, offset)).every((byte) => byte === 0); offset += 512 + Math.ceil(size / 512) * 512) {
      const sizeText = text(header.subarray(124, 136)).trim();
      if (!/^[0-7]+$/u.test(sizeText)) throw new Error("invalid metadata archive size");
      size = Number.parseInt(sizeText, 8);
      const type = header[156];
      if (type === 120) {
        const payload = await read(size, offset + 512);
        pax = new Map();
        for (let at = 0; at < payload.length; at = parseDirectoryPaxRecord(payload, at, pax));
      } else if (type === 53) {
        const prefix = text(header.subarray(345, 500));
        const name = pax.get("path")?.toString("utf8") ?? `${prefix === "" ? "" : `${prefix}/`}${text(header.subarray(0, 100))}`;
        const normalized = name.replace(/^\.\//u, "").replace(/\/$/u, "") || ".";
        if (normalized !== directories[result.length]) throw new Error("metadata archive members do not match");
        result.push([
          normalized,
          ...["SCHILY.acl.access", "SCHILY.acl.default", "SCHILY.acl.ace"].map((key) => pax.get(key)?.toString("base64") ?? null),
        ]);
        pax = new Map();
      } else throw new Error("unexpected metadata archive member");
    }
    if (result.length !== directories.length) throw new Error("metadata archive members do not match");
    return result;
  } finally {
    await handle.close();
  }
}

export async function directoryAclInventory(store: string, directories: readonly string[]): Promise<unknown[]> {
  const stage = await mkdtemp(path.join(path.dirname(store), ".margrave-upgrade-tmp-"));
  try {
    if (process.platform === "darwin") await execFileAsync("/bin/chmod", ["-N", stage]);
    const list = path.join(stage, "members");
    const archive = path.join(stage, "directories.tar");
    await writeFile(list, `${directories.map((name) => (name === "." ? "." : `./${name}`)).join("\0")}\0`, { mode: 0o600 });
    await execFileAsync(
      "/usr/bin/tar",
      ["--acls", "--no-xattrs", "--format", "pax", "--no-recursion", "-cf", archive, "-C", store, "--null", "-T", list],
      {
        env: { ...process.env, TAR_OPTIONS: undefined, COPYFILE_DISABLE: "1" },
      },
    );
    return await directoryAcls(archive, directories);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
