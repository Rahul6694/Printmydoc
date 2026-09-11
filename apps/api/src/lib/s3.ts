import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const bucket = process.env.AWS_S3_BUCKET || "";
const region = process.env.AWS_REGION || "ap-south-1";

const client = new S3Client({ region });

export function publicUrl(key: string): string {
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

export async function uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
}

export async function deleteObject(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export function keyFromPublicUrl(url: string): string {
  const prefix = publicUrl("");
  return url.startsWith(prefix) ? url.slice(prefix.length) : url;
}
