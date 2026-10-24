import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import {
  artifactOccurrenceAt,
  writeOrderedZip,
} from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// "cafe" + combining acute U+0301 (NFD) versus precomposed U+00E9 (NFC).
const NFD_NAME = "caf\u0065\u0301.txt";
const NFC_NAME = "caf\u00e9.txt";
const NFD_DIR = "caf\u0065\u0301";
const NFC_DIR = "caf\u00e9";

const writeZipWithMember = async (
  path: string,
  name: string,
): Promise<void> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(name, new TextReader("evidence\n"));
  await writeFile(path, await writer.close());
};

describe("artifact inventory Unicode normalization", () => {
  it("keeps the NFC logical path and preserves the original NFD spelling", async () => {
    expect(NFD_NAME).not.toBe(NFC_NAME);
    expect(NFD_NAME.normalize("NFC")).toBe(NFC_NAME);
    const root = await createTestTempDirectory("rea-unicode-normalization-");
    const archive = join(root, "nfd.zip");
    await writeZipWithMember(archive, NFD_NAME);

    const inventory = await inventoryArtifact(archive);
    const occurrence = artifactOccurrenceAt(inventory, NFC_NAME);
    // Identity stays on the shared NFC spelling.
    expect(occurrence.logical_path).toBe(NFC_NAME);
    // The archive's decoded spelling is preserved, not silently replaced.
    const limitation = occurrence.limitations.find((item) =>
      item.includes("Unicode-normalized to NFC"),
    );
    expect(limitation).toBeDefined();
    expect(limitation).toContain(JSON.stringify(NFD_NAME));
    expect(limitation?.includes(NFD_NAME)).toBe(true);
  });

  it("names an on-disk folder as a directory path, not an archive member", async () => {
    expect(NFD_DIR).not.toBe(NFC_DIR);
    expect(NFD_DIR.normalize("NFC")).toBe(NFC_DIR);
    const root = await createTestTempDirectory("rea-unicode-normalization-");
    const directory = join(root, "source");
    await mkdir(join(directory, NFD_DIR), { recursive: true });
    await writeFile(join(directory, NFD_DIR, "evidence.txt"), "evidence\n");

    const inventory = await inventoryArtifact(directory);
    const occurrence = artifactOccurrenceAt(inventory, NFC_DIR);
    // Identity stays on the shared NFC spelling.
    expect(occurrence.logical_path).toBe(NFC_DIR);
    // The folder is a directory on disk, never an archive member.
    const limitation = occurrence.limitations.find((item) =>
      item.includes("Unicode-normalized to NFC"),
    );
    expect(limitation).toBeDefined();
    expect(limitation).toContain("Directory path");
    expect(limitation).not.toContain("Archive member");
    expect(limitation).toContain(JSON.stringify(NFD_DIR));
    expect(limitation?.includes(NFD_DIR)).toBe(true);
  });

  it("names a ZIP directory entry as a directory path with its trailing slash", async () => {
    const root = await createTestTempDirectory("rea-unicode-normalization-");
    const archive = join(root, "nfd-dir.zip");
    await writeOrderedZip(archive, [`${NFD_DIR}/`, `${NFD_DIR}/evidence.txt`]);

    const inventory = await inventoryArtifact(archive);
    const occurrence = artifactOccurrenceAt(inventory, NFC_DIR);
    // Identity stays on the shared NFC spelling; the slash is structural.
    expect(occurrence.logical_path).toBe(NFC_DIR);
    const limitation = occurrence.limitations.find((item) =>
      item.includes("Unicode-normalized to NFC"),
    );
    expect(limitation).toBeDefined();
    expect(limitation).toContain("Directory path");
    expect(limitation).not.toContain("Archive member");
    // A ZIP directory entry's decoded spelling carries its trailing slash.
    expect(limitation).toContain(JSON.stringify(`${NFD_DIR}/`));
    // The NFC spelling shown for a directory entry keeps its trailing slash.
    expect(limitation).toContain(JSON.stringify(`${NFC_DIR}/`));
    expect(limitation?.includes(NFD_DIR)).toBe(true);
  });

  it("records no limitation when the member name is already NFC", async () => {
    const root = await createTestTempDirectory("rea-unicode-normalization-");
    const archive = join(root, "nfc.zip");
    await writeZipWithMember(archive, NFC_NAME);

    const inventory = await inventoryArtifact(archive);
    const occurrence = artifactOccurrenceAt(inventory, NFC_NAME);
    expect(occurrence.logical_path).toBe(NFC_NAME);
    expect(
      occurrence.limitations.some((item) =>
        item.includes("Unicode-normalized to NFC"),
      ),
    ).toBe(false);
  });
});
