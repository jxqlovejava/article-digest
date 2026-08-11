import COS from 'cos-nodejs-sdk-v5';
import fs from 'fs';

// ponytail: 所有 COS 交互只在这一个文件;未配置时 isCosEnabled()=false,调用方整体回退本地存储
const SECRET_ID = process.env.COS_SECRET_ID || '';
const SECRET_KEY = process.env.COS_SECRET_KEY || '';
const BUCKET = process.env.COS_BUCKET || '';
const REGION = process.env.COS_REGION || '';
const BASE_URL = (process.env.COS_BASE_URL || '').replace(/\/+$/, '');

export type CosKind = 'video' | 'image';

// 对象标签(x-cos-tagging),key 必须与控制台创建的标签键一致,默认 type=video / type=image
const TAGS: Record<CosKind, string> = {
  video: process.env.COS_TAG_VIDEO || 'type=video',
  image: process.env.COS_TAG_IMAGE || 'type=image',
};

let client: COS | null = null;

export function isCosEnabled(): boolean {
  return Boolean(SECRET_ID && SECRET_KEY && BUCKET && REGION && BASE_URL);
}

function getClient(): COS {
  if (!client) {
    client = new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY });
  }
  return client;
}

export function cosUrl(key: string): string {
  return `${BASE_URL}/${key}`;
}

/** 上传本地文件到 COS 并打上 kind 对应的对象标签,成功返回公网 URL */
export async function uploadToCos(localPath: string, key: string, contentType: string, kind: CosKind): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    getClient().putObject({
      Bucket: BUCKET,
      Region: REGION,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: contentType,
      Headers: { 'x-cos-tagging': TAGS[kind] },
    }, (err) => (err ? reject(err) : resolve()));
  });
  return cosUrl(key);
}

/** 对象是否已存在(迁移脚本断点续传用) */
export async function cosObjectExists(key: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      getClient().headObject({ Bucket: BUCKET, Region: REGION, Key: key }, (err) => (err ? reject(err) : resolve()));
    });
    return true;
  } catch {
    return false;
  }
}
