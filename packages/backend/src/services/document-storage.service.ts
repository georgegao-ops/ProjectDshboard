import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { UUID } from "@contractor/shared";
import { getEnv } from "../config/env";
import { logger } from "../lib/logger";

interface NormalizedTextSaveInput {
  orgId: string;
  projectId: UUID;
  fileId: UUID;
  versionHash?: string;
  text: string;
}

interface NormalizedTextSaveResult {
  objectKey: string;
  checksum: string;
  normalizedTextLength: number;
  storedAt: Date;
  encryptionKeyVersion?: number;
}

interface NormalizedTextReadInput {
  orgId: string;
  projectId: UUID;
  objectKey: string;
}

async function listFilePathsRecursively(rootPath: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(rootPath, entry.name);
      if (entry.isDirectory()) {
        return listFilePathsRecursively(absolutePath);
      }

      if (entry.isFile()) {
        return [absolutePath];
      }

      return [];
    })
  );

  return nested.flat();
}

function sanitizePathToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildObjectKey(input: {
  orgId: string;
  projectId: UUID;
  fileId: UUID;
  versionHash?: string;
}): string {
  const versionHash = sanitizePathToken(input.versionHash ?? "v1");
  return [
    "org",
    sanitizePathToken(input.orgId),
    "project",
    sanitizePathToken(input.projectId),
    "file",
    sanitizePathToken(input.fileId),
    "version",
    versionHash,
    "normalized.txt.gz",
  ].join("/");
}

function decodeEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("DOCUMENT_STORAGE_ENCRYPTION_KEY is empty.");
  }

  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    key = Buffer.from(trimmed, "base64");
  }

  if (key.length !== 32) {
    throw new Error("DOCUMENT_STORAGE_ENCRYPTION_KEY must decode to 32 bytes.");
  }

  return key;
}

function maybeEncrypt(payload: Buffer): {
  payload: Buffer;
  encrypted: boolean;
  keyVersion?: number;
} {
  const env = getEnv();
  if (!env.documentStorageEncryptionKey) {
    return {
      payload,
      encrypted: false,
    };
  }

  const key = decodeEncryptionKey(env.documentStorageEncryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    payload: Buffer.concat([iv, tag, ciphertext]),
    encrypted: true,
    keyVersion: env.documentStorageEncryptionKeyVersion,
  };
}

function maybeDecrypt(payload: Buffer): Buffer {
  const env = getEnv();
  if (!env.documentStorageEncryptionKey) {
    return payload;
  }

  const key = decodeEncryptionKey(env.documentStorageEncryptionKey);
  if (payload.length < 28) {
    throw new Error("Encrypted payload is too short.");
  }

  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Validates that objectKey belongs to the org/project and resolves within the storage root.
 * Returns the absolute path to the object file.
 */
function resolveAndValidateObjectPath(
  root: string,
  orgId: string,
  projectId: UUID,
  objectKey: string
): string {
  const expectedPrefix = `org/${sanitizePathToken(orgId)}/project/${sanitizePathToken(projectId)}/`;
  if (!objectKey.startsWith(expectedPrefix)) {
    throw new Error(
      `Object key does not belong to provided org/project. Expected prefix: ${expectedPrefix}`
    );
  }

  const absolutePath = path.resolve(root, objectKey);
  if (!absolutePath.startsWith(root + path.sep) && absolutePath !== root) {
    throw new Error(
      `Path traversal detected: resolved path is outside storage root. This is a security violation.`
    );
  }

  return absolutePath;
}

export const documentStorageService = {
  async saveNormalizedText(input: NormalizedTextSaveInput): Promise<NormalizedTextSaveResult> {
    const env = getEnv();
    const objectKey = buildObjectKey(input);
    const checksum = sha256(input.text);
    const normalizedTextLength = input.text.length;
    const compressed = gzipSync(Buffer.from(input.text, "utf8"));
    const encrypted = maybeEncrypt(compressed);

    const root = path.resolve(process.cwd(), env.documentStorageLocalRoot);
    const absolutePath = path.resolve(root, objectKey);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, encrypted.payload);

    const storedAt = new Date();
    logger.info("document-storage.normalized-text.saved", {
      orgId: input.orgId,
      projectId: input.projectId,
      fileId: input.fileId,
      objectKey,
      encrypted: encrypted.encrypted,
      checksum,
      normalizedTextLength,
      keyVersion: encrypted.keyVersion,
    });

    return {
      objectKey,
      checksum,
      normalizedTextLength,
      storedAt,
      encryptionKeyVersion: encrypted.keyVersion,
    };
  },

  async readNormalizedText(input: NormalizedTextReadInput): Promise<{ text: string; checksum: string }> {
    const env = getEnv();
    const root = path.resolve(process.cwd(), env.documentStorageLocalRoot);
    const absolutePath = resolveAndValidateObjectPath(root, input.orgId, input.projectId, input.objectKey);

    const payload = await readFile(absolutePath);
    const decrypted = maybeDecrypt(payload);
    const text = gunzipSync(decrypted).toString("utf8");

    logger.info("document-storage.normalized-text.read", {
      orgId: input.orgId,
      projectId: input.projectId,
      objectKey: input.objectKey,
      normalizedTextLength: text.length,
    });

    return {
      text,
      checksum: sha256(text),
    };
  },

  async deleteNormalizedText(input: NormalizedTextReadInput): Promise<void> {
    const env = getEnv();
    const root = path.resolve(process.cwd(), env.documentStorageLocalRoot);
    const absolutePath = resolveAndValidateObjectPath(root, input.orgId, input.projectId, input.objectKey);

    await rm(absolutePath, { force: true });

    logger.info("document-storage.normalized-text.deleted", {
      orgId: input.orgId,
      projectId: input.projectId,
      objectKey: input.objectKey,
    });
  },

  async objectExists(input: NormalizedTextReadInput): Promise<boolean> {
    const env = getEnv();
    const root = path.resolve(process.cwd(), env.documentStorageLocalRoot);
    const absolutePath = resolveAndValidateObjectPath(root, input.orgId, input.projectId, input.objectKey);

    try {
      const info = await stat(absolutePath);
      return info.isFile();
    } catch {
      return false;
    }
  },

  async listProjectObjectKeys(input: { orgId: string; projectId: UUID }): Promise<string[]> {
    const env = getEnv();
    const root = path.resolve(process.cwd(), env.documentStorageLocalRoot);
    const prefix = path.resolve(
      root,
      `org/${sanitizePathToken(input.orgId)}/project/${sanitizePathToken(input.projectId)}`
    );

    const absolutePaths = await listFilePathsRecursively(prefix);
    return absolutePaths.map((absolutePath) =>
      path.relative(root, absolutePath).split(path.sep).join("/")
    );
  },
};
